import { describe, it, expect, vi } from "vitest";
import { formatCleanupReport, runVisionCanary, runVisionCleanup } from "./vision.js";

describe("clawcode vision", () => {
  it("cleanup sends a dry run by default and renders the report", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const send = vi.fn(async () => ({
      apply: false,
      reports: [
        {
          agent: "fin-client",
          dbPath: "/m/memories.db",
          applied: false,
          backupPath: null,
          tables: [{ table: "document_chunks", scanned: 410, changed: 97, emptied: 3, residual: 0 }],
          reclassified: 12,
          samples: [{ table: "document_chunks", id: "c1", removed: "## Chart shape analysis I don't see…" }],
        },
        { agent: "shopping", skipped: "no memory store (agent not running)" },
      ],
    }));
    expect(await runVisionCleanup({ agent: "fin-client" }, send)).toBe(0);
    expect(send).toHaveBeenCalledWith("vision-cleanup", { agent: "fin-client", apply: false, source: "cli" });
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("changed    97  (emptied → deleted 3)");
    expect(text).toContain("reclassified 12");
    out.mockRestore();
  });

  it("formats an applied, clean agent", () => {
    expect(
      formatCleanupReport(true, [
        { agent: "a", dbPath: "/x", applied: false, backupPath: null, tables: [], reclassified: 0, samples: [] },
      ]),
    ).toContain("clean — nothing to do");
  });

  it("canary exit code reflects provider results", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runVisionCanary(async () => ({ ok: true, providers: { "bridge-haiku": true } }))).toBe(0);
    expect(await runVisionCanary(async () => ({ ok: false, providers: { "bridge-haiku": false } }))).toBe(1);
    out.mockRestore();
  });
});
