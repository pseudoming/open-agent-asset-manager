/**
 * Adapter-family registry and Stage-A dispatch boundary.
 *
 * Registration exposes only the final static declarations. Probe and the three
 * validated render operations are live. Production read dispatch is available
 * only through the CoreService-owned durable-authority boundary below.
 */

import { validateAdapterProbeResult, validateAdapterProviderRegistration } from "../adapters/adapter-contract-validator";
import { failedProbeResult, probeExceptionDiagnostic } from "../adapters/probe-failure";
import type { ReadAuthorityRevalidator } from "../adapters/adapter-read-access";
import {
    createVersionDialectRegistry,
    snapshotAdapterDialectContracts,
    type VersionDialectRegistryV1,
} from "../catalog/version-dialect-registry";
import { completeResult } from "../foundation/core-result";
import { deepFreezeParentFirst } from "../foundation/deep-freeze";
import {
    inspectionRendererPartition,
    retainedInspectionPartition,
    snapshotRetainedInspectionBindings,
} from "./adapter-retained-inspection";
import type { RenderRegistrySnapshot } from "../render/render-registry";
import { isCanonicalPhysicalAccessPath, physicalAccessPathContains, withPathEnvironmentObservation } from "@oaam/shared/paths";
import { validateAdapterRenderContractRegistration } from "../render/adapter-render-contract-registration";
import {
    canonicalMaterializationValidatorsForProviders,
    snapshotCanonicalMaterializationValidators,
    type CanonicalMaterializationValidatorsByAdapter,
} from "../render/canonical-materialization-validation";
import { validateAdapterRenderAnalysisResult } from "../render/render-analysis";
import { type AdapterReadAuthorityContext, executeAdapterReadWithAuthority } from "../source-import/source-contract-validator";
import { prepareRead } from "../source-import/source-read-preparation";
import type { PreparedRead } from "../source-import/source-read-execution";
import { failedResult } from "../source-import/source-read-validation-helpers";
import type {
    AdapterId,
    AdapterProbeContext,
    AdapterProvider,
    AdapterProviderStaticDeclarations,
    AdapterProviderSummary,
    AdapterReadResult,
    AdapterReadTarget,
    AdapterRenderAnalysisResult,
    AdapterRenderedTargetInspectionResult,
    AgentRuntimeId,
    CoreResult,
    OperationDiagnostic,
    ProbeAdaptersInput,
    ProbeAdaptersObserver,
    ProbeResult,
    RenderAnalysisInput,
    RenderedTargetInspectionInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
    Sha256Digest,
} from "../types";

interface RegistryEntry {
    provider: AdapterProvider;
    enabled: boolean;
}

const registry = new Map<AdapterId, RegistryEntry>();
let frozen = false;
let registeredVersionDialectRegistry: VersionDialectRegistryV1 | null = null;

/**
 * Atomically install the one process-wide provider set used by CoreService.
 * Validation, provider snapshots and dialect assembly all finish before the
 * global registry changes, so a failed bootstrap cannot strand a partial set.
 */
export function bootstrapAdapterRegistry(providers: readonly AdapterProvider[]): CoreResult<void> {
    if (frozen) return fail("registry_frozen", "registry is frozen");
    if (registry.size !== 0) {
        return fail("registry_not_empty", "CoreService bootstrap requires an empty registry");
    }
    try {
        const staged: AdapterProvider[] = [];
        const stagedIds = new Set<AdapterId>();
        for (const provider of providers) {
            const stagedProvider = snapshotProvider(provider);
            if (stagedIds.has(stagedProvider.adapterId)) {
                return fail("duplicate_adapter", `adapter "${stagedProvider.adapterId}" is registered more than once`);
            }
            const validation = validateAdapterProviderRegistration(stagedProvider, staged);
            if (validation.length > 0) {
                return { status: "failed", value: undefined, diagnostics: validation };
            }
            staged.push(stagedProvider);
            stagedIds.add(stagedProvider.adapterId);
        }
        const renderValidation = validateAdapterRenderContractRegistration(staged);
        if (renderValidation.length > 0) {
            return { status: "failed", value: undefined, diagnostics: renderValidation };
        }
        const dialects = createVersionDialectRegistry(
            staged.flatMap((provider) => provider.dialectContracts.native),
            staged.flatMap((provider) => provider.dialectContracts.restoration),
            staged.flatMap((provider) => provider.dialectContracts.portableEntries),
            staged.flatMap((provider) => provider.dialectContracts.portableSelectors),
        );
        for (const provider of staged) {
            registry.set(provider.adapterId, {
                provider,
                enabled: false,
            });
        }
        registeredVersionDialectRegistry = dialects;
        frozen = true;
        return completeResult(undefined);
    } catch (error) {
        return fail("adapter_bootstrap_invalid", `adapter registry bootstrap is invalid: ${String(error)}`);
    }
}

