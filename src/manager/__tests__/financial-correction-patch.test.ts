/**
 * B (2026-08-26) — tests for the pure patch-op parse/apply/render module.
 * Fixture style: verbatim prod strings from the 2026-08-26 Vallejos
 * incident (house convention — silence-sentinel/result-quality lineage).
 */

import { describe, expect, it } from "vitest";
import {
  applyPatchOps,
  parsePatchOps,
  renderCorrectionNote,
  diffSpan,
  NOTE_MAX_OPS,
  NOTE_TOTAL_MAX_CHARS,
} from "../financial-correction-patch.js";

/** Verbatim incident draft fragment (original wrong rollover claim). */
const INCIDENT_DRAFT =
  "Once you separate from Acme Corp, we open a Schwab Rollover IRA and " +
  "transfer the 401(k) in kind. Nothing is sold, no tax event is " +
  "triggered, and the old account closes itself when the transfer " +
  "completes. Your only step is signing.";

const INCIDENT_OPS_REPLY = [
  "```json",
  JSON.stringify([
    {
      find: "Once you separate from Acme Corp, we open",
      replace:
        "You do not have to quit, retire, or wait — your 401(k) unlocked at 59½ (you are 65). We open",
      source:
        "https://www.irs.gov/retirement-plans/plan-participant-employee/401k-resource-guide-plan-participants-general-distribution-rules",
    },
  ]),
  "```",
].join("\n");

describe("parsePatchOps", () => {
  it("parses a fenced ```json block of ops", () => {
    const ops = parsePatchOps(INCIDENT_OPS_REPLY);
    expect(ops).not.toBeNull();
    expect(ops).toHaveLength(1);
    expect(ops?.[0]?.find).toContain("separate from Acme Corp");
    expect(ops?.[0]?.source).toContain("irs.gov");
  });

  it("parses a bare ``` fence without the json tag", () => {
    const reply = "```\n" + JSON.stringify([{ find: "a", replace: "b" }]) + "\n```";
    const ops = parsePatchOps(reply);
    expect(ops).toHaveLength(1);
    // Missing source normalizes to "".
    expect(ops?.[0]?.source).toBe("");
  });

  it("parses a bare JSON array reply (no fence)", () => {
    const ops = parsePatchOps(
      JSON.stringify([{ find: "225%", replace: "the no-fee option", source: "x" }]),
    );
    expect(ops).toHaveLength(1);
  });

  it("returns null for prose, malformed JSON, empty array, and bad shapes", () => {
    expect(parsePatchOps("On the rollover, you're right and I had it wrong.")).toBeNull();
    expect(parsePatchOps("```json\n[{broken\n```")).toBeNull();
    expect(parsePatchOps("```json\n[]\n```")).toBeNull();
    expect(parsePatchOps('```json\n[{"replace": "x"}]\n```')).toBeNull();
    expect(parsePatchOps('```json\n[{"find": "", "replace": "x"}]\n```')).toBeNull();
    expect(parsePatchOps('```json\n{"find": "a", "replace": "b"}\n```')).toBeNull();
    expect(parsePatchOps("")).toBeNull();
  });

  it("uses the FIRST fenced block when several exist", () => {
    const reply =
      "```json\n" +
      JSON.stringify([{ find: "one", replace: "1", source: "s" }]) +
      "\n```\nsome prose\n```json\n[{\"find\": \"two\", \"replace\": \"2\"}]\n```";
    const ops = parsePatchOps(reply);
    expect(ops).toHaveLength(1);
    expect(ops?.[0]?.find).toBe("one");
  });
});

describe("applyPatchOps", () => {
  it("applies the incident op and leaves the rest byte-identical", () => {
    const ops = parsePatchOps(INCIDENT_OPS_REPLY);
    const patched = applyPatchOps(INCIDENT_DRAFT, ops ?? []);
    expect(patched).not.toBeNull();
    expect(patched).toContain("you do not have to quit, retire, or wait".replace("you", "You"));
    expect(patched).toContain("Your only step is signing.");
    expect(patched).not.toContain("Once you separate from Acme Corp");
  });

  it("applies multiple ops in order against the evolving text", () => {
    const patched = applyPatchOps("aaa bbb ccc", [
      { find: "bbb", replace: "BBB", source: "" },
      { find: "aaa BBB", replace: "x", source: "" },
    ]);
    expect(patched).toBe("x ccc");
  });

  it("replaces only the FIRST occurrence", () => {
    const patched = applyPatchOps("5.25% and 5.25%", [
      { find: "5.25%", replace: "4.31%", source: "" },
    ]);
    expect(patched).toBe("4.31% and 5.25%");
  });

  it("is ALL-OR-NOTHING: one zero-match op fails the whole patch", () => {
    const patched = applyPatchOps(INCIDENT_DRAFT, [
      { find: "Your only step is signing.", replace: "…", source: "" },
      { find: "text that is not in the draft", replace: "y", source: "" },
    ]);
    expect(patched).toBeNull();
  });

  it("supports deletion via empty replace", () => {
    expect(
      applyPatchOps("keep drop keep", [{ find: " drop", replace: "", source: "" }]),
    ).toBe("keep keep");
  });
});

