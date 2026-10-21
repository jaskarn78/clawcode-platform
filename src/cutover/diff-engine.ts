/**
 * Phase 92 Plan 02 — Diff engine (CUT-04).
 *
 * PURE FUNCTION — no I/O, no clock, no logger, no env access. Deterministic
 * by inputs alone. Returns a sorted readonly CutoverGap[] (by kind asc, then
 * identifier asc) consumed by:
 *   - Plan 92-03 additive applier  (handles `severity: "additive"` variants)
 *   - Plan 92-04 destructive embed (handles `severity: "destructive"` variants)
 *   - Plan 92-06 report writer     (renders the full union into CUTOVER-REPORT.md)
 *
 * Detection rules per kind (D-04 + D-11):
 *   missing-skill              → profile.skills − target.yaml.skills
 *   missing-mcp                → profile.mcpServers − target.yaml.mcpServers[].name
 *   missing-memory-file        → profile.memoryRefs − target.workspace.memoryFiles[].path
 *   missing-upload             → profile.uploads − target.workspace.uploads
 *   outdated-memory-file       → path in BOTH but profile.memoryRefHashes[path] !== target hash
 *                                (Plan 92-01 v1 emits memoryRefs as plain strings; tests cast
 *                                an extended fixture carrying memoryRefHashes to exercise the
 *                                variant — production data may produce zero outdated gaps until
 *                                a future profiler enrichment carries source hashes)
 *   model-not-in-allowlist     → profile.models[] not in target.yaml.allowedModels[]
 *   mcp-credential-drift       → MCP in profile + target.mcpRuntime[name].status === "critical"
 *                                with auth-shaped lastError (401/403/invalid_key/auth/...)
 *   tool-permission-gap        → profile.tools[] containing a tool the target's aclDenies[] denies
 *                                (target ACL probe out-of-scope for v1; tests cast an extended
 *                                fixture carrying aclDenies to exercise the variant — production
 *                                wiring deferred to Plan 92-05+)
 *   cron-session-not-mirrored  → profile.topIntents[] containing a "cron:" prefixed entry that
 *                                target.yaml.sessionKinds[] does not mirror (D-11 amendment —
 *                                cron parity ensures Phase 47 schedules continue firing on the
 *                                ClawCode side)
 *
 * Severity tagging:
 *   - additive    (4): missing-skill, missing-mcp, missing-memory-file,
 *                      missing-upload, model-not-in-allowlist
 *                      [Note: this is 5 additive in the union — the
 *                      misnomer comes from the "4 additive + 4 destructive"
 *                      shorthand in 92-CONTEXT.md before D-11 added the 9th
 *                      kind. Real count: 5 additive + 4 destructive = 9.]
 *   - destructive (4): outdated-memory-file, mcp-credential-drift,
 *                      tool-permission-gap, cron-session-not-mirrored
 *
 * Purity invariant pinned by static-grep — see Plan 92-02 verification block
 * for the exact regression pattern (forbidden imports/calls in this file).
 */

import {
  type AgentProfile,
  type CutoverGap,
  type TargetCapability,
  sortGaps,
} from "./types.js";

/**
 * Auth-shaped error keywords used by the mcp-credential-drift heuristic.
 *
 * First-pass heuristic: target.mcpRuntime[name].status === "critical" with
 * lastError containing one of these keywords (case-insensitive substring) is
 * treated as a credential-related failure (vs an unrelated transport error).
 *
 * Tightening this in v2 (e.g. per-server fingerprinting) is a Plan 92-05+
 * concern; the type stays stable.
 */
const AUTH_KEYWORDS = [
  "401",
  "403",
  "invalid_key",
  "invalid key",
  "auth",
  "unauthorized",
  "forbidden",
  "expired",
] as const;

