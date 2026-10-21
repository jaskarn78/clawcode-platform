// Package search — Register-level tests.
//
// These tests exercise the in-process Register function and its handler
// closures against a fake daemon (newline-delimited JSON-RPC unix
// socket). The COMPILED-binary integration tests live in
// integration_test.go (plan 110-04 Task 3).
//
// Coverage:
//   - Register fetches tool schemas at boot via list-mcp-tools (Test 1)
//   - tools/call dispatches search-tool-call with byte-exact params
//     {agent, toolName, args} (Test 2)
//   - daemon error envelope propagates as CallToolResult IsError=true,
//     never swallowed, never auto-retried (Test 3)
//   - CLAWCODE_AGENT env required (Test 4)
//   - source contains zero retry / fallback / Node-shim references (Test 5)
package search

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

// twoToolFixture is the canned list-mcp-tools response used by tests
// 1-4. It mirrors the actual search shim's tool surface (web_search,
// web_fetch_url) per src/search/tools.ts.
var twoToolFixture = []map[string]interface{}{
	{
		"name":        "web_search",
		"description": "Search the web via Brave / Exa.",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"query": map[string]interface{}{"type": "string"}},
			"required":   []string{"query"},
		},
	},
	{
		"name":        "web_fetch_url",
		"description": "Fetch a URL.",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"url": map[string]interface{}{"type": "string"}},
			"required":   []string{"url"},
		},
	},
}

// TestRegisterFetchesToolsAtBoot — Test 1.
//
// Register calls list-mcp-tools with shimType=search; the fake daemon
// returns two tool definitions. After Register, the server has both
// tools registered (verified by listing the server's known tools).
func TestRegisterFetchesToolsAtBoot(t *testing.T) {
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		if req["method"] != "list-mcp-tools" {
			t.Errorf("expected list-mcp-tools, got %q", req["method"])
		}
		params, _ := req["params"].(map[string]interface{})
		if params["shimType"] != "search" {
			t.Errorf("expected shimType=search, got %v", params["shimType"])
		}
		writeResp(conn, req["id"], map[string]interface{}{"tools": twoToolFixture})
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)
	t.Setenv("CLAWCODE_AGENT", "test-agent")

	server := mcp.NewServer(&mcp.Implementation{Name: "search", Version: "test"}, nil)
	if err := Register(server); err != nil {
		t.Fatalf("Register: %v", err)
	}

	// Confirm both tools are registered. The SDK exposes them via the
	// internal tools collection; we test via a direct ListTools call
	// using an in-memory transport pair.
	names := registeredToolNames(t, server)
	if len(names) != 2 {
		t.Fatalf("expected 2 tools, got %d: %v", len(names), names)
	}
	if !contains(names, "web_search") || !contains(names, "web_fetch_url") {
		t.Fatalf("expected web_search + web_fetch_url, got %v", names)
	}
}

// TestRegisterHandlerDispatchesSearchToolCall — Test 2.
//
// When claude calls web_search with {"query":"foo"}, the handler
// dispatches search-tool-call IPC with params
// {agent, toolName, args} byte-exact. The fake daemon validates the
// shape and returns a canned result.
func TestRegisterHandlerDispatchesSearchToolCall(t *testing.T) {
	var sawSearchCall atomic.Bool
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		switch req["method"] {
		case "list-mcp-tools":
			writeResp(conn, req["id"], map[string]interface{}{"tools": twoToolFixture})
		case "search-tool-call":
			sawSearchCall.Store(true)
			params, _ := req["params"].(map[string]interface{})
			if params["agent"] != "test-agent" {
				t.Errorf("agent: got %v, want test-agent", params["agent"])
			}
			if params["toolName"] != "web_search" {
				t.Errorf("toolName: got %v, want web_search", params["toolName"])
			}
			args, _ := params["args"].(map[string]interface{})
			if args["query"] != "foo" {
				t.Errorf("args.query: got %v, want foo", args["query"])
			}
			writeResp(conn, req["id"], map[string]interface{}{"results": []string{"r1"}})
		default:
			t.Errorf("unexpected method: %v", req["method"])
		}
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)
	t.Setenv("CLAWCODE_AGENT", "test-agent")

	// Test the handler directly via makeHandler — bypasses the SDK
	// dispatch and exercises our IPC translation in isolation.
	h := makeHandler("test-agent", "web_search")
	rawArgs := json.RawMessage(`{"query":"foo"}`)
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: rawArgs},
	}
	res, err := h(context.Background(), req)
	if err != nil {
		t.Fatalf("handler returned Go error (should be CallToolResult): %v", err)
	}
	if res.IsError {
		t.Fatalf("handler reported IsError; content: %v", res.Content)
	}
	if !sawSearchCall.Load() {
		t.Fatalf("daemon never received search-tool-call")
	}
}

// TestRegisterHandlerPropagatesDaemonError — Test 3.
//
// When the daemon returns a JSON-RPC error envelope for a
// search-tool-call, the handler builds a CallToolResult with
// IsError=true. The handler does NOT return a Go error (which would
// surface as protocol-level error) and does NOT retry.
func TestRegisterHandlerPropagatesDaemonError(t *testing.T) {
	var callCount atomic.Int32
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		if req["method"] == "search-tool-call" {
			callCount.Add(1)
			writeErr(conn, req["id"], -32000, "daemon search backend down")
		}
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)

	h := makeHandler("test-agent", "web_search")
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(`{"query":"x"}`)},
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
	// Sanity: error message should mention the daemon code or message.
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
//
// With CLAWCODE_AGENT unset, Register returns a clear error mentioning
// the missing env var. Matches Node shim behavior at
// src/search/mcp-server.ts.
func TestRegisterRequiresClawcodeAgent(t *testing.T) {
	t.Setenv("CLAWCODE_AGENT", "")

	server := mcp.NewServer(&mcp.Implementation{Name: "search", Version: "test"}, nil)
	err := Register(server)
	if err == nil {
		t.Fatalf("expected error when CLAWCODE_AGENT is unset")
	}
	if !strings.Contains(err.Error(), "CLAWCODE_AGENT") {
		t.Fatalf("error should mention CLAWCODE_AGENT, got %q", err.Error())
	}
}

// TestRegisterSourceContainsNoFallbackOrRetry — Test 5.
//
// Source-grep regression test. The fail-loud policy is operator-locked;
// any future contributor adding a Node fallback path or a retry loop
// in register.go would silently degrade the locked policy. Catch it at
// test time.
func TestRegisterSourceContainsNoFallbackOrRetry(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("abs repo root: %v", err)
	}
	srcPath := filepath.Join(repoRoot, "internal", "shim", "search", "register.go")
	body, err := os.ReadFile(srcPath)
	if err != nil {
		t.Fatalf("read register.go: %v", err)
	}
	src := string(body)

	// These exact strings would indicate auto-retry or Node-shim
	// fallback — both forbidden by the operator-locked fail-loud policy.
	forbidden := []string{
		"search-mcp",
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

