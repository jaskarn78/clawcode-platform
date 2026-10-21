/**
 * Phase 96 Plan 03 — clawcode_list_files auto-injected directory listing
 * tool (TDD RED for D-07 + D-08).
 *
 * D-07: depth max 3, entries max 500, case-sensitive substring glob,
 *       truncation message at limit. Boundary check goes through 96-01's
 *       checkFsCapability BEFORE any deps.readdir call (D-06 single-source
 *       -of-truth).
 * D-08: out-of-allowlist refusals carry alternatives via
 *       deps.findAlternativeFsAgents — when fin-client can't read
 *       /home/X but admin-clawdy can, the LLM gets that hint structured
 *       into ToolCallError.alternatives.
 *
 * Phase 94 5-value ErrorClass enum NOT extended: 'permission' for boundary
 * refusal, 'unknown' (with rich suggestion) for depth/entries-exceeded /
 * size / missing.
 *
 * Pure-DI module — production wires node:fs/promises at the daemon edge;
 * tests stub deps.checkFsCapability + deps.readdir + deps.stat +
 * deps.findAlternativeFsAgents + deps.getFsCapabilitySnapshot.
 */

import { describe, it, expect, vi } from "vitest";
import {
  clawcodeListFiles,
  CLAWCODE_LIST_FILES_DEF,
  MAX_LIST_FILES_DEPTH,
  MAX_LIST_FILES_ENTRIES,
  LIST_FILES_TRUNCATION_MESSAGE,
  type ListFilesDeps,
  type ListFilesInput,
  type ListFilesOutput,
} from "../tools/clawcode-list-files.js";
import type { FsCapabilitySnapshot } from "../persistent-session-handle.js";
import type { Logger } from "pino";

/** Tiny pino-shaped no-op logger for tests. */
function makeLog(): Logger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => log,
  };
  return log as unknown as Logger;
}

/** Minimal Dirent-shaped object for deps.readdir stubs. */
function makeDirent(name: string, kind: "file" | "dir") {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
  };
}

/** Build a synthetic snapshot Map. */
function makeSnapshot(
  entries: ReadonlyArray<readonly [string, FsCapabilitySnapshot]> = [],
): ReadonlyMap<string, FsCapabilitySnapshot> {
  return new Map(entries);
}

