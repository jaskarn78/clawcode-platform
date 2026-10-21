import { describe, it, expect, vi } from "vitest";
import { formatDeliveryQueueOutput } from "./delivery-queue.js";

type DeliveryQueueResponse = {
  readonly stats: {
    readonly pending: number;
    readonly inFlight: number;
    readonly failed: number;
    readonly delivered: number;
    readonly totalEnqueued: number;
  };
  readonly failed: readonly {
    readonly id: string;
    readonly agentName: string;
    readonly channelId: string;
    readonly content: string;
    readonly lastError: string | null;
    readonly createdAt: string;
    readonly attempts: number;
  }[];
};

describe("formatDeliveryQueueOutput", () => {
  it("formats stats only when showFailed is false", () => {
    const data: DeliveryQueueResponse = {
      stats: { pending: 5, inFlight: 2, failed: 1, delivered: 100, totalEnqueued: 108 },
      failed: [],
    };

    const result = formatDeliveryQueueOutput(data, false);
    expect(result).toContain("Delivery Queue Status");
    expect(result).toContain("Pending:        5");
    expect(result).toContain("In Flight:      2");
    expect(result).toContain("Failed:         1");
    expect(result).toContain("Delivered:      100");
    expect(result).toContain("Total Enqueued: 108");
    expect(result).not.toContain("Failed Deliveries");
  });

  it("formats stats with failed entries when showFailed is true", () => {
    const data: DeliveryQueueResponse = {
      stats: { pending: 0, inFlight: 0, failed: 1, delivered: 50, totalEnqueued: 51 },
      failed: [
        {
          id: "abc12345678",
          agentName: "myagent",
          channelId: "ch12345678",
          content: "Hello world message that is quite long and should be truncated at some point",
          lastError: "rate limited by Discord API",
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          attempts: 3,
        },
      ],
    };

    const result = formatDeliveryQueueOutput(data, true);
    expect(result).toContain("Delivery Queue Status");
    expect(result).toContain("Failed Deliveries");
    expect(result).toContain("abc12345");
    expect(result).toContain("myagent");
    expect(result).toContain("rate limited");
  });

  it("formats all-zero stats correctly", () => {
    const data: DeliveryQueueResponse = {
      stats: { pending: 0, inFlight: 0, failed: 0, delivered: 0, totalEnqueued: 0 },
      failed: [],
    };

    const result = formatDeliveryQueueOutput(data, false);
    expect(result).toContain("Pending:        0");
    expect(result).toContain("In Flight:      0");
    expect(result).toContain("Failed:         0");
    expect(result).toContain("Delivered:      0");
    expect(result).toContain("Total Enqueued: 0");
  });

  it("shows no failed entries table when showFailed is true but array is empty", () => {
    const data: DeliveryQueueResponse = {
      stats: { pending: 0, inFlight: 0, failed: 0, delivered: 10, totalEnqueued: 10 },
      failed: [],
    };

    const result = formatDeliveryQueueOutput(data, true);
    expect(result).toContain("Delivery Queue Status");
    expect(result).not.toContain("Failed Deliveries");
  });

  it("truncates long error messages in failed entries", () => {
    const data: DeliveryQueueResponse = {
      stats: { pending: 0, inFlight: 0, failed: 1, delivered: 0, totalEnqueued: 1 },
      failed: [
        {
          id: "xyz98765432",
          agentName: "agent1",
          channelId: "ch99999999",
          content: "test",
          lastError: "This is a very long error message that should be truncated because it exceeds forty characters",
          createdAt: new Date(Date.now() - 3600_000).toISOString(),
          attempts: 3,
        },
      ],
    };

    const result = formatDeliveryQueueOutput(data, true);
    expect(result).toContain("xyz98765");
    expect(result).toContain("agent1");
  });
});
