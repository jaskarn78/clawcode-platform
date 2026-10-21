#!/usr/bin/env node
/*
 * Supply-chain age guard for npm packages.
 *
 * Catches new or upgraded entries in package-lock.json whose published-to-
 * npm timestamp is below MIN_AGE_DAYS (default 7d). The standing threat:
 * compromised maintainer credentials → malicious version published →
 * downstream consumers install it within minutes. A cooldown window lets
 * the wider community detect + yank before our deploys pick it up.
 *
 * Strategy:
 *   1. Parse current package-lock.json (lockfileVersion 2/3 `packages` map).
 *   2. Parse the comparison base's lockfile (default HEAD; deploy passes
 *      HEAD~1 since the change was already committed).
 *   3. For every (name, version) pair present in current but NOT in base,
 *      call `npm view name@version time.version` and check age.
 *   4. Block (exit 1) if any added entry is younger than MIN_AGE_DAYS,
 *      unless ALLOW_FRESH_DEPS=1.
 *
 * Bootstrap-safe: no new npm dependencies. Pure Node stdlib + spawned
 * `git` and `npm`. This script itself ages with the repo — no install
 * step that could violate the policy it enforces.
 *
 * Usage:
 *   node scripts/check-deps-age.cjs                 # compare WT vs HEAD
 *   node scripts/check-deps-age.cjs --base HEAD~1   # compare WT vs HEAD~1
 *   MIN_AGE_DAYS=14 node scripts/check-deps-age.cjs
 *   ALLOW_FRESH_DEPS=1 node scripts/check-deps-age.cjs  # emergency override
 *
 * SCOPED ALLOWLIST (Phase 999.169): `scripts/deps-age-allow.json` lists exact
 * `name@version` entries an operator approved as fresh, each with a reason and an
 * `expires` timestamp. An unexpired exact match passes the age check; everything
 * else is judged as before. Unlike ALLOW_FRESH_DEPS this cannot wave through a
 * package nobody named, and it lapses on its own. Path override: DEPS_AGE_ALLOWLIST.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS ?? 7);
const OVERRIDE = process.env.ALLOW_FRESH_DEPS === "1";
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const ALLOWLIST_PATH = process.env.DEPS_AGE_ALLOWLIST ?? "scripts/deps-age-allow.json";

/**
 * Parse the allowlist into Map("name@version" → {reason, expires}), keeping only
 * well-formed, unexpired entries. A missing file is an empty list; a malformed
 * file throws (a broken allowlist must not silently widen or narrow the guard).
 */
function parseAllowlist(json, nowMs) {
  const out = new Map();
  if (json === null) return out;
  const doc = JSON.parse(json);
  const entries = Array.isArray(doc && doc.entries) ? doc.entries : [];
  for (const e of entries) {
    if (!e || typeof e.package !== "string" || typeof e.expires !== "string" || typeof e.reason !== "string") {
      throw new Error(`deps-age allowlist: malformed entry ${JSON.stringify(e)}`);
    }
    const exp = Date.parse(e.expires);
    if (Number.isNaN(exp)) throw new Error(`deps-age allowlist: bad expires for ${e.package}`);
    if (exp > nowMs) out.set(e.package, { reason: e.reason, expires: e.expires });
  }
  return out;
}

function readAllowlist() {
  try {
    return fs.readFileSync(ALLOWLIST_PATH, "utf8");
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { base: "HEAD" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) {
      args.base = argv[i + 1];
      i++;
    }
  }
  return args;
}

function gitShow(ref, path) {
  const r = spawnSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout;
}

function readCurrent() {
  try {
    return fs.readFileSync("package-lock.json", "utf8");
  } catch {
    return null;
  }
}

