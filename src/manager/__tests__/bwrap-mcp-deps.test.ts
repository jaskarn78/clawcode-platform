/**
 * WS-3 (sandbox-hardening-2026-06-19) — MCP dependency-bind correctness (G2).
 *
 * The 2026-06-19 incident emptied `general`'s `mcpServers` with the note
 * "re-add after the venv bind fix ships" because a sandboxed agent's MCP server
 * children couldn't `import mcp` (or resolve `node_modules`) inside the
 * namespace. `discoverMcpDepPaths` (in bwrap-sandbox.ts) computes the RO dirs to
 * bind so each server's deps resolve. The pyvenv.cfg/node_modules walk-up logic
 * already shipped (PR #83); this suite VERIFIES it against the *documented prod
 * layout* at `/opt/clawcode-mcp-servers/{python-venv,python,node}/…` (mirrored
 * with tmpdir fixtures) and pins the known walk-up cap limitation.
 *
 * NOTE — these are additive fixtures in a NEW file (not added to the existing
 * bwrap-sandbox.test.ts) to avoid a modify/delete conflict with the in-flight
 * v2/v3 bwrap reconciliation (WS-5) that is deleting that file. If the
 * reconciliation relocates `discoverMcpDepPaths`, only this import needs fixing.
 *
 * What is NOT provable offline (deferred to the WS-4 validator at canary): that
 * the bound set lets every real server complete a JSON-RPC `initialize`
 * handshake inside the live sandbox with no ModuleNotFoundError. This suite
 * proves the bind-PLAN; the validator proves the bind-EFFECT.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMcpDepPaths } from "../bwrap-sandbox.js";

/**
 * Build a faithful copy of the prod MCP server tree under a tmp root:
 *
 *   <root>/python-venv/{bin/python, pyvenv.cfg, lib/python3.13/site-packages}
 *   <root>/python/finnhub/server.py                       (python server script)
 *   <root>/node/google-workspace/{package.json,node_modules,dist/index.js}
 *   <root>/node/shared-deps-srv/dist/index.js   + <root>/node/node_modules
 *   <root>/deepcase/node_modules + <root>/deepcase/x/y/z/dist/index.js (out of reach)
 *
 * The "too deep" case lives under its OWN <root>/deepcase subtree so its
 * out-of-reach node_modules can't pollute the other cases' walk-ups (the
 * markers are generic, so a stray node_modules in a shared ancestor would
 * change every server's bind — a real property worth isolating in fixtures).
 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "clawcode-mcp-deps-"));

  // Shared python venv (the `mcp` lib lives in lib/site-packages).
  mkdirSync(join(root, "python-venv", "bin"), { recursive: true });
  writeFileSync(join(root, "python-venv", "bin", "python"), "#!/bin/sh\n");
  writeFileSync(join(root, "python-venv", "pyvenv.cfg"), "home = /usr/bin\n");
  mkdirSync(join(root, "python-venv", "lib", "python3.13", "site-packages"), { recursive: true });

  // Python MCP server script (no marker in its own dir → binds its own dir).
  mkdirSync(join(root, "python", "finnhub"), { recursive: true });
  writeFileSync(join(root, "python", "finnhub", "server.py"), "# server\n");

  // Node server: node_modules + package.json AT the server root, script in dist/.
  mkdirSync(join(root, "node", "google-workspace", "dist"), { recursive: true });
  mkdirSync(join(root, "node", "google-workspace", "node_modules"), { recursive: true });
  writeFileSync(join(root, "node", "google-workspace", "package.json"), "{}\n");
  writeFileSync(join(root, "node", "google-workspace", "dist", "index.js"), "//\n");

  // Node server with node_modules one level UP (within the walk-up cap).
  mkdirSync(join(root, "node", "node_modules"), { recursive: true });
  mkdirSync(join(root, "node", "shared-deps-srv", "dist"), { recursive: true });
  writeFileSync(join(root, "node", "shared-deps-srv", "dist", "index.js"), "//\n");

  // Node server whose only node_modules is >3 levels above the script (out of
  // reach for MAX_ROOT_WALK). Isolated under its own subtree so it doesn't
  // pollute the other cases' walk-ups.
  mkdirSync(join(root, "deepcase", "node_modules"), { recursive: true });
  mkdirSync(join(root, "deepcase", "x", "y", "z", "dist"), { recursive: true });
  writeFileSync(join(root, "deepcase", "x", "y", "z", "dist", "index.js"), "//\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverMcpDepPaths — prod /opt/clawcode-mcp-servers layout (WS-3)", () => {
  it("binds the venv ROOT (mcp lib) AND the python server's script dir", () => {
    const deps = discoverMcpDepPaths([
      { command: join(root, "python-venv", "bin", "python"), args: [join(root, "python", "finnhub", "server.py")] },
    ]);
    // venv root → covers lib/site-packages where `mcp` resolves (the G2 fix).
    expect(deps).toContain(join(root, "python-venv"));
    // script's own dir (no project marker there) → server code is visible.
    expect(deps).toContain(join(root, "python", "finnhub"));
    // never the bin/ subdir alone (the original bug).
    expect(deps).not.toContain(join(root, "python-venv", "bin"));
  });

  it("binds a node server's ROOT (node_modules+package.json), not the dist/ subdir", () => {
    const deps = discoverMcpDepPaths([
      { command: "node", args: [join(root, "node", "google-workspace", "dist", "index.js")] },
    ]);
    expect(deps).toContain(join(root, "node", "google-workspace"));
    expect(deps).not.toContain(join(root, "node", "google-workspace", "dist"));
  });

  it("walks UP to a node_modules one level above the server root (within MAX_ROOT_WALK)", () => {
    const deps = discoverMcpDepPaths([
      { command: "node", args: [join(root, "node", "shared-deps-srv", "dist", "index.js")] },
    ]);
    expect(deps).toContain(join(root, "node"));
  });

  it("DOCUMENTED LIMITATION: node_modules beyond MAX_ROOT_WALK is missed → binds only the script dir", () => {
    // Mirrors the open "deep node_modules dirs may need wider binds" item: a
    // server whose deps are hoisted >3 levels above the script resolves only to
    // its own dist/ dir. The WS-4 live validator (handshake) is what catches
    // this if a real server is laid out this way — pinned here so the cap is a
    // conscious contract, not a silent surprise.
    const deps = discoverMcpDepPaths([
      { command: "node", args: [join(root, "deepcase", "x", "y", "z", "dist", "index.js")] },
    ]);
    expect(deps).toContain(join(root, "deepcase", "x", "y", "z", "dist"));
    expect(deps).not.toContain(join(root, "deepcase")); // out-of-reach node_modules NOT bound
  });

  it("de-duplicates + sorts across a realistic multi-server set", () => {
    const deps = discoverMcpDepPaths([
      { command: join(root, "python-venv", "bin", "python"), args: [join(root, "python", "finnhub", "server.py")] },
      // second python server sharing the SAME venv → venv bound once.
      { command: join(root, "python-venv", "bin", "python"), args: [join(root, "python", "finnhub", "server.py")] },
      { command: "node", args: [join(root, "node", "google-workspace", "dist", "index.js")] },
    ]);
    // sorted + unique
    expect(deps).toEqual([...deps].sort());
    expect(new Set(deps).size).toBe(deps.length);
    expect(deps.filter((d) => d === join(root, "python-venv"))).toHaveLength(1);
  });

  it("skips non-existent absolute paths and bare-name interpreters", () => {
    const deps = discoverMcpDepPaths([
      { command: "node", args: ["-y", "@modelcontextprotocol/server-everything"] }, // bare pkg name, not a path
      { command: "npx", args: ["playwright"] }, // bare-name → resolved via PATH, no bind
      { command: "/opt/clawcode-mcp-servers/does-not-exist/server.py", args: [] }, // non-existent abs
    ]);
    expect(deps).toEqual([]);
  });
});