describe("renderCorrectionNote", () => {
  it("renders one glance-sized line per op (999.63d compact contract)", () => {
    const note = renderCorrectionNote(
      [
        {
          find: "move to the Two Year GS Global Factor with Par and Fee at 225%",
          replace: "go with the S&P 500 one year annual point to point, no fee",
          source: "client's F&G option menu (screenshots on file)",
        },
      ],
      "🔎 Correction (verified figures & rules):\n",
    );
    expect(note.startsWith("🔎 Correction (verified figures & rules):\n")).toBe(true);
    expect(note).toContain("→");
    // Snippets are tight (40/50) and the doc-name source is truncated to 30.
    expect(note).toContain("S&P 500");
    expect(note).toContain("(client's F&G option menu (scr…)");
    expect(note.split("\n")).toHaveLength(2);
  });

  it("999.63d — URL sources reduce to the bare domain", () => {
    const note = renderCorrectionNote(
      [
        {
          find: "the 2026 Social Security wage base is $176,100",
          replace: "the 2026 Social Security wage base is $184,500",
          source: "https://www.irs.gov/pub/irs-drop/n-25-67.pdf",
        },
      ],
      "P:\n",
    );
    expect(note).toContain("(irs.gov)");
    expect(note).not.toContain("https://");
  });

  it("999.63d — the 13:05 wall fixture stays glance-sized", () => {
    // Shaped like the 2026-08-26 13:05 incident: long quoted spans + full
    // URLs across multiple ops produced a screen-filling note. The compact
    // contract caps it hard.
    const wallOps = [
      {
        find:
          '✏️ MISLABEL — page 2, "California tax deferred, at 9.3%." At ' +
          "$366,460 of taxable income he's above California's 10.3% " +
          "bracket threshold which begins at lower figures for single filers",
        replace:
          '❓ COULD NOT VERIFY — retracting my "California tax deferred, ' +
          'at 9.3%" correction. I claimed the 10.3% bracket starts below ' +
          "his taxable income and that the FTB schedule confirms it",
        source:
          "https://www.ftb.ca.gov/forms/2025/2025-540-tax-rate-schedules.pdf",
      },
      {
        find:
          "Sources: recomputation against IRS Rev. Proc. 2025-32 brackets " +
          "and the $16,100 standard deduction, 2026 SS wage base $176,100",
        replace:
          "Sources: recomputation against IRS Rev. Proc. 2025-32 brackets " +
          "and the $16,100 standard deduction, the 2026 Social Security " +
          "wage base of $184,500 per IRS Notice 2025-67",
        source: "https://www.irs.gov/pub/irs-drop/n-25-67.pdf",
      },
    ];
    const note = renderCorrectionNote(wallOps, "🔎 Correction (verified figures):\n");
    expect(note.length).toBeLessThanOrEqual(NOTE_TOTAL_MAX_CHARS);
    expect(note.split("\n").length).toBeLessThanOrEqual(1 + NOTE_MAX_OPS);
    expect(note).not.toContain("https://");
  });

  it("999.63d — caps at NOTE_MAX_OPS lines + '…and N more' tail", () => {
    const ops = Array.from({ length: 5 }, (_, i) => ({
      find: `wrong claim number ${i}`,
      replace: `right claim number ${i}`,
      source: "https://www.irs.gov/x",
    }));
    const note = renderCorrectionNote(ops, "P:\n");
    const lines = note.split("\n");
    expect(lines.filter((l) => l.startsWith("• ")).length).toBe(NOTE_MAX_OPS);
    expect(lines.at(-1)).toBe("…and 2 more");
  });

  it("truncates long finds, renders empty replace as (removed), omits empty source", () => {
    const note = renderCorrectionNote(
      [{ find: "x".repeat(500), replace: "", source: " " }],
      "P:\n",
    );
    expect(note).toContain("…");
    expect(note).toContain("(removed)");
    expect(note.endsWith("(removed)")).toBe(true);
  });
});

describe("renderCorrectionNote — 2026-08-28 minimal diff (the 10:53 unreadable note)", () => {
  it("shows the changed words with context and strips -# decoration", () => {
    const ops = [
      {
        find: "-# Two names changed from yesterday's list after the re-screen.",
        replace: "-# Three names changed from yesterday's list after the re-screen.",
        source: "Workflow report 00-growth-seven.md",
      },
      {
        find: "If Nevin saw the old list, worth a one-line note: two names changed.",
        replace: "If Nevin saw the old list, worth a one-line note: three names changed.",
        source: "Workflow report 00-growth-seven.md",
      },
    ];
    const note = renderCorrectionNote(ops, "🔎 Correction (verified figures):\n");
    const lines = note.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("• Two → Three names changed from…");
    expect(lines[1]).toContain("(Workflow report 00-growth-sev…)");
    expect(lines[2]!.startsWith("• …a one-line note: two → three names changed.")).toBe(true);
    expect(note).not.toContain("-#");
  });
  it("merges an identical change into one line with a count", () => {
    const op = { find: "a Two b", replace: "a Three b", source: "" };
    const note = renderCorrectionNote([op, op, op], "P:\n");
    expect(note.split("\n")).toHaveLength(2);
    expect(note).toContain("a Two → Three b (3 places)");
  });
  it("diffSpan: insertion and deletion render as (nothing)/(removed) by the note", () => {
    expect(diffSpan("the limit is $7,000", "the limit is now $7,000")).toMatchObject({ old: "", neu: "now", before: "the limit is", after: "$7,000" });
    const note = renderCorrectionNote([{ find: "fee waived for life", replace: "fee waived", source: "" }], "P:\n");
    expect(note).toContain("for life → (removed)");
  });
});
