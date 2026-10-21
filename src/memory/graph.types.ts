/**
 * Types for the memory knowledge graph.
 * Graph edges represent directed wikilinks between memory entries.
 */
import type { MemoryEntry } from "./types.js";

/** A directed edge between two memory entries. */
export type MemoryLink = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly linkText: string;
  readonly createdAt: string;
};

/** A backlink result: a memory that links TO a given target. */
export type BacklinkResult = {
  readonly memory: MemoryEntry;
  readonly linkText: string;
};

/** A forward link result: a memory that a given source links TO. */
export type ForwardLinkResult = {
  readonly memory: MemoryEntry;
  readonly linkText: string;
};
