/**
 * Phase 999.42 Plan 05 T-03 — skill-patch-actions module tests.
 *
 * Covers the D5/D6 patch lifecycle:
 *  - parsePatchFile splits wrapper + body, validates the 6 wrapper fields
 *  - parsePatchFile rejects a malformed wrapper / path-traversal targetSlug
 *  - applyPatch happy path: writes body, archives pre-patch, removes patch
 *  - applyPatch D6 conflict guard: live SKILL.md mutated → conflict, no write
 *  - applyPatch D5 version-validate: wrong body version → version-rejected
 *  - applyPatch missing patch file → not-found
 *  - rejectPatch moves patch → skills-rejected/ with a header, fp12 preserved
 *  - rejectPatch missing patch file → not-found
 *  - every action emits exactly one phase999.42-skill-patch-action log
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, parsePatchFile, rejectPatch } from "../skill-patch-actions.js";

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
const SLUG = "find-clients-by-industry";
const PATCH_ID = `${SLUG}-2026-05-20-120000-${FINGERPRINT12}`;
const PATCH_FILENAME = `${PATCH_ID}.md`;

/** A live SKILL.md at version 1.0.0. */
const LIVE_SKILL = `---
name: find-clients-by-industry
description: List clients by industry
version: 1.0.0
owner: admin-clawdy
capabilities: []
requiredTools: []
requiredMcpServers: []
originatingFingerprint: abc123def456
---

1. Query MySQL.
2. Filter by industry.
`;

/** The proposed body — a patch bump to 1.0.1, refined steps. */
const PROPOSED_BODY = `---
name: find-clients-by-industry
description: List clients by industry
version: 1.0.1
owner: admin-clawdy
capabilities: []
requiredTools: []
requiredMcpServers: []
originatingFingerprint: abc123def456
---

1. Query MySQL with an index hint.
2. Filter by industry.
3. Return the result set.
`;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Build a wrapped patch file given a body + override fields. */
function buildPatch(opts: {
  body: string;
  baseHash: string;
  patchClass?: string;
  targetSlug?: string;
}): string {
  return `---
targetSlug: ${opts.targetSlug ?? SLUG}
patchClass: ${opts.patchClass ?? "patch"}
baseHash: ${opts.baseHash}
sourceFingerprint: ${FINGERPRINT12}
sourceSessionId: session-xyz
draftedAt: 2026-05-20T12:00:00Z
---
${opts.body}`;
}

describe("skill-patch-actions — parsePatchFile", () => {
  it("PP-01: splits a wrapped patch into wrapper + body", () => {
    const file = buildPatch({ body: PROPOSED_BODY, baseHash: sha256(LIVE_SKILL) });
    const parsed = parsePatchFile(file);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.wrapper.targetSlug).toBe(SLUG);
    expect(parsed.wrapper.patchClass).toBe("patch");
    expect(parsed.wrapper.baseHash).toBe(sha256(LIVE_SKILL));
    expect(parsed.wrapper.sourceFingerprint).toBe(FINGERPRINT12);
    expect(parsed.wrapper.sourceSessionId).toBe("session-xyz");
    expect(parsed.wrapper.draftedAt).toBe("2026-05-20T12:00:00Z");
    // The body is the literal proposed SKILL.md, frontmatter and all.
    expect(parsed.body).toBe(PROPOSED_BODY);
  });

  it("PP-02: malformed wrapper (missing field) → typed error", () => {
    const file = `---
targetSlug: find-clients-by-industry
patchClass: patch
---
${PROPOSED_BODY}`;
    const parsed = parsePatchFile(file);
    expect("error" in parsed).toBe(true);
  });

  it("PP-03: no wrapper frontmatter at all → typed error", () => {
    const parsed = parsePatchFile("just some text\nno frontmatter");
    expect("error" in parsed).toBe(true);
  });

  it("PP-04: bad patchClass → typed error", () => {
    const file = buildPatch({
      body: PROPOSED_BODY,
      baseHash: sha256(LIVE_SKILL),
      patchClass: "nonsense",
    });
    const parsed = parsePatchFile(file);
    expect("error" in parsed).toBe(true);
  });

  it("PP-05: path-traversal targetSlug → typed error (T-999.42-05-04)", () => {
    for (const evil of ["../escape", "a/b", "../../etc", "Bad-Slug"]) {
      const file = buildPatch({
        body: PROPOSED_BODY,
        baseHash: sha256(LIVE_SKILL),
        targetSlug: evil,
      });
      const parsed = parsePatchFile(file);
      expect("error" in parsed).toBe(true);
    }
  });

  it("PP-06: body that contains its own frontmatter parses cleanly", () => {
    // PROPOSED_BODY itself begins with `---` — non-greedy split must not
    // swallow the body's frontmatter into the wrapper.
    const file = buildPatch({ body: PROPOSED_BODY, baseHash: "x" });
    const parsed = parsePatchFile(file);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.body.startsWith("---\nname: find-clients-by-industry")).toBe(true);
  });
});

