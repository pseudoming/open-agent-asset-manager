import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { type buildPromotionGrantAuthority, createPromotionGrantAuthority } from "../../src/catalog/promotion-grant-store";
import { publishReverseAcceptedAssetVersion } from "../../src/catalog/version-authority";
import { commitReverseAcceptVersionSelectionSuccessCrashDurable } from "../../src/deployment/deployment-state-authority";
import { computeRenderOutputUnitFingerprint } from "../../src/foundation/fingerprint";
import { listDeploymentAssets } from "../../src/persistence/state-db";
import { promotionTargetForDeployment } from "../../src/render/render-promotion-authorization";
import { createReverseAcceptMarkerStore } from "../../src/reverse/reverse-accept-marker";
import {
    createReverseAcceptService,
    createReverseAcceptServiceForTest,
    type FreshReverseAcceptCommitDraft,
    physicalKeysForCommitForTest,
} from "../../src/reverse/reverse-accept-service";
import { ASSET_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
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
    PROMOTION_GRANT_ID,
    refreshSuccessProvenance,
    STAGED_VERSION_ID,
} from "./fixtures/reverse-accept-commit-test-fixtures";
import { DEPLOYMENT_ID, makeSuccessInput, textPlan } from "./fixtures/reverse-accept-db-fixtures";

