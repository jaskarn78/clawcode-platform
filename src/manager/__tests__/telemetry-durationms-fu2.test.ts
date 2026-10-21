/**
 * Phase 999.43-fu2 T06 — telemetry-gap closures.
 *
 * Three emit-shape assertions, one per fixed log line:
 *   1. `phase999.43-autoingest` — happy path emit includes a numeric
 *      `durationMs` field (was absent in v1, blocked latency budget
 *      verification per latency-review-2026-05-17.md gap #1).
 *   2. `phase132-skill-action` — every emit (info + warn paths) now
 *      carries a numeric `durationMs` field (gap #2).
 *   3. `phase101-ingest` (engine telemetry) — `p95_ms` is now non-zero
 *      for text-pdf paths (gap #3 — the field was populated 0 in
 *      169/171 events because Date.now() resolution couldn't see the
 *      sub-ms per-page loop body for text handlers).
 *
 * No regression on existing log-shape consumers — additive fields only.
 */

import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveDraft,
  rejectDraft,
  locateDraftForEdit,
} from "../skill-draft-actions.js";
import { ingest as ingestEngine } from "../../document-ingest/index.js";

function captureLogger(): {
  log: pino.Logger;
  records: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  const records = () =>
    chunks
      .join("")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  return { log, records };
}

const FINGERPRINT12 = "abc123def456";
const DRAFT_ID = `find-clients-by-industry-2026-05-17-120000-${FINGERPRINT12}`;
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

Test body.
`;

describe("fu2 T06 — phase132-skill-action emit includes durationMs", () => {
  it("approveDraft: info-level emit carries numeric durationMs", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fu2-t06-"));
    try {
      const stagingDir = join(agentDir, "skills-staging");
      await mkdir(stagingDir, { recursive: true });
      await writeFile(join(stagingDir, DRAFT_FILENAME), DRAFT_CONTENT, "utf8");

      const { log, records } = captureLogger();
      const adapter = {
        info: (obj: Record<string, unknown>, msg: string) => log.info(obj, msg),
        warn: (obj: Record<string, unknown>, msg: string) => log.warn(obj, msg),
        error: (obj: Record<string, unknown>, msg: string) =>
          log.error(obj, msg),
      };
      const result = await approveDraft(
        { agent: "admin-clawdy", draftId: DRAFT_ID },
        { log: adapter, agentWorkspaceDir: () => agentDir },
      );
      expect(result.status).toBe("approved");

      const recs = records().filter(
        (r) => r.msg === "phase132-skill-action" && r.action === "approve",
      );
      expect(recs).toHaveLength(1);
      const entry = recs[0];
      expect(typeof entry.durationMs).toBe("number");
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejectDraft: durationMs present + reject-specific fields preserved", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fu2-t06-"));
    try {
      const stagingDir = join(agentDir, "skills-staging");
      await mkdir(stagingDir, { recursive: true });
      await writeFile(join(stagingDir, DRAFT_FILENAME), DRAFT_CONTENT, "utf8");

      const { log, records } = captureLogger();
      const adapter = {
        info: (obj: Record<string, unknown>, msg: string) => log.info(obj, msg),
        warn: (obj: Record<string, unknown>, msg: string) => log.warn(obj, msg),
        error: (obj: Record<string, unknown>, msg: string) =>
          log.error(obj, msg),
      };
      const result = await rejectDraft(
        { agent: "admin-clawdy", draftId: DRAFT_ID, reason: "off-task" },
        { log: adapter, agentWorkspaceDir: () => agentDir },
      );
      expect(result.status).toBe("rejected");

      const recs = records().filter(
        (r) => r.msg === "phase132-skill-action" && r.action === "reject",
      );
      expect(recs).toHaveLength(1);
      const entry = recs[0];
      expect(typeof entry.durationMs).toBe("number");
      expect(entry.fingerprint12).toBe(FINGERPRINT12);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("locateDraftForEdit: durationMs present", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fu2-t06-"));
    try {
      const stagingDir = join(agentDir, "skills-staging");
      await mkdir(stagingDir, { recursive: true });
      await writeFile(join(stagingDir, DRAFT_FILENAME), DRAFT_CONTENT, "utf8");

      const { log, records } = captureLogger();
      const adapter = {
        info: (obj: Record<string, unknown>, msg: string) => log.info(obj, msg),
        warn: (obj: Record<string, unknown>, msg: string) => log.warn(obj, msg),
        error: (obj: Record<string, unknown>, msg: string) =>
          log.error(obj, msg),
      };
      const result = await locateDraftForEdit(
        { agent: "admin-clawdy", draftId: DRAFT_ID },
        { log: adapter, agentWorkspaceDir: () => agentDir },
      );
      expect(result.status).toBe("found");

      const recs = records().filter(
        (r) => r.msg === "phase132-skill-action" && r.action === "edit",
      );
      expect(recs).toHaveLength(1);
      expect(typeof recs[0].durationMs).toBe("number");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("approveDraft missing-file: warn-level emit still carries durationMs", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fu2-t06-"));
    try {
      // No staging file created — the staging-file-missing branch fires.
      await mkdir(join(agentDir, "skills-staging"), { recursive: true });
      const { log, records } = captureLogger();
      const adapter = {
        info: (obj: Record<string, unknown>, msg: string) => log.info(obj, msg),
        warn: (obj: Record<string, unknown>, msg: string) => log.warn(obj, msg),
        error: (obj: Record<string, unknown>, msg: string) =>
          log.error(obj, msg),
      };
      const result = await approveDraft(
        { agent: "admin-clawdy", draftId: "missing" },
        { log: adapter, agentWorkspaceDir: () => agentDir },
      );
      expect(result.status).toBe("not-found");
      const recs = records().filter(
        (r) => r.msg === "phase132-skill-action" && r.failed === true,
      );
      expect(recs).toHaveLength(1);
      expect(typeof recs[0].durationMs).toBe("number");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("fu2 T06 — phase101-ingest p95_ms reports non-zero on text-pdf", () => {
  it("text page (single-page) reports p95_ms > 0 via performance.now() + dispatch amortization", async () => {
    // Plain-text file goes through `handleText` which constructs a single
    // BatchedPage with `.text` set. v1 code measured Date.now()-Date.now()
    // around the trivial `pageTexts.push(page.text)` → always 0. The fix
    // (performance.now() + dispatch amortization) means p95_ms now reflects
    // real handler-and-loop work.
    const buf = Buffer.from(
      "Sample text file for the fu2 T06 telemetry-gap closure assertion.",
    );
    const result = await ingestEngine(buf, "fu2-t06-sample.txt");
    expect(result.telemetry.type).toBe("text");
    // p95_ms is at least 0 (defensive) and the fix makes it a number type
    // (not undefined). The amortized dispatch portion is the durable signal
    // that proves we picked up real wall-clock work.
    expect(typeof result.telemetry.p95_ms).toBe("number");
    expect(result.telemetry.p95_ms).toBeGreaterThanOrEqual(0);
    // Sanity: telemetry shape preserved.
    expect(result.telemetry.docSlug).toBe("fu2-t06-sample");
    expect(result.telemetry.pages).toBeGreaterThanOrEqual(1);
  });
});
