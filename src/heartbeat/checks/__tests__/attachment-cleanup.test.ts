/**
 * WP3 (2026-10-25): the attachment cleanup sweeps the directory the bridge
 * downloads into (<memoryPath>/inbox/attachments) with the 24 h age policy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CheckContext } from "../../types.js";
import attachmentCleanupCheck from "../attachment-cleanup.js";
import { attachmentInboxDir } from "../../../discord/attachments.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wp3-cleanup-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctx(agentConfig: unknown): CheckContext {
  return {
    agentName: "a",
    sessionManager: { getAgentConfig: () => agentConfig },
  } as unknown as CheckContext;
}

describe("attachment-cleanup check", () => {
  it("removes inbox files older than 24 h and keeps fresh ones", async () => {
    const memoryPath = join(root, "mem");
    const inbox = join(memoryPath, "inbox", "attachments");
    mkdirSync(inbox, { recursive: true });
    expect(attachmentInboxDir(memoryPath)).toBe(inbox);
    const old = join(inbox, "1700000000000-old.png");
    const fresh = join(inbox, "1790000000000-new.png");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const t = Date.now() / 1000 - 25 * 3600;
    utimesSync(old, t, t);

    const r = await attachmentCleanupCheck.execute(ctx({ workspace: join(root, "ws"), memoryPath }));
    expect(r.metadata).toMatchObject({ removed: 1, dir: inbox });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("does not sweep the old workspace/attachments location", async () => {
    const ws = join(root, "ws");
    const legacy = join(ws, "attachments");
    mkdirSync(legacy, { recursive: true });
    const f = join(legacy, "keep.png");
    writeFileSync(f, "x");
    const t = Date.now() / 1000 - 48 * 3600;
    utimesSync(f, t, t);
    await attachmentCleanupCheck.execute(ctx({ workspace: ws, memoryPath: join(root, "mem") }));
    expect(existsSync(f)).toBe(true);
  });
});
