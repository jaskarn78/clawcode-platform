/**
 * Discord Components v2 (CV2) renderer.
 *
 * Pure builder that converts an operator-friendly spec into the raw Discord
 * API payload shape `{ flags, components }`. discord.js v14 forwards the
 * payload verbatim when `flags: MessageFlags.IsComponentsV2` is set; the
 * shape matches Discord's documented component types (Container=17,
 * TextDisplay=10, Separator=14).
 *
 * Used by the `post_cv2_embed` MCP tool path:
 *   MCP tool (src/mcp/server.ts)
 *     → IPC `post-cv2-embed` (src/manager/daemon.ts)
 *       → bridge.postCv2ToAgentChannel (src/discord/bridge.ts)
 *         → channel.send(buildCv2Payload(spec))
 *
 * Dual-post note: agents that call `post_cv2_embed` then `clawcode_ack`
 * with empty `result` get NO follow-up text post — the existing skip at
 * bridge.ts (`response.trim().length > 0`) already covers that case. So
 * no new daemon plumbing is needed to suppress the ack's text follow-up.
 *
 * 999.135 — additively extended with Section(9), MediaGallery(12), File(13)
 * and ActionRow(1) blocks (emitters in `cv2-blocks.ts`) for rich cards
 * and dashboards. The original text/separator paths are byte-identical, so
 * `cv2-renderer.test.ts` / `bridge-cv2.test.ts` pass unchanged. Two new
 * whole-payload validators enforce Discord's REAL limits (total text ≤4000
 * across all text components; flattened component count ≤40) that the
 * per-block checks miss once Section/ActionRow nest.
 */
import { MessageFlags } from "discord.js";
import {
  Cv2ValidationError,
  emitActions,
  emitFile,
  emitMedia,
  emitSection,
  type Cv2Accessory,
  type Cv2Action,
  type Cv2MediaItem,
  type RawActionRow,
  type RawFileComponent,
  type RawMediaGallery,
  type RawSection,
} from "./cv2-blocks.js";

export { Cv2ValidationError };
export type { Cv2Action, Cv2Button, Cv2Accessory, Cv2MediaItem, Cv2SelectOption } from "./cv2-blocks.js";

/** Operator-friendly CV2 spec — what the agent emits to the MCP tool. */
export type Cv2Spec = {
  /** Container left-bar color (hex int, e.g. 0x5865F2). Optional. */
  readonly accentColor?: number;
  /** Sequential blocks inside the single Container. */
  readonly blocks: ReadonlyArray<Cv2Block>;
};

export type Cv2Block =
  | { readonly type: "text"; readonly content: string }
  | {
      readonly type: "separator";
      readonly divider?: boolean;
      readonly spacing?: 1 | 2;
    }
  | { readonly type: "section"; readonly text: readonly string[]; readonly accessory: Cv2Accessory }
  | { readonly type: "media"; readonly items: readonly Cv2MediaItem[] }
  | { readonly type: "file"; readonly filename: string }
  | { readonly type: "actions"; readonly components: readonly Cv2Action[] };

/** Raw Discord API payload (passed verbatim to channel.send / rest.post). */
export type Cv2Payload = {
  readonly flags: number;
  readonly components: ReadonlyArray<Cv2Container>;
};

type Cv2Container = {
  readonly type: 17;
  readonly accent_color?: number;
  readonly components: ReadonlyArray<Cv2InnerComponent>;
};

type Cv2InnerComponent =
  | { readonly type: 10; readonly content: string }
  | {
      readonly type: 14;
      readonly divider: boolean;
      readonly spacing: 1 | 2;
    }
  | RawSection
  | RawMediaGallery
  | RawFileComponent
  | RawActionRow;

/** Hard limits from Discord's CV2 documentation. */
const MAX_BLOCKS_PER_CONTAINER = 40;
const MAX_TEXT_BLOCK_CHARS = 4000;
const MAX_TOTAL_TEXT_CHARS = 4000;
const MAX_FLATTENED_COMPONENTS = 40;

