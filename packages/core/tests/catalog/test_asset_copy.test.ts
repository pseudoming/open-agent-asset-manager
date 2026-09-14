/** Cross-location Asset copy preserves exact Version material without transferring authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAssetManifest } from "../../src/catalog/asset-manifest";
import {
    createVersionDialectRegistry,
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishAssetVersion,
    publishImportedInitialAssetVersion,
    readVersionAuthority,
    type VersionAuthorityClosureV1,
} from "../../src/catalog/version-authority";
import { writeProjectManifest } from "../../src/catalog/project-authority";
import { listPromotionGrantAuthorities } from "../../src/catalog/promotion-grant-store";
import type { ImportProvenanceAuthorityV1 } from "../../src/contracts/persistence";
import type { CopyAssetVersionToLocationInputV1, UuidV4 } from "../../src/types";
import {
    computeImportProvenanceAuthorityFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
    computeVersionOriginAuthorityFingerprint,
    stableStringify,
} from "../../src/foundation/fingerprint";
import { resolveVersionSourcePromotionSafety } from "../../src/catalog/version-origin-lineage";
import { createCoreAssetService, createCoreAssetServiceForTest } from "../../src/orchestration/core-asset-service";
import { closeDb, getDb } from "../../src/persistence/db";
import { makeNativeDialectContract, makeRestorationDialectContract } from "../source-import/fixtures/dialect-contracts";
import { makeAsset } from "./fixtures/version-v2";
import { makeDialectVersion } from "./fixtures/version-authority-test-fixtures";

const PROJECT_ID = "70000000-0000-4000-8000-000000000001" as UuidV4;

let sandbox = "";
let assetsRoot = "";
let projectsRoot = "";
let locksRoot = "";
let databasePath = "";
let workspaceRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-asset-copy-"));
    assetsRoot = path.join(sandbox, "oaam", "assets");
    projectsRoot = path.join(sandbox, "oaam", "projects");
    locksRoot = path.join(sandbox, "oaam", "transactions", "authority-locks");
    databasePath = path.join(sandbox, "state.db");
    workspaceRoot = path.join(sandbox, "workspace");
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(path.join(sandbox, "oaam"));
    fs.mkdirSync(path.join(sandbox, "oaam", "transactions"));
    writeProjectManifest(projectsRoot, {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        rootPath: workspaceRoot,
        displayName: "Workspace",
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
    });
    closeDb();
});

afterEach(() => {
    closeDb();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function identityFactory(start = 1): () => UuidV4 {
    let next = start;
    return () => {
        const suffix = String(next).padStart(12, "0");
        next += 1;
        return `90000000-0000-4000-8000-${suffix}`;
    };
}

function makeService(dialectRegistry = EMPTY_VERSION_DIALECT_REGISTRY, newUuid: () => UuidV4 = identityFactory()) {
    return createCoreAssetService({
        assetsRoot,
        projectsRoot,
        authorityLocksRoot: locksRoot,
        db: getDb(databasePath),
        dialectRegistry,
        assertMutationScope: () => undefined,
        now: () => 1_000,
        newUuid,
    });
}

function copyInput(
    source: NonNullable<ReturnType<typeof readVersionAuthority>>,
    destination: CopyAssetVersionToLocationInputV1["destination"],
): CopyAssetVersionToLocationInputV1 {
    return {
        source: {
            assetId: source.manifest.assetId,
            versionId: source.manifest.versionId,
            versionFingerprint: source.manifest.fingerprint,
            originAuthorityFingerprint: source.manifest.originAuthority.authorityFingerprint,
        },
        destination,
        displayName: "Copied Guidance",
        displayDescription: "Copied without inherited grants",
        userActionEvidenceId: "copy-action",
    };
}

function makeRestrictedDialectVersion() {
    const fixture = makeDialectVersion();
    const legacyRepresentation = fixture.version.manifest.nativeRepresentations[0];
    const legacyPayload = fixture.version.nativePayloads[0];
    if (legacyRepresentation?.schemaVersion !== 1 || legacyPayload?.files[0] === undefined) {
        throw new Error("native copy fixture is incomplete");
    }
    const v2Preimage = {
        ...legacyRepresentation,
        schemaVersion: 2 as const,
        directories: ["bundle", "bundle/empty"],
        files: legacyRepresentation.files.map((file) => ({ ...file, relativePath: "bundle/native.md" })),
    };
    const { representationFingerprint: _legacyFingerprint, ...v2WithoutFingerprint } = v2Preimage;
    fixture.version.manifest.nativeRepresentations = [
        {
            ...v2WithoutFingerprint,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(v2WithoutFingerprint),
        },
    ];
    fixture.version.nativePayloads = [
        {
            ...legacyPayload,
            files: legacyPayload.files.map((file) => ({ ...file, relativePath: "bundle/native.md" })),
        },
    ];
    fixture.version.manifest.fingerprint = computeVersionFingerprint(
        fixture.version.manifest.versionCanonicalContentFingerprint,
        fixture.version.manifest.nativeRepresentations,
        fixture.version.manifest.dialectRestorationPayloads,
        fixture.version.manifest.portableDialectContracts,
    );
    const provenancePreimage = {
        schemaVersion: 1 as const,
        importProvenanceId: "asset-copy-import",
        assetId: fixture.version.manifest.assetId,
        versionId: fixture.version.manifest.versionId,
        previewSnapshotFingerprint: `sha256:${"1".repeat(64)}` as const,
        candidateFingerprint: `sha256:${"2".repeat(64)}` as const,
        acceptedFreshness: "current_source_verified" as const,
        acceptedPromotion: {
            promotionAction: "import_only" as const,
            userActionEvidenceId: "import-action",
        },
        promotionSafety: "requires_user_confirmation" as const,
        importedAt: 100,
    };
    const importProvenanceAuthority: ImportProvenanceAuthorityV1 = {
        ...provenancePreimage,
        authorityFingerprint: computeImportProvenanceAuthorityFingerprint(provenancePreimage),
    };
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: fixture.version.manifest.assetId,
        versionId: fixture.version.manifest.versionId,
        originKind: "import" as const,
        importProvenanceId: importProvenanceAuthority.importProvenanceId,
        importProvenanceAuthorityFingerprint: importProvenanceAuthority.authorityFingerprint,
        promotionRequirement: "requires_current_authorization" as const,
        createdAt: 100,
    };
    fixture.version.manifest = {
        ...fixture.version.manifest,
        originAuthority: {
            ...originPreimage,
            authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
        },
        importProvenanceAuthority,
    };
    return fixture;
}

function makeReverseVersion(
    parent: VersionAuthorityClosureV1,
    versionId: UuidV4,
    promotionRequirement: "not_required" | "requires_current_authorization",
): VersionAuthorityClosureV1 {
    const version = structuredClone(parent);
    version.manifest.versionId = versionId;
    version.manifest.revision = parent.manifest.revision + 1;
    version.manifest.changeKind = "extract";
    version.manifest.sourceVersionId = parent.manifest.versionId;
    version.manifest.createdAt += 1;
    delete (version.manifest as unknown as Record<string, unknown>).importProvenanceAuthority;
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: version.manifest.assetId,
        versionId,
        originKind: "reverse_accept" as const,
        previousVersionId: parent.manifest.versionId,
        previousVersionOriginAuthorityFingerprint: parent.manifest.originAuthority.authorityFingerprint,
        reversePreparationIdentityFingerprint: `sha256:${"7".repeat(64)}` as const,
        userActionEvidenceId: "reverse-copy-source",
        promotionRequirement,
        createdAt: version.manifest.createdAt,
    };
    version.manifest.originAuthority = {
        ...originPreimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
    };
    return version;
}

describe("Core Asset cross-location copy", () => {
    it("creates a new Asset with exact text/binary content and leaves display edits outside Version history", () => {
        const service = makeService();
        const sourceAsset = service.createAsset({
            kind: "Guidance",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "Source",
            displayDescription: "Original",
            initialVersion: {
                typeData: { schemaVersion: 1 },
                files: [
                    {
                        logicalPath: "GUIDANCE.md",
                        role: "entry",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        text: "# Guidance\r\n",
                        executable: false,
                        references: [],
                    },
                    {
                        logicalPath: "resource.bin",
                        role: "resource",
                        contentKind: "binary",
                        mediaType: "application/octet-stream",
                        bytes: new Uint8Array([1, 2, 3]),
                        executable: true,
                        references: [],
                    },
                ],
                userActionEvidenceId: "create-source",
                changeKind: "create",
            },
        });
        expect(sourceAsset.status, JSON.stringify(sourceAsset)).toBe("complete");
        const source = readVersionAuthority(
            assetsRoot,
            sourceAsset.value.assetId,
            sourceAsset.value.versionIds[0]!,
            EMPTY_VERSION_DIALECT_REGISTRY,
        )!;

        expect(
            service.copyAssetVersionToLocation(copyInput(source, { scope: "global", projectId: "", scopePath: "" })).status,
        ).toBe("failed");

        const copied = service.copyAssetVersionToLocation(
            copyInput(source, {
                scope: "project",
                projectId: PROJECT_ID,
                scopePath: "nested",
            }),
        );
        expect(copied.status).toBe("complete");
        expect(copied.value.asset).toMatchObject({
            kind: "Guidance",
            scope: "project",
            projectId: PROJECT_ID,
            scopePath: "nested",
            displayName: "Copied Guidance",
            deleted: false,
        });
        expect(copied.value.asset.assetId).not.toBe(source.manifest.assetId);
        expect(copied.value.version.versionId).not.toBe(source.manifest.versionId);
        expect(copied.value.version.fingerprint).toBe(source.manifest.fingerprint);
        expect(copied.value.version.originAuthority).toMatchObject({
            originKind: "asset_copy",
            sourceAssetId: source.manifest.assetId,
            sourceVersionId: source.manifest.versionId,
            sourcePromotionSafety: "not_applicable",
            promotionRequirement: "not_required",
        });

        const copiedClosure = readVersionAuthority(
            assetsRoot,
            copied.value.asset.assetId,
            copied.value.version.versionId,
            EMPTY_VERSION_DIALECT_REGISTRY,
        )!;
        expect(copiedClosure.files.map((file) => file.file.fileId)).not.toEqual(source.files.map((file) => file.file.fileId));
        expect(copiedClosure.files.map((file) => (file.contentKind === "text" ? file.text : Array.from(file.bytes)))).toEqual([
            "# Guidance\n",
            [1, 2, 3],
        ]);
        expect(listPromotionGrantAuthorities(assetsRoot, copied.value.asset.assetId)).toEqual([]);

        const versionBeforeDisplayEdit = stableStringify(copiedClosure.manifest);
        const edited = service.updateAssetDisplay(copied.value.asset.assetId, {
            displayName: "Renamed copy",
            displayDescription: "Display metadata only",
        });
        expect(edited.status).toBe("complete");
        expect(edited.value.versionIds).toEqual([copied.value.version.versionId]);
        expect(
            stableStringify(
                readVersionAuthority(
                    assetsRoot,
                    copied.value.asset.assetId,
                    copied.value.version.versionId,
                    EMPTY_VERSION_DIALECT_REGISTRY,
                )!.manifest,
            ),
        ).toBe(versionBeforeDisplayEdit);

        const returnedToGlobal = service.copyAssetVersionToLocation(
            copyInput(copiedClosure, { scope: "global", projectId: "", scopePath: "" }),
        );
        expect(returnedToGlobal.status).toBe("complete");
        expect(returnedToGlobal.value.version.originAuthority).toMatchObject({
            sourcePromotionSafety: "not_applicable",
            promotionRequirement: "not_required",
        });
    });

    it("preserves native/restoration material and restricted-source safety across repeated copies without grants", () => {
        const sourceFixture = makeRestrictedDialectVersion();
        const registry = createVersionDialectRegistry(
            [makeNativeDialectContract("Guidance", "fixture-native-v1")],
            [makeRestorationDialectContract("Guidance", "fixture-restoration-v1")],
            [],
            [],
        );
        publishImportedInitialAssetVersion({
            assetsRoot,
            transactionId: "publish-imported-source",
            asset: makeAsset(),
            version: sourceFixture.version,
            dialectRegistry: registry,
            promotion: { promotionAction: "import_only" },
        });
        const service = makeService(registry);
        const source = readVersionAuthority(
            assetsRoot,
            sourceFixture.version.manifest.assetId,
            sourceFixture.version.manifest.versionId,
            registry,
        )!;
        const sourceSnapshot = stableStringify(source);
        const projectCopy = service.copyAssetVersionToLocation(
            copyInput(source, { scope: "project", projectId: PROJECT_ID, scopePath: "" }),
        );
        expect(projectCopy.status, JSON.stringify(projectCopy)).toBe("complete");
        const projectClosure = readVersionAuthority(
            assetsRoot,
            projectCopy.value.asset.assetId,
            projectCopy.value.version.versionId,
            registry,
        )!;
        expect(projectClosure.nativePayloads).toEqual(source.nativePayloads);
        expect(projectClosure.restorationPayloads).toEqual(source.restorationPayloads);
        expect(projectClosure.manifest.nativeRepresentations).toEqual(source.manifest.nativeRepresentations);
        expect(projectClosure.manifest.nativeRepresentations[0]).toEqual(
            expect.objectContaining({ schemaVersion: 2, directories: ["bundle", "bundle/empty"] }),
        );
        expect(projectClosure.manifest.dialectRestorationPayloads).toEqual(source.manifest.dialectRestorationPayloads);
        expect(projectClosure.manifest.originAuthority).toMatchObject({
            originKind: "asset_copy",
            sourcePromotionSafety: "requires_user_confirmation",
            promotionRequirement: "requires_current_authorization",
        });
        expect(listPromotionGrantAuthorities(assetsRoot, projectCopy.value.asset.assetId)).toEqual([]);

        const globalCopy = service.copyAssetVersionToLocation(
            copyInput(projectClosure, { scope: "global", projectId: "", scopePath: "" }),
        );
        expect(globalCopy.status).toBe("complete");
        expect(globalCopy.value.version.originAuthority).toMatchObject({
            originKind: "asset_copy",
            sourcePromotionSafety: "requires_user_confirmation",
            promotionRequirement: "requires_current_authorization",
        });
        expect(listPromotionGrantAuthorities(assetsRoot, globalCopy.value.asset.assetId)).toEqual([]);
        expect(
            stableStringify(readVersionAuthority(assetsRoot, source.manifest.assetId, source.manifest.versionId, registry)),
        ).toBe(sourceSnapshot);

        const reverse = makeReverseVersion(source, "88888888-8888-4888-8888-888888888881", "requires_current_authorization");
        publishAssetVersion({
            assetsRoot,
            transactionId: "publish-reverse-source",
            version: reverse,
            dialectRegistry: registry,
        });
        const reverseSource = readVersionAuthority(assetsRoot, reverse.manifest.assetId, reverse.manifest.versionId, registry)!;
        const reverseCopy = service.copyAssetVersionToLocation(
            copyInput(reverseSource, { scope: "project", projectId: PROJECT_ID, scopePath: "reverse" }),
        );
        expect(reverseCopy.status, JSON.stringify(reverseCopy)).toBe("complete");
        expect(reverseCopy.value.version.originAuthority).toMatchObject({
            sourcePromotionSafety: "requires_user_confirmation",
            promotionRequirement: "requires_current_authorization",
        });

        const inconsistent = makeReverseVersion(reverseSource, "88888888-8888-4888-8888-888888888882", "not_required");
        publishAssetVersion({
            assetsRoot,
            transactionId: "publish-inconsistent-reverse-source",
            version: inconsistent,
            dialectRegistry: registry,
        });
        const inconsistentSource = readVersionAuthority(
            assetsRoot,
            inconsistent.manifest.assetId,
            inconsistent.manifest.versionId,
            registry,
        )!;
        expect(
            service.copyAssetVersionToLocation(
                copyInput(inconsistentSource, { scope: "project", projectId: PROJECT_ID, scopePath: "inconsistent" }),
            ).status,
        ).toBe("failed");

        const broken = makeReverseVersion(
            inconsistentSource,
            "88888888-8888-4888-8888-888888888884",
            "requires_current_authorization",
        );
        const brokenOrigin = broken.manifest.originAuthority;
        if (brokenOrigin.originKind !== "reverse_accept") throw new Error("fixture must be reverse lineage");
        brokenOrigin.previousVersionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        const { authorityFingerprint: _storedFingerprint, ...brokenOriginPreimage } = brokenOrigin;
        brokenOrigin.authorityFingerprint = computeVersionOriginAuthorityFingerprint(brokenOriginPreimage);
        publishAssetVersion({
            assetsRoot,
            transactionId: "publish-broken-reverse-source",
            version: broken,
            dialectRegistry: registry,
        });
        const brokenSource = readVersionAuthority(assetsRoot, broken.manifest.assetId, broken.manifest.versionId, registry)!;
        expect(
            service.copyAssetVersionToLocation(
                copyInput(brokenSource, { scope: "project", projectId: PROJECT_ID, scopePath: "broken" }),
            ).status,
        ).toBe("failed");
    });

    it("rejects stale exact-source authority and invalid destinations before publishing a new Asset", () => {
        const service = makeService();
        const created = service.createAsset({
            kind: "Guidance",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "Source",
            initialVersion: {
                typeData: { schemaVersion: 1 },
                files: [
                    {
                        logicalPath: "GUIDANCE.md",
                        role: "entry",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        text: "# Source\n",
                        executable: false,
                    },
                ],
                userActionEvidenceId: "create-source",
                changeKind: "create",
            },
        });
        expect(created.status, JSON.stringify(created)).toBe("complete");
        const source = readVersionAuthority(
            assetsRoot,
            created.value.assetId,
            created.value.versionIds[0]!,
            EMPTY_VERSION_DIALECT_REGISTRY,
        )!;
        const valid = copyInput(source, { scope: "project", projectId: PROJECT_ID, scopePath: "" });
        const staleVersion = structuredClone(valid);
        staleVersion.source.versionFingerprint = `sha256:${"9".repeat(64)}`;
        expect(service.copyAssetVersionToLocation(staleVersion).status).toBe("failed");
        const staleOrigin = structuredClone(valid);
        staleOrigin.source.originAuthorityFingerprint = `sha256:${"8".repeat(64)}`;
        expect(service.copyAssetVersionToLocation(staleOrigin).status).toBe("failed");
        const malformedVersionFingerprint = structuredClone(valid);
        malformedVersionFingerprint.source.versionFingerprint =
            "bad" as typeof malformedVersionFingerprint.source.versionFingerprint;
        expect(service.copyAssetVersionToLocation(malformedVersionFingerprint).status).toBe("failed");
        const malformedOriginFingerprint = structuredClone(valid);
        malformedOriginFingerprint.source.originAuthorityFingerprint =
            "bad" as typeof malformedOriginFingerprint.source.originAuthorityFingerprint;
        expect(service.copyAssetVersionToLocation(malformedOriginFingerprint).status).toBe("failed");
        expect(
            service.copyAssetVersionToLocation({
                ...valid,
                destination: {
                    scope: "project",
                    projectId: "60000000-0000-4000-8000-000000000001",
                    scopePath: "",
                },
            }).status,
        ).toBe("failed");
        expect(
            service.copyAssetVersionToLocation({
                ...valid,
                displayName: " ",
            }).status,
        ).toBe("failed");
        expect(
            service.copyAssetVersionToLocation({
                ...valid,
                userActionEvidenceId: "",
            }).status,
        ).toBe("failed");
        expect(
            service.copyAssetVersionToLocation({
                ...valid,
                displayDescription: 42 as never,
            }).status,
        ).toBe("failed");
        expect(
            service.copyAssetVersionToLocation({
                ...valid,
                displayName: (() => "not cloneable") as never,
            }).status,
        ).toBe("failed");

        const nonCollidingIds = identityFactory(700);
        let firstIdentity = true;
        const colliding = makeService(EMPTY_VERSION_DIALECT_REGISTRY, () => {
            if (firstIdentity) {
                firstIdentity = false;
                return created.value.assetId;
            }
            return nonCollidingIds();
        });
        expect(colliding.copyAssetVersionToLocation(valid).status).toBe("failed");

        const partial = createCoreAssetServiceForTest(
            {
                assetsRoot,
                projectsRoot,
                authorityLocksRoot: locksRoot,
                db: getDb(databasePath),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                assertMutationScope: () => undefined,
                now: () => 1_001,
                newUuid: identityFactory(500),
            },
            {
                beforeIndexProjection() {
                    throw new Error("forced copy projection failure");
                },
            },
        ).copyAssetVersionToLocation(valid);
        expect(partial.status).toBe("partial");
        expect(partial.diagnostics[0]?.code).toBe("asset.index_projection_failed");

        expect(
            fs
                .readdirSync(assetsRoot)
                .filter((entry) => entry !== ".staging")
                .sort(),
        ).toEqual([created.value.assetId, partial.value.asset.assetId].sort());
        expect(readAssetManifest(assetsRoot, created.value.assetId)?.deleted).toBe(false);
    });

    it("fails closed when a hostile in-memory reverse lineage cycles", () => {
        const source = makeReverseVersion(
            makeRestrictedDialectVersion().version,
            "88888888-8888-4888-8888-888888888883",
            "requires_current_authorization",
        );
        const origin = source.manifest.originAuthority;
        if (origin.originKind !== "reverse_accept") throw new Error("fixture must be reverse lineage");
        origin.previousVersionId = source.manifest.versionId;
        origin.previousVersionOriginAuthorityFingerprint = origin.authorityFingerprint;
        const result = resolveVersionSourcePromotionSafety(source, () => source);
        expect(result).toEqual({
            status: "broken",
            message: "Version origin lineage contains a cycle",
        });
    });
});
