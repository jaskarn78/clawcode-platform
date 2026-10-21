// Package brokerpipe — P5 (memory program, Phase 110 "Stage 0c"): the Go
// port of `clawcode mcp-broker-shim --pool 1password`.
//
// The Node shim is a ~200-line byte pipe that cost the full 4.4 MB CLI
// bundle (~240 MB RSS per agent). This port needs no MCP schema work at
// all: connect to the broker's unix socket, write ONE handshake line
// `{"agent":"...","tokenHash":"..."}\n` (sha256-hex[0:8] of
// OP_SERVICE_ACCOUNT_TOKEN — the literal NEVER crosses the wire, SEC-07),
// then pipe stdin↔socket transparently. Everything real (pooling, JSON-RPC
// id rewriting, initialize replay) lives daemon-side.
//
// Exit-code parity with the Node shim (SDK 0.2.97 respawn semantics):
//   64 (USAGE)    — CLAWCODE_AGENT missing
//   75 (TEMPFAIL) — dial failure, socket close, SIGTERM — SDK respawns
package brokerpipe

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

const (
	exitOK       = 0
	exitUsage    = 64
	exitTempfail = 75
)

// SocketPath resolves the broker socket: CLAWCODE_BROKER_SOCKET override,
// else ~/.clawcode/manager/mcp-broker.sock (same-user contract as the
// Node shim — the shim runs as the daemon user, so homedir matches).
func SocketPath() string {
	if p := os.Getenv("CLAWCODE_BROKER_SOCKET"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "/home/clawcode/.clawcode/manager/mcp-broker.sock"
	}
	return filepath.Join(home, ".clawcode", "manager", "mcp-broker.sock")
}

func tokenHash(literal string) string {
	sum := sha256.Sum256([]byte(literal))
	return hex.EncodeToString(sum[:])[:8]
}

// Run executes the pipe until the socket closes or SIGTERM. Returns the
// process exit code.
func Run(logger *slog.Logger) int {
	agent := os.Getenv("CLAWCODE_AGENT")
	if agent == "" {
		logger.Error("CLAWCODE_AGENT is required")
		return exitUsage
	}
	// Parity with the Node shim: an empty token still hashes (the broker
	// rejects an unknown hash server-side with its own diagnostics).
	hash := tokenHash(os.Getenv("OP_SERVICE_ACCOUNT_TOKEN"))

	conn, err := net.Dial("unix", SocketPath())
	if err != nil {
		logger.Error("broker socket dial failed", "err", err)
		return exitTempfail
	}
	defer conn.Close()

	// Handshake — field order matches the Node shim's JSON.stringify.
	handshake, err := json.Marshal(struct {
		Agent     string `json:"agent"`
		TokenHash string `json:"tokenHash"`
	}{Agent: agent, TokenHash: hash})
	if err != nil {
		logger.Error("handshake marshal failed", "err", err)
		return exitTempfail
	}
	if _, err := conn.Write(append(handshake, '\n')); err != nil {
		logger.Error("handshake write failed", "err", err)
		return exitTempfail
	}

	// SIGTERM → graceful socket end (daemon-managed restart / operator kill).
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM)
	go func() {
		<-sig
		logger.Info("SIGTERM received; ending broker socket")
		_ = conn.Close()
	}()

	// Byte-transparent pipe. stdin→socket runs in a goroutine; the main
	// goroutine drains socket→stdout. Socket close/EOF on either side ends
	// the shim with TEMPFAIL so the SDK respawns it on next tool need —
	// identical to the Node shim's close semantics.
	go func() {
		_, _ = io.Copy(conn, os.Stdin)
		// stdin closed (parent claude exiting) — closing the socket
		// unblocks the read side below.
		_ = conn.Close()
	}()
	_, _ = io.Copy(os.Stdout, conn)

	logger.Info("broker socket closed; exiting TEMPFAIL for SDK respawn")
	return exitTempfail
}
