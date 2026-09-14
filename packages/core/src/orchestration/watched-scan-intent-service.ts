/** Core-owned watched-scan intent construction over fresh probe snapshots. */

import {
    isAbsolutePhysicalAccessPathForRoot,
    isCanonicalPhysicalAccessPath,
    normalizePhysicalAccessPathWithinRoot,
} from "@oaam/shared/paths";
import { acquireProjectAuthorityLocks, readProjectManifest } from "../catalog/project-authority";
import { getWatchedScanIntentAuthority, setWatchedScanIntentAuthority } from "../catalog/settings-authority";
import { buildWatchedSourceSelector, canonicalWatchedEnvironments } from "../catalog/watched-scan-intent-setting";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";
import { compareCodeUnitText } from "../foundation/fingerprint-base";
import { hasExactKeys, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";
import type {
    AdapterId,
    AdapterProviderSummary,
    AgentRuntimeId,
    CoreResult,
    EpochMillis,
    OperationDiagnostic,
    Platform,
    PlatformContext,
    ProbeResult,
    ReplaceWatchedScanIntentRequestV1,
    ResetWatchedScanIntentRequestV1,
    UuidV4,
    WatchedEnvironmentIntentV1,
    WatchedEnvironmentSelectorV1,
    WatchedProbeSourceRefV1,
    WatchedScanIntentApi,
    WatchedScanIntentV1,
    WatchedScanSourceDecisionV1,
    WatchedSourceIdentityV1,
    WatchedSourceSelectorV1,
} from "../types";
import { listAdapterProviders, validateRegisteredProbeResult } from "./adapter-registry";
import { CoreMutationScopeError } from "./core-mutation-scope";

export interface WatchedScanIntentServiceConfiguration {
    oaamRoot: string;
    projectsRoot: string;
    authorityLocksRoot: string;
    platformContexts: readonly PlatformContext[];
    assertMutationScope(scope: { assetIds: []; settingsAuthority: true }): void;
    now: () => EpochMillis;
}

interface EnvironmentAccumulator {
    environment: WatchedEnvironmentSelectorV1;
    sourceSelectors: WatchedSourceSelectorV1[];
}

interface CurrentSelector {
    environment: WatchedEnvironmentIntentV1;
    selector: WatchedSourceSelectorV1;
}

interface ProbeSnapshot {
    result: ProbeResult;
    provider: AdapterProviderSummary;
}

export function createWatchedScanIntentService(configuration: WatchedScanIntentServiceConfiguration): WatchedScanIntentApi {
    return Object.freeze({
        getWatchedScanIntent() {
            try {
                const release = acquireSettingsLock(configuration.authorityLocksRoot);
                try {
                    return completeResult(getWatchedScanIntentAuthority(configuration.oaamRoot));
                } finally {
                    release();
                }
            } catch (error) {
                return failed(error);
            }
        },
        replaceWatchedScanIntent(input: ReplaceWatchedScanIntentRequestV1) {
            try {
                const request = structuredClone(input);
                validateReplaceRequest(request);
                configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                const preliminary = getWatchedScanIntentAuthority(configuration.oaamRoot);
                requireCas(preliminary, request.expectedRevision, request.expectedSettingFingerprint);
                const projectIds = requestedProjectIds(preliminary, request.decisions);
                const releaseProjects = acquireProjectAuthorityLocks(configuration.authorityLocksRoot, projectIds);
                try {
                    const releaseSettings = acquireSettingsLock(configuration.authorityLocksRoot);
                    try {
                        configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                        const current = getWatchedScanIntentAuthority(configuration.oaamRoot);
                        requireCas(current, request.expectedRevision, request.expectedSettingFingerprint);
                        requireActiveProjects(configuration.projectsRoot, projectIds);
                        const environments = constructNextEnvironments(configuration, current, request);
                        return completeResult(
                            setWatchedScanIntentAuthority({
                                oaamRoot: configuration.oaamRoot,
                                expectedRevision: request.expectedRevision,
                                expectedSettingFingerprint: request.expectedSettingFingerprint,
                                environments,
                                userActionEvidenceId: request.userActionId,
                                changedAt: configuration.now(),
                            }),
                        );
                    } finally {
                        releaseSettings();
                    }
                } finally {
                    releaseProjects();
                }
            } catch (error) {
                return failed(error);
            }
        },
        resetWatchedScanIntent(input: ResetWatchedScanIntentRequestV1) {
            try {
                const request = structuredClone(input);
                validateResetRequest(request);
                configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                const release = acquireSettingsLock(configuration.authorityLocksRoot);
                try {
                    configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                    return completeResult(
                        setWatchedScanIntentAuthority({
                            oaamRoot: configuration.oaamRoot,
                            expectedRevision: request.expectedRevision,
                            expectedSettingFingerprint: request.expectedSettingFingerprint,
                            environments: [],
                            userActionEvidenceId: request.userActionId,
                            changedAt: configuration.now(),
                        }),
                    );
                } finally {
                    release();
                }
            } catch (error) {
                return failed(error);
            }
        },
    });
}

function constructNextEnvironments(
    configuration: WatchedScanIntentServiceConfiguration,
    current: WatchedScanIntentV1,
    request: ReplaceWatchedScanIntentRequestV1,
): WatchedEnvironmentIntentV1[] {
    const providers = providerMap();
    const probes = validateProbeSnapshots(configuration.platformContexts, request.currentProbeResults, providers);
    const currentSelectors = currentSelectorMap(current);
    const accumulators = new Map<string, EnvironmentAccumulator>();
    const decisionKeys = new Set<string>();

    for (const decision of request.decisions) {
        if (decision.action === "retain_existing") {
            const key = `retain\0${decision.selectorFingerprint}`;
            requireUniqueDecision(decisionKeys, key);
            const retained = currentSelectors.get(decision.selectorFingerprint);
            if (retained === undefined) {
                throw new WatchedScanFailure(
                    "settings.watched_scan_retain_missing",
                    "retained selector fingerprint is not in the current authority",
                );
            }
            const provider = requireProvider(providers, retained.selector.source.adapterId);
            requireProviderRuntimeSubset(provider, retained.selector.agentRuntimeIds);
            if (
                retained.selector.source.rootRole === "source" &&
                retained.selector.source.sourceDomain === "external_managed" &&
                retained.selector.source.locatorIdentities.some((locator) => locator.locatorKind === "user_provided_path")
            ) {
                requireUserSelectedSupport(provider, retained.selector.agentRuntimeIds);
            }
            const accumulator = getAccumulator(accumulators, retained.environment.environment);
            accumulator.sourceSelectors.push(structuredClone(retained.selector));
            continue;
        }

        if (decision.action === "include_user_selected_root") {
            const provider = requireProvider(providers, decision.adapterId);
            const context = requireConfiguredEnvironment(configuration.platformContexts, decision.environment);
            const runtimeIds = requireProviderRuntimeSubset(provider, decision.agentRuntimeIds);
            requireUserSelectedSupport(provider, runtimeIds);
            const canonicalPath = canonicalizeSelectedRoot(decision.directoryRootPath, context);
            const key = `user\0${provider.adapterId}\0${environmentKey(decision.environment)}\0${canonicalPath}`;
            requireUniqueDecision(decisionKeys, key);
            const selector = buildWatchedSourceSelector(
                {
                    disposition: "included",
                    source: {
                        adapterId: provider.adapterId,
                        rootRole: "source",
                        sourceDomain: "external_managed",
                        canonicalPath,
                        locatorIdentities: [{ locatorKind: "user_provided_path", locatorKey: "user_selection" }],
                    },
                    agentRuntimeIds: runtimeIds,
                    binding: decision.binding,
                },
                decision.environment,
            );
            addSelection(accumulators, decision.environment, selector);
            continue;
        }

        const resolved = resolveObservedSource(probes, decision.sourceRef, decision.agentRuntimeIds);
        const key = `observed\0${probeKey(decision.sourceRef.adapterId, decision.sourceRef.platformContext)}\0${decision.sourceRef.sourceRootId}`;
        requireUniqueDecision(decisionKeys, key);
        const preimage =
            decision.action === "include_observed"
                ? {
                      disposition: "included" as const,
                      source: resolved.source,
                      agentRuntimeIds: resolved.runtimeIds,
                      binding: decision.binding,
                  }
                : {
                      disposition: "excluded" as const,
                      source: resolved.source,
                      agentRuntimeIds: resolved.runtimeIds,
                  };
        const selector = buildWatchedSourceSelector(preimage, resolved.environment);
        addSelection(accumulators, resolved.environment, selector);
    }

    return canonicalWatchedEnvironments(
        [...accumulators.values()].map((value) => ({
            environment: value.environment,
            sourceSelectors: value.sourceSelectors,
        })),
    );
}

function validateProbeSnapshots(
    configuredContexts: readonly PlatformContext[],
    results: readonly ProbeResult[],
    providers: Map<AdapterId, AdapterProviderSummary>,
): Map<string, ProbeSnapshot> {
    const snapshots = new Map<string, ProbeSnapshot>();
    for (const result of results) {
        if (!isStrictObject(result) || !isStrictObject(result.observation)) {
            throw new WatchedScanFailure("settings.watched_scan_probe_invalid", "probe result is not a strict object");
        }
        const provider = requireProvider(providers, result.observation.adapterId);
        requireConfiguredContext(configuredContexts, result.observation.platformContext);
        const issues = validateRegisteredProbeResult(result);
        const firstIssue = issues[0];
        if (firstIssue !== undefined) {
            throw new WatchedScanFailure(
                "settings.watched_scan_probe_invalid",
                `probe result failed registered-provider validation: ${firstIssue.message}`,
            );
        }
        const key = probeKey(provider.adapterId, result.observation.platformContext);
        if (snapshots.has(key)) {
            throw new WatchedScanFailure(
                "settings.watched_scan_probe_duplicate",
                "current probe results repeat one adapter/environment",
            );
        }
        snapshots.set(key, { result, provider });
    }
    return snapshots;
}

function resolveObservedSource(
    probes: Map<string, ProbeSnapshot>,
    sourceRef: WatchedProbeSourceRefV1,
    requestedRuntimeIds: readonly AgentRuntimeId[],
): {
    environment: WatchedEnvironmentSelectorV1;
    runtimeIds: AgentRuntimeId[];
    source: WatchedSourceIdentityV1;
} {
    const snapshot = probes.get(probeKey(sourceRef.adapterId, sourceRef.platformContext));
    if (snapshot === undefined) {
        throw new WatchedScanFailure(
            "settings.watched_scan_source_ref_stale",
            "observed source reference does not resolve in current probe results",
        );
    }
    const roots = snapshot.result.observation.sourceRoots.filter((root) => root.sourceRootId === sourceRef.sourceRootId);
    if (roots.length !== 1) {
        throw new WatchedScanFailure(
            "settings.watched_scan_source_ref_ambiguous",
            "observed source reference must resolve exactly once",
        );
    }
    const root = roots[0];
    const allowedRuntimeIds = new Set(
        snapshot.result.observation.observedAgentRuntimes
            .filter((runtime) => runtime.sourceRootIds.includes(root.sourceRootId))
            .map((runtime) => runtime.agentRuntimeId),
    );
    const runtimeIds = canonicalRuntimeIds(requestedRuntimeIds);
    if (runtimeIds.length === 0 || runtimeIds.some((runtimeId) => !allowedRuntimeIds.has(runtimeId))) {
        throw new WatchedScanFailure(
            "settings.watched_scan_runtime_subset_invalid",
            "observed source runtime IDs must be a non-empty subset of entries that reference the root",
        );
    }
    requireProviderRuntimeSubset(snapshot.provider, runtimeIds);
    const locatorIdentities = root.locatorEvidence
        .map((evidence) => ({ locatorKind: evidence.locatorKind, locatorKey: evidence.locatorKey }))
        .filter(
            (locator, index, values) =>
                values.findIndex(
                    (candidate) => candidate.locatorKind === locator.locatorKind && candidate.locatorKey === locator.locatorKey,
                ) === index,
        );
    return {
        environment: {
            platform: sourceRef.platformContext.platform,
            platformInstanceId: sourceRef.platformContext.platformInstanceId,
        },
        runtimeIds,
        source: {
            adapterId: sourceRef.adapterId,
            rootRole: root.rootRole,
            sourceDomain: root.sourceDomain,
            canonicalPath: root.path,
            locatorIdentities,
        },
    };
}

function currentSelectorMap(current: WatchedScanIntentV1): Map<string, CurrentSelector> {
    const selectors = new Map<string, CurrentSelector>();
    for (const environment of current.environments) {
        for (const selector of environment.sourceSelectors) {
            selectors.set(selector.selectorFingerprint, { environment, selector });
        }
    }
    return selectors;
}

function requestedProjectIds(current: WatchedScanIntentV1, decisions: readonly WatchedScanSourceDecisionV1[]): UuidV4[] {
    const selectors = currentSelectorMap(current);
    const ids: UuidV4[] = [];
    for (const decision of decisions) {
        if ("binding" in decision && decision.binding.assetScope === "project") {
            ids.push(decision.binding.projectId);
        } else if (decision.action === "retain_existing") {
            const retained = selectors.get(decision.selectorFingerprint)?.selector;
            if (retained?.disposition === "included" && retained.binding.assetScope === "project") {
                ids.push(retained.binding.projectId);
            }
        }
    }
    return [...new Set(ids)].sort(compareCodeUnitText);
}

function requireActiveProjects(projectsRoot: string, projectIds: readonly UuidV4[]): void {
    for (const projectId of projectIds) {
        const project = readProjectManifest(projectsRoot, projectId);
        if (project === null || project.deleted) {
            throw new WatchedScanFailure(
                "settings.watched_scan_project_inactive",
                `project binding is missing or deleted: ${projectId}`,
            );
        }
    }
}

function requireUserSelectedSupport(provider: AdapterProviderSummary, runtimeIds: readonly AgentRuntimeId[]): void {
    for (const runtimeId of runtimeIds) {
        const supported = provider.assetSourceCapabilities.some(
            (capability) =>
                capability.agentRuntimeId === runtimeId &&
                capability.entrySupportStatus === "supported" &&
                capability.rootLocatorKind === "user_provided_path" &&
                capability.rootRole === "source" &&
                capability.sourceDomain === "external_managed" &&
                (capability.readPolicy === "user_selected_root_only" || capability.readPolicy === "auto_read"),
        );
        if (!supported) {
            throw new WatchedScanFailure(
                "settings.watched_scan_user_root_unsupported",
                `adapter ${provider.adapterId} does not support a user-selected root for ${runtimeId}`,
            );
        }
    }
}

function providerMap(): Map<AdapterId, AdapterProviderSummary> {
    return new Map(listAdapterProviders().value.map((provider) => [provider.adapterId, provider]));
}

function requireProvider(providers: Map<AdapterId, AdapterProviderSummary>, adapterId: AdapterId): AdapterProviderSummary {
    const provider = providers.get(adapterId);
    if (provider === undefined) {
        throw new WatchedScanFailure("settings.watched_scan_adapter_unknown", `adapter is not registered: ${adapterId}`);
    }
    return provider;
}

function requireProviderRuntimeSubset(provider: AdapterProviderSummary, runtimeIds: readonly AgentRuntimeId[]): AgentRuntimeId[] {
    const canonical = canonicalRuntimeIds(runtimeIds);
    const owned = new Set(provider.agentRuntimes.map((runtime) => runtime.agentRuntimeId));
    if (canonical.length === 0 || canonical.some((runtimeId) => !owned.has(runtimeId))) {
        throw new WatchedScanFailure(
            "settings.watched_scan_runtime_foreign",
            `agent runtime IDs must be a non-empty subset owned by ${provider.adapterId}`,
        );
    }
    return canonical;
}

function canonicalizeSelectedRoot(value: string, context: PlatformContext): string {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
        throw new WatchedScanFailure("settings.watched_scan_user_root_invalid", "user-selected root is invalid");
    }
    if (!isAbsolutePhysicalAccessPathForRoot(value, context.accessRootPath)) {
        throw new WatchedScanFailure("settings.watched_scan_user_root_invalid", "user-selected root must be absolute");
    }
    const canonical = normalizePhysicalAccessPathWithinRoot(value, context.accessRootPath);
    if (canonical === null) {
        throw new WatchedScanFailure(
            "settings.watched_scan_user_root_outside_environment",
            "user-selected root is outside the configured environment access root",
        );
    }
    return canonical;
}

