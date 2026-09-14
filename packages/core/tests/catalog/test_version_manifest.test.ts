import { describe, expect, it } from "vitest";
import type { AssetVersionManifestV2 } from "../../src/contracts/asset-version";
import type { ImportProvenanceAuthorityV1, ImportProvenanceAuthorityV2 } from "../../src/contracts/persistence";
import {
    computeImportProvenanceAuthorityFingerprint,
    computeImportSourceSnapshotFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../src/foundation/fingerprint";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { parseVersionManifest, serializeVersionManifest, validateVersionManifest } from "../../src/catalog/version-manifest";
import { ASSET_ID, VERSION_ID, makeTextFile, makeVersionClosure } from "./fixtures/version-v2";

function cloneManifest(): AssetVersionManifestV2 {
    return structuredClone(makeVersionClosure().manifest);
}

function recalculateFinal(manifest: AssetVersionManifestV2): void {
    manifest.fingerprint = computeVersionFingerprint(
        manifest.versionCanonicalContentFingerprint,
        manifest.nativeRepresentations,
        manifest.dialectRestorationPayloads,
        manifest.portableDialectContracts,
    );
}

function makeImportedManifest(
    acceptedPromotion: ImportProvenanceAuthorityV1["acceptedPromotion"],
): AssetVersionManifestV2 & { importProvenanceAuthority: ImportProvenanceAuthorityV1 } {
    const manifest = cloneManifest();
    const provenancePreimage = {
        schemaVersion: 1 as const,
        importProvenanceId: "import-1",
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        previewSnapshotFingerprint: `sha256:${"b".repeat(64)}` as const,
        candidateFingerprint: `sha256:${"c".repeat(64)}` as const,
        acceptedFreshness: "user_approved_preview_snapshot" as const,
        acceptedPromotion,
        promotionSafety: "requires_user_confirmation" as const,
        importedAt: 101,
    };
    const provenance: ImportProvenanceAuthorityV1 = {
        ...provenancePreimage,
        authorityFingerprint: computeImportProvenanceAuthorityFingerprint(provenancePreimage),
    };
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        originKind: "import" as const,
        importProvenanceId: provenance.importProvenanceId,
        importProvenanceAuthorityFingerprint: provenance.authorityFingerprint,
        promotionRequirement: "requires_current_authorization" as const,
        createdAt: 101,
    };
    return {
        ...manifest,
        originAuthority: {
            ...originPreimage,
            authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
        },
        importProvenanceAuthority: provenance,
    } as AssetVersionManifestV2 & { importProvenanceAuthority: ImportProvenanceAuthorityV1 };
}

