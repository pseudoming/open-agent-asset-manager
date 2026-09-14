/** Narrow deterministic helpers shared by source-read validators. */

import type {
    AdapterExtractedAssetCandidate,
    CoreResult,
    ManagedTargetReadGuard,
    ObservedReadEntry,
    OperationDiagnostic,
    Sha256Digest,
    SourceReadObligation,
    SourceRoot,
} from "../types";
import { stableStringify } from "../foundation/fingerprint";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { compareCodeUnitText } from "../foundation/text-order";

export { compareCodeUnitText } from "../foundation/text-order";

export function candidateFileHash(file: AdapterExtractedAssetCandidate["files"][number]): Sha256Digest {
    return sha256Bytes(file.contentKind === "text" ? Buffer.from(file.text, "utf-8") : file.bytes);
}

export function failedResult<T>(diagnostics: OperationDiagnostic[]): CoreResult<T> {
    return { status: "failed", value: undefined as T, diagnostics };
}

export function uniqueMap<T>(
    values: readonly T[],
    keyOf: (value: T) => string,
    code: string,
    diagnostics: OperationDiagnostic[],
): Map<string, T> {
    const result = new Map<string, T>();
    for (const value of values) {
        const key = keyOf(value);
        if (result.has(key)) diagnostics.push(sourceDiagnostic(code, `duplicate identifier: ${key}`));
        result.set(key, value);
    }
    return result;
}

export function sameStringSet(left: Iterable<string>, right: Iterable<string>): boolean {
    const a = [...new Set(left)].sort(compareCodeUnitText);
    const b = [...new Set(right)].sort(compareCodeUnitText);
    return stableStringify(a) === stableStringify(b);
}

export function isSortedUnique(values: readonly string[]): boolean {
    return stableStringify(values) === stableStringify([...new Set(values)].sort(compareCodeUnitText));
}

export function compareRoot(left: SourceRoot, right: SourceRoot): number {
    return compareCodeUnitText(left.sourceRootId, right.sourceRootId);
}

export function compareGuard(left: ManagedTargetReadGuard, right: ManagedTargetReadGuard): number {
    return compareCodeUnitText(stableStringify(left), stableStringify(right));
}

export function compareObligation(left: SourceReadObligation, right: SourceReadObligation): number {
    return compareCodeUnitText(left.sourceReadObligationId, right.sourceReadObligationId);
}

export function compareObservedEntry(left: ObservedReadEntry, right: ObservedReadEntry): number {
    const root = compareCodeUnitText(left.sourceRootId, right.sourceRootId);
    if (root !== 0) return root;
    const pathOrder = compareCodeUnitText(left.relativePath, right.relativePath);
    return pathOrder === 0 ? compareCodeUnitText(left.entryKind, right.entryKind) : pathOrder;
}

export function sourceDiagnostic(code: string, message: string): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message,
        path: "",
        traceId: "",
        operation: "read",
        causeKind: code === "read.candidate_type_data_invalid" ? "invalid_schema" : "verification_failed",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
