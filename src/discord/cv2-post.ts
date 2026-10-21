/**
 * 999.135 — post / edit a Components-v2 card that carries attachment files.
 *
 * The bot-identity path is the ONLY one proven end-to-end for CV2 + files
 * (raw REST `client.rest.post(route, {body, files})`, mirroring
 * `postCv2ToAgentChannel` / `postLedgerCard`). The agent-webhook identity path
 * is behind a flag with an UNCONDITIONAL fallback to bot identity.
 *
 * ⚠ M0 SPIKE OUTSTANDING (2026-09-06): whether Execute-Webhook accepts
 * `files[n]` under `IS_COMPONENTS_V2` is UNVERIFIED — this lane cannot post to
 * a real channel. Discord docs are ambiguous (a CV2 webhook message "can only
 * contain components"; `files[n]` "will fail with a 400"). So `identity`
 * defaults to `"bot"`, the webhook attempt is wrapped in try/catch, and ANY
 * failure falls back to a byte-identical bot post. When the spike runs: a 200
 * greenlights `identity:"agent"` as a default; a 400 keeps it documented-dead.
 *
 * Invariants (advisor #4/#5):
 *   - the POST body equals `buildCv2Payload(spec)` (+ an optional reply ref)
 *     and nothing else — NEVER `attachments: []` (that drops the files);
 *   - the EDIT body adds `attachments: []` (the image-swap idiom that removes
 *     prior files and shows only the fresh render);
 *   - every `attachment://<name>` in the spec must have a matching file in the
 *     same call — otherwise Discord 400s. We cross-check and fail closed with a
 *     reason rather than shipping a broken payload.
 */
import { Routes } from "discord.js";
import { buildCv2Payload, cv2ToPlainText, referencedAttachments, type Cv2Spec } from "./cv2-renderer.js";
import type { OutboundFile } from "./table-delivery.js";

/** The slice of `@discordjs/rest` this module needs (unit-testable). */
export type RestLike = {
  post(route: string, opts: { body: unknown; files?: readonly { name: string; data: Buffer }[] }): Promise<unknown>;
  patch(route: string, opts: { body: unknown; files?: readonly { name: string; data: Buffer }[] }): Promise<unknown>;
  /** Optional — used to clean up a superseded pinned message on re-pin. */
  delete?(route: string): Promise<unknown>;
};

export type WebhookLike = { send(payload: unknown, opts?: unknown): Promise<{ id: string }> };

type LogLike = {
  warn(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
};

const IS_COMPONENTS_V2 = 1 << 15;
const EPHEMERAL = 64;

function toRawFile(f: OutboundFile): { name: string; data: Buffer } {
  return { name: f.name, data: f.attachment };
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number } | null;
  if (e && typeof e.status === "number") return e.status;
  if (e && typeof e.code === "number") return e.code;
  return undefined;
}

/**
 * Discord edit semantics: `attachments` is the COMPLETE list to keep after the
 * edit. Listing exactly the freshly uploaded files (`id` = multipart index)
 * binds the `attachment://<name>` references AND drops every previous
 * attachment. An empty array discards the uploads themselves, which made every
 * media reference fail with a 400 in prod (2026-09-06).
 */
function attachmentList(
  files: readonly OutboundFile[],
): readonly { readonly id: number; readonly filename: string; readonly description?: string }[] {
  return files.map((f, i) => ({
    id: i,
    filename: f.name,
    ...(f.description ? { description: f.description } : {}),
  }));
}

/**
 * Diagnostic fields from a discord.js `DiscordAPIError` / REST error: HTTP
 * status, Discord error code, its generic message and the FIRST offending
 * field path (e.g. `components.0.components.4.items.0.media.url`). Never any
 * payload content.
 */
