/**
 * Phase 137 Plan 04 T-02 — `OpenAiCredentialsResolver` unit tests.
 *
 * Behaviour matrix (10 tests total — 1 more than plan's 9 to also pin
 * factory + inflight dedup):
 *   1. `op://example-vault/item/field` URI resolves via mocked SecretsResolver.
 *   2. Plaintext `sk-...` value returns verbatim (no SecretsResolver call).
 *   3. `{{ op://example-vault/item/field }}` curly-brace wrapper stripped.
 *   4. Undefined apiKeyPath throws OpenAiCredentialsMissingError.
 *   5. Empty-string apiKeyPath throws OpenAiCredentialsMissingError.
 *   6. SecretsResolver returning empty/whitespace throws
 *      OpenAiCredentialsMissingError.
 *   7. Cache hit — two `resolve()` calls produce ONE SecretsResolver call.
 *   8. `invalidateCache()` forces re-resolution on the next call.
 *   9. SEC-07: resolved value NEVER appears in any logger call arg
 *      (op:// path).
 *  10. SEC-07 plaintext branch: plaintext key NEVER appears in any
 *      logger call arg.
 *
 * Test fixture pattern — vi.fn() spies for SecretsResolver.resolve +
 * logger.info/.warn. Logger is asserted via stringified call args to
 * catch ANY mention of the resolved value in ANY position
 * (positional argument or nested object field).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OpenAiCredentialsResolver,
  OpenAiCredentialsMissingError,
  createOpenAiCredentialsResolver,
} from "../openai-credentials.js";
import type { SecretsResolver } from "../../../manager/secrets-resolver.js";

function makeMockSecretsResolver(opts: {
  resolveValue?: string;
  throws?: unknown;
} = {}): {
  mock: SecretsResolver;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const resolveSpy = vi.fn(async (uri: string) => {
    if (opts.throws) throw opts.throws;
    return opts.resolveValue ?? "default-resolved-value";
  });
  const mock = { resolve: resolveSpy } as unknown as SecretsResolver;
  return { mock, resolveSpy };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

/**
 * Check that NO logger call arg (positional, or nested object field)
 * contains the secret string. SEC-07 invariant.
 *
 * Stringifies every call's args and asserts the secret substring is
 * absent. Catches the secret slipping into a nested log field or
 * being concatenated into the message string.
 */
function assertSecretAbsentFromLogger(
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> },
  secret: string,
): void {
  const allCalls = [...logger.info.mock.calls, ...logger.warn.mock.calls];
  for (const call of allCalls) {
    for (const arg of call) {
      const serialised =
        typeof arg === "string"
          ? arg
          : JSON.stringify(arg, (_k, v) => v);
      expect(serialised).not.toContain(secret);
    }
  }
}

