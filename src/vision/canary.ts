/**
 * Phase 999.154 — vision health canary.
 *
 * A fixture PNG with known text goes through the REAL provider (real binary,
 * real model). Mocked binaries are why a dropped image went unnoticed for four
 * months; this is the check that cannot be mocked away in production.
 */

import type { LabeledImage } from "./types.js";

/** 420×110 1-bit PNG reading "CANARY 7351" (DejaVu Sans Bold 48pt). */
export const CANARY_TOKEN = "7351";

export const CANARY_IMAGE: LabeledImage = Object.freeze({
  id: "vision-canary",
  filename: "canary.png",
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAaQAAABuAQAAAABAM1r+AAAC3UlEQVR42u2XTYrkRhCFv0wJlxYNrd3MrnUDzw1Kc5GhbzKBTzBH6KNk+STyrpbZYIymycnnReq3qrGxweCFEooilfniRbz4EXLin69Xz79ZB+pAHagDdaAO1IH6z1Cv9d/c+tzcPJAk46zoJJ4yUjgpwddYaXTSAFWCrxkqZc6SFJGU4VERyQqqUoZTrBQraYBTgqcMJw0TqgbeACJgjwABMqQmz+6k6TjxsolrfC+UH7WIJd456pp+g4oAA4aNAJbx5WQoIqRULCfCBjVUqWxsJsqALdu6Pod7rlBXtkYAgEs4QminXfiUgMQlbPL1kWcCAcuAEF4VAB08KTYeoFLiS1jzxXnKGS47ZVBy4mxPRefhURqrXElSKMqvFVV8Frjy1/da4lh0XD0sh8aAqShh3mGBWPQYWhjT1vSmel9m2byRhfXdH5v01eQ916x4XEwFHEabHLMmEVx1z6WCDo4EeBXWJZaXhpz7LVepN9eCdQjqnuwEzarTxVpg2HL5qRrGcjDCgDJWT8IZwDNwveeiAWunODy1Y2Gz6ZfuNfSAER00kMHPR5oV2WvopwpM0CBiaYIHHIXaFYE/DHnhqhcPAUvjzoNurn8YuX7fTRs/tUOe8ta2Y4bfN43DOeCotc/y2s/JMawtVh554FMqV2/V+F6DeQS/tXgX9/Ngzt1NRUUQ5jIESFkPy1fPWG+o+/dn71R6zm+iAmp/y+WWIWKlV8DL7b1L73MNgNnkbs5uMVsm2KaGlpIYiLuG3s0rWsYSmNurceWFsywYOFCWF3MGGOCNEVnae9i//bBQ7HcSQHYb1g713+DbFS79pZ+nSKf68fZNw+J0AC6XU3rtqt3sbQHr6QejJTscv7i5yBch69vZ29wpkLW+M6xnsrzX8KeNyTnLN9fogI87D53xM0YXDZQ82K/rzBfGAwQPz6tEkhQr/fUKH6Treim649v8QB2oA3WgDtSB+t+g/gQzzIJQdj11NQAAAABJRU5ErkJggg==",
});
