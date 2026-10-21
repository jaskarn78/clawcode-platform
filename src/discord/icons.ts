/**
 * 999.160 v1.2 — icons as Discord application emojis.
 *
 * Operator (2026-09-23): no Unicode icons in buttons or footers; use a proper icon
 * library or none. The bot owns ONE emoji set — Lucide icons (ISC) rendered to
 * 128 px PNGs under assets/icons/ and uploaded once as application emojis named
 * `cc_<name>` (`clawcode icons sync`). At `ready` the bridge loads the set into
 * this registry; every site renders through it and degrades to TEXT ONLY when
 * an icon is missing — never to a Unicode glyph.
 *
 * Pure module (no discord.js import) so footers, status lines and the fast lane
 * can use it without pulling the client in.
 */

export const ICON_EMOJI_PREFIX = "cc_";

/** The bundled set (assets/icons/cc_<name>.png). Keep in sync with scripts/ops/render-icons.mjs. */
export const ICON_NAMES = [
  "check", "x", "warning", "search", "brain", "refresh", "thumbs_up", "thumbs_down", "pencil", "chart",
  "thought", "compass", "receipt", "stop", "thread", "paperclip", "zap", "play", "scissors", "link", "retry",
  "sparkles", "puzzle", "clipboard", "moon", "calculator", "bandage", "eye", "hourglass", "wrench", "clock",
  "bookmark", "bell", "file", "info", "flag", "target", "key", "book", "flame", "rocket", "mail", "user",
  "shield", "gauge", "trending_up", "calendar", "lightbulb", "loader", "circle_check", "circle_x", "pause",
  "forward", "memory", "dot_red", "dot_yellow", "dot_green", "dot_grey", "dot_blue",
  "arrow_right", "messages_square", "bot", "layers", "hash", "settings", "activity", "inbox",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

export type IconRef = { readonly id: string; readonly name: string };

export type IconSyncResult = {
  readonly created: readonly string[];
  readonly existing: readonly string[];
  readonly failed: ReadonlyArray<{ readonly name: string; readonly error: string }>;
};

/** Discord emoji names are 2–32 chars of [A-Za-z0-9_]; ours carry the `cc_` prefix. */
export function isIconEmojiName(name: string): boolean {
  return /^cc_[a-z0-9_]{1,29}$/.test(name);
}

export class IconRegistry {
  private byName: ReadonlyMap<string, IconRef> = new Map();

  /** Replace the whole set from the application's emoji list; only `cc_*` names are kept. */
  setAll(entries: ReadonlyArray<{ readonly id: string; readonly name: string }>): void {
    this.byName = new Map(
      entries
        .filter((e) => isIconEmojiName(e.name))
        .map((e) => [e.name.slice(ICON_EMOJI_PREFIX.length), { id: e.id, name: e.name }] as const),
    );
  }

  clear(): void {
    this.byName = new Map();
  }

  size(): number {
    return this.byName.size;
  }

  has(name: IconName): boolean {
    return this.byName.has(name);
  }

  /** `<:cc_zap:123>` for message text and `-#` subtext; "" when the icon is missing. */
  inline(name: IconName): string {
    const r = this.byName.get(name);
    return r ? `<:${r.name}:${r.id}>` : "";
  }

  /** Icon, a space and the text — or the text alone. */
  prefix(name: IconName, text: string): string {
    const i = this.inline(name);
    return i.length > 0 ? `${i} ${text}` : text;
  }

  /** Button `emoji` payload, or undefined (text-only button). */
  button(name: IconName): IconRef | undefined {
    return this.byName.get(name);
  }

  /** Reaction identifier (`cc_zap:123`) or undefined — the caller decides whether to react at all. */
  reaction(name: IconName): string | undefined {
    const r = this.byName.get(name);
    return r ? `${r.name}:${r.id}` : undefined;
  }
}

/** The process-wide registry: one bot, one set. */
export const icons = new IconRegistry();
