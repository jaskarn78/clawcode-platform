/**
 * Phase 62 Plan 02 — PolicyWatcher tests.
 *
 * Tests the chokidar-based hot-reload watcher for policies.yaml with
 * debounced reload, atomic PolicyEvaluator swap, error recovery, and
 * JSONL audit trail.
 *
 * Uses real temp files in os.tmpdir() for integration-style tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import { PolicyWatcher, type PolicyWatcherOptions } from "../policy-watcher.js";
import { PolicyEvaluator } from "../policy-evaluator.js";
import { PolicyValidationError } from "../policy-loader.js";
import type { PolicyDiff } from "../policy-differ.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLog = pino({ level: "silent" });

const VALID_POLICY_YAML = `
version: 1
rules:
  - id: rule-one
    target: agent-alpha
    payload: "Event from {{event.sourceId}}"
    priority: 10
    source:
      kind: "mysql"
`;

const VALID_POLICY_YAML_V2 = `
version: 1
rules:
  - id: rule-one
    target: agent-alpha
    payload: "Updated payload from {{event.sourceId}}"
    priority: 20
    source:
      kind: "mysql"
  - id: rule-two
    target: agent-beta
    payload: "New rule"
    priority: 5
`;

const INVALID_POLICY_YAML = `
rules:
  - id: 123
    target: agent-alpha
`;

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "policy-watcher-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// start() — boot behavior
// ---------------------------------------------------------------------------

describe("PolicyWatcher", () => {
  describe("start()", () => {
    it("reads and parses policies.yaml, returns initial PolicyEvaluator", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "audit", "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onReload = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload,
        log: silentLog,
        configuredAgents: new Set(["agent-alpha"]),
      });

      const evaluator = await watcher.start();
      expect(evaluator).toBeInstanceOf(PolicyEvaluator);

      // The evaluator should work — evaluate an event matching rule-one
      const result = evaluator.evaluate({
        sourceId: "db-poller",
        idempotencyKey: "k1",
        targetAgent: "agent-alpha",
        payload: {},
        timestamp: Date.now(),
        sourceKind: "mysql",
      });
      expect(result.allow).toBe(true);

      await watcher.stop();
    });

    it("throws PolicyValidationError on invalid policies.yaml (boot rejection per POL-01)", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, INVALID_POLICY_YAML, "utf-8");

      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload: vi.fn(),
        log: silentLog,
      });

      await expect(watcher.start()).rejects.toThrow(PolicyValidationError);
      // Verify error message contains FATAL boot rejection text
      await expect(watcher.start()).rejects.toThrow(/FATAL.*policies\.yaml invalid/);
    });

    it("starts with empty rules when policies.yaml does not exist", async () => {
      const policyPath = join(tempDir, "nonexistent-policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");

      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload: vi.fn(),
        log: silentLog,
        configuredAgents: new Set(["agent-alpha"]),
      });

      const evaluator = await watcher.start();
      expect(evaluator).toBeInstanceOf(PolicyEvaluator);

      // With no rules, any event should be denied
      const result = evaluator.evaluate({
        sourceId: "src",
        idempotencyKey: "k1",
        targetAgent: "agent-alpha",
        payload: {},
        timestamp: Date.now(),
      });
      expect(result.allow).toBe(false);

      await watcher.stop();
    });

    it("writes boot audit entry on successful start", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload: vi.fn(),
        log: silentLog,
      });

      await watcher.start();

      const auditContent = await readFile(auditPath, "utf-8");
      const entry = JSON.parse(auditContent.trim());
      expect(entry.action).toBe("boot");
      expect(entry.status).toBe("success");
      expect(entry.timestamp).toBeTypeOf("string");
      expect(entry.diff).toBeNull();

      await watcher.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Hot-reload behavior
  // -------------------------------------------------------------------------

  describe("hot-reload", () => {
    it("valid YAML change triggers onReload with new PolicyEvaluator and diff", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onReload = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload,
        log: silentLog,
        debounceMs: 50,
        configuredAgents: new Set(["agent-alpha", "agent-beta"]),
      });

      await watcher.start();

      // Write updated policy
      await writeFile(policyPath, VALID_POLICY_YAML_V2, "utf-8");

      // Wait for debounce + file read
      await vi.waitFor(() => {
        expect(onReload).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      const [newEvaluator, diff] = onReload.mock.calls[0]!;
      expect(newEvaluator).toBeInstanceOf(PolicyEvaluator);
      expect(diff.added).toContain("rule-two");
      expect(diff.modified).toContain("rule-one");

      await watcher.stop();
    });

    it("invalid YAML change keeps old evaluator and calls onError", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onReload = vi.fn();
      const onError = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload,
        onError,
        log: silentLog,
        debounceMs: 50,
        configuredAgents: new Set(["agent-alpha"]),
      });

      const initialEvaluator = await watcher.start();

      // Write invalid policy
      await writeFile(policyPath, INVALID_POLICY_YAML, "utf-8");

      // Wait for debounce + file read
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      // onReload should NOT have been called
      expect(onReload).not.toHaveBeenCalled();

      // Current evaluator should still be the old one
      expect(watcher.getCurrentEvaluator()).toBe(initialEvaluator);

      await watcher.stop();
    });

    it("getCurrentEvaluator returns the latest evaluator after reload", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onReload = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload,
        log: silentLog,
        debounceMs: 50,
        configuredAgents: new Set(["agent-alpha", "agent-beta"]),
      });

      const initial = await watcher.start();

      await writeFile(policyPath, VALID_POLICY_YAML_V2, "utf-8");

      await vi.waitFor(() => {
        expect(onReload).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      const current = watcher.getCurrentEvaluator();
      expect(current).not.toBe(initial);
      expect(current).toBe(onReload.mock.calls[0]![0]);

      await watcher.stop();
    });
  });

  // -------------------------------------------------------------------------
  // JSONL audit trail
  // -------------------------------------------------------------------------

  describe("audit trail", () => {
    it("reload writes JSONL entry with diff on success", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onReload = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload,
        log: silentLog,
        debounceMs: 50,
        configuredAgents: new Set(["agent-alpha", "agent-beta"]),
      });

      await watcher.start();

      await writeFile(policyPath, VALID_POLICY_YAML_V2, "utf-8");

      await vi.waitFor(() => {
        expect(onReload).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      const auditContent = await readFile(auditPath, "utf-8");
      const lines = auditContent.trim().split("\n");
      // Line 0 = boot entry, line 1 = reload entry
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const reloadEntry = JSON.parse(lines[1]!);
      expect(reloadEntry.action).toBe("reload");
      expect(reloadEntry.status).toBe("success");
      expect(reloadEntry.diff).toBeDefined();
      expect(reloadEntry.diff.added).toContain("rule-two");

      await watcher.stop();
    });

    it("failed reload writes JSONL entry with error status", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onError = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload: vi.fn(),
        onError,
        log: silentLog,
        debounceMs: 50,
      });

      await watcher.start();

      await writeFile(policyPath, INVALID_POLICY_YAML, "utf-8");

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      const auditContent = await readFile(auditPath, "utf-8");
      const lines = auditContent.trim().split("\n");
      const errorEntry = JSON.parse(lines[lines.length - 1]!);
      expect(errorEntry.action).toBe("reload");
      expect(errorEntry.status).toBe("error");
      expect(errorEntry.error).toBeTypeOf("string");
      expect(errorEntry.error.length).toBeGreaterThan(0);

      await watcher.stop();
    });

    it("creates parent directory for audit file on first write", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "deep", "nested", "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload: vi.fn(),
        log: silentLog,
      });

      await watcher.start();

      // Boot audit entry should have created the nested directory
      const auditContent = await readFile(auditPath, "utf-8");
      expect(auditContent.trim().length).toBeGreaterThan(0);

      await watcher.stop();
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe("stop()", () => {
    it("closes chokidar watcher and clears debounce timer", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onReload = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload,
        log: silentLog,
        debounceMs: 5000, // Long debounce to prove it gets cleared
        configuredAgents: new Set(["agent-alpha"]),
      });

      await watcher.start();

      // Write change (will start debounce timer)
      await writeFile(policyPath, VALID_POLICY_YAML_V2, "utf-8");

      // Stop immediately before debounce fires
      await watcher.stop();

      // Wait a bit to confirm reload did NOT fire
      await new Promise((r) => setTimeout(r, 200));
      expect(onReload).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Debounce
  // -------------------------------------------------------------------------

  describe("debounce", () => {
    it("rapid changes within debounceMs result in single reload", async () => {
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onReload = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload,
        log: silentLog,
        debounceMs: 200,
        configuredAgents: new Set(["agent-alpha", "agent-beta"]),
      });

      await watcher.start();

      // Rapid-fire writes
      await writeFile(policyPath, VALID_POLICY_YAML_V2, "utf-8");
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(policyPath, VALID_POLICY_YAML_V2, "utf-8");
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(policyPath, VALID_POLICY_YAML_V2, "utf-8");

      // Wait for debounce to settle
      await vi.waitFor(() => {
        expect(onReload).toHaveBeenCalled();
      }, { timeout: 3000 });

      // Should have been called only once (debounced)
      expect(onReload).toHaveBeenCalledTimes(1);

      await watcher.stop();
    });
  });

  // -------------------------------------------------------------------------
  // getCurrentEvaluator
  // -------------------------------------------------------------------------

  describe("getCurrentEvaluator()", () => {
    it("throws if start() has not been called", () => {
      const watcher = new PolicyWatcher({
        policyPath: "/nonexistent",
        auditPath: "/nonexistent",
        onReload: vi.fn(),
        log: silentLog,
      });

      expect(() => watcher.getCurrentEvaluator()).toThrow(/not started/i);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 999.13 — DELEG reload regression (Phase 999.11 fix)
  //
  // PolicyWatcher's `configuredAgents: Set<string>` is built from the
  // operator's clawcode.yaml. The new `delegates` agentSchema field MUST
  // not affect the policy reload path — the Set still contains plain agent
  // names. This test pins the regression: a configSchema-validated config
  // with at least one agent declaring `delegates` produces a healthy
  // configuredAgents Set, and the watcher reloads cleanly through it.
  //
  // RED on main because configSchema doesn't accept `delegates` yet
  // (parse fails → can't build the Set → regression test fails).
  // -------------------------------------------------------------------------
  describe("Phase 999.13 — DELEG reload regression", () => {
    it("reload-with-delegates: a config with agents declaring `delegates` produces a healthy configuredAgents Set and reload succeeds", async () => {
      // Lazy import so this test file still loads on main even before
      // Plan 01 ships the schema changes.
      const { configSchema } = await import("../../config/schema.js");

      const cfgInput = {
        version: 1,
        agents: [
          // Agent with delegates pointing at a real configured agent.
          // Plain object literal — zod strips unknown keys today; Plan 01
          // adds the field so the parsed `delegates` survives.
          {
            name: "agent-alpha",
            delegates: { research: "research" },
          },
          { name: "agent-beta" },
          { name: "research" },
        ],
      };

      const parseResult = configSchema.safeParse(cfgInput);
      expect(parseResult.success).toBe(true);
      if (!parseResult.success) return;

      // Sanity: delegates field is preserved on the resolved data (zod
      // strips unknown keys by default — so on main this assertion fails).
      // Plan 01 ships the schema field which makes this pass.
      const alpha = parseResult.data.agents.find(
        (a) => a.name === "agent-alpha",
      );
      // Phase 999.13 GREEN — delegates field is on AgentConfig now.
      expect(alpha?.delegates).toEqual({ research: "research" });

      // Build the configuredAgents Set the way the daemon does.
      const configuredAgents = new Set(
        parseResult.data.agents.map((a) => a.name),
      );
      expect(configuredAgents.has("agent-alpha")).toBe(true);
      expect(configuredAgents.has("research")).toBe(true);

      // Verify the watcher reloads cleanly with this Set.
      const policyPath = join(tempDir, "policies.yaml");
      const auditPath = join(tempDir, "policy-audit.jsonl");
      await writeFile(policyPath, VALID_POLICY_YAML, "utf-8");

      const onReload = vi.fn();
      const watcher = new PolicyWatcher({
        policyPath,
        auditPath,
        onReload,
        log: silentLog,
        debounceMs: 50,
        configuredAgents,
      });

      await watcher.start();

      await writeFile(policyPath, VALID_POLICY_YAML_V2, "utf-8");

      await vi.waitFor(
        () => {
          expect(onReload).toHaveBeenCalledTimes(1);
        },
        { timeout: 3000 },
      );

      const [newEvaluator] = onReload.mock.calls[0]!;
      expect(newEvaluator).toBeInstanceOf(PolicyEvaluator);

      await watcher.stop();
    });
  });
});
