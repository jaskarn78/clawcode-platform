/**
 * Native advisor spawn wiring (2026-08-28).
 *
 * Verified on the pinned CLI 2.1.210 + SDK 0.2.140:
 *   - The server-side advisor tool (`advisor_20260301`) is only offered when
 *     `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` is in the spawned
 *     process env. The daemon's clean spawn env inherits process.env, so the
 *     key is stripped for every agent and re-added ONLY for native agents —
 *     a fleet-wide line in /etc/clawcode/env can never switch it on by itself.
 *   - The advisor model is read from the `advisorModel` SETTING (`--settings`
 *     JSON, which the SDK emits from `Options.settings`). `Options.advisorModel`
 *     is declared in sdk.d.ts but the SDK never forwards it (the only
 *     occurrence in sdk.mjs is the settings schema) — that is why Phase 117's
 *     native backend never actually activated.
 *   - The env flag also BYPASSES the CLI's client-side pairing check, so a
 *     weaker advisor than the executor 400s every request. Callers pass an
 *     `advisorModel` only after `advisorPairingValid` accepted the pair
 *     (`shouldEnableAdvisor` in session-config.ts).
 */

export const ADVISOR_TOOL_ENV = "CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL";

function present(advisorModel: string | undefined): advisorModel is string {
  return typeof advisorModel === "string" && advisorModel.length > 0;
}

/** SDK Options fragment: `{ settings: { advisorModel } }` or nothing. */
export function advisorSdkSettings(
  advisorModel: string | undefined,
): { readonly settings: { readonly advisorModel: string } } | Record<never, never> {
  return present(advisorModel) ? { settings: { advisorModel } } : {};
}

/**
 * Spawn env with the advisor flag set exactly when a validated advisor model
 * is present, and REMOVED otherwise (even if inherited). Pure — returns a new
 * object.
 */
export function withAdvisorToolEnv(
  env: Readonly<Record<string, string | undefined>>,
  advisorModel: string | undefined,
): Record<string, string | undefined> {
  const { [ADVISOR_TOOL_ENV]: _inherited, ...rest } = env;
  return present(advisorModel) ? { ...rest, [ADVISOR_TOOL_ENV]: "1" } : rest;
}
