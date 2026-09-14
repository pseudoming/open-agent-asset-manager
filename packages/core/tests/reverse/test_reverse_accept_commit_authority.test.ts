import Database from "better-sqlite3";
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import {
    publishReverseAcceptedAssetVersion,
    readAssetManifestAuthoritySet,
    readVersionAuthority,
} from "../../src/catalog/version-authority";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-dialect-registry";
import { readDeploymentPayload } from "../../src/deployment/deployment-payload-store";
import {
    computePostAssetManifestAuthoritySetFingerprint,
    computeReverseAcceptCommitIntentFingerprint,
    computeReverseAcceptMarkerFingerprint,
} from "../../src/foundation/fingerprint";
import { getDeployment, listDeploymentAssets } from "../../src/persistence/state-db";
import { buildAssetFilesystemCommitReceipt, createReverseAcceptMarkerStore } from "../../src/reverse/reverse-accept-marker";
import {
    createReverseAcceptService,
    createReverseAcceptServiceForTest,
    type FreshReverseAcceptCommitDraft,
} from "../../src/reverse/reverse-accept-service";
import type { Sha256Digest, UuidV4 } from "../../src/types";
import type { ClaimedIntentRecord } from "./fixtures/reverse-accept-commit-test-fixtures";
import {
    ASSET_UUID,
    commitRequest,
    createHarness,
    DEPLOYMENT_UUID,
    exactAnalysisValidator,
    harness,
    HASH_A,
    HASH_C,
    OLD_VERSION_UUID,
    PREPARATION_ID,
    prepare,
    RENDERED_TEXT,
    SECOND_ASSET_ID,
    SECOND_VERSION_ID,
    STAGED_VERSION_ID,
} from "./fixtures/reverse-accept-commit-test-fixtures";
import { DEPLOYMENT_ID, TRANSACTION_ID } from "./fixtures/reverse-accept-db-fixtures";

