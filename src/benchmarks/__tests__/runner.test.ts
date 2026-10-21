import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBench, runKeepAliveBench, assertKeepAliveWin } from "../runner.js";
import { benchReportSchema } from "../types.js";
import type { HarnessDeps, KeepAliveReport } from "../runner.js";

function writePromptsYaml(dir: string): string {
  const path = join(dir, "prompts.yaml");
  writeFileSync(
    path,
    `prompts:
  - id: "short-reply"
    prompt: "Say hi."
  - id: "memory-lookup"
    prompt: "Recall favorite color."
`,
    "utf-8",
  );
  return path;
}

function makeLatencyResponse() {
  return {
    agent: "bench-agent",
    since: "2026-04-13T20:00:00.000Z",
    segments: [
      { segment: "end_to_end", p50: 1000, p95: 2000, p99: 3000, count: 10 },
      { segment: "first_token", p50: 400, p95: 800, p99: 1200, count: 10 },
      { segment: "context_assemble", p50: 50, p95: 100, p99: 150, count: 10 },
      { segment: "tool_call", p50: 75, p95: 150, p99: 225, count: 20 },
    ],
  };
}

function makeStubHarness(opts: {
  socketPath: string;
  ready?: boolean;
  writeConfigResult?: string;
  stopSpy?: ReturnType<typeof vi.fn>;
}): HarnessDeps {
  const stopFn = opts.stopSpy ?? vi.fn().mockResolvedValue(undefined);
  return {
    spawn: (async () => ({
      pid: 9999,
      socketPath: opts.socketPath,
      stop: stopFn,
    })) as unknown as HarnessDeps["spawn"],
    awaitReady: (async () =>
      opts.ready ?? true) as unknown as HarnessDeps["awaitReady"],
    writeConfig: (async () =>
      opts.writeConfigResult ??
      "/tmp/clawcode-bench.yaml") as unknown as HarnessDeps["writeConfig"],
  };
}