export function registerAdapterProvider(provider: AdapterProvider): CoreResult<AdapterProviderSummary> {
    if (frozen) return fail("registry_frozen", "registry is frozen");
    try {
        const registeredProvider = snapshotProvider(provider);
        if (registry.has(registeredProvider.adapterId)) {
            return fail("duplicate_adapter", `adapter "${registeredProvider.adapterId}" is already registered`);
        }
        const validation = validateAdapterProviderRegistration(
            registeredProvider,
            [...registry.values()].map((entry) => entry.provider),
        );
        validation.push(
            ...validateAdapterRenderContractRegistration([
                ...[...registry.values()].map((entry) => entry.provider),
                registeredProvider,
            ]),
        );
        if (validation.length > 0) {
            return {
                status: "failed",
                value: undefined as unknown as AdapterProviderSummary,
                diagnostics: validation,
            };
        }
        registry.set(registeredProvider.adapterId, { provider: registeredProvider, enabled: false });
        return completeResult(summarize(registeredProvider, false));
    } catch (error) {
        return fail("adapter_registration_invalid", `adapter registration is not a valid runtime contract: ${String(error)}`);
    }
}

export function listAdapterProviders(): CoreResult<AdapterProviderSummary[]> {
    return completeResult([...registry.values()].map(({ provider, enabled }) => summarize(provider, enabled)));
}

/** Revalidate a caller-returned probe snapshot against the frozen registered Provider. */
export function validateRegisteredProbeResult(result: ProbeResult): OperationDiagnostic[] {
    const entry = registry.get(result.observation.adapterId);
    if (entry === undefined) {
        return [
            registryDiagnostic(
                "probe.adapter_not_registered",
                `adapter "${result.observation.adapterId}" is not registered`,
                "probe",
            ),
        ];
    }
    const { adapterId: _adapterId, platformContext, ...observation } = result.observation;
    return validateAdapterProbeResult(
        entry.provider,
        {
            status: result.status,
            observation,
            diagnostics: result.diagnostics,
        },
        platformContext,
    );
}

/** Replace the live projection only after its durable settings authority has committed. */
export function replaceEnabledAdapters(adapterIds: readonly AdapterId[]): CoreResult<void> {
    if (!frozen) return fail("registry_not_frozen", "adapter enablement requires the frozen provider set");
    if (new Set(adapterIds).size !== adapterIds.length) {
        return fail("adapter_enablement_duplicate", "enabled adapter IDs must be unique");
    }
    for (const adapterId of adapterIds) {
        if (!registry.has(adapterId)) {
            return fail("adapter_enablement_unknown", `enabled adapter "${adapterId}" is not registered`);
        }
    }
    const enabled = new Set(adapterIds);
    for (const [adapterId, entry] of registry) {
        entry.enabled = enabled.has(adapterId);
    }
    return completeResult(undefined);
}

export function enableAdapter(adapterId: AdapterId): CoreResult<void> {
    const entry = registry.get(adapterId);
    if (entry === undefined) return fail("not_found", `adapter "${adapterId}" is not registered`);
    entry.enabled = true;
    return completeResult(undefined);
}

export function disableAdapter(adapterId: AdapterId): CoreResult<void> {
    const entry = registry.get(adapterId);
    if (entry === undefined) return fail("not_found", `adapter "${adapterId}" is not registered`);
    entry.enabled = false;
    return completeResult(undefined);
}

