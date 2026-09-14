import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPromotionGrantAuthority, serializePromotionGrant } from "../../src/catalog/promotion-grant-store";
import { publishReverseAcceptedAssetVersion } from "../../src/catalog/version-authority";
import { serializeVersionManifest } from "../../src/catalog/version-manifest";
import {
    commitReverseAcceptVersionSelectionSuccessCrashDurable,
    prepareReverseAcceptDeploymentSuccessAuthority,
} from "../../src/deployment/deployment-state-authority";
import { createReverseAcceptMarkerStore } from "../../src/reverse/reverse-accept-marker";
import { createReverseAcceptServiceForTest } from "../../src/reverse/reverse-accept-service";
import { ASSET_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import {
    commitRequest,
    createHarness,
    exactAnalysisValidator,
    harness,
    HASH_A,
    PREPARATION_ID,
    prepare,
    PROMOTION_GRANT_ID,
} from "./fixtures/reverse-accept-commit-test-fixtures";
import { DEPLOYMENT_ID } from "./fixtures/reverse-accept-db-fixtures";

describe("reverse-accept post-claim recovery", () => {
    it("fails closed for each contradictory post-claim filesystem and database state", async () => {
        const noPublish = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(noPublish.transactionsRoot, exactAnalysisValidator(noPublish.analysis));
            const service = createReverseAcceptServiceForTest(noPublish.configuration(), store, undefined, {
                publishVersion: () => undefined,
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(noPublish.analysis))).diagnostics[0]?.code).toBe(
                "reverse_accept.asset_publication_unconfirmed",
            );
        } finally {
            fs.rmSync(noPublish.root, { recursive: true, force: true });
        }

        const changedDatabase = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                changedDatabase.transactionsRoot,
                exactAnalysisValidator(changedDatabase.analysis),
            );
            const service = createReverseAcceptServiceForTest(changedDatabase.configuration(), store, undefined, {
                publishVersion() {
                    const db = new Database(changedDatabase.databasePath);
                    db.prepare("UPDATE deployments SET updated_at = updated_at + 1 WHERE deployment_id = ?").run(DEPLOYMENT_ID);
                    db.close();
                    throw new Error("publisher failed after concurrent DB mutation");
                },
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(changedDatabase.analysis))).value.commitState).toBe(
                "outcome_unavailable",
            );
        } finally {
            fs.rmSync(changedDatabase.root, { recursive: true, force: true });
        }

        const missingDatabase = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                missingDatabase.transactionsRoot,
                exactAnalysisValidator(missingDatabase.analysis),
            );
            const service = createReverseAcceptServiceForTest(missingDatabase.configuration(), store, undefined, {
                publishVersion() {
                    fs.rmSync(missingDatabase.databasePath, { force: true });
                    fs.rmSync(`${missingDatabase.databasePath}-wal`, { force: true });
                    fs.rmSync(`${missingDatabase.databasePath}-shm`, { force: true });
                    throw new Error("publisher failed after database disappeared");
                },
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(missingDatabase.analysis))).value.commitState).toBe(
                "outcome_unavailable",
            );
        } finally {
            fs.rmSync(missingDatabase.root, { recursive: true, force: true });
        }

        const missingAsset = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                missingAsset.transactionsRoot,
                exactAnalysisValidator(missingAsset.analysis),
            );
            const service = createReverseAcceptServiceForTest(missingAsset.configuration(), store, undefined, {
                publishVersion() {
                    fs.rmSync(path.join(missingAsset.assetsRoot, ASSET_ID, "asset.json"));
                    throw new Error("publisher failed after Asset authority disappeared");
                },
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(missingAsset.analysis))).value.commitState).toBe(
                "outcome_unavailable",
            );
        } finally {
            fs.rmSync(missingAsset.root, { recursive: true, force: true });
        }

        const versionMismatch = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                versionMismatch.transactionsRoot,
                exactAnalysisValidator(versionMismatch.analysis),
            );
            const service = createReverseAcceptServiceForTest(versionMismatch.configuration(), store, undefined, {
                publishVersion(input) {
                    publishReverseAcceptedAssetVersion(input);
                    fs.writeFileSync(
                        path.join(versionMismatch.assetsRoot, ASSET_ID, "versions", VERSION_ID_2, "version.json"),
                        serializeVersionManifest({
                            ...input.version.manifest,
                            changeNote: "changed after publication",
                        }),
                    );
                },
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(versionMismatch.analysis))).diagnostics[0]?.code).toBe(
                "reverse_accept.asset_publication_unconfirmed",
            );
        } finally {
            fs.rmSync(versionMismatch.root, { recursive: true, force: true });
        }

        const corruptVersion = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                corruptVersion.transactionsRoot,
                exactAnalysisValidator(corruptVersion.analysis),
            );
            const service = createReverseAcceptServiceForTest(corruptVersion.configuration(), store, undefined, {
                publishVersion(input) {
                    publishReverseAcceptedAssetVersion(input);
                    fs.writeFileSync(
                        path.join(corruptVersion.assetsRoot, ASSET_ID, "versions", VERSION_ID_2, "version.json"),
                        "{bad json",
                    );
                },
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(corruptVersion.analysis))).diagnostics[0]?.code).toBe(
                "reverse_accept.asset_publication_unconfirmed",
            );
        } finally {
            fs.rmSync(corruptVersion.root, { recursive: true, force: true });
        }

        const grantMismatch = createHarness("requires_current_authorization");
        try {
            const store = createReverseAcceptMarkerStore(
                grantMismatch.transactionsRoot,
                exactAnalysisValidator(grantMismatch.analysis),
            );
            const service = createReverseAcceptServiceForTest(grantMismatch.configuration(), store, undefined, {
                publishVersion(input) {
                    publishReverseAcceptedAssetVersion(input);
                    if (input.promotion.promotionAction !== "publish_grant") {
                        throw new Error("fixture staged grant missing");
                    }
                    const changed = buildPromotionGrantAuthority({
                        promotionGrantId: input.promotion.grant.promotionGrantId,
                        subject: input.promotion.grant.subject,
                        target: input.promotion.grant.target,
                        userActionEvidenceId: "changed-after-publication",
                        updatedAt: input.promotion.grant.updatedAt,
                    });
                    fs.writeFileSync(
                        path.join(grantMismatch.assetsRoot, ASSET_ID, "promotion-grants", `${PROMOTION_GRANT_ID}.json`),
                        serializePromotionGrant(changed),
                    );
                },
            });
            await prepare(service);
            const request = commitRequest(grantMismatch.analysis);
            request.newVersionPromotion = {
                promotionAction: "grant_staged_version_current_target",
            };
            expect((await service.commitRenderedTargetAccept(request)).diagnostics[0]?.code).toBe(
                "reverse_accept.asset_publication_unconfirmed",
            );
        } finally {
            fs.rmSync(grantMismatch.root, { recursive: true, force: true });
        }
    });

    it("does not convert failed-marker or post-COMMIT recovery failures into success", async () => {
        const failMarker = createHarness();
        try {
            const base = createReverseAcceptMarkerStore(failMarker.transactionsRoot, exactAnalysisValidator(failMarker.analysis));
            const store = {
                ...base,
                failClaimed() {
                    throw new Error("failed marker publication fault");
                },
            };
            const service = createReverseAcceptServiceForTest(failMarker.configuration(), store, undefined, {
                publishVersion: () => {
                    throw new Error("publication fault");
                },
            });
            await prepare(service);
            expect(
                (await service.commitRenderedTargetAccept(commitRequest(failMarker.analysis))).diagnostics[0]?.message,
            ).toContain("failed marker publication fault");
        } finally {
            fs.rmSync(failMarker.root, { recursive: true, force: true });
        }

        const lostAckAndConsume = createHarness();
        try {
            const base = createReverseAcceptMarkerStore(
                lostAckAndConsume.transactionsRoot,
                exactAnalysisValidator(lostAckAndConsume.analysis),
            );
            const store = {
                ...base,
                consumeClaimed() {
                    throw new Error("recovery consume fault");
                },
            };
            const service = createReverseAcceptServiceForTest(lostAckAndConsume.configuration(), store, undefined, {
                commitDatabase(input) {
                    commitReverseAcceptVersionSelectionSuccessCrashDurable(input);
                    throw new Error("lost FULL acknowledgement");
                },
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(lostAckAndConsume.analysis))).value.commitState).toBe(
                "outcome_unavailable",
            );
        } finally {
            fs.rmSync(lostAckAndConsume.root, { recursive: true, force: true });
        }

        const changedWithoutReceipt = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                changedWithoutReceipt.transactionsRoot,
                exactAnalysisValidator(changedWithoutReceipt.analysis),
            );
            const service = createReverseAcceptServiceForTest(changedWithoutReceipt.configuration(), store, undefined, {
                commitDatabase() {
                    const db = new Database(changedWithoutReceipt.databasePath);
                    db.prepare("UPDATE deployments SET updated_at = updated_at + 1 WHERE deployment_id = ?").run(DEPLOYMENT_ID);
                    db.close();
                    throw new Error("DB changed without a receipt");
                },
            });
            await prepare(service);
            expect(
                (await service.commitRenderedTargetAccept(commitRequest(changedWithoutReceipt.analysis))).value.commitState,
            ).toBe("outcome_unavailable");
        } finally {
            fs.rmSync(changedWithoutReceipt.root, { recursive: true, force: true });
        }

        const prematureReceipt = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                prematureReceipt.transactionsRoot,
                exactAnalysisValidator(prematureReceipt.analysis),
            );
            let captured: Parameters<typeof commitReverseAcceptVersionSelectionSuccessCrashDurable>[0] | undefined;
            const service = createReverseAcceptServiceForTest(prematureReceipt.configuration(), store, undefined, {
                prepareDatabaseAuthority(databasePath, successCommit, transition) {
                    const preparedAuthority = prepareReverseAcceptDeploymentSuccessAuthority(
                        databasePath,
                        successCommit,
                        transition,
                    );
                    captured = {
                        databasePath,
                        successCommit,
                        preparedAuthority,
                        deploymentAssetTransition: transition,
                    };
                    return preparedAuthority;
                },
                publishVersion() {
                    if (captured === undefined) throw new Error("DB fixture was not prepared");
                    commitReverseAcceptVersionSelectionSuccessCrashDurable(captured);
                    throw new Error("publisher observed a premature DB receipt");
                },
            });
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(prematureReceipt.analysis))).value.commitState).toBe(
                "outcome_unavailable",
            );
        } finally {
            fs.rmSync(prematureReceipt.root, { recursive: true, force: true });
        }
    });

    it("rejects a prepared DB proof that does not join the reverse identity", async () => {
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const service = createReverseAcceptServiceForTest(harness.configuration(), store, undefined, {
            prepareDatabaseAuthority(databasePath, successCommit, transition) {
                const authority = prepareReverseAcceptDeploymentSuccessAuthority(databasePath, successCommit, transition);
                authority.commitReceipt.preCommitDatabaseStateFingerprint = HASH_A;
                return authority;
            },
        });
        await prepare(service);
        expect((await service.commitRenderedTargetAccept(commitRequest(harness.analysis))).diagnostics[0]?.code).toBe(
            "reverse_accept.database_proof_mismatch",
        );
    });

    it("stops before claim when the staged Asset disappears after DB proof preparation", async () => {
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const service = createReverseAcceptServiceForTest(harness.configuration(), store, undefined, {
            prepareDatabaseAuthority(databasePath, successCommit, transition) {
                const authority = prepareReverseAcceptDeploymentSuccessAuthority(databasePath, successCommit, transition);
                fs.rmSync(path.join(harness.assetsRoot, ASSET_ID, "asset.json"));
                return authority;
            },
        });
        await prepare(service);
        expect((await service.commitRenderedTargetAccept(commitRequest(harness.analysis))).diagnostics[0]?.code).toBe(
            "reverse_accept.asset_authority_missing",
        );
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "prepared" },
        });
    });
});
