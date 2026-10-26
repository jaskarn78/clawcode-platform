/**
 * Memory overhaul WP6 (2026-10-25): what buildSessionConfig injects.
 *
 *   (a) The enabled system-prompt directives are rendered into
 *       `sources.systemPromptDirectives` and lead the stable prefix. Before
 *       WP6 nothing set the field, so every directive (no-em-dashes,
 *       mutate-verify, ...) was silently absent.
 *   (b) USER.md is its own identity sub-source and survives a MEMORY.md at
 *       its 16K cap under the default identity budget.
 *   (c) Hot memories carry their created date.
 *   (d) The resume summary skips the heartbeat placeholder and files older
 *       than 7 days.
 *
 * Real files in a temp workspace (no fs mocks), so the read sites are
 * exercised end to end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionConfig } from "../session-config.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { MemoryEntry, MemoryTier } from "../../memory/types.js";
import { DEFAULT_SYSTEM_PROMPT_DIRECTIVES } from "../../config/schema.js";
import {
  renderSystemPromptDirectiveBlock,
  resolveSystemPromptDirectives,
} from "../../config/loader.js";

let workspace: string;

function makeConfig(
  name: string,
  extra: Record<string, unknown> = {},
): ResolvedAgentConfig {
  return {
    name,
    workspace,
    memoryPath: workspace,
    channels: [],
    model: "haiku",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: false,
    greetCoolDownMs: 0,
    settingSources: ["project"],
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: false,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false,
    ingestionPriority: "medium" as const,
    autoStart: false,
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0.85,
      searchTopK: 5,
      consolidation: { enabled: false, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: false, similarityThreshold: 0.95 },
    },
    heartbeat: {
      enabled: false,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.7, criticalThreshold: 0.9 },
    },
    skillsPath: workspace,
    schedules: [],
    admin: false,
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 60, maxThreadSessions: 5 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
    sandbox: { enabled: false },
    ...extra,
  } as unknown as ResolvedAgentConfig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(extra: Record<string, unknown> = {}): any {
  return {
    tierManagers: new Map(),
    skillsCatalog: new Map(),
    allAgentConfigs: [],
    ...extra,
  };
}

/** Varied prose so the BPE tokenizer does not compress it. */
function prose(tag: string, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      `${tag} note ${i}: the operator asked about invoice ${i * 7} and the reconciliation job for region ${i % 13}.`,
    );
  }
  return out.join("\n");
}

function hotMemory(content: string, createdAt: string, importance = 0.9): MemoryEntry {
  return Object.freeze({
    id: `mem-${Math.random().toString(36).slice(2)}`,
    content,
    source: "conversation" as const,
    importance,
    accessCount: 5,
    tags: Object.freeze([] as string[]),
    embedding: null,
    createdAt,
    updatedAt: createdAt,
    accessedAt: createdAt,
    tier: "hot" as MemoryTier,
    sourceTurnIds: null,
  });
}

