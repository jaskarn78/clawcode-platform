import { describe, it, expect } from "vitest";
import {
  RetryActionRegistry,
  buildRetryButtonRow,
  retryCustomId,
  parseRetryCustomId,
  RETRY_PREFIX,
  classifyFailure,
  plainFailureReason,
} from "../retry-actions.js";

const base = {
  noticeMessageId: "notice-1",
  channelId: "chan-1",
  agentName: "fin-client",
  userId: "client-a",
  originalMessageId: "orig-1",
  replayMessage: "what's the CA rate?",
};

describe("retry customId", () => {
  it("round-trips the notice message id", () => {
    const id = retryCustomId("abc123");
    expect(id).toBe(`${RETRY_PREFIX}abc123`);
    expect(parseRetryCustomId(id)).toBe("abc123");
  });
  it("rejects a foreign or empty custom id", () => {
    expect(parseRetryCustomId("ra:abc:0")).toBeNull();
    expect(parseRetryCustomId(RETRY_PREFIX)).toBeNull();
  });
});

describe("buildRetryButtonRow", () => {
  it("is a single secondary Retry button with no Unicode label (icons unloaded → no emoji)", () => {
    const row = buildRetryButtonRow("notice-1");
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(1);
    const btn = row.components[0]!;
    expect(btn).toMatchObject({ type: 2, style: 2, custom_id: "retry:notice-1", label: "Retry" });
    // No cc_ icon loaded in the test process → no emoji key (never a Unicode glyph).
    expect("emoji" in btn).toBe(false);
    expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(btn.label)).toBe(false);
  });
});

describe("RetryActionRegistry", () => {
  it("the original author may click; the entry is consumed (single-use)", () => {
    const reg = new RetryActionRegistry();
    reg.register(base);
    // peek does NOT consume — the busy-guard may keep the button.
    const first = reg.peek(retryCustomId("notice-1"), "client-a");
    expect(first.kind).toBe("ok");
    if (first.kind === "ok") expect(first.entry.replayMessage).toBe("what's the CA rate?");
    expect(reg.size()).toBe(1);
    // The dispatching path consumes it (single-use); a later peek finds nothing.
    expect(reg.consume("notice-1")?.originalMessageId).toBe("orig-1");
    expect(reg.peek(retryCustomId("notice-1"), "client-a").kind).toBe("expired");
    expect(reg.size()).toBe(0);
  });

  it("a configured admin may click; a stranger may not", () => {
    const reg = new RetryActionRegistry();
    reg.register(base);
    expect(reg.peek(retryCustomId("notice-1"), "someone-else").kind).toBe("not-yours");
    // admin allowed
    expect(reg.peek(retryCustomId("notice-1"), "sam", ["sam"]).kind).toBe("ok");
  });

  it("expires after the TTL", () => {
    let now = 1_000;
    const reg = new RetryActionRegistry(60_000, () => now);
    reg.register(base);
    now += 60_001;
    expect(reg.peek(retryCustomId("notice-1"), "client-a").kind).toBe("expired");
  });

  it("unknown custom id is reported as such", () => {
    const reg = new RetryActionRegistry();
    expect(reg.peek("ra:x:0", "client-a").kind).toBe("unknown");
  });

  it("in-flight dedupe: a second retry of the same notice is refused until it ends", () => {
    const reg = new RetryActionRegistry();
    reg.register(base);
    expect(reg.beginRetry("notice-1")).toBe(true);
    expect(reg.isRetrying("notice-1")).toBe(true);
    // A concurrent click is refused while the first retry dispatches.
    expect(reg.beginRetry("notice-1")).toBe(false);
    reg.endRetry("notice-1");
    expect(reg.isRetrying("notice-1")).toBe(false);
    // After it ends, a fresh retry may begin again.
    expect(reg.beginRetry("notice-1")).toBe(true);
  });

  it("prunes expired entries on register", () => {
    let now = 1_000;
    const reg = new RetryActionRegistry(60_000, () => now);
    reg.register({ ...base, noticeMessageId: "old" });
    now += 60_001;
    reg.register({ ...base, noticeMessageId: "new" });
    // The stale "old" entry was swept when "new" registered.
    expect(reg.size()).toBe(1);
    expect(reg.peek(retryCustomId("new"), "client-a").kind).toBe("ok");
  });

  it("forget drops an entry without dispatching", () => {
    const reg = new RetryActionRegistry();
    reg.register(base);
    expect(reg.forget("notice-1")?.originalMessageId).toBe("orig-1");
    expect(reg.size()).toBe(0);
  });
});

describe("failure reason builder", () => {
  it("classifies a crash / session-restart error", () => {
    expect(classifyFailure("exited with code 143")).toBe("crash");
    expect(classifyFailure("Agent 'fin-client' is not running")).toBe("crash");
  });
  it("classifies a queue-full error and defaults everything else to generic", () => {
    expect(classifyFailure("QUEUE_FULL")).toBe("queue-full");
    expect(classifyFailure("some other network blip")).toBe("generic");
  });
  it("gives a plain, user-safe sentence for each kind (no raw error, no emoji)", () => {
    for (const kind of ["crash", "queue-full", "no-answer", "generic"] as const) {
      const reason = plainFailureReason(kind);
      expect(reason.length).toBeGreaterThan(0);
      expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(reason)).toBe(false);
      // Never leaks stack/error tokens.
      expect(reason).not.toMatch(/code 143|QUEUE_FULL|Error|undefined/);
    }
  });
});
