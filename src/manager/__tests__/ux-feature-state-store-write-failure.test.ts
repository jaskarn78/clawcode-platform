/**
 * Phase 999.171 (REVIEW MD-04 / IN-01) — ux-feature state writes that fail
 * part-way. Kept apart from ux-feature-state-store.test.ts because it
 * replaces `rename` from node:fs/promises (the move-aside path uses rename
 * too): the mock passes through to the real rename unless a test fails it.
 */
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { ManagerError } from "../../shared/errors.js";
import {
  readAllUxFeatureState,
  writeUxFeatureState,
} from "../ux-feature-state-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let dir: string;
let path: string;

function fakeLog() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

function renameFailure(): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`EXDEV: cross-device link not permitted, rename '${path}.abc.tmp' -> '${path}'`),
    { code: "EXDEV" },
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ux-feature-state-fail-"));
  path = join(dir, "manager", "ux-feature-state.json");
});
afterEach(async () => {
  vi.mocked(fsp.rename).mockReset();
  await rm(dir, { recursive: true, force: true });
});

describe("ux-feature state store — a failed rename", () => {
  it("rejects, leaves no .tmp beside the state file, and keeps the previous file intact", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    vi.mocked(fsp.rename).mockRejectedValueOnce(renameFailure());
    await expect(writeUxFeatureState(path, "projects", "liveThinking", true)).rejects.toThrow();
    expect(await readdir(join(dir, "manager"))).toEqual(["ux-feature-state.json"]);
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { liveThinking: true } });
  });
});

describe("ux-feature state store — write failures reach Discord without a filesystem path (IN-01)", () => {
  it("a failed rename rejects with a short ManagerError; the path and cause go to the daemon log", async () => {
    vi.mocked(fsp.rename).mockRejectedValueOnce(renameFailure());
    const log = fakeLog();
    const err = await writeUxFeatureState(path, "personal", "liveThinking", true, log).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagerError);
    const msg = (err as Error).message;
    expect(msg).toContain("see daemon log");
    expect(msg).not.toContain(dir);
    expect(msg).not.toContain("EXDEV");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: path, error: expect.stringContaining("EXDEV") }),
      expect.any(String),
    );
  });

  it("a state directory that cannot be created (EACCES on mkdir) also rejects path-free", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode
    await chmod(dir, 0o500);
    try {
      const err = await writeUxFeatureState(path, "personal", "liveThinking", true).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ManagerError);
      expect((err as Error).message).not.toContain(dir);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
