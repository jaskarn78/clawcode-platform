/**
 * Debug session `in-tool-wedge-recovery` work-stream (B) — classifier +
 * wedge-recovery decision-core test suite.
 *
 * Covers:
 *   - classifyTool: read-only built-ins, mutating built-ins, Bash always
 *     mutating, MCP annotation (readOnly / destructive / absent), MCP
 *     fallback allowlist, unknown / malformed / empty → mutating.
 *   - isBatchReadOnly: all-read-only true, any-mutating false, any-unknown
 *     false, empty true.
 *   - decideWedgeRecovery: pure-text hang (empty) → auto-rerun, all
 *     read-only → auto-rerun, any mutating → notify, max-pause +
 *     sweep-force-release reasons honoured.
 *   - CANONICAL PINS: static-grep the source so a future edit that empties
 *     either allowlist fails this test.
 *
 * The classifier is pure — no mocks, no SDK harness needed.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyTool,
  isBatchReadOnly,
  decideWedgeRecovery,
  isDetachableTool,
  describeStallNotice,
  READ_ONLY_BUILTIN_TOOLS,
  READ_ONLY_MCP_TOOL_SUFFIXES,
  DETACHABLE_TOOLS,
  type McpToolAnnotationSnapshot,
  type WedgeInfo,
} from "../tool-mutation-classifier.js";
import { icons } from "../../discord/icons.js";

describe("classifyTool — built-in tools", () => {
  it("classifies the read-only built-in allowlist as read-only", () => {
    for (const name of ["Read", "Grep", "Glob", "WebSearch", "WebFetch"]) {
      expect(classifyTool(name)).toBe("read-only");
    }
  });

  it("classifies Bash as MUTATING unconditionally (args not inspected)", () => {
    expect(classifyTool("Bash")).toBe("mutating");
  });

  it("classifies write-class built-ins as mutating", () => {
    for (const name of ["Write", "Edit", "NotebookEdit", "TodoWrite", "Task"]) {
      expect(classifyTool(name)).toBe("mutating");
    }
  });

  it("classifies an unknown built-in name as mutating (conservative default)", () => {
    expect(classifyTool("SomeFutureBuiltinTool")).toBe("mutating");
    expect(classifyTool("NotebookRead")).toBe("mutating");
    expect(classifyTool("TodoRead")).toBe("mutating");
  });

  it("classifies an empty / non-string tool name as mutating", () => {
    expect(classifyTool("")).toBe("mutating");
    expect(classifyTool(undefined as unknown as string)).toBe("mutating");
    expect(classifyTool(null as unknown as string)).toBe("mutating");
  });
});

describe("classifyTool — MCP tools via fallback allowlist (no annotation)", () => {
  it("classifies allowlisted clawcode-MCP read tools as read-only", () => {
    expect(classifyTool("mcp__clawcode__memory_lookup")).toBe("read-only");
    expect(classifyTool("mcp__clawcode__ask_advisor")).toBe("read-only");
    expect(classifyTool("mcp__search__web_search")).toBe("read-only");
    expect(classifyTool("mcp__clawcode__find_agents")).toBe("read-only");
  });

  it("classifies a non-allowlisted MCP tool as mutating (unknown default)", () => {
    expect(classifyTool("mcp__clawcode__spawn_subagent_thread")).toBe(
      "mutating",
    );
    expect(classifyTool("mcp__clawcode__post_to_agent")).toBe("mutating");
    expect(classifyTool("mcp__finnhub__quote")).toBe("mutating");
  });

  it("treats a malformed mcp__ name as a builtin → mutating", () => {
    expect(classifyTool("mcp__")).toBe("mutating");
    expect(classifyTool("mcp__clawcode")).toBe("mutating");
    expect(classifyTool("mcp__clawcode__")).toBe("mutating");
  });
});

describe("classifyTool — MCP tools via SDK annotation", () => {
  const snapshot: readonly McpToolAnnotationSnapshot[] = [
    {
      name: "weather",
      tools: [
        { name: "get_forecast", annotations: { readOnly: true } },
        { name: "set_alert", annotations: { readOnly: false } },
        {
          name: "purge_cache",
          annotations: { destructive: true, readOnly: true },
        },
        { name: "no_annotation_tool" },
      ],
    },
  ];

  it("uses an explicit readOnly:true annotation", () => {
    expect(classifyTool("mcp__weather__get_forecast", snapshot)).toBe(
      "read-only",
    );
  });

  it("uses an explicit readOnly:false annotation", () => {
    expect(classifyTool("mcp__weather__set_alert", snapshot)).toBe("mutating");
  });

  it("lets destructive:true override a readOnly:true on the same tool", () => {
    expect(classifyTool("mcp__weather__purge_cache", snapshot)).toBe(
      "mutating",
    );
  });

  it("falls back to the allowlist when the tool has no annotation", () => {
    // no_annotation_tool is not on the fallback allowlist → mutating
    expect(classifyTool("mcp__weather__no_annotation_tool", snapshot)).toBe(
      "mutating",
    );
  });

  it("falls back to the allowlist when the server is absent from the snapshot", () => {
    // search server not in `snapshot` → fallback allowlist hit → read-only
    expect(classifyTool("mcp__search__web_search", snapshot)).toBe(
      "read-only",
    );
  });

  it("annotation overrides the fallback allowlist (annotation wins)", () => {
    // A server that annotates web_search as destructive must win over the
    // fallback allowlist that lists `web_search` as read-only.
    const hostile: readonly McpToolAnnotationSnapshot[] = [
      {
        name: "search",
        tools: [
          { name: "web_search", annotations: { destructive: true } },
        ],
      },
    ];
    expect(classifyTool("mcp__search__web_search", hostile)).toBe("mutating");
  });
});

describe("isBatchReadOnly", () => {
  it("is true when every tool is read-only", () => {
    expect(isBatchReadOnly(["Read", "Grep", "mcp__clawcode__memory_lookup"])).toBe(
      true,
    );
  });

  it("is false when any tool is mutating", () => {
    expect(isBatchReadOnly(["Read", "Bash"])).toBe(false);
    expect(isBatchReadOnly(["Read", "Write", "Grep"])).toBe(false);
  });

  it("is false when any tool is unknown", () => {
    expect(isBatchReadOnly(["Read", "SomeUnknownTool"])).toBe(false);
  });

  it("is true (vacuously) for an empty batch", () => {
    expect(isBatchReadOnly([])).toBe(true);
  });
});

describe("decideWedgeRecovery", () => {
  it("auto-reruns a pure-text hang (no tool in flight)", () => {
    const wedge: WedgeInfo = {
      reason: "no-useful-tokens",
      inFlightToolNames: [],
    };
    expect(decideWedgeRecovery(wedge)).toBe("auto-rerun");
  });

  it("auto-reruns when the single in-flight tool is read-only", () => {
    const wedge: WedgeInfo = {
      reason: "max-pause-exceeded",
      inFlightToolNames: ["Read"],
    };
    expect(decideWedgeRecovery(wedge)).toBe("auto-rerun");
  });

  it("notifies when the single in-flight tool is mutating", () => {
    const wedge: WedgeInfo = {
      reason: "max-pause-exceeded",
      inFlightToolNames: ["Bash"],
    };
    expect(decideWedgeRecovery(wedge)).toBe("notify");
  });

  it("notifies when the in-flight tool is unknown (conservative)", () => {
    const wedge: WedgeInfo = {
      reason: "sweep-force-release",
      inFlightToolNames: ["mcp__clawcode__post_to_agent"],
    };
    expect(decideWedgeRecovery(wedge)).toBe("notify");
  });

  it("auto-reruns a parallel batch only when every tool is read-only", () => {
    expect(
      decideWedgeRecovery({
        reason: "max-pause-exceeded",
        inFlightToolNames: ["Read", "Grep", "mcp__clawcode__memory_lookup"],
      }),
    ).toBe("auto-rerun");
  });

  it("notifies a parallel batch when any tool is mutating (FORK 5)", () => {
    expect(
      decideWedgeRecovery({
        reason: "max-pause-exceeded",
        inFlightToolNames: ["Read", "Grep", "Bash"],
      }),
    ).toBe("notify");
  });

  it("honours the SDK annotation snapshot in the decision", () => {
    const snapshot: readonly McpToolAnnotationSnapshot[] = [
      {
        name: "weather",
        tools: [{ name: "get_forecast", annotations: { readOnly: true } }],
      },
    ];
    expect(
      decideWedgeRecovery(
        {
          reason: "max-pause-exceeded",
          inFlightToolNames: ["mcp__weather__get_forecast"],
        },
        snapshot,
      ),
    ).toBe("auto-rerun");
  });
});

describe("canonical pins — allowlists must not silently empty", () => {
  const src = readFileSync(
    join(__dirname, "..", "tool-mutation-classifier.ts"),
    "utf8",
  );

  it("READ_ONLY_BUILTIN_TOOLS exports its five locked entries", () => {
    expect(READ_ONLY_BUILTIN_TOOLS).toEqual([
      "Read",
      "Grep",
      "Glob",
      "WebSearch",
      "WebFetch",
    ]);
    for (const name of READ_ONLY_BUILTIN_TOOLS) {
      expect(src).toContain(`"${name}"`);
    }
  });

  it("READ_ONLY_MCP_TOOL_SUFFIXES is non-empty and frozen", () => {
    expect(READ_ONLY_MCP_TOOL_SUFFIXES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(READ_ONLY_MCP_TOOL_SUFFIXES)).toBe(true);
    expect(Object.isFrozen(READ_ONLY_BUILTIN_TOOLS)).toBe(true);
  });

  it("Bash is NOT on the read-only built-in allowlist", () => {
    expect(READ_ONLY_BUILTIN_TOOLS).not.toContain("Bash");
  });

  it("DETACHABLE_TOOLS is non-empty, frozen, and pins Bash + Task", () => {
    expect(DETACHABLE_TOOLS).toEqual(["Bash", "Task"]);
    expect(DETACHABLE_TOOLS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DETACHABLE_TOOLS)).toBe(true);
    for (const name of DETACHABLE_TOOLS) {
      expect(src).toContain(`"${name}"`);
    }
  });
});

describe("isDetachableTool — work-stream C, FORK 8", () => {
  it("returns true for the detachable foreground-task built-ins", () => {
    expect(isDetachableTool("Bash")).toBe(true);
    expect(isDetachableTool("Task")).toBe(true);
  });

  it("returns false for non-task built-ins (Read/Grep/Write/Edit)", () => {
    for (const name of ["Read", "Grep", "Glob", "Write", "Edit"]) {
      expect(isDetachableTool(name)).toBe(false);
    }
  });

  it("returns false for EVERY MCP tool — backgroundTasks never targets MCP", () => {
    expect(isDetachableTool("mcp__clawcode__memory_lookup")).toBe(false);
    expect(isDetachableTool("mcp__finnhub__quote")).toBe(false);
    // A contrived mcp__ name whose suffix collides with a detachable
    // built-in must STILL be non-detachable (MCP short-circuit).
    expect(isDetachableTool("mcp__evil__Bash")).toBe(false);
  });

  it("returns false for an unknown / empty / non-string name", () => {
    expect(isDetachableTool("SomeFutureTool")).toBe(false);
    expect(isDetachableTool("")).toBe(false);
    expect(isDetachableTool(undefined as unknown as string)).toBe(false);
  });

  it("the detachable axis is ORTHOGONAL to read-only/mutating — Bash is both mutating and detachable", () => {
    expect(classifyTool("Bash")).toBe("mutating");
    expect(isDetachableTool("Bash")).toBe(true);
  });
});

describe("describeStallNotice — cc_* warning glyph, never Unicode (999.178 R1)", () => {
  afterEach(() => icons.clear());

  it("falls back to plain text when the icon set is not loaded", () => {
    icons.clear();
    const notice = describeStallNotice({ reason: "max-turn-duration", inFlightToolNames: [] });
    expect(notice.startsWith("That response hit the maximum turn duration")).toBe(true);
    expect(notice).not.toContain("⚠️");
  });

  it("leads with the cc_warning custom emoji when the set is loaded", () => {
    icons.setAll([{ id: "77", name: "cc_warning" }]);
    const pureText = describeStallNotice({ reason: "no-useful-tokens", inFlightToolNames: [] });
    const withTool = describeStallNotice({ reason: "no-useful-tokens", inFlightToolNames: ["Bash"] });
    expect(pureText.startsWith("<:cc_warning:77> ")).toBe(true);
    expect(withTool.startsWith("<:cc_warning:77> ")).toBe(true);
    for (const notice of [pureText, withTool]) expect(notice).not.toContain("⚠️");
  });
});
