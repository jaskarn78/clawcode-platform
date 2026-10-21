/**
 * `post_cv2_embed` input schema — the agent-facing contract for Discord
 * Components v2 cards.
 *
 * 2026-09-10 (client-a-personal): the tool advertised only `text | separator`,
 * so `{"type":"media"}` failed with MCP -32602 "No matching discriminator"
 * even though the renderer (`cv2-renderer.ts`) and the emitters
 * (`cv2-blocks.ts`) had supported Section(9), MediaGallery(12), File(13) and
 * ActionRow(1) since 999.135. The gap was purely this schema, plus the fact
 * that the tool had no way to carry the files an `attachment://` reference
 * points at. Both are closed here; the daemon loads `files[]` from the
 * agent's workspace and posts them in the same REST call.
 *
 * Lives in its own module so the schema is unit-testable exactly the way an
 * agent probes it (`safeParse`), without dragging the MCP server in.
 *
 * Interactive components are deliberately LINK-ONLY. A button with a
 * `customId` or a select menu needs an interactionCreate handler that knows
 * its id; nothing in the bridge routes agent-authored ids (training buttons
 * and the `pp:` prompt pills have dedicated decoders), so such a component
 * renders fine and then fails on click with Discord's "This interaction
 * failed". Link buttons (style 5) need no handler.
 */
import { z } from "zod/v4";

const MAX_TEXT_BLOCK_CHARS = 4000;
const MAX_BLOCKS = 40;
const MAX_SECTION_LINES = 3;
const MAX_MEDIA_ITEMS = 10;
const MAX_BUTTONS_PER_ROW = 5;
/** Matches `MAX_MEDIA_ITEMS`: one gallery can show every file in one post. */
export const MAX_CV2_FILES = 10;

/**
 * Filename as it appears in `attachment://<name>` and as Discord will show
 * it. One path segment, no traversal, no control characters, and none of the
 * bidi-override / zero-width code points that let a name visually spoof a
 * different extension (U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF).
 * Shared with the daemon-side loader so the two gates cannot drift.
 */
export const ATTACHMENT_NAME_RE = /^[^/\\\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+$/;

const attachmentName = z
  .string()
  .min(1)
  .max(255)
  .regex(ATTACHMENT_NAME_RE, "filename must be a single path segment without control, bidi or zero-width characters")
  .refine((s) => s !== "." && s !== "..", "filename must not be '.' or '..'");

const linkButtonShape = {
  style: z.literal(5).describe("5 = link button. The only interactive style this tool supports (no click handler needed)."),
  // http(s) only — not relying on Discord to reject other schemes.
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "link button url must be http(s)")
    .describe("Where the button goes (http/https)."),
  label: z.string().min(1).max(80).optional().describe("Button text (≤80). Required unless emoji is set."),
  emoji: z.string().min(1).optional().describe("Unicode emoji, or custom as `name:id`."),
  disabled: z.boolean().optional(),
};
const needsLabelOrEmoji = (b: { label?: string; emoji?: string }): boolean =>
  b.label !== undefined || b.emoji !== undefined;

// strictObject on purpose: a `customId` must be REJECTED with a message, not
// silently stripped — otherwise the agent believes it posted a working button.
const linkButton = z.strictObject(linkButtonShape).refine(needsLabelOrEmoji, "a button needs a label or an emoji");
const actionButton = z
  .strictObject({ kind: z.literal("button"), ...linkButtonShape })
  .refine(needsLabelOrEmoji, "a button needs a label or an emoji");

const thumbnailAccessory = z.object({
  kind: z.literal("thumb"),
  filename: attachmentName.describe("Name of a file in `files[]` (its basename, or its `name`)."),
  description: z.string().max(1024).optional().describe("Alt text."),
});

const buttonAccessory = z.strictObject({
  kind: z.literal("button"),
  button: linkButton,
});

const mediaItem = z.object({
  filename: attachmentName.describe("Name of a file in `files[]` (its basename, or its `name`)."),
  description: z.string().max(1024).optional().describe("Alt text."),
  spoiler: z.boolean().optional(),
});

export const CV2_BLOCK_SCHEMA = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    content: z.string().min(1).max(MAX_TEXT_BLOCK_CHARS).describe("Markdown text. Headings, bold, code spans, emoji all supported."),
  }),
  z.object({
    type: z.literal("separator"),
    divider: z.boolean().optional(),
    spacing: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
  z.object({
    type: z.literal("section"),
    text: z.array(z.string().min(1)).min(1).max(MAX_SECTION_LINES).describe("1-3 markdown lines shown beside the accessory."),
    accessory: z.discriminatedUnion("kind", [thumbnailAccessory, buttonAccessory]).describe("A thumbnail image from `files[]`, or a link button."),
  }).describe("Text with a thumbnail or link button on the right."),
  z.object({
    type: z.literal("media"),
    items: z.array(mediaItem).min(1).max(MAX_MEDIA_ITEMS).describe("1-10 images from `files[]`, shown as a gallery grid."),
  }).describe("Image gallery inside the container. Every filename must be in `files[]`."),
  z.object({
    type: z.literal("file"),
    filename: attachmentName.describe("Name of a file in `files[]` — rendered as a downloadable attachment inside the container."),
  }),
  z.object({
    type: z.literal("actions"),
    components: z
      .array(actionButton)
      .min(1)
      .max(MAX_BUTTONS_PER_ROW)
      .describe("1-5 link buttons in one row."),
  }).describe("A row of link buttons (style 5 only)."),
]);

export const CV2_SPEC_SCHEMA = z
  .object({
    accentColor: z
      .number()
      .int()
      .min(0)
      .max(0xffffff)
      .optional()
      .describe("Container left-bar color (hex int, e.g. 0x5865F2). Optional."),
    blocks: z.array(CV2_BLOCK_SCHEMA).min(1).max(MAX_BLOCKS).describe("Sequential blocks rendered inside the Container."),
  })
  .describe(
    "CV2 spec. Discord limits: 40 blocks per Container, 4000 chars per text block and 4000 total across all text, 10 images per media gallery.",
  );

export const CV2_FILE_SCHEMA = z.object({
  path: z
    .string()
    .min(1)
    .describe("File to upload. Absolute path inside your workspace/memory/fileAccess roots, or a path relative to your workspace."),
  name: attachmentName
    .optional()
    .describe("Attachment name blocks refer to. Defaults to the path's basename."),
  description: z.string().max(1024).optional().describe("Alt text for the attachment."),
});

export const CV2_FILES_SCHEMA = z
  .array(CV2_FILE_SCHEMA)
  .max(MAX_CV2_FILES)
  .describe(
    "Files to upload with the card (≤10, ≤25 MiB each). A `media` item, `file` block or `thumb` accessory refers to one of these by name; every referenced name MUST be here or the post is refused.",
  );

export type Cv2SpecInput = z.infer<typeof CV2_SPEC_SCHEMA>;
export type Cv2FileInput = z.infer<typeof CV2_FILE_SCHEMA>;
