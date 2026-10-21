/**
 * 999.95 — live HTML preview store + per-id SSE registry.
 *
 * An agent pushes HTML (or a URL) from a turn via the `show_preview` tool →
 * IPC `show-preview` → daemon → `PreviewStore.set()`. The dashboard server
 * (src/dashboard/server.ts) serves the stored content at `/preview/<id>` with
 * an injected live-reload client, and exposes a per-id SSE stream at
 * `/preview/<id>/events` that fires a `reload` event whenever the same id is
 * re-pushed. The clawdy-activity Discord Embedded App proxies `/preview*` to
 * this server (cookie-gated), so the operator sees the preview live in Discord.
 *
 * Dependency-free on purpose: the daemon constructs one instance early and
 * injects it into `startDashboardServer` (the routes register SSE responses
 * into it; the daemon handler pushes into it). No SseManager reuse — that
 * broadcasts to one global client set on a poll timer, which would fan every
 * preview's reload to every dashboard tab and couple preview lifecycle to the
 * status poll. A per-id `Map<id, Set<res>>` fired event-driven keeps each
 * preview isolated.
 */

import type { ServerResponse } from "node:http";

/** id charset — blocks path traversal, URL-injection, and script-injection when
 *  interpolated into the injected `<script>` SSE path. */
export const PREVIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Hard cap on stored HTML (256 KiB). Enforced here AND in the MCP tool (zod
 *  `.max`) AND the daemon handler (`Buffer.byteLength`) — IPC has no frame cap,
 *  so these are the real defense against unbounded daemon-side buffering. */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/** LRU cap on concurrent previews — oldest is evicted (and its listeners
 *  closed) on overflow. */
export const MAX_PREVIEWS = 32;

/** `currentId()` only resolves a preview pushed within this window. A tap on
 *  the launch button right after a push lands on the fresh preview; a cold
 *  Activity open minutes later falls back to the dashboard instead of
 *  resurfacing a stale preview. */
export const DEFAULT_CURRENT_MAX_AGE_MS = 120_000;

/** Shared keepalive cadence — a change-only SSE stream can sit idle and be
 *  dropped by the Express reverse-proxy; a `:keepalive` comment keeps it open. */
const KEEPALIVE_MS = 20_000;

/** Stored preview content — either inline HTML or a URL to frame. */
export type PreviewEntry =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "url"; readonly url: string };

type StoredEntry = {
  readonly entry: PreviewEntry;
  readonly updatedAt: number;
  /**
   * 999.95-fu3 — the Discord channel the pushing agent is bound to. Absent for
   * a preview pushed by an agent with no channel binding; such a preview is
   * still retrievable by id but never resolves as any channel's `current`.
   */
  readonly channelId?: string;
};

export type PushResult = { readonly isNew: boolean; readonly id: string };

/**
 * url-variant validation. Accepts same-origin relative paths (which resolve
 * through the activity proxy — the only reliably-frameable kind inside the
 * Activity sandbox) or absolute http(s) URLs (best-effort; cross-origin may be
 * CSP-blocked in the Activity iframe). Rejects `javascript:`/`data:` and
 * protocol-relative `//host` forms.
 */
