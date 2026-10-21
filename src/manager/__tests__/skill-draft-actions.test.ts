/**
 * Phase 132 Plan 03 T-01 — skill-draft-actions module tests.
 *
 * Covers SA-01..SA-09 from the plan:
 *  - approveDraft happy path moves staging → skills/<slug>/SKILL.md
 *  - approveDraft missing-draft returns not-found
 *  - approveDraft preserves byte-for-byte content (D-05 movable)
 *  - rejectDraft happy path moves staging → skills-rejected/ preserving
 *    the fingerprint12 substring (D-07 dedup substrate)
 *  - rejectDraft fingerprint12 preserved in filename
 *  - rejectDraft prepends `## Rejected: <reason>` header (D-04)
 *  - locateDraftForEdit returns the absolute draft path without moving
 *  - every action emits exactly one `phase132-skill-action` log line (D-09)
 *  - atomic move via fs.rename / writeFile+unlink — verifiable via spy
 *
 * NOTE: production uses writeFile + unlink (not rename) because skills-staging
 * and skills/<slug>/ may live on different filesystems. Tests spy on
 * writeFile + unlink call counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveDraft,
  rejectDraft,
  locateDraftForEdit,
} from "../skill-draft-actions.js";

type LogCall = readonly [Record<string, unknown>, string];

function makeLog(): {
  readonly log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
  readonly calls: LogCall[];
} {
  const calls: LogCall[] = [];
  const sink = (obj: Record<string, unknown>, msg: string) => {
    calls.push([obj, msg]);
  };
  return { log: { info: sink, warn: sink, error: sink }, calls };
}

const FINGERPRINT12 = "abc123def456";
const DRAFT_ID = `find-clients-by-industry-2026-05-16-120000-${FINGERPRINT12}`;
const DRAFT_FILENAME = `${DRAFT_ID}.md`;
const DRAFT_CONTENT = `---
name: find-clients-by-industry
description: List clients by industry
version: 1.0.0
owner: admin-clawdy
capabilities: []
requiredTools: []
requiredMcpServers: []
---

1. Query MySQL.
2. Filter by industry.
3. Share results.
`;

describe("skill-draft-actions (Phase 132 Plan 03 T-01)", () => {
  let agentDir: string;
  let stagingDir: string;

  const agentWorkspaceDir = (_agent: string): string => agentDir;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "phase132-actions-"));
    stagingDir = join(agentDir, "skills-staging");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, DRAFT_FILENAME), DRAFT_CONTENT, "utf8");
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("SA-01: approveDraft moves staging → skills/<slug>/SKILL.md", async () => {
    const { log } = makeLog();
    const result = await approveDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    expect(result.finalPath).toBe(
      join(agentDir, "skills", "find-clients-by-industry", "SKILL.md"),
    );
    // Staging file gone, final file present.
    expect(existsSync(join(stagingDir, DRAFT_FILENAME))).toBe(false);
    expect(existsSync(result.finalPath)).toBe(true);
  });

  it("SA-02: approveDraft returns not-found when draft missing", async () => {
    const { log } = makeLog();
    const result = await approveDraft(
      { agent: "admin-clawdy", draftId: "no-such-draft-id" },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("not-found");
    if (result.status !== "not-found") return;
    expect(result.reason).toBe("staging-file-missing");
  });

  it("SA-03: approveDraft preserves content + injects originatingFingerprint (Phase 999.42 D7a)", async () => {
    // DRAFT_ID ends in -<fp12> so approveDraft injects originatingFingerprint.
    // The body is otherwise byte-stable — only the new frontmatter line is added.
    const { log } = makeLog();
    const result = await approveDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    const final = await readFile(result.finalPath, "utf8");
    // Every non-frontmatter line of DRAFT_CONTENT is preserved verbatim.
    expect(final).toContain("1. Query MySQL.");
    expect(final).toContain("2. Filter by industry.");
    expect(final).toContain("3. Share results.");
    // The injected line lives inside the frontmatter block.
    expect(final).toContain(`originatingFingerprint: ${FINGERPRINT12}`);
  });

  it("SA-10: approveDraft injects originatingFingerprint into the frontmatter (D7a)", async () => {
    const { log } = makeLog();
    const result = await approveDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    const final = await readFile(result.finalPath, "utf8");
    const fm = final.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).not.toBeNull();
    expect(fm![1]).toContain(`originatingFingerprint: ${FINGERPRINT12}`);
  });

  it("SA-11: approveDraft does not duplicate an existing originatingFingerprint line", async () => {
    const PRE_FP_CONTENT = `---
name: find-clients-by-industry
description: List clients by industry
version: 1.0.0
owner: admin-clawdy
originatingFingerprint: existing12345
capabilities: []
requiredTools: []
requiredMcpServers: []
---

1. Query MySQL.
`;
    await writeFile(join(stagingDir, DRAFT_FILENAME), PRE_FP_CONTENT, "utf8");
    const { log } = makeLog();
    const result = await approveDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    const final = await readFile(result.finalPath, "utf8");
    // The pre-existing value is preserved; the draftId fp12 is NOT injected.
    const occurrences = final.split("originatingFingerprint:").length - 1;
    expect(occurrences).toBe(1);
    expect(final).toContain("originatingFingerprint: existing12345");
    expect(final).not.toContain(`originatingFingerprint: ${FINGERPRINT12}`);
  });

  it("SA-12: approveDraft skips injection when draftId has no fingerprint12", async () => {
    const NO_FP_ID = "manually-authored-skill";
    const NO_FP_FILENAME = `${NO_FP_ID}.md`;
    await writeFile(join(stagingDir, NO_FP_FILENAME), DRAFT_CONTENT, "utf8");
    const { log } = makeLog();
    const result = await approveDraft(
      { agent: "admin-clawdy", draftId: NO_FP_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    const final = await readFile(result.finalPath, "utf8");
    // No parseable fp12 → no injection; the skill simply lacks the key.
    expect(final).not.toContain("originatingFingerprint:");
    expect(final).toBe(DRAFT_CONTENT);
  });

  it("SA-04: rejectDraft moves staging → skills-rejected/", async () => {
    const { log } = makeLog();
    const result = await rejectDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID, reason: "duplicate" },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.finalPath).toBe(
      join(agentDir, "skills-rejected", DRAFT_FILENAME),
    );
    expect(existsSync(join(stagingDir, DRAFT_FILENAME))).toBe(false);
    expect(existsSync(result.finalPath)).toBe(true);
  });

  it("SA-05: rejectDraft preserves fingerprint12 in filename (D-07)", async () => {
    const { log } = makeLog();
    const result = await rejectDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID, reason: "dup" },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.fingerprint12).toBe(FINGERPRINT12);
    // Filename in skills-rejected/ contains the fingerprint12 substring
    // so Plan 02's distiller dedup can scan + skip on the next match.
    const rejectedDir = join(agentDir, "skills-rejected");
    const entries = await readdir(rejectedDir);
    expect(entries.some((n) => n.includes(FINGERPRINT12))).toBe(true);
  });

  it("SA-06: rejectDraft prepends ## Rejected: <reason> header (D-04)", async () => {
    const { log } = makeLog();
    const result = await rejectDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID, reason: "duplicate of /find" },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    const content = await readFile(result.finalPath, "utf8");
    expect(content.startsWith("## Rejected: duplicate of /find\n")).toBe(true);
    expect(content.includes(DRAFT_CONTENT)).toBe(true);
  });

  it("SA-06b: rejectDraft handles missing reason gracefully", async () => {
    const { log } = makeLog();
    const result = await rejectDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    const content = await readFile(result.finalPath, "utf8");
    expect(content.startsWith("## Rejected: no reason given\n")).toBe(true);
  });

  it("SA-07: locateDraftForEdit returns draftPath without moving", async () => {
    const { log } = makeLog();
    const result = await locateDraftForEdit(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.draftPath).toBe(join(stagingDir, DRAFT_FILENAME));
    // Staging file is STILL there — no move.
    expect(existsSync(result.draftPath)).toBe(true);
  });

  it("SA-08: every action emits exactly one phase132-skill-action log (D-09)", async () => {
    // approve
    const approve = makeLog();
    await approveDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      { log: approve.log, agentWorkspaceDir },
    );
    const approveTagged = approve.calls.filter(
      ([, msg]) => msg === "phase132-skill-action",
    );
    expect(approveTagged.length).toBe(1);
    expect(approveTagged[0]![0].action).toBe("approve");
    expect(approveTagged[0]![0].agent).toBe("admin-clawdy");
    expect(approveTagged[0]![0].draftId).toBe(DRAFT_ID);

    // re-stage the file for the next two actions
    await writeFile(join(stagingDir, DRAFT_FILENAME), DRAFT_CONTENT, "utf8");

    const reject = makeLog();
    await rejectDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID, reason: "x" },
      { log: reject.log, agentWorkspaceDir },
    );
    const rejectTagged = reject.calls.filter(
      ([, msg]) => msg === "phase132-skill-action",
    );
    expect(rejectTagged.length).toBe(1);
    expect(rejectTagged[0]![0].action).toBe("reject");
    expect(rejectTagged[0]![0].reason).toBe("x");

    await writeFile(join(stagingDir, DRAFT_FILENAME), DRAFT_CONTENT, "utf8");

    const edit = makeLog();
    await locateDraftForEdit(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      { log: edit.log, agentWorkspaceDir },
    );
    const editTagged = edit.calls.filter(
      ([, msg]) => msg === "phase132-skill-action",
    );
    expect(editTagged.length).toBe(1);
    expect(editTagged[0]![0].action).toBe("edit");
  });

  it("SA-09: approve + reject perform exactly one write + unlink each", async () => {
    const writeSpy = vi.fn(writeFile);
    const unlinkSpy = vi.fn(async (p: string) => rm(p));
    const { log } = makeLog();

    const approveResult = await approveDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID },
      {
        log,
        agentWorkspaceDir,
        fs: {
          writeFile: writeSpy as unknown as typeof writeFile,
          unlink: unlinkSpy as unknown as (p: string) => Promise<void>,
        },
      },
    );
    expect(approveResult.status).toBe("approved");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);

    // re-stage for reject
    await writeFile(join(stagingDir, DRAFT_FILENAME), DRAFT_CONTENT, "utf8");
    const writeSpy2 = vi.fn(writeFile);
    const unlinkSpy2 = vi.fn(async (p: string) => rm(p));
    const rejectResult = await rejectDraft(
      { agent: "admin-clawdy", draftId: DRAFT_ID, reason: "r" },
      {
        log,
        agentWorkspaceDir,
        fs: {
          writeFile: writeSpy2 as unknown as typeof writeFile,
          unlink: unlinkSpy2 as unknown as (p: string) => Promise<void>,
        },
      },
    );
    expect(rejectResult.status).toBe("rejected");
    expect(writeSpy2).toHaveBeenCalledTimes(1);
    expect(unlinkSpy2).toHaveBeenCalledTimes(1);
  });
});
