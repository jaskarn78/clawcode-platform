/**
 * Skill-slash-commands — pure skill-name → Discord-command-name normaliser.
 *
 * Discord application command names must match `^[-_a-z0-9]{1,32}$`: all
 * lowercase, 1-32 chars, only hyphens / underscores / digits / lowercase
 * letters. Skill directory names in this workspace routinely violate that
 * (`discord:access`, `ui-ux-pro-max:ui-ux-pro-max`, uppercase, spaces).
 *
 * `skillNameToCommandName` is a pure function — no I/O, no logging — so it
 * is unit-testable in isolation. It returns the normalised command name, or
 * `null` when the skill name cannot produce a legal non-empty Discord name.
 */

/**
 * Normalise a skill name into a legal Discord application command name.
 *
 * Pipeline:
 *   1. Lowercase.
 *   2. Replace every character outside `[-_a-z0-9]` with `-` (this folds
 *      the `:` plugin-namespace separator into `-`, per the operator's
 *      resolved Fork 5: `discord:access` → `discord-access`).
 *   3. Collapse runs of `-` into a single `-`.
 *   4. Trim leading / trailing `-`.
 *   5. Truncate to 32 characters, then re-trim a trailing `-` exposed by
 *      truncation.
 *
 * @returns the normalised command name, or `null` when the result is empty
 *          (e.g. a skill name made entirely of illegal characters).
 */
export function skillNameToCommandName(skillName: string): string | null {
  const normalised = skillName
    .toLowerCase()
    .replace(/[^-_a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");

  return normalised.length > 0 ? normalised : null;
}
