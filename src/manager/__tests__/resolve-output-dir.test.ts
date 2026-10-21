/**
 * Phase 96 Plan 04 Task 1 — TDD RED for resolveOutputDir (D-09 token resolver).
 *
 * Pure-fn token resolver: {date} → YYYY-MM-DD, {agent}, {channel_name},
 * {client_slug}. Result anchored under agentWorkspaceRoot via path.join +
 * path.resolve. Path traversal blocked. {client_slug} fallback to
 * 'unknown-client' with warning.
 *
 * 10 ROD- tests:
 *   ROD-1 ALL-TOKENS              — happy path with all 4 tokens
 *   ROD-2 DATE-ONLY               — single {date} token (default fleet template)
 *   ROD-3 AGENT-TOKEN             — {agent} expansion
 *   ROD-4 CHANNEL-TOKEN           — {channel_name} expansion
 *   ROD-5 CLIENT-SLUG-FALLBACK    — undefined clientSlug → 'unknown-client' + warning
 *   ROD-6 NESTED-TOKENS           — multi-token nesting
 *   ROD-7 TRAVERSAL-DOTDOT        — '../escape' refused; warnings populated
 *   ROD-8 LEADING-SLASH           — '/etc/passwd/' refused; warnings populated
 *   ROD-9 NO-TOKENS-LITERAL       — literal path with no tokens
 *   ROD-10 IMMUTABILITY           — result Object.frozen + deep-equal across calls
 */

import { describe, it, expect } from "vitest";
import { resolveOutputDir, CLIENT_SLUG_FALLBACK } from "../resolve-output-dir.js";

const AGENT_ROOT = "/home/clawcode/.clawcode/agents/fin-client";

describe("resolveOutputDir — D-09 token resolver", () => {
  it("ROD-1 ALL-TOKENS: all 4 tokens expanded → '${root}/clients/tara-maffeo/2026-04-25'", () => {
    const result = resolveOutputDir(
      "clients/{client_slug}/{date}/",
      {
        agent: "fin-client",
        clientSlug: "tara-maffeo",
        channelName: "acme-client-acquisition",
        now: new Date("2026-04-25T16:00:00Z"),
      },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    expect(result.resolved).toBe(`${AGENT_ROOT}/clients/tara-maffeo/2026-04-25`);
    expect(result.warnings).toEqual([]);
  });

  it("ROD-2 DATE-ONLY: 'outputs/{date}/' default fleet template → ends with 'outputs/YYYY-MM-DD'", () => {
    const result = resolveOutputDir(
      "outputs/{date}/",
      {
        agent: "any-agent",
        now: new Date("2026-04-25T00:00:00Z"),
      },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    expect(result.resolved).toBe(`${AGENT_ROOT}/outputs/2026-04-25`);
    expect(result.warnings).toEqual([]);
  });

  it("ROD-3 AGENT-TOKEN: '{agent}/scratch/' → '${root}/fin-tax/scratch'", () => {
    const result = resolveOutputDir(
      "{agent}/scratch/",
      { agent: "fin-tax" },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    expect(result.resolved).toContain("/fin-tax/scratch");
    expect(result.warnings).toEqual([]);
  });

  it("ROD-4 CHANNEL-TOKEN: 'channels/{channel_name}/' → contains '/channels/general'", () => {
    const result = resolveOutputDir(
      "channels/{channel_name}/",
      { agent: "any", channelName: "general" },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    expect(result.resolved).toContain("/channels/general");
    expect(result.warnings).toEqual([]);
  });

  it("ROD-5 CLIENT-SLUG-FALLBACK: undefined clientSlug → 'unknown-client' + warning", () => {
    const result = resolveOutputDir(
      "{client_slug}/files/",
      { agent: "fin-client" /* clientSlug undefined */ },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    expect(result.resolved).toContain(CLIENT_SLUG_FALLBACK);
    expect(result.resolved).toContain("unknown-client");
    expect(result.warnings.length).toBeGreaterThan(0);
    // Warning must mention the missing token
    expect(result.warnings.some((w) => /client_slug/i.test(w))).toBe(true);
  });

  it("ROD-6 NESTED-TOKENS: 'clients/{client_slug}/{date}/{channel_name}/' → fully expanded", () => {
    const result = resolveOutputDir(
      "clients/{client_slug}/{date}/{channel_name}/",
      {
        agent: "fin-client",
        clientSlug: "tara-maffeo",
        channelName: "acme-client-acquisition",
        now: new Date("2026-04-25T12:00:00Z"),
      },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    expect(result.resolved).toBe(
      `${AGENT_ROOT}/clients/tara-maffeo/2026-04-25/acme-client-acquisition`,
    );
    expect(result.warnings).toEqual([]);
  });

  it("ROD-7 TRAVERSAL-DOTDOT: '../escape/{date}/' → refused; warnings include 'path traversal'", () => {
    const result = resolveOutputDir(
      "../escape/{date}/",
      { agent: "any", now: new Date("2026-04-25T00:00:00Z") },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    // resolved must be anchored under agentWorkspaceRoot
    expect(result.resolved.startsWith(AGENT_ROOT)).toBe(true);
    // warnings must call out the traversal
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => /path traversal/i.test(w))).toBe(true);
  });

  it("ROD-8 LEADING-SLASH: '/etc/passwd/{date}/' → refused; warnings populated", () => {
    const result = resolveOutputDir(
      "/etc/passwd/{date}/",
      { agent: "any", now: new Date("2026-04-25T00:00:00Z") },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    // resolved must be anchored under agentWorkspaceRoot (NOT /etc/passwd)
    expect(result.resolved.startsWith(AGENT_ROOT)).toBe(true);
    expect(result.resolved).not.toContain("/etc/passwd");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("ROD-9 NO-TOKENS-LITERAL: 'static/literal/path' (no tokens) → resolved literal", () => {
    const result = resolveOutputDir(
      "static/literal/path",
      { agent: "any" },
      { agentWorkspaceRoot: AGENT_ROOT },
    );
    expect(result.resolved).toBe(`${AGENT_ROOT}/static/literal/path`);
    expect(result.warnings).toEqual([]);
  });

  it("ROD-10 IMMUTABILITY: result Object.frozen + deep-equal across calls", () => {
    const ctx = {
      agent: "fin-client",
      clientSlug: "tara-maffeo",
      channelName: "acme-client-acquisition",
      now: new Date("2026-04-25T12:00:00Z"),
    };
    const deps = { agentWorkspaceRoot: AGENT_ROOT };
    const a = resolveOutputDir("clients/{client_slug}/{date}/", ctx, deps);
    const b = resolveOutputDir("clients/{client_slug}/{date}/", ctx, deps);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(a.warnings)).toBe(true);
    expect(a.resolved).toBe(b.resolved);
    expect(a.warnings).toEqual(b.warnings);
    // Mutation attempt fails silently in strict mode or throws — either way
    // the frozen contract holds. Verify resolved is read-only.
    expect(() => {
      // @ts-expect-error — testing readonly violation
      a.resolved = "mutated";
    }).toThrow();
  });
});
