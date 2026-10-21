// Package search — integration tests that spawn the COMPILED binary.
//
// Unlike register_test.go (which tests in-process Register against a
// fake daemon), these tests build the cmd/clawcode-mcp-shim binary
// once via TestMain and exec it with --type flags + stdin payloads.
// They verify production-wiring contracts that cannot be exercised
// from within a single Go process:
//
//   - --type search dispatch correctly invokes Register against a
//     fake daemon and tools/list returns the daemon-served names
//     (Test 1 — pin against future regressions where main.go reverts
//     to RegisterSpike).
//   - --type image and --type browser exit SHIM_EXIT_USAGE (64) with
//     stderr referencing the future plan numbers (Test 2 — pin until
//     plans 110-06 / 110-07 ship).
//   - Daemon socket gone causes exit 75 SHIM_EXIT_TEMPFAIL on boot
//     (Test 3 — Pitfall §5 SDK respawn semantics).
//   - Clean stdin EOF exits 0 SHIM_EXIT_OK (Test 4).
//   - Spike-only artifacts removed from the codebase (Test 5).
package search_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// shimBinaryPath is populated by TestMain. Each test exec's this with
// different --type flags and stdin payloads.
var shimBinaryPath string

// repoRoot is the absolute repository root, walked up from
// internal/shim/search/. Used for build invocation and source greps.
var repoRoot string

func TestMain(m *testing.M) {
	tmpDir, err := os.MkdirTemp("", "clawcode-mcp-shim-test-*")
	if err != nil {
		panic("TestMain: mkdir temp: " + err.Error())
	}
	defer os.RemoveAll(tmpDir)

	shimBinaryPath = filepath.Join(tmpDir, "clawcode-mcp-shim")

	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		panic("TestMain: abs repo root: " + err.Error())
	}
	repoRoot = root

	cmd := exec.Command("go", "build", "-o", shimBinaryPath, "./cmd/clawcode-mcp-shim")
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		panic("TestMain: build failed: " + err.Error() + "\n" + string(out))
	}

	os.Exit(m.Run())
}

// startFakeDaemon launches a unix-socket listener that responds to
// list-mcp-tools requests with a single web_search tool. Returns the
// socket path. Used by Tests 1 + 4.
func startFakeDaemon(t *testing.T) string {
	t.Helper()
	sockPath := filepath.Join(t.TempDir(), "daemon.sock")
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
				if req["method"] == "list-mcp-tools" {
					resp := map[string]interface{}{
						"jsonrpc": "2.0",
						"id":      req["id"],
						"result": map[string]interface{}{
							"tools": []map[string]interface{}{
								{
									"name":        "web_search",
									"description": "Search the web.",
									"inputSchema": map[string]interface{}{
										"type":       "object",
										"properties": map[string]interface{}{"query": map[string]interface{}{"type": "string"}},
										"required":   []string{"query"},
									},
								},
							},
						},
					}
					_ = json.NewEncoder(c).Encode(resp)
				}
			}(conn)
		}
	}()
	return sockPath
}

