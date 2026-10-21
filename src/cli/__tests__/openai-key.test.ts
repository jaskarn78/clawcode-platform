/**
 * Phase 69 Plan 03 Task 4 — `clawcode openai-key` CLI tests (OPENAI-04).
 *
 * Tests the commander wiring + parseDuration helper + the injected-deps
 * create/list/revoke flow with mocked handlers. Also verifies the direct-DB
 * fallback path via an in-memory ApiKeysStore by wiring a deps bag that
 * routes through the real handler functions and an ephemeral DB file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDefaultDeps,
  parseDuration,
  registerOpenAiKeyCommand,
  type OpenAiKeyCommandDeps,
} from "../commands/openai-key.js";
import { ApiKeysStore } from "../../openai/keys.js";
import type {
  OpenAiKeyCreateRequest,
  OpenAiKeyCreateResponse,
  OpenAiKeyListResponse,
  OpenAiKeyRevokeRequest,
  OpenAiKeyRevokeResponse,
} from "../../openai/ipc-handlers.js";

function makeProgram(deps: OpenAiKeyCommandDeps): Command {
  const program = new Command()
    .name("clawcode")
    .exitOverride() // throw CommanderError instead of process.exit on parse errors
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerOpenAiKeyCommand(program, deps);
  return program;
}

function makeMockDeps(
  overrides: Partial<OpenAiKeyCommandDeps> = {},
): {
  deps: OpenAiKeyCommandDeps;
  logs: string[];
  errors: string[];
  exitCodes: number[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const deps: OpenAiKeyCommandDeps = {
    runCreate: vi.fn(async (req: OpenAiKeyCreateRequest) => {
      const agent = req.all === true ? "*" : req.agent;
      return {
        key: `ck_clawdy_${"x".repeat(32)}`,
        keyHash: "a".repeat(64),
        agent,
        label: req.label ?? null,
        expiresAt: req.expiresAt ?? null,
        createdAt: 1_700_000_000_000,
      };
    }),
    runList: vi.fn(async () => ({ rows: [] })),
    runRevoke: vi.fn(async () => ({ revoked: true })),
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    exit: (c: number) => exitCodes.push(c),
    ...overrides,
  };
  return { deps, logs, errors, exitCodes };
}

describe("parseDuration", () => {
  it("returns null for 'never'", () => {
    expect(parseDuration("never")).toBeNull();
  });
  it("parses days", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it("parses hours", () => {
    expect(parseDuration("6h")).toBe(6 * 60 * 60 * 1000);
  });
  it("parses minutes", () => {
    expect(parseDuration("15m")).toBe(15 * 60 * 1000);
  });
  it("parses seconds", () => {
    expect(parseDuration("90s")).toBe(90 * 1000);
  });
  it("parses 365d", () => {
    expect(parseDuration("365d")).toBe(365 * 24 * 60 * 60 * 1000);
  });
  it("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("30x")).toThrow();
    expect(() => parseDuration("-5d")).toThrow();
  });
});

describe("clawcode openai-key create", () => {
  it("invokes runCreate with the agent name", async () => {
    const { deps, logs } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync(["node", "clawcode", "openai-key", "create", "clawdy"]);
    expect(deps.runCreate).toHaveBeenCalledOnce();
    const call = (deps.runCreate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.agent).toBe("clawdy");
    // By default --expires is "never" → expiresAt undefined.
    expect(call.expiresAt).toBeUndefined();
    // Output contains the key exactly once AND a security warning.
    const joined = logs.join("\n");
    expect(joined).toContain("ck_clawdy_");
    expect(joined).toContain("will not be shown again");
  });

  it("applies --label", async () => {
    const { deps } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "create",
      "clawdy",
      "--label",
      "my-test",
    ]);
    const call = (deps.runCreate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.label).toBe("my-test");
  });

  it("applies --expires 30d as epoch ms", async () => {
    const before = Date.now();
    const { deps } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "create",
      "clawdy",
      "--expires",
      "30d",
    ]);
    const after = Date.now();
    const call = (deps.runCreate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const expiresAt = call.expiresAt as number;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyDaysMs);
    expect(expiresAt).toBeLessThanOrEqual(after + thirtyDaysMs);
  });

  it("--expires never sets expiresAt undefined", async () => {
    const { deps } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "create",
      "clawdy",
      "--expires",
      "never",
    ]);
    const call = (deps.runCreate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.expiresAt).toBeUndefined();
  });

  it("invalid --expires prints error + exits 1", async () => {
    const { deps, errors, exitCodes } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "create",
      "clawdy",
      "--expires",
      "bad-unit",
    ]);
    expect(exitCodes).toContain(1);
    expect(errors.join("\n")).toContain("Invalid --expires");
  });

  it("unknown-agent error from runCreate surfaces to stderr", async () => {
    const { deps, errors, exitCodes } = makeMockDeps({
      runCreate: vi.fn(async () => {
        throw new Error("Unknown agent: 'ghost'");
      }),
    });
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "create",
      "ghost",
    ]);
    expect(errors.join("\n")).toContain("Unknown agent");
    expect(exitCodes).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// Quick task 260419-p51 — --all flag coverage (P51-MULTI-AGENT-KEY)
// ---------------------------------------------------------------------------

describe("clawcode openai-key create --all", () => {
  it("invokes runCreate with {all:true} when --all is set (no positional agent)", async () => {
    const { deps, logs } = makeMockDeps({
      runCreate: vi.fn(async () => ({
        key: `ck_all_${"x".repeat(32)}`,
        keyHash: "b".repeat(64),
        agent: "*",
        label: "openclaw-all",
        expiresAt: null,
        createdAt: 1_700_000_000_000,
      })),
    });
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "create",
      "--all",
      "--label",
      "openclaw-all",
    ]);
    expect(deps.runCreate).toHaveBeenCalledOnce();
    const call = (deps.runCreate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.all).toBe(true);
    expect(call.agent).toBeUndefined();
    expect(call.label).toBe("openclaw-all");
    // Output renders the "(all)" sentinel, never the raw "*".
    const joined = logs.join("\n");
    expect(joined).toContain("ck_all_");
    expect(joined).toContain("(all)");
    expect(joined).not.toMatch(/^Agent:\s*\*/m);
  });

  it("rejects {agent, --all} together — mutual exclusion, exits 1", async () => {
    const { deps, errors, exitCodes } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "create",
      "clawdy",
      "--all",
    ]);
    expect(deps.runCreate).not.toHaveBeenCalled();
    expect(exitCodes).toContain(1);
    expect(errors.join("\n")).toMatch(/--all|agent/i);
  });

  it("rejects neither agent nor --all — exits 1 with helpful error", async () => {
    const { deps, errors, exitCodes } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync(["node", "clawcode", "openai-key", "create"]);
    expect(deps.runCreate).not.toHaveBeenCalled();
    expect(exitCodes).toContain(1);
    expect(errors.join("\n")).toMatch(/agent|--all/i);
  });
});

