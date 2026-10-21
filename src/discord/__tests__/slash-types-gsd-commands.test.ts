/**
 * Phase 100 follow-up — GSD_SLASH_COMMANDS constant tests.
 *
 * The Phase 100 plan shipped 5 GSD slash commands inlined per-agent in the
 * yaml. The follow-up moves them to a shared `GSD_SLASH_COMMANDS` constant in
 * slash-types.ts so any agent with `gsd.projectDir` configured auto-inherits
 * them — no per-agent yaml duplication. The constant adds 14 more commands
 * (operator-curated subset of the ~57 GSD skills in ~/.claude/commands/gsd/)
 * + the runtime project switcher (set-project, handled inline).
 *
 * Phase 999.21 — entries are now NESTED subcommands under a single top-level
 * `/get-shit-done` command. Each entry has `subcommandOf: "get-shit-done"`
 * and the `name` field is the bare suffix (e.g. "autonomous", "set-project")
 * not the legacy flat `gsd-*` form. The claudeCommand text values stay
 * BYTE-IDENTICAL to the pre-999.21 values — pinned by GS1l below — so the
 * agent-routed dispatch keeps producing the canonical /gsd:* prompt.
 *
 * Pins (GS1 + structural / shape):
 *   GS1a — GSD_SLASH_COMMANDS exported with exactly 19 entries
 *   GS1b — Each entry has the SlashCommandDef shape (name, description,
 *          claudeCommand, options array)
 *   GS1c — All 5 originally shipped Phase 100 names are present (back-compat
 *          for the 5 yaml entries which still get deduped via seenNames)
 *   GS1d — All 14 new operator-friction names are present
 *   GS1e — set-project is present with an empty claudeCommand (inline-
 *          handled, no LLM-prompt routing)
 *   GS1f — Every entry has subcommandOf === "get-shit-done" (Phase 999.21
 *          consolidation invariant — no flat top-level slot leaks through).
 *   GS1g — Every option has the SlashCommandOption shape (name, type,
 *          description, required) and `type` is the Discord STRING enum (3)
 *   GS1h — set-project's only option is `path`, required, type=3
 *   GS1i — autonomous keeps its `args` option (back-compat with Phase 100 yaml)
 *   GS1j — debug keeps its required `issue` option
 *   GS1k — every entry has subcommandOf === "get-shit-done" (Phase 999.21
 *          duplicate-of-GS1f for explicit defense-in-depth — kept separate
 *          so a future regression that strips the field from a single entry
 *          surfaces as TWO failing tests, not one).
 *   GS1l — claudeCommand byte-identity table: every entry's claudeCommand
 *          matches its pre-999.21 value verbatim (the consolidation's hard
 *          invariant — the wire form sent to the agent must not drift even
 *          a single character when the slash dispatch shape changed).
 */
import { describe, it, expect } from "vitest";
import { GSD_SLASH_COMMANDS } from "../slash-types.js";

/**
 * Phase 999.21 — pre-edit claudeCommand values for each of the 19 GSD entries.
 * Asserted verbatim by GS1l. If any entry's claudeCommand drifts (whitespace,
 * casing, placeholder name), this table catches the regression and the
 * consolidation invariant is broken.
 */
const EXPECTED_CLAUDE_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["autonomous", "/gsd:autonomous {args}"],
  ["plan-phase", "/gsd:plan-phase {phase}"],
  ["execute-phase", "/gsd:execute-phase {phase}"],
  ["debug", "/gsd:debug {issue}"],
  ["quick", "/gsd:quick {task}"],
  ["new-project", "/gsd:new-project {args}"],
  ["new-milestone", "/gsd:new-milestone {args}"],
  ["add-phase", "/gsd:add-phase {args}"],
  ["add-tests", "/gsd:add-tests {args}"],
  ["audit-milestone", "/gsd:audit-milestone"],
  ["complete-milestone", "/gsd:complete-milestone {args}"],
  ["cleanup", "/gsd:cleanup"],
  ["progress", "/gsd:progress"],
  ["verify-work", "/gsd:verify-work {args}"],
  ["discuss-phase", "/gsd:discuss-phase {phase}"],
  ["do", "/gsd:do {task}"],
  ["fast", "/gsd:fast {task}"],
  ["help", "/gsd:help {args}"],
  ["set-project", ""],
]);

