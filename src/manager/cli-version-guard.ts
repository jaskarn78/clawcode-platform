/**
 * Phase 999.159 — boot-time gate: does the pinned Claude Code binary satisfy
 * the CLI floor of every model this config will actually run?
 *
 * THE BUG CLASS THIS CLOSES. Anthropic enforces a per-model minimum CLI version
 * and rejects the model below it (`400 ... does not support this model; version
 * 2.1.280 or newer is required`). Nothing checked that locally, so the failure
 * surfaced as EVERY TURN 400ing in production, twice:
 *
 *   - 2026-09-01 — binary moved 2.1.158 → 2.1.257 for Fable 5.1.
 *   - 2026-09-22 — binary moved 2.1.257 → 2.1.280 for Opus 5.5.
 *
 * Both times the code began requiring a binary capability that nothing
 * verified. This guard runs before any turn: it reads `minCliVersion` from
 * `MODEL_ALIAS_CATALOG` (data, not a comment) and fails loud, naming the
 * offending model and the remediation, instead of letting 8 agents discover it
 * one 400 at a time.
 *
 * WHY THE IN-USE / SELECTABLE SPLIT. A model an agent is configured to RUN is a
 * hard failure — it will 400 on its first turn. A model that is merely
 * SELECTABLE (`allowedModels`, reachable later via `/clawcode-model`) is a
 * warning: nothing is broken yet, and failing the fleet's boot over a model
 * nobody is running would be its own outage. Both are reported; only the first
 * blocks.
 *
 * WHY AN UNPROBEABLE BINARY DOES NOT BLOCK. `--version` is a best-effort probe
 * with a timeout (`logResolvedClaudeBinary`). A probe that fails or emits an
 * unparseable string proves nothing about compatibility — and must never be the
 * reason the fleet stays down. That path warns loudly and boots.
 */

import { MODEL_ALIAS_CATALOG, type ModelAliasSpec } from "../shared/model-catalog.js";
import { cliVersionSatisfies, compareCliVersions, formatCliVersion } from "../shared/cli-version.js";

/**
 * Widened view of the catalog. `MODEL_ALIAS_CATALOG` is declared
 * `as const satisfies Record<string, ModelAliasSpec>`, so each entry's LITERAL
 * type carries only the fields it actually declares — reading `minCliVersion`
 * off the `Object.values()` union fails to compile for every alias that omits
 * it. Going through the spec type (where it is `?: string`) is the honest read
 * and keeps the optionality visible.
 */
const CATALOG: Readonly<Record<string, ModelAliasSpec>> = MODEL_ALIAS_CATALOG;

/** One model the config can reach, with where it came from. */
export type ModelCliRequirement = {
  /** The value as configured — an alias key (`opus`) or a concrete id. */
  readonly model: string;
  /** The CLI floor declared for it in the catalog. */
  readonly minCliVersion: string;
  /** Human-readable origin, e.g. `agent "personal".model` — used verbatim in the error. */
  readonly source: string;
  /**
   * `true` when an agent is configured to RUN this model (hard failure);
   * `false` when it is only selectable at runtime (warning).
   */
  readonly inUse: boolean;
};

export type CliVersionVerdict = {
  /** Requirements the installed binary does NOT satisfy and that are in use. */
  readonly blocking: readonly ModelCliRequirement[];
  /** Unmet-but-only-selectable requirements. */
  readonly selectableUnmet: readonly ModelCliRequirement[];
  /** The highest floor among ALL requirements — the CLI version a bump must reach. */
  readonly highestRequired: string | null;
  /** Normalized installed version, or `null` when unprobeable/unparseable. */
  readonly installed: string | null;
};

/** Structural shapes — duck-typed so this module needs no config-schema import. */
type AgentLike = {
  readonly name?: string;
  readonly model?: string | undefined;
  readonly allowedModels?: readonly string[] | undefined;
  readonly advisor?: { readonly model?: string | undefined } | undefined;
};
type ConfigLike = {
  readonly defaults?:
    | {
        readonly model?: string | undefined;
        readonly allowedModels?: readonly string[] | undefined;
        readonly advisor?: { readonly model?: string | undefined } | undefined;
      }
    | undefined;
  readonly agents?: readonly AgentLike[] | undefined;
};

