import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDreamWikilinks } from "../dream-graph-edges.js";

const FIXED_NOW = new Date("2026-05-02T12:00:00.000Z");

describe("appendDreamWikilinks", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dream-graph-edges-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates graph-edges.json with new edges when file is missing", async () => {
    const result = await appendDreamWikilinks({
      memoryRoot: dir,
      links: [
        { from: "memory/a.md", to: "memory/b.md" },
        { from: "memory/c.md", to: "memory/d.md" },
      ],
      now: () => FIXED_NOW,
    });
    expect(result.added).toBe(2);

    const raw = await readFile(join(dir, "graph-edges.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.edges).toEqual([
      {
        from: "memory/a.md",
        to: "memory/b.md",
        createdAt: FIXED_NOW.toISOString(),
      },
      {
        from: "memory/c.md",
        to: "memory/d.md",
        createdAt: FIXED_NOW.toISOString(),
      },
    ]);
  });

  it("dedupes overlapping edges and preserves prior entries", async () => {
    const filePath = join(dir, "graph-edges.json");
    await writeFile(
      filePath,
      JSON.stringify({
        edges: [
          {
            from: "memory/a.md",
            to: "memory/b.md",
            createdAt: "2026-04-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const result = await appendDreamWikilinks({
      memoryRoot: dir,
      links: [
        { from: "memory/a.md", to: "memory/b.md" }, // duplicate — should skip
        { from: "memory/c.md", to: "memory/d.md" }, // new
      ],
      now: () => FIXED_NOW,
    });
    expect(result.added).toBe(1);

    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed.edges).toHaveLength(2);
    expect(parsed.edges[0]).toEqual({
      from: "memory/a.md",
      to: "memory/b.md",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    expect(parsed.edges[1]).toEqual({
      from: "memory/c.md",
      to: "memory/d.md",
      createdAt: FIXED_NOW.toISOString(),
    });
  });

  it("returns added=0 and writes nothing when links input is empty", async () => {
    const result = await appendDreamWikilinks({
      memoryRoot: dir,
      links: [],
      now: () => FIXED_NOW,
    });
    expect(result.added).toBe(0);
    await expect(readFile(join(dir, "graph-edges.json"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("returns added=0 and does not rewrite when every link is a duplicate", async () => {
    const filePath = join(dir, "graph-edges.json");
    const original = JSON.stringify({
      edges: [
        {
          from: "memory/a.md",
          to: "memory/b.md",
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
    await writeFile(filePath, original, "utf8");

    const result = await appendDreamWikilinks({
      memoryRoot: dir,
      links: [{ from: "memory/a.md", to: "memory/b.md" }],
      now: () => FIXED_NOW,
    });
    expect(result.added).toBe(0);

    const after = await readFile(filePath, "utf8");
    expect(after).toBe(original);
  });

  it("treats malformed JSON as empty and overwrites cleanly", async () => {
    const filePath = join(dir, "graph-edges.json");
    await writeFile(filePath, "{ this is not json", "utf8");

    const result = await appendDreamWikilinks({
      memoryRoot: dir,
      links: [{ from: "memory/x.md", to: "memory/y.md" }],
      now: () => FIXED_NOW,
    });
    expect(result.added).toBe(1);

    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed.edges).toEqual([
      {
        from: "memory/x.md",
        to: "memory/y.md",
        createdAt: FIXED_NOW.toISOString(),
      },
    ]);
  });

  it("creates the memoryRoot directory if it does not exist", async () => {
    const nestedRoot = join(dir, "nested", "memory");
    const result = await appendDreamWikilinks({
      memoryRoot: nestedRoot,
      links: [{ from: "memory/a.md", to: "memory/b.md" }],
      now: () => FIXED_NOW,
    });
    expect(result.added).toBe(1);

    const parsed = JSON.parse(
      await readFile(join(nestedRoot, "graph-edges.json"), "utf8"),
    );
    expect(parsed.edges).toHaveLength(1);
  });
});