function makeImportedManifestV2(): AssetVersionManifestV2 & { importProvenanceAuthority: ImportProvenanceAuthorityV2 } {
    const legacy = makeImportedManifest({ promotionAction: "import_only", userActionEvidenceId: "x" });
    const sourceSnapshotPreimage = {
        schemaVersion: 1 as const,
        adapterId: "FIXTURE" as ImportProvenanceAuthorityV2["sourceSnapshot"]["adapterId"],
        roots: [
            {
                sourceRootId: "root-1",
                rootRole: "source" as const,
                sourceDomain: "project_root" as const,
                path: "/project",
                locatorEvidence: [
                    {
                        locatorKind: "runtime_known_rule" as const,
                        locatorKey: "project",
                        evidenceLevel: "local_artifact" as const,
                    },
                ],
            },
        ],
        entries: [
            {
                observedReadEntryId: "entry-1",
                sourceRootId: "root-1",
                relativePath: "AGENTS.md" as const,
                entryKind: "file" as const,
                contentHash: `sha256:${"1".repeat(64)}` as const,
                executable: false,
                physicalIdentityFingerprint: `sha256:${"2".repeat(64)}` as const,
            },
        ],
        fileOrigins: [{ logicalPath: "AGENTS.md" as const, observedReadEntryIds: ["entry-1"] }],
        sourceContainerEntryIds: [],
        metadataOrigins: [{ metadataSubject: "display_name" as const, observedReadEntryId: "entry-1" }],
        evidence: [
            {
                evidenceOrigin: "observed_read" as const,
                observedReadEntryId: "entry-1",
                kind: "document" as const,
                value: "AGENTS.md",
                evidenceLevel: "local_artifact" as const,
            },
        ],
        externalAttestations: [],
    };
    const sourceSnapshot = {
        ...sourceSnapshotPreimage,
        snapshotFingerprint: computeImportSourceSnapshotFingerprint(sourceSnapshotPreimage),
    };
    const {
        authorityFingerprint: _legacyFingerprint,
        schemaVersion: _legacySchemaVersion,
        ...common
    } = legacy.importProvenanceAuthority;
    const provenancePreimage: Omit<ImportProvenanceAuthorityV2, "authorityFingerprint"> = {
        ...common,
        schemaVersion: 2,
        sourceSnapshot,
    };
    const importProvenanceAuthority: ImportProvenanceAuthorityV2 = {
        ...provenancePreimage,
        authorityFingerprint: computeImportProvenanceAuthorityFingerprint(provenancePreimage),
    };
    const origin = legacy.originAuthority;
    if (origin.originKind !== "import") throw new Error("fixture must be imported");
    const { authorityFingerprint: _originFingerprint, ...originCommon } = origin;
    const originPreimage = {
        ...originCommon,
        importProvenanceAuthorityFingerprint: importProvenanceAuthority.authorityFingerprint,
    };
    return {
        ...legacy,
        originAuthority: {
            ...originPreimage,
            authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
        },
        importProvenanceAuthority,
    };
}

function recalculateImportedManifestV2(
    manifest: AssetVersionManifestV2 & { importProvenanceAuthority: ImportProvenanceAuthorityV2 },
): void {
    const sourceSnapshot = manifest.importProvenanceAuthority.sourceSnapshot;
    const { snapshotFingerprint: _storedSnapshot, ...snapshotPreimage } = sourceSnapshot;
    sourceSnapshot.snapshotFingerprint = computeImportSourceSnapshotFingerprint(snapshotPreimage);
    const provenance = manifest.importProvenanceAuthority;
    const { authorityFingerprint: _storedProvenance, ...provenancePreimage } = provenance;
    provenance.authorityFingerprint = computeImportProvenanceAuthorityFingerprint(provenancePreimage);
    const origin = manifest.originAuthority;
    if (origin.originKind !== "import") throw new Error("fixture must be imported");
    origin.importProvenanceAuthorityFingerprint = provenance.authorityFingerprint;
    const { authorityFingerprint: _storedOrigin, ...originPreimage } = origin;
    origin.authorityFingerprint = computeVersionOriginAuthorityFingerprint(originPreimage);
}

function makeCopiedManifest(
    overrides: Partial<Extract<AssetVersionManifestV2["originAuthority"], { originKind: "asset_copy" }>> = {},
): AssetVersionManifestV2 {
    const manifest = cloneManifest();
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: manifest.assetId,
        versionId: manifest.versionId,
        originKind: "asset_copy" as const,
        sourceAssetId: "11111111-1111-4111-8111-111111111111",
        sourceVersionId: "22222222-2222-4222-8222-222222222222",
        sourceVersionFingerprint: manifest.fingerprint,
        sourceVersionOriginAuthorityFingerprint: `sha256:${"3".repeat(64)}` as const,
        sourcePromotionSafety: "not_applicable" as const,
        userActionEvidenceId: "copy-action",
        promotionRequirement: "not_required" as const,
        createdAt: 102,
        ...overrides,
    };
    manifest.originAuthority = {
        ...originPreimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
    };
    return manifest;
}

