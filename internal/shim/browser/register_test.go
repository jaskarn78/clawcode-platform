// Package browser — Register-level tests.
//
// Tests mirror internal/shim/image/register_test.go with browser
// substitutions. Test 6 (CRITICAL) is the Pitfall §2 regression case
// for browser_screenshot specifically: 1 MB base64 PNG payload must
// round-trip through the 16 MB IPC scanner buffer without truncation.
//
// Coverage:
//   - Register fetches tool schemas at boot via list-mcp-tools (Test 1)
//   - tools/call dispatches browser-tool-call with byte-exact params
//     {agent, toolName, args} (Test 2)
//   - daemon error envelope propagates as CallToolResult IsError=true,
//     never swallowed, never auto-retried (Test 3)
//   - CLAWCODE_AGENT env required (Test 4)
//   - source contains zero retry / fallback / Node-shim references (Test 5)
//   - browser_screenshot 1 MB base64 PNG round-trip (Test 6 — Pitfall §2)
package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeDaemonHandler is invoked once per accepted connection. It must
// read the request, write a newline-delimited response, and return.
type fakeDaemonHandler func(t *testing.T, req map[string]interface{}, conn net.Conn)

// startFakeDaemon launches a unix-socket listener and routes accepted
// connections to handler. Returns the socket path. Test sets
// CLAWCODE_MANAGER_SOCK so the IPC client dials this path.
func startFakeDaemon(t *testing.T, handler fakeDaemonHandler) string {
	t.Helper()
	sockPath := filepath.Join(t.TempDir(), "test.sock")
	listener, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				scanner := bufio.NewScanner(c)
				scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
				if !scanner.Scan() {
					return
				}
				var req map[string]interface{}
				if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
					return
				}
				handler(t, req, c)
			}(conn)
		}
	}()
	return sockPath
}

// writeResp writes a JSON-RPC response with id echoed from req.
func writeResp(conn net.Conn, reqID interface{}, result interface{}) {
	resp := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      reqID,
		"result":  result,
	}
	_ = json.NewEncoder(conn).Encode(resp)
}

// writeErr writes a JSON-RPC error envelope.
func writeErr(conn net.Conn, reqID interface{}, code int, message string) {
	resp := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      reqID,
		"error":   map[string]interface{}{"code": code, "message": message},
	}
	_ = json.NewEncoder(conn).Encode(resp)
}

// browserToolFixture mirrors src/browser/tools.ts TOOL_DEFINITIONS
// (subset sufficient for the Register registration check).
var browserToolFixture = []map[string]interface{}{
	{
		"name":        "browser_navigate",
		"description": "Navigate to a URL.",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"url": map[string]interface{}{"type": "string"}},
			"required":   []string{"url"},
		},
	},
	{
		"name":        "browser_screenshot",
		"description": "Take a screenshot of the current page.",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"fullPage": map[string]interface{}{"type": "boolean"}},
		},
	},
	{
		"name":        "browser_extract",
		"description": "Extract text from the current page.",
		"inputSchema": map[string]interface{}{
			"type": "object",
		},
	},
}

// TestRegisterFetchesToolsAtBoot — Test 1.
func TestRegisterFetchesToolsAtBoot(t *testing.T) {
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		if req["method"] != "list-mcp-tools" {
			t.Errorf("expected list-mcp-tools, got %q", req["method"])
		}
		params, _ := req["params"].(map[string]interface{})
		if params["shimType"] != "browser" {
			t.Errorf("expected shimType=browser, got %v", params["shimType"])
		}
		writeResp(conn, req["id"], map[string]interface{}{"tools": browserToolFixture})
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)
	t.Setenv("CLAWCODE_AGENT", "test-agent")

	server := mcp.NewServer(&mcp.Implementation{Name: "browser", Version: "test"}, nil)
	if err := Register(server); err != nil {
		t.Fatalf("Register: %v", err)
	}

	names := registeredToolNames(t, server)
	if len(names) != 3 {
		t.Fatalf("expected 3 tools, got %d: %v", len(names), names)
	}
	for _, want := range []string{"browser_navigate", "browser_screenshot", "browser_extract"} {
		if !contains(names, want) {
			t.Fatalf("expected %q in %v", want, names)
		}
	}
}

// TestRegisterHandlerDispatchesBrowserToolCall — Test 2.
func TestRegisterHandlerDispatchesBrowserToolCall(t *testing.T) {
	var sawCall atomic.Bool
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		switch req["method"] {
		case "list-mcp-tools":
			writeResp(conn, req["id"], map[string]interface{}{"tools": browserToolFixture})
		case "browser-tool-call":
			sawCall.Store(true)
			params, _ := req["params"].(map[string]interface{})
			if params["agent"] != "test-agent" {
				t.Errorf("agent: got %v, want test-agent", params["agent"])
			}
			if params["toolName"] != "browser_navigate" {
				t.Errorf("toolName: got %v, want browser_navigate", params["toolName"])
			}
			args, _ := params["args"].(map[string]interface{})
			if args["url"] != "https://example.com" {
				t.Errorf("args.url: got %v, want https://example.com", args["url"])
			}
			writeResp(conn, req["id"], map[string]interface{}{"ok": true})
		default:
			t.Errorf("unexpected method: %v", req["method"])
		}
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)
	t.Setenv("CLAWCODE_AGENT", "test-agent")

	h := makeHandler("test-agent", "browser_navigate")
	rawArgs := json.RawMessage(`{"url":"https://example.com"}`)
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: rawArgs},
	}
	res, err := h(context.Background(), req)
	if err != nil {
		t.Fatalf("handler returned Go error: %v", err)
	}
	if res.IsError {
		t.Fatalf("handler reported IsError; content: %v", res.Content)
	}
	if !sawCall.Load() {
		t.Fatalf("daemon never received browser-tool-call")
	}
}

