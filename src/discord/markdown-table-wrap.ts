/**
 * Discord table rendering — make agent-emitted markdown tables readable on
 * Discord, especially on mobile.
 *
 * ## Why
 *
 * Discord does NOT render markdown tables. A raw `| a | b |` table shows
 * literal pipes with no column alignment. The original fix (Phase 100,
 * 2026-04-28) wrapped every table in a ```text``` code fence so Discord
 * rendered it as monospace. That helped on desktop but had two problems
 * the operator hit hard (2026-06-22):
 *
 *   1. **Columns still didn't align.** Wrapping in a fence makes monospace
 *      alignment *possible*, but the model rarely pads cells to equal
 *      width, so `| Alexander | 1 |` and `| Bo | 200 |` still don't line
 *      up even inside the fence. The fence was necessary but not
 *      sufficient — nothing re-padded the cells.
 *   2. **Wide tables are miserable on mobile.** A 5-column table inside a
 *      code fence overflows the phone viewport horizontally; the reader
 *      has to scroll sideways per row and the header scrolls off. Wrapping
 *      doesn't help here at all.
 *
 * The same string is shown on BOTH desktop and mobile — there's no
 * per-device branch. So the job is to pick the single rendering that is
 * readable on the narrowest target (mobile), biasing toward the
 * always-safe form when in doubt.
 *
 * ## Strategy — adaptive, width-gated (the default)
 *
 *   - **2-column tables → key/value pairs.** Two columns aren't really a
 *     table, they're label/value. Rendered as `**Label:** value` Discord-
 *     native lines — clean on every device.
 *   - **Narrow tables (aligned monospace width <= budget) → aligned grid.**
 *     Cells are RE-PADDED to equal column width (this is what fixes the
 *     alignment complaint), numeric columns right-aligned per the
 *     separator row's `:` markers, then wrapped in a code fence. Preserves
 *     the at-a-glance grid for genuinely dense/tabular data.
 *   - **Wide tables (would overflow mobile) → stacked cards.** Each row
 *     becomes a card: the first column's value as a bold title, the
 *     remaining columns as `- Label: value` bullets. Reads top-to-bottom,
 *     no horizontal scroll, header labels repeat per row so context never
 *     scrolls off. This is the "beyond the basics" mobile win.
 *
 * The width gate (`mobileColumnBudget`) is the one number that is a real
 * empirical fact about Discord's mobile code-block width (varies by
 * device/font). It is a config knob (`discord.tableRendering`) with a
 * conservative default, biased toward cards. See {@link TableRenderConfig}.
 *
 * ## Modes (rollback)
 *
 *   - `adaptive` (default) — the strategy above.
 *   - `cards` — always cards, never a grid (maximally mobile, more verbose).
 *   - `fence` — legacy behavior: wrap the raw table in a ```text``` fence
 *     with NO re-padding. The exact pre-2026-06-22 rendering. Rollback path.
 *   - `off` — no table transformation at all (tables pass through raw).
 *
 * Tune at runtime via the daemon-wide config (set once at boot through
 * {@link configureTableRendering}); same flippable-knob pattern as
 * `shimRuntime` / `advisor.backend`.
 *
 * ## Invariants
 *
 *   - **Single chokepoint.** {@link formatOutboundText} (strip em-dashes ->
 *     render tables) is called at every outbound-to-Discord write site. The
 *     Phase 122 universal-wrap-coverage sentinel pins that wiring by the
 *     name `formatOutboundText`; the underlying renderer keeps the export
 *     name `wrapMarkdownTablesInCodeFence` for back-compat.
 *   - **Pure.** No I/O, no logging, no side effects (the config setter is
 *     the one piece of module state, set once at boot — the renderer reads
 *     it but never writes it).
 *   - **Idempotent.** Running twice yields the same result as once. Grid
 *     output is a code fence (pass-through on re-run); card / key-value
 *     output has no `| ... |` rows (never re-detected as a table).
 *   - **Streaming-safe.** Runs on accumulated content each edit. A
 *     truncated trailing row (mid-arrival, no closing pipe) falls outside
 *     the detected block and stays raw until it completes. Column widths
 *     only grow as rows stream, so a table flips narrow->cards at most once
 *     (never oscillates).
 *   - **Injection-safe.** Cards / key-value render Discord-native markdown,
 *     so every cell-derived string (title, label, key, value) is
 *     backslash-escaped (`escapeDiscordInline`) for the two genuinely
 *     damaging cases — a stray ```` ``` ```` (code block) and unbalanced
 *     `*`/`**` (emphasis bleed across cards) — without over-escaping common
 *     dev content (see `escapeDiscordInline` for the deliberate exclusions).
 *     Re-detection is prevented structurally: a card/kv line always starts
 *     with `**` or `- `, never `|`. The grid branch needs no escaping (it's
 *     already literal inside the fence); its outer fence escalates to
 *     longest-inner-run + 1 so an embedded ```` ``` ```` can't terminate it
 *     (Phase 122 SC-3).
 *   - **Chunk-safe.** A grid that would exceed `MAX_FENCE_BLOCK_CHARS`
 *     (≈ the Discord per-message ceiling) falls back to cards, so the
 *     downstream splitter never cuts a fence in half and leaves an unclosed
 *     ```text``` block. Cards split cleanly on line boundaries.
 *
 * ## Known limitations
 *
 *   - Grid column widths use UTF-16 `String.length`, so CJK / emoji cells
 *     (which occupy ≈2 monospace cells) are best-effort — alignment is exact
 *     for ASCII, approximate for wide glyphs.
 *   - `@everyone` / `@here` / `<@id>` in a cell render as live mentions in
 *     the non-fenced cards/key-value output (they were inert inside the old
 *     fence). Backslash can't neutralize them; gate at the send layer with
 *     `allowedMentions` if that matters. An agent can already ping from
 *     plain prose, so this is not a new capability.
 */

