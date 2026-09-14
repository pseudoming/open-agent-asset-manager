/** Public Deployment catalog API; runtime mutation remains owned by deployment-executor. */

import type { Database } from "better-sqlite3";
import type {
    AgentRuntimeId,
    CoreResult,
    CreateDeploymentInput,
    DeploymentApi,
    DeploymentAssetInput,
    DeploymentFilter,
    DeploymentView,
    OperationDiagnostic,
    Platform,
    UuidV4,
    UpdateDeploymentInputs,
} from "../types";
import { readAssetManifest } from "../catalog/asset-manifest";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";
import { acquireAllLocks, computeDeploymentOperationKey } from "../foundation/physical-path-locks";
import { compareUtf8Bytes } from "../foundation/text-order";
import { serializeAppliedInputsSnapshot, serializeAppliedRenderSnapshotRef } from "../render/deployment-render-authority";
import type { readDeploymentView } from "../deployment/deployment-view";
import { stableStringify } from "../foundation/fingerprint";
import { acquireProjectAuthorityLocks, readProjectManifest } from "../catalog/project-authority";
import {
    getDeployment,
    insertDeployment,
    listDeploymentAssets,
    listDeployments,
    reassignSortOrders,
    softDeleteDeployment as softDeleteDeploymentRow,
    softDeleteDeploymentAsset,
    updateDeployment,
} from "../persistence/state-db";
import { readVersionAuthority, type VersionDialectRegistryV1 } from "../catalog/version-authority";
import { isCanonicalTargetRootPath, isUuidV4 } from "../foundation/validators";

export interface CoreDeploymentCatalogConfiguration {
    db: Database;
    assetsRoot: string;
    projectsRoot: string;
    authorityLocksRoot: string;
    transactionsRoot: string;
    readDeploymentView: typeof readDeploymentView;
    dialectRegistry: VersionDialectRegistryV1;
    assertMutationScope(scope: { assetIds: UuidV4[]; settingsAuthority: boolean }): void;
    now(): number;
    newUuid(): UuidV4;
}

export type CoreDeploymentCatalogSurface = Pick<
    DeploymentApi,
    "createDeployment" | "getDeployment" | "listDeployments" | "updateDeploymentInputs" | "softDeleteDeployment"
>;

interface CoreDeploymentCatalogTestHooks {
    afterOperationLockAcquired?(deploymentId: UuidV4): void;
    beforeMutationReadback?(deploymentId: UuidV4): void;
}

export function createCoreDeploymentCatalogService(
    configuration: CoreDeploymentCatalogConfiguration,
): CoreDeploymentCatalogSurface {
    return createCoreDeploymentCatalogServiceInternal(configuration, {});
}

/** Test-only module-boundary fault injection; production composition must not import this. */
export function createCoreDeploymentCatalogServiceForTest(
    configuration: CoreDeploymentCatalogConfiguration,
    hooks: CoreDeploymentCatalogTestHooks,
): CoreDeploymentCatalogSurface {
    return createCoreDeploymentCatalogServiceInternal(configuration, hooks);
}

