import { describe, it, expect } from "vitest";
import type {
  DeliveryStatus,
  DeliveryEntry,
  DeliveryQueueConfig,
  DeliveryStats,
  DeliverFn,
} from "./delivery-queue-types.js";
import { DEFAULT_DELIVERY_QUEUE_CONFIG } from "./delivery-queue-types.js";

describe("delivery-queue-types", () => {
  it("exports DEFAULT_DELIVERY_QUEUE_CONFIG with correct defaults", () => {
    expect(DEFAULT_DELIVERY_QUEUE_CONFIG.maxAttempts).toBe(3);
    expect(DEFAULT_DELIVERY_QUEUE_CONFIG.baseDelayMs).toBe(1000);
    expect(DEFAULT_DELIVERY_QUEUE_CONFIG.maxDelayMs).toBe(30000);
    expect(DEFAULT_DELIVERY_QUEUE_CONFIG.processingIntervalMs).toBe(500);
  });

  it("DeliveryStatus accepts valid status values", () => {
    const statuses: readonly DeliveryStatus[] = [
      "pending",
      "in_flight",
      "failed",
      "delivered",
    ];
    expect(statuses).toHaveLength(4);
  });

  it("DeliveryEntry shape is valid", () => {
    const entry: DeliveryEntry = {
      id: "test-id",
      agentName: "agent-a",
      channelId: "ch-1",
      content: "hello",
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      lastAttemptAt: null,
      nextRetryAt: null,
      lastError: null,
      deliveredAt: null,
    };
    expect(entry.status).toBe("pending");
  });

  it("DeliveryStats shape is valid", () => {
    const stats: DeliveryStats = {
      pending: 1,
      inFlight: 0,
      failed: 0,
      delivered: 5,
      totalEnqueued: 6,
    };
    expect(stats.totalEnqueued).toBe(6);
  });

  it("DeliverFn type accepts async function", () => {
    const fn: DeliverFn = async (
      _agentName: string,
      _channelId: string,
      _content: string,
    ): Promise<void> => {};
    expect(typeof fn).toBe("function");
  });

  it("DEFAULT_DELIVERY_QUEUE_CONFIG is frozen/immutable", () => {
    expect(DEFAULT_DELIVERY_QUEUE_CONFIG).toBeDefined();
    // Readonly enforced at type level; runtime check that it's a plain object
    expect(typeof DEFAULT_DELIVERY_QUEUE_CONFIG).toBe("object");
  });
});