export function isValidPreviewUrl(url: string): boolean {
  if (url.length === 0 || url.length > 2048) return false;
  if (url.startsWith("//")) return false; // protocol-relative — ambiguous origin
  if (url.startsWith("/")) return true; // same-origin relative path
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Wrap stored content with the live-reload SSE client. The EventSource URL is
 * an ABSOLUTE same-origin path computed from the (regex-validated) id —
 * `/preview/<id>/events`. Absolute, not `./events`: a document served at
 * `/preview/<id>` (no trailing slash) would resolve `./events` to
 * `/preview/events` (wrong id). The absolute path resolves correctly through
 * the `activity.example.com` proxy regardless of trailing slash.
 */
export function renderPreviewDocument(entry: PreviewEntry, id: string): string {
  const eventsPath = JSON.stringify(`/preview/${id}/events`);
  const reloadScript =
    `<script>(function(){try{` +
    `var es=new EventSource(${eventsPath});` +
    `es.addEventListener("reload",function(){location.reload();});` +
    `}catch(e){}})();</script>`;

  if (entry.kind === "url") {
    const safeUrl = escapeHtmlAttr(entry.url);
    return (
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Live preview</title>` +
      `<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100vh;display:block}</style>` +
      `</head><body><iframe src="${safeUrl}" title="Live preview"></iframe>${reloadScript}</body></html>`
    );
  }

  const { html } = entry;
  // Function replacement → no `$`-pattern interpretation of the script string.
  return html.includes("</body>")
    ? html.replace("</body>", () => `${reloadScript}</body>`)
    : `${html}${reloadScript}`;
}

/**
 * In-memory preview store. Previews are ephemeral live surfaces; a daemon
 * restart clears them (→ `currentId()` returns null → Activity shows its empty
 * state). If durability is ever needed, swap the `Map` for a better-sqlite3
 * table behind this same interface — no route/tool changes required.
 */
export class PreviewStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly listeners = new Map<string, Set<ServerResponse>>();
  /**
   * 999.95-fu3 — most-recent preview PER DISCORD CHANNEL.
   *
   * There was previously a single global `mostRecentId`, set by every push
   * from every agent, and `/preview/current` returned it to whoever asked. So
   * opening the Activity from ANY channel surfaced whichever agent pushed
   * last — client-a-personal's preview could appear in #shopping's Activity and
   * vice versa. For an agent that handles client PII that is a confidentiality
   * problem, not a UX one.
   *
   * The store now keys the most-recent pointer by the channel the pushing
   * agent is bound to, so each channel's Activity resolves only its own.
   */
  private readonly mostRecentByChannel = new Map<string, string>();
  private readonly keepaliveTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  /** `now` is injectable purely for deterministic time-box tests. */
  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.keepaliveTimer = setInterval(() => {
      for (const set of this.listeners.values()) {
        for (const res of set) res.write(":keepalive\n\n");
      }
    }, KEEPALIVE_MS);
    // Never let the keepalive timer keep the process alive.
    this.keepaliveTimer.unref?.();
  }

  static isValidId(id: string): boolean {
    return PREVIEW_ID_RE.test(id);
  }

  /**
   * Store/replace content for `id` and fire a `reload` to that id's listeners.
   * Throws on invalid id or oversize HTML (the handler maps to a ManagerError).
   */
  set(id: string, entry: PreviewEntry, channelId?: string): PushResult {
    if (!PreviewStore.isValidId(id)) throw new Error("invalid preview id");
    if (
      entry.kind === "html" &&
      Buffer.byteLength(entry.html, "utf8") > MAX_PREVIEW_BYTES
    ) {
      throw new Error(`preview HTML exceeds ${MAX_PREVIEW_BYTES} bytes`);
    }

    const isNew = !this.entries.has(id);
    // Refresh insertion order so the Map doubles as an LRU.
    const previous = this.entries.get(id);
    this.entries.delete(id);
    // A re-push may omit the channel (an id-reuse edit); keep the one the
    // preview was first stored under rather than orphaning it.
    const channel = channelId ?? previous?.channelId;
    this.entries.set(id, {
      entry,
      updatedAt: this.now(),
      ...(channel !== undefined ? { channelId: channel } : {}),
    });
    if (channel !== undefined) this.mostRecentByChannel.set(channel, id);

    if (this.entries.size > MAX_PREVIEWS) {
      const oldestId = this.entries.keys().next().value as string;
      const oldest = this.entries.get(oldestId);
      this.entries.delete(oldestId);
      this.closeListeners(oldestId);
      // Clear the channel pointer too, or `current` resolves an evicted id.
      if (oldest?.channelId !== undefined &&
          this.mostRecentByChannel.get(oldest.channelId) === oldestId) {
        this.mostRecentByChannel.delete(oldest.channelId);
      }
    }

    this.fireReload(id);
    return { isNew, id };
  }

  get(id: string): PreviewEntry | null {
    return this.entries.get(id)?.entry ?? null;
  }

  /**
   * The most-recently-pushed id, but only if pushed within `maxAgeMs` — see
   * DEFAULT_CURRENT_MAX_AGE_MS. Returns null otherwise so a cold Activity open
   * falls back to the dashboard rather than a stale preview.
   */
  currentId(
    channelId: string | null,
    maxAgeMs: number = DEFAULT_CURRENT_MAX_AGE_MS,
  ): string | null {
    // FAIL CLOSED on a missing channel. The live Activity client asks for the
    // channel-scoped id first and falls back to an unscoped call; if that
    // fallback returned the global most-recent we would have re-opened the
    // exact cross-channel leak this scoping exists to close. A caller that
    // cannot say which channel it is gets nothing.
    if (channelId === null || channelId === "") return null;
    const id = this.mostRecentByChannel.get(channelId);
    if (id === undefined) return null;
    const stored = this.entries.get(id);
    if (!stored) return null;
    if (this.now() - stored.updatedAt > maxAgeMs) return null;
    return id;
  }

  /**
   * Register an SSE client for `id`. Mirrors SseManager's connection mechanics
   * (text/event-stream headers, leading `:keepalive`, `res.on("close")`
   * cleanup) but scoped per-id. The route hands the response off here and does
   * not write to it again.
   */
  addListener(id: string, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":keepalive\n\n");

    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(res);

    res.on("close", () => {
      const current = this.listeners.get(id);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) this.listeners.delete(id);
    });
  }

  private fireReload(id: string): void {
    const set = this.listeners.get(id);
    if (!set) return;
    const payload = `event: reload\ndata: ${JSON.stringify({ id, ts: this.now() })}\n\n`;
    for (const res of set) res.write(payload);
  }

  private closeListeners(id: string): void {
    const set = this.listeners.get(id);
    if (!set) return;
    for (const res of set) {
      try {
        res.end();
      } catch {
        // already closed — nothing to do
      }
    }
    this.listeners.delete(id);
  }

  /** Stop the keepalive timer and end all open streams (daemon shutdown). */
  close(): void {
    clearInterval(this.keepaliveTimer);
    for (const id of [...this.listeners.keys()]) this.closeListeners(id);
  }
}