/**
 * Convert an operator-friendly spec to the raw Discord send payload.
 * Throws `Cv2ValidationError` on any violation of Discord's limits.
 */
export function buildCv2Payload(spec: Cv2Spec): Cv2Payload {
  if (!spec || typeof spec !== "object") {
    throw new Cv2ValidationError("spec must be an object");
  }
  if (!Array.isArray(spec.blocks)) {
    throw new Cv2ValidationError("spec.blocks must be an array");
  }
  if (spec.blocks.length === 0) {
    throw new Cv2ValidationError("spec.blocks must not be empty");
  }
  if (spec.blocks.length > MAX_BLOCKS_PER_CONTAINER) {
    throw new Cv2ValidationError(
      `spec.blocks has ${spec.blocks.length} items; Discord allows at most ${MAX_BLOCKS_PER_CONTAINER} per container`,
    );
  }
  if (spec.accentColor !== undefined) {
    if (
      typeof spec.accentColor !== "number" ||
      !Number.isInteger(spec.accentColor) ||
      spec.accentColor < 0 ||
      spec.accentColor > 0xffffff
    ) {
      throw new Cv2ValidationError(
        "spec.accentColor must be an integer between 0 and 0xFFFFFF",
      );
    }
  }

  const innerComponents: Cv2InnerComponent[] = spec.blocks.map((block, idx) =>
    renderBlock(block, idx),
  );

  // Whole-payload budgets — the checks the per-block limits miss once
  // Section/ActionRow nest. Gated on the presence of a NEW block type: the
  // pre-existing text/separator-only surfaces (the verification ledger card,
  // `post_cv2_embed`) predate these documented totals and are known-good in
  // production, so exempting them keeps their behavior byte-identical while the
  // richer cards get Discord's real limits. Run last so per-block
  // errors surface first.
  if (hasRichBlock(spec.blocks)) {
    const totalText = totalTextChars(spec.blocks);
    if (totalText > MAX_TOTAL_TEXT_CHARS) {
      throw new Cv2ValidationError(
        `total text is ${totalText} chars; Discord allows at most ${MAX_TOTAL_TEXT_CHARS} across all text components`,
      );
    }
    const flattened = flattenedCount(spec.blocks);
    if (flattened > MAX_FLATTENED_COMPONENTS) {
      throw new Cv2ValidationError(
        `payload has ${flattened} components; Discord allows at most ${MAX_FLATTENED_COMPONENTS} total`,
      );
    }
  }

  const container: Cv2Container = {
    type: 17,
    ...(spec.accentColor !== undefined ? { accent_color: spec.accentColor } : {}),
    components: innerComponents,
  };

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  };
}

function renderBlock(block: Cv2Block, idx: number): Cv2InnerComponent {
  if (block.type === "text") {
    if (typeof block.content !== "string") {
      throw new Cv2ValidationError(`block[${idx}].content must be a string`);
    }
    if (block.content.length === 0) {
      throw new Cv2ValidationError(`block[${idx}].content must not be empty`);
    }
    if (block.content.length > MAX_TEXT_BLOCK_CHARS) {
      throw new Cv2ValidationError(
        `block[${idx}].content is ${block.content.length} chars; Discord allows at most ${MAX_TEXT_BLOCK_CHARS} per text block`,
      );
    }
    return { type: 10, content: block.content };
  }
  if (block.type === "separator") {
    const divider = block.divider ?? true;
    const spacing = block.spacing ?? 1;
    if (spacing !== 1 && spacing !== 2) {
      throw new Cv2ValidationError(
        `block[${idx}].spacing must be 1 or 2; got ${String(spacing)}`,
      );
    }
    return { type: 14, divider, spacing };
  }
  if (block.type === "section") return emitSection(block.text, block.accessory);
  if (block.type === "media") return emitMedia(block.items);
  if (block.type === "file") return emitFile(block.filename);
  if (block.type === "actions") return emitActions(block.components);
  throw new Cv2ValidationError(
    `block[${idx}].type must be one of "text", "separator", "section", "media", "file", "actions"; got ${String((block as { type?: unknown }).type)}`,
  );
}

