/** Final target analysis/materialization/inspection dispatch for one Provider. */

import type {
    AdapterAssetTargetCapability,
    AdapterMaterializerCapability,
    AdapterProvider,
    AdapterRenderedTargetInspectionResult,
    AdapterRenderAnalysisResult,
    AssetKind,
    OperationDiagnostic,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
    RenderedTargetInspectionInput,
    RequiredRenderSemantic,
} from "@oaam/core";
import { projectRenderDialectInputs, rebindAdapterRenderAnalysisOptionFingerprints } from "@oaam/core/adapter-spi";
import type {
    AdapterFrameworkTargetDefinition,
    AdapterTargetConsumerHandler,
    AdapterTargetMaterializerHandler,
} from "./target-model";
import { compareCodeUnitText } from "./source-text";

interface TargetCoordinator {
    analyzeRender: AdapterProvider["analyzeRender"];
    materializeRender: AdapterProvider["materializeRender"];
    inspectRenderedTarget: AdapterProvider["inspectRenderedTarget"];
}

export function createTargetCoordinator(input: {
    adapterId: string;
    adapterVersion: string;
    assetTargetCapabilities: readonly AdapterAssetTargetCapability[];
    materializerCapabilities: readonly AdapterMaterializerCapability[];
    targetRender: AdapterFrameworkTargetDefinition;
}): TargetCoordinator {
    const consumers = validateConsumerHandlers(input.assetTargetCapabilities, input.targetRender.consumers);
    const materializers = validateMaterializerHandlers(input.materializerCapabilities, input.targetRender.materializers);
    return {
        analyzeRender: (value) =>
            coordinateAnalysis(value, input.adapterId, input.adapterVersion, input.assetTargetCapabilities, consumers),
        materializeRender: (value) => coordinateMaterialization(value, materializers),
        inspectRenderedTarget: (value) => coordinateInspection(value, materializers),
    };
}

function validateConsumerHandlers(
    capabilities: readonly AdapterAssetTargetCapability[],
    handlers: readonly AdapterTargetConsumerHandler[],
): ReadonlyMap<string, AdapterTargetConsumerHandler> {
    const capabilityCells = new Map<string, AdapterAssetTargetCapability[]>();
    for (const capability of capabilities) {
        const key = cellKey(capability.agentRuntimeId, capability.assetKind);
        const rows = capabilityCells.get(key) ?? [];
        rows.push(capability);
        capabilityCells.set(key, rows);
    }
    for (const rows of capabilityCells.values()) {
        if (
            rows.some((row) => row.entrySupportStatus === "unsupported" || row.entrySupportStatus === "deferred") &&
            rows.length !== 1
        ) {
            throw new Error("adapter unavailable target capability must be exclusive in its cell");
        }
        const variantKeys = rows.map(targetVariantKey);
        if (new Set(variantKeys).size !== variantKeys.length) {
            throw new Error("adapter target capability variant is duplicated");
        }
    }
    const result = new Map<string, AdapterTargetConsumerHandler>();
    for (const handler of handlers) {
        const key = cellKey(handler.agentRuntimeId, handler.assetKind);
        if (result.has(key)) throw new Error("adapter target consumer handler is duplicated");
        const matches = capabilities.filter(
            (capability) =>
                capability.agentRuntimeId === handler.agentRuntimeId &&
                capability.assetKind === handler.assetKind &&
                capability.entrySupportStatus === "supported",
        );
        if (matches.length === 0) throw new Error("adapter target consumer handler has no exact supported capability");
        result.set(key, Object.freeze({ ...handler }));
    }
    const supported = capabilities.filter((capability) => capability.entrySupportStatus === "supported");
    const supportedCells = new Set(supported.map((capability) => cellKey(capability.agentRuntimeId, capability.assetKind)));
    if (
        supportedCells.size !== result.size ||
        supported.some((capability) => !result.has(cellKey(capability.agentRuntimeId, capability.assetKind)))
    ) {
        throw new Error("every supported target capability requires one consumer handler");
    }
    return result;
}

function targetVariantKey(capability: AdapterAssetTargetCapability): string {
    return "renderStrategy" in capability
        ? JSON.stringify([capability.renderStrategy, capability.outputContractId, capability.outputContractFingerprint])
        : capability.entrySupportStatus;
}

