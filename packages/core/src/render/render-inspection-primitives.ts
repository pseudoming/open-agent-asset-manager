/** Render-inspection content, collection, and failure validation primitives. */

import { binaryPayloadStats, textPayloadStats } from "../catalog/payload-store";
import type { CoreResult, OperationDiagnostic, Sha256Digest } from "../types";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";

export function contentHash(
    content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array },
): Sha256Digest {
    return content.contentKind === "text"
        ? textPayloadStats(content.text).contentHash
        : binaryPayloadStats(content.bytes).contentHash;
}

export function contentByteLength(
    content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array },
): number {
    return content.contentKind === "text" ? Buffer.byteLength(content.text) : content.bytes.byteLength;
}

export function requireHashes(values: readonly string[]): void {
    if (values.some((value) => !isSha256Digest(value))) {
        throw new InspectionFailure("render.inspection_hash_invalid", "inspection state contains a malformed hash");
    }
}

export function requireSortedUniqueHashes(values: readonly string[], label: string): void {
    if (
        values.some((value) => !isSha256Digest(value)) ||
        new Set(values).size !== values.length ||
        stableStringify([...values].sort(compareUtf8Bytes)) !== stableStringify(values)
    ) {
        throw new InspectionFailure(
            "render.inspection_collection_invalid",
            `${label} must be canonical sorted-unique SHA-256 values`,
        );
    }
}

export function requireSortedUniquePaths(values: readonly string[], boundary: string): void {
    if (
        values.some((value) => !isCanonicalRelativePath(value) || !isStrictDescendant(value, boundary)) ||
        new Set(values).size !== values.length ||
        stableStringify([...values].sort(compareUtf8Bytes)) !== stableStringify(values)
    ) {
        throw new InspectionFailure(
            "render.inspection_inventory_paths_invalid",
            "directory inventory descendants must be sorted unique canonical paths under the boundary",
        );
    }
}

export function isStrictDescendant(relativePath: string, boundary: string): boolean {
    return relativePath.startsWith(`${boundary}/`);
}

export function requireExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
    if (
        new Set(actual).size !== actual.length ||
        new Set(expected).size !== expected.length ||
        stableStringify([...actual].sort(compareUtf8Bytes)) !== stableStringify([...expected].sort(compareUtf8Bytes))
    ) {
        throw new InspectionFailure("render.inspection_closure_mismatch", `${label} is not exact`);
    }
}

export class InspectionFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
        readonly retryable = false,
    ) {
        super(message);
    }
}

export function failedInspectionResult<T>(error: unknown): CoreResult<T> {
    const known = error instanceof InspectionFailure;
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code: known ? error.code : "render.inspection_internal_error",
                message: error instanceof Error ? error.message : String(error),
                operation: "scan",
                causeKind: known ? error.causeKind : "internal_error",
                path: "",
                traceId: "",
                retryable: known ? error.retryable : false,
                suggestedActions: [],
                rawSummary: "",
            },
        ],
    };
}