import { stripEmDashes } from "./text-sanitization.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How markdown tables are rendered for Discord. */
export type TableRenderMode = "adaptive" | "cards" | "fence" | "off";

/**
 * Daemon-wide table-rendering configuration.
 *
 * `mobileColumnBudget` is the maximum *aligned monospace width* (in
 * characters, including the ` | ` column separators) a table may occupy
 * before the adaptive renderer converts it to stacked cards. It models the
 * usable width of a Discord code block on a phone in portrait. The default
 * (32) is biased toward cards on purpose: a too-wide guess produces an
 * unreadable horizontal scroll on mobile, while a too-narrow guess only
 * produces a slightly more verbose card stack — the cheaper error. Calibrated
 * 2026-06-25 against a real iPhone (a ~28-char grid fit with margin; fit
 * ceiling ≈37, so 32 leaves headroom for smaller screens / larger fonts).
 * Tune via `discord.tableRendering.mobileColumnBudget`.
 * Setting it very high (e.g. 9999) keeps every table as an aligned grid.
 */
export interface TableImageConfig {
  /** Render wide numeric grids as PNG cards (adaptive mode only). */
  readonly enabled: boolean;
  /** Minimum column count for the image path (2-col tables are always lists). */
  readonly minColumns: number;
  /** Tables with more data rows than this stay text (cards). */
  readonly maxRows: number;
  /** A cell longer than this marks the table as prose-like → cards, not image. */
  readonly maxCellChars: number;
  /** Device scale factor for the PNG (2 = retina-crisp). */
  readonly scale: number;
}

export interface TableRenderConfig {
  readonly mode: TableRenderMode;
  readonly mobileColumnBudget: number;
  /** Image path settings; absent = defaults (tests / legacy callers). */
  readonly image?: TableImageConfig;
}

export const DEFAULT_TABLE_IMAGE_CONFIG: TableImageConfig = Object.freeze({
  enabled: true,
  minColumns: 3,
  maxRows: 40,
  maxCellChars: 80,
  scale: 2,
});

