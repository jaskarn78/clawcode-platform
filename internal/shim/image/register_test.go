// Package image — Register-level tests.
//
// These tests exercise the in-process Register function and its handler
// closures against a fake daemon (newline-delimited JSON-RPC unix
// socket). They mirror internal/shim/search/register_test.go with
// image substitutions plus an additional Test 6 for the 16 MB IPC
// buffer regression case (Pitfall §2): image_generate base64 payloads
// can be several MB.
//
// Coverage:
//   - Register fetches tool schemas at boot via list-mcp-tools (Test 1)
//   - tools/call dispatches image-tool-call with byte-exact params
//     {agent, toolName, args} (Test 2)
//   - daemon error envelope propagates as CallToolResult IsError=true,
//     never swallowed, never auto-retried (Test 3)
//   - CLAWCODE_AGENT env required (Test 4)
//   - source contains zero retry / fallback / Node-shim references (Test 5)
//   - image_generate response with 3 MB base64 payload round-trips
//     through the 16 MB IPC buffer (Test 6 — Pitfall §2 regression)
package image

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

// imageToolFixture mirrors src/image/tools.ts TOOL_DEFINITIONS:
// image_generate, image_edit, image_variations.
var imageToolFixture = []map[string]interface{}{
	{
		"name":        "image_generate",
		"description": "Generate an image from a text prompt.",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"prompt": map[string]interface{}{"type": "string"}},
			"required":   []string{"prompt"},
		},
	},
	{
		"name":        "image_edit",
		"description": "Edit an image with a text prompt.",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"prompt": map[string]interface{}{"type": "string"}},
			"required":   []string{"prompt"},
		},
	},
	{
		"name":        "image_variations",
		"description": "Create variations of an image.",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"image": map[string]interface{}{"type": "string"}},
			"required":   []string{"image"},
		},
	},
}

// TestRegisterFetchesToolsAtBoot — Test 1.
//
// Register calls list-mcp-tools with shimType=image; the fake daemon
// returns three tool definitions. After Register, the server has all
// three tools registered.
func TestRegisterFetchesToolsAtBoot(t *testing.T) {
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		if req["method"] != "list-mcp-tools" {
			t.Errorf("expected list-mcp-tools, got %q", req["method"])
		}
		params, _ := req["params"].(map[string]interface{})
		if params["shimType"] != "image" {
			t.Errorf("expected shimType=image, got %v", params["shimType"])
		}
		writeResp(conn, req["id"], map[string]interface{}{"tools": imageToolFixture})
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)
	t.Setenv("CLAWCODE_AGENT", "test-agent")

	server := mcp.NewServer(&mcp.Implementation{Name: "image", Version: "test"}, nil)
	if err := Register(server); err != nil {
		t.Fatalf("Register: %v", err)
	}

	names := registeredToolNames(t, server)
	if len(names) != 3 {
		t.Fatalf("expected 3 tools, got %d: %v", len(names), names)
	}
	for _, want := range []string{"image_generate", "image_edit", "image_variations"} {
		if !contains(names, want) {
			t.Fatalf("expected %q in %v", want, names)
		}
	}
}

// TestRegisterHandlerDispatchesImageToolCall — Test 2.
//
// When claude calls image_generate with {"prompt":"sunset"}, the handler
// dispatches image-tool-call IPC with params {agent, toolName, args}
// byte-exact.
func TestRegisterHandlerDispatchesImageToolCall(t *testing.T) {
	var sawImageCall atomic.Bool
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		switch req["method"] {
		case "list-mcp-tools":
			writeResp(conn, req["id"], map[string]interface{}{"tools": imageToolFixture})
		case "image-tool-call":
			sawImageCall.Store(true)
			params, _ := req["params"].(map[string]interface{})
			if params["agent"] != "test-agent" {
				t.Errorf("agent: got %v, want test-agent", params["agent"])
			}
			if params["toolName"] != "image_generate" {
				t.Errorf("toolName: got %v, want image_generate", params["toolName"])
			}
			args, _ := params["args"].(map[string]interface{})
			if args["prompt"] != "sunset" {
				t.Errorf("args.prompt: got %v, want sunset", args["prompt"])
			}
			writeResp(conn, req["id"], map[string]interface{}{"image": "data:image/png;base64,iVBOR..."})
		default:
			t.Errorf("unexpected method: %v", req["method"])
		}
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)
	t.Setenv("CLAWCODE_AGENT", "test-agent")

	h := makeHandler("test-agent", "image_generate")
	rawArgs := json.RawMessage(`{"prompt":"sunset"}`)
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
	if !sawImageCall.Load() {
		t.Fatalf("daemon never received image-tool-call")
	}
}

