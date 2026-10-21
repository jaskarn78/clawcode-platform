/**
 * Phase 94 Plan 06 — TOOL-10 / D-10 / D-09 / D-07
 *
 * Schema + resolver tests for `defaults.systemPromptDirectives` — the new
 * additive-optional config field that ships two default-shipped directives
 * (file-sharing, cross-agent-routing) plus a per-agent override merge.
 *
 * 8th application of the Phase 83/86/89/90/92 additive-optional schema
 * blueprint — v2.5 migrated configs without `systemPromptDirectives` MUST
 * parse unchanged (regression-pinned by REG-V25-BACKCOMPAT).
 *
 * Static-grep regression pins (DO NOT remove):
 *   - "ALWAYS upload via Discord" — D-09 file-sharing verbatim
 *   - "suggest the user ask another agent" — D-07 cross-agent-routing verbatim
 *   - "REG-V25-BACKCOMPAT" — additive-optional invariant marker
 *   - "REG-OVERRIDE-PARTIAL" — partial-override merge invariant marker
 */
import { describe, it, expect } from "vitest";
import {
  agentSchema,
  defaultsSchema,
  systemPromptDirectiveSchema,
  DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
  type SystemPromptDirective,
} from "../schema.js";
import { resolveSystemPromptDirectives } from "../loader.js";

describe("systemPromptDirectiveSchema (Phase 94 TOOL-10)", () => {
  it("TOOL-10-S0: shape is { enabled: boolean, text: string }", () => {
    const ok = systemPromptDirectiveSchema.safeParse({
      enabled: true,
      text: "hello",
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.enabled).toBe(true);
      expect(ok.data.text).toBe("hello");
    }
  });
});

describe("DEFAULT_SYSTEM_PROMPT_DIRECTIVES (Phase 94 D-09 + D-07)", () => {
  it("REG-DEFAULTS-PRESENT: ships D-09/D-07 default keys plus subagent-routing + memory-recall + propose-alternatives + long-output-to-file + verify-file-writes plus freshness + derivative-work + trusted-operator + discord-format plus mutate-verify plus parallel-tool-calls plus no-em-dashes (15 directives total)", () => {
    const keys = Object.keys(DEFAULT_SYSTEM_PROMPT_DIRECTIVES).sort();
    // Phase 99 added subagent-routing; Phase 100-fu added memory-recall-before-uncertainty,
    // propose-alternatives, long-output-to-file, and verify-file-writes; Phase 999.1 added
    // freshness, derivative-work, trusted-operator, discord-format; Phase 999.22 added
    // mutate-verify; Phase 115 Plan 08 T02 (sub-scope 17c) added parallel-tool-calls;
    // Phase 999.79 (2026-05-23) adds no-em-dashes (companion to the
    // src/discord/text-sanitization.ts hard strip — 14 directives total).
    expect(keys).toEqual([
      "background-work-status",
      "cross-agent-routing",
      "derivative-work",
      "discord-format",
      "file-sharing",
      "follow-up-actions",
      "freshness",
      "long-output-to-file",
      "memory-recall-before-uncertainty",
      "mutate-verify",
      "no-em-dashes",
      "parallel-tool-calls",
      "propose-alternatives",
      "subagent-routing",
      "trusted-operator",
      "verify-file-writes",
    ]);
    // Both default-enabled per D-10 (operator-locked)
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["file-sharing"].enabled).toBe(true);
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["cross-agent-routing"].enabled).toBe(true);
    // 999.163 — follow-up buttons ride a fleet-wide directive; the bridge strips the block.
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["follow-up-actions"].enabled).toBe(false); // gated: per-agent opt-in
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["follow-up-actions"].text).toContain("<actions>");
    // D-09 file-sharing verbatim text contract
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["file-sharing"].text).toContain(
      "ALWAYS upload via Discord",
    );
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["file-sharing"].text).toContain(
      "NEVER just tell the user a local file path",
    );
    // D-07 cross-agent-routing verbatim text contract
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["cross-agent-routing"].text).toContain(
      "suggest the user ask another agent",
    );
  });
});