export const DEFAULT_TABLE_RENDER_CONFIG: TableRenderConfig = Object.freeze({
  mode: "adaptive",
  mobileColumnBudget: 32,
  image: DEFAULT_TABLE_IMAGE_CONFIG,
});

let activeConfig: TableRenderConfig = DEFAULT_TABLE_RENDER_CONFIG;

/**
 * Install the daemon-wide table-rendering config (boot / reload). A partial
 * is merged field-wise over the compile-time default; `undefined` resets to
 * the default. The renderer reads `activeConfig` when no explicit config is
 * passed to {@link wrapMarkdownTablesInCodeFence}.
 */
export function configureTableRendering(
  partial: (Partial<Omit<TableRenderConfig, "image">> & { image?: Partial<TableImageConfig> }) | undefined,
): void {
  if (!partial) {
    activeConfig = DEFAULT_TABLE_RENDER_CONFIG;
    return;
  }
  activeConfig = Object.freeze({
    mode: partial.mode ?? DEFAULT_TABLE_RENDER_CONFIG.mode,
    mobileColumnBudget:
      partial.mobileColumnBudget ?? DEFAULT_TABLE_RENDER_CONFIG.mobileColumnBudget,
    image: Object.freeze({ ...DEFAULT_TABLE_IMAGE_CONFIG, ...(partial.image ?? {}) }),
  });
}

/** Current daemon-wide table-rendering config (test/diagnostic accessor). */
export function getTableRenderConfig(): TableRenderConfig {
  return activeConfig;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const TABLE_ROW_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]+\|\s*$/;
const CODE_FENCE_RE = /^\s*```/;
const BACKTICK_RUN_RE = /`+/g;
const MIN_FENCE_LEN = 3;
const COLUMN_SEP = " | ";
// Max length of a single rendered grid (fenced) block. Above this the
// downstream chunker (splitMessage, ~2000-char Discord ceiling) would split
// it mid-fence and leave an unclosed ```text```; such grids fall back to
// cards instead. Conservative — leaves headroom for surrounding prose.
const MAX_FENCE_BLOCK_CHARS = 1900;

export type Align = "left" | "right" | "center";

/**
 * Longest run of consecutive backticks across the given lines. Used to size
 * an outer code fence that an embedded backtick run can't terminate early
 * (Phase 122 SC-3).
 */
function longestBacktickRun(block: readonly string[]): number {
  let longest = 0;
  for (const line of block) {
    BACKTICK_RUN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BACKTICK_RUN_RE.exec(line)) !== null) {
      if (m[0].length > longest) longest = m[0].length;
    }
  }
  return longest;
}

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

