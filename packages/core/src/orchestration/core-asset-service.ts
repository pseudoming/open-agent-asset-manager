/** Public Asset/Version/Index API over manifest and payload authorities. */

import type {
    AssetApiRead,
    AssetApiWrite,
    AssetKind,
    AssetKindTypeDataV2,
    AssetManifestV1,
    AssetVersionFileContentV2,
    AssetVersionManifestV2,
    CoreResult,
    CreateAssetInput,
    CreateVersionInput,
    IndexApi,
    OperationDiagnostic,
    ReindexInput,
    UuidV4,
    VersionFileInput,
    VersionStatus,
} from "../types";
import { readAssetManifest } from "../catalog/asset-manifest";
import { completeResult } from "../foundation/core-result";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../foundation/fingerprint";
import { binaryPayloadStats, canonicalMediaType, normalizeText, textPayloadStats } from "../catalog/payload-store";
import { reindexAssets as rebuildAssetIndex } from "../catalog/reindex";
import { validateAssetSpecVersionGraph, type AssetSpecVersionNode } from "../specs/registry";
import {
    publishAssetVersion,
    publishInitialAssetVersion,
    readVersionAuthority,
    type VersionAuthorityClosureV1,
} from "../catalog/version-authority";
import { resolvePortableDialectContractRefs } from "../catalog/portable-dialect-authority";
import { listAssetSummaries, queryAssetSummaries } from "../catalog/asset-index-query";
import { copyAssetVersionToLocation } from "./asset-copy-service";
import { createAssetLifecycleOperations } from "./asset-lifecycle-service";
import {
    acquireAssetLocks,
    acquireNewAssetLocks,
    acquireProjectForScope,
    cloneNativePayload,
    cloneRestorationPayload,
    failedOperationResult,
    identityAllocator,
    inventoryAssetIds,
    mutateAsset,
    mutateExistingManifest,
    requireActiveAsset,
    requireUserAction,
    requireUuid,
    requireVersion,
    requireVersionRef,
    validateAssetScope,
    withProjection,
    type CoreAssetServiceConfiguration,
    type CoreAssetServiceTestHooks,
} from "./asset-service-shared";

export type { CoreAssetServiceConfiguration } from "./asset-service-shared";

export function createCoreAssetService(configuration: CoreAssetServiceConfiguration): AssetApiRead & AssetApiWrite & IndexApi {
    return createCoreAssetServiceInternal(configuration, {});
}

/** Test-only module-boundary fault injection; production composition must not import this. */
export function createCoreAssetServiceForTest(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
): AssetApiRead & AssetApiWrite & IndexApi {
    return createCoreAssetServiceInternal(configuration, hooks);
}

