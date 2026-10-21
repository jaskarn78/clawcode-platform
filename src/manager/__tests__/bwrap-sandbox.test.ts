import { describe, it, expect } from "vitest";
import { execPath } from "node:process";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  wrapWithBwrap,
  buildBindArgs,
  applySandboxEnv,
  seedClaudeConfigDir,
  isActive,
  discoverMcpDepPaths,
  SANDBOX_STRIPPED_ENV_KEYS,
  type SandboxBindPlan,
} from "../bwrap-sandbox.js";
import { isClaudeProcessCmdline } from "../../mcp/orphan-claude-reaper.js";

function plan(overrides: Partial<SandboxBindPlan> = {}): SandboxBindPlan {
  return {
    enabled: true,
    admin: false,
    allowRuntimeOp: false,
    homeDir: "/home/clawcode",
    claudeConfigDir: "/home/clawcode/.clawcode/agents/personal/claude-config",
    workspace: "/home/clawcode/.clawcode/agents/personal",
    memoryPath: "/home/clawcode/.clawcode/agents/personal",
    channelsStateDir: "/home/clawcode/.clawcode/channels-state/personal",
    managerSock: "/home/clawcode/.clawcode/manager/clawcode.sock",
    brokerSock: "/home/clawcode/.clawcode/manager/mcp-broker.sock",
    skillsPath: "/home/clawcode/.clawcode/skills",
    fileAccessRO: [],
    mcpDepPathsRO: [],
    ...overrides,
  };
}

describe("wrapWithBwrap — pass-through guarantees", () => {
  it("passes through when plan is undefined (non-sandboxed fleet)", () => {
    const r = wrapWithBwrap("/opt/clawcode/claude-pin/claude", ["--model", "opus"], undefined);
    expect(r).toEqual({ command: "/opt/clawcode/claude-pin/claude", args: ["--model", "opus"] });
  });

  it("passes through when sandbox.enabled is false", () => {
    const r = wrapWithBwrap("claude", ["a"], plan({ enabled: false }));
    expect(r.command).toBe("claude");
    expect(r.args).toEqual(["a"]);
  });

  it("passes through for admin agents even when enabled (hard exemption)", () => {
    const r = wrapWithBwrap("claude", ["a"], plan({ admin: true }));
    expect(r.command).toBe("claude");
    expect(r.args).toEqual(["a"]);
  });

  it("wraps the command in bwrap when enabled + non-admin", () => {
    const r = wrapWithBwrap("/opt/clawcode/claude-pin/claude", ["--model", "opus"], plan());
    expect(r.command).toBe("bwrap");
    // original command + args land AFTER the `--` separator, in order
    const sep = r.args.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(r.args.slice(sep + 1)).toEqual(["/opt/clawcode/claude-pin/claude", "--model", "opus"]);
  });
});

describe("buildBindArgs — bind-set correctness", () => {
  const args = buildBindArgs(plan({
    fileAccessRO: ["/shared/docs"],
    mcpDepPathsRO: ["/home/example-user/clawd/mcp-servers/finnhub"],
  }));
  const joined = args.join(" ");

  it("keeps the host network namespace (agents need outbound network)", () => {
    expect(args).not.toContain("--unshare-net");
  });

  it("does NOT unshare PID in v1 (keep the /proc orphan-reaper backstop)", () => {
    expect(args).not.toContain("--unshare-pid");
  });

  it("does NOT use --new-session (preserve direct group-kill of MCP grandchildren)", () => {
    // With no --unshare-pid, the inner claude + MCP children must stay in bwrap's
    // process group so the daemon's `process.kill(-bwrapPid)` reaps them directly.
    // --new-session would setsid them into a separate pgrp → only the fragile
    // die-with-parent cascade would reach grandchildren. No tty → no TIOCSTI loss.
    expect(args).not.toContain("--new-session");
  });

  it("ties the sandbox lifetime to the daemon", () => {
    expect(args).toContain("--die-with-parent");
  });

  it("binds the workspace read-write", () => {
    expect(joined).toContain("--bind /home/clawcode/.clawcode/agents/personal /home/clawcode/.clawcode/agents/personal");
  });

  it("binds the manager IPC socket (so file/memory IPC keeps working)", () => {
    expect(joined).toContain("--bind /home/clawcode/.clawcode/manager/clawcode.sock");
  });

  it("binds skills + fileAccess + MCP deps read-only", () => {
    expect(joined).toContain("--ro-bind-try /home/clawcode/.clawcode/skills");
    expect(joined).toContain("--ro-bind-try /shared/docs");
    expect(joined).toContain("--ro-bind-try /home/example-user/clawd/mcp-servers/finnhub");
  });

  it("does NOT bind /etc/clawcode (secrets) or other agents (deny-by-omission)", () => {
    expect(joined).not.toContain("/etc/clawcode/env");
    expect(joined).not.toContain("/etc/clawcode/clawcode.yaml");
  });

  it("emits the workspace bind once when memoryPath === workspace", () => {
    const a = buildBindArgs(plan());
    const occ = a.join(" ").split("--bind /home/clawcode/.clawcode/agents/personal /home/clawcode/.clawcode/agents/personal").length - 1;
    expect(occ).toBe(1);
  });

  it("emits a distinct memoryPath bind when separate", () => {
    const a = buildBindArgs(plan({ memoryPath: "/home/clawcode/.clawcode/agents/acme/memory/fin-client" }));
    expect(a.join(" ")).toContain("--bind /home/clawcode/.clawcode/agents/acme/memory/fin-client");
  });

  it("RW-binds the per-agent claude config dir (Phase 145 — restores Bash/Glob scratch)", () => {
    expect(joined).toContain(
      "--bind /home/clawcode/.clawcode/agents/personal/claude-config /home/clawcode/.clawcode/agents/personal/claude-config",
    );
  });

  it("RO-binds .credentials.json from shared ~/.claude INTO the per-agent config dir (non-identity; auth host-owned)", () => {
    expect(joined).toContain(
      "--ro-bind-try /home/clawcode/.claude/.credentials.json /home/clawcode/.clawcode/agents/personal/claude-config/.credentials.json",
    );
  });

  it("does NOT bind the shared ~/.claude or its projects/ (Phase 145 — closes the cross-agent transcript-read leak)", () => {
    // the old whole-RO identity bind + projects RW overlay must be gone
    expect(joined).not.toContain("--ro-bind-try /home/clawcode/.claude /home/clawcode/.claude");
    expect(joined).not.toContain("/home/clawcode/.claude/projects");
  });

  it("does NOT copy-seed settings via a bind (settings.json is copied, never bound — RO-bind would EBUSY)", () => {
    // settings.* must NOT appear as a bind arg; seedClaudeConfigDir copies them.
    expect(joined).not.toContain("/.claude/settings.json");
  });
});

