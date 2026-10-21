/**
 * Phase 110 Stage 0b 0B-RT-13 — `list-mcp-tools` IPC method tests.
 *
 * Wave 1 daemon-side prerequisite. Future Go shims (Waves 2-4) call this
 * method at boot to fetch JSON-Schema-converted tool definitions, keeping
 * the canonical Zod schemas single-sourced in TypeScript.
 *
 * Test coverage:
 *   - Tests 1-4 (this plan, Task 1): contract tests against the protocol
 *     registry — request/response Zod schemas + method registration.
 *   - Tests 5-9 (this plan, Task 2): handler behavior — TOOL_DEFINITIONS
 *     conversion fidelity for each shim type + invalid-params error.
 */
import { describe, it, expect } from "vitest";
import { z as zV4 } from "zod/v4";

import {
  IPC_METHODS,
  listMcpToolsRequestSchema,
  listMcpToolsResponseSchema,
  mcpToolSchemaSchema,
} from "../../ipc/protocol.js";
import {
  handleListMcpToolsIpc,
  type ListMcpToolsHandlerToolDef,
} from "../daemon.js";
import { ManagerError } from "../../shared/errors.js";
import { TOOL_DEFINITIONS as SEARCH_TOOL_DEFINITIONS } from "../../search/tools.js";
import { TOOL_DEFINITIONS as IMAGE_TOOL_DEFINITIONS } from "../../image/tools.js";
import { TOOL_DEFINITIONS as BROWSER_TOOL_DEFINITIONS } from "../../browser/tools.js";

/**
 * Build a deps surface that wraps the real frozen TOOL_DEFINITIONS arrays.
 * Tests 5-7 use this; Test 8 just needs any deps to satisfy the type.
 */
function buildRealDeps() {
  return {
    searchTools: SEARCH_TOOL_DEFINITIONS as ReadonlyArray<ListMcpToolsHandlerToolDef>,
    imageTools: IMAGE_TOOL_DEFINITIONS as ReadonlyArray<ListMcpToolsHandlerToolDef>,
    browserTools: BROWSER_TOOL_DEFINITIONS as ReadonlyArray<ListMcpToolsHandlerToolDef>,
  };
}

