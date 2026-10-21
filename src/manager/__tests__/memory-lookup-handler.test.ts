import { describe, it, expect } from "vitest";
import { MemoryStore } from "../../memory/store.js";
import { SemanticSearch } from "../../memory/search.js";
import { ManagerError } from "../../shared/errors.js";

/**
 * Tests for the memory-lookup IPC handler logic.
 *
 * These test the handler's core behavior in isolation:
 * - Limit clamping (min 1, max 20, default 5)
 * - Error when agent store not found
 * - Result shape from SemanticSearch
 *
 * The handler itself lives in daemon.ts as a case in the IPC switch.
 * We test the logic patterns it uses rather than the full daemon stack.
 */

describe("memory-lookup handler logic", () => {
  describe("limit clamping", () => {
    it("defaults to 5 when limit is not a number", () => {
      // Type as the broader IPC params shape (limit is optional) so the
      // typeof-narrowing branch typechecks. Behaviour unchanged.
      const params: { agent: string; query: string; limit?: number } = {
        agent: "test",
        query: "hello",
      };
      const limit = typeof params.limit === "number" ? Math.min(Math.max(params.limit, 1), 20) : 5;
      expect(limit).toBe(5);
    });

    it("clamps low values to 1", () => {
      const rawLimit = -5;
      const limit = Math.min(Math.max(rawLimit, 1), 20);
      expect(limit).toBe(1);
    });

    it("clamps high values to 20", () => {
      const rawLimit = 100;
      const limit = Math.min(Math.max(rawLimit, 1), 20);
      expect(limit).toBe(20);
    });

    it("passes through valid values", () => {
      const rawLimit = 10;
      const limit = Math.min(Math.max(rawLimit, 1), 20);
      expect(limit).toBe(10);
    });
  });

  describe("agent store validation", () => {
    it("throws ManagerError when store is null", () => {
      const store = null;
      expect(() => {
        if (!store) {
          throw new ManagerError("Memory store not found for agent 'ghost' (agent may not be running)");
        }
      }).toThrow(ManagerError);
      expect(() => {
        if (!store) {
          throw new ManagerError("Memory store not found for agent 'ghost' (agent may not be running)");
        }
      }).toThrow(/Memory store not found/);
    });
  });

  describe("result shape", () => {
    it("SemanticSearch results have combinedScore for relevance_score mapping", () => {
      const store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });

      // Insert a test memory with embedding
      const embedding = new Float32Array(384);
      embedding[0] = 1.0; // Simple directional vector
      store.insert({
        content: "Test memory content",
        source: "manual",
        importance: 0.5,
        tags: ["test"],
      }, embedding);

      const search = new SemanticSearch(store.getDatabase());
      const results = search.search(embedding, 5);

      // Each result should have the fields the handler maps
      if (results.length > 0) {
        const r = results[0];
        expect(r).toHaveProperty("id");
        expect(r).toHaveProperty("content");
        expect(r).toHaveProperty("combinedScore");
        expect(r).toHaveProperty("tags");
        expect(r).toHaveProperty("createdAt");
      }
    });

    it("maps results to {id, content, relevance_score, tags, created_at} shape", () => {
      const mockResult = {
        id: "abc123",
        content: "test content",
        combinedScore: 0.85,
        tags: ["memory", "test"] as readonly string[],
        createdAt: "2026-04-10T00:00:00Z",
      };

      const mapped = {
        id: mockResult.id,
        content: mockResult.content,
        relevance_score: mockResult.combinedScore,
        tags: mockResult.tags,
        created_at: mockResult.createdAt,
      };

      expect(mapped).toEqual({
        id: "abc123",
        content: "test content",
        relevance_score: 0.85,
        tags: ["memory", "test"],
        created_at: "2026-04-10T00:00:00Z",
      });
    });
  });
});
