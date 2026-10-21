/**
 * `loadCv2Attachments` — the upload boundary for `post_cv2_embed` files.
 * Same gate as clawcode_share_file, applied to the path AND its realpath.
 * All fs is injected; no disk.
 */
import { describe, it, expect, vi, type Mock } from "vitest";
import { loadCv2Attachments, type Cv2AttachmentDeps } from "../cv2-attachments.js";
import { MAX_ATTACHMENT_SIZE } from "../../../discord/attachment-types.js";
import { MAX_CV2_FILES } from "../../../mcp/cv2-spec-schema.js";

const WS = "/home/clawcode/.clawcode/agents/client-a-personal";
const MEM = `${WS}/memory`;

type Fake = { readonly real?: string; readonly size?: number; readonly isFile?: boolean; readonly bytes?: string };

type FakeDeps = Cv2AttachmentDeps & { readonly readFile: Mock<(p: string) => Promise<Buffer>> };

/** A tiny fake fs keyed by absolute path. `real` overrides realpath (symlinks). */
function fakeFs(entries: Record<string, Fake>, overrides: { readonly allowedRoots?: readonly string[] } = {}): FakeDeps {
  const readFile = vi.fn<(p: string) => Promise<Buffer>>(async (p) => {
    const e = entries[p];
    if (!e) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    return Buffer.from(e.bytes ?? "data");
  });
  return {
    allowedRoots: overrides.allowedRoots ?? [WS, MEM],
    workspaceRoot: WS,
    realpath: async (p) => {
      const e = entries[p];
      if (!e) throw new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      return e.real ?? p;
    },
    stat: async (p) => {
      const e = entries[p] ?? Object.values(entries).find((x) => x.real === p);
      if (!e) throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
      return { size: e.size ?? 10, isFile: e.isFile ?? true };
    },
    readFile,
  };
}

describe("loadCv2Attachments — happy paths", () => {
  it("loads an absolute path inside the workspace, named by its basename", async () => {
    const fs = fakeFs({ [`${WS}/charts/one.png`]: { bytes: "png1" } });
    const r = await loadCv2Attachments([{ path: `${WS}/charts/one.png` }], fs);
    expect(r).toEqual({ ok: true, files: [{ attachment: Buffer.from("png1"), name: "one.png" }] });
  });

  it("anchors a relative path at the workspace root", async () => {
    const fs = fakeFs({ [`${WS}/charts/one.png`]: {} });
    const r = await loadCv2Attachments([{ path: "charts/one.png" }], fs);
    expect(r.ok).toBe(true);
    expect(fs.readFile).toHaveBeenCalledWith(`${WS}/charts/one.png`);
  });

  it("honours an explicit name and description", async () => {
    const fs = fakeFs({ [`${WS}/tmp/render-8f3a.png`]: {} });
    const r = await loadCv2Attachments([{ path: "tmp/render-8f3a.png", name: "chart1.png", description: "Weekly volume" }], fs);
    expect(r).toEqual({ ok: true, files: [{ attachment: Buffer.from("data"), name: "chart1.png", description: "Weekly volume" }] });
  });

  it("allows memoryPath and fileAccess roots, not just the workspace", async () => {
    const fs = fakeFs({ [`${MEM}/snap.png`]: {} });
    expect((await loadCv2Attachments([{ path: `${MEM}/snap.png` }], fs)).ok).toBe(true);
  });

  it("empty request → ok with no files, touches nothing", async () => {
    const fs = fakeFs({});
    expect(await loadCv2Attachments([], fs)).toEqual({ ok: true, files: [] });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("follows a symlink that stays inside the roots", async () => {
    const fs = fakeFs({
      [`${WS}/latest.png`]: { real: `${WS}/renders/2026-09-10.png` },
      [`${WS}/renders/2026-09-10.png`]: {},
    });
    const r = await loadCv2Attachments([{ path: "latest.png" }], fs);
    expect(r.ok).toBe(true);
    // Read from the real file; Discord name stays what the agent referenced.
    expect(fs.readFile).toHaveBeenCalledWith(`${WS}/renders/2026-09-10.png`);
    if (r.ok) expect(r.files[0].name).toBe("2026-09-10.png");
  });
});

describe("loadCv2Attachments — the security boundary", () => {
  it("refuses an absolute path outside every root, before any I/O", async () => {
    const fs = fakeFs({ "/etc/passwd": {} });
    const r = await loadCv2Attachments([{ path: "/etc/passwd" }], fs);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/outside.*refused/) });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("refuses `..` traversal in a relative path", async () => {
    const fs = fakeFs({ "/home/clawcode/.clawcode/agents/acme/clients/x.pdf": {} });
    const r = await loadCv2Attachments([{ path: "../acme/clients/x.pdf" }], fs);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
  });

  it("refuses a symlink inside the workspace that points OUTSIDE it", async () => {
    const fs = fakeFs({
      [`${WS}/innocent.png`]: { real: "/etc/shadow" },
      "/etc/shadow": {},
    });
    const r = await loadCv2Attachments([{ path: "innocent.png" }], fs);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/resolves outside/) });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("a root-prefix lookalike is outside (no startsWith without separator)", async () => {
    const fs = fakeFs({ [`${WS}-evil/x.png`]: {} });
    expect((await loadCv2Attachments([{ path: `${WS}-evil/x.png` }], fs)).ok).toBe(false);
  });

  it("refuses when the agent has no roots at all", async () => {
    const fs = fakeFs({ [`${WS}/a.png`]: {} }, { allowedRoots: [] });
    expect((await loadCv2Attachments([{ path: "a.png" }], fs)).ok).toBe(false);
  });
});

