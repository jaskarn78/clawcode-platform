// Package ipc — daemon IPC client for the Stage 0b Go MCP shim.
//
// Wire format: newline-delimited JSON-RPC 2.0 over unix socket. One
// request per connection; the daemon writes its response then closes the
// socket. Matches src/ipc/client.ts:34-46 byte-for-byte (TypeScript
// source-of-truth).
//
// Pitfall §2: bufio.Scanner is constructed with an explicit 16 MB max
// line size to handle browser screenshot inline base64 payloads (~1 MB
// observed). Default 64 KB silently truncates and corrupts JSON.
//
// Pitfall §3: NEVER pool connections. The daemon's protocol is one-shot
// per connection; reusing a connection across requests hangs forever on
// the second response.
//
// Pitfall §6: stderr-only logging is the caller's responsibility — this
// package never writes to stdout.
package ipc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// SocketPath returns the daemon's unix socket path.
//
// Honors the CLAWCODE_MANAGER_SOCK environment variable as an override;
// falls back to ~/.clawcode/manager/clawcode.sock (matching the
// TypeScript daemon's SOCKET_PATH constant at src/manager/daemon.ts).
//
// The override is intended for tests and custom installs where the
// default home-relative path is not appropriate. The Node loader
// (src/config/loader.ts) ALSO sets this env explicitly when spawning
// alternate-runtime shims, as defense-in-depth against future drift —
// but the default below MUST stay aligned with the daemon's binding so
// the binary works even when launched without the env override.
func SocketPath() (string, error) {
	if override := os.Getenv("CLAWCODE_MANAGER_SOCK"); override != "" {
		return override, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, ".clawcode", "manager", "clawcode.sock"), nil
}

// Request is the JSON-RPC 2.0 request envelope written to the daemon.
type Request struct {
	Jsonrpc string                 `json:"jsonrpc"`
	ID      string                 `json:"id"`
	Method  string                 `json:"method"`
	Params  map[string]interface{} `json:"params"`
}

// Response is the JSON-RPC 2.0 response envelope returned by the daemon.
type Response struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      string          `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *ResponseError  `json:"error,omitempty"`
}

// ResponseError mirrors the daemon's error envelope shape.
type ResponseError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// SendRequest dials the daemon, writes one JSON-RPC request, reads
// exactly one response, and closes the connection.
//
// On daemon-side error envelopes the returned error embeds both the
// code and message. On network failures the underlying error is wrapped
// with context. NO automatic recovery — a fresh dial per call is the
// contract; callers MUST surface errors back to MCP clients as
// CallToolResult error envelopes (fail-loud — operator-locked policy).
//
// Per CLAUDE.md immutability rule: the params map is not mutated; the
// passed-in map is copied into a fresh Request value.
func SendRequest(method string, params map[string]interface{}) (json.RawMessage, error) {
	sockPath, err := SocketPath()
	if err != nil {
		return nil, err
	}
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return nil, fmt.Errorf("dial daemon socket %s: %w", sockPath, err)
	}
	defer conn.Close()

	if params == nil {
		params = map[string]interface{}{}
	}
	req := Request{
		Jsonrpc: "2.0",
		ID:      uuid.NewString(),
		Method:  method,
		Params:  params,
	}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}

	scanner := bufio.NewScanner(conn)
	// Pitfall §2 — daemon writes the entire response on a single
	// newline-delimited line. Browser screenshots inline base64 may
	// exceed Go's default 64 KB scanner limit. 16 MB covers any
	// practical screenshot.
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	if !scanner.Scan() {
		if scanErr := scanner.Err(); scanErr != nil {
			return nil, fmt.Errorf("read response: %w", scanErr)
		}
		return nil, fmt.Errorf("daemon closed connection without response")
	}

	var resp Response
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("daemon error %d: %s", resp.Error.Code, resp.Error.Message)
	}
	return resp.Result, nil
}
