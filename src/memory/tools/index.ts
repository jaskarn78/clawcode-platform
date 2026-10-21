/**
 * Phase 115 Plan 05 sub-scope 7 — lazy-load memory tools barrel export.
 *
 * Re-exports the four tool functions + their input schemas + their result
 * types so consumers (mcp/server.ts tool registrations, daemon.ts IPC
 * handlers) import from one place. Per the project's CLAUDE.md "many
 * small files > few large files" rule, each tool lives in its own module
 * and this index just re-exports.
 */

export {
  clawcodeMemorySearch,
  SEARCH_INPUT_SCHEMA,
  type SearchInput,
  type SearchHit,
  type SearchDeps,
  type SearchResult,
} from "./clawcode-memory-search.js";

export {
  clawcodeMemoryRecall,
  RECALL_INPUT_SCHEMA,
  type RecallInput,
  type RecallDeps,
  type RecallResult,
} from "./clawcode-memory-recall.js";

export {
  clawcodeMemoryEdit,
  EDIT_INPUT_SCHEMA,
  type EditInput,
  type EditDeps,
  type EditResult,
} from "./clawcode-memory-edit.js";

export {
  clawcodeMemoryArchive,
  ARCHIVE_INPUT_SCHEMA,
  type ArchiveInput,
  type ArchiveDeps,
  type ArchiveResult,
} from "./clawcode-memory-archive.js";