function validateMaterializerHandlers(
    capabilities: readonly AdapterMaterializerCapability[],
    handlers: readonly AdapterTargetMaterializerHandler[],
): ReadonlyMap<string, AdapterTargetMaterializerHandler> {
    const expected = new Set(capabilities.map((capability) => capability.outputContractId));
    const result = new Map<string, AdapterTargetMaterializerHandler>();
    for (const handler of handlers) {
        if (result.has(handler.outputContractId)) throw new Error("adapter target materializer handler is duplicated");
        if (!expected.has(handler.outputContractId)) {
            throw new Error("adapter target materializer handler has no declared materializer capability");
        }
        result.set(handler.outputContractId, Object.freeze({ ...handler }));
    }
    if (expected.size !== result.size || [...expected].some((outputContractId) => !result.has(outputContractId))) {
        throw new Error("every materializer output contract requires one target handler");
    }
    return result;
}

async function coordinateAnalysis(
    input: RenderAnalysisInput,
    adapterId: string,
    adapterVersion: string,
    capabilities: readonly AdapterAssetTargetCapability[],
    handlers: ReadonlyMap<string, AdapterTargetConsumerHandler>,
): Promise<AdapterRenderAnalysisResult> {
    if (handlers.size === 0) {
        return blockedAnalysis(input, invalidTargetDiagnostic("render", "provider has no supported target consumer"));
    }
    const groups = new Map<string, { semantics: RequiredRenderSemantic[]; capability?: AdapterAssetTargetCapability }>();
    for (const semantic of input.requiredSemantics) {
        const asset = assetForSemantic(input, semantic);
        if (asset === undefined)
            return blockedAnalysis(input, invalidTargetDiagnostic("render", "target semantic has no exact Asset"));
        const key = cellKey(semantic.consumerAgentRuntimeId, asset.version.canonical.kind);
        const group = groups.get(key) ?? {
            semantics: [],
            capability: capabilities.find(
                (capability) =>
                    capability.agentRuntimeId === semantic.consumerAgentRuntimeId &&
                    capability.assetKind === asset.version.canonical.kind,
            ),
        };
        group.semantics.push(semantic);
        groups.set(key, group);
    }

    const results: AdapterRenderAnalysisResult[] = [];
    for (const [key, group] of [...groups].sort(([left], [right]) => compareCodeUnitText(left, right))) {
        const handler = handlers.get(key);
        if (handler === undefined) {
            results.push(blockedAnalysisForSemantics(group.semantics, unavailableDiagnostic(group.capability, "render")));
            continue;
        }
        const result = await handler.analyze(projectAnalysisInput(input, group.semantics));
        results.push(
            isExactHandlerAnalysis(group.semantics, result)
                ? result
                : blockedAnalysisForSemantics(
                      group.semantics,
                      invalidTargetDiagnostic(
                          "render",
                          "one target consumer handler returned a foreign or incomplete semantic closure",
                      ),
                  ),
        );
    }
    const merged = mergeAnalysisResults(input, results);
    if (merged.semanticOptions.length === 0) return merged;
    return rebindAdapterRenderAnalysisOptionFingerprints({ adapterId, version: adapterVersion }, input, merged);
}

async function coordinateMaterialization(
    input: RenderMaterializationInput,
    handlers: ReadonlyMap<string, AdapterTargetMaterializerHandler>,
): Promise<RenderMaterializationResult> {
    if (handlers.size === 0) return blockedMaterialization("provider has no supported target materializer");
    const groups = new Map<AdapterTargetMaterializerHandler, Set<string>>();
    for (const unit of input.selection.outputUnits) {
        const handler = handlers.get(unit.outputContractId);
        if (handler === undefined) return blockedMaterialization("target output contract has no materializer handler");
        const group = groups.get(handler) ?? new Set<string>();
        group.add(unit.outputUnitFingerprint);
        groups.set(handler, group);
    }
    const materializedUnits: Extract<RenderMaterializationResult, { materializationState: "materialized" }>["materializedUnits"] =
        [];
    const diagnostics: OperationDiagnostic[] = [];
    for (const [handler, unitFingerprints] of sortedMaterializerGroups(groups)) {
        const result = await handler.materialize(projectMaterializationInput(input, unitFingerprints));
        diagnostics.push(...result.diagnostics);
        if (result.status !== "complete" || result.materializationState !== "materialized") {
            return blockedMaterialization("one target materializer handler did not close its selected units", diagnostics);
        }
        const expected = [...unitFingerprints].sort(compareCodeUnitText);
        const actual = result.materializedUnits.map((unit) => unit.outputUnitFingerprint).sort(compareCodeUnitText);
        if (!sameStrings(expected, actual)) {
            return blockedMaterialization(
                "one target materializer handler returned a foreign or incomplete unit closure",
                diagnostics,
            );
        }
        materializedUnits.push(...result.materializedUnits);
    }
    materializedUnits.sort((left, right) => compareCodeUnitText(left.outputUnitFingerprint, right.outputUnitFingerprint));
    return { status: "complete", materializationState: "materialized", materializedUnits, diagnostics };
}