function describeDiscordError(err: unknown): {
  readonly status?: number;
  readonly code?: number;
  readonly message?: string;
  readonly path?: string;
} {
  const e = err as {
    status?: number;
    code?: number | string;
    message?: string;
    rawError?: { code?: number; message?: string; errors?: Record<string, unknown> };
  } | null;
  if (!e || typeof e !== "object") return {};
  const errors = e.rawError?.errors;
  return {
    status: typeof e.status === "number" ? e.status : undefined,
    code: typeof e.rawError?.code === "number" ? e.rawError.code : typeof e.code === "number" ? e.code : undefined,
    message: e.rawError?.message ?? (typeof e.message === "string" ? e.message.slice(0, 120) : undefined),
    path: errors && typeof errors === "object" ? firstErrorPath(errors) : undefined,
  };
}

function firstErrorPath(errors: Record<string, unknown>, prefix = "", depth = 0): string | undefined {
  if (depth > 8) return prefix || undefined;
  for (const [key, value] of Object.entries(errors)) {
    if (key === "_errors") return prefix || undefined;
    if (value && typeof value === "object") {
      return firstErrorPath(value as Record<string, unknown>, prefix ? `${prefix}.${key}` : key, depth + 1);
    }
  }
  return prefix || undefined;
}

/** The interaction surface `deliverCv2Ephemeral` needs (button/select/slash all satisfy it). */
export type InteractionLike = {
  readonly applicationId: string;
  readonly token: string;
  followUp(options: unknown): Promise<unknown>;
};

/**
 * Deliver a CV2 view to an ALREADY-DEFERRED ephemeral interaction, never
 * leaving it unanswered. Per Discord docs a DEFERRED response may carry ONLY
 * the EPHEMERAL flag — the IsComponentsV2 flag (32768) is set here, on the
 * @original EDIT, which is the documented way to create a CV2 interaction
 * message. Hop order:
 *   (a) raw-REST edit of @original with `flags:32768` + components + files;
 *   (b) on any failure → a discord.js `followUp` carrying the IsComponentsV2
 *       flag (followups accept it per the docs);
 *   (c) on any failure → a plain-text ephemeral `followUp` flattened from the
 *       same spec. Each hop logs `tag:"cv2-post"` + the status code (no bodies).
 */
export async function deliverCv2Ephemeral(args: {
  readonly rest: RestLike;
  readonly interaction: InteractionLike;
  readonly spec: Cv2Spec;
  readonly files: readonly OutboundFile[];
  readonly log: LogLike;
}): Promise<void> {
  const { rest, interaction, spec, files, log } = args;
  const payload = buildCv2Payload(spec);
  try {
    await rest.patch(Routes.webhookMessage(interaction.applicationId, interaction.token, "@original"), {
      body: { flags: payload.flags, components: payload.components, attachments: attachmentList(files) },
      files: files.map(toRawFile),
    });
    return;
  } catch (errA) {
    log.warn({ tag: "cv2-post", ...describeDiscordError(errA) }, "cv2 @original edit failed — discord.js followUp fallback");
  }
  try {
    await interaction.followUp({
      flags: IS_COMPONENTS_V2 | EPHEMERAL,
      components: payload.components,
      files: files.map((f) => ({ attachment: f.attachment, name: f.name, description: f.description })),
    });
    return;
  } catch (errB) {
    log.warn({ tag: "cv2-post", ...describeDiscordError(errB) }, "cv2 followUp failed — plaintext fallback");
  }
  try {
    await interaction.followUp({ content: cv2ToPlainText(spec), flags: EPHEMERAL });
  } catch (errC) {
    log.warn({ tag: "cv2-post", ...describeDiscordError(errC) }, "plaintext followUp failed — interaction left unanswered");
  }
}

/** Missing attachment name, or null when every reference is backed by a file. */
function missingAttachment(spec: Cv2Spec, files: readonly OutboundFile[]): string | null {
  const have = new Set(files.map((f) => f.name));
  for (const name of referencedAttachments(spec)) {
    if (!have.has(name)) return name;
  }
  return null;
}

