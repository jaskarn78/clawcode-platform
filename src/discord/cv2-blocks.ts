/**
 * 999.135 — Components-v2 block emitters (cards + dashboards).
 *
 * Extends the CV2 vocabulary beyond text(10)+separator(14) with Section(9),
 * MediaGallery(12), File(13) and ActionRow(1) (buttons type 2 + string
 * selects type 3). Each emitter converts an operator-friendly block to the raw
 * Discord API shape and enforces the PER-ITEM limits Discord documents. The
 * whole-payload budgets (total text ≤4000, flattened components ≤40) live in
 * `cv2-renderer.ts`, which imports these emitters.
 *
 * Media/File/Thumbnail reference uploaded attachments as `attachment://<name>`;
 * the caller MUST include a file of that exact name in the same REST call.
 */

/** Raised on any CV2 limit violation. Re-exported by cv2-renderer for back-compat. */
export class Cv2ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Cv2ValidationError";
  }
}

// ---- operator-friendly block sub-types -------------------------------------

export type Cv2Button = {
  readonly style: 1 | 2 | 3 | 4 | 5;
  readonly label?: string; // ≤80; required unless emoji-only
  readonly emoji?: string; // unicode "🏃" or custom "name:id"
  readonly customId?: string; // ≤100; styles 1-4
  readonly url?: string; // style 5
  readonly disabled?: boolean;
};

export type Cv2SelectOption = {
  readonly label: string; // ≤100
  readonly value: string; // ≤100
  readonly description?: string; // ≤100
  readonly default?: boolean;
  readonly emoji?: string;
};

export type Cv2Action =
  | ({ readonly kind: "button" } & Cv2Button)
  | {
      readonly kind: "select";
      readonly customId: string;
      readonly placeholder?: string;
      readonly options: readonly Cv2SelectOption[];
      readonly minValues?: number;
      readonly maxValues?: number;
    };

export type Cv2Accessory =
  | { readonly kind: "button"; readonly button: Cv2Button }
  | { readonly kind: "thumb"; readonly filename: string; readonly description?: string };

export type Cv2MediaItem = { readonly filename: string; readonly description?: string; readonly spoiler?: boolean };

// ---- raw Discord output shapes ---------------------------------------------

type RawEmoji = { readonly name: string; readonly id?: string };
type RawTextDisplay = { readonly type: 10; readonly content: string };
export type RawButton = {
  readonly type: 2;
  readonly style: number;
  readonly label?: string;
  readonly emoji?: RawEmoji;
  readonly custom_id?: string;
  readonly url?: string;
  readonly disabled?: boolean;
};
type RawSelectOption = { readonly label: string; readonly value: string; readonly description?: string; readonly default?: boolean; readonly emoji?: RawEmoji };
export type RawSelect = {
  readonly type: 3;
  readonly custom_id: string;
  readonly placeholder?: string;
  readonly options: readonly RawSelectOption[];
  readonly min_values?: number;
  readonly max_values?: number;
};
type RawThumbnail = { readonly type: 11; readonly media: { readonly url: string }; readonly description?: string };
export type RawSection = { readonly type: 9; readonly components: readonly RawTextDisplay[]; readonly accessory: RawButton | RawThumbnail };
export type RawMediaGallery = { readonly type: 12; readonly items: readonly { readonly media: { readonly url: string }; readonly description?: string; readonly spoiler?: boolean }[] };
export type RawFileComponent = { readonly type: 13; readonly file: { readonly url: string } };
export type RawActionRow = { readonly type: 1; readonly components: readonly (RawButton | RawSelect)[] };

const MAX_LABEL = 80;
const MAX_CUSTOM_ID = 100;
const MAX_SELECT_VALUE = 100;
const MAX_SELECT_LABEL = 100;
const MAX_DESCRIPTION = 1024;
const MAX_SECTION_LINES = 3;
const MAX_MEDIA_ITEMS = 10;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_SELECT_OPTIONS = 25;

function attachmentUrl(filename: string): string {
  if (!filename || typeof filename !== "string") throw new Cv2ValidationError("attachment filename must be a non-empty string");
  return `attachment://${filename}`;
}

/** Unicode emoji → `{name}`; "name:id" custom emoji → `{name, id}`. */
function parseEmoji(emoji: string | undefined): RawEmoji | undefined {
  if (!emoji) return undefined;
  const custom = /^([\w~]+):(\d+)$/.exec(emoji);
  if (custom) return { name: custom[1], id: custom[2] };
  return { name: emoji };
}

export function emitButton(b: Cv2Button): RawButton {
  if (![1, 2, 3, 4, 5].includes(b.style)) throw new Cv2ValidationError(`button style must be 1-5; got ${String(b.style)}`);
  if (b.label !== undefined && b.label.length > MAX_LABEL) {
    throw new Cv2ValidationError(`button label is ${b.label.length} chars; Discord allows at most ${MAX_LABEL}`);
  }
  if (b.label === undefined && b.emoji === undefined) throw new Cv2ValidationError("button needs a label or an emoji");
  if (b.style === 5) {
    if (!b.url) throw new Cv2ValidationError("link button (style 5) requires a url");
    if (b.customId) throw new Cv2ValidationError("link button (style 5) must not have a customId");
  } else {
    if (!b.customId) throw new Cv2ValidationError(`button style ${b.style} requires a customId`);
    if (b.url) throw new Cv2ValidationError(`button style ${b.style} must not have a url`);
    if (b.customId.length > MAX_CUSTOM_ID) {
      throw new Cv2ValidationError(`button customId is ${b.customId.length} chars; Discord allows at most ${MAX_CUSTOM_ID}`);
    }
  }
  return {
    type: 2,
    style: b.style,
    ...(b.label !== undefined ? { label: b.label } : {}),
    ...(b.emoji !== undefined ? { emoji: parseEmoji(b.emoji) } : {}),
    ...(b.customId !== undefined ? { custom_id: b.customId } : {}),
    ...(b.url !== undefined ? { url: b.url } : {}),
    ...(b.disabled ? { disabled: true } : {}),
  };
}

