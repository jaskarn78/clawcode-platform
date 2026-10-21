/**
 * Phase 108 Plan 00 — FakePooledChild test fake.
 *
 * A child_process.ChildProcess-shaped fake used by every Phase 108 broker
 * RED test. Implements only the subset of the ChildProcess surface the
 * broker uses: stdin/stdout/stderr (PassThrough-backed), pid, exitCode,
 * kill(), and the EventEmitter 'exit'/'error' events.
 *
 * Test-only helpers expose deterministic control over:
 *   - stdout line injection (broker reads newline-framed JSON)
 *   - stdin capture (assert what the broker wrote to the pooled child)
 *   - simulated exit (with code + optional signal)
 *   - simulated error
 *
 * No production-code imports. No real spawn. No network. Purely in-process.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

let nextFakePid = 90001;

/**
 * Minimal ChildProcess-shaped fake. The shape is intentionally narrow —
 * any field the production broker eventually depends on must be added
 * here explicitly so RED tests pin it.
 */
export class FakePooledChild extends EventEmitter {
  /** stdin from the pool's perspective — broker WRITES here. */
  public readonly stdin: PassThrough;
  /** stdout from the pool's perspective — broker READS here. */
  public readonly stdout: PassThrough;
  /** stderr from the pool's perspective — broker may log lines from here. */
  public readonly stderr: PassThrough;
  public readonly pid: number;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  /** Last signal passed to kill() — test-only assertion helper. */
  public lastKillSignal: string | undefined = undefined;
  /** Number of times kill() has been called. */
  public killCallCount: number = 0;

  /** Internal accumulator of bytes written to stdin by the broker. */
  private stdinBuf: string = "";

  constructor(opts?: { pid?: number }) {
    super();
    this.pid = opts?.pid ?? nextFakePid++;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    // Capture everything the broker writes to stdin so tests can assert
    // exactly which JSON-RPC lines were dispatched to the pooled child.
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.stdinBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
  }

  /**
   * Emit a single newline-terminated JSON-RPC line to stdout. The broker's
   * readline interface (per RESEARCH.md §"MCP stdio framing") will pick
   * this up as one message.
   */
  pushStdoutLine(json: object): void {
    const line = JSON.stringify(json) + "\n";
    // PassThrough.write delivers via 'data' events — the readline interface
    // attached by the broker will see exactly one complete line.
    this.stdout.write(line);
  }

  /**
   * Drain the bytes the broker has written to stdin since the last call,
   * split on newline, and return the raw line strings (one per JSON-RPC
   * message). Empty trailing fragment (after the final '\n') is dropped.
   */
  consumeStdinLines(): string[] {
    const buf = this.stdinBuf;
    this.stdinBuf = "";
    if (buf.length === 0) return [];
    const parts = buf.split("\n");
    // Drop trailing empty after final '\n'. If broker wrote partial line
    // (no trailing newline), it stays as the last element.
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  /**
   * Drain stdin and parse each captured line as JSON. Throws if any line
   * is malformed — RED tests want to assert the broker wrote valid JSON.
   */
  consumeStdinJson(): unknown[] {
    return this.consumeStdinLines().map((line) => JSON.parse(line));
  }

  /**
   * Simulate the pooled child exiting. Sets exitCode + signalCode, emits
   * 'exit' event with both args (matches Node ChildProcess semantics).
   */
  simulateExit(code: number, signal?: NodeJS.Signals): void {
    this.exitCode = code;
    this.signalCode = signal ?? null;
    this.emit("exit", code, signal ?? null);
    // Also close stdout/stdin to mirror real child cleanup.
    this.stdout.end();
    this.stdin.end();
  }

  /**
   * Simulate an error event from the child (e.g. spawn ENOENT or
   * pipe EPIPE). Broker should treat this as a fatal pool failure.
   */
  simulateError(err: Error): void {
    this.emit("error", err);
  }

  /**
   * Stub kill — records the signal and (by default) does not actually
   * trigger an exit. Tests that want to model "child died after SIGTERM"
   * call simulateExit() explicitly afterwards.
   *
   * Returns true (matches ChildProcess.kill when signal delivered).
   */
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCallCount += 1;
    this.lastKillSignal = signal === undefined ? "SIGTERM" : String(signal);
    return true;
  }
}

/**
 * Convenience factory for tests that want a child with a specific pid.
 */
export function makeFakePooledChild(pid?: number): FakePooledChild {
  return new FakePooledChild({ pid });
}
