/**
 * dashboard-rework — read the native Claude Code plugin marketplace state for
 * the BROWSE surface. Reads (for the daemon user's HOME):
 *   ~/.claude/plugins/known_marketplaces.json      (registered marketplaces)
 *   ~/.claude/plugins/marketplaces/<name>/.claude-plugin/marketplace.json (manifest)
 *   ~/.claude/plugins/installed_plugins.json        (what's installed)
 * and assembles a verified-flagged catalog. "Anthropic-verified" = the
 * marketplace owner is Anthropic OR its source repo/url is under anthropics/*.
 *
 * Pure read + a `claudeHome` override so it's unit-testable without touching the
 * real home dir.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PluginCatalogEntry = {
  name: string;
  marketplace: string;
  ref: string; // <name>@<marketplace>
  description: string;
  author: string | null;
  category: string | null;
  verified: boolean; // marketplace is Anthropic-verified
  firstParty: boolean; // plugin author is Anthropic
  installed: boolean;
  homepage: string | null;
};

export type MarketplaceSummary = {
  name: string;
  source: string; // repo (owner/name) or git url
  verified: boolean;
  pluginCount: number;
};

export type PluginMarketplacesResult = {
  marketplaces: MarketplaceSummary[];
  plugins: PluginCatalogEntry[];
};

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isAnthropicSource(src: unknown): boolean {
  if (!src || typeof src !== "object") return false;
  const s = src as { repo?: unknown; url?: unknown };
  const repo = typeof s.repo === "string" ? s.repo.toLowerCase() : "";
  const url = typeof s.url === "string" ? s.url.toLowerCase() : "";
  return repo.startsWith("anthropics/") || /github\.com[/:]anthropics\//.test(url);
}

function authorName(a: unknown): string | null {
  if (typeof a === "string") return a;
  if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
    return (a as { name: string }).name;
  }
  return null;
}

export function readPluginMarketplaces(claudeHome?: string): PluginMarketplacesResult {
  const base = join(claudeHome ?? homedir(), ".claude", "plugins");
  const marketplaces: MarketplaceSummary[] = [];
  const plugins: PluginCatalogEntry[] = [];

  const installedRefs = new Set<string>();
  const reg = readJson<{ plugins?: Record<string, unknown> }>(join(base, "installed_plugins.json"));
  for (const ref of Object.keys(reg?.plugins ?? {})) installedRefs.add(ref);

  const known = readJson<Record<string, { source?: unknown }>>(join(base, "known_marketplaces.json"));
  if (!known) return { marketplaces, plugins };

  for (const [mktName, info] of Object.entries(known)) {
    const src = (info as { source?: unknown }).source ?? {};
    const s = src as { repo?: string; url?: string };
    const source = s.repo ?? s.url ?? mktName;
    const manifest = readJson<{
      owner?: { name?: string };
      plugins?: Array<Record<string, unknown>>;
    }>(join(base, "marketplaces", mktName, ".claude-plugin", "marketplace.json"));
    const verified = manifest?.owner?.name === "Anthropic" || isAnthropicSource(src);
    const mktPlugins = Array.isArray(manifest?.plugins) ? manifest!.plugins : [];

    marketplaces.push({ name: mktName, source, verified, pluginCount: mktPlugins.length });

    for (const p of mktPlugins) {
      const name = typeof p.name === "string" ? p.name : null;
      if (!name) continue;
      const ref = `${name}@${mktName}`;
      const author = authorName(p.author);
      plugins.push({
        name,
        marketplace: mktName,
        ref,
        description: typeof p.description === "string" ? p.description : "",
        author,
        category: typeof p.category === "string" ? p.category : null,
        verified,
        firstParty: author === "Anthropic",
        installed: installedRefs.has(ref),
        homepage: typeof p.homepage === "string" ? p.homepage : null,
      });
    }
  }

  // Verified marketplaces + plugins surface first; first-party next; then name.
  marketplaces.sort(
    (a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name),
  );
  plugins.sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      Number(b.firstParty) - Number(a.firstParty) ||
      a.name.localeCompare(b.name),
  );

  return { marketplaces, plugins };
}
