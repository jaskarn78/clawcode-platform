/**
 * 2026-07-31 — verification per-knob cascade + coverage warn
 * (loadConfig → resolveAgentConfig). Mirrors loader-steering.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, resolveAgentConfig } from "../loader.js";

describe("verification cascade — 2026-07-31 adaptive budget", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "clawcode-fv-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function load(yamlLines: string[]): Promise<{
    agents: Parameters<typeof resolveAgentConfig>[0][];
    defaults: Parameters<typeof resolveAgentConfig>[1];
    mcpServers: Parameters<typeof resolveAgentConfig>[2];
  }> {
    const cfgPath = join(tmpDir, "clawcode.yaml");
    await writeFile(cfgPath, yamlLines.join("\n"), "utf-8");
    const loaded = await loadConfig(cfgPath);
    return loaded as unknown as {
      agents: Parameters<typeof resolveAgentConfig>[0][];
      defaults: Parameters<typeof resolveAgentConfig>[1];
      mcpServers: Parameters<typeof resolveAgentConfig>[2];
    };
  }

  it("no block anywhere → resolved verification is undefined (byte-stable fleet)", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: fixture-a",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toBeUndefined();
  });

  it("defaults block → schema fills budget knobs; agent inherits", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  verification:",
      "    enforced: false",
      "agents:",
      "  - name: fixture-a",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toEqual({
      enforced: false,
      maxVerifyHops: 1,
      skipIfTurnMsOver: 120_000,
      shrinkIfTurnMsOver: 30_000,
      deferMs: 2_000,
      // C — hold-mode defaults (schema-filled when a defaults block exists).
      holdDelivery: false,
      holdTimeoutMs: 45_000,
    });
  });

  it("per-agent knob beats defaults; unset knobs fall through", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  verification:",
      "    skipIfTurnMsOver: 90000",
      "agents:",
      "  - name: fixture-a",
      "    verification:",
      "      maxVerifyHops: 2",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toMatchObject({
      maxVerifyHops: 2, // per-agent
      skipIfTurnMsOver: 90_000, // defaults (explicit)
      shrinkIfTurnMsOver: 30_000, // defaults (schema-filled)
      deferMs: 2_000, // defaults (schema-filled)
    });
    // enforced omitted everywhere → stays tri-state undefined (prefix rule).
    expect(resolved.verification?.enforced).toBeUndefined();
  });

  it("agent-only block → emitted with only the concrete knobs", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: fixture-a",
      "    verification:",
      "      deferMs: 0",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toEqual({ deferMs: 0 });
  });

  it("schema rejects out-of-range knobs (maxVerifyHops 3)", async () => {
    await expect(
      load([
        "version: 1",
        "defaults:",
        "  verification:",
        "    maxVerifyHops: 3",
        "agents:",
        "  - name: fixture-a",
        "",
      ]),
    ).rejects.toThrow();
  });

  it("phase999.63-coverage-resolver warns for an enforced agent with zero coverage", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { agents, defaults } = await load([
        "version: 1",
        "defaults:",
        // Disallow native WebSearch so the fallback coverage path closes.
        "  disallowedTools:",
        "    - WebSearch",
        "agents:",
        "  - name: fin-fixture",
        "",
      ]);
      resolveAgentConfig(agents[0]!, defaults);
      const hits = warnSpy.mock.calls.filter(
        (c) => c[0] === "phase999.63-coverage-resolver",
      );
      expect(hits.length).toBe(1);
      const payload = JSON.parse(hits[0]![1] as string);
      expect(payload.agent).toBe("fin-fixture");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("999.63b — block without ruleClaims resolves WITHOUT a ruleClaims key (byte-stable)", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: fixture-a",
      "    verification:",
      "      deferMs: 0",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toEqual({ deferMs: 0 });
    expect(
      (resolved.verification as Record<string, unknown>)?.ruleClaims,
    ).toBeUndefined();
  });

  it("999.63b — defaults `ruleClaims: {}` → schema fills the shadow posture; agent inherits", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  verification:",
      "    ruleClaims: {}",
      "agents:",
      "  - name: fixture-a",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toMatchObject({
      ruleClaims: { enabled: true, maxVerifyHops: 0 },
    });
  });

  it("999.63b — per-agent ruleClaims knob beats defaults; unset knob falls through", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  verification:",
      "    ruleClaims: {}",
      "agents:",
      "  - name: fin-client",
      "    verification:",
      "      ruleClaims:",
      "        maxVerifyHops: 1",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification?.ruleClaims).toEqual({
      enabled: true, // defaults (schema-filled)
      maxVerifyHops: 1, // per-agent (the Stage-2 enforcement flip)
    });
  });

  it("999.63b — agent-only ruleClaims emitted with only the concrete knobs", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: fixture-a",
      "    verification:",
      "      ruleClaims:",
      "        enabled: false",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toEqual({
      ruleClaims: { enabled: false },
    });
  });

  it("C — per-agent holdDelivery opt-in cascades; timeout falls to the 45 s default", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  verification:",
      "    enforced: false",
      "agents:",
      "  - name: fixture-a",
      "    verification:",
      "      holdDelivery: true",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toMatchObject({
      holdDelivery: true, // per-agent opt-in
      holdTimeoutMs: 45_000, // defaults (schema-filled)
    });
  });

  it("C — agent-only holdTimeoutMs emitted concrete; holdDelivery stays absent (byte-stable)", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: fixture-a",
      "    verification:",
      "      holdTimeoutMs: 30000",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification).toEqual({ holdTimeoutMs: 30_000 });
  });

  it("999.63d — ux absent everywhere → no ux key (byte-stable)", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  verification:",
      "    maxVerifyHops: 1",
      "agents:",
      "  - name: fixture-a",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(
      (resolved.verification as Record<string, unknown>)?.ux,
    ).toBeUndefined();
  });

  it("999.63d — defaults `ux: {}` → schema fills all three knobs OFF; agent inherits", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  verification:",
      "    ux: {}",
      "agents:",
      "  - name: fixture-a",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification?.ux).toEqual({
      streamStatus: false,
      streamStatusMode: "auto", // 999.63d/5 — arming position, not a toggle
      narrationAsTrail: false, // 2026-08-27 — opt-in
      sourcesFooter: "off",
      verdictReactions: false,
      modelSourcesLine: "keep",
      ledgerButton: false,
      ledgerReaction: "🧾",
      liveClaims: false,
      statusMessage: "inline", // 2026-08-27 — separate status message is opt-in
      unverifiedNotice: true,
      compactBelowChars: 300,
      sourcesCharBudget: 480,
      pendingMarker: false,
      verifiedBadge: false,
    });
  });

  it("999.63d — per-agent ux knob beats defaults; unset knobs fall through", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  verification:",
      "    ux: {}",
      "agents:",
      "  - name: fin-client",
      "    verification:",
      "      ux:",
      "        streamStatus: true",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification?.ux).toEqual({
      streamStatus: true, // per-agent
      streamStatusMode: "auto", // defaults (schema-filled)
      narrationAsTrail: false, // defaults (schema-filled)
      sourcesFooter: "off",
      verdictReactions: false,
      modelSourcesLine: "keep",
      ledgerButton: false,
      ledgerReaction: "🧾",
      liveClaims: false,
      statusMessage: "inline", // 2026-08-27 — separate status message is opt-in
      unverifiedNotice: true,
      compactBelowChars: 300,
      sourcesCharBudget: 480,
      pendingMarker: false, // defaults (schema-filled)
      verifiedBadge: false, // defaults (schema-filled)
    });
  });

  it("999.63d — agent-only ux emitted with only the concrete knobs", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: fin-client",
      "    verification:",
      "      ux:",
      "        verifiedBadge: true",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.verification?.ux).toEqual({
      verifiedBadge: true,
    });
  });

  it("C — schema rejects out-of-range holdTimeoutMs", async () => {
    await expect(
      load([
        "version: 1",
        "agents:",
        "  - name: fixture-a",
        "    verification:",
        "      holdTimeoutMs: 1000",
        "",
      ]),
    ).rejects.toThrow();
  });

  it("999.63b — schema rejects out-of-range ruleClaims.maxVerifyHops", async () => {
    await expect(
      load([
        "version: 1",
        "agents:",
        "  - name: fixture-a",
        "    verification:",
        "      ruleClaims:",
        "        maxVerifyHops: 3",
        "",
      ]),
    ).rejects.toThrow();
  });

  it("no coverage warn for a non-enforced agent or a covered fin agent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { agents, defaults, mcpServers } = await load([
        "version: 1",
        "mcpServers:",
        "  finnhub:",
        "    name: finnhub",
        "    command: node",
        "    args:",
        "      - server.js",
        "agents:",
        "  - name: ops-fixture", // not fin-prefixed → never warns
        "  - name: fin-covered", // fin-prefixed but finnhub present
        "    mcpServers:",
        "      - finnhub",
        "",
      ]);
      resolveAgentConfig(agents[0]!, defaults, mcpServers);
      resolveAgentConfig(agents[1]!, defaults, mcpServers);
      const hits = warnSpy.mock.calls.filter(
        (c) => c[0] === "phase999.63-coverage-resolver",
      );
      expect(hits.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