export function freezeRegistry(): CoreResult<void> {
    if (frozen) return completeResult(undefined);
    const providers = [...registry.values()].map((entry) => entry.provider);
    registeredVersionDialectRegistry = createVersionDialectRegistry(
        providers.flatMap((provider) => provider.dialectContracts.native),
        providers.flatMap((provider) => provider.dialectContracts.restoration),
        providers.flatMap((provider) => provider.dialectContracts.portableEntries),
        providers.flatMap((provider) => provider.dialectContracts.portableSelectors),
    );
    frozen = true;
    return completeResult(undefined);
}

/**
 * Build the immutable Version dialect registry from every registered provider.
 * Adapter enablement controls operations, not the ability to validate existing Versions.
 */
export function getRegisteredVersionDialectRegistry(): VersionDialectRegistryV1 {
    if (!frozen || registeredVersionDialectRegistry === null) {
        throw new Error("adapter registry must be frozen before dialect assembly");
    }
    return registeredVersionDialectRegistry;
}

export function getRegisteredCanonicalMaterializationValidators(
    providers: readonly AdapterProviderSummary[],
): CanonicalMaterializationValidatorsByAdapter {
    if (!frozen) throw new Error("adapter registry must be frozen before render validator assembly");
    return canonicalMaterializationValidatorsForProviders(
        providers.map((summary) => {
            const provider = registry.get(summary.adapterId)?.provider;
            if (provider === undefined || provider.version !== summary.version) {
                throw new Error("render validator Provider does not match the operation registry");
            }
            return provider;
        }),
    );
}

export function resolveRegisteredSourceCapabilityAgentRuntimeId(
    adapterId: AdapterId,
    sourceCapabilityFingerprint: Sha256Digest,
): AgentRuntimeId | null {
    const provider = registry.get(adapterId)?.provider;
    if (provider === undefined) return null;
    return (
        provider.assetSourceCapabilities.find(
            (capability) => capability.sourceCapabilityFingerprint === sourceCapabilityFingerprint,
        )?.agentRuntimeId ?? null
    );
}

/** Test-only seam; guarded against production imports by architecture tests. */
export function unfreezeRegistry(): void {
    frozen = false;
    registeredVersionDialectRegistry = null;
}

/** Test-only seam; guarded against production imports by architecture tests. */
export function clearRegistry(): void {
    registry.clear();
    frozen = false;
    registeredVersionDialectRegistry = null;
}

export async function probeAdapters(
    input: ProbeAdaptersInput,
    observer?: ProbeAdaptersObserver,
): Promise<CoreResult<ProbeResult[]>> {
    return probeAdaptersWithExecution(input, observer);
}

/** Internal composition entry; the ordinary probe API exposes no execution callback. */
export async function probeAdaptersWithExecution(
    input: ProbeAdaptersInput,
    observer?: ProbeAdaptersObserver,
    delegatedProbe?: (adapterId: AdapterId, context: AdapterProbeContext) => Promise<ProbeResult> | undefined,
): Promise<CoreResult<ProbeResult[]>> {
    return withPathEnvironmentObservation(() => probeAdaptersInObservation(input, observer, delegatedProbe));
}

