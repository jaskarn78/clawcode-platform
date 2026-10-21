/**
 * SECURITY.md parser for channel ACLs.
 *
 * Extracts channel access control lists from a simple YAML-in-markdown
 * format found in agent workspace SECURITY.md files.
 */

import { readFile } from "node:fs/promises";
import type { ChannelAcl } from "./types.js";

/**
 * Parse a SECURITY.md file to extract channel ACL entries.
 *
 * Expected format:
 * ```
 * ## Channel ACLs
 * - channel: <channelId>
 *   users: [userId1, userId2]
 *   roles: [roleName1]
 * ```
 *
 * Returns empty array if file is missing or has no ACL section.
 */
export async function parseSecurityMd(
  filePath: string,
): Promise<readonly ChannelAcl[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const aclSectionMatch = content.match(
    /##\s*Channel\s+ACLs\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/,
  );
  if (!aclSectionMatch) {
    return [];
  }

  const section = aclSectionMatch[1];
  const acls: ChannelAcl[] = [];
  const lines = section.split("\n");

  let currentChannelId: string | null = null;
  let currentUsers: string[] = [];
  let currentRoles: string[] = [];

  const flushCurrent = () => {
    if (currentChannelId !== null) {
      acls.push({
        channelId: currentChannelId,
        allowedUserIds: currentUsers,
        allowedRoles: currentRoles,
      });
    }
  };

  for (const line of lines) {
    const channelMatch = line.match(/^-\s*channel:\s*(\S+)/);
    if (channelMatch) {
      flushCurrent();
      currentChannelId = channelMatch[1];
      currentUsers = [];
      currentRoles = [];
      continue;
    }

    if (currentChannelId !== null) {
      const usersMatch = line.match(/^\s+users:\s*\[([^\]]*)\]/);
      if (usersMatch) {
        currentUsers = usersMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        continue;
      }

      const rolesMatch = line.match(/^\s+roles:\s*\[([^\]]*)\]/);
      if (rolesMatch) {
        currentRoles = rolesMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        continue;
      }
    }
  }

  flushCurrent();

  return acls;
}

/**
 * Phase 87 CMD-05 — parse the optional `## Command ACLs` section of
 * SECURITY.md to decide whether a native Claude Code command should be
 * registered as a Discord slash command for this agent.
 *
 * Expected format (admin-command deny list):
 *
 *   ## Command ACLs
 *   - deny: [init, security-review, batch]
 *
 * Precedence:
 *   - Missing file → "allow" (permissive default)
 *   - Missing `## Command ACLs` section → "allow"
 *   - Empty section → "allow"
 *   - Command name present in the deny list → "deny"
 *   - Otherwise → "allow"
 *
 * `commandName` is the bare SDK name (no leading slash, no `clawcode-`
 * prefix). A leading slash in the deny list is stripped so both `/init`
 * and `init` spellings match.
 */
export async function resolveCommandAcl(
  securityMdPath: string,
  commandName: string,
): Promise<"allow" | "deny"> {
  const denied = await resolveDeniedCommands(securityMdPath);
  return denied.has(commandName) ? "deny" : "allow";
}

/**
 * Phase 87 CMD-05 — batch helper used by SlashCommandHandler.register().
 *
 * Reads SECURITY.md once and returns a Set of every denied command name
 * in the `## Command ACLs` section. Register iterates per-command and
 * passes this Set into native-cc-commands.buildNativeCommandDefs as the
 * `acl.denied` field — one file read per agent per registration pass,
 * not per command.
 *
 * Missing file / missing section / empty section → empty Set.
 */
export async function resolveDeniedCommands(
  securityMdPath: string,
): Promise<ReadonlySet<string>> {
  let content: string;
  try {
    content = await readFile(securityMdPath, "utf-8");
  } catch {
    return new Set<string>();
  }
  const sectionMatch = content.match(
    /##\s*Command\s+ACLs\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/,
  );
  if (!sectionMatch) return new Set<string>();

  const denyMatch = sectionMatch[1].match(/^\s*-\s*deny:\s*\[([^\]]*)\]/m);
  if (!denyMatch) return new Set<string>();

  const denied = denyMatch[1]
    .split(",")
    .map((s) => s.trim().replace(/^\/+/, ""))
    .filter((s) => s.length > 0);
  return new Set(denied);
}

/**
 * Check if a user has access to a channel based on ACLs.
 *
 * Returns true if:
 * - The channel has no ACL entry (open by default)
 * - The userId is in the channel's allowedUserIds
 * - Any of the user's roles is in the channel's allowedRoles
 */
export function checkChannelAccess(
  channelId: string,
  userId: string,
  userRoles: readonly string[],
  acls: readonly ChannelAcl[],
): boolean {
  const acl = acls.find((a) => a.channelId === channelId);

  // No ACL entry = open by default
  if (!acl) {
    return true;
  }

  // Check userId
  if (acl.allowedUserIds.includes(userId)) {
    return true;
  }

  // Check roles
  for (const role of userRoles) {
    if (acl.allowedRoles.includes(role)) {
      return true;
    }
  }

  return false;
}