describe("clawcode_list_files — D-07 listing tool + D-08 alternatives", () => {
  it("LF-HAPPY: deps allow path; readdir returns dir+file → output has 2 entries, files have size/mtime, dirs only have name+type", async () => {
    const checkSpy = vi.fn(async () => ({
      allowed: true as const,
      canonicalPath: "/home/clawcode/.clawcode/agents/x/",
      mode: "ro" as const,
    }));
    const readdirSpy = vi.fn(async () => [
      makeDirent("a.pdf", "file"),
      makeDirent("subdir", "dir"),
    ]);
    const statSpy = vi.fn(async () => ({
      size: 1024,
      mtime: new Date("2026-04-25T19:00:00Z"),
    }));
    const deps: ListFilesDeps = {
      checkFsCapability: checkSpy,
      readdir: readdirSpy,
      stat: statSpy,
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };

    const result = (await clawcodeListFiles(
      { path: "/home/clawcode/.clawcode/agents/x/" },
      deps,
    )) as ListFilesOutput;

    expect("kind" in result && result.kind === "ToolCallError").toBe(false);
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(false);

    const fileEntry = result.entries.find((e) => e.name === "a.pdf");
    expect(fileEntry).toBeDefined();
    expect(fileEntry?.type).toBe("file");
    expect(fileEntry?.size).toBe(1024);
    expect(fileEntry?.mtime).toBeDefined();

    const dirEntry = result.entries.find((e) => e.name === "subdir");
    expect(dirEntry).toBeDefined();
    expect(dirEntry?.type).toBe("dir");
    // Dirs do NOT carry size/mtime.
    expect(dirEntry?.size).toBeUndefined();
  });

  it("LF-DEPTH-DEFAULT: input WITHOUT depth → recurse 1 level only (immediate children)", async () => {
    const readdirSpy = vi.fn(async () => [
      makeDirent("only-file.pdf", "file"),
      makeDirent("nested-dir", "dir"),
    ]);
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/home/clawcode/.clawcode/agents/x/",
        mode: "ro" as const,
      })),
      readdir: readdirSpy,
      stat: vi.fn(async () => ({ size: 1, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };

    await clawcodeListFiles(
      { path: "/home/clawcode/.clawcode/agents/x/" },
      deps,
    );

    // depth-default = 1 → readdir called exactly once at the root, NOT
    // recursing into nested-dir.
    expect(readdirSpy).toHaveBeenCalledTimes(1);
  });

  it("LF-DEPTH-EXCEEDED: input.depth = 4 → ToolCallError errorClass='unknown' suggestion mentions 'depth max is 3'", async () => {
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/x/",
        mode: "ro" as const,
      })),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({ size: 0, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = await clawcodeListFiles({ path: "/x/", depth: 4 }, deps);
    expect("kind" in result && result.kind === "ToolCallError").toBe(true);
    if ("kind" in result && result.kind === "ToolCallError") {
      expect(result.errorClass).toBe("unknown");
      expect(result.suggestion ?? "").toMatch(/depth max is 3/);
    }
  });

  it("LF-DEPTH-3: input.depth = 3 → readdir called recursively up to 3 levels", async () => {
    // Mock: every readdir call returns 1 dir + 1 file.
    let calls = 0;
    const readdirSpy = vi.fn(async () => {
      calls++;
      // Return at most a few levels' worth before going empty.
      return [makeDirent(`f${calls}.pdf`, "file"), makeDirent(`d${calls}`, "dir")];
    });
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/x/",
        mode: "ro" as const,
      })),
      readdir: readdirSpy,
      stat: vi.fn(async () => ({ size: 1, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };

    await clawcodeListFiles({ path: "/x/", depth: 3 }, deps);

    // depth=3 means one root call + up to two recursive levels deeper
    // before the recursion guard refuses depth exhaustion. Should be
    // strictly more than the depth-default case (1 call).
    expect(readdirSpy.mock.calls.length).toBeGreaterThan(1);
    // And bounded (depth=3 + branching=1 dir-per-level = at most 3 readdir calls).
    expect(readdirSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("LF-ENTRIES-EXCEEDED: deps.readdir returns 600 dirents → output.entries.length === 500, output.truncated === true", async () => {
    const dirents = Array.from({ length: 600 }, (_, i) =>
      makeDirent(`f${i}.pdf`, "file"),
    );
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/x/",
        mode: "ro" as const,
      })),
      readdir: vi.fn(async () => dirents),
      stat: vi.fn(async () => ({ size: 1, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = (await clawcodeListFiles(
      { path: "/x/", depth: 1 },
      deps,
    )) as ListFilesOutput;
    expect("kind" in result && result.kind === "ToolCallError").toBe(false);
    expect(result.entries.length).toBe(MAX_LIST_FILES_ENTRIES);
    expect(result.entries.length).toBe(500);
    expect(result.truncated).toBe(true);
    // The truncation message is exposed as a module export so the renderer
    // can show it to the LLM consistently.
    expect(LIST_FILES_TRUNCATION_MESSAGE).toBe(
      "[...truncated, use glob filter or specific subpath]",
    );
  });

  it("LF-GLOB-CASE-SENSITIVE: glob='foo' → only 'foo.pdf' matches (Foo.pdf excluded — Linux fs is case-sensitive)", async () => {
    const dirents = [
      makeDirent("Foo.pdf", "file"),
      makeDirent("foo.pdf", "file"),
      makeDirent("README.md", "file"),
    ];
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/x/",
        mode: "ro" as const,
      })),
      readdir: vi.fn(async () => dirents),
      stat: vi.fn(async () => ({ size: 1, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = (await clawcodeListFiles(
      { path: "/x/", glob: "foo" },
      deps,
    )) as ListFilesOutput;
    expect("kind" in result && result.kind === "ToolCallError").toBe(false);
    expect(result.entries.map((e) => e.name)).toEqual(["foo.pdf"]);
  });

  it("LF-GLOB-PDF: glob='.pdf' matches '.pdf' substring; 'foo.PDF' (uppercase) excluded; 'README.md' excluded", async () => {
    const dirents = [
      makeDirent("foo.pdf", "file"),
      makeDirent("foo.PDF", "file"),
      makeDirent("README.md", "file"),
    ];
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/x/",
        mode: "ro" as const,
      })),
      readdir: vi.fn(async () => dirents),
      stat: vi.fn(async () => ({ size: 1, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = (await clawcodeListFiles(
      { path: "/x/", glob: ".pdf" },
      deps,
    )) as ListFilesOutput;
    expect("kind" in result && result.kind === "ToolCallError").toBe(false);
    expect(result.entries.map((e) => e.name)).toEqual(["foo.pdf"]);
  });

  it("LF-BOUNDARY-REFUSED + LF-PERMISSION-ALTERNATIVES: out-of-allowlist path → ToolCallError errorClass='permission' carrying alternatives", async () => {
    const checkSpy = vi.fn(async () => ({
      allowed: false as const,
      reason: "EACCES: permission denied, access '/etc/passwd'",
    }));
    const altSpy = vi.fn(() => ["admin-clawdy", "fin-tax"] as const);
    const readdirSpy = vi.fn(async () => []);
    const deps: ListFilesDeps = {
      checkFsCapability: checkSpy,
      readdir: readdirSpy,
      stat: vi.fn(async () => ({ size: 0, mtime: new Date(0) })),
      findAlternativeFsAgents: altSpy as unknown as ListFilesDeps["findAlternativeFsAgents"],
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = await clawcodeListFiles({ path: "/etc/passwd" }, deps);
    expect("kind" in result && result.kind === "ToolCallError").toBe(true);
    if ("kind" in result && result.kind === "ToolCallError") {
      expect(result.errorClass).toBe("permission");
      expect(result.message).toMatch(/outside|permission|fileAccess/i);
      expect(result.suggestion ?? "").toMatch(/fileAccess/);
      // alternatives populated from deps.findAlternativeFsAgents
      expect(result.alternatives).toEqual(["admin-clawdy", "fin-tax"]);
    }
    // Boundary refused → readdir MUST NOT have been called (D-06 invariant).
    expect(readdirSpy).not.toHaveBeenCalled();
    // findAlternativeFsAgents was called with the input path (not the
    // canonicalized one — deps.checkFsCapability already failed before
    // canonicalization could complete, so the raw input is correct here).
    expect(altSpy).toHaveBeenCalled();
  });

  it("LF-BOUNDARY-NO-ALTERNATIVES: deps.findAlternativeFsAgents returns [] → ToolCallError with empty alternatives, suggestion still mentions fileAccess", async () => {
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: false as const,
        reason: "EACCES",
      })),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({ size: 0, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = await clawcodeListFiles({ path: "/etc/passwd" }, deps);
    expect("kind" in result && result.kind === "ToolCallError").toBe(true);
    if ("kind" in result && result.kind === "ToolCallError") {
      expect(result.errorClass).toBe("permission");
      expect(result.suggestion ?? "").toMatch(/fileAccess/);
      // Empty alternatives → property either omitted OR present-and-empty.
      expect(result.alternatives ?? []).toEqual([]);
    }
  });

  it("LF-ENOENT-WRAP: deps.checkFsCapability allows; deps.readdir rejects with ENOENT → ToolCallError errorClass='unknown' with verbatim ENOENT message", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, scandir '/missing/'"), { code: "ENOENT" });
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/missing/",
        mode: "ro" as const,
      })),
      readdir: vi.fn(async () => {
        throw enoent;
      }),
      stat: vi.fn(async () => ({ size: 0, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = await clawcodeListFiles({ path: "/missing/" }, deps);
    expect("kind" in result && result.kind === "ToolCallError").toBe(true);
    if ("kind" in result && result.kind === "ToolCallError") {
      expect(result.errorClass).toBe("unknown");
      expect(result.message).toContain("ENOENT");
    }
  });

  it("LF-EACCES-AT-READDIR: snapshot says ready; readdir rejects with EACCES (race condition) → ToolCallError errorClass='permission'", async () => {
    const eacces = Object.assign(new Error("EACCES: permission denied, scandir '/blocked/'"), { code: "EACCES" });
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/blocked/",
        mode: "ro" as const,
      })),
      readdir: vi.fn(async () => {
        throw eacces;
      }),
      stat: vi.fn(async () => ({ size: 0, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = await clawcodeListFiles({ path: "/blocked/" }, deps);
    expect("kind" in result && result.kind === "ToolCallError").toBe(true);
    if ("kind" in result && result.kind === "ToolCallError") {
      expect(result.errorClass).toBe("permission");
    }
  });

  it("LF-ORDER-CHECK-BEFORE-READDIR: deps.checkFsCapability called BEFORE deps.readdir (D-06 single-source-of-truth pin)", async () => {
    const checkSpy = vi.fn(async () => ({
      allowed: true as const,
      canonicalPath: "/x/",
      mode: "ro" as const,
    }));
    const readdirSpy = vi.fn(async () => [makeDirent("only.pdf", "file")]);
    const deps: ListFilesDeps = {
      checkFsCapability: checkSpy,
      readdir: readdirSpy,
      stat: vi.fn(async () => ({ size: 1, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    await clawcodeListFiles({ path: "/x/" }, deps);
    // Both must have been called.
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(readdirSpy).toHaveBeenCalledTimes(1);
    // checkFsCapability MUST have been invoked before readdir.
    const checkOrder = checkSpy.mock.invocationCallOrder[0];
    const readdirOrder = readdirSpy.mock.invocationCallOrder[0];
    expect(checkOrder).toBeLessThan(readdirOrder);
  });

  it("LF-DEF: CLAWCODE_LIST_FILES_DEF carries name/description/input_schema with path/depth/glob; description abstract (no hardcoded /home/clawcode/)", () => {
    expect(CLAWCODE_LIST_FILES_DEF.name).toBe("clawcode_list_files");
    expect(typeof CLAWCODE_LIST_FILES_DEF.description).toBe("string");
    // Description is abstract — must NOT hardcode deployment-specific paths.
    expect(CLAWCODE_LIST_FILES_DEF.description).not.toMatch(/\/home\/clawcode/);
    expect(CLAWCODE_LIST_FILES_DEF.input_schema.type).toBe("object");
    const props = CLAWCODE_LIST_FILES_DEF.input_schema.properties as Record<
      string,
      unknown
    >;
    expect(props.path).toBeDefined();
    expect(props.depth).toBeDefined();
    expect(props.glob).toBeDefined();
    expect(CLAWCODE_LIST_FILES_DEF.input_schema.required).toEqual(["path"]);
    // Token-guard constants exposed for both runtime and operator inspection.
    expect(MAX_LIST_FILES_DEPTH).toBe(3);
    expect(MAX_LIST_FILES_ENTRIES).toBe(500);
  });

  it("LF-IMMUTABLE: happy-path output is Object.frozen (CLAUDE.md immutability rule)", async () => {
    const deps: ListFilesDeps = {
      checkFsCapability: vi.fn(async () => ({
        allowed: true as const,
        canonicalPath: "/x/",
        mode: "ro" as const,
      })),
      readdir: vi.fn(async () => [makeDirent("a.pdf", "file")]),
      stat: vi.fn(async () => ({ size: 1, mtime: new Date(0) })),
      findAlternativeFsAgents: vi.fn(() => []),
      getFsCapabilitySnapshot: () => makeSnapshot(),
      log: makeLog(),
    };
    const result = (await clawcodeListFiles(
      { path: "/x/" },
      deps,
    )) as ListFilesOutput;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
  });

  it("LF-SCHEMA-DEPTH-MAX: input_schema declares depth maximum=3 so the SDK rejects depth>3 client-side too", () => {
    const props = CLAWCODE_LIST_FILES_DEF.input_schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.depth.maximum).toBe(MAX_LIST_FILES_DEPTH);
    expect(props.depth.minimum).toBe(0);
  });
});

// Type-level pin — keeps the exported ListFilesInput discoverable for
// downstream consumers AND makes the file fail to compile if
// tools/clawcode-list-files.ts drops the export. (Pure type assertion;
// `declare const` would emit a runtime ReferenceError, so use a typed
// undefined instead.)
type _ListFilesInputPin = ListFilesInput;
const _listFilesInputPin: _ListFilesInputPin | undefined = undefined;
void _listFilesInputPin;
