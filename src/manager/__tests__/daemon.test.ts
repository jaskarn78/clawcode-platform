import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ensureCleanSocket } from "../daemon.js";

describe("Daemon", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("ensureCleanSocket", () => {
    it("removes stale socket file when no daemon is running", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "daemon-test-"));
      const socketPath = join(tmpDir, "test.sock");

      // Create a fake stale socket file
      await writeFile(socketPath, "stale", "utf-8");

      // Should detect the file is not a real socket and delete it
      await ensureCleanSocket(socketPath);

      // File should be gone
      await expect(access(socketPath)).rejects.toThrow();
    });

    it("does nothing when no socket file exists", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "daemon-test-"));
      const socketPath = join(tmpDir, "nonexistent.sock");

      // Should not throw
      await expect(ensureCleanSocket(socketPath)).resolves.toBeUndefined();
    });
  });
});
