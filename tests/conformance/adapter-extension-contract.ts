/** Reusable test authority for one adapter family's public extension surface. */

import type { AdapterProvider, AssetKind } from "../../packages/core/src/types";
import { BUILTIN_ASSET_KINDS } from "../../packages/core/src/specs/registry";
import {
    isAdapterFrameworkProvider,
    isAdapterFrameworkReadHandler,
    isAdapterFrameworkTargetHandler,
} from "@oaam/adapter-framework";

export interface ExtensionReaderDisposition {
    readonly disposition: "reader" | "unsupported" | "deferred";
    readonly buildCandidates?: unknown;
    readonly diagnosticCode?: unknown;
    readonly message?: unknown;
}

export interface AdapterExtensionContractInput {
    provider: AdapterProvider;
    sourceReaderRegistry: Readonly<Record<AssetKind, unknown>>;
}

/**
 * Return stable, human-readable violations instead of throwing so every real
 * and synthetic family is checked by the exact same conformance logic.
 */
export function inspectAdapterExtensionContract(input: AdapterExtensionContractInput): string[] {
    const { provider, sourceReaderRegistry } = input;
    const violations: string[] = [];
    const registryKinds = Object.keys(sourceReaderRegistry).sort();
    const expectedKinds = [...BUILTIN_ASSET_KINDS].sort();

    if (!isAdapterFrameworkProvider(provider)) {
        violations.push("Provider was not constructed by adapter-framework");
    }
    if (!isAdapterFrameworkReadHandler(provider.read)) {
        violations.push("Provider read handler is not the adapter-framework-owned function");
    }
    for (const [name, handler] of [
        ["analyzeRender", provider.analyzeRender],
        ["materializeRender", provider.materializeRender],
        ["inspectRenderedTarget", provider.inspectRenderedTarget],
    ] as const) {
        if (!isAdapterFrameworkTargetHandler(handler)) {
            violations.push(`Provider ${name} handler is not the adapter-framework-owned function`);
        }
    }
    if (!Object.isFrozen(provider)) {
        violations.push("Provider is not frozen");
    }
    if (!Object.isFrozen(sourceReaderRegistry)) {
        violations.push("source reader registry is not frozen");
    }
    if (!sameStrings(registryKinds, expectedKinds)) {
        violations.push("source reader registry does not answer every AssetKind exactly once");
    }

    for (const kind of BUILTIN_ASSET_KINDS) {
        const disposition = sourceReaderRegistry[kind] as ExtensionReaderDisposition | undefined;
        if (disposition === undefined || !Object.isFrozen(disposition)) {
            violations.push(`${kind}: source reader disposition is missing or mutable`);
            continue;
        }
        if (
            disposition.disposition !== "reader" &&
            disposition.disposition !== "unsupported" &&
            disposition.disposition !== "deferred"
        ) {
            violations.push(`${kind}: source reader disposition is unknown`);
            continue;
        }

        const sourceRows = provider.assetSourceCapabilities.filter((row) => row.assetKind === kind);
        const callable = sourceRows.some((row) => row.entrySupportStatus === "supported" && row.readPolicy !== "report_only");
        if (disposition.disposition === "reader") {
            if (typeof disposition.buildCandidates !== "function") {
                violations.push(`${kind}: reader disposition is not callable`);
            }
            if (!callable) {
                violations.push(`${kind}: reader has no callable static source capability`);
            }
        } else {
            if (callable) {
                violations.push(`${kind}: callable source capability has no reader`);
            }
            if (
                typeof disposition.diagnosticCode !== "string" ||
                disposition.diagnosticCode.trim() === "" ||
                typeof disposition.message !== "string" ||
                disposition.message.trim() === ""
            ) {
                violations.push(`${kind}: unavailable reader disposition lacks diagnostics`);
            }
            if (
                sourceRows.some(
                    (row) =>
                        row.entrySupportStatus === "supported" ||
                        row.readPolicy !== "report_only" ||
                        row.diagnostics.length === 0,
                )
            ) {
                violations.push(`${kind}: unavailable reader disagrees with static source rows`);
            }
        }
        if (callable && !provider.dialectContracts.native.some((contract) => contract.definition.kind === kind)) {
            violations.push(`${kind}: callable source kind lacks a native dialect contract`);
        }
    }

    const runtimeIds = new Set(provider.agentRuntimes.map((descriptor) => descriptor.agentRuntimeId));
    for (const row of provider.assetSourceCapabilities) {
        if (!runtimeIds.has(row.agentRuntimeId)) {
            violations.push(`${row.assetKind}: source row names foreign runtime`);
        }
    }
    for (const row of provider.assetTargetCapabilities) {
        if (!runtimeIds.has(row.agentRuntimeId)) {
            violations.push(`${row.assetKind}: target row names foreign runtime`);
        }
    }
    for (const descriptor of provider.agentRuntimes) {
        for (const kind of BUILTIN_ASSET_KINDS) {
            const sourceRows = provider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === descriptor.agentRuntimeId && row.assetKind === kind,
            );
            const targetRows = provider.assetTargetCapabilities.filter(
                (row) => row.agentRuntimeId === descriptor.agentRuntimeId && row.assetKind === kind,
            );
            if (sourceRows.length === 0) {
                violations.push(`${descriptor.agentRuntimeId}/${kind}: source cell is missing`);
            }
            if (targetRows.length === 0) {
                violations.push(`${descriptor.agentRuntimeId}/${kind}: target cell is missing`);
                continue;
            }
            if (
                targetRows.some((row) => row.entrySupportStatus === "unsupported" || row.entrySupportStatus === "deferred") &&
                targetRows.length !== 1
            ) {
                violations.push(`${descriptor.agentRuntimeId}/${kind}: unavailable target cell is not exclusive`);
                continue;
            }
            const variantKeys = targetRows.map((row) =>
                "renderStrategy" in row
                    ? JSON.stringify([row.renderStrategy, row.outputContractId, row.outputContractFingerprint])
                    : row.entrySupportStatus,
            );
            if (new Set(variantKeys).size !== variantKeys.length) {
                violations.push(`${descriptor.agentRuntimeId}/${kind}: target variant is duplicated`);
            }
        }
    }

    return violations.sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
