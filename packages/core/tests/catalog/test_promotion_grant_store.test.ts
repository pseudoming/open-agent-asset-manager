import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    buildPromotionGrantAuthority,
    createPromotionGrantAuthority,
    createPromotionGrantAuthorityForTest,
    listPromotionGrantAuthorities,
    listPromotionGrantAuthoritiesForTest,
    parsePromotionGrant,
    readPromotionGrantAuthority,
    resolvePromotionGrantAuthority,
    revokePromotionGrantAuthority,
    serializePromotionGrant,
    validateImportPromotionGrantForPendingVersion,
    writePendingImportPromotionGrantAuthority,
} from "../../src/catalog/promotion-grant-store";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishAssetVersion,
    publishInitialAssetVersion,
} from "../../src/catalog/version-authority";
import { ASSET_ID, VERSION_ID, VERSION_ID_2, makeAsset, makeVersionClosure } from "./fixtures/version-v2";
import { computePromotionGrantFingerprint } from "../../src/foundation/fingerprint";
import { readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";

const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const GRANT_ID = "55555555-5555-4555-8555-555555555555";
const GRANT_ID_2 = "66666666-6666-4666-8666-666666666666";
const PROJECT_TARGET = { targetKind: "project" as const, projectId: PROJECT_ID };

describe("Asset-local PromotionGrant authority", () => {
    let root: string;
    let assetsRoot: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-p4-grant-"));
        assetsRoot = path.join(root, "assets");
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-initial",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("creates, lists, reopens, and resolves one exact-Version project grant", () => {
        const grant = createPromotionGrantAuthority({
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-create",
            updatedAt: 10,
        });

        expect(grant.revision).toBe(1);
        expect(parsePromotionGrant(serializePromotionGrant(grant))).toEqual(grant);
        expect(readPromotionGrantAuthority(assetsRoot, ASSET_ID, GRANT_ID)).toEqual(grant);
        expect(listPromotionGrantAuthorities(assetsRoot, ASSET_ID)).toEqual([grant]);
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target: PROJECT_TARGET,
            }),
        ).toEqual(grant);
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target: {
                    targetKind: "global_target",
                    targetAuthorityFingerprint: `sha256:${"a".repeat(64)}`,
                },
            }),
        ).toBeNull();
    });

    it("keeps an all-Versions grant inactive until its activation Version enters asset.json", () => {
        const grant = createPromotionGrantAuthority({
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: {
                subjectKind: "asset_all_versions",
                assetId: ASSET_ID,
                activationVersionId: VERSION_ID_2,
            },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-all",
            updatedAt: 20,
        });
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target: PROJECT_TARGET,
            }),
        ).toBeNull();

        publishAssetVersion({
            assetsRoot,
            transactionId: "txn-second",
            version: makeVersionClosure({
                versionId: VERSION_ID_2,
                revision: 2,
                sourceVersionId: VERSION_ID,
                changeKind: "edit",
            }),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target: PROJECT_TARGET,
            }),
        ).toEqual(grant);
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID_2,
                target: PROJECT_TARGET,
            }),
        ).toEqual(grant);
    });

    it("validates and publishes only one exact grant for a pending import Version", () => {
        const exact = buildPromotionGrantAuthority({
            promotionGrantId: GRANT_ID,
            subject: {
                subjectKind: "asset_version",
                assetId: ASSET_ID,
                versionId: VERSION_ID_2,
            },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-pending",
            updatedAt: 20,
        });
        writePendingImportPromotionGrantAuthority({
            assetsRoot,
            assetId: ASSET_ID,
            pendingVersionId: VERSION_ID_2,
            grant: exact,
        });
        expect(readPromotionGrantAuthority(assetsRoot, ASSET_ID, GRANT_ID)).toEqual(exact);
        expect(() =>
            writePendingImportPromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                pendingVersionId: VERSION_ID_2,
                grant: exact,
            }),
        ).toThrow(/already exists/);

        const duplicateCoverage = buildPromotionGrantAuthority({
            promotionGrantId: GRANT_ID_2,
            subject: exact.subject,
            target: exact.target,
            userActionEvidenceId: "ua-duplicate-coverage",
            updatedAt: 21,
        });
        expect(() =>
            writePendingImportPromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                pendingVersionId: VERSION_ID_2,
                grant: duplicateCoverage,
            }),
        ).toThrow(/already covers/);

        const alreadyMember = buildPromotionGrantAuthority({
            promotionGrantId: GRANT_ID_2,
            subject: {
                subjectKind: "asset_version",
                assetId: ASSET_ID,
                versionId: VERSION_ID,
            },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-member",
            updatedAt: 22,
        });
        expect(() =>
            writePendingImportPromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                pendingVersionId: VERSION_ID,
                grant: alreadyMember,
            }),
        ).toThrow(/already an Asset member/);
        expect(() =>
            validateImportPromotionGrantForPendingVersion(exact, "99999999-9999-4999-8999-999999999999", VERSION_ID_2),
        ).toThrow(/another Asset/);

        const wrongActivation = buildPromotionGrantAuthority({
            promotionGrantId: GRANT_ID_2,
            subject: {
                subjectKind: "asset_all_versions",
                assetId: ASSET_ID,
                activationVersionId: VERSION_ID,
            },
            target: {
                targetKind: "global_target",
                targetAuthorityFingerprint: `sha256:${"a".repeat(64)}`,
            },
            userActionEvidenceId: "ua-wrong-anchor",
            updatedAt: 23,
        });
        expect(() => validateImportPromotionGrantForPendingVersion(wrongActivation, ASSET_ID, VERSION_ID_2)).toThrow(
            /anchored by the pending Version/,
        );

        const { grantFingerprint: _exactFingerprint, ...exactPreimage } = exact;
        const revokedPreimage = { ...exactPreimage, grantState: "revoked" as const };
        const revokedPending = {
            ...revokedPreimage,
            grantFingerprint: computePromotionGrantFingerprint(revokedPreimage),
        };
        expect(() => validateImportPromotionGrantForPendingVersion(revokedPending, ASSET_ID, VERSION_ID_2)).toThrow(
            /new active authority/,
        );

        const revisedPreimage = { ...exactPreimage, revision: 2 };
        const revisedPending = {
            ...revisedPreimage,
            grantFingerprint: computePromotionGrantFingerprint(revisedPreimage),
        };
        expect(() => validateImportPromotionGrantForPendingVersion(revisedPending, ASSET_ID, VERSION_ID_2)).toThrow(
            /new active authority/,
        );
    });

    it("prefers an exact-Version grant over an all-Versions grant for the same target", () => {
        const broad = createPromotionGrantAuthority({
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: {
                subjectKind: "asset_all_versions",
                assetId: ASSET_ID,
                activationVersionId: VERSION_ID,
            },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-broad",
            updatedAt: 1,
        });
        const exact = createPromotionGrantAuthority({
            assetsRoot,
            promotionGrantId: GRANT_ID_2,
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-exact",
            updatedAt: 2,
        });
        expect(broad.promotionGrantId).toBe(GRANT_ID);
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target: PROJECT_TARGET,
            }),
        ).toEqual(exact);
    });

    it("revokes by exact revision/fingerprint CAS and never authorizes from stale memory", () => {
        const active = createPromotionGrantAuthority({
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-create",
            updatedAt: 1,
        });
        expect(() =>
            revokePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                promotionGrantId: GRANT_ID,
                expectedRevision: 99,
                expectedGrantFingerprint: active.grantFingerprint,
                userActionEvidenceId: "ua-stale",
                updatedAt: 2,
            }),
        ).toThrow(/CAS mismatch/);
        const revoked = revokePromotionGrantAuthority({
            assetsRoot,
            assetId: ASSET_ID,
            promotionGrantId: GRANT_ID,
            expectedRevision: active.revision,
            expectedGrantFingerprint: active.grantFingerprint,
            userActionEvidenceId: "ua-revoke",
            updatedAt: 3,
        });
        expect(revoked).toMatchObject({ grantState: "revoked", revision: 2 });
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target: PROJECT_TARGET,
            }),
        ).toBeNull();
        expect(() =>
            revokePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                promotionGrantId: GRANT_ID,
                expectedRevision: revoked.revision,
                expectedGrantFingerprint: revoked.grantFingerprint,
                userActionEvidenceId: "ua-again",
                updatedAt: 4,
            }),
        ).toThrow(/already revoked/);
    });

    it("rejects duplicate authorities, ambiguous corrupt duplicates, and missing grants", () => {
        const input = {
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: {
                subjectKind: "asset_version" as const,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
            },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-create",
            updatedAt: 1,
        };
        const first = createPromotionGrantAuthority(input);
        expect(() => createPromotionGrantAuthority(input)).toThrow(/already exists/);
        expect(() => createPromotionGrantAuthority({ ...input, promotionGrantId: GRANT_ID_2 })).toThrow(/already covers/);
        expect(readPromotionGrantAuthority(assetsRoot, ASSET_ID, GRANT_ID_2)).toBeNull();
        expect(() =>
            revokePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                promotionGrantId: GRANT_ID_2,
                expectedRevision: 1,
                expectedGrantFingerprint: first.grantFingerprint,
                userActionEvidenceId: "ua-missing",
                updatedAt: 2,
            }),
        ).toThrow(/not found/);

        const duplicate = { ...first, promotionGrantId: GRANT_ID_2 };
        const { grantFingerprint: _old, ...preimage } = duplicate;
        duplicate.grantFingerprint = computePromotionGrantFingerprint(preimage);
        fs.writeFileSync(
            path.join(assetsRoot, ASSET_ID, "promotion-grants", `${GRANT_ID_2}.json`),
            serializePromotionGrant(duplicate),
        );
        expect(() =>
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target: PROJECT_TARGET,
            }),
        ).toThrow(/ambiguous/);
    });

    it("rechecks create membership after preparation and fails a disappearing inventory entry", () => {
        const input = {
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: {
                subjectKind: "asset_version" as const,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
            },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-create",
            updatedAt: 1,
        };
        expect(() =>
            createPromotionGrantAuthorityForTest(input, {
                beforeCreateWrite: (grantPath, grant) => {
                    fs.writeFileSync(grantPath, serializePromotionGrant(grant));
                },
            }),
        ).toThrow(/already exists/);
        expect(readPromotionGrantAuthority(assetsRoot, ASSET_ID, GRANT_ID)).not.toBeNull();

        expect(() =>
            listPromotionGrantAuthoritiesForTest(assetsRoot, ASSET_ID, {
                afterInventory: () => {
                    fs.rmSync(path.join(assetsRoot, ASSET_ID, "promotion-grants", `${GRANT_ID}.json`));
                },
            }),
        ).toThrow(/disappeared/);
    });

    it("fails closed on tampering, unsafe directory entries, symlinks, and enclosing identity mismatch", () => {
        const grant = createPromotionGrantAuthority({
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-create",
            updatedAt: 1,
        });
        const grantPath = path.join(assetsRoot, ASSET_ID, "promotion-grants", `${GRANT_ID}.json`);
        fs.writeFileSync(grantPath, JSON.stringify({ ...grant, updatedAt: 2 }));
        expect(() => readPromotionGrantAuthority(assetsRoot, ASSET_ID, GRANT_ID)).toThrow(/fingerprint mismatch/);

        fs.writeFileSync(grantPath, serializePromotionGrant(grant));
        fs.writeFileSync(path.join(assetsRoot, ASSET_ID, "promotion-grants", "junk.txt"), "junk");
        expect(() => listPromotionGrantAuthorities(assetsRoot, ASSET_ID)).toThrow(/unexpected/);
        fs.rmSync(path.join(assetsRoot, ASSET_ID, "promotion-grants", "junk.txt"));

        const mismatched = {
            ...grant,
            subject: { ...grant.subject, assetId: "77777777-7777-4777-8777-777777777777" },
        };
        const { grantFingerprint: _mismatchFingerprint, ...mismatchPreimage } = mismatched;
        mismatched.grantFingerprint = computePromotionGrantFingerprint(mismatchPreimage);
        fs.writeFileSync(grantPath, serializePromotionGrant(mismatched));
        expect(() => readPromotionGrantAuthority(assetsRoot, ASSET_ID, GRANT_ID)).toThrow(/enclosing Asset/);
        fs.rmSync(path.join(assetsRoot, ASSET_ID, "promotion-grants"), { recursive: true });
        const outside = path.join(root, "outside");
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(assetsRoot, ASSET_ID, "promotion-grants"));
        expect(() => listPromotionGrantAuthorities(assetsRoot, ASSET_ID)).toThrow(/symbolic|link/i);
        expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("rejects malformed strict branches and inactive Asset/version inputs", () => {
        expect(() => parsePromotionGrant("null")).toThrow(/object/);
        const valid = createPromotionGrantAuthority({
            assetsRoot,
            promotionGrantId: GRANT_ID,
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: PROJECT_TARGET,
            userActionEvidenceId: "ua-valid",
            updatedAt: 1,
        });
        const invalidAuthorities: unknown[] = [
            { ...valid, extra: true },
            { ...valid, schemaVersion: 2 },
            { ...valid, promotionGrantId: "bad" },
            { ...valid, subject: null },
            { ...valid, subject: { subjectKind: "other" } },
            {
                ...valid,
                subject: { subjectKind: "asset_version", assetId: "bad", versionId: VERSION_ID },
            },
            {
                ...valid,
                subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: "bad" },
            },
            {
                ...valid,
                subject: {
                    subjectKind: "asset_all_versions",
                    assetId: ASSET_ID,
                    activationVersionId: "bad",
                },
            },
            { ...valid, target: null },
            { ...valid, target: { targetKind: "other" } },
            { ...valid, target: { targetKind: "project", projectId: "bad" } },
            {
                ...valid,
                target: { targetKind: "global_target", targetAuthorityFingerprint: "bad" },
            },
            { ...valid, grantState: "other" },
            { ...valid, revision: 0 },
            { ...valid, userActionEvidenceId: " " },
            { ...valid, updatedAt: -1 },
            { ...valid, grantFingerprint: "bad" },
        ];
        for (const invalid of invalidAuthorities) {
            expect(() => parsePromotionGrant(JSON.stringify(invalid))).toThrow();
        }
        expect(() =>
            createPromotionGrantAuthority({
                assetsRoot,
                promotionGrantId: GRANT_ID_2,
                subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
                target: {
                    targetKind: "global_target",
                    targetAuthorityFingerprint: `sha256:${"b".repeat(64)}`,
                },
                userActionEvidenceId: " ",
                updatedAt: 2,
            }),
        ).toThrow(/non-blank/);
        expect(() =>
            createPromotionGrantAuthority({
                assetsRoot,
                promotionGrantId: GRANT_ID_2,
                subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
                target: {
                    targetKind: "global_target",
                    targetAuthorityFingerprint: `sha256:${"b".repeat(64)}`,
                },
                userActionEvidenceId: "ua-time",
                updatedAt: -1,
            }),
        ).toThrow(/non-negative/);
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: ASSET_ID,
                versionId: VERSION_ID_2,
                target: PROJECT_TARGET,
            }),
        ).toBeNull();

        const asset = readAssetManifest(assetsRoot, ASSET_ID);
        if (asset === null) throw new Error("fixture Asset missing");
        writeAssetManifest(assetsRoot, { ...asset, deleted: true });
        expect(() => listPromotionGrantAuthorities(assetsRoot, ASSET_ID)).toThrow(/active Asset/);
    });
});
