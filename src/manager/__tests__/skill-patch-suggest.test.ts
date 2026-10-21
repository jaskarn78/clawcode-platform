/**
 * Phase 999.42 Plan 07 — skill-patch-suggest tests.
 *
 * Capability C progressive-refinement loop. Covers:
 *   - SPS-01: findActiveSkillByFingerprint — match found (an active skill's
 *     `originatingFingerprint` equals the trajectory fingerprint12).
 *   - SPS-02: findActiveSkillByFingerprint — no match (a skill without
 *     `originatingFingerprint` never matches; a different fp never matches).
 *   - SPS-03: suggestPatch — sticky-rejected (a skills-rejected/ file whose
 *     filename carries the fingerprint12 → no artifact written).
 *   - SPS-04: suggestPatch — happy path (refine call returns a valid body
 *     with the bumped version → wrapped D5 patch artifact written; wrapper
 *     fields are correct).
 *   - SPS-05: suggestPatch — rejected-invalid (refine call returns the
 *     wrong version → no artifact written).
 *   - SPS-06: suggestPatch — rejected-invalid (refine call returns an
 *     invalid manifest → no artifact written).
 *   - SPS-07: suggestPatch — telemetry tag `phase999.42-skill-patch-suggested`
 *     fires on the happy path; `phase999.42-skill-patch-draft` is the
 *     per-artifact-write tag.
 *
 * T-03 dispatch-wiring tests (SPS-08..SPS-11) live further down — they
 * assert the daemon dispatch branch is gated on `suggestPatches` and lives
 * at exactly one site.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  findActiveSkillByFingerprint,
  shouldRouteToPatch,
  suggestPatch,
  type FindActiveSkillDeps,
  type SuggestPatchDeps,
} from "../skill-patch-suggest.js";
import type { TaskCompletedEvent } from "../skill-distiller-eligibility.js";
import { trajectoryFingerprint } from "../skill-distiller-fingerprint.js";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** A trajectory whose fingerprint12 the active skill carries. */
const TRAJECTORY: TaskCompletedEvent["trajectory"] = [
  { tool: "Grep", ts: 1 },
  { tool: "Read", ts: 2 },
  { tool: "Read", ts: 3 },
  { tool: "Edit", ts: 4 },
  { tool: "Bash", ts: 5 },
  { tool: "Write", ts: 6 },
];

const FP12 = trajectoryFingerprint(TRAJECTORY).slice(0, 12);

const ACTIVE_SKILL_MD = `---
name: find-clients-by-industry
description: Find clients filtered by industry using mysql + share-file workflow
version: 1.0.0
owner: admin-clawdy
capabilities:
  - filesystem
  - mcp-tool-use
requiredTools: []
requiredMcpServers:
  - mysql
originatingFingerprint: ${FP12}
---

# find-clients-by-industry

1. Query mysql for clients in the requested industry.
2. Group results by region.
3. Render output as a table.
`;

/** A refined SKILL.md body Haiku is stubbed to return — version 1.0.1. */
const REFINED_SKILL_MD = `---
name: find-clients-by-industry
description: Find clients filtered by industry using mysql + share-file workflow
version: 1.0.1
owner: admin-clawdy
capabilities:
  - filesystem
  - mcp-tool-use
requiredTools: []
requiredMcpServers:
  - mysql
---

# find-clients-by-industry

1. Query mysql for clients in the requested industry.
2. Group results by region.
3. Render output as a table.
4. Share the result file with the requester.
`;

function makeEvent(overrides: Partial<TaskCompletedEvent> = {}): TaskCompletedEvent {
  return {
    agent: "admin-clawdy",
    sessionId: "sess-abc123",
    trajectory: TRAJECTORY,
    toolCallCount: TRAJECTORY.length,
    durationMs: 200_000,
    outcome: "success",
    ...overrides,
  };
}

