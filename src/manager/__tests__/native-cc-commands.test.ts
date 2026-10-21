/**
 * Phase 87 Plan 01 Task 1 — native-CC classifier + builder unit tests.
 *
 * Phase 117.1-02 T02 UPDATE: classifier flipped from open-by-default to
 * explicit ALLOWLIST. The pre-117.1 expectation that unknown / future
 * command names default to "prompt-channel" no longer holds — under the
 * allowlist policy, anything not in
 * {model, permissions, effort, compact, cost, help} returns "skip".
 *
 * Pinned must_haves (post-117.1-02):
 *   - classifyCommand routes `model`/`permissions`/`effort` → "control-plane"
 *   - classifyCommand routes `compact`/`cost`/`help` → "prompt-channel"
 *   - classifyCommand routes ANY non-allowlisted name → "skip"
 *     (including previously-routable `context`, `hooks`, and unknown future
 *     commands, plus project/user `.claude/commands/*.md` names like
 *     `gsd-debug` / `find-skills` that flooded the registration in prod
 *     CMD-07 2026-05-12)
 *   - classifyCommand routes `clear`/`export`/`mcp` → "skip" (legacy SKIP
 *     set retained for documentation; they're absent from the allowlist too)
 *   - buildNativeCommandDefs: every entry's `.name` matches /^clawcode-/
 *   - buildNativeCommandDefs: non-allowlisted entries produce zero output
 *   - buildNativeCommandDefs: ACL-denied names NEVER appear
 *   - buildNativeCommandDefs: nativeBehavior discriminator is populated
 *   - mergeAndDedupe: native wins on name collision
 *
 * The module under test is PURE (no imports from session-manager / daemon) so
 * this file exercises it in isolation — no DI, no mocks beyond literal
 * SlashCommand[] inputs.
 */

import { describe, it, expect } from "vitest";
import {
  classifyCommand,
  buildNativeCommandDefs,
  mergeAndDedupe,
  buildNativePromptString,
  type CommandAcl,
} from "../native-cc-commands.js";
import type { SlashCommand } from "../sdk-types.js";
import type { SlashCommandDef } from "../../discord/slash-types.js";

const emptyAcl: CommandAcl = { denied: new Set<string>() };

function cmd(
  name: string,
  description = `Native /${name}`,
  argumentHint = "",
): SlashCommand {
  return { name, description, argumentHint };
}

describe("classifyCommand — dispatch discriminator", () => {
  it("routes `model` to control-plane", () => {
    expect(classifyCommand("model")).toBe("control-plane");
  });

  it("routes `permissions` to control-plane", () => {
    expect(classifyCommand("permissions")).toBe("control-plane");
  });

  it("routes `effort` to control-plane", () => {
    expect(classifyCommand("effort")).toBe("control-plane");
  });

  it("routes `compact` to prompt-channel (allowlisted)", () => {
    expect(classifyCommand("compact")).toBe("prompt-channel");
  });

  it("routes `cost` to prompt-channel (allowlisted)", () => {
    expect(classifyCommand("cost")).toBe("prompt-channel");
  });

  it("routes `help` to prompt-channel (allowlisted)", () => {
    expect(classifyCommand("help")).toBe("prompt-channel");
  });

  // Phase 117.1-02 — `context` and `hooks` were previously prompt-channel by
  // virtue of falling through the open default. Under the allowlist they're
  // no longer routable through Discord (operators reach them via CLI).
  it("routes `context` to skip (Phase 117.1-02 — not allowlisted)", () => {
    expect(classifyCommand("context")).toBe("skip");
  });

  it("routes `hooks` to skip (Phase 117.1-02 — not allowlisted)", () => {
    expect(classifyCommand("hooks")).toBe("skip");
  });

  it("routes `clear` to skip (CMD-00 spike: not SDK-dispatchable; also not allowlisted)", () => {
    expect(classifyCommand("clear")).toBe("skip");
  });

  it("routes `export` to skip (CMD-00 spike: not SDK-dispatchable; also not allowlisted)", () => {
    expect(classifyCommand("export")).toBe("skip");
  });

  it("routes `mcp` to skip (Pitfall 12 — covered by /clawcode-tools; also not allowlisted)", () => {
    expect(classifyCommand("mcp")).toBe("skip");
  });

  // Phase 117.1-02 — open-by-default removed. Unknown names now skip.
  // This is the prod CMD-07 regression pin: ~120 project/user .claude/
  // commands/*.md names used to flood registration through this default.
  it("routes unknown future commands to skip (Phase 117.1-02 — not in allowlist)", () => {
    expect(classifyCommand("unknown-future-cmd")).toBe("skip");
  });

  it("routes empty string to skip (Phase 117.1-02 — not in allowlist)", () => {
    expect(classifyCommand("")).toBe("skip");
  });

  // Phase 117.1-02 — explicit regression pins for the names that triggered
  // the production CMD-07 cap breach. Every project/user `.claude/commands/
  // *.md` name surfaced by the SDK when settingSources: [project, user] is
  // set must classify as "skip" — otherwise the open-default regression
  // returns and we ship 193 commands again.
  it("routes `bug` to skip (Phase 117.1-02 — not allowlisted)", () => {
    expect(classifyCommand("bug")).toBe("skip");
  });

  it("routes `init` to skip (Phase 117.1-02 — not allowlisted)", () => {
    expect(classifyCommand("init")).toBe("skip");
  });

  it("routes `gsd-debug` to skip (project/user command — not allowlisted)", () => {
    expect(classifyCommand("gsd-debug")).toBe("skip");
  });

  it("routes `find-skills` to skip (project/user command — not allowlisted)", () => {
    expect(classifyCommand("find-skills")).toBe("skip");
  });
});