describe("applySandboxEnv — fleet vault-token stripping", () => {
  const baseEnv = { PATH: "/usr/bin", OP_SERVICE_ACCOUNT_TOKEN: "secret", ACME_OP_TOKEN: "secret2", https_proxy: "http://127.0.0.1:1" };

  it("returns the same reference when sandbox inactive (byte-identical fleet)", () => {
    expect(applySandboxEnv(baseEnv, undefined)).toBe(baseEnv);
    expect(applySandboxEnv(baseEnv, plan({ enabled: false }))).toBe(baseEnv);
    expect(applySandboxEnv(baseEnv, plan({ admin: true }))).toBe(baseEnv);
  });

  it("keeps the vault token when allowRuntimeOp is set, but still sets CLAUDE_CONFIG_DIR (copy, not same ref)", () => {
    const r = applySandboxEnv(baseEnv, plan({ allowRuntimeOp: true }));
    expect(r).not.toBe(baseEnv); // active sandbox must return a copy (sets config dir)
    expect(r.OP_SERVICE_ACCOUNT_TOKEN).toBe("secret"); // token preserved (opted in)
    expect(r.CLAUDE_CONFIG_DIR).toBe("/home/clawcode/.clawcode/agents/personal/claude-config");
  });

  it("strips the vault tokens AND sets CLAUDE_CONFIG_DIR for an active non-allowRuntimeOp sandbox", () => {
    const r = applySandboxEnv(baseEnv, plan());
    for (const k of SANDBOX_STRIPPED_ENV_KEYS) expect(r[k]).toBeUndefined();
    expect(r.https_proxy).toBe("http://127.0.0.1:1"); // proxy preserved
    expect(r.PATH).toBe("/usr/bin");
    expect(r.CLAUDE_CONFIG_DIR).toBe("/home/clawcode/.clawcode/agents/personal/claude-config"); // Phase 145
  });

  it("does NOT set CLAUDE_CONFIG_DIR for the non-sandboxed fleet (byte-identical env)", () => {
    expect(applySandboxEnv(baseEnv, undefined).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(applySandboxEnv(baseEnv, plan({ enabled: false })).CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("never mutates the input env", () => {
    applySandboxEnv(baseEnv, plan());
    expect(baseEnv.OP_SERVICE_ACCOUNT_TOKEN).toBe("secret");
    expect(baseEnv).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });
});

describe("isActive", () => {
  it("is true only for enabled, non-admin plans", () => {
    expect(isActive(undefined)).toBe(false);
    expect(isActive(plan({ enabled: false }))).toBe(false);
    expect(isActive(plan({ admin: true }))).toBe(false);
    expect(isActive(plan())).toBe(true);
  });
});

describe("discoverMcpDepPaths", () => {
  it("ignores bare-name interpreters (resolved via PATH / /usr)", () => {
    expect(discoverMcpDepPaths([{ command: "node", args: ["mcp-server-mysql"] }])).toEqual([]);
    expect(discoverMcpDepPaths([{ command: "npx", args: ["-y", "some-pkg"] }])).toEqual([]);
  });

  it("binds the containing dir of an absolute existing script", () => {
    // execPath (the node binary) is an absolute existing path → its dir is bound
    const deps = discoverMcpDepPaths([{ command: "node", args: [execPath] }]);
    expect(deps.length).toBeGreaterThan(0);
    expect(execPath.startsWith(deps[0]!) || deps[0] === dirname(execPath)).toBe(true);
  });

  it("resolves a venv python command to the venv ROOT (pyvenv.cfg marker), not just bin/", () => {
    // Regression for the prod bind gap: a `<venv>/bin/python <script>` MCP server
    // must bind `<venv>` so `<venv>/lib/site-packages` (where `mcp` lives) is
    // visible inside the sandbox — binding only `<venv>/bin` → ModuleNotFoundError.
    const venv = mkdtempSync(join(tmpdir(), "clawcode-venv-"));
    try {
      mkdirSync(join(venv, "bin"), { recursive: true });
      writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\n");
      writeFileSync(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
      mkdirSync(join(venv, "lib", "python3.13", "site-packages"), { recursive: true });
      const deps = discoverMcpDepPaths([{ command: join(venv, "bin", "python"), args: [] }]);
      expect(deps).toContain(venv); // venv root → covers lib/site-packages
      expect(deps).not.toContain(join(venv, "bin")); // NOT just the command's own dir
    } finally {
      rmSync(venv, { recursive: true, force: true });
    }
  });
});

describe("seedClaudeConfigDir — per-agent config dir prep (Phase 145)", () => {
  it("mkdirs the config dir and copy-seeds settings.* but NOT creds (creds are RO-bound)", () => {
    const root = mkdtempSync(join(tmpdir(), "clawcode-seed-"));
    try {
      const home = join(root, "home");
      const shared = join(home, ".claude");
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, "settings.json"), "SETTINGS");
      writeFileSync(join(shared, "settings.local.json"), "LOCAL");
      writeFileSync(join(shared, ".credentials.json"), "CREDS");
      const cfgDir = join(home, ".clawcode", "agents", "personal", "claude-config");
      seedClaudeConfigDir(plan({ homeDir: home, claudeConfigDir: cfgDir }));
      expect(existsSync(cfgDir)).toBe(true);
      // settings copied in as writable files (claude can rewrite them)
      expect(readFileSync(join(cfgDir, "settings.json"), "utf8")).toBe("SETTINGS");
      expect(readFileSync(join(cfgDir, "settings.local.json"), "utf8")).toBe("LOCAL");
      // creds NOT copied — RO-bound at spawn so host owns OAuth refresh
      expect(existsSync(join(cfgDir, ".credentials.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT overwrite an existing (claude-rewritten) settings.json (copy-if-absent)", () => {
    const root = mkdtempSync(join(tmpdir(), "clawcode-seed-"));
    try {
      const home = join(root, "home");
      const shared = join(home, ".claude");
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, "settings.json"), "SHARED");
      const cfgDir = join(home, ".clawcode", "agents", "personal", "claude-config");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "settings.json"), "AGENT-EDITED");
      seedClaudeConfigDir(plan({ homeDir: home, claudeConfigDir: cfgDir }));
      expect(readFileSync(join(cfgDir, "settings.json"), "utf8")).toBe("AGENT-EDITED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("THROWS on an un-creatable config dir (the spawn seam catches this → bwrap fails closed)", () => {
    // Pins the contract: seedClaudeConfigDir surfaces mkdir failure as a throw;
    // detached-spawn's makeDetachedSpawn must catch it (a raw throw on the cold
    // spawn path is the 2026-06-19 daemon-crash class). Parent component is a
    // FILE → mkdir -p hits ENOTDIR.
    const root = mkdtempSync(join(tmpdir(), "clawcode-seed-"));
    try {
      const notADir = join(root, "afile");
      writeFileSync(notADir, "x");
      const cfgDir = join(notADir, "claude-config");
      expect(() => seedClaudeConfigDir(plan({ claudeConfigDir: cfgDir }))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op for the non-sandboxed fleet / admin / no plan", () => {
    const root = mkdtempSync(join(tmpdir(), "clawcode-seed-"));
    try {
      const cfgDir = join(root, "should-not-exist");
      seedClaudeConfigDir(plan({ enabled: false, claudeConfigDir: cfgDir }));
      seedClaudeConfigDir(plan({ admin: true, claudeConfigDir: cfgDir }));
      seedClaudeConfigDir(undefined);
      expect(existsSync(cfgDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isClaudeProcessCmdline — orphan-reaper recognizes bwrap-wrapped claude", () => {
  it("matches a direct claude", () => {
    expect(isClaudeProcessCmdline(["/opt/clawcode/claude-pin/claude", "--model", "opus"])).toBe(true);
  });
  it("matches a bwrap-wrapped claude", () => {
    expect(isClaudeProcessCmdline(["/usr/bin/bwrap", "--ro-bind", "/usr", "/usr", "--", "/opt/clawcode/claude-pin/claude", "--model"])).toBe(true);
  });
  it("does not match a non-claude process", () => {
    expect(isClaudeProcessCmdline(["/usr/bin/node", "server.js"])).toBe(false);
  });
  it("does not match bwrap wrapping something other than claude", () => {
    expect(isClaudeProcessCmdline(["bwrap", "--", "/usr/bin/python3", "x.py"])).toBe(false);
  });
});
