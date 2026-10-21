/**
 * Phase 74 Plan 01 — Caller-identity discriminator unit tests.
 *
 * Covers the full admission + parse surface:
 *   - literal native-agent match → { kind: "clawcode-native" }
 *   - `openclaw:<slug>[:<tier>]` parse (with + without tier)
 *   - slug regex gate + tier-token validation
 *   - scope='all' required for template path (pinned keys rejected)
 *   - unknown literal → { error: "unknown_model" }
 *   - SOUL extraction from messages[0].system (string + array-of-parts)
 *   - sha256Hex helper contract
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

import { extractCallerIdentity, sha256Hex } from "../caller-identity.js";
import type { ApiKeyRow } from "../keys.js";
import type {
  ChatCompletionRequest,
  ClaudeToolChoice,
  ClaudeToolDef,
  ClaudeToolResultBlock,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KNOWN_AGENTS: ReadonlyArray<string> = [
  "fin-test",
  "test-agent",
  "admin-clawdy",
];

function scopeAllRow(): ApiKeyRow {
  return {
    key_hash: "a".repeat(64),
    agent_name: "*",
    label: "test-all",
    created_at: 0,
    last_used_at: null,
    expires_at: null,
    disabled_at: null,
    scope: "all",
  };
}

function pinnedRow(agentName: string): ApiKeyRow {
  return {
    key_hash: "b".repeat(64),
    agent_name: agentName,
    label: "test-pinned",
    created_at: 0,
    last_used_at: null,
    expires_at: null,
    disabled_at: null,
    scope: `agent:${agentName}`,
  };
}

function mkBody(
  model: string,
  messages: ChatCompletionRequest["messages"] = [
    { role: "user", content: "hello" },
  ],
): ChatCompletionRequest {
  return {
    model,
    messages,
    stream: false,
  } as ChatCompletionRequest;
}

const NO_TOOLS: ClaudeToolDef[] | null = null;
const NO_CHOICE: ClaudeToolChoice | null = null;
const NO_RESULTS: ClaudeToolResultBlock[] = [];

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  it("returns full lowercase hex sha256 of utf-8 input", () => {
    const out = sha256Hex("hello world");
    // Pre-computed: sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(out).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across calls", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
  });

  it("empty string hashes to the canonical zero-length digest", () => {
    const expected = crypto.createHash("sha256").update("", "utf8").digest("hex");
    expect(sha256Hex("")).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Native path
// ---------------------------------------------------------------------------

describe("extractCallerIdentity — native path", () => {
  it("1a: literal native-agent name → clawcode-native", () => {
    const body = mkBody("test-agent");
    const row = pinnedRow("test-agent");
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ kind: "clawcode-native", agentName: "test-agent" });
  });

  it("1a-bis: literal match takes precedence over prefix check", () => {
    // Even if an agent literally named 'openclaw:fin-test' existed (contrived),
    // literal match wins because it short-circuits the prefix branch.
    const body = mkBody("fin-test");
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ kind: "clawcode-native", agentName: "fin-test" });
  });
});

// ---------------------------------------------------------------------------
// Template path (openclaw: prefix)
// ---------------------------------------------------------------------------

describe("extractCallerIdentity — openclaw-template path", () => {
  it("1b: slug + sonnet tier + system SOUL → openclaw-template", () => {
    const body = mkBody("openclaw:fin-test:sonnet", [
      { role: "system", content: "SOUL BODY" },
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toMatchObject({
      kind: "openclaw-template",
      callerSlug: "fin-test",
      tier: "sonnet",
      soulPrompt: "SOUL BODY",
    });
    if ("soulFp" in out) {
      expect(out.soulFp).toBe(sha256Hex("SOUL BODY").slice(0, 16));
      expect(out.soulFp).toHaveLength(16);
    }
  });

  it("1c: missing tier defaults to sonnet", () => {
    const body = mkBody("openclaw:fin-test", [
      { role: "system", content: "SOUL" },
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toMatchObject({
      kind: "openclaw-template",
      callerSlug: "fin-test",
      tier: "sonnet",
    });
  });

  it("1d: tier=opus accepted", () => {
    const body = mkBody("openclaw:fin-test:opus", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toMatchObject({ kind: "openclaw-template", tier: "opus" });
  });

  it("1e: tier=haiku accepted", () => {
    const body = mkBody("openclaw:fin-test:haiku", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toMatchObject({ kind: "openclaw-template", tier: "haiku" });
  });

  it("1f: invalid tier → malformed_caller", () => {
    const body = mkBody("openclaw:fin-test:gpt4", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ error: "malformed_caller" });
  });

  it("1g: empty slug (openclaw:) → malformed_caller", () => {
    const body = mkBody("openclaw:", [{ role: "user", content: "hi" }]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ error: "malformed_caller" });
  });

  it("1g-bis: empty slug with tier (openclaw::sonnet) → malformed_caller", () => {
    const body = mkBody("openclaw::sonnet", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ error: "malformed_caller" });
  });

  it("1h: mixed-case alphanumeric slug with underscore + hyphen accepted", () => {
    const body = mkBody("openclaw:Ok-SLUG_1", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toMatchObject({
      kind: "openclaw-template",
      callerSlug: "Ok-SLUG_1",
    });
  });

  it("1i: path-traversal slug → malformed_caller", () => {
    const body = mkBody("openclaw:/etc/passwd", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ error: "malformed_caller" });
  });

  it("1i-bis: slug with dot → malformed_caller", () => {
    const body = mkBody("openclaw:fin.test", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ error: "malformed_caller" });
  });

  it("1i-ter: more than two colon segments → malformed_caller", () => {
    const body = mkBody("openclaw:fin-test:sonnet:extra", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ error: "malformed_caller" });
  });

  it("1j: pinned key (scope=agent:<name>) attempting openclaw path → malformed_caller", () => {
    const body = mkBody("openclaw:fin-test:sonnet", [
      { role: "system", content: "SOUL" },
      { role: "user", content: "hi" },
    ]);
    const row = pinnedRow("admin-clawdy");
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ error: "malformed_caller" });
  });

  it("1k: unknown literal (no openclaw: prefix) → unknown_model", () => {
    const body = mkBody("nonexistent-agent");
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toEqual({ error: "unknown_model" });
  });

  it("1l: no system message → soulPrompt is empty string (still valid)", () => {
    const body = mkBody("openclaw:fin-test", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toMatchObject({
      kind: "openclaw-template",
      soulPrompt: "",
    });
    if ("soulFp" in out) {
      expect(out.soulFp).toBe(sha256Hex("").slice(0, 16));
    }
  });

  it("1m: array-of-parts system content concats text parts with double newline", () => {
    const body = mkBody("openclaw:fin-test", [
      {
        role: "system",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(out).toMatchObject({
      kind: "openclaw-template",
      soulPrompt: "first\n\nsecond",
    });
  });

  it("passes translated tools/toolChoice/toolResults through unchanged", () => {
    const tools: ClaudeToolDef[] = [
      { name: "get_stuff", description: "d", input_schema: { type: "object" } },
    ];
    const toolChoice: ClaudeToolChoice = { type: "auto" };
    const toolResults: ClaudeToolResultBlock[] = [
      { type: "tool_result", tool_use_id: "abc", content: "result" },
    ];
    const body = mkBody("openclaw:fin-test", [
      { role: "user", content: "hi" },
    ]);
    const row = scopeAllRow();
    const out = extractCallerIdentity(
      body,
      row,
      KNOWN_AGENTS,
      tools,
      toolChoice,
      toolResults,
    );
    expect(out).toMatchObject({
      kind: "openclaw-template",
      tools,
      toolChoice,
      toolResults,
    });
  });

  it("slug at 64-char maximum accepted; 65-char rejected", () => {
    const slug64 = "a".repeat(64);
    const slug65 = "a".repeat(65);
    const row = scopeAllRow();

    const ok = extractCallerIdentity(
      mkBody(`openclaw:${slug64}`, [{ role: "user", content: "hi" }]),
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(ok).toMatchObject({ kind: "openclaw-template", callerSlug: slug64 });

    const bad = extractCallerIdentity(
      mkBody(`openclaw:${slug65}`, [{ role: "user", content: "hi" }]),
      row,
      KNOWN_AGENTS,
      NO_TOOLS,
      NO_CHOICE,
      NO_RESULTS,
    );
    expect(bad).toEqual({ error: "malformed_caller" });
  });
});
