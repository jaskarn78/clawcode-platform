/**
 * Phase 999.169 — Claude Code CLI + Agent SDK version watch.
 *
 * Operator rule (2026-09-24): check regularly for new releases, and every update
 * moves BOTH to latest as a matched pair. The pair is exact: each SDK release
 * declares the CLI it was built against (`claudeCodeVersion`), and since 999.169
 * the fleet binary IS the SDK's bundled binary — so "latest" means the newest SDK
 * plus the CLI it names.
 *
 * Pure evaluation + rendering. IO (npm registry, binary probe, state file, admin
 * post) is injected by `version-watch-cron.ts` and the `clawcode versions` CLI.
 *
 * Findings, each with a stable dedup key:
 *   - new-pair     npm latest is newer than the SDK the daemon runs
 *   - skew         the binary on disk is not the running SDK's claudeCodeVersion
 *                  (e.g. deps staged without a restart, or a hand-swapped binary)
 *   - override     CLAWCODE_CLAUDE_BIN is set (rollback mode, out of lockstep)
 *   - unresolved   no binary to spawn at all
 */

import { compareCliVersions, formatCliVersion } from "../shared/cli-version.js";

export const SDK_REGISTRY_URL = "https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk";
export const SDK_VERSIONS_URL = "https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk?activeTab=versions";
export const SUPPLY_CHAIN_MIN_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RegistryPair = {
  readonly sdk: string;
  readonly cli: string | null;
  readonly publishedAt: string | null;
};

export type RuntimeTruth = {
  /** SDK the daemon loaded (read at boot). */
  readonly sdkVersion: string | null;
  readonly sdkClaudeCodeVersion: string | null;
  /** `--version` of the binary on disk right now. */
  readonly binaryVersion: string | null;
  readonly source: "override" | "sdk-bundled" | null;
  readonly pin: string | null;
  readonly error: string | null;
};

export type VersionWatchInput = {
  readonly latest: RegistryPair | null;
  readonly registryError: string | null;
  readonly runtime: RuntimeTruth;
  readonly highestFloor: string | null;
  readonly now: number;
};

export type VersionFindingKind = "new-pair" | "skew" | "override" | "unresolved";

export type VersionFinding = {
  readonly kind: VersionFindingKind;
  /** Stable dedup key — the same situation never posts twice. */
  readonly key: string;
  readonly line: string;
};

export type IconPrefix = (icon: "rocket" | "warning" | "wrench" | "shield" | "circle_x" | "circle_check" | "info", text: string) => string;
const plain: IconPrefix = (_i, text) => text;

function ageDays(publishedAt: string | null, now: number): number | null {
  if (publishedAt === null) return null;
  const t = Date.parse(publishedAt);
  return Number.isNaN(t) ? null : Math.floor((now - t) / DAY_MS);
}

export function evaluateVersions(input: VersionWatchInput, icon: IconPrefix = plain): readonly VersionFinding[] {
  const out: VersionFinding[] = [];
  const rt = input.runtime;
  const bin = rt.binaryVersion === null ? null : formatCliVersion(rt.binaryVersion);
  const sdkCc = rt.sdkClaudeCodeVersion === null ? null : formatCliVersion(rt.sdkClaudeCodeVersion);

  if (rt.error !== null) {
    out.push({
      kind: "unresolved",
      key: `unresolved:${rt.error}`,
      line: icon("circle_x", `**No Claude Code binary to spawn:** ${rt.error}`),
    });
  } else if (rt.source === "override") {
    out.push({
      kind: "override",
      key: `override:${rt.pin ?? "?"}@${bin ?? "?"}`,
      line: icon(
        "wrench",
        `**CLAWCODE_CLAUDE_BIN override in effect:** ${rt.pin ?? "?"} (${bin ?? "unprobeable"}), ` +
          `not the SDK's matched ${sdkCc ?? "?"}. Unset it to return to lockstep.`,
      ),
    });
  } else if (bin !== null && sdkCc !== null && compareCliVersions(bin, sdkCc) !== 0) {
    out.push({
      kind: "skew",
      key: `skew:${bin}-vs-${sdkCc}`,
      line: icon(
        "warning",
        `**CLI/SDK skew:** the binary on disk is ${bin} but the running SDK ${rt.sdkVersion ?? "?"} ` +
          `was built for ${sdkCc}. If deps were just staged, restart to finish the update; otherwise run \`npm ci\`.`,
      ),
    });
  }

  const latest = input.latest;
  if (latest !== null && rt.sdkVersion !== null && (compareCliVersions(latest.sdk, rt.sdkVersion) ?? 0) > 0) {
    const age = ageDays(latest.publishedAt, input.now);
    const ageText =
      age === null
        ? ""
        : age >= SUPPLY_CHAIN_MIN_AGE_DAYS
          ? ` · published ${age}d ago (clears the ${SUPPLY_CHAIN_MIN_AGE_DAYS}-day age guard)`
          : ` · published ${age}d ago (clears the ${SUPPLY_CHAIN_MIN_AGE_DAYS}-day age guard in ${SUPPLY_CHAIN_MIN_AGE_DAYS - age}d)`;
    const floorText =
      input.highestFloor !== null && latest.cli !== null && (compareCliVersions(latest.cli, input.highestFloor) ?? 0) < 0
        ? ` · ⚠ below the model floor ${input.highestFloor}`
        : "";
    out.push({
      kind: "new-pair",
      key: `new-pair:${latest.sdk}`,
      line: icon(
        "rocket",
        `**New matched pair:** SDK \`${latest.sdk}\` ↔ CLI \`${latest.cli ?? "?"}\`${ageText}${floorText}. ` +
          `Prod runs SDK \`${rt.sdkVersion}\` / CLI \`${bin ?? sdkCc ?? "?"}\` — update both together. ` +
          `Releases: <${SDK_VERSIONS_URL}>`,
      ),
    });
  }

  return out;
}