function requireConfiguredContext(configured: readonly PlatformContext[], context: PlatformContext): PlatformContext {
    if (!isStrictObject(context) || !hasExactKeys(context, ["platform", "platformInstanceId", "accessRootPath"])) {
        throw new WatchedScanFailure("settings.watched_scan_environment_invalid", "platform context is not strict");
    }
    const matches = configured.filter(
        (candidate) =>
            candidate.platform === context.platform &&
            candidate.platformInstanceId === context.platformInstanceId &&
            candidate.accessRootPath === context.accessRootPath,
    );
    if (matches.length !== 1) {
        throw new WatchedScanFailure(
            "settings.watched_scan_environment_unknown",
            "probe platform context is not one configured environment",
        );
    }
    return matches[0];
}

function requireConfiguredEnvironment(
    configured: readonly PlatformContext[],
    environment: WatchedEnvironmentSelectorV1,
): PlatformContext {
    if (!isStrictObject(environment) || !hasExactKeys(environment, ["platform", "platformInstanceId"])) {
        throw new WatchedScanFailure("settings.watched_scan_environment_invalid", "environment selector is not strict");
    }
    const matches = configured.filter(
        (candidate) =>
            candidate.platform === environment.platform && candidate.platformInstanceId === environment.platformInstanceId,
    );
    if (matches.length !== 1) {
        throw new WatchedScanFailure(
            "settings.watched_scan_environment_unknown",
            "environment selector must resolve exactly one configured platform context",
        );
    }
    return matches[0];
}

