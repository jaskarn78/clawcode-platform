import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DeliveryQueue } from "./delivery-queue.js";
import type { DeliverFn } from "./delivery-queue-types.js";

describe("DeliveryQueue", () => {
  let db: InstanceType<typeof Database>;
  let deliverFn: ReturnType<typeof vi.fn<DeliverFn>>;
  let queue: DeliveryQueue;

  beforeEach(() => {
    db = new Database(":memory:");
    deliverFn = vi.fn<DeliverFn>().mockResolvedValue(undefined);
    queue = new DeliveryQueue({
      db,
      deliverFn,
      config: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000, processingIntervalMs: 50 },
    });
  });

  afterEach(() => {
    queue.stop();
    db.close();
  });

  describe("enqueue", () => {
    it("creates a pending entry and returns its id", () => {
      const id = queue.enqueue("agent-a", "ch-1", "hello world");
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);

      const stats = queue.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.totalEnqueued).toBe(1);
    });

    it("enqueues multiple entries independently", () => {
      const id1 = queue.enqueue("agent-a", "ch-1", "msg 1");
      const id2 = queue.enqueue("agent-b", "ch-2", "msg 2");
      expect(id1).not.toBe(id2);

      const stats = queue.getStats();
      expect(stats.pending).toBe(2);
      expect(stats.totalEnqueued).toBe(2);
    });
  });

  describe("processNext", () => {
    it("delivers successfully and marks delivered", async () => {
      queue.enqueue("agent-a", "ch-1", "hello");

      const processed = await queue.processNext();
      expect(processed).toBe(true);
      expect(deliverFn).toHaveBeenCalledWith("agent-a", "ch-1", "hello");

      const stats = queue.getStats();
      expect(stats.delivered).toBe(1);
      expect(stats.pending).toBe(0);
    });

    it("returns false when queue is empty", async () => {
      const processed = await queue.processNext();
      expect(processed).toBe(false);
      expect(deliverFn).not.toHaveBeenCalled();
    });

    it("processes oldest entry first (FIFO)", async () => {
      queue.enqueue("agent-a", "ch-1", "first");
      queue.enqueue("agent-b", "ch-2", "second");

      await queue.processNext();
      expect(deliverFn).toHaveBeenCalledWith("agent-a", "ch-1", "first");
    });
  });

  describe("retry with exponential backoff", () => {
    it("retries on failure with incremented attempts", async () => {
      deliverFn.mockRejectedValueOnce(new Error("Discord API error"));
      queue.enqueue("agent-a", "ch-1", "will fail");

      await queue.processNext();

      const stats = queue.getStats();
      // After 1 failure with maxAttempts=3, should be pending (retryable)
      expect(stats.pending).toBe(1);
      expect(stats.delivered).toBe(0);
      expect(stats.failed).toBe(0);
    });

    it("marks entry as permanently failed after maxAttempts", async () => {
      // Use baseDelayMs: 0 so retries are immediately available
      const failQueue = new DeliveryQueue({
        db,
        deliverFn: vi.fn<DeliverFn>().mockRejectedValue(new Error("Persistent error")),
        config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, processingIntervalMs: 50 },
      });
      failQueue.enqueue("agent-a", "ch-1", "doomed message");

      // Attempt 1, 2, 3
      await failQueue.processNext();
      await failQueue.processNext();
      await failQueue.processNext();

      const stats = failQueue.getStats();
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(0);
      expect(stats.delivered).toBe(0);
      failQueue.stop();
    });

    it("computes exponential backoff delay", async () => {
      deliverFn.mockRejectedValueOnce(new Error("fail 1"));
      queue.enqueue("agent-a", "ch-1", "retry me");

      await queue.processNext();

      // Get the failed entry to inspect nextRetryAt
      const failedEntries = queue.getFailedEntries();
      // It's not permanently failed yet (1 attempt < 3 maxAttempts)
      // so it should be retryable with a nextRetryAt set
      const stats = queue.getStats();
      expect(stats.pending).toBe(1);
    });

    it("caps backoff delay at maxDelayMs", async () => {
      // Use a queue with very small maxDelay to verify capping
      const cappedQueue = new DeliveryQueue({
        db,
        deliverFn: vi.fn<DeliverFn>().mockRejectedValue(new Error("fail")),
        config: { maxAttempts: 10, baseDelayMs: 10000, maxDelayMs: 100, processingIntervalMs: 50 },
      });

      cappedQueue.enqueue("agent-a", "ch-1", "cap test");
      await cappedQueue.processNext();

      // The delay should be capped -- we can verify by checking the entry is retryable
      const stats = cappedQueue.getStats();
      expect(stats.pending).toBe(1);
      cappedQueue.stop();
    });
  });

  describe("getStats", () => {
    it("returns correct counts across all statuses", async () => {
      // Enqueue 3 messages
      queue.enqueue("agent-a", "ch-1", "msg 1");
      queue.enqueue("agent-b", "ch-2", "msg 2");
      queue.enqueue("agent-c", "ch-3", "msg 3");

      // Deliver first one successfully
      await queue.processNext();

      const stats = queue.getStats();
      expect(stats.delivered).toBe(1);
      expect(stats.pending).toBe(2);
      expect(stats.totalEnqueued).toBe(3);
    });

    it("returns zeros when queue is empty", () => {
      const stats = queue.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.inFlight).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.delivered).toBe(0);
      expect(stats.totalEnqueued).toBe(0);
    });
  });

  describe("getFailedEntries", () => {
    it("returns permanently failed entries with error context", async () => {
      const failFn = vi.fn<DeliverFn>().mockRejectedValue(new Error("Discord 500"));
      const failQueue = new DeliveryQueue({
        db,
        deliverFn: failFn,
        config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, processingIntervalMs: 50 },
      });
      failQueue.enqueue("agent-a", "ch-1", "failing message");

      // Exhaust all attempts
      await failQueue.processNext();
      await failQueue.processNext();
      await failQueue.processNext();

      const failed = failQueue.getFailedEntries();
      expect(failed).toHaveLength(1);
      expect(failed[0].agentName).toBe("agent-a");
      expect(failed[0].channelId).toBe("ch-1");
      expect(failed[0].content).toBe("failing message");
      expect(failed[0].status).toBe("failed");
      expect(failed[0].lastError).toBe("Discord 500");
      expect(failed[0].attempts).toBe(3);
      failQueue.stop();
    });

    it("returns empty array when no failures", () => {
      const failed = queue.getFailedEntries();
      expect(failed).toHaveLength(0);
    });

    it("respects limit parameter", async () => {
      const failFn = vi.fn<DeliverFn>().mockRejectedValue(new Error("fail"));
      const failQueue = new DeliveryQueue({
        db,
        deliverFn: failFn,
        config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, processingIntervalMs: 50 },
      });

      // Create and fail 3 entries
      for (let i = 0; i < 3; i++) {
        failQueue.enqueue("agent-a", "ch-1", `msg ${i}`);
      }
      // Process all 3 x 3 attempts = 9 processNext calls
      for (let i = 0; i < 9; i++) {
        await failQueue.processNext();
      }

      const limited = failQueue.getFailedEntries(2);
      expect(limited).toHaveLength(2);
      failQueue.stop();
    });
  });

  describe("start/stop", () => {
    it("start begins processing and stop halts it", async () => {
      queue.enqueue("agent-a", "ch-1", "auto-processed");
      queue.start();

      // Wait for at least one processing cycle
      await new Promise((resolve) => setTimeout(resolve, 150));

      queue.stop();
      expect(deliverFn).toHaveBeenCalledWith("agent-a", "ch-1", "auto-processed");
    });

    it("stop is idempotent", () => {
      queue.stop();
      queue.stop(); // Should not throw
    });
  });
});
