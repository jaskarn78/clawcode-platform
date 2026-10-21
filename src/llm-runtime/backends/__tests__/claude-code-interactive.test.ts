/**
 * Phase 140 Plan 01 + Plan 04 — ClaudeCodeInteractiveBackend tests.
 *
 * Plan 01 (Stage 1) covered the inert SHELL contract: factory dispatch,
 * discovery, the inert `FakeChannelsSdkModule` (query yields nothing +
 * completes on close), and the control-plane mutators throwing
 * `V3UnsupportedMutatorError`.
 *
 * Plan 04 (Stage 2, THIS suite's additions) crosses the backend from
 * "selectable but inert" to "spawns a real (faked) PTY + reads its
 * transcript":
 *   - `loadSdkModule()` now constructs + starts an injected PtySupervisor
 *     seam with the `claude --dangerously-load-development-channels` argv,
 *     and writes a per-agent `.mcp.json` wiring the clawcode-channel server.
 *   - `getSessionMessages` reads the on-disk `claude --channels` JSONL
 *     transcript (140-01-SUMMARY: `transcript_adapter_required: false` — the
 *     standard Claude Code JSONL the SDK already parses; no adapter).
 *   - the two Plan-03-deferred nits: dead `throwMutator` closure removed;
 *     `forkSession` REJECTS (not a sync throw) to match the query mutators.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import type { ResolvedAgentConfig } from "../../../shared/types.js";
import type { DiscoverCliBinaryDeps } from "../../discovery.js";
import type { SessionMessage } from "../../../manager/sdk-types.js";
import type { LlmRuntimeDeps } from "../../types.js";
import { createLlmRuntimeService } from "../../llm-runtime-service.js";
import {
  ClaudeCodeInteractiveBackend,
  FakeChannelsSdkModule,
  type ChannelSpawnSeam,
  type InteractiveBackendSeams,
  debugWriteToPtyForAgent,
  liveSupervisorByAgent,
  resolveInstalledPluginMcpServers,
} from "../claude-code-interactive.js";
import type {
  PtyHandle,
  PtySpawnFn,
  PtySupervisorTracker,
} from "../../supervisors/pty-supervisor.js";
import { V3UnsupportedMutatorError } from "../../errors/v3-unsupported-mutator.js";

const config = {
  name: "test-agent",
  model: "sonnet",
  llmRuntime: { backend: "claude-code-interactive" as const },
} as unknown as ResolvedAgentConfig;

/** Discovery stub: `which claude` resolves to a fixed path. */
const discoveryDeps: DiscoverCliBinaryDeps = {
  existsSync: () => false,
  which: async () => "/usr/local/bin/claude",
};

/** A fake supervisor seam recording its construction args + spawn calls. */
function makeFakeSupervisorFactory(): {
  factory: NonNullable<InteractiveBackendSeams["supervisorFactory"]>;
  calls: {
    constructions: Array<{ argv: readonly string[]; cwd: string; env: Readonly<Record<string, string | undefined>> }>;
    spawns: number;
    /**
     * 999.83-02 — recorded PTY writes (the warm-nudge / first-turn-input
     * keystrokes). Each entry is the raw string handed to `supervisor.write`.
     * The order here is the order the fired scheduler invoked `writeNudge`.
     */
    writes: string[];
  };
} {
  const calls = {
    constructions: [] as Array<{ argv: readonly string[]; cwd: string; env: Readonly<Record<string, string | undefined>> }>,
    spawns: 0,
    writes: [] as string[],
  };
  const factory: NonNullable<InteractiveBackendSeams["supervisorFactory"]> = (
    opts,
  ): ChannelSpawnSeam => {
    calls.constructions.push({ argv: opts.argv, cwd: opts.cwd, env: opts.env });
    return {
      spawn: async () => {
        calls.spawns += 1;
      },
      // 999.83-02 — expose a `write` so the warm-nudge fire loop has a PTY
      // sink. Records the raw keystroke payload so the ordering (\r-then-task)
      // and fire-once semantics can be asserted deterministically.
      write: (data: string) => {
        calls.writes.push(data);
      },
    };
  };
  return { factory, calls };
}

/**
 * 999.83-02 — a deterministic warm-nudge scheduler harness. The backend uses
 * ONE `scheduleResumeRefresh` seam for both the resume-id refreshes
 * (RESUME_REFRESH_DELAYS_MS = 2s/8s/30s) AND the warm-nudge fires
 * (WARM_NUDGE_DELAYS_MS = 5s/20s/45s). We record `(fn, ms)` pairs so the
 * warm-nudge tests can filter to the warm-nudge delays only, then fire just
 * those — isolating the PTY-write behavior from the resume refreshes.
 */
const WARM_NUDGE_MS = [5_000, 20_000, 45_000];
// 999.83-02 — the firstTurnInput task write is scheduled at 5_050 (the
// menu-dismiss \r at 5_000, the task a beat later). Resume-id refreshes use
// 2_000/8_000/30_000, so firing the warm-nudge family (5_000/5_050/20_000/
// 45_000) leaves the resume refreshes untouched.
const WARM_NUDGE_FIRE_MS = [5_000, 5_050, 20_000, 45_000];
function makeScheduleHarness(): {
  schedule: NonNullable<InteractiveBackendSeams["scheduleResumeRefresh"]>;
  scheduled: Array<{ fn: () => void; ms: number }>;
  fireWarmNudges: () => void;
} {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
    },
    scheduled,
    fireWarmNudges: () => {
      // Fire in time order so the recorded PTY-write order matches wall-clock
      // (the \r at 5_000 lands before the task at 5_050).
      [...scheduled]
        .filter(({ ms }) => WARM_NUDGE_FIRE_MS.includes(ms))
        .sort((a, b) => a.ms - b.ms)
        .forEach(({ fn }) => fn());
    },
  };
}

describe("factory dispatch", () => {
  it("returns a ClaudeCodeInteractiveBackend for the new backend id", () => {
    const svc = createLlmRuntimeService(config);
    expect(svc).toBeInstanceOf(ClaudeCodeInteractiveBackend);
  });
});