function isAuthShapedError(lastError: string | null): boolean {
  if (lastError === null || lastError.length === 0) return false;
  const lower = lastError.toLowerCase();
  return AUTH_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Pure diff function. Given (AgentProfile, TargetCapability), returns a
 * sorted readonly CutoverGap[]. Same input → byte-identical output.
 */
export function diffAgentVsTarget(
  profile: AgentProfile,
  target: TargetCapability,
): readonly CutoverGap[] {
  const gaps: CutoverGap[] = [];

  // -------------------------------------------------------------------------
  // missing-skill
  // -------------------------------------------------------------------------
  const targetSkills = new Set(target.yaml.skills);
  for (const skill of profile.skills) {
    if (!targetSkills.has(skill)) {
      gaps.push({
        kind: "missing-skill",
        identifier: skill,
        severity: "additive",
        sourceRef: { skillName: skill },
        targetRef: { skills: target.yaml.skills },
      });
    }
  }

  // -------------------------------------------------------------------------
  // missing-mcp
  // -------------------------------------------------------------------------
  const targetMcpNames = target.yaml.mcpServers.map((s) => s.name);
  const targetMcpSet = new Set(targetMcpNames);
  for (const mcp of profile.mcpServers) {
    if (!targetMcpSet.has(mcp)) {
      const toolsUsed = profile.tools.filter((t) =>
        t.startsWith(`mcp__${mcp}__`),
      );
      gaps.push({
        kind: "missing-mcp",
        identifier: mcp,
        severity: "additive",
        sourceRef: { mcpServerName: mcp, toolsUsed },
        targetRef: { mcpServers: targetMcpNames },
      });
    }
  }

  // -------------------------------------------------------------------------
  // missing-memory-file + outdated-memory-file (paired)
  // -------------------------------------------------------------------------
  // Cast for outdated-memory-file detection — Plan 92-01 v1 emits memoryRefs
  // as plain strings without source hashes; tests extend the fixture via the
  // optional `memoryRefHashes` map to exercise the variant. Production data
  // may produce zero outdated gaps until a future profiler enrichment ships.
  const profileWithHashes = profile as AgentProfile & {
    readonly memoryRefHashes?: Readonly<Record<string, string>>;
  };
  const targetMemoryByPath = new Map(
    target.workspace.memoryFiles.map((f) => [f.path, f] as const),
  );
  for (const path of profile.memoryRefs) {
    const targetEntry = targetMemoryByPath.get(path);
    if (targetEntry === undefined) {
      // Path absent on target → missing-memory-file (additive).
      const sourceHash =
        profileWithHashes.memoryRefHashes?.[path] ?? "";
      gaps.push({
        kind: "missing-memory-file",
        identifier: path,
        severity: "additive",
        sourceRef: { path, sourceHash },
        targetRef: { exists: false },
      });
      continue;
    }
    // Path present on both sides — check hash drift if we have a source hash.
    const sourceHash = profileWithHashes.memoryRefHashes?.[path];
    if (
      sourceHash !== undefined &&
      sourceHash.length > 0 &&
      sourceHash !== targetEntry.sha256
    ) {
      gaps.push({
        kind: "outdated-memory-file",
        identifier: path,
        severity: "destructive",
        sourceRef: { path, sourceHash },
        targetRef: { path, targetHash: targetEntry.sha256 },
      });
    }
    // Otherwise: hash unknown or matches → no gap.
  }

  // -------------------------------------------------------------------------
  // missing-upload
  // -------------------------------------------------------------------------
  const targetUploads = new Set(target.workspace.uploads);
  for (const upload of profile.uploads) {
    if (!targetUploads.has(upload)) {
      gaps.push({
        kind: "missing-upload",
        identifier: upload,
        severity: "additive",
        sourceRef: { filename: upload },
        targetRef: { uploads: target.workspace.uploads },
      });
    }
  }

  // -------------------------------------------------------------------------
  // model-not-in-allowlist
  // -------------------------------------------------------------------------
  const allowed = new Set(target.yaml.allowedModels);
  for (const model of profile.models) {
    if (!allowed.has(model)) {
      gaps.push({
        kind: "model-not-in-allowlist",
        identifier: model,
        severity: "additive",
        sourceRef: { modelId: model },
        targetRef: { allowedModels: target.yaml.allowedModels },
      });
    }
  }

  // -------------------------------------------------------------------------
  // mcp-credential-drift — heuristic: profile uses MCP server X AND
  // target.mcpRuntime[X].status === "critical" with auth-shaped lastError.
  // -------------------------------------------------------------------------
  const profileMcpSet = new Set(profile.mcpServers);
  for (const runtime of target.mcpRuntime) {
    if (!profileMcpSet.has(runtime.name)) continue;
    if (runtime.status !== "critical") continue;
    if (!isAuthShapedError(runtime.lastError)) continue;
    const yamlEntry = target.yaml.mcpServers.find(
      (s) => s.name === runtime.name,
    );
    const envKeys = yamlEntry?.envKeys ?? [];
    gaps.push({
      kind: "mcp-credential-drift",
      identifier: runtime.name,
      severity: "destructive",
      sourceRef: { mcpServerName: runtime.name, envKeys },
      targetRef: {
        mcpServerName: runtime.name,
        envKeys,
        status: runtime.status,
      },
    });
  }

  // -------------------------------------------------------------------------
  // tool-permission-gap — first-pass: detected when test fixture supplies
  // aclDenies via TargetCapability extension. Production wiring of the
  // target ACL probe is deferred to Plan 92-05+; the kind exists for
  // downstream consumers.
  // -------------------------------------------------------------------------
  const targetWithAcl = target as TargetCapability & {
    readonly aclDenies?: readonly string[];
  };
  const aclDenies = targetWithAcl.aclDenies ?? [];
  if (aclDenies.length > 0) {
    const denySet = new Set(aclDenies);
    for (const tool of profile.tools) {
      if (denySet.has(tool)) {
        gaps.push({
          kind: "tool-permission-gap",
          identifier: tool,
          severity: "destructive",
          sourceRef: { toolName: tool },
          targetRef: { aclDenies },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // cron-session-not-mirrored (D-11) — profile carries cron-prefixed
  // intents (`cron:<intent-name>` from MC entries with kind === "cron",
  // emitted by Plan 92-01's source-profiler). When target.yaml.sessionKinds
  // does NOT include "cron", every cron-prefixed intent surfaces as a gap.
  // -------------------------------------------------------------------------
  const targetSessionKinds = new Set(target.yaml.sessionKinds);
  const targetMirrors = !targetSessionKinds.has("cron");
  if (targetMirrors) {
    // Mirror lookup: which cron entries (if any) the target HAS wired. With
    // sessionKinds lacking "cron", the target advertises zero cron entries.
    const mirroredCronEntries: readonly string[] = [];
    for (const intent of profile.topIntents) {
      if (!intent.intent.startsWith("cron:")) continue;
      gaps.push({
        kind: "cron-session-not-mirrored",
        identifier: intent.intent,
        severity: "destructive",
        sourceRef: {
          sessionKey: intent.intent,
          // Label is the intent name without the "cron:" prefix — gives the
          // operator a human-readable handle for the embed/report (e.g.
          // "acme-db-sync" instead of "cron:acme-db-sync").
          label: intent.intent.slice("cron:".length),
          kind: "cron",
          // Plan 92-01 profile output does NOT carry per-intent timestamps
          // (D-02 schema is count-only). v1 emits a deterministic placeholder
          // for the type's `lastSeenAt` field; Plan 92-04's embed renderer
          // surfaces it as "unknown" when this matches the placeholder.
          // Plan 92-05+ profiler enrichment may populate the real timestamp.
          lastSeenAt: "unknown",
        },
        targetRef: { mirroredCronEntries },
      });
    }
  }

  return sortGaps(gaps);
}
