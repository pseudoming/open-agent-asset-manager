/** Public Project API over strict project.json authority. */

import * as path from "node:path";
import { inspectDirectoryNoFollow, inventoryDirectoryNoFollow, SafeFilesystemError } from "@oaam/shared/filesystem";
import type { Database } from "better-sqlite3";
import { readAssetManifest } from "../catalog/asset-manifest";
import {
    acquireProjectAuthorityLocks,
    acquireProjectCatalogLock,
    inventoryProjectAuthorityIds,
    projectManifestAuthorityFingerprint,
    readProjectManifest,
    writeProjectManifest,
} from "../catalog/project-authority";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";
import { acquireAllLocks, computeDeploymentOperationKey } from "../foundation/physical-path-locks";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isUuidV4 } from "../foundation/validators";
import { listDeploymentAssets, listDeployments, upsertProjectIndex } from "../persistence/state-db";
import type {
    CommitProjectLifecycleInputV1,
    CoreResult,
    OperationDiagnostic,
    ProjectApi,
    ProjectLifecycleApi,
    ProjectLifecyclePreparationV1,
    ProjectManifestV1,
    UuidV4,
} from "../types";

export interface CoreProjectServiceConfiguration {
    projectsRoot: string;
    assetsRoot: string;
    authorityLocksRoot: string;
    transactionsRoot: string;
    db: Database;
    assertMutationScope(scope: { assetIds: UuidV4[]; settingsAuthority: boolean }): void;
    now(): number;
    newUuid(): UuidV4;
}

interface CoreProjectServiceTestHooks {
    afterExistingProjectLockAcquired?(projectId: UuidV4): void;
}

export function createCoreProjectService(configuration: CoreProjectServiceConfiguration): ProjectApi & ProjectLifecycleApi {
    return createCoreProjectServiceInternal(configuration, {});
}

/** Test-only action-time fault seam; production composition must not import this. */
export function createCoreProjectServiceForTest(
    configuration: CoreProjectServiceConfiguration,
    hooks: CoreProjectServiceTestHooks,
): ProjectApi & ProjectLifecycleApi {
    return createCoreProjectServiceInternal(configuration, hooks);
}

