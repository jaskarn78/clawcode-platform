/**
 * `post_cv2_embed` — turn the agent's `files[]` request into the
 * `OutboundFile[]` a Components-v2 post carries.
 *
 * This is a security boundary: the agent names arbitrary paths and the bytes
 * go straight to Discord. The gate is the SAME one `clawcode_share_file`
 * enforces (`isPathInsideRoots` over the agent's workspace + memoryPath +
 * fileAccess), applied twice — once to the resolved path and once to its
 * realpath — so a symlink planted inside the workspace cannot point outside
 * it. Anything not a regular file, over Discord's per-file cap, or more than
 * one gallery's worth is refused with a reason the agent can act on. Nothing
 * is read until every check passes.
 *
 * DI-pure (fs injected) so the boundary is unit-testable without a disk.
 */
import { basename, isAbsolute, resolve } from "node:path";
import { MAX_ATTACHMENT_SIZE } from "../../discord/attachment-types.js";
import type { OutboundFile } from "../../discord/table-delivery.js";
import { isPathInsideRoots } from "./clawcode-share-file.js";
import { ATTACHMENT_NAME_RE, MAX_CV2_FILES } from "../../mcp/cv2-spec-schema.js";

export type Cv2FileRequest = {
  readonly path: string;
  readonly name?: string;
  readonly description?: string;
};

export type Cv2AttachmentDeps = {
  /** Upload surface — paths must resolve (and realpath) inside one of these. */
  readonly allowedRoots: readonly string[];
  /** Relative `path` values are anchored here. */
  readonly workspaceRoot: string;
  readonly realpath: (p: string) => Promise<string>;
  readonly stat: (p: string) => Promise<{ readonly size: number; readonly isFile: boolean }>;
  readonly readFile: (p: string) => Promise<Buffer>;
};

export type Cv2AttachmentsResult =
  | { readonly ok: true; readonly files: readonly OutboundFile[] }
  | { readonly ok: false; readonly reason: string };

/** Discord shows this name and `attachment://<name>` binds to it — same rule as the MCP schema. */
const NAME_RE = ATTACHMENT_NAME_RE;

function validName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && NAME_RE.test(name) && name !== "." && name !== "..";
}

export async function loadCv2Attachments(
  requests: readonly Cv2FileRequest[],
  deps: Cv2AttachmentDeps,
): Promise<Cv2AttachmentsResult> {
  if (requests.length === 0) return { ok: true, files: [] };
  if (requests.length > MAX_CV2_FILES) {
    return { ok: false, reason: `${requests.length} files requested; a CV2 post carries at most ${MAX_CV2_FILES}` };
  }
  if (deps.allowedRoots.length === 0) return { ok: false, reason: "agent has no upload roots configured" };

  // Validate everything before reading anything.
  const planned: { readonly abs: string; readonly name: string; readonly description?: string }[] = [];
  const seen = new Set<string>();
  for (const req of requests) {
    // The MCP schema guarantees shape; a raw-socket caller does not. Refuse
    // cleanly rather than TypeError-ing into the IPC error wrapper.
    if (typeof req !== "object" || req === null) return { ok: false, reason: "each files[] entry must be an object with a path" };
    if (typeof req.path !== "string" || req.path.length === 0) return { ok: false, reason: "file path must be a non-empty string" };

    const abs = isAbsolute(req.path) ? resolve(req.path) : resolve(deps.workspaceRoot, req.path);
    if (!isPathInsideRoots(abs, deps.allowedRoots)) {
      return { ok: false, reason: `'${req.path}' is outside the agent's workspace/fileAccess roots; refused` };
    }

    let real: string;
    try {
      real = await deps.realpath(abs);
    } catch (err) {
      return { ok: false, reason: `'${req.path}': ${err instanceof Error ? err.message : String(err)}` };
    }
    // Second gate on the realpath — a symlink inside the roots must not escape them.
    if (!isPathInsideRoots(real, deps.allowedRoots)) {
      return { ok: false, reason: `'${req.path}' resolves outside the agent's workspace/fileAccess roots; refused` };
    }

    let st: { readonly size: number; readonly isFile: boolean };
    try {
      st = await deps.stat(real);
    } catch (err) {
      return { ok: false, reason: `'${req.path}': ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!st.isFile) return { ok: false, reason: `'${req.path}' is not a regular file` };
    if (st.size > MAX_ATTACHMENT_SIZE) {
      return { ok: false, reason: `'${req.path}' is ${st.size} bytes; Discord allows at most ${MAX_ATTACHMENT_SIZE}` };
    }

    const name = req.name ?? basename(real);
    if (!validName(name)) return { ok: false, reason: `attachment name '${name}' is not a valid single-segment filename` };
    if (seen.has(name)) return { ok: false, reason: `attachment name '${name}' is used twice; names must be unique` };
    seen.add(name);

    planned.push({ abs: real, name, ...(req.description !== undefined ? { description: req.description } : {}) });
  }

  const files: OutboundFile[] = [];
  for (const p of planned) {
    let data: Buffer;
    try {
      data = await deps.readFile(p.abs);
    } catch (err) {
      return { ok: false, reason: `'${p.name}': ${err instanceof Error ? err.message : String(err)}` };
    }
    files.push({ attachment: data, name: p.name, ...(p.description !== undefined ? { description: p.description } : {}) });
  }
  return { ok: true, files };
}
