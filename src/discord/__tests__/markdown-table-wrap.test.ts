import { describe, it, expect, afterEach } from "vitest";
import {
  wrapMarkdownTablesInCodeFence,
  formatOutboundText,
  configureTableRendering,
  getTableRenderConfig,
  DEFAULT_TABLE_RENDER_CONFIG,
  type TableRenderConfig,
  splitKeepingAnnotations,
} from "../markdown-table-wrap.js";

const ADAPTIVE: TableRenderConfig = { mode: "adaptive", mobileColumnBudget: 32 };

/** Body lines of a fenced grid (between the opening/closing fences). */
function fenceBody(rendered: string): string[] {
  const lines = rendered.split("\n");
  return lines.slice(1, -1);
}

describe("markdown-table-wrap — pass-through invariants", () => {
  it("MTW-1: empty input passes through", () => {
    expect(wrapMarkdownTablesInCodeFence("", ADAPTIVE)).toBe("");
  });

  it("MTW-2: pure prose without tables passes through unchanged", () => {
    const input = "Hello world.\n\nNo tables here.\nJust paragraphs.";
    expect(wrapMarkdownTablesInCodeFence(input, ADAPTIVE)).toBe(input);
  });

  it("MTW-5: header without separator is NOT a table (sentence with pipes)", () => {
    const input = "Use | as separator | in CSV.\nNo separator below this line.";
    expect(wrapMarkdownTablesInCodeFence(input, ADAPTIVE)).toBe(input);
  });

  it("MTW-6: existing code-fenced content is preserved (not re-rendered)", () => {
    const input = [
      "Here's some code:",
      "```python",
      "def hello():",
      "    print('hi')",
      "```",
      "And below.",
    ].join("\n");
    expect(wrapMarkdownTablesInCodeFence(input, ADAPTIVE)).toBe(input);
  });

  it("MTW-7: a table inside a code fence passes through (no double render)", () => {
    const input = [
      "Here's a literal example:",
      "```",
      "| Col1 | Col2 |",
      "| ---- | ---- |",
      "| A | B |",
      "```",
      "End.",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    expect(result).toBe(input);
    expect((result.match(/```/g) ?? []).length).toBe(2);
  });
});

describe("markdown-table-wrap — adaptive: narrow → aligned grid", () => {
  it("MTW-3: a narrow table becomes a re-padded aligned grid in a ```text``` fence", () => {
    const input = [
      "| Col1 | Col2 | Col3 |",
      "| ---- | ---- | ---- |",
      "| A | B | E |",
      "| C | D | F |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    expect(result.split("\n")[0]).toBe("```text");
    expect(result.endsWith("```")).toBe(true);
    // Outer markdown pipes are dropped; columns are re-padded.
    expect(result).toContain("Col1 | Col2 | Col3");
    // A header rule separates header from data.
    expect(result).toMatch(/-+\+-+/);
  });

  it("MTW-GRID-ALIGN: every row's column separator sits at the same index", () => {
    const input = [
      "| Plan | Limit | Yr |",
      "| ---- | ----- | -- |",
      "| SIMPLE IRA | $16,500 | 26 |",
      "| Solo 401(k) | $23,500 | 26 |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    const rows = fenceBody(result).filter((l) => !/-\+-/.test(l)); // exclude rule
    const firstSep = rows.map((l) => l.indexOf(" | "));
    const lastSep = rows.map((l) => l.lastIndexOf(" | "));
    expect(new Set(firstSep).size).toBe(1); // first column boundary aligned
    expect(new Set(lastSep).size).toBe(1); // second column boundary aligned
    expect(firstSep[0]).toBeGreaterThan(0);
  });

  it("MTW-GRID-RIGHTALIGN: a `---:` column is right-aligned", () => {
    const input = [
      "| Item | Qty | Price |",
      "| :--- | --: | ----: |",
      "| Pen | 3 | $1 |",
      "| Stapler | 12 | $25 |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    const body = fenceBody(result);
    // "Qty" column: header "Qty" (3) vs values "3","12" — right-aligned means
    // the single-digit "3" is space-padded on the LEFT.
    const dataRow = body.find((l) => l.includes("Pen"))!;
    // Right-aligned "3" has >=2 leading spaces (sep space + pad); a
    // left-aligned "3" would sit one space after the separator.
    expect(dataRow).toMatch(/\| {2,}3 \|/);
  });
});

describe("markdown-table-wrap — adaptive: 2 columns → key/value", () => {
  it("MTW-KV: a 2-column table renders as **Label:** value lines (no fence)", () => {
    const input = [
      "| Plan | Limit |",
      "|:-----|------:|",
      "| SIMPLE IRA | $16,500 |",
      "| Solo 401(k) | $23,500 |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    expect(result).not.toContain("```");
    expect(result).toContain("**SIMPLE IRA:** $16,500");
    expect(result).toContain("**Solo 401(k):** $23,500");
    // 2026-08-27 — a meaningful header pair becomes a bold caption line so
    // the column semantics survive the transform.
    expect(result.split("\n")[0]).toBe("**Plan · Limit**");
  });

  it("MTW-KV-LIST: long labels render as a numbered list with an arrow (client-a's promise table)", () => {
    const input = [
      "| You said on the call | In the plan? |",
      "|---|---|",
      '| "W2 pros and cons versus guaranteed payments" (15:29) | Yes, p.8 with recommendation |',
      '| LLP retirement scenarios, "maximums up to 70K" (20:26) | Yes, p.5, corrected to $72,000 |',
      "| Advisor value comparison (31:07) | **Added today**, p.10 |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    const lines = result.split("\n");
    expect(lines[0]).toBe("**You said on the call → In the plan?**");
    expect(lines[1]).toBe('1. **"W2 pros and cons versus guaranteed payments" (15:29)** → Yes, p.8 with recommendation');
    expect(lines[3]).toBe("3. **Advisor value comparison (31:07)** → **Added today**, p.10"); // balanced bold kept
    expect(result).not.toContain("|");
  });

  it("MTW-KV-GENERIC: generic headers (Key/Value) get no caption line", () => {
    const input = ["| Key | Value |", "|---|---|", "| Fee | $500 |"].join("\n");
    expect(wrapMarkdownTablesInCodeFence(input, ADAPTIVE)).toBe("**Fee:** $500");
  });
});

describe("markdown-table-wrap — adaptive: wide → stacked cards", () => {
  const wide = [
    "| Agent | Model | Status | Last Active | Tokens Today |",
    "| ----- | ----- | ------ | ----------- | ------------ |",
    "| personal | opus | running | 2m ago | 1.2M |",
    "| fin-client | sonnet | idle | 1h ago | 840K |",
  ].join("\n");

  it("MTW-CARDS: a wide table becomes one-line cards (no fence)", () => {
    const result = wrapMarkdownTablesInCodeFence(wide, ADAPTIVE);
    expect(result).not.toContain("```");
    // 2026-08-27 — short rows render as ONE line per row: bold title, then
    // `Label **value**` pairs; long rows fall back to title + bullets.
    expect(result).toContain("**personal** · Model **opus** · Status **running**");
    expect(result).toContain("Tokens Today **1.2M**");
    expect(result).toContain("**fin-client** · Model **sonnet**");
  });

  it("MTW-CARDS-SEP: cards are separated by a blank line", () => {
    const result = wrapMarkdownTablesInCodeFence(wide, ADAPTIVE);
    expect(result).toContain("Tokens Today **1.2M**\n\n**fin-client**");
  });

  it("MTW-CARDS-EMPTY: empty cells are skipped (no dangling labels)", () => {
    const input = [
      "| Agent | Model | Status | Note |",
      "| ----- | ----- | ------ | ---- |",
      "| personal | opus |  | first |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, {
      mode: "cards",
      mobileColumnBudget: 36,
    });
    expect(result).toBe("**personal** · Model **opus** · Note **first**"); // Status (empty) skipped
  });

  it("MTW-CARDS-LONG: rows that don't fit one line fall back to title + bold-label bullets", () => {
    const input = [
      "| Option | Pros | Cons |",
      "| --- | --- | --- |",
      "| Guaranteed payments | Predictable W-2-like income, easier mortgage underwriting, retirement plan basis | Subject to SE tax on the full amount, less flexible year to year |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    expect(result.split("\n")[0]).toBe("**Guaranteed payments**");
    expect(result).toContain("- **Pros:** Predictable W-2-like income");
    expect(result).toContain("- **Cons:** Subject to SE tax");
  });

  it("MTW-CARDS-CODESPAN: a balanced single-backtick code span in a cell is kept", () => {
    const input = ["| Cmd | Desc | Extra |", "| --- | --- | --- |", "| grep | use `-i` flag | ok |"].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, { mode: "cards", mobileColumnBudget: 36 });
    expect(result).toContain("Desc **use `-i` flag**");
  });
});

describe("markdown-table-wrap — width gate boundary", () => {
  const table = [
    "| Aa | Bb | Cc |",
    "| -- | -- | -- |",
    "| 11 | 22 | 33 |",
  ].join("\n");

  it("just under budget → grid", () => {
    const result = wrapMarkdownTablesInCodeFence(table, {
      mode: "adaptive",
      mobileColumnBudget: 99,
    });
    expect(result).toContain("```text");
  });

  it("budget too small → cards", () => {
    const result = wrapMarkdownTablesInCodeFence(table, {
      mode: "adaptive",
      mobileColumnBudget: 1,
    });
    expect(result).not.toContain("```");
    expect(result).toBe("**11** · Bb **22** · Cc **33**");
  });
});

describe("markdown-table-wrap — robust cell parsing", () => {
  it("escaped pipes inside a cell are not column boundaries", () => {
    const input = [
      "| Cmd | Desc | Extra |",
      "| --- | ---- | ----- |",
      "| grep | match a \\| b | ok |",
      "| awk | fields | ok |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, {
      mode: "cards",
      mobileColumnBudget: 36,
    });
    // \| parses as one cell ("match a | b"); pipes are NOT escaped (a single
    // pipe isn't special in Discord), and the card line starts with "- " so
    // it can't re-parse as a table row.
    expect(result).toContain("**grep** · Desc **match a | b** · Extra **ok**");
  });

  it("a row WITH outer pipes but a cell value containing pipes parses correctly", () => {
    // Detection requires the `| ... |` pipe-style (header + separator with
    // outer pipes) to avoid false-positives on prose. Within a detected
    // table, splitRow still tolerates optional outer pipes per row.
    const input = [
      "| Name | Path | Note |",
      "| ---- | ---- | ---- |",
      "a/b | c/d | ok", // this data row lacks outer pipes — still parsed
    ];
    // The data row alone wouldn't be detected, but once the header+separator
    // start a table, consecutive `| ... |` rows are collected. A pipe-less
    // data row ends the block (TABLE_ROW_RE needs outer pipes), so it stays
    // raw — documenting the strict-detection boundary.
    const result = wrapMarkdownTablesInCodeFence(input.join("\n"), {
      mode: "cards",
      mobileColumnBudget: 36,
    });
    expect(result).toContain("a/b | c/d | ok"); // pipe-less row preserved raw
  });

  it("a fully pipe-less table passes through raw (strict detection, documented)", () => {
    const input = ["a | b | c", "--- | --- | ---", "1 | 2 | 3"].join("\n");
    // No outer pipes anywhere → not detected as a table → unchanged.
    expect(
      wrapMarkdownTablesInCodeFence(input, { mode: "cards", mobileColumnBudget: 36 }),
    ).toBe(input);
  });
});

describe("markdown-table-wrap — code-fence safety (SC-3)", () => {
  it("MTW-11: grid with a cell containing ``` uses a 4+ backtick outer fence", () => {
    const input = [
      "| L | U | Ex | N |",
      "| - | - | -- | - |",
      "| Bash | sh | ```x``` | ok |",
      "| Py | lg | p() | ok |",
    ].join("\n");
    // Force grid with a generous budget.
    const result = wrapMarkdownTablesInCodeFence(input, {
      mode: "adaptive",
      mobileColumnBudget: 999,
    });
    const open = result.split("\n")[0];
    expect(open).toMatch(/^`{4,}text$/);
    expect(result).toContain("```x```");
    const openLen = (open.match(/^`+/) ?? [""])[0].length;
    expect(result.endsWith("`".repeat(openLen))).toBe(true);
  });

  it("CARDS-BACKTICK: a card value with ``` is backslash-escaped (can't open a block)", () => {
    const input = [
      "| Name | Snippet | Extra |",
      "| ---- | ------- | ----- |",
      "| demo | ```x``` | ok |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, {
      mode: "cards",
      mobileColumnBudget: 36,
    });
    // Every backtick is escaped → renders literally, no code block opened
    // (a triple-backtick run is a block fence even when balanced).
    expect(result).toContain("Snippet **\\`\\`\\`x\\`\\`\\`**");
    expect(result).not.toContain("```x```");
  });

  it("CARDS-LABEL-BACKTICK: a backtick in a HEADER label is escaped too", () => {
    const input = [
      "| Agent | `live | Note |",
      "| ----- | ----- | ---- |",
      "| personal | yes | ok |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, {
      mode: "cards",
      mobileColumnBudget: 36,
    });
    expect(result).toContain("\\`live **yes**"); // label escaped, not raw backtick
    expect(result).not.toMatch(/ `live \*\*/);
  });

  it("CARDS-EMPHASIS: unbalanced ** in a title/value is escaped (no bleed across cards)", () => {
    const input = [
      "| Agent | Model | Status | Owner | Note |",
      "| ----- | ----- | ------ | ----- | ---- |",
      "| a**b | opus | running | x | n1 |",
      "| second | sonnet | idle | y | n2 |",
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, {
      mode: "cards",
      mobileColumnBudget: 36,
    });
    // The lone ** inside the title is escaped, so the only ** runs are our
    // own paired title delimiters → an even count, no formatting bleed.
    expect(result).toContain("**a\\*\\*b**");
    expect((result.match(/(?<!\\)\*\*/g) ?? []).length % 2).toBe(0);
  });
});

describe("markdown-table-wrap — streaming partials", () => {
  it("MTW-8: a truncated trailing row stays raw, complete rows render", () => {
    const input = [
      "| Col1 | Col2 | Col3 |",
      "| ---- | ---- | ---- |",
      "| Aaaaaaaaa | Bbbbbbbbb | Cccccccc |",
      "| C | D", // truncated — no closing pipe
    ].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    expect(result).toContain("| C | D"); // truncated row preserved raw
  });

  it("PARTIAL-HEADER-ONLY: header + separator with no data falls back to raw fence", () => {
    const input = ["| Col1 | Col2 | Col3 |", "| ---- | ---- | ---- |"].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    expect(result.split("\n")[0]).toBe("```text");
    expect(result).toContain("| Col1 | Col2 | Col3 |"); // header shown raw
  });
});

describe("markdown-table-wrap — idempotency (all branches)", () => {
  const run = (s: string, cfg: TableRenderConfig) =>
    wrapMarkdownTablesInCodeFence(s, cfg);

  it("grid branch is idempotent", () => {
    const input = [
      "Above.",
      "",
      "| A1 | B1 | C1 |",
      "| -- | -- | -- |",
      "| 11 | 22 | 33 |",
      "",
      "Below.",
    ].join("\n");
    const once = run(input, ADAPTIVE);
    expect(run(once, ADAPTIVE)).toBe(once);
  });

  it("cards branch is idempotent", () => {
    const input = [
      "| Agent | Model | Status | Last Active |",
      "| ----- | ----- | ------ | ----------- |",
      "| personal | opus | running | 2m ago |",
    ].join("\n");
    const once = run(input, ADAPTIVE);
    expect(run(once, ADAPTIVE)).toBe(once);
  });

  it("key/value branch is idempotent", () => {
    const input = ["| K | V |", "| - | - |", "| a | 1 |", "| b | 2 |"].join("\n");
    const once = run(input, ADAPTIVE);
    expect(run(once, ADAPTIVE)).toBe(once);
  });

  it("KV-EMPTYKEY-IDEM: empty-key rows whose values reconstruct a pipe table stay stable", () => {
    // Regression: empty-key values that, unescaped, look like `| a | b |` +
    // `| - | - |` must not be re-detected as a table on a second pass.
    const input = [
      "| K | V |",
      "| - | - |",
      "|  | \\| a \\| b \\| |",
      "|  | \\| - \\| - \\| |",
    ].join("\n");
    const once = run(input, ADAPTIVE);
    expect(once).not.toContain("```"); // no fence got introduced
    expect(run(once, ADAPTIVE)).toBe(once); // idempotent
  });

  it("multiple tables + prose are each rendered and stable", () => {
    const input = [
      "First.",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "Between.",
      "",
      "| Agent | Model | Status | Last Active | Tokens Today |",
      "| ----- | ----- | ------ | ----------- | ------------ |",
      "| personal | opus | running | 2m ago | 1.2M |",
    ].join("\n");
    const once = run(input, ADAPTIVE);
    expect(once).toContain("Between.");
    expect(once).toContain("**1:** 2"); // first table → key/value
    expect(once).toContain("**personal**"); // second (wide) → cards
    expect(run(once, ADAPTIVE)).toBe(once);
  });
});

describe("markdown-table-wrap — chunk safety (oversized grid)", () => {
  it("GRID-OVERSIZE: a narrow grid that would exceed the per-message budget falls back to cards", () => {
    // ~140 narrow rows: stays under the width budget (so it WOULD be a grid)
    // but the rendered fenced block exceeds the safe single-message length.
    const rows = Array.from({ length: 140 }, (_, i) => `| ${i} | item-${i} | ${i * 7} |`);
    const input = ["| ID | Name | Qty |", "| -- | ---- | --- |", ...rows].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    // Must NOT be a single fence that a splitter would cut mid-block.
    expect(result).not.toContain("```");
    expect(result).toContain("**0** · Name **item-0** · Qty **0**"); // rendered as cards instead
  });

  it("GRID-NORMAL: an ordinary narrow grid still renders as a fenced grid", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `| ${i} | item-${i} | ${i * 7} |`);
    const input = ["| ID | Name | Qty |", "| -- | ---- | --- |", ...rows].join("\n");
    const result = wrapMarkdownTablesInCodeFence(input, ADAPTIVE);
    expect(result.split("\n")[0]).toBe("```text");
  });
});

describe("markdown-table-wrap — modes", () => {
  const t = ["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n");

  it("off: tables pass through raw", () => {
    expect(wrapMarkdownTablesInCodeFence(t, { mode: "off", mobileColumnBudget: 36 })).toBe(t);
  });

  it("fence: legacy raw-in-fence (no re-pad, keeps pipes)", () => {
    const result = wrapMarkdownTablesInCodeFence(t, { mode: "fence", mobileColumnBudget: 36 });
    expect(result.split("\n")[0]).toBe("```text");
    expect(result).toContain("| A | B |"); // raw, unmodified
    expect(result).toContain("| 1 | 2 |");
  });

  it("cards: even a 2-column table becomes cards (not key/value)", () => {
    const result = wrapMarkdownTablesInCodeFence(t, { mode: "cards", mobileColumnBudget: 36 });
    expect(result).toBe("**1** · B **2**");
  });
});

describe("markdown-table-wrap — daemon-wide config", () => {
  afterEach(() => configureTableRendering(undefined)); // reset to default

  it("default config is adaptive / budget 32", () => {
    configureTableRendering(undefined);
    expect(getTableRenderConfig()).toEqual(DEFAULT_TABLE_RENDER_CONFIG);
    expect(getTableRenderConfig().mode).toBe("adaptive");
    expect(getTableRenderConfig().mobileColumnBudget).toBe(32);
  });

  it("configureTableRendering merges a partial over defaults", () => {
    configureTableRendering({ mode: "fence" });
    expect(getTableRenderConfig().mode).toBe("fence");
    expect(getTableRenderConfig().mobileColumnBudget).toBe(32); // unchanged
  });

  it("formatOutboundText honors the installed mode (off)", () => {
    const t = ["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n");
    configureTableRendering({ mode: "off" });
    expect(formatOutboundText(t)).toBe(t);
  });

  it("formatOutboundText strips em dashes before rendering tables", () => {
    configureTableRendering(undefined);
    const t = ["| Name | Note |", "| ---- | ---- |", "| a | x — y |"].join("\n");
    const result = formatOutboundText(t);
    expect(result).not.toContain("—");
    expect(result).toContain("x - y");
  });
});

describe("splitKeepingAnnotations (2026-08-27)", () => {
  const naive = (body: string, max: number): string[] => {
    const out: string[] = [];
    let r = body;
    while (r.length > max) { let i = r.lastIndexOf("\n", max); if (i <= 0) i = max; out.push(r.slice(0, i)); r = r.slice(i).trimStart(); }
    if (r) out.push(r);
    return out;
  };
  it("the trailing -# block never straddles a chunk boundary", () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const block = "-# ⚠️ cited, not opened: a.com\n-# Sources: [irs.gov › a](<https://irs.gov/a>) · [irs.gov › b](<https://irs.gov/b>)";
    const chunks = splitKeepingAnnotations(`${body}\n\n${block}`, 900, naive);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(900);
    const withBlock = chunks.filter((c) => c.includes("-# "));
    expect(withBlock).toHaveLength(1);
    expect(withBlock[0].endsWith(block)).toBe(true);
    expect(chunks[chunks.length - 1]).toBe(withBlock[0]);
  });
  it("no annotation block → identical to the body splitter", () => {
    const text = "a\nb\nc";
    expect(splitKeepingAnnotations(text, 2000, naive)).toEqual(naive(text, 2000));
  });
});
