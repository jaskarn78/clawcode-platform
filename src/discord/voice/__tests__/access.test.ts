/**
 * Phase 135 Plan 03 Task 1 — voice ACL enforcement tests.
 *
 * Pins the contract for `enforceVoiceChannelAcl`:
 *   1. No security policies map registered → allow (open).
 *   2. Policy registered for agent but `channelAcls` empty → allow.
 *   3. Allowlisted user → allow.
 *   4. Non-allowlisted user → deny (silent drop) + info log.
 *   5. The SAME `checkChannelAccess` predicate from acl-parser.ts is the
 *      one invoked — no parallel auth route per RESEARCH § Anti-Patterns.
 *
 * The shared `checkChannelAccess` lives in `src/security/acl-parser.ts`.
 * We spy on it via vi.mock so we can assert the wrapper forwards through
 * that single seam (not via a parallel implementation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SecurityPolicy } from "../../../security/types.js";

// Mock the shared predicate so we can verify it IS called with the
// expected arguments. Tests below set `mockCheckChannelAccess.mockReturnValue(...)`.
const mockCheckChannelAccess = vi.fn();
vi.mock("../../../security/acl-parser.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkChannelAccess: (...args: unknown[]) => mockCheckChannelAccess(...args),
  };
});

import { enforceVoiceChannelAcl, __test as accessTestHelpers } from "../access.js";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("enforceVoiceChannelAcl — Phase 135 Plan 03 Task 1", () => {
  beforeEach(() => {
    mockCheckChannelAccess.mockReset();
    // Phase 135 REVIEW WR-03 — reset the warn-once-per-agent set
    // between tests so the open-ACL warn log fires deterministically
    // for cases that exercise it.
    accessTestHelpers.resetNoAclWarnedAgents();
  });

  it("allows when no security policies map is registered (undefined map)", () => {
    const log = makeLog();
    const result = enforceVoiceChannelAcl(undefined, "agent-x", "chan-1", "user-a", log as any);
    expect(result).toBe(true);
    expect(mockCheckChannelAccess).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("allows when no policy is registered for this agent (empty map)", () => {
    const log = makeLog();
    const policies = new Map<string, SecurityPolicy>();
    const result = enforceVoiceChannelAcl(policies, "agent-x", "chan-1", "user-a", log as any);
    expect(result).toBe(true);
    expect(mockCheckChannelAccess).not.toHaveBeenCalled();
  });

  it("allows when policy.channelAcls is empty (no-acl = open)", () => {
    const log = makeLog();
    const policies = new Map<string, SecurityPolicy>([
      ["agent-x", { allowlist: [], channelAcls: [] }],
    ]);
    const result = enforceVoiceChannelAcl(policies, "agent-x", "chan-1", "user-a", log as any);
    expect(result).toBe(true);
    expect(mockCheckChannelAccess).not.toHaveBeenCalled();
  });

  it("allows when checkChannelAccess returns true (allowlisted user)", () => {
    mockCheckChannelAccess.mockReturnValue(true);
    const log = makeLog();
    const acls = [{ channelId: "chan-1", allowedUserIds: ["user-a"], allowedRoles: [] }];
    const policies = new Map<string, SecurityPolicy>([
      ["agent-x", { allowlist: [], channelAcls: acls }],
    ]);
    const result = enforceVoiceChannelAcl(policies, "agent-x", "chan-1", "user-a", log as any);
    expect(result).toBe(true);
    expect(mockCheckChannelAccess).toHaveBeenCalledTimes(1);
    expect(mockCheckChannelAccess).toHaveBeenCalledWith("chan-1", "user-a", [], acls);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("denies when checkChannelAccess returns false (non-allowlisted user) + logs info", () => {
    mockCheckChannelAccess.mockReturnValue(false);
    const log = makeLog();
    const acls = [{ channelId: "chan-1", allowedUserIds: ["alice"], allowedRoles: [] }];
    const policies = new Map<string, SecurityPolicy>([
      ["agent-x", { allowlist: [], channelAcls: acls }],
    ]);
    const result = enforceVoiceChannelAcl(policies, "agent-x", "chan-1", "eve", log as any);
    expect(result).toBe(false);
    expect(mockCheckChannelAccess).toHaveBeenCalledWith("chan-1", "eve", [], acls);
    expect(log.info).toHaveBeenCalledTimes(1);
    const logArg = log.info.mock.calls[0]?.[0];
    expect(logArg).toMatchObject({
      agent: "agent-x",
      user: "eve",
      channel: "chan-1",
    });
  });

  it("passes empty userRoles array to checkChannelAccess (voice has no role context)", () => {
    mockCheckChannelAccess.mockReturnValue(true);
    const log = makeLog();
    const acls = [
      { channelId: "chan-1", allowedUserIds: [], allowedRoles: ["mod"] },
    ];
    const policies = new Map<string, SecurityPolicy>([
      ["agent-x", { allowlist: [], channelAcls: acls }],
    ]);
    enforceVoiceChannelAcl(policies, "agent-x", "chan-1", "user-a", log as any);
    const callArgs = mockCheckChannelAccess.mock.calls[0];
    expect(callArgs?.[2]).toEqual([]); // userRoles is [] for voice
  });

  // Phase 135 REVIEW WR-03 — warn-once-per-agent when voice path
  // admits transcripts with no channel ACL gating. Voice abuse cost
  // (Deepgram + ElevenLabs) is materially higher than text, so the
  // un-gated condition surfaces loudly at boot but not on every
  // utterance.
  describe("WR-03 warn-once when no ACL is enforced", () => {
    it("warns the FIRST time an agent admits a transcript with undefined securityPolicies", () => {
      const log = makeLog();
      enforceVoiceChannelAcl(undefined, "agent-x", "chan-1", "user-a", log as any);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]?.[0]).toMatchObject({
        agent: "agent-x",
        channel: "chan-1",
      });
    });

    it("does NOT warn again for the same agent on subsequent admissions (warn-once)", () => {
      const log = makeLog();
      enforceVoiceChannelAcl(undefined, "agent-x", "chan-1", "user-a", log as any);
      enforceVoiceChannelAcl(undefined, "agent-x", "chan-1", "user-b", log as any);
      enforceVoiceChannelAcl(undefined, "agent-x", "chan-1", "user-c", log as any);
      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it("warns once per agent (different agents → different warn-fires)", () => {
      const log = makeLog();
      enforceVoiceChannelAcl(undefined, "agent-x", "chan-1", "user-a", log as any);
      enforceVoiceChannelAcl(undefined, "agent-y", "chan-2", "user-b", log as any);
      enforceVoiceChannelAcl(undefined, "agent-x", "chan-1", "user-c", log as any);
      expect(log.warn).toHaveBeenCalledTimes(2);
    });

    it("warns when policy registered but channelAcls is empty (no-acl = open)", () => {
      const log = makeLog();
      const policies = new Map<string, SecurityPolicy>([
        ["agent-x", { allowlist: [], channelAcls: [] }],
      ]);
      enforceVoiceChannelAcl(policies, "agent-x", "chan-1", "user-a", log as any);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]?.[1]).toMatch(/no channel ACL/i);
    });

    it("does NOT warn when policy with non-empty channelAcls is registered (gated path)", () => {
      mockCheckChannelAccess.mockReturnValue(true);
      const log = makeLog();
      const acls = [{ channelId: "chan-1", allowedUserIds: ["user-a"], allowedRoles: [] }];
      const policies = new Map<string, SecurityPolicy>([
        ["agent-x", { allowlist: [], channelAcls: acls }],
      ]);
      enforceVoiceChannelAcl(policies, "agent-x", "chan-1", "user-a", log as any);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });
});