function createCoreDeploymentCatalogServiceInternal(
    configuration: CoreDeploymentCatalogConfiguration,
    hooks: CoreDeploymentCatalogTestHooks,
): CoreDeploymentCatalogSurface {
    const service: CoreDeploymentCatalogSurface = {
        createDeployment(sourceInput) {
            return run("deploy", () => {
                const input = normalizeDeploymentInput(sourceInput);
                const projectRelease = acquireDeploymentProjectLock(configuration, input.projectId);
                try {
                    requireActiveProject(configuration, input.projectId);
                    const deploymentId = configuration.newUuid();
                    requireUuid(deploymentId, "new deploymentId");
                    const releaseAssets = acquireAssetLocks(
                        configuration.authorityLocksRoot,
                        input.assets.map((asset) => asset.assetId),
                    );
                    try {
                        configuration.assertMutationScope({
                            assetIds: input.assets.map((asset) => asset.assetId),
                            settingsAuthority: false,
                        });
                        const operationLock = acquireAllLocks(configuration.transactionsRoot, [
                            computeDeploymentOperationKey(deploymentId),
                        ]);
                        if (operationLock === null) {
                            throw new Error("generated Deployment is locked");
                        }
                        try {
                            if (getDeployment(configuration.db, deploymentId) !== null) {
                                throw new Error("generated deploymentId already exists");
                            }
                            validateDeploymentAssets(configuration, input.projectId, input.assets);
                            const now = configuration.now();
                            return configuration.db.transaction(() => {
                                insertDeployment(configuration.db, {
                                    deploymentId,
                                    consumerAgentRuntimeIds: JSON.stringify(input.consumerAgentRuntimeIds),
                                    platform: input.platform,
                                    platformInstanceId: input.platformInstanceId,
                                    targetRootPath: input.targetRootPath,
                                    projectId: input.projectId,
                                    committedTransactionId: "",
                                    appliedInputsSnapshot: serializeAppliedInputsSnapshot({
                                        schemaVersion: 1,
                                        deploymentId,
                                        consumerAgentRuntimeIds: input.consumerAgentRuntimeIds,
                                        assets: [],
                                    }),
                                    appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                                        snapshotState: "never",
                                    }),
                                    observationState: "never",
                                    observationAttemptedAt: 0,
                                    lastCompleteObservationAt: 0,
                                    blockingEvidence: stableStringify(emptyBlockingEvidence()),
                                    deleted: 0,
                                    createdAt: now,
                                    updatedAt: now,
                                });
                                replaceDeploymentAssets(configuration.db, deploymentId, input.assets, now);
                                hooks.beforeMutationReadback?.(deploymentId);
                                return requireDeploymentView(configuration, deploymentId);
                            })();
                        } finally {
                            operationLock.release();
                        }
                    } finally {
                        releaseAssets();
                    }
                } finally {
                    projectRelease();
                }
            });
        },
        getDeployment(deploymentId) {
            return run("deploy", () => {
                requireUuid(deploymentId, "deploymentId");
                const value = configuration.readDeploymentView({
                    db: configuration.db,
                    transactionsRoot: configuration.transactionsRoot,
                    deploymentId,
                });
                return { found: value !== null, ...(value === null ? {} : { value }) };
            });
        },
        listDeployments(filter = {}) {
            return run("deploy", () => listDeploymentViews(configuration, filter));
        },
        updateDeploymentInputs(deploymentId, sourceInput) {
            return mutateDeployment(configuration, hooks, deploymentId, sourceInput, false);
        },
        softDeleteDeployment(deploymentId) {
            return mutateDeployment(configuration, hooks, deploymentId, {}, true);
        },
    };
    return Object.freeze(service);
}

function mutateDeployment(
    configuration: CoreDeploymentCatalogConfiguration,
    hooks: CoreDeploymentCatalogTestHooks,
    deploymentId: UuidV4,
    sourceInput: UpdateDeploymentInputs,
    deleteDeployment: boolean,
): CoreResult<DeploymentView> {
    return run("deploy", () => {
        requireUuid(deploymentId, "deploymentId");
        const preliminary = getDeployment(configuration.db, deploymentId);
        if (preliminary === null) throw new Error("Deployment not found");
        if (preliminary.deleted === 1) {
            if (deleteDeployment) return requireDeploymentView(configuration, deploymentId);
            throw new Error("active Deployment not found");
        }
        const preliminaryAssets = listDeploymentAssets(configuration.db, deploymentId, false);
        const requestedAssets = sourceInput.assets === undefined ? undefined : normalizeDeploymentAssets(sourceInput.assets);
        const expectedInputs =
            sourceInput.expectedInputs === undefined
                ? undefined
                : {
                      consumerAgentRuntimeIds: normalizeConsumers(sourceInput.expectedInputs.consumerAgentRuntimeIds),
                      assets: normalizeDeploymentAssets(sourceInput.expectedInputs.assets),
                  };
        const lockedAssetIds = [
            ...new Set([
                ...preliminaryAssets.map((asset) => asset.assetId as UuidV4),
                ...(requestedAssets ?? []).map((asset) => asset.assetId),
            ]),
        ].sort(compareUtf8Bytes);
        const projectRelease = acquireDeploymentProjectLock(configuration, preliminary.projectId);
        try {
            // Removing an already inert Deployment remains allowed after its owning Project
            // is soft-deleted. All active input changes still require a live Project.
            if (!deleteDeployment) requireActiveProject(configuration, preliminary.projectId);
            const releaseAssets = acquireAssetLocks(configuration.authorityLocksRoot, lockedAssetIds);
            try {
                const operationLock = acquireAllLocks(configuration.transactionsRoot, [
                    computeDeploymentOperationKey(deploymentId),
                ]);
                if (operationLock === null) throw new Error("Deployment is busy");
                try {
                    hooks.afterOperationLockAcquired?.(deploymentId);
                    const current = getDeployment(configuration.db, deploymentId);
                    if (current === null) throw new Error("Deployment not found");
                    if (current.projectId !== preliminary.projectId) {
                        throw new Error("Deployment Project changed during lock acquisition");
                    }
                    if (current.deleted === 1) {
                        if (deleteDeployment) {
                            return requireDeploymentView(configuration, deploymentId);
                        }
                        throw new Error("active Deployment not found");
                    }
                    const currentAssets = listDeploymentAssets(configuration.db, deploymentId, false);
                    const lockedAssetIdSet = new Set(lockedAssetIds);
                    if (currentAssets.some((asset) => !lockedAssetIdSet.has(asset.assetId as UuidV4))) {
                        throw new Error("Deployment Asset membership changed during lock acquisition; retry");
                    }
                    const nextAssets =
                        requestedAssets ??
                        currentAssets.map((asset) => ({
                            assetId: asset.assetId as UuidV4,
                            versionId: asset.versionId as UuidV4,
                            allowIncomplete: asset.allowIncomplete === 1,
                        }));
                    configuration.assertMutationScope({
                        assetIds: lockedAssetIds,
                        settingsAuthority: false,
                    });
                    return configuration.db.transaction(() => {
                        if (deleteDeployment) {
                            softDeleteDeploymentRow(configuration.db, deploymentId, configuration.now());
                        } else {
                            if (
                                expectedInputs !== undefined &&
                                stableStringify(expectedInputs) !==
                                    stableStringify({
                                        consumerAgentRuntimeIds: parseStoredConsumers(current.consumerAgentRuntimeIds),
                                        assets: currentAssets.map((asset) => ({
                                            assetId: asset.assetId,
                                            versionId: asset.versionId,
                                            allowIncomplete: asset.allowIncomplete === 1,
                                        })),
                                    })
                            ) {
                                throw new DeploymentInputsChangedError(
                                    "The selected Deployment inputs changed; reload before updating",
                                );
                            }
                            validateDeploymentAssets(configuration, current.projectId, nextAssets);
                            const consumers =
                                sourceInput.consumerAgentRuntimeIds === undefined
                                    ? parseStoredConsumers(current.consumerAgentRuntimeIds)
                                    : normalizeConsumers(sourceInput.consumerAgentRuntimeIds);
                            const now = configuration.now();
                            updateDeployment(
                                configuration.db,
                                deploymentId,
                                { consumerAgentRuntimeIds: JSON.stringify(consumers) },
                                now,
                            );
                            if (sourceInput.assets !== undefined) {
                                replaceDeploymentAssets(configuration.db, deploymentId, nextAssets, now);
                            }
                        }
                        hooks.beforeMutationReadback?.(deploymentId);
                        return requireDeploymentView(configuration, deploymentId);
                    })();
                } finally {
                    operationLock.release();
                }
            } finally {
                releaseAssets();
            }
        } finally {
            projectRelease();
        }
    });
}

