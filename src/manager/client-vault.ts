/**
 * Phase 999.132 — per-client fact vault.
 *
 * WHY. fin-client's client documents are only as good as the figures
 * behind them, and today those figures live in prose across memories,
 * session summaries and old PDFs. A client vault is one small, structured,
 * human-readable file per client (`<workspace>/clients/<slug>/facts.json`):
 * every fact carries its value, its source, its as-of date and who set it,
 * and every change keeps the previous value in history. The fact-check
 * step (999.123) and the house-PDF Sources section can cite it verbatim.
 *
 * The file lives in the agent's own workspace next to the client's
 * documents, so it is greppable, editable by hand, backed up with the
 * workspace, and never readable by another agent.
 */

import { mkdir, readFile, rename, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const CLIENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FACT_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const VAULT_FILE = "facts.json";
export const CLIENTS_DIR = "clients";
const MAX_HISTORY = 20;
const MAX_VALUE_CHARS = 500;

export interface ClientFact {
  readonly value: string;
  /** Where the figure comes from: a statement, a form, a conversation, a public reference. */
  readonly source: string;
  /** ISO date the value is true as of (YYYY-MM-DD). */
  readonly asOf: string;
  readonly note?: string;
  readonly setBy: string;
  /** ISO timestamp of the write. */
  readonly setAt: string;
}

export interface ClientVault {
  readonly client: string;
  readonly facts: Readonly<Record<string, ClientFact>>;
  /** Previous values per key, newest first. */
  readonly history: Readonly<Record<string, readonly ClientFact[]>>;
  readonly updatedAt: string | null;
}

export function emptyVault(client: string): ClientVault {
  return Object.freeze({ client, facts: Object.freeze({}), history: Object.freeze({}), updatedAt: null });
}

export function isClientSlug(s: string): boolean {
  return CLIENT_SLUG_RE.test(s);
}

export function isFactKey(s: string): boolean {
  return FACT_KEY_RE.test(s);
}

/** The vault file for a client, guaranteed to sit under `<workspace>/clients/`. */
export function vaultPath(workspace: string, client: string): string {
  if (!isClientSlug(client)) throw new Error(`invalid client slug "${client}" (use lowercase letters, digits, dashes)`);
  const root = resolve(workspace, CLIENTS_DIR);
  const path = resolve(root, client, VAULT_FILE);
  if (!path.startsWith(root + sep)) throw new Error("vault path escapes the clients directory");
  return path;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isFact(v: unknown): v is ClientFact {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.value === "string" &&
    typeof f.source === "string" &&
    typeof f.asOf === "string" &&
    typeof f.setBy === "string" &&
    typeof f.setAt === "string"
  );
}

/** Parse a vault file's JSON; tolerant of hand edits (unknown keys dropped, bad entries skipped). */
export function parseVault(json: string, client: string): ClientVault {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`facts.json for "${client}" is not valid JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyVault(client);
  const r = raw as Record<string, unknown>;
  const facts: Record<string, ClientFact> = {};
  if (r.facts && typeof r.facts === "object" && !Array.isArray(r.facts)) {
    for (const [k, v] of Object.entries(r.facts as Record<string, unknown>)) {
      if (isFactKey(k) && isFact(v)) facts[k] = Object.freeze({ ...v });
    }
  }
  const history: Record<string, readonly ClientFact[]> = {};
  if (r.history && typeof r.history === "object" && !Array.isArray(r.history)) {
    for (const [k, v] of Object.entries(r.history as Record<string, unknown>)) {
      if (isFactKey(k) && Array.isArray(v)) {
        history[k] = Object.freeze(v.filter(isFact).slice(0, MAX_HISTORY).map((f) => Object.freeze({ ...f })));
      }
    }
  }
  return Object.freeze({
    client,
    facts: Object.freeze(facts),
    history: Object.freeze(history),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
  });
}

export async function readVault(workspace: string, client: string): Promise<ClientVault> {
  const path = vaultPath(workspace, client);
  try {
    return parseVault(await readFile(path, "utf8"), client);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyVault(client);
    throw err;
  }
}

export interface SetFactInput {
  readonly key: string;
  readonly value: string;
  readonly source: string;
  readonly asOf: string;
  readonly note?: string;
  readonly setBy: string;
  readonly now?: Date;
}

/** Validate and normalise a fact write; throws with a message the agent can act on. */
export function validateFactInput(input: SetFactInput): ClientFact & { readonly key: string } {
  if (!isFactKey(input.key)) {
    throw new Error(`invalid fact key "${input.key}" (lowercase letters, digits, dots, dashes, underscores; e.g. "aum", "fee.annual", "accounts.401k")`);
  }
  const value = input.value.trim();
  if (value.length === 0 || value.length > MAX_VALUE_CHARS) throw new Error("value must be 1 to 500 characters");
  const source = input.source.trim();
  if (source.length === 0) throw new Error("source is required (statement, form, conversation, public reference)");
  const asOf = input.asOf.trim();
  if (!DATE_RE.test(asOf) || Number.isNaN(Date.parse(asOf))) throw new Error("as_of must be a date, YYYY-MM-DD");
  const note = input.note?.trim();
  return Object.freeze({
    key: input.key,
    value,
    source,
    asOf,
    ...(note ? { note } : {}),
    setBy: input.setBy,
    setAt: (input.now ?? new Date()).toISOString(),
  });
}

/** Pure: a new vault with the fact set and the previous value pushed onto history. */
export function setFact(vault: ClientVault, input: SetFactInput): { vault: ClientVault; previous: ClientFact | null } {
  const { key, ...fact } = validateFactInput(input);
  const previous = vault.facts[key] ?? null;
  const history = { ...vault.history };
  if (previous) history[key] = Object.freeze([previous, ...(vault.history[key] ?? [])].slice(0, MAX_HISTORY));
  return {
    vault: Object.freeze({
      client: vault.client,
      facts: Object.freeze({ ...vault.facts, [key]: fact }),
      history: Object.freeze(history),
      updatedAt: fact.setAt,
    }),
    previous,
  };
}

/** Pure: remove a key (its last value goes to history). */
export function removeFact(vault: ClientVault, key: string, setBy: string, now: Date = new Date()): { vault: ClientVault; removed: ClientFact | null } {
  const removed = vault.facts[key] ?? null;
  if (!removed) return { vault, removed: null };
  const rest = { ...vault.facts };
  delete rest[key];
  const history = { ...vault.history, [key]: Object.freeze([removed, ...(vault.history[key] ?? [])].slice(0, MAX_HISTORY)) };
  return {
    vault: Object.freeze({ client: vault.client, facts: Object.freeze(rest), history: Object.freeze(history), updatedAt: now.toISOString() }),
    removed: { ...removed, setBy },
  };
}

/** Atomic write (tmp + rename) so a half-written vault is never read. */
export async function writeVault(workspace: string, vault: ClientVault): Promise<string> {
  const path = vaultPath(workspace, vault.client);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(vault, null, 2) + "\n");
  await rename(tmp, path);
  return path;
}

/** Clients that have a vault, sorted. */
export async function listClients(workspace: string): Promise<readonly string[]> {
  const root = join(workspace, CLIENTS_DIR);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!isClientSlug(e)) continue;
    try {
      const s = await stat(join(root, e, VAULT_FILE));
      if (s.isFile()) out.push(e);
    } catch {
      /* no vault */
    }
  }
  return out.sort();
}

/** The table an agent reads back. */
export function renderVault(vault: ClientVault): string {
  const keys = Object.keys(vault.facts).sort();
  if (keys.length === 0) return `No facts on file for ${vault.client}.`;
  const lines = [
    `Facts on file for ${vault.client} (${keys.length}):`,
    "",
    "| key | value | source | as of | set by |",
    "|---|---|---|---|---|",
    ...keys.map((k) => {
      const f = vault.facts[k]!;
      const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      return `| ${k} | ${cell(f.value)} | ${cell(f.source)} | ${f.asOf} | ${f.setBy} |` + (f.note ? ` ${cell(f.note)}` : "");
    }),
  ];
  const changed = keys.filter((k) => (vault.history[k]?.length ?? 0) > 0);
  if (changed.length > 0) {
    lines.push("", `Keys with history: ${changed.map((k) => `${k} (${vault.history[k]!.length})`).join(", ")}.`);
  }
  return lines.join("\n");
}

/** Source lines for a document's Sources section. */
export function factsAsSources(vault: ClientVault, keys?: readonly string[]): readonly string[] {
  const chosen = (keys ?? Object.keys(vault.facts)).filter((k) => vault.facts[k]);
  return chosen.sort().map((k) => {
    const f = vault.facts[k]!;
    return `${k}: ${f.value} (${f.source}, as of ${f.asOf})`;
  });
}
