/**
 * Phase 108 Plan 00 — FakeBrokerSocketPair test fake.
 *
 * Cross-wired PassThrough-backed duplex pair that mimics the surface of
 * `net.Socket` used by the broker shim-server. Used by the shim-server
 * RED tests (and the agent-side shim CLI tests) so neither side has to
 * touch a real unix-domain-socket file.
 *
 * Surface mirrored:
 *   - Duplex read/write
 *   - 'data' / 'close' / 'error' / 'end' events (EventEmitter on PassThrough)
 *   - end() to signal half-close
 *
 * No production-code imports. No real net.Socket / unix sockets.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Net.Socket-shaped fake (duplex). Production code uses .write/.on/.end —
 * the underlying PassThrough satisfies all three. We expose the public
 * surface as a `Socket`-like object via duck typing so test code reads
 * naturally.
 */
export type FakeSocket = PassThrough & {
  /**
   * Test-only: emit a 'close' event so the production code's close handler
   * fires (PassThrough.end alone doesn't synthesize 'close').
   */
  fakeClose(reason?: string): void;
  /** Test-only: emit an 'error' event without throwing. */
  fakeError(err: Error): void;
};

function decorate(stream: PassThrough, peer?: () => PassThrough): FakeSocket {
  const decorated = stream as FakeSocket;
  decorated.fakeClose = (reason?: string): void => {
    // Mirror real net.Socket: end() then 'close' fires.
    decorated.end();
    // Use process.nextTick so any in-flight writes flush first.
    process.nextTick(() => {
      decorated.emit("close", reason !== undefined);
      // Propagate close to peer end of the pair so consumers holding the
      // *other* half (e.g. the shim CLI's client socket when the broker /
      // server side calls fakeClose) observe a 'close'/'end' event. Without
      // this, fakeClose on one side would be invisible to the other —
      // making the fake unusable for "daemon restart → shim exits" tests
      // (Pitfall 5 in Phase 108).
      const other = peer?.();
      if (other && !other.destroyed) {
        other.end();
        process.nextTick(() => {
          other.emit("close", reason !== undefined);
        });
      }
    });
  };
  decorated.fakeError = (err: Error): void => {
    decorated.emit("error", err);
  };
  return decorated;
}

export type FakeBrokerSocketPair = {
  /** The shim-side end of the connection (agent-side shim writes here). */
  readonly client: FakeSocket;
  /** The broker-side end of the connection (broker writes here). */
  readonly server: FakeSocket;
};

/**
 * Build a cross-wired pair of PassThrough streams. Bytes written to
 * `client` come out of `server`'s read side and vice versa.
 *
 * Implementation detail: each side is its own PassThrough; we pipe them
 * to each other so write-on-A ⇒ data-on-B. We set { allowHalfOpen: true }
 * via a per-write copy because PassThrough's pipe() default would close
 * the destination on source-end. Our `end()` propagation is simulated via
 * fakeClose() so tests have explicit control.
 */
export function createFakeBrokerSocketPair(): FakeBrokerSocketPair {
  // Each side is its own PassThrough. We override `write` on each side so
  // that calling `client.write(x)` pushes `x` directly into `server`'s
  // readable side (and vice versa). This avoids the looping that would
  // otherwise happen if we used 'data' listeners for cross-wire forwarding
  // (a 'data' listener on side A calling B.write would re-trigger A's
  // forwarder, causing infinite ping-pong).
  const client = new PassThrough();
  const server = new PassThrough();

  // Capture the original PassThrough.write so consumers reading from each
  // side via `.on('data')` still receive bytes pushed by the *peer*. We
  // monkey-patch `client.write` so that calls to it (which represent the
  // shim "writing to the socket") get routed straight into server's
  // readable buffer — surfacing on `server.on('data')` exactly once, with
  // no echo back.
  // Capture the PassThroughs' native write functions (bound to their owning
  // instance). We invoke the *peer's* native write so bytes appear once on
  // the peer's readable side without round-tripping through 'data' events.
  const realClientWrite: (...args: unknown[]) => boolean =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.write as any).bind(client);
  const realServerWrite: (...args: unknown[]) => boolean =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.write as any).bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).write = (...args: unknown[]): boolean => {
    if (server.writableEnded || server.destroyed) return false;
    return realServerWrite(...args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).write = (...args: unknown[]): boolean => {
    if (client.writableEnded || client.destroyed) return false;
    return realClientWrite(...args);
  };

  // Suppress lint for unused vars: `realClientWrite` / `realServerWrite`
  // are intentionally captured (above) and not referenced elsewhere.
  void realClientWrite;
  void realServerWrite;

  return {
    client: decorate(client, () => server),
    server: decorate(server, () => client),
  };
}

/**
 * Simulate daemon shutdown: fire 'close' on both halves of the pair.
 * Used by Pitfall-5 RED tests (shim ↔ daemon socket fragility).
 */
export function closePair(
  pair: FakeBrokerSocketPair,
  reason?: string,
): void {
  pair.client.fakeClose(reason);
  pair.server.fakeClose(reason);
}

/**
 * Belt-and-suspenders type guard so production code (when written) can
 * accept both FakeSocket and real net.Socket without casts in tests.
 *
 * (Currently unused; exists so the test fake's type surface is explicit.)
 */
export function isFakeSocket(s: unknown): s is FakeSocket {
  return (
    s instanceof EventEmitter &&
    typeof (s as { fakeClose?: unknown }).fakeClose === "function"
  );
}