function makeDeps(
  agentDir: string,
  log: ReturnType<typeof makeLog>,
  callHaiku: SuggestPatchDeps["callHaiku"],
): SuggestPatchDeps {
  return {
    callHaiku,
    resolveModelId: (alias: string) => `claude-${alias}-resolved`,
    log: log as unknown as SuggestPatchDeps["log"],
    agentWorkspaceDir: () => agentDir,
    now: () => new Date("2026-05-20T12:00:00.000Z"),
    sleep: async () => {},
  };
}

describe("Phase 999.42 Plan 07 — findActiveSkillByFingerprint", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sps-find-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("SPS-01: returns the matching skill when originatingFingerprint == fp12", async () => {
    const skillDir = join(tempDir, "skills", "find-clients-by-industry");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), ACTIVE_SKILL_MD, "utf-8");

    const log = makeLog();
    const result = await findActiveSkillByFingerprint("admin-clawdy", FP12, {
      log: log as unknown as SuggestPatchDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("find-clients-by-industry");
    expect(result!.currentVersion).toBe("1.0.0");
    expect(result!.content).toBe(ACTIVE_SKILL_MD);
    expect(result!.skillMdPath).toBe(
      join(tempDir, "skills", "find-clients-by-industry", "SKILL.md"),
    );
  });

  it("SPS-02: returns null for a skill with no originatingFingerprint or a different fp", async () => {
    // Skill A: no originatingFingerprint at all.
    const noFpDir = join(tempDir, "skills", "hand-authored-skill");
    await mkdir(noFpDir, { recursive: true });
    await writeFile(
      join(noFpDir, "SKILL.md"),
      ACTIVE_SKILL_MD.replace(`originatingFingerprint: ${FP12}\n`, ""),
      "utf-8",
    );
    // Skill B: a DIFFERENT originatingFingerprint.
    const otherFpDir = join(tempDir, "skills", "other-skill");
    await mkdir(otherFpDir, { recursive: true });
    await writeFile(
      join(otherFpDir, "SKILL.md"),
      ACTIVE_SKILL_MD.replace(FP12, "ffffffffffff"),
      "utf-8",
    );

    const log = makeLog();
    const result = await findActiveSkillByFingerprint("admin-clawdy", FP12, {
      log: log as unknown as SuggestPatchDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });
    expect(result).toBeNull();
  });

  it("SPS-02b: returns null when skills/ does not exist (no throw)", async () => {
    const log = makeLog();
    const result = await findActiveSkillByFingerprint("admin-clawdy", FP12, {
      log: log as unknown as SuggestPatchDeps["log"],
      agentWorkspaceDir: () => join(tempDir, "nonexistent"),
    });
    expect(result).toBeNull();
  });
});