async function probeAdaptersInObservation(
    input: ProbeAdaptersInput,
    observer?: ProbeAdaptersObserver,
    delegatedProbe?: (adapterId: AdapterId, context: AdapterProbeContext) => Promise<ProbeResult> | undefined,
): Promise<CoreResult<ProbeResult[]>> {
    let request: ProbeAdaptersInput;
    let requestDiagnostics: OperationDiagnostic[];
    try {
        request = structuredClone(input);
        requestDiagnostics = validateProbeRequest(request);
    } catch (error) {
        return {
            status: "failed",
            value: [],
            diagnostics: [
                registryDiagnostic(
                    "probe_request_invalid",
                    `probe request is not a cloneable runtime contract: ${String(error)}`,
                    "probe",
                ),
            ],
        };
    }
    if (requestDiagnostics.length > 0) {
        return { status: "failed", value: [], diagnostics: requestDiagnostics };
    }
    const targetIds = request.adapterIds ?? [...registry.entries()].filter(([, entry]) => entry.enabled).map(([id]) => id);
    const selectedCalls = targetIds.flatMap((adapterId) => {
        const entry = registry.get(adapterId);
        return entry === undefined || !entry.enabled
            ? []
            : request.contexts.map((platformContext) => ({ adapterId, platformContext }));
    });
    reportProbeProgress(observer, { stage: "provider_probe", completedUnits: 0, totalUnits: selectedCalls.length });
    let completedUnits = 0;
    const calls: Promise<ProbeCallOutcome>[] = [];
    for (const adapterId of targetIds) {
        const entry = registry.get(adapterId);
        if (entry === undefined || !entry.enabled) {
            const diagnostic = registryDiagnostic(
                entry === undefined ? "not_found" : "adapter_disabled",
                entry === undefined ? `adapter "${adapterId}" is not registered` : `adapter "${adapterId}" is disabled`,
                "probe",
            );
            calls.push(Promise.resolve({ result: null, diagnostics: [diagnostic], status: "failed" }));
            continue;
        }

        for (const platformContext of request.contexts) {
            const installationRoot =
                request.target.installationRootPath === undefined
                    ? {}
                    : { installationRootPath: request.target.installationRootPath };
            const context =
                request.target.authorizationScope === "global"
                    ? { authorizationScope: "global" as const, platformContext, ...installationRoot }
                    : request.target.authorizationScope === "project"
                      ? {
                            authorizationScope: "project" as const,
                            platformContext,
                            projectRootPath: request.target.projectRootPath,
                            ...installationRoot,
                        }
                      : {
                            authorizationScope: "directory" as const,
                            platformContext,
                            directoryRootPath: request.target.directoryRootPath,
                            ...installationRoot,
                        };
            const startedAt = performance.now();
            calls.push(
                runProbeCall(entry.provider, adapterId, platformContext, context, delegatedProbe).then((outcome) => {
                    completedUnits += 1;
                    reportProbeProgress(observer, {
                        stage: "provider_probe",
                        completedUnits,
                        totalUnits: selectedCalls.length,
                        adapterId,
                        platformContext,
                        outcome: outcome.status,
                        elapsedMilliseconds: Math.max(0, Math.round(performance.now() - startedAt)),
                    });
                    return outcome;
                }),
            );
        }
    }

    const outcomes = await Promise.all(calls);
    const results = outcomes.flatMap((outcome) => (outcome.result === null ? [] : [outcome.result]));
    const diagnostics = outcomes.flatMap((outcome) => outcome.diagnostics);
    const completeCalls = outcomes.filter((outcome) => outcome.status === "complete").length;
    const partialCalls = outcomes.filter((outcome) => outcome.status === "partial").length;
    const failedCalls = outcomes.filter((outcome) => outcome.status === "failed").length;
    const attemptedCalls = completeCalls + partialCalls + failedCalls;
    const status =
        attemptedCalls === 0 || (partialCalls === 0 && failedCalls === 0)
            ? "complete"
            : completeCalls > 0 || partialCalls > 0
              ? "partial"
              : "failed";
    return { status, value: results, diagnostics };
}

function reportProbeProgress(observer: ProbeAdaptersObserver | undefined, progress: Parameters<ProbeAdaptersObserver>[0]): void {
    try {
        observer?.(structuredClone(progress));
    } catch {
        // Presentation progress cannot alter the immutable terminal probe result.
    }
}

interface ProbeCallOutcome {
    result: ProbeResult | null;
    diagnostics: OperationDiagnostic[];
    status: ProbeResult["status"];
}

