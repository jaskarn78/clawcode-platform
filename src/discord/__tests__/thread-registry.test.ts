import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  stat,
  utimes,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readThreadRegistry,
  writeThreadRegistry,
  mutateThreadRegistry,
  stampLastDeliveryAt,
  resetSteerGates,
  migrateBindingsForPhase999_36,
} from "../thread-registry.js";
import type {
  ThreadBinding,
  ThreadBindingRegistry,
} from "../thread-types.js";

const NOW = 1_700_000_000_000;

function binding(overrides: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    threadId: "thread-1",
    parentChannelId: "ch-1",
    agentName: "fin-client-sub-AbC123",
    sessionName: "fin-client-sub-AbC123",
    createdAt: NOW - 30 * 60_000,
    lastActivity: NOW - 10 * 60_000,
    ...overrides,
  };
}

let tmp: string;
let registryPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "thread-registry-test-"));
  registryPath = join(tmp, "thread-bindings.json");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ThreadBinding back-compat: lastDeliveryAt", () => {
  it("parses a binding written WITHOUT lastDeliveryAt (pre-Phase-999.36)", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding()],
      updatedAt: NOW,
    };
    await writeThreadRegistry(registryPath, reg);
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.threadId).toBe("thread-1");
    expect(out.bindings[0]!.lastDeliveryAt).toBeUndefined();
  });

  it("round-trips a binding with lastDeliveryAt = 1234567890", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding({ lastDeliveryAt: 1234567890 })],
      updatedAt: NOW,
    };
    await writeThreadRegistry(registryPath, reg);
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBe(1234567890);
  });

  it("preserves lastDeliveryAt: null as null (NOT coerced to undefined)", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding({ lastDeliveryAt: null })],
      updatedAt: NOW,
    };
    await writeThreadRegistry(registryPath, reg);
    const raw = await readFile(registryPath, "utf-8");
    expect(raw).toContain('"lastDeliveryAt": null');
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBeNull();
  });
});

describe("stampLastDeliveryAt", () => {
  it("returns no-binding when threadId is unknown", async () => {
    const reg: ThreadBindingRegistry = { bindings: [], updatedAt: 0 };
    await writeThreadRegistry(registryPath, reg);
    const r = await stampLastDeliveryAt(registryPath, "missing", NOW);
    expect(r).toEqual({ ok: false, reason: "no-binding" });
  });

  it("stamps lastDeliveryAt on an existing binding", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding()],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await stampLastDeliveryAt(registryPath, "thread-1", NOW);
    expect(r).toEqual({ ok: true });
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBe(NOW);
    expect(out.bindings[0]!.threadId).toBe("thread-1");
    expect(out.bindings[0]!.lastActivity).toBe(binding().lastActivity);
  });

  it("does not mutate sibling bindings", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [
        binding({ threadId: "thread-1" }),
        binding({ threadId: "thread-2" }),
      ],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    await stampLastDeliveryAt(registryPath, "thread-2", NOW);
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBeUndefined();
    expect(out.bindings[1]!.lastDeliveryAt).toBe(NOW);
  });

  it("idempotent — re-stamping same threadId is a clean overwrite", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding()],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r1 = await stampLastDeliveryAt(registryPath, "thread-1", 1111);
    const r2 = await stampLastDeliveryAt(registryPath, "thread-1", 2222);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBe(2222);
  });
});

describe("stampLastDeliveryAt with producedRealContent (2026-05-23)", () => {
  it("stamps both lastDeliveryAt and producedRealContent when the flag is passed", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding()],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await stampLastDeliveryAt(registryPath, "thread-1", NOW, true);
    expect(r).toEqual({ ok: true });
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBe(NOW);
    expect(out.bindings[0]!.producedRealContent).toBe(true);
  });

  it("preserves existing producedRealContent when called WITHOUT the flag (back-compat)", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding({ producedRealContent: true })],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await stampLastDeliveryAt(registryPath, "thread-1", NOW);
    expect(r).toEqual({ ok: true });
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBe(NOW);
    // Should NOT be clobbered — omitted arg leaves the field untouched.
    expect(out.bindings[0]!.producedRealContent).toBe(true);
  });

  it("stamps producedRealContent=false to record a placeholder-only turn", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding({ producedRealContent: true })],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await stampLastDeliveryAt(registryPath, "thread-1", NOW, false);
    expect(r).toEqual({ ok: true });
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.producedRealContent).toBe(false);
  });
});

