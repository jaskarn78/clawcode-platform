/**
 * Phase 59 — JSON-Schema → Zod v4 compiler.
 *
 * Task schemas live at ~/.clawcode/task-schemas/*.yaml with an `input:` and
 * `output:` section each declared in a narrow JSON Schema subset. This module
 * compiles that subset to Zod v4 schemas used by TaskManager (Plan 59-02) for
 * payload validation (HAND-02) and unknown-key rejection (HAND-06).
 *
 * Supported keywords:
 *   - Primitives: string, number, integer, boolean, null
 *   - Compound: object (with required[] + .strict()), array (with items +
 *     min/maxItems), enum, oneOf
 *   - Constraints: minLength, maxLength, minimum, maximum, minItems, maxItems
 *
 * Unsupported (throws ValidationError("unknown_schema", ...) at compile time):
 *   - $ref, allOf, anyOf, not, if/then/else, dependencies
 *   - patternProperties, additionalProperties other than false (effectively
 *     false by virtue of .strict())
 *   - format (date-time etc.), pattern (regex), const outside enum
 *
 * Unknown-keys policy: every object compiles to z.object(shape).strict() —
 * any top-level unknown key is REJECTED. HAND-06 (explicit payload boundary)
 * is NOT optional: this is how the daemon prevents ambient context leakage.
 */

import { z, type ZodTypeAny } from "zod/v4";
import { ValidationError } from "./errors.js";

export type JsonSchema = Readonly<{
  type?: "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";
  enum?: readonly unknown[];
  oneOf?: readonly JsonSchema[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}>;

export function compileJsonSchema(schema: JsonSchema, path = "#"): ZodTypeAny {
  // `enum` wins over `type` (JSON Schema convention: const-list beats declared type).
  if (schema.enum && schema.enum.length > 0) {
    const literals: ZodTypeAny[] = schema.enum.map((v) =>
      z.literal(v as string | number | boolean | null),
    );
    if (literals.length === 1) return literals[0]!;
    return z.union(literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }

  if (schema.oneOf && schema.oneOf.length > 0) {
    const compiled: ZodTypeAny[] = schema.oneOf.map((s, i) =>
      compileJsonSchema(s, `${path}/oneOf/${i}`),
    );
    if (compiled.length === 1) return compiled[0]!;
    return z.union(compiled as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }

  switch (schema.type) {
    case "string": {
      let s: z.ZodString = z.string();
      if (schema.minLength !== undefined) s = s.min(schema.minLength);
      if (schema.maxLength !== undefined) s = s.max(schema.maxLength);
      return s;
    }
    case "integer": {
      let n: z.ZodNumber = z.number().int();
      if (schema.minimum !== undefined) n = n.min(schema.minimum);
      if (schema.maximum !== undefined) n = n.max(schema.maximum);
      return n;
    }
    case "number": {
      let n: z.ZodNumber = z.number();
      if (schema.minimum !== undefined) n = n.min(schema.minimum);
      if (schema.maximum !== undefined) n = n.max(schema.maximum);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      if (!schema.items) {
        throw new ValidationError(
          "unknown_schema",
          `array schema at ${path} missing 'items'`,
          { path },
        );
      }
      let a: z.ZodArray<ZodTypeAny> = z.array(
        compileJsonSchema(schema.items, `${path}/items`),
      );
      if (schema.minItems !== undefined) a = a.min(schema.minItems);
      if (schema.maxItems !== undefined) a = a.max(schema.maxItems);
      return a;
    }
    case "object": {
      const shape: Record<string, ZodTypeAny> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
        const inner = compileJsonSchema(subSchema, `${path}/properties/${key}`);
        shape[key] = required.has(key) ? inner : inner.optional();
      }
      // HAND-06 — reject unknown keys by default.
      return z.object(shape).strict();
    }
    default:
      throw new ValidationError(
        "unknown_schema",
        `unsupported schema type at ${path}: ${schema.type}`,
        { path, type: schema.type },
      );
  }
}