/**
 * Catalog floor for a configured model value. Accepts BOTH an alias key
 * (`opus`) and a concrete id (`claude-opus-5-5`) — config carries aliases, but
 * advisor/override paths can carry ids, and a floor that only matched one shape
 * would be a silent half-check.
 *
 * A `<family>@latest` value resolves at runtime against an entitlement
 * snapshot this module cannot see, so its family prefix is matched instead —
 * conservatively taking the highest floor in that family.
 */
export function lookupMinCliVersion(model: string): string | null {
  const direct = CATALOG[model];
  if (direct !== undefined) return direct.minCliVersion ?? null;

  for (const spec of Object.values(CATALOG)) {
    if (spec.id === model) return spec.minCliVersion ?? null;
  }

  // `<family>@latest` — take the highest floor declared in the family.
  const at = model.indexOf("@");
  if (at > 0) {
    const family = model.slice(0, at);
    let highest: string | null = null;
    for (const spec of Object.values(CATALOG)) {
      if (spec.family !== family || spec.minCliVersion === undefined) continue;
      if (highest === null || (compareCliVersions(spec.minCliVersion, highest) ?? 0) > 0) {
        highest = spec.minCliVersion;
      }
    }
    return highest;
  }
  return null;
}

/**
 * Walk the config for every model it can reach, keeping only those that declare
 * a floor. Duplicates are collapsed per (model, inUse) so one unmet floor on
 * five agents reports once per agent in `source` but does not multiply the
 * verdict.
 */
export function collectCliVersionRequirements(cfg: ConfigLike): readonly ModelCliRequirement[] {
  const out: ModelCliRequirement[] = [];
  const push = (model: string | undefined, source: string, inUse: boolean): void => {
    if (model === undefined || model.trim().length === 0) return;
    const min = lookupMinCliVersion(model);
    if (min === null) return;
    out.push({ model, minCliVersion: min, source, inUse });
  };

  const defaultModel = cfg.defaults?.model;
  push(defaultModel, "defaults.model", true);
  push(cfg.defaults?.advisor?.model, "defaults.advisor.model", true);
  for (const m of cfg.defaults?.allowedModels ?? []) {
    push(m, "defaults.allowedModels", false);
  }

  for (const agent of cfg.agents ?? []) {
    const label = agent.name === undefined ? "agent" : `agent "${agent.name}"`;
    // An agent WITHOUT an explicit model inherits defaults.model, already
    // counted above — do not re-push it under the agent's name.
    push(agent.model, `${label}.model`, true);
    push(agent.advisor?.model, `${label}.advisor.model`, true);
    for (const m of agent.allowedModels ?? []) {
      push(m, `${label}.allowedModels`, false);
    }
  }
  return out;
}

/**
 * Compare the installed version against the collected floors.
 *
 * `installedRaw === null` (unprobeable) yields no blocking entries — see the
 * module header. Every floor still contributes to `highestRequired` so the
 * remediation can name a concrete target.
 */
export function checkCliVersion(
  installedRaw: string | null,
  requirements: readonly ModelCliRequirement[],
): CliVersionVerdict {
  let highestRequired: string | null = null;
  for (const req of requirements) {
    if (
      highestRequired === null ||
      (compareCliVersions(req.minCliVersion, highestRequired) ?? 0) > 0
    ) {
      highestRequired = req.minCliVersion;
    }
  }

  const installed =
    installedRaw === null || installedRaw.trim().length === 0
      ? null
      : formatCliVersion(installedRaw);

  if (installed === null) {
    return { blocking: [], selectableUnmet: [], highestRequired, installed: null };
  }

  const blocking: ModelCliRequirement[] = [];
  const selectableUnmet: ModelCliRequirement[] = [];
  for (const req of requirements) {
    // `null` === unparseable on either side: cannot prove a violation, so it is
    // not treated as one (the warn path in the caller reports it).
    if (cliVersionSatisfies(installed, req.minCliVersion) === false) {
      (req.inUse ? blocking : selectableUnmet).push(req);
    }
  }
  return { blocking, selectableUnmet, highestRequired, installed };
}

/**
 * The operator-facing message. Names every offending model, its origin, and the
 * one command that fixes it — the 09-22 incident cost time precisely because
 * the 400 body named a version but nothing named what to DO about it.
 */