describe("ClaudeCodeInteractiveBackend — loadSdkModule (Plan 04: live PTY + channel wiring)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "cc-interactive-test-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function seams(
    fakeFactory: NonNullable<InteractiveBackendSeams["supervisorFactory"]>,
  ): InteractiveBackendSeams {
    return {
      supervisorFactory: fakeFactory,
      // Pin the channels-state dir into the tmp dir so the test owns cleanup.
      channelsStateDir: () => stateDir,
      // Deterministic dist path for the .mcp.json assertion.
      channelMcpServerPath: () => "/opt/clawcode/dist/channels/clawcode-channel-mcp-server.js",
    };
  }

  it("resolves a FakeChannelsSdkModule once discovery succeeds, and caches it", async () => {
    const { factory } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    const mod = await backend.loadSdkModule();
    expect(mod).toBeInstanceOf(FakeChannelsSdkModule);
    // Cached — same reference on the second call.
    expect(await backend.loadSdkModule()).toBe(mod);
  });

  it("starts the PtySupervisor exactly once and does not re-spawn on cache hit", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    await backend.loadSdkModule();
    expect(calls.spawns).toBe(1);
    expect(calls.constructions).toHaveLength(1);
  });

  it("hands the supervisor the channels argv (flags + mcp-config)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    // argv[0] must end in `claude` (orphan-claude-reaper coverage).
    expect(argv[0]).toMatch(/claude$/);
    // Phase 140-12 — dev flag APPROVES server: channel as a turn-source (plain
    // --channels loads it as an MCP server only, not a turn-source). Its
    // confirmation prompt is dismissed by the warm-nudge Enter.
    expect(argv).toContain("--dangerously-load-development-channels");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("server:clawcode-channel");
    // Phase 140 Model B — plugin:discord OMITTED by default (daemon owns the bot).
    expect(argv).not.toContain("plugin:discord@claude-plugins-official");
    expect(argv).toContain("--mcp-config");
    // Parity — the channel-protocol system prompt (ack contract + clawcode tools)
    // is appended so the agent behaves correctly by default (caveat #1).
    const spIdx = argv.indexOf("--append-system-prompt");
    expect(spIdx).toBeGreaterThan(-1);
    expect(argv[spIdx + 1]).toMatch(/clawcode_ack/);
  });

  // Phase 141 (A3) — the agent's `effort` config must reach the PTY as `--effort`
  // so v3 agents can be dialed below the CLI default (the latency root cause).
  it("threads agent effort onto the spawn as --effort <level>", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const lowEffortConfig = {
      ...config,
      effort: "low",
    } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(
      lowEffortConfig,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const eIdx = argv.indexOf("--effort");
    expect(eIdx).toBeGreaterThan(-1);
    expect(argv[eIdx + 1]).toBe("low");
  });

  // Phase 999.98-03 (gap closure) — the v3 spawn must emit a FULL `claude-*` id,
  // NOT the raw alias. `opus` resolves to its pinned `MODEL_ALIAS_MAP.opus`
  // (`claude-opus-4-8`), matching the v2/SDK adapter (which runs config.model
  // through resolveModelId). The pre-fix behavior (raw `opus` on the wire) is
  // what the 999.98 verifier flagged as the SC-5/SC-1 v3 root cause.
  it("threads the agent's configured model onto the spawn as --model, RESOLVED to the full id", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const opusConfig = {
      ...config,
      model: "opus",
    } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(
      opusConfig,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const mIdx = argv.indexOf("--model");
    expect(mIdx).toBeGreaterThan(-1);
    // RESOLVED: `opus` → its pinned `claude-opus-5-5` (the CLI accepts native
    // aliases too, but v2 sends the pinned id; v3 now matches it for parity).
    // 🚨 The pinned id requires CLI >= 2.1.280 on the wire — 2.1.257 400s on it.
    expect(argv[mIdx + 1]).toBe("claude-opus-5-5");
  });

  // Phase 999.98-03 (gap closure) — `fable` is a ClawCode-ONLY alias (not a
  // CLI-native alias like sonnet/opus/haiku). The v3 spawn MUST resolve it to the
  // full id `claude-fable-5` (the form CONTEXT's live entitlement probe proved
  // accepted); the bare alias `fable` is unverified on `--model` and was the
  // SC-1 v3 caveat. This is the SC-1 v3-path closure.
  it("resolves the ClawCode-only `fable` alias to `claude-fable-5` on the spawn", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const fableConfig = {
      ...config,
      model: "fable",
    } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(
      fableConfig,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const mIdx = argv.indexOf("--model");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("claude-fable-5");
    // NEVER the bare alias on the wire.
    expect(argv).not.toContain("fable");
  });

  // Phase 999.98-03 (gap closure) — `<family>@latest` with a POPULATED catalog
  // snapshot resolves to the newest entitled tier (proves the snapshot dep
  // actually reaches the backend, not just the cold-fallback half). SC-5 v3.
  it("resolves `opus@latest` to the newest snapshot tier when the catalog is populated", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const latestConfig = {
      ...config,
      model: "opus@latest",
    } as unknown as ResolvedAgentConfig;
    // A populated snapshot whose newest opus row is NEWER than the pinned alias
    // (claude-opus-5-5) — resolveLatestModel must pick claude-opus-5-10 (numeric
    // version compare, not lexical: "10" > "8"). Fixtures live above the pin so
    // the winner isn't floored to the pin.
    const deps: LlmRuntimeDeps = {
      getCatalogSnapshot: () => [
        {
          model_id: "claude-opus-5-10",
          display_name: "Claude Opus 5.10",
          last_seen_at: 1_800_000_000_000,
          family: "opus",
        },
        {
          model_id: "claude-opus-5-8",
          display_name: "Claude Opus 5.8",
          last_seen_at: 1_800_000_000_000,
          family: "opus",
        },
      ],
    };
    const backend = new ClaudeCodeInteractiveBackend(
      latestConfig,
      deps,
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const mIdx = argv.indexOf("--model");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("claude-opus-5-10");
    // NEVER the bare `@latest` sugar on the wire (the CLI can't parse it).
    expect(argv).not.toContain("opus@latest");
  });

  // Phase 999.98-03 (gap closure) — `<family>@latest` with a COLD/empty catalog
  // (no snapshot dep wired, or empty snapshot) falls back to the pinned alias
  // floor (`MODEL_ALIAS_MAP[family]`), and NEVER emits the bare `@latest`. SC-5
  // cold-fallback half.
  it("resolves `opus@latest` to the pinned alias when the catalog is cold/unwired", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const latestConfig = {
      ...config,
      model: "opus@latest",
    } as unknown as ResolvedAgentConfig;
    // No getCatalogSnapshot dep — the backend defaults to an empty snapshot.
    const backend = new ClaudeCodeInteractiveBackend(
      latestConfig,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const mIdx = argv.indexOf("--model");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("claude-opus-5-5");
    expect(argv).not.toContain("opus@latest");
  });

  it("omits --effort when effort is 'auto' (falls back to the CLI default)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const autoEffortConfig = {
      ...config,
      effort: "auto",
    } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(
      autoEffortConfig,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    expect(argv).not.toContain("--effort");
  });

  // Phase 141 (#4) — a headless daemon-spawned PTY has no TTY to answer a
  // permission prompt, so the spawn ALWAYS carries --permission-mode, defaulting
  // to bypassPermissions (parity with the v2 SDK path's hardcoded mode).
  it("always emits --permission-mode, defaulting to bypassPermissions", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const pIdx = argv.indexOf("--permission-mode");
    expect(pIdx).toBeGreaterThan(-1);
    expect(argv[pIdx + 1]).toBe("bypassPermissions");
  });

  it("honors a configured permissionMode via the backend seam", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      { ...seams(factory), permissionMode: "plan" },
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const pIdx = argv.indexOf("--permission-mode");
    expect(pIdx).toBeGreaterThan(-1);
    expect(argv[pIdx + 1]).toBe("plan");
  });

  // Phase 141 (#7) — a locked-down agent's Layer-1 tool blocklist must survive a
  // migration to v3; the v2 path forwards config.disallowedTools to the SDK, v3
  // had no slot and silently dropped it.
  it("threads disallowedTools onto the spawn as --disallowedTools (was dropped on v3)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const lockedConfig = {
      ...config,
      disallowedTools: ["Bash", "WebFetch"],
    } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(
      lockedConfig,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const dIdx = argv.indexOf("--disallowedTools");
    expect(dIdx).toBeGreaterThan(-1);
    expect(argv[dIdx + 1]).toBe("Bash");
    expect(argv[dIdx + 2]).toBe("WebFetch");
    // The variadic must stop before the next real flag (--settings follows).
    expect(argv).toContain("--settings");
  });

  it("omits --disallowedTools when the agent has none", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    expect(argv).not.toContain("--disallowedTools");
  });

  // Workspace isolation — v3 must restrict which setting TIERS the PTY auto-loads
  // to the agent's own `settingSources` (loader default ["project"]). Without
  // --setting-sources the CLI also loads GLOBAL ~/.claude/{settings,skills,commands,
  // CLAUDE.md} — shared across every v3 agent — so the agent would inherit config /
  // skills / identity from OUTSIDE its own workspace. Parity with v2 settingSources.
  it("threads settingSources onto the spawn as --setting-sources (default project → workspace-only)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const cfg = { ...config, settingSources: ["project"] } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(cfg, {}, discoveryDeps, seams(factory));
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const idx = argv.indexOf("--setting-sources");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("project");
  });

  it("honors an operator's multi-tier settingSources (e.g. project,user for GSD commands)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const cfg = { ...config, settingSources: ["project", "user"] } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(cfg, {}, discoveryDeps, seams(factory));
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const idx = argv.indexOf("--setting-sources");
    expect(argv[idx + 1]).toBe("project,user");
  });

  // Phase 141 WS-2 (Option B) — a locked-down agent (non-empty security.allowlist)
  // KEEPS its permission mode (bypassPermissions) so non-Bash + MCP tools work
  // (v2 parity), and gets a PreToolUse Bash hook + the CLAWCODE_BASH_ALLOWLIST
  // spawn-env var. `dontAsk` is NOT used (it would deny Write/Edit/MCP too).
  const settingsBlob = (argv: readonly string[]): Record<string, unknown> => {
    const sIdx = argv.indexOf("--settings");
    expect(sIdx).toBeGreaterThan(-1);
    return JSON.parse(argv[sIdx + 1]!) as Record<string, unknown>;
  };
  const preToolUseMatchers = (settings: Record<string, unknown>): string[] => {
    const hooks = settings.hooks as { PreToolUse?: Array<{ matcher?: string }> };
    return (hooks.PreToolUse ?? []).map((h) => h.matcher ?? "");
  };

  it("locked-down agent (security.allowlist) → keeps bypassPermissions + PreToolUse Bash hook + CLAWCODE_BASH_ALLOWLIST env (NO dontAsk, NO permissions key)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const lockedConfig = {
      ...config,
      security: {
        allowlist: [{ pattern: "git status *" }, { pattern: "npm test" }],
        denyScopeAll: false,
      },
    } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(
      lockedConfig,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const { argv, env } = calls.constructions[0]!;
    const pIdx = argv.indexOf("--permission-mode");
    expect(argv[pIdx + 1]).toBe("bypassPermissions"); // NOT dontAsk
    const settings = settingsBlob(argv);
    expect(settings.permissions).toBeUndefined(); // gate is the hook, not allow rules
    expect(preToolUseMatchers(settings)).toEqual(["Bash"]);
    // Allowlist patterns delivered to the hook via the spawn env.
    expect(JSON.parse(env.CLAWCODE_BASH_ALLOWLIST as string)).toEqual([
      "git status *",
      "npm test",
    ]);
  });

  it("explicit llmRuntime.permissionMode is still honored AND the Bash hook is still registered for a locked-down agent", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const lockedConfig = {
      ...config,
      security: { allowlist: [{ pattern: "git status *" }], denyScopeAll: false },
    } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(
      lockedConfig,
      {},
      discoveryDeps,
      { ...seams(factory), permissionMode: "plan" },
    );
    await backend.loadSdkModule();
    const { argv, env } = calls.constructions[0]!;
    const pIdx = argv.indexOf("--permission-mode");
    expect(argv[pIdx + 1]).toBe("plan"); // operator override wins
    expect(preToolUseMatchers(settingsBlob(argv))).toEqual(["Bash"]); // hook independent of mode
    expect(JSON.parse(env.CLAWCODE_BASH_ALLOWLIST as string)).toEqual([
      "git status *",
    ]);
  });

  it("no allowlist → bypassPermissions, NO PreToolUse hook, NO CLAWCODE_BASH_ALLOWLIST (non-locked-down unchanged)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const { argv, env } = calls.constructions[0]!;
    const pIdx = argv.indexOf("--permission-mode");
    expect(argv[pIdx + 1]).toBe("bypassPermissions");
    const settings = settingsBlob(argv);
    expect(settings.permissions).toBeUndefined();
    expect(preToolUseMatchers(settings)).toEqual([]); // no Bash hook
    expect(env.CLAWCODE_BASH_ALLOWLIST).toBeUndefined();
  });

  it("empty allowlist array → treated as non-locked-down (no hook, no env)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const emptyAllowlistConfig = {
      ...config,
      security: { allowlist: [], denyScopeAll: false },
    } as unknown as ResolvedAgentConfig;
    const backend = new ClaudeCodeInteractiveBackend(
      emptyAllowlistConfig,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    const { argv, env } = calls.constructions[0]!;
    expect(preToolUseMatchers(settingsBlob(argv))).toEqual([]);
    expect(env.CLAWCODE_BASH_ALLOWLIST).toBeUndefined();
  });

  it("writes a per-agent .mcp.json with the clawcode-channel server + the two CLAWCODE_* env vars", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();

    // The argv's --mcp-config value is the path the writer wrote to.
    const argv = calls.constructions[0]!.argv;
    const idx = argv.indexOf("--mcp-config");
    const mcpConfigPath = argv[idx + 1]!;
    expect(mcpConfigPath.startsWith(stateDir)).toBe(true);

    const written = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    const entry = written.mcpServers["clawcode-channel"];
    expect(entry).toBeDefined();
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual([
      "/opt/clawcode/dist/channels/clawcode-channel-mcp-server.js",
    ]);
    expect(entry.env.CLAWCODE_AGENT_NAME).toBe("test-agent");
    expect(typeof entry.env.CLAWCODE_DAEMON_SOCKET).toBe("string");
    expect(entry.env.CLAWCODE_DAEMON_SOCKET.length).toBeGreaterThan(0);
  });

  it("MCP parity — writes the agent's resolved mcpServers (shims + custom) alongside clawcode-channel", async () => {
    const parityConfig = {
      name: "test-agent",
      model: "sonnet",
      llmRuntime: { backend: "claude-code-interactive" as const },
      mcpServers: [
        {
          name: "search",
          command: "/opt/clawcode/bin/clawcode-mcp-shim",
          args: ["--type", "search"],
          env: { CLAWCODE_AGENT: "test-agent", CLAWCODE_MANAGER_SOCK: "/tmp/m.sock" },
          optional: false,
        },
        {
          name: "1password",
          command: "node",
          args: ["/x/op.js"],
          env: { OP_TOKEN: "resolved-secret" },
          optional: true,
        },
      ],
    } as unknown as ResolvedAgentConfig;

    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      parityConfig,
      {},
      discoveryDeps,
      // Deterministic clawcode command so the assertion isn't tied to argv[1].
      { ...seams(factory), clawcodeMcpCommand: { command: "node", args: ["/cc/cli.js", "mcp"] } },
    );
    await backend.loadSdkModule();

    const argv = calls.constructions[0]!.argv;
    const mcpConfigPath = argv[argv.indexOf("--mcp-config") + 1]!;
    const written = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));

    // The v3 agent gets the SAME shim + custom servers a v2 agent would …
    expect(written.mcpServers.search).toEqual({
      command: "/opt/clawcode/bin/clawcode-mcp-shim",
      args: ["--type", "search"],
      env: { CLAWCODE_AGENT: "test-agent", CLAWCODE_MANAGER_SOCK: "/tmp/m.sock" },
    });
    expect(written.mcpServers["1password"].env.OP_TOKEN).toBe("resolved-secret");
    // … the clawcode TOOL server (spawn_subagent_thread/post_to_agent/memory/…)
    //    with the authoritative CLAWCODE_AGENT identity + manager socket …
    expect(written.mcpServers.clawcode).toEqual({
      command: "node",
      args: ["/cc/cli.js", "mcp"],
      env: {
        CLAWCODE_AGENT: "test-agent",
        CLAWCODE_MANAGER_SOCK: expect.any(String),
      },
    });
    expect(written.mcpServers.clawcode.env.CLAWCODE_MANAGER_SOCK.length).toBeGreaterThan(0);
    // … PLUS the v3-only channel server (never shadowed).
    expect(written.mcpServers["clawcode-channel"]).toBeDefined();
    expect(written.mcpServers["clawcode-channel"].env.CLAWCODE_AGENT_NAME).toBe("test-agent");
  });

  // v3-optin — config.mcpEnvOverrides parity with the v2 SDK path. A acme
  // agent declares a vault-scoped op:// token for its 1password MCP server; the
  // injected opEnvResolver resolves it and the resolved value is merged
  // last-wins into the written .mcp.json env (other keys preserved, servers
  // without an override untouched).
  const acmeConfig = {
    name: "fin-client",
    model: "sonnet",
    llmRuntime: { backend: "claude-code-interactive" as const },
    mcpServers: [
      {
        name: "1password",
        command: "node",
        args: ["/x/op.js"],
        // The shared block carries the daemon's clawdbot-scoped fleet token.
        env: { OP_SERVICE_ACCOUNT_TOKEN: "clawdbot-fleet-token", KEEP: "unchanged" },
        optional: true,
      },
      {
        name: "search",
        command: "/opt/clawcode/bin/clawcode-mcp-shim",
        args: ["--type", "search"],
        env: { CLAWCODE_AGENT: "fin-client" },
        optional: false,
      },
    ],
    mcpEnvOverrides: {
      "1password": { OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-10/sa/credential" },
    },
  } as unknown as ResolvedAgentConfig;

  it("mcpEnvOverrides — resolves + merges the vault-scoped op:// token last-wins", async () => {
    // Stub resolver: simulate `op read` swapping any op:// value to the
    // Acme-vault-scoped token (the daemon wires the real SecretsResolver).
    const opEnvResolver = vi.fn(
      async (
        overrides: Record<string, Record<string, string>>,
        _agentName: string,
      ): Promise<Record<string, Record<string, string>>> => {
        const out: Record<string, Record<string, string>> = {};
        for (const [server, env] of Object.entries(overrides)) {
          out[server] = {};
          for (const [k, v] of Object.entries(env)) {
            out[server]![k] = v.startsWith("op://") ? "acme-scoped-token" : v;
          }
        }
        return out;
      },
    );

    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      acmeConfig,
      { opEnvResolver },
      discoveryDeps,
      { ...seams(factory), clawcodeMcpCommand: null },
    );
    await backend.loadSdkModule();

    const argv = calls.constructions[0]!.argv;
    const written = JSON.parse(
      readFileSync(argv[argv.indexOf("--mcp-config") + 1]!, "utf-8"),
    );

    // Override wins on the matching key …
    expect(written.mcpServers["1password"].env.OP_SERVICE_ACCOUNT_TOKEN).toBe(
      "acme-scoped-token",
    );
    // … other env keys on the same server are preserved …
    expect(written.mcpServers["1password"].env.KEEP).toBe("unchanged");
    // … a server WITHOUT an override entry passes through unchanged …
    expect(written.mcpServers.search.env).toEqual({ CLAWCODE_AGENT: "fin-client" });
    // … and the resolver saw the (mutable copy of the) override map + agent name.
    expect(opEnvResolver).toHaveBeenCalledWith(
      { "1password": { OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-10/sa/credential" } },
      "fin-client",
    );
  });

  it("mcpEnvOverrides — gated: no resolver wired → env written unchanged (no op:// leak)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    // deps WITHOUT opEnvResolver — the non-acme fleet / back-compat path.
    const backend = new ClaudeCodeInteractiveBackend(
      acmeConfig,
      {},
      discoveryDeps,
      { ...seams(factory), clawcodeMcpCommand: null },
    );
    await backend.loadSdkModule();

    const argv = calls.constructions[0]!.argv;
    const written = JSON.parse(
      readFileSync(argv[argv.indexOf("--mcp-config") + 1]!, "utf-8"),
    );

    // No resolver → no merge attempted; the shared-block value is written
    // verbatim (and the op:// URI is NOT written, since the override is skipped).
    expect(written.mcpServers["1password"].env.OP_SERVICE_ACCOUNT_TOKEN).toBe(
      "clawdbot-fleet-token",
    );
  });

  it("spawn env — merges per-agent channels-state/.env (DISCORD_BOT_TOKEN) + strips CLAUDE*", async () => {
    // Per-agent .env in the (tmp) state dir — the agent's own Discord bot.
    writeFileSync(path.join(stateDir, ".env"), 'DISCORD_BOT_TOKEN=agent-bot-xyz\n# comment\nFOO="bar"\n');
    const prevClaude = process.env.CLAUDE_HARNESS_MARKER;
    process.env.CLAUDE_HARNESS_MARKER = "should-be-stripped";
    try {
      const { factory, calls } = makeFakeSupervisorFactory();
      const backend = new ClaudeCodeInteractiveBackend(config, {}, discoveryDeps, seams(factory));
      await backend.loadSdkModule();
      const env = calls.constructions[0]!.env;
      // Per-agent .env merged …
      expect(env.DISCORD_BOT_TOKEN).toBe("agent-bot-xyz");
      expect(env.FOO).toBe("bar"); // quotes stripped
      // … nested CLAUDE* stripped so the child runs a fresh session.
      expect(env.CLAUDE_HARNESS_MARKER).toBeUndefined();
      // … non-CLAUDE daemon env still flows through.
      expect(env.PATH).toBeDefined();
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDE_HARNESS_MARKER;
      else process.env.CLAUDE_HARNESS_MARKER = prevClaude;
    }
  });

  it("includeDiscordPlugin: true (Model A) adds plugin:discord to the argv", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      { ...seams(factory), includeDiscordPlugin: true },
    );
    await backend.loadSdkModule();
    expect(calls.constructions[0]!.argv).toContain("plugin:discord@claude-plugins-official");
  });

  it("clawcodeMcpCommand: null omits the clawcode tool server (opt-out)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      { name: "test-agent", model: "sonnet", llmRuntime: { backend: "claude-code-interactive" as const } } as unknown as ResolvedAgentConfig,
      {},
      discoveryDeps,
      { ...seams(factory), clawcodeMcpCommand: null },
    );
    await backend.loadSdkModule();
    const argv = calls.constructions[0]!.argv;
    const written = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1]!, "utf-8"));
    expect(written.mcpServers.clawcode).toBeUndefined();
    expect(written.mcpServers["clawcode-channel"]).toBeDefined();
  });

  it("surfaces CliBinaryNotFoundError when no tier resolves (before spawning)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      { existsSync: () => false, which: async () => null },
      seams(factory),
    );
    await expect(backend.loadSdkModule()).rejects.toThrow(/not found/);
    // Discovery failure must short-circuit BEFORE the supervisor is spawned.
    expect(calls.spawns).toBe(0);
  });
});