describe("skill-patch-actions — applyPatch / rejectPatch", () => {
  let agentDir: string;
  let patchesDir: string;
  let skillDir: string;
  let skillPath: string;

  const agentWorkspaceDir = (_agent: string): string => agentDir;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "phase99942-patch-"));
    patchesDir = join(agentDir, "skill-patches");
    skillDir = join(agentDir, "skills", SLUG);
    skillPath = join(skillDir, "SKILL.md");
    await mkdir(patchesDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, LIVE_SKILL, "utf8");
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  async function stagePatch(file: string): Promise<void> {
    await writeFile(join(patchesDir, PATCH_FILENAME), file, "utf8");
  }

  it("AP-01: happy path — writes body, archives pre-patch, removes patch", async () => {
    await stagePatch(buildPatch({ body: PROPOSED_BODY, baseHash: sha256(LIVE_SKILL) }));
    const { log } = makeLog();
    const result = await applyPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.newVersion).toBe("1.0.1");
    // Live SKILL.md now holds the proposed body.
    expect(await readFile(skillPath, "utf8")).toBe(PROPOSED_BODY);
    // Patch file removed.
    expect(existsSync(join(patchesDir, PATCH_FILENAME))).toBe(false);
    // Pre-patch archived under skill-patches/applied/.
    const appliedDir = join(patchesDir, "applied");
    const archived = await readdir(appliedDir);
    expect(archived.length).toBe(1);
    expect(await readFile(join(appliedDir, archived[0]!), "utf8")).toBe(LIVE_SKILL);
  });

  it("AP-02: D6 conflict guard — live SKILL.md mutated → conflict, no write", async () => {
    // baseHash recorded against LIVE_SKILL, but the operator edits it after.
    await stagePatch(buildPatch({ body: PROPOSED_BODY, baseHash: sha256(LIVE_SKILL) }));
    const operatorEdited = LIVE_SKILL.replace("Query MySQL.", "Query Postgres.");
    await writeFile(skillPath, operatorEdited, "utf8");
    const { log, calls } = makeLog();
    const result = await applyPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("conflict");
    // The operator's edit is preserved — nothing written.
    expect(await readFile(skillPath, "utf8")).toBe(operatorEdited);
    // Patch file NOT removed — operator can re-draft.
    expect(existsSync(join(patchesDir, PATCH_FILENAME))).toBe(true);
    // Action log records the failure reason.
    const tagged = calls.filter(([, m]) => m === "phase999.42-skill-patch-action");
    expect(tagged.length).toBe(1);
    expect(tagged[0]![0].failed).toBe(true);
    expect(tagged[0]![0].reason).toBe("base-hash-mismatch");
  });

  it("AP-03: D5 version-validate — wrong body version → version-rejected", async () => {
    // patchClass: patch against 1.0.0 expects 1.0.1; body declares 2.0.0.
    const wrongVersionBody = PROPOSED_BODY.replace("version: 1.0.1", "version: 2.0.0");
    await stagePatch(buildPatch({ body: wrongVersionBody, baseHash: sha256(LIVE_SKILL) }));
    const { log } = makeLog();
    const result = await applyPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("version-rejected");
    // Nothing written.
    expect(await readFile(skillPath, "utf8")).toBe(LIVE_SKILL);
    expect(existsSync(join(patchesDir, PATCH_FILENAME))).toBe(true);
  });

  it("AP-04: edit patchClass bumps the minor — happy path", async () => {
    const editBody = PROPOSED_BODY.replace("version: 1.0.1", "version: 1.1.0");
    await stagePatch(
      buildPatch({ body: editBody, baseHash: sha256(LIVE_SKILL), patchClass: "edit" }),
    );
    const { log } = makeLog();
    const result = await applyPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.newVersion).toBe("1.1.0");
  });

  it("AP-05: missing patch file → not-found", async () => {
    const { log } = makeLog();
    const result = await applyPatch(
      { agent: "admin-clawdy", patchId: "no-such-patch-id" },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("not-found");
  });

  it("AP-06: malformed patch wrapper → conflict-free typed failure (no throw)", async () => {
    await writeFile(
      join(patchesDir, PATCH_FILENAME),
      "garbage with no frontmatter",
      "utf8",
    );
    const { log } = makeLog();
    const result = await applyPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID },
      { log, agentWorkspaceDir },
    );
    // A malformed wrapper must not throw — surfaces as a failure result.
    expect(["conflict", "not-found", "version-rejected"]).toContain(result.status);
    // Nothing written.
    expect(await readFile(skillPath, "utf8")).toBe(LIVE_SKILL);
  });

  it("RP-01: rejectPatch moves patch → skills-rejected/ with header, fp12 kept", async () => {
    await stagePatch(buildPatch({ body: PROPOSED_BODY, baseHash: sha256(LIVE_SKILL) }));
    const { log } = makeLog();
    const result = await rejectPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID, reason: "superseded" },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.finalPath).toBe(
      join(agentDir, "skills-rejected", PATCH_FILENAME),
    );
    // Patch removed from skill-patches/.
    expect(existsSync(join(patchesDir, PATCH_FILENAME))).toBe(false);
    const content = await readFile(result.finalPath, "utf8");
    expect(content.startsWith("## Rejected: superseded\n")).toBe(true);
    // fp12 preserved in the filename so D7's sticky-rejection set covers it.
    const rejected = await readdir(join(agentDir, "skills-rejected"));
    expect(rejected.some((n) => n.includes(FINGERPRINT12))).toBe(true);
  });

  it("RP-02: rejectPatch handles a missing reason gracefully", async () => {
    await stagePatch(buildPatch({ body: PROPOSED_BODY, baseHash: sha256(LIVE_SKILL) }));
    const { log } = makeLog();
    const result = await rejectPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    const content = await readFile(result.finalPath, "utf8");
    expect(content.startsWith("## Rejected: no reason given\n")).toBe(true);
  });

  it("RP-03: rejectPatch missing patch file → not-found", async () => {
    const { log } = makeLog();
    const result = await rejectPatch(
      { agent: "admin-clawdy", patchId: "no-such-patch-id" },
      { log, agentWorkspaceDir },
    );
    expect(result.status).toBe("not-found");
  });

  it("PA-LOG: apply + reject each emit exactly one phase999.42-skill-patch-action", async () => {
    await stagePatch(buildPatch({ body: PROPOSED_BODY, baseHash: sha256(LIVE_SKILL) }));
    const apply = makeLog();
    await applyPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID },
      { log: apply.log, agentWorkspaceDir },
    );
    const applyTagged = apply.calls.filter(
      ([, m]) => m === "phase999.42-skill-patch-action",
    );
    expect(applyTagged.length).toBe(1);
    expect(applyTagged[0]![0].action).toBe("apply");

    // re-stage for reject
    await stagePatch(buildPatch({ body: PROPOSED_BODY, baseHash: sha256(LIVE_SKILL) }));
    const reject = makeLog();
    await rejectPatch(
      { agent: "admin-clawdy", patchId: PATCH_ID, reason: "x" },
      { log: reject.log, agentWorkspaceDir },
    );
    const rejectTagged = reject.calls.filter(
      ([, m]) => m === "phase999.42-skill-patch-action",
    );
    expect(rejectTagged.length).toBe(1);
    expect(rejectTagged[0]![0].action).toBe("reject");
  });
});
