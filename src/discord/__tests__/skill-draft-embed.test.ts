/**
 * Phase 132 Plan 03 T-02 — skill-draft-embed module tests.
 *
 * Covers EM-01..EM-08 from the plan; the embed shape is byte-locked against
 * CONTEXT.md §specifics — any divergence from the field labels fails EM-02.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildSkillDraftEmbed,
  postSkillDraftEmbed,
  type DraftStagedRecord,
} from "../skill-draft-embed.js";

function makeRecord(overrides: Partial<DraftStagedRecord> = {}): DraftStagedRecord {
  return {
    draftId: "find-clients-by-industry-2026-05-16-120000-abc123def456",
    slug: "find-clients-by-industry",
    agent: "admin-clawdy",
    sessionId: "sess-abc123",
    trajectoryFingerprint: "abc123def456abc123def456",
    stepCount: 4,
    manifest: {
      name: "find-clients-by-industry",
      description: 'when user asks "which clients do X". Lists clients by industry.',
      version: "1.0.0",
      owner: "admin-clawdy",
      capabilities: [],
      requiredTools: ["mysql_query"],
      requiredMcpServers: ["clawcode_share_file"],
    },
    draftPath:
      "/home/x/.clawcode/agents/admin-clawdy/skills-staging/find-clients-by-industry-2026-05-16-120000-abc123def456.md",
    ...overrides,
  };
}

describe("skill-draft-embed (Phase 132 Plan 03 T-02)", () => {
  it("EM-01: title is the locked 📜 Candidate skill ready for review", () => {
    const embed = buildSkillDraftEmbed(makeRecord());
    const json = embed.toJSON();
    expect(json.title).toContain("Candidate skill ready for review");
    expect(json.title).toContain("📜");
  });

  it("EM-02: 8 required fields all present (Edit went with /edit-skill, 2026-09-23)", () => {
    const embed = buildSkillDraftEmbed(makeRecord());
    const json = embed.toJSON();
    const names = (json.fields ?? []).map((f) => f.name);
    expect(names).toEqual([
      "Agent",
      "Name",
      "Trigger",
      "Tools",
      "Steps",
      "Source session",
      "Approve",
      "Reject",
    ]);
  });

  it("EM-03: Approve field contains /approve-skill <draftId>", () => {
    const r = makeRecord();
    const embed = buildSkillDraftEmbed(r);
    const approve = embed.toJSON().fields!.find((f) => f.name === "Approve")!;
    expect(approve.value).toContain(`/approve-skill ${r.draftId}`);
  });

  it("EM-04: Reject field contains /reject-skill <draftId> [reason]", () => {
    const r = makeRecord();
    const embed = buildSkillDraftEmbed(r);
    const reject = embed.toJSON().fields!.find((f) => f.name === "Reject")!;
    expect(reject.value).toContain(`/reject-skill ${r.draftId} [reason]`);
  });

  it("EM-05: no field points at the retired /edit-skill command", () => {
    const embed = buildSkillDraftEmbed(makeRecord());
    const values = (embed.toJSON().fields ?? []).map((f) => `${f.name} ${f.value}`);
    expect(values.some((v) => v.includes("/edit-skill"))).toBe(false);
  });

  it("EM-06: Tools field joins requiredTools + requiredMcpServers", () => {
    const r = makeRecord();
    const embed = buildSkillDraftEmbed(r);
    const tools = embed.toJSON().fields!.find((f) => f.name === "Tools")!;
    expect(tools.value).toBe("mysql_query, clawcode_share_file");
  });

  it("EM-07: Trigger derives first clause of description", () => {
    const r = makeRecord();
    const embed = buildSkillDraftEmbed(r);
    const trigger = embed.toJSON().fields!.find((f) => f.name === "Trigger")!;
    // First sentence up to the first period.
    expect(trigger.value).toBe('when user asks "which clients do X"');
  });

  it("EM-07b: Trigger handles description without a period gracefully", () => {
    const r = makeRecord({
      manifest: {
        ...makeRecord().manifest,
        description: "no period here",
      },
    });
    const embed = buildSkillDraftEmbed(r);
    const trigger = embed.toJSON().fields!.find((f) => f.name === "Trigger")!;
    expect(trigger.value).toBe("no period here");
  });

  it("EM-08: postSkillDraftEmbed calls bridge.postEmbedToAgentChannel", async () => {
    const post = vi.fn(async () => "msg-789");
    const fakeBridge = {
      postEmbedToAgentChannel: post,
    };
    const r = makeRecord();
    const embed = buildSkillDraftEmbed(r);
    const result = await postSkillDraftEmbed(
      fakeBridge as unknown as Parameters<typeof postSkillDraftEmbed>[0],
      r.agent,
      embed,
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(r.agent, embed);
    expect(result).toBe("msg-789");
  });

  it("EM-08b: postSkillDraftEmbed swallows bridge errors and returns null", async () => {
    const post = vi.fn(async () => {
      throw new Error("discord down");
    });
    const fakeBridge = {
      postEmbedToAgentChannel: post,
    };
    const r = makeRecord();
    const embed = buildSkillDraftEmbed(r);
    const result = await postSkillDraftEmbed(
      fakeBridge as unknown as Parameters<typeof postSkillDraftEmbed>[0],
      r.agent,
      embed,
    );
    expect(result).toBeNull();
  });

  it("EM-stepcount: Steps field is the stringified stepCount", () => {
    const r = makeRecord({ stepCount: 7 });
    const embed = buildSkillDraftEmbed(r);
    const steps = embed.toJSON().fields!.find((f) => f.name === "Steps")!;
    expect(steps.value).toBe("7");
  });
});
