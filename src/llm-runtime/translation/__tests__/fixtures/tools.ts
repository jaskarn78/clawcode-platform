/**
 * Phase 137 Plan 02 T-03 — round-trip parity test fixtures.
 *
 * Five representative Anthropic block-typed tool definitions, each
 * paired with a realistic `AnthropicToolUseBlock` sample and a
 * realistic `AnthropicToolResultBlock` sample. The round-trip
 * parity test (`round-trip-parity.test.ts`) iterates these and
 * asserts loss-less translation through the OpenAI shape and
 * back — SC3 acceptance.
 *
 * Provenance:
 *   - Real clawcode tools (`SendUserFile`) are not used as the
 *     fixture source because `SendUserFile` is a single
 *     fingerprint-bridging tool with very specific shape (see
 *     `src/bridge/native-tool-definitions.ts`). Its `oneOf`-free
 *     schema doesn't exercise the JSON Schema edge cases T-03
 *     requires (oneOf, anyOf, nested objects).
 *   - The 5 fixtures below are HAND-AUTHORED to model real-world
 *     code-tooling shapes (read_file, bash, grep, write_file, plus
 *     an `additionalProperties: false` strict shape). Names + arg
 *     conventions mirror what a Codex-CLI–wired agent would
 *     advertise. Rationale documented in 137-02-SUMMARY.md.
 *   - Fixture (c) exercises `oneOf` in `input_schema.properties`.
 *   - Fixture (d) exercises nested-object schema with optional
 *     properties (`options: { encoding?, mode? }`).
 *   - Fixture (e) exercises `required: [...]` + `additionalProperties:
 *     false` strict mode.
 */

import type {
  AnthropicToolBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "../../types.js";

/** A single fixture entry — tool def + sample call + sample result. */
export interface ToolFixture {
  readonly label: string;
  readonly tool: AnthropicToolBlock;
  readonly toolUse: AnthropicToolUseBlock;
  readonly toolResult: AnthropicToolResultBlock;
}

// -------------------------------------------------------------
// (a) Simple required-string-arg tool — read_file
// -------------------------------------------------------------
const READ_FILE: ToolFixture = {
  label: "read_file (simple required string arg)",
  tool: {
    name: "read_file",
    description: "Read a file from disk and return its contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path." },
      },
      required: ["path"],
    },
  },
  toolUse: {
    type: "tool_use",
    id: "tu_read_file_001",
    name: "read_file",
    input: { path: "/tmp/example.txt" },
  },
  toolResult: {
    type: "tool_result",
    tool_use_id: "tu_read_file_001",
    content: "Hello, world!",
  },
};

// -------------------------------------------------------------
// (b) Multi-arg tool with optional fields — bash
// -------------------------------------------------------------
const BASH: ToolFixture = {
  label: "bash (multi-arg with optional timeout)",
  tool: {
    name: "bash",
    description: "Execute a shell command and capture stdout/stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "Timeout in seconds." },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
  },
  toolUse: {
    type: "tool_use",
    id: "tu_bash_002",
    name: "bash",
    input: { command: "ls -la", timeout: 30 },
  },
  toolResult: {
    type: "tool_result",
    tool_use_id: "tu_bash_002",
    content: "total 0\ndrwxr-xr-x  2 user user  40 May 19 20:00 .",
  },
};

// -------------------------------------------------------------
// (c) Tool with oneOf in the schema — grep
// -------------------------------------------------------------
const GREP: ToolFixture = {
  label: "grep (oneOf pattern — string OR structured)",
  tool: {
    name: "grep",
    description: "Search files for a pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                regex: { type: "string" },
                flags: { type: "string" },
              },
              required: ["regex"],
            },
          ],
        },
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["pattern", "path"],
    },
  },
  toolUse: {
    type: "tool_use",
    id: "tu_grep_003",
    name: "grep",
    input: {
      pattern: { regex: "TODO", flags: "im" },
      path: "/src",
      recursive: true,
    },
  },
  toolResult: {
    type: "tool_result",
    tool_use_id: "tu_grep_003",
    content: "src/main.ts:42: // TODO: implement\nsrc/util.ts:7: // todo later",
  },
};

// -------------------------------------------------------------
// (d) Tool with nested object schema — write_file
// -------------------------------------------------------------
const WRITE_FILE: ToolFixture = {
  label: "write_file (nested options object)",
  tool: {
    name: "write_file",
    description: "Write content to a file with optional encoding/mode.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        options: {
          type: "object",
          properties: {
            encoding: { type: "string", enum: ["utf-8", "ascii", "base64"] },
            mode: { type: "integer" },
          },
        },
      },
      required: ["path", "content"],
    },
  },
  toolUse: {
    type: "tool_use",
    id: "tu_write_file_004",
    name: "write_file",
    input: {
      path: "/tmp/out.txt",
      content: "hello",
      options: { encoding: "utf-8", mode: 420 },
    },
  },
  toolResult: {
    type: "tool_result",
    tool_use_id: "tu_write_file_004",
    content: "wrote 5 bytes",
  },
};

// -------------------------------------------------------------
// (e) Tool with required[] + additionalProperties: false — strict_send
// -------------------------------------------------------------
const STRICT_SEND: ToolFixture = {
  label: "strict_send (required[] + additionalProperties: false)",
  tool: {
    name: "strict_send",
    description: "Send a payload with no extra fields allowed (strict mode).",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        recipient: { type: "string" },
        body: { type: "string" },
        priority: { type: "string", enum: ["normal", "high"] },
      },
      required: ["recipient", "body", "priority"],
    },
    cache_control: { type: "ephemeral" },
  },
  toolUse: {
    type: "tool_use",
    id: "tu_strict_send_005",
    name: "strict_send",
    input: {
      recipient: "ops@clawcode.local",
      body: "all systems nominal",
      priority: "normal",
    },
  },
  toolResult: {
    type: "tool_result",
    tool_use_id: "tu_strict_send_005",
    content: "delivered",
  },
};

/** Ordered fixture array. The round-trip test iterates this. */
export const TOOL_FIXTURES: ReadonlyArray<ToolFixture> = [
  READ_FILE,
  BASH,
  GREP,
  WRITE_FILE,
  STRICT_SEND,
];
