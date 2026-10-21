/**
 * Phase 137 Plan 01 T-01 — discoverCliBinary unit tests.
 *
 * Proves the 3-tier resolution order:
 *   (1) explicit config path → returned verbatim when on-disk.
 *   (2) PATH probe via `which` → returned when explicit is undefined.
 *   (3) commonPaths → tried in order when (1) + (2) fail.
 *
 * Also proves the `CliBinaryNotFoundError.checked` list is operator-
 * actionable: every probe lands in the list in the order it was
 * tried, including the explicit path when it was supplied but
 * missing.
 *
 * All filesystem + child_process access is stubbed via the
 * injectable `DiscoverCliBinaryDeps` — no real `which` execution,
 * no real `fs.existsSync` calls.
 *
 * See:
 *   - src/llm-runtime/discovery.ts
 *   - .planning/phases/137-.../137-01-PLAN.md T-01
 */

import { describe, it, expect, vi } from "vitest";
import {
  discoverCliBinary,
  CliBinaryNotFoundError,
  type DiscoverCliBinaryDeps,
} from "../discovery.js";

describe("discoverCliBinary", () => {
  it("(1) explicitPath provided + exists → returns explicitPath verbatim", async () => {
    const existsSync = vi.fn((p: string) => p === "/opt/codex/bin/codex");
    const which = vi.fn(async () => null);
    const deps: DiscoverCliBinaryDeps = { existsSync, which };

    const result = await discoverCliBinary(
      {
        binaryName: "codex",
        explicitPath: "/opt/codex/bin/codex",
        commonPaths: ["/usr/local/bin/codex"],
      },
      deps,
    );

    expect(result).toBe("/opt/codex/bin/codex");
    // PATH probe + commonPaths probes must NOT run on tier-1 hit.
    expect(which).not.toHaveBeenCalled();
  });

  it("(2) explicitPath undefined + which returns abs path → returns that path", async () => {
    const existsSync = vi.fn(() => false);
    const which = vi.fn(async () => "/usr/bin/codex");
    const deps: DiscoverCliBinaryDeps = { existsSync, which };

    const result = await discoverCliBinary(
      {
        binaryName: "codex",
        commonPaths: ["/usr/local/bin/codex"],
      },
      deps,
    );

    expect(result).toBe("/usr/bin/codex");
    expect(which).toHaveBeenCalledWith("codex");
    // commonPaths must NOT be probed on tier-2 hit.
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("(3) which returns null + commonPaths[0] exists → returns commonPaths[0]", async () => {
    const existsSync = vi.fn((p: string) => p === "/usr/local/bin/codex");
    const which = vi.fn(async () => null);
    const deps: DiscoverCliBinaryDeps = { existsSync, which };

    const result = await discoverCliBinary(
      {
        binaryName: "codex",
        commonPaths: [
          "/usr/local/bin/codex",
          "/home/operator/.local/bin/codex",
        ],
      },
      deps,
    );

    expect(result).toBe("/usr/local/bin/codex");
    // Second commonPath must NOT be probed once the first hits.
    expect(existsSync).toHaveBeenCalledTimes(1);
  });

  it("(4) nothing resolves (no explicit) → CliBinaryNotFoundError with .checked.length === 1 + commonPaths.length", async () => {
    const existsSync = vi.fn(() => false);
    const which = vi.fn(async () => null);
    const deps: DiscoverCliBinaryDeps = { existsSync, which };

    const commonPaths = [
      "/usr/local/bin/codex",
      "/home/operator/.local/bin/codex",
      "/opt/homebrew/bin/codex",
    ];

    let caught: unknown;
    try {
      await discoverCliBinary(
        { binaryName: "codex", commonPaths },
        deps,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliBinaryNotFoundError);
    const err = caught as CliBinaryNotFoundError;
    expect(err.binaryName).toBe("codex");
    // No explicit path → 1 PATH-probe label + N commonPaths.
    expect(err.checked).toHaveLength(1 + commonPaths.length);
    // PATH probe label is the first entry.
    expect(err.checked[0]).toContain("which");
    expect(err.checked[0]).toContain("codex");
    // commonPaths follow in order.
    for (let i = 0; i < commonPaths.length; i++) {
      expect(err.checked[i + 1]).toBe(commonPaths[i]);
    }
    // Error message lists each path for operator copy-paste.
    expect(err.message).toContain("codex");
    expect(err.message).toContain("/usr/local/bin/codex");
  });

  it("(5) explicit provided but missing + everything else fails → error.checked includes explicit AND all fallbacks", async () => {
    const existsSync = vi.fn(() => false);
    const which = vi.fn(async () => null);
    const deps: DiscoverCliBinaryDeps = { existsSync, which };

    const commonPaths = [
      "/usr/local/bin/codex",
      "/home/operator/.local/bin/codex",
    ];

    await expect(
      discoverCliBinary(
        {
          binaryName: "codex",
          explicitPath: "/operator/typo/codex",
          commonPaths,
        },
        deps,
      ),
    ).rejects.toThrow(CliBinaryNotFoundError);

    // Re-run to inspect the error instance.
    let caught: CliBinaryNotFoundError | undefined;
    try {
      await discoverCliBinary(
        {
          binaryName: "codex",
          explicitPath: "/operator/typo/codex",
          commonPaths,
        },
        deps,
      );
    } catch (err) {
      caught = err as CliBinaryNotFoundError;
    }
    expect(caught).toBeDefined();
    // Explicit + 1 PATH probe + 2 commonPaths = 4 entries.
    expect(caught!.checked).toHaveLength(1 + 1 + commonPaths.length);
    expect(caught!.checked[0]).toBe("/operator/typo/codex");
    expect(caught!.checked[1]).toContain("which");
    expect(caught!.checked.slice(2)).toEqual(commonPaths);
  });
});
