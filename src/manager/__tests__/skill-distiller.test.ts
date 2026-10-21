/**
 * Phase 132 Plan 02 T-02 — distillSkillDraft tests.
 *
 *   - SD-01 (SC-4): synthetic long-turn fixture produces manifest-valid draft.
 *   - SD-02: manifest-invalid frontmatter → rejected (no write).
 *   - SD-03: trajectory fingerprint matches skills-rejected/ → skipped (no Haiku call).
 *   - SD-04: <3 numbered body steps → rejected (no write).
 *   - SD-05: model default is literal "claude-haiku-4-5" (D-02).
 *   - SD-06: distillerModel sonnet → resolveModelId("sonnet").
 *   - SD-07: phase132-skill-draft tag appears in every exit branch.
 *   - SD-08: atomic write — no .tmp leftover.
 *   - SD-09: 5xx retry with backoff [10000, 30000, 90000, 270000, 600000] ms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillSkillDraft } from "../skill-distiller.js";
import type { TaskCompletedEvent, SkillDistillerConfig } from "../skill-distiller-eligibility.js";
import { trajectoryFingerprint } from "../skill-distiller-fingerprint.js";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const CANONICAL_FRONTMATTER = `---
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
  - clawcode-share-file
---

# find-clients-by-industry

1. Query mysql for clients in the requested industry.
2. Group results by region.
3. Render output as a table.
4. Share file via clawcode_share_file.
`;

function syntheticLongTurnEvent(): TaskCompletedEvent {
  const tools = [
    "bash", "bash", "edit", "read",
    "mysql_query", "mysql_query", "clawcode_share_file", "subagent_complete",
  ];
  return {
    agent: "admin-clawdy",
    sessionId: "sess-long-1",
    trajectory: tools.map((tool, i) => ({ tool, ts: i * 30_000 })),
    durationMs: 240_000,
    toolCallCount: tools.length,
    outcome: "success",
  };
}

function defaultConfig(): SkillDistillerConfig {
  return {
    enabled: true,
    minToolCalls: 6,
    minDurationMs: 180_000,
    outcomeFilter: ["success"],
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "skill-distiller-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeDeps(opts: {
  haikuResponse?: string;
  haikuThrows?: Error;
  haikuResponses?: Array<string | Error>;
  log?: ReturnType<typeof makeLog>;
}) {
  const log = opts.log ?? makeLog();
  const callHaiku = vi.fn();
  const sleep = vi.fn().mockResolvedValue(undefined);
  let callIdx = 0;
  callHaiku.mockImplementation(async () => {
    if (opts.haikuResponses) {
      const item = opts.haikuResponses[callIdx++];
      if (item instanceof Error) throw item;
      return { text: item ?? "", costUsd: 0.005 };
    }
    if (opts.haikuThrows) throw opts.haikuThrows;
    return { text: opts.haikuResponse ?? CANONICAL_FRONTMATTER, costUsd: 0.005 };
  });
  return {
    callHaiku,
    resolveModelId: (alias: string) =>
      alias === "sonnet" ? "claude-sonnet-5" : alias,
    log: log as unknown as import("pino").Logger,
    agentWorkspaceDir: (agent: string) => join(tmpRoot, "agents", agent),
    now: () => new Date("2026-05-16T12:34:56Z"),
    sleep,
    spyLog: log,
  };
}

describe("distillSkillDraft (T-02)", () => {
  it("SD-01 (SC-4): synthetic long-turn fixture produces a manifest-valid SKILL.md draft", async () => {
    const deps = makeDeps({ haikuResponse: CANONICAL_FRONTMATTER });
    const result = await distillSkillDraft(
      syntheticLongTurnEvent(),
      defaultConfig(),
      deps,
    );
    expect(result.status).toBe("staged");
    if (result.status !== "staged") return;
    expect(result.draftPath).toMatch(
      /skills-staging\/find-clients-by-industry-2026-05-16-123456-[a-f0-9]{12}\.md$/,
    );
    const fileContent = await readFile(result.draftPath, "utf-8");
    expect(fileContent).toContain("name: find-clients-by-industry");
    expect(result.manifest.name).toBe("find-clients-by-industry");
  });

  it("SD-02: manifest-invalid (bad semver) frontmatter is rejected, no file written", async () => {
    const bad = CANONICAL_FRONTMATTER.replace(
      "version: 1.0.0",
      "version: not-a-semver",
    );
    const deps = makeDeps({ haikuResponse: bad });
    const result = await distillSkillDraft(
      syntheticLongTurnEvent(),
      defaultConfig(),
      deps,
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("manifest-invalid");
    const stagingDir = join(tmpRoot, "agents", "admin-clawdy", "skills-staging");
    let entries: string[] = [];
    try { entries = await readdir(stagingDir); } catch { /* not exists is fine */ }
    expect(entries).toHaveLength(0);
    const skillDraftLogs = deps.spyLog.info.mock.calls
      .concat(deps.spyLog.warn.mock.calls)
      .filter(([, msg]) => msg === "phase132-skill-draft");
    expect(skillDraftLogs.length).toBeGreaterThan(0);
    expect(skillDraftLogs.some(([p]) => p.manifestValid === false)).toBe(true);
  });

  it("SD-03: trajectory fingerprint matches skills-rejected → skipped, no Haiku call", async () => {
    const event = syntheticLongTurnEvent();
    const fp = trajectoryFingerprint(event.trajectory);
    const fp12 = fp.slice(0, 12);
    const agentDir = join(tmpRoot, "agents", "admin-clawdy");
    const rejectedDir = join(agentDir, "skills-rejected");
    await mkdir(rejectedDir, { recursive: true });
    await writeFile(
      join(rejectedDir, `some-skill-2026-05-15-100000-${fp12}.md`),
      "# rejected",
      "utf-8",
    );
    const deps = makeDeps({ haikuResponse: CANONICAL_FRONTMATTER });
    const result = await distillSkillDraft(event, defaultConfig(), deps);
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("fingerprint-rejected-prior");
    expect(deps.callHaiku).not.toHaveBeenCalled();
  });

  it("SD-04: <3 numbered body steps → rejected with reason trivial-trajectory", async () => {
    const trivial = `---
name: find-clients-by-industry
description: trivial trajectory test
version: 1.0.0
owner: admin-clawdy
capabilities: []
requiredTools: []
requiredMcpServers: []
---

# trivial

1. First step.
2. Second step.
`;
    const deps = makeDeps({ haikuResponse: trivial });
    const result = await distillSkillDraft(
      syntheticLongTurnEvent(),
      defaultConfig(),
      deps,
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("trivial-trajectory");
    expect((result as { stepCount: number }).stepCount).toBe(2);
  });

  it("SD-05: default model is the literal 'claude-haiku-4-5'", async () => {
    const deps = makeDeps({ haikuResponse: CANONICAL_FRONTMATTER });
    await distillSkillDraft(
      syntheticLongTurnEvent(),
      defaultConfig(),
      deps,
    );
    expect(deps.callHaiku).toHaveBeenCalledTimes(1);
    const args = deps.callHaiku.mock.calls[0];
    expect(args[0]).toBe("claude-haiku-4-5");
  });

  it("SD-06: distillerModel sonnet → resolveModelId('sonnet')", async () => {
    const deps = makeDeps({ haikuResponse: CANONICAL_FRONTMATTER });
    const cfg: SkillDistillerConfig = { ...defaultConfig(), distillerModel: "sonnet" };
    await distillSkillDraft(syntheticLongTurnEvent(), cfg, deps);
    const args = deps.callHaiku.mock.calls[0];
    expect(args[0]).toBe("claude-sonnet-5");
  });

  it("SD-07: phase132-skill-draft tag appears in staged/rejected/skipped/errored exits", async () => {
    // staged
    {
      const deps = makeDeps({ haikuResponse: CANONICAL_FRONTMATTER });
      await distillSkillDraft(syntheticLongTurnEvent(), defaultConfig(), deps);
      const has = deps.spyLog.info.mock.calls.some(([, m]) => m === "phase132-skill-draft");
      expect(has).toBe(true);
    }
    // rejected
    {
      const bad = CANONICAL_FRONTMATTER.replace("version: 1.0.0", "version: nope");
      const deps = makeDeps({ haikuResponse: bad });
      await distillSkillDraft(syntheticLongTurnEvent(), defaultConfig(), deps);
      const all = [
        ...deps.spyLog.info.mock.calls,
        ...deps.spyLog.warn.mock.calls,
      ];
      const has = all.some(([, m]) => m === "phase132-skill-draft");
      expect(has).toBe(true);
    }
    // skipped (fingerprint)
    {
      const event = syntheticLongTurnEvent();
      const fp12 = trajectoryFingerprint(event.trajectory).slice(0, 12);
      const agentDir = join(tmpRoot, "agents", event.agent);
      const rejectedDir = join(agentDir, "skills-rejected");
      await mkdir(rejectedDir, { recursive: true });
      await writeFile(join(rejectedDir, `x-${fp12}.md`), "x", "utf-8");
      const deps = makeDeps({ haikuResponse: CANONICAL_FRONTMATTER });
      await distillSkillDraft(event, defaultConfig(), deps);
      const has = deps.spyLog.info.mock.calls.some(([, m]) => m === "phase132-skill-draft");
      expect(has).toBe(true);
    }
    // errored
    {
      const err = Object.assign(new Error("server"), { status: 500 });
      const responses: Array<string | Error> = [err, err, err, err, err];
      const deps = makeDeps({ haikuResponses: responses });
      await distillSkillDraft(syntheticLongTurnEvent(), defaultConfig(), deps);
      const all = [
        ...deps.spyLog.info.mock.calls,
        ...deps.spyLog.warn.mock.calls,
        ...deps.spyLog.error.mock.calls,
      ];
      const has = all.some(([, m]) => m === "phase132-skill-draft");
      expect(has).toBe(true);
    }
  });

  it("SD-08: atomic write leaves no .tmp leftover in staging dir", async () => {
    const deps = makeDeps({ haikuResponse: CANONICAL_FRONTMATTER });
    await distillSkillDraft(
      syntheticLongTurnEvent(),
      defaultConfig(),
      deps,
    );
    const stagingDir = join(tmpRoot, "agents", "admin-clawdy", "skills-staging");
    const entries = await readdir(stagingDir);
    expect(entries.length).toBe(1);
    expect(entries[0].startsWith(".")).toBe(false);
    expect(entries[0].endsWith(".tmp")).toBe(false);
    expect(entries[0].endsWith(".md")).toBe(true);
  });

  it("SD-09: 5xx error retried 5 times with backoff [10000,30000,90000,270000,600000] then errors", async () => {
    const err = Object.assign(new Error("upstream 500"), { status: 500 });
    // 5 throws (initial + 4 retries) then final attempt also throws → errored
    const responses: Array<string | Error> = [err, err, err, err, err];
    const deps = makeDeps({ haikuResponses: responses });
    const result = await distillSkillDraft(
      syntheticLongTurnEvent(),
      defaultConfig(),
      deps,
    );
    expect(result.status).toBe("errored");
    if (result.status !== "errored") return;
    expect(result.reason).toBe("haiku-call-failed");
    // 5 sleeps between/before the 5 attempts
    const sleepCalls = deps.sleep.mock.calls.map((c) => c[0]);
    expect(sleepCalls).toEqual([10000, 30000, 90000, 270000, 600000]);
  });
});
