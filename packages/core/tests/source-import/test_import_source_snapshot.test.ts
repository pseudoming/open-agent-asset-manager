import { describe, expect, it } from "vitest";
import { readVersionAuthority } from "../../src/catalog/version-authority";
import { computeImportSourceSnapshotFingerprint } from "../../src/foundation/fingerprint";
import { buildImportSourceSnapshot } from "../../src/orchestration/import-source-snapshot";
import type { AdapterId, UuidV4 } from "../../src/types";
import {
    acceptRequest,
    assetsRoot,
    makeReadResult,
    makeService,
    makeServiceConfiguration,
} from "./fixtures/import-service-test-fixtures";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;
const SHA_C = `sha256:${"c".repeat(64)}` as const;

describe("durable import source snapshots", () => {
    it("persists only the accepted candidate source closure in provenance V2", async () => {
        const read = await makeReadResult();
        read.sourceRoots.push({
            sourceRootId: "unused-root",
            rootRole: "source",
            sourceDomain: "family_shared",
            path: "/unused",
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "unused",
                    evidenceLevel: "docs_declared",
                },
            ],
            diagnostics: [],
        });
        read.observedReadEntries.push({
            observedReadEntryId: "unused-entry",
            sourceRootId: "unused-root",
            relativePath: "unused.md",
            entryKind: "file",
            contentHash: SHA_A,
            executable: false,
            physicalIdentityFingerprint: SHA_B,
        });
        read.sourceRoots.push({
            sourceRootId: "used-root-2",
            rootRole: "source",
            sourceDomain: "project_root",
            path: "/project",
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "z",
                    evidenceLevel: "docs_declared",
                },
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "a",
                    evidenceLevel: "user_provided",
                },
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "a",
                    evidenceLevel: "local_artifact",
                },
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "a",
                    evidenceLevel: "user_provided",
                },
            ],
            diagnostics: [],
        });
        read.observedReadEntries.push({
            observedReadEntryId: "used-entry-2",
            sourceRootId: "used-root-2",
            relativePath: "nested",
            entryKind: "directory",
            physicalIdentityFingerprint: SHA_C,
            directoryInventoryFingerprint: SHA_A,
        });
        const candidate = read.candidates[0]!;
        candidate.sourceRootIds.push("used-root-2");
        candidate.sourceContainerEntryIds.push("used-entry-2");
        candidate.sourceFileOrigins[0]!.observedReadEntryIds.push("used-entry-2");
        candidate.metadataSourceOrigins.push({
            metadataSubject: "type_data",
            observedReadEntryId: "used-entry-2",
        });
        candidate.metadataSourceOrigins.push({
            metadataSubject: "display_name",
            observedReadEntryId: "used-entry-2",
        });
        candidate.sourceEvidence.push({
            evidenceOrigin: "observed_read",
            observedReadEntryId: "used-entry-2",
            kind: "path",
            value: "nested",
            evidenceLevel: "local_artifact",
        });
        candidate.sourceEvidence.push({
            evidenceOrigin: "external_attestation",
            externalAttestationReceiptId: "receipt-1",
        });
        candidate.sourceEvidence.push({
            evidenceOrigin: "external_attestation",
            externalAttestationReceiptId: "receipt-2",
        });
        read.externalAttestationReceipts.push({
            externalAttestationReceiptId: "receipt-1",
            verifier: {
                componentId: "fixture-verifier",
                componentVersion: 1,
                configFingerprint: SHA_A,
            },
            subject: {
                subjectKind: "source_root_entry",
                sourceRootId: candidate.sourceRootIds[0]!,
                relativePath: "",
            },
            subjectFingerprint: SHA_B,
            verifierInputFingerprint: SHA_C,
            attestedKind: "document",
            attestedValue: "fixture",
            evidenceLevel: "local_artifact",
            verifierResultFingerprint: SHA_A,
            attestationReceiptFingerprint: SHA_B,
        });
        read.externalAttestationReceipts.push({
            externalAttestationReceiptId: "receipt-2",
            verifier: {
                componentId: "fixture-verifier",
                componentVersion: 1,
                configFingerprint: SHA_A,
            },
            subject: {
                subjectKind: "agent_runtime",
                agentRuntimeId: "FIXTURE_CLI",
            },
            subjectFingerprint: SHA_B,
            verifierInputFingerprint: SHA_C,
            attestedKind: "summary",
            attestedValue: "fixture runtime",
            evidenceLevel: "agent_answer",
            verifierResultFingerprint: SHA_A,
            attestationReceiptFingerprint: SHA_C,
        });

        const snapshot = buildImportSourceSnapshot(read, candidate);
        expect(snapshot.adapterId).toBe(candidate.adapterId);
        expect(snapshot.roots.map((root) => root.sourceRootId)).toEqual(["root-1", "used-root-2"]);
        expect(snapshot.entries.map((entry) => entry.observedReadEntryId)).not.toContain("unused-entry");
        expect(snapshot.externalAttestations.map((receipt) => receipt.externalAttestationReceiptId)).toEqual([
            "receipt-1",
            "receipt-2",
        ]);
        const { snapshotFingerprint: _stored, ...preimage } = snapshot;
        expect(snapshot.snapshotFingerprint).toBe(computeImportSourceSnapshotFingerprint(preimage));
    });

    it("rejects candidate references that are absent from the accepted read result", async () => {
        const read = await makeReadResult();
        const wrongAdapter = structuredClone(read.candidates[0]!);
        wrongAdapter.adapterId = "OTHER" as AdapterId;
        expect(() => buildImportSourceSnapshot(read, wrongAdapter)).toThrow(/adapter/u);

        const missingEntry = structuredClone(read.candidates[0]!);
        missingEntry.sourceFileOrigins[0]!.observedReadEntryIds = ["missing-entry"];
        expect(() => buildImportSourceSnapshot(read, missingEntry)).toThrow(/missing observed read entry/u);

        const missingReceipt = structuredClone(read.candidates[0]!);
        missingReceipt.sourceEvidence.push({
            evidenceOrigin: "external_attestation",
            externalAttestationReceiptId: "missing-receipt",
        });
        expect(() => buildImportSourceSnapshot(read, missingReceipt)).toThrow(/missing external attestation receipt/u);

        const missingRoot = structuredClone(read.candidates[0]!);
        missingRoot.sourceRootIds.push("missing-root");
        expect(() => buildImportSourceSnapshot(read, missingRoot)).toThrow(/missing source root/u);
    });

    it("writes provenance V2 while retaining the exact historical path and content identity", async () => {
        const read = await makeReadResult();
        const service = makeService(async () => read);
        const accepted = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
        if (accepted.status !== "complete") throw new Error("fixture import failed");
        const configuration = makeServiceConfiguration(async () => read);
        const version = readVersionAuthority(
            assetsRoot,
            accepted.value.assetId as UuidV4,
            accepted.value.versionId as UuidV4,
            configuration.dialectRegistry,
        );
        if (version === null || version.manifest.originAuthority.originKind !== "import") {
            throw new Error("fixture imported Version missing");
        }
        const provenance = version.manifest.importProvenanceAuthority;
        expect(provenance.schemaVersion).toBe(2);
        if (provenance.schemaVersion !== 2) throw new Error("new import did not write provenance V2");
        expect(provenance.sourceSnapshot).toMatchObject({
            schemaVersion: 1,
            adapterId: read.readTarget.adapterId,
            roots: [
                {
                    sourceRootId: "root-1",
                    path: read.sourceRoots[0]!.path,
                    rootRole: "source",
                    sourceDomain: "agent_runtime_private",
                },
            ],
            entries: [
                {
                    observedReadEntryId: read.observedReadEntries[0]!.observedReadEntryId,
                    contentHash: (read.observedReadEntries[0] as { contentHash: string }).contentHash,
                },
            ],
        });
        expect(provenance.sourceSnapshot.roots[0]!.path).toBe(read.sourceRoots[0]!.path);
    });
});
