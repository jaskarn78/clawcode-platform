/**
 * Phase 110 follow-up — buildSearchEnv unit tests.
 *
 * The helper at src/manager/daemon.ts (~line 970) overlays process.env
 * with resolved op:// or literal values from
 * defaults.search.{brave,exa}.apiKey, returning a synthetic env that
 * createBraveClient + createExaClient consume.
 *
 * Coverage:
 *   - literal apiKey overrides baseEnv at apiKeyEnv key (Test 1)
 *   - op:// apiKey resolves via SecretsResolver cache and overrides
 *     baseEnv at apiKeyEnv key (Test 2)
 *   - op:// cache miss leaves baseEnv unchanged at apiKeyEnv key
 *     (Pitfall: do NOT crash; do NOT empty out an already-set env var)
 *     (Test 3)
 *   - missing apiKey field passes through baseEnv unchanged (Test 4)
 *   - empty-string apiKey is treated like absent (Test 5 — defensive)
 */

import { describe, it, expect } from "vitest";
import { buildSearchEnv } from "../daemon.js";

/** Fake resolver — only getCached is exercised by buildSearchEnv. */
function makeResolver(cache: Record<string, string | undefined>) {
  return {
    getCached: (uri: string): string | undefined => cache[uri],
  };
}

const baseSearchCfg = {
  brave: { apiKeyEnv: "BRAVE_API_KEY", apiKey: undefined as string | undefined },
  exa: { apiKeyEnv: "EXA_API_KEY", apiKey: undefined as string | undefined },
};

describe("buildSearchEnv", () => {
  it("Test 1: literal apiKey injects at apiKeyEnv key", () => {
    const env = buildSearchEnv(
      {
        brave: { apiKeyEnv: "BRAVE_API_KEY", apiKey: "BSA-literal-1" },
        exa: { apiKeyEnv: "EXA_API_KEY" },
      },
      makeResolver({}),
      { OTHER: "preserved" },
    );
    expect(env.BRAVE_API_KEY).toBe("BSA-literal-1");
    expect(env.OTHER).toBe("preserved");
    expect(env.EXA_API_KEY).toBeUndefined();
  });

  it("Test 2: op:// apiKey resolves via cache and injects", () => {
    const env = buildSearchEnv(
      {
        brave: {
          apiKeyEnv: "BRAVE_API_KEY",
          apiKey: "op://example-vault-21/Brave Search API Key/credential",
        },
        exa: { apiKeyEnv: "EXA_API_KEY", apiKey: "op://example-vault-21/Exa/credential" },
      },
      makeResolver({
        "op://example-vault-21/Brave Search API Key/credential": "resolved-brave",
        "op://example-vault-21/Exa/credential": "resolved-exa",
      }),
      {},
    );
    expect(env.BRAVE_API_KEY).toBe("resolved-brave");
    expect(env.EXA_API_KEY).toBe("resolved-exa");
  });

  it("Test 3: op:// cache miss leaves baseEnv at apiKeyEnv unchanged (no clobber)", () => {
    // Operator scenario: yaml says `apiKey: op://...` but op CLI failed at
    // boot and the cache is empty. /etc/clawcode/env still has the literal
    // env var as a fallback. buildSearchEnv must NOT overwrite that with
    // empty string — it must pass through.
    const env = buildSearchEnv(
      {
        brave: { apiKeyEnv: "BRAVE_API_KEY", apiKey: "op://example-vault-21/Brave/credential" },
        exa: { apiKeyEnv: "EXA_API_KEY" },
      },
      makeResolver({ "op://example-vault-21/Brave/credential": undefined }),
      { BRAVE_API_KEY: "fallback-from-env-file" },
    );
    expect(env.BRAVE_API_KEY).toBe("fallback-from-env-file");
  });

  it("Test 4: missing apiKey passes baseEnv through unchanged", () => {
    // Default state — no yaml config; legacy /etc/clawcode/env path
    // continues to work for any operator that hasn't migrated to op://.
    const env = buildSearchEnv(
      baseSearchCfg,
      makeResolver({}),
      {
        BRAVE_API_KEY: "from-env-file",
        EXA_API_KEY: "from-env-file-too",
        UNRELATED: "x",
      },
    );
    expect(env.BRAVE_API_KEY).toBe("from-env-file");
    expect(env.EXA_API_KEY).toBe("from-env-file-too");
    expect(env.UNRELATED).toBe("x");
  });

  it("Test 5: empty-string apiKey is treated like absent (defensive)", () => {
    // Schema allows `string` so empty-string is technically valid; treat
    // it as absent so the legacy env-var fallback wins (matches the
    // "if (!rawValue)" guard in the impl).
    const env = buildSearchEnv(
      {
        brave: { apiKeyEnv: "BRAVE_API_KEY", apiKey: "" },
        exa: { apiKeyEnv: "EXA_API_KEY", apiKey: "" },
      },
      makeResolver({}),
      { BRAVE_API_KEY: "from-env" },
    );
    expect(env.BRAVE_API_KEY).toBe("from-env");
  });
});