function addSelection(
    accumulators: Map<string, EnvironmentAccumulator>,
    environment: WatchedEnvironmentSelectorV1,
    selector: WatchedSourceSelectorV1,
): void {
    const accumulator = getAccumulator(accumulators, environment);
    accumulator.sourceSelectors.push(selector);
}

function getAccumulator(
    accumulators: Map<string, EnvironmentAccumulator>,
    environment: WatchedEnvironmentSelectorV1,
): EnvironmentAccumulator {
    const key = environmentKey(environment);
    const current = accumulators.get(key);
    if (current !== undefined) return current;
    const created: EnvironmentAccumulator = {
        environment: structuredClone(environment),
        sourceSelectors: [],
    };
    accumulators.set(key, created);
    return created;
}

function canonicalRuntimeIds(value: readonly AgentRuntimeId[]): AgentRuntimeId[] {
    if (!Array.isArray(value)) {
        throw new WatchedScanFailure("settings.watched_scan_runtime_ids_invalid", "agentRuntimeIds must be an array");
    }
    const ids = value.map((runtimeId) => {
        requireNonBlank(runtimeId, "agentRuntimeId");
        return runtimeId;
    });
    ids.sort(compareCodeUnitText);
    if (new Set(ids).size !== ids.length) {
        throw new WatchedScanFailure("settings.watched_scan_runtime_ids_duplicate", "agentRuntimeIds must be unique");
    }
    return ids;
}