describe("Phase 999.42 Plan 07 — suggestPatch", () => {
  let tempDir: string;

  async function seedActiveSkill(): Promise<void> {
    const skillDir = join(tempDir, "skills", "find-clients-by-industry");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), ACTIVE_SKILL_MD, "utf-8");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sps-suggest-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("SPS-03: sticky-rejected — a skills-rejected/ file with the fp12 blocks the patch", async () => {
    await seedActiveSkill();
    const rejectedDir = join(tempDir, "skills-rejected");
    await mkdir(rejectedDir, { recursive: true });
    await writeFile(
      join(rejectedDir, `find-clients-by-industry-2026-05-19-100000-${FP12}.md`),
      "## Rejected: operator said no\n",
      "utf-8",
    );

    const log = makeLog();
    const callHaiku = vi.fn();
    const active = await findActiveSkillByFingerprint("admin-clawdy", FP12, {
      log: log as unknown as SuggestPatchDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });
    expect(active).not.toBeNull();

    const result = await suggestPatch(
      makeEvent(),
      active!,
      makeDeps(tempDir, log, callHaiku),
    );
    expect(result.status).toBe("sticky-rejected");
    expect(callHaiku).not.toHaveBeenCalled();
    // No artifact written.
    const patchesExist = await readdir(join(tempDir, "skill-patches")).catch(
      () => [] as string[],
    );
    expect(patchesExist).toHaveLength(0);
  });

  it("SPS-04: happy path — writes a wrapped D5 patch artifact with correct wrapper fields", async () => {
    await seedActiveSkill();
    const log = makeLog();
    const callHaiku = vi
      .fn()
      .mockResolvedValue({ text: REFINED_SKILL_MD, costUsd: 0.001 });
    const active = await findActiveSkillByFingerprint("admin-clawdy", FP12, {
      log: log as unknown as SuggestPatchDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });

    const result = await suggestPatch(
      makeEvent(),
      active!,
      makeDeps(tempDir, log, callHaiku),
    );
    expect(result.status).toBe("suggested");
    if (result.status !== "suggested") throw new Error("unreachable");

    const raw = await readFile(result.patchPath, "utf-8");
    // Wrapper frontmatter — D5 format.
    expect(raw).toMatch(/^---\n/);
    expect(raw).toContain("targetSlug: find-clients-by-industry");
    expect(raw).toContain("patchClass: patch");
    expect(raw).toContain(
      `baseHash: ${createHash("sha256").update(ACTIVE_SKILL_MD, "utf8").digest("hex")}`,
    );
    expect(raw).toContain("sourceFingerprint:");
    expect(raw).toContain("sourceSessionId: sess-abc123");
    expect(raw).toContain("draftedAt:");
    // The literal body (the refined SKILL.md with version 1.0.1) follows.
    expect(raw).toContain(REFINED_SKILL_MD.trim());
    // No .tmp leftover (atomic write).
    const patchesEntries = await readdir(join(tempDir, "skill-patches"));
    expect(patchesEntries.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(patchesEntries.some((n) => n.includes(FP12))).toBe(true);
  });

  it("SPS-05: rejected-invalid — refine returns the wrong version → no artifact", async () => {
    await seedActiveSkill();
    const log = makeLog();
    // version 2.0.0 — not the patch bump of 1.0.0 (which is 1.0.1).
    const wrongVersionBody = REFINED_SKILL_MD.replace(
      "version: 1.0.1",
      "version: 2.0.0",
    );
    const callHaiku = vi.fn().mockResolvedValue({ text: wrongVersionBody });
    const active = await findActiveSkillByFingerprint("admin-clawdy", FP12, {
      log: log as unknown as SuggestPatchDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });

    const result = await suggestPatch(
      makeEvent(),
      active!,
      makeDeps(tempDir, log, callHaiku),
    );
    expect(result.status).toBe("rejected-invalid");
    const patchesExist = await readdir(join(tempDir, "skill-patches")).catch(
      () => [] as string[],
    );
    expect(patchesExist.filter((n) => n.endsWith(".md"))).toHaveLength(0);
  });

  it("SPS-06: rejected-invalid — refine returns an invalid manifest → no artifact", async () => {
    await seedActiveSkill();
    const log = makeLog();
    // Missing required `description` field — SkillManifestSchema rejects.
    const badManifestBody = `---
name: find-clients-by-industry
version: 1.0.1
owner: admin-clawdy
---

# find-clients-by-industry

1. step one.
`;
    const callHaiku = vi.fn().mockResolvedValue({ text: badManifestBody });
    const active = await findActiveSkillByFingerprint("admin-clawdy", FP12, {
      log: log as unknown as SuggestPatchDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });

    const result = await suggestPatch(
      makeEvent(),
      active!,
      makeDeps(tempDir, log, callHaiku),
    );
    expect(result.status).toBe("rejected-invalid");
    const patchesExist = await readdir(join(tempDir, "skill-patches")).catch(
      () => [] as string[],
    );
    expect(patchesExist.filter((n) => n.endsWith(".md"))).toHaveLength(0);
  });

  it("SPS-07: telemetry — phase999.42-skill-patch-suggested + -draft fire on the happy path", async () => {
    await seedActiveSkill();
    const log = makeLog();
    const callHaiku = vi.fn().mockResolvedValue({ text: REFINED_SKILL_MD });
    const active = await findActiveSkillByFingerprint("admin-clawdy", FP12, {
      log: log as unknown as SuggestPatchDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });

    await suggestPatch(makeEvent(), active!, makeDeps(tempDir, log, callHaiku));

    const allTags = log.info.mock.calls.map((c) => c[1]);
    expect(allTags).toContain("phase999.42-skill-patch-suggested");
    expect(allTags).toContain("phase999.42-skill-patch-draft");
  });
});

