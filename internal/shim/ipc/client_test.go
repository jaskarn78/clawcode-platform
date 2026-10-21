// Package ipc tests — six regression tests covering the IPC client's
// wire-format contract, buffer sizing (Pitfall §2 — the 4 MB payload
// regression test is THE acceptance criterion for browser screenshot
// support), one-request-per-connection enforcement (Pitfall §3), error
// envelope handling, and the CLAWCODE_MANAGER_SOCK env override.
package ipc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// startFakeDaemon launches a unix-socket listener on a tempdir-scoped
// path. The handler is invoked once per accepted connection with the
// connection passed in — handlers may write a response and return; the
// listener tears down on test completion via t.Cleanup.
//
// Returns the socket path. Tests set CLAWCODE_MANAGER_SOCK to this path
// (test 6 explicitly; tests 1-5 implicitly through the override env).
func startFakeDaemon(t *testing.T, handler func(conn net.Conn)) string {
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
				handler(c)
			}(conn)
		}
	}()
	return sockPath
}

// readRequest reads one newline-delimited JSON-RPC request from conn.
// Used by the fake daemon handlers to confirm the client wrote a
// well-formed request before responding.
func readRequest(t *testing.T, conn net.Conn) Request {
	t.Helper()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	if !scanner.Scan() {
		t.Fatalf("fake daemon: no request: %v", scanner.Err())
	}
	var req Request
	if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
		t.Fatalf("fake daemon: decode request: %v", err)
	}
	return req
}

// TestSendRequestSingleRoundTrip — Test 1.
//
// Fake server echoes one canned response. Client calls SendRequest with
// a method and params; result must equal the canned payload bytes.
func TestSendRequestSingleRoundTrip(t *testing.T) {
	sockPath := startFakeDaemon(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		// Echo response with same id, canned result.
		resp := Response{
			Jsonrpc: "2.0",
			ID:      req.ID,
			Result:  json.RawMessage(`{"echoed":"ok","method":"` + req.Method + `"}`),
		}
		_ = json.NewEncoder(conn).Encode(resp)
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)

	result, err := SendRequest("test", map[string]interface{}{"foo": "bar"})
	if err != nil {
		t.Fatalf("SendRequest: %v", err)
	}
	var got map[string]string
	if err := json.Unmarshal(result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if got["echoed"] != "ok" || got["method"] != "test" {
		t.Fatalf("unexpected result: %+v", got)
	}
}

// TestSendRequestLargePayload — Test 2 (Pitfall §2 regression).
//
// Fake server returns a 4 MB JSON-encoded base64 string in the result
// field. Client must successfully receive the full payload without
// truncation. This is the canonical buffer-size regression test — if a
// future refactor drops the explicit scanner.Buffer call, this test
// fails with `bufio.Scanner: token too long`.
func TestSendRequestLargePayload(t *testing.T) {
	huge := strings.Repeat("A", 4*1024*1024)
	expectedLen := len(huge)

	sockPath := startFakeDaemon(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		// Build the JSON manually to avoid double-encoding the huge string.
		payload := fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":{"blob":%q}}`+"\n",
			req.ID, huge)
		_, _ = conn.Write([]byte(payload))
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)

	result, err := SendRequest("test", nil)
	if err != nil {
		t.Fatalf("SendRequest: %v", err)
	}
	var got struct {
		Blob string `json:"blob"`
	}
	if err := json.Unmarshal(result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Blob) != expectedLen {
		t.Fatalf("blob length: got %d, want %d (truncation? Pitfall §2)",
			len(got.Blob), expectedLen)
	}
}

