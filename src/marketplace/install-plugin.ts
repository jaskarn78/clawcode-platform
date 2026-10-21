/**
 * Phase 90 Plan 05 HUB-02 / HUB-04 — ClawHub plugin installer.
 *
 * Parallel to installSingleSkill (Phase 88 / Plan 90-04) but targets
 * `agents[*].mcpServers` (not skills). Plugin manifests are JSON (not
 * tarballs) — zero filesystem staging; the full pipeline runs in-memory
 * off the parsed manifest + operator-supplied configInputs.
 *
 * Pipeline:
 *   1. normalizePluginManifest — coerce ClawHub manifest shape to
 *      ClawCode-native mcpServerSchema (name, command, args, env).
 *      Required-env gate: missing configInput + no default → outcome
 *      "config-missing" with the missing_field pinned.
 *   2. Literal-value secret scan — every env value that is NOT an op://
 *      reference runs through scanLiteralValueForSecret. On refuse →
 *      outcome "blocked-secret-scan" with the field name pinned.
 *   3. Atomic YAML persist via updateAgentMcpServers (op:"add"). On
 *      updated/no-op → outcome "installed"; on other outcomes →
 *      "installed-persist-failed" or agent-level error passthrough.
 *
 * Error mapping (exhaustive PluginInstallOutcome discriminated union):
 *   - ClawhubRateLimitedError   → { kind:"rate-limited", retryAfterMs }
 *   - ClawhubAuthRequiredError  → { kind:"auth-required", reason }
 *   - ClawhubManifestInvalidError → { kind:"manifest-invalid", reason }
 *   - any other fetch-derived error → { kind:"manifest-invalid", reason }
 *     (treated as malformed registry response for UI clarity)
 *
 * Non-rollback on YAML persist failure: the normalized entry is captured
 * in the return value even on persist-failed; operator can reconcile.
 */
import {
  ClawhubAuthRequiredError,
  ClawhubManifestInvalidError,
  ClawhubManifestNotFoundError,
  ClawhubRateLimitedError,
  type ClawhubPluginManifest,
} from "./clawhub-client.js";
import { updateAgentMcpServers } from "../migration/yaml-writer.js";
import { scanLiteralValueForSecret } from "../migration/skills-secret-scan.js";
// Phase 90 Plan 06 HUB-05 — 1Password op:// rewrite probe. Imported via the
// module object (not named imports) so tests can vi.spyOn(opRewriteMod,
// "listOpItems") without breaking ESM bindings.
import * as opRewriteMod from "./op-rewrite.js";
import type { OpRewriteProposal } from "./op-rewrite.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Normalized ClawCode mcpServerSchema-shaped entry. One plugin manifest
 * becomes one of these after normalizePluginManifest. Consumed by
 * updateAgentMcpServers directly (no further transformation).
 */
export type NormalizedMcpServerEntry = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  optional?: boolean;
}>;

/**
 * Discriminated union of every outcome installClawhubPlugin can return.
 * Mirrors the 11-variant SkillInstallOutcome shape but adapted for the
 * plugin pipeline (plugin-specific variants: config-missing, not-in-
 * catalog, plus the shared HUB-06 variants auth-required/rate-limited/
 * manifest-invalid).
 *
 * Exhaustive-switch invariant (MKT-05 pattern): every failure mode has a
 * distinct `kind`. Plan 05 Task 2 Discord renderer branches on .kind;
 * TypeScript enforces exhaustiveness via the `never` sample branch.
 */