function writeResumeSummary(generated: string, body: string): void {
  const dir = join(workspace, "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "context-summary.md"),
    ["# Context Summary", "", "**Agent:** wp6", `**Generated:** ${generated}`, "", body, ""].join("\n"),
    "utf8",
  );
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "wp6-injection-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("WP6 (a) system-prompt directives reach the prompt", () => {
  it("renders the enabled fleet-default directives first in the stable prefix, no-em-dashes included", async () => {
    const result = await buildSessionConfig(makeConfig("wp6-a"), makeDeps());
    const prompt = result.systemPrompt;
    const expectedBlock = renderSystemPromptDirectiveBlock(
      resolveSystemPromptDirectives(undefined, DEFAULT_SYSTEM_PROMPT_DIRECTIVES),
    );
    expect(expectedBlock.length).toBeGreaterThan(0);
    // The directive block is the head of the prompt, verbatim.
    expect(prompt.startsWith(expectedBlock + "\n\n")).toBe(true);
    expect(prompt).toContain("Do not use em dashes");
    expect(prompt).toContain("Quote the post-mutation evidence");
    expect(prompt.indexOf("Do not use em dashes")).toBeLessThan(prompt.indexOf("Your name is wp6-a"));
    // Default-off directives stay off.
    expect(prompt).not.toContain("FOLLOW-UP BUTTONS");
  });

  it("a per-agent override on the config disables one directive and keeps the others", async () => {
    const config = makeConfig("wp6-a-off", {
      systemPromptDirectives: { "no-em-dashes": { enabled: false } },
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).not.toContain("Do not use em dashes");
    expect(result.systemPrompt).toContain("PARALLEL-TOOL-01");
  });

  it("a per-agent override can switch on an opt-in directive", async () => {
    const config = makeConfig("wp6-a-on", {
      systemPromptDirectives: { "follow-up-actions": { enabled: true } },
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("FOLLOW-UP BUTTONS");
  });

  it("fleet defaults passed in deps replace the schema defaults; none enabled renders no block", async () => {
    const custom = await buildSessionConfig(
      makeConfig("wp6-a-custom"),
      makeDeps({ systemPromptDirectiveDefaults: { custom: { enabled: true, text: "CUSTOM FLEET RULE." } } }),
    );
    expect(custom.systemPrompt.startsWith("CUSTOM FLEET RULE.\n\n")).toBe(true);
    expect(custom.systemPrompt).not.toContain("Do not use em dashes");

    const none = await buildSessionConfig(
      makeConfig("wp6-a-none"),
      makeDeps({ systemPromptDirectiveDefaults: {} }),
    );
    expect(none.systemPrompt.startsWith("Your name is wp6-a-none.")).toBe(true);
  });

  it("the bootstrap walkthrough prompt does not carry the directive block", async () => {
    const result = await buildSessionConfig(makeConfig("wp6-a-boot"), makeDeps(), undefined, "needed");
    expect(result.systemPrompt).not.toContain("Do not use em dashes");
  });
});

describe("WP6 (b) USER.md survives a full MEMORY.md", () => {
  it("under the default identity budget MEMORY.md is cut, the user profile is kept whole with both headings", async () => {
    const userBody = prose("profile", 30); // ~3K chars, under the 4K USER.md cap
    writeFileSync(join(workspace, "MEMORY.md"), prose("memory", 320), "utf8"); // ~31K chars
    writeFileSync(join(workspace, "USER.md"), userBody, "utf8");
    // A persona file of realistic size: MEMORY.md at its 16K cap plus
    // IDENTITY.md and USER.md exceed the default 4000-token identity budget.
    writeFileSync(join(workspace, "IDENTITY.md"), prose("persona", 30), "utf8");

    const warns: Array<Record<string, unknown>> = [];
    const result = await buildSessionConfig(
      makeConfig("wp6-b"),
      makeDeps({ log: { warn: (obj: Record<string, unknown>) => warns.push(obj) } }),
    );
    const prompt = result.systemPrompt;
    // The identity budget pass really ran (the read-site cap alone is not
    // what this test is about).
    expect(warns.some((w) => w.section === "identity" && w.strategy === "drop-lowest-importance")).toBe(true);

    expect(prompt).toContain("## Long-term memory (MEMORY.md)");
    expect(prompt).toContain("## About the user (USER.md)");
    for (const line of userBody.split("\n")) {
      expect(prompt).toContain(line);
    }
    // MEMORY.md was cut (read-site cap and then the identity budget) and the
    // agent-actionable marker is still in the prompt.
    expect(prompt).toMatch(/\[TRUNCATED \S+ \d+ chars dropped, dream-pass priority requested\]/);
    expect(prompt).not.toContain("memory note 200:");
  });
});

describe("WP6 (c) hot memories carry their created date", () => {
  it("each Key Memories bullet ends with (saved YYYY-MM-DD)", async () => {
    const tierManager = {
      getHotMemories: () => [
        hotMemory("User prefers TypeScript", "2026-10-20T08:00:00.000Z", 0.9),
        hotMemory("Billing job runs at 02:00", "2025-03-04T08:00:00.000Z", 0.8),
      ],
    };
    const result = await buildSessionConfig(
      makeConfig("wp6-c"),
      makeDeps({ tierManagers: new Map([["wp6-c", tierManager]]) }),
    );
    expect(result.systemPrompt).toContain("## Key Memories");
    expect(result.systemPrompt).toContain("- User prefers TypeScript (saved 2026-10-20)");
    expect(result.systemPrompt).toContain("- Billing job runs at 02:00 (saved 2025-03-04)");
  });
});

describe("WP6 (d) resume summary staleness", () => {
  const NOW = Date.parse("2026-10-25T12:00:00.000Z");

  it("the heartbeat placeholder is not injected as a previous-session summary", async () => {
    writeResumeSummary("2026-10-25 04:00:00 PDT", "Auto-snapshot at 85% context fill [red zone]");
    const result = await buildSessionConfig(makeConfig("wp6-d1"), makeDeps({ now: NOW }));
    expect(result.mutableSuffix ?? "").not.toContain("## Context Summary");
    expect(result.mutableSuffix ?? "").not.toContain("Auto-snapshot");
  });

  it("a summary older than 7 days is not injected", async () => {
    writeResumeSummary("2026-10-10T09:00:00.000Z", "Old: the deploy was blocked on DNS.");
    const result = await buildSessionConfig(makeConfig("wp6-d2"), makeDeps({ now: NOW }));
    expect(result.mutableSuffix ?? "").not.toContain("## Context Summary");
    expect(result.mutableSuffix ?? "").not.toContain("blocked on DNS");
  });

  it("a recent real summary is still injected into Session Continuity", async () => {
    writeResumeSummary("2026-10-24T09:00:00.000Z", "Key context: the deploy is blocked on DNS.");
    const result = await buildSessionConfig(makeConfig("wp6-d3"), makeDeps({ now: NOW }));
    const mutable = result.mutableSuffix ?? "";
    expect(mutable).toContain("## Session Continuity");
    expect(mutable).toContain("## Context Summary (from previous session)\nKey context: the deploy is blocked on DNS.");
  });
});