describe("OpenAiCredentialsResolver — Phase 137 Plan 04 T-02", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(1) resolves an op:// URI via the injected SecretsResolver", async () => {
    const { mock, resolveSpy } = makeMockSecretsResolver({
      resolveValue: "sk-resolved-from-1password",
    });
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
    });
    const result = await r.resolve();
    expect(result).toBe("sk-resolved-from-1password");
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(
      "op://example-vault-9/openai/credential",
    );
  });

  it("(2) plaintext sk-... value returns verbatim — no SecretsResolver call", async () => {
    const { mock, resolveSpy } = makeMockSecretsResolver();
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "sk-plaintext-test-key",
      agentName: "research",
    });
    const result = await r.resolve();
    expect(result).toBe("sk-plaintext-test-key");
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("(3) strips {{ ... }} curly-brace wrapper before dispatching", async () => {
    const { mock, resolveSpy } = makeMockSecretsResolver({
      resolveValue: "sk-curly-resolved",
    });
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "{{ op://example-vault-9/openai/credential }}",
      agentName: "research",
    });
    const result = await r.resolve();
    expect(result).toBe("sk-curly-resolved");
    // The URI passed to SecretsResolver MUST be the bare op:// form
    // (no curly-brace wrappers).
    expect(resolveSpy).toHaveBeenCalledWith(
      "op://example-vault-9/openai/credential",
    );
  });

  it("(4) undefined apiKeyPath throws OpenAiCredentialsMissingError", async () => {
    const { mock } = makeMockSecretsResolver();
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: undefined,
      agentName: "research",
    });
    await expect(r.resolve()).rejects.toThrow(OpenAiCredentialsMissingError);
    await expect(r.resolve()).rejects.toThrow(
      /providers\.openai\.apiKeyPath not configured/,
    );
  });

  it("(5) empty-string apiKeyPath throws OpenAiCredentialsMissingError", async () => {
    const { mock } = makeMockSecretsResolver();
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "",
      agentName: "research",
    });
    await expect(r.resolve()).rejects.toThrow(OpenAiCredentialsMissingError);
  });

  it("(6) SecretsResolver returning empty string throws OpenAiCredentialsMissingError", async () => {
    const { mock } = makeMockSecretsResolver({ resolveValue: "" });
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
    });
    await expect(r.resolve()).rejects.toThrow(OpenAiCredentialsMissingError);
    await expect(r.resolve()).rejects.toThrow(/resolved.*to empty/);
  });

  it("(6b) SecretsResolver returning whitespace-only throws OpenAiCredentialsMissingError", async () => {
    const { mock } = makeMockSecretsResolver({ resolveValue: "   \n\t  " });
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
    });
    await expect(r.resolve()).rejects.toThrow(OpenAiCredentialsMissingError);
  });

  it("(7) cache hit: two resolve() calls share ONE SecretsResolver call", async () => {
    const { mock, resolveSpy } = makeMockSecretsResolver({
      resolveValue: "sk-cache-test",
    });
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
    });
    const first = await r.resolve();
    const second = await r.resolve();
    const third = await r.resolve();
    expect(first).toBe("sk-cache-test");
    expect(second).toBe("sk-cache-test");
    expect(third).toBe("sk-cache-test");
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("(7b) inflight dedup: concurrent first-resolve calls share one SecretsResolver invocation", async () => {
    let resolveInner!: (v: string) => void;
    const slow = new Promise<string>((res) => {
      resolveInner = res;
    });
    const resolveSpy = vi.fn(async () => slow);
    const mock = { resolve: resolveSpy } as unknown as SecretsResolver;

    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
    });
    const p1 = r.resolve();
    const p2 = r.resolve();
    resolveInner("sk-inflight-test");
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("sk-inflight-test");
    expect(b).toBe("sk-inflight-test");
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("(8) invalidateCache() forces re-resolution on the next call", async () => {
    const { mock, resolveSpy } = makeMockSecretsResolver({
      resolveValue: "sk-rotation-test",
    });
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
    });
    await r.resolve();
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    r.invalidateCache();
    await r.resolve();
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it("(9) SEC-07: resolved value (op:// path) NEVER appears in any logger call arg", async () => {
    const SECRET = "sk-extremely-sensitive-must-not-leak";
    const { mock } = makeMockSecretsResolver({ resolveValue: SECRET });
    const logger = makeLogger();
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
      logger,
    });
    await r.resolve();
    await r.resolve(); // hit cache → second log line fires too

    // The phase137-codex-credentials-resolved line MUST fire at least
    // once (operator-side grep target).
    const logKeys = logger.info.mock.calls.map((c) => c[1]);
    expect(logKeys).toContain("phase137-codex-credentials-resolved");

    // SEC-07 invariant — the resolved value must not appear in any
    // logger call positional arg or nested object field.
    assertSecretAbsentFromLogger(logger, SECRET);
  });

  it("(10) SEC-07: plaintext key NEVER appears in any logger call arg", async () => {
    const PLAINTEXT_SECRET = "sk-plaintext-must-not-leak-either";
    const { mock } = makeMockSecretsResolver();
    const logger = makeLogger();
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: PLAINTEXT_SECRET,
      agentName: "research",
      logger,
    });
    await r.resolve();
    await r.resolve();
    r.invalidateCache();
    await r.resolve();

    // The structural log line fires; SEC-07 invariant holds.
    const logKeys = logger.info.mock.calls.map((c) => c[1]);
    expect(logKeys).toContain("phase137-codex-credentials-resolved");
    expect(logKeys).toContain("phase137-codex-credentials-invalidated");

    assertSecretAbsentFromLogger(logger, PLAINTEXT_SECRET);
  });

  it("(11) factory createOpenAiCredentialsResolver returns a working instance", async () => {
    const { mock } = makeMockSecretsResolver({ resolveValue: "sk-from-factory" });
    const r = createOpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
    });
    expect(r).toBeInstanceOf(OpenAiCredentialsResolver);
    const result = await r.resolve();
    expect(result).toBe("sk-from-factory");
  });

  it("(12) getCachedForTest returns undefined before first resolve, value after", async () => {
    const { mock } = makeMockSecretsResolver({ resolveValue: "sk-cache-probe" });
    const r = new OpenAiCredentialsResolver({
      secretsResolver: mock,
      apiKeyPath: "op://example-vault-9/openai/credential",
      agentName: "research",
    });
    expect(r.getCachedForTest()).toBeUndefined();
    await r.resolve();
    expect(r.getCachedForTest()).toBe("sk-cache-probe");
    r.invalidateCache();
    expect(r.getCachedForTest()).toBeUndefined();
  });
});
