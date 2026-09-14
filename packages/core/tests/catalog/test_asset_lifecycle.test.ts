/** Asset lifecycle never cascades and only recycles one exact OAAM owner tree. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAssetManifest, resolveAssetRoot } from "../../src/catalog/asset-manifest";
import { createPromotionGrantAuthority, listRetainedPromotionGrantAuthorities } from "../../src/catalog/promotion-grant-store";
import { createCoreAssetService, createCoreAssetServiceForTest } from "../../src/orchestration/core-asset-service";
import { acquireAssetLocks, acquireNewAssetLocks } from "../../src/orchestration/asset-service-shared";
import { closeDb, getDb } from "../../src/persistence/db";
import {
    getCurrentAssetIndex,
    insertDeployment,
    listCurrentAssetIndex,
    upsertDeploymentAsset,
} from "../../src/persistence/state-db";
import type { AssetPurgePreparationV1, FileReferenceV2, UuidV4 } from "../../src/types";
import { EMPTY_VERSION_DIALECT_REGISTRY, readVersionAuthority } from "../../src/catalog/version-authority";
import { samePhysicalPathIdentity } from "@oaam/shared/filesystem";

const GRANT_ID = "70000000-0000-4000-8000-000000000001" as UuidV4;
const DEPLOYMENT_ID = "70000000-0000-4000-8000-000000000002" as UuidV4;
const MISSING_ASSET_ID = "70000000-0000-4000-8000-000000000003" as UuidV4;
const ORPHAN_ASSET_ID = "70000000-0000-4000-8000-000000000004" as UuidV4;

let sandbox = "";
let assetsRoot = "";
let projectsRoot = "";
let locksRoot = "";
let databasePath = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-asset-lifecycle-"));
    assetsRoot = path.join(sandbox, "oaam", "assets");
    projectsRoot = path.join(sandbox, "oaam", "projects");
    locksRoot = path.join(sandbox, "oaam", "transactions", "authority-locks");
    databasePath = path.join(sandbox, "state.db");
    fs.mkdirSync(path.join(sandbox, "oaam", "transactions"), { recursive: true });
    closeDb();
});

afterEach(() => {
    closeDb();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function identities(start = 1): () => UuidV4 {
    let next = start;
    return () => {
        const suffix = String(next).padStart(12, "0");
        next += 1;
        return `71000000-0000-4000-8000-${suffix}`;
    };
}

function service(hooks: Parameters<typeof createCoreAssetServiceForTest>[1] = {}, newUuid: () => UuidV4 = identities()) {
    return createCoreAssetServiceForTest(
        {
            assetsRoot,
            projectsRoot,
            authorityLocksRoot: locksRoot,
            db: getDb(databasePath),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            assertMutationScope: () => undefined,
            now: () => 1_000,
            newUuid,
        },
        hooks,
    );
}

function guidance(api: ReturnType<typeof service>, displayName = "Lifecycle Guidance", references: FileReferenceV2[] = []) {
    const created = api.createAsset({
        kind: "Guidance",
        scope: "global",
        projectId: "",
        scopePath: "",
        displayName,
        displayDescription: "fixture",
        initialVersion: {
            typeData: { schemaVersion: 1 },
            files: [
                {
                    logicalPath: "AGENTS.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    text: "# Guidance\n",
                    executable: false,
                    references,
                },
            ],
            userActionEvidenceId: "create",
            changeKind: "create",
        },
    });
    expect(created.status, JSON.stringify(created)).toBe("complete");
    return created.value;
}

function memoryUnit(api: ReturnType<typeof service>) {
    const created = api.createAsset({
        kind: "Memory",
        scope: "global",
        projectId: "",
        scopePath: "",
        displayName: "Memory Unit",
        displayDescription: "fixture",
        initialVersion: {
            typeData: {
                schemaVersion: 2,
                entityRole: "unit",
                card: { name: "topic", description: "fixture" },
                loading: { card: "high", body: "low" },
                applicabilityRule: "",
            },
            files: [
                {
                    logicalPath: "topic.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    text: "# Topic\n",
                    executable: false,
                    references: [],
                },
            ],
            userActionEvidenceId: "create",
            changeKind: "create",
        },
    });
    expect(created.status, JSON.stringify(created)).toBe("complete");
    return created.value;
}

function memoryCatalog(api: ReturnType<typeof service>, targetAssetVersionId: UuidV4) {
    const created = api.createAsset({
        kind: "Memory",
        scope: "global",
        projectId: "",
        scopePath: "",
        displayName: "Memory Catalog",
        displayDescription: "fixture",
        initialVersion: {
            typeData: {
                schemaVersion: 2,
                entityRole: "catalog",
                members: [{ targetAssetVersionId, routingTitle: "Topic", routingHint: "fixture" }],
            },
            files: [],
            userActionEvidenceId: "create",
            changeKind: "create",
        },
    });
    expect(created.status, JSON.stringify(created)).toBe("complete");
    return created.value;
}

function softDeleteAndInspect(api: ReturnType<typeof service>, assetId: UuidV4): AssetPurgePreparationV1 {
    expect(api.softDeleteAsset(assetId).status).toBe("complete");
    const inspected = api.inspectAssetPurge(assetId);
    expect(inspected.status, JSON.stringify(inspected)).toBe("complete");
    return inspected.value;
}

function recycleHook(trashName = "recycled-asset") {
    return (
        directoryPath: string,
        expectedIdentity: Parameters<NonNullable<Parameters<typeof service>[0]["recycleDirectoryTreeIfIdentity"]>>[1],
    ) => {
        const actual = fs.statSync(directoryPath, { bigint: true });
        const observed = {
            deviceId: actual.dev.toString(),
            fileId: actual.ino.toString(),
            entryKind: "directory" as const,
        };
        if (!samePhysicalPathIdentity(observed, expectedIdentity)) throw new Error("stale identity in test recycle");
        fs.renameSync(directoryPath, path.join(sandbox, trashName));
        return true;
    };
}

describe("Core Asset lifecycle", () => {
    it("releases the Asset catalog sentinel when an exact owner lock cannot be acquired", () => {
        const lockedAssetId = "70000000-0000-4000-8000-000000000005" as UuidV4;
        const independentAssetId = "70000000-0000-4000-8000-000000000006" as UuidV4;
        const releaseLockedAsset = acquireAssetLocks(locksRoot, [lockedAssetId]);
        try {
            expect(() => acquireNewAssetLocks(locksRoot, [lockedAssetId])).toThrow(/Asset authority is locked/u);
            const releaseIndependentAsset = acquireNewAssetLocks(locksRoot, [independentAssetId]);
            releaseIndependentAsset();
        } finally {
            releaseLockedAsset();
        }
    });

    it("keeps soft-delete reversible and requires an active Project only when restoring", () => {
        const api = service();
        const asset = guidance(api);

        expect(api.inspectAssetPurge(MISSING_ASSET_ID).status).toBe("failed");
        expect(() => listRetainedPromotionGrantAuthorities(assetsRoot, MISSING_ASSET_ID)).toThrow(/Asset not found/u);
        expect(api.restoreAsset(asset.assetId).status).toBe("failed");
        expect(api.inspectAssetPurge(asset.assetId).status).toBe("failed");
        expect(api.softDeleteAsset(asset.assetId).value.deleted).toBe(true);
        expect(api.softDeleteAsset(asset.assetId).value.deleted).toBe(true);
        expect(api.restoreAsset(asset.assetId).value.deleted).toBe(false);
        expect(api.getAsset(asset.assetId).value.value?.assetId).toBe(asset.assetId);
    });

    it("reports Unix-like Trash as unsupported without touching the soft-deleted owner tree", () => {
        const api = createCoreAssetService({
            assetsRoot,
            projectsRoot,
            authorityLocksRoot: locksRoot,
            db: getDb(databasePath),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            assertMutationScope: () => undefined,
            now: () => 1_000,
            newUuid: identities(),
        });
        const asset = guidance(api);
        expect(api.softDeleteAsset(asset.assetId).status).toBe("complete");

        const inspected = api.inspectAssetPurge(asset.assetId);

        expect(inspected.status).toBe("failed");
        expect(inspected.diagnostics[0]?.message).toMatch(/identity-bound Trash is not available/u);
        expect(readAssetManifest(assetsRoot, asset.assetId)).not.toBeNull();
    });

    it("blocks retained Asset references without cascading, then recycles each leaf in dependency order", () => {
        const api = service({
            assertDirectoryTreeRecycleSupported: () => undefined,
            recycleDirectoryTreeIfIdentity: recycleHook(),
        });
        const target = guidance(api, "Target");
        const targetVersionId = target.versionIds[0] as UuidV4;
        const dependent = guidance(api, "Dependent", [
            {
                kind: "include",
                rawTarget: "oaam:target",
                required: true,
                diagnostics: [],
                resolution: "resolved_asset_version",
                targetAssetVersionId: targetVersionId,
            },
        ]);
        expect(api.softDeleteAsset(target.assetId).status).toBe("complete");
        expect(api.inspectAssetPurge(target.assetId).diagnostics[0]?.message).toMatch(/depends on purged Version/u);
        expect(readAssetManifest(assetsRoot, target.assetId)).not.toBeNull();

        const dependentPreparation = softDeleteAndInspect(api, dependent.assetId);
        expect(
            api.purgeAsset({
                preparation: dependentPreparation,
                userActionEvidenceId: "confirm-dependent-purge",
            }).status,
        ).toBe("complete");
        expect(readAssetManifest(assetsRoot, target.assetId)).not.toBeNull();

        const targetPreparation = api.inspectAssetPurge(target.assetId);
        expect(targetPreparation.status).toBe("complete");
    });

    it("blocks handler-owned dependencies instead of only inspecting file references", () => {
        const api = service({ assertDirectoryTreeRecycleSupported: () => undefined });
        const unit = memoryUnit(api);
        memoryCatalog(api, unit.versionIds[0] as UuidV4);
        expect(api.softDeleteAsset(unit.assetId).status).toBe("complete");

        expect(api.inspectAssetPurge(unit.assetId).diagnostics[0]?.message).toMatch(/depends on purged Version/u);
        expect(readAssetManifest(assetsRoot, unit.assetId)).not.toBeNull();
    });

    it("holds the Asset catalog lock so no brand-new owner can appear after dependency inspection starts", () => {
        let createDuringPurge: ReturnType<ReturnType<typeof service>["createAsset"]> | undefined;
        let copyDuringPurge: ReturnType<ReturnType<typeof service>["copyAssetVersionToLocation"]> | undefined;
        let api: ReturnType<typeof service>;
        const hooks: Parameters<typeof service>[0] = {
            assertDirectoryTreeRecycleSupported: () => undefined,
            afterPurgeCatalogLock: () => {
                createDuringPurge = api.createAsset({
                    kind: "Guidance",
                    scope: "global",
                    projectId: "",
                    scopePath: "",
                    displayName: "Concurrent owner",
                    initialVersion: {
                        typeData: { schemaVersion: 1 },
                        files: [
                            {
                                logicalPath: "AGENTS.md",
                                role: "entry",
                                contentKind: "text",
                                mediaType: "text/markdown",
                                text: "# Concurrent\n",
                                executable: false,
                                references: [],
                            },
                        ],
                        userActionEvidenceId: "concurrent-create",
                        changeKind: "create",
                    },
                });
                copyDuringPurge = api.copyAssetVersionToLocation({
                    source: {
                        assetId: sourceClosure.manifest.assetId,
                        versionId: sourceClosure.manifest.versionId,
                        versionFingerprint: sourceClosure.manifest.fingerprint,
                        originAuthorityFingerprint: sourceClosure.manifest.originAuthority.authorityFingerprint,
                    },
                    destination: { scope: "global", projectId: "", scopePath: "" },
                    displayName: "Concurrent copy",
                    displayDescription: "",
                    userActionEvidenceId: "concurrent-copy",
                });
            },
            recycleDirectoryTreeIfIdentity: recycleHook(),
        };
        api = service(hooks);
        const source = guidance(api, "Copy source");
        const sourceClosure = readVersionAuthority(
            assetsRoot,
            source.assetId,
            source.versionIds[0] as UuidV4,
            EMPTY_VERSION_DIALECT_REGISTRY,
        )!;
        const target = guidance(api, "Purge target");
        const preparation = softDeleteAndInspect(api, target.assetId);

        const purged = api.purgeAsset({ preparation, userActionEvidenceId: "confirm-purge" });

        expect(purged.status).toBe("complete");
        expect(createDuringPurge?.status).toBe("failed");
        expect(createDuringPurge?.diagnostics[0]?.message).toMatch(/Asset catalog is locked/u);
        expect(copyDuringPurge?.status).toBe("failed");
        expect(copyDuringPurge?.diagnostics[0]?.message).toMatch(/Asset catalog is locked/u);
        expect(readAssetManifest(assetsRoot, source.assetId)).not.toBeNull();
    });

    it("ignores unrelated retained dependencies, unresolved references, and Deployment relations", () => {
        const api = service({ assertDirectoryTreeRecycleSupported: () => undefined });
        const target = guidance(api, "Independent target");
        const other = guidance(api, "Other target");
        guidance(api, "Other dependent", [
            {
                kind: "include",
                rawTarget: "oaam:other",
                required: true,
                diagnostics: [],
                resolution: "resolved_asset_version",
                targetAssetVersionId: other.versionIds[0] as UuidV4,
            },
        ]);
        guidance(api, "Unresolved reference", [
            {
                kind: "include",
                rawTarget: "external",
                required: false,
                diagnostics: [],
                resolution: "unresolved",
            },
        ]);
        insertDeployment(getDb(databasePath), {
            deploymentId: DEPLOYMENT_ID,
            consumerAgentRuntimeIds: "[]",
            platform: "win32",
            platformInstanceId: "desktop",
            targetRootPath: "C:\\fixture",
            projectId: "",
            committedTransactionId: "",
            appliedInputsSnapshot: "{}",
            appliedRenderSnapshotRef: "{}",
            observationState: "never",
            observationAttemptedAt: 0,
            lastCompleteObservationAt: 0,
            blockingEvidence: "[]",
            deleted: 0,
            createdAt: 1,
            updatedAt: 1,
        });
        upsertDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, other.assetId, other.versionIds[0] as UuidV4, 1, 0, 1);
        expect(api.softDeleteAsset(target.assetId).status).toBe("complete");

        expect(api.inspectAssetPurge(target.assetId).status).toBe("complete");
    });

    it("blocks every retained Deployment relation, including a soft-deleted row", () => {
        const api = service({ assertDirectoryTreeRecycleSupported: () => undefined });
        const asset = guidance(api);
        const db = getDb(databasePath);
        insertDeployment(db, {
            deploymentId: DEPLOYMENT_ID,
            consumerAgentRuntimeIds: "[]",
            platform: "win32",
            platformInstanceId: "desktop",
            targetRootPath: "C:\\fixture",
            projectId: "",
            committedTransactionId: "",
            appliedInputsSnapshot: "{}",
            appliedRenderSnapshotRef: "{}",
            observationState: "never",
            observationAttemptedAt: 0,
            lastCompleteObservationAt: 0,
            blockingEvidence: "[]",
            deleted: 1,
            createdAt: 1,
            updatedAt: 1,
        });
        upsertDeploymentAsset(db, DEPLOYMENT_ID, asset.assetId, asset.versionIds[0] as UuidV4, 1, 0, 1);
        db.prepare("UPDATE deployment_assets SET deleted = 1 WHERE deployment_id = ?").run(DEPLOYMENT_ID);
        expect(api.softDeleteAsset(asset.assetId).status).toBe("complete");

        expect(api.inspectAssetPurge(asset.assetId).diagnostics[0]?.message).toContain(DEPLOYMENT_ID);
        expect(readAssetManifest(assetsRoot, asset.assetId)).not.toBeNull();
    });

    it("strictly inventories owner-local grants and recycles the exact reviewed Asset tree", () => {
        const api = service({
            assertDirectoryTreeRecycleSupported: () => undefined,
            recycleDirectoryTreeIfIdentity: recycleHook(),
        });
        const asset = guidance(api);
        createPromotionGrantAuthority({
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: {
                subjectKind: "asset_version",
                assetId: asset.assetId,
                versionId: asset.versionIds[0] as UuidV4,
            },
            target: {
                targetKind: "global_target",
                targetAuthorityFingerprint: `sha256:${"a".repeat(64)}`,
            },
            userActionEvidenceId: "grant",
            updatedAt: 2,
        });
        const preparation = softDeleteAndInspect(api, asset.assetId);
        expect(preparation.promotionGrantCount).toBe(1);
        expect(getCurrentAssetIndex(getDb(databasePath), asset.assetId)?.deleted).toBe(1);

        const purged = api.purgeAsset({
            preparation,
            userActionEvidenceId: "confirm-purge",
        });

        expect(purged).toEqual({
            status: "complete",
            value: { assetId: asset.assetId, recycled: true },
            diagnostics: [],
        });
        expect(readAssetManifest(assetsRoot, asset.assetId)).toBeNull();
        expect(fs.existsSync(path.join(sandbox, "recycled-asset", "asset.json"))).toBe(true);
        expect(getCurrentAssetIndex(getDb(databasePath), asset.assetId)).toBeNull();
        expect(listCurrentAssetIndex(getDb(databasePath), true)).toEqual([]);
    });

    it("rejects malformed, stale, missing-confirmation, and physically replaced reviews before recycle", () => {
        const recycle = vi.fn(recycleHook());
        const api = service({
            assertDirectoryTreeRecycleSupported: () => undefined,
            beforePurgeRecycle: () => {
                const original = resolveAssetRoot(assetsRoot, asset.assetId);
                fs.renameSync(original, `${original}-old`);
                fs.mkdirSync(original);
                fs.writeFileSync(path.join(original, "asset.json"), "{}");
            },
            recycleDirectoryTreeIfIdentity: recycle,
        });
        const asset = guidance(api);
        const preparation = softDeleteAndInspect(api, asset.assetId);

        expect(api.purgeAsset({ preparation, userActionEvidenceId: "" }).status).toBe("failed");
        expect(
            api.purgeAsset({
                preparation: { ...preparation, displayName: "tampered" },
                userActionEvidenceId: "confirm",
            }).status,
        ).toBe("failed");
        expect(
            api.purgeAsset({
                preparation: { ...preparation, extra: true } as never,
                userActionEvidenceId: "confirm",
            }).status,
        ).toBe("failed");
        for (const malformed of [
            { ...preparation, schemaVersion: 2 },
            { ...preparation, action: "remove" },
            { ...preparation, assetId: "not-an-id" },
            { ...preparation, assetManifestFingerprint: "not-a-digest" },
            { ...preparation, assetDirectoryIdentityFingerprint: "not-a-digest" },
            { ...preparation, kind: "Plugin" },
            { ...preparation, scope: "session" },
            { ...preparation, projectId: 1 },
            { ...preparation, scopePath: 1 },
            { ...preparation, displayName: 1 },
            { ...preparation, versionCount: -1 },
            { ...preparation, promotionGrantCount: 0.5 },
        ]) {
            expect(
                api.purgeAsset({
                    preparation: malformed as never,
                    userActionEvidenceId: "confirm",
                }).status,
            ).toBe("failed");
        }
        expect(api.purgeAsset({ preparation, userActionEvidenceId: "confirm" }).status).toBe("failed");
        expect(recycle).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(resolveAssetRoot(assetsRoot, asset.assetId))).toBe(true);
        expect(fs.existsSync(`${resolveAssetRoot(assetsRoot, asset.assetId)}-old`)).toBe(true);
    });

    it("preserves the original owner tree when Recycle Bin handoff fails and reports partial projection cleanup honestly", () => {
        const failing = service({
            assertDirectoryTreeRecycleSupported: () => undefined,
            recycleDirectoryTreeIfIdentity: () => {
                throw new Error("Recycle Bin unavailable");
            },
        });
        const failedAsset = guidance(failing, "Failure");
        const failedPreparation = softDeleteAndInspect(failing, failedAsset.assetId);
        expect(
            failing.purgeAsset({
                preparation: failedPreparation,
                userActionEvidenceId: "confirm",
            }).status,
        ).toBe("failed");
        expect(readAssetManifest(assetsRoot, failedAsset.assetId)).not.toBeNull();

        const partial = service(
            {
                assertDirectoryTreeRecycleSupported: () => undefined,
                recycleDirectoryTreeIfIdentity: recycleHook("partial-recycle"),
                beforePurgeProjection: () => {
                    throw new Error("projection fault");
                },
            },
            identities(100),
        );
        const partialAsset = guidance(partial, "Partial");
        const partialPreparation = softDeleteAndInspect(partial, partialAsset.assetId);
        const result = partial.purgeAsset({
            preparation: partialPreparation,
            userActionEvidenceId: "confirm",
        });
        expect(result.status).toBe("partial");
        expect(result.value.recycled).toBe(true);
        expect(result.diagnostics[0]?.code).toBe("asset.purge_projection_failed");
        expect(readAssetManifest(assetsRoot, partialAsset.assetId)).toBeNull();
    });

    it("fails closed for unsupported commit-time mechanics, a vanished tree, and an invalid directory identity", () => {
        const inspectedService = service({ assertDirectoryTreeRecycleSupported: () => undefined });
        const defaultSupportAsset = guidance(inspectedService, "Default support");
        const defaultSupportPreparation = softDeleteAndInspect(inspectedService, defaultSupportAsset.assetId);
        const defaultSupportCommit = service({}, identities(200));
        expect(
            defaultSupportCommit.purgeAsset({
                preparation: defaultSupportPreparation,
                userActionEvidenceId: "confirm",
            }).status,
        ).toBe("failed");

        const defaultRecycle = service({ assertDirectoryTreeRecycleSupported: () => undefined }, identities(300));
        const defaultRecycleAsset = guidance(defaultRecycle, "Default recycle");
        const defaultRecyclePreparation = softDeleteAndInspect(defaultRecycle, defaultRecycleAsset.assetId);
        expect(
            defaultRecycle.purgeAsset({
                preparation: defaultRecyclePreparation,
                userActionEvidenceId: "confirm",
            }).status,
        ).toBe("failed");

        const vanished = service(
            {
                assertDirectoryTreeRecycleSupported: () => undefined,
                recycleDirectoryTreeIfIdentity: () => false,
            },
            identities(400),
        );
        const vanishedAsset = guidance(vanished, "Vanished");
        const vanishedPreparation = softDeleteAndInspect(vanished, vanishedAsset.assetId);
        expect(vanished.purgeAsset({ preparation: vanishedPreparation, userActionEvidenceId: "confirm" }).status).toBe("failed");

        const invalidIdentity = service(
            {
                assertDirectoryTreeRecycleSupported: () => undefined,
                confirmDirectoryTreeNoFollow: () => ({ deviceId: "1", fileId: "2", entryKind: "file" }),
            },
            identities(500),
        );
        const invalidIdentityAsset = guidance(invalidIdentity, "Invalid identity");
        expect(invalidIdentity.softDeleteAsset(invalidIdentityAsset.assetId).status).toBe("complete");
        expect(invalidIdentity.inspectAssetPurge(invalidIdentityAsset.assetId).status).toBe("failed");
    });

    it("rejects corrupt and concurrently disappearing Asset and Version authority during dependency inventory", () => {
        const corrupt = service({ assertDirectoryTreeRecycleSupported: () => undefined });
        const corruptTarget = guidance(corrupt, "Corrupt inventory target");
        expect(corrupt.softDeleteAsset(corruptTarget.assetId).status).toBe("complete");
        fs.mkdirSync(resolveAssetRoot(assetsRoot, ORPHAN_ASSET_ID), { recursive: true });
        expect(corrupt.inspectAssetPurge(corruptTarget.assetId).diagnostics[0]?.message).toMatch(/Asset disappeared/u);

        fs.rmSync(resolveAssetRoot(assetsRoot, ORPHAN_ASSET_ID), { recursive: true });
        const candidate = guidance(corrupt, "Concurrent candidate");
        const candidateVersionId = candidate.versionIds[0] as UuidV4;
        const candidateRace = service({
            assertDirectoryTreeRecycleSupported: () => undefined,
            beforePurgeVersionRead: (assetId, versionId) => {
                if (assetId === candidate.assetId && versionId === candidateVersionId) {
                    fs.rmSync(path.join(resolveAssetRoot(assetsRoot, candidate.assetId), "asset.json"));
                }
            },
        });
        expect(candidateRace.inspectAssetPurge(corruptTarget.assetId).diagnostics[0]?.message).toMatch(
            /retained Version disappeared/u,
        );
        fs.rmSync(resolveAssetRoot(assetsRoot, candidate.assetId), { recursive: true });

        const own = guidance(corrupt, "Concurrent owner");
        expect(corrupt.softDeleteAsset(own.assetId).status).toBe("complete");
        const ownVersionId = own.versionIds[0] as UuidV4;
        const ownerRace = service({
            assertDirectoryTreeRecycleSupported: () => undefined,
            beforePurgeVersionRead: (assetId, versionId) => {
                if (assetId === own.assetId && versionId === ownVersionId) {
                    fs.rmSync(path.join(resolveAssetRoot(assetsRoot, own.assetId), "asset.json"));
                }
            },
        });
        expect(ownerRace.inspectAssetPurge(own.assetId).diagnostics[0]?.message).toMatch(/Asset Version is missing/u);
    });
});