describe("Phase 999.42 Plan 07 — T-03 shouldRouteToPatch dispatch gate", () => {
  let tempDir: string;

  async function seedActiveSkill(): Promise<void> {
    const skillDir = join(tempDir, "skills", "find-clients-by-industry");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), ACTIVE_SKILL_MD, "utf-8");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sps-dispatch-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("SPS-08: suggestPatches=false → returns null AND does NOT scan skills/", async () => {
    await seedActiveSkill();
    const log = makeLog();
    // A spying agentWorkspaceDir — proves the scan is fully gated: with the
    // flag off, shouldRouteToPatch must short-circuit before resolving the
    // skills/ path at all.
    const agentWorkspaceDir = vi.fn(() => tempDir);
    const deps: FindActiveSkillDeps = {
      log: log as unknown as FindActiveSkillDeps["log"],
      agentWorkspaceDir,
    };
    const result = await shouldRouteToPatch(makeEvent(), false, deps);
    expect(result).toBeNull();
    // Flag off → no skills/ resolution at all (byte-identical to Phase 132).
    expect(agentWorkspaceDir).not.toHaveBeenCalled();
  });

  it("SPS-09: suggestPatches=true + active-skill match → returns the match (patch path)", async () => {
    await seedActiveSkill();
    const log = makeLog();
    const result = await shouldRouteToPatch(makeEvent(), true, {
      log: log as unknown as FindActiveSkillDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("find-clients-by-industry");
  });

  it("SPS-10: suggestPatches=true + NO match → returns null (create-draft fallthrough)", async () => {
    // No active skill seeded — the create-draft path must run.
    const log = makeLog();
    const result = await shouldRouteToPatch(makeEvent(), true, {
      log: log as unknown as FindActiveSkillDeps["log"],
      agentWorkspaceDir: () => tempDir,
    });
    expect(result).toBeNull();
  });
});

describe("Phase 999.42 Plan 07 — T-03 structural single-site invariants", () => {
  // Mirrors the Phase 132 fu2 grep-invariant test style — read daemon.ts as
  // a string and assert the patch-suggest branch lives at exactly one site.
  // A regression that copies the branch into a second dispatch path, or
  // adds a parallel patch-embed posting site, trips these.
  const daemonSrc = readFileSync(join(__dirname, "../daemon.ts"), "utf-8");

  it("SPS-11: exactly one line-start shouldRouteToPatch( invocation in daemon.ts", () => {
    const matches = daemonSrc.match(/^[ \t]*(?:const \w+ = )?await shouldRouteToPatch\(/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("SPS-12: exactly one line-start suggestPatch( invocation in daemon.ts", () => {
    // Match the call, not the `import { ... suggestPatch }` line or comments.
    const matches = daemonSrc.match(/^[ \t]*(?:const \w+ = )?await suggestPatch\(/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("SPS-13: exactly one line-start buildSkillPatchEmbed( invocation in daemon.ts", () => {
    const matches = daemonSrc.match(/^[ \t]*(?:const \w+ = )?buildSkillPatchEmbed\(/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("SPS-14: the patch branch is gated on sd.suggestPatches (single gate site)", () => {
    const matches = daemonSrc.match(/sd\.suggestPatches/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("SPS-15: fu2 invariant preserved — exactly 2 emitTaskCompletedEvent( sites", () => {
    // The patch-suggest branch lives INSIDE dispatchDistiller, downstream of
    // the emit — it adds no new emitTaskCompletedEvent( call. The Phase 132
    // fu2 single-emit invariant must be untouched.
    const matches = daemonSrc.match(/^[ \t]*emitTaskCompletedEvent\(/gm) ?? [];
    expect(matches).toHaveLength(2);
  });
});
