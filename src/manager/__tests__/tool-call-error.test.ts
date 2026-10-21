/**
 * Phase 94 Plan 04 Task 1 — TDD RED for the honest ToolCallError schema.
 *
 * These tests pin D-06: when a tool that PASSED the capability probe still
 * fails mid-turn (transient/auth/quota/permission), the executor wraps the
 * failure into a structured discriminated-shape object the LLM receives in
 * the tool-result slot.
 *
 * 5-value ErrorClass enum LOCKED at: transient | auth | quota | permission | unknown.
 * Adding a 6th value cascades through Plans 94-05 (renderer) + 94-07 (display)
 * and requires an explicit STATE.md decision.
 *
 * Verbatim-message pass-through (Phase 85 TOOL-04 inheritance): the wrapper
 * NEVER rewrites or truncates the source error text. Operators inspect the
 * raw failure mode through the same channel the LLM does.
 */

import { describe, it, expect } from "vitest";
import {
  classifyToolError,
  wrapMcpToolError,
  type ErrorClass,
  type ToolCallError,
} from "../tool-call-error.js";

describe("classifyToolError — D-06 5-value enum (TCE-CLASS-*)", () => {
  it("TCE-CLASS-1 transient: network/socket/ECONNRESET/ETIMEDOUT/EAI_AGAIN/timeout", () => {
    const cases: ReadonlyArray<readonly [string | Error, ErrorClass]> = [
      ["ECONNRESET while connecting to upstream", "transient"],
      [new Error("socket hang up"), "transient"],
      ["ETIMEDOUT", "transient"],
      ["ECONNREFUSED at 127.0.0.1:9000", "transient"],
      ["EAI_AGAIN dns failure", "transient"],
      [new Error("network unreachable"), "transient"],
      [new Error("request timeout after 30s"), "transient"],
    ];
    for (const [input, expected] of cases) {
      expect(classifyToolError(input)).toBe(expected);
    }
  });

  it("TCE-CLASS-2 auth: 401 / unauthorized / invalid_key / authentication / expired", () => {
    const cases: ReadonlyArray<readonly [string | Error, ErrorClass]> = [
      ["HTTP 401 unauthorized", "auth"],
      [new Error("invalid_key"), "auth"],
      [new Error("invalid key"), "auth"],
      ["authentication expired", "auth"],
      [new Error("token expired — refresh required"), "auth"],
      ["unauthorized: missing bearer", "auth"],
    ];
    for (const [input, expected] of cases) {
      expect(classifyToolError(input)).toBe(expected);
    }
  });

  it("TCE-CLASS-3 quota: 429 / rate limit / quota exceeded / too many requests", () => {
    const cases: ReadonlyArray<readonly [string | Error, ErrorClass]> = [
      ["HTTP 429 rate limit exceeded", "quota"],
      [new Error("quota exceeded"), "quota"],
      ["rate_limit hit", "quota"],
      [new Error("too many requests"), "quota"],
      ["429 Too Many Requests", "quota"],
    ];
    for (const [input, expected] of cases) {
      expect(classifyToolError(input)).toBe(expected);
    }
  });

  it("TCE-CLASS-4 permission: 403 / forbidden / permission denied / insufficient", () => {
    const cases: ReadonlyArray<readonly [string | Error, ErrorClass]> = [
      ["HTTP 403 forbidden", "permission"],
      [new Error("permission denied"), "permission"],
      [new Error("forbidden"), "permission"],
      ["insufficient privileges", "permission"],
      ["403 access denied — forbidden namespace", "permission"],
    ];
    for (const [input, expected] of cases) {
      expect(classifyToolError(input)).toBe(expected);
    }
  });

  it("TCE-CLASS-5 unknown: anything that doesn't match the four classes", () => {
    const cases: ReadonlyArray<readonly [string | Error, ErrorClass]> = [
      ["totally weird thing happened", "unknown"],
      ["", "unknown"],
      [new Error("xyz"), "unknown"],
      [new Error("Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome"), "unknown"],
    ];
    for (const [input, expected] of cases) {
      expect(classifyToolError(input)).toBe(expected);
    }
  });

  it("Order matters: auth/quota/permission take priority over transient when both regexes would match", () => {
    // "401 timeout" — auth indicator (401) AND transient indicator (timeout).
    // Spec: auth/quota/permission checked BEFORE transient → auth wins.
    expect(classifyToolError("HTTP 401 timeout — token refresh hang")).toBe("auth");
    // "429 ECONNRESET" — quota wins.
    expect(classifyToolError("HTTP 429 ECONNRESET")).toBe("quota");
    // "403 socket hang up" — permission wins.
    expect(classifyToolError("HTTP 403 socket hang up")).toBe("permission");
  });

  it("Empty / null-ish inputs default to unknown without throwing", () => {
    expect(classifyToolError("")).toBe("unknown");
    expect(classifyToolError(new Error(""))).toBe("unknown");
    // Object with no message field.
    const errLike = new Error();
    expect(classifyToolError(errLike)).toBe("unknown");
  });
});