function createCoreProjectServiceInternal(
    configuration: CoreProjectServiceConfiguration,
    hooks: CoreProjectServiceTestHooks,
): ProjectApi & ProjectLifecycleApi {
    const service: ProjectApi & ProjectLifecycleApi = {
        registerProject(sourceInput) {
            return run("project", () => {
                const input = structuredClone(sourceInput);
                requireAccessibleProjectRoot(input.rootPath);
                const displayName = input.displayName ?? "";
                if (displayName.length > 0 && displayName.trim().length === 0) {
                    throw new Error("displayName may be empty but not blank");
                }
                configuration.assertMutationScope({ assetIds: [], settingsAuthority: false });
                const releaseCatalog = acquireProjectCatalogLock(configuration.authorityLocksRoot);
                try {
                    const existing = readAllProjectManifests(configuration.projectsRoot).filter(
                        (manifest) => manifest.rootPath === input.rootPath,
                    );
                    if (existing.length > 1) {
                        throw new Error("multiple Project authorities claim the same rootPath");
                    }
                    if (existing[0] !== undefined) {
                        const projectId = existing[0].projectId;
                        const releaseProject = acquireProjectAuthorityLocks(configuration.authorityLocksRoot, [projectId]);
                        try {
                            hooks.afterExistingProjectLockAcquired?.(projectId);
                            const current = readProjectManifest(configuration.projectsRoot, projectId);
                            if (current === null || current.rootPath !== input.rootPath) {
                                throw new Error("Project authority changed during registration");
                            }
                            if (current.deleted) throw new Error("registered Project is deleted");
                            configuration.assertMutationScope({
                                assetIds: [],
                                settingsAuthority: false,
                            });
                            return projectWithProjection(configuration, current);
                        } finally {
                            releaseProject();
                        }
                    }
                    const projectId = requireGeneratedUuid(configuration.newUuid());
                    if (readProjectManifest(configuration.projectsRoot, projectId) !== null) {
                        throw new Error("generated projectId already exists");
                    }
                    const now = configuration.now();
                    const manifest: ProjectManifestV1 = {
                        schemaVersion: 1,
                        projectId,
                        rootPath: input.rootPath,
                        displayName,
                        deleted: false,
                        createdAt: now,
                        updatedAt: now,
                    };
                    const releaseProject = acquireProjectAuthorityLocks(configuration.authorityLocksRoot, [projectId]);
                    try {
                        writeProjectManifest(configuration.projectsRoot, manifest);
                    } finally {
                        releaseProject();
                    }
                    return projectWithProjection(configuration, manifest);
                } finally {
                    releaseCatalog();
                }
            });
        },
        getProject(projectId) {
            return run("project", () => {
                requireProjectId(projectId);
                const manifest = readProjectManifest(configuration.projectsRoot, projectId);
                return {
                    found: manifest !== null,
                    ...(manifest === null ? {} : { value: manifest }),
                };
            });
        },
        listProjects(filter = {}) {
            try {
                const diagnostics: OperationDiagnostic[] = [];
                const manifests = inventoryProjectAuthorityIds(configuration.projectsRoot).flatMap((entryName) => {
                    if (!isUuidV4(entryName)) {
                        diagnostics.push(
                            diagnostic(
                                "project.authority_entry_invalid",
                                `ignored non-UUID Project authority directory: ${entryName}`,
                                "partial",
                            ),
                        );
                        return [];
                    }
                    try {
                        const manifest = readProjectManifest(configuration.projectsRoot, entryName);
                        return manifest === null ? [] : [manifest];
                    } catch (error) {
                        diagnostics.push(
                            diagnostic(
                                "project.authority_invalid",
                                `ignored invalid Project authority ${entryName}: ${String(error)}`,
                                "partial",
                            ),
                        );
                        return [];
                    }
                });
                const value = manifests
                    .filter((manifest) => filter.includeDeleted || !manifest.deleted)
                    .sort((left, right) => compareUtf8Bytes(left.projectId, right.projectId));
                return {
                    status: diagnostics.length === 0 ? "complete" : "partial",
                    value,
                    diagnostics,
                } as CoreResult<ProjectManifestV1[]>;
            } catch (error) {
                return failed(error, "project");
            }
        },
        inspectProjectLifecycle(sourceInput) {
            return run("project", () => {
                const input = structuredClone(sourceInput);
                requireProjectId(input.projectId);
                const current = readProjectManifest(configuration.projectsRoot, input.projectId);
                if (current === null) throw new Error("Project not found");
                switch (input.action) {
                    case "rename":
                        if (current.deleted) throw new Error("deleted Project cannot be renamed");
                        requireProjectDisplayName(input.nextDisplayName);
                        if (current.displayName === input.nextDisplayName) {
                            throw new Error("Project displayName is unchanged");
                        }
                        return {
                            schemaVersion: 1,
                            action: "rename",
                            projectId: current.projectId,
                            projectAuthorityFingerprint: projectManifestAuthorityFingerprint(current),
                            rootPath: current.rootPath,
                            currentDisplayName: current.displayName,
                            nextDisplayName: input.nextDisplayName,
                        } satisfies ProjectLifecyclePreparationV1;
                    case "rebind": {
                        if (current.deleted) throw new Error("deleted Project cannot be rebound");
                        requireAccessibleProjectRoot(input.nextRootPath);
                        if (current.rootPath === input.nextRootPath) throw new Error("Project rootPath is unchanged");
                        const owner = resolveActiveProjectIdByRoot(configuration.projectsRoot, input.nextRootPath);
                        if (owner !== null && owner !== current.projectId) {
                            throw new Error("destination rootPath belongs to another active Project");
                        }
                        return {
                            schemaVersion: 1,
                            action: "rebind",
                            projectId: current.projectId,
                            projectAuthorityFingerprint: projectManifestAuthorityFingerprint(current),
                            displayName: current.displayName,
                            currentRootPath: current.rootPath,
                            nextRootPath: input.nextRootPath,
                        } satisfies ProjectLifecyclePreparationV1;
                    }
                    case "restore":
                        if (!current.deleted) throw new Error("active Project cannot be restored");
                        return {
                            schemaVersion: 1,
                            action: "restore",
                            projectId: current.projectId,
                            projectAuthorityFingerprint: projectManifestAuthorityFingerprint(current),
                            displayName: current.displayName,
                            rootPath: current.rootPath,
                            rootAccessState: projectRootAccessState(current.rootPath),
                        } satisfies ProjectLifecyclePreparationV1;
                    case "stop_managing":
                        if (current.deleted) throw new Error("deleted Project is not actively managed");
                        return {
                            schemaVersion: 1,
                            action: "stop_managing",
                            projectId: current.projectId,
                            projectAuthorityFingerprint: projectManifestAuthorityFingerprint(current),
                            displayName: current.displayName,
                            rootPath: current.rootPath,
                        } satisfies ProjectLifecyclePreparationV1;
                    default:
                        throw new Error("Project lifecycle action is unsupported");
                }
            });
        },
        commitProjectLifecycle(sourceInput) {
            return run("project", () => {
                const input = structuredClone(sourceInput);
                requireProjectLifecycleCommitInput(input);
                const { preparation } = input;
                if (preparation.action === "stop_managing") {
                    const releaseCatalog = acquireProjectCatalogLock(configuration.authorityLocksRoot);
                    try {
                        const releaseProject = acquireProjectAuthorityLocks(configuration.authorityLocksRoot, [
                            preparation.projectId,
                        ]);
                        try {
                            const current = readProjectManifest(configuration.projectsRoot, preparation.projectId);
                            if (current === null) throw new Error("Project not found");
                            if (current.deleted) throw new Error("deleted Project is not actively managed");
                            if (projectManifestAuthorityFingerprint(current) !== preparation.projectAuthorityFingerprint) {
                                throw new Error("Project authority changed after review");
                            }
                            if (current.rootPath !== preparation.rootPath || current.displayName !== preparation.displayName) {
                                throw new Error("Project stop-managing review no longer matches authority");
                            }
                            // The Project lock prevents new project-scoped Assets, imports, and
                            // Deployments from appearing after this complete ownership inventory.
                            const deploymentIds = listDeployments(configuration.db, false)
                                .filter((row) => row.projectId === preparation.projectId)
                                .map((row) => row.deploymentId as UuidV4)
                                .sort(compareUtf8Bytes);
                            const assetIds = [
                                ...new Set([
                                    ...projectAssetIds(configuration.assetsRoot, preparation.projectId),
                                    ...deploymentIds.flatMap((deploymentId) =>
                                        listDeploymentAssets(configuration.db, deploymentId, false).map(
                                            (row) => row.assetId as UuidV4,
                                        ),
                                    ),
                                ]),
                            ].sort(compareUtf8Bytes);
                            const releaseAssets = acquireAssetLocks(configuration.authorityLocksRoot, assetIds);
                            try {
                                const operationLocks = acquireAllLocks(
                                    configuration.transactionsRoot,
                                    deploymentIds.map(computeDeploymentOperationKey),
                                );
                                if (operationLocks === null) throw new Error("Project Deployment is busy");
                                try {
                                    configuration.assertMutationScope({
                                        assetIds,
                                        settingsAuthority: false,
                                    });
                                    const actionTime = readProjectManifest(configuration.projectsRoot, preparation.projectId);
                                    if (
                                        actionTime === null ||
                                        actionTime.deleted ||
                                        projectManifestAuthorityFingerprint(actionTime) !==
                                            preparation.projectAuthorityFingerprint
                                    ) {
                                        throw new Error("Project authority changed during stop managing");
                                    }
                                    const next: ProjectManifestV1 = {
                                        ...actionTime,
                                        deleted: true,
                                        updatedAt: Math.max(actionTime.updatedAt, configuration.now()),
                                    };
                                    writeProjectManifest(configuration.projectsRoot, next);
                                    return projectWithProjection(configuration, next);
                                } finally {
                                    operationLocks.release();
                                }
                            } finally {
                                releaseAssets();
                            }
                        } finally {
                            releaseProject();
                        }
                    } finally {
                        releaseCatalog();
                    }
                }
                if (preparation.action === "restore") {
                    const releaseCatalog = acquireProjectCatalogLock(configuration.authorityLocksRoot);
                    try {
                        const releaseProject = acquireProjectAuthorityLocks(configuration.authorityLocksRoot, [
                            preparation.projectId,
                        ]);
                        try {
                            const current = readProjectManifest(configuration.projectsRoot, preparation.projectId);
                            if (current === null) throw new Error("Project not found");
                            if (!current.deleted) throw new Error("active Project cannot be restored");
                            if (projectManifestAuthorityFingerprint(current) !== preparation.projectAuthorityFingerprint) {
                                throw new Error("Project authority changed after review");
                            }
                            if (
                                current.rootPath !== preparation.rootPath ||
                                current.displayName !== preparation.displayName ||
                                projectRootAccessState(current.rootPath) !== preparation.rootAccessState
                            ) {
                                throw new Error("Project restore review no longer matches authority");
                            }
                            const owner = resolveActiveProjectIdByRoot(configuration.projectsRoot, preparation.rootPath);
                            if (owner !== null) {
                                throw new Error("Project rootPath belongs to another active Project");
                            }
                            configuration.assertMutationScope({ assetIds: [], settingsAuthority: false });
                            const next: ProjectManifestV1 = {
                                ...current,
                                deleted: false,
                                updatedAt: Math.max(current.updatedAt, configuration.now()),
                            };
                            writeProjectManifest(configuration.projectsRoot, next);
                            return projectWithProjection(configuration, next);
                        } finally {
                            releaseProject();
                        }
                    } finally {
                        releaseCatalog();
                    }
                }
                if (preparation.action === "rebind") {
                    const releaseCatalog = acquireProjectCatalogLock(configuration.authorityLocksRoot);
                    try {
                        const releaseProject = acquireProjectAuthorityLocks(configuration.authorityLocksRoot, [
                            preparation.projectId,
                        ]);
                        try {
                            const current = readProjectManifest(configuration.projectsRoot, preparation.projectId);
                            if (current === null) throw new Error("Project not found");
                            if (current.deleted) throw new Error("deleted Project cannot be rebound");
                            if (projectManifestAuthorityFingerprint(current) !== preparation.projectAuthorityFingerprint) {
                                throw new Error("Project authority changed after review");
                            }
                            if (
                                current.rootPath !== preparation.currentRootPath ||
                                current.displayName !== preparation.displayName ||
                                current.rootPath === preparation.nextRootPath
                            ) {
                                throw new Error("Project rebind review no longer matches authority");
                            }
                            requireAccessibleProjectRoot(preparation.nextRootPath);
                            const owner = resolveActiveProjectIdByRoot(configuration.projectsRoot, preparation.nextRootPath);
                            if (owner !== null) {
                                throw new Error("destination rootPath belongs to another active Project");
                            }
                            configuration.assertMutationScope({ assetIds: [], settingsAuthority: false });
                            const next: ProjectManifestV1 = {
                                ...current,
                                rootPath: preparation.nextRootPath,
                                updatedAt: Math.max(current.updatedAt, configuration.now()),
                            };
                            writeProjectManifest(configuration.projectsRoot, next);
                            return projectWithProjection(configuration, next);
                        } finally {
                            releaseProject();
                        }
                    } finally {
                        releaseCatalog();
                    }
                }
                const releaseProject = acquireProjectAuthorityLocks(configuration.authorityLocksRoot, [preparation.projectId]);
                try {
                    const current = readProjectManifest(configuration.projectsRoot, preparation.projectId);
                    if (current === null) throw new Error("Project not found");
                    if (current.deleted) throw new Error("deleted Project cannot be renamed");
                    if (projectManifestAuthorityFingerprint(current) !== preparation.projectAuthorityFingerprint) {
                        throw new Error("Project authority changed after review");
                    }
                    if (
                        current.rootPath !== preparation.rootPath ||
                        current.displayName !== preparation.currentDisplayName ||
                        current.displayName === preparation.nextDisplayName
                    ) {
                        throw new Error("Project rename review no longer matches authority");
                    }
                    configuration.assertMutationScope({ assetIds: [], settingsAuthority: false });
                    const next: ProjectManifestV1 = {
                        ...current,
                        displayName: preparation.nextDisplayName,
                        updatedAt: Math.max(current.updatedAt, configuration.now()),
                    };
                    writeProjectManifest(configuration.projectsRoot, next);
                    return projectWithProjection(configuration, next);
                } finally {
                    releaseProject();
                }
            });
        },
    };
    return Object.freeze(service);
}

