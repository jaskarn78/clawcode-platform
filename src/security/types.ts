/**
 * Security type definitions for the execution approval system.
 *
 * Defines allowlist entries, approval decisions, audit entries,
 * channel ACLs, and the overall security policy shape.
 */

/**
 * A glob pattern for command matching in allowlists.
 */
export type AllowlistEntry = {
  readonly pattern: string;
};

/**
 * Possible outcomes of an approval decision.
 */
export type ApprovalDecision = "approved" | "denied" | "allow-always";

/**
 * A single entry in the approval audit log (JSONL).
 */
export type ApprovalAuditEntry = {
  readonly timestamp: string;
  readonly agentName: string;
  readonly command: string;
  readonly decision: ApprovalDecision;
  readonly approvedBy: string;
};

/**
 * Channel-level access control list parsed from SECURITY.md.
 */
export type ChannelAcl = {
  readonly channelId: string;
  readonly allowedUserIds: readonly string[];
  readonly allowedRoles: readonly string[];
};

/**
 * Combined security policy for an agent.
 */
export type SecurityPolicy = {
  readonly allowlist: readonly AllowlistEntry[];
  readonly channelAcls: readonly ChannelAcl[];
};

/**
 * Result of checking a command against an allowlist.
 */
export type CommandCheckResult = {
  readonly allowed: boolean;
  readonly matchedPattern?: string;
};