/**
 * Split one markdown table row into trimmed cell strings. Tolerates:
 *   - optional leading/trailing outer pipes (`| a | b |` and `a | b` both ok)
 *   - escaped pipes (`\|`) inside a cell — unescaped to a literal `|`
 */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  // Drop a trailing outer pipe, but not an escaped one (`\|`).
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Parse per-column alignment from the separator row's `:` markers. */
function parseAlignments(separatorLine: string): Align[] {
  return splitRow(separatorLine).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function pad(s: string, width: number, align: Align): string {
  const gap = Math.max(0, width - s.length);
  if (gap === 0) return s;
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

/** Normalize a row to exactly `nCols` cells (truncate extras, pad blanks). */
function normalizeRow(row: string[], nCols: number): string[] {
  const c = row.slice(0, nCols);
  while (c.length < nCols) c.push("");
  return c;
}

// Discord markdown control characters worth escaping in the NON-fenced
// cards / key-value output. Deliberately MINIMAL — we escape only chars
// that (a) are genuinely special as a SINGLE char and (b) cause real
// structural corruption, while leaving common dev content untouched:
//   `  code span/fence — a stray run opens a code block            (escape)
//   *  emphasis/bold   — an odd `**`/`*` bleeds across cards         (escape)
//   \  the escape char — so a literal `\` in a cell can't swallow a
//      following escaped char; must be in the class too             (escape)
// NOT escaped (over-escaping a dev/agent tool is worse than the rare edge):
//   _  Discord ignores intraword underscores, so snake_case / URLs render
//      fine raw; escaping every `_` litters backslashes and breaks links.
//   |  a single pipe isn't special (only `||` spoiler is); pipes are common
//      in cell data. Idempotency does NOT need it — card/kv lines always
//      start with `**` or `- `, never `|`, so they can't re-parse as a row.
//   ~  a single tilde isn't special (only `~~`); `~/paths` are common.
//   >  only a LINE-LEADING `>` is a blockquote; cell content never leads
//      a card/kv line (it follows `- `/`**`).
// Residual (rare): a cell containing the exact double/boundary forms
// `||x||`, `~~x~~`, or `_word_` still renders as spoiler/strike/italic.
const DISCORD_INLINE_SPECIAL_RE = /[\\`*]/g;

/**
 * Backslash-escape Discord markdown control chars so a table cell's content
 * renders LITERALLY and cannot inject structure into the non-fenced cards /
 * key-value output (unbalanced `**`, a stray ```` ``` ````). Mirrors the
 * literal-content semantics of the in-fence grid branch. The backslashes for
 * these chars are hidden by Discord (each IS a recognized control char), so
 * nothing visible is added. Callers escape exactly once per render.
 *
 * 2026-08-27 — BALANCED inline markdown is preserved: a cell like
 * `**Added today**, p.10` keeps its bold (the model meant it), and `` `code` ``
 * keeps its code span. Only cells whose `*` / backtick runs are unbalanced —
 * the ones that could bleed emphasis or open a code block across cards —
 * are escaped, and then wholesale, as before. Backslashes are always escaped
 * so a literal `\` can't swallow a following escaped char.
 *
 * Not handled: `@everyone`/`@here`/`<@id>` mentions (backslash doesn't
 * neutralize them). Suppress those at the send layer via `allowedMentions`
 * if needed; an agent can already ping from plain prose, so a table cell is
 * not a new capability.
 */
function escapeDiscordInline(s: string): string {
  if (!/[`*]/.test(s)) return s.replace(/\\/g, "\\\\");
  const balanced = inlineMarkdownBalanced(s);
  if (balanced) return s.replace(/\\/g, "\\\\");
  return s.replace(DISCORD_INLINE_SPECIAL_RE, "\\$&");
}

