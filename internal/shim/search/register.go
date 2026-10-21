// Package search — Stage 0b production search MCP shim. Replaces the
// Wave 0 spike (RegisterSpike, deleted in plan 110-04 Task 2).
//
// Register fetches the canonical tool schemas from the daemon at boot
// via the `list-mcp-tools` IPC method (Wave 1 — plan 110-01 ships the
// daemon-side handler). This keeps Zod the single source of truth for
// tool schemas; Go never duplicates or codegens them. (Pitfall §4 —
// schema drift.)
//
// Per `tools/call`, the handler dispatches `search-tool-call` IPC to
// the daemon with the byte-equivalent params shape used by the
// existing TypeScript shim at src/search/mcp-server.ts:
//
//	{ agent: <CLAWCODE_AGENT>, toolName: <name>, args: <claude args> }
//
// Crash-fallback (LOCKED — operator decision 2026-05-05):
// every IPC error returns to Claude as a CallToolResult error envelope
// (IsError=true). NO automatic recovery, NO secondary attempt,
// NO Node fallback — surface daemon failures so they are visible.
// Operators flip the runtime flag in clawcode.yaml if Go misbehaves;
// the shim itself never silently degrades.
package search

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

// Register fetches the search tool schemas from the daemon at boot and
// adds each tool to the MCP server with a handler that forwards
// tools/call invocations to `search-tool-call` IPC.
//
// Returns an error if:
//   - CLAWCODE_AGENT env is unset (operator misconfiguration; matches
//     Node shim behavior at src/search/mcp-server.ts).
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
		"shimType": "search",
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
// tools/call invocation to the daemon's `search-tool-call` IPC method.
//
// The handler is a closure capturing `agent` (read once at boot) and
// `toolName` (the tool the handler was registered for). Each call dials
// a fresh socket connection (Pitfall §3 — one-request-per-connection).
//
// Fail-loud contract: any IPC error becomes a CallToolResult with
// IsError=true and the error message in TextContent. The handler does
// NOT return a Go error — returning a Go error here would mean the SDK
// reports a protocol-level error to the client, not a tool-level error
// envelope. The Node shim's behavior is tool-level errors; we match
// byte-for-byte.
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

		result, ipcErr := ipc.SendRequest("search-tool-call", params)
		if ipcErr != nil {
			// Fail-loud: surface the IPC error to claude as a tool-level
			// error envelope. The daemon may have died, the socket may
			// be gone, or the daemon may have returned a JSON-RPC error.
			// Either way, we do not swallow it and we do not attempt a
			// second dial.
			return errorResult(fmt.Sprintf("daemon error: %v", ipcErr)), nil
		}

		// The daemon's `search-tool-call` returns opaque JSON; we pass
		// through as a single TextContent block. The Node shim does the
		// same shape (cf. src/search/mcp-server.ts which serializes
		// outcome as JSON text).
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