function requireProjectLifecycleCommitInput(input: CommitProjectLifecycleInputV1): void {
    if (
        typeof input.userActionId !== "string" ||
        input.userActionId.length === 0 ||
        input.userActionId.trim() !== input.userActionId ||
        input.userActionId.includes("\0")
    ) {
        throw new Error("userActionId must be non-empty canonical text");
    }
    const preparation = input.preparation;
    if (
        preparation.schemaVersion !== 1 ||
        !isUuidV4(preparation.projectId) ||
        !/^sha256:[0-9a-f]{64}$/u.test(preparation.projectAuthorityFingerprint)
    ) {
        throw new Error("Project lifecycle preparation is invalid");
    }
    switch (preparation.action) {
        case "rename":
            if (!pathIsCanonicalAbsolute(preparation.rootPath)) {
                throw new Error("Project lifecycle preparation is invalid");
            }
            requireProjectDisplayName(preparation.currentDisplayName);
            requireProjectDisplayName(preparation.nextDisplayName);
            return;
        case "rebind":
            requireProjectDisplayName(preparation.displayName);
            if (
                !pathIsCanonicalAbsolute(preparation.currentRootPath) ||
                !pathIsCanonicalAbsolute(preparation.nextRootPath) ||
                preparation.currentRootPath === preparation.nextRootPath
            ) {
                throw new Error("Project lifecycle preparation is invalid");
            }
            return;
        case "restore":
            requireProjectDisplayName(preparation.displayName);
            if (
                !pathIsCanonicalAbsolute(preparation.rootPath) ||
                (preparation.rootAccessState !== "available" && preparation.rootAccessState !== "unavailable")
            ) {
                throw new Error("Project lifecycle preparation is invalid");
            }
            return;
        case "stop_managing":
            requireProjectDisplayName(preparation.displayName);
            if (!pathIsCanonicalAbsolute(preparation.rootPath)) {
                throw new Error("Project lifecycle preparation is invalid");
            }
            return;
        default:
            throw new Error("Project lifecycle preparation is invalid");
    }
}

