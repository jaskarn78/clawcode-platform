/**
 * Phase 999.117 WS-4 — presentation registry tests.
 *
 * The registry exists so an acknowledgment can be a REACTION on the message
 * being acknowledged rather than a separate post. Production was emitting ~51
 * standalone "✅ X processed your message" posts a week — roughly one per real
 * message — each saying nothing the original could not say by wearing a
 * checkmark.
 */

import { describe, it, expect } from "vitest";
import {
  PresentationRegistry,
  RECEIPT_EMOJI,
} from "../presentation-registry.js";

describe("PresentationRegistry", () => {
  it("remembers where a delivery was rendered", () => {
    const r = new PresentationRegistry();
    r.record("del-1", { channelId: "chan-1", messageId: "msg-1" });
    expect(r.get("del-1")).toEqual({ channelId: "chan-1", messageId: "msg-1" });
  });

  it("returns undefined for an unknown or missing id", () => {
    const r = new PresentationRegistry();
    expect(r.get("nope")).toBeUndefined();
    expect(r.get(undefined)).toBeUndefined();
  });

  it("no-ops on incomplete input rather than throwing", () => {
    // This is best-effort decoration. Failing to remember where something was
    // rendered must never be able to fail the delivery itself.
    const r = new PresentationRegistry();
    expect(() => r.record(undefined, { channelId: "c", messageId: "m" })).not.toThrow();
    expect(() => r.record("d", undefined)).not.toThrow();
    expect(() => r.record("d", { channelId: "", messageId: "m" })).not.toThrow();
    expect(r.size()).toBe(0);
  });

  it("is bounded", () => {
    const r = new PresentationRegistry(50);
    for (let i = 0; i < 500; i++) {
      r.record(`d-${i}`, { channelId: "c", messageId: `m-${i}` });
    }
    expect(r.size()).toBeLessThanOrEqual(51);
  });

  it("exposes distinct receipt states", () => {
    // Several states can stack on one message instead of accumulating posts.
    const values = Object.values(RECEIPT_EMOJI);
    expect(new Set(values).size).toBe(values.length);
  });
});
