/**
 * Phase 115 sub-scope 14 — debug-dump baseopts as operator-toggle config flag.
 *
 * Tests for `redactSecrets` + `debugDumpBaseOptions` exported via
 * `_internal_phase115` from session-adapter.ts.
 *
 * **T03 final state** (this file's coverage):
 *   - `dumpEnabled=true` (regardless of agent name) → file IS written
 *   - `dumpEnabled=false` (regardless of agent name) → no file written
 *   - The hardcoded `DEBUG_DUMP_AGENTS` allowlist no longer exists; the
 *     flag is the SOLE gate.
 *   - redactSecrets correctness for keys, value-prefixes, circular refs.
 *   - Slugification still applied to agent names with spaces.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { _internal_phase115 } from "../session-adapter.js";

const { redactSecrets, debugDumpBaseOptions } = _internal_phase115;

// We dump under HOME so the helper's `pathJoin(homedir(), ".clawcode", ...)`
// produces a temp-isolated path. We swap process.env.HOME before each test
// so the dump never escapes the test sandbox.
let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "phase115-dump-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("redactSecrets", () => {
  it("redacts ANTHROPIC_API_KEY by key name", () => {
    const input = {
      env: { ANTHROPIC_API_KEY: "sk-ant-real-secret", PATH: "/usr/bin" },
    };
    const out = redactSecrets(input) as typeof input;
    expect(out.env.ANTHROPIC_API_KEY).toBe("<REDACTED>");
    expect(out.env.PATH).toBe("/usr/bin");
  });

  it("redacts DISCORD_TOKEN, GITHUB_TOKEN, OPENAI_API_KEY by key", () => {
    const input = {
      DISCORD_TOKEN: "dt-1",
      GITHUB_TOKEN: "ghp_xyz",
      OPENAI_API_KEY: "sk-openai",
      DISCORD_BOT_TOKEN: "dbt-2",
      OTHER: "kept",
    };
    const out = redactSecrets(input) as Record<string, string>;
    expect(out.DISCORD_TOKEN).toBe("<REDACTED>");
    expect(out.GITHUB_TOKEN).toBe("<REDACTED>");
    expect(out.OPENAI_API_KEY).toBe("<REDACTED>");
    expect(out.DISCORD_BOT_TOKEN).toBe("<REDACTED>");
    expect(out.OTHER).toBe("kept");
  });

  it("redacts catch-all `*_TOKEN`, `*_KEY`, `*_SECRET`, `password`, `credentials`", () => {
    const input = {
      WEIRD_TOKEN: "v1",
      WIDGET_KEY: "v2",
      VAULT_SECRET: "v3",
      password: "p1",
      credentials: { token: "Bearer abc" },
      kept: "kept",
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.WEIRD_TOKEN).toBe("<REDACTED>");
    expect(out.WIDGET_KEY).toBe("<REDACTED>");
    expect(out.VAULT_SECRET).toBe("<REDACTED>");
    expect(out.password).toBe("<REDACTED>");
    expect(out.credentials).toBe("<REDACTED>");
    expect(out.kept).toBe("kept");
  });

  it("redacts string leaves with sk-ant- value prefix", () => {
    const out = redactSecrets({ token: "sk-ant-real-key" }) as Record<
      string,
      string
    >;
    expect(out.token).toBe("<REDACTED>");
  });

  it("redacts string leaves with `Bearer ` value prefix", () => {
    const out = redactSecrets("Bearer ya29.fake-bearer");
    expect(out).toBe("<REDACTED>");
  });

  it("redacts ghp_ and ghs_ value prefixes", () => {
    expect(redactSecrets("ghp_abc123")).toBe("<REDACTED>");
    expect(redactSecrets("ghs_def456")).toBe("<REDACTED>");
  });

  it("redacts sk- generic value prefix (covers OpenAI + future generic keys)", () => {
    const out = redactSecrets({ randomField: "sk-something" }) as Record<
      string,
      string
    >;
    expect(out.randomField).toBe("<REDACTED>");
  });

  it("preserves null, undefined, numbers, booleans verbatim", () => {
    const input = { a: null, b: undefined, c: 42, d: true, e: false };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.a).toBeNull();
    expect(out.b).toBeUndefined();
    expect(out.c).toBe(42);
    expect(out.d).toBe(true);
    expect(out.e).toBe(false);
  });

  it("walks arrays of objects and redacts inside each element", () => {
    const input = [
      { name: "a", DISCORD_TOKEN: "t1" },
      { name: "b", env: { ANTHROPIC_API_KEY: "sk-ant-z" } },
    ];
    const out = redactSecrets(input) as Array<Record<string, unknown>>;
    expect(out[0].DISCORD_TOKEN).toBe("<REDACTED>");
    expect(out[0].name).toBe("a");
    expect(
      (out[1].env as Record<string, string>).ANTHROPIC_API_KEY,
    ).toBe("<REDACTED>");
  });

  it("handles circular references without infinite loop", () => {
    type Node = { name: string; self?: Node };
    const obj: Node = { name: "circular" };
    obj.self = obj;
    const out = redactSecrets(obj) as Node & { self: unknown };
    expect(out.name).toBe("circular");
    expect(out.self).toBe("<CIRCULAR>");
  });

  it("does not mutate input value (immutability)", () => {
    const input = { ANTHROPIC_API_KEY: "sk-ant-orig", kept: "stay" };
    redactSecrets(input);
    expect(input.ANTHROPIC_API_KEY).toBe("sk-ant-orig");
    expect(input.kept).toBe("stay");
  });
});

describe("debugDumpBaseOptions — T03 final state (flag-only gate)", () => {
  it("writes dump file when dumpEnabled=true (any agent name)", async () => {
    const baseOptions = {
      model: "haiku" as const,
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
    };
    const fleetAgent = "regular-agent";

    await debugDumpBaseOptions(
      "create",
      fleetAgent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
      true, // dumpEnabled
    );

    const dir = join(tmpHome, ".clawcode", "agents", fleetAgent, "diagnostics");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^baseopts-create-\d+\.json$/);
  });

  it("does NOT write dump when dumpEnabled=false even for the previously-allowlisted agents (post-T03 invariant)", async () => {
    const baseOptions = {
      model: "haiku" as const,
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
    };
    // Pre-T03 these were in the hardcoded allowlist and would dump even
    // without the flag. Post-T03 the flag is the sole gate — no dump.
    for (const previouslyAllowlisted of ["fin-client", "Admin Clawdy"]) {
      await debugDumpBaseOptions(
        "create",
        previouslyAllowlisted,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        baseOptions as any,
        false, // dumpEnabled — sole gate, off
      );
      const slug = previouslyAllowlisted.replace(/\s+/g, "_");
      const dir = join(tmpHome, ".clawcode", "agents", slug, "diagnostics");
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("does NOT write a dump when dumpEnabled=false (regardless of agent name)", async () => {
    const baseOptions = {
      model: "haiku" as const,
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
    };
    const fleetAgent = "another-fleet-agent";

    await debugDumpBaseOptions(
      "create",
      fleetAgent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
      false, // dumpEnabled
    );

    const dir = join(tmpHome, ".clawcode", "agents", fleetAgent, "diagnostics");
    expect(existsSync(dir)).toBe(false);
  });

  it("slugifies agent name with spaces (Admin Clawdy → Admin_Clawdy) when dumping is enabled by flag", async () => {
    const baseOptions = {
      model: "haiku" as const,
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
    };
    const spaced = "Admin Clawdy";

    await debugDumpBaseOptions(
      "resume",
      spaced,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
      true, // dumpEnabled — flag is now the sole gate
    );

    const dir = join(
      tmpHome,
      ".clawcode",
      "agents",
      "Admin_Clawdy",
      "diagnostics",
    );
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^baseopts-resume-\d+\.json$/);
  });

  it("redacts ANTHROPIC_API_KEY out of the dumped file content (env wholesale-stripped)", async () => {
    const baseOptions = {
      model: "haiku" as const,
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
      env: {
        ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
        PATH: "/usr/bin",
      },
    };
    const agent = "any-agent";

    await debugDumpBaseOptions(
      "create",
      agent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
      true, // dumpEnabled
    );

    const dir = join(tmpHome, ".clawcode", "agents", agent, "diagnostics");
    const file = join(dir, readdirSync(dir)[0]);
    const content = readFileSync(file, "utf8");
    expect(content).not.toContain("sk-ant-must-not-leak");
    // env was wholesale-stripped before redactSecrets walked the structure.
    expect(content).toContain("\"env\": \"<stripped>\"");
  });

  it("never throws when called (helper swallows internal errors silently)", async () => {
    const baseOptions = {
      model: "haiku" as const,
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
    };
    await expect(
      debugDumpBaseOptions(
        "create",
        "any-agent",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        baseOptions as any,
        true,
      ),
    ).resolves.toBeUndefined();
  });
});
