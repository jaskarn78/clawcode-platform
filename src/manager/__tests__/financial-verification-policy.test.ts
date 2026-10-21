/**
 * Phase 999.63 Plan 04 T-01 — financial-verification per-agent policy
 * resolver tests.
 *
 * `isVerificationEnforced` decides whether the Phase 999.63
 * enforcement gate applies to an agent. CONTEXT.md D6:
 *   - default TRUE when the agent name prefix-matches `fin-`;
 *   - an explicit per-agent override (`true` OR `false`) wins in both
 *     directions.
 *
 * These are pure-function tests — no I/O, no mocks.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FINANCIAL_AGENT_PREFIXES,
  isVerificationEnforced,
} from "../financial-verification-policy.js";

describe("isVerificationEnforced — prefix-rule default", () => {
  it("fin-client, no override → true", () => {
    expect(isVerificationEnforced("fin-client")).toBe(true);
  });

  it("fin-research, no override → true", () => {
    expect(isVerificationEnforced("fin-research")).toBe(true);
  });

  it("fin-tax, no override → true", () => {
    expect(isVerificationEnforced("fin-tax")).toBe(true);
  });

  it("fin-playground, no override → true", () => {
    expect(isVerificationEnforced("fin-playground")).toBe(true);
  });

  it("a non-fin agent with a brand-style prefix, no override → false", () => {
    expect(isVerificationEnforced("acme-content-creator")).toBe(false);
  });

  it("admin-clawdy, no override → false", () => {
    expect(isVerificationEnforced("admin-clawdy")).toBe(false);
  });

  it("research, no override → false", () => {
    expect(isVerificationEnforced("research")).toBe(false);
  });
});

describe("isVerificationEnforced — explicit per-agent override", () => {
  it("fin-client, override false → false (explicit opt-out wins)", () => {
    expect(isVerificationEnforced("fin-client", false)).toBe(
      false,
    );
  });

  it("admin-clawdy, override true → true (explicit opt-in wins)", () => {
    expect(isVerificationEnforced("admin-clawdy", true)).toBe(true);
  });

  it("fin-research, override true → true (opt-in is a no-op on an already-enforced agent)", () => {
    expect(isVerificationEnforced("fin-research", true)).toBe(true);
  });

  it("research, override false → false (opt-out is a no-op on an already-unenforced agent)", () => {
    expect(isVerificationEnforced("research", false)).toBe(false);
  });

  it("override undefined behaves identically to no argument", () => {
    expect(isVerificationEnforced("fin-research", undefined)).toBe(
      true,
    );
    expect(isVerificationEnforced("admin-clawdy", undefined)).toBe(
      false,
    );
  });
});

describe("isVerificationEnforced — prefix discipline", () => {
  it("finance-bot → false (contains 'fin' but does NOT start with 'fin-')", () => {
    // The rule is a PREFIX match WITH the hyphen — not a bare substring.
    // `finance-bot` starts with `fin` but not `fin-`, so it must NOT
    // enforce. Pinned so a future edit cannot loosen the prefix to a
    // substring and silently gate the whole fleet.
    expect(isVerificationEnforced("finance-bot")).toBe(false);
  });

  it("fin (exact, no hyphen suffix) → false", () => {
    // `fin` alone does not start with `fin-`.
    expect(isVerificationEnforced("fin")).toBe(false);
  });

  it("fin (exact) → false — `fin` is not `fin-`", () => {
    expect(isVerificationEnforced("fin")).toBe(false);
  });

  it("empty string → false", () => {
    expect(isVerificationEnforced("")).toBe(false);
  });
});

describe("FINANCIAL_AGENT_PREFIXES — canonical pin", () => {
  it("contains exactly the one locked prefix", () => {
    expect([...FINANCIAL_AGENT_PREFIXES]).toEqual(["fin-"]);
  });

  it("is frozen — runtime mutation is rejected", () => {
    expect(Object.isFrozen(FINANCIAL_AGENT_PREFIXES)).toBe(true);
  });

  it("CANONICAL PIN — source file contains the literal prefix strings", () => {
    // Static-grep regression: a future edit cannot silently drop or
    // rename the `fin-` prefix without breaking this.
    const src = readFileSync(
      fileURLToPath(
        new URL("../financial-verification-policy.ts", import.meta.url),
      ),
      "utf-8",
    );
    expect(src).toContain('"fin-"');
  });
});