async function coordinateInspection(
    input: RenderedTargetInspectionInput,
    handlers: ReadonlyMap<string, AdapterTargetMaterializerHandler>,
): Promise<AdapterRenderedTargetInspectionResult> {
    if (handlers.size === 0) return blockedInspection("provider has no supported target inspector");
    const unitByFingerprint = new Map(input.appliedRenderSnapshot.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit]));
    const stateByPath = new Map(input.inspectionScope.fileStates.map((state) => [state.relativePath, state]));
    const groups = new Map<AdapterTargetMaterializerHandler, Set<string>>();
    for (const file of input.files) {
        const state = stateByPath.get(file.relativePath);
        const unit = state === undefined ? undefined : unitByFingerprint.get(state.outputUnitFingerprint);
        if (unit === undefined) return blockedInspection("changed target file has no exact materializer handler");
        const handler = handlers.get(unit.outputContractId);
        if (handler === undefined) return blockedInspection("changed target file has no exact materializer handler");
        const group = groups.get(handler) ?? new Set<string>();
        group.add(unit.outputUnitFingerprint);
        groups.set(handler, group);
    }
    for (const delta of input.inventoryDeltas) {
        const unit = unitByFingerprint.get(delta.outputUnitFingerprint);
        const handler = unit === undefined ? undefined : handlers.get(unit.outputContractId);
        if (handler === undefined) return blockedInspection("target inventory delta has no exact materializer handler");
        const group = groups.get(handler) ?? new Set<string>();
        group.add(delta.outputUnitFingerprint);
        groups.set(handler, group);
    }
    const changes: AdapterRenderedTargetInspectionResult["changes"] = [];
    const files: AdapterRenderedTargetInspectionResult["files"] = [];
    const diagnostics: OperationDiagnostic[] = [];
    for (const [handler, unitFingerprints] of sortedMaterializerGroups(groups)) {
        const projected = projectInspectionInput(input, unitFingerprints, stateByPath);
        const result = await handler.inspect(projected);
        diagnostics.push(...result.diagnostics);
        const expectedPaths = projected.files.map((file) => file.relativePath).sort(compareCodeUnitText);
        const actualPaths = result.files.map((file) => file.relativePath).sort(compareCodeUnitText);
        const changeFingerprints = result.changes.map((change) => change.changeFingerprint);
        if (
            result.status !== "complete" ||
            !sameStrings(expectedPaths, actualPaths) ||
            new Set(actualPaths).size !== actualPaths.length ||
            new Set(changeFingerprints).size !== changeFingerprints.length
        ) {
            return blockedInspection("one target inspection handler returned a foreign or incomplete closure", diagnostics);
        }
        changes.push(...result.changes);
        files.push(...result.files);
    }
    if (new Set(changes.map((change) => change.changeFingerprint)).size !== changes.length) {
        return blockedInspection("target inspection handlers returned overlapping closures", diagnostics);
    }
    changes.sort((left, right) => compareCodeUnitText(left.changeFingerprint, right.changeFingerprint));
    files.sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath));
    return { status: "complete", changes, files, diagnostics };
}

function projectAnalysisInput(input: RenderAnalysisInput, semantics: RequiredRenderSemantic[]): RenderAnalysisInput {
    const assetKeys = projectedAssetKeys(input, semantics);
    const consumerIds = new Set(semantics.map((semantic) => semantic.consumerAgentRuntimeId));
    const assets = input.deployment.assets.filter((asset) => assetKeys.has(versionKey(asset.version.ref)));
    const ownsAggregateSnapshot = semantics.some((semantic) => {
        const asset = input.deployment.assets.find(
            (candidate) => versionKey(candidate.version.ref) === versionKey(semantic.subject),
        );
        return asset?.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog";
    });
    const { targetFileSnapshots: _targetFileSnapshots, ...deploymentWithoutSnapshots } = input.deployment;
    return {
        ...input,
        deployment: {
            ...(ownsAggregateSnapshot ? input.deployment : deploymentWithoutSnapshots),
            assets,
            targetContexts: input.deployment.targetContexts.filter((context) => consumerIds.has(context.agentRuntimeId)),
        },
        requiredSemantics: semantics,
        dialectInputs: projectRenderDialectInputs(input.dialectInputs, semantics, input.deployment.assets),
    };
}