/** True when every `**`, `*` and backtick run in `s` closes within `s`. */
function inlineMarkdownBalanced(s: string): boolean {
  // Backtick runs: each distinct run length must occur an even number of times.
  const runs = new Map<number, number>();
  for (const m of s.matchAll(/`+/g)) {
    // A triple-backtick run is a BLOCK fence even when it closes on the same
    // line — it would split the card line into a code block. Always escape.
    if (m[0].length >= 3) return false;
    runs.set(m[0].length, (runs.get(m[0].length) ?? 0) + 1);
  }
  for (const n of runs.values()) if (n % 2 !== 0) return false;
  // Strip code spans, then count bold and single-star markers.
  const noCode = s.replace(/`[^`]*`/g, "");
  const bold = (noCode.match(/\*\*/g) ?? []).length;
  if (bold % 2 !== 0) return false;
  const single = (noCode.replace(/\*\*/g, "").match(/\*/g) ?? []).length;
  return single % 2 === 0;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Legacy / rollback: wrap the raw table block verbatim in a ```text``` fence. */
function renderRawFence(block: readonly string[]): string {
  const outerLen = Math.max(longestBacktickRun(block) + 1, MIN_FENCE_LEN);
  const fence = "`".repeat(outerLen);
  return [`${fence}text`, ...block, fence].join("\n");
}

/** Aligned monospace grid inside a code fence, with a header rule. */
function renderGrid(
  header: string[],
  rows: string[][],
  colW: number[],
  aligns: Align[],
): string {
  const fmtRow = (r: string[]): string =>
    r.map((c, i) => pad(c, colW[i], aligns[i])).join(COLUMN_SEP).replace(/\s+$/, "");
  // Header rule: dashes per column, joined so the `+` sits under each `|`.
  const rule = colW.map((w) => "-".repeat(w)).join("-+-");
  const bodyLines = [fmtRow(header), rule, ...rows.map(fmtRow)];
  const outerLen = Math.max(longestBacktickRun(bodyLines) + 1, MIN_FENCE_LEN);
  const fence = "`".repeat(outerLen);
  return [`${fence}text`, ...bodyLines, fence].join("\n");
}

/** Header cells that carry no information worth a caption line. */
const GENERIC_HEADER_RE = /^(?:|-+|key|keys|value|values|field|fields|item|items|name|label|description|detail|details|column ?\d*|col ?\d*)$/i;

function meaningfulHeaderPair(header: readonly string[]): boolean {
  const a = (header[0] ?? "").trim();
  const b = (header[1] ?? "").trim();
  return a.length >= 2 && b.length >= 2 && !GENERIC_HEADER_RE.test(a) && !GENERIC_HEADER_RE.test(b);
}

/** Median label length decides list vs definition style (see renderKeyValue). */
const KV_NUMBERED_MEDIAN_CHARS = 28;

/**
 * Two-column table → Discord-native lines. Two shapes, chosen by label length:
 *
 *   - short labels (`Fee | $500`) → definition list `**Label:** value`;
 *   - long labels (a quoted sentence, a promise, a question) → a numbered
 *     list `1. **label** → value`, which reads top-to-bottom on a phone and
 *     gives the reader something to point at ("item 7").
 *
 * When the header pair is meaningful it becomes a bold caption line
 * (`**You said on the call → In the plan?**`) so the column semantics —
 * dropped entirely before 2026-08-27 — survive the transform.
 */
function renderKeyValue(header: readonly string[], rows: string[][]): string {
  const out: string[] = [];
  const labelLens = rows.map((r) => (r[0] ?? "").trim().length).filter((n) => n > 0).sort((a, b) => a - b);
  const median = labelLens.length ? labelLens[Math.floor(labelLens.length / 2)] : 0;
  const numbered = rows.length >= 3 && median > KV_NUMBERED_MEDIAN_CHARS;
  if (meaningfulHeaderPair(header)) {
    const h1 = escapeDiscordInline(header[0].trim());
    const h2 = escapeDiscordInline(header[1].trim());
    out.push(numbered ? `**${h1} → ${h2}**` : `**${h1} · ${h2}**`);
  }
  let n = 0;
  for (const r of rows) {
    const k = (r[0] ?? "").trim();
    const v = (r[1] ?? "").trim();
    if (!k && !v) continue;
    const ev = escapeDiscordInline(v);
    if (!k) {
      // Keyless row → plain bullet. The `- ` prefix (plus escaped pipes in
      // ev) guarantees the line can't re-parse as a `| ... |` table row on
      // a later pass, preserving idempotency.
      out.push(`- ${ev}`);
      continue;
    }
    n += 1;
    if (numbered) out.push(`${n}. **${escapeDiscordInline(k)}** → ${ev}`.replace(/\s+$/, ""));
    else out.push(`**${escapeDiscordInline(k)}:** ${ev}`.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

/** Longest single-line card before it breaks into bullets. */
const CARD_ONE_LINE_MAX_CHARS = 110;

/**
 * Wide table → stacked cards. A row whose fields fit on one line renders as
 * `**title** · Label **value** · Label **value**` (one glance per row);
 * otherwise as a bold title followed by `- **Label:** value` bullets.
 */
function renderCards(header: readonly string[], rows: string[][]): string {
  const cards: string[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const titleRaw = (r[0] ?? "").trim();
    const title = titleRaw ? escapeDiscordInline(titleRaw) : `Row ${ri + 1}`;
    const fields: Array<{ label: string; value: string }> = [];
    for (let ci = 1; ci < r.length; ci++) {
      const val = (r[ci] ?? "").trim();
      if (!val) continue; // skip empty fields — keeps cards uncluttered
      const labelRaw = (header[ci] ?? "").trim();
      // Label comes from the agent-controlled header row — escape it too.
      const label = labelRaw ? escapeDiscordInline(labelRaw) : `Field ${ci + 1}`;
      fields.push({ label, value: escapeDiscordInline(val) });
    }
    const oneLine = `**${title}** · ${fields.map((f) => `${f.label} **${f.value}**`).join(" · ")}`;
    if (fields.length > 0 && oneLine.length <= CARD_ONE_LINE_MAX_CHARS) {
      cards.push(oneLine);
      continue;
    }
    const lines: string[] = [`**${title}**`];
    for (const f of fields) lines.push(`- **${f.label}:** ${f.value}`);
    cards.push(lines.join("\n"));
  }
  return cards.join("\n\n");
}

/**
 * Render one detected table block ([header, separator, ...dataRows], every
 * line matching {@link TABLE_ROW_RE}) according to the active mode.
 */
function renderTableBlock(block: string[], cfg: TableRenderConfig): string {
  if (cfg.mode === "fence") return renderRawFence(block);

  const header = splitRow(block[0]);
  const aligns = parseAlignments(block[1]);
  const dataRows = block.slice(2).map(splitRow);

  // Header + separator only (no data) — usually a mid-stream partial. Keep
  // the raw fence so the header is still shown; cards/grid would either be
  // empty or lose it.
  if (dataRows.length === 0) return renderRawFence(block);

  const nCols = Math.max(
    header.length,
    aligns.length,
    ...dataRows.map((r) => r.length),
  );
  const H = normalizeRow(header, nCols);
  const rows = dataRows.map((r) => normalizeRow(r, nCols));
  const A: Align[] = Array.from({ length: nCols }, (_, i) => aligns[i] ?? "left");

  if (cfg.mode === "cards") return renderCards(H, rows);

  // 2-column → key/value (adaptive only; `cards` handled above).
  if (nCols === 2) return renderKeyValue(H, rows);

  // adaptive: gate on the aligned monospace width.
  const colW = Array.from({ length: nCols }, (_, i) =>
    Math.max(H[i].length, ...rows.map((r) => r[i].length), 1),
  );
  const totalWidth =
    colW.reduce((a, b) => a + b, 0) + COLUMN_SEP.length * (nCols - 1);
  if (totalWidth <= cfg.mobileColumnBudget) {
    const grid = renderGrid(H, rows, colW, A);
    // A single fenced block large enough to exceed a per-message budget gets
    // split mid-fence by the downstream chunker (splitMessage), leaving an
    // unclosed ```text``` that renders everything AFTER it as code. Fall back
    // to cards, which split cleanly across messages (no unclosed structure).
    if (grid.length <= MAX_FENCE_BLOCK_CHARS) return grid;
    return renderCards(H, rows);
  }
  return renderCards(H, rows);
}

// ---------------------------------------------------------------------------
// Shared detection (used by the async image planner in table-delivery.ts)
// ---------------------------------------------------------------------------

export interface ParsedTable {
  /** Line index of the header row / one past the last table row. */
  readonly start: number;
  readonly end: number;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly aligns: readonly Align[];
  readonly nCols: number;
  /** Aligned monospace width incl. ` | ` separators — the mobile budget gate. */
  readonly alignedWidth: number;
  /** Longest cell (chars) — prose-like tables have long cells. */
  readonly maxCellChars: number;
}

/** Parse a detected block ([header, separator, ...rows]) into cells. */
export function parseTableBlock(block: readonly string[], start = 0): ParsedTable | null {
  if (block.length < 2) return null;
  const header = splitRow(block[0]);
  const aligns = parseAlignments(block[1]);
  const dataRows = block.slice(2).map(splitRow);
  const nCols = Math.max(header.length, aligns.length, ...dataRows.map((r) => r.length));
  const H = normalizeRow(header, nCols);
  const rows = dataRows.map((r) => normalizeRow(r, nCols));
  const A: Align[] = Array.from({ length: nCols }, (_, i) => aligns[i] ?? "left");
  const colW = Array.from({ length: nCols }, (_, i) =>
    Math.max(H[i].length, ...rows.map((r) => r[i].length), 1),
  );
  const alignedWidth = colW.reduce((a, b) => a + b, 0) + COLUMN_SEP.length * (nCols - 1);
  const maxCellChars = Math.max(0, ...rows.flat().map((c) => c.length));
  return { start, end: start + block.length, header: H, rows, aligns: A, nCols, alignedWidth, maxCellChars };
}

/**
 * Locate every standalone markdown table in `lines` (fence-aware, same
 * detection as the text renderer). Pure.
 */
export function findMarkdownTables(lines: readonly string[]): ParsedTable[] {
  const found: ParsedTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (CODE_FENCE_RE.test(lines[i])) {
      i++;
      while (i < lines.length && !CODE_FENCE_RE.test(lines[i])) i++;
      i++;
      continue;
    }
    if (TABLE_ROW_RE.test(lines[i]) && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      const start = i;
      const block: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      const parsed = parseTableBlock(block, start);
      if (parsed) found.push(parsed);
      continue;
    }
    i++;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Render every standalone markdown table in `content` for Discord per the
 * given config (defaults to the daemon-wide active config). Content already
 * inside a code fence passes through untouched. Idempotent.
 *
 * Name retained for the Phase 122 coverage sentinel and the ~13 chokepoint
 * call sites; the function now does adaptive rendering, not only fencing.
 */
export function wrapMarkdownTablesInCodeFence(
  content: string,
  cfg: TableRenderConfig = activeConfig,
): string {
  if (!content || content.length === 0) return content;
  if (cfg.mode === "off") return content;

  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Pass through anything already inside a code fence — never re-render.
    if (CODE_FENCE_RE.test(line)) {
      out.push(line);
      i++;
      while (i < lines.length && !CODE_FENCE_RE.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        out.push(lines[i]); // closing fence
        i++;
      }
      continue;
    }
    // Table start = header row + separator row.
    if (
      TABLE_ROW_RE.test(line) &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR_RE.test(lines[i + 1])
    ) {
      const block: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      out.push(renderTableBlock(block, cfg));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

/**
 * Phase 999.79 — universal outbound-text formatter. Strip AI-tell em dashes,
 * then render markdown tables for Discord. Strip BEFORE render so dashes in
 * table cells are cleaned before the cells are re-emitted as grid/cards.
 *
 * All ClawCode outbound-to-Discord chokepoints call this. Idempotent.
 */
export function formatOutboundText(content: string): string {
  return wrapMarkdownTablesInCodeFence(stripEmDashes(content));
}

/**
 * 2026-08-27 — split `text` into ≤`max` chunks WITHOUT letting the trailing
 * annotation block (contiguous `-# ` lines at the end: warnings + Sources)
 * straddle a boundary. It rides the last chunk, or becomes its own chunk if
 * it doesn't fit. Pure; delegates the body split to `splitLines`.
 */
export function splitKeepingAnnotations(
  text: string,
  max: number,
  splitBody: (body: string, max: number) => readonly string[],
): string[] {
  const lines = text.split("\n");
  let i = lines.length;
  while (i > 0 && (lines[i - 1].startsWith("-# ") || lines[i - 1].trim() === "")) i--;
  const block = lines.slice(i).join("\n").replace(/^\n+/, "");
  const body = lines.slice(0, i).join("\n").replace(/\s+$/, "");
  if (block.trim().length === 0 || !block.includes("-# ")) return [...splitBody(text, max)];
  const chunks = body.length > 0 ? [...splitBody(body, max)] : [];
  if (chunks.length === 0) return [block.slice(0, max)];
  const last = chunks[chunks.length - 1];
  const joined = `${last}\n\n${block}`;
  if (joined.length <= max) chunks[chunks.length - 1] = joined;
  else chunks.push(block.slice(0, max));
  return chunks;
}

/** `formatOutboundText` with an explicit config (planner / tests). */
export function formatOutboundTextWith(content: string, cfg: TableRenderConfig): string {
  return wrapMarkdownTablesInCodeFence(stripEmDashes(content), cfg);
}