/** One admin post for the findings that have not been surfaced yet. */
export function renderAlert(findings: readonly VersionFinding[], icon: IconPrefix = plain): string {
  return [icon("info", "**Claude Code / Agent SDK version watch**"), ...findings.map((f) => `- ${f.line}`)].join("\n");
}

/** Full human report for `clawcode versions` — everything, no dedup. */
export function renderReport(input: VersionWatchInput, findings: readonly VersionFinding[]): string {
  const rt = input.runtime;
  const lines = [
    "Claude Code / Agent SDK",
    `  running SDK:     ${rt.sdkVersion ?? "not installed"} (built for CLI ${rt.sdkClaudeCodeVersion ?? "?"})`,
    `  fleet binary:    ${rt.pin ?? "unresolved"} [${rt.source ?? "-"}]`,
    `  binary version:  ${rt.binaryVersion ?? "unprobeable"}`,
    `  npm latest:      ${
      input.latest === null
        ? `unavailable (${input.registryError ?? "no data"})`
        : `SDK ${input.latest.sdk} ↔ CLI ${input.latest.cli ?? "?"}${
            input.latest.publishedAt === null ? "" : ` (published ${input.latest.publishedAt.slice(0, 10)})`
          }`
    }`,
    `  highest floor:   ${input.highestFloor ?? "none declared"}`,
  ];
  lines.push(findings.length === 0 ? "  status:          in lockstep, up to date" : "  findings:");
  for (const f of findings) lines.push(`    - [${f.kind}] ${f.line.replace(/\*\*/g, "")}`);
  return lines.join("\n");
}

export type FetchJson = (url: string) => Promise<unknown>;

/** npm `latest` for the SDK plus the CLI it names; publish time only when asked. */
/**
 * Registry strings are rendered into an admin Discord post, so only strict
 * semver-shaped values are accepted (no markdown, mentions or links can ride in).
 */
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

export async function fetchLatestPair(fetchJson: FetchJson, withPublishTime: (sdk: string) => boolean): Promise<RegistryPair> {
  const latest = (await fetchJson(`${SDK_REGISTRY_URL}/latest`)) as { version?: unknown; claudeCodeVersion?: unknown };
  if (typeof latest.version !== "string") throw new Error("registry: latest has no version");
  if (!SEMVER.test(latest.version)) throw new Error("registry: latest version is not semver-shaped");
  const cli =
    typeof latest.claudeCodeVersion === "string" && SEMVER.test(latest.claudeCodeVersion)
      ? latest.claudeCodeVersion
      : null;
  let publishedAt: string | null = null;
  if (withPublishTime(latest.version)) {
    const doc = (await fetchJson(SDK_REGISTRY_URL)) as { time?: Record<string, unknown> };
    const t = doc.time?.[latest.version];
    publishedAt = typeof t === "string" && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : null;
  }
  return { sdk: latest.version, cli, publishedAt };
}

/** Persisted dedup: which finding keys already reached Admin Clawdy. */
export type VersionWatchState = { readonly surfaced: Readonly<Record<string, string>> };

export function unsurfaced(findings: readonly VersionFinding[], state: VersionWatchState): readonly VersionFinding[] {
  return findings.filter((f) => state.surfaced[f.key] === undefined);
}

export function markSurfaced(state: VersionWatchState, findings: readonly VersionFinding[], at: number): VersionWatchState {
  const surfaced: Record<string, string> = { ...state.surfaced };
  for (const f of findings) surfaced[f.key] = new Date(at).toISOString();
  return { surfaced };
}
