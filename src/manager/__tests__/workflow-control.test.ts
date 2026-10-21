/**
 * Phase 999.165 — who may see and control a workflow, and the words an agent
 * or operator reads back.
 */
import { describe, expect, it } from "vitest";
import {
  authorizeWorkflowControl,
  isWorkflowId,
  resolveWorkflowCaller,
  workflowActorLabel,
  workflowIdTaskHint,
} from "../workflow-control.js";
import { formatDuration, renderCancelResultText, renderWorkflowListText } from "../workflow-status-render.js";
import type { WorkflowSummary } from "../workflow-orchestrator.js";

const fleet = [
  { name: "personal", owner: "owner_a" },
  { name: "projects", owner: "owner_a" },
  { name: "Admin Clawdy", owner: "owner_a", admin: true },
  { name: "fin-client", owner: "client_a" },
];

describe("resolveWorkflowCaller", () => {
  it("a tokenless local call is the operator, labelled by `by`", () => {
    expect(resolveWorkflowCaller(null, { by: "operator (owner_a)" }, fleet)).toEqual({ kind: "operator", by: "operator (owner_a)" });
    expect(resolveWorkflowCaller(null, {}, fleet)).toEqual({ kind: "operator", by: "operator" });
  });
  it("a verified agent — and its own sub-sessions — resolve to the agent, with the admin flag", () => {
    expect(resolveWorkflowCaller("projects", {}, fleet)).toEqual({ kind: "agent", agent: "projects", admin: false });
    expect(resolveWorkflowCaller("projects-sub-abc123", {}, fleet)).toEqual({ kind: "agent", agent: "projects", admin: false });
    expect(resolveWorkflowCaller("Admin Clawdy", {}, fleet)).toEqual({ kind: "agent", agent: "Admin Clawdy", admin: true });
  });
});

describe("authorizeWorkflowControl", () => {
  const agent = (name: string) => resolveWorkflowCaller(name, {}, fleet);
  it("the owner may act on its own workflow", () => {
    expect(() => authorizeWorkflowControl(agent("projects"), "projects", "wf_1", fleet)).not.toThrow();
    expect(() => authorizeWorkflowControl(agent("projects-sub-abc123"), "projects", "wf_1", fleet)).not.toThrow();
  });
  it("another agent of the same owner may not", () => {
    expect(() => authorizeWorkflowControl(agent("personal"), "projects", "wf_1", fleet)).toThrow(/belongs to projects/);
  });
  it("an admin agent may, within the owner fence", () => {
    expect(() => authorizeWorkflowControl(agent("Admin Clawdy"), "projects", "wf_1", fleet)).not.toThrow();
  });
  it("a different tenant never may", () => {
    expect(() => authorizeWorkflowControl(agent("fin-client"), "projects", "wf_1", fleet)).toThrow(/cross-owner action denied/);
    expect(() => authorizeWorkflowControl(agent("personal"), "fin-client", "wf_2", fleet)).toThrow(/cross-owner action denied/);
  });
  it("the operator path is trusted", () => {
    expect(() => authorizeWorkflowControl({ kind: "operator", by: "operator (owner_a)" }, "fin-client", "wf_2", fleet)).not.toThrow();
  });
  it("labels the actor", () => {
    expect(workflowActorLabel(agent("projects-sub-abc123"))).toBe("projects");
    expect(workflowActorLabel({ kind: "operator", by: "operator (owner_a)" })).toBe("operator (owner_a)");
  });
});

describe("task tools given a workflow id", () => {
  it("recognizes wf_ ids and points at the workflow tools", () => {
    expect(isWorkflowId("wf_83Ndpj")).toBe(true);
    expect(isWorkflowId("task_83Ndpj")).toBe(false);
    expect(workflowIdTaskHint("wf_83Ndpj")).toMatch(/background workflow.*workflow_status.*cancel_workflow/);
  });
});

describe("rendering", () => {
  const wf = (over: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
    workflowId: "wf_abc123",
    parentAgentName: "projects",
    status: "running",
    ageMs: 14 * 60_000,
    workers: { total: 3, running: 2, done: 1, failed: 0 },
    lastProgressAt: 0,
    plannedSteps: 5,
    waves: { current: 1, total: 2 },
    ...over,
  });
  it("lists workflows with planned totals, wave and age", () => {
    expect(renderWorkflowListText([wf()])).toBe("wf_abc123 — running · 1/5 step(s) done, 2 running · wave 1/2 · 14m old");
    expect(renderWorkflowListText([wf({ cancelled: { by: "projects", reason: "wrong direction" } })])).toContain(
      "cancelled by projects (wrong direction)",
    );
    expect(renderWorkflowListText([])).toMatch(/No background workflows/);
  });
  it("renders every cancel outcome", () => {
    expect(renderCancelResultText("wf_x", { status: "cancelled", done: 1, stopped: 2, skipped: 3 })).toMatch(/stopping 2 running, skipping 3/);
    expect(renderCancelResultText("wf_x", { status: "step-stopped", stepId: "a" })).toMatch(/Stopped step a/);
    expect(renderCancelResultText("wf_x", { status: "step-will-skip", stepId: "a" })).toMatch(/will be skipped/);
    expect(renderCancelResultText("wf_x", { status: "step-not-found", stepId: "a" })).toMatch(/workflow_status/);
    expect(renderCancelResultText("wf_x", { status: "not-found" })).toMatch(/No workflow wf_x/);
  });
  it("formats durations", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(4 * 60_000)).toBe("4m");
    expect(formatDuration(65 * 60_000)).toBe("1h 05m");
  });
});