function emitSelect(s: Extract<Cv2Action, { kind: "select" }>): RawSelect {
  if (!s.customId) throw new Cv2ValidationError("select requires a customId");
  if (s.customId.length > MAX_CUSTOM_ID) throw new Cv2ValidationError(`select customId is ${s.customId.length} chars; Discord allows at most ${MAX_CUSTOM_ID}`);
  if (s.options.length < 1 || s.options.length > MAX_SELECT_OPTIONS) {
    throw new Cv2ValidationError(`select has ${s.options.length} options; Discord allows 1-${MAX_SELECT_OPTIONS}`);
  }
  const options = s.options.map((o) => {
    if (!o.label || o.label.length > MAX_SELECT_LABEL) throw new Cv2ValidationError(`select option label must be 1-${MAX_SELECT_LABEL} chars`);
    if (!o.value || o.value.length > MAX_SELECT_VALUE) throw new Cv2ValidationError(`select option value must be 1-${MAX_SELECT_VALUE} chars`);
    if (o.description !== undefined && o.description.length > MAX_SELECT_LABEL) throw new Cv2ValidationError("select option description too long");
    return {
      label: o.label,
      value: o.value,
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.default ? { default: true } : {}),
      ...(o.emoji !== undefined ? { emoji: parseEmoji(o.emoji) } : {}),
    };
  });
  return {
    type: 3,
    custom_id: s.customId,
    ...(s.placeholder !== undefined ? { placeholder: s.placeholder } : {}),
    options,
    ...(s.minValues !== undefined ? { min_values: s.minValues } : {}),
    ...(s.maxValues !== undefined ? { max_values: s.maxValues } : {}),
  };
}

/** ActionRow: a lone select, OR up to 5 buttons — never a mix. */
export function emitActions(components: readonly Cv2Action[]): RawActionRow {
  if (components.length === 0) throw new Cv2ValidationError("action row must have at least one component");
  const selects = components.filter((c) => c.kind === "select");
  if (selects.length > 0) {
    if (components.length > 1) throw new Cv2ValidationError("a select must occupy an action row alone (no other components)");
    return { type: 1, components: [emitSelect(selects[0] as Extract<Cv2Action, { kind: "select" }>)] };
  }
  if (components.length > MAX_BUTTONS_PER_ROW) {
    throw new Cv2ValidationError(`action row has ${components.length} buttons; Discord allows at most ${MAX_BUTTONS_PER_ROW}`);
  }
  return { type: 1, components: components.map((c) => emitButton(c as Extract<Cv2Action, { kind: "button" }>)) };
}

export function emitSection(text: readonly string[], accessory: Cv2Accessory): RawSection {
  if (text.length < 1 || text.length > MAX_SECTION_LINES) {
    throw new Cv2ValidationError(`section has ${text.length} text lines; Discord allows 1-${MAX_SECTION_LINES}`);
  }
  for (const line of text) {
    if (typeof line !== "string" || line.length === 0) throw new Cv2ValidationError("section text lines must be non-empty strings");
  }
  const acc: RawButton | RawThumbnail =
    accessory.kind === "button"
      ? emitButton(accessory.button)
      : {
          type: 11,
          media: { url: attachmentUrl(accessory.filename) },
          ...(accessory.description !== undefined
            ? (accessory.description.length > MAX_DESCRIPTION
                ? (() => { throw new Cv2ValidationError("thumbnail description too long"); })()
                : { description: accessory.description })
            : {}),
        };
  return { type: 9, components: text.map((content) => ({ type: 10, content })), accessory: acc };
}

export function emitMedia(items: readonly Cv2MediaItem[]): RawMediaGallery {
  if (items.length < 1 || items.length > MAX_MEDIA_ITEMS) {
    throw new Cv2ValidationError(`media gallery has ${items.length} items; Discord allows 1-${MAX_MEDIA_ITEMS}`);
  }
  return {
    type: 12,
    items: items.map((it) => {
      if (it.description !== undefined && it.description.length > MAX_DESCRIPTION) throw new Cv2ValidationError("media item description too long");
      return {
        media: { url: attachmentUrl(it.filename) },
        ...(it.description !== undefined ? { description: it.description } : {}),
        ...(it.spoiler ? { spoiler: true } : {}),
      };
    }),
  };
}

export function emitFile(filename: string): RawFileComponent {
  return { type: 13, file: { url: attachmentUrl(filename) } };
}

/** Collect every `attachment://<name>` referenced by a raw component (for the file cross-check). */
export function attachmentNamesIn(raw: RawSection | RawMediaGallery | RawFileComponent | RawActionRow | { readonly type: number }): string[] {
  const names: string[] = [];
  const push = (url: string | undefined): void => {
    if (url && url.startsWith("attachment://")) names.push(url.slice("attachment://".length));
  };
  const r = raw as { type: number; accessory?: { media?: { url?: string } }; items?: { media?: { url?: string } }[]; file?: { url?: string } };
  if (r.type === 9 && r.accessory?.media?.url) push(r.accessory.media.url);
  if (r.type === 12 && Array.isArray(r.items)) for (const it of r.items) push(it.media?.url);
  if (r.type === 13 && r.file?.url) push(r.file.url);
  return names;
}
