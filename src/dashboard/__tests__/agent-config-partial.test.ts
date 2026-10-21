/**
 * dashboard-rework P2 — verify the agent-config-panel partial-builder emits
 * patches that satisfy the daemon's REAL `agentSchema.partial()`. The read-only
 * dev proxy can't exercise `PUT /api/config/agents/:name`, so validating the
 * emitted PATCH SHAPE against the authoritative zod schema here is the backstop
 * that catches a malformed write before a restart-gated deploy.
 */
import { describe, it, expect } from "vitest";
import { agentSchema } from "../../config/schema.js";
import {
  buildAgentPartial,
  formStateFromRaw,
  type FormState,
} from "../client/src/lib/agent-config-partial.js";

const partialSchema = agentSchema.partial();

const BASE: FormState = {
  workspace: "/home/clawcode/.clawcode/agents/x",
  memoryPath: "",
  model: "sonnet",
  effort: "high",
  channels: "111\n222",
  allowedModels: ["sonnet", "opus"],
  skills: "subagent-thread\nnew-reel",
  plugins: "",
  memoryAutoLoad: true,
  memoryRetrievalTopK: 8,
  mcpServers: ["clawcode", "memory-search"],
  schedules: [],
  dreamEnabled: false,
  dreamIdleMinutes: 30,
  dreamModel: "haiku",
  dreamRetentionDays: "",
  optimizerEnabled: false,
  optimizerEvalSet: "",
  optimizerRaw: {},
};

describe("agentSchema.partial() is usable", () => {
  it("agentSchema is a ZodObject exposing .partial()", () => {
    expect(typeof agentSchema.partial).toBe("function");
    expect(partialSchema.safeParse({}).success).toBe(true);
  });
});

describe("buildAgentPartial emits schema-valid patches", () => {
  it("no edits → empty patch (valid)", () => {
    const patch = buildAgentPartial(BASE, BASE);
    expect(Object.keys(patch)).toHaveLength(0);
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });

  it("editing scalars + arrays → patch parses against agentSchema.partial()", () => {
    const next: FormState = {
      ...BASE,
      model: "opus",
      effort: "xhigh",
      channels: "111\n222\n333",
      skills: "subagent-thread",
      allowedModels: ["sonnet", "opus", "haiku"],
      memoryAutoLoad: false,
      memoryRetrievalTopK: 12,
    };
    // current = edited (next), original = loaded (BASE)
    const patch = buildAgentPartial(next, BASE);
    // every changed field present, none of the unchanged ones
    expect(Object.keys(patch).sort()).toEqual(
      ["allowedModels", "channels", "effort", "memoryAutoLoad", "memoryRetrievalTopK", "model", "skills"].sort(),
    );
    const res = partialSchema.safeParse(patch);
    expect(res.success).toBe(true);
    // arrays are emitted as trimmed string[] (not the newline textarea form)
    expect(patch.channels).toEqual(["111", "222", "333"]);
    expect(patch.skills).toEqual(["subagent-thread"]);
  });

  it("clearing memoryPath emits undefined (omittable, still valid)", () => {
    const withPath: FormState = { ...BASE, memoryPath: "/tmp/mp" };
    // current = cleared form, original = had a path
    const patch = buildAgentPartial({ ...withPath, memoryPath: "" }, withPath);
    expect(patch.memoryPath).toBeUndefined();
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });

  it("blank channels/skills collapse to empty arrays (valid)", () => {
    // current = blanked form, original = BASE (had values)
    const patch = buildAgentPartial({ ...BASE, channels: "  \n \n", skills: "" }, BASE);
    expect(patch.channels).toEqual([]);
    expect(patch.skills).toEqual([]);
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });
});

