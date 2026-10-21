import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReadinessWaitMs,
  mapAgentConfigForServer,
  agentBaseOptionsFromConfig,
  agentModelFromConfig,
} from "../endpoint-bootstrap.js";
import { sha256Hex } from "../caller-identity.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import { MODEL_ALIAS_CATALOG } from "../../shared/model-catalog.js";

/**
 * Phase 73 Plan 02 — parseReadinessWaitMs unit tests (LAT-04).
 *
 * Pin the parse contract without booting an endpoint:
 *   - undefined / empty → undefined (server uses its 300ms default).
 *   - valid integer in [0, 60_000] → that integer.
 *   - anything else → undefined + warn log fires.
 */

type WarnLog = { obj: Record<string, unknown>; msg?: string };

function makeLog(): {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  calls: WarnLog[];
} {
  const calls: WarnLog[] = [];
  return {
    calls,
    warn: (obj, msg) => {
      calls.push({ obj, msg });
    },
  };
}

describe("mapAgentConfigForServer (server-facing config narrowing)", () => {
  it("returns null for an unknown agent", () => {
    expect(mapAgentConfigForServer(null)).toBeNull();
    expect(mapAgentConfigForServer(undefined)).toBeNull();
  });

  it("does NOT forward openaiVoice — the voice route is unwired from the endpoint", () => {
    // 2026-09-23: voice is unfinished, so a voice-opted agent (prod `personal`)
    // must run the plain transient path. The server no longer reads the block.
    const cfg = {
      name: "clawdy-voice",
      openaiVoice: { enabled: true, streamKeepaliveMs: 5000, mcpAllowlist: [] },
    } as unknown as ResolvedAgentConfig;
    expect(mapAgentConfigForServer(cfg)).toEqual({ security: undefined });
  });

  it("forwards security.denyScopeAll", () => {
    const cfg = {
      name: "a",
      security: { denyScopeAll: true },
    } as unknown as ResolvedAgentConfig;
    expect(mapAgentConfigForServer(cfg)?.security).toEqual({ denyScopeAll: true });
  });

});

describe("parseReadinessWaitMs", () => {
  it("env absent (undefined) → undefined, no warn", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs(undefined, log)).toBeUndefined();
    expect(log.calls).toHaveLength(0);
  });

  it("env empty string → undefined, no warn", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs("", log)).toBeUndefined();
    expect(log.calls).toHaveLength(0);
  });

  it("env whitespace-only → undefined, no warn (treated as absent)", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs("   ", log)).toBeUndefined();
    expect(log.calls).toHaveLength(0);
  });

  it("env='500' → 500 (valid integer passes through)", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs("500", log)).toBe(500);
    expect(log.calls).toHaveLength(0);
  });

  it("env='0' → 0 (zero is the lower bound, no wait)", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs("0", log)).toBe(0);
    expect(log.calls).toHaveLength(0);
  });

  it("env='60000' → 60000 (upper bound accepted)", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs("60000", log)).toBe(60_000);
    expect(log.calls).toHaveLength(0);
  });

  it("env='-5' → undefined + warn (negative rejected)", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs("-5", log)).toBeUndefined();
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.obj.raw).toBe("-5");
    expect(log.calls[0]!.obj.default).toBe(300);
    expect(log.calls[0]!.msg).toMatch(/invalid/i);
  });

  it("env='abc' → undefined + warn (non-numeric rejected)", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs("abc", log)).toBeUndefined();
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.obj.raw).toBe("abc");
  });

  it("env='999999' → undefined + warn (out of range, > 60_000)", () => {
    const log = makeLog();
    expect(parseReadinessWaitMs("999999", log)).toBeUndefined();
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.obj.raw).toBe("999999");
    expect(log.calls[0]!.obj.default).toBe(300);
  });

  it("works without a log (warn path is silent)", () => {
    // No throw when log is undefined and input is invalid.
    expect(() => parseReadinessWaitMs("bogus")).not.toThrow();
    expect(parseReadinessWaitMs("bogus")).toBeUndefined();
    expect(parseReadinessWaitMs(undefined)).toBeUndefined();
    expect(parseReadinessWaitMs("250")).toBe(250);
  });

  it("decimals truncate via parseInt (env='300.7' → 300)", () => {
    // parseInt semantics — operator intent for a 300ms bound is preserved.
    const log = makeLog();
    expect(parseReadinessWaitMs("300.7", log)).toBe(300);
    expect(log.calls).toHaveLength(0);
  });
});

