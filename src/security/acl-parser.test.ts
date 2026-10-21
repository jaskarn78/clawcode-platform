import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSecurityMd,
  checkChannelAccess,
  resolveCommandAcl,
  resolveDeniedCommands,
} from "./acl-parser.js";
import type { ChannelAcl } from "./types.js";

describe("parseSecurityMd", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `acl-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("parses channel with users", async () => {
    const content = `## Channel ACLs
- channel: 123
  users: [alice, bob]`;
    const filePath = join(tmpDir, "SECURITY.md");
    await writeFile(filePath, content, "utf-8");

    const result = await parseSecurityMd(filePath);
    expect(result).toEqual([
      { channelId: "123", allowedUserIds: ["alice", "bob"], allowedRoles: [] },
    ]);
  });

  it("parses channel with roles", async () => {
    const content = `## Channel ACLs
- channel: 456
  roles: [admin, mod]`;
    const filePath = join(tmpDir, "SECURITY.md");
    await writeFile(filePath, content, "utf-8");

    const result = await parseSecurityMd(filePath);
    expect(result).toEqual([
      { channelId: "456", allowedUserIds: [], allowedRoles: ["admin", "mod"] },
    ]);
  });

  it("parses channel with both users and roles", async () => {
    const content = `## Channel ACLs
- channel: 789
  users: [alice]
  roles: [admin]`;
    const filePath = join(tmpDir, "SECURITY.md");
    await writeFile(filePath, content, "utf-8");

    const result = await parseSecurityMd(filePath);
    expect(result).toEqual([
      { channelId: "789", allowedUserIds: ["alice"], allowedRoles: ["admin"] },
    ]);
  });

  it("returns empty array for missing file", async () => {
    const result = await parseSecurityMd(join(tmpDir, "nonexistent.md"));
    expect(result).toEqual([]);
  });

  it("returns empty array when no ACL section exists", async () => {
    const content = `# Security Policy\n\nSome other content.`;
    const filePath = join(tmpDir, "SECURITY.md");
    await writeFile(filePath, content, "utf-8");

    const result = await parseSecurityMd(filePath);
    expect(result).toEqual([]);
  });

  it("parses multiple channel entries", async () => {
    const content = `## Channel ACLs
- channel: 100
  users: [alice]
- channel: 200
  roles: [mod]`;
    const filePath = join(tmpDir, "SECURITY.md");
    await writeFile(filePath, content, "utf-8");

    const result = await parseSecurityMd(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].channelId).toBe("100");
    expect(result[1].channelId).toBe("200");
  });
});