describe("Phase 100 follow-up — GSD_SLASH_COMMANDS constant", () => {
  it("GS1a — exports exactly 19 entries", () => {
    expect(GSD_SLASH_COMMANDS).toHaveLength(19);
  });

  it("GS1b — each entry has SlashCommandDef shape (name, description, claudeCommand, options)", () => {
    for (const cmd of GSD_SLASH_COMMANDS) {
      expect(typeof cmd.name).toBe("string");
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(typeof cmd.description).toBe("string");
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(typeof cmd.claudeCommand).toBe("string"); // may be empty for inline (set-project)
      expect(Array.isArray(cmd.options)).toBe(true);
    }
  });

  it("GS1c — all 5 originally-shipped Phase 100 names are present (suffix-only post-999.21)", () => {
    const names = GSD_SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain("autonomous");
    expect(names).toContain("plan-phase");
    expect(names).toContain("execute-phase");
    expect(names).toContain("debug");
    expect(names).toContain("quick");
  });

  it("GS1d — all 14 new operator-friction names are present (suffix-only post-999.21)", () => {
    const names = GSD_SLASH_COMMANDS.map((c) => c.name);
    // Project / milestone / phase scaffolding (the friction catalysts)
    expect(names).toContain("new-project");
    expect(names).toContain("new-milestone");
    expect(names).toContain("add-phase");
    expect(names).toContain("add-tests");
    // Audit / completion / cleanup
    expect(names).toContain("audit-milestone");
    expect(names).toContain("complete-milestone");
    expect(names).toContain("cleanup");
    // Progress / verify / discuss
    expect(names).toContain("progress");
    expect(names).toContain("verify-work");
    expect(names).toContain("discuss-phase");
    // Quick / fast / do / help
    expect(names).toContain("do");
    expect(names).toContain("fast");
    expect(names).toContain("help");
    // Runtime project switcher (inline-handled)
    expect(names).toContain("set-project");
  });

  it("GS1e — set-project has empty claudeCommand (inline handler short-circuit)", () => {
    const setProj = GSD_SLASH_COMMANDS.find((c) => c.name === "set-project");
    expect(setProj).toBeDefined();
    expect(setProj!.claudeCommand).toBe("");
  });

  it("GS1f — every entry has subcommandOf === 'get-shit-done' (Phase 999.21 consolidation guard)", () => {
    for (const cmd of GSD_SLASH_COMMANDS) {
      expect(cmd.subcommandOf).toBe("get-shit-done");
    }
  });

  it("GS1g — every option is { name, type=3, description, required }", () => {
    for (const cmd of GSD_SLASH_COMMANDS) {
      for (const opt of cmd.options) {
        expect(typeof opt.name).toBe("string");
        expect(opt.name.length).toBeGreaterThan(0);
        // 3 = Discord ApplicationCommandOptionType.STRING
        expect(opt.type).toBe(3);
        expect(typeof opt.description).toBe("string");
        expect(typeof opt.required).toBe("boolean");
      }
    }
  });

  it("GS1h — set-project has exactly one required `path` option (type=3)", () => {
    const setProj = GSD_SLASH_COMMANDS.find((c) => c.name === "set-project");
    expect(setProj).toBeDefined();
    expect(setProj!.options).toHaveLength(1);
    const pathOpt = setProj!.options[0]!;
    expect(pathOpt.name).toBe("path");
    expect(pathOpt.type).toBe(3);
    expect(pathOpt.required).toBe(true);
  });

  it("GS1i — autonomous keeps its `args` option (back-compat with Phase 100 yaml)", () => {
    const auto = GSD_SLASH_COMMANDS.find((c) => c.name === "autonomous");
    expect(auto).toBeDefined();
    expect(auto!.claudeCommand).toBe("/gsd:autonomous {args}");
    const args = auto!.options.find((o) => o.name === "args");
    expect(args).toBeDefined();
    expect(args!.required).toBe(false);
  });

  it("GS1j — debug keeps its required `issue` option", () => {
    const dbg = GSD_SLASH_COMMANDS.find((c) => c.name === "debug");
    expect(dbg).toBeDefined();
    expect(dbg!.claudeCommand).toBe("/gsd:debug {issue}");
    const issue = dbg!.options.find((o) => o.name === "issue");
    expect(issue).toBeDefined();
    expect(issue!.required).toBe(true);
  });

  it("GS1k — every entry has subcommandOf === 'get-shit-done' (defense-in-depth duplicate of GS1f)", () => {
    for (const cmd of GSD_SLASH_COMMANDS) {
      expect(cmd.subcommandOf).toBe("get-shit-done");
    }
  });

  it("GS1l — claudeCommand byte-identity preserved verbatim across the Phase 999.21 consolidation", () => {
    // Every entry's claudeCommand must match its pre-999.21 value exactly.
    // This is the hard invariant of the consolidation: the slash dispatch
    // shape changed (flat → nested subcommand) but the wire form sent to
    // the agent (the canonical /gsd:* string after formatCommandMessage)
    // must NOT drift even a single character.
    expect(GSD_SLASH_COMMANDS).toHaveLength(EXPECTED_CLAUDE_COMMANDS.size);
    for (const cmd of GSD_SLASH_COMMANDS) {
      const expected = EXPECTED_CLAUDE_COMMANDS.get(cmd.name);
      expect(expected, `unexpected entry name: ${cmd.name}`).toBeDefined();
      expect(cmd.claudeCommand).toBe(expected);
    }
  });
});
