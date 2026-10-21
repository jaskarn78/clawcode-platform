import { describe, it, expect } from "vitest";
import {
  renderMcpPromptBlock,
  MCP_PREAUTH_STATEMENT,
  MCP_VERBATIM_ERROR_RULE,
  MCP_LAST_ERROR_MAX_CHARS,
} from "../mcp-prompt-block.js";
import type { McpServerState } from "../../mcp/readiness.js";

/**
 * Phase 85 Plan 02 — unit tests for `renderMcpPromptBlock`.
 *
 * These tests pin the canonical wording of the TOOL-02 preauth statement
 * and the TOOL-05 verbatim-error rule so that a later edit cannot silently
 * reword either string without breaking a named assertion. They also pin
 * the absence-of-env-leak invariant that closes Pitfall 12.
 */

type ServerInput = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly optional?: boolean;
};

function makeState(overrides: Partial<McpServerState> & { name: string }): McpServerState {
  return Object.freeze({
    name: overrides.name,
    status: overrides.status ?? "ready",
    lastSuccessAt: overrides.lastSuccessAt ?? 1_700_000_000_000,
    lastFailureAt: overrides.lastFailureAt ?? null,
    lastError: overrides.lastError ?? null,
    failureCount: overrides.failureCount ?? 0,
    optional: overrides.optional ?? false,
  });
}

const oneServer: ServerInput = Object.freeze({
  name: "1password",
  command: "op-mcp",
  args: Object.freeze([]),
  env: Object.freeze({ OP_TOKEN: "secret-token-value" }),
});

describe("renderMcpPromptBlock — TOOL-02 preauth statement", () => {
  it("Test 1: output includes the verbatim 'MCP tools are pre-authenticated' string", () => {
    const stateByName = new Map([
      [oneServer.name, makeState({ name: oneServer.name, status: "ready" })],
    ]);
    const out = renderMcpPromptBlock({ servers: [oneServer], stateByName });
    expect(out).toContain("MCP tools are pre-authenticated");
    expect(out).toContain(MCP_PREAUTH_STATEMENT);
  });
});

describe("renderMcpPromptBlock — TOOL-05 verbatim-error rule", () => {
  it("Test 2: output includes the verbatim error-reporting instruction", () => {
    const stateByName = new Map([
      [oneServer.name, makeState({ name: oneServer.name, status: "ready" })],
    ]);
    const out = renderMcpPromptBlock({ servers: [oneServer], stateByName });
    expect(out).toContain(
      "If an MCP tool reports an error, include the actual error message verbatim; do not assume the tool is misconfigured unless the error explicitly states misconfiguration",
    );
    expect(out).toContain(MCP_VERBATIM_ERROR_RULE);
  });
});

describe("renderMcpPromptBlock — status table", () => {
  it("Test 3: renders a markdown table with the canonical header + one row per server, covering all statuses", () => {
    const servers: readonly ServerInput[] = [
      { name: "ready-server", command: "r", args: [], env: {} },
      { name: "degraded-server", command: "d", args: [], env: {} },
      { name: "failed-server", command: "f", args: [], env: {} },
      { name: "reconnecting-server", command: "rc", args: [], env: {} },
      { name: "unknown-server", command: "u", args: [], env: {} },
    ];
    const stateByName = new Map<string, McpServerState>([
      ["ready-server", makeState({ name: "ready-server", status: "ready" })],
      ["degraded-server", makeState({ name: "degraded-server", status: "degraded" })],
      [
        "failed-server",
        makeState({
          name: "failed-server",
          status: "failed",
          lastError: { message: "ECONNREFUSED" },
        }),
      ],
      [
        "reconnecting-server",
        makeState({ name: "reconnecting-server", status: "reconnecting" }),
      ],
      // unknown-server intentionally absent from the map
    ]);
    const out = renderMcpPromptBlock({ servers, stateByName });
    expect(out).toContain("| Server | Status | Tools | Last Error |");
    expect(out).toContain("|--------|--------|-------|------------|");
    // Match each status exactly within a row cell (surrounded by ` | `).
    expect(out).toMatch(/\| ready-server \| ready \|/);
    expect(out).toMatch(/\| degraded-server \| degraded \|/);
    expect(out).toMatch(/\| failed-server \| failed \|/);
    expect(out).toMatch(/\| reconnecting-server \| reconnecting \|/);
    expect(out).toMatch(/\| unknown-server \| unknown \|/);
  });
});

describe("renderMcpPromptBlock — TOOL-04 verbatim error passthrough", () => {
  it("Test 4: failed server's lastError.message appears verbatim in the Last Error column", () => {
    const server: ServerInput = { name: "b", command: "bad", args: [], env: {} };
    const stateByName = new Map<string, McpServerState>([
      [
        "b",
        makeState({
          name: "b",
          status: "failed",
          lastError: { message: "Failed to start: ENOENT" },
        }),
      ],
    ]);
    const out = renderMcpPromptBlock({ servers: [server], stateByName });
    // Verbatim — no truncation, no rewording.
    expect(out).toContain("Failed to start: ENOENT");
    // And appears within the table row for this server.
    expect(out).toMatch(/\| b \| failed \| [^|]+\| Failed to start: ENOENT \|/);
    // Anti-rewording guards.
    expect(out).not.toContain("tool unavailable");
    expect(out).not.toContain("Tool unavailable");
  });
});

describe("renderMcpPromptBlock — empty servers short-circuit", () => {
  it("Test 5: zero servers produce an empty string (no preamble, no table, no rule)", () => {
    const out = renderMcpPromptBlock({ servers: [], stateByName: new Map() });
    expect(out).toBe("");
  });
});

