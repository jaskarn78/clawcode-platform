/**
 * Phase 90 Plan 06 HUB-05 — Discord ModalBuilder + serial flow for
 * install-time plugin config collection.
 *
 * Two paths per D-13:
 *   - ≤5 fields → single ModalBuilder with one TextInput per field (Discord
 *     hard-cap). Happy path for the 95% of plugins that need one API key /
 *     password / URL.
 *   - >5 fields → serial follow-up prompt flow (buildSerialPromptFlow
 *     generator). The caller iterates frame by frame, showing a mini-modal
 *     with a single field + "Step N/M" title at each step.
 *
 * Sensitive fields (D-16) get a ⚠️ emoji prefix in their label AND default
 * to an "op:// reference preferred" placeholder — the Discord picker+Modal
 * UX nudges operators toward 1Password references before they type a
 * literal secret.
 *
 * Pure factories — no Discord client I/O. Tests serialize via `.toJSON()`.
 * The caller (slash-commands.ts) owns showModal / awaitModalSubmit.
 */
import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ClawhubPluginManifest } from "../marketplace/clawhub-client.js";

/** Discord ModalBuilder hard cap: 5 TextInput rows per modal. */
export const DISCORD_MODAL_MAX_FIELDS = 5;

/** Discord TextInput label max length. */
const MAX_LABEL_LEN = 45;

/** Discord TextInput placeholder max length. */
const MAX_PLACEHOLDER_LEN = 100;

/** Discord Modal title max length. */
const MAX_TITLE_LEN = 45;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a manifest's config.fields[] exceeds the Discord ModalBuilder
 * 5-row cap. Caller should fall through to buildSerialPromptFlow instead.
 */
export class TooManyFieldsError extends Error {
  public readonly fieldCount: number;
  constructor(fieldCount: number) {
    super(
      `Modal cap: ${DISCORD_MODAL_MAX_FIELDS} fields max, got ${fieldCount}`,
    );
    this.name = "TooManyFieldsError";
    this.fieldCount = fieldCount;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One frame from buildSerialPromptFlow. `step` is 1-indexed for user-facing
 * display ("Step 3/8 — configure DATABASE_URL").
 */
export type SerialFlowFrame = Readonly<{
  field: NonNullable<ClawhubPluginManifest["config"]>["fields"][number];
  step: number;
  total: number;
}>;

// ---------------------------------------------------------------------------
// buildPluginConfigModal — single-modal path (≤5 fields)
// ---------------------------------------------------------------------------

/**
 * Build a Discord ModalBuilder with one TextInputBuilder per config field.
 *
 * Contracts:
 *   - customId format: `clawhub-plugin-config:<plugin>:<nonce>` (awaitModalSubmit
 *     filter hook-point for the caller)
 *   - Throws TooManyFieldsError if >5 fields (caller must fall through to
 *     buildSerialPromptFlow)
 *   - Sensitive fields get "⚠️ " prefix + "op:// reference preferred"
 *     placeholder unless a custom placeholder is set in the manifest
 *   - Field types: "paragraph" → TextInputStyle.Paragraph (multi-line);
 *     anything else → TextInputStyle.Short (single-line)
 */
export function buildPluginConfigModal(
  manifest: ClawhubPluginManifest,
  nonce: string,
): ModalBuilder {
  const fields = manifest.config?.fields ?? [];
  if (fields.length > DISCORD_MODAL_MAX_FIELDS) {
    throw new TooManyFieldsError(fields.length);
  }

  const modal = new ModalBuilder()
    .setCustomId(`clawhub-plugin-config:${manifest.name}:${nonce}`)
    .setTitle(`Configure ${manifest.name}`.slice(0, MAX_TITLE_LEN));

  for (const field of fields) {
    const rawLabel = field.sensitive
      ? `⚠️ ${field.label}`
      : field.label;
    const input = new TextInputBuilder()
      .setCustomId(`field:${field.name}`)
      .setLabel(rawLabel.slice(0, MAX_LABEL_LEN))
      .setStyle(
        field.type === "paragraph"
          ? TextInputStyle.Paragraph
          : TextInputStyle.Short,
      )
      .setRequired(true);
    if (field.placeholder && field.placeholder.length > 0) {
      input.setPlaceholder(field.placeholder.slice(0, MAX_PLACEHOLDER_LEN));
    } else if (field.sensitive) {
      input.setPlaceholder("op:// reference preferred");
    }
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
  }
  return modal;
}

// ---------------------------------------------------------------------------
// parseModalSubmit — extract submitted values
// ---------------------------------------------------------------------------

/**
 * Extract all field values from a ModalSubmitInteraction into a plain object
 * keyed by manifest field name. Missing fields (should not happen — they're
 * required) are omitted from the result.
 */
export function parseModalSubmit(
  submit: ModalSubmitInteraction,
  manifest: ClawhubPluginManifest,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of manifest.config?.fields ?? []) {
    try {
      out[f.name] = submit.fields.getTextInputValue(`field:${f.name}`);
    } catch {
      // Field absent — Discord returns an error from getTextInputValue.
      // Required fields should always be present; this is defensive.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildSerialPromptFlow — >5 field flow controller
// ---------------------------------------------------------------------------

/**
 * Generator that yields one frame per config field, with "Step N/M" metadata
 * for the caller's Discord ephemeral message. The caller iterates the
 * generator, shows a mini-modal (or ephemeral + button+modal chain) for each
 * frame, collects the submitted value, and merges into the configInputs
 * object before dispatching the install IPC.
 *
 * Empty manifest.config → zero frames (caller shortcircuits to direct install).
 */
export function* buildSerialPromptFlow(
  manifest: ClawhubPluginManifest,
): Generator<SerialFlowFrame> {
  const fields = manifest.config?.fields ?? [];
  for (let i = 0; i < fields.length; i++) {
    yield Object.freeze({
      field: fields[i],
      step: i + 1,
      total: fields.length,
    });
  }
}
