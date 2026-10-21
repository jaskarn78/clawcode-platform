// Package main — Phase 110 Stage 0b production MCP shim entrypoint.
//
// Single-binary MCP shim with --type dispatch. All three shim types
// (search, image, browser) are wired through the same daemon IPC
// surface (`list-mcp-tools` + `<type>-tool-call`):
//   - search:  plan 110-04 (Wave 2 — shipped)
//   - image:   plan 110-06 (Wave 4 — this build)
//   - browser: plan 110-07 (Wave 5 — this build)
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"

	"github.com/example-user/clawcode-shim/internal/shim/browser"
	"github.com/example-user/clawcode-shim/internal/shim/brokerpipe"
	"github.com/example-user/clawcode-shim/internal/shim/image"
	"github.com/example-user/clawcode-shim/internal/shim/search"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Phase 108 broker exit-code semantics — match exactly so Claude Code
// SDK 0.2.97 respawn behavior is identical between Node and Go shims.
//
// Pitfall §5: SDK respawns on exit-75 (TEMPFAIL); other non-zero exit
// codes are interpreted as permanent failures and disable the tool for
// the session. Daemon-side failures and unexpected panics MUST exit 75.
const (
	SHIM_EXIT_OK       = 0
	SHIM_EXIT_USAGE    = 64
	SHIM_EXIT_TEMPFAIL = 75
)

func main() {
	// slog ALWAYS to stderr — stdout is owned by the MCP SDK (Pitfall §6).
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	serverType := flag.String("type", "", "search|image|browser (required)")
	flag.Parse()

	// Panic recovery: any unexpected runtime panic in our code (or in
	// the Go SDK's request dispatch) exits 75 so the SDK respawns the
	// shim on next tool need (Pitfall §5). Without this, Go's default
	// behavior would be exit 2, which the SDK interprets as a permanent
	// failure and would disable the tool for the entire claude session.
	defer func() {
		if r := recover(); r != nil {
			logger.Error("panic in shim", "panic", r, "serverType", *serverType)
			os.Exit(SHIM_EXIT_TEMPFAIL)
		}
	}()

	if *serverType == "" {
		logger.Error("missing required flag", "flag", "--type")
		os.Exit(SHIM_EXIT_USAGE)
	}

	// P5 (Phase 110 "Stage 0c", operator-unlocked 2026-08-03) — the
	// 1password broker shim is a raw byte pipe to the broker socket, NOT
	// an MCP server: no tool schemas, no list-mcp-tools. Dispatch before
	// the MCP server construction below.
	if *serverType == "1password" {
		os.Exit(brokerpipe.Run(logger))
	}

	server := mcp.NewServer(
		&mcp.Implementation{Name: *serverType, Version: "0.1.0"},
		nil,
	)

	switch *serverType {
	case "search":
		if err := search.Register(server); err != nil {
			// Boot-time IPC failure (daemon unreachable, list-mcp-tools
			// failed, or CLAWCODE_AGENT unset). Exit 75 so SDK respawns
			// once the daemon is back up.
			logger.Error("search.Register failed", "err", err)
			os.Exit(SHIM_EXIT_TEMPFAIL)
		}
	case "image":
		if err := image.Register(server); err != nil {
			// Boot-time IPC failure (daemon unreachable, list-mcp-tools
			// failed, or CLAWCODE_AGENT unset). Exit 75 so SDK respawns
			// once the daemon is back up.
			logger.Error("image.Register failed", "err", err)
			os.Exit(SHIM_EXIT_TEMPFAIL)
		}
	case "browser":
		if err := browser.Register(server); err != nil {
			// Boot-time IPC failure (daemon unreachable, list-mcp-tools
			// failed, or CLAWCODE_AGENT unset). Exit 75 so SDK respawns
			// once the daemon is back up.
			logger.Error("browser.Register failed", "err", err)
			os.Exit(SHIM_EXIT_TEMPFAIL)
		}
	default:
		logger.Error("unknown serverType", "serverType", *serverType)
		os.Exit(SHIM_EXIT_USAGE)
	}

	logger.Info("shim starting", "serverType", *serverType, "version", "0.1.0")
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		// Pitfall §5 — exit 75 (SHIM_EXIT_TEMPFAIL) signals "transient
		// failure, please retry" to Claude Code SDK 0.2.97. SDK respawns
		// on next tool need. Phase 108 broker uses identical semantics.
		logger.Error("server.Run failed", "err", err, "serverType", *serverType)
		os.Exit(SHIM_EXIT_TEMPFAIL)
	}
	os.Exit(SHIM_EXIT_OK)
}
