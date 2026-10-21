/**
 * P1-EMBED-WORKER client unit tests — the failure model (landmines #1, #5):
 *  - boot fail-open to inline (missing file / pre-first-success fault)
 *  - runtime crash → reject retryable + respawn (NO inline)
 *  - per-request timeout → reject + recycle (frees the drain's governor permit)
 *  - transferable ArrayBuffer reconstruction
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import pino from "pino";
import {
  EmbedWorkerClient,
  EmbedWorkerError,
  type WorkerLike,
} from "../embed-worker-client.js";
import type { EmbedWorkerResponse } from "../embed-worker.js";

const log = pino({ level: "silent" });
// An existing path so the client's existsSync check passes and it spawns the
// (fake) worker. The fake never reads the file.
const EXISTING_PATH = fileURLToPath(import.meta.url);

/** A controllable in-process stand-in for a worker_threads Worker. */
class FakeWorker implements WorkerLike {
  posted: Array<{ id: number; texts: string[]; includeV1: boolean }> = [];
  terminated = 0;
  private handlers: {
    message?: (v: EmbedWorkerResponse) => void;
    error?: (e: Error) => void;
    exit?: (code: number) => void;
  } = {};

  postMessage(value: unknown): void {
    this.posted.push(
      value as { id: number; texts: string[]; includeV1: boolean },
    );
  }
  on(event: "message", cb: (v: EmbedWorkerResponse) => void): void;
  on(event: "error", cb: (e: Error) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  on(event: string, cb: (arg: never) => void): void {
    (this.handlers as Record<string, unknown>)[event] = cb;
  }
  terminate(): void {
    this.terminated++;
    // Node 22 emits an 'exit' (code 1) when a worker is terminated — model it so
    // tests exercise the cascade the identity guard must prevent.
    this.handlers.exit?.(1);
  }

  lastId(): number {
    return this.posted[this.posted.length - 1]!.id;
  }
  respondOk(v2: ArrayBuffer[], v1: ArrayBuffer[] | null): void {
    this.handlers.message?.({ id: this.lastId(), ok: true, v2, v1 });
  }
  respondErr(error: string): void {
    this.handlers.message?.({ id: this.lastId(), ok: false, error });
  }
  emitExit(code: number): void {
    this.handlers.exit?.(code);
  }
  emitError(e: Error): void {
    this.handlers.error?.(e);
  }
}

function inlineEmbedderStub() {
  const calls = { embedV2: 0, embed: 0 };
  const embedder = {
    embedV2: async (_t: string) => {
      calls.embedV2++;
      return new Int8Array(384);
    },
    embed: async (_t: string) => {
      calls.embed++;
      return new Float32Array(384);
    },
  };
  return { embedder, calls };
}

function buf(n: number): ArrayBuffer[] {
  return Array.from({ length: n }, () => new Int8Array(384).buffer);
}
function fbuf(n: number): ArrayBuffer[] {
  return Array.from({ length: n }, () => new Float32Array(384).buffer);
}

describe("EmbedWorkerClient — happy path", () => {
  it("returns Int8/Float32 arrays reconstructed from transferable buffers", async () => {
    const fake = new FakeWorker();
    const { embedder, calls } = inlineEmbedderStub();
    const client = new EmbedWorkerClient({
      log,
      getInlineEmbedder: () => embedder as never,
      workerPath: EXISTING_PATH,
      createWorker: () => fake,
    });
    expect(client.getMode()).toBe("worker");

    const p = client.embedBothVersions(["a", "b"], true);
    expect(fake.posted.at(-1)).toMatchObject({ texts: ["a", "b"], includeV1: true });
    fake.respondOk(buf(2), fbuf(2));
    const r = await p;

    expect(r.v2).toHaveLength(2);
    expect(r.v2[0]).toBeInstanceOf(Int8Array);
    expect(r.v2[0].length).toBe(384);
    expect(r.v1).toHaveLength(2);
    expect(r.v1![0]).toBeInstanceOf(Float32Array);
    expect(calls.embed).toBe(0); // inline never used in worker mode
  });

  it("empty texts short-circuits without touching the worker", async () => {
    const fake = new FakeWorker();
    const { embedder } = inlineEmbedderStub();
    const client = new EmbedWorkerClient({
      log,
      getInlineEmbedder: () => embedder as never,
      workerPath: EXISTING_PATH,
      createWorker: () => fake,
    });
    const r = await client.embedBothVersions([], false);
    expect(r.v2).toEqual([]);
    expect(r.v1).toBeNull();
    expect(fake.posted).toHaveLength(0);
  });
});

describe("EmbedWorkerClient — boot fail-open to inline", () => {
  it("missing worker file → inline mode, no worker spawned", async () => {
    const created = vi.fn();
    const { embedder, calls } = inlineEmbedderStub();
    const client = new EmbedWorkerClient({
      log,
      getInlineEmbedder: () => embedder as never,
      workerPath: "/nonexistent/embed-worker.js",
      createWorker: () => {
        created();
        return new FakeWorker();
      },
    });
    expect(client.getMode()).toBe("inline");
    expect(created).not.toHaveBeenCalled();

    const r = await client.embedBothVersions(["x"], true);
    expect(calls.embedV2).toBe(1);
    expect(calls.embed).toBe(1);
    expect(r.v2[0]).toBeInstanceOf(Int8Array);
    expect(r.v1![0]).toBeInstanceOf(Float32Array);
  });

  it("worker fault BEFORE any success → fail open to inline (request still completes)", async () => {
    const fake = new FakeWorker();
    const { embedder, calls } = inlineEmbedderStub();
    const client = new EmbedWorkerClient({
      log,
      getInlineEmbedder: () => embedder as never,
      workerPath: EXISTING_PATH,
      createWorker: () => fake,
    });
    const p = client.embedBothVersions(["x"], false);
    fake.emitExit(1); // crash before responding, everSucceeded === false
    const r = await p; // resolves via inline fallback, does NOT reject
    expect(r.v2).toHaveLength(1);
    expect(calls.embedV2).toBe(1);
    expect(client.getMode()).toBe("inline");
  });
});

describe("EmbedWorkerClient — runtime crash (NO inline)", () => {
  it("after a success, a crash rejects retryable + respawns; inline NOT used", async () => {
    const fakes: FakeWorker[] = [];
    const { embedder, calls } = inlineEmbedderStub();
    const client = new EmbedWorkerClient({
      log,
      getInlineEmbedder: () => embedder as never,
      workerPath: EXISTING_PATH,
      createWorker: () => {
        const f = new FakeWorker();
        fakes.push(f);
        return f;
      },
    });

    // First request succeeds → everSucceeded = true.
    const p1 = client.embedBothVersions(["a"], false);
    fakes[0].respondOk(buf(1), null);
    await p1;

    // Second request: worker crashes mid-flight.
    const p2 = client.embedBothVersions(["b"], false);
    fakes[0].emitExit(1);
    await expect(p2).rejects.toBeInstanceOf(EmbedWorkerError);
    expect(calls.embedV2).toBe(0); // inline NEVER used at runtime
    expect(fakes).toHaveLength(2); // respawned
    expect(client.getMode()).toBe("worker");
  });
});

describe("EmbedWorkerClient — crash cascade prevention (identity guard)", () => {
  it("a crash emitting BOTH error and exit respawns EXACTLY once (no cascade)", async () => {
    const fakes: FakeWorker[] = [];
    const { embedder } = inlineEmbedderStub();
    const client = new EmbedWorkerClient({
      log,
      getInlineEmbedder: () => embedder as never,
      workerPath: EXISTING_PATH,
      createWorker: () => {
        const f = new FakeWorker();
        fakes.push(f);
        return f;
      },
    });
    const p1 = client.embedBothVersions(["a"], false);
    fakes[0].respondOk(buf(1), null);
    await p1; // everSucceeded === true

    // Node emits 'error' THEN 'exit' for an uncaught worker exception; the
    // client's terminate() also emits 'exit'. Without the identity guard these
    // stale events would terminate the freshly-spawned worker and cascade.
    const p2 = client.embedBothVersions(["b"], false);
    fakes[0].emitError(new Error("uncaught in worker"));
    fakes[0].emitExit(1); // stale — must be ignored
    await expect(p2).rejects.toBeInstanceOf(EmbedWorkerError);

    expect(fakes).toHaveLength(2); // exactly ONE respawn (W2), no W3/W4...
    expect(fakes[1].terminated).toBe(0); // W2 healthy, never terminated
    expect(client.getMode()).toBe("worker");
  });
});

describe("EmbedWorkerClient — runtime respawn failure (landmine #5: never inline)", () => {
  it("stays worker-mode and rejects retryable when respawn fails; recovers later; NEVER inline", async () => {
    const fakes: FakeWorker[] = [];
    let spawnCount = 0;
    const { embedder, calls } = inlineEmbedderStub();
    const client = new EmbedWorkerClient({
      log,
      getInlineEmbedder: () => embedder as never,
      workerPath: EXISTING_PATH,
      createWorker: () => {
        spawnCount++;
        if (spawnCount === 2) throw new Error("ENOMEM"); // respawn fails once
        const f = new FakeWorker();
        fakes.push(f);
        return f;
      },
    });
    const p1 = client.embedBothVersions(["a"], false);
    fakes[0].respondOk(buf(1), null);
    await p1; // everSucceeded

    // Crash → respawn (spawn #2) throws ENOMEM → must NOT fall to inline.
    const p2 = client.embedBothVersions(["b"], false);
    fakes[0].emitExit(1);
    await expect(p2).rejects.toBeInstanceOf(EmbedWorkerError);
    expect(client.getMode()).toBe("worker"); // NOT inline (landmine #5)
    expect(calls.embedV2).toBe(0); // inline NEVER used at runtime

    // Next request lazily retries spawn (#3) — now succeeds → recovers.
    const p3 = client.embedBothVersions(["c"], false);
    fakes[1].respondOk(buf(1), null);
    const r3 = await p3;
    expect(r3.v2).toHaveLength(1);
    expect(calls.embedV2).toBe(0); // still never inline
  });
});

describe("EmbedWorkerClient — timeout frees the permit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("after a success, a hung request times out and rejects retryable", async () => {
    const fakes: FakeWorker[] = [];
    const { embedder } = inlineEmbedderStub();
    const client = new EmbedWorkerClient({
      log,
      getInlineEmbedder: () => embedder as never,
      workerPath: EXISTING_PATH,
      createWorker: () => {
        const f = new FakeWorker();
        fakes.push(f);
        return f;
      },
      timeoutMs: 1000,
    });
    const p1 = client.embedBothVersions(["a"], false);
    fakes[0].respondOk(buf(1), null);
    await p1;

    const p2 = client.embedBothVersions(["b"], false); // never answered
    const assertion = expect(p2).rejects.toBeInstanceOf(EmbedWorkerError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(fakes[0].terminated).toBeGreaterThan(0); // recycled
  });
});