describe("wrapMcpToolError — D-06 ToolCallError shape", () => {
  it("TCE-VERBATIM: preserves the verbatim Playwright error message (Phase 85 TOOL-04)", () => {
    // Sentinel from D-CONTEXT specifics — exact production-observed string.
    const playwrightErr = new Error(
      "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
    );
    const wrapped = wrapMcpToolError(playwrightErr, { tool: "browser_snapshot" });
    expect(wrapped.message).toContain(
      "Executable doesn't exist at /home/clawcode/.cache/ms-playwright",
    );
    // No truncation: the full path survives.
    expect(wrapped.message).toContain("chromium-1187/chrome-linux/chrome");
    // No rewriting: exact substring preserved verbatim.
    expect(wrapped.message).toBe(playwrightErr.message);
  });

  it("TCE-VERBATIM (multi-line): preserves newlines + full body, no truncation under 5000 chars", () => {
    const longErr = new Error(
      "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome\n" +
        "Looks like Playwright Test or Playwright was just installed or updated.\n" +
        "Please run the following command to download new browsers:\n\n" +
        "npx playwright install",
    );
    const wrapped = wrapMcpToolError(longErr, { tool: "browser_snapshot" });
    expect(wrapped.message).toBe(longErr.message);
    expect(wrapped.message.split("\n").length).toBeGreaterThanOrEqual(4);
  });

  it("TCE-NO-LEAK: wrapper does NOT augment the message with env/secrets — passes through verbatim", () => {
    const e = new Error("auth failed for SECRET_42");
    const wrapped = wrapMcpToolError(e, { tool: "vault_get" });
    expect(wrapped.message).toBe("auth failed for SECRET_42");
  });

  it("TCE-DISCRIMINATOR: kind === 'ToolCallError' (locked discriminator literal)", () => {
    const wrapped = wrapMcpToolError(new Error("test"), { tool: "x" });
    expect(wrapped.kind).toBe("ToolCallError");
  });

  it("TCE-CLASSIFY: errorClass matches classifyToolError output for the same input", () => {
    expect(wrapMcpToolError(new Error("ECONNRESET"), { tool: "x" }).errorClass).toBe("transient");
    expect(wrapMcpToolError(new Error("HTTP 401"), { tool: "x" }).errorClass).toBe("auth");
    expect(wrapMcpToolError(new Error("HTTP 429"), { tool: "x" }).errorClass).toBe("quota");
    expect(wrapMcpToolError(new Error("HTTP 403"), { tool: "x" }).errorClass).toBe("permission");
    expect(wrapMcpToolError(new Error("???"), { tool: "x" }).errorClass).toBe("unknown");
  });

  it("TCE-JSON: round-trips through JSON.parse(JSON.stringify(.)) deep-equal", () => {
    const wrapped = wrapMcpToolError(new Error("HTTP 401 unauthorized"), {
      tool: "vault_get",
      findAlternatives: () => ["fin-client", "general"],
      suggestionFor: (cls) => (cls === "auth" ? "rotate the op:// reference" : undefined),
    });
    const roundTripped = JSON.parse(JSON.stringify(wrapped)) as ToolCallError;
    expect(roundTripped.kind).toBe(wrapped.kind);
    expect(roundTripped.tool).toBe(wrapped.tool);
    expect(roundTripped.errorClass).toBe(wrapped.errorClass);
    expect(roundTripped.message).toBe(wrapped.message);
    expect(roundTripped.suggestion).toBe(wrapped.suggestion);
    expect(roundTripped.alternatives).toEqual(wrapped.alternatives);
    // Strict equality on the whole object.
    expect(roundTripped).toEqual(wrapped);
  });

  it("TCE-ALT: populates alternatives from injected findAlternatives", () => {
    const wrapped = wrapMcpToolError(new Error("err"), {
      tool: "browser_snapshot",
      findAlternatives: () => ["fin-client", "general"],
    });
    expect(wrapped.alternatives).toEqual(["fin-client", "general"]);
  });

  it("TCE-ALT-empty: empty alternatives array yields undefined alternatives field (cleaner JSON)", () => {
    const wrapped = wrapMcpToolError(new Error("err"), {
      tool: "x",
      findAlternatives: () => [],
    });
    expect(wrapped.alternatives).toBeUndefined();
  });

  it("TCE-ALT-absent: no findAlternatives callback → alternatives === undefined", () => {
    const wrapped = wrapMcpToolError(new Error("err"), { tool: "x" });
    expect(wrapped.alternatives).toBeUndefined();
  });

  it("TCE-SUGGESTION: populates suggestion when suggestionFor returns a string", () => {
    const wrapped = wrapMcpToolError(new Error("HTTP 401"), {
      tool: "vault_get",
      suggestionFor: (cls) => (cls === "auth" ? "rotate op:// reference" : undefined),
    });
    expect(wrapped.suggestion).toBe("rotate op:// reference");
  });

  it("TCE-SUGGESTION-absent: no suggestionFor → suggestion === undefined", () => {
    const wrapped = wrapMcpToolError(new Error("err"), { tool: "x" });
    expect(wrapped.suggestion).toBeUndefined();
  });

  it("TCE-IMMUTABLE: returned object is frozen (CLAUDE.md immutability rule)", () => {
    const wrapped = wrapMcpToolError(new Error("err"), {
      tool: "x",
      findAlternatives: () => ["a"],
    });
    expect(Object.isFrozen(wrapped)).toBe(true);
    // Alternatives array also frozen so consumers can't mutate the cross-ref list.
    expect(Object.isFrozen(wrapped.alternatives)).toBe(true);
  });

  it("TCE-STRING-ERR: string input (not Error instance) preserved verbatim", () => {
    const wrapped = wrapMcpToolError("plain string error text", { tool: "x" });
    expect(wrapped.message).toBe("plain string error text");
  });

  it("TCE-TOOL: tool field carried through verbatim", () => {
    const wrapped = wrapMcpToolError(new Error("err"), { tool: "browser_snapshot" });
    expect(wrapped.tool).toBe("browser_snapshot");
  });
});