function validateReplaceRequest(value: ReplaceWatchedScanIntentRequestV1): void {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "expectedRevision",
            "expectedSettingFingerprint",
            "userActionId",
            "currentProbeResults",
            "decisions",
        ])
    ) {
        throw new WatchedScanFailure("settings.watched_scan_request_invalid", "replace request is not strict");
    }
    requireRequestHeader(value);
    if (!Array.isArray(value.currentProbeResults) || !Array.isArray(value.decisions)) {
        throw new WatchedScanFailure("settings.watched_scan_request_invalid", "probe results and decisions must be arrays");
    }
    for (const decision of value.decisions) validateDecision(decision);
}

function validateResetRequest(value: ResetWatchedScanIntentRequestV1): void {
    if (!isStrictObject(value) || !hasExactKeys(value, ["expectedRevision", "expectedSettingFingerprint", "userActionId"])) {
        throw new WatchedScanFailure("settings.watched_scan_request_invalid", "reset request is not strict");
    }
    requireRequestHeader(value);
}

function validateDecision(decision: WatchedScanSourceDecisionV1): void {
    if (!isStrictObject(decision)) {
        throw new WatchedScanFailure("settings.watched_scan_decision_invalid", "decision must be an object");
    }
    if (decision.action === "retain_existing") {
        if (!hasExactKeys(decision, ["action", "selectorFingerprint"]) || !isSha256Digest(decision.selectorFingerprint)) {
            throw new WatchedScanFailure("settings.watched_scan_decision_invalid", "retain decision is invalid");
        }
        return;
    }
    if (decision.action === "include_observed" || decision.action === "exclude_observed") {
        const keys =
            decision.action === "include_observed"
                ? ["action", "sourceRef", "agentRuntimeIds", "binding"]
                : ["action", "sourceRef", "agentRuntimeIds"];
        if (!hasExactKeys(decision, keys)) {
            throw new WatchedScanFailure("settings.watched_scan_decision_invalid", "observed decision is invalid");
        }
        validateSourceRef(decision.sourceRef);
        canonicalRuntimeIds(decision.agentRuntimeIds);
        if (decision.action === "include_observed") validateBinding(decision.binding);
        return;
    }
    if (decision.action === "include_user_selected_root") {
        if (!hasExactKeys(decision, ["action", "environment", "adapterId", "agentRuntimeIds", "directoryRootPath", "binding"])) {
            throw new WatchedScanFailure("settings.watched_scan_decision_invalid", "user-root decision is invalid");
        }
        requireNonBlank(decision.adapterId, "adapterId");
        canonicalRuntimeIds(decision.agentRuntimeIds);
        validateBinding(decision.binding);
        return;
    }
    throw new WatchedScanFailure("settings.watched_scan_decision_invalid", "decision action is invalid");
}