export type PluginInstallOutcome =
  | {
      readonly kind: "installed";
      readonly plugin: string;
      readonly pluginVersion: string;
      readonly entry: NormalizedMcpServerEntry;
    }
  | {
      readonly kind: "installed-persist-failed";
      readonly plugin: string;
      readonly pluginVersion: string;
      readonly persist_error: string;
      readonly entry: NormalizedMcpServerEntry;
    }
  | {
      readonly kind: "already-installed";
      readonly plugin: string;
      readonly reason: string;
    }
  | {
      readonly kind: "blocked-secret-scan";
      readonly plugin: string;
      readonly field: string;
      readonly reason: string;
    }
  | {
      readonly kind: "manifest-invalid";
      readonly plugin: string;
      readonly reason: string;
    }
  | {
      readonly kind: "config-missing";
      readonly plugin: string;
      readonly missing_field: string;
    }
  | {
      readonly kind: "auth-required";
      readonly plugin: string;
      readonly reason: string;
    }
  | {
      readonly kind: "rate-limited";
      readonly plugin: string;
      readonly retryAfterMs: number;
    }
  | {
      readonly kind: "not-in-catalog";
      readonly plugin: string;
    }
  | {
      /**
       * Phase 93 Plan 03 — registry lists the plugin but its manifest URL
       * 404s. Distinct from manifest-invalid (the body parsed but had wrong
       * shape) and not-in-catalog (the plugin name isn't in the list).
       *
       * Operator UX: retry later or pick a different plugin. This is a
       * registry-side fix (publish the manifest); not actionable in
       * ClawCode itself.
       */
      readonly kind: "manifest-unavailable";
      readonly plugin: string;
      readonly manifestUrl: string;
      readonly status: number;
    };

// ---------------------------------------------------------------------------
// normalizePluginManifest — pure function, fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Coerce a ClawHub plugin manifest into a ClawCode-native mcpServerSchema
 * entry, validating required config inputs along the way.
 *
 * Returns `{ ok: true, entry }` on success; `{ ok: false, ... }` with a
 * typed reason on failure. Caller maps the failure reason to a
 * PluginInstallOutcome variant (config-missing or manifest-invalid).
 */
