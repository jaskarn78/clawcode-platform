/**
 * Phase 61 Plan 01 Task 1 -- Trigger source config schema tests.
 *
 * Validates Zod schemas for all four Phase 61 trigger source types:
 * MySQL, webhook, inbox, and calendar. Each schema must parse valid
 * configs, reject invalid configs, and apply correct defaults.
 */

import { describe, it, expect } from "vitest";

import {
  mysqlTriggerSourceSchema,
  webhookTriggerSourceSchema,
  inboxTriggerSourceSchema,
  calendarTriggerSourceSchema,
  triggerSourcesConfigSchema,
  triggersConfigSchema,
} from "../schema.js";

// ---------------------------------------------------------------------------
// MySQL trigger source schema
// ---------------------------------------------------------------------------

describe("mysqlTriggerSourceSchema", () => {
  it("parses valid config with all fields", () => {
    const result = mysqlTriggerSourceSchema.parse({
      table: "pipeline_clients",
      idColumn: "id",
      pollIntervalMs: 30000,
      targetAgent: "acquisition",
      batchSize: 100,
    });
    expect(result.table).toBe("pipeline_clients");
    expect(result.idColumn).toBe("id");
    expect(result.pollIntervalMs).toBe(30000);
    expect(result.targetAgent).toBe("acquisition");
    expect(result.batchSize).toBe(100);
  });

  it("rejects missing table or targetAgent", () => {
    expect(() =>
      mysqlTriggerSourceSchema.parse({ targetAgent: "acquisition" }),
    ).toThrow();
    expect(() =>
      mysqlTriggerSourceSchema.parse({ table: "pipeline_clients" }),
    ).toThrow();
  });

  it("applies defaults (pollIntervalMs=30000, idColumn='id', batchSize=100)", () => {
    const result = mysqlTriggerSourceSchema.parse({
      table: "pipeline_clients",
      targetAgent: "acquisition",
    });
    expect(result.pollIntervalMs).toBe(30000);
    expect(result.idColumn).toBe("id");
    expect(result.batchSize).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Webhook trigger source schema
// ---------------------------------------------------------------------------

describe("webhookTriggerSourceSchema", () => {
  it("parses valid config with all fields", () => {
    const result = webhookTriggerSourceSchema.parse({
      triggerId: "gh-push",
      secret: "hmac-secret-here",
      targetAgent: "studio",
      maxBodyBytes: 65536,
    });
    expect(result.triggerId).toBe("gh-push");
    expect(result.secret).toBe("hmac-secret-here");
    expect(result.targetAgent).toBe("studio");
    expect(result.maxBodyBytes).toBe(65536);
  });

  it("rejects missing triggerId, secret, or targetAgent", () => {
    expect(() =>
      webhookTriggerSourceSchema.parse({
        secret: "s",
        targetAgent: "a",
      }),
    ).toThrow();
    expect(() =>
      webhookTriggerSourceSchema.parse({
        triggerId: "t",
        targetAgent: "a",
      }),
    ).toThrow();
    expect(() =>
      webhookTriggerSourceSchema.parse({
        triggerId: "t",
        secret: "s",
      }),
    ).toThrow();
  });

  it("applies maxBodyBytes default of 65536", () => {
    const result = webhookTriggerSourceSchema.parse({
      triggerId: "gh-push",
      secret: "hmac-secret-here",
      targetAgent: "studio",
    });
    expect(result.maxBodyBytes).toBe(65536);
  });
});

// ---------------------------------------------------------------------------
// Inbox trigger source schema
// ---------------------------------------------------------------------------

describe("inboxTriggerSourceSchema", () => {
  it("parses valid config", () => {
    const result = inboxTriggerSourceSchema.parse({
      targetAgent: "playground",
      stabilityThresholdMs: 500,
    });
    expect(result.targetAgent).toBe("playground");
    expect(result.stabilityThresholdMs).toBe(500);
  });

  it("applies stabilityThresholdMs default of 500", () => {
    const result = inboxTriggerSourceSchema.parse({
      targetAgent: "playground",
    });
    expect(result.stabilityThresholdMs).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Calendar trigger source schema
// ---------------------------------------------------------------------------

describe("calendarTriggerSourceSchema", () => {
  it("parses valid config with all fields", () => {
    const result = calendarTriggerSourceSchema.parse({
      user: "owner_a",
      targetAgent: "studio",
      pollIntervalMs: 300000,
      offsetMs: 900000,
      mcpServer: "google-workspace",
    });
    expect(result.user).toBe("owner_a");
    expect(result.targetAgent).toBe("studio");
    expect(result.pollIntervalMs).toBe(300000);
    expect(result.offsetMs).toBe(900000);
    expect(result.mcpServer).toBe("google-workspace");
  });

  it("applies defaults (pollIntervalMs=300000, offsetMs=900000, calendarId='primary', maxResults=50, eventRetentionDays=7)", () => {
    const result = calendarTriggerSourceSchema.parse({
      user: "owner_a",
      targetAgent: "studio",
      mcpServer: "google-workspace",
    });
    expect(result.pollIntervalMs).toBe(300000);
    expect(result.offsetMs).toBe(900000);
    expect(result.calendarId).toBe("primary");
    expect(result.maxResults).toBe(50);
    expect(result.eventRetentionDays).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Aggregate trigger sources config schema
// ---------------------------------------------------------------------------

describe("triggerSourcesConfigSchema", () => {
  it("is an optional object with mysql, webhook, inbox, calendar arrays", () => {
    // Parse empty object -- arrays default to []
    const empty = triggerSourcesConfigSchema!.parse({})!;
    expect(empty!.mysql).toEqual([]);
    expect(empty!.webhook).toEqual([]);
    expect(empty!.inbox).toEqual([]);
    expect(empty!.calendar).toEqual([]);

    // Parse with items
    const populated = triggerSourcesConfigSchema!.parse({
      mysql: [{ table: "t", targetAgent: "a" }],
      webhook: [{ triggerId: "t", secret: "s", targetAgent: "a" }],
      inbox: [{ targetAgent: "b" }],
      calendar: [{ user: "u", targetAgent: "c", mcpServer: "gw" }],
    })!;
    expect(populated!.mysql).toHaveLength(1);
    expect(populated!.webhook).toHaveLength(1);
    expect(populated!.inbox).toHaveLength(1);
    expect(populated!.calendar).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// triggersConfigSchema includes sources sub-object
// ---------------------------------------------------------------------------

describe("triggersConfigSchema", () => {
  it("includes sources sub-object alongside existing replayMaxAgeMs and defaultDebounceMs", () => {
    const result = triggersConfigSchema!.parse({
      replayMaxAgeMs: 86400000,
      defaultDebounceMs: 5000,
      sources: {
        mysql: [{ table: "t", targetAgent: "a" }],
      },
    });
    expect(result!.replayMaxAgeMs).toBe(86400000);
    expect(result!.defaultDebounceMs).toBe(5000);
    expect(result!.sources!.mysql).toHaveLength(1);
  });

  it("still works without sources (backward-compatible)", () => {
    const result = triggersConfigSchema!.parse({});
    expect(result!.replayMaxAgeMs).toBe(86400000);
    expect(result!.defaultDebounceMs).toBe(5000);
    expect(result!.sources).toBeUndefined();
  });
});
