import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ClaudeBinaryNotFoundError,
  checkBinaryIntegrity,
  platformPackageName,
  probeFleetBinary,
  readBinaryManifest,
  readInstalledSdk,
  resolveClaudeBinary,
  sha256File,
  type ClaudeBinaryDeps,
} from "../claude-binary.js";

const SDK_DIR = "/app/node_modules/@anthropic-ai/claude-agent-sdk";
const GLIBC_PKG = "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64";
const MUSL_PKG = "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl";

function fakeDeps(over: Partial<ClaudeBinaryDeps> & { files?: Record<string, string> } = {}): ClaudeBinaryDeps {
  const files: Record<string, string> = {
    [`${SDK_DIR}/package.json`]: JSON.stringify({ version: "0.3.282", claudeCodeVersion: "2.1.282" }),
    [`${GLIBC_PKG}/package.json`]: "{}",
    [`${GLIBC_PKG}/claude`]: "ELF",
    ...over.files,
  };
  return {
    env: {},
    platform: "linux",
    arch: "x64",
    isGlibc: () => true,
    resolveModule: (spec) => {
      if (spec === "@anthropic-ai/claude-agent-sdk") return `${SDK_DIR}/sdk.mjs`;
      const pkg = spec.replace(/\/package\.json$/, "");
      const dir = `/app/node_modules/${pkg}`;
      if (`${dir}/package.json` in files) return `${dir}/package.json`;
      throw new Error(`Cannot find module '${spec}'`);
    },
    readFile: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    exists: (p) => p in files,
    ...over,
  };
}

describe("platformPackageName", () => {
  it("maps linux glibc/musl, darwin, and refuses unsupported platforms", () => {
    expect(platformPackageName("linux", "x64", true)).toBe("@anthropic-ai/claude-agent-sdk-linux-x64");
    expect(platformPackageName("linux", "x64", false)).toBe("@anthropic-ai/claude-agent-sdk-linux-x64-musl");
    expect(platformPackageName("linux", "arm64", true)).toBe("@anthropic-ai/claude-agent-sdk-linux-arm64");
    expect(platformPackageName("darwin", "arm64", true)).toBe("@anthropic-ai/claude-agent-sdk-darwin-arm64");
    expect(platformPackageName("win32", "x64", true)).toBeNull();
    expect(platformPackageName("linux", "ia32", true)).toBeNull();
  });
});

describe("readInstalledSdk", () => {
  it("reads version + claudeCodeVersion beside the resolved entry (package.json is not exported)", () => {
    expect(readInstalledSdk(fakeDeps())).toEqual({
      version: "0.3.282",
      claudeCodeVersion: "2.1.282",
      dir: SDK_DIR,
    });
  });

  it("returns null when the SDK is not installed", () => {
    const deps = fakeDeps({
      resolveModule: () => {
        throw new Error("Cannot find module");
      },
    });
    expect(readInstalledSdk(deps)).toBeNull();
  });

  it("claudeCodeVersion is null when the SDK does not declare one", () => {
    const deps = fakeDeps({ files: { [`${SDK_DIR}/package.json`]: JSON.stringify({ version: "0.3.1" }) } });
    expect(readInstalledSdk(deps)?.claudeCodeVersion).toBeNull();
  });
});