describe("ClaudeCodeInteractiveBackend — default supervisor factory tracker wiring (140-06 Task 10)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "cc-interactive-tracker-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** A fake pty handle exposing the narrow PtyHandle surface the supervisor uses. */
  function makeFakePtyHandle(pid: number): PtyHandle {
    return {
      pid,
      onExit: () => ({ dispose: () => {} }),
      kill: () => {},
    };
  }

  /** Seams that exercise the REAL `defaultSupervisorFactory` with a fake pty. */
  function seamsWithFakeSpawn(spawnPty: PtySpawnFn): InteractiveBackendSeams {
    return {
      // No `supervisorFactory` override → the production defaultSupervisorFactory
      // path runs (the one whose tracker selection we are wiring).
      spawnPty,
      channelsStateDir: () => stateDir,
      channelMcpServerPath: () =>
        "/opt/clawcode/dist/channels/clawcode-channel-mcp-server.js",
    };
  }

  it("registers the spawned PTY pid with deps.mcpTracker (real-tracker coverage)", async () => {
    const registered: Array<{ agent: string; pid: number }> = [];
    const tracker: PtySupervisorTracker = {
      register: async (agent, pid) => {
        registered.push({ agent, pid });
      },
      killAgentGroup: async () => {},
    };
    const deps: LlmRuntimeDeps = { mcpTracker: tracker };
    const spawnPty: PtySpawnFn = () => makeFakePtyHandle(4242);

    const backend = new ClaudeCodeInteractiveBackend(
      config,
      deps,
      discoveryDeps,
      seamsWithFakeSpawn(spawnPty),
    );
    await backend.loadSdkModule();

    // The default factory must have registered the child PID via the REAL
    // tracker — this is the killAgentGroup + orphan-reaper coverage that the
    // no-op tracker silently bypassed (140-04 Deferred Issue #1).
    expect(registered).toEqual([{ agent: "test-agent", pid: 4242 }]);
  });

  it("falls back to a no-op tracker (no throw) when deps.mcpTracker is absent", async () => {
    // Back-compat: an agent constructed WITHOUT a tracker (e.g. non-Linux, no
    // /proc) must still spawn — the no-op tracker swallows register/kill.
    const spawnPty: PtySpawnFn = () => makeFakePtyHandle(99);
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seamsWithFakeSpawn(spawnPty),
    );
    await expect(backend.loadSdkModule()).resolves.toBeInstanceOf(
      FakeChannelsSdkModule,
    );
  });

  it("prefers deps.mcpTracker over a seams.tracker when both are present", async () => {
    // Production injects the live tracker via `deps.mcpTracker`. The legacy
    // `seams.tracker` is a test-only seam; the daemon path must win.
    const depsTrackerCalls: number[] = [];
    const seamsTrackerCalls: number[] = [];
    const depsTracker: PtySupervisorTracker = {
      register: async (_agent, pid) => {
        depsTrackerCalls.push(pid);
      },
      killAgentGroup: async () => {},
    };
    const seamsTracker: PtySupervisorTracker = {
      register: async (_agent, pid) => {
        seamsTrackerCalls.push(pid);
      },
      killAgentGroup: async () => {},
    };
    const spawnPty: PtySpawnFn = () => makeFakePtyHandle(7);
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      { mcpTracker: depsTracker },
      discoveryDeps,
      { ...seamsWithFakeSpawn(spawnPty), tracker: seamsTracker },
    );
    await backend.loadSdkModule();

    expect(depsTrackerCalls).toEqual([7]);
    expect(seamsTrackerCalls).toEqual([]);
  });
});

