import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectOrphanVersions, readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";
import { resolvePayloadPath } from "../../src/catalog/payload-store";
import {
    buildPromotionGrantAuthority,
    readPromotionGrantAuthority,
    resolvePromotionGrantAuthority,
    revokePromotionGrantAuthority,
    serializePromotionGrant,
} from "../../src/catalog/promotion-grant-store";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    projectAppendedAssetManifestAuthority,
    publishAssetVersion,
    publishAssetVersionForTest,
    publishImportedAssetVersionForTest,
    publishImportedInitialAssetVersion,
    publishImportedInitialAssetVersionForTest,
    publishInitialAssetVersion,
    publishInitialAssetVersionForTest,
    publishReverseAcceptedAssetVersionForTest,
    readAssetManifestAuthority,
    readAssetManifestAuthoritySet,
    readVersionAuthority,
    replaceExistingAssetManifestAuthority,
} from "../../src/catalog/version-authority";
import { ASSET_ID, makeAsset, makeVersionClosure, VERSION_ID, VERSION_ID_2 } from "./fixtures/version-v2";
import { assetsRoot, root } from "./fixtures/version-authority-test-fixtures";

describe("AssetVersion V2 filesystem publication authority", () => {
    it("centralizes exact mutable Asset manifest replacement without changing membership", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "00000000-0000-4000-8000-000000000090",
            asset: makeAsset([VERSION_ID]),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const expected = readAssetManifest(assetsRoot, ASSET_ID)!;
        const next = {
            ...expected,
            displayName: "Renamed",
            deleted: true,
            updatedAt: expected.updatedAt + 1,
        };
        replaceExistingAssetManifestAuthority({ assetsRoot, expected, next });
        expect(readAssetManifest(assetsRoot, ASSET_ID)).toEqual(next);

        expect(() => replaceExistingAssetManifestAuthority({ assetsRoot, expected, next })).toThrow(/authority changed/);
        expect(() =>
            replaceExistingAssetManifestAuthority({
                assetsRoot: path.join(root, "missing-assets"),
                expected: next,
                next,
            }),
        ).toThrow(/authority changed/);
        expect(() =>
            replaceExistingAssetManifestAuthority({
                assetsRoot,
                expected: next,
                next: { ...next, kind: "Rule" },
            }),
        ).toThrow(/immutable identity/);
        expect(() =>
            replaceExistingAssetManifestAuthority({
                assetsRoot,
                expected: next,
                next: { ...next, versionIds: [] },
            }),
        ).toThrow(/Version membership/);
        expect(() =>
            replaceExistingAssetManifestAuthority({
                assetsRoot,
                expected: next,
                next: { ...next, updatedAt: expected.updatedAt },
            }),
        ).toThrow(/updatedAt backwards/);
    });

    it("publishes and reopens an initial Asset only after its complete Version closure is durable", () => {
        const version = makeVersionClosure();
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-initial",
            asset: makeAsset(),
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(readAssetManifest(assetsRoot, ASSET_ID)?.versionIds).toEqual([VERSION_ID]);
        expect(readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)).toEqual(version);
        expect(fs.readdirSync(path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID, "payloads"))).toHaveLength(1);
    });

    it("fails closed when an Asset manifest authority is absent", () => {
        expect(readAssetManifestAuthority(assetsRoot, ASSET_ID)).toBeNull();
        expect(() => readAssetManifestAuthoritySet(assetsRoot, [ASSET_ID])).toThrow(/authority is missing/);
    });

    it("rejects a staged Version that does not extend the exact Asset revision authority", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-invalid-projection",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const current = readAssetManifest(assetsRoot, ASSET_ID);
        if (current === null) throw new Error("fixture Asset missing");
        expect(() =>
            projectAppendedAssetManifestAuthority({
                assetsRoot,
                current,
                stagedVersion: makeVersionClosure({
                    versionId: VERSION_ID_2,
                    revision: 3,
                    sourceVersionId: VERSION_ID,
                    changeKind: "edit",
                }).manifest,
            }),
        ).toThrow(/does not extend/);
    });

    it("exposes the reverse publication kill seam without committing the Asset pointer", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-reverse-seam-initial",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const second = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
            createdAt: 200,
        });
        expect(() =>
            publishReverseAcceptedAssetVersionForTest(
                {
                    assetsRoot,
                    transactionId: "txn-reverse-seam-second",
                    version: second,
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                    promotion: { promotionAction: "import_only" },
                },
                {
                    afterPayloads() {
                        throw new Error("kill:reverse-after-payloads");
                    },
                },
            ),
        ).toThrow("kill:reverse-after-payloads");
        expect(readAssetManifest(assetsRoot, ASSET_ID)?.versionIds).toEqual([VERSION_ID]);
    });

    it("publishes an initial import grant with the Asset and rejects a changed staged grant", () => {
        const grant = buildPromotionGrantAuthority({
            promotionGrantId: "55555555-5555-4555-8555-555555555555",
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: {
                targetKind: "project",
                projectId: "44444444-4444-4444-8444-444444444444",
            },
            userActionEvidenceId: "accept-import-grant",
            updatedAt: 10,
        });
        publishImportedInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-imported-initial",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            promotion: { promotionAction: "publish_grant", grant },
        });
        expect(readPromotionGrantAuthority(assetsRoot, ASSET_ID, grant.promotionGrantId)).toEqual(grant);

        const changed = buildPromotionGrantAuthority({
            promotionGrantId: grant.promotionGrantId,
            subject: grant.subject,
            target: grant.target,
            userActionEvidenceId: "changed-after-write",
            updatedAt: 11,
        });
        const isolatedAssets = path.join(root, "changed-staged-grant");
        expect(() =>
            publishImportedInitialAssetVersionForTest(
                {
                    assetsRoot: isolatedAssets,
                    transactionId: "txn-changed-staged-grant",
                    asset: makeAsset(),
                    version: makeVersionClosure(),
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                    promotion: { promotionAction: "publish_grant", grant },
                },
                {
                    afterGrantWrite: (grantPath) => {
                        fs.writeFileSync(grantPath, serializePromotionGrant(changed));
                    },
                },
            ),
        ).toThrow(/staged import promotion grant differs/);
        expect(readAssetManifest(isolatedAssets, ASSET_ID)).toBeNull();
    });

    it("rechecks Asset and import-grant authority before the later Version pointer commit", () => {
        const setup = (child: string) => {
            const isolatedAssets = path.join(root, child);
            publishInitialAssetVersion({
                assetsRoot: isolatedAssets,
                transactionId: `txn-${child}-initial`,
                asset: makeAsset(),
                version: makeVersionClosure(),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            });
            return isolatedAssets;
        };
        const second = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "extract",
            createdAt: 200,
        });

        const changedAssetRoot = setup("changed-asset");
        expect(() =>
            publishImportedAssetVersionForTest(
                {
                    assetsRoot: changedAssetRoot,
                    transactionId: "txn-changed-asset-second",
                    version: second,
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                    promotion: { promotionAction: "import_only" },
                },
                {
                    afterVersionRename: () => {
                        const current = readAssetManifest(changedAssetRoot, ASSET_ID);
                        if (current === null) throw new Error("fixture Asset missing");
                        writeAssetManifest(changedAssetRoot, { ...current, updatedAt: 201 });
                    },
                },
            ),
        ).toThrow(/Asset authority changed/);
        expect(readAssetManifest(changedAssetRoot, ASSET_ID)?.versionIds).toEqual([VERSION_ID]);

        const changedGrantRoot = setup("changed-grant");
        const grant = buildPromotionGrantAuthority({
            promotionGrantId: "55555555-5555-4555-8555-555555555555",
            subject: {
                subjectKind: "asset_all_versions",
                assetId: ASSET_ID,
                activationVersionId: VERSION_ID_2,
            },
            target: {
                targetKind: "project",
                projectId: "44444444-4444-4444-8444-444444444444",
            },
            userActionEvidenceId: "accept-import-grant",
            updatedAt: 200,
        });
        expect(() =>
            publishImportedAssetVersionForTest(
                {
                    assetsRoot: changedGrantRoot,
                    transactionId: "txn-changed-grant-second",
                    version: second,
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                    promotion: { promotionAction: "publish_grant", grant },
                },
                {
                    afterVersionRename: () => {
                        revokePromotionGrantAuthority({
                            assetsRoot: changedGrantRoot,
                            assetId: ASSET_ID,
                            promotionGrantId: grant.promotionGrantId,
                            expectedRevision: grant.revision,
                            expectedGrantFingerprint: grant.grantFingerprint,
                            userActionEvidenceId: "concurrent-revoke",
                            updatedAt: 201,
                        });
                    },
                },
            ),
        ).toThrow(/promotion grant changed/);
        expect(readAssetManifest(changedGrantRoot, ASSET_ID)?.versionIds).toEqual([VERSION_ID]);
    });

    it("leaves pre-rename kill points only in non-authoritative staging", () => {
        for (const hook of ["afterPayloads", "afterManifest"] as const) {
            const isolatedAssets = path.join(root, hook);
            expect(() =>
                publishInitialAssetVersionForTest(
                    {
                        assetsRoot: isolatedAssets,
                        transactionId: `txn-${hook}`,
                        asset: makeAsset(),
                        version: makeVersionClosure(),
                        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                    },
                    {
                        [hook]: () => {
                            throw new Error(`kill:${hook}`);
                        },
                    },
                ),
            ).toThrow(`kill:${hook}`);
            expect(readAssetManifest(isolatedAssets, ASSET_ID)).toBeNull();
            expect(fs.existsSync(path.join(isolatedAssets, ".staging", `txn-${hook}`))).toBe(true);
        }
    });

    it("publishes a later Version directory before the asset.json pointer", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-1",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const second = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
            createdAt: 200,
        });
        publishAssetVersion({
            assetsRoot,
            transactionId: "txn-2",
            version: second,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(readAssetManifest(assetsRoot, ASSET_ID)?.versionIds).toEqual([VERSION_ID, VERSION_ID_2]);
        expect(readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID_2, EMPTY_VERSION_DIALECT_REGISTRY)).toEqual(second);
    });

    it("a kill after Version rename creates an orphan but never activates it", () => {
        const first = makeVersionClosure();
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-1",
            asset: makeAsset(),
            version: first,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const second = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "sync",
        });
        expect(() =>
            publishAssetVersionForTest(
                {
                    assetsRoot,
                    transactionId: "txn-2",
                    version: second,
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                },
                {
                    afterVersionRename: () => {
                        throw new Error("kill:after-rename");
                    },
                },
            ),
        ).toThrow("kill:after-rename");
        const asset = readAssetManifest(assetsRoot, ASSET_ID);
        expect(asset?.versionIds).toEqual([VERSION_ID]);
        expect(asset && detectOrphanVersions(assetsRoot, asset)).toEqual([VERSION_ID_2]);
        expect(readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID_2, EMPTY_VERSION_DIALECT_REGISTRY)).toBeNull();
    });

    it("a kill after a pending import grant leaves no effective authorization", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-import-kill-initial",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const second = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "extract",
        });
        const target = {
            targetKind: "project" as const,
            projectId: "44444444-4444-4444-8444-444444444444",
        };
        const grant = buildPromotionGrantAuthority({
            promotionGrantId: "55555555-5555-4555-8555-555555555555",
            subject: {
                subjectKind: "asset_all_versions",
                assetId: ASSET_ID,
                activationVersionId: VERSION_ID_2,
            },
            target,
            userActionEvidenceId: "accept-import-grant",
            updatedAt: 200,
        });
        expect(() =>
            publishImportedAssetVersionForTest(
                {
                    assetsRoot,
                    transactionId: "txn-import-kill-second",
                    version: second,
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                    promotion: { promotionAction: "publish_grant", grant },
                },
                {
                    afterGrant: () => {
                        throw new Error("kill:after-grant");
                    },
                },
            ),
        ).toThrow("kill:after-grant");
        expect(readAssetManifest(assetsRoot, ASSET_ID)?.versionIds).toEqual([VERSION_ID]);
        expect(readPromotionGrantAuthority(assetsRoot, ASSET_ID, grant.promotionGrantId)).toEqual(grant);
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target,
            }),
        ).toBeNull();
    });

    it("fails closed on missing, tampered, or symlinked payload authority", () => {
        const version = makeVersionClosure();
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-1",
            asset: makeAsset(),
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const versionRoot = path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID);
        const payload = resolvePayloadPath(versionRoot, version.files[0].file.contentHash);
        fs.rmSync(payload);
        expect(() => readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)).toThrow();
        fs.writeFileSync(payload, "tampered");
        expect(() => readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)).toThrow(
            /payload (byteSize|hash) mismatch/,
        );
        fs.rmSync(payload);
        const outside = path.join(root, "outside");
        fs.writeFileSync(outside, "# Guidance\n");
        fs.symlinkSync(outside, payload);
        expect(() => readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)).toThrow(
            /symbolic|link/i,
        );
    });
});
