import { describe, expect, it } from "vitest";
import {
  isSubagentOrThreadSession,
  isSubagentThreadName,
  parentAgentName,
} from "../subagent-name.js";

describe("isSubagentThreadName", () => {
  describe("positive matches (auto-spawned)", () => {
    it("matches delegated pattern: <parent>-via-<delegate>-<nanoid6>", () => {
      expect(
        isSubagentThreadName("fin-client-via-fin-research-57r__G"),
      ).toBe(true);
    });

    it("matches delegated pattern with multi-segment delegate", () => {
      expect(
        isSubagentThreadName(
          "fin-client-via-acme-content-creator-4XZKL0",
        ),
      ).toBe(true);
    });

    it("matches direct sub pattern: <parent>-sub-<nanoid6>", () => {
      expect(isSubagentThreadName("fin-client-sub-AbC123")).toBe(true);
    });

    it("matches when nanoid suffix uses underscores and dashes", () => {
      expect(isSubagentThreadName("research-via-general-_-aBc1")).toBe(true);
      expect(isSubagentThreadName("research-via-general-A_b-Cd")).toBe(true);
    });

    it("matches the literal screenshot examples", () => {
      // The two threads from admin-clawdy that motivated this phase.
      expect(
        isSubagentThreadName("fin-client-via-fin-research-57r__G"),
      ).toBe(true);
      expect(
        isSubagentThreadName("fin-client-via-fin-research-4XZKL0"),
      ).toBe(true);
    });
  });

  describe("negative matches (operator-defined names)", () => {
    it("does NOT match a plain operator agent name", () => {
      expect(isSubagentThreadName("fin-client")).toBe(false);
      expect(isSubagentThreadName("personal")).toBe(false);
      expect(isSubagentThreadName("research")).toBe(false);
    });

    it("does NOT match an operator name even if it contains -via-", () => {
      // Operator could legally name an agent "general-via-billing"; only the
      // 6-char nanoid suffix triggers the match.
      expect(isSubagentThreadName("general-via-billing")).toBe(false);
    });

    it("does NOT match when suffix is shorter than 6 chars", () => {
      expect(isSubagentThreadName("foo-via-bar-abc")).toBe(false);
      expect(isSubagentThreadName("foo-sub-abcde")).toBe(false);
    });

    it("does NOT match when suffix is longer than 6 chars (length-pinned)", () => {
      expect(isSubagentThreadName("foo-via-bar-abcdefg")).toBe(false);
      expect(isSubagentThreadName("foo-sub-abcdefg")).toBe(false);
    });

    it("does NOT match an empty or trivial string", () => {
      expect(isSubagentThreadName("")).toBe(false);
      expect(isSubagentThreadName("a")).toBe(false);
      expect(isSubagentThreadName("via-bar-abcdef")).toBe(false); // no parent
    });

    it("does NOT match Admin Clawdy or other names with spaces", () => {
      expect(isSubagentThreadName("Admin Clawdy")).toBe(false);
    });

    it("does NOT match -via- suffix without a delegate segment", () => {
      // "foo-via-abcdef" — the regex requires `via-<delegate>-<6chars>`
      // (delegate is non-empty), so `via-` directly followed by the suffix
      // fails.
      expect(isSubagentThreadName("foo-via-abcdef")).toBe(false);
    });

    it("does NOT match suffix with disallowed characters", () => {
      // nanoid uses [A-Za-z0-9_-] only; a "." or "@" must not match.
      expect(isSubagentThreadName("foo-via-bar-ab.def")).toBe(false);
      expect(isSubagentThreadName("foo-sub-ab@def")).toBe(false);
    });
  });
});

