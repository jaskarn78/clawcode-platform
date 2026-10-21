import { describe, it, expect } from "vitest";
import { configSchema, agentSchema, scheduleEntrySchema } from "../../config/schema.js";

describe("scheduleEntrySchema", () => {
  it("validates a valid cron expression entry", () => {
    const result = scheduleEntrySchema.safeParse({
      name: "daily-report",
      cron: "0 9 * * *",
      prompt: "Generate the daily summary report",
      enabled: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("daily-report");
      expect(result.data.cron).toBe("0 9 * * *");
      expect(result.data.prompt).toBe("Generate the daily summary report");
      expect(result.data.enabled).toBe(true);
    }
  });

  it("validates an interval string entry", () => {
    const result = scheduleEntrySchema.safeParse({
      name: "check-status",
      cron: "every 30m",
      prompt: "Check system status",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cron).toBe("every 30m");
    }
  });

  it("rejects entry missing required name field", () => {
    const result = scheduleEntrySchema.safeParse({
      cron: "0 9 * * *",
      prompt: "Do something",
    });

    expect(result.success).toBe(false);
  });

  it("rejects entry missing required prompt field", () => {
    const result = scheduleEntrySchema.safeParse({
      name: "task",
      cron: "0 9 * * *",
    });

    expect(result.success).toBe(false);
  });

  it("rejects entry missing required cron field", () => {
    const result = scheduleEntrySchema.safeParse({
      name: "task",
      prompt: "Do something",
    });

    expect(result.success).toBe(false);
  });

  it("defaults enabled to true when omitted", () => {
    const result = scheduleEntrySchema.safeParse({
      name: "task",
      cron: "0 */6 * * *",
      prompt: "Run every 6 hours",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });
});

describe("agentSchema with schedules", () => {
  it("parses agent with schedules array", () => {
    const result = agentSchema.safeParse({
      name: "researcher",
      schedules: [
        {
          name: "daily-report",
          cron: "0 9 * * *",
          prompt: "Generate daily report",
          enabled: true,
        },
        {
          name: "check-news",
          cron: "0 */2 * * *",
          prompt: "Check latest news",
          enabled: false,
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schedules).toHaveLength(2);
      expect(result.data.schedules[0].name).toBe("daily-report");
      expect(result.data.schedules[1].enabled).toBe(false);
    }
  });

  it("defaults schedules to empty array when omitted", () => {
    const result = agentSchema.safeParse({
      name: "minimal-agent",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schedules).toEqual([]);
    }
  });
});