function validateSourceRef(sourceRef: WatchedProbeSourceRefV1): void {
    if (!isStrictObject(sourceRef) || !hasExactKeys(sourceRef, ["adapterId", "platformContext", "sourceRootId"])) {
        throw new WatchedScanFailure("settings.watched_scan_source_ref_invalid", "sourceRef is not strict");
    }
    requireNonBlank(sourceRef.adapterId, "sourceRef.adapterId");
    requireNonBlank(sourceRef.sourceRootId, "sourceRef.sourceRootId");
    if (
        !isStrictObject(sourceRef.platformContext) ||
        !hasExactKeys(sourceRef.platformContext, ["platform", "platformInstanceId", "accessRootPath"]) ||
        !isSupportedPlatform(sourceRef.platformContext.platform) ||
        typeof sourceRef.platformContext.platformInstanceId !== "string" ||
        sourceRef.platformContext.platformInstanceId.trim().length === 0 ||
        sourceRef.platformContext.platformInstanceId.includes("\0") ||
        typeof sourceRef.platformContext.accessRootPath !== "string" ||
        !isCanonicalPhysicalAccessPath(sourceRef.platformContext.accessRootPath)
    ) {
        throw new WatchedScanFailure("settings.watched_scan_source_ref_invalid", "sourceRef platformContext is invalid");
    }
}