describe("list-mcp-tools IPC contract (Phase 110 0B-RT-13)", () => {
  describe("request schema", () => {
    it("Test 1 — accepts valid shimType values (search/image/browser)", () => {
      const search = listMcpToolsRequestSchema.safeParse({ shimType: "search" });
      const image = listMcpToolsRequestSchema.safeParse({ shimType: "image" });
      const browser = listMcpToolsRequestSchema.safeParse({
        shimType: "browser",
      });
      expect(search.success).toBe(true);
      expect(image.success).toBe(true);
      expect(browser.success).toBe(true);
      if (search.success) expect(search.data.shimType).toBe("search");
      if (image.success) expect(image.data.shimType).toBe("image");
      if (browser.success) expect(browser.data.shimType).toBe("browser");
    });

    it("Test 2 — rejects unknown / empty shimType values", () => {
      // Operator-side typo ("broker" is a different surface, Phase 108).
      const broker = listMcpToolsRequestSchema.safeParse({
        shimType: "broker",
      });
      expect(broker.success).toBe(false);

      // Empty string also rejected (z.enum is strict).
      const empty = listMcpToolsRequestSchema.safeParse({ shimType: "" });
      expect(empty.success).toBe(false);

      // Missing shimType entirely.
      const missing = listMcpToolsRequestSchema.safeParse({});
      expect(missing.success).toBe(false);

      // Non-string shimType.
      const numeric = listMcpToolsRequestSchema.safeParse({ shimType: 1 });
      expect(numeric.success).toBe(false);
    });
  });

  describe("response schema", () => {
    it("Test 3 — accepts well-formed tools array", () => {
      const wellFormed = listMcpToolsResponseSchema.safeParse({
        tools: [
          {
            name: "x",
            description: "y",
            inputSchema: {},
          },
        ],
      });
      expect(wellFormed.success).toBe(true);

      // Empty tools array is valid (e.g., a future shim type with no tools).
      const empty = listMcpToolsResponseSchema.safeParse({ tools: [] });
      expect(empty.success).toBe(true);

      // Multiple tools with realistic JSON-Schema-shaped inputSchema.
      const multi = listMcpToolsResponseSchema.safeParse({
        tools: [
          {
            name: "web_search",
            description: "Search the live web.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
          {
            name: "web_fetch_url",
            description: "Fetch a URL.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      expect(multi.success).toBe(true);

      // mcpToolSchemaSchema rejects empty name (per CLAUDE.md input validation).
      const emptyName = mcpToolSchemaSchema.safeParse({
        name: "",
        description: "y",
        inputSchema: {},
      });
      expect(emptyName.success).toBe(false);

      // mcpToolSchemaSchema rejects missing inputSchema.
      const missingSchema = mcpToolSchemaSchema.safeParse({
        name: "x",
        description: "y",
      });
      expect(missingSchema.success).toBe(false);
    });
  });

  describe("method registration", () => {
    it("Test 4 — `list-mcp-tools` is registered in IPC_METHODS", () => {
      expect(IPC_METHODS).toContain("list-mcp-tools");
    });
  });
});

describe("handleListMcpToolsIpc handler (Task 2 — Phase 110 0B-RT-13)", () => {
  it("Test 5 — search shimType returns every TOOL_DEFINITIONS entry with matching name + description + non-empty inputSchema", () => {
    const deps = buildRealDeps();
    const result = handleListMcpToolsIpc(deps, { shimType: "search" });

    // Response shape passes the Zod response schema (acceptance:
    // every tool has name, description, inputSchema fields).
    const parsed = listMcpToolsResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);

    // Every name from source TOOL_DEFINITIONS appears in the response.
    expect(result.tools.length).toBe(SEARCH_TOOL_DEFINITIONS.length);
    for (const def of SEARCH_TOOL_DEFINITIONS) {
      const match = result.tools.find((t) => t.name === def.name);
      expect(match).toBeDefined();
      expect(match!.description).toBe(def.description);
      // inputSchema is a non-empty object (JSON Schema with at least
      // type/properties/required keys for the wrapped object schema).
      expect(typeof match!.inputSchema).toBe("object");
      expect(Object.keys(match!.inputSchema).length).toBeGreaterThan(0);
    }
  });

  it("Test 6 — image shimType returns every TOOL_DEFINITIONS entry with matching name + description + non-empty inputSchema", () => {
    const deps = buildRealDeps();
    const result = handleListMcpToolsIpc(deps, { shimType: "image" });

    const parsed = listMcpToolsResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);

    expect(result.tools.length).toBe(IMAGE_TOOL_DEFINITIONS.length);
    for (const def of IMAGE_TOOL_DEFINITIONS) {
      const match = result.tools.find((t) => t.name === def.name);
      expect(match).toBeDefined();
      expect(match!.description).toBe(def.description);
      expect(typeof match!.inputSchema).toBe("object");
      expect(Object.keys(match!.inputSchema).length).toBeGreaterThan(0);
    }
  });

  it("Test 7 — browser shimType returns every TOOL_DEFINITIONS entry with matching name + description + non-empty inputSchema", () => {
    const deps = buildRealDeps();
    const result = handleListMcpToolsIpc(deps, { shimType: "browser" });

    const parsed = listMcpToolsResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);

    expect(result.tools.length).toBe(BROWSER_TOOL_DEFINITIONS.length);
    for (const def of BROWSER_TOOL_DEFINITIONS) {
      const match = result.tools.find((t) => t.name === def.name);
      expect(match).toBeDefined();
      expect(match!.description).toBe(def.description);
      expect(typeof match!.inputSchema).toBe("object");
      expect(Object.keys(match!.inputSchema).length).toBeGreaterThan(0);
    }
  });

  it("Test 8 — unknown shimType throws ManagerError with code -32602 (invalid params)", () => {
    const deps = buildRealDeps();

    // "broker" is a valid concept (Phase 108 broker shim) but NOT one of
    // the three translator shim types — operator-side typo case.
    expect(() => handleListMcpToolsIpc(deps, { shimType: "broker" })).toThrow(
      ManagerError,
    );

    try {
      handleListMcpToolsIpc(deps, { shimType: "broker" });
    } catch (err) {
      expect(err).toBeInstanceOf(ManagerError);
      const me = err as ManagerError;
      expect(me.code).toBe(-32602);
    }

    // Empty object also rejects with -32602 (missing required field).
    try {
      handleListMcpToolsIpc(deps, {});
    } catch (err) {
      expect(err).toBeInstanceOf(ManagerError);
      expect((err as ManagerError).code).toBe(-32602);
    }

    // Null params rejects too.
    try {
      handleListMcpToolsIpc(deps, null);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagerError);
      expect((err as ManagerError).code).toBe(-32602);
    }
  });

  it("Test 9 — JSON Schema fidelity: web_search inputSchema has required:['query']", () => {
    const deps = buildRealDeps();
    const result = handleListMcpToolsIpc(deps, { shimType: "search" });

    const webSearch = result.tools.find((t) => t.name === "web_search");
    expect(webSearch).toBeDefined();

    const schema = webSearch!.inputSchema as Record<string, unknown>;
    expect(schema["type"]).toBe("object");

    // The Zod schema marks `query` required (z.string().min(1)) and
    // `numResults` optional (.optional()). zod/v4's native toJSONSchema
    // serializes required fields into a top-level `required` array.
    const required = schema["required"];
    expect(Array.isArray(required)).toBe(true);
    expect(required as string[]).toContain("query");
    // numResults is optional so it MUST NOT appear in required.
    expect(required as string[]).not.toContain("numResults");

    // The properties block should include both fields (one required,
    // one optional — both are advertised, optionality is in `required`).
    const properties = schema["properties"] as Record<string, unknown>;
    expect(properties).toHaveProperty("query");
    expect(properties).toHaveProperty("numResults");
  });

  it("immutability — handler does not mutate the input TOOL_DEFINITIONS arrays", () => {
    const deps = buildRealDeps();
    const beforeLen = SEARCH_TOOL_DEFINITIONS.length;
    const beforeNames = SEARCH_TOOL_DEFINITIONS.map((d) => d.name);
    handleListMcpToolsIpc(deps, { shimType: "search" });
    expect(SEARCH_TOOL_DEFINITIONS.length).toBe(beforeLen);
    expect(SEARCH_TOOL_DEFINITIONS.map((d) => d.name)).toEqual(beforeNames);
    // TOOL_DEFINITIONS is Object.freeze'd — verify the assertion stays
    // truthful even after the handler runs.
    expect(Object.isFrozen(SEARCH_TOOL_DEFINITIONS)).toBe(true);
  });

  it("custom toJsonSchema override — DI seam works (synthetic deps)", () => {
    // Sanity check: pass a synthetic fixture with deterministic converter
    // so the suite is robust against zod minor-version drift in the
    // native converter.
    const synthetic: ListMcpToolsHandlerToolDef[] = [
      {
        name: "fake_tool",
        description: "fake",
        schemaBuilder: (z_: typeof zV4) => ({ x: z_.string() }),
      },
    ];
    const result = handleListMcpToolsIpc(
      {
        searchTools: synthetic,
        imageTools: [],
        browserTools: [],
        toJsonSchema: () => ({ stub: "stub-schema" }),
      },
      { shimType: "search" },
    );
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("fake_tool");
    expect(result.tools[0]!.inputSchema).toEqual({ stub: "stub-schema" });
  });
});
