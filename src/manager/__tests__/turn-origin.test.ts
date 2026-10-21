import { describe, it, expect } from "vitest";
import {
  SOURCE_KINDS,
  TurnOriginSchema,
  makeRootOrigin,
  makeRootOriginWithTurnId,
  makeRootOriginWithCausation,
  makeTurnId,
  TURN_ID_REGEX,
  DISCORD_SNOWFLAKE_PREFIX,
  type TurnOrigin,
} from "../turn-origin.js";

describe("TurnOriginSchema", () => {
  it("round-trips a valid origin", () => {
    const origin = {
      source: { kind: "discord" as const, id: "msg_123" },
      rootTurnId: "discord:abc123XYZ0",
      parentTurnId: null,
      chain: ["discord:abc123XYZ0"],
    };
    const parsed = TurnOriginSchema.parse(origin);
    // causationId defaults to null for backward compatibility (Phase 60 TRIG-08)
    expect(parsed).toEqual({ ...origin, causationId: null });
  });

  it("rejects unknown source.kind", () => {
    expect(() =>
      TurnOriginSchema.parse({
        // "carrier-pigeon" is intentionally never a registered SOURCE_KIND
        // (was "slack" before the multi-platform-messaging phase registered it).
        source: { kind: "carrier-pigeon", id: "x" },
        rootTurnId: "discord:abc123XYZ0",
        parentTurnId: null,
        chain: ["discord:abc123XYZ0"],
      }),
    ).toThrow();
  });

  it("rejects empty chain", () => {
    expect(() =>
      TurnOriginSchema.parse({
        source: { kind: "discord", id: "x" },
        rootTurnId: "discord:abc123XYZ0",
        parentTurnId: null,
        chain: [],
      }),
    ).toThrow();
  });

  it("rejects empty-string parentTurnId", () => {
    expect(() =>
      TurnOriginSchema.parse({
        source: { kind: "discord", id: "x" },
        rootTurnId: "discord:abc123XYZ0",
        parentTurnId: "",
        chain: ["discord:abc123XYZ0"],
      }),
    ).toThrow();
  });
});

describe("makeRootOrigin", () => {
  it("produces a discord-kind origin with matching turnId regex", () => {
    const origin = makeRootOrigin("discord", "msg_123");
    expect(origin.source).toEqual({ kind: "discord", id: "msg_123" });
    expect(origin.parentTurnId).toBeNull();
    expect(origin.chain).toEqual([origin.rootTurnId]);
    expect(origin.rootTurnId).toMatch(/^discord:[a-zA-Z0-9_-]{10,}$/);
    expect(origin.rootTurnId).toMatch(TURN_ID_REGEX);
  });

  it("produces a scheduler-kind origin with matching regex", () => {
    const origin = makeRootOrigin("scheduler", "daily-report");
    expect(origin.rootTurnId).toMatch(/^scheduler:[a-zA-Z0-9_-]{10,}$/);
  });

  it("produces a task-kind origin (reserved for Phase 59)", () => {
    const origin = makeRootOrigin("task", "x");
    expect(origin.rootTurnId).toMatch(/^task:[a-zA-Z0-9_-]{10,}$/);
  });

  it("produces a trigger-kind origin (reserved for Phase 60)", () => {
    const origin = makeRootOrigin("trigger", "x");
    expect(origin.rootTurnId).toMatch(/^trigger:[a-zA-Z0-9_-]{10,}$/);
  });

  it("generates distinct rootTurnIds on successive calls", () => {
    const a = makeRootOrigin("discord", "x");
    const b = makeRootOrigin("discord", "x");
    expect(a.rootTurnId).not.toBe(b.rootTurnId);
  });

  it("returns a deeply frozen origin", () => {
    const origin = makeRootOrigin("discord", "msg_123");
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.source)).toBe(true);
    expect(Object.isFrozen(origin.chain)).toBe(true);
  });

  it("includes causationId: null by default (Phase 60 backward compat)", () => {
    const origin = makeRootOrigin("discord", "msg_123");
    expect(origin.causationId).toBeNull();
  });
});

describe("makeTurnId", () => {
  it("produces turnIds matching TURN_ID_REGEX for every SourceKind", () => {
    for (const kind of ["discord", "scheduler", "task", "trigger", "openai-api"] as const) {
      const id = makeTurnId(kind);
      expect(id).toMatch(TURN_ID_REGEX);
      expect(id.startsWith(`${kind}:`)).toBe(true);
    }
  });

  it("uses a 10-char nanoid suffix (matches scheduler convention)", () => {
    // Format: `${kind}:${nanoid(10)}` — suffix length is exactly 10
    const id = makeTurnId("discord");
    const suffix = id.slice("discord:".length);
    expect(suffix).toHaveLength(10);
  });
});

describe("DISCORD_SNOWFLAKE_PREFIX", () => {
  it("equals 'discord:'", () => {
    expect(DISCORD_SNOWFLAKE_PREFIX).toBe("discord:");
  });
});

