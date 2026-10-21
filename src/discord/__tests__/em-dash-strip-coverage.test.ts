/**
 * Phase 999.79 (2026-05-23) — em-dash strip coverage sentinel.
 *
 * Static-grep sentinel paired with the Phase 122 universal-wrap-coverage
 * sentinel (122-universal-wrap-coverage.test.ts):
 *   - Phase 122 UWC pins that EVERY outbound chokepoint calls
 *     `formatOutboundText` (the universal helper).
 *   - This file pins that `formatOutboundText` ACTUALLY strips em
 *     dashes (composition guarantee), and that no chokepoint file
 *     bypasses the universal helper by calling
 *     `wrapMarkdownTablesInCodeFence` directly.
 *
 * Without these two paired sentinels, a future refactor could:
 *   - Pass UWC by adding a new outbound chokepoint that calls
 *     `formatOutboundText` — but quietly remove the `stripEmDashes`
 *     call from inside `formatOutboundText` (em dashes leak again).
 *   - Pass UWC at all existing chokepoints but introduce a NEW
 *     chokepoint that uses the raw wrap (em dashes leak from that
 *     one site).
 *
 * Structural-only test — no behavioral assertions. The behavioral
 * coverage lives in text-sanitization.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

// Files where `formatOutboundText` is the ONLY allowed entry point —
// direct calls to `wrapMarkdownTablesInCodeFence(` would bypass the
// em-dash strip. The wrap helper is still EXPORTED from
// `markdown-table-wrap.ts` (composed inside `formatOutboundText`)
// but no other file should call it directly.
const CHOKEPOINT_FILES: readonly string[] = [
  "src/discord/bridge.ts",
  "src/discord/subagent-thread-spawner.ts",
  "src/discord/webhook-manager.ts",
  "src/discord/slash-commands.ts",
  "src/manager/daemon.ts",
];

describe("Phase 999.79 — em-dash strip coverage sentinel", () => {
  it("EDS-1: `formatOutboundText` definition imports and calls `stripEmDashes`", () => {
    const src = readSource("src/discord/markdown-table-wrap.ts");
    // Import line: stripEmDashes from the sanitization module.
    expect(src).toMatch(
      /import\s*\{\s*stripEmDashes\s*\}\s*from\s*["']\.\/text-sanitization\.js["']/,
    );
    // The composed helper must reference stripEmDashes by name in its
    // body (otherwise it's not actually stripping).
    expect(src).toMatch(/export function formatOutboundText/);
    // Locate the formatOutboundText body and verify stripEmDashes is
    // called inside it. Naive: find the function header line, scan
    // forward up to 10 lines, assert stripEmDashes appears.
    const lines = src.split("\n");
    const headerIdx = lines.findIndex((l) =>
      l.includes("export function formatOutboundText"),
    );
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    const bodyWindow = lines.slice(headerIdx, headerIdx + 10).join("\n");
    expect(bodyWindow).toContain("stripEmDashes");
    expect(bodyWindow).toContain("wrapMarkdownTablesInCodeFence");
  });

  it("EDS-2: `stripEmDashes` is called BEFORE `wrapMarkdownTablesInCodeFence` (strip-then-wrap order)", () => {
    const src = readSource("src/discord/markdown-table-wrap.ts");
    // Find the formatOutboundText body region and assert the order
    // of the two function references inside it. The composition is
    // `wrap(strip(content))` — so `stripEmDashes(` must appear as an
    // ARGUMENT to `wrapMarkdownTablesInCodeFence(`, i.e., the strip
    // call must occur before (or nested inside) the wrap call. The
    // regex looks for: `wrapMarkdownTablesInCodeFence(stripEmDashes(`
    // or `wrapMarkdownTablesInCodeFence(\s*stripEmDashes(`.
    expect(src).toMatch(
      /wrapMarkdownTablesInCodeFence\s*\(\s*stripEmDashes\s*\(/,
    );
    // Negative: wrap-then-strip would look like
    // `stripEmDashes(wrapMarkdownTablesInCodeFence(...))` — this
    // MUST NOT appear (it'd let the wrap protect table-cell em
    // dashes from the strip; see text-sanitization.test.ts Test 8).
    expect(src).not.toMatch(
      /stripEmDashes\s*\(\s*wrapMarkdownTablesInCodeFence\s*\(/,
    );
  });

  it.each(CHOKEPOINT_FILES)(
    "EDS-3: chokepoint file %s does NOT call wrapMarkdownTablesInCodeFence directly (must go through formatOutboundText)",
    (file) => {
      const src = readSource(file);
      // The chokepoint files import only `formatOutboundText` from
      // markdown-table-wrap.js (verified by the import-line shape).
      // They MUST NOT have any direct `wrapMarkdownTablesInCodeFence(`
      // CALL — that would bypass the em-dash strip.
      //
      // Caveat: comments and JSDoc may legitimately mention the name
      // (e.g., "we used to call wrapMarkdownTablesInCodeFence here").
      // We strip line/block comments before the assertion, mirroring
      // the SG1-SG6 static-grep convention in
      // bridge/__tests__/static-grep-anthropic-interceptor-single-source.test.ts.
      const noComments = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      // Look for the actual function CALL pattern (name followed by
      // `(`), not just a bare name mention.
      expect(noComments).not.toMatch(/wrapMarkdownTablesInCodeFence\s*\(/);
    },
  );

  it("EDS-4: chokepoint files import `formatOutboundText` from the markdown-table-wrap module", () => {
    for (const file of CHOKEPOINT_FILES) {
      const src = readSource(file);
      expect(src).toMatch(
        /import\s*\{\s*formatOutboundText\s*\}\s*from\s*["'][^"']*markdown-table-wrap\.js["']/,
      );
    }
  });

  // 2026-05-23 follow-up: share-file caption bypass regression pin.
  //
  // The `botUpload` closure inside the `case "share-file"` IPC handler
  // in daemon.ts has its own `channel.send({ content, files })` site
  // that the original 88f600b7 universal-wrap audit missed because it
  // lives inside an IPC handler rather than at a named bridge
  // chokepoint. The caption was passed through verbatim, leaking em
  // dashes on every `clawcode_share_file` call with a caption. This
  // sentinel ensures that future refactors of the share-file handler
  // can't silently re-introduce the bypass.
  it("EDS-5: share-file `botUpload` caption is wrapped through `formatOutboundText` before sending", () => {
    const src = readSource("src/manager/daemon.ts");
    const lines = src.split("\n");
    // Locate the `const botUpload = async` line — the share-file
    // handler's inline closure. There may be other `botUpload` mentions
    // elsewhere; the closure form is unique.
    const headerIdx = lines.findIndex((l) =>
      /const\s+botUpload\s*=\s*async/.test(l),
    );
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    // Scan the next ~50 lines for the caption assignment and assert it
    // routes through formatOutboundText. The assignment shape we want
    // is `sendOpts.content = formatOutboundText(file.caption)` or
    // similar; we accept any line that mentions both `caption` and
    // `formatOutboundText` within the closure body.
    const bodyWindow = lines.slice(headerIdx, headerIdx + 50).join("\n");
    // Negative: raw assignment without the wrap MUST NOT appear.
    expect(bodyWindow).not.toMatch(
      /sendOpts\.content\s*=\s*file\.caption\s*[;\n]/,
    );
    // Positive: the wrapped form is present.
    expect(bodyWindow).toMatch(
      /sendOpts\.content\s*=\s*formatOutboundText\s*\(\s*file\.caption\s*\)/,
    );
  });
});