describe("FakeChannelsSdkModule", () => {
  const mod = new FakeChannelsSdkModule("test-agent");

  it("query() yields nothing and completes when close() is called", async () => {
    const q = mod.query({ prompt: "hello" });
    const collected: unknown[] = [];
    const drain = (async () => {
      for await (const m of q) collected.push(m);
    })();
    q.close();
    await drain;
    expect(collected).toEqual([]);
  });

  it("control-plane mutators reject with V3UnsupportedMutatorError (except interrupt — see note)", async () => {
    const q = mod.query({ prompt: "x" });
    // q.interrupt deliberately resolves (no-op) on v3 because the daemon's
    // phase127 stream-stall recovery calls it reflexively on idle v3 sessions
    // and unhandled rejections crashed the dev daemon (2026-05-27). See the
    // FakeChannelsSdkModule inert query comment.
    await expect(q.interrupt()).resolves.toBeUndefined();
    await expect(q.setModel("opus")).rejects.toBeInstanceOf(V3UnsupportedMutatorError);
    await expect(q.setPermissionMode("default")).rejects.toBeInstanceOf(
      V3UnsupportedMutatorError,
    );
    q.close();
  });

  it("forkSession REJECTS with V3UnsupportedMutatorError (nit: not a sync throw)", async () => {
    // The promise must reject — proving the sync-throw nit is fixed. A sync
    // throw would surface as a synchronous exception, not a rejected promise.
    const p = mod.forkSession("sess_1");
    await expect(p).rejects.toBeInstanceOf(V3UnsupportedMutatorError);
    await expect(p).rejects.toMatchObject({ mutator: "forkSession" });
  });

  it("read-only introspection returns benign empties (no fault on construct)", async () => {
    const q = mod.query({ prompt: "x" });
    expect(await q.mcpServerStatus()).toEqual([]);
    expect(await q.supportedCommands()).toEqual([]);
    expect((await q.initializationResult()).commands).toEqual([]);
    expect((await q.getContextUsage()).totalTokens).toBe(0);
    q.close();
  });
});