export function formatCliVersionFailure(verdict: CliVersionVerdict): string {
  const target = verdict.highestRequired ?? "a newer version";
  const lines = verdict.blocking.map(
    (b) => `  - ${b.model} (${b.source}) requires CLI >= ${b.minCliVersion}`,
  );
  return [
    `Claude Code binary too old for the configured models: installed ${verdict.installed}, ` +
      `need ${target}.`,
    ...lines,
    `Every turn on ${verdict.blocking.length === 1 ? "that model" : "those models"} would fail ` +
      `with "400 ... does not support this model". Remediation: bump ` +
      `@anthropic-ai/claude-agent-sdk to a release whose claudeCodeVersion >= ${target} ` +
      `(it ships the matched binary) and redeploy; or, as a stopgap, point ` +
      `CLAWCODE_CLAUDE_BIN at an installed binary >= ${target}.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Phase 999.169 — CLI + SDK lockstep
// ---------------------------------------------------------------------------

/** The boot probe's view of the fleet binary (see `probeClaudeBinary`). */
export type LockstepProbe = {
  readonly pin: string | null;
  readonly source: "override" | "sdk-bundled" | null;
  readonly version: string | null;
  readonly sdkVersion: string | null;
  readonly sdkClaudeCodeVersion: string | null;
  readonly error: string | null;
};

export type LockstepVerdict =
  | { readonly kind: "ok"; readonly version: string }
  | { readonly kind: "mismatch"; readonly installed: string; readonly expected: string; readonly pin: string | null }
  | { readonly kind: "unresolved"; readonly error: string }
  | { readonly kind: "override"; readonly pin: string | null; readonly installed: string | null; readonly expected: string | null }
  | { readonly kind: "unverifiable"; readonly reason: string };

/**
 * Is the binary every agent spawns the exact CLI the installed SDK was built
 * against? The operator rule (2026-09-24) is that CLI and SDK move together;
 * a binary that drifted from its SDK is the silent-skew class this phase closes.
 *
 * - `unresolved` (no binary to spawn) and `mismatch` are FATAL at boot.
 * - `override` (CLAWCODE_CLAUDE_BIN) is the deliberate rollback path: loud, not fatal.
 * - `unverifiable` (probe failed, or the SDK declares no claudeCodeVersion) warns,
 *   matching the floor guard's rule that an unprobeable binary must not keep the
 *   fleet down.
 */
export function checkClaudeBinaryLockstep(probe: LockstepProbe): LockstepVerdict {
  if (probe.error !== null || probe.pin === null) {
    return { kind: "unresolved", error: probe.error ?? "no Claude Code binary resolved" };
  }
  const installed = probe.version === null ? null : formatCliVersion(probe.version);
  const expected = probe.sdkClaudeCodeVersion === null ? null : formatCliVersion(probe.sdkClaudeCodeVersion);
  if (probe.source === "override") {
    return { kind: "override", pin: probe.pin, installed, expected };
  }
  if (installed === null) return { kind: "unverifiable", reason: `could not probe ${probe.pin} --version` };
  if (expected === null) {
    return { kind: "unverifiable", reason: `SDK ${probe.sdkVersion ?? "?"} declares no claudeCodeVersion` };
  }
  const cmp = compareCliVersions(installed, expected);
  if (cmp === null) {
    return { kind: "unverifiable", reason: `unparseable versions (${installed} vs ${expected})` };
  }
  if (cmp !== 0) return { kind: "mismatch", installed, expected, pin: probe.pin };
  return { kind: "ok", version: installed };
}

export function isLockstepFatal(v: LockstepVerdict): boolean {
  return v.kind === "mismatch" || v.kind === "unresolved";
}

export function formatLockstepFailure(v: LockstepVerdict): string {
  const rollback =
    "Rollback: set CLAWCODE_CLAUDE_BIN=/opt/clawcode/claude-pin/claude in /etc/clawcode/env and restart.";
  switch (v.kind) {
    case "mismatch":
      return (
        `Claude Code binary ${v.installed} at ${v.pin ?? "?"} is not the CLI the installed Agent SDK ` +
        `was built against (${v.expected}). CLI and SDK must move together. Fix: run \`npm ci\` in the ` +
        `ClawCode install dir so the SDK's platform package matches package-lock. ${rollback}`
      );
    case "unresolved":
      return `No Claude Code binary to spawn: ${v.error}. ${rollback}`;
    case "override":
      return (
        `CLAWCODE_CLAUDE_BIN override in effect: ${v.pin ?? "?"} (${v.installed ?? "unprobeable"}), ` +
        `not the SDK's matched ${v.expected ?? "?"}. Unset it to return to lockstep.`
      );
    case "unverifiable":
      return `CLI/SDK lockstep UNVERIFIED: ${v.reason}.`;
    case "ok":
      return `CLI/SDK lockstep OK (${v.version}).`;
  }
}
