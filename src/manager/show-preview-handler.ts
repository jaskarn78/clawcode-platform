/**
 * Backlog 999.95 — `show-preview` IPC handler, extracted from daemon.ts so the
 * core path the operator exercises (html/url discrimination, id-gen, Layer-2
 * validation, isNew→post / else no-post) is unit-testable in isolation with a
 * mocked store + launcher. The daemon's closure-intercept switch delegates here.
 */

import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { ManagerError } from "../shared/errors.js";
import {
  PreviewStore,
  isValidPreviewUrl,
  MAX_PREVIEW_BYTES,
  type PreviewEntry,
} from "../dashboard/preview-store.js";
import type { SnapshotInput } from "./preview-snapshot.js";

/**
 * Minimal launcher surface the handler needs — keeps it unit-testable without
 * constructing a full DiscordBridge. `DiscordBridge.postActivityLaunchButton`
 * structurally satisfies this.
 */
export interface ActivityLauncher {
  /**
   * 999.95-fu2 — mint the embedded-Activity invite URL without posting a
   * message, so the launch can ride on the snapshot rather than arriving as a
   * second post. Optional: an older bridge without it simply yields no button.
   */
  createActivityInviteUrl?(agent: string): Promise<string | undefined>;
  postActivityLaunchButton(args: {
    readonly agent: string;
    readonly previewId: string;
    readonly previewUrl: string;
  }): Promise<{ readonly ok: boolean; readonly reason?: string }>;
}

/**
 * 999.95-fu (2026-09-02) — inline snapshot surface. `render` produces a PNG of
 * the preview (null = unavailable/failed, fail-soft); `deliver` posts it to the
 * agent's channel, EDITING the previous snapshot message on id reuse so a
 * hot-reload updates the image in place instead of spamming the channel.
 */
export interface PreviewSnapshotter {
  /** 999.95-fu2 — motion tier: auto-playing mp4 tour of the live page. */
  renderMotion?(input: SnapshotInput): Promise<{ buffer: Buffer; filename: string } | null>;
  render(input: SnapshotInput): Promise<Buffer | null>;
  deliver(args: {
    readonly agent: string;
    readonly previewId: string;
    readonly media: Buffer;
    readonly filename: string;
    readonly caption: string;
    readonly links?: readonly { readonly label: string; readonly url: string }[];
  }): Promise<{ readonly ok: boolean; readonly reason?: string }>;
}

export type ShowPreviewDeps = {
  readonly previewStore: PreviewStore;
  /** null when the Discord bridge is not yet bound — preview push still works. */
  readonly launcher: ActivityLauncher | null;
  /** e.g. "https://activity.example-user.me" (env CLAWCODE_ACTIVITY_BASE_URL); "" ok. */
  readonly activityBaseUrl: string;
  /**
   * 999.95-fu3 — the Discord channel this agent is bound to. Scopes the push
   * so one channel's preview never surfaces in another channel's Activity.
   * Undefined for an agent with no binding: the preview is still stored and
   * reachable by id, it just never becomes any channel's `current`.
   */
  readonly agentChannelId?: string;
  readonly log: Logger;
  /**
   * 999.95-fu — null/omitted preserves the pre-snapshot behavior exactly
   * (launch affordance only). Operator feedback that drove this: the Activity
   * launch is too slow as the ONLY way to view a preview.
   */
  readonly snapshot?: PreviewSnapshotter | null;
};

export type ShowPreviewResult = {
  readonly ok: true;
  readonly id: string;
  readonly isNew: boolean;
  readonly previewUrl: string;
  readonly posted: boolean;
  /** 999.95-fu — true when an inline PNG snapshot reached the channel. */
  readonly snapshotPosted: boolean;
};

/** `/preview/current` is the self-resolve pointer route — an explicit id of
 *  "current" would be shadowed by it, so it is reserved. */
const RESERVED_PREVIEW_IDS = new Set(["current"]);