describe("resolveClaudeBinary", () => {
  it("resolves the SDK's own glibc platform binary by default", () => {
    const r = resolveClaudeBinary(fakeDeps());
    expect(r.path).toBe(`${GLIBC_PKG}/claude`);
    expect(r.source).toBe("sdk-bundled");
    expect(r.sdk?.claudeCodeVersion).toBe("2.1.282");
  });

  it("picks the musl package on a non-glibc host", () => {
    const deps = fakeDeps({
      isGlibc: () => false,
      files: { [`${MUSL_PKG}/package.json`]: "{}", [`${MUSL_PKG}/claude`]: "ELF" },
    });
    expect(resolveClaudeBinary(deps).path).toBe(`${MUSL_PKG}/claude`);
  });

  it("CLAWCODE_CLAUDE_BIN (trimmed) is an explicit override and wins", () => {
    const r = resolveClaudeBinary(fakeDeps({ env: { CLAWCODE_CLAUDE_BIN: "  /opt/clawcode/claude-pin/claude " } }));
    expect(r).toMatchObject({ path: "/opt/clawcode/claude-pin/claude", source: "override" });
    expect(r.sdk?.version).toBe("0.3.282");
  });

  it("a blank override is ignored", () => {
    expect(resolveClaudeBinary(fakeDeps({ env: { CLAWCODE_CLAUDE_BIN: "   " } })).source).toBe("sdk-bundled");
  });

  it("fails loud — never falls back silently — when the platform package is missing", () => {
    const noPkg = fakeDeps({
      resolveModule: (spec) => {
        if (spec === "@anthropic-ai/claude-agent-sdk") return `${SDK_DIR}/sdk.mjs`;
        throw new Error(`Cannot find module '${spec}'`);
      },
    });
    expect(() => resolveClaudeBinary(noPkg)).toThrow(ClaudeBinaryNotFoundError);
    expect(() => resolveClaudeBinary(noPkg)).toThrow(/claude-agent-sdk-linux-x64/);
    expect(() => resolveClaudeBinary(noPkg)).toThrow(/npm ci/);
  });

  it("fails loud when the package resolves but the binary file is absent", () => {
    const deps = fakeDeps({ exists: (p) => p !== `${GLIBC_PKG}/claude` });
    expect(() => resolveClaudeBinary(deps)).toThrow(ClaudeBinaryNotFoundError);
  });

  it("an unsupported platform without an override names the override as the fix", () => {
    expect(() => resolveClaudeBinary(fakeDeps({ platform: "win32" }))).toThrow(/CLAWCODE_CLAUDE_BIN/);
  });
});

describe("binary integrity (999.169 review)", () => {
  it("sha256File streams a file and matches node's one-shot hash; null when unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-"));
    const f = join(dir, "bin");
    const data = Buffer.alloc(3 * (1 << 20) + 17, 7);
    writeFileSync(f, data);
    expect(sha256File(f)).toBe(createHash("sha256").update(data).digest("hex"));
    expect(sha256File(join(dir, "missing"))).toBeNull();
  });

  it("probeFleetBinary records platform package + sha256, and can skip hashing", () => {
    const resolve = () => ({
      path: "/x/claude",
      source: "sdk-bundled" as const,
      platformPackage: "@anthropic-ai/claude-agent-sdk-linux-x64",
      sdk: { version: "0.3.282", claudeCodeVersion: "2.1.282", dir: "/x" },
    });
    const p = probeFleetBinary({ resolve, probeVersion: () => "2.1.282", hashFile: () => "f".repeat(64) });
    expect(p).toMatchObject({ platformPackage: "@anthropic-ai/claude-agent-sdk-linux-x64", sha256: "f".repeat(64) });
    expect(probeFleetBinary({ resolve, probeVersion: () => "2.1.282", hash: false }).sha256).toBeNull();
  });

  const manifest = {
    sdkVersion: "0.3.282",
    claudeCodeVersion: "2.1.282",
    platformPackage: "@anthropic-ai/claude-agent-sdk-linux-x64",
    binaryVersion: "2.1.282 (Claude Code)",
    sha256: "a".repeat(64),
    recordedAt: "2026-09-25T00:00:00.000Z",
  };
  const probe = {
    pin: "/x/claude",
    source: "sdk-bundled" as const,
    sha256: "a".repeat(64),
    sdkVersion: "0.3.282",
    platformPackage: "@anthropic-ai/claude-agent-sdk-linux-x64",
  };

  it("ok / mismatch / not-applicable verdicts", () => {
    expect(checkBinaryIntegrity(probe, manifest).kind).toBe("ok");
    expect(checkBinaryIntegrity({ ...probe, sha256: "b".repeat(64) }, manifest)).toMatchObject({ kind: "mismatch" });
    expect(checkBinaryIntegrity(probe, null).kind).toBe("not-applicable");
    expect(checkBinaryIntegrity({ ...probe, source: "override" }, manifest).kind).toBe("not-applicable");
    expect(checkBinaryIntegrity({ ...probe, sdkVersion: "0.3.283" }, manifest).kind).toBe("not-applicable");
    expect(checkBinaryIntegrity({ ...probe, sha256: null }, manifest).kind).toBe("not-applicable");
  });

  it("readBinaryManifest rejects malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbm-"));
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    writeFileSync(good, JSON.stringify(manifest));
    writeFileSync(bad, JSON.stringify({ ...manifest, sha256: "not-hex" }));
    expect(readBinaryManifest(good)?.sha256).toBe("a".repeat(64));
    expect(readBinaryManifest(bad)).toBeNull();
    expect(readBinaryManifest(join(dir, "missing.json"))).toBeNull();
  });
});