async function runProbeCall(
    provider: AdapterProvider,
    adapterId: AdapterId,
    platformContext: ProbeAdaptersInput["contexts"][number],
    context: Parameters<AdapterProvider["probe"]>[0],
    delegatedProbe?: (adapterId: AdapterId, context: AdapterProbeContext) => Promise<ProbeResult> | undefined,
): Promise<ProbeCallOutcome> {
    try {
        const delegated = delegatedProbe?.(adapterId, structuredClone(context));
        const result = structuredClone(await (delegated ?? provider.probe(structuredClone(context))));
        if (delegated !== undefined) {
            const observation = (result as ProbeResult).observation;
            if (
                observation.adapterId !== adapterId ||
                observation.platformContext.platform !== platformContext.platform ||
                observation.platformContext.platformInstanceId !== platformContext.platformInstanceId ||
                observation.platformContext.accessRootPath !== platformContext.accessRootPath
            ) {
                throw new Error("restricted probe response does not belong to the requested Provider and Environment");
            }
        }
        const validation = validateAdapterProbeResult(provider, result, platformContext).map((diagnostic) => ({
            ...diagnostic,
            operation: "probe" as const,
        }));
        if (validation.length > 0) {
            return {
                result: failedProbeResult(adapterId, platformContext, validation),
                diagnostics: validation,
                status: "failed",
            };
        }
        const projected: ProbeResult = {
            status: result.status,
            observation: { ...result.observation, adapterId, platformContext },
            diagnostics: result.diagnostics,
        };
        return { result: projected, diagnostics: result.diagnostics, status: result.status };
    } catch (error) {
        const diagnostic = probeExceptionDiagnostic(adapterId, error);
        return {
            result: failedProbeResult(adapterId, platformContext, [diagnostic]),
            diagnostics: [diagnostic],
            status: "failed",
        };
    }
}

function validateProbeRequest(input: ProbeAdaptersInput): OperationDiagnostic[] {
    const diagnostics: OperationDiagnostic[] = [];
    if (input.adapterIds !== undefined && new Set(input.adapterIds).size !== input.adapterIds.length) {
        diagnostics.push(
            registryDiagnostic("probe_request_adapter_duplicate", "probe request adapterIds must be unique", "probe"),
        );
    }
    const contextKeys = new Set<string>();
    if (input.target.installationRootPath !== undefined && (input.adapterIds?.length !== 1 || input.contexts.length !== 1)) {
        diagnostics.push(
            registryDiagnostic(
                "probe_request_installation_root_scope_invalid",
                "a user-selected installation root requires exactly one adapter and one platform context",
                "probe",
            ),
        );
    }
    for (const context of input.contexts) {
        const key = `${context.platform}\0${context.platformInstanceId}\0${context.accessRootPath}`;
        if (contextKeys.has(key)) {
            diagnostics.push(
                registryDiagnostic("probe_request_context_duplicate", "probe request platform contexts must be unique", "probe"),
            );
        }
        contextKeys.add(key);
        if (context.platformInstanceId.trim().length === 0 || !isCanonicalPhysicalAccessPath(context.accessRootPath)) {
            diagnostics.push(
                registryDiagnostic(
                    "probe_request_context_invalid",
                    "probe request context requires a nonblank identity and canonical access root",
                    "probe",
                ),
            );
        }
        const selectedRoot =
            input.target.authorizationScope === "project"
                ? input.target.projectRootPath
                : input.target.authorizationScope === "directory"
                  ? input.target.directoryRootPath
                  : null;
        if (selectedRoot !== null && !physicalAccessPathContains(context.accessRootPath, selectedRoot)) {
            diagnostics.push(
                registryDiagnostic(
                    "probe_request_target_root_invalid",
                    "probe request target root must remain inside every selected physical access root",
                    "probe",
                ),
            );
        }
        if (
            input.target.installationRootPath !== undefined &&
            (!isCanonicalPhysicalAccessPath(input.target.installationRootPath) ||
                !physicalAccessPathContains(context.accessRootPath, input.target.installationRootPath))
        ) {
            diagnostics.push(
                registryDiagnostic(
                    "probe_request_installation_root_invalid",
                    "the user-selected installation root must be canonical and remain inside the selected physical access root",
                    "probe",
                ),
            );
        }
    }
    return diagnostics;
}

/**
 * The raw convenience boundary remains deliberately closed: callers cannot
 * supply a trustworthy durable authority snapshot. CoreService uses the
 * internal authority-bearing dispatch below after deriving that snapshot from
 * DeploymentFile, residual and journal state.
 */
export async function readAssetsFromAdapter(input: AdapterReadTarget): Promise<CoreResult<AdapterReadResult>> {
    return dispatchDeferred(input.adapterId, "read", "stage_a_read_authority_unassembled");
}