describe("agentModelFromConfig (native driver model resolution)", () => {
  const cfg = (model: string) => ({ model }) as unknown as ResolvedAgentConfig;

  it("resolves `<family>@latest` to that family's catalog pin (was undefined)", () => {
    // Regression: `cfg.model as Tier` looked "opus@latest" up in TIER_MODEL_MAP
    // → undefined → the CLI's default model instead of the agent's.
    expect(agentModelFromConfig(cfg("opus@latest"))).toBe(MODEL_ALIAS_CATALOG.opus.id);
    expect(agentModelFromConfig(cfg("fable@latest"))).toBe(MODEL_ALIAS_CATALOG.fable.id);
  });

  it("resolves bare and pinned aliases to their catalog ids", () => {
    expect(agentModelFromConfig(cfg("opus"))).toBe(MODEL_ALIAS_CATALOG.opus.id);
    expect(agentModelFromConfig(cfg("opus-5"))).toBe(MODEL_ALIAS_CATALOG["opus-5"].id);
  });

  it("defaults to sonnet for an unknown agent", () => {
    expect(agentModelFromConfig(null)).toBe(MODEL_ALIAS_CATALOG.sonnet.id);
  });
});

describe("agentBaseOptionsFromConfig (soul loading — same precedence as agent sessions)", () => {
  // Real files, no fs mock: soulFile → <workspace>/SOUL.md → inline soul.
  const root = mkdtempSync(join(tmpdir(), "clawcode-endpoint-soul-"));
  const workspaceWithSoul = join(root, "ws-with-soul");
  const emptyWorkspace = join(root, "ws-empty");
  const soulFile = join(root, "personal-SOUL.md");
  mkdirSync(workspaceWithSoul);
  mkdirSync(emptyWorkspace);
  writeFileSync(join(workspaceWithSoul, "SOUL.md"), "Workspace soul.");
  writeFileSync(soulFile, "You are Clawdy. Dry wit.");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const cfg = (over: Record<string, unknown>) =>
    ({ name: "personal", model: "opus@latest", soul: undefined, ...over }) as unknown as ResolvedAgentConfig;

  it("loads soulFile content (prod `personal` has soulFile, no inline soul)", async () => {
    const out = await agentBaseOptionsFromConfig(cfg({ soulFile, workspace: emptyWorkspace }));
    expect(out.soulPrompt).toBe("You are Clawdy. Dry wit.");
    expect(out.soulFp).toBe(sha256Hex("You are Clawdy. Dry wit.").slice(0, 16));
    expect(out.model).toBe(MODEL_ALIAS_CATALOG.opus.id);
  });

  it("falls through an unreadable soulFile to <workspace>/SOUL.md", async () => {
    const out = await agentBaseOptionsFromConfig(
      cfg({ soulFile: join(root, "missing.md"), workspace: workspaceWithSoul, soul: "Inline." }),
    );
    expect(out.soulPrompt).toBe("Workspace soul.");
  });

  it("falls back to the inline soul when no file resolves", async () => {
    const out = await agentBaseOptionsFromConfig(cfg({ workspace: emptyWorkspace, soul: "Inline." }));
    expect(out.soulPrompt).toBe("Inline.");
  });

  it("is empty — never throws — when nothing resolves, and for an unknown agent", async () => {
    expect((await agentBaseOptionsFromConfig(cfg({ workspace: emptyWorkspace }))).soulPrompt).toBe("");
    expect((await agentBaseOptionsFromConfig(null)).soulPrompt).toBe("");
  });
});
