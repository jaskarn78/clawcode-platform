/**
 * Phase 90 Plan 07 WIRE-06 — `clawcode memory backfill <agent>` CLI tests.
 *
 * Tests MB-CLI1..MB-CLI3 — happy path / agent not found / idempotent re-run.
 * DI'd against a stub MemoryScanner + stub loadConfig so tests don't touch
 * SQLite, MiniLM embeddings, or a real daemon.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runMemoryBackfillAction } from "../memory-backfill.js";

describe("memory-backfill CLI", () => {
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutCapture = [];
    stderrCapture = [];
    writeStdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdoutCapture.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stdout.write);
    writeStderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderrCapture.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stderr.write);
  });

  afterEach(() => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("MB-CLI1: happy path — exits 0 and emits 'Indexed N memory/*.md files, M chunks'", async () => {
    const loadConfigStub = vi.fn().mockResolvedValue({
      agents: [
        {
          name: "fin-client",
          workspace: "/tmp/ws-fin",
          memoryPath: "/tmp/ws-fin/memory/fin-client",
        },
      ],
    });
    const backfillStub = vi.fn().mockResolvedValue({
      indexed: 62,
      chunks: 487,
      skipped: 0,
    });
    const makeScannerStub = vi.fn().mockReturnValue({
      backfill: backfillStub,
    });

    const code = await runMemoryBackfillAction({
      agentName: "fin-client",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: loadConfigStub,
      makeScanner: makeScannerStub,
    });

    expect(code).toBe(0);
    const combined = stdoutCapture.join("") + stderrCapture.join("");
    expect(combined).toMatch(/Indexed 62 memory\/\*\.md files, 487 chunks/);
    expect(backfillStub).toHaveBeenCalledOnce();
    expect(makeScannerStub).toHaveBeenCalledOnce();
  });

  it("MB-CLI2: agent not found — exits 1 with stderr error", async () => {
    const loadConfigStub = vi.fn().mockResolvedValue({
      agents: [
        {
          name: "fin-client",
          workspace: "/tmp/ws-fin",
        },
      ],
    });
    const backfillStub = vi.fn();
    const makeScannerStub = vi.fn();

    const code = await runMemoryBackfillAction({
      agentName: "ghost",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: loadConfigStub,
      makeScanner: makeScannerStub,
    });

    expect(code).toBe(1);
    const stderr = stderrCapture.join("") + stdoutCapture.join("");
    expect(stderr).toMatch(/Agent 'ghost' not in clawcode\.yaml/);
    expect(backfillStub).not.toHaveBeenCalled();
  });

  it("MB-CLI3: idempotent re-run — second invocation returns same chunk count", async () => {
    const loadConfigStub = vi.fn().mockResolvedValue({
      agents: [
        {
          name: "fin-client",
          workspace: "/tmp/ws-fin",
        },
      ],
    });
    // First run indexes 62 files, 487 chunks; second is fully skipped.
    const backfillStub = vi
      .fn()
      .mockResolvedValueOnce({ indexed: 62, chunks: 487, skipped: 0 })
      .mockResolvedValueOnce({ indexed: 0, chunks: 0, skipped: 62 });
    const makeScannerStub = vi.fn().mockReturnValue({
      backfill: backfillStub,
    });

    const code1 = await runMemoryBackfillAction({
      agentName: "fin-client",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: loadConfigStub,
      makeScanner: makeScannerStub,
    });
    const code2 = await runMemoryBackfillAction({
      agentName: "fin-client",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: loadConfigStub,
      makeScanner: makeScannerStub,
    });

    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(backfillStub).toHaveBeenCalledTimes(2);
    const combined = stdoutCapture.join("") + stderrCapture.join("");
    // First run reports 487 chunks, second run reports 0 chunks + 62 skipped.
    expect(combined).toMatch(/Indexed 62 memory\/\*\.md files, 487 chunks/);
    expect(combined).toMatch(/skipped 62 unchanged/);
  });
});