function projectedAssetKeys(input: RenderAnalysisInput, semantics: readonly RequiredRenderSemantic[]): Set<string> {
    const assetKeys = new Set(semantics.map((semantic) => versionKey(semantic.subject)));
    for (const asset of input.deployment.assets) {
        if (
            !assetKeys.has(versionKey(asset.version.ref)) ||
            asset.version.canonical.kind !== "Memory" ||
            asset.version.canonical.typeData.entityRole !== "catalog"
        ) {
            continue;
        }
        const memberVersionIds = new Set(asset.version.canonical.typeData.members.map((member) => member.targetAssetVersionId));
        for (const candidate of input.deployment.assets) {
            if (memberVersionIds.has(candidate.version.ref.versionId)) assetKeys.add(versionKey(candidate.version.ref));
        }
    }
    return assetKeys;
}

function projectMaterializationInput(
    input: RenderMaterializationInput,
    unitFingerprints: ReadonlySet<string>,
): RenderMaterializationInput {
    const options = input.selection.semanticOptions.filter((option) =>
        option.requiredOutputUnitFingerprints.some((fingerprint) => unitFingerprints.has(fingerprint)),
    );
    const semanticRefs = new Set(options.map((option) => option.semanticRefFingerprint));
    const semantics = input.requiredSemantics.filter((semantic) => semanticRefs.has(semantic.semanticRefFingerprint));
    const projected = projectAnalysisInput(
        {
            schemaVersion: input.schemaVersion,
            deployment: input.deployment,
            requiredSemantics: semantics,
            dialectInputs: input.dialectInputs,
        },
        semantics,
    );
    return {
        ...input,
        deployment: projected.deployment,
        requiredSemantics: semantics,
        dialectInputs: projected.dialectInputs,
        selection: {
            schemaVersion: 1,
            semanticOptions: options,
            outputUnits: input.selection.outputUnits.filter((unit) => unitFingerprints.has(unit.outputUnitFingerprint)),
            outputUnitRenderers: input.selection.outputUnitRenderers.filter((renderer) =>
                unitFingerprints.has(renderer.outputUnitFingerprint),
            ),
        },
    };
}

function projectInspectionInput(
    input: RenderedTargetInspectionInput,
    unitFingerprints: ReadonlySet<string>,
    stateByPath: ReadonlyMap<string, RenderedTargetInspectionInput["inspectionScope"]["fileStates"][number]>,
): RenderedTargetInspectionInput {
    return {
        ...input,
        inspectionScope: {
            ...input.inspectionScope,
            fileStates: input.inspectionScope.fileStates.filter((state) => unitFingerprints.has(state.outputUnitFingerprint)),
            directoryInventories: input.inspectionScope.directoryInventories.filter((inventory) =>
                unitFingerprints.has(inventory.outputUnitFingerprint),
            ),
        },
        files: input.files.filter((file) => {
            const state = stateByPath.get(file.relativePath);
            return state !== undefined && unitFingerprints.has(state.outputUnitFingerprint);
        }),
        inventoryDeltas: input.inventoryDeltas.filter((delta) => unitFingerprints.has(delta.outputUnitFingerprint)),
    };
}

function mergeAnalysisResults(
    input: RenderAnalysisInput,
    results: readonly AdapterRenderAnalysisResult[],
): AdapterRenderAnalysisResult {
    if (results.length === 0)
        return { status: "complete", outputUnits: [], semanticOptions: [], blockedSemanticRefs: [], diagnostics: [] };
    const outputUnits = results.flatMap((result) => result.outputUnits);
    const semanticOptions = results.flatMap((result) => result.semanticOptions);
    const blockedSemanticRefs = results.flatMap((result) => result.blockedSemanticRefs);
    const diagnostics = results.flatMap((result) => result.diagnostics);
    const covered = new Set([
        ...semanticOptions.map((option) => option.semanticRefFingerprint),
        ...blockedSemanticRefs.map((blocked) => blocked.semanticRefFingerprint),
    ]);
    const expected = input.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(compareCodeUnitText);
    const actual = [
        ...semanticOptions.map((option) => option.semanticRefFingerprint),
        ...blockedSemanticRefs.map((blocked) => blocked.semanticRefFingerprint),
    ].sort(compareCodeUnitText);
    const outputFingerprints = outputUnits.map((unit) => unit.outputUnitFingerprint);
    if (
        covered.size !== input.requiredSemantics.length ||
        !sameStrings(expected, actual) ||
        new Set(outputFingerprints).size !== outputFingerprints.length
    ) {
        return blockedAnalysis(input, invalidTargetDiagnostic("render", "target handlers did not classify every semantic"));
    }
    outputUnits.sort((left, right) => compareCodeUnitText(left.outputUnitFingerprint, right.outputUnitFingerprint));
    semanticOptions.sort((left, right) =>
        compareCodeUnitText(
            `${left.semanticRefFingerprint}\0${left.optionFingerprint}`,
            `${right.semanticRefFingerprint}\0${right.optionFingerprint}`,
        ),
    );
    blockedSemanticRefs.sort((left, right) => compareCodeUnitText(left.semanticRefFingerprint, right.semanticRefFingerprint));
    return {
        status: blockedSemanticRefs.length === 0 ? "complete" : semanticOptions.length === 0 ? "failed" : "partial",
        outputUnits,
        semanticOptions,
        blockedSemanticRefs,
        diagnostics,
    };
}