function extractMessageId(res: unknown): string | undefined {
  if (res && typeof res === "object" && "id" in res) {
    const id = (res as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

export type PostCv2Result =
  | { readonly ok: true; readonly messageId: string; readonly identity: "bot" | "agent" }
  | { readonly ok: false; readonly reason: string };

/**
 * Post a CV2 card + files to a channel. Tries agent-webhook identity when
 * asked and available; falls back to bot identity on any failure.
 */
export async function postCv2WithFiles(args: {
  readonly rest: RestLike;
  readonly channelId: string;
  readonly spec: Cv2Spec;
  readonly files: readonly OutboundFile[];
  readonly identity?: "bot" | "agent";
  readonly webhook?: WebhookLike;
  readonly replyToMessageId?: string;
  readonly log: LogLike;
}): Promise<PostCv2Result> {
  const { rest, channelId, spec, files, webhook, replyToMessageId, log } = args;
  const identity = args.identity ?? "bot";

  let payload: ReturnType<typeof buildCv2Payload>;
  try {
    payload = buildCv2Payload(spec);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const missing = missingAttachment(spec, files);
  if (missing) return { ok: false, reason: `missing attachment: ${missing}` };

  // Agent-webhook identity — best effort, unconditional fallback to bot.
  if (identity === "agent" && webhook) {
    try {
      const res = await webhook.send(
        {
          flags: IS_COMPONENTS_V2,
          components: payload.components,
          files: files.map(toRawFile),
          ...(replyToMessageId ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } } : {}),
        },
        { query: { with_components: true } },
      );
      const id = extractMessageId(res);
      if (id) return { ok: true, messageId: id, identity: "agent" };
      log.warn({ channelId }, "cv2 agent-webhook post returned no id — falling back to bot");
    } catch (err) {
      log.warn({ channelId, error: err instanceof Error ? err.message : String(err) }, "cv2 agent-webhook post failed — falling back to bot");
    }
  }

  // Bot identity — the proven path. Body === buildCv2Payload(spec) (+reply ref).
  const body = {
    ...payload,
    ...(replyToMessageId
      ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false }, allowed_mentions: { parse: [] as string[] } }
      : {}),
  };
  try {
    const res = await rest.post(Routes.channelMessages(channelId), { body, files: files.map(toRawFile) });
    const id = extractMessageId(res);
    if (!id) return { ok: false, reason: "bot post returned no message id" };
    return { ok: true, messageId: id, identity: "bot" };
  } catch (err) {
    log.warn({ channelId, error: err instanceof Error ? err.message : String(err) }, "cv2 bot post failed");
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Edit a previously-posted CV2 card in place (bot identity). Image-swap idiom:
 * `attachments` lists exactly the fresh uploads (see `attachmentList`), which
 * binds their `attachment://` references and drops every prior file. A
 * chart-free edit passes `files: []` (→ `attachments: []`, dropping all) — but
 * the spec must then hold no `attachment://` reference (cross-checked; fails
 * closed otherwise).
 */
export async function editCv2Message(args: {
  readonly rest: RestLike;
  readonly channelId: string;
  readonly messageId: string;
  readonly spec: Cv2Spec;
  readonly files: readonly OutboundFile[];
  readonly log: LogLike;
}): Promise<{ ok: boolean; reason?: string }> {
  const { rest, channelId, messageId, spec, files, log } = args;
  let payload: ReturnType<typeof buildCv2Payload>;
  try {
    payload = buildCv2Payload(spec);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const missing = missingAttachment(spec, files);
  if (missing) return { ok: false, reason: `missing attachment: ${missing}` };
  try {
    await rest.patch(Routes.channelMessage(channelId, messageId), {
      body: { ...payload, attachments: attachmentList(files) },
      files: files.map(toRawFile),
    });
    return { ok: true };
  } catch (err) {
    log.warn({ channelId, messageId, ...describeDiscordError(err) }, "cv2 edit failed");
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