describe("makeRootOriginWithTurnId", () => {
  it("uses the caller-supplied turnId as rootTurnId (Discord snowflake preservation)", () => {
    const snowflake = "000000000000000103";
    const turnId = `${DISCORD_SNOWFLAKE_PREFIX}${snowflake}`;
    const origin = makeRootOriginWithTurnId("discord", snowflake, turnId);

    expect(origin.rootTurnId).toBe(turnId);
    expect(origin.rootTurnId).toBe("discord:000000000000000103");
    expect(origin.chain).toEqual([turnId]);
    expect(origin.parentTurnId).toBeNull();
    expect(origin.source).toEqual({ kind: "discord", id: snowflake });
  });

  it("accepts a snowflake-formatted turnId (17-19 digits, matches TURN_ID_REGEX)", () => {
    const turnId = "discord:000000000000000103"; // 19-digit snowflake
    expect(turnId).toMatch(TURN_ID_REGEX);
    const origin = makeRootOriginWithTurnId("discord", "000000000000000103", turnId);
    expect(origin.rootTurnId).toBe(turnId);
  });

  it("throws on turnId not matching TURN_ID_REGEX (bad format)", () => {
    expect(() => makeRootOriginWithTurnId("discord", "x", "bad-format")).toThrow(/TURN_ID_REGEX/);
  });

  it("throws on turnId with too-short suffix (< 10 chars after prefix)", () => {
    expect(() => makeRootOriginWithTurnId("discord", "x", "discord:short")).toThrow(/TURN_ID_REGEX/);
  });

  it("returns a deeply frozen origin (same invariants as makeRootOrigin)", () => {
    const origin = makeRootOriginWithTurnId("discord", "000000000000000103", "discord:000000000000000103");
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.source)).toBe(true);
    expect(Object.isFrozen(origin.chain)).toBe(true);
  });
});

describe("Phase 69 — openai-api kind", () => {
  it("SOURCE_KINDS includes 'openai-api' as 5th element", () => {
    expect(SOURCE_KINDS).toContain("openai-api");
    // multi-platform-messaging phase appended 'slack' as the 6th kind.
    expect(SOURCE_KINDS.length).toBe(6);
    expect(SOURCE_KINDS[4]).toBe("openai-api");
  });

  it("SOURCE_KINDS includes 'slack' as 6th element (multi-platform messaging)", () => {
    expect(SOURCE_KINDS).toContain("slack");
    expect(SOURCE_KINDS[5]).toBe("slack");
  });

  it("makeTurnId('openai-api') produces a turnId matching TURN_ID_REGEX", () => {
    const id = makeTurnId("openai-api");
    expect(id.startsWith("openai-api:")).toBe(true);
    expect(TURN_ID_REGEX.test(id)).toBe(true);
  });

  it("TURN_ID_REGEX accepts openai-api: prefixed ids with 10+ char bodies", () => {
    expect(TURN_ID_REGEX.test("openai-api:abc12def45")).toBe(true);
    expect(TURN_ID_REGEX.test("openai-api:short")).toBe(false);
  });

  it("makeRootOrigin('openai-api', fingerprint) produces frozen origin with correct kind", () => {
    const origin = makeRootOrigin("openai-api", "deadbeef");
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.source)).toBe(true);
    expect(Object.isFrozen(origin.chain)).toBe(true);
    expect(origin.source.kind).toBe("openai-api");
    expect(origin.source.id).toBe("deadbeef");
    expect(origin.parentTurnId).toBeNull();
    expect(origin.rootTurnId).toMatch(TURN_ID_REGEX);
    expect(origin.rootTurnId.startsWith("openai-api:")).toBe(true);
  });

  it("makeRootOriginWithTurnId('openai-api', ..., 'openai-api:custom-foo01') preserves the custom turnId", () => {
    const turnId = "openai-api:custom-foo01";
    const origin = makeRootOriginWithTurnId("openai-api", "deadbeef", turnId);
    expect(origin.rootTurnId).toBe(turnId);
    expect(origin.chain).toEqual([turnId]);
    expect(origin.source.kind).toBe("openai-api");
  });

  it("makeRootOriginWithTurnId throws on non-matching turnId", () => {
    expect(() =>
      makeRootOriginWithTurnId("openai-api", "x", "wrong-format"),
    ).toThrow(/TURN_ID_REGEX/);
  });

  it("TurnOriginSchema accepts source.kind = 'openai-api' without modification", () => {
    const parsed = TurnOriginSchema.parse({
      source: { kind: "openai-api", id: "fp_abc123" },
      rootTurnId: "openai-api:abc123XYZ0",
      parentTurnId: null,
      chain: ["openai-api:abc123XYZ0"],
    });
    expect(parsed.source.kind).toBe("openai-api");
    expect(parsed.causationId).toBeNull();
  });
});

describe("makeRootOriginWithCausation", () => {
  it("produces a trigger-kind origin with non-null causationId", () => {
    const origin = makeRootOriginWithCausation("trigger", "cron-daily", "abc123");
    expect(origin.source).toEqual({ kind: "trigger", id: "cron-daily" });
    expect(origin.rootTurnId).toMatch(/^trigger:[a-zA-Z0-9_-]{10,}$/);
    expect(origin.parentTurnId).toBeNull();
    expect(origin.chain).toEqual([origin.rootTurnId]);
    expect(origin.causationId).toBe("abc123");
  });

  it("passes TurnOriginSchema validation with causationId set", () => {
    const origin = makeRootOriginWithCausation("trigger", "webhook-src", "xyz789");
    const parsed = TurnOriginSchema.parse(origin);
    expect(parsed.causationId).toBe("xyz789");
  });

  it("returns a deeply frozen origin", () => {
    const origin = makeRootOriginWithCausation("trigger", "x", "cid");
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.source)).toBe(true);
    expect(Object.isFrozen(origin.chain)).toBe(true);
  });
});