function createCoreAssetServiceInternal(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
): AssetApiRead & AssetApiWrite & IndexApi {
    const lifecycle = createAssetLifecycleOperations(configuration, hooks);
    const service: AssetApiRead & AssetApiWrite & IndexApi = {
        getAsset(assetId) {
            return run("asset", () => {
                requireUuid(assetId, "assetId");
                const manifest = readAssetManifest(configuration.assetsRoot, assetId);
                return {
                    found: manifest !== null,
                    ...(manifest === null ? {} : { value: manifest }),
                };
            });
        },
        listAssets(filter = {}) {
            return run("asset", () => listAssetSummaries(configuration.db, filter));
        },
        getCurrentVersion(assetId) {
            return run("version", () => {
                requireUuid(assetId, "assetId");
                const asset = readAssetManifest(configuration.assetsRoot, assetId);
                if (asset === null) return { found: false };
                const versionId = asset.versionIds.at(-1) as UuidV4;
                const closure = requireVersion(configuration, { assetId, versionId });
                return { found: true, value: publicVersionBundle(closure) };
            });
        },
        getVersion(ref) {
            return run("version", () => {
                requireVersionRef(ref);
                const closure = readVersionAuthority(
                    configuration.assetsRoot,
                    ref.assetId,
                    ref.versionId,
                    configuration.dialectRegistry,
                );
                return {
                    found: closure !== null,
                    ...(closure === null ? {} : { value: publicVersionBundle(closure) }),
                };
            });
        },
        listVersions(assetId) {
            return run("version", () => {
                requireUuid(assetId, "assetId");
                const asset = readAssetManifest(configuration.assetsRoot, assetId);
                if (asset === null) return [];
                return asset.versionIds.map(
                    (versionId) =>
                        requireVersion(configuration, {
                            assetId,
                            versionId: versionId as UuidV4,
                        }).manifest,
                );
            });
        },
        createAsset(sourceInput) {
            return mutateAsset(configuration, [], "asset", () => {
                const input = structuredClone(sourceInput) as CreateAssetInput;
                validateAssetScope(configuration.projectsRoot, input);
                const ids = identityAllocator(configuration.newUuid);
                const assetId = ids.next("assetId");
                const versionId = ids.next("versionId");
                const createdAt = configuration.now();
                const version = buildUserVersion(configuration, {
                    assetId,
                    versionId,
                    revision: 1,
                    kind: input.kind,
                    scope: input.scope,
                    projectId: input.projectId,
                    scopePath: input.scopePath,
                    parent: null,
                    input: input.initialVersion,
                    createdAt,
                    ids,
                });
                const asset: AssetManifestV1 = {
                    schemaVersion: 1,
                    assetId,
                    kind: input.kind,
                    scope: input.scope,
                    projectId: input.projectId,
                    scopePath: input.scopePath,
                    displayName: input.displayName,
                    displayDescription: input.displayDescription ?? "",
                    versionIds: [versionId],
                    deleted: false,
                    createdAt,
                    updatedAt: createdAt,
                };
                const releaseProject = acquireProjectForScope(configuration, input.scope, input.projectId);
                try {
                    validateAssetScope(configuration.projectsRoot, input);
                    const release = acquireNewAssetLocks(configuration.authorityLocksRoot, [assetId]);
                    try {
                        configuration.assertMutationScope({
                            assetIds: [assetId],
                            settingsAuthority: false,
                        });
                        if (readAssetManifest(configuration.assetsRoot, assetId) !== null) {
                            throw new Error("generated assetId already exists");
                        }
                        publishInitialAssetVersion({
                            assetsRoot: configuration.assetsRoot,
                            transactionId: ids.next("transactionId"),
                            asset,
                            version,
                            dialectRegistry: configuration.dialectRegistry,
                        });
                    } finally {
                        release();
                    }
                } finally {
                    releaseProject();
                }
                return withProjection(configuration, asset, hooks);
            });
        },
        createVersion(assetId, sourceInput) {
            return mutateAsset(configuration, [assetId], "version", () => {
                requireUuid(assetId, "assetId");
                const input = structuredClone(sourceInput) as CreateVersionInput;
                const preliminary = readAssetManifest(configuration.assetsRoot, assetId);
                if (preliminary === null) throw new Error("Asset not found");
                const releaseProject = acquireProjectForScope(configuration, preliminary.scope, preliminary.projectId);
                try {
                    const release = acquireAssetLocks(configuration.authorityLocksRoot, [assetId]);
                    try {
                        configuration.assertMutationScope({
                            assetIds: [assetId],
                            settingsAuthority: false,
                        });
                        const asset = requireActiveAsset(configuration, assetId);
                        const parent = requireVersion(configuration, {
                            assetId,
                            versionId: input.sourceVersionId,
                        });
                        const ids = identityAllocator(configuration.newUuid);
                        const versionId = ids.next("versionId");
                        const version = buildUserVersion(configuration, {
                            assetId,
                            versionId,
                            revision: highestRevision(configuration, asset) + 1,
                            kind: asset.kind,
                            scope: asset.scope,
                            projectId: asset.projectId,
                            scopePath: asset.scopePath,
                            parent,
                            input,
                            createdAt: configuration.now(),
                            ids,
                        });
                        publishAssetVersion({
                            assetsRoot: configuration.assetsRoot,
                            transactionId: ids.next("transactionId"),
                            version,
                            dialectRegistry: configuration.dialectRegistry,
                        });
                        const projected = withProjection(
                            configuration,
                            readAssetManifest(configuration.assetsRoot, assetId) as AssetManifestV1,
                            hooks,
                        );
                        return projected.status === "complete"
                            ? completeResult(version.manifest)
                            : {
                                  status: "partial",
                                  value: version.manifest,
                                  diagnostics: projected.diagnostics,
                              };
                    } finally {
                        release();
                    }
                } finally {
                    releaseProject();
                }
            });
        },
        copyAssetVersionToLocation(sourceInput) {
            return copyAssetVersionToLocation(configuration, hooks, sourceInput);
        },
        updateAssetDisplay(assetId, input) {
            return mutateExistingManifest(configuration, hooks, assetId, true, (asset) => {
                if (asset.deleted) throw new Error("active Asset not found");
                if (input.displayName === undefined && input.displayDescription === undefined) {
                    throw new Error("at least one display field must be supplied");
                }
                return {
                    ...asset,
                    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
                    ...(input.displayDescription === undefined ? {} : { displayDescription: input.displayDescription }),
                    updatedAt: configuration.now(),
                };
            });
        },
        setCurrentVersion(ref) {
            return mutateExistingManifest(configuration, hooks, ref.assetId, true, (asset) => {
                requireUuid(ref.versionId, "versionId");
                if (asset.deleted) throw new Error("active Asset not found");
                if (!asset.versionIds.includes(ref.versionId)) {
                    throw new Error("versionId does not belong to assetId");
                }
                return {
                    ...asset,
                    versionIds: [...asset.versionIds.filter((versionId) => versionId !== ref.versionId), ref.versionId],
                    updatedAt: configuration.now(),
                };
            });
        },
        ...lifecycle,
        queryAssets(input) {
            return run("reindex", () => queryAssetSummaries(configuration.db, input));
        },
        reindexAssets(input?: ReindexInput) {
            return run("reindex", () => {
                const assetIds = input?.assetIds ?? inventoryAssetIds(configuration.assetsRoot);
                for (const assetId of assetIds) requireUuid(assetId, "assetId");
                configuration.assertMutationScope({
                    assetIds: assetIds as UuidV4[],
                    settingsAuthority: false,
                });
                try {
                    return rebuildAssetIndex(configuration.assetsRoot, configuration.db, {
                        assetIds: input?.assetIds,
                        includeDeleted: input?.includeDeleted,
                        dialectRegistry: configuration.dialectRegistry,
                    });
                } finally {
                    configuration.onProjectionChanged?.();
                }
            });
        },
    };
    return Object.freeze(service);
}

