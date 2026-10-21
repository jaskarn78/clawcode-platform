import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStyleState,
  writeStyleState,
  clearStyleState,
} from "../style-state-store.js";

/** Invariants mirrored from effort-state-store.test.ts. */
describe("style-state-store", () => {
  async function tmpPath(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), "style-state-")), "style-state.json");
  }

  it("missing file → null (silent first-boot state)", async () => {
    expect(await readStyleState(await tmpPath(), "projects")).toBeNull();
  });

  it("round-trips a style", async () => {
    const p = await tmpPath();
    await writeStyleState(p, "projects", "bluf");
    expect(await readStyleState(p, "projects")).toBe("bluf");
    expect(await readStyleState(p, "other")).toBeNull();
  });

  it("corrupt JSON → null, and a later write starts fresh (never blocks)", async () => {
    const p = await tmpPath();
    await writeFile(p, "{not json", "utf8");
    expect(await readStyleState(p, "projects")).toBeNull();
    await writeStyleState(p, "projects", "brief");
    expect(await readStyleState(p, "projects")).toBe("brief");
  });

  it("per-entry salvage: one junk sibling never nulls the record", async () => {
    const p = await tmpPath();
    await writeStyleState(p, "a", "sourced");
    // Inject a junk sibling by hand.
    const raw = JSON.parse(await readFile(p, "utf8")) as {
      agents: Record<string, unknown>;
    };
    raw.agents["b"] = "zen-master"; // persona from the rejected corpus
    await writeFile(p, JSON.stringify(raw), "utf8");
    expect(await readStyleState(p, "a")).toBe("sourced");
    expect(await readStyleState(p, "b")).toBeNull();
    // A write against the file with the junk sibling keeps `a` intact.
    await writeStyleState(p, "c", "steps");
    expect(await readStyleState(p, "a")).toBe("sourced");
  });

  it("clearStyleState removes ONE agent, leaves siblings, no-ops on absent", async () => {
    const p = await tmpPath();
    await writeStyleState(p, "a", "plain");
    await writeStyleState(p, "b", "bluf");
    await clearStyleState(p, "a");
    expect(await readStyleState(p, "a")).toBeNull();
    expect(await readStyleState(p, "b")).toBe("bluf");
    await clearStyleState(p, "never-existed"); // no throw
  });
});
