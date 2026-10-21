/**
 * Phase 130 Plan 03 T-03 — SLD-01 integration test.
 *
 * Asserts the end-to-end behavior:
 *   (a) A skill declaring `requiredMcpServers: [<missing>]` is REFUSED by
 *       `loadSkillManifest` (Plan 02 chokepoint).
 *   (b) The refusal produces an `UnloadedSkillEntry` that flows into
 *       `notifyUnloadedSkills` (Plan 03 T-01).
 *   (c) `webhookManager.send` is called ONCE per agent (batched) with a
 *       message matching the expected format.
 *   (d) The `unloadedSkills` map exposed to the CLI surface (Plan 03 T-02
 *       via `formatAgentSkillsStatus`) renders the skill with the
 *       refused-mcp-missing emoji + label.
 *   (e) Fire-and-forget contract — `notifyUnloadedSkills` returns void
 *       synchronously even if `webhookManager.send` rejects.
 *
 * Integration boundary: we exercise the real `loadSkillManifest`,
 * `notifyUnloadedSkills`, and `formatAgentSkillsStatus` modules against
 * a tmp fixture skill + a fake WebhookManager. Daemon boot ordering is
 * NOT exercised end-to-end (out of scope for unit-test surface — Plan
 * 02's daemon wiring already has the static `grep -c = 1` chokepoint
 * assertion).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSkillManifest,
  type UnloadedSkillEntry,
} from "../skill-loader.js";
import { notifyUnloadedSkills } from "../skill-load-notifier.js";
import { formatAgentSkillsStatus } from "../../cli/commands/skills.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase130-sld-01-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const MISSING_MCP_MANIFEST = `---
name: nonexistent-mcp-skill
description: A skill that requires the nonexistent-mcp server which is not enabled
version: 1.0.0
owner: admin-clawdy
capabilities:
  - mcp-tool-use
requiredTools: []
requiredMcpServers:
  - nonexistent-mcp
---

# Body
`;

describe("Phase 130 Plan 03 T-03 — SLD-01 end-to-end refusal + Discord + CLI", () => {
  it("SLD-01: refused skill → Discord notification + CLI status + correct UnloadedSkillEntry", () => {
    // Silence the loader's structured-log noise.
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // (1) Set up the fixture skill — requires `nonexistent-mcp`, but the
    //     agent has only `1password` enabled.
    const skillDir = path.join(tmpRoot, "nonexistent-mcp-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), MISSING_MCP_MANIFEST);

    // (2) Loader refuses the skill (Plan 02 chokepoint exercised verbatim).
    const result = loadSkillManifest(skillDir, ["1password"]);
    expect(result.status).toBe("refused-mcp-missing");
    if (result.status !== "refused-mcp-missing") {
      throw new Error("unreachable");
    }
    expect(result.missingMcp).toEqual(["nonexistent-mcp"]);

    // (3) Build the per-agent unloadedSkills entry that the daemon's
    //     loop would have produced (matches the inline construction at
    //     daemon.ts:2480-2490).
    const unloaded: UnloadedSkillEntry = {
      name: "nonexistent-mcp-skill",
      status: result.status,
      reason: result.reason,
      missingMcp: [...result.missingMcp],
    };
    const unloadedSkillsByAgent = new Map<
      string,
      readonly UnloadedSkillEntry[]
    >([["test-agent", [unloaded]]]);

    // (4) Fake WebhookManager — captures send() calls. hasWebhook returns
    //     true so notifyUnloadedSkills proceeds to send.
    const sendCalls: Array<{ agent: string; content: string }> = [];
    const fakeWebhookManager = {
      hasWebhook: vi.fn(() => true),
      send: vi.fn(async (agent: string, content: string) => {
        sendCalls.push({ agent, content });
      }),
    };

    // (5) Drive Plan 03 T-01 notification — fire-and-forget.
    notifyUnloadedSkills({
      unloadedSkillsByAgent,
      webhookManager: fakeWebhookManager as unknown as Parameters<
        typeof notifyUnloadedSkills
      >[0]["webhookManager"],
    });

    // (6) Assertion (c) — exactly ONE send call (batched), correct content.
    expect(fakeWebhookManager.send).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.agent).toBe("test-agent");
    expect(sendCalls[0]!.content).toMatch(
      /⚠️ unloaded skills:.*nonexistent-mcp-skill.*missing MCP:.*nonexistent-mcp/,
    );

    // (7) Assertion (d) — CLI surface renders the same entry with the
    //     refused-mcp-missing emoji + the missing MCP server in detail.
    const cliTable = formatAgentSkillsStatus(
      "test-agent",
      ["nonexistent-mcp-skill", "other-loaded-skill"],
      [unloaded],
    );
    expect(cliTable).toContain("⛔ nonexistent-mcp-skill [refused-mcp-missing: nonexistent-mcp]");
    expect(cliTable).toContain("✅ other-loaded-skill [loaded]");

    // (8) Assertion (e) — the function returned synchronously; verify by
    //     observing that we reached this point with `send` still pending
    //     resolution (vitest's microtask queue runs after this assertion).
    //     We've already asserted the call was made (synchronous side-effect
    //     before the promise resolves), so the fire-and-forget contract is
    //     pinned.
  });

  it("SLD-01b: webhookManager.send rejection does NOT throw out of notifyUnloadedSkills", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const skillDir = path.join(tmpRoot, "rejection-test-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), MISSING_MCP_MANIFEST);

    const result = loadSkillManifest(skillDir, []);
    if (result.status !== "refused-mcp-missing") throw new Error("unreachable");

    const unloadedSkillsByAgent = new Map<
      string,
      readonly UnloadedSkillEntry[]
    >([
      [
        "test-agent",
        [
          {
            name: "rejection-test-skill",
            status: result.status,
            missingMcp: [...result.missingMcp],
          },
        ],
      ],
    ]);

    const fakeWebhookManager = {
      hasWebhook: vi.fn(() => true),
      send: vi.fn(async () => {
        throw new Error("simulated webhook failure");
      }),
    };

    // No throw out of the synchronous call — fire-and-forget contract.
    expect(() =>
      notifyUnloadedSkills({
        unloadedSkillsByAgent,
        webhookManager: fakeWebhookManager as unknown as Parameters<
          typeof notifyUnloadedSkills
        >[0]["webhookManager"],
      }),
    ).not.toThrow();

    // Drain microtasks so the `.catch(...)` handler runs.
    await new Promise((r) => setImmediate(r));

    // The catch handler emits a console.warn with the structured key.
    const hadFailLog = warnSpy.mock.calls.some(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "phase130-skill-load-notify-failed",
    );
    expect(hadFailLog).toBe(true);
  });

  it("SLD-01c: no webhook configured → notifyUnloadedSkills logs a skipped warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const unloadedSkillsByAgent = new Map<
      string,
      readonly UnloadedSkillEntry[]
    >([
      [
        "agent-without-webhook",
        [
          {
            name: "some-skill",
            status: "refused-mcp-missing",
            missingMcp: ["missing-mcp"],
          },
        ],
      ],
    ]);

    const fakeWebhookManager = {
      hasWebhook: vi.fn(() => false),
      send: vi.fn(),
    };

    notifyUnloadedSkills({
      unloadedSkillsByAgent,
      webhookManager: fakeWebhookManager as unknown as Parameters<
        typeof notifyUnloadedSkills
      >[0]["webhookManager"],
    });

    expect(fakeWebhookManager.send).not.toHaveBeenCalled();
    const hadSkipLog = warnSpy.mock.calls.some(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === "phase130-skill-load-notify-skipped",
    );
    expect(hadSkipLog).toBe(true);
  });
});