// TestRegisterHandlerPropagatesDaemonError — Test 3.
//
// When the daemon returns a JSON-RPC error envelope for an
// image-tool-call, the handler builds a CallToolResult with
// IsError=true. The handler does NOT return a Go error and does NOT
// retry.
func TestRegisterHandlerPropagatesDaemonError(t *testing.T) {
	var callCount atomic.Int32
	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		if req["method"] == "image-tool-call" {
			callCount.Add(1)
			writeErr(conn, req["id"], -32000, "daemon image backend down")
		}
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)

	h := makeHandler("test-agent", "image_generate")
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(`{"prompt":"x"}`)},
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
//
// With CLAWCODE_AGENT unset, Register returns a clear error mentioning
// the missing env var. Matches Node shim behavior at
// src/image/mcp-server.ts.
func TestRegisterRequiresClawcodeAgent(t *testing.T) {
	t.Setenv("CLAWCODE_AGENT", "")

	server := mcp.NewServer(&mcp.Implementation{Name: "image", Version: "test"}, nil)
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
// Source-grep regression test for the operator-locked fail-loud policy.
func TestRegisterSourceContainsNoFallbackOrRetry(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("abs repo root: %v", err)
	}
	srcPath := filepath.Join(repoRoot, "internal", "shim", "image", "register.go")
	body, err := os.ReadFile(srcPath)
	if err != nil {
		t.Fatalf("read register.go: %v", err)
	}
	src := string(body)

	forbidden := []string{
		"image-mcp",
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

// TestImageGenerateLargePayloadRoundtrip — Test 6 (Pitfall §2 regression).
//
// image_generate responses contain base64-encoded image data that can
// be several MB. The shared internal/shim/ipc/client.go provisions a
// 16 MB scanner buffer for exactly this case. This test verifies the
// image shim's path through that buffer with a 3 MB base64 payload.
//
// Failure mode if the buffer is undersized: bufio.Scanner returns
// "token too long", SendRequest returns an error, the handler reports
// IsError=true. A passing test confirms the full payload round-trips
// without truncation.
func TestImageGenerateLargePayloadRoundtrip(t *testing.T) {
	// 3 MB of base64 payload — well under 16 MB ceiling but well above
	// the 64 KB default scanner buffer.
	const payloadSize = 3 * 1024 * 1024
	bigB64 := strings.Repeat("A", payloadSize)

	sockPath := startFakeDaemon(t, func(t *testing.T, req map[string]interface{}, conn net.Conn) {
		if req["method"] == "image-tool-call" {
			writeResp(conn, req["id"], map[string]interface{}{
				"image": bigB64,
				"mime":  "image/png",
			})
		}
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)
	t.Setenv("CLAWCODE_AGENT", "test-agent")

	h := makeHandler("test-agent", "image_generate")
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(`{"prompt":"big"}`)},
	}
	res, err := h(context.Background(), req)
	if err != nil {
		t.Fatalf("handler returned Go error: %v", err)
	}
	if res.IsError {
		// Most likely Pitfall §2 — buffer truncation.
		var msg string
		if tc, ok := res.Content[0].(*mcp.TextContent); ok {
			msg = tc.Text
		}
		t.Fatalf("handler reported IsError on large payload (Pitfall §2 regression?): %s", msg)
	}
	if len(res.Content) == 0 {
		t.Fatalf("expected non-empty content")
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected TextContent, got %T", res.Content[0])
	}
	// Verify the full base64 string round-tripped intact (no truncation).
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
