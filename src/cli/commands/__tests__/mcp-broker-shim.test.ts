// RED — Phase 108-00 — Wave 0 scaffolding. Production target: src/cli/commands/mcp-broker-shim.ts.
/**
 * Phase 108 Plan 00 — `clawcode mcp-broker-shim --pool 1password` CLI tests.
 *
 * Pins agent-side stdio↔socket bridge behavior. The shim is a "dumb byte
 * pipe" (per RESEARCH.md §"Don't Hand-Roll"):
 *   - agent stdin → broker socket
 *   - broker socket → agent stdout
 *
 * Tests cover:
 *   - First line shim writes to socket is the handshake
 *     `{agent, tokenHash}` (tokenHash = sha256(OP_SERVICE_ACCOUNT_TOKEN).slice(0,8))
 *   - Stdio bridge is byte-transparent (no JSON re-parsing inside shim)
 *   - Daemon restart (socket close) → runShim() resolves with non-zero exit
 *     code so the SDK reconnects (Pitfall 5)
 *   - Token literal never appears in pino logs (Phase 104 SEC-07)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable, PassThrough } from "node:stream";
import pino from "pino";
import * as crypto from "node:crypto";

import {
  createFakeBrokerSocketPair,
  type FakeSocket,
  type FakeBrokerSocketPair,
} from "../../../../tests/__fakes__/fake-broker-socket.js";

// Production target — does NOT exist yet.
import {
  runShim,
  normalizeServerType,
  type ShimDeps,
} from "../mcp-broker-shim.js";

const TEST_TOKEN_LITERAL = "ops_TESTTOKEN_FAKE_XYZ";
const EXPECTED_TOKEN_HASH = crypto
  .createHash("sha256")
  .update(TEST_TOKEN_LITERAL)
  .digest("hex")
  .slice(0, 8);

function captureLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  return {
    log,
    raw: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s) as Record<string, unknown>),
  };
}

type ShimWiring = {
  agentStdin: PassThrough; // shim reads here
  agentStdout: PassThrough; // shim writes here
  pair: FakeBrokerSocketPair; // shim's "socket" is pair.client
  capturedAgentOut: string[];
};

function buildWiring(): ShimWiring {
  const agentStdin = new PassThrough();
  const agentStdout = new PassThrough();
  const pair = createFakeBrokerSocketPair();
  const capturedAgentOut: string[] = [];
  agentStdout.on("data", (chunk: Buffer) =>
    capturedAgentOut.push(chunk.toString("utf8")),
  );
  return { agentStdin, agentStdout, pair, capturedAgentOut };
}

function buildDeps(
  wiring: ShimWiring,
  log: pino.Logger,
  env: Record<string, string>,
): ShimDeps {
  return {
    stdin: wiring.agentStdin,
    stdout: wiring.agentStdout,
    connectSocket: async () => wiring.pair.client as unknown as FakeSocket,
    env,
    log,
  };
}

function readSocketLines(socket: FakeSocket): {
  buf: string[];
  parsed: () => Array<Record<string, unknown>>;
} {
  const buf: string[] = [];
  socket.on("data", (chunk: Buffer) => buf.push(chunk.toString("utf8")));
  return {
    buf,
    parsed: () =>
      buf
        .join("")
        .split("\n")
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s) as Record<string, unknown>),
  };
}

describe("mcp-broker-shim — handshake on connect", () => {
  it("first line written to the broker socket is the handshake { agent, tokenHash }", async () => {
    const cap = captureLogger();
    const wiring = buildWiring();
    const socketReader = readSocketLines(wiring.pair.server);

    const env = {
      CLAWCODE_AGENT: "fin-client",
      OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN_LITERAL,
    };
    const shimPromise = runShim({
      pool: "1password",
      ...buildDeps(wiring, cap.log, env),
    });

    // Allow handshake to write.
    await new Promise((r) => setImmediate(r));

    const [first] = socketReader.parsed();
    expect(first).toBeDefined();
    expect(first!.agent).toBe("fin-client");
    expect(first!.tokenHash).toBe(EXPECTED_TOKEN_HASH);

    // Cleanly end shim.
    wiring.pair.server.fakeClose();
    await shimPromise.catch(() => undefined);
  });

  it("hashes tokenHash in-shim — never sends literal token over the socket", async () => {
    const cap = captureLogger();
    const wiring = buildWiring();
    const socketReader = readSocketLines(wiring.pair.server);

    const env = {
      CLAWCODE_AGENT: "fin-client",
      OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN_LITERAL,
    };
    const shimPromise = runShim({
      pool: "1password",
      ...buildDeps(wiring, cap.log, env),
    });
    await new Promise((r) => setImmediate(r));

    expect(socketReader.buf.join("")).not.toContain(TEST_TOKEN_LITERAL);

    wiring.pair.server.fakeClose();
    await shimPromise.catch(() => undefined);
  });
});

describe("mcp-broker-shim — stdio bridge (byte transparency)", () => {
  it("agent stdin lines arrive on the broker socket unchanged (byte-for-byte)", async () => {
    const cap = captureLogger();
    const wiring = buildWiring();
    const socketReader = readSocketLines(wiring.pair.server);

    const env = {
      CLAWCODE_AGENT: "agent-x",
      OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN_LITERAL,
    };
    const shimPromise = runShim({
      pool: "1password",
      ...buildDeps(wiring, cap.log, env),
    });
    await new Promise((r) => setImmediate(r));

    // After handshake the shim is in pass-through mode. Write a JSON-RPC
    // line into agent stdin.
    const jsonrpcLine =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "password_read", arguments: { reference: "op://example-vault-34/y/z" } },
      }) + "\n";
    wiring.agentStdin.write(jsonrpcLine);
    await new Promise((r) => setImmediate(r));

    // The socket should now have BOTH the handshake AND the JSON-RPC line.
    const allBytes = socketReader.buf.join("");
    expect(allBytes).toContain(jsonrpcLine);

    wiring.pair.server.fakeClose();
    await shimPromise.catch(() => undefined);
  });

  it("broker socket writes appear on agent stdout unchanged (byte-for-byte)", async () => {
    const cap = captureLogger();
    const wiring = buildWiring();

    const env = {
      CLAWCODE_AGENT: "agent-x",
      OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN_LITERAL,
    };
    const shimPromise = runShim({
      pool: "1password",
      ...buildDeps(wiring, cap.log, env),
    });
    await new Promise((r) => setImmediate(r));

    // Broker writes a response.
    const respLine =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "secret-value" }] },
      }) + "\n";
    wiring.pair.server.write(respLine);
    await new Promise((r) => setImmediate(r));

    const stdoutBytes = wiring.capturedAgentOut.join("");
    expect(stdoutBytes).toContain(respLine);

    wiring.pair.server.fakeClose();
    await shimPromise.catch(() => undefined);
  });
});

describe("mcp-broker-shim — daemon restart triggers non-zero exit (Pitfall 5)", () => {
  it("when the broker socket closes, runShim resolves with a non-zero exit code", async () => {
    const cap = captureLogger();
    const wiring = buildWiring();

    const env = {
      CLAWCODE_AGENT: "agent-x",
      OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN_LITERAL,
    };
    const shimPromise = runShim({
      pool: "1password",
      ...buildDeps(wiring, cap.log, env),
    });
    await new Promise((r) => setImmediate(r));

    // Daemon dies → socket closes.
    wiring.pair.server.fakeClose("daemon-restart");

    const exitCode = await shimPromise;
    expect(exitCode).not.toBe(0);
    expect(typeof exitCode).toBe("number");
  });
});

describe("mcp-broker-shim — Phase 110 Stage 0a `--type` alias", () => {
  it("`--type 1password` accepted; resolves to serverType '1password'", () => {
    const r = normalizeServerType({ type: "1password" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.serverType).toBe("1password");
  });

  it("legacy `--pool 1password` continues to work (Phase 108 shape)", () => {
    const r = normalizeServerType({ pool: "1password" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.serverType).toBe("1password");
  });

  it("bare invocation (no flag) defaults to '1password'", () => {
    const r = normalizeServerType({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.serverType).toBe("1password");
  });

  it("`--type` wins when both flags passed", () => {
    // Synthetic case: --pool=1password, --type=fal-ai. --type wins, gets
    // rejected. The opposite combo (type=1password, pool=garbage) is a
    // success because --type wins regardless of --pool's value.
    const r1 = normalizeServerType({ type: "fal-ai", pool: "1password" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.serverType).toBe("fal-ai");

    const r2 = normalizeServerType({ type: "1password", pool: "garbage" });
    expect(r2.ok).toBe(true);
  });

  it("rejects unsupported serverType with EX_USAGE-shaped error", () => {
    const r = normalizeServerType({ type: "fal-ai" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.serverType).toBe("fal-ai");
      expect(r.message).toContain("Unsupported broker type: fal-ai");
      expect(r.message).toContain("Phase 110 Stage 0a");
      expect(r.message).toContain("Stage 1");
    }
  });

  it("runShim child logger emits a serverType field on every line", async () => {
    const cap = captureLogger();
    const wiring = buildWiring();

    const env = {
      CLAWCODE_AGENT: "agent-x",
      OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN_LITERAL,
    };
    const shimPromise = runShim({
      pool: "1password",
      ...buildDeps(wiring, cap.log, env),
    });
    await new Promise((r) => setImmediate(r));
    wiring.pair.server.fakeClose();
    await shimPromise.catch(() => undefined);

    const lines = cap.lines();
    // Every shim-emitted line carries serverType=1password (journalctl
    // greps work day one).
    const shimLines = lines.filter(
      (l) => l.component === "mcp-broker-shim",
    );
    expect(shimLines.length).toBeGreaterThan(0);
    for (const l of shimLines) {
      expect(l.serverType).toBe("1password");
    }
  });
});

describe("mcp-broker-shim — token never logged literal", () => {
  it("no log line emitted by the shim contains the literal OP_SERVICE_ACCOUNT_TOKEN value", async () => {
    const cap = captureLogger();
    const wiring = buildWiring();

    const env = {
      CLAWCODE_AGENT: "agent-x",
      OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN_LITERAL,
    };
    const shimPromise = runShim({
      pool: "1password",
      ...buildDeps(wiring, cap.log, env),
    });
    await new Promise((r) => setImmediate(r));

    // Force an error path: simulate bad handshake response.
    wiring.pair.server.write(
      JSON.stringify({ error: { code: -32099, message: "bad agent" } }) + "\n",
    );
    await new Promise((r) => setImmediate(r));

    wiring.pair.server.fakeClose();
    await shimPromise.catch(() => undefined);

    const logs = cap.raw();
    expect(logs).not.toContain(TEST_TOKEN_LITERAL);
    expect(logs).not.toMatch(/ops_[A-Z0-9_]/);
  });
});