describe("renderMcpPromptBlock — tools column", () => {
  it("Test 6: Tools column renders as an em dash (U+2014) when names are not yet known", () => {
    const stateByName = new Map([
      [oneServer.name, makeState({ name: oneServer.name, status: "ready" })],
    ]);
    const out = renderMcpPromptBlock({ servers: [oneServer], stateByName });
    // Em dash is a single character — not two hyphens.
    expect(out).toContain("\u2014");
    // The row must contain the em-dash cell (padded with surrounding spaces).
    expect(out).toMatch(/\| \u2014 \|/);
    // Double-hyphen must NOT stand in for the em dash (guards against a
    // careless editor replacement).
    expect(out).not.toMatch(/\| -- \|/);
  });
});

describe("renderMcpPromptBlock — optional servers", () => {
  it("Test 7: optional server with non-ready status is annotated as '(optional)' in the Status cell", () => {
    const optionalFailed: ServerInput = {
      name: "opt-fail",
      command: "f",
      args: [],
      env: {},
      optional: true,
    };
    const stateByName = new Map<string, McpServerState>([
      [
        "opt-fail",
        makeState({
          name: "opt-fail",
          status: "failed",
          optional: true,
          lastError: { message: "boom" },
        }),
      ],
    ]);
    const out = renderMcpPromptBlock({
      servers: [optionalFailed],
      stateByName,
    });
    expect(out).toMatch(/\| opt-fail \| failed \(optional\) \|/);
  });

  it("Test 7b: optional server in 'ready' status does NOT carry the '(optional)' annotation", () => {
    const optionalReady: ServerInput = {
      name: "opt-ok",
      command: "o",
      args: [],
      env: {},
      optional: true,
    };
    const stateByName = new Map<string, McpServerState>([
      [
        "opt-ok",
        makeState({ name: "opt-ok", status: "ready", optional: true }),
      ],
    ]);
    const out = renderMcpPromptBlock({
      servers: [optionalReady],
      stateByName,
    });
    expect(out).toMatch(/\| opt-ok \| ready \|/);
    expect(out).not.toContain("(optional)");
  });
});

describe("renderMcpPromptBlock — Pitfall 12 security closure", () => {
  it("Test 8: output NEVER contains server.command, server.args, or any value from server.env", () => {
    const server: ServerInput = {
      name: "sensitive",
      command: "/usr/local/bin/op-mcp-cli", // must not appear
      args: ["--token", "SECRET-ARG-VALUE"], // must not appear
      env: {
        OP_TOKEN: "SECRET-ENV-VALUE-abc123",
        OPENAI_API_KEY: "sk-shouldnotleak",
      }, // values must not appear
      optional: false,
    };
    const stateByName = new Map<string, McpServerState>([
      ["sensitive", makeState({ name: "sensitive", status: "ready" })],
    ]);
    const out = renderMcpPromptBlock({ servers: [server], stateByName });

    // Command / args leak check.
    expect(out).not.toContain("/usr/local/bin/op-mcp-cli");
    expect(out).not.toContain("SECRET-ARG-VALUE");
    expect(out).not.toContain("--token");
    // Env values leak check.
    expect(out).not.toContain("SECRET-ENV-VALUE-abc123");
    expect(out).not.toContain("sk-shouldnotleak");
    // Name-only rendering check — the server name IS expected to appear.
    expect(out).toContain("sensitive");
  });
});

describe("renderMcpPromptBlock — pipe + newline escaping in lastError", () => {
  it("escapes `|` and strips newlines in lastError.message so the table stays valid", () => {
    const server: ServerInput = { name: "m", command: "m", args: [], env: {} };
    const stateByName = new Map<string, McpServerState>([
      [
        "m",
        makeState({
          name: "m",
          status: "failed",
          lastError: { message: "line1 | raw pipe\nline2" },
        }),
      ],
    ]);
    const out = renderMcpPromptBlock({ servers: [server], stateByName });
    // Pipes inside the error message are escaped.
    expect(out).toContain("line1 \\| raw pipe line2");
    // And the table has exactly 5 cells per row (4 pipes + 1 leading + 1 trailing)
    // — the row for `m` must not break across lines.
    const rowMatch = out.match(/\| m \| failed \|[^\n]+\|$/m);
    expect(rowMatch).not.toBeNull();
  });
});

describe("renderMcpPromptBlock — lastError defensive cap (context-bloat #6)", () => {
  it("caps a pathological multi-KB lastError at MCP_LAST_ERROR_MAX_CHARS with an ellipsis", () => {
    const server: ServerInput = { name: "m", command: "m", args: [], env: {} };
    const giant = "E".repeat(5000); // pathological multi-KB JSON-RPC error
    const stateByName = new Map<string, McpServerState>([
      [
        "m",
        makeState({
          name: "m",
          status: "failed",
          lastError: { message: giant },
        }),
      ],
    ]);
    const out = renderMcpPromptBlock({ servers: [server], stateByName });
    // The rendered cell carries at most MAX chars + a single ellipsis,
    // never the full 5000-char payload.
    const capped = "E".repeat(MCP_LAST_ERROR_MAX_CHARS) + "…";
    expect(out).toContain(capped);
    expect(out).not.toContain("E".repeat(MCP_LAST_ERROR_MAX_CHARS + 1));
  });

  it("leaves a normal-length lastError untouched (no ellipsis appended)", () => {
    const server: ServerInput = { name: "m", command: "m", args: [], env: {} };
    const stateByName = new Map<string, McpServerState>([
      [
        "m",
        makeState({
          name: "m",
          status: "failed",
          lastError: { message: "Failed to start: ENOENT" },
        }),
      ],
    ]);
    const out = renderMcpPromptBlock({ servers: [server], stateByName });
    expect(out).toContain("Failed to start: ENOENT");
    expect(out).not.toContain("…");
  });
});