function requireProjectDisplayName(value: string): void {
    if (typeof value !== "string" || (value.length > 0 && value.trim().length === 0) || value.includes("\0")) {
        throw new Error("displayName may be empty but not blank or NUL-bearing");
    }
}

export function resolveActiveProjectIdByRoot(projectsRoot: string, rootPath: string): UuidV4 | null {
    const matches = readAllProjectManifests(projectsRoot).filter(
        (manifest) => !manifest.deleted && manifest.rootPath === rootPath,
    );
    if (matches.length > 1) throw new Error("multiple active Projects claim the same rootPath");
    return matches[0]?.projectId ?? null;
}

function readAllProjectManifests(projectsRoot: string): ProjectManifestV1[] {
    return inventoryProjectAuthorityIds(projectsRoot).map((projectId) => {
        if (!isUuidV4(projectId)) throw new Error(`invalid Project authority directory: ${projectId}`);
        const manifest = readProjectManifest(projectsRoot, projectId);
        if (manifest === null) throw new Error(`Project authority is missing: ${projectId}`);
        return manifest;
    });
}

function projectWithProjection(
    configuration: CoreProjectServiceConfiguration,
    manifest: ProjectManifestV1,
): CoreResult<ProjectManifestV1> {
    try {
        upsertProjectIndex(configuration.db, {
            projectId: manifest.projectId,
            rootPath: manifest.rootPath,
            displayName: manifest.displayName,
            deleted: manifest.deleted ? 1 : 0,
            createdAt: manifest.createdAt,
            updatedAt: manifest.updatedAt,
        });
        return completeResult(manifest);
    } catch (error) {
        return {
            status: "partial",
            value: manifest,
            diagnostics: [
                diagnostic(
                    "project.index_projection_failed",
                    `Project authority committed but index projection failed: ${String(error)}`,
                    "partial",
                ),
            ],
        };
    }
}