describe("buildNativeCommandDefs — classifier-driven SlashCommandDef[] construction", () => {
  it("skips non-allowlisted entries and emits only allowlisted commands", () => {
    const input: readonly SlashCommand[] = [
      cmd("compact", "X"), // allowlisted
      cmd("export", "Y"),  // not allowlisted (legacy SKIP)
    ];
    const out = buildNativeCommandDefs(input, emptyAcl);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("clawcode-compact");
  });

  it("prefixes EVERY returned name with `clawcode-` (allowlisted entries only)", () => {
    // Phase 117.1-02 — `hooks` and `context` are no longer allowlisted,
    // so only the three allowlisted names below survive.
    const input: readonly SlashCommand[] = [
      cmd("compact"), // allowlisted (prompt-channel)
      cmd("model"),   // allowlisted (control-plane)
      cmd("hooks"),   // skipped — not allowlisted
      cmd("help"),    // allowlisted (prompt-channel)
      cmd("context"), // skipped — not allowlisted
    ];
    const out = buildNativeCommandDefs(input, emptyAcl);
    // Every returned entry respects the namespace pin (Pitfall 10).
    for (const entry of out) {
      expect(entry.name).toMatch(/^clawcode-/);
    }
    expect(out.length).toBe(3);
    expect(out.map((c) => c.name).sort()).toEqual([
      "clawcode-compact",
      "clawcode-help",
      "clawcode-model",
    ]);
  });

  it("tags control-plane entries with nativeBehavior:'control-plane'", () => {
    const out = buildNativeCommandDefs([cmd("model")], emptyAcl);
    expect(out).toHaveLength(1);
    expect(out[0].nativeBehavior).toBe("control-plane");
  });

  it("tags prompt-channel entries with nativeBehavior:'prompt-channel'", () => {
    const out = buildNativeCommandDefs([cmd("compact")], emptyAcl);
    expect(out).toHaveLength(1);
    expect(out[0].nativeBehavior).toBe("prompt-channel");
  });

  it("filters out ACL-denied names BEFORE classification (init/security-review/batch)", () => {
    // Phase 117.1-02 — under the allowlist these names would be skipped
    // anyway, but the ACL gate must run FIRST so admins can override the
    // allowlist (e.g., deny an allowlisted name) without surfacing a
    // classification mismatch. Keep `compact` (allowlisted) as the
    // positive-path pin.
    const input: readonly SlashCommand[] = [
      cmd("init"),
      cmd("security-review"),
      cmd("batch"),
      cmd("compact"),
    ];
    const acl: CommandAcl = {
      denied: new Set(["init", "security-review", "batch"]),
    };
    const out = buildNativeCommandDefs(input, acl);
    const names = out.map((c) => c.name);
    expect(names).not.toContain("clawcode-init");
    expect(names).not.toContain("clawcode-security-review");
    expect(names).not.toContain("clawcode-batch");
    expect(names).toContain("clawcode-compact");
  });

  it("with empty ACL, only allowlisted commands pass through (Phase 117.1-02 — `init` is no longer allowlisted)", () => {
    const input: readonly SlashCommand[] = [
      cmd("init"),    // skipped — not allowlisted
      cmd("compact"), // allowlisted
      cmd("model"),   // allowlisted
    ];
    const out = buildNativeCommandDefs(input, emptyAcl);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.name).sort()).toEqual([
      "clawcode-compact",
      "clawcode-model",
    ]);
  });

  it("forwards description and description-fallback is non-empty", () => {
    // Empty SDK description should fall back to "Native /{name}" so Discord
    // never receives a zero-length description (API rejects that).
    const out = buildNativeCommandDefs([cmd("compact", "")], emptyAcl);
    expect(out[0].description.length).toBeGreaterThan(0);
  });

  it("truncates description at 100 characters (Discord limit)", () => {
    const longDesc = "x".repeat(250);
    const out = buildNativeCommandDefs([cmd("compact", longDesc)], emptyAcl);
    expect(out[0].description.length).toBeLessThanOrEqual(100);
  });

  it("emits an `args` STRING option when argumentHint is present", () => {
    const out = buildNativeCommandDefs(
      [cmd("compact", "Compact", "<summary-style>")],
      emptyAcl,
    );
    expect(out[0].options).toHaveLength(1);
    expect(out[0].options[0].name).toBe("args");
    expect(out[0].options[0].type).toBe(3);
    expect(out[0].options[0].required).toBe(false);
  });

  it("emits zero options when argumentHint is empty", () => {
    const out = buildNativeCommandDefs([cmd("compact", "Compact", "")], emptyAcl);
    expect(out[0].options).toEqual([]);
  });

  it("returns an empty array when given an empty SDK command list", () => {
    const out = buildNativeCommandDefs([], emptyAcl);
    expect(out).toEqual([]);
  });

  it("handles mixed skip + control-plane + prompt-channel + denied", () => {
    const input: readonly SlashCommand[] = [
      cmd("clear"),    // skip
      cmd("export"),   // skip
      cmd("mcp"),      // skip
      cmd("model"),    // control-plane
      cmd("compact"),  // prompt-channel
      cmd("init"),     // denied by ACL
      cmd("help"),     // prompt-channel
    ];
    const acl: CommandAcl = { denied: new Set(["init"]) };
    const out = buildNativeCommandDefs(input, acl);
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual([
      "clawcode-compact",
      "clawcode-help",
      "clawcode-model",
    ]);
  });
});

