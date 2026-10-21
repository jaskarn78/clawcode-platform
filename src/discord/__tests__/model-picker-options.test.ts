/**
 * Phase 999.114 — `/clawcode-model` select-menu option construction.
 */
import { describe, it, expect } from "vitest";
import { buildModelPickerOptions } from "../model-picker-options.js";
import {
  DEFAULT_PICKER_MODELS,
  type ConfigModel,
} from "../../shared/model-catalog.js";

describe("buildModelPickerOptions", () => {
  it("renders human names and prices, not raw config aliases", () => {
    const opts = buildModelPickerOptions(["fable", "opus-4-8"]);
    expect(opts.map((o) => o.label)).toEqual([
      "Claude Fable 5.1",
      "Claude Opus 4.8",
    ]);
    // The VALUE stays the config alias — that is what goes over IPC.
    expect(opts.map((o) => o.value)).toEqual(["fable", "opus-4-8"]);
    expect(opts[0]!.description).toContain("$10/$50");
    expect(opts[1]!.description).toContain("$5/$25");
  });

  it("distinguishes the current pin from a superseded one", () => {
    const [current, legacy] = buildModelPickerOptions(["sonnet", "sonnet-4-5"]);
    expect(current!.description).toContain("current");
    expect(legacy!.description).toContain("previous release");
    // Per-MODEL pricing: Sonnet 5 is $2/$10, Sonnet 4.5 is $3/$15.
    expect(current!.description).toContain("$2/$10");
    expect(legacy!.description).toContain("$3/$15");
  });

  it("marks the agent's current model so Discord pre-selects it", () => {
    const opts = buildModelPickerOptions(["haiku", "opus"], "opus");
    expect(opts.filter((o) => o.isCurrent).map((o) => o.value)).toEqual(["opus"]);
  });

  it("describes `<family>@latest` as auto-following new releases", () => {
    const [opt] = buildModelPickerOptions(["fable@latest"]);
    expect(opt!.label).toBe("Claude Fable — latest");
    expect(opt!.description).toContain("Auto-follows");
  });

  it("orders strongest family first, and within a family: pin, latest, legacy", () => {
    expect(
      buildModelPickerOptions([
        "haiku",
        "opus-4-8",
        "fable",
        "opus",
        "opus@latest",
      ]).map((o) => o.value),
    ).toEqual(["fable", "opus", "opus@latest", "opus-4-8", "haiku"]);
  });

  it("de-dupes — a repeated value makes Discord reject the whole menu", () => {
    const opts = buildModelPickerOptions([
      "opus",
      "opus",
      "haiku",
    ] as ConfigModel[]);
    expect(opts.map((o) => o.value)).toEqual(["opus", "haiku"]);
  });

  it("renders an unrecognized hand-edited value instead of dropping it silently", () => {
    const [opt] = buildModelPickerOptions(["totally-made-up" as ConfigModel]);
    expect(opt!.label).toBe("totally-made-up");
    expect(opt!.description).toContain("Unrecognized");
  });

  it("the shipped default fits Discord's 25-option menu cap", () => {
    const opts = buildModelPickerOptions(DEFAULT_PICKER_MODELS);
    expect(opts.length).toBe(DEFAULT_PICKER_MODELS.length);
    expect(opts.length).toBeLessThanOrEqual(25);
    // Discord rejects a label or description longer than 100 chars.
    for (const o of opts) {
      expect(o.label.length).toBeLessThanOrEqual(100);
      expect(o.description.length).toBeLessThanOrEqual(100);
      expect(o.label.length).toBeGreaterThan(0);
    }
  });
});
