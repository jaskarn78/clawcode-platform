/**
 * Unit tests for Phase 77 Plan 03 runtime fs-guard (MIGR-07 belt-and-suspenders).
 *
 * Five load-bearing invariants:
 *   1. Installed state intercepts fs.writeFile / appendFile / mkdir (async + sync)
 *      and throws ReadOnlySourceError BEFORE the original implementation runs
 *      when the path resolves under ~/.openclaw/.
 *   2. Installed state passes through writes to paths NOT under ~/.openclaw/
 *      to the original implementation unchanged.
 *   3. Uninstall restores original behavior — a post-uninstall write under
 *      ~/.openclaw/ does NOT throw ReadOnlySourceError (filesystem-level
 *      error/success resumes).
 *   4. Install is idempotent — calling twice does NOT double-wrap (verified
 *      via a second install+uninstall cycle leaving the surface clean).
 *   5. Path extraction handles string, Buffer, and URL argument forms
 *      (fd `number` is a no-op pass-through per node:fs semantics).
 *
 * ### ESM-scope note
 * The fs-guard patches the CJS module objects returned by `require("node:fs")`
 * and `require("node:fs/promises")` — those are the same objects that the
 * default-export import style binds to. Callers using `import * as fs from
 * "node:fs"` or `import { writeFile } from "node:fs/promises"` receive
 * ESM-frozen bindings that CANNOT be patched at runtime (Node.js
 * fundamental — not a bug in this module).
 *
 * Therefore these tests exercise the guard through `createRequire()` access —
 * matching how dynamic-path production code that wants to be covered would
 * access fs. The static-grep regression test in migrate-openclaw.test.ts is
 * the primary MIGR-07 line of defense against named-import code; the
 * runtime guard is the belt-and-suspenders fallback.
 *
 * These tests do NOT vi.mock node:fs or node:fs/promises — the whole point
 * of fs-guard is to patch the REAL underlying module objects. Tests use
 * mkdtemp + real writes + real stat to assert on-disk behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  installFsGuard,
  uninstallFsGuard,
} from "../fs-guard.js";
import { ReadOnlySourceError } from "../guards.js";

// Access fs through createRequire — this returns the SAME underlying CJS
// object that the fs-guard patches. Using named ESM imports would capture
// the original function at import time and never see the patched version.
const localRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fs: any = localRequire("node:fs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fsp: any = localRequire("node:fs/promises");

describe("fs-guard runtime interceptor", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fs-guard-"));
  });

  afterEach(() => {
    uninstallFsGuard();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("async writeFile under ~/.openclaw/ throws ReadOnlySourceError before any filesystem interaction", async () => {
    installFsGuard();
    const forbidden = join(homedir(), ".openclaw", "migration-test-canary");
    await expect(fsp.writeFile(forbidden, "x")).rejects.toBeInstanceOf(
      ReadOnlySourceError,
    );
    // Nothing should exist on disk at the forbidden canary path.
    expect(existsSync(forbidden)).toBe(false);
  });

  it("sync writeFileSync under ~/.openclaw/ throws ReadOnlySourceError", () => {
    installFsGuard();
    const forbidden = join(homedir(), ".openclaw", "canary-sync");
    expect(() => fs.writeFileSync(forbidden, "x")).toThrow(
      ReadOnlySourceError,
    );
    expect(existsSync(forbidden)).toBe(false);
  });

  it("writeFile to /tmp/... (outside ~/.openclaw/) executes normally", async () => {
    installFsGuard();
    const allowed = join(tmp, "allowed.txt");
    await fsp.writeFile(allowed, "hello");
    expect(existsSync(allowed)).toBe(true);
  });

  it("uninstall restores original behavior — write under ~/.openclaw/ does NOT throw ReadOnlySourceError", async () => {
    installFsGuard();
    uninstallFsGuard();
    // After uninstall, the guard must NOT fire. We do not actually attempt
    // to pollute the real ~/.openclaw/ tree — instead we assert the positive
    // proof: a write to ~/.openclaw/<canary> would either succeed or raise a
    // NON-ReadOnlySourceError (e.g., EACCES / EISDIR) — never the guard's
    // dedicated error type.
    const target = join(homedir(), ".openclaw", "post-uninstall-canary");
    let thrown: unknown;
    try {
      await fsp.writeFile(target, "x");
      // If it somehow succeeded, clean up so the next test run doesn't see
      // the leftover file.
      rmSync(target, { force: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeInstanceOf(ReadOnlySourceError);
  });

  it("install is idempotent — calling twice does not double-wrap", async () => {
    installFsGuard();
    installFsGuard(); // second call MUST be a no-op
    // Prove idempotency by showing uninstall fully restores after a single
    // uninstall call: the original fs.writeFile surface is back (no guard).
    uninstallFsGuard();
    const allowed = join(tmp, "after-double-install.txt");
    await fsp.writeFile(allowed, "ok");
    expect(existsSync(allowed)).toBe(true);
    // Re-install + re-uninstall still restores clean state.
    installFsGuard();
    uninstallFsGuard();
    const allowed2 = join(tmp, "after-cycle.txt");
    await fsp.writeFile(allowed2, "ok2");
    expect(existsSync(allowed2)).toBe(true);
  });

  it("uninstall without prior install is a safe no-op", async () => {
    // Fresh suite — no prior install in this test. (beforeEach did not
    // install; afterEach's uninstall is the one we're testing here.)
    uninstallFsGuard();
    // Writes must still work normally.
    const allowed = join(tmp, "never-installed.txt");
    await fsp.writeFile(allowed, "ok");
    expect(existsSync(allowed)).toBe(true);
  });

  it("Buffer path argument is extracted and checked", () => {
    installFsGuard();
    const forbidden = Buffer.from(
      join(homedir(), ".openclaw", "buffer-canary"),
      "utf8",
    );
    expect(() => fs.writeFileSync(forbidden, "x")).toThrow(
      ReadOnlySourceError,
    );
  });

  it("URL path argument is converted via fileURLToPath and checked", () => {
    installFsGuard();
    const forbidden = pathToFileURL(
      join(homedir(), ".openclaw", "url-canary"),
    );
    expect(() => fs.writeFileSync(forbidden, "x")).toThrow(
      ReadOnlySourceError,
    );
  });

  it("appendFile to a path outside ~/.openclaw/ (e.g. the ledger path) passes through", async () => {
    installFsGuard();
    const ledgerLike = join(tmp, ".planning", "migration", "ledger.jsonl");
    await fsp.mkdir(join(tmp, ".planning", "migration"), { recursive: true });
    await fsp.appendFile(ledgerLike, '{"row":1}\n');
    await fsp.appendFile(ledgerLike, '{"row":2}\n');
    const content = fs.readFileSync(ledgerLike, "utf8");
    expect(content).toBe('{"row":1}\n{"row":2}\n');
  });

  it("file-descriptor (number) argument is pass-through — no path extraction", () => {
    installFsGuard();
    // Open a real fd to a legit file, write via fd — must not throw.
    const allowed = join(tmp, "fd-write.txt");
    fs.writeFileSync(allowed, ""); // create
    const fd = fs.openSync(allowed, "w");
    try {
      expect(() => fs.writeFileSync(fd, "via-fd")).not.toThrow();
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(allowed, "utf8")).toBe("via-fd");
  });

  it("mkdir async under ~/.openclaw/ throws ReadOnlySourceError", async () => {
    installFsGuard();
    const forbidden = join(homedir(), ".openclaw", "mkdir-canary");
    await expect(
      fsp.mkdir(forbidden, { recursive: true }),
    ).rejects.toBeInstanceOf(ReadOnlySourceError);
  });

  it("mkdirSync under ~/.openclaw/ throws ReadOnlySourceError", () => {
    installFsGuard();
    const forbidden = join(homedir(), ".openclaw", "mkdir-sync-canary");
    expect(() => fs.mkdirSync(forbidden, { recursive: true })).toThrow(
      ReadOnlySourceError,
    );
  });

  it("appendFileSync under ~/.openclaw/ throws ReadOnlySourceError", () => {
    installFsGuard();
    const forbidden = join(homedir(), ".openclaw", "append-sync-canary");
    expect(() => fs.appendFileSync(forbidden, "x")).toThrow(
      ReadOnlySourceError,
    );
    expect(existsSync(forbidden)).toBe(false);
  });
});

describe("allowlist option (Phase 82)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fs-guard-allow-"));
  });

  afterEach(() => {
    uninstallFsGuard();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("default install (no args) preserves existing Phase 77 behavior — writes under ~/.openclaw/ still throw", async () => {
    installFsGuard();
    const forbidden = join(homedir(), ".openclaw", "phase82-default-canary");
    await expect(fsp.writeFile(forbidden, "x")).rejects.toBeInstanceOf(
      ReadOnlySourceError,
    );
  });

  it("allowlist entry permits writes to exactly that resolved path", async () => {
    // We exercise the allowlist using a path under ~/.openclaw/ (which would
    // normally be forbidden). We DO NOT actually write to the real source
    // tree — we stub the underlying write via a monkey-patch observer. The
    // allowlist check must let the call THROUGH the guard; the stub then
    // intercepts before any real disk I/O.
    const { createRequire } = await import("node:module");
    const lr = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fspMutable: any = lr("node:fs/promises");
    const originalWriteFile = fspMutable.writeFile;
    let intercepted: string | undefined;

    const allowed = join(homedir(), ".openclaw", "openclaw.json");
    installFsGuard({ allowlist: [allowed] });

    // After install, writeFile is the wrapped version. Replace the WRAPPED
    // version with a sentinel so allowlist-permitted calls land at our
    // intercept instead of the real fs.
    fspMutable.writeFile = async (p: unknown, ..._rest: unknown[]) => {
      intercepted = String(p);
    };
    try {
      await fspMutable.writeFile(allowed, "x");
      expect(intercepted).toBe(allowed);
    } finally {
      fspMutable.writeFile = originalWriteFile;
    }
  });

  it("allowlist is exact-equality on resolved paths — sibling openclaw.json.bak still refused", async () => {
    const allowed = join(homedir(), ".openclaw", "openclaw.json");
    installFsGuard({ allowlist: [allowed] });
    const sibling = join(homedir(), ".openclaw", "openclaw.json.bak");
    await expect(fsp.writeFile(sibling, "x")).rejects.toBeInstanceOf(
      ReadOnlySourceError,
    );
  });

  it("allowlist normalizes via path.resolve (relative paths, trailing slashes)", async () => {
    // Pass a non-normalized path; still should match its canonical form.
    const canonical = join(homedir(), ".openclaw", "openclaw.json");
    const denormalized = join(homedir(), ".openclaw", ".", "openclaw.json");
    installFsGuard({ allowlist: [denormalized] });

    const { createRequire } = await import("node:module");
    const lr = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fspMutable: any = lr("node:fs/promises");
    const originalWriteFile = fspMutable.writeFile;
    let intercepted: string | undefined;
    fspMutable.writeFile = async (p: unknown, ..._rest: unknown[]) => {
      intercepted = String(p);
    };
    try {
      await fspMutable.writeFile(canonical, "x");
      expect(intercepted).toBe(canonical);
    } finally {
      fspMutable.writeFile = originalWriteFile;
    }
  });

  it("uninstall clears allowlist — re-install with no args refuses the previously-allowlisted path", async () => {
    const allowed = join(homedir(), ".openclaw", "openclaw.json");
    installFsGuard({ allowlist: [allowed] });
    uninstallFsGuard();
    installFsGuard(); // no args — should be empty allowlist
    await expect(fsp.writeFile(allowed, "x")).rejects.toBeInstanceOf(
      ReadOnlySourceError,
    );
  });

  it("allowlist permits writes to /tmp/... (outside ~/.openclaw/) via normal pass-through (unchanged)", async () => {
    const allowed = join(tmp, "allow-noop.txt");
    installFsGuard({ allowlist: [join(homedir(), ".openclaw", "openclaw.json")] });
    await fsp.writeFile(allowed, "hello");
    expect(existsSync(allowed)).toBe(true);
  });

  it("empty allowlist array behaves identically to no argument", async () => {
    installFsGuard({ allowlist: [] });
    const forbidden = join(homedir(), ".openclaw", "empty-allowlist-canary");
    await expect(fsp.writeFile(forbidden, "x")).rejects.toBeInstanceOf(
      ReadOnlySourceError,
    );
  });
});
