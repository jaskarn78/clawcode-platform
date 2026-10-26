/**
 * Static wiring sentinels for the daemon's dream-machinery edge (WP7).
 *
 * The daemon regions that build the machinery and register the cron are
 * plain closures with no pure handler to unit test, so these pin the three
 * wirings by reading the source, in the same spirit as
 * dream-cron-wiring.test.ts:
 *   - the dream dispatch calls callModelDirect with the requested model
 *     (every pass used to run on Haiku through callHaikuDirect while the
 *     dream log claimed the configured model);
 *   - the cron registration passes the machinery's novelty gate and the
 *     tick's idle minutes;
 *   - the machinery gets a memoryDir resolver for the reflection digest.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = path.resolve(__dirname, "..", "daemon.ts");

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start);
  expect(end, `marker not found: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("daemon dream wiring (WP7)", () => {
  const src = readFileSync(DAEMON_PATH, "utf-8");

  it("the dream dispatch honors the requested model through callModelDirect", () => {
    const block = between(src, "const buildDreamMachineryForDaemon = () =>", "const turnDispatcher = new TurnDispatcher(");
    expect(block).toMatch(/dispatch:\s*async\s*\(dispatchReq\)\s*=>/);
    expect(block).toContain("dispatchReq.model");
    expect(block).toMatch(/callModelDirect\(/);
    expect(block).not.toMatch(/callHaikuDirect\(/);
    // The response reports the model that really ran.
    expect(block).toMatch(/return \{ rawText: text, tokensIn: inApprox, tokensOut: outApprox, model \}/);
  });

  it("the machinery receives a memoryDir resolver for the reflection digest", () => {
    const block = between(src, "const buildDreamMachineryForDaemon = () =>", "const turnDispatcher = new TurnDispatcher(");
    expect(block).toMatch(/resolveMemoryDir:\s*\(agent: string\)\s*=>/);
    expect(block).toContain("resolveMemoryRoots(cfg).memoryDir");
  });

  it("the cron registration wires the novelty gate and the measured idle minutes", () => {
    const block = between(src, "const dreamCronRegistrations: DreamCronRegistration[] = [];", "dream cron wiring complete");
    expect(block).toMatch(/noveltyGate:\s*\(agent: string\)\s*=>\s*dreamMachinery\.noveltyGate\(agent\)/);
    expect(block).toMatch(
      /applyDreamResultPriority:\s*\(agent, outcome, isPriorityPass, idleMinutes\)\s*=>\s*dreamMachinery\.applyDreamResult\(agent, outcome, isPriorityPass, idleMinutes\)/,
    );
  });
});