describe("loadCv2Attachments — file checks", () => {
  it("refuses a directory", async () => {
    const fs = fakeFs({ [`${WS}/charts`]: { isFile: false } });
    expect(await loadCv2Attachments([{ path: "charts" }], fs)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a regular file/) });
  });

  it("refuses a file over Discord's cap, naming the size", async () => {
    const fs = fakeFs({ [`${WS}/big.mp4`]: { size: MAX_ATTACHMENT_SIZE + 1 } });
    const r = await loadCv2Attachments([{ path: "big.mp4" }], fs);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(String(MAX_ATTACHMENT_SIZE + 1)) });
  });

  it("accepts a file exactly at the cap", async () => {
    const fs = fakeFs({ [`${WS}/edge.bin`]: { size: MAX_ATTACHMENT_SIZE } });
    expect((await loadCv2Attachments([{ path: "edge.bin" }], fs)).ok).toBe(true);
  });

  it("refuses a missing file with the OS reason", async () => {
    const fs = fakeFs({});
    expect(await loadCv2Attachments([{ path: "nope.png" }], fs)).toMatchObject({ ok: false, reason: expect.stringMatching(/ENOENT/) });
  });

  it(`refuses more than ${MAX_CV2_FILES} files`, async () => {
    const entries = Object.fromEntries(Array.from({ length: MAX_CV2_FILES + 1 }, (_, i) => [`${WS}/f${i}.png`, {}]));
    const fs = fakeFs(entries);
    const r = await loadCv2Attachments(Object.keys(entries).map((path) => ({ path })), fs);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(`at most ${MAX_CV2_FILES}`) });
  });

  it("refuses duplicate attachment names (two paths, same basename)", async () => {
    const fs = fakeFs({ [`${WS}/a/chart.png`]: {}, [`${WS}/b/chart.png`]: {} });
    const r = await loadCv2Attachments([{ path: "a/chart.png" }, { path: "b/chart.png" }], fs);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/used twice/) });
  });

  it("refuses an invalid explicit name", async () => {
    const fs = fakeFs({ [`${WS}/x.png`]: {} });
    expect((await loadCv2Attachments([{ path: "x.png", name: "a/b.png" }], fs)).ok).toBe(false);
    expect((await loadCv2Attachments([{ path: "x.png", name: ".." }], fs)).ok).toBe(false);
  });

  it("a non-object entry (raw-socket caller) is refused with a reason, not a TypeError", async () => {
    const fs = fakeFs({ [`${WS}/a.png`]: {} });
    const r = await loadCv2Attachments([null as unknown as { path: string }, { path: "a.png" }], fs);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/must be an object/) });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("a bidi-override in an explicit name is refused (same rule as the MCP schema)", async () => {
    const fs = fakeFs({ [`${WS}/x.png`]: {} });
    const r = await loadCv2Attachments([{ path: "x.png", name: `report${String.fromCharCode(0x202e)}gnp.exe` }], fs);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/not a valid/) });
  });

  it("validates every file before reading any — one bad file means zero reads", async () => {
    const fs = fakeFs({ [`${WS}/good.png`]: {}, [`${WS}/dir`]: { isFile: false } });
    const r = await loadCv2Attachments([{ path: "good.png" }, { path: "dir" }], fs);
    expect(r.ok).toBe(false);
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});