function normalizeDeploymentInput(input: CreateDeploymentInput): CreateDeploymentInput {
    const cloned = structuredClone(input);
    requireUuidOrEmpty(cloned.projectId, "projectId");
    cloned.consumerAgentRuntimeIds = normalizeConsumers(cloned.consumerAgentRuntimeIds);
    requirePlatform(cloned.platform);
    requireNonBlank(cloned.platformInstanceId, "platformInstanceId");
    if (!isCanonicalTargetRootPath(cloned.targetRootPath, cloned.platform)) {
        throw new Error("targetRootPath must be canonical for platform");
    }
    cloned.assets = normalizeDeploymentAssets(cloned.assets);
    return cloned;
}

function normalizeConsumers(consumers: AgentRuntimeId[]): AgentRuntimeId[] {
    if (
        consumers.length === 0 ||
        consumers.some((value) => value.length === 0 || value !== value.toUpperCase() || value.includes("\0"))
    ) {
        throw new Error("consumerAgentRuntimeIds must contain uppercase non-empty IDs");
    }
    const sorted = [...new Set(consumers)].sort(compareUtf8Bytes);
    if (sorted.length !== consumers.length) {
        throw new Error("consumerAgentRuntimeIds must be unique");
    }
    return sorted;
}

function parseStoredConsumers(json: string): AgentRuntimeId[] {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        throw new Error("stored consumerAgentRuntimeIds are invalid");
    }
    return normalizeConsumers(parsed);
}

function normalizeDeploymentAssets(assets: DeploymentAssetInput[]): DeploymentAssetInput[] {
    const cloned = structuredClone(assets);
    const ids = new Set<string>();
    for (const asset of cloned) {
        requireUuid(asset.assetId, "assetId");
        requireUuid(asset.versionId, "versionId");
        if (typeof asset.allowIncomplete !== "boolean") {
            throw new Error("allowIncomplete must be boolean");
        }
        if (ids.has(asset.assetId)) throw new Error("Deployment Asset IDs must be unique");
        ids.add(asset.assetId);
    }
    return cloned;
}

