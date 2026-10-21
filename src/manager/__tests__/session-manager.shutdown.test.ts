/**
 * Quick task 260419-q2z Task 4 — shutdown drain tests.
 *
 * Tests SessionManager.drain() semantics + the streamFromAgent/dispatchTurn
 * rejection guard that activates after drain. Uses __testTrackSummary to
 * enqueue promises into the same Set that the production stop/crash paths
 * fill, so we don't need to stand up full agent + memory infrastructure to
 * exercise the drain behavior directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMockAdapter, type MockSessionAdapter } from "../session-adapter.js";
import type { BackoffConfig } from "../types.js";
import { SessionManager } from "../session-manager.js";

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

describe("SessionManager.drain (260419-q2z Fix B)", () => {
  let adapter: MockSessionAdapter;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-drain-test-"));
    manager = new SessionManager({
      adapter,
      registryPath: join(tmpDir, "registry.json"),
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* ignore — shutdown tests drive drain directly */
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("drain() returns {0, 0} immediately when no summaries are pending", async () => {
    const start = Date.now();
    const result = await manager.drain(1000);
    const elapsed = Date.now() - start;
    expect(result).toEqual({ settled: 0, timedOut: 0 });
    expect(elapsed).toBeLessThan(50);
  });

  it("drain() waits for in-flight summaries before returning {settled, timedOut}", async () => {
    let resolveInner: () => void = () => undefined;
    const inner = new Promise<void>((resolve) => {
      resolveInner = resolve;
    });
    manager.__testTrackSummary(inner);

    let drainSettled = false;
    const drainPromise = manager.drain(5000).then((r) => {
      drainSettled = true;
      return r;
    });

    // Microtask flush — drain should still be pending.
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    // Resolve the tracked summary → drain should now complete.
    resolveInner();
    const result = await drainPromise;
    expect(result).toEqual({ settled: 1, timedOut: 0 });
  });

  it("drain() honors timeout — returns {0, N} when summaries exceed the ceiling", async () => {
    // A promise that never resolves on its own.
    let unblock: () => void = () => undefined;
    const neverResolving = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    manager.__testTrackSummary(neverResolving);

    const start = Date.now();
    const result = await manager.drain(100);
    const elapsed = Date.now() - start;

    expect(result).toEqual({ settled: 0, timedOut: 1 });
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);

    // Clean up — release the dangling promise so it doesn't produce an
    // unhandled rejection warning when the test process exits.
    unblock();
    await neverResolving;
  });

  it("drain() flips draining=true so streamFromAgent rejects with SessionError('shutting down')", async () => {
    // No pending summaries — drain resolves fast but still sets draining=true.
    await manager.drain(100);
    expect(manager.__testIsDraining()).toBe(true);

    await expect(
      manager.streamFromAgent("nonexistent-agent", "hi", () => undefined),
    ).rejects.toThrow(/shutting down/);
  });

  it("drain() flips draining=true so dispatchTurn rejects with SessionError('shutting down')", async () => {
    await manager.drain(100);
    await expect(manager.dispatchTurn("nonexistent-agent", "hi")).rejects.toThrow(
      /shutting down/,
    );
  });

  it("drain() is idempotent — second call after the first returns {0, 0} fast", async () => {
    let resolveInner: () => void = () => undefined;
    const inner = new Promise<void>((resolve) => {
      resolveInner = resolve;
    });
    manager.__testTrackSummary(inner);
    const firstPromise = manager.drain(5000);
    resolveInner();
    const firstResult = await firstPromise;
    expect(firstResult).toEqual({ settled: 1, timedOut: 0 });

    const secondStart = Date.now();
    const secondResult = await manager.drain(1000);
    const secondElapsed = Date.now() - secondStart;
    expect(secondResult).toEqual({ settled: 0, timedOut: 0 });
    expect(secondElapsed).toBeLessThan(50);
  });

  it("drain() timeout does NOT cancel the pending promise — background continuation still settles cleanly", async () => {
    // This guards against unhandled-rejection warnings when a drain timeout
    // is followed by the summary eventually resolving (or rejecting).
    let resolveLate: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    manager.__testTrackSummary(late);

    const result = await manager.drain(50);
    expect(result).toEqual({ settled: 0, timedOut: 1 });

    // Resolve after drain has already returned — should not throw or warn.
    resolveLate();
    await late;
  });

  it("drain() tracks multiple in-flight summaries and reports the aggregate count", async () => {
    const resolvers: Array<() => void> = [];
    for (let i = 0; i < 3; i++) {
      const p = new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      manager.__testTrackSummary(p);
    }

    const drainPromise = manager.drain(5000);
    resolvers.forEach((r) => r());
    const result = await drainPromise;
    expect(result).toEqual({ settled: 3, timedOut: 0 });
  });
});

describe("daemon shutdown drain ordering (260419-q2z Fix B integration)", () => {
  it("daemon.ts shutdown handler awaits manager.drain(15_000) BEFORE openAiEndpoint.close()", async () => {
    // Lightweight static check: verify the source file literally contains the
    // drain(15_000) call placed BEFORE openAiEndpoint.close() in the
    // shutdown handler. This guards against accidental reordering without
    // needing to boot a full daemon for a one-line ordering assertion.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/manager/daemon.ts", "utf-8");
    const drainIdx = src.indexOf("manager.drain(15_000)");
    const closeIdx = src.indexOf("await openAiEndpoint.close()");
    expect(drainIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(drainIdx).toBeLessThan(closeIdx);
  });
});
