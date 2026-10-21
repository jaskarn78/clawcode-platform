/**
 * Thrown when a memory store operation fails.
 * Includes the database path for debugging context.
 */
export class MemoryError extends Error {
  readonly dbPath: string;

  constructor(message: string, dbPath: string) {
    super(`Memory error (${dbPath}): ${message}`);
    this.name = "MemoryError";
    this.dbPath = dbPath;
  }
}

/**
 * Thrown when an embedding operation fails.
 * Includes context about which step failed.
 */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(`Embedding error: ${message}`);
    this.name = "EmbeddingError";
  }
}
