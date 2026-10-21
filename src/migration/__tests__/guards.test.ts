import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertReadOnlySource, ReadOnlySourceError } from "../guards.js";

describe("assertReadOnlySource", () => {
  it("throws for a path under ~/.openclaw/", () => {
    const target = join(homedir(), ".openclaw", "workspace", "file.md");
    expect(() => assertReadOnlySource(target)).toThrow(ReadOnlySourceError);
  });

  it("throws for ~/.openclaw itself", () => {
    expect(() => assertReadOnlySource(join(homedir(), ".openclaw"))).toThrow(
      ReadOnlySourceError,
    );
  });

  it("allows a similar-prefix sibling such as ~/.openclaw-backup", () => {
    const target = join(homedir(), ".openclaw-backup", "foo");
    expect(() => assertReadOnlySource(target)).not.toThrow();
  });

  it("allows paths outside ~/.openclaw", () => {
    expect(() => assertReadOnlySource("/tmp/clawcode/agents/a/SOUL.md")).not.toThrow();
  });
});
