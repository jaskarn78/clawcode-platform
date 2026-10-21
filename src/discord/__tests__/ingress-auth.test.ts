import { describe, it, expect } from "vitest";
import { evaluateEnvelopeAuth, isHumanAuthorAllowed } from "../ingress-auth.js";
import { signA2aEnvelope, type A2aEnvelopeFields } from "../../collaboration/envelope-auth.js";
import {
  buildAgentMessageEmbed,
  parseAgentMessageFooter,
  truncateA2aDescription,
} from "../agent-message.js";

const SECRET = "s".repeat(64);
const FIELDS: A2aEnvelopeFields = {
  deliveryId: "d-1",
  sender: "personal",
  recipient: "projects",
  content: "do the thing",
};

describe("evaluateEnvelopeAuth", () => {
  const sig = signA2aEnvelope(SECRET, FIELDS);

  it("off → skipped, dispatch (pre-999.144 behavior)", () => {
    expect(evaluateEnvelopeAuth("off", SECRET, FIELDS, undefined))
      .toEqual({ verdict: "skipped", dispatch: true });
  });

  it("no secret → dispatch even under enforce (boot window, fail open like _callerAgent)", () => {
    expect(evaluateEnvelopeAuth("enforce", null, FIELDS, sig))
      .toEqual({ verdict: "no-secret", dispatch: true });
  });

  it("shadow logs but always dispatches", () => {
    expect(evaluateEnvelopeAuth("shadow", SECRET, FIELDS, undefined))
      .toEqual({ verdict: "unsigned", dispatch: true });
    expect(evaluateEnvelopeAuth("shadow", SECRET, FIELDS, "0".repeat(64)))
      .toEqual({ verdict: "bad-signature", dispatch: true });
    expect(evaluateEnvelopeAuth("shadow", SECRET, FIELDS, sig))
      .toEqual({ verdict: "pass", dispatch: true });
  });

  it("enforce dispatches ONLY a valid signature", () => {
    expect(evaluateEnvelopeAuth("enforce", SECRET, FIELDS, sig))
      .toEqual({ verdict: "pass", dispatch: true });
    expect(evaluateEnvelopeAuth("enforce", SECRET, FIELDS, undefined).dispatch).toBe(false);
    expect(evaluateEnvelopeAuth("enforce", SECRET, FIELDS, "0".repeat(64)).dispatch).toBe(false);
  });

  it("enforce refuses a crafted footer over new content (the incident vector)", () => {
    const forged = evaluateEnvelopeAuth(
      "enforce", SECRET,
      { ...FIELDS, content: "@everyone join https://spam.invalid" },
      sig,
    );
    expect(forged).toEqual({ verdict: "bad-signature", dispatch: false });
  });
});

describe("footer sig roundtrip", () => {
  it("build → parse carries sender, id and sig", () => {
    const content = "x".repeat(5000); // forces truncation
    const desc = truncateA2aDescription(content);
    const sig = signA2aEnvelope(SECRET, { ...FIELDS, content: desc });
    const embed = buildAgentMessageEmbed("personal", "Personal", desc, "d-1", sig);
    const parsed = parseAgentMessageFooter(embed.data.footer?.text);
    expect(parsed).toEqual({ senderName: "personal", deliveryId: "d-1", sig });
    // and the signature verifies against the POSTED description
    expect(embed.data.description).toBe(desc);
  });

  it("legacy footers (no sig / no id) still parse — append-only contract", () => {
    expect(parseAgentMessageFooter("Agent-to-agent message from personal"))
      .toEqual({ senderName: "personal" });
    expect(parseAgentMessageFooter("Agent-to-agent message from Admin Clawdy · id:abc"))
      .toEqual({ senderName: "Admin Clawdy", deliveryId: "abc" });
  });

  it("a sender name containing the id separator still parses (last-occurrence rule)", () => {
    const sig = "a".repeat(64);
    const embed = buildAgentMessageEmbed("weird · id:name", "W", "hi", "d-9", sig);
    expect(parseAgentMessageFooter(embed.data.footer?.text))
      .toEqual({ senderName: "weird · id:name", deliveryId: "d-9", sig });
  });
});

describe("isHumanAuthorAllowed", () => {
  it("undefined allowlist = feature off = allow", () => {
    expect(isHumanAuthorAllowed(undefined, "123")).toBe(true);
  });
  it("configured list is exact-match", () => {
    const ids = ["000000000000000002", "000000000000000003"];
    expect(isHumanAuthorAllowed(ids, "000000000000000002")).toBe(true);
    expect(isHumanAuthorAllowed(ids, "999")).toBe(false);
  });
  it("empty list denies (fail closed — unrepresentable via schema, but never allow-all)", () => {
    expect(isHumanAuthorAllowed([], "123")).toBe(false);
  });
});