// TestIntegrationSearchDispatchesToProductionRegister — Test 1.
//
// Spawns the binary with --type search + a fake daemon serving
// list-mcp-tools. After initialize handshake, tools/list returns the
// daemon-served tool name (web_search). Confirms main.go is wired to
// the production Register, not RegisterSpike.
func TestIntegrationSearchDispatchesToProductionRegister(t *testing.T) {
	sockPath := startFakeDaemon(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, shimBinaryPath, "--type", "search")
	cmd.Env = append(os.Environ(),
		"CLAWCODE_MANAGER_SOCK="+sockPath,
		"CLAWCODE_AGENT=test-agent",
	)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("StdinPipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}

	// initialize
	initReq := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}` + "\n"
	if _, err := stdin.Write([]byte(initReq)); err != nil {
		t.Fatalf("write initialize: %v", err)
	}
	notifInit := `{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}` + "\n"
	if _, err := stdin.Write([]byte(notifInit)); err != nil {
		t.Fatalf("write initialized notif: %v", err)
	}
	// tools/list
	listReq := `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}` + "\n"
	if _, err := stdin.Write([]byte(listReq)); err != nil {
		t.Fatalf("write tools/list: %v", err)
	}

	// Read frames until we see id=2 response.
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	var listResp map[string]interface{}
	deadline := time.After(5 * time.Second)
	done := make(chan bool, 1)
	go func() {
		for scanner.Scan() {
			line := scanner.Bytes()
			var frame map[string]interface{}
			if err := json.Unmarshal(line, &frame); err != nil {
				continue
			}
			if id, ok := frame["id"].(float64); ok && id == 2 {
				listResp = frame
				done <- true
				return
			}
		}
		done <- false
	}()

	select {
	case ok := <-done:
		if !ok {
			t.Fatalf("never received tools/list response\nstderr: %s", stderr.String())
		}
	case <-deadline:
		_ = cmd.Process.Kill()
		t.Fatalf("timeout waiting for tools/list\nstderr: %s", stderr.String())
	}

	_ = stdin.Close()
	go func() { _ = cmd.Wait() }()

	// Validate tools list
	result, ok := listResp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("no result in tools/list: %+v", listResp)
	}
	tools, ok := result["tools"].([]interface{})
	if !ok || len(tools) == 0 {
		t.Fatalf("expected ≥1 tools, got %v", tools)
	}
	tool0, _ := tools[0].(map[string]interface{})
	if tool0["name"] != "web_search" {
		t.Fatalf("tool[0].name: got %v, want web_search (production Register not wired?)", tool0["name"])
	}
}

// TestIntegrationImageBrowserStubsExitUsage — Test 2.
//
// Spawning with --type image or --type browser must exit 64 (USAGE)
// with stderr referencing the future plan numbers. This pins the stub
// behavior until plans 110-06 / 110-07 land.
func TestIntegrationImageBrowserStubsExitUsage(t *testing.T) {
	cases := []struct {
		shimType string
		planRef  string
	}{
		{"image", "110-06"},
		{"browser", "110-07"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.shimType, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			cmd := exec.CommandContext(ctx, shimBinaryPath, "--type", tc.shimType)
			cmd.Stdin = strings.NewReader("")
			var stdout, stderr bytes.Buffer
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr

			err := cmd.Run()
			if err == nil {
				t.Fatalf("expected non-zero exit for stub type %q", tc.shimType)
			}
			exitErr, ok := err.(*exec.ExitError)
			if !ok {
				t.Fatalf("expected *exec.ExitError, got %T: %v", err, err)
			}
			if exitErr.ExitCode() != 64 {
				t.Fatalf("expected exit 64 (SHIM_EXIT_USAGE), got %d", exitErr.ExitCode())
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout must be empty (SDK owns stdout): %q", stdout.String())
			}
			if !strings.Contains(stderr.String(), tc.planRef) {
				t.Fatalf("stderr must reference plan %s; got %q", tc.planRef, stderr.String())
			}
			if !strings.Contains(stderr.String(), "not yet implemented") {
				t.Fatalf("stderr must say 'not yet implemented'; got %q", stderr.String())
			}
		})
	}
}

// TestIntegrationDaemonSocketGoneExitsTempfail — Test 3.
//
// With NO daemon listening on the configured socket path, the shim's
// boot-time list-mcp-tools call fails. The shim must exit 75
// (SHIM_EXIT_TEMPFAIL) so the SDK respawns it on next tool need —
// Pitfall §5 SDK respawn semantics.
func TestIntegrationDaemonSocketGoneExitsTempfail(t *testing.T) {
	bogusPath := filepath.Join(t.TempDir(), "no-such-daemon.sock")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, shimBinaryPath, "--type", "search")
	cmd.Env = append(os.Environ(),
		"CLAWCODE_MANAGER_SOCK="+bogusPath,
		"CLAWCODE_AGENT=test-agent",
	)
	cmd.Stdin = strings.NewReader("")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err == nil {
		t.Fatalf("expected non-zero exit when daemon socket is gone")
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("expected *exec.ExitError, got %T: %v", err, err)
	}
	if exitErr.ExitCode() != 75 {
		t.Fatalf("expected exit 75 (SHIM_EXIT_TEMPFAIL — Pitfall §5), got %d\nstderr: %s",
			exitErr.ExitCode(), stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout must be empty: %q", stdout.String())
	}
}

// TestIntegrationCleanStdinEOFExitsZero — Test 4.
//
// Spawn the binary with --type search + a working fake daemon, complete
// the boot-time IPC fetch, then close stdin immediately. The MCP SDK's
// stdio reader hits EOF and the server exits via the shutdown path.
// Exit code must be 0 (SHIM_EXIT_OK).
func TestIntegrationCleanStdinEOFExitsZero(t *testing.T) {
	sockPath := startFakeDaemon(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, shimBinaryPath, "--type", "search")
	cmd.Env = append(os.Environ(),
		"CLAWCODE_MANAGER_SOCK="+sockPath,
		"CLAWCODE_AGENT=test-agent",
	)
	cmd.Stdin = strings.NewReader("") // empty stdin → immediate EOF
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		exitErr, ok := err.(*exec.ExitError)
		if ok {
			t.Fatalf("expected exit 0, got %d\nstderr: %s",
				exitErr.ExitCode(), stderr.String())
		}
		t.Fatalf("clean EOF run failed: %v\nstderr: %s", err, stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout must be empty (SDK owns stdout): %q", stdout.String())
	}
}

// TestIntegrationNoSpikeArtifactsInSource — Test 5.
//
// Greps cmd/ and internal/shim/ for Wave 0 spike artifacts that should
// be gone after Wave 2 cutover. Future contributors who copy-paste the
// spike pattern will be caught at test time.
//
// Filters out:
//   - Lines inside this very test file (this file must literally
//     mention the patterns to grep for them).
//   - Lines that are pure Go comments (// ...) — historical references
//     in package-doc strings are acceptable.
//
// What remains MUST be empty: any active code reference (function call,
// type name, version string usage) is a real regression.
func TestIntegrationNoSpikeArtifactsInSource(t *testing.T) {
	cmd := exec.Command("grep", "-rnE",
		`RegisterSpike|0\.1\.0-spike`,
		filepath.Join(repoRoot, "cmd"),
		filepath.Join(repoRoot, "internal", "shim"),
	)
	out, _ := cmd.CombinedOutput()
	// grep exits 1 when no matches found — that's success.
	// grep exits 0 when matches found — filter and inspect.
	var bad []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		// Skip lines inside this test file (it must contain the patterns
		// in order to grep for them).
		if strings.Contains(line, "integration_test.go") {
			continue
		}
		// Skip pure-comment references (the line content after the
		// path:lineno: prefix begins with `//` or `*` or whitespace+`//`).
		// Format: <path>:<lineno>:<text>
		parts := strings.SplitN(line, ":", 3)
		if len(parts) == 3 {
			text := strings.TrimLeft(parts[2], " \t")
			if strings.HasPrefix(text, "//") || strings.HasPrefix(text, "*") {
				continue
			}
		}
		bad = append(bad, line)
	}
	if len(bad) > 0 {
		t.Fatalf("forbidden spike artifacts present in source (active code references):\n%s",
			strings.Join(bad, "\n"))
	}
}

// _ ensures fmt is referenced even when log lines are removed from a
// future test. Belt-and-suspenders against unused-import noise.
var _ = fmt.Sprintf
