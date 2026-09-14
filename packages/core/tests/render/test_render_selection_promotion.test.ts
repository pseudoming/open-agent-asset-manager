/** Authority-focused split from the original oversized render test suite. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    publishAssetVersion,
    publishImportedInitialAssetVersion,
    publishInitialAssetVersion,
    EMPTY_VERSION_DIALECT_REGISTRY,
} from "../../src/catalog/version-authority";
import { computeRenderInputFingerprint, computeVersionOriginAuthorityFingerprint } from "../../src/foundation/fingerprint";
import {
    buildPromotionGrantAuthority,
    createPromotionGrantAuthority,
    revokePromotionGrantAuthority,
} from "../../src/catalog/promotion-grant-store";
import { readAssetManifest } from "../../src/catalog/asset-manifest";
import { inspectPromotionAuthorizations } from "../../src/render/render-promotion-authorization";
import { makeAsset, makeTextFile, makeVersionClosure, VERSION_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import { RENDER_PROJECT_ID } from "./fixtures/render-contract-fixtures";
import {
    VERSION_ID_3,
    selectionFixture,
    selectionResult,
    refreshAnalysis,
    pointDeploymentAtVersion,
    makeImportedClosure,
    makeReverseClosure,
    globalTarget,
    enableFullAccess,
    resolveStagedSelection,
} from "./fixtures/render-selection-test-fixtures";

describe("promotion authorization resolution", () => {
    it("inspects required, granted, revoked, not-required, and unavailable authority without selecting", async () => {
        const ordinary = await selectionFixture();
        expect(inspectPromotionAuthorizations(ordinary.deployment, ordinary.configuration)).toMatchObject({
            status: "complete",
            value: [
                {
                    promotionAuthorizationState: "not_required",
                    assetId: ordinary.deployment.assets[0]?.version.ref.assetId,
                    versionId: ordinary.deployment.assets[0]?.version.ref.versionId,
                },
            ],
        });

        const secondAssetId = "99999999-9999-4999-8999-999999999999";
        const secondVersion = makeVersionClosure({ assetId: secondAssetId, versionId: VERSION_ID_2 });
        publishInitialAssetVersion({
            assetsRoot: ordinary.configuration.assetsRoot,
            transactionId: "txn-inspection-second",
            asset: makeAsset([VERSION_ID_2], { assetId: secondAssetId }),
            version: secondVersion,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const secondInput = structuredClone(ordinary.deployment.assets[0]!);
        secondInput.version = {
            ...secondInput.version,
            ref: { assetId: secondAssetId, versionId: VERSION_ID_2 },
            versionFingerprint: secondVersion.manifest.fingerprint,
            versionCanonicalContentFingerprint: secondVersion.manifest.versionCanonicalContentFingerprint,
        };
        ordinary.deployment.assets.push(secondInput);
        expect(inspectPromotionAuthorizations(ordinary.deployment, ordinary.configuration).value).toMatchObject([
            { assetId: secondAssetId, versionId: VERSION_ID_2 },
            { assetId: ordinary.deployment.assets[0]?.version.ref.assetId, versionId: VERSION_ID },
        ]);

        const restricted = await selectionFixture({ publishAsset: false, projectScoped: true });
        const closure = makeImportedClosure("requires_user_confirmation");
        publishImportedInitialAssetVersion({
            assetsRoot: restricted.configuration.assetsRoot,
            transactionId: "txn-inspection-import",
            asset: makeAsset([VERSION_ID], {
                scope: "project",
                projectId: RENDER_PROJECT_ID,
                scopePath: "",
            }),
            version: closure,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            promotion: { promotionAction: "import_only" },
        });
        const required = inspectPromotionAuthorizations(restricted.deployment, restricted.configuration);
        expect(required).toMatchObject({
            status: "complete",
            value: [
                {
                    promotionAuthorizationState: "required",
                    target: { targetKind: "project", projectId: RENDER_PROJECT_ID },
                },
            ],
        });

        const grant = createPromotionGrantAuthority({
            assetsRoot: restricted.configuration.assetsRoot,
            promotionGrantId: "69696969-6969-4969-8969-696969696969",
            subject: { subjectKind: "asset_version", assetId: closure.manifest.assetId, versionId: VERSION_ID },
            target: { targetKind: "project", projectId: RENDER_PROJECT_ID },
            userActionEvidenceId: "inspection-grant",
            updatedAt: 200,
        });
        expect(inspectPromotionAuthorizations(restricted.deployment, restricted.configuration)).toMatchObject({
            status: "complete",
            value: [
                {
                    promotionAuthorizationState: "authorized",
                    authorizationSource: "version_target_grant",
                    authorityId: grant.promotionGrantId,
                    authorityRevision: 1,
                    authorityFingerprint: grant.grantFingerprint,
                },
            ],
        });
        revokePromotionGrantAuthority({
            assetsRoot: restricted.configuration.assetsRoot,
            assetId: closure.manifest.assetId,
            promotionGrantId: grant.promotionGrantId,
            expectedRevision: grant.revision,
            expectedGrantFingerprint: grant.grantFingerprint,
            userActionEvidenceId: "inspection-revoke",
            updatedAt: 201,
        });
        expect(inspectPromotionAuthorizations(restricted.deployment, restricted.configuration)).toMatchObject({
            status: "complete",
            value: [{ promotionAuthorizationState: "required" }],
        });

        restricted.deployment.assets[0]!.scopePath = "stale";
        expect(inspectPromotionAuthorizations(restricted.deployment, restricted.configuration)).toMatchObject({
            status: "partial",
            value: [
                {
                    promotionAuthorizationState: "unavailable",
                    diagnosticCode: "render.promotion_asset_stale",
                },
            ],
            diagnostics: [{ code: "render.promotion_asset_stale" }],
        });

        const corrupt = await selectionFixture();
        fs.writeFileSync(
            path.join(
                corrupt.configuration.assetsRoot,
                corrupt.deployment.assets[0]!.version.ref.assetId,
                "versions",
                corrupt.deployment.assets[0]!.version.ref.versionId,
                "version.json",
            ),
            "{corrupt",
        );
        expect(inspectPromotionAuthorizations(corrupt.deployment, corrupt.configuration)).toMatchObject({
            status: "partial",
            value: [
                {
                    promotionAuthorizationState: "unavailable",
                    diagnosticCode: "render.promotion_authority_unavailable",
                },
            ],
            diagnostics: [{ code: "render.promotion_authority_unavailable" }],
        });
    });

    it("selects an unpublished reverse Version without pretending it is an Asset member", async () => {
        const fixture = await selectionFixture();
        const staged = makeReverseClosure(makeVersionClosure(), {
            promotionRequirement: "not_required",
        });
        pointDeploymentAtVersion(fixture, staged);
        await refreshAnalysis(fixture);

        const result = resolveStagedSelection(fixture, staged);
        expect(result.status).toBe("complete");
        expect(result.value.promotionAuthorizations).toEqual([
            expect.objectContaining({
                versionId: VERSION_ID_2,
                promotionAuthorizationState: "not_required",
            }),
        ]);
        expect(
            fs.existsSync(
                path.join(fixture.configuration.assetsRoot, staged.manifest.assetId, "versions", staged.manifest.versionId),
            ),
        ).toBe(false);
    });

    it("accepts only the exact pending-Version grant for a staged reverse Version", async () => {
        const fixture = await selectionFixture();
        const staged = makeReverseClosure(makeVersionClosure());
        pointDeploymentAtVersion(fixture, staged);
        await refreshAnalysis(fixture);
        const grant = buildPromotionGrantAuthority({
            promotionGrantId: "66666666-6666-4666-8666-666666666666",
            subject: {
                subjectKind: "asset_version",
                assetId: staged.manifest.assetId,
                versionId: staged.manifest.versionId,
            },
            target: globalTarget(fixture),
            userActionEvidenceId: "pending-grant-action",
            updatedAt: 200,
        });
        const accepted = resolveStagedSelection(fixture, staged, grant);
        expect(accepted.status).toBe("complete");
        expect(accepted.value.promotionAuthorizations[0]).toEqual(
            expect.objectContaining({
                authorizationSource: "version_target_grant",
                authorityId: grant.promotionGrantId,
            }),
        );

        const wrongTarget = buildPromotionGrantAuthority({
            promotionGrantId: grant.promotionGrantId,
            subject: structuredClone(grant.subject),
            target: { targetKind: "project", projectId: RENDER_PROJECT_ID },
            userActionEvidenceId: grant.userActionEvidenceId,
            updatedAt: grant.updatedAt,
        });
        expect(resolveStagedSelection(fixture, staged, wrongTarget).status).toBe("failed");
    });

    it("inherits an active Asset-all grant but not a grant for the previous Version", async () => {
        const inherited = await selectionFixture();
        const staged = makeReverseClosure(makeVersionClosure());
        createPromotionGrantAuthority({
            assetsRoot: inherited.configuration.assetsRoot,
            promotionGrantId: "77777777-7777-4777-8777-777777777777",
            subject: {
                subjectKind: "asset_all_versions",
                assetId: staged.manifest.assetId,
                activationVersionId: VERSION_ID,
            },
            target: globalTarget(inherited),
            userActionEvidenceId: "all-version-action",
            updatedAt: 200,
        });
        pointDeploymentAtVersion(inherited, staged);
        await refreshAnalysis(inherited);
        expect(resolveStagedSelection(inherited, staged).status).toBe("complete");
        publishAssetVersion({
            assetsRoot: inherited.configuration.assetsRoot,
            transactionId: "txn-publish-second-version",
            version: staged,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        createPromotionGrantAuthority({
            assetsRoot: inherited.configuration.assetsRoot,
            promotionGrantId: "79797979-7979-4979-8979-797979797979",
            subject: {
                subjectKind: "asset_all_versions",
                assetId: staged.manifest.assetId,
                activationVersionId: VERSION_ID_2,
            },
            target: globalTarget(inherited),
            userActionEvidenceId: "second-all-version-action",
            updatedAt: 201,
        });
        const nextStaged = makeReverseClosure(staged, {
            versionId: VERSION_ID_3,
            revision: 3,
        });
        pointDeploymentAtVersion(inherited, nextStaged);
        await refreshAnalysis(inherited);
        expect(readAssetManifest(inherited.configuration.assetsRoot, nextStaged.manifest.assetId)?.versionIds).toEqual([
            VERSION_ID,
            VERSION_ID_2,
        ]);
        expect(nextStaged.manifest.originAuthority).toMatchObject({
            originKind: "reverse_accept",
            previousVersionId: VERSION_ID_2,
        });
        expect(resolveStagedSelection(inherited, nextStaged).diagnostics[0]?.code).toBe("render.promotion_authority_ambiguous");

        const versionOnly = await selectionFixture();
        createPromotionGrantAuthority({
            assetsRoot: versionOnly.configuration.assetsRoot,
            promotionGrantId: "88888888-8888-4888-8888-888888888888",
            subject: {
                subjectKind: "asset_version",
                assetId: staged.manifest.assetId,
                versionId: VERSION_ID,
            },
            target: globalTarget(versionOnly),
            userActionEvidenceId: "old-version-action",
            updatedAt: 200,
        });
        pointDeploymentAtVersion(versionOnly, staged);
        await refreshAnalysis(versionOnly);
        expect(resolveStagedSelection(versionOnly, staged).diagnostics[0]?.code).toBe("render.promotion_authorization_required");
    });

    it("accepts exact current-version and Asset-all-versions grants", async () => {
        for (const subjectKind of ["asset_version", "asset_all_versions"] as const) {
            const fixture = await selectionFixture({ publishAsset: false });
            const closure = makeImportedClosure("requires_user_confirmation");
            const grant = buildPromotionGrantAuthority({
                promotionGrantId:
                    subjectKind === "asset_version"
                        ? "33333333-3333-4333-8333-333333333333"
                        : "44444444-4444-4444-8444-444444444444",
                subject:
                    subjectKind === "asset_version"
                        ? {
                              subjectKind,
                              assetId: closure.manifest.assetId,
                              versionId: closure.manifest.versionId,
                          }
                        : {
                              subjectKind,
                              assetId: closure.manifest.assetId,
                              activationVersionId: closure.manifest.versionId,
                          },
                target: globalTarget(fixture),
                userActionEvidenceId: "grant-action",
                updatedAt: 100,
            });
            publishImportedInitialAssetVersion({
                assetsRoot: fixture.configuration.assetsRoot,
                transactionId: `txn-${subjectKind}`,
                asset: makeAsset(),
                version: closure,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                promotion: { promotionAction: "publish_grant", grant },
            });
            const result = selectionResult(fixture);
            expect(result.status).toBe("complete");
            expect(result.value.promotionAuthorizations[0]).toEqual(
                expect.objectContaining({
                    authorizationSource:
                        subjectKind === "asset_version" ? "version_target_grant" : "asset_all_versions_target_grant",
                }),
            );
        }
    });

    it("binds an exact grant to the current project-scoped target", async () => {
        const fixture = await selectionFixture({
            publishAsset: false,
            projectScoped: true,
        });
        const closure = makeImportedClosure("requires_user_confirmation");
        const grant = buildPromotionGrantAuthority({
            promotionGrantId: "55555555-5555-4555-8555-555555555555",
            subject: {
                subjectKind: "asset_version",
                assetId: closure.manifest.assetId,
                versionId: closure.manifest.versionId,
            },
            target: {
                targetKind: "project",
                projectId: RENDER_PROJECT_ID,
            },
            userActionEvidenceId: "project-grant-action",
            updatedAt: 100,
        });
        publishImportedInitialAssetVersion({
            assetsRoot: fixture.configuration.assetsRoot,
            transactionId: "txn-project-grant",
            asset: makeAsset([VERSION_ID], {
                scope: "project",
                projectId: RENDER_PROJECT_ID,
                scopePath: "",
            }),
            version: closure,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            promotion: { promotionAction: "publish_grant", grant },
        });
        const result = selectionResult(fixture);
        expect(result.status).toBe("complete");
        expect(result.value.promotionAuthorizations[0]).toEqual(
            expect.objectContaining({
                target: { targetKind: "project", projectId: RENDER_PROJECT_ID },
            }),
        );
    });

    it("sorts authorization records for two independently published Assets", async () => {
        const fixture = await selectionFixture();
        const secondAssetId = "11111111-1111-4111-8111-111111111112";
        const secondVersionId = "22222222-2222-4222-8222-222222222223";
        const secondFileId = "33333333-3333-4333-8333-333333333334";
        const secondFile = makeTextFile("# Second\n", "SECOND.md");
        secondFile.file.fileId = secondFileId;
        const secondClosure = makeVersionClosure({
            assetId: secondAssetId,
            versionId: secondVersionId,
            files: [secondFile],
        });
        publishInitialAssetVersion({
            assetsRoot: fixture.configuration.assetsRoot,
            transactionId: "txn-second-asset",
            asset: makeAsset([secondVersionId], { assetId: secondAssetId }),
            version: secondClosure,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        fixture.deployment.assets.push({
            scope: "global",
            projectId: "",
            scopePath: "",
            allowIncomplete: false,
            version: {
                ref: { assetId: secondAssetId, versionId: secondVersionId },
                versionFingerprint: secondClosure.manifest.fingerprint,
                versionCanonicalContentFingerprint: secondClosure.manifest.versionCanonicalContentFingerprint,
                status: secondClosure.manifest.status,
                canonical: {
                    kind: secondClosure.manifest.kind,
                    typeData: secondClosure.manifest.typeData,
                } as never,
                files: secondClosure.files,
            },
            sectionHandles: { [secondFileId]: "second-section" },
        });
        const { renderInputFingerprint: _stored, ...preimage } = fixture.deployment;
        fixture.deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
        await refreshAnalysis(fixture);
        const result = selectionResult(fixture);
        expect(result.status).toBe("complete");
        expect(result.value.promotionAuthorizations.map((item) => item.assetId)).toEqual([
            secondAssetId,
            fixture.deployment.assets[0]!.version.ref.assetId,
        ]);
    });

    it("uses Full Access only for restricted imports, never default-promotable imports", async () => {
        for (const safety of ["requires_user_confirmation", "default_promotable"] as const) {
            const fixture = await selectionFixture({ publishAsset: false });
            publishImportedInitialAssetVersion({
                assetsRoot: fixture.configuration.assetsRoot,
                transactionId: `txn-${safety}`,
                asset: makeAsset(),
                version: makeImportedClosure(safety),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                promotion: { promotionAction: "import_only" },
            });
            enableFullAccess(fixture);
            const result = selectionResult(fixture);
            if (safety === "requires_user_confirmation") {
                expect(result.status).toBe("complete");
                expect(result.value.promotionAuthorizations[0]).toEqual(
                    expect.objectContaining({
                        authorizationSource: "restricted_source_full_access",
                    }),
                );
            } else {
                expect(result.diagnostics[0]?.code).toBe("render.promotion_authorization_required");
            }
        }
    });

    it("preserves restricted-source Full Access semantics for copied Versions without inheriting a grant", async () => {
        for (const sourcePromotionSafety of ["requires_user_confirmation", "default_promotable"] as const) {
            const fixture = await selectionFixture({ publishAsset: false });
            const closure = makeVersionClosure();
            const originPreimage = {
                schemaVersion: 1 as const,
                assetId: closure.manifest.assetId,
                versionId: closure.manifest.versionId,
                originKind: "asset_copy" as const,
                sourceAssetId: "11111111-1111-4111-8111-111111111111",
                sourceVersionId: "22222222-2222-4222-8222-222222222222",
                sourceVersionFingerprint: closure.manifest.fingerprint,
                sourceVersionOriginAuthorityFingerprint: `sha256:${"3".repeat(64)}` as const,
                sourcePromotionSafety,
                userActionEvidenceId: "copy-action",
                promotionRequirement: "requires_current_authorization" as const,
                createdAt: 100,
            };
            closure.manifest.originAuthority = {
                ...originPreimage,
                authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
            };
            publishInitialAssetVersion({
                assetsRoot: fixture.configuration.assetsRoot,
                transactionId: `txn-copy-${sourcePromotionSafety}`,
                asset: makeAsset(),
                version: closure,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            });
            enableFullAccess(fixture);
            const result = selectionResult(fixture);
            if (sourcePromotionSafety === "requires_user_confirmation") {
                expect(result.status).toBe("complete");
                expect(result.value.promotionAuthorizations[0]).toEqual(
                    expect.objectContaining({
                        authorizationSource: "restricted_source_full_access",
                    }),
                );
            } else {
                expect(result.diagnostics[0]?.code).toBe("render.promotion_authorization_required");
            }
        }
    });

    it("inherits restricted-source safety through an exact reverse-accept lineage", async () => {
        const fixture = await selectionFixture({ publishAsset: false });
        const imported = makeImportedClosure("requires_user_confirmation");
        publishImportedInitialAssetVersion({
            assetsRoot: fixture.configuration.assetsRoot,
            transactionId: "txn-import-parent",
            asset: makeAsset(),
            version: imported,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            promotion: { promotionAction: "import_only" },
        });
        const reverse = makeReverseClosure(imported);
        publishAssetVersion({
            assetsRoot: fixture.configuration.assetsRoot,
            transactionId: "txn-reverse-child",
            version: reverse,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        pointDeploymentAtVersion(fixture, reverse);
        await refreshAnalysis(fixture);
        enableFullAccess(fixture);

        const result = selectionResult(fixture);
        expect(result.status).toBe("complete");
        expect(result.value.promotionAuthorizations[0]).toEqual(
            expect.objectContaining({
                versionId: VERSION_ID_2,
                authorizationSource: "restricted_source_full_access",
            }),
        );
    });

    it("does not let Full Access promote a reverse lineage rooted in user-created content", async () => {
        const fixture = await selectionFixture();
        const parent = makeVersionClosure();
        const reverse = makeReverseClosure(parent);
        publishAssetVersion({
            assetsRoot: fixture.configuration.assetsRoot,
            transactionId: "txn-user-reverse",
            version: reverse,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        pointDeploymentAtVersion(fixture, reverse);
        await refreshAnalysis(fixture);
        enableFullAccess(fixture);
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.promotion_authorization_required");
    });

    it("fails closed when reverse lineage names a missing or fingerprint-mismatched parent", async () => {
        for (const failure of ["missing", "mismatch"] as const) {
            const fixture = await selectionFixture({ publishAsset: false });
            const imported = makeImportedClosure("requires_user_confirmation");
            publishImportedInitialAssetVersion({
                assetsRoot: fixture.configuration.assetsRoot,
                transactionId: `txn-${failure}-parent`,
                asset: makeAsset(),
                version: imported,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                promotion: { promotionAction: "import_only" },
            });
            const reverse = makeReverseClosure(
                imported,
                failure === "missing"
                    ? {
                          previousVersionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                      }
                    : {
                          previousOriginFingerprint: `sha256:${"f".repeat(64)}`,
                      },
            );
            publishAssetVersion({
                assetsRoot: fixture.configuration.assetsRoot,
                transactionId: `txn-${failure}-child`,
                version: reverse,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            });
            pointDeploymentAtVersion(fixture, reverse);
            await refreshAnalysis(fixture);
            enableFullAccess(fixture);
            expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.origin_lineage_broken");
        }
    });

    it("blocks an import without any current grant or Full Access authority", async () => {
        const fixture = await selectionFixture({ publishAsset: false });
        publishImportedInitialAssetVersion({
            assetsRoot: fixture.configuration.assetsRoot,
            transactionId: "txn-import-only",
            asset: makeAsset(),
            version: makeImportedClosure("requires_user_confirmation"),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            promotion: { promotionAction: "import_only" },
        });
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.promotion_authorization_required");
    });
});
