/**
 * Phase 90 Plan 06 HUB-05 — Discord config modal tests (CM-M1..M4, CM-SF1).
 *
 * Pins:
 *   CM-M1  buildPluginConfigModal happy — 3 fields → ModalBuilder with 3 rows
 *   CM-M2  sensitive field gets ⚠️ prefix + "op:// reference preferred" placeholder
 *   CM-M3  >5 fields → throws TooManyFieldsError
 *   CM-M4  parseModalSubmit extracts all field values
 *   CM-SF1 buildSerialPromptFlow yields frames in order with step/total
 */
import { describe, it, expect } from "vitest";
import {
  buildPluginConfigModal,
  parseModalSubmit,
  buildSerialPromptFlow,
  TooManyFieldsError,
} from "../config-modal.js";
import type { ClawhubPluginManifest } from "../../marketplace/clawhub-client.js";

function makeManifest(
  fieldCount: number,
  overrides?: Partial<
    NonNullable<ClawhubPluginManifest["config"]>["fields"][number]
  >,
): ClawhubPluginManifest {
  const fields = Array.from({ length: fieldCount }, (_, i) => ({
    name: `FIELD_${i}`,
    label: `Field ${i}`,
    type: "short" as const,
    sensitive: false,
    ...overrides,
  }));
  return Object.freeze({
    name: "test-plugin",
    description: "test",
    version: "1.0.0",
    command: "noop",
    args: [],
    env: {},
    config: { fields: Object.freeze(fields) },
  }) as ClawhubPluginManifest;
}

describe("buildPluginConfigModal (CM-M1, CM-M2, CM-M3)", () => {
  it("CM-M1: 3 fields → ModalBuilder with 3 rows + correct customIds", () => {
    const manifest = makeManifest(3);
    const modal = buildPluginConfigModal(manifest, "nonce-abc");
    const data = modal.toJSON();
    expect(data.custom_id).toBe("clawhub-plugin-config:test-plugin:nonce-abc");
    expect(data.title).toContain("test-plugin");
    expect(data.components).toHaveLength(3);
    const firstInput = (data.components[0] as unknown as {
      components: ReadonlyArray<{ custom_id: string; label: string }>;
    }).components[0];
    expect(firstInput.custom_id).toBe("field:FIELD_0");
    expect(firstInput.label).toBe("Field 0");
  });

  it("CM-M2: sensitive field gets ⚠️ prefix + op:// placeholder", () => {
    const manifest = Object.freeze({
      name: "plugin",
      description: "",
      version: "1.0",
      command: "noop",
      args: [],
      env: {},
      config: {
        fields: Object.freeze([
          {
            name: "API_KEY",
            label: "API Key",
            type: "short" as const,
            sensitive: true,
          },
        ]),
      },
    }) as ClawhubPluginManifest;
    const modal = buildPluginConfigModal(manifest, "n");
    const data = modal.toJSON();
    const input = (data.components[0] as unknown as {
      components: ReadonlyArray<{
        label: string;
        placeholder?: string;
      }>;
    }).components[0];
    expect(input.label).toContain("⚠️");
    expect(input.placeholder).toMatch(/op:\/\//);
  });

  it("CM-M3: 6 fields → throws TooManyFieldsError", () => {
    const manifest = makeManifest(6);
    expect(() => buildPluginConfigModal(manifest, "n")).toThrow(
      TooManyFieldsError,
    );
  });

  it("uses paragraph style for type=paragraph fields", () => {
    const manifest = Object.freeze({
      name: "plugin",
      description: "",
      version: "1.0",
      command: "noop",
      args: [],
      env: {},
      config: {
        fields: Object.freeze([
          {
            name: "SSH_KEY",
            label: "SSH Key",
            type: "paragraph" as const,
            sensitive: true,
          },
        ]),
      },
    }) as ClawhubPluginManifest;
    const modal = buildPluginConfigModal(manifest, "n");
    const data = modal.toJSON();
    const input = (data.components[0] as unknown as {
      components: ReadonlyArray<{ style: number }>;
    }).components[0];
    // TextInputStyle.Paragraph = 2, Short = 1
    expect(input.style).toBe(2);
  });

  it("respects custom placeholder when provided", () => {
    const manifest = Object.freeze({
      name: "plugin",
      description: "",
      version: "1.0",
      command: "noop",
      args: [],
      env: {},
      config: {
        fields: Object.freeze([
          {
            name: "HOST",
            label: "DB Host",
            type: "short" as const,
            sensitive: false,
            placeholder: "db.example.com",
          },
        ]),
      },
    }) as ClawhubPluginManifest;
    const modal = buildPluginConfigModal(manifest, "n");
    const input = (modal.toJSON().components[0] as unknown as {
      components: ReadonlyArray<{ placeholder?: string }>;
    }).components[0];
    expect(input.placeholder).toBe("db.example.com");
  });
});

describe("parseModalSubmit (CM-M4)", () => {
  it("CM-M4: extracts all field values by custom_id", () => {
    const manifest = makeManifest(3);
    const values = new Map<string, string>([
      ["field:FIELD_0", "value-0"],
      ["field:FIELD_1", "value-1"],
      ["field:FIELD_2", "value-2"],
    ]);
    const submitStub = {
      fields: {
        getTextInputValue: (id: string) => {
          const v = values.get(id);
          if (v === undefined) throw new Error(`missing: ${id}`);
          return v;
        },
      },
    };
    const out = parseModalSubmit(
      submitStub as never,
      manifest,
    );
    expect(out).toEqual({
      FIELD_0: "value-0",
      FIELD_1: "value-1",
      FIELD_2: "value-2",
    });
  });
});

describe("buildSerialPromptFlow (CM-SF1)", () => {
  it("CM-SF1: yields N frames in order with step/total metadata", () => {
    const manifest = makeManifest(7);
    const frames = Array.from(buildSerialPromptFlow(manifest));
    expect(frames).toHaveLength(7);
    expect(frames[0]).toMatchObject({ step: 1, total: 7 });
    expect(frames[0].field.name).toBe("FIELD_0");
    expect(frames[6]).toMatchObject({ step: 7, total: 7 });
    expect(frames[6].field.name).toBe("FIELD_6");
  });

  it("yields zero frames when manifest has no config.fields", () => {
    const manifest = Object.freeze({
      name: "plugin",
      description: "",
      version: "1.0",
      command: "noop",
      args: [],
      env: {},
    }) as ClawhubPluginManifest;
    expect(Array.from(buildSerialPromptFlow(manifest))).toEqual([]);
  });
});
