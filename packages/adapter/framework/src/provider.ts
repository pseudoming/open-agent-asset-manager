/** Authenticated functional construction for final AdapterProvider objects. */

import type { AdapterProvider, AssetKind } from "@oaam/core";
import { coordinateSourceRead, type SourceReadCoordinatorHooks } from "./source-coordinator";
import type { SourceCandidateBuilder, SourceContextBase, SourceScanResultBase } from "./source-model";
import { defineAssetReaderRegistry, type AssetReaderRegistry } from "./source-registry";
import { createTargetCoordinator } from "./target-coordinator";
import type { AdapterFrameworkTargetDefinition } from "./target-model";

export type AdapterFrameworkSourceReadDefinition<
    Context extends SourceContextBase<string, object>,
    Scan extends SourceScanResultBase,
> = Omit<SourceReadCoordinatorHooks<Context, Scan>, "getReader"> & {
    registry: AssetReaderRegistry<SourceCandidateBuilder<Context, Scan>>;
};

type AdapterFrameworkProviderDefinitionBase<
    Context extends SourceContextBase<string, object>,
    Scan extends SourceScanResultBase,
> = Omit<AdapterProvider, "read" | "analyzeRender" | "materializeRender" | "inspectRenderedTarget"> & {
    sourceRead: AdapterFrameworkSourceReadDefinition<Context, Scan>;
    targetRender: AdapterFrameworkTargetDefinition;
};

export type AdapterFrameworkProviderDefinition<
    Context extends SourceContextBase<string, object>,
    Scan extends SourceScanResultBase,
> = AdapterFrameworkProviderDefinitionBase<Context, Scan>;

const AUTHENTIC_PROVIDERS = new WeakSet<object>();
const AUTHENTIC_READ_HANDLERS = new WeakSet<object>();
const AUTHENTIC_TARGET_HANDLERS = new WeakSet<object>();

export function defineAdapterProvider<Context extends SourceContextBase<string, object>, Scan extends SourceScanResultBase>(
    definition: AdapterFrameworkProviderDefinition<Context, Scan>,
): AdapterProvider {
    if ("read" in definition) {
        throw new Error("adapter framework owns the final Provider read handler");
    }
    if (!("targetRender" in definition) || definition.targetRender === undefined) {
        throw new Error("adapter framework requires one explicit targetRender definition");
    }
    for (const key of ["analyzeRender", "materializeRender", "inspectRenderedTarget"] as const) {
        if (key in definition) throw new Error("adapter framework owns final Provider target handlers");
    }

    const { sourceRead, targetRender, ...providerDefinition } = definition;
    const registry = defineAssetReaderRegistry(sourceRead.registry);
    const hooks = deepFreeze({
        getReader: (kind: AssetKind) => registry[kind],
        resolveContext: sourceRead.resolveContext,
        scan: sourceRead.scan,
        candidateIdentityConflict: sourceRead.candidateIdentityConflict,
        diagnostics: sourceRead.diagnostics,
    }) satisfies SourceReadCoordinatorHooks<Context, Scan>;
    const read: AdapterProvider["read"] = (input) =>
        coordinateSourceRead(input, providerDefinition.assetSourceCapabilities, hooks);
    const coordinatedTarget = createTargetCoordinator({
        adapterId: providerDefinition.adapterId,
        adapterVersion: providerDefinition.version,
        assetTargetCapabilities: providerDefinition.assetTargetCapabilities,
        materializerCapabilities: providerDefinition.materializerCapabilities,
        targetRender,
    });
    const provider = { ...providerDefinition, read, ...coordinatedTarget } as AdapterProvider;

    deepFreeze(provider);
    AUTHENTIC_READ_HANDLERS.add(read);
    AUTHENTIC_TARGET_HANDLERS.add(coordinatedTarget.analyzeRender);
    AUTHENTIC_TARGET_HANDLERS.add(coordinatedTarget.materializeRender);
    AUTHENTIC_TARGET_HANDLERS.add(coordinatedTarget.inspectRenderedTarget);
    AUTHENTIC_PROVIDERS.add(provider);
    return provider;
}

export function isAdapterFrameworkProvider(value: unknown): value is AdapterProvider {
    return isObject(value) && AUTHENTIC_PROVIDERS.has(value);
}

export function isAdapterFrameworkReadHandler(value: unknown): value is AdapterProvider["read"] {
    return isObject(value) && AUTHENTIC_READ_HANDLERS.has(value);
}

export function isAdapterFrameworkTargetHandler(
    value: unknown,
): value is AdapterProvider["analyzeRender"] | AdapterProvider["materializeRender"] | AdapterProvider["inspectRenderedTarget"] {
    return isObject(value) && AUTHENTIC_TARGET_HANDLERS.has(value);
}

function deepFreeze<T>(value: T): T {
    if (!isObject(value) || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function isObject(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}
