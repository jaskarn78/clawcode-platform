/**
 * C3 — dispatch-path wiring proof for the cross-agent memory IPC gate.
 *
 * Unit tests for `decideAgentIdentity` prove the gate LOGIC; this proves the
 * gate is actually WIRED into the real `routeMethod` dispatch path. It honors
 * the cross-ref plan's "forged param must be rejected by the real handler, not
 * just the helper" bar — without standing up a full daemon socket (no
 * `startDaemon` test harness exists in this repo).
 *
 * Mechanism: a `switch` jumps straight to the matched case, and
 * `enforceAgentIdentity` fires at the TOP of each gated case BEFORE any store/
 * dep is dereferenced — so a forged-token call throws before the (stubbed)
 * deps are touched. We seed the daemon's identity secret via
 * `initAgentIdentitySecret` (reads CLAWCODE_IDENTITY_SECRET) so the test can
 * mint a token for agent A and assert the daemon rejects A's token claiming B.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { routeMethod, initAgentIdentitySecret } from "../daemon.js";
import { computeAgentToken } from "../agent-identity-token.js";

const TEST_SECRET = "a".repeat(64); // 32-byte hex
let savedEnv: string | undefined;

beforeAll(() => {
  savedEnv = process.env.CLAWCODE_IDENTITY_SECRET;
  process.env.CLAWCODE_IDENTITY_SECRET = TEST_SECRET;
  initAgentIdentitySecret(); // pin the module secret to TEST_SECRET
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.CLAWCODE_IDENTITY_SECRET;
  else process.env.CLAWCODE_IDENTITY_SECRET = savedEnv;
});

// All routeMethod deps are unused on the reject path (enforce throws first).
// `undefined as never` for the positional deps after `params`.
function callRouteMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const u = undefined as never;
  return routeMethod(
    u, // manager
    [], // configs
    method,
    params,
    u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u,
    // Phase 999.114 — getCatalogSnapshot (set-model `@latest` resolution).
    (() => []) as never,
    // Phase 999.117 — a2a services bundle. Unused on the reject path.
    u,
  );
}

describe("C3 dispatch-path gate (routeMethod)", () => {
  it("REJECTS a write (memory-save) where agent A's token claims agent B", async () => {
    const tokenForPersonal = computeAgentToken(TEST_SECRET, "personal");
    await expect(
      callRouteMethod("memory-save", {
        agent: "fin-client", // attacker target
        content: "planted",
        tags: [],
        importance: 0.7,
        _agentToken: tokenForPersonal,
        _callerAgent: "personal", // token proves caller is personal
      }),
    ).rejects.toThrow(/cross-agent access denied/);
  });

  it("REJECTS a read (memory-search) where agent A's token claims agent B", async () => {
    const tokenForPersonal = computeAgentToken(TEST_SECRET, "personal");
    await expect(
      callRouteMethod("memory-search", {
        agent: "fin-client",
        query: "client SSN",
        _agentToken: tokenForPersonal,
        _callerAgent: "personal",
      }),
    ).rejects.toThrow(/cross-agent access denied/);
  });

  it("REJECTS a forged (invalid HMAC) token on a write", async () => {
    await expect(
      callRouteMethod("memory-save", {
        agent: "fin-client",
        content: "x",
        tags: [],
        importance: 0.7,
        _agentToken: "deadbeef".repeat(8),
        _callerAgent: "fin-client",
      }),
    ).rejects.toThrow(/invalid agent identity token/);
  });

  it("does NOT reject at the gate when A's token acts on its OWN agent (gate passes; later store deref is out of scope)", async () => {
    // A valid same-agent call must NOT throw the cross-agent error. It WILL
    // throw later (stubbed manager has no getMemoryStore) — we assert only that
    // the failure is NOT the identity gate, proving a legitimate caller passes.
    const tokenForFin = computeAgentToken(TEST_SECRET, "fin-client");
    await expect(
      callRouteMethod("memory-search", {
        agent: "fin-client",
        query: "q",
        _agentToken: tokenForFin,
        _callerAgent: "fin-client",
      }),
    ).rejects.not.toThrow(/cross-agent access denied|invalid agent identity token/);
  });
});
