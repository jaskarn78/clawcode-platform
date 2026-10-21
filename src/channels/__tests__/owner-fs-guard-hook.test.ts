/**
 * Owner filesystem guard unit pins (2026-06-27). Defense-in-depth: deny an
 * owned agent's file tools from touching another owner's agent dirs. (Bypassable
 * by relative-traversal/symlink/MCP — see module header; airtight = OS uid.)
 */

import { describe, it, expect } from "vitest";
import {
  decideOwnerFsAccess,
  computeCrossOwnerForbiddenPaths,
} from "../owner-fs-guard-hook.js";

const JAS = "/home/clawcode/.clawcode/agents/personal";
const FORBIDDEN = [JAS, "/home/clawcode/.clawcode/agents/legal-counsel"];

describe("decideOwnerFsAccess", () => {
  it("allows everything when there are no forbidden prefixes", () => {
    expect(decideOwnerFsAccess("Bash", { command: `cat ${JAS}/x` }, []).deny).toBe(
      false,
    );
  });

  it("denies a Bash command that references a forbidden dir", () => {
    const d = decideOwnerFsAccess(
      "Bash",
      { command: `cat ${JAS}/memory/memories.db` },
      FORBIDDEN,
    );
    expect(d.deny).toBe(true);
    expect(d.reason).toMatch(/cross-owner/);
  });

  it("allows a Bash command that stays out of forbidden dirs", () => {
    expect(
      decideOwnerFsAccess("Bash", { command: "ls /tmp && cat ./notes.md" }, FORBIDDEN)
        .deny,
    ).toBe(false);
  });

  it("denies Read/Write/Edit whose path resolves under a forbidden dir", () => {
    for (const tool of ["Read", "Write", "Edit"]) {
      expect(
        decideOwnerFsAccess(tool, { file_path: `${JAS}/MEMORY.md` }, FORBIDDEN).deny,
      ).toBe(true);
    }
  });

  it("allows Read of the agent's own (non-forbidden) path", () => {
    expect(
      decideOwnerFsAccess(
        "Read",
        { file_path: "/home/clawcode/.clawcode/agents/acme/notes.md" },
        FORBIDDEN,
      ).deny,
    ).toBe(false);
  });

  it("denies Grep into a forbidden dir (path arg or pattern)", () => {
    expect(decideOwnerFsAccess("Grep", { path: JAS }, FORBIDDEN).deny).toBe(true);
    expect(
      decideOwnerFsAccess("Grep", { pattern: `${JAS}/x`, path: "/tmp" }, FORBIDDEN)
        .deny,
    ).toBe(true);
  });

  it("allows unknown / non-file tools", () => {
    expect(decideOwnerFsAccess("WebSearch", { query: JAS }, FORBIDDEN).deny).toBe(
      false,
    );
  });
});

describe("computeCrossOwnerForbiddenPaths", () => {
  const FLEET = [
    { name: "personal", owner: "owner_a", workspace: JAS, memoryPath: `${JAS}/memory` },
    {
      name: "legal-counsel",
      owner: "owner_a",
      workspace: "/home/clawcode/.clawcode/agents/legal-counsel",
    },
    {
      name: "fin-client",
      owner: "client_a",
      workspace: "/home/clawcode/.clawcode/agents/acme",
      memoryPath: "/home/clawcode/.clawcode/agents/acme/memory/fin-client",
    },
    {
      name: "fin-research",
      owner: "client_a",
      workspace: "/home/clawcode/.clawcode/agents/acme",
    },
    { name: "Admin Clawdy", owner: "owner_a", admin: true },
    { name: "untagged", workspace: "/x" },
  ];

  it("for a client_a agent: forbids owner_a dirs, NOT same-owner or self", () => {
    const f = computeCrossOwnerForbiddenPaths(
      { name: "fin-client", owner: "client_a" },
      FLEET,
    );
    expect(f).toContain(JAS);
    expect(f).toContain("/home/clawcode/.clawcode/agents/legal-counsel");
    // same-owner shared workspace must NOT be forbidden (fin-* share acme)
    expect(f).not.toContain("/home/clawcode/.clawcode/agents/acme");
    // untagged agents assert no boundary either way
    expect(f).not.toContain("/x");
  });

  it("admin and untenanted agents get no forbidden paths (no hook)", () => {
    expect(
      computeCrossOwnerForbiddenPaths(
        { name: "Admin Clawdy", owner: "owner_a", admin: true },
        FLEET,
      ),
    ).toEqual([]);
    expect(
      computeCrossOwnerForbiddenPaths({ name: "untagged" }, FLEET),
    ).toEqual([]);
  });

  it("for a owner_a agent: forbids client_a dirs (symmetric)", () => {
    const f = computeCrossOwnerForbiddenPaths(
      { name: "personal", owner: "owner_a" },
      FLEET,
    );
    expect(f).toContain("/home/clawcode/.clawcode/agents/acme");
    expect(f).not.toContain(JAS);
  });
});