describe("resetSteerGates (2026-05-23)", () => {
  it("returns no-binding when threadId is unknown", async () => {
    const reg: ThreadBindingRegistry = { bindings: [], updatedAt: 0 };
    await writeThreadRegistry(registryPath, reg);
    const r = await resetSteerGates(registryPath, "missing");
    expect(r).toEqual({ ok: false, reason: "no-binding" });
  });

  it("refuses to reset a terminal binding (completedAt set)", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding({ completedAt: NOW - 1000 })],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await resetSteerGates(registryPath, "thread-1");
    expect(r).toEqual({ ok: false, reason: "terminal" });
    // Verify NO mutation occurred — completedAt stays.
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.completedAt).toBe(NOW - 1000);
  });

  it("clears lastDeliveryAt to null and sets producedRealContent to false", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [
        binding({ lastDeliveryAt: NOW, producedRealContent: true }),
      ],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await resetSteerGates(registryPath, "thread-1");
    expect(r).toEqual({ ok: true });
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBeNull();
    expect(out.bindings[0]!.producedRealContent).toBe(false);
  });

  it("preserves other binding fields (threadId / agentName / createdAt / lastActivity)", async () => {
    const original = binding({
      lastDeliveryAt: NOW,
      producedRealContent: true,
    });
    const reg: ThreadBindingRegistry = {
      bindings: [original],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    await resetSteerGates(registryPath, "thread-1");
    const out = await readThreadRegistry(registryPath);
    const after = out.bindings[0]!;
    expect(after.threadId).toBe(original.threadId);
    expect(after.parentChannelId).toBe(original.parentChannelId);
    expect(after.agentName).toBe(original.agentName);
    expect(after.sessionName).toBe(original.sessionName);
    expect(after.createdAt).toBe(original.createdAt);
    expect(after.lastActivity).toBe(original.lastActivity);
  });

  it("does not mutate sibling bindings", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [
        binding({ threadId: "thread-1", lastDeliveryAt: 1111, producedRealContent: true }),
        binding({ threadId: "thread-2", lastDeliveryAt: 2222, producedRealContent: true }),
      ],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    await resetSteerGates(registryPath, "thread-2");
    const out = await readThreadRegistry(registryPath);
    // thread-1 untouched
    expect(out.bindings[0]!.lastDeliveryAt).toBe(1111);
    expect(out.bindings[0]!.producedRealContent).toBe(true);
    // thread-2 reset
    expect(out.bindings[1]!.lastDeliveryAt).toBeNull();
    expect(out.bindings[1]!.producedRealContent).toBe(false);
  });
});

describe("migrateBindingsForPhase999_36", () => {
  it("returns migrated=0 when no bindings exist", async () => {
    await writeThreadRegistry(registryPath, { bindings: [], updatedAt: 0 });
    const r = await migrateBindingsForPhase999_36(registryPath);
    expect(r).toEqual({ migrated: 0, total: 0 });
  });

  it("backfills lastDeliveryAt = lastActivity for pre-Phase entries", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding({ lastActivity: 1111 })],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await migrateBindingsForPhase999_36(registryPath);
    expect(r.migrated).toBe(1);
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBe(1111);
  });

  it("is idempotent — re-running on already-migrated bindings is a no-op", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding({ lastDeliveryAt: 9999 })],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await migrateBindingsForPhase999_36(registryPath);
    expect(r.migrated).toBe(0);
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBe(9999);
  });

  it("skips terminal bindings (completedAt set) without backfill", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [
        binding({
          threadId: "t-terminal",
          completedAt: NOW - 5_000,
          lastActivity: 2222,
        }),
      ],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);
    const r = await migrateBindingsForPhase999_36(registryPath);
    expect(r.migrated).toBe(0);
    const out = await readThreadRegistry(registryPath);
    expect(out.bindings[0]!.lastDeliveryAt).toBeUndefined();
  });
});

