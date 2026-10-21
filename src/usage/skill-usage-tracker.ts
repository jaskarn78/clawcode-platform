/**
 * Phase 53 Plan 03 — SkillUsageTracker.
 *
 * In-memory per-agent ring buffer recording which skills were mentioned
 * in each turn's assistant/user messages. Queried by the context-assembler
 * (via session-config) to decide which skills render full SKILL.md content
 * vs compressed one-line catalog entries.
 *
 * NO SQLite persistence (CONTEXT.md Claude's Discretion #3). Usage window
 * reconstructs from recent turns only; daemon restart resets the window
 * to empty and all skills initially render full-content during the warm-up
 * period — `usage.turns < lazySkills.usageThresholdTurns` is the warm-up
 * guard inside the assembler.
 *
 * Capacity floor of 5 is enforced at the constructor (backup Zod from
 * Plan 53-01 `lazySkills.usageThresholdTurns.min(5)`).
 */

export type SkillMentionEvent = {
  readonly mentionedSkills: readonly string[];
};

export type SkillUsageWindow = {
  readonly agent: string;
  /** Turns currently buffered (0..capacity). */
  readonly turns: number;
  /** Ring buffer size; turns cap at this count. */
  readonly capacity: number;
  /** Union of skills mentioned across all turns in the buffer. */
  readonly recentlyUsed: ReadonlySet<string>;
};

export type SkillUsageTrackerOptions = {
  /** Ring buffer size per agent. Floor 5 enforced at construction. */
  readonly capacity: number;
};

const MIN_CAPACITY = 5;

/**
 * Per-agent ring buffer tracking skill mentions per turn.
 *
 * Each call to `recordTurn(agent, { mentionedSkills })` pushes one entry
 * onto the agent's ring buffer. Once the buffer exceeds `capacity`, the
 * oldest entry is evicted. `getRecentlyUsedSkills(agent)` returns the
 * union of all skill names across every buffered turn for that agent.
 *
 * No persistence: a daemon restart clears all state. Warm-up behavior
 * (turns < threshold → all skills render full content) absorbs the reset.
 */
export class SkillUsageTracker {
  private readonly capacity: number;
  private readonly buffers = new Map<string, string[][]>();

  constructor(opts: SkillUsageTrackerOptions) {
    if (opts.capacity < MIN_CAPACITY) {
      throw new RangeError(
        `capacity floor is 5, got ${opts.capacity}`,
      );
    }
    this.capacity = opts.capacity;
  }

  /**
   * Record one turn of skill mentions for the named agent. Silently
   * tolerates duplicate mentions (they deduplicate at read time via
   * {@link getRecentlyUsedSkills}).
   */
  recordTurn(agent: string, event: SkillMentionEvent): void {
    const buf = this.buffers.get(agent) ?? [];
    buf.push([...event.mentionedSkills]);
    while (buf.length > this.capacity) buf.shift();
    this.buffers.set(agent, buf);
  }

  /**
   * Read the current usage window for an agent. Returns a frozen snapshot —
   * mutation attempts by the caller do not affect tracker state.
   */
  getWindow(agent: string): SkillUsageWindow {
    const buf = this.buffers.get(agent) ?? [];
    const set = new Set<string>();
    for (const turn of buf) {
      for (const s of turn) set.add(s);
    }
    Object.freeze(set);
    return Object.freeze({
      agent,
      turns: buf.length,
      capacity: this.capacity,
      recentlyUsed: set as ReadonlySet<string>,
    });
  }

  /** Convenience accessor — equivalent to `getWindow(agent).recentlyUsed`. */
  getRecentlyUsedSkills(agent: string): ReadonlySet<string> {
    return this.getWindow(agent).recentlyUsed;
  }

  /** Drop one agent's buffer entirely (used on stopAgent). */
  resetAgent(agent: string): void {
    this.buffers.delete(agent);
  }
}

/**
 * Extract word-boundary skill mentions from free-form text against a
 * supplied catalog of known skill names.
 *
 *   - Word-boundary regex `\b<name>\b` prevents substring false-positives
 *     (e.g. `"subsearch-firstline"` does NOT match `"search-first"`).
 *   - Case-insensitive (`/.../i`).
 *   - Result is de-duplicated (same skill mentioned multiple times = one
 *     entry).
 *   - Result is frozen so callers cannot mutate.
 *
 * Only catalog-known names are considered — arbitrary text tokens that
 * happen to match a regex pattern are ignored. Empty text or empty
 * catalog short-circuits to the empty array.
 */
export function extractSkillMentions(
  text: string,
  catalogNames: readonly string[],
): readonly string[] {
  if (!text || catalogNames.length === 0) {
    return Object.freeze([] as string[]);
  }
  const found = new Set<string>();
  for (const name of catalogNames) {
    // Escape regex metacharacters in the name so `.` / `+` / etc. in skill
    // names are matched literally. Skill directory names in practice use
    // `-` and `_` which are regex-safe, but we guard anyway.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(text)) {
      found.add(name);
    }
  }
  return Object.freeze([...found]);
}
