/** Small internal strict-JSON schema runner used by additive V2 validators. */

import { isStrictObject } from "./validators";

export type StrictSchema =
    | {
          kind: "string";
          nonBlank?: boolean;
          allowed?: readonly string[];
      }
    | {
          kind: "number";
          integer?: boolean;
          min?: number;
          max?: number;
      }
    | { kind: "boolean" }
    | { kind: "literal"; value: string | number | boolean }
    | {
          kind: "array";
          element: StrictSchema;
          minLength?: number;
          uniqueBy?: (value: unknown) => string;
      }
    | { kind: "record"; value: StrictSchema }
    | { kind: "object"; fields: Readonly<Record<string, StrictSchema>> }
    | { kind: "union"; variants: readonly StrictSchema[] }
    | { kind: "custom"; check: (value: unknown) => boolean };

export function schemaLiteral(value: string | number | boolean): StrictSchema {
    return { kind: "literal", value };
}

export function schemaStringEnum(...allowed: string[]): StrictSchema {
    return { kind: "string", allowed };
}

export function schemaObject(fields: Readonly<Record<string, StrictSchema>>): StrictSchema {
    return { kind: "object", fields };
}

export function schemaUnion(...variants: StrictSchema[]): StrictSchema {
    return { kind: "union", variants };
}

/** Preserve the option-object construction used by AssetKind schemas. */
export function schemaArrayWithOptions(
    element: StrictSchema,
    options: { minLength?: number; uniqueBy?: (value: unknown) => string },
): StrictSchema {
    return { kind: "array", element, ...options };
}

/** Preserve the explicit `uniqueBy: undefined` shape used by Version schemas. */
export function schemaArrayWithUniqueKey(element: StrictSchema, uniqueBy?: (value: unknown) => string): StrictSchema {
    return { kind: "array", element, uniqueBy };
}

export function validateStrict(schema: StrictSchema, value: unknown): boolean {
    switch (schema.kind) {
        case "string":
            return (
                typeof value === "string" &&
                (!schema.nonBlank || value.trim().length > 0) &&
                (schema.allowed === undefined || schema.allowed.includes(value))
            );
        case "number":
            return (
                typeof value === "number" &&
                Number.isFinite(value) &&
                (!schema.integer || Number.isInteger(value)) &&
                (schema.min === undefined || value >= schema.min) &&
                (schema.max === undefined || value <= schema.max)
            );
        case "boolean":
            return typeof value === "boolean";
        case "literal":
            return value === schema.value;
        case "array": {
            if (!Array.isArray(value) || (schema.minLength !== undefined && value.length < schema.minLength)) {
                return false;
            }
            if (!value.every((item) => validateStrict(schema.element, item))) return false;
            if (schema.uniqueBy === undefined) return true;
            return new Set(value.map(schema.uniqueBy)).size === value.length;
        }
        case "record":
            return isStrictObject(value) && Object.values(value).every((item) => validateStrict(schema.value, item));
        case "object": {
            if (!isStrictObject(value)) return false;
            const entries = Object.entries(schema.fields);
            return (
                Object.keys(value).length === entries.length &&
                entries.every(([key, fieldSchema]) => Object.hasOwn(value, key) && validateStrict(fieldSchema, value[key]))
            );
        }
        case "union":
            return schema.variants.some((variant) => validateStrict(variant, value));
        case "custom":
            return schema.check(value);
    }
}
