/**
 * Per-agent OS sandbox (bubblewrap) for the v2/SDK spawn path.
 *
 * THREAT MODEL: filesystem confidentiality. Every ClawCode agent runs as the
 * same `clawcode` OS user with `bypassPermissions` + full Bash/Read/Write, so a
 * prompt-injected agent can `cat` another agent's `memories.db`, another agent's
 * `.env` (Discord tokens), `/etc/clawcode/env` (secrets), or any client's PII.
 * The `T-101-08` daemon-side check only guards `file_path` IPC params, NOT raw
 * Bash. This module wraps the spawned `claude` process in a bwrap mount
 * namespace so a non-admin agent sees ONLY its own workspace + the shared
 * infrastructure it needs (sockets, skills, runtimes, MCP deps). Everything
 * else is invisible (deny-by-omission).
 *
 * NOT closed by this layer: the cross-agent IPC forge — the agent still holds
 * the manager socket, so a forged `agent` param can still impersonate; that is
 * the separate capability-token-gate hardening. bwrap = FS isolation only.
 *
 * INTEGRATION: the bind-plan is computed in the daemon at session-config time
 * (where the resolved agent config lives) and frozen into the spawn. It is
 * NON_RELOADABLE — a YAML flip needs `clawcode restart <agent>`. The spawn seam
 * (`detached-spawn.ts`) calls `wrapWithBwrap` just before `spawn()`.
 *
 * ADMIN EXEMPTION: `plan.admin === true` short-circuits to pass-through at the
 * wrapper boundary (belt-and-suspenders with the config-time gate), so the admin
 * agent is NEVER sandboxed even if an operator mis-sets `enabled: true`.
 *
 * Why no `--unshare-net`: agents need outbound network (LLM API, MCP servers),
 * and loopback services such as the daemon's local endpoints must stay reachable.
 * Why no `--unshare-pid` (v1): the orphan-claude-reaper walks host `/proc`; a
 * private PID namespace blinds it. Cleanup is instead guaranteed by
 * `--die-with-parent` + bwrap being the process-group leader (group-kill).
 */

import { existsSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Frozen, per-agent bind-plan. Computed once in the daemon (resolved config has
 * the identity + paths the spawn seam lacks) and carried as a handle-only field.
 * All paths are absolute and already home-expanded.
 */
export interface SandboxBindPlan {
  /** Master switch — when false, `wrapWithBwrap` is a pass-through. */
  readonly enabled: boolean;
  /** Admin agents are never sandboxed (hard exemption at the wrapper). */
  readonly admin: boolean;
  /**
   * Keep the 1Password CLI usable INSIDE the sandbox (the `op` binary is under
   * `/usr`, already RO-bound; this gates whether the fleet vault token stays in
   * the env). Default false → the full-fleet `OP_SERVICE_ACCOUNT_TOKEN` is
   * stripped so a confined agent can't `op read` another client's secrets.
   * MCP op:// env is resolved daemon-side BEFORE spawn, so stripping the token
   * does NOT break MCP servers — only runtime `op read` calls from skills.
   */
  readonly allowRuntimeOp: boolean;
  /** Agent home (`~`) — for the `~/.bun` bind + the shared-`~/.claude` seed source. */
  readonly homeDir: string;
  /**
   * Per-agent writable claude config dir (Phase 145) — the `CLAUDE_CONFIG_DIR`
   * target, RW-bound. claude `mkdir`s ~30 scratch subdirs (`session-env`,
   * `shell-snapshots`, `projects`, …) under this dir; making it writable + per-
   * agent restores Bash/Glob AND isolates session transcripts (an agent can no
   * longer read another's `projects/`). The shared `~/.claude` is NOT bound; the
   * narrow read-set (auth/settings) is seeded into this dir instead. Stable per
   * agent across restarts so the daemon's transcript-resume keeps working.
   */
  readonly claudeConfigDir: string;
  /** Agent workspace — RW (covers memories.db, inbox/, generated-images/, …). */
  readonly workspace: string;
  /** Memory root — RW; emitted only when distinct from `workspace`. */
  readonly memoryPath: string;
  /** Per-agent channel state dir (`~/.clawcode/channels-state/<agent>/`) — RW. */
  readonly channelsStateDir: string;
  /** Shared manager IPC socket file — RW bind. */
  readonly managerSock: string;
  /** Shared MCP broker socket file — RW bind. */
  readonly brokerSock: string;
  /** Fleet-wide skills dir — RO. */
  readonly skillsPath: string;
  /** Operator-granted cross-workspace read ACL paths — RO. */
  readonly fileAccessRO: readonly string[];
  /** Directories the agent's MCP server children need (discovered) — RO. */
  readonly mcpDepPathsRO: readonly string[];
}

/** Minimal shape of a resolved MCP server entry for dependency discovery. */
export interface McpServerLike {
  readonly command?: string;
  readonly args?: readonly string[];
}

// `pyvenv.cfg` marks a Python venv ROOT. Without it, an MCP server launched as
// `<venv>/bin/python <script>` binds only `<venv>/bin` (the command's own dir),
// leaving `<venv>/lib/site-packages` unbound → `import mcp` fails inside the
// sandbox → the server can't handshake → warm-path crash-loop. Matching it makes
// the walk-up resolve the command to the venv root, binding `lib/` too. (Proven
// on prod: brave-search/browserless + all fin python MCP servers use this venv.)
const PROJECT_ROOT_MARKERS = ["node_modules", "package.json", ".git", "venv", ".venv", "pyvenv.cfg"] as const;
/** Cap the walk-up so a dep under `/home/x/clawd/projects/y` never binds `/home`. */
const MAX_ROOT_WALK = 3;

function isAbsExisting(p: string | undefined): p is string {
  return typeof p === "string" && p.startsWith("/") && existsSync(p);
}

/**
 * Given a file/dir path an MCP server touches, return the directory to bind RO:
 * the nearest ancestor (within {@link MAX_ROOT_WALK} levels) that holds a
 * project-root marker (so the server's `node_modules` / venv resolve), else the
 * path's own directory.
 */
function depDirForPath(p: string): string {
  let dir = isAbsExisting(p) && statSync(p).isDirectory() ? p : dirname(p);
  let candidate = dir;
  for (let i = 0; i < MAX_ROOT_WALK; i++) {
    if (PROJECT_ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) {
      candidate = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir || parent === "/" || parent === "/home") break;
    dir = parent;
  }
  return candidate;
}

/**
 * Discover the read-only directories an agent's MCP server children must see
 * inside the sandbox. Parses the RESOLVED MCP set (commands + args), not the raw
 * YAML — so op://example-vault-2 env + plugin roots are already concrete. Bare-name
 * commands (`node`, `npx`, `python3`, `bun`) resolve via the host PATH (always
 * bound via `/usr` + `~/.bun`), so only ABSOLUTE command/arg paths add a bind.
 *
 * Daemon-side build helper (does FS existence checks); the returned list is
 * frozen into the plan. De-duplicated + sorted for stable test output.
 */
export function discoverMcpDepPaths(servers: readonly McpServerLike[]): string[] {
  const out = new Set<string>();
  for (const s of servers) {
    if (isAbsExisting(s.command)) out.add(depDirForPath(s.command));
    for (const arg of s.args ?? []) {
      if (isAbsExisting(arg)) out.add(depDirForPath(arg));
    }
  }
  return [...out].sort();
}

/** Push a `--<flag> SRC DEST` triple (same src+dest — identity mount). */
function mount(into: string[], flag: string, path: string): void {
  into.push(flag, path, path);
}

/**
 * Read-set seeded into the per-agent `claudeConfigDir` by **RO-bind** (Phase
 * 145): the file is bound read-only from the shared `~/.claude`, so claude reads
 * it but cannot write it. `.credentials.json` stays here — OAuth refresh remains
 * host-owned (matching the pre-145 whole-RO behavior); a per-agent *copy* would
 * let N agents rotate one account's refresh token against each other.
 * `plugins/` is read-only config (claude reads it; never needs runtime writes).
 * All entries use `--ro-bind-try`, so a missing source is a no-op.
 */
export const CLAUDE_CONFIG_RO_SEED = [".credentials.json", "plugins"] as const;

/**
 * Read-set seeded into the per-agent `claudeConfigDir` by **copy-if-absent**
 * (Phase 145): claude rewrites these in place (settings migration / MRU), and an
 * RO-bind would `EBUSY` on the atomic `.tmp`+`rename()` over a bind mountpoint
 * (verified on clawdy). Copying once preserves claude's own edits across
 * restarts. Done by {@link seedClaudeConfigDir} before the spawn.
 */
export const CLAUDE_CONFIG_COPY_SEED = ["settings.json", "settings.local.json"] as const;

/**
 * Translate a {@link SandboxBindPlan} into the bwrap argv (the part BEFORE the
 * `--` separator). Pure — all FS discovery already happened in the plan.
 *
 * Bind ordering matters: broad RO system first, then RW overlays (a later bind
 * shadows an earlier RO mount for the same subtree — e.g. `~/.claude` RO then
 * `~/.claude/projects` RW for session transcripts).
 */
export function buildBindArgs(plan: SandboxBindPlan): string[] {
  const a: string[] = [];

  // --- isolation primitives (keep net for outbound access and local services; keep
  // host PID ns so the orphan-reaper backstop still works) ---
  // Deliberately NO `--new-session`: with no `--unshare-pid`, the daemon's
  // shutdown `process.kill(-bwrapPid)` group-kill is the RELIABLE reaper for the
  // inner claude + its MCP grandchildren (they inherit bwrap's process group).
  // `--new-session` would setsid the inner tree into a separate pgrp, so only the
  // fragile `--die-with-parent` pdeathsig cascade would reach the grandchildren —
  // the exact fragility the orphan-reaper exists to backstop. Its sole benefit
  // (TIOCSTI/tty-injection hardening) is moot here: `detached: true` + pipe stdio
  // means the sandbox has no controlling terminal to inject into.
  a.push(
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
  );

  // --- RO system (usrmerge: Ubuntu 25.04) ---
  mount(a, "--ro-bind", "/usr");
  a.push(
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/sbin", "/sbin",
  );
  mount(a, "--ro-bind-try", "/etc/ssl");
  mount(a, "--ro-bind-try", "/etc/resolv.conf");
  mount(a, "--ro-bind-try", "/etc/ca-certificates");
  mount(a, "--ro-bind-try", "/etc/alternatives");
  mount(a, "--ro-bind-try", "/etc/nsswitch.conf");

  // --- RO runtime (claude-pin, dist/channels hooks, mcp-shim; bun) ---
  mount(a, "--ro-bind", "/opt/clawcode");
  mount(a, "--ro-bind-try", join(plan.homeDir, ".bun"));
  mount(a, "--ro-bind-try", join(plan.homeDir, ".npm"));

  // --- per-agent claude config dir (Phase 145) ---
  // The shared `~/.claude` is deliberately NOT bound. `CLAUDE_CONFIG_DIR` (set
  // in applySandboxEnv) points claude's ~30 writable scratch subdirs
  // (session-env, shell-snapshots, …) AND its session transcripts (projects/)
  // at THIS per-agent dir → Bash/Glob work AND no agent can read another's
  // transcripts (closes the pre-145 whole-RO read leak this block used to admit).
  // The narrow read-set is seeded into the dir: settings.* copied in (writable —
  // seedClaudeConfigDir), .credentials.json + plugins/ RO-bound on top (auth
  // stays host-owned). RW dir first, then the RO file-binds shadow it (a later
  // bind shadows an earlier mount of the same subtree).
  mount(a, "--bind", plan.claudeConfigDir);
  const sharedClaude = join(plan.homeDir, ".claude");
  for (const name of CLAUDE_CONFIG_RO_SEED) {
    // non-identity: shared source → per-agent destination inside the config dir
    a.push("--ro-bind-try", join(sharedClaude, name), join(plan.claudeConfigDir, name));
  }

  // --- RW agent state ---
  mount(a, "--bind", plan.workspace);
  if (plan.memoryPath && plan.memoryPath !== plan.workspace) {
    mount(a, "--bind", plan.memoryPath);
  }
  mount(a, "--bind-try", plan.channelsStateDir);

  // --- IPC sockets (file binds — their parent dir is NOT otherwise mounted,
  // so deny-by-omission hides the rest of ~/.clawcode/manager) ---
  mount(a, "--bind", plan.managerSock);
  mount(a, "--bind-try", plan.brokerSock);

  // --- RO shared: skills, fileAccess ACL, MCP dep dirs ---
  mount(a, "--ro-bind-try", plan.skillsPath);
  for (const p of plan.fileAccessRO) mount(a, "--ro-bind-try", p);
  for (const p of plan.mcpDepPathsRO) mount(a, "--ro-bind-try", p);

  // --- pseudo-fs ---
  a.push("--proc", "/proc");
  a.push("--dev", "/dev");
  a.push("--tmpfs", "/tmp");

  return a;
}

/**
 * Wrap a spawn command/args in bwrap per the plan. Returns the ORIGINAL command
 * unchanged when sandboxing is off, no plan was threaded, or the agent is admin
 * (the hard exemption). Otherwise returns `bwrap <binds> -- <command> <args>`.
 *
 * Pure + side-effect-free — safe to unit test and to call on every (re-)spawn.
 */
export function wrapWithBwrap(
  command: string,
  args: readonly string[],
  plan: SandboxBindPlan | undefined,
): { command: string; args: string[] } {
  if (!isActive(plan)) {
    return { command, args: [...args] };
  }
  return {
    command: "bwrap",
    args: [...buildBindArgs(plan), "--", command, ...args],
  };
}

/** True when the plan should actually confine the spawn (enabled, non-admin). */
export function isActive(plan: SandboxBindPlan | undefined): plan is SandboxBindPlan {
  return Boolean(plan && plan.enabled && !plan.admin);
}

/**
 * Fleet-wide secrets stripped from a sandboxed agent's env unless it opted into
 * `allowRuntimeOp`. `OP_SERVICE_ACCOUNT_TOKEN` can read the ENTIRE 1Password
 * vault (every client's secrets), so leaving it in the env of a confined,
 * prompt-injectable agent would undercut the FS isolation.
 */
export const SANDBOX_STRIPPED_ENV_KEYS = [
  "OP_SERVICE_ACCOUNT_TOKEN",
  "ACME_OP_TOKEN",
] as const;

/**
 * Return the env a sandboxed agent's `claude` process should spawn with:
 *   - `CLAUDE_CONFIG_DIR` pointed at the per-agent config dir (Phase 145) so all
 *     of claude's scratch + transcripts land in the RW-bound, isolated dir, AND
 *   - the fleet vault tokens removed (unless `allowRuntimeOp`).
 * Returns the SAME object reference for the non-sandboxed fleet (pass-through =
 * byte-identical env). Never mutates the input. An ACTIVE sandbox always returns
 * a copy (it must set `CLAUDE_CONFIG_DIR`), even with `allowRuntimeOp`.
 */
export function applySandboxEnv(
  env: NodeJS.ProcessEnv,
  plan: SandboxBindPlan | undefined,
): NodeJS.ProcessEnv {
  if (!isActive(plan)) return env;
  const copy: NodeJS.ProcessEnv = { ...env, CLAUDE_CONFIG_DIR: plan.claudeConfigDir };
  if (!plan.allowRuntimeOp) {
    for (const k of SANDBOX_STRIPPED_ENV_KEYS) delete copy[k];
  }
  return copy;
}

/**
 * Ensure the per-agent claude config dir exists and is seeded with the
 * copy-set BEFORE the sandboxed spawn. Idempotent + best-effort:
 *   - `mkdir -p` the dir (mode 0700 — it holds the agent's transcripts/auth view),
 *   - copy {@link CLAUDE_CONFIG_COPY_SEED} (settings.*) from the shared
 *     `~/.claude` IF ABSENT (claude rewrites these in place; copy-once preserves
 *     its edits and avoids the RO-bind atomic-rename `EBUSY`).
 * `.credentials.json`/`plugins/` are NOT copied — they are RO-bound in
 * {@link buildBindArgs} so auth stays host-owned. No-op when the plan is not
 * active (non-sandboxed / admin). Call once per (re-)spawn from the spawn seam.
 */
export function seedClaudeConfigDir(plan: SandboxBindPlan | undefined): void {
  if (!isActive(plan)) return;
  mkdirSync(plan.claudeConfigDir, { recursive: true, mode: 0o700 });
  const sharedClaude = join(plan.homeDir, ".claude");
  for (const name of CLAUDE_CONFIG_COPY_SEED) {
    const src = join(sharedClaude, name);
    const dest = join(plan.claudeConfigDir, name);
    if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
  }
}