// TestSendRequestServerClosesEarly — Test 3.
//
// Fake server closes the connection without sending a newline. Client
// must return a clear "no response" error, NOT hang.
func TestSendRequestServerClosesEarly(t *testing.T) {
	sockPath := startFakeDaemon(t, func(conn net.Conn) {
		_ = readRequest(t, conn)
		// Close without writing — defer in startFakeDaemon handles it.
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)

	done := make(chan error, 1)
	go func() {
		_, err := SendRequest("test", nil)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("expected error when server closes without response")
		}
		if !strings.Contains(err.Error(), "without response") &&
			!strings.Contains(err.Error(), "read response") {
			t.Fatalf("unexpected error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("SendRequest hung — should have returned promptly")
	}
}

// TestSendRequestErrorEnvelope — Test 4.
//
// Fake server returns a JSON-RPC error envelope. Client returns a
// non-nil error containing both the code and message.
func TestSendRequestErrorEnvelope(t *testing.T) {
	sockPath := startFakeDaemon(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		resp := Response{
			Jsonrpc: "2.0",
			ID:      req.ID,
			Error: &ResponseError{
				Code:    -32000,
				Message: "test error",
			},
		}
		_ = json.NewEncoder(conn).Encode(resp)
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)

	_, err := SendRequest("broken", nil)
	if err == nil {
		t.Fatalf("expected error from JSON-RPC error envelope")
	}
	msg := err.Error()
	if !strings.Contains(msg, "-32000") {
		t.Fatalf("error missing code: %v", err)
	}
	if !strings.Contains(msg, "test error") {
		t.Fatalf("error missing message: %v", err)
	}
}

// TestSendRequestOneRequestPerConnection — Test 5.
//
// Confirms that the client closes the connection after receiving the
// response (one-request-per-connection — Pitfall §3). The fake daemon
// counts accepted connections; two SendRequest calls must produce two
// distinct accepts.
func TestSendRequestOneRequestPerConnection(t *testing.T) {
	var accepts int64
	var wg sync.WaitGroup
	sockPath := startFakeDaemon(t, func(conn net.Conn) {
		atomic.AddInt64(&accepts, 1)
		req := readRequest(t, conn)
		resp := Response{Jsonrpc: "2.0", ID: req.ID, Result: json.RawMessage(`{}`)}
		_ = json.NewEncoder(conn).Encode(resp)
		wg.Done()
	})
	t.Setenv("CLAWCODE_MANAGER_SOCK", sockPath)

	wg.Add(2)
	if _, err := SendRequest("a", nil); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if _, err := SendRequest("b", nil); err != nil {
		t.Fatalf("second call: %v", err)
	}
	wg.Wait()
	if got := atomic.LoadInt64(&accepts); got != 2 {
		t.Fatalf("accepts: got %d, want 2 (Pitfall §3 — connection pooling?)", got)
	}
}

// TestSocketPathEnvOverride — Test 6.
//
// When CLAWCODE_MANAGER_SOCK is set, SocketPath returns it verbatim.
// When unset, returns the home-relative default.
func TestSocketPathEnvOverride(t *testing.T) {
	customPath := "/tmp/custom-test.sock"
	t.Setenv("CLAWCODE_MANAGER_SOCK", customPath)
	got, err := SocketPath()
	if err != nil {
		t.Fatalf("SocketPath: %v", err)
	}
	if got != customPath {
		t.Fatalf("override: got %q, want %q", got, customPath)
	}

	// Unset and verify default path shape.
	t.Setenv("CLAWCODE_MANAGER_SOCK", "")
	got, err = SocketPath()
	if err != nil {
		t.Fatalf("SocketPath default: %v", err)
	}
	if !strings.HasSuffix(got, ".clawcode/manager/clawcode.sock") {
		t.Fatalf("default path: got %q, want suffix .clawcode/manager/clawcode.sock", got)
	}
}

// TestSocketPathDefaultMatchesDaemonConvention pins the Go default to the
// exact same path the TypeScript daemon binds at
// src/manager/daemon.ts:SOCKET_PATH (~/.clawcode/manager/clawcode.sock).
//
// If either side renames, this test fails. Add to the failure message a
// reminder to update both in lockstep — the bug this guards against is
// the 2026-05-06 admin-clawdy canary failure where the Go default was
// "manager.sock" while the daemon bound "clawcode.sock", so net.Dial
// returned ENOENT and the shim exited 75 before MCP initialize.
func TestSocketPathDefaultMatchesDaemonConvention(t *testing.T) {
	t.Setenv("CLAWCODE_MANAGER_SOCK", "")
	got, err := SocketPath()
	if err != nil {
		t.Fatalf("SocketPath: %v", err)
	}
	home, homeErr := os.UserHomeDir()
	if homeErr != nil {
		t.Fatalf("UserHomeDir: %v", homeErr)
	}
	want := filepath.Join(home, ".clawcode", "manager", "clawcode.sock")
	if got != want {
		t.Fatalf("SocketPath default = %q, want %q (must match daemon SOCKET_PATH at src/manager/daemon.ts; rename one side without the other and the shim cannot dial the daemon)", got, want)
	}
}

// TestSocketPathHonorsOverride pins the env-override branch.
func TestSocketPathHonorsOverride(t *testing.T) {
	t.Setenv("CLAWCODE_MANAGER_SOCK", "/tmp/custom.sock")
	got, err := SocketPath()
	if err != nil {
		t.Fatalf("SocketPath: %v", err)
	}
	if got != "/tmp/custom.sock" {
		t.Fatalf("SocketPath override = %q, want /tmp/custom.sock", got)
	}
}
