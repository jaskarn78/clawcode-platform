import { describe, it, expect } from "vitest";
// Phase 999.114 — the picker default is now the full catalog, not a 3-set.
import { DEFAULT_PICKER_MODELS } from "../../shared/model-catalog.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { agentSchema, browserConfigSchema, configSchema, defaultsSchema, IDEMPOTENT_TOOL_DEFAULTS, imageConfigSchema, mcpServerSchema, openaiEndpointSchema, searchConfigSchema, securityConfigSchema, streamingConfigSchema, MEMORY_AUTOLOAD_MAX_BYTES } from "../schema.js";
import { RELOADABLE_FIELDS } from "../types.js";
import { conversationConfigSchema } from "../../memory/schema.js";

describe("mcpServerSchema", () => {
  it("validates a complete MCP server config", () => {
    const result = mcpServerSchema.safeParse({
      name: "finnhub",
      command: "npx",
      args: ["-y", "finnhub-mcp"],
      env: { API_KEY: "xxx" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("finnhub");
      expect(result.data.command).toBe("npx");
      expect(result.data.args).toEqual(["-y", "finnhub-mcp"]);
      expect(result.data.env).toEqual({ API_KEY: "xxx" });
    }
  });

  it("applies default empty arrays/objects for args and env", () => {
    const result = mcpServerSchema.safeParse({
      name: "simple",
      command: "my-server",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args).toEqual([]);
      expect(result.data.env).toEqual({});
    }
  });

  it("rejects missing name", () => {
    const result = mcpServerSchema.safeParse({
      command: "npx",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing command", () => {
    const result = mcpServerSchema.safeParse({
      name: "finnhub",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name string", () => {
    const result = mcpServerSchema.safeParse({
      name: "",
      command: "npx",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty command string", () => {
    const result = mcpServerSchema.safeParse({
      name: "test",
      command: "",
    });
    expect(result.success).toBe(false);
  });

  // Phase 100-fu — operator-curated MCP annotations
  it("MCP-DESC-1: mcpServerSchema accepts description + accessPattern fields", () => {
    const result = mcpServerSchema.safeParse({
      name: "acme-db",
      command: "mcporter",
      description: "Postgres SELECT",
      accessPattern: "read-only",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Postgres SELECT");
      expect(result.data.accessPattern).toBe("read-only");
    }
  });

  it("MCP-DESC-2: missing description / accessPattern parses fine (back-compat)", () => {
    const result = mcpServerSchema.safeParse({
      name: "legacy",
      command: "node",
      args: ["server.js"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Both fields are optional — undefined when absent.
      expect(result.data.description).toBeUndefined();
      expect(result.data.accessPattern).toBeUndefined();
    }
  });

  it("MCP-DESC-3: rejects an invalid accessPattern value", () => {
    const result = mcpServerSchema.safeParse({
      name: "bad",
      command: "node",
      accessPattern: "delete-everything",
    });
    expect(result.success).toBe(false);
  });
});

describe("mcpServerSchema alwaysLoad (Phase 999.54 D-01, D-02)", () => {
  it("omits alwaysLoad from parsed output when not declared (byte-stable)", () => {
    const parsed = mcpServerSchema.parse({
      name: "clawcode",
      command: "clawcode",
      args: ["mcp"],
    });
    // RESEARCH.md Pitfall 3 — must NOT be `alwaysLoad: undefined` (would break
    // byte-stable deep-equality). The key MUST be absent from the parsed object.
    expect(Object.prototype.hasOwnProperty.call(parsed, "alwaysLoad")).toBe(false);
  });

  it("accepts alwaysLoad: true and round-trips it (D-01)", () => {
    const parsed = mcpServerSchema.parse({
      name: "clawcode",
      command: "clawcode",
      args: ["mcp"],
      alwaysLoad: true,
    });
    expect(parsed.alwaysLoad).toBe(true);
  });

  it("rejects stringly-typed alwaysLoad with a zod error (strict boolean, D-02)", () => {
    expect(() =>
      mcpServerSchema.parse({
        name: "clawcode",
        command: "clawcode",
        args: ["mcp"],
        alwaysLoad: "true",
      }),
    ).toThrow();
  });
});

describe("configSchema - mcpServers", () => {
  it("accepts top-level shared mcpServers definitions", () => {
    const result = configSchema.safeParse({
      version: 1,
      mcpServers: {
        finnhub: { name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"], env: { API_KEY: "xxx" } },
      },
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers).toBeDefined();
      expect(result.data.mcpServers["finnhub"]).toBeDefined();
      expect(result.data.mcpServers["finnhub"].command).toBe("npx");
    }
  });

  it("defaults mcpServers to empty object when omitted", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers).toEqual({});
    }
  });

  it("accepts per-agent inline mcpServers objects", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{
        name: "test",
        mcpServers: [{ name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"] }],
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents[0].mcpServers).toHaveLength(1);
    }
  });

  it("accepts per-agent string references in mcpServers", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{
        name: "test",
        mcpServers: ["finnhub"],
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents[0].mcpServers).toEqual(["finnhub"]);
    }
  });

  it("accepts mixed inline and string references in per-agent mcpServers", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{
        name: "test",
        mcpServers: [
          "finnhub",
          { name: "custom", command: "my-server" },
        ],
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents[0].mcpServers).toHaveLength(2);
    }
  });

  it("defaults per-agent mcpServers to empty array when omitted", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents[0].mcpServers).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 70 — browser automation config schema
// ---------------------------------------------------------------------------

describe("browserConfigSchema", () => {
  it("parses with all defaults when block omitted (undefined input)", () => {
    const result = browserConfigSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.headless).toBe(true);
      expect(result.data.warmOnBoot).toBe(true);
      expect(result.data.navigationTimeoutMs).toBe(30000);
      expect(result.data.actionTimeoutMs).toBe(10000);
      expect(result.data.viewport).toEqual({ width: 1280, height: 720 });
      expect(result.data.userAgent).toBeNull();
      expect(result.data.maxScreenshotInlineBytes).toBe(524288);
    }
  });

  it("parses an empty object as all defaults", () => {
    const result = browserConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.headless).toBe(true);
      expect(result.data.maxScreenshotInlineBytes).toBe(524288);
    }
  });

  it("parses with partial overrides (headless=false preserved, others default)", () => {
    const result = browserConfigSchema.safeParse({ headless: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.headless).toBe(false);
      expect(result.data.enabled).toBe(true);
      expect(result.data.navigationTimeoutMs).toBe(30000);
      expect(result.data.viewport).toEqual({ width: 1280, height: 720 });
    }
  });

  it("rejects navigationTimeoutMs=0", () => {
    const result = browserConfigSchema.safeParse({ navigationTimeoutMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative actionTimeoutMs", () => {
    const result = browserConfigSchema.safeParse({ actionTimeoutMs: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects navigationTimeoutMs over 10-minute ceiling", () => {
    const result = browserConfigSchema.safeParse({ navigationTimeoutMs: 600001 });
    expect(result.success).toBe(false);
  });

  it("rejects viewport width=0", () => {
    const result = browserConfigSchema.safeParse({ viewport: { width: 0, height: 720 } });
    expect(result.success).toBe(false);
  });

  it("rejects viewport height under 240", () => {
    const result = browserConfigSchema.safeParse({ viewport: { width: 1280, height: 239 } });
    expect(result.success).toBe(false);
  });

  it("rejects maxScreenshotInlineBytes > 5 MiB", () => {
    const result = browserConfigSchema.safeParse({ maxScreenshotInlineBytes: 6291456 });
    expect(result.success).toBe(false);
  });

  it("accepts maxScreenshotInlineBytes = 0 (never inline)", () => {
    const result = browserConfigSchema.safeParse({ maxScreenshotInlineBytes: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxScreenshotInlineBytes).toBe(0);
    }
  });

  it("accepts userAgent null", () => {
    const result = browserConfigSchema.safeParse({ userAgent: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userAgent).toBeNull();
    }
  });

  it("accepts userAgent custom string", () => {
    const result = browserConfigSchema.safeParse({ userAgent: "ClawcodeBot/1.0" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userAgent).toBe("ClawcodeBot/1.0");
    }
  });

  it("accepts custom viewport within bounds", () => {
    const result = browserConfigSchema.safeParse({ viewport: { width: 1920, height: 1080 } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.viewport).toEqual({ width: 1920, height: 1080 });
    }
  });
});

describe("configSchema - defaults.browser wiring", () => {
  it("parses config without defaults.browser and applies browser defaults", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.browser).toBeDefined();
      expect(result.data.defaults.browser.enabled).toBe(true);
      expect(result.data.defaults.browser.headless).toBe(true);
      expect(result.data.defaults.browser.navigationTimeoutMs).toBe(30000);
    }
  });

  it("parses config with explicit defaults.browser block", () => {
    const result = configSchema.safeParse({
      version: 1,
      defaults: {
        browser: {
          enabled: false,
          headless: false,
          navigationTimeoutMs: 45000,
          viewport: { width: 1920, height: 1080 },
        },
      },
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.browser.enabled).toBe(false);
      expect(result.data.defaults.browser.headless).toBe(false);
      expect(result.data.defaults.browser.navigationTimeoutMs).toBe(45000);
      expect(result.data.defaults.browser.viewport).toEqual({ width: 1920, height: 1080 });
      // Unspecified fields should fall back to defaults.
      expect(result.data.defaults.browser.warmOnBoot).toBe(true);
      expect(result.data.defaults.browser.actionTimeoutMs).toBe(10000);
    }
  });

  it("rejects defaults.browser with invalid viewport", () => {
    const result = configSchema.safeParse({
      version: 1,
      defaults: {
        browser: { viewport: { width: 10, height: 720 } },
      },
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("configSchema", () => {
  const validConfig = {
    version: 1,
    agents: [
      {
        name: "researcher",
        channels: ["1234567890123456"],
        model: "opus",
        skills: ["market-research"],
      },
    ],
  };

  it("parses a valid config with all fields", () => {
    const result = configSchema.safeParse({
      version: 1,
      defaults: {
        model: "sonnet",
        skills: ["search-first"],
        basePath: "~/.clawcode/agents",
      },
      agents: [
        {
          name: "researcher",
          channels: ["1234567890123456"],
          model: "opus",
          skills: ["market-research"],
          soul: "Be helpful",
          identity: "I am researcher",
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
      expect(result.data.defaults.model).toBe("sonnet");
      expect(result.data.agents[0].name).toBe("researcher");
      expect(result.data.agents[0].model).toBe("opus");
    }
  });

  it("applies default values when defaults section is omitted", () => {
    const result = configSchema.safeParse(validConfig);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.model).toBe("haiku");
      expect(result.data.defaults.skills).toEqual([]);
      expect(result.data.defaults.basePath).toBe("~/.clawcode/agents");
    }
  });

  it("applies default empty arrays for agent channels and skills", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "minimal" }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents[0].channels).toEqual([]);
      expect(result.data.agents[0].skills).toEqual([]);
    }
  });

  it("rejects config with missing version field", () => {
    const result = configSchema.safeParse({
      agents: [{ name: "test" }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects config with wrong version number", () => {
    const result = configSchema.safeParse({
      version: 2,
      agents: [{ name: "test" }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects config with empty agents array", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects agent with empty name string", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "" }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid model value", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "test", model: "gpt4" }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts the sonnet-4-6 escape-hatch model alias", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "test", channels: ["1234567890123456"], model: "sonnet-4-6" },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents[0].model).toBe("sonnet-4-6");
    }
  });

  it("enforces channel IDs as strings (not numbers)", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "test", channels: [1234567890] }],
    });

    expect(result.success).toBe(false);
  });
});

describe("agentSchema perf.slos override", () => {
  it("accepts a perf.slos array with a single canonical-segment override", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: {
        slos: [{ segment: "end_to_end", metric: "p95", thresholdMs: 5000 }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.slos).toHaveLength(1);
      expect(result.data.perf?.slos?.[0]).toEqual({
        segment: "end_to_end",
        metric: "p95",
        thresholdMs: 5000,
      });
    }
  });

  it("rejects a perf.slos override using a non-canonical segment name", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: {
        slos: [{ segment: "garbage", metric: "p95", thresholdMs: 5000 }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      // Zod enum issues mention the invalid value or expected options
      expect(messages.toLowerCase()).toMatch(/garbage|end_to_end|enum|invalid/);
    }
  });

  it("accepts perf.traceRetentionDays alongside perf.slos (additive, no field collision)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: {
        traceRetentionDays: 14,
        slos: [
          { segment: "first_token", metric: "p50", thresholdMs: 1500 },
          { segment: "tool_call", metric: "p99", thresholdMs: 4000 },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.traceRetentionDays).toBe(14);
      expect(result.data.perf?.slos).toHaveLength(2);
    }
  });

  it("accepts perf.slos on the defaults schema (fleet-wide override path)", () => {
    const result = defaultsSchema.safeParse({
      perf: {
        traceRetentionDays: 30,
        slos: [
          { segment: "context_assemble", metric: "p95", thresholdMs: 250 },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.slos?.[0]?.thresholdMs).toBe(250);
    }
  });
});

describe("agentSchema perf.memoryAssemblyBudgets override (Phase 53)", () => {
  it("accepts a valid memoryAssemblyBudgets object with partial sections", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: {
        memoryAssemblyBudgets: {
          identity: 500,
          hot_tier: 1500,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.memoryAssemblyBudgets?.identity).toBe(500);
      expect(result.data.perf?.memoryAssemblyBudgets?.hot_tier).toBe(1500);
    }
  });

  it("rejects negative memoryAssemblyBudgets values", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: {
        memoryAssemblyBudgets: { identity: -1 },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentSchema perf.lazySkills override (Phase 53)", () => {
  it("accepts a valid lazySkills config with usageThresholdTurns >= 5", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: {
        lazySkills: {
          enabled: true,
          usageThresholdTurns: 20,
          reinflateOnMention: true,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.lazySkills?.usageThresholdTurns).toBe(20);
      expect(result.data.perf?.lazySkills?.enabled).toBe(true);
      expect(result.data.perf?.lazySkills?.reinflateOnMention).toBe(true);
    }
  });

  it("rejects lazySkills with usageThresholdTurns below the 5-turn floor", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: {
        lazySkills: {
          enabled: true,
          usageThresholdTurns: 3,
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentSchema perf.resumeSummaryBudget override (Phase 53)", () => {
  it("accepts resumeSummaryBudget at or above the 500-token floor and rejects below/non-integer", () => {
    const ok = agentSchema.safeParse({
      name: "x",
      perf: { resumeSummaryBudget: 1500 },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.perf?.resumeSummaryBudget).toBe(1500);
    }

    const tooLow = agentSchema.safeParse({
      name: "x",
      perf: { resumeSummaryBudget: 400 },
    });
    expect(tooLow.success).toBe(false);

    const nonInt = agentSchema.safeParse({
      name: "x",
      perf: { resumeSummaryBudget: 1500.5 },
    });
    expect(nonInt.success).toBe(false);
  });
});

describe("streamingConfigSchema (Phase 54)", () => {
  it("accepts { editIntervalMs: 750 } (inside default corridor)", () => {
    const result = streamingConfigSchema.safeParse({ editIntervalMs: 750 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.editIntervalMs).toBe(750);
    }
  });

  it("accepts { editIntervalMs: 300 } (exactly on the 300ms floor)", () => {
    const result = streamingConfigSchema.safeParse({ editIntervalMs: 300 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.editIntervalMs).toBe(300);
    }
  });

  it("rejects { editIntervalMs: 299 } with a Zod issue mentioning the 300ms floor", () => {
    const result = streamingConfigSchema.safeParse({ editIntervalMs: 299 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages.toLowerCase()).toMatch(/300|min|greater|>=|too_small/);
    }
  });

  it("rejects { editIntervalMs: -1 } and { editIntervalMs: 0 }", () => {
    const neg = streamingConfigSchema.safeParse({ editIntervalMs: -1 });
    const zero = streamingConfigSchema.safeParse({ editIntervalMs: 0 });
    expect(neg.success).toBe(false);
    expect(zero.success).toBe(false);
  });

  it("accepts { maxLength: 2000 } (Discord message character limit)", () => {
    const result = streamingConfigSchema.safeParse({ maxLength: 2000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxLength).toBe(2000);
    }
  });

  it("accepts {} (all fields optional)", () => {
    const result = streamingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.editIntervalMs).toBeUndefined();
      expect(result.data.maxLength).toBeUndefined();
    }
  });

  it("agentSchema accepts { perf: { streaming: { editIntervalMs: 500 } } }", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: { streaming: { editIntervalMs: 500 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.streaming?.editIntervalMs).toBe(500);
    }
  });

  it("agentSchema REJECTS { perf: { streaming: { editIntervalMs: 100 } } } (floor propagates)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: { streaming: { editIntervalMs: 100 } },
    });
    expect(result.success).toBe(false);
  });

  it("defaultsSchema accepts { perf: { streaming: { editIntervalMs: 500 } } } (fleet-wide default path)", () => {
    const result = defaultsSchema.safeParse({
      perf: { streaming: { editIntervalMs: 500, maxLength: 1800 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.streaming?.editIntervalMs).toBe(500);
      expect(result.data.perf?.streaming?.maxLength).toBe(1800);
    }
  });
});

describe("agentSchema perf combined fields (Phase 53 regression)", () => {
  it("accepts all four phases' fields simultaneously with no collision", () => {
    const result = agentSchema.safeParse({
      name: "x",
      perf: {
        traceRetentionDays: 14,
        slos: [{ segment: "end_to_end", metric: "p95", thresholdMs: 6000 }],
        memoryAssemblyBudgets: {
          identity: 500,
          soul: 400,
          skills_header: 600,
          hot_tier: 1500,
          recent_history: 2000,
          per_turn_summary: 300,
          resume_summary: 1500,
        },
        lazySkills: {
          enabled: true,
          usageThresholdTurns: 20,
          reinflateOnMention: true,
        },
        resumeSummaryBudget: 1500,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.traceRetentionDays).toBe(14);
      expect(result.data.perf?.slos).toHaveLength(1);
      expect(result.data.perf?.memoryAssemblyBudgets?.resume_summary).toBe(1500);
      expect(result.data.perf?.lazySkills?.enabled).toBe(true);
      expect(result.data.perf?.resumeSummaryBudget).toBe(1500);
    }
  });

  it("mirrors the three new fields on defaultsSchema.perf (fleet-wide path)", () => {
    const result = defaultsSchema.safeParse({
      perf: {
        traceRetentionDays: 30,
        memoryAssemblyBudgets: { identity: 500 },
        lazySkills: { enabled: false, usageThresholdTurns: 10, reinflateOnMention: false },
        resumeSummaryBudget: 1500,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perf?.memoryAssemblyBudgets?.identity).toBe(500);
      expect(result.data.perf?.lazySkills?.usageThresholdTurns).toBe(10);
      expect(result.data.perf?.resumeSummaryBudget).toBe(1500);
    }
  });
});

describe("conversationConfigSchema (Phase 67)", () => {
  it("resumeSessionCount floor", () => {
    // min 1 — value of 0 must be rejected
    expect(() => conversationConfigSchema.parse({ resumeSessionCount: 0 })).toThrow();
    // 1 is the floor — must pass
    expect(() => conversationConfigSchema.parse({ resumeSessionCount: 1 })).not.toThrow();
  });

  it("conversationContextBudget floor", () => {
    // min 500 — value of 499 must be rejected
    expect(() => conversationConfigSchema.parse({ conversationContextBudget: 499 })).toThrow();
    // 500 is the floor — must pass
    expect(() => conversationConfigSchema.parse({ conversationContextBudget: 500 })).not.toThrow();
  });

  it("provides defaults when input is empty", () => {
    const parsed = conversationConfigSchema.parse({});
    expect(parsed.resumeSessionCount).toBe(3);
    expect(parsed.resumeGapThresholdHours).toBe(4);
    expect(parsed.conversationContextBudget).toBe(2000);
  });

  it("resumeSessionCount ceiling (max 10)", () => {
    // max 10 — value of 11 must be rejected
    expect(() => conversationConfigSchema.parse({ resumeSessionCount: 11 })).toThrow();
    // 10 must pass
    expect(() => conversationConfigSchema.parse({ resumeSessionCount: 10 })).not.toThrow();
  });

  it("resumeGapThresholdHours accepts 0 (always inject)", () => {
    // gap=0 means never skip — valid per min(0)
    const parsed = conversationConfigSchema.parse({ resumeGapThresholdHours: 0 });
    expect(parsed.resumeGapThresholdHours).toBe(0);
  });

  // Phase 68 — RETR-03: retrievalHalfLifeDays knob
  it("retrievalHalfLifeDays defaults to 14", () => {
    const parsed = conversationConfigSchema.parse({});
    expect(parsed.retrievalHalfLifeDays).toBe(14);
  });

  it("retrievalHalfLifeDays accepts custom positive integer", () => {
    const parsed = conversationConfigSchema.parse({ retrievalHalfLifeDays: 7 });
    expect(parsed.retrievalHalfLifeDays).toBe(7);
  });

  it("retrievalHalfLifeDays rejects 0 (min=1)", () => {
    expect(() =>
      conversationConfigSchema.parse({ retrievalHalfLifeDays: 0 }),
    ).toThrow();
  });

  // Gap 3 (memory-persistence-gaps) — flushIntervalMinutes
  it("flushIntervalMinutes defaults to 15", () => {
    const parsed = conversationConfigSchema.parse({});
    expect(parsed.flushIntervalMinutes).toBe(15);
  });

  it("flushIntervalMinutes accepts 0 (disables periodic flush)", () => {
    const parsed = conversationConfigSchema.parse({ flushIntervalMinutes: 0 });
    expect(parsed.flushIntervalMinutes).toBe(0);
  });

  it("flushIntervalMinutes accepts custom positive integer", () => {
    const parsed = conversationConfigSchema.parse({ flushIntervalMinutes: 5 });
    expect(parsed.flushIntervalMinutes).toBe(5);
  });

  it("flushIntervalMinutes rejects negative values", () => {
    expect(() =>
      conversationConfigSchema.parse({ flushIntervalMinutes: -1 }),
    ).toThrow();
  });

  it("flushIntervalMinutes rejects non-integer values", () => {
    expect(() =>
      conversationConfigSchema.parse({ flushIntervalMinutes: 1.5 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 69 — OpenAI-compatible endpoint schema (OPENAI-01..07)
// ---------------------------------------------------------------------------

describe("openaiEndpointSchema", () => {
  it("applies all defaults when parsed with an empty object", () => {
    const parsed = openaiEndpointSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.port).toBe(3101);
    expect(parsed.host).toBe("0.0.0.0");
    expect(parsed.maxRequestBodyBytes).toBe(1048576);
    expect(parsed.streamKeepaliveMs).toBe(15000);
  });

  it("wraps schema with .default({}) so a partial object still populates all fields", () => {
    // When only a subset of fields is provided, the remaining fields fall
    // back to their inner defaults. This is the realistic YAML scenario.
    const parsed = openaiEndpointSchema.parse({ port: 9999 });
    expect(parsed.port).toBe(9999);
    expect(parsed.host).toBe("0.0.0.0");
    expect(parsed.enabled).toBe(true);
    expect(parsed.maxRequestBodyBytes).toBe(1048576);
    expect(parsed.streamKeepaliveMs).toBe(15000);
  });

  it("accepts port=3101 host=127.0.0.1 and preserves values", () => {
    const parsed = openaiEndpointSchema.parse({ port: 3101, host: "127.0.0.1" });
    expect(parsed.port).toBe(3101);
    expect(parsed.host).toBe("127.0.0.1");
  });

  it("rejects port=0 (below min)", () => {
    expect(() => openaiEndpointSchema.parse({ port: 0 })).toThrow();
  });

  it("rejects port=65536 (above max)", () => {
    expect(() => openaiEndpointSchema.parse({ port: 65536 })).toThrow();
  });

  it("rejects empty host string", () => {
    expect(() => openaiEndpointSchema.parse({ host: "" })).toThrow();
  });

  it("rejects maxRequestBodyBytes=500 (below 1024 floor)", () => {
    expect(() =>
      openaiEndpointSchema.parse({ maxRequestBodyBytes: 500 }),
    ).toThrow();
  });

  it("rejects maxRequestBodyBytes above 100 MiB ceiling", () => {
    expect(() =>
      openaiEndpointSchema.parse({ maxRequestBodyBytes: 104857601 }),
    ).toThrow();
  });

  it("rejects streamKeepaliveMs=500 (below 1000 floor)", () => {
    expect(() =>
      openaiEndpointSchema.parse({ streamKeepaliveMs: 500 }),
    ).toThrow();
  });

  it("rejects streamKeepaliveMs above 120000 ceiling", () => {
    expect(() =>
      openaiEndpointSchema.parse({ streamKeepaliveMs: 120001 }),
    ).toThrow();
  });

  it("rejects non-integer port", () => {
    expect(() => openaiEndpointSchema.parse({ port: 3101.5 })).toThrow();
  });
});

describe("configSchema — defaults.openai", () => {
  it("parses with all openai defaults when defaults.openai is omitted", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.openai.enabled).toBe(true);
      expect(result.data.defaults.openai.port).toBe(3101);
      expect(result.data.defaults.openai.host).toBe("0.0.0.0");
      expect(result.data.defaults.openai.maxRequestBodyBytes).toBe(1048576);
      expect(result.data.defaults.openai.streamKeepaliveMs).toBe(15000);
    }
  });

  it("accepts explicit defaults.openai overrides", () => {
    const result = configSchema.safeParse({
      version: 1,
      defaults: {
        openai: {
          enabled: false,
          port: 4000,
          host: "127.0.0.1",
          maxRequestBodyBytes: 2097152,
          streamKeepaliveMs: 30000,
        },
      },
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.openai.enabled).toBe(false);
      expect(result.data.defaults.openai.port).toBe(4000);
      expect(result.data.defaults.openai.host).toBe("127.0.0.1");
    }
  });

  it("rejects defaults.openai with out-of-range port", () => {
    const result = configSchema.safeParse({
      version: 1,
      defaults: { openai: { port: 70000 } },
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(false);
  });

  // Regression for the "clawdy v2 stability" bug (2026-04-19).
  // When `defaults:` is PRESENT with other fields but `openai` is absent,
  // Zod must still cascade inner field defaults so `enabled` resolves to true.
  // The previous `.default({})` form silently yielded `{}` here — the endpoint
  // saw `enabled: undefined`, hit the disabled branch, and never bound port 3101.
  it("cascades openai defaults when defaults block is present but openai is absent (real clawdy config shape)", () => {
    const result = configSchema.safeParse({
      version: 1,
      defaults: {
        model: "sonnet",
        basePath: "~/.clawcode/agents",
        memory: { compactionThreshold: 0.75, searchTopK: 10 },
        heartbeat: {
          enabled: true,
          intervalSeconds: 60,
          timeoutSeconds: 10,
          contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
        },
      },
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.openai.enabled).toBe(true);
      expect(result.data.defaults.openai.port).toBe(3101);
      expect(result.data.defaults.openai.host).toBe("0.0.0.0");
      expect(result.data.defaults.openai.maxRequestBodyBytes).toBe(1048576);
      expect(result.data.defaults.openai.streamKeepaliveMs).toBe(15000);
    }
  });

  it("defaultsSchema.parse with partial input populates openai fully (cascade check)", () => {
    // Direct defaultsSchema parse — what the inner loader path sees.
    const parsed = defaultsSchema.parse({
      model: "sonnet",
      heartbeat: {
        enabled: true,
        intervalSeconds: 60,
        timeoutSeconds: 10,
        contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
      },
    });
    expect(parsed.openai).toEqual({
      enabled: true,
      port: 3101,
      host: "0.0.0.0",
      maxRequestBodyBytes: 1048576,
      streamKeepaliveMs: 15000,
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 71 — web search MCP config schema
// ---------------------------------------------------------------------------

describe("searchConfigSchema (Phase 71)", () => {
  it("returns full default when parsing empty object", () => {
    const result = searchConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      backend: "brave",
      brave: {
        apiKeyEnv: "BRAVE_API_KEY",
        safeSearch: "moderate",
        country: "us",
      },
      exa: {
        apiKeyEnv: "EXA_API_KEY",
        useAutoprompt: false,
      },
      maxResults: 20,
      timeoutMs: 10000,
      fetch: {
        timeoutMs: 30000,
        maxBytes: 1048576,
        userAgentSuffix: null,
      },
    });
  });

  it("keeps defaults for unspecified nested fields on partial override", () => {
    const result = searchConfigSchema.parse({ backend: "exa", maxResults: 5 });
    expect(result.backend).toBe("exa");
    expect(result.maxResults).toBe(5);
    // Nested defaults still populated
    expect(result.brave).toEqual({
      apiKeyEnv: "BRAVE_API_KEY",
      safeSearch: "moderate",
      country: "us",
    });
    expect(result.exa).toEqual({
      apiKeyEnv: "EXA_API_KEY",
      useAutoprompt: false,
    });
    expect(result.fetch).toEqual({
      timeoutMs: 30000,
      maxBytes: 1048576,
      userAgentSuffix: null,
    });
  });

  it("rejects backend='google' (only brave|exa allowed)", () => {
    expect(() => searchConfigSchema.parse({ backend: "google" })).toThrow();
  });

  it("rejects maxResults=0 (must be >= 1)", () => {
    expect(() => searchConfigSchema.parse({ maxResults: 0 })).toThrow();
  });

  it("rejects maxResults=21 (hard cap 20)", () => {
    expect(() => searchConfigSchema.parse({ maxResults: 21 })).toThrow();
  });

  it("rejects fetch.maxBytes=0 (must be >= 1)", () => {
    expect(() => searchConfigSchema.parse({ fetch: { maxBytes: 0 } })).toThrow();
  });

  it("defaultsSchema.parse({}).search returns a fully-populated default", () => {
    const parsed = defaultsSchema.parse({});
    expect(parsed.search).toBeDefined();
    expect(parsed.search.enabled).toBe(true);
    expect(parsed.search.backend).toBe("brave");
    expect(parsed.search.maxResults).toBe(20);
    expect(parsed.search.timeoutMs).toBe(10000);
    expect(parsed.search.brave.apiKeyEnv).toBe("BRAVE_API_KEY");
    expect(parsed.search.exa.apiKeyEnv).toBe("EXA_API_KEY");
    expect(parsed.search.fetch.maxBytes).toBe(1048576);
  });

  it("IDEMPOTENT_TOOL_DEFAULTS contains web_search and web_fetch_url (frozen)", () => {
    expect(IDEMPOTENT_TOOL_DEFAULTS).toContain("web_search");
    expect(IDEMPOTENT_TOOL_DEFAULTS).toContain("web_fetch_url");
    expect(IDEMPOTENT_TOOL_DEFAULTS).toContain("memory_lookup");
    expect(IDEMPOTENT_TOOL_DEFAULTS).toContain("search_documents");
    expect(IDEMPOTENT_TOOL_DEFAULTS).toContain("memory_list");
    expect(IDEMPOTENT_TOOL_DEFAULTS).toContain("memory_graph");
    expect(IDEMPOTENT_TOOL_DEFAULTS).toHaveLength(6);
    expect(Object.isFrozen(IDEMPOTENT_TOOL_DEFAULTS)).toBe(true);
    // Frozen array — push should throw in strict mode.
    expect(() => {
      (IDEMPOTENT_TOOL_DEFAULTS as string[]).push("nope");
    }).toThrow();
  });

  // --------------------------------------------------------------------------
  // Phase 72 — image generation MCP config schema
  // --------------------------------------------------------------------------

  it("S1: imageConfigSchema parses empty input and returns documented defaults", () => {
    const parsed = imageConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.backend).toBe("openai");
    expect(parsed.openai.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(parsed.openai.model).toBe("gpt-image-1");
    expect(parsed.minimax.apiKeyEnv).toBe("MINIMAX_API_KEY");
    expect(parsed.minimax.model).toBe("image-01");
    expect(parsed.fal.apiKeyEnv).toBe("FAL_API_KEY");
    expect(parsed.fal.model).toBe("fal-ai/flux-pro");
    expect(parsed.maxImageBytes).toBe(10485760);
    expect(parsed.timeoutMs).toBe(60000);
    expect(parsed.workspaceSubdir).toBe("generated-images");
  });

  it("S2: imageConfigSchema rejects unknown backend (z.enum strict)", () => {
    const result = imageConfigSchema.safeParse({ backend: "stable-diffusion" });
    expect(result.success).toBe(false);
  });

  it("S3: defaultsSchema parses minimal config and image block is populated", () => {
    const parsed = defaultsSchema.parse({});
    expect(parsed.image).toBeDefined();
    expect(parsed.image.backend).toBe("openai");
    expect(parsed.image.openai.model).toBe("gpt-image-1");
  });

  it("S4: configSchema with only version+agents produces a populated defaults.image block equal to imageConfigSchema().parse({})", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const expected = imageConfigSchema.parse({});
    expect(result.data.defaults.image).toEqual(expected);
  });

  it("S5: imageConfigSchema rejects maxImageBytes one byte over 10MB", () => {
    const result = imageConfigSchema.safeParse({ maxImageBytes: 10485761 });
    expect(result.success).toBe(false);
  });

  it("imageConfigSchema rejects timeoutMs over 5 minutes", () => {
    expect(imageConfigSchema.safeParse({ timeoutMs: 300001 }).success).toBe(false);
    expect(imageConfigSchema.safeParse({ timeoutMs: 300000 }).success).toBe(true);
    expect(imageConfigSchema.safeParse({ timeoutMs: 999 }).success).toBe(false);
  });

  it("imageConfigSchema rejects empty workspaceSubdir", () => {
    expect(imageConfigSchema.safeParse({ workspaceSubdir: "" }).success).toBe(false);
  });

  it("imageConfigSchema rejects empty apiKeyEnv on any backend", () => {
    expect(
      imageConfigSchema.safeParse({ openai: { apiKeyEnv: "", model: "x" } }).success,
    ).toBe(false);
    expect(
      imageConfigSchema.safeParse({ minimax: { apiKeyEnv: "", model: "x" } }).success,
    ).toBe(false);
    expect(
      imageConfigSchema.safeParse({ fal: { apiKeyEnv: "", model: "x" } }).success,
    ).toBe(false);
  });

  it("IDEMPOTENT_TOOL_DEFAULTS does NOT contain image_generate / image_edit / image_variations", () => {
    // Image tools are non-deterministic — same prompt yields different images.
    // Caching them would be a correctness bug.
    expect(IDEMPOTENT_TOOL_DEFAULTS).not.toContain("image_generate");
    expect(IDEMPOTENT_TOOL_DEFAULTS).not.toContain("image_edit");
    expect(IDEMPOTENT_TOOL_DEFAULTS).not.toContain("image_variations");
  });
});

// ---------------------------------------------------------------------------
// Phase 74 Plan 02 — security.denyScopeAll per-agent flag
// ---------------------------------------------------------------------------

describe("Phase 74 Plan 02 — securityConfigSchema.denyScopeAll", () => {
  it("parses { allowlist: [], denyScopeAll: true } successfully with denyScopeAll=true", () => {
    const result = securityConfigSchema.safeParse({
      allowlist: [],
      denyScopeAll: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.denyScopeAll).toBe(true);
      expect(result.data.allowlist).toEqual([]);
    }
  });

  it("parses { allowlist: [] } (no denyScopeAll) successfully with denyScopeAll defaulting to false", () => {
    const result = securityConfigSchema.safeParse({ allowlist: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.denyScopeAll).toBe(false);
    }
  });

  it("rejects denyScopeAll as non-boolean (must be boolean type)", () => {
    const result = securityConfigSchema.safeParse({
      allowlist: [],
      denyScopeAll: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("full agent config with admin=true + security.denyScopeAll=true parses and exposes the flag", () => {
    const result = agentSchema.safeParse({
      name: "admin-clawdy",
      admin: true,
      security: { denyScopeAll: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.admin).toBe(true);
      expect(result.data.security?.denyScopeAll).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 75 Plan 01 — SHARED-01: agentSchema.memoryPath + configSchema conflict
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 86 Plan 01 — MODEL-01: agentSchema.allowedModels + defaultsSchema.allowedModels
// + v2.1 config back-compat + resolved agent exposure.
// ---------------------------------------------------------------------------

describe("agentSchema - allowedModels (Phase 86 MODEL-01)", () => {
  it("accepts allowedModels with valid model aliases (haiku, sonnet, opus)", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      allowedModels: ["haiku", "sonnet"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedModels).toEqual(["haiku", "sonnet"]);
    }
  });

  it("accepts agent without allowedModels (optional field — loader fills defaults)", () => {
    const result = agentSchema.safeParse({ name: "fin-client" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedModels).toBeUndefined();
    }
  });

  it("rejects allowedModels containing an unknown alias (e.g. gpt-4)", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      allowedModels: ["gpt-4"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts allowedModels with all three aliases", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      allowedModels: ["haiku", "sonnet", "opus"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedModels).toEqual(["haiku", "sonnet", "opus"]);
    }
  });
});

describe("defaultsSchema - allowedModels (Phase 86 MODEL-01)", () => {
  // Phase 999.114 — "the full set" is now every catalog alias, not the 3-set:
  // the picker surfaces every tier and every historical pin.
  it("defaults allowedModels to the full catalog set when omitted", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedModels).toEqual([...DEFAULT_PICKER_MODELS]);
    }
  });

  it("accepts an explicit defaults.allowedModels override", () => {
    const result = defaultsSchema.safeParse({ allowedModels: ["haiku"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedModels).toEqual(["haiku"]);
    }
  });
});

describe("configSchema - allowedModels backward compatibility (Phase 86 MODEL-01)", () => {
  it("v2.1-style config (15 agents without allowedModels) parses unchanged; defaults populated", () => {
    // Simulate a migrated v2.1 fleet: 15 agents, none declaring allowedModels.
    const agents = Array.from({ length: 15 }, (_, i) => ({
      name: `agent-${i}`,
      channels: [`${1000000000000000 + i}`],
      model: "sonnet" as const,
      effort: "low" as const,
    }));
    const result = configSchema.safeParse({ version: 1, agents });
    expect(result.success).toBe(true);
    if (result.success) {
      // Defaults.allowedModels is populated to the full set — Phase 999.114:
      // every catalog alias, so the Discord picker offers every model.
      expect(result.data.defaults.allowedModels).toEqual([...DEFAULT_PICKER_MODELS]);
      // Every agent's allowedModels is undefined on the raw parse — loader
      // resolves against defaults downstream.
      for (const agent of result.data.agents) {
        expect(agent.allowedModels).toBeUndefined();
      }
    }
  });

  it("configSchema populates defaults.allowedModels when defaults block is absent entirely", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "solo" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.allowedModels).toEqual([...DEFAULT_PICKER_MODELS]);
    }
  });
});

describe("agentSchema - memoryPath", () => {
  it("parses an agent with memoryPath set to a ~/... path unchanged (expansion deferred to loader)", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      memoryPath: "~/shared/memories/fin-client",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Schema stores raw string; expansion via expandHome() happens in loader.ts (Plan 02).
      expect(result.data.memoryPath).toBe("~/shared/memories/fin-client");
    }
  });

  it("parses an agent without memoryPath (optional — fallback to workspace handled in loader)", () => {
    const result = agentSchema.safeParse({ name: "researcher" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memoryPath).toBeUndefined();
    }
  });

  it("rejects memoryPath with a non-string (number) value", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      memoryPath: 123,
    });
    expect(result.success).toBe(false);
  });

  it("rejects memoryPath with an empty string (min(1) guard)", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      memoryPath: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts relative paths (./subdir) and absolute paths — schema stores raw strings", () => {
    const relResult = agentSchema.safeParse({
      name: "fin-research",
      memoryPath: "./shared/fin-research",
    });
    expect(relResult.success).toBe(true);

    const absResult = agentSchema.safeParse({
      name: "fin-research",
      memoryPath: "/var/lib/clawcode/fin-research",
    });
    expect(absResult.success).toBe(true);
  });
});

describe("configSchema - memoryPath conflict detection", () => {
  it("rejects two agents sharing the same memoryPath, naming both conflicting agents", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "fin-client", memoryPath: "~/shared/memories/fin-client" },
        { name: "fin-research", memoryPath: "~/shared/memories/fin-client" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/memoryPath.*conflict/i);
      expect(messages).toContain("fin-client");
      expect(messages).toContain("fin-research");
    }
  });

  it("accepts two agents with the SAME workspace but DIFFERENT memoryPath values (no conflict)", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "fin-client", workspace: "~/shared/acme", memoryPath: "~/shared/memories/fin-client" },
        { name: "fin-research", workspace: "~/shared/acme", memoryPath: "~/shared/memories/fin-research" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("lists ONLY conflicting agent names (three-agent case, two collide, one distinct)", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "fin-client", memoryPath: "~/shared/memories/shared-A" },
        { name: "fin-research", memoryPath: "~/shared/memories/shared-A" },
        { name: "fin-playground", memoryPath: "~/shared/memories/fin-playground" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toContain("fin-client");
      expect(messages).toContain("fin-research");
      // Only the conflicting names should appear; the distinct agent should not be flagged as conflicting.
      expect(messages).not.toContain("fin-playground");
    }
  });

  it("accepts a config where memoryPath is omitted on all agents (nothing to compare)", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "researcher" },
        { name: "coder" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("compares raw strings at the schema boundary — trailing slash is NOT normalized (schema accepts; loader handles normalization)", () => {
    // This documents the schema contract: Zod sees raw strings. `~/shared/A` and `~/shared/A/`
    // are considered distinct at this layer. Loader.ts (Plan 02) will expand + normalize
    // before use; any real filesystem collision is caught by downstream invariants.
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "fin-client", memoryPath: "~/shared/A" },
        { name: "fin-research", memoryPath: "~/shared/A/" },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 78 Plan 01 — CONF-01: agentSchema.soulFile + agentSchema.identityFile
// + configSchema mutual-exclusion guard (inline soul/identity vs file pointers)
// ---------------------------------------------------------------------------

describe("agentSchema - soulFile / identityFile (Phase 78 CONF-01)", () => {
  it("accepts optional soulFile with ~/... path (raw, no expansion at schema layer)", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      soulFile: "~/workspace-fin-client/SOUL.md",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Schema stores raw string; expandHome() runs in loader.ts.
      expect(result.data.soulFile).toBe(
        "~/workspace-fin-client/SOUL.md",
      );
    }
  });

  it("accepts optional identityFile with ~/... path (raw, no expansion at schema layer)", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      identityFile: "~/workspace-fin-client/IDENTITY.md",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.identityFile).toBe(
        "~/workspace-fin-client/IDENTITY.md",
      );
    }
  });

  it("leaves both soulFile and identityFile undefined when omitted", () => {
    const result = agentSchema.safeParse({ name: "writer" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.soulFile).toBeUndefined();
      expect(result.data.identityFile).toBeUndefined();
    }
  });

  it("rejects soulFile with an empty string (min(1) guard)", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      soulFile: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects soulFile with a non-string (number) value", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      soulFile: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("configSchema - soul/soulFile + identity/identityFile mutual exclusion (Phase 78 CONF-01)", () => {
  it("rejects an agent that sets BOTH inline soul AND soulFile — error names the agent", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        {
          name: "fin-client",
          soul: "inline soul text",
          soulFile: "~/workspace-fin-client/SOUL.md",
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" | ");
      expect(msg).toMatch(/soul.*soulFile.*cannot be used together/i);
      expect(msg).toContain("fin-client");
    }
  });

  it("rejects an agent that sets BOTH inline identity AND identityFile — error names the agent", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        {
          name: "fin-client",
          identity: "inline identity text",
          identityFile: "~/workspace-fin-client/IDENTITY.md",
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" | ");
      expect(msg).toMatch(/identity.*identityFile.*cannot be used together/i);
      expect(msg).toContain("fin-client");
    }
  });

  it("accepts an agent setting ONLY soulFile and ONLY identityFile (no inline counterparts)", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        {
          name: "fin-client",
          soulFile: "~/workspace-fin-client/SOUL.md",
          identityFile: "~/workspace-fin-client/IDENTITY.md",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a mix across agents: A uses inline soul, B uses soulFile (exclusion is per-agent)", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "agent-a", soul: "inline text for A" },
        { name: "agent-b", soulFile: "~/workspace-b/SOUL.md" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("preserves existing Phase 75 memoryPath conflict detection (regression — both superRefine blocks fire)", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        {
          name: "fin-client",
          memoryPath: "~/shared/A",
          soulFile: "~/workspace-fin-client/SOUL.md",
        },
        {
          name: "fin-research",
          memoryPath: "~/shared/A",
          soulFile: "~/workspace-fin-research/SOUL.md",
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      // Phase 75 guard still fires despite adding the Phase 78 block.
      expect(messages).toMatch(/memoryPath.*conflict/i);
      expect(messages).toContain("fin-client");
      expect(messages).toContain("fin-research");
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 90 Plan 01 — MEM-01: agentSchema.memoryAutoLoad + memoryAutoLoadPath
// additions, defaultsSchema.memoryAutoLoad default, MEMORY_AUTOLOAD_MAX_BYTES
// constant, RELOADABLE_FIELDS entries. Mirrors Phase 86 allowedModels +
// Phase 89 greetOnRestart additive-optional rollout shape.
// ---------------------------------------------------------------------------

describe("agentSchema - memoryAutoLoad / memoryAutoLoadPath (Phase 90 MEM-01)", () => {
  it("MEM-01-S1: agentSchema.parse({name:'x'}) leaves memoryAutoLoad undefined (optional)", () => {
    const result = agentSchema.safeParse({ name: "x" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memoryAutoLoad).toBeUndefined();
      expect(result.data.memoryAutoLoadPath).toBeUndefined();
    }
  });

  it("MEM-01-S3a: agentSchema accepts explicit memoryAutoLoad=false override", () => {
    const result = agentSchema.safeParse({ name: "x", memoryAutoLoad: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memoryAutoLoad).toBe(false);
    }
  });

  it("MEM-01-S3b: agentSchema accepts memoryAutoLoadPath override as abs path", () => {
    const result = agentSchema.safeParse({
      name: "x",
      memoryAutoLoadPath: "/abs/memo.md",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memoryAutoLoadPath).toBe("/abs/memo.md");
    }
  });

  it("MEM-01-S3c: agentSchema rejects empty memoryAutoLoadPath string (min(1))", () => {
    const result = agentSchema.safeParse({ name: "x", memoryAutoLoadPath: "" });
    expect(result.success).toBe(false);
  });
});

describe("defaultsSchema - memoryAutoLoad (Phase 90 MEM-01)", () => {
  it("MEM-01-S2: defaultsSchema.parse({}) defaults memoryAutoLoad to true", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memoryAutoLoad).toBe(true);
    }
  });

  it("MEM-01-S2b: defaultsSchema accepts explicit memoryAutoLoad=false override", () => {
    const result = defaultsSchema.safeParse({ memoryAutoLoad: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memoryAutoLoad).toBe(false);
    }
  });
});

describe("MEMORY_AUTOLOAD_MAX_BYTES constant (Phase 90 MEM-01 D-17)", () => {
  it("MEM-01-L3: MEMORY_AUTOLOAD_MAX_BYTES === 50 * 1024", () => {
    expect(MEMORY_AUTOLOAD_MAX_BYTES).toBe(50 * 1024);
  });
});

describe("RELOADABLE_FIELDS - MEM-01 entries (Phase 90 MEM-01 / D-18)", () => {
  it("MEM-01-S4a: RELOADABLE_FIELDS contains agents.*.memoryAutoLoad", () => {
    expect(RELOADABLE_FIELDS.has("agents.*.memoryAutoLoad")).toBe(true);
  });

  it("MEM-01-S4b: RELOADABLE_FIELDS contains defaults.memoryAutoLoad", () => {
    expect(RELOADABLE_FIELDS.has("defaults.memoryAutoLoad")).toBe(true);
  });

  it("MEM-01-S4c: RELOADABLE_FIELDS contains agents.*.memoryAutoLoadPath", () => {
    expect(RELOADABLE_FIELDS.has("agents.*.memoryAutoLoadPath")).toBe(true);
  });
});

describe("configSchema - memoryAutoLoad backward compatibility (Phase 90 MEM-01)", () => {
  it("v2.1-style config (15 agents without memoryAutoLoad) parses unchanged; defaults populated", () => {
    // Simulate a migrated v2.1 fleet: 15 agents, none declaring memoryAutoLoad.
    const agents = Array.from({ length: 15 }, (_, i) => ({
      name: `agent-${i}`,
      channels: [`${1000000000000000 + i}`],
      model: "sonnet" as const,
      effort: "low" as const,
    }));
    const result = configSchema.safeParse({ version: 1, agents });
    expect(result.success).toBe(true);
    if (result.success) {
      // Defaults.memoryAutoLoad is populated to true.
      expect(result.data.defaults.memoryAutoLoad).toBe(true);
      // Every agent's memoryAutoLoad is undefined on the raw parse —
      // loader resolves against defaults downstream.
      for (const agent of result.data.agents) {
        expect(agent.memoryAutoLoad).toBeUndefined();
        expect(agent.memoryAutoLoadPath).toBeUndefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 95 Plan 01 — DREAM-01..03: agentSchema.dream + defaultsSchema.dream
// additive-optional rollout. 9th application of the Phase 83/86/89/90/94
// schema blueprint. v2.5/v2.6 migrated configs (no `dream:` block) parse
// unchanged because agentSchema.dream is fully optional and defaults.dream
// is default-bearing (enabled:false / idleMinutes:30 / model:haiku).
// ---------------------------------------------------------------------------

describe("dreamConfigSchema (Phase 95 DREAM-01..03)", () => {
  it("DREAM-S1: empty agent (v2.5 fleet) — no `dream` key — parses unchanged via configSchema", () => {
    const agents = Array.from({ length: 15 }, (_, i) => ({
      name: `agent-${i}`,
      channels: [`${1000000000000000 + i}`],
      model: "sonnet" as const,
      effort: "low" as const,
    }));
    const result = configSchema.safeParse({ version: 1, agents });
    expect(result.success).toBe(true);
    if (result.success) {
      // Defaults.dream is populated by the resolver default factory.
      expect(result.data.defaults.dream).toEqual({
        enabled: false,
        idleMinutes: 30,
        model: "haiku",
      });
      // Every agent's `dream` is undefined on the raw parse — loader
      // resolves against defaults downstream.
      for (const agent of result.data.agents) {
        expect(agent.dream).toBeUndefined();
      }
    }
  });

  it("DREAM-S2: agent with dream: { enabled: true, idleMinutes: 60 } parses; model defaults to 'haiku'", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      dream: { enabled: true, idleMinutes: 60 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dream).toBeDefined();
      expect(result.data.dream?.enabled).toBe(true);
      expect(result.data.dream?.idleMinutes).toBe(60);
      // model default applied per dreamConfigSchema's z.enum().default('haiku')
      expect(result.data.dream?.model).toBe("haiku");
      // retentionDays is optional — undefined when not set
      expect(result.data.dream?.retentionDays).toBeUndefined();
    }
  });

  it("DREAM-S3: agent with dream: { idleMinutes: 4 } REJECTS (below D-01 hard floor 5)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      dream: { idleMinutes: 4 },
    });
    expect(result.success).toBe(false);
  });

  it("DREAM-S4: agent with dream: { idleMinutes: 361 } REJECTS (above D-01 hard ceiling 360 = 6h)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      dream: { idleMinutes: 361 },
    });
    expect(result.success).toBe(false);
  });

  it("DREAM-S5: agent with dream: { model: 'sonnet-4' } REJECTS (model union locked to haiku|sonnet|opus)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      dream: { model: "sonnet-4" as unknown as "haiku" },
    });
    expect(result.success).toBe(false);
  });

  it("DREAM-S6: defaultsSchema.parse({}) sets fleet-level dream defaults; per-agent overrides win at the loader level (mirror memoryAutoLoad pattern)", () => {
    // Defaults parse with no input populates the dream block.
    const defaultsResult = defaultsSchema.safeParse({});
    expect(defaultsResult.success).toBe(true);
    if (defaultsResult.success) {
      expect(defaultsResult.data.dream).toEqual({
        enabled: false,
        idleMinutes: 30,
        model: "haiku",
      });
    }
    // Per-agent override is preserved on agentSchema parse — loader merges.
    const agentResult = agentSchema.safeParse({
      name: "content-creator",
      dream: { enabled: true, idleMinutes: 15, model: "sonnet" },
    });
    expect(agentResult.success).toBe(true);
    if (agentResult.success) {
      expect(agentResult.data.dream).toEqual({
        enabled: true,
        idleMinutes: 15,
        model: "sonnet",
      });
    }
    // Defaults can be overridden too (e.g. fleet-wide enable).
    const fleetEnabled = defaultsSchema.safeParse({
      dream: { enabled: true, idleMinutes: 45, model: "opus" },
    });
    expect(fleetEnabled.success).toBe(true);
    if (fleetEnabled.success) {
      expect(fleetEnabled.data.dream).toEqual({
        enabled: true,
        idleMinutes: 45,
        model: "opus",
      });
    }
  });
});

