import { describe, it, expect } from "vitest";
import {
  DEFAULT_SLASH_COMMANDS,
  CONTROL_COMMANDS,
  type SlashCommandDef,
  type SlashCommandOption,
} from "../slash-types.js";

describe("slash-types", () => {
  describe("DEFAULT_SLASH_COMMANDS", () => {
    // Phase 87 CMD-04 — clawcode-compact and clawcode-usage were REMOVED from
    // DEFAULT_SLASH_COMMANDS. They are re-provided at registration time by the
    // SDK discovery loop via native-cc-commands.buildNativeCommandDefs so the
    // native-dispatch path is the ONLY path for /compact and /cost going forward.
    // 2026-08-26: pin was STALE at 14 — a 15th default landed earlier
    // without updating it, so this had been red on master. Re-pinned to
    // the true count; /clawcode-verify is a CONTROL command and does not
    // affect this list.
    // 2026-09-23: the pin had drifted again (15 listed vs 16 real — /clawcode-style
    // was never added). Re-pinned to the true list after
    // /clawcode-skills-browse, /clawcode-plugins-browse and /clawcode-clawhub-auth
    // were retired and /training removed → 12.
    it("contains exactly 12 commands (8 clawcode-* + 2 ultra-* + gsd-do + vc)", () => {
      expect(DEFAULT_SLASH_COMMANDS).toHaveLength(12);
      const names = DEFAULT_SLASH_COMMANDS.map((cmd) => cmd.name);
      expect(names).toEqual([
        "clawcode-status",
        "clawcode-memory",
        "clawcode-schedule",
        "clawcode-health",
        "clawcode-model",
        "clawcode-style",
        "clawcode-effort",
        "clawcode-skills",
        "ultra-plan",
        "ultra-review",
        "gsd-do",
        // Phase 135 Plan 01 Task 3 — /vc {join,leave,status} voice channel
        // commands. Inline handler at slash-commands.ts dispatches by
        // subcommand to handleVcCommand (src/discord/voice/command.ts);
        // claudeCommand is "" (inline-handled) — registered alongside the
        // other inline handlers in the inlineHandlers set below.
        "vc",
      ]);
    });

    it("does NOT contain the commands retired 2026-09-23", () => {
      const names = DEFAULT_SLASH_COMMANDS.map((cmd) => cmd.name);
      for (const retired of ["clawcode-skills-browse", "clawcode-plugins-browse", "clawcode-clawhub-auth"]) {
        expect(names).not.toContain(retired);
      }
    });

    it("does NOT contain clawcode-compact (Phase 87 CMD-04 regression pin)", () => {
      const names = DEFAULT_SLASH_COMMANDS.map((cmd) => cmd.name);
      expect(names).not.toContain("clawcode-compact");
    });

    it("does NOT contain clawcode-usage (Phase 87 CMD-04 regression pin)", () => {
      const names = DEFAULT_SLASH_COMMANDS.map((cmd) => cmd.name);
      expect(names).not.toContain("clawcode-usage");
    });

    it("every remaining entry matches /^clawcode-/ OR is a 999.31 ultra-* shortcut OR is gsd-do (999.32) OR is /vc (Phase 135 Plan 01)", () => {
      const exempt = new Set(["ultra-plan", "ultra-review", "gsd-do", "vc"]);
      for (const cmd of DEFAULT_SLASH_COMMANDS) {
        if (exempt.has(cmd.name)) continue;
        expect(cmd.name).toMatch(/^clawcode-/);
      }
    });

    it("each default command has name, description fields (non-empty strings); claudeCommand is a string (may be empty for inline handlers)", () => {
      // Phase 86 MODEL-02 / MODEL-03 — clawcode-model was converted to an
      // inline handler that routes through IPC set-model directly. Its
      // claudeCommand field is intentionally empty (the inline handler short-
      // circuits before formatCommandMessage is reached). All other commands
      // still carry a non-empty LLM-prompt template.
      // Phase 88 MKT-01 / MKT-07 — clawcode-skills-browse and clawcode-skills
      // are ALSO inline-handled (StringSelectMenuBuilder + IPC dispatch).
      const inlineHandlers = new Set([
        "clawcode-model",
        "clawcode-skills",
        // Phase 135 Plan 01 Task 3 — /vc is inline-dispatched to
        // handleVcCommand; claudeCommand is "" (Plan 02 wires real
        // behaviour). The vc command has SUB_COMMAND options (not
        // LLM-prompt options), so it joins this set, not the
        // free-text-prompt set.
        "vc",
      ]);
      for (const cmd of DEFAULT_SLASH_COMMANDS) {
        expect(cmd.name).toBeTruthy();
        expect(typeof cmd.name).toBe("string");
        expect(cmd.description).toBeTruthy();
        expect(typeof cmd.description).toBe("string");
        expect(typeof cmd.claudeCommand).toBe("string");
        if (inlineHandlers.has(cmd.name)) {
          expect(cmd.claudeCommand).toBe("");
        } else {
          expect(cmd.claudeCommand).toBeTruthy();
        }
      }
    });

    it("the memory command has one required option named query of type STRING (3)", () => {
      const memoryCmd = DEFAULT_SLASH_COMMANDS.find((cmd) => cmd.name === "clawcode-memory");
      expect(memoryCmd).toBeDefined();
      expect(memoryCmd!.options).toHaveLength(1);

      const queryOpt = memoryCmd!.options[0];
      expect(queryOpt.name).toBe("query");
      expect(queryOpt.type).toBe(3);
      expect(queryOpt.required).toBe(true);
      expect(queryOpt.description).toBeTruthy();
    });

    it("commands without options have an empty options array", () => {
      // Phase 87 CMD-04 — after removing compact + usage, the no-options set
      // shrinks from 5 to 3 (status, schedule, health).
      // Phase 88 MKT-01 / MKT-07 / UI-01 — clawcode-skills-browse and
      // clawcode-skills are picker-driven (zero free-text args); they join
      // the no-options set.
      // Phase 999.31 — ultra-plan and ultra-review have an `args` option.
      // Phase 999.32 — gsd-do has an `args` option.
      const withOptions = new Set([
        "clawcode-memory",
        "clawcode-model",
        "clawcode-style",
        "clawcode-effort",
        "ultra-plan",
        "ultra-review",
        "gsd-do",
        // Phase 135 Plan 01 Task 3 — /vc carries three SUB_COMMAND (type=1)
        // options: join, leave, status. Plan 02 will add a nested
        // channel:CHANNEL option to the join subcommand.
        "vc",
      ]);
      const noOptionCmds = DEFAULT_SLASH_COMMANDS.filter((cmd) => !withOptions.has(cmd.name));
      // 2026-09-23: status, schedule, health, skills (style was
      // missing from withOptions; the three retired browse/auth commands left).
      expect(noOptionCmds.length).toBe(4);
      for (const cmd of noOptionCmds) {
        expect(cmd.options).toEqual([]);
      }
    });

    it("(Phase 88 UI-01) clawcode-skills has empty claudeCommand and zero options", () => {
      const skills = DEFAULT_SLASH_COMMANDS.find((c) => c.name === "clawcode-skills");
      expect(skills).toBeDefined();
      expect(skills!.claudeCommand).toBe("");
      expect(skills!.options).toHaveLength(0);
    });

    it("the model command has OPTIONAL `model` and `agent` options, both STRING (3)", () => {
      // Phase 86 MODEL-02 — `/clawcode-model` (no arg) opens the native
      // StringSelectMenuBuilder picker; `/clawcode-model <alias>` dispatches
      // directly via IPC. The option must therefore be OPTIONAL (required: false)
      // so Discord lets users invoke the command with no argument.
      //
      // 2026-09-04 — `agent` added as a second OPTIONAL option so a model can
      // be changed from outside the target agent's channel, matching
      // /clawcode-effort and /clawcode-style. Both must stay optional: `model`
      // omitted opens the picker, `agent` omitted falls back to the channel
      // binding.
      const modelCmd = DEFAULT_SLASH_COMMANDS.find((cmd) => cmd.name === "clawcode-model");
      expect(modelCmd).toBeDefined();
      expect(modelCmd!.options).toHaveLength(2);

      const modelOpt = modelCmd!.options.find((o) => o.name === "model");
      expect(modelOpt).toBeDefined();
      expect(modelOpt!.type).toBe(3);
      expect(modelOpt!.required).toBe(false);
      expect(modelOpt!.description).toBeTruthy();

      // The fleet-agent dropdown is injected in slash-commands.ts for any
      // option named exactly "agent" that carries NO static choices — rename
      // it, or give it choices, and the injection silently skips it.
      const agentOpt = modelCmd!.options.find((o) => o.name === "agent");
      expect(agentOpt).toBeDefined();
      expect(agentOpt!.type).toBe(3);
      expect(agentOpt!.required).toBe(false);
      expect(agentOpt!.description).toBeTruthy();
      expect(agentOpt!.choices ?? []).toHaveLength(0);
    });

    it("default commands are readonly arrays", () => {
      // Verify the array and nested options are readonly by checking structure
      expect(Array.isArray(DEFAULT_SLASH_COMMANDS)).toBe(true);
      for (const cmd of DEFAULT_SLASH_COMMANDS) {
        expect(Array.isArray(cmd.options)).toBe(true);
      }
    });
  });

  describe("CONTROL_COMMANDS", () => {
    // 2026-08-26 999.63d/7 — /clawcode-verify added -> 22 controls.
    // 2026-09-23 999.164 — /clawcode-quick added -> 23 controls.
    // 2026-09-23 — agent-create, edit-skill, patch-skill, approve-patch and
    // reject-patch retired -> 18 controls.
    // 2026-09-24 999.171 added clawcode-ux → 19.
    it("does NOT contain the control commands retired 2026-09-23 (approve/reject-skill stay for /clawcode-optimize drafts)", () => {
      const names = CONTROL_COMMANDS.map((c) => c.name);
      for (const retired of ["clawcode-agent-create", "edit-skill", "patch-skill", "approve-patch", "reject-patch"]) {
        expect(names).not.toContain(retired);
      }
      expect(names).toContain("approve-skill");
      expect(names).toContain("reject-skill");
      expect(names).toContain("clawcode-optimize");
    });

    it("contains exactly 20 control commands", () => {
      // Quick task 260419-nic — grew from 5 to 7 with clawcode-interrupt +
      // clawcode-steer. Phase 85 Plan 03 added clawcode-tools → 8.
      // Phase 91 Plan 05 added clawcode-sync-status → 9.
      // Phase 92 Plan 04 added clawcode-cutover-verify → 10.
      // Phase 95 Plan 03 added clawcode-dream → 11.
      // Phase 96 Plan 05 added clawcode-probe-fs → 12.
      // Phase 103 Plan 03 added clawcode-usage → 13.
      // Phase 999.32 — clawcode-probe-fs slash removed (operator cleanup) → 12.
      // Phase 117 Plan 117-11 added clawcode-verbose → 11. (Note: the
      // historical comment chain above was off-by-one; runtime length
      // pre-117-11 was 10 — verified 2026-05-13.)
      // Phase 124 Plan 03 added clawcode-session-compact → 12.
      // Phase 132 Plan 03 added approve-skill / reject-skill / edit-skill → 15.
      // Phase 999.42 Plan 06 added patch-skill / approve-patch / reject-patch → 18.
      // Phase 142 added clawcode-optimize → 19.
      // 2026-06-26 added clawcode-workflows → 21 (was 20 incl. /clawcode-goal).
      // 2026-08-26 999.63d/7 added clawcode-verify → 22.
      // 2026-09-23 999.164 added clawcode-quick → 23.
      // 2026-09-23 retired clawcode-agent-create, edit-skill, patch-skill,
      // approve-patch, reject-patch → 18.
      // 2026-09-24 999.171 added clawcode-ux → 19.
      // 2026-09-24 999.176 added clawcode-account → 20.
      expect(CONTROL_COMMANDS).toHaveLength(20);
    });

    it("all control commands have control: true and a valid ipcMethod", () => {
      const validMethods = [
        "start",
        "stop",
        "restart",
        "status",
        // 2026-06-26 — /clawcode-workflows reads daemon workflow state.
        "workflow-status",
        "agent-create",
        // Quick task 260419-nic — mid-turn abort + redirect.
        "interrupt-agent",
        "steer-agent",
        // Phase 85 Plan 03 TOOL-06 — /clawcode-tools reads MCP state via
        // the list-mcp-status IPC shipped in Plan 01.
        "list-mcp-status",
        // Phase 91 Plan 05 SYNC-08 — /clawcode-sync-status reads sync
        // state via list-sync-status IPC shipped in 91-05.
        "list-sync-status",
        // Phase 92 Plan 04 CUT-06 — /clawcode-cutover-verify
        "cutover-verify-summary",
        // Phase 95 Plan 03 DREAM-07 — /clawcode-dream operator-driven
        // manual dream-pass trigger via run-dream-pass IPC shipped in 95-03.
        "run-dream-pass",
        // Phase 142 — /clawcode-optimize operator-driven agent-optimizer trigger.
        "run-agent-optimization",
        // Phase 999.176 — /clawcode-account (inline flow; status is the only IPC it names).
        "account-status",
        // Phase 96 Plan 05 D-03 — /clawcode-probe-fs operator-driven
        // filesystem capability probe trigger via probe-fs IPC.
        "probe-fs",
        // Phase 103 Plan 03 OBS-07 — /clawcode-usage daemon-routed
        // OAuth Max usage panel via list-rate-limit-snapshots IPC
        // (NOT rate-limit-status — see Pitfall 5).
        "list-rate-limit-snapshots",
        // Phase 117 Plan 117-11 — /clawcode-verbose operator-driven
        // per-channel advisor-visibility toggle via set-verbose-level IPC.
        "set-verbose-level",
        // 2026-08-26 999.63d/7 — /clawcode-verify.
        "set-verification",
        // 2026-09-23 999.164 — /clawcode-quick.
        "set-fast-lane",
        // 2026-09-24 999.171 — /clawcode-ux.
        "set-ux-feature",
        // Phase 124 Plan 03 — /clawcode-session-compact operator-driven
        // session-compaction trigger via compact-session IPC.
        "compact-session",
        // Phase 132 Plan 03 — operator review surface for candidate skill
        // drafts (out-of-band Haiku 4.5 distiller, Plan 02). Three slash
        // commands; admin-only ephemeral matching /clawcode-dream pattern.
        "approve-skill-draft",
        "reject-skill-draft",
        "edit-skill-draft",
        // Phase 999.42 Plan 06 — operator review surface for the skill PATCH
        // lifecycle (capability C). Three slash commands; admin-only
        // ephemeral matching the Phase 132 /approve-skill pattern.
        "list-skill-patches",
        "apply-skill-patch",
        "reject-skill-patch",
        // /clawcode-goal — autonomous goal loop. Nominal ipcMethod (the inline
        // handler picks goal-set / goal-status / goal-clear from the options).
        "goal-set",
      ];
      for (const cmd of CONTROL_COMMANDS) {
        expect(cmd.control).toBe(true);
        expect(validMethods).toContain(cmd.ipcMethod);
      }
    });

    it("clawcode-ux is ONE admin-only control command routed to set-ux-feature (999.171)", () => {
      const cmd = CONTROL_COMMANDS.find((c) => c.name === "clawcode-ux");
      expect(cmd).toBeDefined();
      // Parity with /clawcode-quick (T-999.171-06).
      expect(cmd!.defaultMemberPermissions).toBe("0");
      expect(cmd!.control).toBe(true);
      expect(cmd!.ipcMethod).toBe("set-ux-feature");
      // 999.173 polish — `model` (research only) sits before the free-text agent option.
      expect(cmd!.options.map((o) => o.name)).toEqual(["feature", "state", "model", "agent"]);
      expect(cmd!.options[2]!.required).toBe(false);
      expect(cmd!.options[2]!.choices?.map((c) => c.value)).toEqual(["opus", "sonnet", "haiku", "fable", "inherit", "reset"]);
      expect(cmd!.options[2]!.description.length).toBeLessThanOrEqual(100);
      // Discord requires required options before optional ones.
      expect(cmd!.options[0]!.required).toBe(true);
      expect(cmd!.options[0]!.choices?.map((c) => c.value)).toEqual(["thinking", "ping", "suggestions", "research"]);
      // reset added 2026-09-24 (operator): a choice, not a new command.
      expect(cmd!.options[1]!.choices?.map((c) => c.value)).toEqual(["on", "off", "status", "reset"]);
      expect(cmd!.options[1]!.description).toContain("reset");
      expect(cmd!.options[1]!.description.length).toBeLessThanOrEqual(100);
      expect(cmd!.description).toContain("reset");
      expect(cmd!.description.length).toBeLessThanOrEqual(100);
      // No emoji anywhere in the entry (999.157 / 999.171 operator rule).
      expect(JSON.stringify(cmd)).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("all control commands have empty claudeCommand", () => {
      for (const cmd of CONTROL_COMMANDS) {
        expect(cmd.claudeCommand).toBe("");
      }
    });

    it("start, stop, restart each have a required agent option", () => {
      const agentCmds = CONTROL_COMMANDS.filter(
        (c) => c.ipcMethod === "start" || c.ipcMethod === "stop" || c.ipcMethod === "restart",
      );
      expect(agentCmds).toHaveLength(3);
      for (const cmd of agentCmds) {
        expect(cmd.options).toHaveLength(1);
        expect(cmd.options[0].name).toBe("agent");
        expect(cmd.options[0].type).toBe(3);
        expect(cmd.options[0].required).toBe(true);
      }
    });

    it("fleet command has no options", () => {
      const fleet = CONTROL_COMMANDS.find(
        (c) => c.name === "clawcode-fleet",
      );
      expect(fleet).toBeDefined();
      expect(fleet!.options).toHaveLength(0);
    });

    it("includes all expected command names", () => {
      const names = CONTROL_COMMANDS.map((c) => c.name);
      expect(names).toContain("clawcode-start");
      expect(names).toContain("clawcode-stop");
      expect(names).toContain("clawcode-restart");
      expect(names).toContain("clawcode-fleet");
    });
  });

  describe("type contracts", () => {
    it("SlashCommandOption satisfies the expected shape", () => {
      const opt: SlashCommandOption = {
        name: "test",
        type: 3,
        description: "A test option",
        required: true,
      };
      expect(opt.name).toBe("test");
      expect(opt.type).toBe(3);
    });

    it("SlashCommandDef satisfies the expected shape", () => {
      const def: SlashCommandDef = {
        name: "test",
        description: "A test command",
        claudeCommand: "do something",
        options: [],
      };
      expect(def.name).toBe("test");
      expect(def.options).toEqual([]);
    });
  });
});
