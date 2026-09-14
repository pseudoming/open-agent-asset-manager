/** Deployment payload collection, promotion authority, and captured-byte scenarios. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import { deploymentInspectionInternalsForTest } from "../../src/orchestration/deployment-inspection-service";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import { publishDeploymentPayloads } from "../../src/deployment/deployment-payload-store";
import { createPromotionGrantAuthority, revokePromotionGrantAuthority } from "../../src/catalog/promotion-grant-store";
import {
    setRestrictedSourceFullAccessAuthority,
    virginRestrictedSourceFullAccessAuthority,
} from "../../src/catalog/settings-authority";
import { publishImportedInitialAssetVersion, publishInitialAssetVersion } from "../../src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { binaryPayloadStats, textPayloadStats } from "../../src/catalog/payload-store";
import { ASSET_ID, PROJECT_ID, VERSION_ID, makeAsset, makeVersionClosure } from "../catalog/fixtures/version-v2";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";
import {
    DEPLOYMENT_ID,
    TRANSACTION_ID,
    SHA_A,
    SHA_B,
    stagedContent,
    importedClosure,
    reverseClosure,
} from "./fixtures/deployment-lifecycle-test-fixtures";

describe("deployment payload collection and inspection byte helpers", () => {
    let root = "";

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-lifecycle-helper-"));
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("collects active and residual payloads once and rejects a kind conflict", () => {
        const deploymentsRoot = path.join(root, "deployments");
        const residualBytes = new Uint8Array(Buffer.from("residual"));
        const residualStats = binaryPayloadStats(residualBytes);
        publishDeploymentPayloads({
            deploymentsRoot,
            deploymentId: DEPLOYMENT_ID,
            transactionId: TRANSACTION_ID,
            payloads: [
                {
                    contentKind: "text",
                    contentHash: residualStats.contentHash,
                    bytes: residualBytes,
                },
            ],
        });
        const activeBytes = new Uint8Array(Buffer.from("active"));
        const activeStats = binaryPayloadStats(activeBytes);
        const residual = {
            appliedPayload: {
                contentKind: "text",
                contentHash: residualStats.contentHash,
                byteSize: residualBytes.byteLength,
            },
        };
        const collected = deploymentLifecycleInternalsForTest.collectDeploymentPayloads(
            deploymentsRoot,
            DEPLOYMENT_ID,
            [{ contentKind: "binary", contentHash: activeStats.contentHash, bytes: activeBytes }],
            [residual] as never,
        );
        expect(collected.map((payload) => payload.contentHash)).toEqual(
            [...collected.map((payload) => payload.contentHash)].sort(),
        );

        expect(() =>
            deploymentLifecycleInternalsForTest.collectDeploymentPayloads(
                deploymentsRoot,
                DEPLOYMENT_ID,
                [
                    {
                        contentKind: "binary",
                        contentHash: residualStats.contentHash,
                        bytes: residualBytes,
                    },
                ],
                [residual] as never,
            ),
        ).toThrow(/conflicting content kinds/);
    });

    it("resolves reverse promotion only from current persisted authorization", () => {
        const makeConfiguration = (name: string) => {
            const oaamRoot = path.join(root, name);
            fs.mkdirSync(oaamRoot);
            return {
                render: {
                    assetsRoot: path.join(oaamRoot, "assets"),
                    oaamRoot,
                    dialectRegistry: createVersionDialectRegistry([], [], [], []),
                },
            } as Parameters<typeof deploymentLifecycleInternalsForTest.resolvePreparationPromotionState>[0];
        };
        const deployment = {
            platform: "linux",
            platformInstanceId: "local-linux",
            targetRootPath: "/project",
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        } as Parameters<typeof deploymentLifecycleInternalsForTest.resolvePreparationPromotionState>[2];
        const notRequired = stagedContent();
        expect(
            deploymentLifecycleInternalsForTest.resolvePreparationPromotionState(
                makeConfiguration("not-required"),
                notRequired,
                deployment,
            ),
        ).toBe("already_authorized");

        const required = {
            ...stagedContent(),
            promotionRequirement: "requires_current_authorization" as const,
        };
        expect(
            deploymentLifecycleInternalsForTest.resolvePreparationPromotionState(
                makeConfiguration("missing-asset"),
                required,
                deployment as never,
            ),
        ).toBe("user_confirmation_required");

        const grantConfiguration = makeConfiguration("grants");
        const imported = importedClosure("requires_user_confirmation");
        publishImportedInitialAssetVersion({
            assetsRoot: grantConfiguration.render.assetsRoot,
            transactionId: "txn-lifecycle-imported-grants",
            asset: makeAsset([VERSION_ID], {
                scope: "project",
                projectId: PROJECT_ID,
                scopePath: "",
            }),
            version: imported,
            dialectRegistry: grantConfiguration.render.dialectRegistry,
            promotion: { promotionAction: "import_only" },
        });
        expect(
            deploymentLifecycleInternalsForTest.resolvePreparationPromotionState(
                grantConfiguration,
                required,
                deployment as never,
            ),
        ).toBe("user_confirmation_required");

        const revoked = createPromotionGrantAuthority({
            assetsRoot: grantConfiguration.render.assetsRoot,
            promotionGrantId: "10101010-1010-4010-8010-101010101010",
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: { targetKind: "project", projectId: PROJECT_ID },
            userActionEvidenceId: "revoked-grant-action",
            updatedAt: 101,
        });
        revokePromotionGrantAuthority({
            assetsRoot: grantConfiguration.render.assetsRoot,
            assetId: ASSET_ID,
            promotionGrantId: revoked.promotionGrantId,
            expectedRevision: revoked.revision,
            expectedGrantFingerprint: revoked.grantFingerprint,
            userActionEvidenceId: "revoke-grant-action",
            updatedAt: 102,
        });
        createPromotionGrantAuthority({
            assetsRoot: grantConfiguration.render.assetsRoot,
            promotionGrantId: "20202020-2020-4020-8020-202020202020",
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: { targetKind: "project", projectId: PROJECT_ID },
            userActionEvidenceId: "version-grant-action",
            updatedAt: 103,
        });
        createPromotionGrantAuthority({
            assetsRoot: grantConfiguration.render.assetsRoot,
            promotionGrantId: "30303030-3030-4030-8030-303030303030",
            subject: {
                subjectKind: "asset_all_versions",
                assetId: ASSET_ID,
                activationVersionId: DEPLOYMENT_ID,
            },
            target: { targetKind: "project", projectId: PROJECT_ID },
            userActionEvidenceId: "inactive-anchor-action",
            updatedAt: 104,
        });
        createPromotionGrantAuthority({
            assetsRoot: grantConfiguration.render.assetsRoot,
            promotionGrantId: "40404040-4040-4040-8040-404040404040",
            subject: {
                subjectKind: "asset_all_versions",
                assetId: ASSET_ID,
                activationVersionId: VERSION_ID,
            },
            target: { targetKind: "global_target", targetAuthorityFingerprint: SHA_A },
            userActionEvidenceId: "wrong-target-action",
            updatedAt: 105,
        });
        expect(
            deploymentLifecycleInternalsForTest.resolvePreparationPromotionState(
                grantConfiguration,
                required,
                deployment as never,
            ),
        ).toBe("user_confirmation_required");
        createPromotionGrantAuthority({
            assetsRoot: grantConfiguration.render.assetsRoot,
            promotionGrantId: "50505050-5050-4050-8050-505050505050",
            subject: {
                subjectKind: "asset_all_versions",
                assetId: ASSET_ID,
                activationVersionId: VERSION_ID,
            },
            target: { targetKind: "project", projectId: PROJECT_ID },
            userActionEvidenceId: "matching-target-action",
            updatedAt: 106,
        });
        expect(
            deploymentLifecycleInternalsForTest.resolvePreparationPromotionState(
                grantConfiguration,
                required,
                deployment as never,
            ),
        ).toBe("already_authorized");

        const fullAccessConfiguration = makeConfiguration("full-access-imported");
        publishImportedInitialAssetVersion({
            assetsRoot: fullAccessConfiguration.render.assetsRoot,
            transactionId: "txn-lifecycle-imported-full-access",
            asset: makeAsset([VERSION_ID], {
                scope: "project",
                projectId: PROJECT_ID,
                scopePath: "",
            }),
            version: importedClosure("requires_user_confirmation"),
            dialectRegistry: fullAccessConfiguration.render.dialectRegistry,
            promotion: { promotionAction: "import_only" },
        });
        const virgin = virginRestrictedSourceFullAccessAuthority();
        setRestrictedSourceFullAccessAuthority({
            oaamRoot: fullAccessConfiguration.render.oaamRoot,
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            nextState: "enabled",
            userActionEvidenceId: "enable-full-access-action",
            changedAt: 110,
        });
        expect(
            deploymentLifecycleInternalsForTest.resolvePreparationPromotionState(
                fullAccessConfiguration,
                required,
                deployment as never,
            ),
        ).toBe("already_authorized");
        expect(
            deploymentLifecycleInternalsForTest.resolvePreparationPromotionState(
                fullAccessConfiguration,
                { ...required, parentVersionId: DEPLOYMENT_ID },
                deployment as never,
            ),
        ).toBe("user_confirmation_required");

        const ordinaryConfiguration = makeConfiguration("full-access-ordinary");
        publishInitialAssetVersion({
            assetsRoot: ordinaryConfiguration.render.assetsRoot,
            transactionId: "txn-lifecycle-ordinary-full-access",
            asset: makeAsset([VERSION_ID], {
                scope: "project",
                projectId: PROJECT_ID,
                scopePath: "",
            }),
            version: makeVersionClosure(),
            dialectRegistry: ordinaryConfiguration.render.dialectRegistry,
        });
        setRestrictedSourceFullAccessAuthority({
            oaamRoot: ordinaryConfiguration.render.oaamRoot,
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            nextState: "enabled",
            userActionEvidenceId: "enable-ordinary-full-access-action",
            changedAt: 111,
        });
        expect(
            deploymentLifecycleInternalsForTest.resolvePreparationPromotionState(
                ordinaryConfiguration,
                required,
                deployment as never,
            ),
        ).toBe("user_confirmation_required");
    });

    it("inherits imported promotion safety only through an exact reverse lineage", () => {
        fs.mkdirSync(path.join(root, "lineage"));
        const configuration = {
            render: {
                assetsRoot: path.join(root, "lineage", "assets"),
                dialectRegistry: createVersionDialectRegistry([], [], [], []),
            },
        } as Parameters<typeof deploymentLifecycleInternalsForTest.importedPromotionSafety>[0];
        const imported = importedClosure("requires_user_confirmation");
        expect(deploymentLifecycleInternalsForTest.importedPromotionSafety(configuration, imported)).toBe(
            "requires_user_confirmation",
        );
        expect(deploymentLifecycleInternalsForTest.importedPromotionSafety(configuration, makeVersionClosure())).toBeNull();
        publishImportedInitialAssetVersion({
            assetsRoot: configuration.render.assetsRoot,
            transactionId: "txn-lifecycle-lineage",
            asset: makeAsset(),
            version: imported,
            dialectRegistry: configuration.render.dialectRegistry,
            promotion: { promotionAction: "import_only" },
        });
        expect(deploymentLifecycleInternalsForTest.importedPromotionSafety(configuration, reverseClosure(imported))).toBe(
            "requires_user_confirmation",
        );

        const missingParent = reverseClosure(imported);
        if (missingParent.manifest.originAuthority.originKind !== "reverse_accept") {
            throw new Error("reverse fixture origin was not preserved");
        }
        missingParent.manifest.originAuthority.previousVersionId = DEPLOYMENT_ID;
        expect(() => deploymentLifecycleInternalsForTest.importedPromotionSafety(configuration, missingParent)).toThrow(
            /exact parent authority/,
        );
        const mismatchedParent = reverseClosure(imported);
        if (mismatchedParent.manifest.originAuthority.originKind !== "reverse_accept") {
            throw new Error("reverse fixture origin was not preserved");
        }
        mismatchedParent.manifest.originAuthority.previousVersionOriginAuthorityFingerprint = SHA_B;
        expect(() => deploymentLifecycleInternalsForTest.importedPromotionSafety(configuration, mismatchedParent)).toThrow(
            /exact parent authority/,
        );
    });

    it("keeps canonical text, falls back for changed bytes, and preserves binary bytes", () => {
        expect(deploymentInspectionInternalsForTest.contentFromBytes(new Uint8Array(Buffer.from("hello\n")), "text")).toEqual({
            contentKind: "text",
            text: "hello\n",
        });
        expect(deploymentInspectionInternalsForTest.contentFromBytes(new Uint8Array([0, 255]), "binary")).toEqual({
            contentKind: "binary",
            bytes: new Uint8Array([0, 255]),
        });
        expect(() =>
            deploymentInspectionInternalsForTest.contentFromBytes(new Uint8Array(Buffer.from("hello\r\n")), "text"),
        ).toThrow(/canonically encoded/);
        expect(
            deploymentInspectionInternalsForTest.contentFromBytes(new Uint8Array(Buffer.from("hello\r\n")), "text", true),
        ).toMatchObject({ contentKind: "binary" });
        expect(() => deploymentInspectionInternalsForTest.contentFromBytes(new Uint8Array([255]), "text")).toThrow();
        expect(deploymentInspectionInternalsForTest.contentFromBytes(new Uint8Array([255]), "text", true)).toMatchObject({
            contentKind: "binary",
        });
    });

    it("captures a missing zero-byte deployment payload without inventing a hunk", () => {
        const deploymentsRoot = path.join(root, "empty-deployments");
        const targetPlan: TargetPlan = {
            schemaVersion: 1,
            targetFiles: [
                {
                    relativePath: "EMPTY.md",
                    content: { contentKind: "text", text: "" },
                    executable: false,
                },
            ],
        };
        const authority = makeExecutionAuthority(targetPlan, {
            deploymentId: DEPLOYMENT_ID,
        });
        const emptyStats = textPayloadStats("");
        publishDeploymentPayloads({
            deploymentsRoot,
            deploymentId: DEPLOYMENT_ID,
            transactionId: TRANSACTION_ID,
            payloads: [
                {
                    contentKind: "text",
                    contentHash: emptyStats.contentHash,
                    bytes: new Uint8Array(),
                },
            ],
        });
        const baseline = [
            {
                relativePath: "EMPTY.md",
                baselineState: {
                    rowState: "active",
                    appliedPayload: {
                        contentKind: "text",
                        contentHash: emptyStats.contentHash,
                        byteSize: 0,
                    },
                    appliedExecutable: false,
                    provenance: authority.targetFileProvenance[0]!.provenance,
                },
                managedDirectoryBoundaryPaths: [],
            },
        ];
        const captured = deploymentInspectionInternalsForTest.captureInspectionInput(
            { deploymentsRoot } as never,
            DEPLOYMENT_ID,
            authority.appliedRenderSnapshot,
            baseline as never,
            path.join(root, "missing-target-root"),
        );
        expect(captured.input.files).toEqual([
            expect.objectContaining({
                fileState: "baseline_missing",
                diffHunks: [],
                currentContent: { contentKind: "missing" },
            }),
        ]);
        expect(captured.runtimeReplacementAuthority.files).toEqual([{ relativePath: "EMPTY.md", expectedState: "missing" }]);
    });
});
