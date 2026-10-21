import { describe, it, expect } from "vitest";
import { todoMirrorSchema } from "../schema.js";

/**
 * 999.103 WS-1 — the three-place-knob guard. `todoMirror` must exist in the
 * zod schema, in `ResolvedAgentConfig` (shared/types.ts) and as an explicit
 * spread in loader.ts; missing any one means it parses, validates, and is
 * silently dropped (the probe-throttle lesson, and the 2026-07-14
 * disallowedTools RCA before it).
 */
describe("todoMirrorSchema", () => {
  it("applies defaults from an empty object (disabled, floor 2)", () => {
    expect(todoMirrorSchema.parse({})).toEqual({ enabled: false, minItems: 2 });
  });

  it("keeps explicit values", () => {
    expect(todoMirrorSchema.parse({ enabled: true, minItems: 3 })).toEqual({
      enabled: true,
      minItems: 3,
    });
  });

  it("rejects a zero/negative floor rather than coercing", () => {
    expect(() => todoMirrorSchema.parse({ minItems: 0 })).toThrow();
    expect(() => todoMirrorSchema.parse({ minItems: -1 })).toThrow();
  });
});
