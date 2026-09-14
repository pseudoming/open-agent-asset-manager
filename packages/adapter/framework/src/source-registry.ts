/** Exhaustive AssetKind registry with no default reader or successful fallback. */

import { BUILTIN_ASSET_KINDS, type AssetKind } from "@oaam/core/adapter-spi";

export type SourceReaderDisposition<Builder> = Readonly<{
    disposition: "reader";
    buildCandidates: Builder;
}>;

export type SourceUnavailableDisposition = Readonly<{
    disposition: "unsupported" | "deferred";
    diagnosticCode: string;
    message: string;
}>;

export type AssetReaderDisposition<Builder> = SourceReaderDisposition<Builder> | SourceUnavailableDisposition;

export type AssetReaderRegistry<Builder> = Readonly<Record<AssetKind, AssetReaderDisposition<Builder>>>;

export function sourceReader<Builder>(buildCandidates: Builder): SourceReaderDisposition<Builder> {
    if (typeof buildCandidates !== "function") {
        throw new Error("source reader must be a callable candidate builder");
    }
    return Object.freeze({ disposition: "reader", buildCandidates });
}

export function sourceUnavailable(
    disposition: "unsupported" | "deferred",
    diagnosticCode: string,
    message: string,
): SourceUnavailableDisposition {
    if (!isNonBlank(diagnosticCode) || !isNonBlank(message)) {
        throw new Error("unavailable source disposition requires diagnosticCode and message");
    }
    return Object.freeze({ disposition, diagnosticCode, message });
}

export function defineAssetReaderRegistry<const Registry extends Record<AssetKind, AssetReaderDisposition<unknown>>>(
    input: Registry,
): Readonly<Registry> {
    if (!isRecord(input)) throw new Error("asset reader registry must be an object");
    const actualKeys = Object.keys(input).sort();
    const expectedKeys = [...BUILTIN_ASSET_KINDS].sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error("asset reader registry must answer every AssetKind exactly once");
    }

    const entries = BUILTIN_ASSET_KINDS.map((kind) => {
        const row: unknown = input[kind];
        if (!isRecord(row)) throw new Error(`asset reader disposition is invalid: ${kind}`);
        if (row.disposition === "reader") {
            if (typeof row.buildCandidates !== "function") {
                throw new Error(`asset reader is not callable: ${kind}`);
            }
            return [kind, Object.freeze({ ...row })] as const;
        }
        if (row.disposition === "unsupported" || row.disposition === "deferred") {
            if (!isNonBlank(row.diagnosticCode) || !isNonBlank(row.message)) {
                throw new Error(`asset reader unavailable disposition is incomplete: ${kind}`);
            }
            return [kind, Object.freeze({ ...row })] as const;
        }
        throw new Error(`asset reader disposition is unknown: ${kind}`);
    });
    return Object.freeze(Object.fromEntries(entries)) as Readonly<Registry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
