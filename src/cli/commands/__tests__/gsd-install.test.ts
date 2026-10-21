/**
 * Phase 100 Plan 06 INST- — `clawcode gsd install` CLI tests.
 *
 * Hermetic unit tests covering ensureSymlink + ensureSandbox + runGsdInstallAction
 * with DI-mocked fs deps + gitRunner. NO real filesystem mutations.
 *
 * Pins:
 *   INST1  — ensureSymlink first-time create
 *   INST2  — ensureSymlink already-present-and-matches (no-op)
 *   INST3  — ensureSymlink already-present-but-stale (unlink + recreate)
 *   INST4  — ensureSymlink source missing (failed)
 *   INST5  — ensureSymlink fs.symlink throws (failed)
 *   INST6  — ensureSandbox first-time (mkdir + git init + git commit)
 *   INST7  — ensureSandbox already-initialized (no git commands)
 *   INST8  — ensureSandbox mkdir fails (failed)
 *   INST9  — runGsdInstallAction happy path (returns 0)
 *   INST10 — runGsdInstallAction with one symlink failure (returns 1)
 *   INST11 — runGsdInstallAction prints summary table
 *   INST12 — runGsdInstallAction respects CLI overrides (custom paths)
 *   INST13 — idempotency: re-run with same mocks → no destructive deltas
 *   INST14 — never mutates source paths (no destructive call to /home/example-user/.claude/)
 *   INST15 — absolute-path-only enforcement (relative path rejected)
 *   INST16 — sandbox path traversal guard ('..' rejected)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Logger } from "pino";

import {
  runGsdInstallAction,
  ensureSymlink,
  ensureSandbox,
  DEFAULTS,
  type FsDeps,
  type GitRunner,
} from "../gsd-install.js";

/** Build a fresh fs mock — every test gets clean call-count state. */
function makeFsMock(): {
  readonly fs: FsDeps;
  readonly stat: ReturnType<typeof vi.fn>;
  readonly mkdir: ReturnType<typeof vi.fn>;
  readonly symlink: ReturnType<typeof vi.fn>;
  readonly unlink: ReturnType<typeof vi.fn>;
  readonly readlink: ReturnType<typeof vi.fn>;
} {
  const stat = vi.fn();
  const mkdir = vi.fn();
  const symlink = vi.fn();
  const unlink = vi.fn();
  const readlink = vi.fn();
  return {
    fs: {
      stat: stat as unknown as FsDeps["stat"],
      mkdir: mkdir as unknown as FsDeps["mkdir"],
      symlink: symlink as unknown as FsDeps["symlink"],
      unlink: unlink as unknown as FsDeps["unlink"],
      readlink: readlink as unknown as FsDeps["readlink"],
    },
    stat,
    mkdir,
    symlink,
    unlink,
    readlink,
  };
}

function makeGitRunnerMock(): {
  readonly gitRunner: GitRunner;
  readonly execGit: ReturnType<typeof vi.fn>;
} {
  const execGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
  return {
    gitRunner: { execGit: execGit as unknown as GitRunner["execGit"] },
    execGit,
  };
}

function makeLogMock(): Pick<Logger, "info" | "warn" | "error"> {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Pick<Logger, "info" | "warn" | "error">;
}

/** ENOENT-style error for fs operations on missing paths. */
function makeEnoent(): Error & { code: string } {
  const err = new Error("ENOENT: no such file or directory") as Error & {
    code: string;
  };
  err.code = "ENOENT";
  return err;
}