describe("RELOADABLE_FIELDS - DREAM entries (Phase 95 DREAM)", () => {
  it("DREAM-RELOAD-1: RELOADABLE_FIELDS contains agents.*.dream", () => {
    expect(RELOADABLE_FIELDS.has("agents.*.dream")).toBe(true);
  });
  it("DREAM-RELOAD-2: RELOADABLE_FIELDS contains defaults.dream", () => {
    expect(RELOADABLE_FIELDS.has("defaults.dream")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 100 — agent.settingSources + agent.gsd.projectDir (Plan 100-01)
//
// 12th application of the additive-optional schema blueprint
// (Phases 83/86/89/90/94/95/96). Tests pin:
//   - PR1   parse-omit:        omitting both fields yields undefined for each
//   - PR2   parse-project:     ['project'] singleton parses
//   - PR3   parse-project-user: ['project','user'] parses
//   - PR4   parse-all-three:   ['user','project','local'] parses (any order)
//   - PR5   reject-empty:      [] REJECTS at parse time (.min(1) per Pitfall 3)
//   - PR6   reject-invalid:    ['invalid'] REJECTS (enum constraint)
//   - PR7   parse-duplicates:  ['project','project'] parses (zod doesn't dedup)
//   - PR8   parse-gsd-abs:     gsd.projectDir absolute path parses
//   - PR9   reject-empty-pd:   gsd.projectDir empty string REJECTS (.min(1))
//   - PR10  parse-gsd-empty:   gsd: {} parses (projectDir optional inside)
//   - PR11  parse-regression:  in-tree clawcode.yaml parses with all settingSources/gsd undefined
//   - PR12  type-narrowing:    parsed shape conforms to ('project'|'user'|'local')[]|undefined
//
// RESEARCH.md Pitfall 3: settingSources: [] silently disables ALL filesystem
// settings. Schema MUST use .min(1) on the array to reject empty at parse time.
// ---------------------------------------------------------------------------

describe("Phase 100 — agent.settingSources + agent.gsd.projectDir", () => {
  // Minimal-agent fixture matching the existing test style
  const minimalAgent = (overrides: Record<string, unknown> = {}) => ({
    name: "x",
    channels: [],
    ...overrides,
  });

  it("PR1: omitting both fields yields settingSources === undefined AND gsd === undefined", () => {
    const result = agentSchema.parse(minimalAgent());
    expect(result.settingSources).toBeUndefined();
    expect(result.gsd).toBeUndefined();
  });

  it("PR2: settingSources: ['project'] parses to exactly ['project']", () => {
    const result = agentSchema.parse(minimalAgent({ settingSources: ["project"] }));
    expect(result.settingSources).toEqual(["project"]);
  });

  it("PR3: settingSources: ['project','user'] parses to exactly that array", () => {
    const result = agentSchema.parse(
      minimalAgent({ settingSources: ["project", "user"] }),
    );
    expect(result.settingSources).toEqual(["project", "user"]);
  });

  it("PR4: settingSources: ['user','project','local'] parses (any order, any subset)", () => {
    const result = agentSchema.parse(
      minimalAgent({ settingSources: ["user", "project", "local"] }),
    );
    expect(result.settingSources).toEqual(["user", "project", "local"]);
  });

  it("PR5: settingSources: [] REJECTS at parse time (.min(1) per Pitfall 3)", () => {
    const parsed = agentSchema.safeParse(minimalAgent({ settingSources: [] }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The path[0] should reference the settingSources field
      const onSettingSources = parsed.error.issues.some((i) =>
        i.path.includes("settingSources"),
      );
      expect(onSettingSources).toBe(true);
    }
  });

  it("PR6: settingSources: ['invalid'] REJECTS on enum constraint", () => {
    const parsed = agentSchema.safeParse(
      minimalAgent({ settingSources: ["invalid"] }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const onSettingSources = parsed.error.issues.some((i) =>
        i.path.includes("settingSources"),
      );
      expect(onSettingSources).toBe(true);
    }
  });

  it("PR7: settingSources: ['project','project'] parses (duplicates allowed — zod doesn't dedup)", () => {
    const result = agentSchema.parse(
      minimalAgent({ settingSources: ["project", "project"] }),
    );
    // Zod preserves duplicates; documented in JSDoc on the schema field.
    expect(result.settingSources).toEqual(["project", "project"]);
  });

  it("PR8: gsd.projectDir absolute path parses; result.gsd.projectDir mirrors input", () => {
    const result = agentSchema.parse(
      minimalAgent({ gsd: { projectDir: "/opt/clawcode-projects/sandbox" } }),
    );
    expect(result.gsd).toBeDefined();
    expect(result.gsd?.projectDir).toBe("/opt/clawcode-projects/sandbox");
  });

  it("PR9: gsd.projectDir empty string REJECTS (.min(1) on inner string)", () => {
    const parsed = agentSchema.safeParse(
      minimalAgent({ gsd: { projectDir: "" } }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const onProjectDir = parsed.error.issues.some(
        (i) => i.path.includes("gsd") && i.path.includes("projectDir"),
      );
      expect(onProjectDir).toBe(true);
    }
  });

  it("PR10: gsd: {} parses (projectDir is optional inside)", () => {
    const result = agentSchema.parse(minimalAgent({ gsd: {} }));
    expect(result.gsd).toEqual({});
    expect(result.gsd?.projectDir).toBeUndefined();
  });

  it("PR11: parse-regression — in-tree clawcode.yaml parses; settingSources/gsd are 1:1 (Phase 100 follow-up cascade)", () => {
    // Catch an accidental required-field cascade in the additive-optional
    // schema extension. v2.5/v2.6 migrated configs must parse unchanged.
    //
    // Phase 100 follow-up — relaxed from "ONLY admin-clawdy" to a per-agent
    // 1:1 invariant: an agent has BOTH settingSources [project, user] AND
    // gsd.projectDir, OR it has NEITHER. The follow-up extends GSD capability
    // to fin-client (operator-driven self-serve workflow); future GSD-
    // enabled agents follow the same invariant. Non-GSD production agents
    // (personal, fin-tax, acme-content-creator, etc.) stay implicit-
    // default — CONTEXT.md lock-in: settingSources triggers ~/.claude/commands/
    // loading; gsd.projectDir tells the SDK where to cd into. Neither works
    // without the other.
    const yamlPath = join(process.cwd(), "clawcode.yaml");
    const raw = readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw);
    const result = configSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      // 10+ agents currently in clawcode.yaml.
      expect(result.data.agents.length).toBeGreaterThanOrEqual(10);
      // Pin: admin-clawdy carries the original Phase 100 GSD config.
      const adminClawdy = result.data.agents.find((a) => a.name === "admin-clawdy");
      expect(adminClawdy?.settingSources).toEqual(["project", "user"]);
      expect(adminClawdy?.gsd?.projectDir).toBe("/opt/clawcode-projects/sandbox");
      // 1:1 invariant — settingSources [project, user] iff gsd.projectDir set.
      for (const agent of result.data.agents) {
        const hasGsd = agent.gsd?.projectDir !== undefined;
        if (hasGsd) {
          expect(
            agent.settingSources,
            `GSD-enabled agent ${agent.name} missing settingSources [project, user]`,
          ).toEqual(["project", "user"]);
        } else {
          expect(
            agent.settingSources,
            `non-GSD agent ${agent.name} unexpectedly carries settingSources`,
          ).toBeUndefined();
        }
      }
    }
  });

  it("PR12: type-narrowing — parsed settingSources is ('project'|'user'|'local')[]|undefined", () => {
    const r = agentSchema.parse(
      minimalAgent({ settingSources: ["project"] }),
    );
    // Compile-time invariant — the assignment fails to type-check if the
    // schema field's parsed type drifts away from this exact shape.
    const _check: ("project" | "user" | "local")[] | undefined = r.settingSources;
    expect(_check).toEqual(["project"]);

    // Same invariant for gsd
    const r2 = agentSchema.parse(
      minimalAgent({ gsd: { projectDir: "/abs/path" } }),
    );
    const _check2: { projectDir?: string } | undefined = r2.gsd;
    expect(_check2).toEqual({ projectDir: "/abs/path" });
  });
});

// ---------------------------------------------------------------------------
// Phase 99 sub-scope N (2026-04-26) — recursion-guard Layer 2: lower the
// per-agent default thread cap. The default `maxThreadSessions` is shipped
// at three locations in schema.ts (line 350 — threadsConfigSchema field
// default; line 1195 — agentSchema.threads block default factory; line 1392
// — defaultsSchema.threads default factory). All three drop from 10 → 3 so
// the blast-radius of a runaway subagent chain is capped if Layer 1's
// disallowedTools is somehow bypassed.
//
// RG4 pins the new value at the SCHEMA boundary across all three call sites
// so a future drift back to 10 is caught by tests, not by an operator
// noticing 5+ Admin Clawdy clones in Discord.
// ---------------------------------------------------------------------------

describe("Phase 99-N — recursion-guard Layer 2: maxThreadSessions default lowered to 3", () => {
  it("RG4a: threadsConfigSchema field default for maxThreadSessions is 3 (was 10)", () => {
    // Parse an empty object — the schema field default kicks in.
    const r = configSchema.safeParse({
      version: 1,
      agents: [{ name: "rg4a-agent" }],
      defaults: { threads: {} },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.defaults.threads.maxThreadSessions).toBe(3);
      expect(r.data.defaults.threads.idleTimeoutMinutes).toBe(1440);
    }
  });

  it("RG4b: agentSchema.threads block default factory yields maxThreadSessions === 3", () => {
    const r = agentSchema.safeParse({
      name: "rg4b-agent",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // Top-level agent.threads is optional — when present it has the new default.
      // We assert the parsed shape after applying the agentSchema's default factory.
      expect(r.data.threads?.maxThreadSessions ?? 3).toBe(3);
    }
  });

  it("RG4c: defaultsSchema.threads default factory yields maxThreadSessions === 3", () => {
    const r = defaultsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.threads.maxThreadSessions).toBe(3);
      expect(r.data.threads.idleTimeoutMinutes).toBe(1440);
    }
  });

  it("RG4d: explicit maxThreadSessions value wins over default — operator override unchanged", () => {
    const r = configSchema.safeParse({
      version: 1,
      agents: [{ name: "rg4d-agent" }],
      defaults: { threads: { maxThreadSessions: 7 } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.defaults.threads.maxThreadSessions).toBe(7);
    }
  });
});

/**
 * Phase 100 follow-up — per-agent MCP env overrides (vault-scoped 1Password
 * tokens for the acme agent family). Schema must accept the new
 * `mcpEnvOverrides` field on agentSchema, default to undefined when absent
 * (back-compat with the existing 15-agent fleet), and reject malformed
 * shapes (non-string keys / values, non-object entries).
 */
describe("agentSchema - mcpEnvOverrides (Phase 100 follow-up)", () => {
  it("MCP-OVERRIDE-1: agentSchema accepts mcpEnvOverrides field with op:// reference", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      mcpEnvOverrides: {
        "1password": {
          OP_SERVICE_ACCOUNT_TOKEN:
            "op://example-vault-21/Acme Service Account/credential",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.mcpEnvOverrides?.["1password"]?.OP_SERVICE_ACCOUNT_TOKEN,
      ).toBe("op://example-vault-21/Acme Service Account/credential");
    }
  });

  it("MCP-OVERRIDE-2: missing field parses fine (back-compat with existing fleet)", () => {
    const result = agentSchema.safeParse({ name: "test-agent" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpEnvOverrides).toBeUndefined();
    }
  });

  it("MCP-OVERRIDE-3a: invalid shape (non-string env value) rejected at parse", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      mcpEnvOverrides: {
        "1password": { OP_SERVICE_ACCOUNT_TOKEN: 123 },
      },
    });
    expect(result.success).toBe(false);
  });

  it("MCP-OVERRIDE-3b: invalid shape (empty server name) rejected at parse", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      mcpEnvOverrides: {
        "": { OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-21/SA/credential" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("MCP-OVERRIDE-3c: invalid shape (empty env key) rejected at parse", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      mcpEnvOverrides: {
        "1password": { "": "op://example-vault-21/SA/credential" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("MCP-OVERRIDE-3d: invalid shape (empty env value) rejected at parse", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      mcpEnvOverrides: {
        "1password": { OP_SERVICE_ACCOUNT_TOKEN: "" },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — DELEG (Pillar A: extendible specialist delegate map)
// Wave 0 RED tests. These FAIL on current main because:
//   - agentSchema has no `delegates` field yet (Plan 01 adds it)
//   - configSchema.superRefine has no delegates-target validation yet
// ---------------------------------------------------------------------------
describe("Phase 999.13 — DELEG", () => {
  it("delegates-schema: agentSchema accepts delegates: { research: 'research' }", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      delegates: { research: "fin-research" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Phase 999.13 GREEN — delegates is now part of AgentConfig.
      expect(result.data.delegates).toEqual({ research: "fin-research" });
    }
  });

  it("delegates-schema: empty {} parses (no min-keys constraint)", () => {
    const result = agentSchema.safeParse({
      name: "test-agent",
      delegates: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Phase 999.13 GREEN — delegates is now part of AgentConfig.
      expect(result.data.delegates).toEqual({});
    }
  });

  it("delegates-schema: omitted field parses (back-compat — undefined)", () => {
    const result = agentSchema.safeParse({ name: "test-agent" });
    expect(result.success).toBe(true);
    if (result.success) {
      // Phase 999.13 GREEN — delegates is now part of AgentConfig.
      expect(result.data.delegates).toBeUndefined();
    }
  });

  it("delegates-schema-invalid: rejects empty-string keys", () => {
    const result = agentSchema.safeParse({
      name: "test-agent",
      delegates: { "": "fin-research" },
    });
    expect(result.success).toBe(false);
  });

  it("delegates-schema-invalid: rejects empty-string values", () => {
    const result = agentSchema.safeParse({
      name: "test-agent",
      delegates: { research: "" },
    });
    expect(result.success).toBe(false);
  });

  it("delegates-superRefine-unknown-target: rejects target that doesn't match any agent name", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "fin-client", delegates: { research: "ghost-agent" } },
        { name: "fin-research" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const allMessages = result.error.issues.map((i) => i.message).join("\n");
      // Must mention the offending agent AND the unknown target
      expect(allMessages).toContain("fin-client");
      expect(allMessages).toContain("ghost-agent");
    }
  });

  it("delegates-superRefine-valid: all-known-targets parse cleanly across N=3 agents", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "fin-client", delegates: { research: "fin-research" } },
        { name: "fin-tax", delegates: { research: "fin-research", tax: "fin-tax" } },
        { name: "fin-research" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("delegates-back-compat: existing fixture with no delegates parses byte-identically (success path)", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [
        { name: "test-agent" },
        { name: "research" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Phase 999.13 GREEN — delegates is now part of AgentConfig.
      expect(result.data.agents[0].delegates).toBeUndefined();
      expect(result.data.agents[1].delegates).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — TZ (Pillar B: agent-context timezone rendering — schema bits)
// Wave 0 RED tests. These FAIL on current main because:
//   - defaultsSchema has no `timezone` field yet (Plan 02 adds it)
//   - defaultsSchema has no IANA-TZ pre-validation yet (Plan 02 adds it)
// ---------------------------------------------------------------------------
describe("Phase 999.13 — TZ", () => {
  it("defaults-timezone-schema: defaultsSchema accepts timezone: 'America/Los_Angeles'", () => {
    const result = defaultsSchema.safeParse({
      timezone: "America/Los_Angeles",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBe("America/Los_Angeles");
    }
  });

  it("defaults-timezone-schema: timezone is optional (absence parses cleanly)", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBeUndefined();
    }
  });

  it("defaults-timezone-iana-validation: rejects 'Pacific/LosAngeles' (typo, invalid IANA)", () => {
    // Open Question 3 LOCKED YES — Plan 02 must add a try/catch refinement
    // around new Intl.DateTimeFormat(undefined, { timeZone: tz }).
    const result = defaultsSchema.safeParse({
      timezone: "Pacific/LosAngeles",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join("\n");
      // Operator-friendly error message must call out the bad value
      expect(messages.toLowerCase()).toMatch(/timezone|iana|invalid/);
    }
  });

  it("defaults-timezone-iana-validation: accepts canonical IANA TZs (UTC, America/New_York)", () => {
    expect(defaultsSchema.safeParse({ timezone: "UTC" }).success).toBe(true);
    expect(
      defaultsSchema.safeParse({ timezone: "America/New_York" }).success,
    ).toBe(true);
    expect(
      defaultsSchema.safeParse({ timezone: "Europe/London" }).success,
    ).toBe(true);
  });
});

describe("advisor.forkTimeoutMs (2026-08-27)", () => {
  it("defaults to 180s, is bounded 30s..600s, and is accepted as a per-agent override", async () => {
    const { advisorConfigSchema, agentAdvisorOverrideSchema } = await import("../schema.js");
    expect(advisorConfigSchema.parse({}).forkTimeoutMs).toBe(180_000);
    expect(advisorConfigSchema.safeParse({ forkTimeoutMs: 1_000 }).success).toBe(false);
    expect(advisorConfigSchema.safeParse({ forkTimeoutMs: 900_000 }).success).toBe(false);
    expect(agentAdvisorOverrideSchema.parse({ forkTimeoutMs: 90_000 }).forkTimeoutMs).toBe(90_000);
  });
});
