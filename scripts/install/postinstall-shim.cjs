#!/usr/bin/env node
// Phase 110 Stage 0b — npm postinstall hook.
// Selects the correct prebuilt clawcode-mcp-shim binary for the host arch
// and copies it to node_modules/.bin/clawcode-mcp-shim so it's on $PATH for
// child processes spawned by the daemon.
//
// Mirrors the better-sqlite3 prebuild-install pattern (locked decision in
// .planning/phases/110-mcp-memory-reduction-shim-runtime-swap/110-CONTEXT.md).
// Fails LOUD on unsupported arch — no silent skip, per the global fail-loud
// policy (CONTEXT.md Rollout Policy: "Fail loud, NO auto-fall-back").

"use strict";
const fs = require("fs");
const path = require("path");

// platform-arch (Node naming) → prebuild directory (GOOS-GOARCH naming).
// Keep linux-x64 and linux-arm64 supported per Wave 1 distribution scope.
// Darwin / Windows intentionally absent: fail-loud with a clear message.
const SUPPORTED = {
  "linux-x64": "linux-amd64",
  "linux-arm64": "linux-arm64",
};

function selectPrebuild(platform, arch) {
  const key = `${platform}-${arch}`;
  const dir = SUPPORTED[key];
  if (!dir) {
    const supportedKeys = Object.keys(SUPPORTED).join(", ");
    throw new Error(
      `clawcode-mcp-shim: no prebuilt binary for ${key}. ` +
        `Supported: ${supportedKeys}. ` +
        `Build from source via 'go build ./cmd/clawcode-mcp-shim' or open an issue.`,
    );
  }
  return path.join("prebuilds", dir, "clawcode-mcp-shim");
}

function install(opts) {
  const pkgRoot = opts && opts.pkgRoot;
  const target = opts && opts.target;
  const platform = (opts && opts.platform) || process.platform;
  const arch = (opts && opts.arch) || process.arch;

  if (!pkgRoot || !target) {
    throw new Error("clawcode-mcp-shim: install() requires { pkgRoot, target }");
  }

  const relPrebuild = selectPrebuild(platform, arch);
  const src = path.join(pkgRoot, relPrebuild);
  if (!fs.existsSync(src)) {
    throw new Error(
      `clawcode-mcp-shim: prebuild missing at ${src} — npm package is corrupt or built without Go shim. ` +
        `Re-run npm publish from a clean Go-build CI.`,
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(src, target);
  fs.chmodSync(target, 0o755);
  return target;
}

function runMain(opts) {
  // pkgRoot = the directory containing this package's package.json.
  // __dirname is .../<pkg>/scripts/install, so go up two levels.
  const pkgRoot = (opts && opts.pkgRoot) || path.resolve(__dirname, "..", "..");
  const target =
    (opts && opts.target) || path.join(pkgRoot, "node_modules", ".bin", "clawcode-mcp-shim");
  const log = (opts && opts.log) || console.log;
  const errlog = (opts && opts.errlog) || console.error;

  // Dev / source-checkout / pre-Wave-2 install: prebuilds/ was never bundled.
  // This is NOT the operator-install case the plan locked fail-loud for; it's
  // a developer running `npm ci` in the source repo before the npm-publish
  // workflow has bundled binaries. Skip with a visible notice (NOT silent).
  // See 110-03 deviation Rule 3 in SUMMARY.md.
  const prebuildsDir = (opts && opts.prebuildsDir) || path.join(pkgRoot, "prebuilds");
  if (!fs.existsSync(prebuildsDir)) {
    log(
      "clawcode-mcp-shim postinstall: prebuilds/ not present — skipping " +
        "(source checkout or pre-Wave-2 install). " +
        "Operator installs from npm bundle binaries via go-build + npm-publish CI.",
    );
    return { skipped: true, target: null };
  }

  try {
    install({ pkgRoot, target });
    log(`clawcode-mcp-shim: installed binary at ${target}`);
    return { skipped: false, target };
  } catch (err) {
    errlog(`clawcode-mcp-shim postinstall FAILED: ${err && err.message ? err.message : err}`);
    throw err;
  }
}

if (require.main === module) {
  try {
    runMain();
  } catch (_err) {
    process.exit(1);
  }
}

module.exports = { selectPrebuild, install, runMain, SUPPORTED };
