/** Authority-focused split from the original oversized test suite. */

import * as fs from "node:fs";
import * as path from "node:path";
import { lockFile } from "@oaam/shared/filesystem";
import { describe, expect, it } from "vitest";
import { createImportService } from "../../src/orchestration/import-service";
import { buildCandidateMaterial } from "../../src/orchestration/import-material";
import { readAssetManifest } from "../../src/catalog/asset-manifest";
import { resolvePromotionGrantAuthority } from "../../src/catalog/promotion-grant-store";
import { createVersionDialectRegistry, readVersionAuthority } from "../../src/catalog/version-authority";
import type { UuidV4 } from "../../src/types";
import { makeNativeDialectContract, makeRestorationDialectContract } from "./fixtures/dialect-contracts";
import {
    PROJECT_ID,
    TARGET_PROJECT_ID,
    assetsRoot,
    locksRoot,
    sourceFile,
    guidanceCandidate,
    providerForCandidate,
    makeReadResult,
    makeGuidanceReadResult,
    makeReadResultFromProvider,
    makeServiceConfiguration,
    makeService,
    acceptRequest,
} from "./fixtures/import-service-test-fixtures";

describe("Core promotion orchestration and imported Version material closure", () => {
    it("materializes an immutable V2 native directory graph without consulting a live source", () => {
        const candidate = guidanceCandidate("observed-entry", "# Guidance\n", {
            nativeRepresentation: {
                representationSource: "separate_file_graph",
                dialectId: "fixture-guidance-v1",
                directories: [
                    { relativePath: "bundle", observedReadEntryIds: ["directory-bundle"] },
                    { relativePath: "bundle/empty", observedReadEntryIds: ["directory-empty"] },
                ],
                files: [
                    {
                        relativePath: "bundle/native.md",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        bytes: new TextEncoder().encode("native bytes\n"),
                        executable: false,
                    },
                ],
            },
        });
        const material = buildCandidateMaterial(
            candidate,
            [],
            null,
            createVersionDialectRegistry([makeNativeDialectContract("Guidance", "fixture-guidance-v1")], [], [], []),
            [],
            { next: () => "00000000-0000-4000-8000-000000000099" as UuidV4 },
        );
        expect(material.nativeRepresentations).toEqual([
            expect.objectContaining({
                schemaVersion: 2,
                directories: ["bundle", "bundle/empty"],
                files: [expect.objectContaining({ relativePath: "bundle/native.md" })],
            }),
        ]);
    });

    it("creates, resolves, revokes, and lists an exact post-import grant", async () => {
        const read = await makeReadResult();
        const service = makeService(async () => read);
        const imported = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
        if (imported.status !== "complete") throw new Error("import failed");
        const created = service.createPromotionGrant({
            promotionAction: "grant_current_version_current_target",
            assetId: imported.value.assetId,
            versionId: imported.value.versionId,
            target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
            userActionId: "grant-current",
        });
        expect(created.status).toBe("complete");
        expect(service.listPromotionGrants(imported.value.assetId).value).toHaveLength(1);
        const revoked = service.revokePromotionGrant({
            promotionGrantId: created.value.promotionGrantId,
            expectedRevision: created.value.revision,
            expectedGrantFingerprint: created.value.grantFingerprint,
            userActionId: "revoke-current",
        });
        expect(revoked.value.grantState).toBe("revoked");
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: imported.value.assetId,
                versionId: imported.value.versionId,
                target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
            }),
        ).toBeNull();
    });

    it("keeps restricted-source Full Access disabled by default and updates it by CAS", async () => {
        const service = makeService(async (previous) => previous);
        const initial = service.getRestrictedSourcePromotionFullAccess();
        expect(initial.value).toEqual(expect.objectContaining({ state: "disabled", revision: 0 }));
        const enabled = service.setRestrictedSourcePromotionFullAccess({
            settingId: "restricted_source_promotion_full_access_v1",
            expectedRevision: initial.value.revision,
            expectedSettingFingerprint: initial.value.settingFingerprint,
            nextState: "enabled",
            userActionId: "enable-full-access",
        });
        expect(enabled.value).toEqual(expect.objectContaining({ state: "enabled", revision: 1 }));
        const stale = service.setRestrictedSourcePromotionFullAccess({
            settingId: "restricted_source_promotion_full_access_v1",
            expectedRevision: 0,
            expectedSettingFingerprint: initial.value.settingFingerprint,
            nextState: "disabled",
            userActionId: "stale-disable",
        });
        expect(stale.status).toBe("failed");
    });

    it("fails closed for missing authorities, wrong Version membership, and held locks", async () => {
        const read = await makeReadResult();
        const service = makeService(async (previous) => previous);
        const imported = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
        if (imported.status !== "complete") throw new Error("import failed");

        const invalidId = service.listPromotionGrants("invalid" as UuidV4);
        expect(invalidId.diagnostics[0]?.code).toBe("import.asset_id_invalid");
        const wrongVersion = service.createPromotionGrant({
            promotionAction: "grant_current_version_current_target",
            assetId: imported.value.assetId,
            versionId: "00000000-0000-4000-8000-000000009998" as UuidV4,
            target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
            userActionId: "wrong-version",
        });
        expect(wrongVersion.diagnostics[0]?.code).toBe("promotion.version_not_member");
        const missingGrant = service.revokePromotionGrant({
            promotionGrantId: "00000000-0000-4000-8000-000000009997" as UuidV4,
            expectedRevision: 1,
            expectedGrantFingerprint: `sha256:${"9".repeat(64)}`,
            userActionId: "missing-grant",
        });
        expect(missingGrant.diagnostics[0]?.code).toBe("promotion.grant_cardinality");

        const allVersions = service.createPromotionGrant({
            promotionAction: "grant_asset_all_versions_current_target",
            assetId: imported.value.assetId,
            target: { targetKind: "project", projectId: PROJECT_ID },
            userActionId: "all-versions",
        });
        expect(allVersions.value.subject).toEqual({
            subjectKind: "asset_all_versions",
            assetId: imported.value.assetId,
            activationVersionId: imported.value.versionId,
        });

        fs.mkdirSync(path.join(locksRoot, "assets"), { recursive: true });
        const releaseAsset = lockFile(path.join(locksRoot, "assets", `${imported.value.assetId}.lock`));
        if (releaseAsset === null) throw new Error("fixture failed to acquire Asset lock");
        try {
            const locked = service.listPromotionGrants(imported.value.assetId);
            expect(locked.diagnostics[0]?.code).toBe("import.asset_locked");
        } finally {
            releaseAsset();
        }

        service.getRestrictedSourcePromotionFullAccess();
        const releaseSettings = lockFile(path.join(locksRoot, "settings", "settings.lock"));
        if (releaseSettings === null) throw new Error("fixture failed to acquire settings lock");
        try {
            const locked = service.getRestrictedSourcePromotionFullAccess();
            expect(locked.diagnostics[0]?.code).toBe("settings.authority_locked");
        } finally {
            releaseSettings();
        }
    });

    it("rejects malformed security-operation discriminants before authority mutation", () => {
        const service = makeService(async (previous) => previous);
        const malformedGrant = service.createPromotionGrant({
            promotionAction: "grant_everything" as never,
            assetId: "00000000-0000-4000-8000-000000009996" as UuidV4,
            target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
            userActionId: "malformed-grant",
        } as never);
        expect(malformedGrant.diagnostics[0]?.code).toBe("promotion.action_invalid");

        const initial = service.getRestrictedSourcePromotionFullAccess();
        const malformedSetting = service.setRestrictedSourcePromotionFullAccess({
            settingId: "different_security_setting" as never,
            expectedRevision: initial.value.revision,
            expectedSettingFingerprint: initial.value.settingFingerprint,
            nextState: "enabled",
            userActionId: "malformed-setting",
        });
        expect(malformedSetting.diagnostics[0]?.code).toBe("settings.setting_id_invalid");
        expect(service.getRestrictedSourcePromotionFullAccess().value).toEqual(initial.value);
    });

    it("uses default clock/UUID factories and preserves canonical binary native bytes", async () => {
        const read = await makeReadResultFromProvider(
            providerForCandidate("Guidance", (observedReadEntryId) =>
                guidanceCandidate(observedReadEntryId, "# Guidance\n", {
                    files: [
                        {
                            logicalPath: "GUIDANCE.md",
                            role: "entry",
                            contentKind: "text",
                            mediaType: "text/markdown",
                            text: "# Guidance\n",
                            executable: false,
                        },
                        {
                            logicalPath: "resource.bin",
                            role: "resource",
                            contentKind: "binary",
                            mediaType: "application/octet-stream",
                            bytes: Buffer.from("# Guidance\n"),
                            executable: false,
                        },
                    ],
                    sourceFileOrigins: [
                        {
                            logicalPath: "GUIDANCE.md",
                            observedReadEntryIds: [observedReadEntryId],
                        },
                        {
                            logicalPath: "resource.bin",
                            observedReadEntryIds: [observedReadEntryId],
                        },
                    ],
                }),
            ),
            "Guidance",
        );
        const configuration = makeServiceConfiguration(async (previous) => previous);
        configuration.now = undefined;
        configuration.newUuid = undefined;
        const service = createImportService(configuration);
        const result = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
        expect(result.status).toBe("complete");
        if (result.status !== "complete") throw new Error("default-factory import failed");
        expect(result.value).toEqual({
            assetId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            versionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });
    });

    it("imports project scope, binary resources, separate native bytes, and source diagnostics", async () => {
        fs.writeFileSync(sourceFile, "native bytes\n");
        const read = await makeReadResultFromProvider(
            providerForCandidate("Guidance", (observedReadEntryId) =>
                guidanceCandidate(observedReadEntryId, "# Guidance\n", {
                    scope: "project",
                    projectRootPath: "/project",
                    files: [
                        {
                            logicalPath: "GUIDANCE.md",
                            role: "entry",
                            contentKind: "text",
                            mediaType: "text/markdown",
                            text: "# Guidance\n",
                            executable: false,
                            references: [],
                        },
                        {
                            logicalPath: "image.bin",
                            role: "resource",
                            contentKind: "binary",
                            mediaType: "application/octet-stream",
                            bytes: Buffer.from("# Guidance\n", "utf-8"),
                            executable: false,
                            references: [],
                        },
                    ],
                    nativeRepresentation: {
                        representationSource: "separate_files",
                        dialectId: "fixture-guidance-v1",
                        files: [
                            {
                                relativePath: "native.md",
                                contentKind: "text",
                                mediaType: "text/markdown",
                                bytes: Buffer.from("native bytes\n"),
                                executable: false,
                            },
                        ],
                    },
                    sourceFileOrigins: [
                        {
                            logicalPath: "GUIDANCE.md",
                            observedReadEntryIds: [observedReadEntryId],
                        },
                        {
                            logicalPath: "image.bin",
                            observedReadEntryIds: [observedReadEntryId],
                        },
                    ],
                    diagnostics: [
                        {
                            severity: "warning",
                            code: "fixture.source_note",
                            message: "source note",
                            path: "GUIDANCE.md",
                            traceId: "trace",
                            operation: "read",
                            causeKind: "unknown",
                            retryable: false,
                            suggestedActions: [],
                            rawSummary: "source note",
                        },
                    ],
                }),
            ),
            "Guidance",
        );
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([read]);
        const result = await service.acceptImport(acceptRequest(preview.value));
        expect(result.status).toBe("complete");
        if (result.status !== "complete") throw new Error("project import failed");
        expect(readAssetManifest(assetsRoot, result.value.assetId)?.projectId).toBe(PROJECT_ID);
        const version = readVersionAuthority(
            assetsRoot,
            result.value.assetId,
            result.value.versionId,
            createVersionDialectRegistry([makeNativeDialectContract("Guidance", "fixture-guidance-v1")], [], [], []),
        );
        expect(version?.files.find((file) => file.contentKind === "binary")).toEqual(
            expect.objectContaining({ bytes: new Uint8Array(Buffer.from("# Guidance\n")) }),
        );
        expect(version?.nativePayloads[0]?.files[0]?.bytes).toEqual(new Uint8Array(Buffer.from("native bytes\n")));
        expect(version?.manifest.diagnostics).toEqual([
            expect.objectContaining({
                code: "fixture.source_note",
            }),
        ]);
    });

    it("replaces, inherits, and clears restoration payloads across multiple dialects", async () => {
        const restorationFingerprint = `sha256:${"3".repeat(64)}` as const;
        const dialectIds = ["fixture-guidance-v1", "fixture-guidance-v2", "fixture-guidance-v3"] as const;
        const registry = createVersionDialectRegistry(
            dialectIds.map((dialectId) => makeNativeDialectContract("Guidance", dialectId)),
            dialectIds.map((dialectId) =>
                makeRestorationDialectContract("Guidance", dialectId, (bytes) => bytes.byteLength > 0, restorationFingerprint),
            ),
            [],
            [],
        );
        const service = makeService(async (previous) => previous, { dialectRegistry: registry });
        const firstRead = await makeGuidanceReadResult({
            dialectRestorationTransition: {
                action: "replace",
                bytes: Buffer.from("restoration-v1"),
            },
        });
        const first = await service.acceptImport(acceptRequest(service.previewImport([firstRead]).value));
        if (first.status !== "complete") throw new Error("first restoration import failed");

        const publishNext = async (
            label: string,
            dialectId: (typeof dialectIds)[number],
            transition: { action: "inherit" } | { action: "clear" } | { action: "replace"; bytes: Uint8Array },
            parentVersionId: UuidV4,
        ) => {
            fs.writeFileSync(sourceFile, `# ${label}\n`);
            const read = await makeGuidanceReadResult({
                nativeRepresentation: { representationSource: "canonical_files", dialectId },
                dialectRestorationTransition: transition,
            });
            const result = await service.acceptImport(
                acceptRequest(service.previewImport([read]).value, {
                    action: "create_version",
                    assetId: first.value.assetId,
                    parentVersionId,
                }),
            );
            if (result.status !== "complete") throw new Error(`${label} import failed`);
            return result.value.versionId;
        };

        const secondVersionId = await publishNext(
            "Second",
            "fixture-guidance-v2",
            { action: "replace", bytes: Buffer.from("restoration-v2") },
            first.value.versionId,
        );
        const thirdVersionId = await publishNext(
            "Third",
            "fixture-guidance-v3",
            { action: "replace", bytes: Buffer.from("restoration-v3") },
            secondVersionId,
        );
        const inheritedVersionId = await publishNext("Inherited", "fixture-guidance-v1", { action: "inherit" }, thirdVersionId);
        expect(
            readVersionAuthority(assetsRoot, first.value.assetId, inheritedVersionId, registry)?.restorationPayloads.map(
                (payload) => payload.dialectId,
            ),
        ).toEqual(dialectIds);

        const clearedVersionId = await publishNext("Cleared", "fixture-guidance-v1", { action: "clear" }, inheritedVersionId);
        expect(
            readVersionAuthority(assetsRoot, first.value.assetId, clearedVersionId, registry)?.restorationPayloads.map(
                (payload) => payload.dialectId,
            ),
        ).toEqual(["fixture-guidance-v2", "fixture-guidance-v3"]);
    });

    it("blocks a restoration transition without its exact dialect contract", async () => {
        const read = await makeGuidanceReadResult({
            dialectRestorationTransition: { action: "replace", bytes: Buffer.from("unknown") },
        });
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([read]);
        expect(preview.value.items[0]).toEqual(expect.objectContaining({ action: "blocked" }));
        expect(preview.value.items[0]?.diagnostics[0]?.code).toBe("import.restoration_contract_missing");
    });
});