describe("no-em-dashes directive (Phase 999.79)", () => {
  it("NED-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES).toHaveProperty("no-em-dashes");
  });

  it("NED-DIR-2: directive is enabled by default", () => {
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["no-em-dashes"].enabled).toBe(true);
  });

  it("NED-DIR-3: directive text pins the canonical 'Do not use em dashes' phrase + en-dash carve-out", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["no-em-dashes"].text;
    // Canonical pin — the operative directive sentence verbatim.
    expect(text).toContain("Do not use em dashes");
    // Mentions the actual codepoint so model can disambiguate from a hyphen.
    expect(text).toContain("U+2014");
    // Explicitly preserves en dashes for valid grammatical uses (number ranges).
    expect(text).toContain("En dashes");
    // Names the companion hard-strip mechanism so the model knows compliance
    // saves tokens but non-compliance still produces correct output.
    expect(text).toContain("post-hoc filter");
  });
});

describe("memory-recall-before-uncertainty directive (Phase 100-fu)", () => {
  it("MEM-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "memory-recall-before-uncertainty",
      ),
    ).toBe(true);
  });

  it("MEM-DIR-2: directive is enabled by default", () => {
    expect(
      DEFAULT_SYSTEM_PROMPT_DIRECTIVES["memory-recall-before-uncertainty"]
        .enabled,
    ).toBe(true);
  });

  it("MEM-DIR-3: directive text mentions memory_lookup and 'I don't know'", () => {
    const text =
      DEFAULT_SYSTEM_PROMPT_DIRECTIVES["memory-recall-before-uncertainty"]
        .text;
    expect(text).toContain("memory_lookup");
    expect(text).toContain("I don't know");
  });
});

describe("propose-alternatives directive (Phase 100-fu)", () => {
  it("ALT-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "propose-alternatives",
      ),
    ).toBe(true);
  });

  it("ALT-DIR-2: directive is enabled by default", () => {
    expect(
      DEFAULT_SYSTEM_PROMPT_DIRECTIVES["propose-alternatives"].enabled,
    ).toBe(true);
  });

  it("ALT-DIR-3: directive text mentions 'alternatives' and 'constraint'", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["propose-alternatives"].text;
    expect(text).toContain("alternatives");
    expect(text).toContain("constraint");
  });
});

describe("long-output-to-file directive (Phase 100-fu)", () => {
  it("LOF-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "long-output-to-file",
      ),
    ).toBe(true);
  });

  it("LOF-DIR-2: directive is enabled by default", () => {
    expect(
      DEFAULT_SYSTEM_PROMPT_DIRECTIVES["long-output-to-file"].enabled,
    ).toBe(true);
  });

  it("LOF-DIR-3: directive text mentions 'Discord messages are hard-capped' and SAVE/POST flow", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["long-output-to-file"].text;
    expect(text).toContain("Discord messages are hard-capped");
    expect(text).toContain("SAVE");
    expect(text).toContain("POST");
    expect(text).toContain("VERIFY");
  });
});

describe("verify-file-writes directive (Phase 100-fu)", () => {
  it("VFW-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "verify-file-writes",
      ),
    ).toBe(true);
  });

  it("VFW-DIR-2: directive is enabled by default", () => {
    expect(
      DEFAULT_SYSTEM_PROMPT_DIRECTIVES["verify-file-writes"].enabled,
    ).toBe(true);
  });

  it("VFW-DIR-3: directive text mentions 'verify it by reading' and hallucinated saves", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["verify-file-writes"].text;
    expect(text).toContain("verify it by reading");
    expect(text).toContain("hallucinated");
  });
});