describe("strict AssetVersion V2 manifest codec", () => {
    it("accepts and round-trips a canonical user-created Guidance Version", () => {
        const manifest = cloneManifest();
        expect(validateVersionManifest(manifest)).toEqual({ ok: true, diagnostics: [] });
        const json = serializeVersionManifest(manifest);
        expect(json.endsWith("\n")).toBe(true);
        expect(parseVersionManifest(json)).toEqual(manifest);
        const reordered = { originAuthority: manifest.originAuthority, ...manifest };
        expect(serializeVersionManifest(reordered)).toBe(json);
    });

    it("rejects unknown, missing, and nested undeclared fields without throwing", () => {
        const extra = { ...cloneManifest(), surprise: true };
        expect(validateVersionManifest(extra).ok).toBe(false);
        const missing = cloneManifest() as unknown as Record<string, unknown>;
        delete missing.files;
        expect(validateVersionManifest(missing).ok).toBe(false);
        const nested = cloneManifest();
        (nested.files[0] as unknown as Record<string, unknown>).surprise = true;
        expect(validateVersionManifest(nested).ok).toBe(false);
        expect(validateVersionManifest(null).diagnostics[0]?.code).toBe("version.strict");
    });

    it("rejects a kind/typeData mismatch", () => {
        const manifest = cloneManifest() as unknown as Record<string, unknown>;
        manifest.kind = "Rule";
        expect(validateVersionManifest(manifest).ok).toBe(false);
    });

    it("enforces create versus later exact-parent lineage", () => {
        const createWithParent = cloneManifest();
        createWithParent.sourceVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        expect(validateVersionManifest(createWithParent).diagnostics[0]?.code).toBe("version.lineage");

        const laterWithoutParent = cloneManifest();
        laterWithoutParent.changeKind = "edit";
        expect(validateVersionManifest(laterWithoutParent).diagnostics[0]?.code).toBe("version.lineage");
    });

    it("requires canonical file ordering and valid local reference targets", () => {
        const referenced = makeTextFile("# Root\n", "a.md", [
            {
                kind: "include",
                rawTarget: "z.md",
                required: true,
                resolution: "resolved_version_file",
                targetLogicalPath: "z.md",
                diagnostics: [],
            },
        ]);
        const target = makeTextFile("target", "z.md");
        target.file.fileId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        const valid = makeVersionClosure({ files: [referenced, target] }).manifest;
        expect(validateVersionManifest(valid).ok).toBe(true);

        const reversed = structuredClone(valid);
        reversed.files.reverse();
        expect(validateVersionManifest(reversed).diagnostics.some((d) => d.code === "version.file_order")).toBe(true);

        const missing = structuredClone(valid);
        const reference = missing.files[0]?.references[0];
        if (reference?.resolution === "resolved_version_file") reference.targetLogicalPath = "missing.md";
        expect(validateVersionManifest(missing).diagnostics.some((d) => d.code === "version.reference")).toBe(true);
    });

    it("recomputes both canonical and final Version fingerprints", () => {
        const canonicalMismatch = cloneManifest();
        canonicalMismatch.versionCanonicalContentFingerprint = `sha256:${"1".repeat(64)}`;
        expect(
            validateVersionManifest(canonicalMismatch).diagnostics.some((d) => d.code === "version.canonical_fingerprint"),
        ).toBe(true);
        const finalMismatch = cloneManifest();
        finalMismatch.fingerprint = `sha256:${"2".repeat(64)}`;
        expect(validateVersionManifest(finalMismatch).diagnostics.some((d) => d.code === "version.fingerprint")).toBe(true);
    });

    it("round-trips exact Asset-copy lineage and rejects washed promotion/content classification", () => {
        const unrestricted = makeCopiedManifest();
        expect(validateVersionManifest(unrestricted)).toEqual({ ok: true, diagnostics: [] });
        expect(parseVersionManifest(serializeVersionManifest(unrestricted))).toEqual(unrestricted);

        const restricted = makeCopiedManifest({
            sourcePromotionSafety: "requires_user_confirmation",
            promotionRequirement: "requires_current_authorization",
        });
        expect(validateVersionManifest(restricted).ok).toBe(true);

        const washedRestriction = makeCopiedManifest({
            sourcePromotionSafety: "requires_user_confirmation",
            promotionRequirement: "not_required",
        });
        expect(validateVersionManifest(washedRestriction).diagnostics).toContainEqual(
            expect.objectContaining({ code: "version.copy_origin" }),
        );

        const inventedRestriction = makeCopiedManifest({
            sourcePromotionSafety: "not_applicable",
            promotionRequirement: "requires_current_authorization",
        });
        expect(validateVersionManifest(inventedRestriction).diagnostics).toContainEqual(
            expect.objectContaining({ code: "version.copy_origin" }),
        );

        const changedContent = makeCopiedManifest({
            sourceVersionFingerprint: `sha256:${"4".repeat(64)}`,
        });
        expect(validateVersionManifest(changedContent).diagnostics).toContainEqual(
            expect.objectContaining({ code: "version.copy_origin" }),
        );
    });

    it("requires portable dialect refs to be sorted uniquely", () => {
        const manifest = cloneManifest();
        manifest.portableDialectContracts = [
            {
                field: "workflow_tool",
                dialectId: "z-tool-v1",
                dialectContractFingerprint: `sha256:${"7".repeat(64)}`,
            },
            {
                field: "workflow_model",
                dialectId: "a-model-v1",
                dialectContractFingerprint: `sha256:${"8".repeat(64)}`,
            },
        ];
        recalculateFinal(manifest);
        expect(
            validateVersionManifest(manifest).diagnostics.some(
                (diagnostic) => diagnostic.code === "version.portable_dialect_order",
            ),
        ).toBe(true);

        const duplicate = cloneManifest();
        duplicate.portableDialectContracts = [manifest.portableDialectContracts[0]!, manifest.portableDialectContracts[0]!];
        recalculateFinal(duplicate);
        expect(validateVersionManifest(duplicate).diagnostics[0]?.code).toBe("version.strict");
    });

    it("validates native binding, ordering, file ordering, and representation fingerprint", () => {
        const manifest = cloneManifest();
        const aStats = binaryPayloadStats(Buffer.from("a"));
        const zStats = binaryPayloadStats(Buffer.from("z"));
        const preimage = {
            schemaVersion: 1 as const,
            dialectId: "dialect",
            dialectContractFingerprint: `sha256:${"3".repeat(64)}` as const,
            canonicalContentFingerprint: manifest.versionCanonicalContentFingerprint,
            files: [
                {
                    relativePath: "a.md",
                    contentKind: "text" as const,
                    mediaType: "text/markdown",
                    contentHash: aStats.contentHash,
                    byteSize: aStats.byteSize,
                    executable: false,
                },
                {
                    relativePath: "z.md",
                    contentKind: "text" as const,
                    mediaType: "text/markdown",
                    contentHash: zStats.contentHash,
                    byteSize: zStats.byteSize,
                    executable: false,
                },
            ],
        };
        manifest.nativeRepresentations = [
            { ...preimage, representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage) },
        ];
        recalculateFinal(manifest);
        expect(validateVersionManifest(manifest).ok).toBe(true);

        const badBinding = structuredClone(manifest);
        badBinding.nativeRepresentations[0].canonicalContentFingerprint = `sha256:${"4".repeat(64)}`;
        expect(validateVersionManifest(badBinding).diagnostics.some((d) => d.code === "version.native_binding")).toBe(true);
        const badOrder = structuredClone(manifest);
        badOrder.nativeRepresentations[0].files.reverse();
        expect(validateVersionManifest(badOrder).diagnostics.some((d) => d.code === "version.native_file_order")).toBe(true);
        const badFingerprint = structuredClone(manifest);
        badFingerprint.nativeRepresentations[0].representationFingerprint = `sha256:${"5".repeat(64)}`;
        expect(validateVersionManifest(badFingerprint).diagnostics.some((d) => d.code === "version.native_fingerprint")).toBe(
            true,
        );

        const second = structuredClone(manifest.nativeRepresentations[0]);
        second.dialectId = "aaa";
        const { representationFingerprint: _old, ...secondPreimage } = second;
        second.representationFingerprint = computeVersionNativeRepresentationFingerprint(secondPreimage);
        const unordered = structuredClone(manifest);
        unordered.nativeRepresentations = [manifest.nativeRepresentations[0], second];
        recalculateFinal(unordered);
        expect(validateVersionManifest(unordered).diagnostics.some((d) => d.code === "version.native_order")).toBe(true);
    });

    it("accepts a fingerprinted V2 empty-directory graph while preserving strict closure", () => {
        const manifest = cloneManifest();
        const stats = binaryPayloadStats(Buffer.from("entry"));
        const preimage = {
            schemaVersion: 2 as const,
            dialectId: "directory-dialect",
            dialectContractFingerprint: `sha256:${"3".repeat(64)}` as const,
            canonicalContentFingerprint: manifest.versionCanonicalContentFingerprint,
            directories: ["bundle", "bundle/empty"],
            files: [
                {
                    relativePath: "bundle/entry.md",
                    contentKind: "text" as const,
                    mediaType: "text/markdown",
                    contentHash: stats.contentHash,
                    byteSize: stats.byteSize,
                    executable: false,
                },
            ],
        };
        manifest.nativeRepresentations = [
            { ...preimage, representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage) },
        ];
        recalculateFinal(manifest);
        expect(validateVersionManifest(manifest)).toEqual({ ok: true, diagnostics: [] });

        const missingParent = structuredClone(manifest);
        if (missingParent.nativeRepresentations[0]?.schemaVersion !== 2) throw new Error("missing V2 fixture");
        missingParent.nativeRepresentations[0].directories = ["bundle/empty"];
        expect(
            validateVersionManifest(missingParent).diagnostics.some(
                (diagnostic) => diagnostic.code === "version.native_directory_graph",
            ),
        ).toBe(true);
        const collision = structuredClone(manifest);
        if (collision.nativeRepresentations[0]?.schemaVersion !== 2) throw new Error("missing V2 fixture");
        collision.nativeRepresentations[0].directories.push("bundle/entry.md");
        expect(
            validateVersionManifest(collision).diagnostics.some(
                (diagnostic) => diagnostic.code === "version.native_directory_graph",
            ),
        ).toBe(true);
    });

    it("requires restoration refs to be sorted uniquely", () => {
        const manifest = cloneManifest();
        manifest.dialectRestorationPayloads = [
            {
                dialectId: "z",
                restorationContractFingerprint: `sha256:${"6".repeat(64)}`,
                contentHash: `sha256:${"7".repeat(64)}`,
            },
            {
                dialectId: "a",
                restorationContractFingerprint: `sha256:${"8".repeat(64)}`,
                contentHash: `sha256:${"9".repeat(64)}`,
            },
        ];
        recalculateFinal(manifest);
        expect(validateVersionManifest(manifest).diagnostics.some((d) => d.code === "version.restoration_order")).toBe(true);
    });

    it("binds user-created origin identity and fingerprint", () => {
        const identity = cloneManifest();
        identity.originAuthority.assetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        expect(validateVersionManifest(identity).diagnostics.some((d) => d.code === "version.origin_identity")).toBe(true);
        const fingerprint = cloneManifest();
        fingerprint.originAuthority.authorityFingerprint = `sha256:${"a".repeat(64)}`;
        expect(validateVersionManifest(fingerprint).diagnostics.some((d) => d.code === "version.origin_fingerprint")).toBe(true);
    });

    it("accepts a strict import authority branch and rejects broken provenance bindings", () => {
        const imported = makeImportedManifest({
            promotionAction: "grant_current_version_current_target",
            promotionGrantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            userActionEvidenceId: "accept-1",
        });
        expect(validateVersionManifest(imported).ok).toBe(true);

        const wrongIdentity = structuredClone(imported);
        wrongIdentity.importProvenanceAuthority.versionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        expect(validateVersionManifest(wrongIdentity).diagnostics.some((d) => d.code === "version.provenance_identity")).toBe(
            true,
        );
        const wrongFingerprint = structuredClone(imported) as typeof wrongIdentity;
        wrongFingerprint.importProvenanceAuthority.authorityFingerprint = `sha256:${"d".repeat(64)}`;
        expect(
            validateVersionManifest(wrongFingerprint).diagnostics.some((d) => d.code === "version.provenance_fingerprint"),
        ).toBe(true);
        const wrongBinding = structuredClone(imported) as typeof wrongIdentity;
        if (wrongBinding.originAuthority.originKind === "import") {
            wrongBinding.originAuthority.importProvenanceId = "other";
        }
        expect(validateVersionManifest(wrongBinding).diagnostics.some((d) => d.code === "version.provenance_binding")).toBe(true);
    });

    it("accepts provenance V2 and rejects tampered or incomplete source snapshots", () => {
        const complete = makeImportedManifestV2();
        complete.importProvenanceAuthority.sourceSnapshot.sourceContainerEntryIds = ["entry-1"];
        complete.importProvenanceAuthority.sourceSnapshot.externalAttestations = [
            {
                externalAttestationReceiptId: "receipt-1",
                verifier: {
                    componentId: "fixture",
                    componentVersion: 1,
                    configFingerprint: `sha256:${"3".repeat(64)}`,
                },
                subject: {
                    subjectKind: "source_root_entry",
                    sourceRootId: "root-1",
                    relativePath: "AGENTS.md",
                },
                subjectFingerprint: `sha256:${"4".repeat(64)}`,
                verifierInputFingerprint: `sha256:${"5".repeat(64)}`,
                attestedKind: "document",
                attestedValue: "fixture",
                evidenceLevel: "local_artifact",
                verifierResultFingerprint: `sha256:${"6".repeat(64)}`,
                attestationReceiptFingerprint: `sha256:${"7".repeat(64)}`,
            },
        ];
        complete.importProvenanceAuthority.sourceSnapshot.evidence.push({
            evidenceOrigin: "external_attestation",
            externalAttestationReceiptId: "receipt-1",
        });
        recalculateImportedManifestV2(complete);
        expect(validateVersionManifest(complete).ok).toBe(true);

        const fingerprint = makeImportedManifestV2();
        fingerprint.importProvenanceAuthority.sourceSnapshot.snapshotFingerprint = `sha256:${"0".repeat(64)}`;
        expect(
            validateVersionManifest(fingerprint).diagnostics.some((item) => item.code === "version.source_snapshot_fingerprint"),
        ).toBe(true);

        const missingEntry = makeImportedManifestV2();
        missingEntry.importProvenanceAuthority.sourceSnapshot.fileOrigins[0]!.observedReadEntryIds = ["missing"];
        recalculateImportedManifestV2(missingEntry);
        expect(
            validateVersionManifest(missingEntry).diagnostics.some((item) => item.code === "version.source_snapshot_entry"),
        ).toBe(true);

        for (const mutate of [
            (manifest: typeof missingEntry) => {
                manifest.importProvenanceAuthority.sourceSnapshot.entries[0]!.sourceRootId = "missing";
            },
            (manifest: typeof missingEntry) => {
                manifest.importProvenanceAuthority.sourceSnapshot.sourceContainerEntryIds = ["missing"];
            },
            (manifest: typeof missingEntry) => {
                manifest.importProvenanceAuthority.sourceSnapshot.metadataOrigins[0]!.observedReadEntryId = "missing";
            },
            (manifest: typeof missingEntry) => {
                const evidence = manifest.importProvenanceAuthority.sourceSnapshot.evidence[0]!;
                if (evidence.evidenceOrigin === "observed_read") evidence.observedReadEntryId = "missing";
            },
        ]) {
            const broken = makeImportedManifestV2();
            mutate(broken);
            recalculateImportedManifestV2(broken);
            expect(
                validateVersionManifest(broken).diagnostics.some((item) =>
                    ["version.source_snapshot_root", "version.source_snapshot_entry"].includes(item.code),
                ),
            ).toBe(true);
        }

        const missingReceipt = structuredClone(complete);
        const attestationEvidence = missingReceipt.importProvenanceAuthority.sourceSnapshot.evidence.find(
            (evidence) => evidence.evidenceOrigin === "external_attestation",
        );
        if (attestationEvidence?.evidenceOrigin !== "external_attestation") throw new Error("fixture evidence missing");
        attestationEvidence.externalAttestationReceiptId = "missing";
        recalculateImportedManifestV2(missingReceipt);
        expect(
            validateVersionManifest(missingReceipt).diagnostics.some(
                (item) => item.code === "version.source_snapshot_attestation",
            ),
        ).toBe(true);

        const missingReceiptRoot = structuredClone(complete);
        const receipt = missingReceiptRoot.importProvenanceAuthority.sourceSnapshot.externalAttestations[0]!;
        if (receipt.subject.subjectKind !== "source_root_entry") throw new Error("fixture receipt subject mismatch");
        receipt.subject.sourceRootId = "missing";
        recalculateImportedManifestV2(missingReceiptRoot);
        expect(
            validateVersionManifest(missingReceiptRoot).diagnostics.some((item) => item.code === "version.source_snapshot_root"),
        ).toBe(true);

        const duplicateContainer = structuredClone(complete);
        duplicateContainer.importProvenanceAuthority.sourceSnapshot.sourceContainerEntryIds.push("entry-1");
        expect(validateVersionManifest(duplicateContainer).diagnostics[0]?.code).toBe("version.strict");

        const duplicateReceipt = structuredClone(complete);
        duplicateReceipt.importProvenanceAuthority.sourceSnapshot.externalAttestations.push(
            structuredClone(duplicateReceipt.importProvenanceAuthority.sourceSnapshot.externalAttestations[0]!),
        );
        expect(validateVersionManifest(duplicateReceipt).diagnostics[0]?.code).toBe("version.strict");
    });

    it("accepts reverse-accept origin and both remaining strict promotion disposition branches", () => {
        const manifest = cloneManifest();
        const reversePreimage = {
            schemaVersion: 1 as const,
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            originKind: "reverse_accept" as const,
            previousVersionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            previousVersionOriginAuthorityFingerprint: `sha256:${"e".repeat(64)}` as const,
            reversePreparationIdentityFingerprint: `sha256:${"f".repeat(64)}` as const,
            userActionEvidenceId: "reverse-1",
            promotionRequirement: "requires_current_authorization" as const,
            createdAt: 102,
        };
        manifest.originAuthority = {
            ...reversePreimage,
            authorityFingerprint: computeVersionOriginAuthorityFingerprint(reversePreimage),
        };
        expect(validateVersionManifest(manifest).ok).toBe(true);

        expect(
            validateVersionManifest(makeImportedManifest({ promotionAction: "import_only", userActionEvidenceId: "x" })).ok,
        ).toBe(true);
        expect(
            validateVersionManifest(
                makeImportedManifest({
                    promotionAction: "grant_asset_all_versions_current_target",
                    promotionGrantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                    userActionEvidenceId: "x",
                }),
            ).ok,
        ).toBe(true);
    });

    it("serialize and parse refuse an invalid authority instead of normalizing it", () => {
        const invalid = cloneManifest();
        invalid.fingerprint = `sha256:${"0".repeat(64)}`;
        expect(() => serializeVersionManifest(invalid)).toThrow(/fingerprint mismatch/);
        expect(() => parseVersionManifest("[]")).toThrow(/strict V2 schema/);
        expect(() => parseVersionManifest("{")).toThrow();
    });
});