describe("FakeChannelsSdkModule.getSessionMessages (Plan 04: real transcript read)", () => {
  /**
   * Fixture in the standard Claude Code JSONL shape (140-01-SUMMARY confirmed
   * `claude --channels` writes this exact shape — `SessionMessage[]`). The
   * reader (`sdk-transcript-reader.ts`) must convert this into ≥1 turn.
   */
  const fixtureMessages: readonly SessionMessage[] = [
    {
      type: "user",
      uuid: "u1",
      session_id: "sess_1",
      message: { role: "user", content: "ping" },
      parent_tool_use_id: null,
    },
    {
      type: "assistant",
      uuid: "a1",
      session_id: "sess_1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "pong" },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file: "x" } },
        ],
      },
      parent_tool_use_id: null,
    },
  ];

  it("reads the transcript and returns SessionMessage[] convertible by readToolAwareTurns", async () => {
    const readSpy = vi.fn(async () => fixtureMessages);
    const mod = new FakeChannelsSdkModule("test-agent", {
      readSessionMessages: readSpy,
    });

    const out = await mod.getSessionMessages("sess_1", { dir: "/some/project" });
    expect(out).toEqual(fixtureMessages);
    expect(readSpy).toHaveBeenCalledWith("sess_1", { dir: "/some/project" });

    // The output must feed the existing reader and yield ≥1 ToolOutputTurn.
    const { readToolAwareTurns } = await import("../../../memory/sdk-transcript-reader.js");
    const turns = await readToolAwareTurns({
      sessionId: "sess_1",
      getSessionMessages: () => mod.getSessionMessages("sess_1"),
      agentName: "test-agent",
      log: { warn: () => {} },
    });
    expect(turns).not.toBeNull();
    expect((turns ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("returns [] (fail-open) when the transcript is absent", async () => {
    // Absent transcript → the SDK read resolves []. The fail-open contract
    // (documented in the compaction reader) must be preserved verbatim.
    const mod = new FakeChannelsSdkModule("test-agent", {
      readSessionMessages: async () => [],
    });
    expect(await mod.getSessionMessages("missing")).toEqual([]);
  });

  it("returns [] (fail-open) when the underlying SDK read throws", async () => {
    const mod = new FakeChannelsSdkModule("test-agent", {
      readSessionMessages: async () => {
        throw new Error("session store unavailable");
      },
    });
    expect(await mod.getSessionMessages("sess_1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 140 Plan 07 — resume seam (closes 140-04 Deferred #2)
//
// loadSdkModule must hand the supervisor a getResumeSessionId backed by the
// SessionIdTracker: cold (null) before the post-spawn refresh, then the latest
// session id after the injected refresh fires. Proves the sync-getter /
// async-cache bridge is wired through the production loadSdkModule path.
// ---------------------------------------------------------------------------
describe("ClaudeCodeInteractiveBackend — resume seam (Plan 07)", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "cc-resume-test-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("wires getResumeSessionId from the tracker (cold→null, refresh→latest id)", async () => {
    let capturedGetter: (() => string | null) | undefined;
    const factory: NonNullable<InteractiveBackendSeams["supervisorFactory"]> = (
      opts,
    ): ChannelSpawnSeam => {
      capturedGetter = opts.getResumeSessionId;
      return { spawn: async () => {} };
    };
    const refreshFns: Array<() => void> = [];

    const backend = new ClaudeCodeInteractiveBackend(config, {}, discoveryDeps, {
      supervisorFactory: factory,
      channelsStateDir: () => stateDir,
      channelMcpServerPath: () => "/opt/clawcode/dist/channels/x.js",
      // Two sessions — the tracker must pick the most-recently-modified.
      listSessions: async () => [
        { sessionId: "stale", lastModified: 1 },
        { sessionId: "resume-me", lastModified: 999 },
      ],
      // Capture the scheduled refreshes instead of timing them out.
      scheduleResumeRefresh: (fn) => refreshFns.push(fn),
    });

    await backend.loadSdkModule();

    // The seam is wired (not the pre-Plan-07 hardcoded undefined)…
    expect(typeof capturedGetter).toBe("function");
    // …but cold until the post-spawn refresh runs → fresh spawn meanwhile.
    expect(capturedGetter!()).toBeNull();
    // The backend scheduled refreshes (one per RESUME_REFRESH_DELAYS_MS entry).
    expect(refreshFns.length).toBeGreaterThan(0);

    // Fire them + let the async listSessions settle → getter now resolves.
    refreshFns.forEach((fn) => fn());
    await vi.waitFor(() => expect(capturedGetter!()).toBe("resume-me"));
  });
});

// ---------------------------------------------------------------------------
// Phase 999.83-02 — warm-nudge / first-turn-input behavior (Fix A + Fix B)
//
// Fix A: a v3 subagent's task is delivered as PTY stdin (the reliable
//   turn-trigger) — but ONLY as a SECOND write, AFTER the menu-dismiss \r, so
//   the task can never be mis-keyed into the dev-channels confirmation menu
//   (threat T-999.83-02-TTY / Pitfall 1 / A1).
// Fix B: when the task IS the first-turn input, the warm-nudge fires ONCE
//   (5s only) — it is NOT re-written at 20s/45s, so a delegated side-effecting
//   task (e.g. `gh pr create`) doesn't run three times (T-999.83-02-DUP).
//
// The Task-1 harness (makeFakeSupervisorFactory.writes + makeScheduleHarness)
// records PTY writes + (fn, ms) scheduler slots so the order/timing is
// asserted deterministically with no real timers.
// ---------------------------------------------------------------------------
describe("ClaudeCodeInteractiveBackend — warm-nudge first-turn-input (999.83-02)", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "cc-warmnudge-test-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function warmNudgeSeams(
    fakeFactory: NonNullable<InteractiveBackendSeams["supervisorFactory"]>,
    schedule: NonNullable<InteractiveBackendSeams["scheduleResumeRefresh"]>,
    extra?: Partial<InteractiveBackendSeams>,
  ): InteractiveBackendSeams {
    return {
      supervisorFactory: fakeFactory,
      channelsStateDir: () => stateDir,
      channelMcpServerPath: () =>
        "/opt/clawcode/dist/channels/clawcode-channel-mcp-server.js",
      scheduleResumeRefresh: schedule,
      ...extra,
    };
  }

  it("baseline: no firstTurnInput writes DEFAULT_WARM_NUDGE (\\r) at the three warm-nudge delays", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const harness = makeScheduleHarness();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      warmNudgeSeams(factory, harness.schedule),
    );
    await backend.loadSdkModule();

    // Before firing, nothing is written (the nudge is scheduled, not eager).
    expect(calls.writes).toEqual([]);
    // The backend scheduled a warm-nudge slot at each of 5s/20s/45s.
    const warmMs = harness.scheduled
      .map((s) => s.ms)
      .filter((ms) => WARM_NUDGE_MS.includes(ms))
      .sort((a, b) => a - b);
    expect(warmMs).toEqual([5_000, 20_000, 45_000]);

    // Fire only the warm-nudge slots → three "\r" writes (default behavior).
    harness.fireWarmNudges();
    expect(calls.writes).toEqual(["\r", "\r", "\r"]);
  });

  it("firstTurnInput: writes \\r THEN the task, fire-once (no 20s/45s re-fire) — A1 + Fix B", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const harness = makeScheduleHarness();
    const TASK = "do the thing";
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      warmNudgeSeams(factory, harness.schedule, { firstTurnInput: TASK }),
    );
    await backend.loadSdkModule();

    // Fire-once: the task path scheduled writes only around the FIRST delay
    // (5_000 menu-dismiss + 5_050 task) — NOTHING at 20s/45s.
    const warmMs = harness.scheduled
      .map((s) => s.ms)
      .filter((ms) => WARM_NUDGE_FIRE_MS.includes(ms))
      .sort((a, b) => a - b);
    expect(warmMs).toEqual([5_000, 5_050]);
    expect(warmMs).not.toContain(20_000);
    expect(warmMs).not.toContain(45_000);

    harness.fireWarmNudges();
    // Exactly [menu-dismiss \r, task] in that order — the task is its OWN
    // write, never concatenated into the menu-dismiss \r (T-999.83-02-TTY).
    expect(calls.writes).toEqual(["\r", TASK]);
  });

  it("firstTurnInput takes precedence over a custom warmNudge seam", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const harness = makeScheduleHarness();
    const TASK = "execute the delegated work";
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      // A custom warmNudge is present but MUST be ignored when firstTurnInput
      // is a non-empty string (the \r-then-task single-fire path wins).
      warmNudgeSeams(factory, harness.schedule, {
        firstTurnInput: TASK,
        warmNudge: "custom-nudge-should-be-ignored",
      }),
    );
    await backend.loadSdkModule();

    harness.fireWarmNudges();
    expect(calls.writes).toEqual(["\r", TASK]);
  });

  it("empty firstTurnInput falls back to default \\r x3 (treated as absent)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const harness = makeScheduleHarness();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      warmNudgeSeams(factory, harness.schedule, { firstTurnInput: "" }),
    );
    await backend.loadSdkModule();

    harness.fireWarmNudges();
    expect(calls.writes).toEqual(["\r", "\r", "\r"]);
  });

  it("deferFirstTurn=true suppresses BOTH the warm-nudge schedule AND firstTurnInput", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const harness = makeScheduleHarness();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      warmNudgeSeams(factory, harness.schedule, {
        deferFirstTurn: true,
        // firstTurnInput is provided but MUST be ignored when deferred.
        firstTurnInput: "do-not-deliver-yet",
      }),
    );
    await backend.loadSdkModule();

    // No warm-nudge slots were scheduled at all (the pool delivers \r+msg later).
    const warmMs = harness.scheduled
      .map((s) => s.ms)
      .filter(
        (ms) =>
          WARM_NUDGE_MS.includes(ms) ||
          WARM_NUDGE_FIRE_MS.includes(ms),
      );
    expect(warmMs).toEqual([]);

    // Even if we fire whatever is scheduled, no PTY writes happen.
    harness.fireWarmNudges();
    expect(calls.writes).toEqual([]);
  });

  it("deferFirstTurn=true still registers supervisor in liveSupervisorByAgent so the pool can reach it", async () => {
    const { factory } = makeFakeSupervisorFactory();
    const harness = makeScheduleHarness();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      warmNudgeSeams(factory, harness.schedule, { deferFirstTurn: true }),
    );
    await backend.loadSdkModule();

    // Supervisor was captured even though no warm-nudge fired.
    const supervisor = liveSupervisorByAgent.get(config.name);
    expect(supervisor).toBeDefined();
  });

  it("deferFirstTurn=false (default) preserves today's warm-nudge schedule", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const harness = makeScheduleHarness();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      warmNudgeSeams(factory, harness.schedule),
    );
    await backend.loadSdkModule();
    harness.fireWarmNudges();
    expect(calls.writes).toEqual(["\r", "\r", "\r"]);
  });
});

