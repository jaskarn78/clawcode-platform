import { describe, it, expect } from "vitest";
import { formatTier, renderBootReport, renderConfirm, renderLogin, renderStatus } from "../account-swap-render.js";
import { isAccountAdmin, resolveMacAgent } from "../account-swap-wiring.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

const NOW = 1_800_000_000_000;
const summary = (tier: string | null, sha = "abc123def456") => ({
  present: true,
  readable: true,
  subscriptionType: "max",
  rateLimitTier: tier,
  refreshSha: sha,
  expiresAt: NOW + 7.9 * 3_600_000,
});

describe("formatTier", () => {
  it("reads the Max multiplier", () => {
    expect(formatTier(summary("default_claude_max_20x"))).toBe("Max 20x");
    expect(formatTier(summary(null))).toBe("max");
  });
});

describe("renderStatus", () => {
  it("shows live account and slot health", () => {
    const text = renderStatus(
      {
        configDir: "/x",
        activeSlot: "main",
        live: summary("default_claude_max_20x"),
        slots: [
          { ...summary("default_claude_max_20x"), name: "main", matchesLive: true },
          { ...summary(null), present: false, name: "admin", matchesLive: false },
        ],
        configured: [
          { name: "main", email: "main@example.com" },
          { name: "admin", email: "admin@example.com" },
        ],
      },
      NOW,
    );
    expect(text).toContain("`main` · main@example.com · Max 20x");
    expect(text).toContain("rollback copy current");
    expect(text).toContain("`admin` · admin@example.com — not saved yet");
  });
});

describe("renderConfirm", () => {
  it("warns on a plan change and names busy agents", () => {
    const text = renderConfirm({
      target: "admin",
      email: "admin@example.com",
      summary: summary("default_claude_max_5x"),
      fromSlot: "main",
      fromTier: "Max 20x",
      runningAgents: 8,
      busyAgents: ["fin-client"],
      freshLogin: true,
    });
    expect(text).toContain("Max 20x → Max 5x");
    expect(text).toContain("fin-client");
    expect(text).toContain("8 running agents");
  });
});

describe("renderLogin", () => {
  it("masks the link and shows the Mac status", () => {
    const text = renderLogin({
      target: "admin",
      email: "admin@example.com",
      why: "expired",
      url: "https://claude.com/cai/oauth/authorize?state=s",
      expiresAt: NOW,
      mac: { kind: "unavailable", reason: "screen locked" },
    });
    expect(text).toContain("[Open the sign-in page](<https://claude.com/cai/oauth/authorize?state=s>)");
    expect(text).toContain("`screen locked`");
    expect(text).toContain(`<t:${NOW / 1000}:R>`);
  });
});

describe("untrusted Mac reason", () => {
  it("renders inert — a markdown link cannot become clickable", () => {
    const text = renderLogin({
      target: "admin",
      email: "admin@example.com",
      why: "expired",
      url: "https://claude.com/cai/oauth/authorize?state=s",
      expiresAt: NOW,
      mac: { kind: "unavailable", reason: "[click here](https://evil.example) `x`" },
    });
    expect(text).toContain("`[click here](https://evil.example)  x`");
  });
});

describe("renderBootReport", () => {
  const base = {
    ok: true,
    changed: true,
    from: "main",
    to: "admin",
    channelId: "1",
    requestedBy: "42",
    appliedAt: NOW,
    error: null,
  };
  it("reports success with the probe verdict", () => {
    const text = renderBootReport({ result: base, live: summary("default_claude_max_5x"), liveEmail: "admin@example.com", probeOk: true, runningAgents: 8, now: NOW });
    expect(text).toContain("`main` → `admin`");
    expect(text).toContain("✅");
  });
  it("reports failure without claiming a switch", () => {
    const text = renderBootReport({ result: { ...base, ok: false, error: "slot 'admin' is not seeded" }, live: summary(null), liveEmail: null, probeOk: null, runningAgents: 8, now: NOW });
    expect(text).toContain("failed");
    expect(text).toContain("not changed");
  });
});

describe("account admin gate", () => {
  const agents = [
    { name: "Admin Clawdy", admin: true },
    { name: "personal", admin: false },
  ] as unknown as ResolvedAgentConfig[];
  const routing = {
    channelToAgent: new Map([
      ["admin-chan", "Admin Clawdy"],
      ["personal-chan", "personal"],
    ]),
  };
  const input = { adminUserIds: ["op"], getRoutingTable: () => routing, resolvedAgents: agents };

  it("requires BOTH the admin user id and an admin channel", () => {
    expect(isAccountAdmin({ user: { id: "op" }, channelId: "admin-chan" }, input)).toBe(true);
    expect(isAccountAdmin({ user: { id: "op" }, channelId: "personal-chan" }, input)).toBe(false);
    expect(isAccountAdmin({ user: { id: "someone" }, channelId: "admin-chan" }, input)).toBe(false);
  });

  it("fails closed with an empty allowlist", () => {
    expect(isAccountAdmin({ user: { id: "op" }, channelId: "admin-chan" }, { ...input, adminUserIds: [] })).toBe(false);
  });

  it("resolves the Mac agent from config or the admin flag", () => {
    expect(resolveMacAgent(agents, undefined)).toBe("Admin Clawdy");
    expect(resolveMacAgent(agents, "personal")).toBe("personal");
    expect(resolveMacAgent(agents, "missing")).toBeUndefined();
  });
});
