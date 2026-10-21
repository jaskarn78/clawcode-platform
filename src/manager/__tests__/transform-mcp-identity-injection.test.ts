/**
 * C3 — v2/SDK spawn-injection config proof.
 *
 * `transformMcpServersForSdk` is the v2/SDK seam that hands MCP server configs
 * (incl. per-server `env`) to the Agent SDK. The auto-injected `clawcode`
 * server's loader env is `{}` (no daemon secret at config-load time), so the
 * agent's authoritative identity + capability token MUST be injected HERE, at
 * the spawn boundary where the daemon secret exists.
 *
 * This proves the INJECTION CONFIG half (token lands in the clawcode entry's
 * env). End-to-end propagation to the spawned `clawcode mcp` subprocess rests
 * on the same SDK per-server-env mechanism the 1password broker shim already
 * uses in prod (loader.ts injects CLAWCODE_AGENT into a clawcode-spawned
 * subprocess the same way) — not re-verified here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { transformMcpServersForSdk } from "../session-adapter.js";
import {
  initProcessIdentitySecret,
  computeAgentToken,
  AGENT_TOKEN_ENV,
  AGENT_NAME_ENV,
} from "../agent-identity-token.js";

const TEST_SECRET = "b".repeat(64);
let saved: string | undefined;

const servers: ReadonlyArray<{
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly alwaysLoad?: boolean;
}> = [
  { name: "clawcode", command: "clawcode", args: ["mcp"], env: {}, alwaysLoad: true },
  { name: "search", command: "clawcode", args: ["search-mcp"], env: { FOO: "bar" } },
];

beforeAll(() => {
  saved = process.env.CLAWCODE_IDENTITY_SECRET;
  process.env.CLAWCODE_IDENTITY_SECRET = TEST_SECRET;
  initProcessIdentitySecret();
});
afterAll(() => {
  if (saved === undefined) delete process.env.CLAWCODE_IDENTITY_SECRET;
  else process.env.CLAWCODE_IDENTITY_SECRET = saved;
});

describe("transformMcpServersForSdk — C3 identity injection", () => {
  it("injects CLAWCODE_AGENT + token into the clawcode server when agentName supplied", () => {
    const out = transformMcpServersForSdk(servers, "fin-client")!;
    const clawcode = out["clawcode"]!;
    expect(clawcode.env[AGENT_NAME_ENV]).toBe("fin-client");
    expect(clawcode.env[AGENT_TOKEN_ENV]).toBe(
      computeAgentToken(TEST_SECRET, "fin-client"),
    );
  });

  it("does NOT inject identity into non-clawcode servers", () => {
    const out = transformMcpServersForSdk(servers, "fin-client")!;
    const search = out["search"]!;
    expect(search.env[AGENT_NAME_ENV]).toBeUndefined();
    expect(search.env[AGENT_TOKEN_ENV]).toBeUndefined();
    expect(search.env.FOO).toBe("bar"); // existing env preserved
  });

  it("omits identity entirely when agentName is undefined (byte-stable legacy path)", () => {
    const out = transformMcpServersForSdk(servers)!;
    expect(out["clawcode"]!.env[AGENT_NAME_ENV]).toBeUndefined();
    expect(out["clawcode"]!.env[AGENT_TOKEN_ENV]).toBeUndefined();
    expect(out["clawcode"]!.env).toEqual({}); // unchanged from loader
    // alwaysLoad still propagates regardless of injection.
    expect(out["clawcode"]!.alwaysLoad).toBe(true);
  });
});