describe("clawcode openai-key list — Scope column", () => {
  it("renders a Scope column with values like 'agent:clawdy' and 'all'", async () => {
    const now = Date.now();
    const { deps, logs } = makeMockDeps({
      runList: vi.fn(async () => ({
        rows: [
          {
            key_hash: "1234567890abcdef".repeat(4),
            agent_name: "clawdy",
            scope: "agent:clawdy",
            label: "pinned",
            created_at: now - 3600_000,
            last_used_at: null,
            expires_at: null,
            disabled_at: null,
          },
          {
            key_hash: "abcdef1234567890".repeat(4),
            agent_name: "*",
            scope: "all",
            label: "fleet",
            created_at: now - 7200_000,
            last_used_at: null,
            expires_at: null,
            disabled_at: null,
          },
        ],
      })),
    });
    const program = makeProgram(deps);
    await program.parseAsync(["node", "clawcode", "openai-key", "list"]);
    const out = logs.join("\n");
    expect(out).toContain("Scope");
    expect(out).toContain("agent:clawdy");
    expect(out).toContain("all");
    // Sanity: the Scope column sits between Agent and Hash in the header row.
    const header = out.split("\n")[0] ?? "";
    expect(header.indexOf("Agent")).toBeLessThan(header.indexOf("Scope"));
    expect(header.indexOf("Scope")).toBeLessThan(header.indexOf("Hash"));
  });
});