function validateDeploymentAssets(
    configuration: CoreDeploymentCatalogConfiguration,
    projectId: string,
    assets: readonly DeploymentAssetInput[],
): void {
    for (const input of assets) {
        const asset = readAssetManifest(configuration.assetsRoot, input.assetId);
        if (asset === null || asset.deleted) throw new Error("active Deployment Asset not found");
        if (asset.scope === "project" && asset.projectId !== projectId) {
            throw new Error("project Asset does not belong to the Deployment Project");
        }
        const version = readVersionAuthority(
            configuration.assetsRoot,
            input.assetId,
            input.versionId,
            configuration.dialectRegistry,
        );
        if (version === null) throw new Error("Deployment Version not found in Asset history");
        if (version.manifest.status === "incomplete" && !input.allowIncomplete) {
            throw new Error("incomplete Version requires allowIncomplete=true");
        }
    }
}

function replaceDeploymentAssets(db: Database, deploymentId: UuidV4, assets: readonly DeploymentAssetInput[], now: number): void {
    const info = new Map(
        assets.map((asset) => [asset.assetId, { versionId: asset.versionId, allowIncomplete: asset.allowIncomplete ? 1 : 0 }]),
    );
    reassignSortOrders(
        db,
        deploymentId,
        assets.map((asset) => asset.assetId),
        info,
        now,
    );
    const retained = new Set(assets.map((asset) => asset.assetId));
    for (const current of listDeploymentAssets(db, deploymentId, false)) {
        if (!retained.has(current.assetId as UuidV4)) {
            softDeleteDeploymentAsset(db, deploymentId, current.assetId, now);
        }
    }
}

function listDeploymentViews(configuration: CoreDeploymentCatalogConfiguration, filter: DeploymentFilter): DeploymentView[] {
    return listDeployments(configuration.db, filter.includeDeleted ?? false)
        .filter((row) => filter.projectId === undefined || row.projectId === filter.projectId)
        .map((row) => requireDeploymentView(configuration, row.deploymentId as UuidV4))
        .filter((view) => filter.stage === undefined || view.derivedStatus.stage === filter.stage)
        .sort((left, right) => compareUtf8Bytes(left.deploymentId, right.deploymentId));
}

function requireDeploymentView(configuration: CoreDeploymentCatalogConfiguration, deploymentId: UuidV4): DeploymentView {
    const view = configuration.readDeploymentView({
        db: configuration.db,
        transactionsRoot: configuration.transactionsRoot,
        deploymentId,
    });
    if (view === null) throw new Error("Deployment disappeared after mutation");
    return view;
}

function requireActiveProject(configuration: CoreDeploymentCatalogConfiguration, projectId: string): void {
    if (projectId === "") return;
    const project = readProjectManifest(configuration.projectsRoot, projectId as UuidV4);
    if (project === null || project.deleted) throw new Error("active Deployment Project not found");
}

function acquireDeploymentProjectLock(configuration: CoreDeploymentCatalogConfiguration, projectId: string): () => void {
    if (projectId === "") return () => undefined;
    requireUuid(projectId, "projectId");
    return acquireProjectAuthorityLocks(configuration.authorityLocksRoot, [projectId]);
}

function acquireAssetLocks(authorityLocksRoot: string, assetIds: readonly UuidV4[]): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "assets", [...new Set(assetIds)].sort(compareUtf8Bytes));
    if (release === null) throw new Error("Deployment Asset authority is locked");
    return release;
}

function emptyBlockingEvidence() {
    return {
        schemaVersion: 1 as const,
        reasonCode: "",
        operation: "" as const,
        contextFingerprint: "",
        occurredAt: 0,
        diagnostics: [],
        suggestedActions: [],
        retryable: false,
    };
}

function requirePlatform(value: Platform): void {
    if (value !== "win32" && value !== "darwin" && value !== "linux" && value !== "wsl") {
        throw new Error("platform is invalid");
    }
}

function requireNonBlank(value: string, label: string): void {
    if (value.trim() === "" || value.includes("\0")) throw new Error(`${label} must be non-blank and NUL-free`);
}

function requireUuidOrEmpty(value: string, label: string): void {
    if (value !== "") requireUuid(value, label);
}

function requireUuid(value: string, label: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error(`${label} must be UUID v4`);
}

class DeploymentInputsChangedError extends Error {}

function run<T>(operation: OperationDiagnostic["operation"], action: () => T): CoreResult<T> {
    try {
        return completeResult(action());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const inputsChanged = error instanceof DeploymentInputsChangedError;
        return {
            status: "failed",
            value: undefined as T,
            diagnostics: [
                {
                    severity: "error",
                    code: inputsChanged ? "deploy.inputs_changed" : `${operation}.operation_failed`,
                    message,
                    path: "",
                    traceId: "",
                    operation,
                    causeKind: inputsChanged ? "conflict" : "invalid_schema",
                    retryable: inputsChanged,
                    suggestedActions: [],
                    rawSummary: message,
                },
            ],
        };
    }
}
