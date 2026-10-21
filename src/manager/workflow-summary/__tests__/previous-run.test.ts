/**
 * Phase 999.129 — previous-run records for recurring workflows.
 */

import { describe, it, expect } from "vitest";
import {
  parseRunRecord,
  pickPreviousRun,
  previousRunPromptSection,
  runRecordJson,
  sameParams,
  type RunRecord,
} from "../previous-run.js";

const rec = (o: Partial<RunRecord> & { workflowId: string; finishedAt: number }): RunRecord => ({
  template: "market-scan",
  params: { ticker: "NVDA" },
  status: "done",
  keyFindings: [],
  nextSteps: [],
  changes: [],
  ...o,
});

describe("run records", () => {
  it("round-trips through JSON and tolerates junk", () => {
    const r = rec({ workflowId: "wf_1", finishedAt: 1000, bluf: "Up.", keyFindings: ["A rose 3%"], nextSteps: ["Buy"], changes: ["A up"] });
    expect(parseRunRecord(runRecordJson(r))).toEqual(r);
    expect(parseRunRecord("{not json")).toBeNull();
    expect(parseRunRecord(JSON.stringify({ workflowId: "x" }))).toBeNull();
    expect(parseRunRecord(JSON.stringify({ workflowId: "x", template: "t", finishedAt: 1, keyFindings: [1, "ok", ""] }))).toMatchObject({
      status: "done",
      keyFindings: ["ok"],
      params: {},
    });
  });

  it("picks the latest completed run of the same template + params, never itself", () => {
    const records = [
      rec({ workflowId: "wf_old", finishedAt: 100 }),
      rec({ workflowId: "wf_new", finishedAt: 300 }),
      rec({ workflowId: "wf_failed", finishedAt: 400, status: "failed" }),
      rec({ workflowId: "wf_other", finishedAt: 500, params: { ticker: "AMD" } }),
      rec({ workflowId: "wf_template2", finishedAt: 600, template: "audit" }),
      rec({ workflowId: "wf_self", finishedAt: 700 }),
    ];
    expect(pickPreviousRun(records, { template: "market-scan", params: { ticker: "NVDA" } }, "wf_self")?.workflowId).toBe("wf_new");
    expect(pickPreviousRun(records, { template: "market-scan", params: { ticker: "TSLA" } }, "wf_self")).toBeNull();
    expect(sameParams({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
    expect(sameParams({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });

  it("renders the editor section with the previous conclusions and the delta rules", () => {
    const text = previousRunPromptSection(
      rec({ workflowId: "wf_1", finishedAt: Date.UTC(2026, 7, 29), bluf: "Flat week.", keyFindings: ["Revenue $1.2M"], nextSteps: ["Watch margins"] }),
    );
    expect(text).toContain('template "market-scan", ticker=NVDA');
    expect(text).toContain("finished on 2026-08-29");
    expect(text).toContain("- Bottom line then: Flat week.");
    expect(text).toContain("- Finding then: Revenue $1.2M");
    expect(text).toContain("Since last run");
    expect(text).toContain("`changes:` list");
    expect(text).not.toContain("—");
  });
});