// Parse lockfileVersion 2/3 `packages` map → Map("name@version" → true).
// Excludes the root entry and anything without a version string.
function lockToVersionSet(lockContent) {
  const set = new Map();
  if (!lockContent) return set;
  let obj;
  try {
    obj = JSON.parse(lockContent);
  } catch {
    return set;
  }
  if (!obj.packages || typeof obj.packages !== "object") return set;
  for (const [key, val] of Object.entries(obj.packages)) {
    if (key === "" || !val || typeof val !== "object") continue;
    if (!val.version) continue;
    // Extract the package name from the deepest "node_modules/<name>"
    // segment. Scoped packages: "node_modules/@scope/pkg".
    const m = key.match(/(?:^|.*\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (!m) continue;
    set.set(`${m[1]}@${val.version}`, true);
  }
  return set;
}

// Cache: pkg name → time map (avoid re-fetching for multiple versions of same pkg).
const timeCache = new Map();

function getTimeMap(name) {
  if (timeCache.has(name)) return timeCache.get(name);
  // `npm view <pkg> time --json` returns the full publish-time map. We
  // can't use `time.<version>` dot-syntax because version keys contain
  // dots (e.g. "1.2.3") which npm's path-walker mis-traverses.
  const r = spawnSync("npm", ["view", name, "time", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0 || !r.stdout) {
    timeCache.set(name, null);
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(r.stdout);
  } catch {
    timeCache.set(name, null);
    return null;
  }
  if (!obj || typeof obj !== "object") {
    timeCache.set(name, null);
    return null;
  }
  timeCache.set(name, obj);
  return obj;
}

function publishDate(name, version) {
  const map = getTimeMap(name);
  if (!map) return null;
  const iso = map[version];
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function main() {
  const { base } = parseArgs(process.argv);
  const current = readCurrent();
  if (!current) {
    console.log("check-deps-age: no package-lock.json — skip");
    return 0;
  }

  const previous = gitShow(base, "package-lock.json");
  if (previous === null) {
    console.log(
      `check-deps-age: no package-lock.json at ${base} (first commit / lockfile newly tracked) — skip`,
    );
    return 0;
  }

  const cur = lockToVersionSet(current);
  const prev = lockToVersionSet(previous);

  const added = [];
  for (const key of cur.keys()) {
    if (!prev.has(key)) added.push(key);
  }

  if (added.length === 0) {
    console.log("check-deps-age: no new or upgraded packages — OK");
    return 0;
  }

  console.log(
    `check-deps-age: ${added.length} new/upgraded package(s) vs ${base}; threshold ${MIN_AGE_DAYS}d`,
  );
  const allowlist = parseAllowlist(readAllowlist(), Date.now());
  if (allowlist.size > 0) {
    console.log(`check-deps-age: ${allowlist.size} unexpired allowlist entr${allowlist.size === 1 ? "y" : "ies"} (${ALLOWLIST_PATH})`);
  }

  const tooNew = [];
  const unknown = [];
  for (const entry of added) {
    // Split on the LAST "@" so scoped packages parse correctly:
    //   "@scope/pkg@1.2.3" → name="@scope/pkg", version="1.2.3"
    const at = entry.lastIndexOf("@");
    if (at <= 0) continue;
    const name = entry.slice(0, at);
    const version = entry.slice(at + 1);

    const d = publishDate(name, version);
    if (!d) {
      unknown.push(entry);
      console.log(`  ? ${entry} — could not determine publish date`);
      continue;
    }
    const ageMs = Date.now() - d.getTime();
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const allowed = allowlist.get(entry);
    if (ageMs < MIN_AGE_MS && allowed) {
      console.log(
        `  ✓ ${entry} — ${ageDays}d old, ALLOWLISTED until ${allowed.expires} (${allowed.reason})`,
      );
    } else if (ageMs < MIN_AGE_MS) {
      tooNew.push({ entry, ageDays, publishedAt: d.toISOString() });
      console.log(
        `  ✗ ${entry} — ${ageDays}d old (published ${d.toISOString().slice(0, 10)})`,
      );
    } else {
      console.log(`  ✓ ${entry} — ${ageDays}d old`);
    }
  }

  if (tooNew.length === 0 && unknown.length === 0) {
    console.log("check-deps-age: all new packages meet age threshold");
    return 0;
  }

  if (OVERRIDE) {
    console.log(
      `\ncheck-deps-age: ${tooNew.length} below-threshold + ${unknown.length} unknown — ALLOW_FRESH_DEPS=1 set, proceeding`,
    );
    return 0;
  }

  if (tooNew.length > 0) {
    console.log(
      `\ncheck-deps-age: BLOCKED — ${tooNew.length} package(s) below the ${MIN_AGE_DAYS}-day age threshold.`,
    );
    console.log(
      "Wait for the packages to age, pin to an older version, or override with ALLOW_FRESH_DEPS=1 if you understand the supply-chain risk.",
    );
    return 1;
  }
  // Only unknowns — fail closed (security-first; the network failure could
  // mask a fresh malicious pkg). Override path is documented.
  console.log(
    `\ncheck-deps-age: BLOCKED — ${unknown.length} package(s) could not be age-verified (network / npm registry failure).`,
  );
  console.log(
    "Re-run when the registry is reachable, or override with ALLOW_FRESH_DEPS=1.",
  );
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { parseAllowlist, lockToVersionSet };