describe("reverse-accept commit authority", () => {
    it("publishes the staged Version, changes Deployment input, commits receipt, and consumes marker", async () => {
        const service = createReverseAcceptService(harness.configuration());
        const prepared = await service.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_UUID,
            inspectionResultFingerprint: HASH_C,
        });
        expect(prepared.status).toBe("complete");

        const committed = await service.commitRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
            userActionId: "accept-edited-guidance",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: {
                schemaVersion: 1,
                renderInputFingerprint: harness.analysis.renderInputFingerprint,
                semanticOptions: [],
            },
        });

        expect(committed).toEqual({
            status: "complete",
            value: {
                commitState: "committed",
                version: { assetId: ASSET_UUID, versionId: STAGED_VERSION_ID },
            },
            diagnostics: [],
        });
        expect(
            readVersionAuthority(harness.assetsRoot, ASSET_UUID, STAGED_VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY).manifest
                .originAuthority,
        ).toMatchObject({
            originKind: "reverse_accept",
            previousVersionId: OLD_VERSION_UUID,
            userActionEvidenceId: "accept-edited-guidance",
        });
        const db = new Database(harness.databasePath);
        expect(listDeploymentAssets(db, DEPLOYMENT_ID, false)[0]?.versionId).toBe(STAGED_VERSION_ID);
        expect(getDeployment(db, DEPLOYMENT_ID)).toMatchObject({
            committedTransactionId: TRANSACTION_ID,
            observationState: "complete",
        });
        db.close();
        const expectedPayloadBytes = new Uint8Array(Buffer.from(RENDERED_TEXT, "utf-8"));
        expect(
            readDeploymentPayload({
                deploymentsRoot: harness.deploymentsRoot,
                deploymentId: DEPLOYMENT_UUID,
                contentHash: sha256Bytes(expectedPayloadBytes),
                expectedByteSize: expectedPayloadBytes.byteLength,
            }),
        ).toEqual(expectedPayloadBytes);
        const marker = createReverseAcceptMarkerStore(
            harness.transactionsRoot,
            exactAnalysisValidator(harness.analysis),
        ).readMarker(PREPARATION_ID);
        expect(marker).toMatchObject({
            state: "available",
            value: { preparationState: "consumed", preparationRevision: 3 },
        });
        if (marker.state !== "available" || marker.value.preparationState !== "consumed") {
            throw new Error("consumed marker fixture missing");
        }
        expect(marker.value.intent.expectedPostAssetManifestAuthoritySetFingerprint).toBe(
            computePostAssetManifestAuthoritySetFingerprint(readAssetManifestAuthoritySet(harness.assetsRoot, [ASSET_UUID])),
        );
    });

    it("keeps an unrelated Deployment Asset exact during a one-Version reverse transition", async () => {
        const multi = createHarness("not_required", true);
        try {
            const service = createReverseAcceptService(multi.configuration());
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(multi.analysis))).status).toBe("complete");
            const db = new Database(multi.databasePath);
            expect(listDeploymentAssets(db, DEPLOYMENT_ID, false).map((row) => [row.assetId, row.versionId])).toEqual([
                [ASSET_UUID, STAGED_VERSION_ID],
                [SECOND_ASSET_ID, SECOND_VERSION_ID],
            ]);
            db.close();
        } finally {
            fs.rmSync(multi.root, { recursive: true, force: true });
        }
    });

    it("rejects missing, duplicate, mismatched, and extra Deployment payload closures before claim", async () => {
        const extraBytes = new Uint8Array(Buffer.from("extra", "utf-8"));
        const cases: Array<{
            label: string;
            mutate(value: FreshReverseAcceptCommitDraft): void;
        }> = [
            {
                label: "non-array",
                mutate: (value) => {
                    value.deploymentPayloads = null as never;
                },
            },
            {
                label: "missing",
                mutate: (value) => {
                    value.deploymentPayloads = [];
                },
            },
            {
                label: "duplicate",
                mutate: (value) => {
                    value.deploymentPayloads.push(structuredClone(value.deploymentPayloads[0]!));
                },
            },
            {
                label: "mismatched bytes",
                mutate: (value) => {
                    value.deploymentPayloads[0]!.bytes = extraBytes;
                },
            },
            {
                label: "mismatched kind",
                mutate: (value) => {
                    value.deploymentPayloads[0]!.contentKind = "binary";
                },
            },
            {
                label: "invalid active payload reference",
                mutate: (value) => {
                    value.successCommit.verifiedActiveFiles[0]!.appliedPayload.byteSize = -1;
                },
            },
            {
                label: "conflicting active payload metadata",
                mutate: (value) => {
                    const second = structuredClone(value.successCommit.verifiedActiveFiles[0]!);
                    second.verified.relativePath = "OTHER.md";
                    second.appliedPayload.contentKind = "binary";
                    value.successCommit.verifiedActiveFiles.push(second);
                },
            },
            {
                label: "payload object has an extra key",
                mutate: (value) => {
                    value.deploymentPayloads[0] = {
                        ...value.deploymentPayloads[0]!,
                        extra: true,
                    } as never;
                },
            },
            {
                label: "extra",
                mutate: (value) => {
                    value.deploymentPayloads.push({
                        contentKind: "text",
                        contentHash: sha256Bytes(extraBytes),
                        bytes: extraBytes,
                    });
                },
            },
            {
                label: "two-payload canonicalization reaches later join validation",
                mutate: (value) => {
                    const bytes = new Uint8Array(Buffer.from("second payload", "utf-8"));
                    const second = structuredClone(value.successCommit.verifiedActiveFiles[0]!);
                    second.verified.relativePath = "SECOND.md";
                    second.verified.appliedContentHash = sha256Bytes(bytes);
                    second.verified.observedContentHash = sha256Bytes(bytes);
                    second.appliedPayload = {
                        contentKind: "text",
                        contentHash: sha256Bytes(bytes),
                        byteSize: bytes.byteLength,
                    };
                    value.successCommit.verifiedActiveFiles.push(second);
                    value.deploymentPayloads.push({
                        contentKind: "text",
                        contentHash: sha256Bytes(bytes),
                        bytes,
                    });
                    value.successCommit.now += 1;
                },
            },
        ];
        for (const testCase of cases) {
            const isolated = createHarness();
            try {
                const service = createReverseAcceptService(
                    isolated.configuration({
                        resolveFreshCommit: async (input) => {
                            const value = isolated.makeCommitDraft(input.stagedVersionOriginAuthority, input.promotionGrantId);
                            testCase.mutate(value);
                            return { status: "complete", value, diagnostics: [] };
                        },
                    }),
                );
                await prepare(service);
                const result = await service.commitRenderedTargetAccept(commitRequest(isolated.analysis));
                expect(result.status, testCase.label).toBe("failed");
                expect(result.diagnostics[0]?.code, testCase.label).toBe("reverse_accept.invalid_commit_draft");
                expect(
                    createReverseAcceptMarkerStore(
                        isolated.transactionsRoot,
                        exactAnalysisValidator(isolated.analysis),
                    ).readMarker(PREPARATION_ID),
                    testCase.label,
                ).toMatchObject({
                    state: "available",
                    value: { preparationState: "prepared" },
                });
            } finally {
                fs.rmSync(isolated.root, { recursive: true, force: true });
            }
        }
    });

    it("rejects invalid and hash-conflicting residual payload references before claim", async () => {
        const cases: Array<{
            label: string;
            expectedCode: string;
            mutate(value: FreshReverseAcceptCommitDraft): void;
        }> = [
            {
                label: "invalid residual payload reference",
                expectedCode: "reverse_accept.invalid_commit_draft",
                mutate(value) {
                    value.successCommit.newlyRemoved[0]!.appliedPayload.byteSize = -1;
                },
            },
            {
                label: "residual hash conflicts with active payload metadata",
                expectedCode: "reverse_accept.invalid_commit_draft",
                mutate(value) {
                    value.successCommit.newlyRemoved[0]!.appliedPayload.contentHash =
                        value.successCommit.verifiedActiveFiles[0]!.appliedPayload.contentHash;
                },
            },
            {
                label: "binary residual shape reaches prior-baseline authority validation",
                expectedCode: "reverse_accept.internal_failure",
                mutate(value) {
                    const residual = value.successCommit.newlyRemoved[0]!;
                    residual.appliedPayload.contentKind = "binary";
                    const payload = value.deploymentPayloads.find(
                        (candidate) => candidate.contentHash === residual.appliedPayload.contentHash,
                    );
                    if (payload === undefined) throw new Error("residual payload fixture missing");
                    payload.contentKind = "binary";
                },
            },
        ];
        for (const testCase of cases) {
            const isolated = createHarness("not_required", false, true);
            try {
                const service = createReverseAcceptService(
                    isolated.configuration({
                        resolveFreshCommit: async (input) => {
                            const value = isolated.makeCommitDraft(input.stagedVersionOriginAuthority, input.promotionGrantId);
                            testCase.mutate(value);
                            return { status: "complete", value, diagnostics: [] };
                        },
                    }),
                );
                await prepare(service);
                const result = await service.commitRenderedTargetAccept(commitRequest(isolated.analysis));
                expect(result.status, testCase.label).toBe("failed");
                expect(result.diagnostics[0]?.code, testCase.label).toBe(testCase.expectedCode);
                expect(
                    createReverseAcceptMarkerStore(
                        isolated.transactionsRoot,
                        exactAnalysisValidator(isolated.analysis),
                    ).readMarker(PREPARATION_ID),
                    testCase.label,
                ).toMatchObject({
                    state: "available",
                    value: { preparationState: "prepared" },
                });
            } finally {
                fs.rmSync(isolated.root, { recursive: true, force: true });
            }
        }
    });

    it("classifies Deployment payload publish and readback failures before DB commit", async () => {
        const cases = [
            {
                label: "publish failure",
                dependencies: {
                    publishDeploymentPayloads() {
                        throw new Error("payload publish failed");
                    },
                },
            },
            {
                label: "readback mismatch",
                dependencies: {
                    readDeploymentPayload() {
                        return new Uint8Array(Buffer.from("wrong", "utf-8"));
                    },
                },
            },
        ];
        for (const testCase of cases) {
            const isolated = createHarness();
            try {
                const store = createReverseAcceptMarkerStore(
                    isolated.transactionsRoot,
                    exactAnalysisValidator(isolated.analysis),
                );
                const service = createReverseAcceptServiceForTest(
                    isolated.configuration(),
                    store,
                    undefined,
                    testCase.dependencies,
                );
                await prepare(service);
                const result = await service.commitRenderedTargetAccept(commitRequest(isolated.analysis));
                expect(result, testCase.label).toMatchObject({
                    status: "partial",
                    value: {
                        commitState: "not_committed",
                        versionPublicationState: "published_not_selected",
                    },
                });
                expect(store.readMarker(PREPARATION_ID), testCase.label).toMatchObject({
                    state: "available",
                    value: { preparationState: "failed" },
                });
                const db = new Database(isolated.databasePath);
                expect(listDeploymentAssets(db, DEPLOYMENT_ID, false)[0]?.versionId, testCase.label).toBe(OLD_VERSION_UUID);
                db.close();
            } finally {
                fs.rmSync(isolated.root, { recursive: true, force: true });
            }
        }
    });

    it("refuses success when an unrelated Asset authority changes after claim", async () => {
        const multi = createHarness("not_required", true);
        try {
            const store = createReverseAcceptMarkerStore(multi.transactionsRoot, exactAnalysisValidator(multi.analysis));
            const service = createReverseAcceptServiceForTest(multi.configuration(), store, undefined, {
                publishVersion(input) {
                    publishReverseAcceptedAssetVersion(input);
                    const current = readAssetManifest(multi.assetsRoot, SECOND_ASSET_ID);
                    if (current === null) throw new Error("second Asset fixture missing");
                    writeAssetManifest(multi.assetsRoot, {
                        ...current,
                        updatedAt: current.updatedAt + 1,
                    });
                },
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(multi.analysis))).diagnostics[0]?.code).toBe(
                "reverse_accept.asset_publication_unconfirmed",
            );
        } finally {
            fs.rmSync(multi.root, { recursive: true, force: true });
        }
    });

    it("rechecks post-Asset and filesystem-receipt fingerprints after claim", async () => {
        const cases: Array<{
            label: string;
            mutate(intent: ClaimedIntentRecord): void;
        }> = [
            {
                label: "post-Asset authority-set fingerprint",
                mutate: (intent) => {
                    intent.expectedPostAssetManifestAuthoritySetFingerprint = HASH_A;
                },
            },
            {
                label: "filesystem receipt",
                mutate: (intent) => {
                    intent.stagedVersionFingerprint = HASH_A;
                    const receipt = buildAssetFilesystemCommitReceipt({
                        schemaVersion: 1,
                        preparationIdentityFingerprint: intent.preparationIdentityFingerprint as Sha256Digest,
                        stagedAssetId: intent.stagedAssetId as UuidV4,
                        stagedVersionId: intent.stagedVersionId as UuidV4,
                        stagedVersionFingerprint: HASH_A,
                        stagedVersionOriginAuthorityFingerprint: (
                            intent.stagedVersionOriginAuthority as {
                                authorityFingerprint: Sha256Digest;
                            }
                        ).authorityFingerprint,
                        stagedPromotionPublication: intent.stagedPromotionPublication as Parameters<
                            typeof buildAssetFilesystemCommitReceipt
                        >[0]["stagedPromotionPublication"],
                        stagedAssetManifestFingerprint: intent.stagedAssetManifestFingerprint as Sha256Digest,
                        postAssetManifestAuthoritySetFingerprint:
                            intent.expectedPostAssetManifestAuthoritySetFingerprint as Sha256Digest,
                    });
                    intent.expectedAssetFilesystemReceiptFingerprint = receipt.assetFilesystemReceiptFingerprint;
                },
            },
        ];
        for (const testCase of cases) {
            const isolated = createHarness();
            try {
                const base = createReverseAcceptMarkerStore(isolated.transactionsRoot, exactAnalysisValidator(isolated.analysis));
                const store = {
                    ...base,
                    claimPrepared(...args: Parameters<typeof base.claimPrepared>) {
                        const claimed = base.claimPrepared(...args);
                        const intent = structuredClone(claimed.intent) as unknown as ClaimedIntentRecord;
                        testCase.mutate(intent);
                        const { commitIntentFingerprint: _intentFingerprint, ...intentPreimage } = intent;
                        intent.commitIntentFingerprint = computeReverseAcceptCommitIntentFingerprint(
                            intentPreimage as Parameters<typeof computeReverseAcceptCommitIntentFingerprint>[0],
                        );
                        const { markerFingerprint: _markerFingerprint, ...markerPreimage } = claimed;
                        const changed = { ...markerPreimage, intent };
                        return {
                            ...changed,
                            markerFingerprint: computeReverseAcceptMarkerFingerprint(changed),
                        };
                    },
                };
                const service = createReverseAcceptServiceForTest(isolated.configuration(), store);
                await prepare(service);
                const result = await service.commitRenderedTargetAccept(commitRequest(isolated.analysis));
                expect(result.status, testCase.label).toBe("failed");
                expect(result.diagnostics[0]?.code, testCase.label).toBe("reverse_accept.asset_publication_unconfirmed");
            } finally {
                fs.rmSync(isolated.root, { recursive: true, force: true });
            }
        }
    });
});
