/**
 * Phase 999.154 — REAL-binary contract test (opt-in).
 *
 * Every other vision test mocks the `claude` binary; that is exactly how a
 * dropped image passed four months of green tests. This one spawns the real
 * CLI with the canary fixture and requires the known text back.
 *
 *   CLAWCODE_REAL_CLI_TEST=1 npx vitest run src/vision/__tests__/real-cli-contract.test.ts
 *
 * Costs one small Haiku call (~$0.02). Run before every CLI pin bump.
 */

import { describe, it, expect } from "vitest";
import pino from "pino";
import { createBridgeHaikuProvider } from "../providers/bridge-haiku.js";
import { createOcrOnlyProvider } from "../providers/ocr-only.js";
import { VisionService } from "../service.js";
import { CANARY_TOKEN } from "../canary.js";

const enabled = process.env.CLAWCODE_REAL_CLI_TEST === "1";

describe.skipIf(!enabled)("real CLI vision contract", () => {
  it(
    "the canary fixture round-trips through the real binary",
    async () => {
      const svc = new VisionService({
        providers: [
          createBridgeHaikuProvider({ site: "vision-canary", maxBatch: 1 }),
          createOcrOnlyProvider(),
        ],
        log: pino({ level: "silent" }),
      });
      const outcome = await svc.runCanary();
      expect(outcome.get("bridge-haiku")).toBe(true);
      expect(CANARY_TOKEN).toBe("7351");
    },
    120_000,
  );
});
