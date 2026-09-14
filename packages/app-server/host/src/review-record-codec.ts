import * as crypto from "node:crypto";

export type HostReviewRecordKind =
    | "probe"
    | "read"
    | "import_preview"
    | "render_preview"
    | "rendered_inspection"
    | "state_backup"
    | "state_restore"
    | "support_bundle"
    | "project_lifecycle";

type EncodedNode =
    | { readonly type: "null" }
    | { readonly type: "boolean"; readonly value: boolean }
    | { readonly type: "number"; readonly value: number }
    | { readonly type: "string"; readonly value: string }
    | { readonly type: "bytes"; readonly value: string }
    | { readonly type: "array"; readonly value: readonly EncodedNode[] }
    | { readonly type: "object"; readonly value: readonly (readonly [string, EncodedNode])[] };

interface EncodedEnvelope {
    readonly schemaVersion: 1;
    readonly recordKind: HostReviewRecordKind;
    readonly payloadFingerprint: string;
    readonly payload: EncodedNode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function encodeNode(value: unknown): EncodedNode {
    if (value === null) return { type: "null" };
    if (typeof value === "boolean") return { type: "boolean", value };
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("review record numbers must be finite");
        return { type: "number", value };
    }
    if (typeof value === "string") return { type: "string", value };
    if (value instanceof Uint8Array) return { type: "bytes", value: Buffer.from(value).toString("base64") };
    if (Array.isArray(value)) return { type: "array", value: value.map(encodeNode) };
    if (isRecord(value)) {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("review record objects must use a plain prototype");
        }
        return {
            type: "object",
            value: Object.keys(value)
                .sort()
                .map((key) => [key, encodeNode(value[key])] as const),
        };
    }
    throw new TypeError(`review record contains unsupported ${typeof value}`);
}

function decodeNode(value: unknown): unknown {
    if (!isRecord(value) || typeof value.type !== "string") throw new TypeError("encoded review node is invalid");
    switch (value.type) {
        case "null":
            if (!hasExactKeys(value, ["type"])) throw new TypeError("encoded null node is not strict");
            return null;
        case "boolean":
            if (!hasExactKeys(value, ["type", "value"]) || typeof value.value !== "boolean") {
                throw new TypeError("encoded boolean node is invalid");
            }
            return value.value;
        case "number":
            if (!hasExactKeys(value, ["type", "value"]) || typeof value.value !== "number" || !Number.isFinite(value.value)) {
                throw new TypeError("encoded number node is invalid");
            }
            return value.value;
        case "string":
            if (!hasExactKeys(value, ["type", "value"]) || typeof value.value !== "string") {
                throw new TypeError("encoded string node is invalid");
            }
            return value.value;
        case "bytes": {
            if (!hasExactKeys(value, ["type", "value"]) || typeof value.value !== "string") {
                throw new TypeError("encoded byte node is invalid");
            }
            const bytes = Buffer.from(value.value, "base64");
            if (bytes.toString("base64") !== value.value) throw new TypeError("encoded byte node is not canonical base64");
            return new Uint8Array(bytes);
        }
        case "array":
            if (!hasExactKeys(value, ["type", "value"]) || !Array.isArray(value.value)) {
                throw new TypeError("encoded array node is invalid");
            }
            return value.value.map(decodeNode);
        case "object": {
            if (!hasExactKeys(value, ["type", "value"]) || !Array.isArray(value.value)) {
                throw new TypeError("encoded object node is invalid");
            }
            const result: Record<string, unknown> = {};
            let previousKey: string | undefined;
            for (const entry of value.value) {
                if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
                    throw new TypeError("encoded object entry is invalid");
                }
                if (previousKey !== undefined && entry[0] <= previousKey) {
                    throw new TypeError("encoded object keys must be sorted and unique");
                }
                previousKey = entry[0];
                Object.defineProperty(result, entry[0], {
                    configurable: true,
                    enumerable: true,
                    value: decodeNode(entry[1]),
                    writable: true,
                });
            }
            return result;
        }
        default:
            throw new TypeError("encoded review node type is unknown");
    }
}

function fingerprint(node: unknown): string {
    return crypto.createHash("sha256").update(JSON.stringify(node), "utf8").digest("hex");
}

export function encodeReviewRecord(kind: HostReviewRecordKind, payload: unknown): Uint8Array {
    const encodedPayload = encodeNode(payload);
    const envelope: EncodedEnvelope = {
        schemaVersion: 1,
        recordKind: kind,
        payloadFingerprint: fingerprint(encodedPayload),
        payload: encodedPayload,
    };
    return new TextEncoder().encode(JSON.stringify(envelope));
}

export function decodeReviewRecord(bytes: Uint8Array, expectedKind: HostReviewRecordKind): unknown {
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
        throw new TypeError("review record is not strict UTF-8 JSON");
    }
    if (
        !isRecord(parsed) ||
        !hasExactKeys(parsed, ["schemaVersion", "recordKind", "payloadFingerprint", "payload"]) ||
        parsed.schemaVersion !== 1 ||
        parsed.recordKind !== expectedKind ||
        typeof parsed.payloadFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/u.test(parsed.payloadFingerprint) ||
        parsed.payloadFingerprint !== fingerprint(parsed.payload)
    ) {
        throw new TypeError("review record envelope is invalid");
    }
    return decodeNode(parsed.payload);
}
