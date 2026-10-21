/**
 * Phase 96 Plan 02 Task 2 (RED) — context-assembler integration tests.
 *
 * Five integration tests pin the assembler-level contract for the new
 * <filesystem_capability> block insertion site:
 *
 *   CA-FS-1 INSERTED-BETWEEN-MARKERS — assembled stable prefix contains
 *           <tool_status> ... <filesystem_capability> ... <dream_log_recent>
 *           in that order (cache-stability via byte-position invariant)
 *   CA-FS-2 EMPTY-FS-PREFIX-UNCHANGED — empty fs ⇒ no <filesystem_capability>
 *           substring AND no triplet markers (v2.5 fixture stable-prefix
 *           hash UNCHANGED)
 *   CA-FS-3 POPULATED-3-SECTIONS — populated fs ⇒ all 3 subsection headers
 *           rendered inside the <filesystem_capability> block
 *   CA-FS-4 STABLE-PREFIX-HASH-UNCHANGED-V25 — sha256 of full stable prefix
 *           with empty fs equals sha256 of the SAME prefix without the fs
 *           field threaded at all (cache-stability invariant for v2.5)
 *   CA-FS-5 IMMUTABILITY — assembler does not mutate the snapshot Map
 *           (ReadonlyMap contract; identity preserved via Object.is)
 *
 * The plan's <action> presumes a SessionHandle.getFsCapabilitySnapshot()
 * call inside the assembler. context-assembler.ts is pure (no SessionHandle
 * import); to preserve purity AND honor the plan's intent, the renderer is
 * invoked at the daemon edge (session-config.ts in production) and the
 * pre-rendered string flows through ContextSources.filesystemCapabilityBlock
 * exactly the way Phase 94 systemPromptDirectives is threaded. These tests
 * exercise the assembler-level contract directly via that field.
 *
 * Order pin (W-1 promoted to acceptance_criteria):
 *   `grep -A 50 '<tool_status>' src/manager/context-assembler.ts | grep -B 0
 *    '<dream_log_recent>' | grep -q '<filesystem_capability>'` exits 0
 *
 * The runtime ordering test (CA-FS-1) asserts the rendered stable prefix
 * contains the three substrings in source-byte order — independent of
 * variable name in the assembler implementation.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  assembleContext,
  type ContextSources,
} from "../context-assembler.js";
import {
  renderFilesystemCapabilityBlock,
} from "../../prompt/filesystem-capability-block.js";
import type { FsCapabilitySnapshot } from "../persistent-session-handle.js";

const AGENT_ROOT = "/home/clawcode/.clawcode/agents/fin-client";
const FIXED_NOW = new Date("2026-04-25T18:30:00Z");

function ready(modeOverride: "rw" | "ro" = "ro"): FsCapabilitySnapshot {
  return {
    status: "ready",
    mode: modeOverride,
    lastProbeAt: "2026-04-25T18:29:00Z",
    lastSuccessAt: "2026-04-25T18:29:00Z",
  };
}

function makeSources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    identity: "test agent identity",
    hotMemories: "",
    toolDefinitions: "tool_a: does stuff",
    graphContext: "",
    discordBindings: "",
    contextSummary: "",
    ...overrides,
  } as ContextSources;
}

describe("context-assembler — Phase 96 Plan 02 <filesystem_capability> block (D-02)", () => {
  it("CA-FS-1 INSERTED-BETWEEN-MARKERS: assembled stable prefix contains <tool_status> ... <filesystem_capability> ... <dream_log_recent> in that order", () => {
    // Mock SessionHandle equivalent: pre-render the fs snapshot at the
    // daemon edge and thread the resulting string through ContextSources
    // (matching how systemPromptDirectives is threaded — see Phase 94 D-10).
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
      ["/home/example-user/.openclaw/workspace-acme", ready("ro")],
    ]);
    const fsBlock = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(fsBlock).not.toBe(""); // sanity — populated snapshot ⇒ block

    const sources = makeSources({
      filesystemCapabilityBlock: fsBlock,
    });
    const result = assembleContext(sources);
    const prefix = result.stablePrefix;

    const toolIdx = prefix.indexOf("<tool_status>");
    const fsIdx = prefix.indexOf("<filesystem_capability>");
    const dreamIdx = prefix.indexOf("<dream_log_recent>");

    expect(toolIdx).toBeGreaterThan(-1);
    expect(fsIdx).toBeGreaterThan(toolIdx);
    expect(dreamIdx).toBeGreaterThan(fsIdx);

    // Order matters between markers — pinned by the static-grep regression
    // test on context-assembler.ts source AND by the runtime ordering above.
  });

  it("CA-FS-2 EMPTY-FS-PREFIX-UNCHANGED: empty fs snapshot ⇒ no <filesystem_capability> substring (v2.5 cache-stability)", () => {
    // v2.5 fixture state: no fileAccess declared ⇒ snapshot is empty Map ⇒
    // renderer returns empty string ⇒ ContextSources.filesystemCapabilityBlock
    // is "" ⇒ assembler emits NO triplet markers.
    const snapshot = new Map<string, FsCapabilitySnapshot>();
    const fsBlock = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(fsBlock).toBe(""); // empty snapshot ⇒ empty string (RF-EMPTY)

    const sources = makeSources({ filesystemCapabilityBlock: fsBlock });
    const result = assembleContext(sources);
    const prefix = result.stablePrefix;

    expect(prefix).not.toContain("<filesystem_capability>");
    expect(prefix).not.toContain("<tool_status>");
    expect(prefix).not.toContain("<dream_log_recent>");
  });

  it("CA-FS-3 POPULATED-3-SECTIONS: populated fs ⇒ My workspace + Operator-shared + Off-limits all render inside <filesystem_capability>", () => {
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
      ["/home/example-user/.openclaw/workspace-acme", ready("ro")],
      ["/home/example-user/.openclaw/workspace-coding", ready("ro")],
    ]);
    const fsBlock = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    const sources = makeSources({ filesystemCapabilityBlock: fsBlock });
    const result = assembleContext(sources);
    const prefix = result.stablePrefix;

    expect(prefix).toContain("<filesystem_capability>");
    expect(prefix).toContain("</filesystem_capability>");
    expect(prefix).toContain("## My workspace (full RW)");
    expect(prefix).toContain("## Operator-shared paths (per ACL)");
    expect(prefix).toContain("## Off-limits — do not attempt");
    // All section markers must be INSIDE the <filesystem_capability> block.
    const openIdx = prefix.indexOf("<filesystem_capability>");
    const closeIdx = prefix.indexOf("</filesystem_capability>");
    expect(prefix.indexOf("## My workspace (full RW)")).toBeGreaterThan(openIdx);
    expect(prefix.indexOf("## My workspace (full RW)")).toBeLessThan(closeIdx);
    expect(prefix.indexOf("## Off-limits")).toBeGreaterThan(openIdx);
    expect(prefix.indexOf("## Off-limits")).toBeLessThan(closeIdx);
  });

  it("CA-FS-4 STABLE-PREFIX-HASH-UNCHANGED-V25: sha256 of v2.5-style prefix (no fs field) === sha256 of v2.5-style prefix with empty fs threaded (cache-stability for v2.5 deploy)", () => {
    // Baseline: v2.5-style sources WITHOUT filesystemCapabilityBlock at all
    const baselineSources = makeSources({});
    const baseline = assembleContext(baselineSources);
    const baselineHash = createHash("sha256")
      .update(baseline.stablePrefix, "utf8")
      .digest("hex");

    // v2.6 deploy with EMPTY fs snapshot — should hash IDENTICALLY because
    // empty snapshot ⇒ empty fsBlock ⇒ no triplet markers ⇒ byte-identical
    // stable prefix.
    const emptySnapshot = new Map<string, FsCapabilitySnapshot>();
    const emptyFsBlock = renderFilesystemCapabilityBlock(
      emptySnapshot,
      AGENT_ROOT,
      { now: () => FIXED_NOW },
    );
    const v26Sources = makeSources({
      filesystemCapabilityBlock: emptyFsBlock,
    });
    const v26 = assembleContext(v26Sources);
    const v26Hash = createHash("sha256")
      .update(v26.stablePrefix, "utf8")
      .digest("hex");

    expect(v26Hash).toBe(baselineHash);
  });

  it("CA-FS-5 IMMUTABILITY: assembler does not mutate the snapshot Map across calls (ReadonlyMap contract)", () => {
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
    ]);
    const before = Array.from(snapshot.entries()).map(([k, v]) => [k, { ...v }]);

    const fsBlock1 = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    const sources1 = makeSources({ filesystemCapabilityBlock: fsBlock1 });
    assembleContext(sources1);

    const fsBlock2 = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    const sources2 = makeSources({ filesystemCapabilityBlock: fsBlock2 });
    assembleContext(sources2);

    // Snapshot identity preserved — no entries added/removed/mutated
    const after = Array.from(snapshot.entries()).map(([k, v]) => [k, { ...v }]);
    expect(after).toEqual(before);
    expect(snapshot.size).toBe(1);
    // Renderer is deterministic ⇒ both rendered outputs are byte-identical
    expect(fsBlock1).toBe(fsBlock2);
  });
});
