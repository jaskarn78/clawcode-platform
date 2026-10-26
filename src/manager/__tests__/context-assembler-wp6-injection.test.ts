/**
 * Memory overhaul WP6 (2026-10-25): injection fixes in the assembler.
 *
 *   - USER.md is its own identity sub-source (`identityUserAutoload`),
 *     rendered after MEMORY.md and truncated only after MEMORY.md has been
 *     shrunk to its floor, so the user profile survives a full MEMORY.md.
 *   - The read-site truncation markers written by session-config.ts survive
 *     the identity-budget pass (they used to sit in the dropped middle).
 *   - Hot memories render with their created date.
 *   - The system-prompt directive block is exempt from the 8K outer cap, and
 *     the carved identity budget yields to the other fixed parts so the
 *     emergency whole-prefix head-tail cut stays a last resort.
 */

import { describe, it, expect } from "vitest";
import {
  assembleContext,
  formatHotMemoryDate,
  renderHotMemoryLine,
  STABLE_PREFIX_MAX_TOKENS,
  type ContextSources,
  type BudgetWarningEvent,
} from "../context-assembler.js";
import type { MemoryEntry } from "../../memory/types.js";
import { countTokens } from "../../performance/token-count.js";

function makeSources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    identity: "",
    hotMemories: "",
    toolDefinitions: "",
    graphContext: "",
    discordBindings: "",
    contextSummary: "",
    ...overrides,
  } as ContextSources;
}

/** Varied prose so the BPE tokenizer does not compress it (about 4 chars per token). */
function prose(tag: string, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      `${tag} note ${i}: the operator asked about invoice ${i * 7} and the reconciliation job for region ${i % 13}.`,
    );
  }
  return out.join("\n");
}

function makeMemoryEntry(
  overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "content" | "importance">,
): MemoryEntry {
  return Object.freeze({
    id: overrides.id ?? "mem-" + Math.random().toString(36).slice(2, 8),
    content: overrides.content,
    source: overrides.source ?? "manual",
    importance: overrides.importance,
    accessCount: overrides.accessCount ?? 0,
    tags: Object.freeze(overrides.tags ?? []),
    embedding: overrides.embedding ?? null,
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    accessedAt: overrides.accessedAt ?? "2026-04-01T00:00:00.000Z",
    tier: overrides.tier ?? "hot",
    sourceTurnIds: overrides.sourceTurnIds ?? null,
  });
}

// The read-site markers session-config.ts writes use U+2014 as the dash
// token; built from the code point so this file holds no literal dash.
const DASH = String.fromCharCode(0x2014);
const MEMORY_MARKER = (n: number) =>
  `[TRUNCATED ${DASH} ${n} chars dropped, dream-pass priority requested]`;
const USER_MARKER = (n: number) =>
  `[TRUNCATED ${DASH} ${n} chars dropped; keep USER.md under 4000 chars]`;

/** A MEMORY.md body shaped like session-config's read-site truncation output. */
function cappedMemoryBody(): string {
  const raw = prose("memory", 200); // ~20K chars
  const headLen = Math.floor(16_000 * 0.7);
  const tailLen = Math.floor(16_000 * 0.2);
  const dropped = raw.length - headLen - tailLen;
  return `${raw.slice(0, headLen)}\n\n${MEMORY_MARKER(dropped)}\n\n${raw.slice(-tailLen)}`;
}

describe("WP6 hot memories carry their created date", () => {
  it("formatHotMemoryDate reads the calendar date verbatim from the ISO string", () => {
    expect(formatHotMemoryDate("2026-04-01T23:30:00.000Z")).toBe("2026-04-01");
    expect(formatHotMemoryDate("2025-12-31 08:00:00")).toBe("2025-12-31");
    expect(formatHotMemoryDate(undefined)).toBeUndefined();
    expect(formatHotMemoryDate("")).toBeUndefined();
    expect(formatHotMemoryDate("yesterday")).toBeUndefined();
  });

  it("renderHotMemoryLine appends (saved YYYY-MM-DD) and degrades to the bare bullet", () => {
    expect(renderHotMemoryLine({ content: "User prefers TypeScript", createdAt: "2026-04-01T00:00:00.000Z" })).toBe(
      "- User prefers TypeScript (saved 2026-04-01)",
    );
    expect(renderHotMemoryLine({ content: "No date" })).toBe("- No date");
    expect(renderHotMemoryLine({ content: "Bad date", createdAt: "n/a" })).toBe("- Bad date");
  });

  it("the Key Memories block renders each entry with its date", () => {
    const entries = [
      makeMemoryEntry({ content: "Deploy target is Node 22", importance: 0.9, createdAt: "2026-10-20T10:00:00.000Z" }),
      makeMemoryEntry({ content: "User is in Pacific time", importance: 0.8, createdAt: "2024-02-03T10:00:00.000Z" }),
    ];
    const result = assembleContext(
      makeSources({
        identity: "id",
        hotMemories: entries.map((m) => renderHotMemoryLine(m)).join("\n"),
        hotMemoriesEntries: entries,
      }),
    );
    expect(result.stablePrefix).toContain("## Key Memories");
    expect(result.stablePrefix).toContain("- Deploy target is Node 22 (saved 2026-10-20)");
    expect(result.stablePrefix).toContain("- User is in Pacific time (saved 2024-02-03)");
  });
});

