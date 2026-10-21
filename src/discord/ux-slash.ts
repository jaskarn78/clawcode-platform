/**
 * Phase 999.171 — `/clawcode-ux <thinking|suggestions|research>
 * on|off|status|reset [agent]`: route to the daemon's `set-ux-feature` IPC and
 * render the ephemeral reply. Testable without a Discord client.
 *
 * Replies are plain text — no emoji or Unicode icons (operator rule for
 * 999.157 / 999.171) — and always say when the change takes effect: next
 * turn, after a restart, or not used by this build yet.
 */

import { UX_FEATURE_META, type UxFeature } from "../manager/ux-feature-state-store.js";

/** Deps for `/clawcode-ux` (testable without a client). */
export interface UxSlashDeps {
  readonly agent: string;
  readonly feature: string;
  readonly state?: string;
  /** 999.173 polish — research only: opus | sonnet | haiku | fable | inherit | reset. */
  readonly model?: string;
  readonly sendIpc: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

interface UxSlashIpcResult {
  readonly agent: string;
  readonly feature: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly source: "override" | "config";
  readonly applies: "next-turn" | "restart" | "not-yet-available";
  /** 999.172 — restart-applied features: does the running session still differ? */
  readonly restartPending?: boolean;
  /** 999.173 polish — research only. */
  readonly researchModel?: Readonly<{ model: string; source: "override" | "config" | "default"; applies?: string }>;
  /** 999.173 polish — research only: the usage guard line. */
  readonly usageGuard?: string;
  /** 999.173 polish — research only: the budgets line. */
  readonly budgets?: string;
}

/** Headroom under Discord's 2,000-char message limit (same as /clawcode-quick). */
const UX_SLASH_REPLY_MAX_CHARS = 1900;

function capReply(text: string): string {
  return text.length > UX_SLASH_REPLY_MAX_CHARS
    ? `${text.slice(0, UX_SLASH_REPLY_MAX_CHARS - 1)}…`
    : text;
}

function labelFor(feature: string): string {
  return Object.hasOwn(UX_FEATURE_META, feature)
    ? UX_FEATURE_META[feature as UxFeature].label
    : feature;
}

function appliesLine(
  applies: UxSlashIpcResult["applies"],
  agent: string,
  restartPending?: boolean,
): string {
  switch (applies) {
    case "next-turn":
      return "Takes effect on the next turn.";
    case "restart":
      if (restartPending === true) return `Restart pending: takes effect after the agent restarts (clawcode restart ${agent}).`;
      if (restartPending === false) return "The running session already matches.";
      return `Takes effect after the agent restarts (clawcode restart ${agent}).`;
    case "not-yet-available":
      return "Saved, but this build does not use it yet.";
    default:
      return "";
  }
}

function isIpcResult(value: unknown): value is UxSlashIpcResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.agent === "string" && typeof v.feature === "string" && typeof v.enabled === "boolean";
}

/** Route `/clawcode-ux` to the daemon and render the ephemeral reply. */
export async function handleUxSlash(deps: UxSlashDeps): Promise<string> {
  const requested = deps.state ?? "status";
  const response = await deps.sendIpc("set-ux-feature", {
    agent: deps.agent,
    feature: deps.feature,
    state: requested,
    ...(deps.model !== undefined ? { model: deps.model } : {}),
  });
  if (typeof response === "object" && response !== null && "error" in response) {
    return capReply(`ux: ${String((response as { error: unknown }).error)}`);
  }
  if (!isIpcResult(response)) return "ux: unexpected response from the daemon";

  const state = typeof response.state === "string" ? response.state : requested;
  const onOff = response.enabled ? "**on**" : "**off**";
  const source = response.source === "override" ? "set with /clawcode-ux" : "from config";
  const base = `${labelFor(response.feature)} ${onOff} for **${response.agent}**`;
  const head =
    state === "reset"
      ? `${labelFor(response.feature)} reset for **${response.agent}** — now ${onOff} (${source}).`
      : state === "on" || state === "off"
        ? `${base} — kept across restarts.`
        : `${base} (${source})`;
  const tail = appliesLine(
    response.applies,
    response.agent,
    typeof response.restartPending === "boolean" ? response.restartPending : undefined,
  );
  const modelLine = researchModelLine(response.researchModel, deps.model);
  const usageLine = typeof response.usageGuard === "string" ? response.usageGuard : "";
  const budgetLine = typeof response.budgets === "string" ? response.budgets : "";
  return capReply([head, tail, modelLine, usageLine, budgetLine].filter((l) => l.length > 0).join("\n"));
}

const MODEL_SOURCE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  override: "set with /clawcode-ux",
  config: "from config",
  default: "default",
});

/** 999.173 polish — "Research model: sonnet (set with /clawcode-ux). Applies from the next research launch, no restart." */
function researchModelLine(rm: UxSlashIpcResult["researchModel"], requested: string | undefined): string {
  if (rm === undefined || typeof rm.model !== "string") return "";
  const source = MODEL_SOURCE_TEXT[rm.source] ?? rm.source;
  const changed = requested !== undefined;
  return `Research model: ${rm.model} (${source}).${changed ? " Applies from the next research launch, no restart." : ""}`;
}
