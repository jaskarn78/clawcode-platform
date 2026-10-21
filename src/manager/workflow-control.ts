/**
 * Phase 999.165 — who may see and control a background workflow.
 *
 * The rule, in one place so every workflow-control IPC method (status, cancel,
 * steer, edit) applies it identically:
 *
 *   - A call carrying an agent token is an AGENT. It acts only on its own
 *     workflows — a workflow's own sub-sessions (`<owner>-sub-<id>`) count as
 *     the owner — or on any workflow when the agent is `admin`. On top of that
 *     the fleet's cross-owner fence (`assertCrossAgentAllowed`) still applies,
 *     so a Client A-owned agent can never reach a Operator-owned workflow.
 *   - A tokenless local call (the Discord operator path, the CLI, the
 *     dashboard) is the trusted OPERATOR, exactly as for every other IPC
 *     method (`enforceAgentIdentity` / `resolveVerifiedCaller` fail open the
 *     same way). The Discord handler gates cancel/steer on its own admin check
 *     before it ever gets here.
 *
 * Pure: the verified caller and the fleet configs are passed in.
 */

import { ManagerError } from "../shared/errors.js";
import { assertCrossAgentAllowed, type OwnerConfigView } from "./agent-owner-isolation.js";
import { parentAgentName } from "./subagent-name.js";

export type WorkflowCaller =
  | { readonly kind: "operator"; readonly by: string }
  | { readonly kind: "agent"; readonly agent: string; readonly admin: boolean };

const OPERATOR_LABEL_MAX_CHARS = 80;

/**
 * @param verifiedCaller the token-verified caller (`resolveVerifiedCaller`),
 *   or null for a tokenless local call.
 * @param params the IPC params; a tokenless caller may name itself in `by`.
 */
export function resolveWorkflowCaller(
  verifiedCaller: string | null,
  params: Record<string, unknown>,
  configs: readonly OwnerConfigView[],
): WorkflowCaller {
  if (verifiedCaller === null) {
    const by = typeof params.by === "string" ? params.by.trim().slice(0, OPERATOR_LABEL_MAX_CHARS) : "";
    return { kind: "operator", by: by.length > 0 ? by : "operator" };
  }
  const agent = parentAgentName(verifiedCaller);
  return { kind: "agent", agent, admin: configs.find((c) => c.name === agent)?.admin === true };
}

/** Throws a ManagerError when `caller` may not control a workflow owned by `owner`. */
export function authorizeWorkflowControl(
  caller: WorkflowCaller,
  owner: string,
  workflowId: string,
  configs: readonly OwnerConfigView[],
): void {
  if (caller.kind === "operator") return;
  assertCrossAgentAllowed(caller.agent, owner, configs);
  if (caller.agent !== owner && !caller.admin) {
    throw new ManagerError(
      `workflow ${workflowId} belongs to ${owner} — only ${owner} (or an admin agent) can change it`,
    );
  }
}

/** The name recorded as "cancelled by …" / "steered by …". */
export function workflowActorLabel(caller: WorkflowCaller): string {
  return caller.kind === "operator" ? caller.by : caller.agent;
}

/**
 * Agents reached for the task tools with a `wf_` id and got "Task not found".
 * Point them at the right tools instead.
 */
export function workflowIdTaskHint(id: string): string {
  return (
    `${id} is a background workflow, not a delegated task. ` +
    `Use workflow_status to see it, steer_workflow to give it new direction, edit_workflow to add/replace/remove steps, ` +
    `and cancel_workflow to stop it (or one of its steps).`
  );
}

export function isWorkflowId(id: string): boolean {
  return /^wf_[A-Za-z0-9_-]+$/.test(id);
}