export function normalizePluginManifest(
  manifest: ClawhubPluginManifest,
  configInputs: Readonly<Record<string, string>>,
):
  | { ok: true; entry: NormalizedMcpServerEntry }
  | {
      ok: false;
      reason: string;
      missing_field?: string;
    } {
  // Required-field gate: every env entry with required=true MUST have
  // either an operator-supplied configInput OR a non-null default.
  const envSpec = manifest.env ?? {};
  for (const [envName, spec] of Object.entries(envSpec)) {
    if (spec.required !== true) continue;
    const hasInput =
      Object.prototype.hasOwnProperty.call(configInputs, envName) &&
      configInputs[envName] !== undefined &&
      configInputs[envName] !== "";
    const hasDefault =
      spec.default !== null &&
      spec.default !== undefined &&
      spec.default !== "";
    if (!hasInput && !hasDefault) {
      return {
        ok: false,
        reason: `missing required env: ${envName}`,
        missing_field: envName,
      };
    }
  }

  // Build the env map — operator input wins over manifest default.
  const env: Record<string, string> = {};
  for (const [envName, spec] of Object.entries(envSpec)) {
    const inputVal = configInputs[envName];
    if (inputVal !== undefined && inputVal !== "") {
      env[envName] = inputVal;
    } else if (
      spec.default !== null &&
      spec.default !== undefined &&
      spec.default !== ""
    ) {
      env[envName] = spec.default;
    } else {
      // Optional field with no input and no default — skip (env map
      // doesn't need to carry it). Plugin invocation will see it unset.
      continue;
    }
  }

  // Accept extra configInputs that don't map to a manifest env spec —
  // operator may be overriding a documented-elsewhere flag. Log the key
  // but don't reject.
  for (const [k, v] of Object.entries(configInputs)) {
    if (!(k in env) && v !== undefined && v !== "" && !(k in envSpec)) {
      env[k] = v;
    }
  }

  const entry: NormalizedMcpServerEntry = Object.freeze({
    name: manifest.name,
    command: manifest.command,
    args: Object.freeze([...manifest.args]),
    env: Object.freeze(env),
    optional: false,
  });
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// installClawhubPlugin — orchestrator
// ---------------------------------------------------------------------------

/**
 * Install one ClawHub-sourced plugin on an agent. Returns a typed
 * PluginInstallOutcome; never throws except for truly unrecoverable
 * errors outside any gated branch (structural YAML corruption from
 * updateAgentMcpServers bubbling up).
 *
 * Caller (daemon handleMarketplaceInstallPluginIpc) is responsible for
 * fetching the manifest via downloadClawhubPluginManifest BEFORE calling
 * here — that way this function stays hermetic (no network I/O) and
 * unit-testable with a stub manifest.
 */
export async function installClawhubPlugin(
  args: Readonly<{
    manifest: ClawhubPluginManifest;
    agentName: string;
    configPath: string;
    configInputs: Readonly<Record<string, string>>;
  }>,
): Promise<PluginInstallOutcome> {
  // --- Step 1: Normalize manifest + validate required inputs -------
  const norm = normalizePluginManifest(args.manifest, args.configInputs);
  if (!norm.ok) {
    if (norm.missing_field !== undefined) {
      return Object.freeze({
        kind: "config-missing" as const,
        plugin: args.manifest.name,
        missing_field: norm.missing_field,
      });
    }
    return Object.freeze({
      kind: "manifest-invalid" as const,
      plugin: args.manifest.name,
      reason: norm.reason,
    });
  }

  // --- Step 2: Literal-value secret scan ---------------------------
  // Every env value that is NOT an op:// reference runs through the
  // Phase 84 classifier. On refuse, capture the field name so the
  // Discord UI can pinpoint which input was unsafe. 1Password refs pass
  // silently (already protected).
  for (const [k, v] of Object.entries(norm.entry.env)) {
    if (v.startsWith("op://")) continue;
    const scan = scanLiteralValueForSecret(k, v);
    if (scan.refused) {
      return Object.freeze({
        kind: "blocked-secret-scan" as const,
        plugin: args.manifest.name,
        field: k,
        reason: scan.reason,
      });
    }
  }

  // --- Step 3: Atomic YAML persist ---------------------------------
  let persistResult;
  try {
    persistResult = await updateAgentMcpServers({
      existingConfigPath: args.configPath,
      agentName: args.agentName,
      entry: norm.entry,
      op: "add",
    });
  } catch (err) {
    return Object.freeze({
      kind: "installed-persist-failed" as const,
      plugin: args.manifest.name,
      pluginVersion: args.manifest.version,
      persist_error: err instanceof Error ? err.message : String(err),
      entry: norm.entry,
    });
  }

  switch (persistResult.outcome) {
    case "updated":
      return Object.freeze({
        kind: "installed" as const,
        plugin: args.manifest.name,
        pluginVersion: args.manifest.version,
        entry: norm.entry,
      });
    case "no-op":
      return Object.freeze({
        kind: "already-installed" as const,
        plugin: args.manifest.name,
        reason: persistResult.reason,
      });
    case "not-found":
      return Object.freeze({
        kind: "not-in-catalog" as const,
        plugin: args.manifest.name,
      });
    case "file-not-found":
      return Object.freeze({
        kind: "installed-persist-failed" as const,
        plugin: args.manifest.name,
        pluginVersion: args.manifest.version,
        persist_error: persistResult.reason,
        entry: norm.entry,
      });
    case "refused":
      // Step is either "secret-scan" (caught above but belt-and-
      // suspenders — the writer also runs its own scan) or
      // "invalid-entry" (schema fail after normalize).
      if (persistResult.step === "secret-scan") {
        return Object.freeze({
          kind: "blocked-secret-scan" as const,
          plugin: args.manifest.name,
          field: persistResult.reason.split(":")[0]?.replace(/^env\./, "") ?? "env",
          reason: persistResult.reason,
        });
      }
      return Object.freeze({
        kind: "manifest-invalid" as const,
        plugin: args.manifest.name,
        reason: persistResult.reason,
      });
  }
}

// ---------------------------------------------------------------------------
// mapFetchErrorToOutcome — daemon-level convenience helper
// ---------------------------------------------------------------------------

/**
 * Convert a fetch/download error (caught around the manifest fetch) to
 * the corresponding PluginInstallOutcome variant. Used by the daemon's
 * handleMarketplaceInstallPluginIpc closure so the error-mapping logic
 * stays near the union definition.
 *
 * Unknown errors fall through as `manifest-invalid` — the registry
 * returned something we can't parse. Discord UI treats this as "registry
 * payload is broken" vs the plugin file itself.
 */
export function mapFetchErrorToOutcome(
  err: unknown,
  pluginName: string,
): PluginInstallOutcome {
  if (err instanceof ClawhubRateLimitedError) {
    return Object.freeze({
      kind: "rate-limited" as const,
      plugin: pluginName,
      retryAfterMs: err.retryAfterMs,
    });
  }
  if (err instanceof ClawhubAuthRequiredError) {
    return Object.freeze({
      kind: "auth-required" as const,
      plugin: pluginName,
      reason: err.message,
    });
  }
  // Phase 93 Plan 03 — must precede the ClawhubManifestInvalidError branch
  // so the more-specific 404 routing fires first. Carries manifestUrl +
  // status so the Discord renderer can surface the exact URL operators can
  // probe by hand.
  if (err instanceof ClawhubManifestNotFoundError) {
    return Object.freeze({
      kind: "manifest-unavailable" as const,
      plugin: pluginName,
      manifestUrl: err.manifestUrl,
      status: err.status,
    });
  }
  if (err instanceof ClawhubManifestInvalidError) {
    return Object.freeze({
      kind: "manifest-invalid" as const,
      plugin: pluginName,
      reason: err.message,
    });
  }
  return Object.freeze({
    kind: "manifest-invalid" as const,
    plugin: pluginName,
    reason: err instanceof Error ? err.message : String(err),
  });
}

// ---------------------------------------------------------------------------
// Phase 90 Plan 06 HUB-05 — op:// rewrite candidate generator
// ---------------------------------------------------------------------------

/**
 * One sensitive field that has a matching 1Password item — the operator
 * will see this as a "Use op://..." / "Use literal" button row in Discord.
 */
export type OpRewriteCandidate = Readonly<{
  fieldName: string;
  fieldLabel: string;
  typedValue: string;
  proposal: OpRewriteProposal;
}>;

/**
 * Probe the operator's 1Password vault and, for any sensitive field where
 *   (1) the typed value isn't already an op:// ref, AND
 *   (2) a fuzzy match (substring or Levenshtein ≤ 3) exists against an
 *       existing 1Password item title,
 * return a candidate op:// proposal. The operator confirms each proposal
 * via a Discord button click; on confirmation the caller substitutes the
 * op:// URI for the typed value in configInputs before dispatching the
 * install IPC.
 *
 * Does NOT mutate configInputs — returns an advisory list. The caller is
 * responsible for applying the substitution after operator confirmation.
 *
 * When 1Password is unavailable (listOpItems returns []), this function
 * returns an empty array and the UI falls through to literal paste (which
 * still passes through the install-plugin.ts secret-scan gate — literal
 * high-entropy credentials are refused even after an explicit "use literal"
 * button click).
 */
export async function buildOpRewriteCandidates(
  manifest: ClawhubPluginManifest,
  configInputs: Readonly<Record<string, string>>,
): Promise<readonly OpRewriteCandidate[]> {
  const items = await opRewriteMod.listOpItems();
  if (items.length === 0) return Object.freeze([]);

  const fields = manifest.config?.fields ?? [];
  const out: OpRewriteCandidate[] = [];
  for (const f of fields) {
    if (!f.sensitive) continue;
    const v = configInputs[f.name] ?? "";
    if (v.startsWith("op://")) continue;
    const proposal = opRewriteMod.proposeOpUri(f.name, f.label, items);
    if (proposal) {
      out.push(
        Object.freeze({
          fieldName: f.name,
          fieldLabel: f.label,
          typedValue: v,
          proposal,
        }),
      );
    }
  }
  return Object.freeze(out);
}
