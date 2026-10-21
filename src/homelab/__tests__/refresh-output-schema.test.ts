// src/homelab/__tests__/refresh-output-schema.test.ts
//
// Phase 999.47 Plan 02 Task 1 — frozen `.refresh-last.json` contract tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { refreshOutputSchema } from "../refresh-output-schema.js";
import { loadConfig } from "../../config/loader.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function happyPathPayload() {
  return {
    schemaVersion: 1 as const,
    ranAt: "2026-05-15T18:00:00.000Z",
    ok: true,
    commitsha: "abc1234abcdef",
    noDiff: false,
    counts: {
      hostCount: 6,
      vmCount: 4,
      containerCount: 2,
      driftCount: 1,
      tunnelCount: 3,
      dnsCount: 5,
    },
    failureReason: null,
    consecutiveFailures: 0,
  };
}

describe("refreshOutputSchema", () => {
  it("Test 1: parses a valid happy-path payload", () => {
    const parsed = refreshOutputSchema.safeParse(happyPathPayload());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ok).toBe(true);
      expect(parsed.data.counts.hostCount).toBe(6);
      expect(parsed.data.counts.driftCount).toBe(1);
      expect(parsed.data.commitsha).toBe("abc1234abcdef");
    }
  });

  it("Test 2: rejects missing counts.driftCount", () => {
    const bad = happyPathPayload() as unknown as Record<string, unknown>;
    delete (bad.counts as Record<string, unknown>).driftCount;
    const parsed = refreshOutputSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const flat = parsed.error.issues.map((i) => i.path.join("."));
      expect(flat.some((p) => p.includes("counts") && p.includes("driftCount"))).toBe(true);
    }
  });

  it("Test 3: rejects negative counts (hostCount: -1)", () => {
    const bad = happyPathPayload();
    bad.counts.hostCount = -1;
    const parsed = refreshOutputSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("Test 4: rejects ok=false with null failureReason (D-04c never-silent)", () => {
    const bad = {
      ...happyPathPayload(),
      ok: false,
      failureReason: null,
      consecutiveFailures: 0,
    };
    const parsed = refreshOutputSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msgs = parsed.error.issues.map((i) => i.message).join("\n");
      expect(msgs).toMatch(/failureReason/);
    }
  });

  it("Test 4b: rejects ok=false with empty-string failureReason", () => {
    const bad = {
      ...happyPathPayload(),
      ok: false,
      failureReason: "",
      consecutiveFailures: 1,
    };
    const parsed = refreshOutputSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("Test 4c: accepts ok=false with non-empty failureReason", () => {
    const ok = {
      ...happyPathPayload(),
      ok: false,
      failureReason: "tailscale-unreachable",
      consecutiveFailures: 3,
    };
    const parsed = refreshOutputSchema.safeParse(ok);
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty object", () => {
    const parsed = refreshOutputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("rejects schemaVersion != 1", () => {
    const bad = { ...happyPathPayload(), schemaVersion: 2 };
    const parsed = refreshOutputSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });
});

describe("defaults.homelab config block", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "homelab-cfg-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Test 5: clawcode.yaml with valid defaults.homelab block resolves", async () => {
    const yamlPath = join(tempDir, "clawcode.yaml");
    writeFileSync(
      yamlPath,
      [
        "version: 1",
        "defaults:",
        "  homelab:",
        "    enabled: true",
        "    refreshIntervalMinutes: 60",
        '    repoPath: "/home/clawcode/homelab"',
        "agents:",
        "  - name: test-agent",
        "    channels: []",
        "    workspace: " + tempDir,
        "    model: sonnet",
        "    effort: low",
        "    skills: []",
        "    schedules: []",
        "    mcpServers: []",
        "    slashCommands: []",
        "",
      ].join("\n"),
    );
    const config = await loadConfig(yamlPath);
    expect(config.defaults.homelab).toBeDefined();
    expect(config.defaults.homelab?.refreshIntervalMinutes).toBe(60);
    expect(config.defaults.homelab?.repoPath).toBe("/home/clawcode/homelab");
    expect(config.defaults.homelab?.enabled).toBe(true);
  });

  it("Test 5b: rejects refreshIntervalMinutes: 0 (must be >= 5)", async () => {
    const yamlPath = join(tempDir, "clawcode.yaml");
    writeFileSync(
      yamlPath,
      [
        "version: 1",
        "defaults:",
        "  homelab:",
        "    refreshIntervalMinutes: 0",
        "agents:",
        "  - name: test-agent",
        "    channels: []",
        "    workspace: " + tempDir,
        "    model: sonnet",
        "    effort: low",
        "    skills: []",
        "    schedules: []",
        "    mcpServers: []",
        "    slashCommands: []",
        "",
      ].join("\n"),
    );
    await expect(loadConfig(yamlPath)).rejects.toThrow();
  });

  it("defaults.homelab is optional — config without it parses unchanged", async () => {
    const yamlPath = join(tempDir, "clawcode.yaml");
    writeFileSync(
      yamlPath,
      [
        "version: 1",
        "agents:",
        "  - name: test-agent",
        "    channels: []",
        "    workspace: " + tempDir,
        "    model: sonnet",
        "    effort: low",
        "    skills: []",
        "    schedules: []",
        "    mcpServers: []",
        "    slashCommands: []",
        "",
      ].join("\n"),
    );
    const config = await loadConfig(yamlPath);
    // homelab can be undefined (no `defaults.homelab` block in yaml)
    // or it may default to a populated structure depending on schema shape.
    // Either way must not throw and must not crash callers reading `.homelab`.
    expect(() => config.defaults.homelab).not.toThrow();
  });
});

