/**
 * 999.178 R1 — migration guard. Every bot-emitted reaction on a turn surface
 * resolves through the `cc_*` icon registry (`icons.reaction(...)`), never a
 * Unicode emoji literal. A regression that reintroduces `message.react("🧭")`
 * — degrading back to a Unicode glyph — fails here. User-INTERACTIVE reactions
 * (a human is asked to click) are NOT `.react()` calls the bot makes; they
 * live in map keys and prompt text and are deliberately out of scope until
 * they become buttons.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("bot reactions never use a Unicode emoji literal", () => {
  it("bridge.ts has no `.react(\"<emoji>\")` string literal", () => {
    const src = readFileSync(join(__dirname, "..", "bridge.ts"), "utf8");
    // Matches `.react(` (not `.reaction(`, not `addReaction(`) immediately
    // followed by a string literal; captures the literal's contents.
    const reactLiteral = /\.react\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gu;
    const pictographic = /\p{Extended_Pictographic}/u;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = reactLiteral.exec(src)) !== null) {
      if (pictographic.test(m[2]!)) offenders.push(m[0]);
    }
    expect(offenders).toEqual([]);
  });
});