function projectAssetIds(assetsRoot: string, projectId: UuidV4): UuidV4[] {
    try {
        return inventoryDirectoryNoFollow(assetsRoot).entries.flatMap((entry) => {
            if (entry.relativeName === ".staging") {
                if (entry.identity.entryKind !== "directory") {
                    throw new Error("Asset staging authority must be a directory");
                }
                return [];
            }
            if (entry.identity.entryKind !== "directory" || !isUuidV4(entry.relativeName)) {
                throw new Error(`unexpected entry in Asset authority inventory: ${entry.relativeName}`);
            }
            const manifest = readAssetManifest(assetsRoot, entry.relativeName);
            if (manifest === null) {
                throw new Error(`Asset authority is missing: ${entry.relativeName}`);
            }
            return manifest?.scope === "project" && manifest.projectId === projectId ? [manifest.assetId] : [];
        });
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
}

function acquireAssetLocks(authorityLocksRoot: string, assetIds: readonly UuidV4[]): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "assets", [...new Set(assetIds)].sort(compareUtf8Bytes));
    if (release === null) throw new Error("Project Asset authority is locked");
    return release;
}

function requireAccessibleProjectRoot(rootPath: string): void {
    if (rootPath.length === 0 || rootPath.includes("\0") || !pathIsCanonicalAbsolute(rootPath)) {
        throw new ProjectRootAccessError(
            rootPath,
            "project.root_invalid",
            "invalid_schema",
            "rootPath must be a canonical non-root absolute path",
        );
    }
    try {
        inspectDirectoryNoFollow(rootPath);
    } catch (error) {
        if (error instanceof SafeFilesystemError) throw projectRootAccessError(rootPath, error);
        throw error;
    }
}

