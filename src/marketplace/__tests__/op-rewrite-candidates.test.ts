/**
 * Phase 90 Plan 06 HUB-05 — buildOpRewriteCandidates integration tests
 * (INS-OR1, INS-OR2).
 *
 * Pins:
 *   INS-OR1 buildOpRewriteCandidates produces proposals for sensitive fields;
 *           configInputs left unchanged (operator confirmation required).
 *   INS-OR2 Skips fields that are already op:// references.
 */
import { describe, it, expect, vi } from "vitest";
import { buildOpRewriteCandidates } from "../install-plugin.js";
import type { ClawhubPluginManifest } from "../clawhub-client.js";
import * as opRewriteMod from "../op-rewrite.js";

const manifest: ClawhubPluginManifest = Object.freeze({
  name: "db-plugin",
  description: "",
  version: "1.0",
  command: "noop",
  args: [],
  env: {
    DB_HOST: {
      default: null,
      required: true,
      sensitive: false,
    },
    DB_PASSWORD: {
      default: null,
      required: true,
      sensitive: true,
    },
  },
  config: {
    fields: Object.freeze([
      {
        name: "DB_HOST",
        label: "DB Host",
        type: "short",
        sensitive: false,
      },
      {
        name: "DB_PASSWORD",
        label: "MySQL Password",
        type: "short",
        sensitive: true,
      },
    ]),
  },
}) as ClawhubPluginManifest;

describe("buildOpRewriteCandidates (INS-OR1, INS-OR2)", () => {
  it("INS-OR1: proposes op:// URIs for sensitive fields with 1P matches", async () => {
    const listSpy = vi
      .spyOn(opRewriteMod, "listOpItems")
      .mockResolvedValue(
        Object.freeze([
          Object.freeze({
            uuid: "u-1",
            title: "MySQL DB - Unraid",
            category: "Credential",
          }),
        ]),
      );

    const configInputs = { DB_HOST: "db.local", DB_PASSWORD: "literal-pw" };
    const candidates = await buildOpRewriteCandidates(manifest, configInputs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].fieldName).toBe("DB_PASSWORD");
    expect(candidates[0].proposal.uri).toBe(
      "op://example-vault-21/MySQL DB - Unraid/password",
    );
    expect(candidates[0].typedValue).toBe("literal-pw");
    listSpy.mockRestore();
  });

  it("INS-OR2: skips fields already set to op:// references", async () => {
    const listSpy = vi
      .spyOn(opRewriteMod, "listOpItems")
      .mockResolvedValue(
        Object.freeze([
          Object.freeze({
            uuid: "u-1",
            title: "MySQL DB - Unraid",
            category: "Credential",
          }),
        ]),
      );

    const configInputs = {
      DB_HOST: "db.local",
      DB_PASSWORD: "op://example-vault-21/Something/password",
    };
    const candidates = await buildOpRewriteCandidates(manifest, configInputs);
    expect(candidates).toEqual([]);
    listSpy.mockRestore();
  });

  it("returns empty when 1P vault is unavailable", async () => {
    const listSpy = vi
      .spyOn(opRewriteMod, "listOpItems")
      .mockResolvedValue(Object.freeze([]));
    const candidates = await buildOpRewriteCandidates(manifest, {
      DB_PASSWORD: "literal",
    });
    expect(candidates).toEqual([]);
    listSpy.mockRestore();
  });

  it("returns empty when no sensitive fields have matches", async () => {
    const listSpy = vi
      .spyOn(opRewriteMod, "listOpItems")
      .mockResolvedValue(
        Object.freeze([
          Object.freeze({
            uuid: "u-1",
            title: "Unrelated Credential",
            category: "Credential",
          }),
        ]),
      );
    const candidates = await buildOpRewriteCandidates(manifest, {
      DB_PASSWORD: "literal-pw",
    });
    expect(candidates).toEqual([]);
    listSpy.mockRestore();
  });
});