describe("WP6 USER.md is its own identity sub-source", () => {
  it("renders after MEMORY.md, byte-identical to the pre-WP6 fold when both files are present", () => {
    const base = {
      identitySoulFingerprint: "## Identity\n- calm",
      identityFile: "I am clawdy.\n",
      identityCapabilityManifest: "Your name is clawdy.\n",
    };
    const split = assembleContext(
      makeSources({
        ...base,
        identityMemoryAutoload: "memory facts",
        identityUserAutoload: "user profile",
      }),
    );
    // Pre-WP6 session-config appended USER.md to the MEMORY.md body.
    const folded = assembleContext(
      makeSources({
        ...base,
        identityMemoryAutoload: "memory facts\n\n## About the user (USER.md)\n\nuser profile",
      }),
    );
    expect(split.stablePrefix).toBe(folded.stablePrefix);
    expect(split.stablePrefix.indexOf("## Long-term memory (MEMORY.md)")).toBeLessThan(
      split.stablePrefix.indexOf("## About the user (USER.md)"),
    );
  });

  it("USER.md alone renders without an empty MEMORY.md heading", () => {
    const result = assembleContext(
      makeSources({
        identityCapabilityManifest: "Your name is clawdy.\n",
        identityMemoryAutoload: "",
        identityUserAutoload: "Prefers short answers.",
      }),
    );
    expect(result.stablePrefix).toContain("## About the user (USER.md)\n\nPrefers short answers.");
    expect(result.stablePrefix).not.toContain("## Long-term memory (MEMORY.md)");
  });

  it("over budget: MEMORY.md shrinks first, the user profile survives intact, both markers stay", () => {
    const warnings: BudgetWarningEvent[] = [];
    const memoryBody = cappedMemoryBody();
    const userBody = prose("user", 20); // ~2K chars, under the 4K cap
    const result = assembleContext(
      makeSources({
        identitySoulFingerprint: "## Identity\n- calm, precise",
        identityFile: "I am clawdy, the operations agent.\n",
        identityCapabilityManifest: "Your name is clawdy.\n",
        identityMemoryAutoload: memoryBody,
        identityUserAutoload: userBody,
      }),
      undefined,
      {
        memoryAssemblyBudgets: { identity: 2000 },
        onBudgetWarning: (e) => warnings.push(e),
      },
    );
    const prefix = result.stablePrefix;
    // Every line of the user profile is still there.
    for (const line of userBody.split("\n")) {
      expect(prefix).toContain(line);
    }
    // MEMORY.md was cut, and the agent-actionable marker survived the cut
    // with an updated running dropped-count.
    const m = /\[TRUNCATED \S+ (\d+) chars dropped, dream-pass priority requested\]/.exec(prefix);
    expect(m).not.toBeNull();
    const originalDropped = Number(/(\d+) chars dropped/.exec(memoryBody)![1]);
    expect(Number(m![1])).toBeGreaterThan(originalDropped);
    expect(prefix).not.toContain(memoryBody);
    const identityWarn = warnings.find((w) => w.section === "identity");
    expect(identityWarn?.strategy).toBe("drop-lowest-importance");
  });

  it("USER.md is cut only once MEMORY.md is at its floor, and keeps its own marker", () => {
    const memoryBody = cappedMemoryBody();
    const rawUser = prose("user", 45); // ~4.6K chars
    const headLen = Math.floor(4000 * 0.7);
    const tailLen = Math.floor(4000 * 0.2);
    const userBody = `${rawUser.slice(0, headLen)}\n\n${USER_MARKER(rawUser.length - headLen - tailLen)}\n\n${rawUser.slice(-tailLen)}`;
    const result = assembleContext(
      makeSources({
        identityCapabilityManifest: "Your name is clawdy.\n",
        identityMemoryAutoload: memoryBody,
        identityUserAutoload: userBody,
      }),
      undefined,
      { memoryAssemblyBudgets: { identity: 300 } },
    );
    const prefix = result.stablePrefix;
    expect(prefix).toMatch(/\[TRUNCATED \S+ \d+ chars dropped, dream-pass priority requested\]/);
    expect(prefix).toMatch(/\[TRUNCATED \S+ \d+ chars dropped; keep USER\.md under 4000 chars\]/);
    // MEMORY.md is at (about) its 400-char floor; USER.md was shrunk too.
    const memSection = prefix.slice(
      prefix.indexOf("## Long-term memory (MEMORY.md)"),
      prefix.indexOf("## About the user (USER.md)"),
    );
    expect(memSection.length).toBeLessThan(800);
    expect(prefix).not.toContain(userBody);
  });

  it("a MEMORY.md cut at the budget step without a read-site marker still gets a TRUNCATED marker", () => {
    const result = assembleContext(
      makeSources({
        identityCapabilityManifest: "Your name is clawdy.\n",
        identityMemoryAutoload: prose("memory", 120),
      }),
      undefined,
      { memoryAssemblyBudgets: { identity: 800 } },
    );
    expect(result.stablePrefix).toMatch(/\[TRUNCATED \S+ \d+ chars dropped\]/);
  });
});