function isSupportedPlatform(value: unknown): value is Platform {
    return value === "win32" || value === "darwin" || value === "linux" || value === "wsl";
}

function validateBinding(value: unknown): void {
    if (!isStrictObject(value)) throw new WatchedScanFailure("settings.watched_scan_binding_invalid", "binding is invalid");
    if (value.assetScope === "global" && hasExactKeys(value, ["assetScope"])) return;
    if (value.assetScope === "project" && hasExactKeys(value, ["assetScope", "projectId"]) && isUuidV4(value.projectId)) return;
    throw new WatchedScanFailure("settings.watched_scan_binding_invalid", "binding is invalid");
}

function requireRequestHeader(value: {
    expectedRevision: number;
    expectedSettingFingerprint: string;
    userActionId: string;
}): void {
    if (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 0) {
        throw new WatchedScanFailure("settings.watched_scan_revision_invalid", "expectedRevision is invalid");
    }
    if (!isSha256Digest(value.expectedSettingFingerprint)) {
        throw new WatchedScanFailure("settings.watched_scan_fingerprint_invalid", "expected fingerprint is invalid");
    }
    requireNonBlank(value.userActionId, "userActionId");
}

function requireCas(current: WatchedScanIntentV1, revision: number, fingerprint: string): void {
    if (current.revision !== revision || current.settingFingerprint !== fingerprint) {
        throw new WatchedScanFailure("settings.watched_scan_cas_mismatch", "watched-scan intent CAS mismatch");
    }
}

