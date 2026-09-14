/** Durable, candidate-scoped historical source evidence for an accepted import. */

import type { AdapterReadResult, ExtractedAssetCandidate } from "../contracts/source-import";
import type {
    ImportExternalAttestationSnapshotV1,
    ImportSourceEntrySnapshotV1,
    ImportSourceEvidenceSnapshotV1,
    ImportSourceSnapshotV1,
} from "../contracts/persistence";
import { computeImportSourceSnapshotFingerprint } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";

export function buildImportSourceSnapshot(
    readResult: AdapterReadResult,
    candidate: ExtractedAssetCandidate,
): ImportSourceSnapshotV1 {
    if (readResult.readTarget.adapterId !== candidate.adapterId) {
        throw new Error("candidate adapter does not match its accepted read result");
    }
    const entryIds = consumedObservedEntryIds(candidate);
    const entries = selectById(
        readResult.observedReadEntries,
        entryIds,
        (entry) => entry.observedReadEntryId,
        "observed read entry",
    )
        .map((entry): ImportSourceEntrySnapshotV1 => structuredClone(entry))
        .sort((left, right) => compareUtf8Bytes(left.observedReadEntryId, right.observedReadEntryId));

    const externalAttestationIds = new Set(
        candidate.sourceEvidence.flatMap((evidence) =>
            evidence.evidenceOrigin === "external_attestation" ? [evidence.externalAttestationReceiptId] : [],
        ),
    );
    const externalAttestations = selectById(
        readResult.externalAttestationReceipts,
        externalAttestationIds,
        (receipt) => receipt.externalAttestationReceiptId,
        "external attestation receipt",
    )
        .map((receipt): ImportExternalAttestationSnapshotV1 => structuredClone(receipt))
        .sort((left, right) => compareUtf8Bytes(left.externalAttestationReceiptId, right.externalAttestationReceiptId));

    const rootIds = new Set(candidate.sourceRootIds);
    for (const entry of entries) rootIds.add(entry.sourceRootId);
    for (const receipt of externalAttestations) {
        if (receipt.subject.subjectKind === "source_root_entry") rootIds.add(receipt.subject.sourceRootId);
    }
    const roots = selectById(readResult.sourceRoots, rootIds, (root) => root.sourceRootId, "source root")
        .map((root) => ({
            sourceRootId: root.sourceRootId,
            rootRole: root.rootRole,
            sourceDomain: root.sourceDomain,
            path: root.path,
            locatorEvidence: [...root.locatorEvidence]
                .map((evidence) => ({ ...evidence }))
                .sort(
                    (left, right) =>
                        compareUtf8Bytes(left.locatorKind, right.locatorKind) ||
                        compareUtf8Bytes(left.locatorKey, right.locatorKey) ||
                        compareUtf8Bytes(left.evidenceLevel, right.evidenceLevel),
                ),
        }))
        .sort((left, right) => compareUtf8Bytes(left.sourceRootId, right.sourceRootId));

    const preimage: Omit<ImportSourceSnapshotV1, "snapshotFingerprint"> = {
        schemaVersion: 1,
        adapterId: candidate.adapterId,
        roots,
        entries,
        fileOrigins: [...candidate.sourceFileOrigins]
            .map((origin) => ({
                logicalPath: origin.logicalPath,
                observedReadEntryIds: [...origin.observedReadEntryIds].sort(compareUtf8Bytes),
            }))
            .sort((left, right) => compareUtf8Bytes(left.logicalPath, right.logicalPath)),
        sourceContainerEntryIds: [...candidate.sourceContainerEntryIds].sort(compareUtf8Bytes),
        metadataOrigins: [...candidate.metadataSourceOrigins]
            .map((origin) => ({ ...origin }))
            .sort(
                (left, right) =>
                    compareUtf8Bytes(left.metadataSubject, right.metadataSubject) ||
                    compareUtf8Bytes(left.observedReadEntryId, right.observedReadEntryId),
            ),
        evidence: [...candidate.sourceEvidence]
            .map((evidence): ImportSourceEvidenceSnapshotV1 => structuredClone(evidence))
            .sort((left, right) => compareUtf8Bytes(evidenceKey(left), evidenceKey(right))),
        externalAttestations,
    };
    return {
        ...preimage,
        snapshotFingerprint: computeImportSourceSnapshotFingerprint(preimage),
    };
}

function consumedObservedEntryIds(candidate: ExtractedAssetCandidate): Set<string> {
    const ids = new Set(candidate.sourceContainerEntryIds);
    for (const origin of candidate.sourceFileOrigins) {
        for (const observedReadEntryId of origin.observedReadEntryIds) ids.add(observedReadEntryId);
    }
    for (const origin of candidate.metadataSourceOrigins) ids.add(origin.observedReadEntryId);
    for (const evidence of candidate.sourceEvidence) {
        if (evidence.evidenceOrigin === "observed_read") ids.add(evidence.observedReadEntryId);
    }
    return ids;
}

function selectById<T>(values: readonly T[], requiredIds: ReadonlySet<string>, id: (value: T) => string, label: string): T[] {
    const byId = new Map(values.map((value) => [id(value), value]));
    return [...requiredIds].map((requiredId) => {
        const value = byId.get(requiredId);
        if (value === undefined) throw new Error(`accepted candidate references a missing ${label}: ${requiredId}`);
        return value;
    });
}

function evidenceKey(evidence: ImportSourceEvidenceSnapshotV1): string {
    return evidence.evidenceOrigin === "external_attestation"
        ? `external\0${evidence.externalAttestationReceiptId}`
        : `observed\0${evidence.observedReadEntryId}\0${evidence.kind}\0${evidence.value}\0${evidence.evidenceLevel}`;
}
