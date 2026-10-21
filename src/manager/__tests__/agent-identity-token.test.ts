import { describe, it, expect } from "vitest";
import {
  generateDaemonIdentitySecret,
  computeAgentToken,
  decideAgentIdentity,
} from "../agent-identity-token.js";

const SECRET = generateDaemonIdentitySecret();

describe("computeAgentToken", () => {
  it("is deterministic for the same secret + agent", () => {
    expect(computeAgentToken(SECRET, "fin")).toBe(computeAgentToken(SECRET, "fin"));
  });
  it("differs across agents", () => {
    expect(computeAgentToken(SECRET, "fin")).not.toBe(
      computeAgentToken(SECRET, "personal"),
    );
  });
  it("differs across secrets", () => {
    const other = generateDaemonIdentitySecret();
    expect(computeAgentToken(SECRET, "fin")).not.toBe(
      computeAgentToken(other, "fin"),
    );
  });
});

describe("decideAgentIdentity", () => {
  it("fails OPEN when no token (trusted CLI/dashboard path)", () => {
    const d = decideAgentIdentity({
      secret: SECRET,
      requestedAgent: "fin",
      token: undefined,
      callerAgent: undefined,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe("untokenized");
  });

  it("allows a valid token acting on its OWN agent", () => {
    const token = computeAgentToken(SECRET, "fin");
    const d = decideAgentIdentity({
      secret: SECRET,
      requestedAgent: "fin",
      token,
      callerAgent: "fin",
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.mode).toBe("verified");
  });

  it("REJECTS a valid token claiming a DIFFERENT target agent (impersonation)", () => {
    const token = computeAgentToken(SECRET, "personal");
    const d = decideAgentIdentity({
      secret: SECRET,
      requestedAgent: "fin", // attacker wants fin's memory
      token,
      callerAgent: "personal", // but token proves they are personal
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/cross-agent access denied/);
  });

  it("REJECTS a forged token (caller claims fin but token is invalid)", () => {
    const d = decideAgentIdentity({
      secret: SECRET,
      requestedAgent: "fin",
      token: "deadbeef".repeat(8), // not a valid HMAC for "fin"
      callerAgent: "fin",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/invalid agent identity token/);
  });

  it("REJECTS a token minted under a different secret", () => {
    const otherSecret = generateDaemonIdentitySecret();
    const token = computeAgentToken(otherSecret, "fin");
    const d = decideAgentIdentity({
      secret: SECRET,
      requestedAgent: "fin",
      token,
      callerAgent: "fin",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/invalid agent identity token/);
  });

  it("REJECTS a token present without a caller identity", () => {
    const token = computeAgentToken(SECRET, "fin");
    const d = decideAgentIdentity({
      secret: SECRET,
      requestedAgent: "fin",
      token,
      callerAgent: undefined,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/without a valid caller/);
  });

  it("REJECTS a non-string token", () => {
    const d = decideAgentIdentity({
      secret: SECRET,
      requestedAgent: "fin",
      token: 12345,
      callerAgent: "fin",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/must be a string/);
  });

  it("treats empty-string token as untokenized (fail-open)", () => {
    const d = decideAgentIdentity({
      secret: SECRET,
      requestedAgent: "fin",
      token: "",
      callerAgent: undefined,
    });
    expect(d.ok).toBe(true);
  });
});