describe("ClaudeCodeInteractiveBackend — debugWriteToPty (999.84-01)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "cc-interactive-debug-write-"));
    // Clean module-level registry between tests so the free-function tests
    // don't see entries from prior test cases.
    liveSupervisorByAgent.clear();
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    liveSupervisorByAgent.clear();
  });

  function seams(
    fakeFactory: NonNullable<InteractiveBackendSeams["supervisorFactory"]>,
  ): InteractiveBackendSeams {
    return {
      supervisorFactory: fakeFactory,
      channelsStateDir: () => stateDir,
      channelMcpServerPath: () => "/opt/clawcode/dist/channels/clawcode-channel-mcp-server.js",
    };
  }

  it("returns { ok: false, reason: 'no-supervisor' } before loadSdkModule() has spawned", () => {
    const { factory } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    // Note: no `await backend.loadSdkModule()` — supervisor hasn't been captured yet.
    const result = backend.debugWriteToPty("hello\n");
    expect(result).toEqual({ ok: false, reason: "no-supervisor" });
  });

  it("after loadSdkModule(), forwards the text to supervisor.write and returns { ok: true }", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    // Clear any warm-nudge writes that may have fired during spawn (the
    // schedule harness is NOT injected here, so the default scheduler is
    // used — but the test asserts only that OUR debug call appears in writes).
    const writesBefore = calls.writes.length;

    const result = backend.debugWriteToPty("hypothesis test\n");
    expect(result).toEqual({ ok: true });
    expect(calls.writes.length).toBe(writesBefore + 1);
    expect(calls.writes[calls.writes.length - 1]).toBe("hypothesis test\n");
  });

  it("returns { ok: false, reason: 'no-write-seam' } when supervisor lacks write()", async () => {
    // A degraded fake — spawn works but no write seam (mirrors the
    // ChannelSpawnSeam interface comment that `write` is optional for fakes).
    const writelessFactory: NonNullable<
      InteractiveBackendSeams["supervisorFactory"]
    > = (): ChannelSpawnSeam => ({
      spawn: async () => {},
      // write deliberately omitted
    });
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(writelessFactory),
    );
    await backend.loadSdkModule();
    const result = backend.debugWriteToPty("anything");
    expect(result).toEqual({ ok: false, reason: "no-write-seam" });
  });

  it("debugWriteToPtyForAgent (free fn) returns no-supervisor when registry is empty", () => {
    const result = debugWriteToPtyForAgent("any-agent", "x");
    expect(result).toEqual({ ok: false, reason: "no-supervisor" });
  });

  it("debugWriteToPtyForAgent (free fn) writes to the supervisor that loadSdkModule registered", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    // Critical assertion: free function looks up by agent name, NOT by
    // instance. Mirrors what daemon.ts does after the resolver returns a
    // fresh instance whose own liveSupervisor field is null.
    const writesBefore = calls.writes.length;
    const result = debugWriteToPtyForAgent(config.name, "from-free-fn\n");
    expect(result).toEqual({ ok: true });
    expect(calls.writes.length).toBe(writesBefore + 1);
    expect(calls.writes[calls.writes.length - 1]).toBe("from-free-fn\n");
  });

  it("debugWriteToPtyForAgent reads from a DIFFERENT backend instance than the one that called loadSdkModule (Phase 138 resolver semantics regression pin)", async () => {
    const { factory, calls } = makeFakeSupervisorFactory();
    // Instance A spawns + registers
    const backendA = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    await backendA.loadSdkModule();

    // Instance B (mimicking the daemon's fresh resolver-returned instance)
    // never called loadSdkModule — its own liveSupervisor field is null.
    const backendB = new ClaudeCodeInteractiveBackend(
      config,
      {},
      discoveryDeps,
      seams(factory),
    );
    expect(backendB.debugWriteToPty("via instance B")).toEqual({
      ok: false,
      reason: "no-supervisor",
    });

    // But the free function — which the daemon IPC uses — DOES find the
    // supervisor via the module-level registry that backendA populated.
    const writesBefore = calls.writes.length;
    const result = debugWriteToPtyForAgent(config.name, "via free fn\n");
    expect(result).toEqual({ ok: true });
    expect(calls.writes.length).toBe(writesBefore + 1);
  });

  it("logs a phase99984-debug-pty-write info line on successful write (no body leak — only textLength)", async () => {
    const { factory } = makeFakeSupervisorFactory();
    const logEntries: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const fakeLogger = {
      info: (obj: Record<string, unknown>, msg: string) => {
        logEntries.push({ obj, msg });
      },
      warn: () => {},
    };
    const deps: LlmRuntimeDeps = {
      logger: fakeLogger as unknown as NonNullable<LlmRuntimeDeps["logger"]>,
    };
    const backend = new ClaudeCodeInteractiveBackend(
      config,
      deps,
      discoveryDeps,
      seams(factory),
    );
    await backend.loadSdkModule();
    backend.debugWriteToPty("secret-payload");
    const debugLog = logEntries.find(
      (e) => e.msg === "phase99984-debug-pty-write",
    );
    expect(debugLog).toBeDefined();
    expect(debugLog!.obj).toEqual({
      agent: config.name,
      textLength: "secret-payload".length,
    });
    // No-body-leak — the log MUST NOT contain the text itself.
    expect(JSON.stringify(debugLog!.obj)).not.toContain("secret-payload");
  });
});