describe("runBench", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "runner-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a BenchReport with prompt_results per prompt × repeats", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    const ipcClient = vi.fn(async (_sock, method) => {
      if (method === "bench-run-prompt") {
        return { turnId: `bench:t:${Math.random().toString(36).slice(2, 8)}`, response: "ok" };
      }
      if (method === "latency") return makeLatencyResponse();
      if (method === "start") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 2,
      since: "1h",
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
    });

    expect(report.prompt_results).toHaveLength(2);
    expect(report.prompt_results[0]!.turnIds).toHaveLength(2);
    expect(report.prompt_results[1]!.turnIds).toHaveLength(2);
    expect(report.run_id).toMatch(/.+/);
    expect(report.node_version).toBe(process.version);
  });

  it("writes a report JSON file that round-trips through benchReportSchema", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "bench-run-prompt")
        return { turnId: "bench:t:abcdef", response: "ok" };
      if (method === "latency") return makeLatencyResponse();
      if (method === "start") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });

    const { report, reportPath } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 1,
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
    });

    expect(reportPath).toBe(join(reportsDir, `${report.run_id}.json`));
    const onDisk = JSON.parse(readFileSync(reportPath, "utf-8"));
    const parsed = benchReportSchema.safeParse(onDisk);
    expect(parsed.success).toBe(true);
  });

  it("tears down the daemon in finally{} even when an IPC call throws", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");
    const stopSpy = vi.fn().mockResolvedValue(undefined);

    // IPC fails partway — the runner must still call handle.stop().
    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "start") return { ok: true };
      if (method === "bench-run-prompt") throw new Error("simulated IPC failure");
      if (method === "latency") return makeLatencyResponse();
      throw new Error(`unexpected method ${method}`);
    });

    await expect(
      runBench({
        promptsPath,
        agent: "bench-agent",
        repeats: 1,
        reportsDir,
        harness: makeStubHarness({ socketPath, stopSpy }),
        ipcClient,
        tmpHomeFactory: () => tmp,
      }),
    ).rejects.toThrow(/simulated IPC failure/);

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("produces overall_percentiles with exactly 4 canonical segments (even count=0 rows)", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    // Return only 2 segments — runner must backfill the missing 2 with count=0.
    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "bench-run-prompt")
        return { turnId: "bench:t:partial", response: "ok" };
      if (method === "start") return { ok: true };
      if (method === "latency")
        return {
          agent: "bench-agent",
          since: "2026-04-13T20:00:00.000Z",
          segments: [
            { segment: "end_to_end", p50: 1000, p95: 2000, p99: 3000, count: 10 },
            { segment: "first_token", p50: 400, p95: 800, p99: 1200, count: 10 },
          ],
        };
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 1,
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
    });

    expect(report.overall_percentiles).toHaveLength(4);
    const segs = report.overall_percentiles.map((r) => r.segment);
    expect(segs).toEqual([
      "end_to_end",
      "first_token",
      "context_assemble",
      "tool_call",
    ]);
    const contextRow = report.overall_percentiles.find(
      (r) => r.segment === "context_assemble",
    );
    expect(contextRow?.count).toBe(0);
    expect(contextRow?.p50).toBeNull();
  });

  it("captures git_sha from git rev-parse HEAD when git is available", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "bench-run-prompt")
        return { turnId: "bench:t:xyz", response: "ok" };
      if (method === "start") return { ok: true };
      if (method === "latency") return makeLatencyResponse();
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 1,
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
    });

    // We're inside a git checkout — sha should be a 40-char hex or "unknown"
    // (the latter is a valid fallback when git is unavailable).
    expect(report.git_sha).toMatch(/^(?:[a-f0-9]{40}|unknown)$/);
  });

  it("Test 18 (Phase 53): captureResponses=true includes response_lengths in BenchReport", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    const responses: Record<string, string[]> = {
      "short-reply": ["hi there", "hello again friendly"],
      "memory-lookup": ["blue is the favored color"],
    };

    const ipcClient = vi.fn(async (_s, method, params) => {
      if (method === "bench-run-prompt") {
        const turnIdPrefix = (params as { turnIdPrefix?: string })
          ?.turnIdPrefix ?? "bench:t:";
        // Extract prompt id from turnIdPrefix (format: `bench:<id>:`)
        const match = turnIdPrefix.match(/^bench:([^:]+):/);
        const id = match?.[1] ?? "unknown";
        const pool = responses[id] ?? ["generic reply"];
        const idx = Math.floor(Math.random() * pool.length);
        const response = pool[idx]!;
        return { turnId: `bench:t:${Math.random()}`, response };
      }
      if (method === "latency") return makeLatencyResponse();
      if (method === "start") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 2,
      since: "1h",
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
      captureResponses: true,
    });

    const lengths = (report as unknown as {
      response_lengths?: Record<string, number>;
    }).response_lengths;
    expect(lengths).toBeDefined();
    expect(typeof lengths!["short-reply"]).toBe("number");
    expect(typeof lengths!["memory-lookup"]).toBe("number");
    expect(lengths!["memory-lookup"]).toBeGreaterThan(0);
  });

  // ── Phase 54 Plan 03 — rate_limit_errors counter + 4-segment backward-compat filter ──

  it("Test 20 (Phase 54): runBench output includes rate_limit_errors: 0 when no rate-limit events occur", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "bench-run-prompt") {
        return { turnId: "bench:t:abc", response: "ok", rate_limit_errors: 0 };
      }
      if (method === "latency") return makeLatencyResponse();
      if (method === "start") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 1,
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
    });

    expect(report.rate_limit_errors).toBe(0);
  });

  it("Test 21 (Phase 54): runBench sums rate-limit counts across prompt responses (2 prompts × 1 = 2 total)", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    // Each bench-run-prompt call returns rate_limit_errors: 1
    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "bench-run-prompt") {
        return { turnId: "bench:t:rl", response: "ok", rate_limit_errors: 1 };
      }
      if (method === "latency") return makeLatencyResponse();
      if (method === "start") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 1, // 2 prompts x 1 repeat = 2 calls => rate_limit_errors = 2
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
    });

    expect(report.rate_limit_errors).toBe(2);
  });

  it("Test 22 (Phase 54): runner's overall_percentiles contains EXACTLY the 4 Phase 51 canonical segments (filters out first_visible_token + typing_indicator)", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    // The daemon's latency response includes the 2 NEW Phase 54 segments
    // (first_visible_token, typing_indicator) — runner must filter them out
    // of overall_percentiles so baseline.json Zod parse still succeeds.
    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "bench-run-prompt") {
        return { turnId: "bench:t:x", response: "ok", rate_limit_errors: 0 };
      }
      if (method === "latency") {
        return {
          agent: "bench-agent",
          since: "2026-04-13T20:00:00.000Z",
          segments: [
            { segment: "end_to_end", p50: 1000, p95: 2000, p99: 3000, count: 10 },
            { segment: "first_token", p50: 400, p95: 800, p99: 1200, count: 10 },
            { segment: "first_visible_token", p50: 420, p95: 820, p99: 1220, count: 10 }, // new Phase 54
            { segment: "context_assemble", p50: 50, p95: 100, p99: 150, count: 10 },
            { segment: "tool_call", p50: 75, p95: 150, p99: 225, count: 20 },
            { segment: "typing_indicator", p50: 50, p95: 100, p99: 150, count: 10 }, // new Phase 54
          ],
        };
      }
      if (method === "start") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 1,
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
    });

    expect(report.overall_percentiles).toHaveLength(4);
    const segs = report.overall_percentiles.map((r) => r.segment);
    expect(segs).toEqual([
      "end_to_end",
      "first_token",
      "context_assemble",
      "tool_call",
    ]);
    // Explicit absence checks
    expect(segs).not.toContain("first_visible_token");
    expect(segs).not.toContain("typing_indicator");
  });

  it("Test 23 (Phase 54): runner's per-prompt promptResults.percentiles MAY contain the 2 new segments (only overall is backward-compat filtered)", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    // Per-prompt percentiles are captured verbatim from the latency IPC
    // response — they preserve the full 6-segment shape for debugging.
    const extendedLatency = {
      agent: "bench-agent",
      since: "2026-04-13T20:00:00.000Z",
      segments: [
        { segment: "end_to_end", p50: 1000, p95: 2000, p99: 3000, count: 10 },
        { segment: "first_token", p50: 400, p95: 800, p99: 1200, count: 10 },
        { segment: "first_visible_token", p50: 420, p95: 820, p99: 1220, count: 10 },
        { segment: "context_assemble", p50: 50, p95: 100, p99: 150, count: 10 },
        { segment: "tool_call", p50: 75, p95: 150, p99: 225, count: 20 },
        { segment: "typing_indicator", p50: 50, p95: 100, p99: 150, count: 10 },
      ],
    };
    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "bench-run-prompt") {
        return { turnId: "bench:t:x", response: "ok", rate_limit_errors: 0 };
      }
      if (method === "latency") return extendedLatency;
      if (method === "start") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 1,
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
    });

    // Per-prompt percentiles are verbatim — 6 segments preserved
    expect(report.prompt_results[0]!.percentiles).toHaveLength(6);
    const perPromptSegs = report.prompt_results[0]!.percentiles.map(
      (r) => r.segment,
    );
    expect(perPromptSegs).toContain("first_visible_token");
    expect(perPromptSegs).toContain("typing_indicator");
  });

  it("Test 19 (Phase 53): captureResponses=false (default) omits response_lengths", async () => {
    const promptsPath = writePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");

    const ipcClient = vi.fn(async (_s, method) => {
      if (method === "bench-run-prompt") {
        return { turnId: "bench:t:abc", response: "ok" };
      }
      if (method === "latency") return makeLatencyResponse();
      if (method === "start") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    });

    const { report } = await runBench({
      promptsPath,
      agent: "bench-agent",
      repeats: 1,
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient,
      tmpHomeFactory: () => tmp,
      // captureResponses omitted → default false
    });

    expect(
      (report as unknown as { response_lengths?: Record<string, number> })
        .response_lengths,
    ).toBeUndefined();
  });
});

