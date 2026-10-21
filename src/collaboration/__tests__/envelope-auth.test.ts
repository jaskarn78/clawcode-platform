import { describe, it, expect } from "vitest";
import {
  canonicalEnvelopeString,
  signA2aEnvelope,
  verifyA2aEnvelope,
  type A2aEnvelopeFields,
} from "../envelope-auth.js";

const SECRET = "0".repeat(64);
const FIELDS: A2aEnvelopeFields = {
  deliveryId: "d-123",
  sender: "personal",
  recipient: "projects",
  content: "Handoff: PG&E account integration.",
};

describe("envelope-auth", () => {
  it("sign → verify roundtrip", () => {
    const sig = signA2aEnvelope(SECRET, FIELDS);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyA2aEnvelope(SECRET, FIELDS, sig)).toBe(true);
  });

  it("every bound field is tamper-evident", () => {
    const sig = signA2aEnvelope(SECRET, FIELDS);
    const tampered: A2aEnvelopeFields[] = [
      { ...FIELDS, deliveryId: "d-124" },
      { ...FIELDS, sender: "client-a-personal" },
      { ...FIELDS, recipient: "Admin Clawdy" },
      { ...FIELDS, content: FIELDS.content + "!" },
    ];
    for (const fields of tampered) {
      expect(verifyA2aEnvelope(SECRET, fields, sig)).toBe(false);
    }
  });

  it("wrong secret fails", () => {
    const sig = signA2aEnvelope(SECRET, FIELDS);
    expect(verifyA2aEnvelope("1".repeat(64), FIELDS, sig)).toBe(false);
  });

  it("malformed signatures are rejected, never throw", () => {
    for (const bad of ["", "zz", "deadbeef", "Z".repeat(64), signA2aEnvelope(SECRET, FIELDS).toUpperCase()]) {
      expect(verifyA2aEnvelope(SECRET, FIELDS, bad)).toBe(false);
    }
  });

  it("fields cannot smuggle separators into each other's positions", () => {
    // sender ends with what looks like the next field's start — the content
    // hash keeps free text out of the joined string entirely, and \n-joined
    // fixed fields keep positions stable.
    const a = canonicalEnvelopeString({ ...FIELDS, sender: "a\nb", recipient: "c" });
    const b = canonicalEnvelopeString({ ...FIELDS, sender: "a", recipient: "b\nc" });
    expect(a).not.toBe(b);
  });
});
