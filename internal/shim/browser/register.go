// Package browser — Stage 0b production browser MCP shim. Mirrors
// internal/shim/image/register.go byte-for-byte except for two
// strings (shimType "browser", IPC method "browser-tool-call"). Wired
// in from cmd/clawcode-mcp-shim/main.go via the `--type browser`
// dispatch.
//
// Register fetches the canonical tool schemas from the daemon at boot
// via the `list-mcp-tools` IPC method (Wave 1 — plan 110-01 ships the
// daemon-side handler). This keeps Zod the single source of truth for
// tool schemas; Go never duplicates or codegens them. (Pitfall §4 —
// schema drift.)
//
// Per `tools/call`, the handler dispatches `browser-tool-call` IPC to
// the daemon with the byte-equivalent params shape used by the
// existing TypeScript shim at src/browser/mcp-server.ts:
//
//	{ agent: <CLAWCODE_AGENT>, toolName: <name>, args: <claude args> }
//
// Crash-fallback (LOCKED — operator decision 2026-05-05):
// every IPC error returns to Claude as a CallToolResult error envelope
// (IsError=true). NO automatic recovery, NO secondary attempt,
// NO Node fallback — surface daemon failures so they are visible.
// Operators flip the runtime flag in clawcode.yaml if Go misbehaves;
// the shim itself never silently degrades.
//
// RED tier (CONTEXT.md): Browser SESSION STATE (Playwright/Chrome
// lifecycle) is RED tier and stays daemon-side. This shim migrates
// ONLY the IPC translator process; session state is OUT of scope.
//
// Pitfall §2 (16 MB IPC buffer): browser_screenshot returns 200 KB-1 MB
// base64 PNG payloads inline. The shared internal/shim/ipc/client.go
// already provisions a 16 MB scanner buffer. Test 6 in
// register_test.go is THE Pitfall §2 regression test for this path.
package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/example-user/clawcode-shim/internal/shim/ipc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// toolDef is the wire-shape returned by `list-mcp-tools`. The daemon
// converts Zod schemas to JSON Schema and embeds them in `inputSchema`
// as opaque JSON. Go does not re-validate; the daemon owns validation.
type toolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// listMcpToolsResponse mirrors the daemon's response envelope.
type listMcpToolsResponse struct {
	Tools []toolDef `json:"tools"`
}

// Register fetches the browser tool schemas from the daemon at boot
// and adds each tool to the MCP server with a handler that forwards
// tools/call invocations to `browser-tool-call` IPC.
//
// Returns an error if:
//   - CLAWCODE_AGENT env is unset (operator misconfiguration; matches
//     Node shim behavior at src/browser/mcp-server.ts).
//   - The daemon is unreachable or `list-mcp-tools` fails (caller MUST
//     surface this — main.go exits 75 SHIM_EXIT_TEMPFAIL so the SDK
//     respawns on next tool need; Pitfall §5).
//
// Per CLAUDE.md immutability: handler-side params map is built fresh
// per call; no shared mutable state.
func Register(server *mcp.Server) error {
	agent := os.Getenv("CLAWCODE_AGENT")
	if agent == "" {
		return fmt.Errorf("CLAWCODE_AGENT env var is required (set by daemon when spawning shim)")
	}

	rawTools, err := ipc.SendRequest("list-mcp-tools", map[string]interface{}{
		"shimType": "browser",
	})
	if err != nil {
		return fmt.Errorf("fetch tool schemas: %w", err)
	}
	var resp listMcpToolsResponse
	if err := json.Unmarshal(rawTools, &resp); err != nil {
		return fmt.Errorf("decode list-mcp-tools response: %w", err)
	}

	for _, td := range resp.Tools {
		td := td // capture loop variable for handler closure
		server.AddTool(
			&mcp.Tool{
				Name:        td.Name,
				Description: td.Description,
				InputSchema: td.InputSchema,
			},
			makeHandler(agent, td.Name),
		)
	}
	return nil
}

// makeHandler returns an mcp.ToolHandler that forwards a single
// tools/call invocation to the daemon's `browser-tool-call` IPC
// method.
//
// The handler is a closure capturing `agent` (read once at boot) and
// `toolName`. Each call dials a fresh socket connection (Pitfall §3 —
// one-request-per-connection).
//
// Fail-loud contract: any IPC error becomes a CallToolResult with
// IsError=true and the error message in TextContent. The handler does
// NOT return a Go error and does NOT attempt a second dial.
func makeHandler(agent, toolName string) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Decode args from the raw JSON the SDK passes through.
		var args map[string]interface{}
		if len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
				return errorResult(fmt.Sprintf("decode tool args: %v", err)), nil
			}
		}

		params := map[string]interface{}{
			"agent":    agent,
			"toolName": toolName,
			"args":     args,
		}

		result, ipcErr := ipc.SendRequest("browser-tool-call", params)
		if ipcErr != nil {
			return errorResult(fmt.Sprintf("daemon error: %v", ipcErr)), nil
		}

		// The daemon's `browser-tool-call` returns opaque JSON; we pass
		// through as a single TextContent block. The Node shim does the
		// same shape (cf. src/browser/mcp-server.ts which serializes
		// outcome as JSON text — including base64 screenshots).
		return &mcp.CallToolResult{
			Content: []mcp.Content{
				&mcp.TextContent{Text: string(result)},
			},
		}, nil
	}
}

// errorResult builds a tool-level error envelope (IsError=true). Used
// for both args-decode failures and daemon-IPC failures.
func errorResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
		IsError: true,
	}
}
