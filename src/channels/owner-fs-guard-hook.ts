/**
 * Owner filesystem guard — in-process SDK PreToolUse hook that denies an OWNED
 * agent's file tools (Bash/Read/Write/Edit/Grep/Glob/NotebookEdit) from touching
 * another OWNER's agent directories (2026-06-27).
 *
 * This is the filesystem half of cross-tenant isolation. The IPC half
 * (agent-owner-isolation.ts) is airtight for ClawCode's own cross-agent tools;
 * this hook addresses the residual raw-filesystem vector — all agents run as the
 * same `clawcode` uid with no working sandbox, so without it a Client A agent could
 * `cat /home/clawcode/.clawcode/agents/personal/...`.
 *
 * HONEST GUARANTEE — DEFENSE-IN-DEPTH, NOT A BOUNDARY. It matches ABSOLUTE paths
 * (file-tool args resolved to absolute; Bash commands by substring). It is
 * DEFEATED by: relative-path traversal (`cd .. && cat`), symlinks, env/base64
 * indirection, write-then-exec, and file-reading MCP servers (`file://`). It
 * stops casual/prompt-driven access; airtight kernel-level isolation requires
 * per-tenant OS uids — see AIRTIGHT-PLAN.md.
 *
 * Mirrors `subagent-permission-hook.ts` (SDK v2 in-process HookCallback). Unlike
 * that hook it applies to the MAIN agent session too (the owned agent itself is
 * the threat), not only subagents — so it does NOT gate on `agent_id`.
 */

import { resolve } from "node:path";
import type {
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

export interface OwnerFsDecision {
  readonly deny: boolean;
  readonly reason?: string;
}

/** Tools whose input names a file/dir path argument. */
const PATH_ARG_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Grep: ["path"],
  Glob: ["path"],
  LS: ["path"],
};

function norm(prefix: string): string {
  const r = resolve(prefix);
  return r.endsWith("/") ? r.slice(0, -1) : r;
}

function isUnder(absPath: string, prefix: string): boolean {
  return absPath === prefix || absPath.startsWith(prefix + "/");
}

/**
 * Pure decision (exported for tests). `forbiddenPrefixes` are ABSOLUTE dir paths
 * the agent may not touch (cross-owner agent dirs). Allow-by-default; deny only
 * a file tool whose path/command references a forbidden prefix.
 */
export function decideOwnerFsAccess(
  toolName: string,
  toolInput: unknown,
  forbiddenPrefixes: readonly string[],
): OwnerFsDecision {
  if (forbiddenPrefixes.length === 0) return { deny: false };
  const prefixes = forbiddenPrefixes.map(norm);
  const input = (toolInput ?? {}) as Record<string, unknown>;

  // Bash: substring-match the command against absolute forbidden prefixes.
  if (toolName === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    for (const p of prefixes) {
      if (cmd.includes(p)) {
        return {
          deny: true,
          reason: `cross-owner filesystem access denied: command references '${p}' (another owner's agent directory).`,
        };
      }
    }
    return { deny: false };
  }

  // Path-arg tools: resolve the named arg to absolute and check containment.
  const argNames = PATH_ARG_TOOLS[toolName];
  if (argNames) {
    for (const arg of argNames) {
      const raw = input[arg];
      if (typeof raw !== "string" || raw.length === 0) continue;
      const abs = resolve(raw);
      for (const p of prefixes) {
        if (isUnder(abs, p)) {
          return {
            deny: true,
            reason: `cross-owner filesystem access denied: '${arg}' resolves under '${p}' (another owner's agent directory).`,
          };
        }
      }
    }
    // Grep/Glob may also embed a path in the pattern — substring guard.
    const pattern = input.pattern;
    if (typeof pattern === "string") {
      for (const p of prefixes) {
        if (pattern.includes(p)) {
          return {
            deny: true,
            reason: `cross-owner filesystem access denied: pattern references '${p}'.`,
          };
        }
      }
    }
  }

  return { deny: false };
}

/**
 * Build the in-process PreToolUse hook for an owned agent. Returns `undefined`
 * when there are no forbidden prefixes (untenanted / admin agent → no hook, so
 * the options bag is unchanged for those agents).
 */
export function makeOwnerFsGuardHook(
  forbiddenPrefixes: readonly string[],
): HookCallback | undefined {
  if (forbiddenPrefixes.length === 0) return undefined;
  const prefixes = forbiddenPrefixes.map(norm);
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const decision = decideOwnerFsAccess(pre.tool_name, pre.tool_input, prefixes);
    if (decision.deny) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            decision.reason ?? "cross-owner filesystem access denied.",
        },
      };
    }
    return {};
  };
}

/**
 * Compute the cross-owner forbidden dir prefixes for `self` from the full fleet.
 * Returns the workspace + memory dirs of every agent whose owner DIFFERS from
 * self's owner. Empty when self is untenanted or admin (no boundary), or when no
 * other-owner agent exists. Pure — call at config-load time and stamp the result
 * on the resolved config so the hook factory reads a ready list.
 */
export function computeCrossOwnerForbiddenPaths(
  self: { readonly name: string; readonly owner?: string; readonly admin?: boolean },
  fleet: readonly {
    readonly name: string;
    readonly owner?: string;
    readonly workspace?: string;
    readonly memoryPath?: string;
  }[],
): string[] {
  if (self.admin || self.owner === undefined) return [];
  const out = new Set<string>();
  for (const other of fleet) {
    if (other.name === self.name) continue;
    if (other.owner === undefined || other.owner === self.owner) continue;
    if (other.workspace) out.add(norm(other.workspace));
    if (other.memoryPath) out.add(norm(other.memoryPath));
  }
  return [...out];
}
