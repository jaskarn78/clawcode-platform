import { describe, it, expect } from "vitest";
import { toSlackMrkdwn } from "./mrkdwn.js";

describe("toSlackMrkdwn", () => {
  it("leaves plain text and empty input unchanged", () => {
    expect(toSlackMrkdwn("")).toBe("");
    expect(toSlackMrkdwn("hello world")).toBe("hello world");
  });

  it("converts bold **x** → *x*", () => {
    expect(toSlackMrkdwn("a **bold** b")).toBe("a *bold* b");
  });

  it("converts asterisk italic *x* → _x_ and leaves _x_ italic intact", () => {
    expect(toSlackMrkdwn("a *em* b")).toBe("a _em_ b");
    expect(toSlackMrkdwn("a _em_ b")).toBe("a _em_ b");
  });

  it("degrades underline __x__ → italic _x_", () => {
    expect(toSlackMrkdwn("a __under__ b")).toBe("a _under_ b");
  });

  it("converts bold+italic ***x*** → *_x_*", () => {
    expect(toSlackMrkdwn("a ***bi*** b")).toBe("a *_bi_* b");
  });

  it("converts strikethrough ~~x~~ → ~x~", () => {
    expect(toSlackMrkdwn("a ~~gone~~ b")).toBe("a ~gone~ b");
  });

  it("converts links [label](url) → <url|label>", () => {
    expect(toSlackMrkdwn("see [docs](https://example.com/x) now")).toBe(
      "see <https://example.com/x|docs> now",
    );
  });

  it("converts ATX headings to bold (Slack has no headings)", () => {
    expect(toSlackMrkdwn("# Title")).toBe("*Title*");
    expect(toSlackMrkdwn("### Sub section")).toBe("*Sub section*");
    expect(toSlackMrkdwn("intro\n## Heading\nbody")).toBe("intro\n*Heading*\nbody");
  });

  it("handles several constructs in one string", () => {
    expect(toSlackMrkdwn("**bold** and *italic* and [t](http://u)")).toBe(
      "*bold* and _italic_ and <http://u|t>",
    );
  });

  // --- code is sacred ---

  it("never transforms inside an inline code span", () => {
    expect(toSlackMrkdwn("use `**not bold**` here")).toBe("use `**not bold**` here");
  });

  it("never transforms inside a fenced code block", () => {
    const input = "before\n```js\nconst x = **keep**; // [a](b)\n```\nafter **go**";
    expect(toSlackMrkdwn(input)).toBe(
      "before\n```js\nconst x = **keep**; // [a](b)\n```\nafter *go*",
    );
  });

  it("transforms prose around code but not the code itself", () => {
    expect(toSlackMrkdwn("**a** `**b**` *c*")).toBe("*a* `**b**` _c_");
  });

  // --- streaming safety: unterminated fence is code-to-end ---

  it("treats an unterminated trailing fence as code (no mangling mid-stream)", () => {
    const partial = "intro **done**\n```js\nconst y = **stay**";
    expect(toSlackMrkdwn(partial)).toBe("intro *done*\n```js\nconst y = **stay**");
  });

  it("treats a stray inline backtick as literal and keeps transforming after it", () => {
    expect(toSlackMrkdwn("a ` b **c**")).toBe("a ` b *c*");
  });

  // --- idempotency guard: this is a single-pass canonical→slack transform ---

  it("is NOT idempotent (documents why callers must translate canonical text once)", () => {
    const once = toSlackMrkdwn("**x**"); // → *x*
    expect(once).toBe("*x*");
    const twice = toSlackMrkdwn(once); // *x* is now read as italic → _x_
    expect(twice).toBe("_x_");
  });

  it("strips a stray NUL so it can't collide with the bold sentinel", () => {
    expect(toSlackMrkdwn(`a${String.fromCharCode(0)}b **c**`)).toBe("ab *c*");
  });
});
