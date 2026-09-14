/** Base, catalog, origin and promotion fingerprint authority scenarios. */

import { describe, expect, it } from "vitest";
import {
    computeDeploymentAssetId,
    computeDeploymentFileId,
    computeImportProvenanceAuthorityFingerprint,
    computePostAssetManifestAuthoritySetFingerprint,
    computePromotionGrantFingerprint,
    computeRestrictedSourceFullAccessSettingFingerprint,
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
    computeVersionOriginAuthorityFingerprint,
    fingerprintDomain,
    stableStringify,
} from "../../src/foundation/fingerprint";
import { makeTextFile } from "../catalog/fixtures/version-v2";

describe("V2 base and catalog fingerprint registry", () => {
    it("stableStringify recursively sorts keys, preserves arrays, and drops undefined object fields", () => {
        expect(stableStringify({ z: 1, a: { y: 2, x: [null, true] }, omitted: undefined })).toBe(
            '{"a":{"x":[null,true],"y":2},"z":1}',
        );
        expect(() => stableStringify(1n)).toThrow(/BigInt/);
    });

    it("domain separation changes otherwise identical preimages", () => {
        expect(fingerprintDomain("domain-a", { value: 1 })).not.toBe(fingerprintDomain("domain-b", { value: 1 }));
    });

    it("canonicalizes post-publish Asset manifest authorities by Asset ID", () => {
        const left = {
            assetId: "11111111-1111-4111-8111-111111111111" as const,
            assetManifestAuthorityFingerprint: `sha256:${"1".repeat(64)}` as const,
        };
        const right = {
            assetId: "22222222-2222-4222-8222-222222222222" as const,
            assetManifestAuthorityFingerprint: `sha256:${"2".repeat(64)}` as const,
        };
        expect(computePostAssetManifestAuthoritySetFingerprint([right, left])).toBe(
            computePostAssetManifestAuthoritySetFingerprint([left, right]),
        );
    });

    it("canonical content is order-independent for files and excludes fileId/reference diagnostics", () => {
        const a = makeTextFile("a", "a.md", [
            {
                kind: "include",
                rawTarget: "b.md",
                required: true,
                resolution: "resolved_version_file",
                targetLogicalPath: "b.md",
                diagnostics: [],
            },
            {
                kind: "link",
                rawTarget: "asset",
                required: false,
                resolution: "resolved_asset_version",
                targetAssetVersionId: "99999999-9999-4999-8999-999999999999",
                diagnostics: [],
            },
            {
                kind: "execute",
                rawTarget: "later",
                required: false,
                resolution: "unresolved",
                diagnostics: [],
            },
        ]);
        const b = makeTextFile("b", "b.md");
        const canonical = { kind: "Guidance" as const, typeData: { schemaVersion: 1 as const } };
        const first = computeVersionCanonicalContentFingerprint(canonical, [b.file, a.file]);
        const changedOnlyLocals = {
            ...a.file,
            fileId: "88888888-8888-4888-8888-888888888888",
            references: a.file.references.map((reference) => ({
                ...reference,
                diagnostics: [
                    {
                        severity: "warning" as const,
                        code: "ignored",
                        message: "x",
                        path: "",
                        traceId: "",
                    },
                ],
            })),
        };
        expect(computeVersionCanonicalContentFingerprint(canonical, [changedOnlyLocals, b.file])).toBe(first);
        expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(computeVersionCanonicalContentFingerprint(canonical, [a.file, { ...b.file, logicalPath: "a.md" }])).toMatch(
            /^sha256:/,
        );
    });

    it("native and final Version fingerprints normalize dialect/file order and bind restoration triples", () => {
        const canonical = `sha256:${"1".repeat(64)}` as const;
        const nativeBase = {
            schemaVersion: 1 as const,
            dialectId: "z",
            dialectContractFingerprint: `sha256:${"2".repeat(64)}` as const,
            canonicalContentFingerprint: canonical,
            files: [
                {
                    relativePath: "z.md",
                    contentKind: "text" as const,
                    mediaType: "text/markdown",
                    contentHash: `sha256:${"3".repeat(64)}` as const,
                    byteSize: 1,
                    executable: false,
                },
                {
                    relativePath: "a.md",
                    contentKind: "text" as const,
                    mediaType: "text/markdown",
                    contentHash: `sha256:${"4".repeat(64)}` as const,
                    byteSize: 1,
                    executable: false,
                },
            ],
        };
        const fingerprint = computeVersionNativeRepresentationFingerprint(nativeBase);
        expect(fingerprint).toBe("sha256:011dc542221292585aade20222a38777a39aa6e9bbd89c143cc45a6be331c9d4");
        const native = { ...nativeBase, representationFingerprint: fingerprint };
        const restoration = {
            dialectId: "a",
            restorationContractFingerprint: `sha256:${"5".repeat(64)}` as const,
            contentHash: `sha256:${"6".repeat(64)}` as const,
        };
        const portable = [
            {
                field: "workflow_tool" as const,
                dialectId: "z-tool-v1",
                dialectContractFingerprint: `sha256:${"7".repeat(64)}` as const,
            },
            {
                field: "workflow_model" as const,
                dialectId: "a-model-v1",
                dialectContractFingerprint: `sha256:${"8".repeat(64)}` as const,
            },
        ];
        const finalFingerprint = computeVersionFingerprint(canonical, [native], [restoration], portable);
        expect(finalFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(computeVersionFingerprint(canonical, [native], [restoration], [...portable].reverse())).toBe(finalFingerprint);
        expect(
            computeVersionNativeRepresentationFingerprint({
                ...nativeBase,
                files: [...nativeBase.files].reverse(),
            }),
        ).toBe(fingerprint);
        const graphBase = {
            ...nativeBase,
            schemaVersion: 2 as const,
            directories: ["bundle", "bundle/empty"] as const,
            files: nativeBase.files.map((file) => ({ ...file, relativePath: `bundle/${file.relativePath}` })),
        };
        const graphFingerprint = computeVersionNativeRepresentationFingerprint(graphBase);
        expect(
            computeVersionNativeRepresentationFingerprint({
                ...graphBase,
                directories: [...graphBase.directories].reverse(),
            }),
        ).toBe(graphFingerprint);
        expect(
            computeVersionNativeRepresentationFingerprint({
                ...graphBase,
                directories: ["bundle", "bundle/other"],
            }),
        ).not.toBe(graphFingerprint);
    });

    it("origin and provenance fingerprints bind every supplied authority field", () => {
        const origin = {
            schemaVersion: 1 as const,
            assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            originKind: "user_created" as const,
            userActionEvidenceId: "click-1",
            promotionRequirement: "not_required" as const,
            createdAt: 1,
        };
        const provenance = {
            schemaVersion: 1 as const,
            importProvenanceId: "import-1",
            assetId: origin.assetId,
            versionId: origin.versionId,
            previewSnapshotFingerprint: `sha256:${"7".repeat(64)}` as const,
            candidateFingerprint: `sha256:${"8".repeat(64)}` as const,
            acceptedFreshness: "current_source_verified" as const,
            acceptedPromotion: {
                promotionAction: "import_only" as const,
                userActionEvidenceId: "click-2",
            },
            promotionSafety: "default_promotable" as const,
            importedAt: 2,
        };
        expect(computeVersionOriginAuthorityFingerprint(origin)).not.toBe(
            computeVersionOriginAuthorityFingerprint({ ...origin, createdAt: 2 }),
        );
        expect(computeImportProvenanceAuthorityFingerprint(provenance)).not.toBe(
            computeImportProvenanceAuthorityFingerprint({ ...provenance, importedAt: 3 }),
        );
    });

    it("pins PromotionGrant and restricted-source Full Access golden domains", () => {
        expect(
            computePromotionGrantFingerprint({
                schemaVersion: 1,
                promotionGrantId: "55555555-5555-4555-8555-555555555555",
                subject: {
                    subjectKind: "asset_version",
                    assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                },
                target: {
                    targetKind: "project",
                    projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                },
                grantState: "active",
                revision: 1,
                userActionEvidenceId: "ua",
                updatedAt: 10,
            }),
        ).toBe("sha256:06509966248854f4c48d8f33e6eecdc7384cddca61d14363789815a041374a61");
        expect(
            computeRestrictedSourceFullAccessSettingFingerprint({
                configVersion: 1,
                settingId: "restricted_source_promotion_full_access_v1",
                state: "disabled",
                revision: 0,
                updatedAt: 0,
            }),
        ).toBe("sha256:b5000d71a1c6fe7b8d8fb6d03704c47fdca74e925d58b3887ef58ee0d9cd278c");
    });

    it("preserves deterministic Deployment row IDs", () => {
        expect(computeDeploymentAssetId("d", "a")).toBe("533d77155dadc1819ba34e33593355f6");
        expect(computeDeploymentFileId("d", "a.md")).toBe("179823c5695a05841104fd61fdef8fc1");
    });
});