/** Internal production dispatch after CoreService has derived the complete durable authority. */
export async function dispatchReadAssetsWithAuthority(
    input: AdapterReadTarget,
    authority: AdapterReadAuthorityContext,
    revalidateAuthority: ReadAuthorityRevalidator,
    execution?: (preparation: PreparedRead) => Promise<CoreResult<AdapterReadResult>>,
): Promise<CoreResult<AdapterReadResult>> {
    const entry = registry.get(input.adapterId);
    if (entry === undefined) return fail("not_found", `adapter "${input.adapterId}" is not registered`, "read");
    if (!entry.enabled) return fail("adapter_disabled", `adapter "${input.adapterId}" is disabled`, "read");
    if (execution !== undefined) {
        const preparation = prepareRead(entry.provider, input, authority);
        return "diagnostics" in preparation ? failedResult(preparation.diagnostics) : execution(preparation);
    }
    return executeAdapterReadWithAuthority(entry.provider, input, authority, revalidateAuthority);
}

/** Recheck current registry and durable source authority without sampling source bytes again. */
export function revalidateRegisteredReadAuthority(previous: AdapterReadResult, authority: AdapterReadAuthorityContext): boolean {
    const entry = registry.get(previous.readTarget.adapterId);
    if (entry === undefined || !entry.enabled) return false;
    const prepared = prepareRead(entry.provider, previous.readTarget, authority);
    return !("diagnostics" in prepared) && prepared.readAuthorityFingerprint === previous.readAuthorityFingerprint;
}

/** Test-only compatibility seam; architecture guards forbid production imports. */
export async function readAssetsFromAdapterForTest(
    input: AdapterReadTarget,
    authority: AdapterReadAuthorityContext,
): Promise<CoreResult<AdapterReadResult>> {
    return dispatchReadAssetsWithAuthority(input, authority, () => true);
}

/** Validated analysis dispatch; provider identity is stamped by the Core aggregation layer. */
export async function dispatchAnalyzeRender(
    adapterId: AdapterId,
    input: RenderAnalysisInput,
): Promise<CoreResult<AdapterRenderAnalysisResult>> {
    const entry = registry.get(adapterId);
    if (entry === undefined) return fail("not_found", `adapter "${adapterId}" is not registered`, "render");
    if (!entry.enabled) return fail("adapter_disabled", `adapter "${adapterId}" is disabled`, "render");
    try {
        const result = structuredClone(await entry.provider.analyzeRender(structuredClone(input)));
        const validation = validateAdapterRenderAnalysisResult(summarize(entry.provider, entry.enabled), input, result);
        if (validation.length > 0) {
            return {
                status: "failed",
                value: undefined as unknown as AdapterRenderAnalysisResult,
                diagnostics: validation,
            };
        }
        return { status: result.status, value: result, diagnostics: result.diagnostics };
    } catch (error) {
        return fail("render_analysis_error", `adapter "${adapterId}" analysis threw: ${String(error)}`, "render");
    }
}

export async function dispatchMaterializeRender(
    adapterId: AdapterId,
    input: RenderMaterializationInput,
): Promise<CoreResult<RenderMaterializationResult>> {
    const entry = registry.get(adapterId);
    if (entry === undefined) return fail("not_found", `adapter "${adapterId}" is not registered`, "render");
    if (!entry.enabled) return fail("adapter_disabled", `adapter "${adapterId}" is disabled`, "render");
    try {
        validateMaterializationDispatch(entry.provider, input);
        const result = structuredClone(await entry.provider.materializeRender(structuredClone(input)));
        if (
            (result.status !== "complete" && result.status !== "partial" && result.status !== "failed") ||
            !Array.isArray(result.diagnostics) ||
            (result.materializationState === "materialized" && !Array.isArray(result.materializedUnits)) ||
            (result.materializationState !== "materialized" && result.materializationState !== "blocked")
        ) {
            return fail(
                "render_materialization_result_invalid",
                `adapter "${adapterId}" returned an invalid materialization shape`,
                "render",
            );
        }
        return { status: result.status, value: result, diagnostics: result.diagnostics };
    } catch (error) {
        return fail("render_materialization_error", `adapter "${adapterId}" materialization threw: ${String(error)}`, "render");
    }
}

