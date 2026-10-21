import { describe, it, expect } from "vitest";

import { decideBashAllowlist } from "../clawcode-bash-allowlist-hook.js";

const allow = (patterns: string[]) => JSON.stringify(patterns);

describe("decideBashAllowlist (Phase 141 WS-2 Option B)", () => {
  it("allows a Bash command matching an allowlist glob", () => {
    expect(
      decideBashAllowlist("Bash", "git status -s", allow(["git status *"])),
    ).toEqual({ deny: false });
  });

  it("denies a Bash command not on the allowlist (deny-by-default)", () => {
    const d = decideBashAllowlist("Bash", "rm -rf /", allow(["git status *"]));
    expect(d.deny).toBe(true);
    expect(d.reason).toMatch(/security\.allowlist/);
  });

  it("uses v2 matchCommand semantics — `*` matches any sequence", () => {
    expect(decideBashAllowlist("Bash", "npm run build", allow(["npm *"]))).toEqual({
      deny: false,
    });
    expect(decideBashAllowlist("Bash", "npmx", allow(["npm *"])).deny).toBe(true);
  });

  it("NEVER gates a non-Bash tool (Write/Read/MCP pass straight through)", () => {
    expect(decideBashAllowlist("Write", undefined, allow([])).deny).toBe(false);
    expect(decideBashAllowlist("Read", undefined, allow([])).deny).toBe(false);
    expect(
      decideBashAllowlist("mcp__clawcode__memory", undefined, allow([])).deny,
    ).toBe(false);
    expect(decideBashAllowlist(undefined, undefined, allow([])).deny).toBe(false);
  });

  it("allows an empty/whitespace Bash command (nothing to run → nothing to gate)", () => {
    expect(decideBashAllowlist("Bash", "   ", allow(["git *"]))).toEqual({
      deny: false,
    });
  });

  it("fails CLOSED (denies) when the allowlist env is missing or unparseable", () => {
    expect(decideBashAllowlist("Bash", "ls", undefined).deny).toBe(true);
    expect(decideBashAllowlist("Bash", "ls", "not json").deny).toBe(true);
    expect(decideBashAllowlist("Bash", "ls", "{}").deny).toBe(true); // not an array
  });

  it("an empty allowlist array denies every Bash command (deny-all)", () => {
    expect(decideBashAllowlist("Bash", "ls", allow([])).deny).toBe(true);
  });
});