// ── Phase 56 Plan 03 — keep-alive bench (5-message same-thread warm-path probe) ──

function writeKeepAlivePromptsYaml(dir: string): string {
  const path = join(dir, "keep-alive-prompts.yaml");
  writeFileSync(
    path,
    `prompts:
  - id: ka-01
    prompt: "What is 2 + 2?"
    description: "Cold first message — establish baseline"
  - id: ka-02
    prompt: "Now multiply that by 3."
    description: "Second message — session should be warm"
  - id: ka-03
    prompt: "What if we subtract 1?"
    description: "Third message"
  - id: ka-04
    prompt: "Explain why this chain matters in one sentence."
    description: "Fourth message"
  - id: ka-05
    prompt: "Now summarize the chain in 10 words."
    description: "Fifth message"
`,
    "utf-8",
  );
  return path;
}

/**
 * Build a keep-alive stub IPC client that returns controlled per-message
 * latencies. The `latencies` array is consumed in order for each
 * `bench-run-prompt` call — emulating wall-clock ms for that message.
 *
 * Uses `vi.useFakeTimers()` so we can advance Date.now by the stubbed ms
 * inside each IPC call. Matching this with how `runKeepAliveBench` measures
 * per-message latency (`Date.now()` diff around the IPC call) is what makes
 * the test deterministic.
 */