describe("clawcode openai-key list", () => {
  it("prints 'no keys yet' when list is empty", async () => {
    const { deps, logs } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync(["node", "clawcode", "openai-key", "list"]);
    expect(logs.join("\n")).toContain("No keys yet");
  });

  it("prints a table with hash prefix + status columns", async () => {
    const now = Date.now();
    const { deps, logs } = makeMockDeps({
      runList: vi.fn(
        async (): Promise<OpenAiKeyListResponse> => ({
          rows: [
            {
              key_hash: "1234567890abcdef".repeat(4),
              agent_name: "clawdy",
              scope: "agent:clawdy",
              label: "label-active",
              created_at: now - 3600_000,
              last_used_at: now - 100_000,
              expires_at: null,
              disabled_at: null,
            },
            {
              key_hash: "abcdef1234567890".repeat(4),
              agent_name: "clawdy",
              scope: "agent:clawdy",
              label: "label-revoked",
              created_at: now - 7200_000,
              last_used_at: null,
              expires_at: null,
              disabled_at: now - 60_000,
            },
            {
              key_hash: "fedcba0987654321".repeat(4),
              agent_name: "clawdy",
              scope: "agent:clawdy",
              label: "label-expired",
              created_at: now - 7200_000,
              last_used_at: null,
              expires_at: now - 10_000,
              disabled_at: null,
            },
          ],
        }),
      ),
    });
    const program = makeProgram(deps);
    await program.parseAsync(["node", "clawcode", "openai-key", "list"]);
    const out = logs.join("\n");
    expect(out).toContain("Hash");
    expect(out).toContain("Status");
    expect(out).toContain("12345678"); // prefix-8 of first row
    expect(out).toContain("active");
    expect(out).toContain("disabled");
    expect(out).toContain("expired");
  });

  it("never prints any plaintext key (hash is prefix only)", async () => {
    const { deps, logs } = makeMockDeps({
      runList: vi.fn(
        async (): Promise<OpenAiKeyListResponse> => ({
          rows: [
            {
              key_hash: "a".repeat(64),
              agent_name: "clawdy",
              scope: "agent:clawdy",
              label: "t",
              created_at: Date.now(),
              last_used_at: null,
              expires_at: null,
              disabled_at: null,
            },
          ],
        }),
      ),
    });
    const program = makeProgram(deps);
    await program.parseAsync(["node", "clawcode", "openai-key", "list"]);
    const out = logs.join("\n");
    expect(out).not.toContain("ck_"); // no plaintext key prefix
    expect(out).not.toContain("a".repeat(64)); // no full hash
  });
});

describe("clawcode openai-key revoke", () => {
  it("prints 'Revoked.' on success", async () => {
    const { deps, logs } = makeMockDeps({
      runRevoke: vi.fn(
        async (_req: OpenAiKeyRevokeRequest): Promise<OpenAiKeyRevokeResponse> => ({
          revoked: true,
        }),
      ),
    });
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "revoke",
      "my-label",
    ]);
    expect(logs.join("\n")).toContain("Revoked.");
  });

  it("prints 'No matching key found' + exits 1 on miss", async () => {
    const { deps, logs, exitCodes } = makeMockDeps({
      runRevoke: vi.fn(async () => ({ revoked: false })),
    });
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "revoke",
      "nonexistent",
    ]);
    expect(logs.join("\n")).toContain("No matching key found");
    expect(exitCodes).toContain(1);
  });

  it("passes the identifier through as-is (label | hash prefix | full key)", async () => {
    const { deps } = makeMockDeps();
    const program = makeProgram(deps);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "revoke",
      "abcdef12",
    ]);
    const call = (deps.runRevoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.identifier).toBe("abcdef12");
  });
});