describe("resolveInstalledPluginMcpServers (999.84-05 — Model A plugin MCP injection)", () => {
  let claudeHome: string;
  let installPath: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(path.join(tmpdir(), "claude-home-"));
    // Layout matches the production shape:
    //   <home>/.claude/plugins/installed_plugins.json
    //   <home>/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/.mcp.json
    installPath = path.join(
      claudeHome,
      ".claude",
      "plugins",
      "cache",
      "claude-plugins-official",
      "discord",
      "0.0.4",
    );
    mkdirSync(installPath, { recursive: true });
    mkdirSync(path.join(claudeHome, ".claude", "plugins"), { recursive: true });
  });
  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  it("returns null when the registry file is missing (fail-open)", () => {
    const result = resolveInstalledPluginMcpServers(
      "discord@claude-plugins-official",
      claudeHome,
    );
    expect(result).toBeNull();
  });

  it("returns null when the plugin isn't in the registry", () => {
    writeFileSync(
      path.join(claudeHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: {} }),
    );
    const result = resolveInstalledPluginMcpServers(
      "discord@claude-plugins-official",
      claudeHome,
    );
    expect(result).toBeNull();
  });

  it("returns null when the registry points to a plugin dir without .mcp.json (fail-open)", () => {
    writeFileSync(
      path.join(claudeHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "discord@claude-plugins-official": [{ scope: "user", installPath, version: "0.0.4" }],
        },
      }),
    );
    // installPath dir exists (beforeEach) but no .mcp.json inside.
    const result = resolveInstalledPluginMcpServers(
      "discord@claude-plugins-official",
      claudeHome,
    );
    expect(result).toBeNull();
  });

  it("resolves the plugin's MCP servers AND substitutes ${CLAUDE_PLUGIN_ROOT} with the absolute install path", () => {
    writeFileSync(
      path.join(claudeHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "discord@claude-plugins-official": [{ scope: "user", installPath, version: "0.0.4" }],
        },
      }),
    );
    writeFileSync(
      path.join(installPath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          discord: {
            command: "bun",
            args: ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"],
          },
        },
      }),
    );
    const result = resolveInstalledPluginMcpServers(
      "discord@claude-plugins-official",
      claudeHome,
    );
    expect(result).not.toBeNull();
    expect(result!.discord.command).toBe("bun");
    // Substitution: --cwd argument should be the absolute installPath, not the literal placeholder.
    expect(result!.discord.args).toEqual([
      "run",
      "--cwd",
      installPath,
      "--shell=bun",
      "--silent",
      "start",
    ]);
    expect(result!.discord.args.join(" ")).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  });

  it("picks the LAST entry in the registry array (newest install) when multiple versions exist", () => {
    const v1Path = path.join(claudeHome, ".claude", "plugins", "cache", "claude-plugins-official", "discord", "0.0.3");
    mkdirSync(v1Path, { recursive: true });
    writeFileSync(
      path.join(v1Path, ".mcp.json"),
      JSON.stringify({ mcpServers: { discord: { command: "old", args: [] } } }),
    );
    writeFileSync(
      path.join(installPath, ".mcp.json"),
      JSON.stringify({ mcpServers: { discord: { command: "new", args: [] } } }),
    );
    writeFileSync(
      path.join(claudeHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "discord@claude-plugins-official": [
            { scope: "user", installPath: v1Path, version: "0.0.3" },
            { scope: "user", installPath, version: "0.0.4" },
          ],
        },
      }),
    );
    const result = resolveInstalledPluginMcpServers(
      "discord@claude-plugins-official",
      claudeHome,
    );
    expect(result!.discord.command).toBe("new");
  });

  it("returns null when the registry JSON is malformed (fail-open, no throw)", () => {
    writeFileSync(
      path.join(claudeHome, ".claude", "plugins", "installed_plugins.json"),
      "{not: valid json",
    );
    const result = resolveInstalledPluginMcpServers(
      "discord@claude-plugins-official",
      claudeHome,
    );
    expect(result).toBeNull();
  });
});