describe("mergeAndDedupe — existing + native merge, native wins", () => {
  it("preserves unique entries from both sides", () => {
    const existing: readonly SlashCommandDef[] = [
      {
        name: "clawcode-fleet",
        description: "Fleet",
        claudeCommand: "",
        options: [],
        control: true,
      },
    ];
    const native: readonly SlashCommandDef[] = [
      {
        name: "clawcode-compact",
        description: "Compact",
        claudeCommand: "",
        options: [],
        nativeBehavior: "prompt-channel",
      },
    ];
    const merged = mergeAndDedupe(existing, native);
    expect(merged).toHaveLength(2);
    expect(merged.map((c) => c.name).sort()).toEqual([
      "clawcode-compact",
      "clawcode-fleet",
    ]);
  });

  it("native wins on name collision (preserves nativeBehavior discriminator)", () => {
    const existing: readonly SlashCommandDef[] = [
      {
        name: "clawcode-compact",
        description: "Old LLM-prompt version",
        claudeCommand: "Trigger context compaction now",
        options: [],
      },
    ];
    const native: readonly SlashCommandDef[] = [
      {
        name: "clawcode-compact",
        description: "Native compact",
        claudeCommand: "",
        options: [],
        nativeBehavior: "prompt-channel",
      },
    ];
    const merged = mergeAndDedupe(existing, native);
    expect(merged).toHaveLength(1);
    expect(merged[0].nativeBehavior).toBe("prompt-channel");
    expect(merged[0].description).toBe("Native compact");
    expect(merged[0].claudeCommand).toBe("");
  });

  it("returns an empty array when both inputs are empty", () => {
    expect(mergeAndDedupe([], [])).toEqual([]);
  });

  it("returns existing as-is when native is empty", () => {
    const existing: readonly SlashCommandDef[] = [
      {
        name: "clawcode-status",
        description: "Status",
        claudeCommand: "Report status",
        options: [],
      },
    ];
    const merged = mergeAndDedupe(existing, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("clawcode-status");
  });

  it("returns native as-is when existing is empty", () => {
    const native: readonly SlashCommandDef[] = [
      {
        name: "clawcode-compact",
        description: "Compact",
        claudeCommand: "",
        options: [],
        nativeBehavior: "prompt-channel",
      },
    ];
    const merged = mergeAndDedupe([], native);
    expect(merged).toHaveLength(1);
    expect(merged[0].nativeBehavior).toBe("prompt-channel");
  });

  it("preserves insertion order (existing first, then unique native)", () => {
    const existing: readonly SlashCommandDef[] = [
      {
        name: "clawcode-fleet",
        description: "",
        claudeCommand: "",
        options: [],
      },
      {
        name: "clawcode-status",
        description: "",
        claudeCommand: "",
        options: [],
      },
    ];
    const native: readonly SlashCommandDef[] = [
      {
        name: "clawcode-compact",
        description: "",
        claudeCommand: "",
        options: [],
        nativeBehavior: "prompt-channel",
      },
    ];
    const merged = mergeAndDedupe(existing, native);
    expect(merged.map((c) => c.name)).toEqual([
      "clawcode-fleet",
      "clawcode-status",
      "clawcode-compact",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 87 Plan 03 CMD-03 — buildNativePromptString canonical prompt format.
//
// Single source of truth for the `/` + bare-name + optional-args string that
// Plan 03's prompt-channel carve-out sends through TurnDispatcher. The SDK's
// local-command dispatcher parses this LITERAL against its own slash-command
// table (no clawcode- prefix knowledge), so over-prefixing or over-escaping
// silently breaks the local_command_output emission path.
// ---------------------------------------------------------------------------

describe("buildNativePromptString — canonical prompt-channel format", () => {
  it("clawcode-compact with undefined args → '/compact'", () => {
    expect(buildNativePromptString("clawcode-compact", undefined)).toBe(
      "/compact",
    );
  });

  it("clawcode-compact with empty-string args → '/compact' (empty treated as no args)", () => {
    expect(buildNativePromptString("clawcode-compact", "")).toBe("/compact");
  });

  it("clawcode-compact with 'do a thing' args → '/compact do a thing'", () => {
    expect(buildNativePromptString("clawcode-compact", "do a thing")).toBe(
      "/compact do a thing",
    );
  });

  it("clawcode-context with undefined args → '/context'", () => {
    expect(buildNativePromptString("clawcode-context", undefined)).toBe(
      "/context",
    );
  });

  it("clawcode-cost with undefined args → '/cost'", () => {
    expect(buildNativePromptString("clawcode-cost", undefined)).toBe("/cost");
  });

  it("accepts BARE name 'compact' (prefix strip is idempotent, both forms → '/compact')", () => {
    expect(buildNativePromptString("compact", undefined)).toBe("/compact");
  });

  it("clawcode-hooks with empty args → '/hooks' (empty string treated as no args)", () => {
    expect(buildNativePromptString("clawcode-hooks", "")).toBe("/hooks");
  });

  it("clawcode-help with 'commands' arg → '/help commands'", () => {
    expect(buildNativePromptString("clawcode-help", "commands")).toBe(
      "/help commands",
    );
  });

  it("does NOT prepend `/clawcode-` (SDK expects bare command names)", () => {
    const result = buildNativePromptString("clawcode-compact", undefined);
    expect(result.startsWith("/clawcode-")).toBe(false);
    expect(result).toBe("/compact");
  });

  it("does NOT escape/quote args (SDK parses verbatim — over-escaping breaks passthrough)", () => {
    // Quotes, brackets, and special chars must pass through untouched.
    const result = buildNativePromptString(
      "clawcode-help",
      `"quoted" [bracket] 'single' $var`,
    );
    expect(result).toBe(`/help "quoted" [bracket] 'single' $var`);
  });

  it("trims leading/trailing whitespace in args (Discord form padding)", () => {
    // Whitespace-only args collapse to no-args; leading/trailing whitespace
    // around real args is trimmed.
    expect(buildNativePromptString("clawcode-compact", "   ")).toBe("/compact");
    expect(buildNativePromptString("clawcode-compact", "  trimmed  ")).toBe(
      "/compact trimmed",
    );
  });
});
