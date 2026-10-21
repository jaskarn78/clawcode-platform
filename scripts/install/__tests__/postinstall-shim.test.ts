/**
 * Phase 110-03 Task 2 — Tests for npm postinstall hook.
 *
 * Behavior under test:
 *  1. linux/x64 selects prebuilds/linux-amd64/clawcode-mcp-shim
 *  2. linux/arm64 selects prebuilds/linux-arm64/clawcode-mcp-shim
 *  3. unsupported platform (darwin) throws (fail-loud)
 *  4. install() actually places binary at target with execute permission
 *  5. install() is idempotent (running twice doesn't error)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { selectPrebuild, install, runMain } from "../postinstall-shim.cjs";

describe("selectPrebuild", () => {
  it("Test 1: linux x64 selects amd64 prebuild path", () => {
    const result = selectPrebuild("linux", "x64");
    // Use `sep` so this passes on any host that runs the test, but the
    // production target is linux so forward slashes are the canonical form.
    expect(result.split(sep).join("/")).toBe("prebuilds/linux-amd64/clawcode-mcp-shim");
  });

  it("Test 2: linux arm64 selects arm64 prebuild path", () => {
    const result = selectPrebuild("linux", "arm64");
    expect(result.split(sep).join("/")).toBe("prebuilds/linux-arm64/clawcode-mcp-shim");
  });

  it("Test 3: unsupported platform fails loud (no silent skip)", () => {
    expect(() => selectPrebuild("darwin", "arm64")).toThrowError(
      /no prebuilt binary for darwin-arm64/i,
    );
    expect(() => selectPrebuild("win32", "x64")).toThrowError(
      /no prebuilt binary for win32-x64/i,
    );
  });
});

describe("install", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "postinstall-shim-"));
    // Lay down a fake prebuild matching what the npm tarball ships.
    const prebuildDir = join(tmp, "prebuilds", "linux-amd64");
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(join(prebuildDir, "clawcode-mcp-shim"), "#!/bin/sh\necho fake\n", {
      mode: 0o644,
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Test 4: copy actually places binary at node_modules/.bin with exec perm", () => {
    // Force x64 selection regardless of host (test must work on arm64 dev machines too).
    const target = join(tmp, "node_modules", ".bin", "clawcode-mcp-shim");
    install({ pkgRoot: tmp, target, platform: "linux", arch: "x64" });

    expect(existsSync(target)).toBe(true);
    const st = statSync(target);
    // Mode includes execute bit for owner, group, other.
    expect((st.mode & 0o111) !== 0).toBe(true);
    // Content was copied from the prebuild.
    expect(readFileSync(target, "utf8")).toContain("fake");
  });

  it("Test 5: idempotent — running install twice does not error", () => {
    const target = join(tmp, "node_modules", ".bin", "clawcode-mcp-shim");
    install({ pkgRoot: tmp, target, platform: "linux", arch: "x64" });
    expect(() =>
      install({ pkgRoot: tmp, target, platform: "linux", arch: "x64" }),
    ).not.toThrow();
    expect(existsSync(target)).toBe(true);
  });

  it("install throws if prebuild file is missing in pkgRoot", () => {
    // Different arch's prebuild not laid down — should fail loud.
    const target = join(tmp, "node_modules", ".bin", "clawcode-mcp-shim");
    expect(() =>
      install({ pkgRoot: tmp, target, platform: "linux", arch: "arm64" }),
    ).toThrowError(/prebuild missing/i);
  });
});

describe("runMain (entry point)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "postinstall-shim-main-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Test 7: skips with visible notice when prebuilds/ directory absent (dev / source-checkout)", () => {
    // No prebuilds/ dir at all — should skip, not throw, not silently.
    const messages: string[] = [];
    const errors: string[] = [];
    const target = join(tmp, "node_modules", ".bin", "clawcode-mcp-shim");
    const result = runMain({
      pkgRoot: tmp,
      target,
      log: (m: string) => messages.push(m),
      errlog: (m: string) => errors.push(m),
    });

    expect(result.skipped).toBe(true);
    expect(existsSync(target)).toBe(false); // no install occurred
    expect(messages.join("\n")).toMatch(/prebuilds\/ not present/i);
    expect(errors).toHaveLength(0); // not an error path
  });

  it("Test 8: installs normally when prebuilds/ exists with the right arch", () => {
    // Lay down a fake prebuild for whatever arch the test host actually runs.
    // Easiest: use linux-amd64 and force platform/arch via process.* override
    // NOT possible from runMain — runMain consumes process.platform/arch.
    // So skip this case if host is not linux/x64. The selectPrebuild +
    // install tests above cover the override path; this test verifies
    // runMain's wiring on hosts that match a SUPPORTED key.
    const isSupportedHost =
      (process.platform === "linux" && process.arch === "x64") ||
      (process.platform === "linux" && process.arch === "arm64");
    if (!isSupportedHost) {
      // On unsupported hosts, runMain would throw via install() — covered by Test 9.
      return;
    }
    const archDir = process.arch === "x64" ? "linux-amd64" : "linux-arm64";
    const prebuildDir = join(tmp, "prebuilds", archDir);
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(join(prebuildDir, "clawcode-mcp-shim"), "#!/bin/sh\necho fake\n", {
      mode: 0o644,
    });

    const messages: string[] = [];
    const target = join(tmp, "node_modules", ".bin", "clawcode-mcp-shim");
    const result = runMain({
      pkgRoot: tmp,
      target,
      log: (m: string) => messages.push(m),
    });

    expect(result.skipped).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(messages.join("\n")).toMatch(/installed binary at/);
  });

  it("Test 9: throws when prebuilds/ exists but arch-specific binary missing (corrupt tarball)", () => {
    // Make prebuilds/ exist but empty — no per-arch dir.
    mkdirSync(join(tmp, "prebuilds"), { recursive: true });
    const target = join(tmp, "node_modules", ".bin", "clawcode-mcp-shim");

    if (!(process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"))) {
      // selectPrebuild throws first on unsupported host — that's also fail-loud
      expect(() => runMain({ pkgRoot: tmp, target, log: () => {}, errlog: () => {} })).toThrow(
        /no prebuilt binary for/i,
      );
      return;
    }

    expect(() => runMain({ pkgRoot: tmp, target, log: () => {}, errlog: () => {} })).toThrow(
      /prebuild missing/i,
    );
  });
});