/** Selected only for an already applied renderer by the inspection pipeline. */
export function getRegisteredRetainedInspectionRegistry(
    adapterId: AdapterId,
    rendererVersion: string,
): RenderRegistrySnapshot | null {
    const entry = registry.get(adapterId);
    if (!frozen || entry === undefined || !entry.enabled) return null;
    return retainedInspectionPartition(entry.provider, rendererVersion)?.registry ?? null;
}

export async function dispatchInspectRenderedTarget(
    adapterId: AdapterId,
    input: RenderedTargetInspectionInput,
): Promise<CoreResult<AdapterRenderedTargetInspectionResult>> {
    const entry = registry.get(adapterId);
    if (entry === undefined) return fail("not_found", `adapter "${adapterId}" is not registered`, "scan");
    if (!entry.enabled) return fail("adapter_disabled", `adapter "${adapterId}" is disabled`, "scan");
    try {
        const { rendererVersion, changedUnits } = inspectionRendererPartition(input, adapterId);
        const retained =
            rendererVersion === entry.provider.version ? null : retainedInspectionPartition(entry.provider, rendererVersion);
        if (rendererVersion !== entry.provider.version && retained === null) {
            throw new Error("inspection renderer version is not retained");
        }
        const metadata = retained?.metadata ?? entry.provider;
        validateInspectionDispatch(metadata, input, changedUnits);
        const result = structuredClone(
            await (retained === null
                ? entry.provider.inspectRenderedTarget(structuredClone(input))
                : retained.inspectRenderedTarget(structuredClone(input))),
        );
        if (
            (result.status !== "complete" && result.status !== "partial" && result.status !== "failed") ||
            !Array.isArray(result.changes) ||
            !Array.isArray(result.files) ||
            !Array.isArray(result.diagnostics)
        ) {
            return fail(
                "render_inspection_result_invalid",
                `adapter "${adapterId}" returned an invalid inspection shape`,
                "scan",
            );
        }
        return { status: result.status, value: result, diagnostics: result.diagnostics };
    } catch (error) {
        return fail("render_inspection_error", `adapter "${adapterId}" inspection threw: ${String(error)}`, "scan");
    }
}

function validateMaterializationDispatch(provider: AdapterProvider, input: RenderMaterializationInput): void {
    if (
        input.schemaVersion !== 1 ||
        input.selection.schemaVersion !== 1 ||
        input.selection.outputUnits.length === 0 ||
        input.selection.outputUnitRenderers.length !== input.selection.outputUnits.length
    ) {
        throw new Error("materialization dispatch requires one non-empty exact unit closure");
    }
    const unitByFingerprint = new Map(input.selection.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit]));
    const renderers = new Set<string>();
    for (const renderer of input.selection.outputUnitRenderers) {
        const unit = unitByFingerprint.get(renderer.outputUnitFingerprint);
        if (
            unit === undefined ||
            renderers.has(renderer.outputUnitFingerprint) ||
            renderer.rendererAdapterId !== provider.adapterId ||
            renderer.rendererAdapterVersion !== provider.version
        ) {
            throw new Error("materialization dispatch contains a foreign or duplicate renderer");
        }
        const capability = provider.materializerCapabilities.find(
            (item) => item.materializerCapabilityKey === renderer.materializerCapabilityKey,
        );
        if (
            capability === undefined ||
            capability.outputContractId !== unit.outputContractId ||
            capability.outputContractFingerprint !== unit.outputContractFingerprint ||
            !capability.materializationProfileIds.includes(renderer.materializationProfileId)
        ) {
            throw new Error("materialization dispatch capability/profile is not registered");
        }
        renderers.add(renderer.outputUnitFingerprint);
    }
}