/** True when the spec uses any block beyond the legacy text/separator pair. */
function hasRichBlock(blocks: ReadonlyArray<Cv2Block>): boolean {
  return blocks.some((b) => b.type === "section" || b.type === "media" || b.type === "file" || b.type === "actions");
}

/** Sum of every TextDisplay content length (top-level text + section lines). */
function totalTextChars(blocks: ReadonlyArray<Cv2Block>): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "text") n += b.content.length;
    else if (b.type === "section") for (const line of b.text) n += line.length;
  }
  return n;
}

/**
 * Flattened component count = Container + every node in the tree. A Section is
 * 1 node + its TextDisplay children + its 1 accessory; a MediaGallery is 1
 * (items are not components); an ActionRow is 1 + its buttons/select.
 */
function flattenedCount(blocks: ReadonlyArray<Cv2Block>): number {
  let n = 1; // the Container itself
  for (const b of blocks) {
    switch (b.type) {
      case "section": n += 1 + b.text.length + 1; break;
      case "actions": n += 1 + b.components.length; break;
      default: n += 1; break; // text, separator, media, file
    }
  }
  return n;
}

/**
 * Flatten a spec to a plain-text ephemeral fallback (last resort when a CV2
 * response is rejected): text/section lines kept verbatim, media/file dropped,
 * action rows summarised as "options: …". Clipped to a Discord message length.
 */
export function cv2ToPlainText(spec: Cv2Spec, max = 1900): string {
  const lines: string[] = [];
  for (const b of spec.blocks) {
    if (b.type === "text") lines.push(b.content);
    else if (b.type === "section") for (const l of b.text) lines.push(l);
    else if (b.type === "separator") lines.push("────────");
    else if (b.type === "actions") {
      const labels = b.components
        .map((c) => (c.kind === "button" ? c.label ?? c.emoji ?? "" : c.placeholder ?? "select"))
        .filter(Boolean);
      if (labels.length > 0) lines.push(`options: ${labels.join(" · ")}`);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").slice(0, max);
}

/** Attachment filenames referenced by the spec (thumbnails, media items, files). */
export function referencedAttachments(spec: Cv2Spec): string[] {
  const names: string[] = [];
  for (const b of spec.blocks) {
    if (b.type === "section" && b.accessory.kind === "thumb") names.push(b.accessory.filename);
    else if (b.type === "media") for (const it of b.items) names.push(it.filename);
    else if (b.type === "file") names.push(b.filename);
  }
  return names;
}

/**
 * Drop every block referencing an attachment NOT in `available` — a chart that
 * failed to render must not leave a dangling `attachment://` (Discord 400s, and
 * `postCv2WithFiles` fails the cross-check). Media items are filtered per-item;
 * an emptied media/file block is removed; a section whose thumbnail vanished
 * degrades to plain text. Consecutive/edge separators are then collapsed.
 */
export function pruneUnbackedAttachments(spec: Cv2Spec, available: ReadonlySet<string>): Cv2Spec {
  const out: Cv2Block[] = [];
  for (const b of spec.blocks) {
    if (b.type === "media") {
      const items = b.items.filter((it) => available.has(it.filename));
      if (items.length > 0) out.push({ type: "media", items });
      continue;
    }
    if (b.type === "file") {
      if (available.has(b.filename)) out.push(b);
      continue;
    }
    if (b.type === "section" && b.accessory.kind === "thumb" && !available.has(b.accessory.filename)) {
      for (const line of b.text) out.push({ type: "text", content: line });
      continue;
    }
    out.push(b);
  }
  return { ...spec, blocks: collapseSeparators(out) };
}

/** Remove leading/trailing separators and merge consecutive ones. */
function collapseSeparators(blocks: readonly Cv2Block[]): Cv2Block[] {
  const out: Cv2Block[] = [];
  for (const b of blocks) {
    if (b.type === "separator") {
      if (out.length === 0 || out[out.length - 1].type === "separator") continue;
    }
    out.push(b);
  }
  while (out.length > 0 && out[out.length - 1].type === "separator") out.pop();
  return out;
}