export async function handleShowPreview(
  params: Record<string, unknown>,
  deps: ShowPreviewDeps,
): Promise<ShowPreviewResult> {
  const agent = requireStringParam(params, "agent");

  const hasHtml = typeof params.html === "string" && params.html.length > 0;
  const hasUrl = typeof params.url === "string" && params.url.length > 0;
  if (hasHtml === hasUrl) {
    throw new ManagerError("show-preview requires exactly one of `html` or `url`");
  }

  const id =
    typeof params.id === "string" && params.id.length > 0
      ? params.id
      : `p-${nanoid(10)}`;
  if (!PreviewStore.isValidId(id)) {
    throw new ManagerError("invalid preview id");
  }
  if (RESERVED_PREVIEW_IDS.has(id)) {
    throw new ManagerError(`'${id}' is a reserved preview id`);
  }

  let entry: PreviewEntry;
  if (hasHtml) {
    const html = params.html as string;
    if (Buffer.byteLength(html, "utf8") > MAX_PREVIEW_BYTES) {
      throw new ManagerError(`preview HTML exceeds ${MAX_PREVIEW_BYTES} bytes`);
    }
    entry = { kind: "html", html };
  } else {
    const url = params.url as string;
    if (!isValidPreviewUrl(url)) {
      throw new ManagerError(
        "invalid preview url (expected http(s):// or a /relative path)",
      );
    }
    entry = { kind: "url", url };
  }

  // 999.95-fu3 — tag the push with the agent's bound channel so it only ever
  // resolves as THAT channel's `current`.
  const { isNew } = deps.previewStore.set(id, entry, deps.agentChannelId);

  // Public URL resolves through the activity proxy; base from env, never
  // hardcoded. Empty base → a relative path the operator can still use.
  const base = deps.activityBaseUrl.replace(/\/+$/, "");
  const previewUrl = `${base}/preview/${id}`;

  // ── 999.95-fu: inline snapshot, EVERY push (new posts, reuse edits) ──
  // Snapshot FIRST — operator feedback (2026-09-02): "I don't want to see
  // links to the ClawdyCode activity." The launch affordance is now a
  // FALLBACK, posted only when no snapshot landed (and only on the first
  // push of an id — later pushes hot-reload the open preview via SSE).
  let posted = false;
  let snapshotPosted = false;
  if (deps.snapshot) {
    try {
      const input: SnapshotInput =
        entry.kind === "html"
          ? { kind: "html", html: entry.html }
          : {
              kind: "url",
              // Relative preview paths render through the activity proxy.
              url: entry.url.startsWith("/") && base ? `${base}${entry.url}` : entry.url,
            };
      // Motion first (auto-playing tour), PNG second, button-only last.
      let media: Buffer | null = null;
      let filename = `preview-${id}.png`;
      let icon = "📸";
      if (deps.snapshot.renderMotion) {
        const motion = await deps.snapshot.renderMotion(input);
        if (motion) {
          media = motion.buffer;
          filename = `preview-${id}.mp4`;
          icon = "🎬";
        }
      }
      if (!media) {
        media = await deps.snapshot.render(input);
      }
      if (media) {
        // The agent's own answer is the caption when it supplied one — an
        // image with no words beside it is not an answer (operator, 2026-09-02).
        const authored = typeof params.caption === "string" ? params.caption.trim() : "";
        const caption = authored.length > 0 ? authored.slice(0, 1900) : `${icon} **${agent}** preview`;
        // 999.95-fu2 — hang the real Discord Activity launch on the snapshot.
        //
        // The 2026-09-02 rework made the launch affordance a fallback that
        // only fired when the snapshot FAILED; since the motion tier lands
        // reliably it stopped appearing entirely, taking the live interactive
        // preview with it. The objection then was to a second message
        // carrying a link — not to the Activity itself. An embedded-app
        // invite is an ordinary https URL, so it can be a button on the
        // snapshot: one message, and it still opens inside Discord.
        //
        // First position, so it survives the 5-button cap ahead of any
        // agent-supplied links.
        const agentLinks = sanitizeLinks(params.links);
        let links = agentLinks;
        if (deps.launcher?.createActivityInviteUrl) {
          try {
            const inviteUrl = await deps.launcher.createActivityInviteUrl(agent);
            if (inviteUrl) {
              links = [
                { label: "🪟 Open Live Preview", url: inviteUrl },
                ...agentLinks,
              ].slice(0, 5);
            }
          } catch (err) {
            // Never let a decoration cost the snapshot.
            deps.log.warn(
              {
                agent,
                previewId: id,
                error: err instanceof Error ? err.message : String(err),
              },
              "activity invite for snapshot failed (posting snapshot without it)",
            );
          }
        }
        const delivered = await deps.snapshot.deliver({
          agent, previewId: id, media, filename, caption,
          ...(links.length > 0 ? { links } : {}),
        });
        snapshotPosted = delivered.ok;
        if (!delivered.ok) {
          deps.log.warn(
            { agent, previewId: id, reason: delivered.reason },
            "preview snapshot not delivered",
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log.warn({ agent, previewId: id, error: msg }, "preview snapshot threw");
    }
  }

  if (isNew && deps.launcher && !snapshotPosted) {
    posted = await postLaunchAffordance(deps.launcher, agent, id, previewUrl, deps.log);
  }

  return { ok: true, id, isNew, previewUrl, posted, snapshotPosted };
}

/**
 * Agent-supplied link buttons are untrusted input heading for a Discord
 * component: allow https only, cap the count and label length, and drop
 * anything malformed rather than failing the whole push.
 */
function sanitizeLinks(
  raw: unknown,
): readonly { readonly label: string; readonly url: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; url: string }[] = [];
  for (const item of raw) {
    if (out.length >= 5) break;
    if (!item || typeof item !== "object") continue;
    const label = String((item as { label?: unknown }).label ?? "").trim().slice(0, 80);
    const url = String((item as { url?: unknown }).url ?? "").trim();
    if (!label || url.length > 512) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    out.push({ label, url });
  }
  return out;
}

/** Non-fatal — any Discord failure is logged and returns false so a posting
 *  hiccup never fails the preview push itself. */
async function postLaunchAffordance(
  launcher: ActivityLauncher,
  agent: string,
  previewId: string,
  previewUrl: string,
  log: Logger,
): Promise<boolean> {
  try {
    const result = await launcher.postActivityLaunchButton({
      agent,
      previewId,
      previewUrl,
    });
    if (!result.ok) {
      log.warn(
        { agent, previewId, reason: result.reason },
        "activity launch affordance not posted",
      );
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ agent, previewId, error: msg }, "activity launch affordance threw");
    return false;
  }
}

function requireStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ManagerError(`Missing required parameter: ${key}`);
  }
  return value;
}
