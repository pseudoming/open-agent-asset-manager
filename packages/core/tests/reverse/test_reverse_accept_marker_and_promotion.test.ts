import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPromotionGrantAuthority, readPromotionGrantAuthority } from "../../src/catalog/promotion-grant-store";
import { buildDeploymentCommitReceipt } from "../../src/deployment/deployment-commit-receipts";
import {
    computeReverseAcceptMarkerFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../src/foundation/fingerprint";
import {
    buildAssetFilesystemCommitReceipt,
    buildClaimedRenderedTargetCommitIntent,
    buildReverseAcceptPreparationIdentity,
    createReverseAcceptMarkerStore,
    requireIntentExtendsPreparedForTest,
    type ReverseAcceptPreparationMarkerV1,
    validateAssetFilesystemCommitReceiptForTest,
    validateClaimedRenderedTargetCommitIntentForTest,
    validateReverseAcceptMarkerForTest,
} from "../../src/reverse/reverse-accept-marker";
import { createReverseAcceptService } from "../../src/reverse/reverse-accept-service";
import {
    ASSET_UUID,
    commitRequest,
    createHarness,
    exactAnalysisValidator,
    harness,
    HASH_A,
    HASH_B,
    PREPARATION_ID,
    prepare,
    PROMOTION_GRANT_ID,
    STAGED_VERSION_ID,
} from "./fixtures/reverse-accept-commit-test-fixtures";

describe("reverse-accept marker and promotion", () => {
    it("rejects malformed claimed, filesystem-receipt, and terminal marker authorities", async () => {
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const service = createReverseAcceptService(harness.configuration());
        await prepare(service);
        const preparedRead = store.readMarker(PREPARATION_ID);
        if (preparedRead.state !== "available" || preparedRead.value.preparationState !== "prepared") {
            throw new Error("prepared marker fixture missing");
        }
        const prepared = preparedRead.value;
        const committed = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
        expect(committed.status).toBe("complete");
        const consumedRead = store.readMarker(PREPARATION_ID);
        if (consumedRead.state !== "available" || consumedRead.value.preparationState !== "consumed") {
            throw new Error("consumed marker fixture missing");
        }
        const consumed = consumedRead.value;
        const intent = consumed.intent;
        const filesystemReceipt = buildAssetFilesystemCommitReceipt({
            schemaVersion: 1,
            preparationIdentityFingerprint: intent.preparationIdentityFingerprint,
            stagedAssetId: intent.stagedAssetId,
            stagedVersionId: intent.stagedVersionId,
            stagedVersionFingerprint: intent.stagedVersionFingerprint,
            stagedVersionOriginAuthorityFingerprint: intent.stagedVersionOriginAuthority.authorityFingerprint,
            stagedPromotionPublication: intent.stagedPromotionPublication,
            stagedAssetManifestFingerprint: intent.stagedAssetManifestFingerprint,
            postAssetManifestAuthoritySetFingerprint: intent.expectedPostAssetManifestAuthoritySetFingerprint,
        });
        validateClaimedRenderedTargetCommitIntentForTest(intent);
        validateAssetFilesystemCommitReceiptForTest(filesystemReceipt);
        validateReverseAcceptMarkerForTest(consumed, exactAnalysisValidator(harness.analysis));
        requireIntentExtendsPreparedForTest(intent, prepared);

        const invalidIntentCases: Array<{
            label: string;
            mutate(value: Record<string, unknown>): void;
        }> = [
            { label: "extra key", mutate: (value) => Object.assign(value, { extra: true }) },
            {
                label: "revision",
                mutate: (value) => Object.assign(value, { claimedPreparationRevision: 0 }),
            },
            {
                label: "Asset ID",
                mutate: (value) => Object.assign(value, { stagedAssetId: "bad" }),
            },
            {
                label: "Version ID",
                mutate: (value) => Object.assign(value, { stagedVersionId: "bad" }),
            },
            {
                label: "digest",
                mutate: (value) => Object.assign(value, { selectionFingerprint: "bad" }),
            },
            {
                label: "authority array",
                mutate: (value) => Object.assign(value, { assetManifestAuthorities: null }),
            },
            {
                label: "authority-set fingerprint",
                mutate: (value) => Object.assign(value, { assetManifestAuthoritySetFingerprint: HASH_A }),
            },
            {
                label: "staged Asset outside authority",
                mutate: (value) => Object.assign(value, { stagedAssetId: PREPARATION_ID }),
            },
            {
                label: "origin Asset mismatch",
                mutate: (value) => {
                    const origin = structuredClone(value.stagedVersionOriginAuthority) as Record<string, unknown>;
                    origin.assetId = PREPARATION_ID;
                    const { authorityFingerprint: _fingerprint, ...preimage } = origin;
                    origin.authorityFingerprint = computeVersionOriginAuthorityFingerprint(
                        preimage as Parameters<typeof computeVersionOriginAuthorityFingerprint>[0],
                    );
                    value.stagedVersionOriginAuthority = origin;
                },
            },
            {
                label: "expected DB receipt",
                mutate: (value) => Object.assign(value, { expectedCommitReceiptFingerprint: HASH_A }),
            },
            {
                label: "expected filesystem receipt",
                mutate: (value) => Object.assign(value, { expectedAssetFilesystemReceiptFingerprint: HASH_A }),
            },
            {
                label: "intent fingerprint",
                mutate: (value) => Object.assign(value, { commitIntentFingerprint: HASH_A }),
            },
            {
                label: "promotion object",
                mutate: (value) => Object.assign(value, { stagedPromotionPublication: null }),
            },
            {
                label: "promotion discriminator",
                mutate: (value) =>
                    Object.assign(value, {
                        stagedPromotionPublication: { publicationState: 1 },
                    }),
            },
            {
                label: "no-grant promotion extra key",
                mutate: (value) =>
                    Object.assign(value, {
                        stagedPromotionPublication: {
                            publicationState: "not_created",
                            extra: true,
                        },
                    }),
            },
            {
                label: "unknown promotion branch",
                mutate: (value) =>
                    Object.assign(value, {
                        stagedPromotionPublication: { publicationState: "future" },
                    }),
            },
            {
                label: "missing promotion grant",
                mutate: (value) =>
                    Object.assign(value, {
                        stagedPromotionPublication: { publicationState: "version_target_grant" },
                    }),
            },
            {
                label: "malformed promotion grant",
                mutate: (value) =>
                    Object.assign(value, {
                        stagedPromotionPublication: {
                            publicationState: "version_target_grant",
                            promotionGrant: null,
                        },
                    }),
            },
        ];
        for (const testCase of invalidIntentCases) {
            const candidate = structuredClone(intent) as unknown as Record<string, unknown>;
            testCase.mutate(candidate);
            expect(() => validateClaimedRenderedTargetCommitIntentForTest(candidate), testCase.label).toThrow();
        }

        const invalidOriginFields: Array<[string, unknown]> = [
            ["schemaVersion", 2],
            ["originKind", "user_created"],
            ["assetId", "bad"],
            ["versionId", "bad"],
            ["previousVersionId", "bad"],
            ["previousVersionOriginAuthorityFingerprint", "bad"],
            ["reversePreparationIdentityFingerprint", "bad"],
            ["userActionEvidenceId", 1],
            ["userActionEvidenceId", " "],
            ["promotionRequirement", "bad"],
            ["createdAt", -1],
            ["authorityFingerprint", "bad"],
            ["authorityFingerprint", HASH_A],
        ];
        for (const [field, invalid] of invalidOriginFields) {
            const candidate = structuredClone(intent) as unknown as Record<string, unknown>;
            const origin = candidate.stagedVersionOriginAuthority as Record<string, unknown>;
            origin[field] = invalid;
            expect(
                () => validateClaimedRenderedTargetCommitIntentForTest(candidate),
                `origin ${field}:${String(invalid)}`,
            ).toThrow();
        }
        for (const invalidOrigin of [null, { ...intent.stagedVersionOriginAuthority, extra: true }]) {
            const candidate = structuredClone(intent) as unknown as Record<string, unknown>;
            candidate.stagedVersionOriginAuthority = invalidOrigin;
            expect(() => validateClaimedRenderedTargetCommitIntentForTest(candidate)).toThrow();
        }

        const invalidReceiptCases: Array<{
            label: string;
            mutate(value: Record<string, unknown>): void;
        }> = [
            { label: "extra key", mutate: (value) => Object.assign(value, { extra: true }) },
            { label: "schema", mutate: (value) => Object.assign(value, { schemaVersion: 2 }) },
            {
                label: "Asset ID",
                mutate: (value) => Object.assign(value, { stagedAssetId: "bad" }),
            },
            {
                label: "Version ID",
                mutate: (value) => Object.assign(value, { stagedVersionId: "bad" }),
            },
            {
                label: "digest",
                mutate: (value) => Object.assign(value, { stagedVersionFingerprint: "bad" }),
            },
            {
                label: "promotion object",
                mutate: (value) => Object.assign(value, { stagedPromotionPublication: null }),
            },
            {
                label: "no-grant extra key",
                mutate: (value) =>
                    Object.assign(value, {
                        stagedPromotionPublication: {
                            publicationState: "not_created",
                            extra: true,
                        },
                    }),
            },
            {
                label: "unknown promotion branch",
                mutate: (value) =>
                    Object.assign(value, {
                        stagedPromotionPublication: { publicationState: "future" },
                    }),
            },
            {
                label: "malformed grant",
                mutate: (value) =>
                    Object.assign(value, {
                        stagedPromotionPublication: {
                            publicationState: "version_target_grant",
                            promotionGrant: null,
                        },
                    }),
            },
            {
                label: "receipt fingerprint",
                mutate: (value) => Object.assign(value, { assetFilesystemReceiptFingerprint: HASH_A }),
            },
        ];
        for (const testCase of invalidReceiptCases) {
            const candidate = structuredClone(filesystemReceipt) as unknown as Record<string, unknown>;
            testCase.mutate(candidate);
            expect(() => validateAssetFilesystemCommitReceiptForTest(candidate), testCase.label).toThrow();
        }

        const markerFromPreimage = (preimage: Record<string, unknown>): ReverseAcceptPreparationMarkerV1 =>
            ({
                ...preimage,
                markerFingerprint: computeReverseAcceptMarkerFingerprint(
                    preimage as Parameters<typeof computeReverseAcceptMarkerFingerprint>[0],
                ),
            }) as ReverseAcceptPreparationMarkerV1;
        const claimed = markerFromPreimage({
            identity: consumed.identity,
            preparationRevision: 2,
            preparationState: "claimed",
            intent,
        });
        const failedPre = markerFromPreimage({
            identity: consumed.identity,
            preparationRevision: 3,
            preparationState: "failed",
            intent,
            filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
        });
        const failedPublished = markerFromPreimage({
            identity: consumed.identity,
            preparationRevision: 3,
            preparationState: "failed",
            intent,
            filesystemTerminalProof: {
                filesystemTerminalState: "staged_manifest_published",
                assetFilesystemReceipt: filesystemReceipt,
            },
        });
        for (const valid of [claimed, failedPre, failedPublished]) {
            validateReverseAcceptMarkerForTest(valid, exactAnalysisValidator(harness.analysis));
        }
        const markerCases: unknown[] = [
            markerFromPreimage({
                ...claimed,
                preparationRevision: 3,
                markerFingerprint: undefined,
            } as never),
            markerFromPreimage({
                ...consumed,
                preparationRevision: 2,
                markerFingerprint: undefined,
            } as never),
            markerFromPreimage({
                ...failedPre,
                preparationRevision: 2,
                markerFingerprint: undefined,
            } as never),
            { ...claimed, extra: true },
            { ...consumed, extra: true },
            { ...failedPre, extra: true },
            { ...claimed, preparationState: "future" },
            { ...claimed, markerFingerprint: "bad" },
            { ...claimed, markerFingerprint: HASH_A },
        ];
        for (const invalid of markerCases) {
            expect(() => validateReverseAcceptMarkerForTest(invalid, exactAnalysisValidator(harness.analysis))).toThrow();
        }

        const identityMismatch = buildReverseAcceptPreparationIdentity({
            preparationId: consumed.identity.preparationId,
            deploymentId: consumed.identity.deploymentId,
            commitTransactionId: consumed.identity.commitTransactionId,
            assetIds: [PREPARATION_ID],
        });
        expect(() =>
            validateReverseAcceptMarkerForTest(
                markerFromPreimage({
                    identity: identityMismatch,
                    preparationRevision: 2,
                    preparationState: "claimed",
                    intent,
                }),
                exactAnalysisValidator(harness.analysis),
            ),
        ).toThrow(/does not join/);

        const foreignReceipt = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId: PREPARATION_ID,
            commitTransactionId: consumed.commitReceipt.commitTransactionId,
            preCommitDatabaseStateFingerprint: consumed.commitReceipt.preCommitDatabaseStateFingerprint,
            appliedInputsSnapshotFingerprint: consumed.commitReceipt.appliedInputsSnapshotFingerprint,
            appliedRenderSnapshotFingerprint: consumed.commitReceipt.appliedRenderSnapshotFingerprint,
            deploymentFileBaselineSetFingerprint: consumed.commitReceipt.deploymentFileBaselineSetFingerprint,
        });
        expect(() =>
            validateReverseAcceptMarkerForTest(
                markerFromPreimage({
                    identity: consumed.identity,
                    preparationRevision: 3,
                    preparationState: "consumed",
                    intent,
                    commitReceipt: foreignReceipt,
                }),
                exactAnalysisValidator(harness.analysis),
            ),
        ).toThrow(/contradicts claimed intent/);

        for (const proof of [
            null,
            { filesystemTerminalState: "pre_authority", extra: true },
            { filesystemTerminalState: "future" },
            { filesystemTerminalState: "staged_manifest_published" },
            {
                filesystemTerminalState: "staged_manifest_published",
                assetFilesystemReceipt: buildAssetFilesystemCommitReceipt({
                    schemaVersion: 1,
                    preparationIdentityFingerprint: HASH_A,
                    stagedAssetId: intent.stagedAssetId,
                    stagedVersionId: intent.stagedVersionId,
                    stagedVersionFingerprint: intent.stagedVersionFingerprint,
                    stagedVersionOriginAuthorityFingerprint: intent.stagedVersionOriginAuthority.authorityFingerprint,
                    stagedPromotionPublication: intent.stagedPromotionPublication,
                    stagedAssetManifestFingerprint: intent.stagedAssetManifestFingerprint,
                    postAssetManifestAuthoritySetFingerprint: intent.expectedPostAssetManifestAuthoritySetFingerprint,
                }),
            },
        ]) {
            const invalid = markerFromPreimage({
                identity: consumed.identity,
                preparationRevision: 3,
                preparationState: "failed",
                intent,
                filesystemTerminalProof: proof,
            } as never);
            expect(() => validateReverseAcceptMarkerForTest(invalid, exactAnalysisValidator(harness.analysis))).toThrow();
        }

        const { commitIntentFingerprint: _commitIntentFingerprint, ...intentPreimage } = intent;
        const changedIntent = buildClaimedRenderedTargetCommitIntent({
            ...intentPreimage,
            deploymentAuthorityFingerprint: HASH_B,
        });
        expect(() => requireIntentExtendsPreparedForTest(changedIntent, prepared)).toThrow(/does not extend/);
    });

    it("publishes and consumes an exact staged-Version promotion grant", async () => {
        const restricted = createHarness("requires_current_authorization");
        try {
            const service = createReverseAcceptService(restricted.configuration());
            await prepare(service);
            const request = commitRequest(restricted.analysis);
            request.newVersionPromotion = {
                promotionAction: "grant_staged_version_current_target",
            };
            const result = await service.commitRenderedTargetAccept(request);
            expect(result.status).toBe("complete");
            expect(readPromotionGrantAuthority(restricted.assetsRoot, ASSET_UUID, PROMOTION_GRANT_ID)).toMatchObject({
                promotionGrantId: PROMOTION_GRANT_ID,
                subject: {
                    subjectKind: "asset_version",
                    assetId: ASSET_UUID,
                    versionId: STAGED_VERSION_ID,
                },
            });
            const markerRead = createReverseAcceptMarkerStore(
                restricted.transactionsRoot,
                exactAnalysisValidator(restricted.analysis),
            ).readMarker(PREPARATION_ID);
            expect(markerRead).toMatchObject({
                state: "available",
                value: {
                    preparationState: "consumed",
                    intent: {
                        stagedPromotionPublication: {
                            publicationState: "version_target_grant",
                            promotionGrant: { promotionGrantId: PROMOTION_GRANT_ID },
                        },
                    },
                },
            });
            if (
                markerRead.state !== "available" ||
                markerRead.value.preparationState !== "consumed" ||
                markerRead.value.intent.stagedPromotionPublication.publicationState !== "version_target_grant"
            ) {
                throw new Error("restricted consumed marker fixture missing");
            }
            const restrictedIntent = markerRead.value.intent;
            const baseGrant = restrictedIntent.stagedPromotionPublication.promotionGrant;
            const invalidBindingGrants = [
                buildPromotionGrantAuthority({
                    promotionGrantId: baseGrant.promotionGrantId,
                    subject: {
                        subjectKind: "asset_all_versions",
                        assetId: ASSET_UUID,
                        activationVersionId: STAGED_VERSION_ID,
                    },
                    target: baseGrant.target,
                    userActionEvidenceId: baseGrant.userActionEvidenceId,
                    updatedAt: baseGrant.updatedAt,
                }),
                buildPromotionGrantAuthority({
                    promotionGrantId: baseGrant.promotionGrantId,
                    subject: {
                        subjectKind: "asset_version",
                        assetId: PREPARATION_ID,
                        versionId: STAGED_VERSION_ID,
                    },
                    target: baseGrant.target,
                    userActionEvidenceId: baseGrant.userActionEvidenceId,
                    updatedAt: baseGrant.updatedAt,
                }),
                buildPromotionGrantAuthority({
                    promotionGrantId: baseGrant.promotionGrantId,
                    subject: {
                        subjectKind: "asset_version",
                        assetId: ASSET_UUID,
                        versionId: PREPARATION_ID,
                    },
                    target: baseGrant.target,
                    userActionEvidenceId: baseGrant.userActionEvidenceId,
                    updatedAt: baseGrant.updatedAt,
                }),
                buildPromotionGrantAuthority({
                    promotionGrantId: baseGrant.promotionGrantId,
                    subject: baseGrant.subject,
                    target: baseGrant.target,
                    userActionEvidenceId: "different-action",
                    updatedAt: baseGrant.updatedAt,
                }),
                buildPromotionGrantAuthority({
                    promotionGrantId: baseGrant.promotionGrantId,
                    subject: baseGrant.subject,
                    target: baseGrant.target,
                    userActionEvidenceId: baseGrant.userActionEvidenceId,
                    updatedAt: baseGrant.updatedAt + 1,
                }),
            ];
            for (const grant of invalidBindingGrants) {
                const candidate = structuredClone(restrictedIntent) as unknown as Record<string, unknown>;
                candidate.stagedPromotionPublication = {
                    publicationState: "version_target_grant",
                    promotionGrant: grant,
                };
                expect(() => validateClaimedRenderedTargetCommitIntentForTest(candidate)).toThrow(/does not bind/);
            }
        } finally {
            fs.rmSync(restricted.root, { recursive: true, force: true });
        }
    });
});