// TestRegisterHandlerPropagatesDaemonError — Test 3.
func TestRegisterHandlerPropagatesDaemonError(t *testing.T) {
	var callCount atomic.Int32
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		if req["method"] == "browser-tool-call" {
			callCount.Add(1)
			writeErr(conn, req["id"], -32000, "daemon browser backend down")
		}
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)

	h := makeHandler("test-agent", "browser_navigate")
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(`{"url":"x"}`)},
	}
	res, err := h(context.Background(), req)
	if err != nil {
		t.Fatalf("handler returned Go error (must be tool-level): %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected IsError=true on daemon error envelope")
	}
	if got := callCount.Load(); got != 1 {
		t.Fatalf("expected exactly 1 daemon call (no retry), got %d", got)
	}
	if len(res.Content) == 0 {
		t.Fatalf("expected error content")
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected TextContent, got %T", res.Content[0])
	}
	if !strings.Contains(tc.Text, "daemon") {
		t.Fatalf("expected error text to mention 'daemon', got %q", tc.Text)
	}
}

// TestRegisterRequiresClawcodeAgent — Test 4.
func TestRegisterRequiresClawcodeAgent(t *testing.T) {
	t.Setenv("CLAWCODE_AGENT", "")

	server := mcp.NewServer(&mcp.Implementation{Name: "browser", Version: "test"}, nil)
	err := Register(server)
	if err == nil {
		t.Fatalf("expected error when CLAWCODE_AGENT is unset")
	}
	if !strings.Contains(err.Error(), "CLAWCODE_AGENT") {
		t.Fatalf("error should mention CLAWCODE_AGENT, got %q", err.Error())
	}
}

// TestRegisterSourceContainsNoFallbackOrRetry — Test 5.
func TestRegisterSourceContainsNoFallbackOrRetry(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("abs repo root: %v", err)
	}
	srcPath := filepath.Join(repoRoot, "internal", "shim", "browser", "register.go")
	body, err := os.ReadFile(srcPath)
	if err != nil {
		t.Fatalf("read register.go: %v", err)
	}
	src := string(body)

	forbidden := []string{
		"browser-mcp",
		"clawcode-fallback",
		"MaxRetries",
		"exponentialBackoff",
		`"node-shim"`,
	}
	for _, bad := range forbidden {
		if strings.Contains(src, bad) {
			t.Errorf("register.go contains forbidden pattern %q (fail-loud policy)", bad)
		}
	}
}

// TestScreenshotLargePayloadRoundtrip — Test 6 (Pitfall §2 regression).
//
// browser_screenshot returns 200 KB-1 MB base64 PNG payloads inline.
// This test feeds a 1 MB base64 string through the fake daemon and
// asserts the full payload round-trips intact. Failure mode if the
// 16 MB scanner buffer regresses: bufio.Scanner returns "token too
// long", SendRequest errors, handler reports IsError=true. A passing
// test confirms screenshot payloads survive the IPC layer.
func TestScreenshotLargePayloadRoundtrip(t *testing.T) {
	const payloadSize = 1024 * 1024 // 1 MB
	bigB64 := strings.Repeat("A", payloadSize)

	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		if req["method"] == "browser-tool-call" {
			writeResp(conn, req["id"], map[string]interface{}{
				"image": bigB64,
				"mime":  "image/png",
			})
		}
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)
	t.Setenv("CLAWCODE_AGENT", "test-agent")

	h := makeHandler("test-agent", "browser_screenshot")
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(`{"fullPage":true}`)},
	}
	res, err := h(context.Background(), req)
	if err != nil {
		t.Fatalf("handler returned Go error: %v", err)
	}
	if res.IsError {
		var msg string
		if tc, ok := res.Content[0].(*mcp.TextContent); ok {
			msg = tc.Text
		}
		t.Fatalf("handler reported IsError on 1 MB screenshot (Pitfall §2 regression?): %s", msg)
	}
	if len(res.Content) == 0 {
		t.Fatalf("expected non-empty content")
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected TextContent, got %T", res.Content[0])
	}
	if !strings.Contains(tc.Text, bigB64) {
		t.Fatalf("payload truncated: returned %d bytes, expected to contain %d-byte base64",
			len(tc.Text), payloadSize)
	}
}

// registeredToolNames returns the names of all tools currently
// registered on server, by performing an in-memory ListTools round-trip
// via a client paired to the server.
func registeredToolNames(t *testing.T, server *mcp.Server) []string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	go func() { _ = server.Run(ctx, serverTransport) }()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "0"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer session.Close()

	resp, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	names := make([]string, 0, len(resp.Tools))
	for _, tool := range resp.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