describe("M2 — cross-process advisory flock fallback", () => {
  it("releases the .lock dir after a mutation completes", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding()],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);

    await mutateThreadRegistry(registryPath, (r) => ({
      ...r,
      updatedAt: NOW,
    }));

    // The lock dir must not be left behind once the op settles.
    expect(existsSync(`${registryPath}.lock`)).toBe(false);
    const out = await readThreadRegistry(registryPath);
    expect(out.updatedAt).toBe(NOW);
  });

  it("reclaims a STALE pre-existing lock dir (left by a crashed daemon) instead of blocking", async () => {
    const reg: ThreadBindingRegistry = {
      bindings: [binding()],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);

    // Simulate a lock left by a SIGKILL'd process: create the dir and
    // backdate its mtime well past the 30s stale window.
    const lockDir = `${registryPath}.lock`;
    await mkdir(lockDir);
    const stale = new Date(Date.now() - 120_000);
    await utimes(lockDir, stale, stale);

    // The mutation must reclaim the stale lock and complete (not hang to the
    // 2s contention budget — assert it finishes promptly + correctly).
    const start = Date.now();
    await mutateThreadRegistry(registryPath, (r) => ({
      ...r,
      updatedAt: NOW,
    }));
    expect(Date.now() - start).toBeLessThan(2_000);

    const out = await readThreadRegistry(registryPath);
    expect(out.updatedAt).toBe(NOW);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("serializes concurrent mutations on the same path (no lost update)", async () => {
    // Two binding fields stamped by two concurrent mutators; both must
    // survive — neither write clobbers the other.
    const reg: ThreadBindingRegistry = {
      bindings: [binding({ lastDeliveryAt: undefined })],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);

    await Promise.all([
      mutateThreadRegistry(registryPath, (r) => ({
        ...r,
        bindings: r.bindings.map((b) => ({ ...b, lastDeliveryAt: 111 })),
        updatedAt: NOW,
      })),
      mutateThreadRegistry(registryPath, (r) => ({
        ...r,
        bindings: r.bindings.map((b) => ({ ...b, completedAt: 222 })),
        updatedAt: NOW + 1,
      })),
    ]);

    const out = await readThreadRegistry(registryPath);
    // Both fields present — serialization preserved both writes.
    expect(out.bindings[0]!.lastDeliveryAt).toBe(111);
    expect(out.bindings[0]!.completedAt).toBe(222);
    expect(existsSync(`${registryPath}.lock`)).toBe(false);
  });

  it("fails open: a fresh (non-stale) foreign lock does not deadlock the mutation", async () => {
    // A concurrent live holder would normally make us spin up to the 2s
    // budget then fail open. Create a FRESH lock dir to force the fail-open
    // path and assert the mutation still completes (delivery never blocked).
    const reg: ThreadBindingRegistry = {
      bindings: [binding()],
      updatedAt: 0,
    };
    await writeThreadRegistry(registryPath, reg);

    const lockDir = `${registryPath}.lock`;
    await mkdir(lockDir); // fresh — owned by a (simulated) live peer
    const held = await stat(lockDir);
    expect(held).toBeDefined();

    // Mutation fails open after the contention budget and still writes.
    await mutateThreadRegistry(registryPath, (r) => ({
      ...r,
      updatedAt: NOW,
    }));

    const out = await readThreadRegistry(registryPath);
    expect(out.updatedAt).toBe(NOW);

    // Clean up the simulated peer lock.
    await rm(lockDir, { recursive: true, force: true });
  });
});