describe("increment 2: mcpServers / schedules / dream patches are schema-valid", () => {
  it("attaching an MCP string-ref emits a valid mcpServers array", () => {
    const next: FormState = { ...BASE, mcpServers: [...BASE.mcpServers, "acme-db"] };
    const patch = buildAgentPartial(next, BASE);
    expect(patch.mcpServers).toEqual(["clawcode", "memory-search", "acme-db"]);
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });

  it("inline MCP object (name+command) is accepted alongside string refs", () => {
    const next: FormState = {
      ...BASE,
      mcpServers: ["clawcode", { name: "custom", command: "node", args: ["x.js"] }],
    };
    const patch = buildAgentPartial(next, BASE);
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });

  it("editing schedules emits a valid schedules array; half-filled rows dropped", () => {
    const next: FormState = {
      ...BASE,
      schedules: [
        { id: "a", name: "daily", cron: "0 9 * * *", prompt: "morning brief", enabled: true },
        { id: "b", name: "", cron: "", prompt: "", enabled: true }, // incomplete → dropped
      ],
    };
    const patch = buildAgentPartial(next, BASE);
    expect(patch.schedules).toHaveLength(1);
    // the client-only `id` must NOT reach the wire patch
    expect((patch.schedules as Array<Record<string, unknown>>)[0]).not.toHaveProperty("id");
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });

  it("an incomplete-only schedule edit produces no schedules key", () => {
    const next: FormState = {
      ...BASE,
      schedules: [{ id: "a", name: "x", cron: "", prompt: "", enabled: true }],
    };
    const patch = buildAgentPartial(next, BASE);
    expect("schedules" in patch).toBe(false);
  });

  it("enabling dream emits a valid dream object", () => {
    const next: FormState = {
      ...BASE,
      dreamEnabled: true,
      dreamIdleMinutes: 45,
      dreamModel: "sonnet",
    };
    const patch = buildAgentPartial(next, BASE);
    expect(patch.dream).toEqual({ enabled: true, idleMinutes: 45, model: "sonnet" });
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });

  it("out-of-range dream idleMinutes is rejected by the schema (sanity)", () => {
    expect(partialSchema.safeParse({ dream: { enabled: true, idleMinutes: 9999 } }).success).toBe(
      false,
    );
  });

  it("editing plugins emits a trimmed ref array (valid against schema)", () => {
    const next: FormState = {
      ...BASE,
      plugins: "discord@claude-plugins-official\n  agent-sdk-dev@claude-plugins-official  \n",
    };
    const patch = buildAgentPartial(next, BASE);
    expect(patch.plugins).toEqual([
      "discord@claude-plugins-official",
      "agent-sdk-dev@claude-plugins-official",
    ]);
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });

  it("enabling the optimizer MERGES over the resolved block (preserves knobs)", () => {
    const resolvedOpt = { enabled: false, model: "opus", maxActionsPerRun: 5 };
    const orig: FormState = { ...BASE, optimizerRaw: resolvedOpt };
    const next: FormState = {
      ...orig,
      optimizerEnabled: true,
      optimizerEvalSet: "evals/personal.json",
    };
    const patch = buildAgentPartial(next, orig);
    expect(patch.optimizer).toMatchObject({
      enabled: true,
      model: "opus",
      maxActionsPerRun: 5,
      evalSet: "evals/personal.json",
    });
    expect(partialSchema.safeParse(patch).success).toBe(true);
  });
});

describe("schema actually rejects bad values (sanity)", () => {
  it("an invalid effort enum is rejected by the partial schema", () => {
    expect(partialSchema.safeParse({ effort: "ludicrous" }).success).toBe(false);
  });
});

describe("formStateFromRaw round-trips resolved config", () => {
  it("reads arrays + scalars out of a raw block", () => {
    const fs = formStateFromRaw({
      model: "haiku",
      channels: ["a", "b"],
      skills: ["s1"],
      memoryRetrievalTopK: 5,
    });
    expect(fs.model).toBe("haiku");
    expect(fs.channels).toBe("a\nb");
    expect(fs.skills).toBe("s1");
    expect(fs.memoryRetrievalTopK).toBe(5);
  });
});
