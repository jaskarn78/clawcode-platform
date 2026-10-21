/**
 * WS-2 Layer B (sandbox-hardening-2026-06-19) — the pure crash classifier that
 * the daemon's global `uncaughtException` handler consults so a managed child's
 * async EPIPE never exits the whole fleet (the 2026-06-19 prod-down).
 *
 * Tested in ISOLATION from Layer A (the spawn-seam stdio guard) so a green here
 * proves the global net independently — a passing behavioral test must not be
 * silently carried by the other layer.
 */
import { describe, it, expect } from "vitest";
import { isNonFatalPipeError, NON_FATAL_PIPE_ERROR_CODES } from "../crash-policy.js";

describe("isNonFatalPipeError — global uncaughtException leniency", () => {
  it("classifies EPIPE as non-fatal (the incident code)", () => {
    expect(isNonFatalPipeError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    // plain coded object (not necessarily an Error instance)
    expect(isNonFatalPipeError({ code: "EPIPE" })).toBe(true);
  });

  it("keeps every other error code FATAL (no broad weakening of the backstop)", () => {
    expect(isNonFatalPipeError(Object.assign(new Error("spawn bwrap"), { code: "ENOENT" }))).toBe(false);
    expect(isNonFatalPipeError(Object.assign(new Error("oom"), { code: "ERR_OUT_OF_MEMORY" }))).toBe(false);
    expect(isNonFatalPipeError(new Error("plain error, no code"))).toBe(false);
  });

  it("treats ECONNRESET as FATAL at the global level (deliberate scoping — not in the evidence set yet)", () => {
    // The spawn-seam guard (Layer A) swallows ECONNRESET on a child stream; this
    // assertion pins that we did NOT additionally widen the global crash policy
    // past the proven EPIPE evidence. Flip this (and the code list) only if a
    // real ECONNRESET crash is observed from a non-seam spawn path.
    expect(isNonFatalPipeError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(false);
  });

  it("defaults to FATAL for non-object / malformed inputs (fail-safe)", () => {
    expect(isNonFatalPipeError(null)).toBe(false);
    expect(isNonFatalPipeError(undefined)).toBe(false);
    expect(isNonFatalPipeError("EPIPE")).toBe(false); // a bare string is not a coded error
    expect(isNonFatalPipeError(42)).toBe(false);
    expect(isNonFatalPipeError({ code: 123 })).toBe(false); // non-string code
    expect(isNonFatalPipeError({})).toBe(false);
  });

  it("the non-fatal code set is EXACTLY [EPIPE] (matches the incident evidence)", () => {
    expect([...NON_FATAL_PIPE_ERROR_CODES]).toEqual(["EPIPE"]);
  });
});
