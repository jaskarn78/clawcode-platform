/**
 * Types for the memory consolidation pipeline.
 * Digest types represent weekly and monthly summaries of session logs.
 * All types are readonly per project immutability convention.
 */

/** The consolidation period granularity. */
export type DigestPeriod = "weekly" | "monthly";

/** A weekly digest summarizing session logs for a single ISO week. */
export type WeeklyDigest = {
  readonly year: number;
  readonly week: number;
  readonly period: "weekly";
  readonly startDate: string; // YYYY-MM-DD
  readonly endDate: string; // YYYY-MM-DD
  readonly sourceFiles: readonly string[];
  readonly content: string; // LLM-generated markdown
  readonly createdAt: string;
};

/** A monthly digest summarizing weekly digests for a single month. */
export type MonthlyDigest = {
  readonly year: number;
  readonly month: number;
  readonly period: "monthly";
  readonly sourceDigests: readonly string[]; // weekly digest file paths
  readonly content: string;
  readonly createdAt: string;
};

/** Result of a consolidation run, tracking what was created and any errors. */
export type ConsolidationResult = {
  readonly weeklyDigestsCreated: number;
  readonly monthlyDigestsCreated: number;
  readonly filesArchived: number;
  readonly errors: readonly string[];
};
