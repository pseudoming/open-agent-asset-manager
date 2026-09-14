export class ProtocolValidationError extends Error {
    public readonly path: string;

    public constructor(path: string, message: string) {
        super(`${path}: ${message}`);
        this.name = "ProtocolValidationError";
        this.path = path;
    }
}

export interface ProtocolSchema<T> {
    readonly description: string;
    parse(value: unknown, path?: string): T;
}

export type InferProtocolSchema<TSchema> = TSchema extends ProtocolSchema<infer TValue> ? TValue : never;

type ProtocolShape = Readonly<Record<string, ProtocolSchema<unknown> | OptionalProtocolField<unknown>>>;

interface OptionalProtocolField<T> {
    readonly optional: true;
    readonly schema: ProtocolSchema<T>;
}

type InferProtocolShape<TShape extends ProtocolShape> = {
    readonly [TKey in keyof TShape as TShape[TKey] extends OptionalProtocolField<unknown>
        ? never
        : TKey]: TShape[TKey] extends ProtocolSchema<infer TValue> ? TValue : never;
} & {
    readonly [TKey in keyof TShape as TShape[TKey] extends OptionalProtocolField<unknown>
        ? TKey
        : never]?: TShape[TKey] extends OptionalProtocolField<infer TValue> ? TValue : never;
};

function schema<T>(description: string, parse: (value: unknown, path: string) => T): ProtocolSchema<T> {
    return Object.freeze({
        description,
        parse(value: unknown, path = "$"): T {
            return parse(value, path);
        },
    });
}

function fail(path: string, message: string): never {
    throw new ProtocolValidationError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalProtocolField<T>(fieldSchema: ProtocolSchema<T>): OptionalProtocolField<T> {
    return Object.freeze({ optional: true, schema: fieldSchema });
}

export const protocolString = schema("string", (value, path) =>
    typeof value === "string" ? value : fail(path, "expected string"),
);

export const protocolNonBlankString = schema("non-blank string", (value, path) => {
    const parsed = protocolString.parse(value, path);
    return parsed.length > 0 && parsed.trim() === parsed ? parsed : fail(path, "expected non-blank trimmed string");
});

export const protocolBoolean = schema("boolean", (value, path) =>
    typeof value === "boolean" ? value : fail(path, "expected boolean"),
);

export const protocolNonNegativeInteger = schema("non-negative integer", (value, path) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : fail(path, "expected non-negative safe integer"),
);

export const protocolPositiveInteger = schema("positive integer", (value, path) => {
    const parsed = protocolNonNegativeInteger.parse(value, path);
    return parsed > 0 ? parsed : fail(path, "expected positive safe integer");
});

export function protocolLiteral<const TValue extends string | number | boolean | null>(expected: TValue): ProtocolSchema<TValue> {
    return schema(JSON.stringify(expected), (value, path) =>
        value === expected ? expected : fail(path, `expected ${JSON.stringify(expected)}`),
    );
}

export function protocolEnum<const TValues extends readonly [string, ...string[]]>(
    values: TValues,
): ProtocolSchema<TValues[number]> {
    const accepted = new Set<string>(values);
    return schema(`one of ${values.join(", ")}`, (value, path) =>
        typeof value === "string" && accepted.has(value)
            ? (value as TValues[number])
            : fail(path, `expected one of ${values.join(", ")}`),
    );
}

export function protocolArray<T>(itemSchema: ProtocolSchema<T>): ProtocolSchema<readonly T[]> {
    return schema(`array of ${itemSchema.description}`, (value, path) => {
        if (!Array.isArray(value)) fail(path, "expected array");
        return Object.freeze(value.map((item, index) => itemSchema.parse(item, `${path}[${index}]`)));
    });
}

export function protocolNonEmptyArray<T>(itemSchema: ProtocolSchema<T>): ProtocolSchema<readonly [T, ...T[]]> {
    return schema(`non-empty array of ${itemSchema.description}`, (value, path) => {
        const parsed = protocolArray(itemSchema).parse(value, path);
        return parsed.length > 0 ? (parsed as readonly [T, ...T[]]) : fail(path, "expected non-empty array");
    });
}

export const protocolEmptyArraySchema: ProtocolSchema<readonly never[]> = schema("empty array", (value, path) =>
    Array.isArray(value) && value.length === 0 ? Object.freeze([]) : fail(path, "expected empty array"),
);

export function protocolObject<const TShape extends ProtocolShape>(
    shape: TShape,
    description = "strict object",
): ProtocolSchema<Readonly<InferProtocolShape<TShape>>> {
    const keys = Object.freeze(Object.keys(shape));
    const allowed = new Set(keys);
    return schema(description, (value, path) => {
        if (!isRecord(value)) fail(path, "expected object");
        for (const key of Object.keys(value)) {
            if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
        }
        const parsed: Record<string, unknown> = {};
        for (const key of keys) {
            const field = shape[key];
            if (field === undefined) fail(path, `schema is missing field ${key}`);
            if ("optional" in field) {
                if (Object.hasOwn(value, key)) parsed[key] = field.schema.parse(value[key], `${path}.${key}`);
            } else {
                if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "missing required field");
                parsed[key] = field.parse(value[key], `${path}.${key}`);
            }
        }
        return Object.freeze(parsed) as Readonly<InferProtocolShape<TShape>>;
    });
}

export function protocolUnion<const TSchemas extends readonly [ProtocolSchema<unknown>, ...ProtocolSchema<unknown>[]]>(
    schemas: TSchemas,
    description = "union",
): ProtocolSchema<InferProtocolSchema<TSchemas[number]>> {
    return schema(description, (value, path) => {
        const errors: string[] = [];
        for (const candidate of schemas) {
            try {
                return candidate.parse(value, path) as InferProtocolSchema<TSchemas[number]>;
            } catch (error) {
                if (!(error instanceof ProtocolValidationError)) throw error;
                errors.push(error.message);
            }
        }
        return fail(path, `${description} did not match any branch: ${errors.join(" | ")}`);
    });
}

export const protocolJsonValue: ProtocolSchema<ProtocolJsonValue> = schema("JSON value", (value, path) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : fail(path, "expected finite JSON number");
    if (Array.isArray(value)) {
        return Object.freeze(value.map((item, index) => protocolJsonValue.parse(item, `${path}[${index}]`)));
    }
    if (isRecord(value)) {
        const parsed: Record<string, ProtocolJsonValue> = {};
        for (const [key, item] of Object.entries(value)) parsed[key] = protocolJsonValue.parse(item, `${path}.${key}`);
        return Object.freeze(parsed);
    }
    return fail(path, "expected JSON value");
});

export type ProtocolJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ProtocolJsonValue[]
    | { readonly [key: string]: ProtocolJsonValue };