function isExactHandlerAnalysis(semantics: readonly RequiredRenderSemantic[], result: AdapterRenderAnalysisResult): boolean {
    const expected = semantics.map((semantic) => semantic.semanticRefFingerprint).sort(compareCodeUnitText);
    const actual = [
        ...result.semanticOptions.map((option) => option.semanticRefFingerprint),
        ...result.blockedSemanticRefs.map((blocked) => blocked.semanticRefFingerprint),
    ].sort(compareCodeUnitText);
    const outputFingerprints = result.outputUnits.map((unit) => unit.outputUnitFingerprint);
    const expectedStatus =
        result.blockedSemanticRefs.length === 0 ? "complete" : result.semanticOptions.length === 0 ? "failed" : "partial";
    return (
        sameStrings(expected, actual) &&
        new Set(actual).size === actual.length &&
        new Set(outputFingerprints).size === outputFingerprints.length &&
        result.status === expectedStatus
    );
}

function assetForSemantic(input: RenderAnalysisInput, semantic: RequiredRenderSemantic) {
    return input.deployment.assets.find(
        (asset) =>
            asset.version.ref.assetId === semantic.subject.assetId && asset.version.ref.versionId === semantic.subject.versionId,
    );
}

function blockedAnalysis(input: RenderAnalysisInput, diagnostic: OperationDiagnostic): AdapterRenderAnalysisResult {
    return blockedAnalysisForSemantics(input.requiredSemantics, diagnostic);
}

function blockedAnalysisForSemantics(
    semantics: readonly RequiredRenderSemantic[],
    diagnostic: OperationDiagnostic,
): AdapterRenderAnalysisResult {
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: semantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: diagnostic.code,
            diagnostics: [diagnostic],
        })),
        diagnostics: [diagnostic],
    };
}

function blockedMaterialization(message: string, diagnostics: OperationDiagnostic[] = []): RenderMaterializationResult {
    const own = invalidTargetDiagnostic("render", message);
    return {
        status: "failed",
        materializationState: "blocked",
        reasonCode: own.code,
        diagnostics: [...diagnostics, own],
    };
}

function blockedInspection(message: string, diagnostics: OperationDiagnostic[] = []): AdapterRenderedTargetInspectionResult {
    return {
        status: "failed",
        changes: [],
        files: [],
        diagnostics: [...diagnostics, invalidTargetDiagnostic("scan", message)],
    };
}

function unavailableDiagnostic(capability: AdapterAssetTargetCapability | undefined, operation: "render" | "scan") {
    const source = capability?.diagnostics[0];
    return source === undefined
        ? invalidTargetDiagnostic(operation, "target capability is unavailable")
        : { ...source, operation };
}

function invalidTargetDiagnostic(operation: "render" | "scan", message: string): OperationDiagnostic {
    return {
        severity: "error",
        code: "adapter_framework.target_handler_unavailable",
        message,
        path: "",
        traceId: "",
        operation,
        causeKind: "unsupported",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}

function cellKey(agentRuntimeId: string, assetKind: AssetKind): string {
    return `${agentRuntimeId}\0${assetKind}`;
}

function versionKey(version: { assetId: string; versionId: string }): string {
    return `${version.assetId}\0${version.versionId}`;
}

function sortedMaterializerGroups(
    groups: ReadonlyMap<AdapterTargetMaterializerHandler, Set<string>>,
): Array<[AdapterTargetMaterializerHandler, Set<string>]> {
    return [...groups].sort(([left], [right]) => compareCodeUnitText(left.outputContractId, right.outputContractId));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