describe("clawcode gsd install — Phase 100 Plan 06 (INST-)", () => {
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutCapture = [];
    stderrCapture = [];
    writeStdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdoutCapture.push(
          typeof chunk === "string" ? chunk : chunk.toString(),
        );
        return true;
      }) as typeof process.stdout.write);
    writeStderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderrCapture.push(
          typeof chunk === "string" ? chunk : chunk.toString(),
        );
        return true;
      }) as typeof process.stderr.write);
  });

  afterEach(() => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("ensureSymlink", () => {
    it("INST1 — first-time create: target absent → fs.symlink called, returns 'created'", async () => {
      const { fs, stat, mkdir, symlink, readlink } = makeFsMock();
      const log = makeLogMock();

      // source exists
      stat.mockResolvedValue({ isDirectory: () => true });
      // mkdir succeeds
      mkdir.mockResolvedValue(undefined);
      // readlink throws ENOENT (target absent)
      readlink.mockRejectedValue(makeEnoent());
      // symlink succeeds
      symlink.mockResolvedValue(undefined);

      const outcome = await ensureSymlink(
        fs,
        log,
        "/home/example-user/.claude/get-shit-done",
        "/home/clawcode/.claude/get-shit-done",
      );

      expect(outcome).toBe("created");
      expect(symlink).toHaveBeenCalledTimes(1);
      expect(symlink).toHaveBeenCalledWith(
        "/home/example-user/.claude/get-shit-done",
        "/home/clawcode/.claude/get-shit-done",
      );
    });

    it("INST2 — already-present-and-matches: readlink returns source verbatim → returns 'already-present', NO fs.symlink call", async () => {
      const { fs, stat, mkdir, symlink, unlink, readlink } = makeFsMock();
      const log = makeLogMock();

      stat.mockResolvedValue({ isDirectory: () => true });
      mkdir.mockResolvedValue(undefined);
      readlink.mockResolvedValue("/home/example-user/.claude/get-shit-done");

      const outcome = await ensureSymlink(
        fs,
        log,
        "/home/example-user/.claude/get-shit-done",
        "/home/clawcode/.claude/get-shit-done",
      );

      expect(outcome).toBe("already-present");
      expect(symlink).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it("INST3 — already-present-but-stale: readlink returns wrong target → fs.unlink + fs.symlink called, returns 'updated'", async () => {
      const { fs, stat, mkdir, symlink, unlink, readlink } = makeFsMock();
      const log = makeLogMock();

      stat.mockResolvedValue({ isDirectory: () => true });
      mkdir.mockResolvedValue(undefined);
      readlink.mockResolvedValue("/some/other/stale/target");
      unlink.mockResolvedValue(undefined);
      symlink.mockResolvedValue(undefined);

      const outcome = await ensureSymlink(
        fs,
        log,
        "/home/example-user/.claude/get-shit-done",
        "/home/clawcode/.claude/get-shit-done",
      );

      expect(outcome).toBe("updated");
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        "/home/clawcode/.claude/get-shit-done",
      );
      expect(symlink).toHaveBeenCalledTimes(1);
      expect(symlink).toHaveBeenCalledWith(
        "/home/example-user/.claude/get-shit-done",
        "/home/clawcode/.claude/get-shit-done",
      );
    });

    it("INST4 — source missing: fs.stat throws ENOENT → returns 'failed', no destructive calls", async () => {
      const { fs, stat, symlink, unlink } = makeFsMock();
      const log = makeLogMock();

      stat.mockRejectedValue(makeEnoent());

      const outcome = await ensureSymlink(
        fs,
        log,
        "/home/example-user/.claude/missing-source",
        "/home/clawcode/.claude/get-shit-done",
      );

      expect(outcome).toBe("failed");
      expect(symlink).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalled();
    });

    it("INST5 — fs.symlink throws (e.g. EEXIST): returns 'failed' and logs error", async () => {
      const { fs, stat, mkdir, symlink, readlink } = makeFsMock();
      const log = makeLogMock();

      stat.mockResolvedValue({ isDirectory: () => true });
      mkdir.mockResolvedValue(undefined);
      readlink.mockRejectedValue(makeEnoent());
      const eexist = new Error("EEXIST: file already exists") as Error & {
        code: string;
      };
      eexist.code = "EEXIST";
      symlink.mockRejectedValue(eexist);

      const outcome = await ensureSymlink(
        fs,
        log,
        "/home/example-user/.claude/get-shit-done",
        "/home/clawcode/.claude/get-shit-done",
      );

      expect(outcome).toBe("failed");
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe("ensureSandbox", () => {
    it("INST6 — first-time: .git absent → mkdir + git init + git commit, returns 'created'", async () => {
      const { fs, stat, mkdir } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      mkdir.mockResolvedValue(undefined);
      // .git stat throws ENOENT
      stat.mockRejectedValue(makeEnoent());

      const outcome = await ensureSandbox(
        fs,
        gitRunner,
        log,
        "/opt/clawcode-projects/sandbox",
      );

      expect(outcome).toBe("created");
      expect(mkdir).toHaveBeenCalledWith("/opt/clawcode-projects/sandbox", {
        recursive: true,
      });
      // git init + git commit (2 calls)
      expect(execGit).toHaveBeenCalledTimes(2);
      const initCall = execGit.mock.calls[0]![0] as readonly string[];
      const commitCall = execGit.mock.calls[1]![0] as readonly string[];
      expect(initCall).toContain("init");
      expect(commitCall).toContain("commit");
      expect(commitCall).toContain("--allow-empty");
    });

    it("INST7 — already-initialized: .git exists → no git commands run, returns 'already-present'", async () => {
      const { fs, stat, mkdir } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      mkdir.mockResolvedValue(undefined);
      // .git stat resolves successfully (already exists)
      stat.mockResolvedValue({ isDirectory: () => true });

      const outcome = await ensureSandbox(
        fs,
        gitRunner,
        log,
        "/opt/clawcode-projects/sandbox",
      );

      expect(outcome).toBe("already-present");
      expect(execGit).not.toHaveBeenCalled();
    });

    it("INST8 — mkdir fails: returns 'failed', no git commands run", async () => {
      const { fs, mkdir } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      const eperm = new Error("EACCES: permission denied") as Error & {
        code: string;
      };
      eperm.code = "EACCES";
      mkdir.mockRejectedValue(eperm);

      const outcome = await ensureSandbox(
        fs,
        gitRunner,
        log,
        "/opt/clawcode-projects/sandbox",
      );

      expect(outcome).toBe("failed");
      expect(execGit).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe("runGsdInstallAction", () => {
    it("INST9 — happy path: all DI mocked, all 'created' → returns 0", async () => {
      const { fs, stat, mkdir, symlink, readlink } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      // Source paths exist; .git absent at sandbox
      stat.mockImplementation(async (path: string) => {
        if (path.endsWith("/.git")) {
          throw makeEnoent();
        }
        return { isDirectory: () => true };
      });
      mkdir.mockResolvedValue(undefined);
      // All targets absent
      readlink.mockRejectedValue(makeEnoent());
      symlink.mockResolvedValue(undefined);
      execGit.mockResolvedValue({ stdout: "", stderr: "" });

      const code = await runGsdInstallAction({
        fs,
        gitRunner,
        log,
      });

      expect(code).toBe(0);
      // Two symlinks created (skills + commands)
      expect(symlink).toHaveBeenCalledTimes(2);
      // Git init + commit at sandbox
      expect(execGit).toHaveBeenCalledTimes(2);
    });

    it("INST10 — one symlink failure → returns 1", async () => {
      const { fs, stat, mkdir, symlink, readlink } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      // Skills source exists; commands source missing → ensureSymlink failed
      stat.mockImplementation(async (path: string) => {
        if (path === DEFAULTS.commandsSource) {
          throw makeEnoent();
        }
        if (path.endsWith("/.git")) {
          throw makeEnoent();
        }
        return { isDirectory: () => true };
      });
      mkdir.mockResolvedValue(undefined);
      readlink.mockRejectedValue(makeEnoent());
      symlink.mockResolvedValue(undefined);
      execGit.mockResolvedValue({ stdout: "", stderr: "" });

      const code = await runGsdInstallAction({
        fs,
        gitRunner,
        log,
      });

      expect(code).toBe(1);
      const stderrAll = stderrCapture.join("");
      expect(stderrAll.toLowerCase()).toContain("failed");
    });

    it("INST11 — prints summary table containing each step's outcome", async () => {
      const { fs, stat, mkdir, symlink, readlink } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      stat.mockImplementation(async (path: string) => {
        if (path.endsWith("/.git")) {
          throw makeEnoent();
        }
        return { isDirectory: () => true };
      });
      mkdir.mockResolvedValue(undefined);
      readlink.mockRejectedValue(makeEnoent());
      symlink.mockResolvedValue(undefined);
      execGit.mockResolvedValue({ stdout: "", stderr: "" });

      await runGsdInstallAction({ fs, gitRunner, log });

      const stdoutAll = stdoutCapture.join("");
      // Summary table contains each step's name + outcome
      expect(stdoutAll.toLowerCase()).toContain("summary");
      expect(stdoutAll).toContain("skills");
      expect(stdoutAll).toContain("commands");
      expect(stdoutAll).toContain("sandbox");
      expect(stdoutAll).toContain("created");
    });

    it("INST12 — respects CLI overrides (custom paths)", async () => {
      const { fs, stat, mkdir, symlink, readlink } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      stat.mockImplementation(async (path: string) => {
        if (path.endsWith("/.git")) {
          throw makeEnoent();
        }
        return { isDirectory: () => true };
      });
      mkdir.mockResolvedValue(undefined);
      readlink.mockRejectedValue(makeEnoent());
      symlink.mockResolvedValue(undefined);
      execGit.mockResolvedValue({ stdout: "", stderr: "" });

      const code = await runGsdInstallAction({
        skillsSource: "/custom/source/skills",
        skillsTarget: "/custom/target/skills",
        commandsSource: "/custom/source/commands",
        commandsTarget: "/custom/target/commands",
        sandboxDir: "/custom/sandbox",
        fs,
        gitRunner,
        log,
      });

      expect(code).toBe(0);
      // Symlink calls used the custom paths
      const symlinkArgs = symlink.mock.calls.map((c) => c.slice(0, 2));
      const sources = symlinkArgs.map((a) => a[0]);
      const targets = symlinkArgs.map((a) => a[1]);
      expect(sources).toContain("/custom/source/skills");
      expect(sources).toContain("/custom/source/commands");
      expect(targets).toContain("/custom/target/skills");
      expect(targets).toContain("/custom/target/commands");
      // Git ran against the custom sandbox dir
      const gitArgs = execGit.mock.calls.map((c) => c[0] as readonly string[]);
      const sawCustomSandbox = gitArgs.some(
        (a) => a.includes("/custom/sandbox"),
      );
      expect(sawCustomSandbox).toBe(true);
    });

    it("INST13 — re-running with identical mocks (already-present state) produces no destructive deltas", async () => {
      const { fs, stat, mkdir, symlink, unlink, readlink } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      // already-present: .git exists; readlink returns the matching source
      stat.mockResolvedValue({ isDirectory: () => true });
      mkdir.mockResolvedValue(undefined);
      readlink.mockImplementation(async (target: string) => {
        if (target === DEFAULTS.skillsTarget) return DEFAULTS.skillsSource;
        if (target === DEFAULTS.commandsTarget) return DEFAULTS.commandsSource;
        throw makeEnoent();
      });
      execGit.mockResolvedValue({ stdout: "", stderr: "" });

      const code1 = await runGsdInstallAction({ fs, gitRunner, log });
      const symlinkCallsAfterFirst = symlink.mock.calls.length;
      const unlinkCallsAfterFirst = unlink.mock.calls.length;
      const execGitCallsAfterFirst = execGit.mock.calls.length;

      const code2 = await runGsdInstallAction({ fs, gitRunner, log });

      expect(code1).toBe(0);
      expect(code2).toBe(0);
      // No additional destructive calls between runs
      expect(symlink.mock.calls.length).toBe(symlinkCallsAfterFirst);
      expect(unlink.mock.calls.length).toBe(unlinkCallsAfterFirst);
      expect(execGit.mock.calls.length).toBe(execGitCallsAfterFirst);
      // First run was already a no-op (already-present)
      expect(symlinkCallsAfterFirst).toBe(0);
      expect(unlinkCallsAfterFirst).toBe(0);
      expect(execGitCallsAfterFirst).toBe(0);
    });

    it("INST14 — never mutates source paths (no destructive calls to /home/example-user/.claude/)", async () => {
      const { fs, stat, mkdir, symlink, unlink, readlink } = makeFsMock();
      const { gitRunner, execGit } = makeGitRunnerMock();
      const log = makeLogMock();

      stat.mockImplementation(async (path: string) => {
        if (path.endsWith("/.git")) {
          throw makeEnoent();
        }
        return { isDirectory: () => true };
      });
      mkdir.mockResolvedValue(undefined);
      // Stale targets — force unlink + symlink path
      readlink.mockResolvedValue("/some/stale/old/target");
      unlink.mockResolvedValue(undefined);
      symlink.mockResolvedValue(undefined);
      execGit.mockResolvedValue({ stdout: "", stderr: "" });

      await runGsdInstallAction({ fs, gitRunner, log });

      // Assert no destructive call mentions a /home/example-user/.claude/ path
      for (const call of unlink.mock.calls) {
        expect(call[0] as string).not.toMatch(/^\/home\/example-user\/\.claude/);
      }
      for (const call of symlink.mock.calls) {
        // symlink(source, target) — only target is mutated; source is read-only
        const target = call[1] as string;
        expect(target).not.toMatch(/^\/home\/example-user\/\.claude/);
      }
      for (const call of mkdir.mock.calls) {
        expect(call[0] as string).not.toMatch(/^\/home\/example-user\/\.claude/);
      }
      // Git ran only against the sandbox dir, not source paths
      for (const call of execGit.mock.calls) {
        const args = call[0] as readonly string[];
        for (const a of args) {
          expect(a).not.toMatch(/^\/home\/example-user\/\.claude/);
        }
      }
    });

    it("INST15 — absolute-path-only enforcement: relative path rejected at action entry", async () => {
      const { fs } = makeFsMock();
      const { gitRunner } = makeGitRunnerMock();
      const log = makeLogMock();

      await expect(
        runGsdInstallAction({
          skillsSource: "relative/path/skills",
          fs,
          gitRunner,
          log,
        }),
      ).rejects.toThrow(/absolute/i);
    });

    it("INST16 — sandbox path traversal guard: '..' rejected", async () => {
      const { fs } = makeFsMock();
      const { gitRunner } = makeGitRunnerMock();
      const log = makeLogMock();

      await expect(
        runGsdInstallAction({
          sandboxDir: "/opt/../etc/sandbox",
          fs,
          gitRunner,
          log,
        }),
      ).rejects.toThrow(/'\.\.'|traversal|absolute/i);
    });
  });
});
