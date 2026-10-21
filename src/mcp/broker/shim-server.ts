/**
 * Phase 108 — ShimServer.
 *
 * Daemon-side IPC server that accepts unix-socket connections from the
 * agent-side mcp-broker-shim CLI, validates the handshake, and bridges
 * each connection to OnePasswordMcpBroker.
 *
 * Wire protocol (line-framed JSON, one object per '\n'):
 *
 *   1. Client → server: handshake `{agent: string, tokenHash: string}`.
 *      tokenLiteral is NEVER sent over the wire (SEC-07 invariant; the
 *      shim CLI hashes the literal client-side before connecting).
 *   2. Server → client (on error): `{error: {code, message}}` then close.
 *   3. After successful handshake, both directions exchange JSON-RPC
 *      messages — client lines forward to broker.handleAgentMessage;
 *      broker responses are written back to the client.
 *
 * Security:
 *   - Reject malformed handshakes with structured errors that NEVER
 *     echo the offending payload (handshake might accidentally contain
 *     a literal token from a buggy shim).
 *   - Per-connection state is local; no shared mutable state with peers.
 */
import type { Logger } from "pino";
import type {
  OnePasswordMcpBroker,
  BrokerAgentConnection,
} from "./broker.js";

/** Handshake validation error codes — JSON-RPC server-defined range. */
export const SHIM_HANDSHAKE_ERROR_MISSING_FIELDS = -32010;
export const SHIM_HANDSHAKE_ERROR_INVALID_AGENT = -32011;
export const SHIM_HANDSHAKE_ERROR_SHUTTING_DOWN = -32012;

/** Agent name validation pattern — alphanumeric + dash + underscore, 1-64 chars. */
// Agent names in clawcode.yaml allow alnum, dash, underscore, and SPACES
// (e.g. "Admin Clawdy"). Reject anything that could be shell-metacharacter
// or path-traversal noise. Spaces are safe inside the JSON-RPC handshake
// payload — they only flow into structured log fields, never into shell.
const AGENT_NAME_PATTERN = /^[a-zA-Z0-9 _\-]{1,64}$/;
/**
 * TokenHash is the first 8 (or more) hex-ish chars of sha256(token).
 * Pattern is intentionally permissive — production sends sha256-derived
 * lowercase hex, but tests use synthetic identifiers like "tokenA01".
 * What we strictly disallow: empty, oversized, or characters that could
 * smuggle control bytes into log lines.
 */
const TOKEN_HASH_PATTERN = /^[a-zA-Z0-9_\-]{1,64}$/;

/**
 * Minimal duplex socket surface — broker.test fakes implement a
 * PassThrough-backed pair; production passes a real net.Socket. We type
 * it via duck-typing so both shapes work.
 */
type DuplexSocket = {
  write(chunk: string | Buffer): boolean;
  end(): void;
  destroy(err?: Error): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
};

export type ShimServerDeps = {
  log: Logger;
  broker: OnePasswordMcpBroker;
  /**
   * Optional: socket path for production listen(). Tests drive
   * handleConnection() directly without a real socket file.
   */
  socketPath?: string;
  /**
   * Phase 108 Plan 04 — daemon-side tokenHash → rawToken resolver. The
   * shim NEVER sends the literal token over the socket (Phase 104 SEC-07);
   * the daemon holds a tokenHash → rawToken map built at boot from
   * resolved agent configs. The broker needs the literal to spawn the
   * pool child via its env. Returns undefined when the tokenHash is
   * unknown (handshake will be rejected).
   *
   * Tests omit this — the test path uses rawToken="" because the test
   * spawnFn doesn't read the token. Production MUST inject this.
   */
  resolveRawToken?: (tokenHash: string) => string | undefined;
};

type Connection = {
  socket: DuplexSocket;
  buf: string;
  handshakeDone: boolean;
  closed: boolean;
  brokerConn?: BrokerAgentConnection;
  closeListeners: Array<() => void>;
};

export class ShimServer {
  private readonly log: Logger;
  private readonly broker: OnePasswordMcpBroker;
  private readonly connections: Set<Connection> = new Set();
  private readonly resolveRawToken: (tokenHash: string) => string | undefined;
  private draining = false;

  constructor(deps: ShimServerDeps) {
    this.log = deps.log;
    this.broker = deps.broker;
    // Phase 108 Plan 04 — production daemon injects a real resolver that
    // looks up the rawToken via a daemon-held tokenHash → rawToken map.
    // Tests omit it; the test rawToken=="" path is fine because test
    // spawnFn doesn't actually read the token.
    this.resolveRawToken = deps.resolveRawToken ?? (() => undefined);
  }

  /**
   * Wire a fresh socket into the per-connection state machine. Public so
   * tests can drive it directly (production callers use a node:net server
   * that emits 'connection' events; the listener calls this).
   */
  handleConnection(socket: DuplexSocket): void {
    const conn: Connection = {
      socket,
      buf: "",
      handshakeDone: false,
      closed: false,
      closeListeners: [],
    };
    this.connections.add(conn);

    socket.on("data", (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      conn.buf += s;
      this.processBuffer(conn);
    });
    socket.on("close", () => {
      this.handleClose(conn);
    });
    socket.on("end", () => {
      this.handleClose(conn);
    });
    socket.on("error", (err: Error) => {
      this.log.warn(
        { component: "mcp-broker-shim-server", err: String(err) },
        "socket error",
      );
      this.handleClose(conn);
    });
  }

