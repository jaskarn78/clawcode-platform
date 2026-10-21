/**
 * Phase 115 sub-scope 13(a) — `prompt-bloat-suspected` classifier tests.
 *
 * Pure-function tests. Verifies:
 *   - Trigger conditions: invalid_request_error AND prefix > threshold
 *   - Suppression: rate-limit error (different code) does NOT trigger
 *   - Suppression: invalid_request with small prefix does NOT trigger
 *   - Counter increment fires when traceSink is provided
 *   - Counter increment is BEST-EFFORT (sink throw never breaks the warn log)
 */

import { describe, it, expect, vi } from "vitest";
import {
  classifyPromptBloat,
  PROMPT_BLOAT_THRESHOLD,
  type PromptBloatLogger,
  type PromptBloatTraceSink,
} from "../session-adapter.js";

function makeLogger(): {
  log: PromptBloatLogger;
  warns: Array<{ obj: Record<string, unknown>; msg?: string }>;
} {
  const warns: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
  const log: PromptBloatLogger = {
    warn(obj, msg) {
      warns.push({ obj, msg });
    },
  };
  return { log, warns };
}

describe("classifyPromptBloat", () => {
  it("fires when error contains invalid_request_error AND prefix > threshold", () => {
    const { log, warns } = makeLogger();
    const error = new Error(
      "got 400 invalid_request_error: prompt is too long",
    );
    const fired = classifyPromptBloat(
      error,
      PROMPT_BLOAT_THRESHOLD + 5_000,
      "fin-client",
      log,
    );
    expect(fired).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0].obj).toMatchObject({
      agent: "fin-client",
      promptChars: PROMPT_BLOAT_THRESHOLD + 5_000,
      threshold: PROMPT_BLOAT_THRESHOLD,
      action: "prompt-bloat-suspected",
    });
    expect(warns[0].msg).toBe("[diag] likely-prompt-bloat");
  });

  it("fires on bare '400' message (no invalid_request_error literal)", () => {
    const { log, warns } = makeLogger();
    const error = new Error("status: 400 — request rejected");
    const fired = classifyPromptBloat(
      error,
      PROMPT_BLOAT_THRESHOLD + 1,
      "agent-A",
      log,
    );
    expect(fired).toBe(true);
    expect(warns).toHaveLength(1);
  });

  it("does NOT fire when error contains rate_limit (different code) even with large prefix", () => {
    const { log, warns } = makeLogger();
    const error = new Error("rate_limit_error: too many requests");
    const fired = classifyPromptBloat(
      error,
      PROMPT_BLOAT_THRESHOLD + 50_000,
      "fin-client",
      log,
    );
    expect(fired).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it("does NOT fire when prefix is at or under threshold", () => {
    const { log, warns } = makeLogger();
    const error = new Error("invalid_request_error: sample");
    const fired1 = classifyPromptBloat(
      error,
      PROMPT_BLOAT_THRESHOLD,
      "agent-A",
      log,
    );
    const fired2 = classifyPromptBloat(
      error,
      PROMPT_BLOAT_THRESHOLD - 1,
      "agent-A",
      log,
    );
    expect(fired1).toBe(false);
    expect(fired2).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it("does NOT fire when error is undefined / non-Error (defensive)", () => {
    const { log, warns } = makeLogger();
    expect(
      classifyPromptBloat(undefined, PROMPT_BLOAT_THRESHOLD + 1, "a", log),
    ).toBe(false);
    expect(
      classifyPromptBloat(null, PROMPT_BLOAT_THRESHOLD + 1, "a", log),
    ).toBe(false);
    expect(
      classifyPromptBloat({}, PROMPT_BLOAT_THRESHOLD + 1, "a", log),
    ).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it("invokes traceSink.incrementPromptBloatWarning on every fire", () => {
    const { log } = makeLogger();
    const sink: PromptBloatTraceSink = {
      incrementPromptBloatWarning: vi.fn(),
    };
    const error = new Error("invalid_request_error");
    classifyPromptBloat(error, PROMPT_BLOAT_THRESHOLD + 1, "X", log, sink);
    classifyPromptBloat(error, PROMPT_BLOAT_THRESHOLD + 1, "X", log, sink);
    expect(sink.incrementPromptBloatWarning).toHaveBeenCalledTimes(2);
    expect(sink.incrementPromptBloatWarning).toHaveBeenCalledWith("X");
  });

  it("does not call traceSink when classifier suppresses", () => {
    const { log } = makeLogger();
    const sink: PromptBloatTraceSink = {
      incrementPromptBloatWarning: vi.fn(),
    };
    const error = new Error("rate_limit_error");
    classifyPromptBloat(error, PROMPT_BLOAT_THRESHOLD + 1, "X", log, sink);
    expect(sink.incrementPromptBloatWarning).not.toHaveBeenCalled();
  });

  it("traceSink throw does NOT break the warn log (best-effort counter)", () => {
    const { log, warns } = makeLogger();
    const sink: PromptBloatTraceSink = {
      incrementPromptBloatWarning: () => {
        throw new Error("missing column prompt_bloat_warnings_24h");
      },
    };
    const error = new Error("invalid_request_error");
    const fired = classifyPromptBloat(
      error,
      PROMPT_BLOAT_THRESHOLD + 1,
      "X",
      log,
      sink,
    );
    // The classifier still reports it fired (the warn log went out) even
    // though the trace counter threw — operator-visibility-first contract.
    expect(fired).toBe(true);
    expect(warns).toHaveLength(1);
  });
});
