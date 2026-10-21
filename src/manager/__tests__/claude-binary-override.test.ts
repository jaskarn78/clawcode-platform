import { describe, it, expect } from "vitest";
import { readClaudeBinaryOverride } from "../../shared/claude-binary.js";

/**
 * `CLAWCODE_CLAUDE_BIN` — since 999.169 an explicit OVERRIDE of the fleet binary
 * (which is otherwise the Agent SDK's own bundled, version-matched binary). It is
 * the rollback path, so a blank value must be a clean no-op.
 *
 * History: the original pin wiring was silently dropped in the 2026-06-01 v3
 * union merge with its test deleted alongside it. Keep this compile-time guard:
 * deleting the reader breaks this import.
 */
describe("readClaudeBinaryOverride", () => {
  it("returns undefined when unset (→ the SDK-bundled fleet binary)", () => {
    expect(readClaudeBinaryOverride({})).toBeUndefined();
  });

  it("returns undefined when blank/whitespace-only (clean no-op / rollback)", () => {
    expect(readClaudeBinaryOverride({ CLAWCODE_CLAUDE_BIN: "   " })).toBeUndefined();
  });

  it("returns the trimmed executable path when set", () => {
    expect(readClaudeBinaryOverride({ CLAWCODE_CLAUDE_BIN: "  /opt/clawcode/claude-pin/claude  " })).toBe(
      "/opt/clawcode/claude-pin/claude",
    );
  });
});