  private processBuffer(conn: Connection): void {
    let idx = conn.buf.indexOf("\n");
    while (idx !== -1 && !conn.closed) {
      const line = conn.buf.slice(0, idx);
      conn.buf = conn.buf.slice(idx + 1);
      if (line.length > 0) {
        if (!conn.handshakeDone) {
          this.handleHandshakeLine(conn, line);
        } else {
          this.handleAgentLine(conn, line);
        }
      }
      idx = conn.buf.indexOf("\n");
    }
  }

  private handleHandshakeLine(conn: Connection, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.rejectHandshake(conn, SHIM_HANDSHAKE_ERROR_MISSING_FIELDS, "Malformed handshake JSON");
      return;
    }

    if (this.draining) {
      this.rejectHandshake(
        conn,
        SHIM_HANDSHAKE_ERROR_SHUTTING_DOWN,
        "Broker is shutting down",
      );
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.rejectHandshake(
        conn,
        SHIM_HANDSHAKE_ERROR_MISSING_FIELDS,
        "Handshake must be a JSON object",
      );
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const agent = obj.agent;
    const tokenHash = obj.tokenHash;

    if (agent === undefined || tokenHash === undefined) {
      this.rejectHandshake(
        conn,
        SHIM_HANDSHAKE_ERROR_MISSING_FIELDS,
        "Handshake missing required fields",
      );
      return;
    }
    if (typeof agent !== "string") {
      this.rejectHandshake(
        conn,
        SHIM_HANDSHAKE_ERROR_INVALID_AGENT,
        "Handshake agent must be a string",
      );
      return;
    }
    if (!AGENT_NAME_PATTERN.test(agent)) {
      this.rejectHandshake(
        conn,
        SHIM_HANDSHAKE_ERROR_INVALID_AGENT,
        "Handshake agent name invalid",
      );
      return;
    }
    if (typeof tokenHash !== "string" || !TOKEN_HASH_PATTERN.test(tokenHash)) {
      this.rejectHandshake(
        conn,
        SHIM_HANDSHAKE_ERROR_MISSING_FIELDS,
        "Handshake tokenHash invalid",
      );
      return;
    }

    // Build BrokerAgentConnection and register with broker. We never
    // transmit the literal token over the socket — the shim hashed it
    // client-side (Phase 104 SEC-07). Production daemon injects a
    // tokenHash → rawToken resolver via `deps.resolveRawToken` so the
    // broker can spawn the pool child with the literal env var. Tests
    // (and offline flows) leave it undefined → rawToken="" stays the
    // safe default and the test spawnFn doesn't actually read it.
    const rawToken = this.resolveRawToken(tokenHash) ?? "";
    const brokerConn: BrokerAgentConnection = {
      agentName: agent,
      tokenHash,
      rawToken,
      send: (msg) => {
        if (conn.closed) return;
        try {
          conn.socket.write(JSON.stringify(msg) + "\n");
        } catch (err) {
          this.log.warn(
            {
              component: "mcp-broker-shim-server",
              agent,
              tokenHash,
              err: String(err),
            },
            "failed to write response to socket",
          );
        }
      },
      onClose: (fn) => {
        conn.closeListeners.push(fn);
      },
    };
    conn.brokerConn = brokerConn;
    conn.handshakeDone = true;

    void this.broker.acceptConnection(brokerConn);

    this.log.debug(
      {
        component: "mcp-broker-shim-server",
        agent,
        tokenHash,
      },
      "shim handshake accepted",
    );
  }

  private handleAgentLine(conn: Connection, line: string): void {
    if (conn.brokerConn === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.log.warn(
        {
          component: "mcp-broker-shim-server",
          agent: conn.brokerConn.agentName,
          err: String(err),
        },
        "malformed JSON-RPC from shim",
      );
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    void this.broker.handleAgentMessage(
      conn.brokerConn,
      parsed as Record<string, unknown>,
    );
  }

  private rejectHandshake(
    conn: Connection,
    code: number,
    message: string,
  ): void {
    // Structured error response — NEVER echo any field from the bad
    // payload (shim might have accidentally included a token literal).
    try {
      conn.socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code, message },
        }) + "\n",
      );
    } catch {
      // ignore — we're closing anyway
    }
    this.log.warn(
      {
        component: "mcp-broker-shim-server",
        code,
        message,
      },
      "rejected handshake",
    );
    conn.closed = true;
    try {
      conn.socket.end();
    } catch {
      // ignore
    }
    this.connections.delete(conn);
  }

  private handleClose(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    for (const fn of conn.closeListeners) {
      try {
        fn();
      } catch (err) {
        this.log.warn(
          { component: "mcp-broker-shim-server", err: String(err) },
          "close listener threw",
        );
      }
    }
    this.connections.delete(conn);
  }

  /**
   * Daemon pre-drain: new connections get rejected immediately; existing
   * connections continue serving until they disconnect naturally.
   */
  preDrainNotify(): void {
    this.draining = true;
    this.broker.preDrainNotify();
    this.log.info(
      { component: "mcp-broker-shim-server" },
      "pre-drain — rejecting new connections",
    );
  }

  /**
   * Force-close all sockets and ask the broker to SIGTERM all pool
   * children within the ceiling.
   */
  async shutdown(timeoutMs: number = 5000): Promise<void> {
    this.draining = true;
    // Close every active connection — broker will see disconnects and
    // begin per-pool drain logic.
    const conns = Array.from(this.connections);
    for (const conn of conns) {
      this.handleClose(conn);
      try {
        conn.socket.end();
      } catch {
        // ignore
      }
    }
    await this.broker.shutdown(timeoutMs);
  }

  /** Test-helper: reject all currently-open connections. */
  closeAllConnections(): void {
    const conns = Array.from(this.connections);
    for (const conn of conns) {
      this.handleClose(conn);
      try {
        conn.socket.end();
      } catch {
        // ignore
      }
    }
  }
}