function buildUserVersion(
    configuration: CoreAssetServiceConfiguration,
    context: {
        assetId: UuidV4;
        versionId: UuidV4;
        revision: number;
        kind: AssetKind;
        scope: AssetManifestV1["scope"];
        projectId: string;
        scopePath: string;
        parent: VersionAuthorityClosureV1 | null;
        input: CreateVersionInput | CreateAssetInput["initialVersion"];
        createdAt: number;
        ids: ReturnType<typeof identityAllocator>;
    },
): VersionAuthorityClosureV1 {
    requireUserAction(context.input.userActionEvidenceId);
    const canonical = {
        kind: context.kind,
        typeData: structuredClone(context.input.typeData),
    } as AssetKindTypeDataV2;
    const files = context.input.files.map((file) => buildVersionFile(file, context.ids));
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        files.map((file) => file.file),
    );
    const retainedNative =
        context.parent?.manifest.nativeRepresentations.filter(
            (representation) => representation.canonicalContentFingerprint === versionCanonicalContentFingerprint,
        ) ?? [];
    const retainedDialectIds = new Set(retainedNative.map((item) => item.dialectId));
    const nativePayloads =
        context.parent?.nativePayloads.filter((payload) => retainedDialectIds.has(payload.dialectId)).map(cloneNativePayload) ??
        [];
    const restorationPayloads = context.parent?.restorationPayloads.map(cloneRestorationPayload) ?? [];
    const restorationRefs =
        context.parent?.manifest.dialectRestorationPayloads.map((item) => ({
            ...item,
        })) ?? [];
    const provisionalNode = (status: VersionStatus): AssetSpecVersionNode => ({
        versionId: context.versionId,
        scope: context.scope,
        projectId: context.projectId,
        scopePath: context.scopePath,
        status,
        canonical,
        files,
    });
    const derivedStatus = deriveVersionStatus(configuration, provisionalNode);
    if (context.input.status === "complete" && derivedStatus !== "complete") {
        throw new Error("objectively incomplete Version cannot be forced to complete");
    }
    const status = context.input.status ?? derivedStatus;
    const portableDialectContracts = resolvePortableDialectContractRefs(canonical, files, status, configuration.dialectRegistry);
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: context.assetId,
        versionId: context.versionId,
        originKind: "user_created" as const,
        userActionEvidenceId: context.input.userActionEvidenceId,
        promotionRequirement: "not_required" as const,
        createdAt: context.createdAt,
    };
    const manifest: AssetVersionManifestV2 = {
        schemaVersion: 2,
        versionId: context.versionId,
        assetId: context.assetId,
        revision: context.revision,
        fingerprint: computeVersionFingerprint(
            versionCanonicalContentFingerprint,
            retainedNative,
            restorationRefs,
            portableDialectContracts,
        ),
        status,
        diagnostics: structuredClone(context.input.diagnostics ?? []),
        ...canonical,
        files: files.map((file) => file.file),
        changeKind: context.parent === null ? "create" : context.input.changeKind,
        sourceVersionId: context.parent?.manifest.versionId ?? "",
        sourceDeploymentId: context.input.sourceDeploymentId ?? "",
        changeNote: context.input.changeNote ?? "",
        createdAt: context.createdAt,
        versionCanonicalContentFingerprint,
        portableDialectContracts,
        nativeRepresentations: retainedNative,
        dialectRestorationPayloads: restorationRefs,
        originAuthority: {
            ...originPreimage,
            authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
        },
    };
    return { manifest, files, nativePayloads, restorationPayloads };
}