describe("reverse-accept publication outcomes", () => {
    it("rejects invalid promotion choices and stale restricted authorization joins", async () => {
        const nonRestricted = createHarness();
        try {
            const service = createReverseAcceptService(nonRestricted.configuration());
            await prepare(service);
            const request = commitRequest(nonRestricted.analysis);
            request.newVersionPromotion = {
                promotionAction: "grant_staged_version_current_target",
            };
            expect((await service.commitRenderedTargetAccept(request)).diagnostics[0]?.code).toBe(
                "reverse_accept.promotion_choice_invalid",
            );
        } finally {
            fs.rmSync(nonRestricted.root, { recursive: true, force: true });
        }

        const cases: Array<{
            label: string;
            action: "use_existing_authority" | "grant_staged_version_current_target";
            mutate(draft: FreshReverseAcceptCommitDraft): void;
        }> = [
            {
                label: "restricted Version is not authorized",
                action: "grant_staged_version_current_target",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.promotionAuthorizations[0] = {
                        promotionAuthorizationState: "not_required",
                        assetId: ASSET_UUID,
                        versionId: STAGED_VERSION_ID,
                        target: promotionTargetForDeployment(draft.deployment),
                        versionOriginAuthorityFingerprint: draft.stagedVersion.manifest.originAuthority.authorityFingerprint,
                    };
                },
            },
            ...(["authorizationSource", "authorityId", "authorityRevision", "authorityFingerprint"] as const).map((field) => ({
                label: `staged grant ${field} mismatch`,
                action: "grant_staged_version_current_target" as const,
                mutate(draft: FreshReverseAcceptCommitDraft) {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    const authorization = draft.successCommit.appliedRenderSnapshot.promotionAuthorizations[0];
                    if (authorization?.promotionAuthorizationState !== "authorized") {
                        throw new Error("fixture authorization missing");
                    }
                    if (field === "authorizationSource") {
                        authorization.authorizationSource = "asset_all_versions_target_grant";
                    } else if (field === "authorityId") {
                        authorization.authorityId = PREPARATION_ID;
                    } else if (field === "authorityRevision") {
                        authorization.authorityRevision += 1;
                    } else {
                        authorization.authorityFingerprint = HASH_A;
                    }
                },
            })),
            {
                label: "unpublished staged grant treated as existing",
                action: "use_existing_authority",
                mutate: () => undefined,
            },
        ];
        for (const testCase of cases) {
            const isolated = createHarness("requires_current_authorization");
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
                const request = commitRequest(isolated.analysis);
                request.newVersionPromotion = { promotionAction: testCase.action };
                const result = await service.commitRenderedTargetAccept(request);
                expect(result.status, testCase.label).toBe("failed");
                expect(result.diagnostics.length, testCase.label).toBeGreaterThan(0);
            } finally {
                fs.rmSync(isolated.root, { recursive: true, force: true });
            }
        }

        const existingAuthority = createHarness("requires_current_authorization");
        try {
            let grant: ReturnType<typeof buildPromotionGrantAuthority> | undefined;
            const service = createReverseAcceptService(
                existingAuthority.configuration({
                    resolveFreshCommit: async (input) => {
                        const value = existingAuthority.makeCommitDraft(
                            input.stagedVersionOriginAuthority,
                            input.promotionGrantId,
                        );
                        if (value.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                            throw new Error("fixture applied snapshot missing");
                        }
                        if (grant === undefined) {
                            grant = createPromotionGrantAuthority({
                                assetsRoot: existingAuthority.assetsRoot,
                                promotionGrantId: PROMOTION_GRANT_ID,
                                subject: {
                                    subjectKind: "asset_all_versions",
                                    assetId: ASSET_UUID,
                                    activationVersionId: OLD_VERSION_UUID,
                                },
                                target: promotionTargetForDeployment(value.deployment),
                                userActionEvidenceId: "existing-all-versions-grant",
                                updatedAt: 9_000,
                            });
                        }
                        value.successCommit.appliedRenderSnapshot.promotionAuthorizations[0] = {
                            promotionAuthorizationState: "authorized",
                            assetId: ASSET_UUID,
                            versionId: STAGED_VERSION_ID,
                            target: grant.target,
                            versionOriginAuthorityFingerprint: input.stagedVersionOriginAuthority.authorityFingerprint,
                            authorizationSource: "asset_all_versions_target_grant",
                            authorityId: grant.promotionGrantId,
                            authorityRevision: grant.revision,
                            authorityFingerprint: grant.grantFingerprint,
                        };
                        refreshSuccessProvenance(value);
                        return { status: "complete", value, diagnostics: [] };
                    },
                }),
            );
            await prepare(service);
            const result = await service.commitRenderedTargetAccept(commitRequest(existingAuthority.analysis));
            expect(result.status, JSON.stringify(result)).toBe("complete");
        } finally {
            fs.rmSync(existingAuthority.root, { recursive: true, force: true });
        }
    });

    it("derives physical file, parent, and managed-boundary locks from the first fresh draft", async () => {
        let calls = 0;
        const lockClosures: string[][] = [];
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const service = createReverseAcceptServiceForTest(
            harness.configuration({
                resolveFreshCommit: async (input) => {
                    calls += 1;
                    const value = harness.makeCommitDraft(input.stagedVersionOriginAuthority, input.promotionGrantId);
                    expect(() =>
                        physicalKeysForCommitForTest({
                            ...value,
                            deployment: null as never,
                        }),
                    ).toThrow("fresh commit draft has no Deployment lock authority");
                    expect(() =>
                        physicalKeysForCommitForTest({
                            ...value,
                            deployment: {
                                ...value.deployment,
                                targetRootPath: `${value.deployment.targetRootPath}${path.sep}.`,
                            },
                        }),
                    ).toThrow("fresh commit draft target root is not canonical absolute");
                    const withRemoval = structuredClone(value);
                    withRemoval.successCommit.newlyRemoved = [{ relativePath: "managed/removed.md" } as never];
                    expect(physicalKeysForCommitForTest(withRemoval)).toContain(
                        `linux\0${path.join(value.deployment.targetRootPath, "managed", "removed.md")}`,
                    );
                    const withFile = makeSuccessInput(textPlan("managed/a.md", "# edited"));
                    value.successCommit.verifiedActiveFiles = withFile.verifiedActiveFiles;
                    if (value.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    const snapshot = value.successCommit.appliedRenderSnapshot;
                    const currentUnit = withFile.appliedRenderSnapshot.outputUnits[0]!;
                    const { outputUnitFingerprint: _currentFingerprint, ...currentUnitPreimage } = currentUnit;
                    const unitPreimage = {
                        ...currentUnitPreimage,
                        managedDirectoryBoundaries: [
                            {
                                relativePath: "managed",
                                boundaryKind: "directory_inventory" as const,
                            },
                        ],
                    };
                    const outputUnitFingerprint = computeRenderOutputUnitFingerprint(unitPreimage);
                    snapshot.outputUnits = [{ ...unitPreimage, outputUnitFingerprint }];
                    snapshot.outputUnitRenderers = [
                        {
                            ...withFile.appliedRenderSnapshot.outputUnitRenderers[0]!,
                            outputUnitFingerprint,
                        },
                    ];
                    snapshot.semanticCoverageProofs = [
                        {
                            ...withFile.appliedRenderSnapshot.semanticCoverageProofs[0]!,
                            outputUnitFingerprint,
                        },
                    ];
                    if (calls === 2) value.compilationFingerprint = HASH_A;
                    return { status: "complete", value, diagnostics: [] };
                },
            }),
            store,
            (_root, keys) => {
                lockClosures.push([...keys]);
                return { release() {} };
            },
        );
        await prepare(service);
        const result = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
        expect(result.diagnostics[0]?.code, JSON.stringify(result)).toBe("reverse_accept.fresh_commit_changed");
        expect(lockClosures.some((keys) => keys.length >= 3)).toBe(true);
    });

    it("refuses to claim when the fresh commit draft changes while target locks are acquired", async () => {
        let calls = 0;
        const service = createReverseAcceptService(
            harness.configuration({
                resolveFreshCommit: async (input) => {
                    calls += 1;
                    const value = harness.makeCommitDraft(input.stagedVersionOriginAuthority, input.promotionGrantId);
                    if (calls === 2) value.compilationFingerprint = HASH_A;
                    return { status: "complete", value, diagnostics: [] };
                },
            }),
        );
        await service.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_UUID,
            inspectionResultFingerprint: HASH_C,
        });
        const beforeAsset = fs.readFileSync(path.join(harness.assetsRoot, ASSET_ID, "asset.json"));
        const result = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("reverse_accept.fresh_commit_changed");
        expect(fs.readFileSync(path.join(harness.assetsRoot, ASSET_ID, "asset.json"))).toEqual(beforeAsset);
        const marker = createReverseAcceptMarkerStore(
            harness.transactionsRoot,
            exactAnalysisValidator(harness.analysis),
        ).readMarker(PREPARATION_ID);
        expect(marker).toMatchObject({
            state: "available",
            value: { preparationState: "prepared", preparationRevision: 1 },
        });
        const db = new Database(harness.databasePath);
        expect(listDeploymentAssets(db, DEPLOYMENT_ID, false)[0]?.versionId).toBe(OLD_VERSION_UUID);
        db.close();
    });

    it("records a durable pre-authority failure when Version publication never starts", async () => {
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const service = createReverseAcceptServiceForTest(harness.configuration(), store, undefined, {
            publishVersion() {
                throw new Error("fault before Version publication");
            },
        });
        await prepare(service);
        const result = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
        expect(result).toMatchObject({
            status: "failed",
            value: { commitState: "not_committed", versionPublicationState: "not_published" },
        });
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: {
                preparationState: "failed",
                preparationRevision: 3,
                filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
            },
        });
        expect(fs.existsSync(path.join(harness.assetsRoot, ASSET_ID, "versions", VERSION_ID_2))).toBe(false);
    });

    it("reports published-not-selected after an exact Asset publish followed by DB failure", async () => {
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const service = createReverseAcceptServiceForTest(harness.configuration(), store, undefined, {
            commitDatabase() {
                throw new Error("fault before FULL transaction");
            },
        });
        await prepare(service);
        const result = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
        expect(result).toMatchObject({
            status: "partial",
            value: {
                commitState: "not_committed",
                versionPublicationState: "published_not_selected",
                version: { assetId: ASSET_UUID, versionId: STAGED_VERSION_ID },
            },
        });
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: {
                preparationState: "failed",
                filesystemTerminalProof: {
                    filesystemTerminalState: "staged_manifest_published",
                },
            },
        });
        const db = new Database(harness.databasePath);
        expect(listDeploymentAssets(db, DEPLOYMENT_ID, false)[0]?.versionId).toBe(OLD_VERSION_UUID);
        db.close();
    });

    it("classifies a publisher throw after exact publication from durable evidence", async () => {
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const service = createReverseAcceptServiceForTest(harness.configuration(), store, undefined, {
            publishVersion(input) {
                publishReverseAcceptedAssetVersion(input);
                throw new Error("lost acknowledgement after Asset publication");
            },
        });
        await prepare(service);
        const result = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
        expect(result).toMatchObject({
            status: "partial",
            value: {
                commitState: "not_committed",
                versionPublicationState: "published_not_selected",
            },
        });
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "failed" },
        });
    });

    it("returns committed when the FULL transaction committed before its acknowledgement was lost", async () => {
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const service = createReverseAcceptServiceForTest(harness.configuration(), store, undefined, {
            commitDatabase(input) {
                commitReverseAcceptVersionSelectionSuccessCrashDurable(input);
                throw new Error("lost acknowledgement after FULL COMMIT");
            },
        });
        await prepare(service);
        const result = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
        expect(result).toMatchObject({
            status: "complete",
            value: { commitState: "committed" },
        });
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "consumed" },
        });
    });

    it("does not claim success when marker consumption fails after DB commit", async () => {
        const base = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const store = {
            ...base,
            consumeClaimed() {
                throw new Error("fault while consuming claimed marker");
            },
        };
        const service = createReverseAcceptServiceForTest(harness.configuration(), store);
        await prepare(service);
        const result = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
        expect(result).toMatchObject({
            status: "failed",
            value: { commitState: "outcome_unavailable" },
        });
        expect(base.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "claimed" },
        });
        const db = new Database(harness.databasePath);
        expect(listDeploymentAssets(db, DEPLOYMENT_ID, false)[0]?.versionId).toBe(STAGED_VERSION_ID);
        db.close();
    });
});