describe("isSubagentOrThreadSession", () => {
  // Phase 999.19 D3 — the LOOSE "exclude from top-level fleet" predicate.
  // Intentionally substring-based (`-sub-` / `-via-` / `-thread-`), NOT
  // nanoid6-anchored: it is the drop-in for the prior `.includes("-sub-") ||
  // .includes("-thread-")` filter pairs and must preserve that exact
  // semantics while additionally catching the `-via-` delegated pattern.

  describe("positive matches", () => {
    it("matches a -sub- direct subagent session name", () => {
      expect(isSubagentOrThreadSession("admin-clawdy-sub-aB3xZ_")).toBe(true);
    });

    it("matches a -via- delegated session name", () => {
      expect(
        isSubagentOrThreadSession("admin-clawdy-via-research-aB3xZ_"),
      ).toBe(true);
    });

    it("matches a -thread- session name", () => {
      expect(isSubagentOrThreadSession("personal-thread-aB3xZ_")).toBe(true);
    });

    it("matches even without a trailing nanoid6 (loose, unanchored)", () => {
      // The loose predicate mirrors the old `.includes` checks — it does
      // NOT require the 6-char nanoid suffix.
      expect(isSubagentOrThreadSession("foo-sub-abc")).toBe(true);
      expect(isSubagentOrThreadSession("foo-via-bar-x")).toBe(true);
    });
  });

  describe("negative matches (operator-defined names)", () => {
    it("does NOT match plain operator agent names", () => {
      expect(isSubagentOrThreadSession("fin-client")).toBe(false);
      expect(isSubagentOrThreadSession("research")).toBe(false);
      expect(isSubagentOrThreadSession("personal")).toBe(false);
    });

    it("does NOT match operator names that merely contain 'subaru'/'viable'", () => {
      // The hyphen delimiters in `-sub-` / `-via-` guard against false hits
      // on substrings of ordinary words.
      expect(isSubagentOrThreadSession("subaru-club")).toBe(false);
      expect(isSubagentOrThreadSession("viable-product")).toBe(false);
    });

    it("does NOT match an empty string", () => {
      expect(isSubagentOrThreadSession("")).toBe(false);
    });
  });

  describe("relationship to the strict predicate", () => {
    it("a -thread- name is LOOSE-true but STRICT-false", () => {
      // isSubagentThreadName's regex covers only -sub-/-via-; -thread-
      // names are excluded from the top-level fleet (loose) yet are not
      // strict subagent-thread names.
      const threadName = "personal-thread-aB3xZ_";
      expect(isSubagentOrThreadSession(threadName)).toBe(true);
      expect(isSubagentThreadName(threadName)).toBe(false);
    });

    it("operator names are false under both predicates", () => {
      for (const name of ["fin-client", "research", "subaru-club"]) {
        expect(isSubagentOrThreadSession(name)).toBe(false);
        expect(isSubagentThreadName(name)).toBe(false);
      }
    });
  });
});

describe("parentAgentName", () => {
  it("strips -sub-<nanoid6> to recover the parent", () => {
    expect(parentAgentName("fin-client-sub-AbC123")).toBe(
      "fin-client",
    );
    expect(parentAgentName("personal-sub-Wo2nHX")).toBe("personal");
  });

  it("strips -via-<delegate>-<nanoid6> to recover the parent", () => {
    expect(parentAgentName("fin-client-via-fin-research-57r__G")).toBe(
      "fin-client",
    );
  });

  it("strips multi-segment delegate suffix back to the root parent", () => {
    // The greedy `.+` in the delegate portion + non-greedy parent capture
    // must still land at the first valid -via- boundary.
    expect(
      parentAgentName("fin-client-via-acme-content-creator-4XZKL0"),
    ).toBe("fin-client");
  });

  it("preserves parent names containing spaces", () => {
    expect(parentAgentName("Admin Clawdy-sub-Wo2nHX")).toBe("Admin Clawdy");
    expect(parentAgentName("Admin Clawdy-via-research-2K7cf3")).toBe(
      "Admin Clawdy",
    );
  });

  it("returns operator-defined names unchanged", () => {
    expect(parentAgentName("fin-client")).toBe("fin-client");
    expect(parentAgentName("Admin Clawdy")).toBe("Admin Clawdy");
    expect(parentAgentName("personal")).toBe("personal");
  });

  it("returns operator names containing -via- unchanged (suffix not nanoid)", () => {
    // An operator could legally name an agent "general-via-billing"; the
    // trailing nanoid6 is what makes it a subagent.
    expect(parentAgentName("general-via-billing")).toBe("general-via-billing");
  });

  it("returns unchanged when suffix is wrong length", () => {
    expect(parentAgentName("foo-sub-abcde")).toBe("foo-sub-abcde");
    expect(parentAgentName("foo-sub-abcdefg")).toBe("foo-sub-abcdefg");
  });

  it("handles edge inputs gracefully", () => {
    expect(parentAgentName("")).toBe("");
    expect(parentAgentName("a")).toBe("a");
  });
});