describe("checkChannelAccess", () => {
  const acls: readonly ChannelAcl[] = [
    { channelId: "123", allowedUserIds: ["alice", "bob"], allowedRoles: ["admin"] },
    { channelId: "456", allowedUserIds: [], allowedRoles: ["mod"] },
  ];

  it("allows user in allowedUserIds", () => {
    expect(checkChannelAccess("123", "alice", [], acls)).toBe(true);
  });

  it("denies user not in allowedUserIds or roles", () => {
    expect(checkChannelAccess("123", "eve", [], acls)).toBe(false);
  });

  it("allows user with matching role", () => {
    expect(checkChannelAccess("123", "eve", ["admin"], acls)).toBe(true);
  });

  it("returns true for channel not in ACLs (open by default)", () => {
    expect(checkChannelAccess("999", "anyone", [], acls)).toBe(true);
  });

  it("denies user with non-matching role", () => {
    expect(checkChannelAccess("456", "eve", ["viewer"], acls)).toBe(false);
  });

  it("allows user with one of multiple matching roles", () => {
    expect(checkChannelAccess("456", "eve", ["viewer", "mod"], acls)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 87 CMD-05 — resolveCommandAcl + resolveDeniedCommands tests.
//
// SECURITY.md `## Command ACLs` section gates native-CC Discord registration
// per-agent. Missing file / missing section = permissive default. Matching
// deny-list entry = refuse.
// ---------------------------------------------------------------------------

describe("resolveCommandAcl (Phase 87 CMD-05)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `cmd-acl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 'allow' when the SECURITY.md file is missing", async () => {
    const result = await resolveCommandAcl(
      join(tmpDir, "nonexistent.md"),
      "init",
    );
    expect(result).toBe("allow");
  });

  it("returns 'allow' when SECURITY.md exists but has no Command ACLs section", async () => {
    const filePath = join(tmpDir, "SECURITY.md");
    await writeFile(filePath, "# Security\n\nNothing here.", "utf-8");
    expect(await resolveCommandAcl(filePath, "init")).toBe("allow");
  });

  it("returns 'deny' for a command listed in the deny list", async () => {
    const filePath = join(tmpDir, "SECURITY.md");
    const content = `## Command ACLs
- deny: [init, security-review]
`;
    await writeFile(filePath, content, "utf-8");
    expect(await resolveCommandAcl(filePath, "init")).toBe("deny");
    expect(await resolveCommandAcl(filePath, "security-review")).toBe("deny");
  });

  it("returns 'allow' for a command NOT in the deny list", async () => {
    const filePath = join(tmpDir, "SECURITY.md");
    const content = `## Command ACLs
- deny: [init, security-review]
`;
    await writeFile(filePath, content, "utf-8");
    expect(await resolveCommandAcl(filePath, "compact")).toBe("allow");
  });

  it("returns 'allow' when the Command ACLs section is empty (permissive default)", async () => {
    const filePath = join(tmpDir, "SECURITY.md");
    const content = `## Command ACLs

## Channel ACLs
- channel: 123
  users: [alice]
`;
    await writeFile(filePath, content, "utf-8");
    expect(await resolveCommandAcl(filePath, "init")).toBe("allow");
  });

  it("strips a leading slash from the deny list entry (both /init and init match)", async () => {
    const filePath = join(tmpDir, "SECURITY.md");
    const content = `## Command ACLs
- deny: [/init, /batch]
`;
    await writeFile(filePath, content, "utf-8");
    expect(await resolveCommandAcl(filePath, "init")).toBe("deny");
    expect(await resolveCommandAcl(filePath, "batch")).toBe("deny");
  });

  it("coexists with the Channel ACLs section without cross-contamination", async () => {
    const filePath = join(tmpDir, "SECURITY.md");
    const content = `## Channel ACLs
- channel: 123
  users: [alice]

## Command ACLs
- deny: [init]
`;
    await writeFile(filePath, content, "utf-8");
    expect(await resolveCommandAcl(filePath, "init")).toBe("deny");
    expect(await resolveCommandAcl(filePath, "compact")).toBe("allow");
    // parseSecurityMd still works on the same file.
    const channelAcls = await parseSecurityMd(filePath);
    expect(channelAcls).toHaveLength(1);
    expect(channelAcls[0].channelId).toBe("123");
  });
});

describe("resolveDeniedCommands (Phase 87 CMD-05 — batch helper)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `denied-cmds-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty Set when SECURITY.md is missing", async () => {
    const result = await resolveDeniedCommands(join(tmpDir, "nope.md"));
    expect(result.size).toBe(0);
  });

  it("returns an empty Set when no Command ACLs section exists", async () => {
    const filePath = join(tmpDir, "SECURITY.md");
    await writeFile(filePath, "# nothing\n", "utf-8");
    const result = await resolveDeniedCommands(filePath);
    expect(result.size).toBe(0);
  });

  it("returns a Set of denied command names (no leading slash)", async () => {
    const filePath = join(tmpDir, "SECURITY.md");
    const content = `## Command ACLs
- deny: [init, /security-review, batch]
`;
    await writeFile(filePath, content, "utf-8");
    const result = await resolveDeniedCommands(filePath);
    expect(result.has("init")).toBe(true);
    expect(result.has("security-review")).toBe(true);
    expect(result.has("batch")).toBe(true);
    expect(result.has("compact")).toBe(false);
    expect(result.size).toBe(3);
  });
});
