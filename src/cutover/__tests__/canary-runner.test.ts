/**
 * Phase 92 Plan 05 Task 1 (RED) — canary-runner tests.
 *
 * Pins the contract for `runCanary(deps)` defined in the plan's <interfaces>
 * block. RED gate: src/cutover/canary-runner.ts does not yet exist so
 * import-time failure triggers vitest red.
 *
 * Behavioral pins (D-08):
 *   R1 happy 40-invocation: 20 prompts × 2 paths = 40 results all "passed"
 *   R2 partial-failure   : API path fails for 1 prompt → passRate < 100
 *   R3 timeout (FAKE)    : dispatchStream never resolves → failed-timeout
 *   R4 empty-response    : fetchApi 200 with empty text → failed-empty
 *   R5 result-determinism: results sorted by (intent, path) ASC; two runs
 *                           over identical input produce identical sequences
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCanary, type CanaryRunnerDeps } from "../canary-runner.js";
import type { CanaryPrompt } from "../types.js";

function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as import("pino").Logger;
}

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "cutover-canary-runner-"));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function makePrompts(n: number): CanaryPrompt[] {
  return Array.from({ length: n }, (_, i) => ({
    intent: `intent-${String(i).padStart(2, "0")}`,
    prompt: `Please handle intent ${i}.`,
  }));
}

function baseDeps(
  overrides: Partial<CanaryRunnerDeps> = {},
): CanaryRunnerDeps {
  return {
    agent: "fin-client",
    prompts: makePrompts(2),
    canaryChannelId: "test-channel-123",
    apiEndpoint: "http://localhost:3101/v1/chat/completions",
    outputDir,
    dispatchStream: vi.fn(async () => ({ text: "discord ok" })),
    fetchApi: vi.fn(async () => ({ status: 200, text: "api ok" })),
    log: makeLog(),
    ...overrides,
  };
}

describe("runCanary — R1 happy 40-invocation", () => {
  it("20 prompts × 2 paths = 40 results all status=passed; passRate === 100", async () => {
    const dispatchStream = vi.fn(async () => ({ text: "discord reply" }));
    const fetchApi = vi.fn(async () => ({
      status: 200,
      text: "api reply",
    }));
    const outcome = await runCanary(
      baseDeps({
        prompts: makePrompts(20),
        dispatchStream:
          dispatchStream as unknown as CanaryRunnerDeps["dispatchStream"],
        fetchApi: fetchApi as unknown as CanaryRunnerDeps["fetchApi"],
      }),
    );
    expect(outcome.kind).toBe("ran");
    if (outcome.kind === "ran") {
      expect(outcome.results).toHaveLength(40);
      expect(
        outcome.results.filter((r) => r.path === "discord-bot"),
      ).toHaveLength(20);
      expect(outcome.results.filter((r) => r.path === "api")).toHaveLength(20);
      expect(outcome.results.every((r) => r.status === "passed")).toBe(true);
      expect(outcome.passRate).toBe(100);
    }
  });
});

describe("runCanary — R2 partial failure", () => {
  it("API returns 500 for one prompt → exactly one failed-error in results, passRate < 100", async () => {
    const prompts = makePrompts(2);
    const dispatchStream = vi.fn(async () => ({ text: "discord ok" }));
    let apiCallIndex = 0;
    const fetchApi = vi.fn(async () => {
      const i = apiCallIndex++;
      if (i === 0) return { status: 500, text: "internal error" };
      return { status: 200, text: "api ok" };
    });
    const outcome = await runCanary(
      baseDeps({
        prompts,
        dispatchStream:
          dispatchStream as unknown as CanaryRunnerDeps["dispatchStream"],
        fetchApi: fetchApi as unknown as CanaryRunnerDeps["fetchApi"],
      }),
    );
    expect(outcome.kind).toBe("ran");
    if (outcome.kind === "ran") {
      const failed = outcome.results.filter((r) => r.status !== "passed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.path).toBe("api");
      expect(failed[0]?.status).toBe("failed-error");
      expect(outcome.passRate).toBeLessThan(100);
    }
  });
});

describe("runCanary — R3 timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatchStream never resolves → result.status === 'failed-timeout' after 30s", async () => {
    // dispatchStream returns a promise that never resolves — only the
    // raceWithTimeout setTimeout fires once vi.advanceTimersByTime is called.
    const dispatchStream = vi.fn(
      () => new Promise<{ text: string }>(() => {}),
    );
    const fetchApi = vi.fn(async () => ({ status: 200, text: "api ok" }));

    const runPromise = runCanary(
      baseDeps({
        prompts: makePrompts(1),
        timeoutMs: 30_000,
        dispatchStream:
          dispatchStream as unknown as CanaryRunnerDeps["dispatchStream"],
        fetchApi: fetchApi as unknown as CanaryRunnerDeps["fetchApi"],
      }),
    );

    // Advance past the 30s timeout to fire the race's setTimeout. We allow
    // microtask flushes between advances so the inner state machine runs.
    await vi.advanceTimersByTimeAsync(31_000);
    const outcome = await runPromise;

    expect(outcome.kind).toBe("ran");
    if (outcome.kind === "ran") {
      const discord = outcome.results.find((r) => r.path === "discord-bot");
      expect(discord?.status).toBe("failed-timeout");
    }
  });
});

describe("runCanary — R4 empty response", () => {
  it("fetchApi resolves status=200 with empty text → status='failed-empty'", async () => {
    const prompts = makePrompts(1);
    const dispatchStream = vi.fn(async () => ({ text: "discord ok" }));
    const fetchApi = vi.fn(async () => ({ status: 200, text: "" }));
    const outcome = await runCanary(
      baseDeps({
        prompts,
        dispatchStream:
          dispatchStream as unknown as CanaryRunnerDeps["dispatchStream"],
        fetchApi: fetchApi as unknown as CanaryRunnerDeps["fetchApi"],
      }),
    );
    expect(outcome.kind).toBe("ran");
    if (outcome.kind === "ran") {
      const apiResult = outcome.results.find((r) => r.path === "api");
      expect(apiResult?.status).toBe("failed-empty");
    }
  });
});

describe("runCanary — R5 result determinism", () => {
  it("results sorted by (intent ASC, path ASC); two runs over identical input → same sequence", async () => {
    // Intentionally pass prompts out of intent-order to prove the runner
    // sorts the output regardless of input order.
    const prompts: readonly CanaryPrompt[] = [
      { intent: "z", prompt: "Z?" },
      { intent: "a", prompt: "A?" },
      { intent: "m", prompt: "M?" },
    ];
    const dispatchStream = vi.fn(async () => ({ text: "discord ok" }));
    const fetchApi = vi.fn(async () => ({
      status: 200,
      text: "api ok",
    }));

    const out1 = await runCanary(
      baseDeps({
        prompts,
        dispatchStream:
          dispatchStream as unknown as CanaryRunnerDeps["dispatchStream"],
        fetchApi: fetchApi as unknown as CanaryRunnerDeps["fetchApi"],
      }),
    );
    const out2 = await runCanary(
      baseDeps({
        prompts,
        dispatchStream:
          dispatchStream as unknown as CanaryRunnerDeps["dispatchStream"],
        fetchApi: fetchApi as unknown as CanaryRunnerDeps["fetchApi"],
      }),
    );

    expect(out1.kind).toBe("ran");
    expect(out2.kind).toBe("ran");
    if (out1.kind === "ran" && out2.kind === "ran") {
      // Verify intent-then-path ordering.
      const seq = out1.results.map((r) => `${r.intent}:${r.path}`);
      expect(seq).toEqual([
        "a:api",
        "a:discord-bot",
        "m:api",
        "m:discord-bot",
        "z:api",
        "z:discord-bot",
      ]);
      // Determinism across runs (durationMs may differ; compare sequence only).
      expect(out2.results.map((r) => `${r.intent}:${r.path}:${r.status}`)).toEqual(
        out1.results.map((r) => `${r.intent}:${r.path}:${r.status}`),
      );
    }
  });
});
