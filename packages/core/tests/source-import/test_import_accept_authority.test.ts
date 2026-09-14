/** Authority-focused split from the original oversized test suite. */

import * as fs from "node:fs";
import * as path from "node:path";
import { lockFile } from "@oaam/shared/filesystem";
import { describe, expect, it } from "vitest";
import { readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";
import {
    createVersionDialectRegistry,
    publishInitialAssetVersion,
    readVersionAuthority,
} from "../../src/catalog/version-authority";
import {
    computeImportProvenanceAuthorityFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../src/foundation/fingerprint";
import type { AdapterReadResult, ImportServiceConfiguration, OperationDiagnostic, ReindexReport, UuidV4 } from "../../src/types";
import {
    acceptRequest,
    assetsRoot,
    locksRoot,
    makeGuidanceReadResult,
    makeReadResult,
    makeService,
    makeServiceConfiguration,
    PROJECT_ID,
    sandbox,
    sourceFile,
    TARGET_PROJECT_ID,
} from "./fixtures/import-service-test-fixtures";

describe("Core import accept authority and failure closure", () => {
    it("rejects a create-Version decision whose exact parent is outside the selected Asset", async () => {
        const firstRead = await makeReadResult();
        const service = makeService(async (previous) => previous);
        const first = await service.acceptImport(acceptRequest(service.previewImport([firstRead]).value));
        if (first.status !== "complete") throw new Error("first import failed");
        fs.writeFileSync(sourceFile, "# Changed candidate\n");
        const changedRead = await makeReadResult();
        const result = await service.acceptImport(
            acceptRequest(service.previewImport([changedRead]).value, {
                action: "create_version",
                assetId: first.value.assetId,
                parentVersionId: "99999999-9999-4999-8999-999999999999",
            }),
        );
        expect(result.diagnostics[0]?.code).toBe("import.parent_invalid");
        expect(readAssetManifest(assetsRoot, first.value.assetId)?.versionIds).toEqual([first.value.versionId]);
    });

    it("rejects a project candidate appended to a global Asset before publishing", async () => {
        const service = makeService(async (previous) => previous);
        const first = await service.acceptImport(acceptRequest(service.previewImport([await makeReadResult()]).value));
        if (first.status !== "complete") throw new Error("first import failed");

        fs.writeFileSync(sourceFile, "# Project candidate\n");
        const projectRead = await makeGuidanceReadResult({
            scope: "project",
            projectRootPath: "/project",
        });
        const result = await service.acceptImport(
            acceptRequest(service.previewImport([projectRead]).value, {
                action: "create_version",
                assetId: first.value.assetId,
                parentVersionId: first.value.versionId,
            }),
        );

        expect(result.diagnostics[0]?.code).toBe("import.target_asset_mismatch");
        expect(readAssetManifest(assetsRoot, first.value.assetId)?.versionIds).toEqual([first.value.versionId]);
    });

    it("rejects a Project authority remap after acquiring the original Project lock", async () => {
        const projectRead = await makeGuidanceReadResult({
            scope: "project",
            projectRootPath: "/project",
        });
        let remapped = false;
        const service = makeService(async (previous) => previous, {
            resolveProjectId: (projectRootPath) =>
                projectRootPath === "/project" ? (remapped ? TARGET_PROJECT_ID : PROJECT_ID) : null,
            acquireProjectAuthority: () => {
                remapped = true;
                return () => undefined;
            },
        });
        const result = await service.acceptImport(acceptRequest(service.previewImport([projectRead]).value));
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("import.project_authority_changed");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("rejects client mutation of the complete preview closure", async () => {
        const read = await makeReadResult();
        const service = makeService(async () => read);
        const preview = service.previewImport([read]);
        const tampered = structuredClone(preview.value);
        tampered.items[0]!.freshness = "stale";
        const result = await service.acceptImport(acceptRequest(tampered));
        expect(result.diagnostics[0]?.code).toBe("import.preview_tampered_or_stale");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("rejects a decision for a candidate absent from the accepted snapshot", async () => {
        const read = await makeReadResult();
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([read]);
        const request = acceptRequest(preview.value);
        request.decision.candidateId = "missing-candidate";
        const result = await service.acceptImport(request);
        expect(result.diagnostics[0]?.code).toBe("import.candidate_missing");
    });

    it("fails closed when current-source refresh fails or throws", async () => {
        const read = await makeReadResult();
        const failedService = makeService(async (previous) => previous, {
            refreshReadResult: async () => ({
                status: "failed",
                value: undefined as AdapterReadResult,
                diagnostics: [],
            }),
        });
        const preview = failedService.previewImport([read]);
        const failedRefresh = await failedService.acceptImport(acceptRequest(preview.value));
        expect(failedRefresh.diagnostics[0]?.code).toBe("import.source_refresh_failed");

        const throwingService = makeService(async (previous) => previous, {
            refreshReadResult: async () => {
                throw new Error("refresh transport broke");
            },
        });
        const thrown = await throwingService.acceptImport(acceptRequest(preview.value));
        expect(thrown.diagnostics[0]).toEqual(
            expect.objectContaining({
                code: "import.internal_error",
                causeKind: "internal_error",
            }),
        );
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("maps a non-Error source refresh throw to an internal diagnostic", async () => {
        const read = await makeReadResult();
        const service = makeService(async (previous) => previous, {
            refreshReadResult: async () => {
                throw "refresh-string-fault";
            },
        });
        const preview = service.previewImport([read]);
        const result = await service.acceptImport(acceptRequest(preview.value));
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toEqual(
            expect.objectContaining({
                code: "import.internal_error",
                message: "refresh-string-fault",
                causeKind: "internal_error",
            }),
        );
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("requires nonblank user evidence for stale-snapshot and import consent", async () => {
        const read = await makeReadResult();
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([read]);
        const stale = await service.acceptImport(
            acceptRequest(preview.value, {
                freshness: { freshnessAction: "accept_preview_snapshot", userActionId: " " },
            }),
        );
        expect(stale.diagnostics[0]?.code).toBe("import.user_action_missing");

        const importConsent = await service.acceptImport(
            acceptRequest(preview.value, {
                promotion: { promotionAction: "import_only", userActionId: "" },
            }),
        );
        expect(importConsent.diagnostics[0]?.code).toBe("import.user_action_missing");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("rejects missing dialect authority and invalid or repeated generated identities", async () => {
        const read = await makeReadResult();
        const noDialect = makeService(async (previous) => previous, {
            dialectRegistry: createVersionDialectRegistry([], [], [], []),
        });
        const blocked = noDialect.previewImport([read]);
        expect(blocked.value.items[0]).toEqual(expect.objectContaining({ action: "blocked" }));
        expect(blocked.value.items[0]?.diagnostics[0]?.code).toBe("import.native_contract_missing");

        const invalidIdentity = makeService(async (previous) => previous, {
            newUuid: () => "not-a-uuid" as UuidV4,
        });
        const invalid = await invalidIdentity.acceptImport(acceptRequest(invalidIdentity.previewImport([read]).value));
        expect(invalid.diagnostics[0]?.code).toBe("import.identity_invalid");

        const repeated = "00000000-0000-4000-8000-000000000777" as UuidV4;
        const repeatedIdentity = makeService(async (previous) => previous, {
            newUuid: () => repeated,
        });
        const duplicate = await repeatedIdentity.acceptImport(acceptRequest(repeatedIdentity.previewImport([read]).value));
        expect(duplicate.diagnostics[0]?.code).toBe("import.identity_duplicate");
    });

    it("rejects a generated Asset identity that already exists", async () => {
        const firstRead = await makeReadResult();
        const firstService = makeService(async (previous) => previous);
        const first = await firstService.acceptImport(acceptRequest(firstService.previewImport([firstRead]).value));
        if (first.status !== "complete") throw new Error("first import failed");

        fs.writeFileSync(sourceFile, "# Different asset\n");
        const secondRead = await makeReadResult();
        const generated = [
            "00000000-0000-4000-8000-000000000778" as UuidV4,
            first.value.assetId,
            "00000000-0000-4000-8000-000000000779" as UuidV4,
            "00000000-0000-4000-8000-000000000780" as UuidV4,
            "00000000-0000-4000-8000-000000000781" as UuidV4,
        ];
        const collisionService = makeService(async (previous) => previous, {
            newUuid: () => generated.shift() as UuidV4,
        });
        const collision = await collisionService.acceptImport(acceptRequest(collisionService.previewImport([secondRead]).value));
        expect(collision.diagnostics[0]?.code).toBe("import.asset_id_collision");
        expect(readAssetManifest(assetsRoot, first.value.assetId)?.versionIds).toEqual([first.value.versionId]);
    });

    it("blocks one canonical fingerprint claimed by two independent Asset histories", async () => {
        const read = await makeReadResult();
        const service = makeService(async (previous) => previous);
        const imported = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
        if (imported.status !== "complete") throw new Error("fixture import failed");
        const asset = readAssetManifest(assetsRoot, imported.value.assetId);
        const closure = readVersionAuthority(
            assetsRoot,
            imported.value.assetId,
            imported.value.versionId,
            makeServiceConfiguration(async (previous) => previous).dialectRegistry,
        );
        if (asset === null || closure === null) throw new Error("fixture authority missing");
        if (closure.manifest.originAuthority.originKind !== "import") {
            throw new Error("fixture Version must be imported");
        }

        const cloneAssetId = "77777777-7777-4777-8777-777777777777" as UuidV4;
        const cloneVersionId = "88888888-8888-4888-8888-888888888888" as UuidV4;
        const clone = structuredClone(closure);
        clone.manifest.assetId = cloneAssetId;
        clone.manifest.versionId = cloneVersionId;
        clone.manifest.importProvenanceAuthority.assetId = cloneAssetId;
        clone.manifest.importProvenanceAuthority.versionId = cloneVersionId;
        clone.manifest.importProvenanceAuthority.importProvenanceId = "clone-provenance";
        const { authorityFingerprint: _oldProvenanceFingerprint, ...provenancePreimage } =
            clone.manifest.importProvenanceAuthority;
        clone.manifest.importProvenanceAuthority.authorityFingerprint =
            computeImportProvenanceAuthorityFingerprint(provenancePreimage);
        clone.manifest.originAuthority.assetId = cloneAssetId;
        clone.manifest.originAuthority.versionId = cloneVersionId;
        clone.manifest.originAuthority.importProvenanceId = clone.manifest.importProvenanceAuthority.importProvenanceId;
        clone.manifest.originAuthority.importProvenanceAuthorityFingerprint =
            clone.manifest.importProvenanceAuthority.authorityFingerprint;
        const { authorityFingerprint: _oldOriginFingerprint, ...originPreimage } = clone.manifest.originAuthority;
        clone.manifest.originAuthority.authorityFingerprint = computeVersionOriginAuthorityFingerprint(originPreimage);
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-clone-history",
            asset: {
                ...asset,
                assetId: cloneAssetId,
                versionIds: [cloneVersionId],
            },
            version: clone,
            dialectRegistry: makeServiceConfiguration(async (previous) => previous).dialectRegistry,
        });

        const ambiguous = service.previewImport([read]);
        expect(ambiguous.value.items[0]).toEqual(expect.objectContaining({ action: "blocked" }));
        expect(ambiguous.value.items[0]?.diagnostics[0]?.code).toBe("import.duplicate_ambiguous");
    });

    it("ignores a deleted history for duplicate matching and refuses new grants on it", async () => {
        const read = await makeReadResult();
        const service = makeService(async (previous) => previous);
        const imported = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
        if (imported.status !== "complete") throw new Error("fixture import failed");
        const asset = readAssetManifest(assetsRoot, imported.value.assetId);
        if (asset === null) throw new Error("fixture Asset missing");
        writeAssetManifest(assetsRoot, { ...asset, deleted: true });

        expect(service.previewImport([read]).value.items[0]?.action).toBe("create_asset");
        const grant = service.createPromotionGrant({
            promotionAction: "grant_current_version_current_target",
            assetId: imported.value.assetId,
            versionId: imported.value.versionId,
            target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
            userActionId: "grant-deleted",
        });
        expect(grant.diagnostics[0]?.code).toBe("import.asset_inactive");
    });

    it("fails closed on an unreadable catalog and on an Asset directory without asset.json", async () => {
        const read = await makeReadResult();
        const missingManifestRoot = path.join(sandbox, "missing-manifest-assets");
        fs.mkdirSync(path.join(missingManifestRoot, "77777777-7777-4777-8777-777777777777"), {
            recursive: true,
        });
        const missingManifest = makeService(async (previous) => previous, {
            assetsRoot: missingManifestRoot,
        }).previewImport([read]);
        expect(missingManifest.diagnostics[0]?.code).toBe("import.asset_missing");

        const nonDirectoryRoot = path.join(sandbox, "catalog-is-a-file");
        fs.writeFileSync(nonDirectoryRoot, "not a directory");
        const unreadable = makeService(async (previous) => previous, {
            assetsRoot: nonDirectoryRoot,
        }).previewImport([read]);
        expect(unreadable.diagnostics[0]).toEqual(
            expect.objectContaining({
                code: "import.internal_error",
                causeKind: "internal_error",
            }),
        );
    });

    it("serializes preview reconciliation and publish under the import-catalog lock", async () => {
        const read = await makeReadResult();
        fs.mkdirSync(path.join(locksRoot, "imports"), { recursive: true });
        const release = lockFile(path.join(locksRoot, "imports", "import-catalog.lock"));
        if (release === null) throw new Error("fixture failed to acquire import lock");
        const service = makeService(async (previous) => previous);
        const request = acceptRequest(service.previewImport([read]).value);
        try {
            const result = await service.acceptImport(request);
            expect(result.diagnostics[0]).toEqual(
                expect.objectContaining({
                    code: "import.catalog_locked",
                    retryable: true,
                }),
            );
            expect(fs.existsSync(assetsRoot)).toBe(false);
        } finally {
            release();
        }

        const retried = await service.acceptImport(request);
        if (retried.status !== "complete") throw new Error("retry import failed");
        expect(readAssetManifest(assetsRoot, retried.value.assetId)).not.toBeNull();
    });

    it("keeps the committed VersionRef when reindex reports an Asset diagnostic", async () => {
        await expectPublishedProjectionPartial(
            () => ({
                status: "complete",
                value: reindexReport([projectionDiagnostic("fixture.index_projection_failed")]),
                diagnostics: [],
            }),
            "fixture.index_projection_failed",
        );
    });

    it("synthesizes a retryable diagnostic when failed reindex returns no diagnostic", async () => {
        await expectPublishedProjectionPartial(
            () => ({
                status: "failed",
                value: undefined as ReindexReport,
                diagnostics: [],
            }),
            "import.index_projection_failed",
        );
    });

    it("treats a partial reindex without diagnostics as a committed partial import", async () => {
        await expectPublishedProjectionPartial(
            () => ({
                status: "partial",
                value: reindexReport(),
                diagnostics: [],
            }),
            "import.index_projection_failed",
        );
    });

    it("keeps the committed VersionRef when reindex throws an Error", async () => {
        await expectPublishedProjectionPartial(() => {
            throw new Error("injected projection failure");
        }, "import.index_projection_failed");
    });

    it("keeps the committed VersionRef when reindex throws a non-Error", async () => {
        await expectPublishedProjectionPartial(() => {
            throw "injected projection string failure";
        }, "import.index_projection_failed");
    });
});

async function expectPublishedProjectionPartial(
    reindexImportedAsset: ImportServiceConfiguration["reindexImportedAsset"],
    diagnosticCode: string,
): Promise<void> {
    const read = await makeReadResult();
    const service = makeService(async (previous) => previous, { reindexImportedAsset });
    const result = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
    expect(result.status).toBe("partial");
    expect(result.diagnostics[0]?.code).toBe(diagnosticCode);
    expect(result.value).toEqual({
        assetId: expect.any(String),
        versionId: expect.any(String),
    });
    expect(readAssetManifest(assetsRoot, result.value.assetId)?.versionIds).toEqual([result.value.versionId]);
}

function reindexReport(diagnostics: OperationDiagnostic[] = []): ReindexReport {
    return {
        scannedAssets: 1,
        indexedAssets: diagnostics.length === 0 ? 1 : 0,
        skippedAssets: diagnostics.length === 0 ? 0 : 1,
        diagnostics,
    };
}

function projectionDiagnostic(code: string): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message: "injected index projection failure",
        path: "",
        traceId: "",
        operation: "reindex",
        causeKind: "partial",
        retryable: true,
        suggestedActions: ["retry"],
        rawSummary: "injected index projection failure",
    };
}
