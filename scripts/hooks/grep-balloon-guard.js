#!/usr/bin/env node
/**
 * 999.108 — Grep balloon guard (PreToolUse hook, matcher: "Grep").
 *
 * Two production incidents (2026-08-14 state-contract 16.8GB, 2026-08-17
 * fin-nested 12GB) share one shape: a Grep pattern using a wide bounded
 * wildcard window (`.{0,80}…339K…{0,140}`) as poor-man's match context. ugrep
 * compiles these into an exploding matcher state over large trees and eats
 * GBs per minute until memwatch kills it — the search ALWAYS fails anyway.
 * This hook rejects only those pathological shapes BEFORE the spawn, with an
 * error that tells the model the working alternative (literal + -C), so the
 * search succeeds on the immediate retry instead of wrecking the fleet.
 *
 * FAIL-OPEN: any internal error, unparseable input, or missing pattern exits
 * 0 (allow). The ONLY blocking path is a confidently-matched balloon
 * signature (exit 2; stderr is fed back to the model).
 */

const BOUNDED_WINDOW_MAX = 25; // .{0,N} with N above this = balloon signature

function findBalloonSignature(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return null;
  if (pattern.length > 1000) {
    return "pattern is over 1000 chars (runaway generated pattern)";
  }
  // Wide bounded repetition of a broad atom: `.{n,m}`, `[^x]{n,m}`, `\S{n,m}`
  // with m ≥ BOUNDED_WINDOW_MAX or open-ended `{n,}` — the exact incident
  // shape. Braces may be BRE-escaped (`\{0,80\}` — ugrep -G mode, the form
  // both live incidents actually ran). Narrow literals with big bounds
  // (e.g. `a{0,100}`) don't balloon and are left alone.
  const broadAtom = /(\\[sSwWdD]|\.|\[[^\]]*\])\\?\{(\d+),(\d*)\\?\}/g;
  let m;
  while ((m = broadAtom.exec(pattern)) !== null) {
    const atom = m[1];
    // Open-ended {n,} is equivalent to +/* (allowed everywhere) — only the
    // FINITE wide window is the incident shape.
    if (m[3] === "") continue;
    const max = Number(m[3]);
    const isBroad =
      atom === "." || atom.startsWith("\\") || atom.startsWith("[^");
    if (isBroad && max >= BOUNDED_WINDOW_MAX) {
      return `wide wildcard window ${atom}{${m[2]},${m[3]}}`;
    }
  }
  // Nested quantifiers — classic catastrophic backtracking: (x+)+, (x*)*,
  // (x{1,9})+ and friends.
  if (/\([^()]*[+*}][^()]*\)[+*]/.test(pattern)) {
    return "nested quantifier (catastrophic backtracking shape)";
  }
  return null;
}

function main() {
  let raw = "";
  try {
    raw = require("fs").readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const pattern = input?.tool_input?.pattern;
  const reason = findBalloonSignature(pattern);
  if (reason === null) process.exit(0);
  process.stderr.write(
    `Grep pattern REJECTED by the memory-balloon guard (${reason}). ` +
      `Patterns like .{0,140} used as match context have twice ballooned ` +
      `ugrep past 12GB and been killed — the search never completes. ` +
      `Instead: search for the distinctive literal alone ` +
      `(e.g. pattern: "339K") and get surrounding context with -C 3 ` +
      `(context lines), or narrow the path/glob. The literal + -C form ` +
      `returns the same information without the balloon.`,
  );
  process.exit(2);
}

try {
  main();
} catch {
  process.exit(0); // fail-open, always
}