describe("WP6 outer cap: directives exempt, identity yields to fixed parts", () => {
  function captureLog() {
    const errors: Array<Record<string, unknown>> = [];
    return {
      errors,
      log: { error: (obj: Record<string, unknown>) => errors.push(obj) },
    };
  }

  it("a ~3K-token directive block does not trip the cap or shrink MEMORY.md", () => {
    const directives = prose("directive", 160); // ~15K chars, ~3K tokens
    expect(countTokens(directives)).toBeGreaterThan(2800);
    const memoryBody = prose("memory", 130); // ~2.5K tokens, under the identity budget
    const sources = {
      identitySoulFingerprint: "## Identity\n- calm",
      identityFile: "I am clawdy.\n",
      identityCapabilityManifest: "Your name is clawdy.\n",
      identityMemoryAutoload: memoryBody,
      toolDefinitions: prose("tool", 75), // ~7.3K chars, under the 2000-token tools budget
      discordBindings: prose("discord", 60),
    };
    const { errors, log } = captureLog();
    const withDirectives = assembleContext(
      makeSources({ ...sources, systemPromptDirectives: directives }),
      undefined,
      { log, agentName: "a" },
    );
    const without = assembleContext(makeSources(sources), undefined, { log, agentName: "a" });

    // Over 8K tokens in total, yet no emergency fallback.
    expect(countTokens(withDirectives.stablePrefix)).toBeGreaterThan(STABLE_PREFIX_MAX_TOKENS);
    expect(errors).toHaveLength(0);
    // Directives lead the prefix verbatim; everything after them is
    // byte-identical to the no-directives render (MEMORY.md untouched).
    expect(withDirectives.stablePrefix).toBe(directives + "\n\n" + without.stablePrefix);
    expect(withDirectives.stablePrefix).toContain(memoryBody);
  });

  it("when the other fixed parts leave less room than the identity budget, MEMORY.md is cut instead of the whole prefix", () => {
    // Discord steers of ~4.5K tokens + tools at their 2000-token budget leave
    // well under the 4000-token identity budget below the 8K cap.
    const discord = prose("discord", 170);
    const tools = prose("tool", 120); // truncated to the 2000-token tools budget
    const memoryBody = cappedMemoryBody();
    const warnings: BudgetWarningEvent[] = [];
    const { errors, log } = captureLog();
    const result = assembleContext(
      makeSources({
        identitySoulFingerprint: "## Identity\n- calm",
        identityFile: "I am clawdy.\n",
        identityCapabilityManifest: "Your name is clawdy.\n",
        identityMemoryAutoload: memoryBody,
        identityUserAutoload: "Prefers short answers.",
        toolDefinitions: tools,
        discordBindings: discord,
      }),
      undefined,
      { log, agentName: "a", onBudgetWarning: (e) => warnings.push(e) },
    );
    expect(errors).toHaveLength(0);
    expect(countTokens(result.stablePrefix)).toBeLessThanOrEqual(STABLE_PREFIX_MAX_TOKENS);
    // The steer block and the profile are intact; MEMORY.md took the cut and
    // kept its marker. No generic whole-prefix marker appears.
    expect(result.stablePrefix).toContain(discord);
    expect(result.stablePrefix).toContain("Prefers short answers.");
    expect(result.stablePrefix).toMatch(/dream-pass priority requested\]/);
    const identityWarn = warnings.find((w) => w.section === "identity");
    expect(identityWarn).toBeDefined();
    expect(identityWarn!.budgetTokens).toBeLessThan(4000);
  });

  it("legacy compound identity keeps its configured budget (sizing applies to the carved path only)", () => {
    const warnings: BudgetWarningEvent[] = [];
    assembleContext(
      // The carved path would size identity down here (the steer block alone
      // leaves well under 4000 tokens of room); the legacy path does not.
      makeSources({ identity: prose("legacy", 100), discordBindings: prose("discord", 250) }),
      undefined,
      { onBudgetWarning: (e) => warnings.push(e) },
    );
    expect(warnings.find((w) => w.section === "identity")).toBeUndefined();
  });
});