function deriveVersionStatus(
    configuration: CoreAssetServiceConfiguration,
    node: (status: VersionStatus) => AssetSpecVersionNode,
): VersionStatus {
    const complete = node("complete");
    const graph = [...collectVersionNodes(configuration), complete];
    return validateAssetSpecVersionGraph(graph).valid ? "complete" : "incomplete";
}

function collectVersionNodes(configuration: CoreAssetServiceConfiguration): AssetSpecVersionNode[] {
    return inventoryAssetIds(configuration.assetsRoot).flatMap((assetId) => {
        const asset = readAssetManifest(configuration.assetsRoot, assetId);
        if (asset === null) return [];
        return asset.versionIds.map((versionId) => {
            const closure = requireVersion(configuration, {
                assetId,
                versionId: versionId as UuidV4,
            });
            return {
                versionId: closure.manifest.versionId,
                scope: asset.scope,
                projectId: asset.projectId,
                scopePath: asset.scopePath,
                status: closure.manifest.status,
                canonical: {
                    kind: closure.manifest.kind,
                    typeData: closure.manifest.typeData,
                },
                files: closure.files,
            };
        });
    });
}

function buildVersionFile(input: VersionFileInput, ids: ReturnType<typeof identityAllocator>): AssetVersionFileContentV2 {
    const fileId = ids.next("fileId");
    const references = structuredClone(input.references ?? []);
    const mediaType = canonicalMediaType(input.mediaType);
    if (input.contentKind === "binary") {
        const bytes = new Uint8Array(input.bytes);
        const stats = binaryPayloadStats(bytes);
        return {
            contentKind: "binary",
            bytes,
            file: {
                fileId,
                logicalPath: input.logicalPath,
                role: input.role,
                contentHash: stats.contentHash,
                contentKind: "binary",
                mediaType,
                byteSize: stats.byteSize,
                executable: input.executable,
                references,
            },
        };
    }
    const normalized = normalizeText(input.text);
    const stats = textPayloadStats(normalized.normalized);
    return {
        contentKind: "text",
        text: normalized.normalized,
        file: {
            fileId,
            logicalPath: input.logicalPath,
            role: input.role,
            contentHash: stats.contentHash,
            contentKind: "text",
            mediaType,
            byteSize: stats.byteSize,
            executable: input.executable,
            references,
        },
    };
}

function highestRevision(configuration: CoreAssetServiceConfiguration, asset: AssetManifestV1): number {
    return Math.max(
        ...asset.versionIds.map(
            (versionId) =>
                requireVersion(configuration, {
                    assetId: asset.assetId,
                    versionId: versionId as UuidV4,
                }).manifest.revision,
        ),
    );
}

function publicVersionBundle(closure: VersionAuthorityClosureV1) {
    return {
        manifest: structuredClone(closure.manifest),
        files: closure.files.map((file) =>
            file.contentKind === "text"
                ? { ...structuredClone(file), text: file.text }
                : { ...structuredClone(file), bytes: new Uint8Array(file.bytes) },
        ),
    };
}

function run<T>(operation: OperationDiagnostic["operation"], action: () => T): CoreResult<T> {
    try {
        return completeResult(action());
    } catch (error) {
        return failedOperationResult(error, operation);
    }
}