describe("freshness directive (Phase 999.1)", () => {
  it("FRESH-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "freshness",
      ),
    ).toBe(true);
  });

  it("FRESH-DIR-2: directive is enabled by default", () => {
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["freshness"].enabled).toBe(true);
  });

  it("FRESH-DIR-3: directive text pins canonical phrase 'Do not anchor on training-cutoff knowledge' (D-FR-04)", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["freshness"].text;
    expect(text).toContain("Do not anchor on training-cutoff knowledge");
  });
});

describe("derivative-work directive (Phase 999.1)", () => {
  it("DERIV-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "derivative-work",
      ),
    ).toBe(true);
  });

  it("DERIV-DIR-2: directive is enabled by default", () => {
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["derivative-work"].enabled).toBe(
      true,
    );
  });

  it("DERIV-DIR-3: directive text pins canonical phrase 'are all in-scope work product' (D-DR-03)", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["derivative-work"].text;
    expect(text).toContain("are all in-scope work product");
  });
});

describe("trusted-operator directive (Phase 999.1)", () => {
  it("TRUST-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "trusted-operator",
      ),
    ).toBe(true);
  });

  it("TRUST-DIR-2: directive is enabled by default", () => {
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["trusted-operator"].enabled).toBe(
      true,
    );
  });

  it("TRUST-DIR-3: directive text pins canonical phrase 'Skip all CYA language' (D-TR-03)", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["trusted-operator"].text;
    expect(text).toContain("Skip all CYA language");
  });
});

describe("discord-format directive (Phase 999.1)", () => {
  it("TABLE-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "discord-format",
      ),
    ).toBe(true);
  });

  it("TABLE-DIR-2: directive is enabled by default", () => {
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["discord-format"].enabled).toBe(
      true,
    );
  });

  it("TABLE-DIR-3: directive text pins canonical phrase 'prefer bullets, numbered lists, or definition-style prose' (D-TB-03)", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["discord-format"].text;
    expect(text).toContain(
      "prefer bullets, numbered lists, or definition-style prose",
    );
  });
});

describe("mutate-verify directive (Phase 999.22)", () => {
  it("MUTATE-DIR-1: directive key is present in DEFAULT_SYSTEM_PROMPT_DIRECTIVES", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
        "mutate-verify",
      ),
    ).toBe(true);
  });

  it("MUTATE-DIR-2: directive is enabled by default", () => {
    expect(DEFAULT_SYSTEM_PROMPT_DIRECTIVES["mutate-verify"].enabled).toBe(
      true,
    );
  });

  it("MUTATE-DIR-3: directive text pins canonical phrase 'Quote the post-mutation evidence' (Phase 999.22 hallucinated-success failure mode)", () => {
    const text = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["mutate-verify"].text;
    expect(text).toContain("Quote the post-mutation evidence");
  });
});

describe("defaultsSchema.systemPromptDirectives (Phase 94 D-10)", () => {
  it("REG-V25-BACKCOMPAT: defaultsSchema.parse({}) populates systemPromptDirectives with the defaults (additive-optional, 8th application)", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Default-bearing: legacy v2.5 migrated configs without
      // systemPromptDirectives MUST resolve to a concrete record matching
      // DEFAULT_SYSTEM_PROMPT_DIRECTIVES exactly (REG-V25-BACKCOMPAT pin).
      expect(result.data.systemPromptDirectives).toBeDefined();
      expect(
        Object.keys(result.data.systemPromptDirectives ?? {}).sort(),
      ).toEqual([
        "background-work-status",
        "cross-agent-routing",
        "derivative-work",
        "discord-format",
        "file-sharing",
        "follow-up-actions",
        "freshness",
        "long-output-to-file",
        "memory-recall-before-uncertainty",
        "mutate-verify",
        "no-em-dashes",
        "parallel-tool-calls",
        "propose-alternatives",
        "subagent-routing",
        "trusted-operator",
        "verify-file-writes",
      ]);
      expect(
        result.data.systemPromptDirectives?.["file-sharing"].text,
      ).toContain("ALWAYS upload via Discord");
      expect(
        result.data.systemPromptDirectives?.["cross-agent-routing"].text,
      ).toContain("suggest the user ask another agent");
    }
  });

  it("REG-OVERRIDE-DEFAULTS: defaultsSchema accepts explicit systemPromptDirectives override", () => {
    const result = defaultsSchema.safeParse({
      systemPromptDirectives: {
        "custom-rule": { enabled: true, text: "Be terse." },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.systemPromptDirectives?.["custom-rule"]?.text,
      ).toBe("Be terse.");
    }
  });
});