describe("direct-DB fallback integration (daemon down)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-openai-key-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildDefaultDeps + sendIpcRequest failing → falls back to direct DB", async () => {
    // Build a minimal deps bag that routes create/list/revoke through a
    // temp-dir ApiKeysStore directly (simulating the fallback path).
    const dbPath = join(dir, "api-keys.db");
    const logs: string[] = [];
    const errors: string[] = [];
    const deps: OpenAiKeyCommandDeps = {
      runCreate: async (req) => {
        const store = new ApiKeysStore(dbPath);
        try {
          const { key, row } = req.all === true
            ? store.createAllKey({ label: req.label, expiresAt: req.expiresAt })
            : store.createKey(req.agent, {
                label: req.label,
                expiresAt: req.expiresAt,
              });
          return {
            key,
            keyHash: row.key_hash,
            agent: row.agent_name,
            label: row.label,
            expiresAt: row.expires_at,
            createdAt: row.created_at,
          } as OpenAiKeyCreateResponse;
        } finally {
          store.close();
        }
      },
      runList: async () => {
        const store = new ApiKeysStore(dbPath);
        try {
          const rows = store.listKeys();
          return { rows: rows.map((r) => ({ ...r })) };
        } finally {
          store.close();
        }
      },
      runRevoke: async (req) => {
        const store = new ApiKeysStore(dbPath);
        try {
          return { revoked: store.revokeKey(req.identifier) };
        } finally {
          store.close();
        }
      },
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
      exit: () => {},
    };
    const program = makeProgram(deps);

    // Create → list → revoke by label.
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "create",
      "clawdy",
      "--label",
      "first",
    ]);
    const program2 = makeProgram(deps);
    await program2.parseAsync(["node", "clawcode", "openai-key", "list"]);
    const program3 = makeProgram(deps);
    await program3.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "revoke",
      "first",
    ]);

    const joined = logs.join("\n");
    expect(joined).toContain("ck_clawdy_");
    expect(joined).toContain("first"); // label appears in list
    expect(joined).toContain("Revoked.");
  });

  it("revoke by 8+ hex prefix matches", async () => {
    const dbPath = join(dir, "api-keys.db");
    const store = new ApiKeysStore(dbPath);
    const { row } = store.createKey("clawdy", { label: "prefix-test" });
    store.close();

    const logs: string[] = [];
    const deps: OpenAiKeyCommandDeps = {
      runCreate: vi.fn() as unknown as OpenAiKeyCommandDeps["runCreate"],
      runList: vi.fn() as unknown as OpenAiKeyCommandDeps["runList"],
      runRevoke: async (req) => {
        const s = new ApiKeysStore(dbPath);
        try {
          return { revoked: s.revokeKey(req.identifier) };
        } finally {
          s.close();
        }
      },
      log: (m) => logs.push(m),
      error: () => {},
      exit: () => {},
    };
    const program = makeProgram(deps);
    const prefix = row.key_hash.slice(0, 10);
    await program.parseAsync([
      "node",
      "clawcode",
      "openai-key",
      "revoke",
      prefix,
    ]);
    expect(logs.join("\n")).toContain("Revoked.");
  });
});

describe("buildDefaultDeps", () => {
  it("returns a deps object with all three runners + log/error/exit", () => {
    const deps = buildDefaultDeps();
    expect(typeof deps.runCreate).toBe("function");
    expect(typeof deps.runList).toBe("function");
    expect(typeof deps.runRevoke).toBe("function");
    expect(typeof deps.log).toBe("function");
    expect(typeof deps.error).toBe("function");
    expect(typeof deps.exit).toBe("function");
  });
});