type IpcClientFn = (
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

function makeKeepAliveIpcStub(latencies: readonly number[]): IpcClientFn {
  let idx = 0;
  const fn = vi.fn(async (_sock: string, method: string) => {
    if (method === "start") return { ok: true };
    if (method === "bench-run-prompt") {
      const ms = latencies[idx] ?? 500;
      idx += 1;
      // Advance fake time so the runner's Date.now() wall-clock diff picks up `ms`.
      vi.advanceTimersByTime(ms);
      return { turnId: `bench:ka:${idx}`, response: "ok" };
    }
    // latency snapshot isn't required for keep-alive (uses wall-clock), but
    // stay defensive if runner calls it.
    if (method === "latency") return makeLatencyResponse();
    throw new Error(`unexpected method ${method}`);
  });
  return fn as unknown as IpcClientFn;
}

describe("keep-alive bench (Phase 56)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "keep-alive-test-"));
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Test 1 (Phase 56): runKeepAliveBench captures per-message end_to_end ms in order", async () => {
    const promptsPath = writeKeepAlivePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");
    // msg 1 cold = 800ms; msgs 2-5 warm = 300ms each
    const latencies = [800, 300, 300, 300, 300];

    const report = await runKeepAliveBench({
      promptsPath,
      agent: "bench-agent",
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient: makeKeepAliveIpcStub(latencies),
      tmpHomeFactory: () => tmp,
    });

    expect(report.mode).toBe("keep-alive");
    expect(report.agent).toBe("bench-agent");
    expect(report.per_message_ms).toHaveLength(5);
    expect(report.per_message_ms).toEqual([800, 300, 300, 300, 300]);
  });

  it("Test 2 (Phase 56): KeepAliveReport includes warm_path_win_ratio = msgs2_5_p50 / msg1", async () => {
    const promptsPath = writeKeepAlivePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");
    // msg 1 = 800ms; msgs 2-5 p50 = 300ms → ratio = 300/800 = 0.375
    const latencies = [800, 300, 300, 300, 300];

    const report = await runKeepAliveBench({
      promptsPath,
      agent: "bench-agent",
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient: makeKeepAliveIpcStub(latencies),
      tmpHomeFactory: () => tmp,
    });

    expect(report.message1_ms).toBe(800);
    expect(report.messages2_5_p50_ms).toBe(300);
    expect(report.warm_path_win_ratio).toBeCloseTo(0.375, 3);
  });

  it("Test 3 (Phase 56): assertKeepAliveWin passes when ratio ≤ 0.7 (happy path)", async () => {
    const report: KeepAliveReport = Object.freeze({
      mode: "keep-alive",
      agent: "bench-agent",
      per_message_ms: Object.freeze([800, 300, 300, 300, 300]) as unknown as readonly number[],
      message1_ms: 800,
      messages2_5_p50_ms: 300,
      warm_path_win_ratio: 0.375,
    });

    const result = assertKeepAliveWin(report);
    expect(result.passed).toBe(true);
    expect(result.ratio).toBeCloseTo(0.375, 3);
    expect(result.message1).toBe(800);
    expect(result.messages2_5_p50).toBe(300);
  });

  it("Test 4 (Phase 56): assertKeepAliveWin throws with actionable message when ratio > 0.7 (cold-reinit path)", async () => {
    const report: KeepAliveReport = Object.freeze({
      mode: "keep-alive",
      agent: "bench-agent",
      per_message_ms: Object.freeze([800, 800, 800, 800, 800]) as unknown as readonly number[],
      message1_ms: 800,
      messages2_5_p50_ms: 800,
      warm_path_win_ratio: 1.0,
    });

    expect(() => assertKeepAliveWin(report)).toThrowError(
      /keep-alive regression/,
    );
    // Error message must include the ratio AND both ms values so operators
    // can triage without re-running the bench.
    try {
      assertKeepAliveWin(report);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/100(\.0)?%/);
      expect(msg).toMatch(/800/);
    }
  });

  it("Test 5 (Phase 56): runs a full 5-message bench end-to-end + asserts warm-path win against happy-path harness", async () => {
    const promptsPath = writeKeepAlivePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");
    // Happy path: cold msg 1 = 1000ms, warm msgs 2-5 ~= 300ms → ratio 0.3
    const latencies = [1000, 280, 320, 290, 310];

    const report = await runKeepAliveBench({
      promptsPath,
      agent: "bench-agent",
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient: makeKeepAliveIpcStub(latencies),
      tmpHomeFactory: () => tmp,
    });

    // p50 of [280, 320, 290, 310] sorted: [280, 290, 310, 320] — nearest-rank
    // at p=0.5 gives index floor(4*0.5)=2 → 310. Assert in a tolerant way.
    expect(report.messages2_5_p50_ms).toBeGreaterThanOrEqual(290);
    expect(report.messages2_5_p50_ms).toBeLessThanOrEqual(310);
    expect(report.warm_path_win_ratio).toBeLessThanOrEqual(0.7);
    const result = assertKeepAliveWin(report);
    expect(result.passed).toBe(true);
  });

  it("Test 6 (Phase 56): divide-by-zero guard — when message 1 is 0ms, ratio is set to 1.0 (fail-safe)", async () => {
    const promptsPath = writeKeepAlivePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");
    // Synthetic: all messages 0ms (mock path). Runner must NOT divide by zero.
    const latencies = [0, 0, 0, 0, 0];

    const report = await runKeepAliveBench({
      promptsPath,
      agent: "bench-agent",
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient: makeKeepAliveIpcStub(latencies),
      tmpHomeFactory: () => tmp,
    });

    expect(report.message1_ms).toBe(0);
    expect(report.messages2_5_p50_ms).toBe(0);
    // Divide-by-zero guard → ratio forced to 1.0 so assertKeepAliveWin
    // catches the degenerate case rather than returning NaN.
    expect(report.warm_path_win_ratio).toBe(1.0);
    expect(() => assertKeepAliveWin(report)).toThrowError(
      /keep-alive regression/,
    );
  });

  it("Test 7 (Phase 56): KeepAliveReport shape is frozen (immutable — matches project readonly contract)", async () => {
    const promptsPath = writeKeepAlivePromptsYaml(tmp);
    const reportsDir = join(tmp, "reports");
    const socketPath = join(tmp, ".clawcode", "manager", "clawcode.sock");
    const latencies = [500, 200, 200, 200, 200];

    const report = await runKeepAliveBench({
      promptsPath,
      agent: "bench-agent",
      reportsDir,
      harness: makeStubHarness({ socketPath }),
      ipcClient: makeKeepAliveIpcStub(latencies),
      tmpHomeFactory: () => tmp,
    });

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.per_message_ms)).toBe(true);
    // Attempt to mutate — strict mode throws; non-strict silently no-ops.
    // Either way, the value after the attempt must be unchanged.
    expect(() => {
      (report as unknown as { mode: string }).mode = "tampered";
    }).toThrow();
    expect(report.mode).toBe("keep-alive");
  });
});