describe("agentSchema.systemPromptDirectives (Phase 94 D-10 per-agent override)", () => {
  it("agentSchema.parse({name:'x'}) leaves systemPromptDirectives undefined (optional)", () => {
    const result = agentSchema.safeParse({ name: "x" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPromptDirectives).toBeUndefined();
    }
  });

  it("REG-OVERRIDE-PARTIAL: agentSchema accepts a partial directive override (only enabled set)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      systemPromptDirectives: {
        "file-sharing": { enabled: false },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.systemPromptDirectives?.["file-sharing"]?.enabled,
      ).toBe(false);
      // Partial: text is optional in override shape
      expect(
        result.data.systemPromptDirectives?.["file-sharing"]?.text,
      ).toBeUndefined();
    }
  });

  it("REG-MALFORMED-REJECTED: agentSchema rejects malformed directive (enabled is not boolean)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      systemPromptDirectives: {
        "file-sharing": { enabled: "not-a-bool" },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("resolveSystemPromptDirectives (Phase 94 D-10 per-key merge)", () => {
  const defaults: Record<string, SystemPromptDirective> = {
    "file-sharing": {
      enabled: true,
      text: "ALWAYS upload via Discord and return the CDN URL.",
    },
    "cross-agent-routing": {
      enabled: true,
      text: "suggest the user ask another agent in another channel.",
    },
  };

  it("REG-OVERRIDE-PARTIAL: agent override file-sharing.enabled=false drops file-sharing but keeps cross-agent-routing (inherits default)", () => {
    const out = resolveSystemPromptDirectives(
      { "file-sharing": { enabled: false } },
      defaults,
    );
    const keys = out.map((d) => d.key);
    expect(keys).not.toContain("file-sharing");
    expect(keys).toContain("cross-agent-routing");
  });

  it("REG-OVERRIDE-TEXT: agent override changes text but keeps enabled (inherited)", () => {
    const out = resolveSystemPromptDirectives(
      { "file-sharing": { text: "Custom directive." } },
      defaults,
    );
    const fileSharing = out.find((d) => d.key === "file-sharing");
    expect(fileSharing).toBeDefined();
    expect(fileSharing?.text).toBe("Custom directive.");
  });

  it("REG-OVERRIDE-NEW-DIRECTIVE: agent override adds a new directive on top of defaults (sorted alpha)", () => {
    const out = resolveSystemPromptDirectives(
      { "custom-rule": { enabled: true, text: "Be terse." } },
      defaults,
    );
    const keys = out.map((d) => d.key);
    // Three directives total, sorted alphabetically for cache stability
    expect(keys).toEqual(["cross-agent-routing", "custom-rule", "file-sharing"]);
  });

  it("REG-DETERMINISTIC: same input → byte-identical sorted output", () => {
    const out1 = resolveSystemPromptDirectives(undefined, defaults);
    const out2 = resolveSystemPromptDirectives(undefined, defaults);
    expect(out1.map((d) => d.key)).toEqual(out2.map((d) => d.key));
    expect(out1.map((d) => d.text)).toEqual(out2.map((d) => d.text));
    // Sort order MUST be alphabetical by key (deterministic for prompt-cache hash)
    const keys = out1.map((d) => d.key);
    expect(keys).toEqual([...keys].sort());
  });
});