function validateInspectionDispatch(
    provider: AdapterProviderStaticDeclarations,
    input: RenderedTargetInspectionInput,
    changedUnits: ReadonlySet<Sha256Digest>,
): void {
    const rendererByUnit = new Map(
        input.appliedRenderSnapshot.outputUnitRenderers.map((renderer) => [renderer.outputUnitFingerprint, renderer]),
    );
    const outputUnitByFingerprint = new Map(
        input.appliedRenderSnapshot.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit]),
    );
    for (const unit of changedUnits) {
        const renderer = rendererByUnit.get(unit);
        const outputUnit = outputUnitByFingerprint.get(unit);
        const capability = provider.materializerCapabilities.find(
            (item) => item.materializerCapabilityKey === renderer?.materializerCapabilityKey,
        );
        if (
            renderer === undefined ||
            outputUnit === undefined ||
            renderer.rendererAdapterId !== provider.adapterId ||
            renderer.rendererAdapterVersion !== provider.version ||
            capability === undefined ||
            capability.outputContractId !== outputUnit.outputContractId ||
            capability.outputContractFingerprint !== outputUnit.outputContractFingerprint ||
            !capability.materializationProfileIds.includes(renderer.materializationProfileId)
        ) {
            throw new Error("inspection dispatch output unit is not owned by this renderer");
        }
    }
}

function dispatchDeferred<T>(adapterId: AdapterId, operation: OperationDiagnostic["operation"], code: string): CoreResult<T> {
    const entry = registry.get(adapterId);
    if (entry === undefined) return fail("not_found", `adapter "${adapterId}" is not registered`, operation);
    if (!entry.enabled) return fail("adapter_disabled", `adapter "${adapterId}" is disabled`, operation);
    return fail(code, `adapter "${adapterId}" operation is deferred until its Stage A authority is installed`, operation);
}

function summarize(provider: AdapterProvider, enabled: boolean): AdapterProviderSummary {
    return structuredClone({
        adapterId: provider.adapterId,
        displayName: provider.displayName,
        version: provider.version,
        enabled,
        agentRuntimes: provider.agentRuntimes,
        targetContextSchemas: provider.targetContextSchemas,
        assetSourceCapabilities: provider.assetSourceCapabilities,
        assetTargetCapabilities: provider.assetTargetCapabilities,
        materializerCapabilities: provider.materializerCapabilities,
        renderContractDeclarations: provider.renderContractDeclarations,
    });
}

/**
 * Registration is the one static-provider authority boundary. Capture both
 * declarations and method identities before validation and publish only that
 * snapshot, so later mutation of the caller-owned object cannot bypass checks
 * or silently change a frozen capability owner.
 */
function snapshotProvider(provider: AdapterProvider): AdapterProvider {
    const snapshot: AdapterProvider = {
        adapterId: provider.adapterId,
        displayName: provider.displayName,
        version: provider.version,
        agentRuntimes: deepFreezeParentFirst(structuredClone(provider.agentRuntimes)),
        targetContextSchemas: deepFreezeParentFirst(structuredClone(provider.targetContextSchemas)),
        assetSourceCapabilities: deepFreezeParentFirst(structuredClone(provider.assetSourceCapabilities)),
        assetTargetCapabilities: deepFreezeParentFirst(structuredClone(provider.assetTargetCapabilities)),
        materializerCapabilities: deepFreezeParentFirst(structuredClone(provider.materializerCapabilities)),
        renderContractDeclarations: deepFreezeParentFirst(structuredClone(provider.renderContractDeclarations)),
        dialectContracts: snapshotAdapterDialectContracts(provider.dialectContracts),
        canonicalMaterializationValidators: snapshotCanonicalMaterializationValidators(
            provider.canonicalMaterializationValidators,
        ),
        probe: provider.probe,
        read: provider.read,
        analyzeRender: provider.analyzeRender,
        materializeRender: provider.materializeRender,
        inspectRenderedTarget: provider.inspectRenderedTarget,
    };
    return Object.freeze({
        ...snapshot,
        retainedInspectionBindings: snapshotRetainedInspectionBindings(snapshot, provider.retainedInspectionBindings),
    });
}

function fail<T>(code: string, message: string, operation: OperationDiagnostic["operation"] = "internal"): CoreResult<T> {
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [registryDiagnostic(code, message, operation)],
    };
}

function registryDiagnostic(code: string, message: string, operation: OperationDiagnostic["operation"]): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message,
        operation,
        causeKind: code === "not_found" ? "not_found" : "unavailable",
        path: "",
        traceId: "",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