function requireUniqueDecision(keys: Set<string>, key: string): void {
    if (keys.has(key)) {
        throw new WatchedScanFailure("settings.watched_scan_decision_duplicate", "watched-scan decisions must be unique");
    }
    keys.add(key);
}

function requireNonBlank(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
        throw new WatchedScanFailure("settings.watched_scan_text_invalid", `${label} must be non-blank`);
    }
}

function acquireSettingsLock(authorityLocksRoot: string): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "settings", ["settings"]);
    if (release === null) {
        throw new WatchedScanFailure("settings.watched_scan_locked", "settings authority is locked", "unavailable", true);
    }
    return release;
}

function environmentKey(environment: WatchedEnvironmentSelectorV1): string {
    return `${environment.platform}\0${environment.platformInstanceId}`;
}

function probeKey(adapterId: AdapterId, context: PlatformContext): string {
    return `${adapterId}\0${context.platform}\0${context.platformInstanceId}\0${context.accessRootPath}`;
}

function failed(error: unknown): CoreResult<WatchedScanIntentV1> {
    if (error instanceof CoreMutationScopeError) {
        return {
            status: "failed",
            value: undefined as unknown as WatchedScanIntentV1,
            diagnostics: [diagnostic(error.code, error.message, "unavailable", true)],
        };
    }
    if (error instanceof WatchedScanFailure) {
        return {
            status: "failed",
            value: undefined as unknown as WatchedScanIntentV1,
            diagnostics: [diagnostic(error.code, error.message, error.causeKind, error.retryable)],
        };
    }
    const message = String(error);
    return {
        status: "failed",
        value: undefined as unknown as WatchedScanIntentV1,
        diagnostics: [
            diagnostic(
                "settings.watched_scan_invalid",
                message,
                message.includes("fingerprint") || message.includes("fields") ? "invalid_schema" : "internal_error",
                false,
            ),
        ],
    };
}

function diagnostic(
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    retryable: boolean,
): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message,
        path: "",
        traceId: "",
        operation: "settings",
        causeKind,
        retryable,
        suggestedActions: retryable ? ["retry"] : [],
        rawSummary: message,
    };
}

class WatchedScanFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
        readonly retryable = false,
    ) {
        super(message);
    }
}