function projectRootAccessState(rootPath: string): "available" | "unavailable" {
    try {
        inspectDirectoryNoFollow(rootPath);
        return "available";
    } catch {
        return "unavailable";
    }
}

class ProjectRootAccessError extends Error {
    public readonly diagnosticCode: string;
    public readonly causeKind: OperationDiagnostic["causeKind"];
    public readonly rootPath: string;

    public constructor(rootPath: string, diagnosticCode: string, causeKind: OperationDiagnostic["causeKind"], message: string) {
        super(message);
        this.name = "ProjectRootAccessError";
        this.diagnosticCode = diagnosticCode;
        this.causeKind = causeKind;
        this.rootPath = rootPath;
    }
}

function projectRootAccessError(rootPath: string, error: SafeFilesystemError): ProjectRootAccessError {
    switch (error.failureKind) {
        case "not_found":
            return new ProjectRootAccessError(rootPath, "project.root_not_found", "not_found", error.message);
        case "permission_denied":
            return new ProjectRootAccessError(rootPath, "project.root_permission_denied", "permission_denied", error.message);
        case "symlink_or_reparse":
            return new ProjectRootAccessError(rootPath, "project.root_is_link", "invalid_schema", error.message);
        case "wrong_entry_type":
            return new ProjectRootAccessError(rootPath, "project.root_not_directory", "invalid_schema", error.message);
        case "stale":
            return new ProjectRootAccessError(rootPath, "project.root_changed", "verification_failed", error.message);
        case "invalid_path":
            return new ProjectRootAccessError(rootPath, "project.root_invalid", "invalid_schema", error.message);
        case "resource_limit":
        case "unsupported_platform":
        case "io_error":
            return new ProjectRootAccessError(rootPath, "project.root_unavailable", "unavailable", error.message);
    }
}

function pathIsCanonicalAbsolute(value: string): boolean {
    return (
        path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root && !value.endsWith(path.sep)
    );
}

function requireGeneratedUuid(value: UuidV4): UuidV4 {
    if (!isUuidV4(value)) throw new Error("newUuid returned an invalid UUID v4");
    return value;
}

function requireProjectId(value: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error("projectId must be UUID v4");
}

function run<T>(operation: OperationDiagnostic["operation"], action: () => T | CoreResult<T>): CoreResult<T> {
    try {
        const result = action();
        return isCoreResult(result) ? result : completeResult(result);
    } catch (error) {
        return failed(error, operation);
    }
}

function failed<T>(error: unknown, operation: OperationDiagnostic["operation"]): CoreResult<T> {
    const message = error instanceof Error ? error.message : String(error);
    const projectRootError = error instanceof ProjectRootAccessError ? error : undefined;
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            diagnostic(
                projectRootError?.diagnosticCode ?? `${operation}.operation_failed`,
                message,
                projectRootError?.causeKind ?? "invalid_schema",
                projectRootError?.rootPath ?? "",
            ),
        ],
    };
}

function diagnostic(code: string, message: string, causeKind: OperationDiagnostic["causeKind"], path = ""): OperationDiagnostic {
    return {
        severity: causeKind === "partial" ? "warning" : "error",
        code,
        message,
        path,
        traceId: "",
        operation: "project",
        causeKind,
        retryable: false,
        suggestedActions: [],
        rawSummary: message,
    };
}

function isCoreResult<T>(value: T | CoreResult<T>): value is CoreResult<T> {
    return typeof value === "object" && value !== null && "status" in value && "value" in value;
}
