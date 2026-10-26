import { describe, it, expect } from "vitest";
import { buildCapabilityManifest, buildMemoryProtocol } from "../capability-manifest.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

/**
 * Phase 100 follow-up — capability manifest builder.
 *
 * The manifest is auto-injected into the system prompt so the LLM has
 * enabled features in context (avoiding the "I don't dream" failure mode
 * observed in fin-client on 2026-04-27). Pure function — reads only
 * from ResolvedAgentConfig (no I/O, no hallucination).
 */
function makeConfig(
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: "test-agent",
    workspace: "/tmp/test-workspace",
    memoryPath: "/tmp/test-workspace",
    channels: [],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    autoCompactAt: 0.7, // Phase 124 D-06
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: true,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"],
    autoStart: true, // Phase 100 follow-up
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: {
        enabled: true,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: true, similarityThreshold: 0.85 },
    },
    schedules: [],
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
    skillsPath: "/tmp/skills",
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 30, maxThreadSessions: 5 },
    reactions: false,
    slashCommands: [],
    mcpServers: [],
    ...overrides,
  };
}

describe("buildCapabilityManifest", () => {
  it("renders the start_workflow steering bullet when the clawcode MCP server is present", () => {
    const cfg = makeConfig({
      mcpServers: [
        { name: "clawcode", command: "clawcode", args: ["mcp"], env: {}, optional: false },
      ],
    });
    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("start_workflow");
    expect(manifest).toContain("/clawcode-workflows");
    expect(manifest).toContain("NEVER `/workflows`");
  });

  it("omits the start_workflow bullet when there is no clawcode MCP server", () => {
    // hasOptIn via a skill so the manifest still renders, but no clawcode server.
    const cfg = makeConfig({
      skills: ["subagent-thread"],
      mcpServers: [
        { name: "search", command: "x", args: [], env: {}, optional: true },
      ],
    });
    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).not.toContain("start_workflow");
  });

  it("CM-1: agent with all features enabled emits Memory dreaming + Scheduled tasks + Subagent threads + GSD bullets", () => {
    const cfg = makeConfig({
      dream: { enabled: true, idleMinutes: 30, model: "haiku" },
      schedules: [
        {
          name: "morning-standup",
          cron: "0 9 * * *",
          prompt: "say good morning",
          enabled: true,
        },
        {
          name: "weekly-review",
          cron: "0 17 * * 5",
          prompt: "review the week",
          enabled: true,
        },
      ],
      skills: ["subagent-thread"],
      gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Your ClawCode Capabilities");
    expect(manifest).toContain("Memory dreaming");
    expect(manifest).toContain("auto-fires every 30min idle");
    expect(manifest).toContain("model=haiku");
    expect(manifest).toContain("/clawcode-dream");
    expect(manifest).toContain("Scheduled tasks");
    expect(manifest).toContain("2"); // schedule count
    expect(manifest).toContain("Subagent threads");
    expect(manifest).toContain("spawn_subagent_thread");
    expect(manifest).toContain("GSD workflow");
    expect(manifest).toContain("/opt/clawcode-projects/sandbox");
  });

  it("CM-2: agent without dream config omits the dreaming bullet", () => {
    const cfg = makeConfig({
      dream: undefined,
      schedules: [
        {
          name: "tick",
          cron: "*/5 * * * *",
          prompt: "tick",
          enabled: true,
        },
      ],
    });

    const manifest = buildCapabilityManifest(cfg);
    // Manifest is non-empty (schedules present) but dreaming bullet omitted.
    expect(manifest).not.toContain("Memory dreaming");
    expect(manifest).toContain("Scheduled tasks");
  });

  it("CM-2b: agent with dream.enabled=false omits the dreaming bullet (operator opted out)", () => {
    const cfg = makeConfig({
      dream: { enabled: false, idleMinutes: 30, model: "haiku" },
      skills: ["subagent-thread"],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).not.toContain("Memory dreaming");
    // Subagent thread bullet still appears.
    expect(manifest).toContain("Subagent threads");
  });

  it("CM-3: agent with no schedules omits the scheduled-tasks bullet", () => {
    const cfg = makeConfig({
      dream: { enabled: true, idleMinutes: 30, model: "haiku" },
      schedules: [],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Memory dreaming");
    expect(manifest).not.toContain("Scheduled tasks");
  });

  // Memory overhaul 2026-10-25 (WP5) - CM-4 / CM-4b / CM-ADV-MINIMAL used
  // to pin "" for a minimal agent. The memory protocol is now emitted for
  // every agent, so a minimal agent gets exactly that section and nothing
  // else (no capabilities header, no bullets, no advisor block).
  it("CM-4: minimal agent (no features) returns only the memory protocol", () => {
    const cfg = makeConfig({
      dream: undefined,
      schedules: [],
      skills: [],
      gsd: undefined,
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toBe(buildMemoryProtocol(cfg).trimStart());
    expect(manifest.startsWith("## Memory protocol")).toBe(true);
    expect(manifest).not.toContain("Your ClawCode Capabilities");
  });

  it("CM-4b: agent with only memoryAutoLoad enabled (no dream/schedules/skills/gsd) still returns empty", () => {
    // Memory auto-load is the fleet-wide default — it's not "notable" enough
    // to bloat minimal agents' prompts. The manifest is for OPTED-IN features.
    const cfg = makeConfig({
      dream: undefined,
      schedules: [],
      skills: [],
      gsd: undefined,
      memoryAutoLoad: true,
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toBe(buildMemoryProtocol(cfg).trimStart());
  });

  it("CM-5: dream bullet uses the agent's actual idleMinutes + model (no hallucination)", () => {
    const cfg = makeConfig({
      dream: { enabled: true, idleMinutes: 90, model: "sonnet" },
      schedules: [],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("auto-fires every 90min idle");
    expect(manifest).toContain("model=sonnet");
  });

  it("CM-6: subagent thread bullet only appears when the skill is assigned", () => {
    const withoutSkill = buildCapabilityManifest(
      makeConfig({
        dream: { enabled: true, idleMinutes: 30, model: "haiku" },
        skills: [],
      }),
    );
    expect(withoutSkill).not.toContain("Subagent threads");

    const withSkill = buildCapabilityManifest(
      makeConfig({
        dream: { enabled: true, idleMinutes: 30, model: "haiku" },
        skills: ["subagent-thread"],
      }),
    );
    expect(withSkill).toContain("Subagent threads");
  });

  it("CM-7: GSD bullet only appears when gsd.projectDir is set", () => {
    const cfg = makeConfig({
      schedules: [
        {
          name: "tick",
          cron: "*/5 * * * *",
          prompt: "tick",
          enabled: true,
        },
      ],
      gsd: undefined,
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).not.toContain("GSD workflow");
  });

  // ---------------------------------------------------------------------------
  // Phase 100-fu — Tier 1 + Tier 2 manifest extension (2026-04-26)
  // ---------------------------------------------------------------------------

  it("CM-MCP-1: agent with mcpServers (description + accessPattern) → MCP servers bullet with annotations", () => {
    const cfg = makeConfig({
      mcpServers: [
        {
          name: "1password",
          command: "npx",
          args: [],
          env: {},
          optional: false,
          description: "secrets retrieval",
          accessPattern: "read-only",
        },
        {
          name: "acme-db",
          command: "mcporter",
          args: [],
          env: {},
          optional: false,
          description: "Postgres SELECT",
          accessPattern: "read-only",
        },
        {
          name: "playwright",
          command: "npx",
          args: [],
          env: {},
          optional: false,
          description: "browser automation",
          // accessPattern omitted on purpose — bullet should still render
        },
      ],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("MCP servers");
    expect(manifest).toContain("1password (secrets retrieval — read-only)");
    expect(manifest).toContain("acme-db (Postgres SELECT — read-only)");
    expect(manifest).toContain("playwright (browser automation)");
  });

  it("CM-MCP-2: mcpServer entries without description fall back to just the name", () => {
    const cfg = makeConfig({
      mcpServers: [
        {
          name: "clawcode",
          command: "clawcode",
          args: ["mcp"],
          env: {},
          optional: false,
          // no description, no accessPattern
        },
      ],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("MCP servers");
    expect(manifest).toContain("clawcode");
    // No qualifier in parens — bare name only.
    expect(manifest).not.toContain("clawcode (");
  });

  it("CM-SKILLS-1: agent with skills → manifest includes a Skills bullet", () => {
    const cfg = makeConfig({
      skills: ["subagent-thread", "memory-recall", "research", "synthesis"],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Skills");
    expect(manifest).toContain("subagent-thread");
    expect(manifest).toContain("memory-recall");
    expect(manifest).toContain("research");
    expect(manifest).toContain("synthesis");
  });

  it("CM-SKILLS-EMPTY: agent with empty skills → no Skills bullet", () => {
    const cfg = makeConfig({
      skills: [],
      // need something else opted-in so the manifest is non-empty
      gsd: { projectDir: "/tmp/p" },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).not.toMatch(/^- \*\*Skills\*\*:/m);
  });

  it("CM-MODEL-1: model + effort included", () => {
    const cfg = makeConfig({
      model: "opus",
      effort: "high",
      // ensure the manifest renders something so we can scan it
      gsd: { projectDir: "/tmp/p" },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("model=opus");
    expect(manifest).toContain("effort=high");
  });

  it("CM-CONV-1: 'Prior session summaries auto-resume' line present", () => {
    const cfg = makeConfig({
      gsd: { projectDir: "/tmp/p" },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Prior session summaries auto-resume");
    expect(manifest).toContain("Working memory of recent turns");
  });

  it("CM-FILE-1: fileAccess paths rendered when present", () => {
    const cfg = makeConfig({
      fileAccess: [
        "/home/clawcode/.clawcode/agents/test-agent/",
        "/srv/shared/acme/",
      ],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("File access");
    expect(manifest).toContain("/home/clawcode/.clawcode/agents/test-agent/");
    expect(manifest).toContain("/srv/shared/acme/");
  });

  it("CM-FILE-EMPTY: no fileAccess bullet when undefined or empty", () => {
    const cfg = makeConfig({
      fileAccess: undefined,
      gsd: { projectDir: "/tmp/p" },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).not.toMatch(/^- \*\*File access\*\*:/m);
  });

  it("CM-HEART-1: heartbeat enabled → renders 'every model' summary", () => {
    const cfg = makeConfig({
      heartbeat: {
        enabled: true,
        intervalSeconds: 60,
        checkTimeoutSeconds: 10,
        contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
        every: "50m",
        model: "haiku",
      } as ResolvedAgentConfig["heartbeat"],
      // Trigger non-empty manifest so the heartbeat bullet renders.
      gsd: { projectDir: "/tmp/p" },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Heartbeat");
    expect(manifest).toContain("50m");
    expect(manifest).toContain("haiku");
  });

  it("CM-HEART-DISABLED: heartbeat disabled → renders 'disabled'", () => {
    const cfg = makeConfig({
      heartbeat: {
        enabled: false,
        intervalSeconds: 60,
        checkTimeoutSeconds: 10,
        contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
      },
      gsd: { projectDir: "/tmp/p" },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Heartbeat");
    expect(manifest).toContain("disabled");
  });

  it("CM-RECUR-1: recursion guard sentence present", () => {
    const cfg = makeConfig({
      skills: ["subagent-thread"],
    });

    const manifest = buildCapabilityManifest(cfg);
    // The recursion-guard bullet ALWAYS renders (informational about how the
    // SDK enforces "subagents cannot spawn subagents").
    expect(manifest).toContain("recursion is impossible by design");
    expect(manifest).toContain("-sub-");
  });

  it("CM-AUTOREALAY-1: subagent-thread bullet mentions autoRelay default", () => {
    const cfg = makeConfig({
      skills: ["subagent-thread"],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Subagent threads");
    expect(manifest).toContain("autoRelay");
    expect(manifest).toContain("autoArchive");
  });

  it("CM-EMPTY-FIELDS: empty Tier 2 fields are omitted (no bloat)", () => {
    // Minimal-ish agent — only one feature opted in. Tier 2 fields should
    // not produce empty bullets.
    const cfg = makeConfig({
      skills: [],
      mcpServers: [],
      fileAccess: undefined,
      gsd: { projectDir: "/tmp/p" },
    });

    const manifest = buildCapabilityManifest(cfg);
    // Skills/MCP/FileAccess bullets are absent
    expect(manifest).not.toMatch(/^- \*\*Skills\*\*:/m);
    expect(manifest).not.toMatch(/^- \*\*MCP servers\*\*:/m);
    expect(manifest).not.toMatch(/^- \*\*File access\*\*:/m);
  });

  // Phase 100 follow-up — vault-scope annotation surfaces when the agent
  // carries an mcpEnvOverrides entry for OP_SERVICE_ACCOUNT_TOKEN. The LLM
  // needs to know "I have NARROWER access than the daemon's clawdbot
  // service account" — otherwise it confidently asserts cross-vault reads
  // it cannot actually perform.
  it("CM-MCP-VAULT-1: 1password server with mcpEnvOverrides → bullet appends 'vault-scoped' annotation", () => {
    const cfg = makeConfig({
      mcpServers: [
        {
          name: "1password",
          command: "npx",
          args: [],
          env: {},
          optional: false,
          description: "secrets retrieval",
          accessPattern: "read-only",
        },
      ],
      mcpEnvOverrides: {
        "1password": {
          OP_SERVICE_ACCOUNT_TOKEN:
            "op://example-vault-21/Acme Service Account/credential",
        },
      },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("MCP servers");
    expect(manifest).toContain("1password");
    expect(manifest).toMatch(/vault-scoped/);
  });

  // ---------------------------------------------------------------------------
  // Phase 117 Plan 08 — Advisor awareness block (2026-05-13)
  //
  // Capability-manifest injects (a) an "Advisor (Opus)" bullet listing
  // `advisor()` as a server-tool and (b) an "## Advisor protocol" prose
  // section with the canonical timing-prompt. Source-of-truth for the prose
  // is `src/advisor/prompts.ts::buildAgentAwarenessBlock`. The injection is
  // gated on `resolveAdvisorBackend(config) ∈ {native, fork}` — always true
  // post-117-06 given the default `native`, but the gate exists for future
  // operators who explicitly disable advisor.
  //
  // The manifest's "minimal agent → empty string" rule still wins: a
  // baseline agent (no dream/schedules/skills/gsd/etc.) gets ""; the
  // advisor block does NOT itself count as an opt-in (matching the file
  // philosophy of "don't bloat minimal agents").
  // ---------------------------------------------------------------------------

  it("CM-ADV-A (native): non-minimal agent with default backend → 'Advisor (Opus)' bullet + '## Advisor protocol' present; no '(legacy fork backend' qualifier", () => {
    // gsd present ⇒ manifest is non-empty; resolveAdvisorBackend defaults
    // to "native" because makeConfig has no `advisor` field.
    const cfg = makeConfig({
      gsd: { projectDir: "/tmp/p" },
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Advisor (Opus)");
    expect(manifest).toContain("advisor()");
    expect(manifest).toContain("Budget: 10 calls/day");
    expect(manifest).toContain("💭 reaction");
    expect(manifest).toContain("## Advisor protocol");
    expect(manifest).toContain("BEFORE substantive work");
    // Protocol points operators toward subagent-thread by skill name (not
    // the MCP tool name) so the prose doesn't accidentally surface
    // `spawn_subagent_thread` to agents that don't carry the skill —
    // see session-config "does NOT include guidance when agent has other
    // skills but not subagent-thread" test (Rule 1 deviation from initial
    // T01 draft, caught by full-suite run pre-completion).
    expect(manifest).toContain("subagent-thread skill");
    // Native path: no legacy-fork qualifier.
    expect(manifest).not.toContain("legacy fork backend");
  });

  it("CM-ADV-B (fork): agent with advisor.backend='fork' → bullet carries '(legacy fork backend — operator rollback path)' qualifier", () => {
    // advisor.backend is not part of ResolvedAgentConfig today (resolver
    // duck-types via `agent?.advisor?.backend`). The cast simulates a
    // future config carrying the field; resolveAdvisorBackend returns
    // "fork" for it.
    const cfg = makeConfig({
      gsd: { projectDir: "/tmp/p" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg as any).advisor = { backend: "fork" };

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Advisor (Opus)");
    expect(manifest).toContain(
      "(legacy fork backend — operator rollback path)",
    );
    expect(manifest).toContain("## Advisor protocol");
  });

  it("CM-ADV-C (defensive, skipped): future 'none' backend would suppress the advisor bullet — guarded by the resolver narrowing today", () => {
    // The resolver narrows to "native" | "fork", so a "none"-like state is
    // unreachable in 117 scope. This test documents the manifest's gate
    // intent: `(backend === "native" || backend === "fork")` is the
    // suppression hook for a future operator-disabled advisor mode. If a
    // future plan widens BackendId, the gate suppresses the bullet without
    // needing a test refactor. Today the gate is always true.
    //
    // Sanity check: with the resolver's current contract, every non-empty
    // manifest carries the advisor bullet. (Inverse direction of A/B.)
    const cfg = makeConfig({ gsd: { projectDir: "/tmp/p" } });
    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("Advisor (Opus)");
  });

  it("CM-ADV-D (single injection): bullet appears exactly once in the assembled manifest", () => {
    const cfg = makeConfig({
      dream: { enabled: true, idleMinutes: 30, model: "haiku" },
      schedules: [
        { name: "tick", cron: "*/5 * * * *", prompt: "tick", enabled: true },
      ],
      skills: ["subagent-thread"],
      gsd: { projectDir: "/tmp/p" },
      mcpServers: [
        {
          name: "clawcode",
          command: "clawcode",
          args: ["mcp"],
          env: {},
          optional: false,
        },
      ],
      fileAccess: ["/srv/shared/"],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect((manifest.match(/Advisor \(Opus\)/g) ?? []).length).toBe(1);
    expect((manifest.match(/## Advisor protocol/g) ?? []).length).toBe(1);
  });

  it("CM-ADV-MINIMAL: baseline agent (no opt-ins) gets no advisor block, only the memory protocol", () => {
    // Matches CM-4 / CM-4b philosophy: the advisor bullet only rides
    // alongside other opt-ins. Truly minimal agents pay no prompt cost.
    const cfg = makeConfig({
      dream: undefined,
      schedules: [],
      skills: [],
      gsd: undefined,
      fileAccess: undefined,
      mcpServers: [],
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toBe(buildMemoryProtocol(cfg).trimStart());
    expect(manifest).not.toContain("Advisor");
  });

  it("CM-MCP-VAULT-2: 1password server without mcpEnvOverrides → no vault-scoped annotation (inherits daemon scope)", () => {
    const cfg = makeConfig({
      mcpServers: [
        {
          name: "1password",
          command: "npx",
          args: [],
          env: {},
          optional: false,
          description: "secrets retrieval",
          accessPattern: "read-only",
        },
      ],
      // no mcpEnvOverrides
    });

    const manifest = buildCapabilityManifest(cfg);
    expect(manifest).toContain("1password");
    expect(manifest).not.toMatch(/vault-scoped/);
  });
});

describe("memory protocol (memory overhaul 2026-10-25, WP5)", () => {
  const minimal = (overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig =>
    makeConfig({ dream: undefined, schedules: [], skills: [], gsd: undefined, mcpServers: [], ...overrides });

  it("names the right tool for each job and the save / correct rules", () => {
    const protocol = buildCapabilityManifest(minimal());
    expect(protocol).toContain("## Memory protocol");
    expect(protocol).toContain("`clawcode_memory_search`");
    expect(protocol).toMatch(/saved memories and your memory files/);
    expect(protocol).toContain("`search_documents`");
    expect(protocol).toContain("`memory_save`");
    expect(protocol).toMatch(/absolute dates \(YYYY-MM-DD/);
    expect(protocol).toContain("`clawcode_memory_update(id, content)`");
    expect(protocol).toContain("`clawcode_memory_forget(id, reason)`");
    expect(protocol).toMatch(/MEMORY\.md and USER\.md are your short, curated index/);
    expect(protocol).toContain("`clawcode_memory_recall(memoryId)`");
  });

  it("is present exactly once for an opted-in agent too", () => {
    const manifest = buildCapabilityManifest(
      makeConfig({ dream: { enabled: true, idleMinutes: 30, model: "haiku" }, gsd: { projectDir: "/tmp/p" } }),
    );
    expect(manifest).toContain("Your ClawCode Capabilities");
    expect((manifest.match(/## Memory protocol/g) ?? []).length).toBe(1);
    expect(manifest).toContain("`clawcode_memory_update` / `clawcode_memory_forget`");
  });

  it("follows memoryAutoLoad and memoryRetrievalTopK instead of promising memory that was not loaded", () => {
    const loaded = buildMemoryProtocol(minimal());
    expect(loaded).toMatch(/loaded into this prompt at session start/);
    expect(loaded).toMatch(/retrieved for you before each turn/);

    const bare = buildMemoryProtocol(minimal({ memoryAutoLoad: false, memoryRetrievalTopK: 0 }));
    expect(bare).toMatch(/NOT loaded into this session/);
    expect(bare).toMatch(/Nothing is retrieved for you automatically/);
    expect(bare).not.toMatch(/loaded into this prompt at session start/);
    expect(bare).not.toMatch(/retrieved for you before each turn/);
  });

  it("contains no em dashes", () => {
    expect(buildMemoryProtocol(minimal())).not.toContain("\u2014");
    expect(buildMemoryProtocol(minimal({ memoryAutoLoad: false, memoryRetrievalTopK: 0 }))).not.toContain("\u2014");
  });
});
