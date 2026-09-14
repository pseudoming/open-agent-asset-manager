/** Exact candidate reconciliation across sibling source-read obligations. */

import { isDeepStrictEqual } from "node:util";
import type { AdapterExtractedAssetCandidate, CandidateMetadataSourceOrigin, SourceEvidence } from "@oaam/core";
import { compareCodeUnitText } from "./source-text";

/**
 * One physical source can be owned by more than one exact AgentRuntime entry.
 * Each obligation must retain its own Core read accounting, while an identical
 * Provider candidate remains one import decision with the union of its origins.
 * Any non-origin difference keeps both rows so Core's duplicate gate fails.
 */
export function appendCoalescedCandidates(
    candidates: AdapterExtractedAssetCandidate[],
    additions: readonly AdapterExtractedAssetCandidate[],
): void {
    const additionCounts = new Map<string, number>();
    for (const addition of additions) {
        additionCounts.set(addition.candidateId, (additionCounts.get(addition.candidateId) ?? 0) + 1);
    }
    for (const addition of additions) {
        if (additionCounts.get(addition.candidateId) !== 1) {
            candidates.push(addition);
            continue;
        }
        const existingIndex = candidates.findIndex((candidate) => candidate.candidateId === addition.candidateId);
        if (existingIndex === -1) {
            candidates.push(addition);
            continue;
        }
        const existing = candidates[existingIndex] as AdapterExtractedAssetCandidate;
        if (!sameCandidateMaterial(existing, addition)) {
            candidates.push(addition);
            continue;
        }
        candidates[existingIndex] = mergeCandidateOrigins(existing, addition);
    }
}

function sameCandidateMaterial(left: AdapterExtractedAssetCandidate, right: AdapterExtractedAssetCandidate): boolean {
    return isDeepStrictEqual(normalizeObservedOrigins(left), normalizeObservedOrigins(right));
}

function normalizeObservedOrigins(candidate: AdapterExtractedAssetCandidate): AdapterExtractedAssetCandidate {
    const normalized = structuredClone(candidate);
    normalized.sourceFileOrigins = normalized.sourceFileOrigins.map((origin) => ({
        ...origin,
        observedReadEntryIds: origin.observedReadEntryIds.map(() => ""),
    }));
    normalized.sourceContainerEntryIds = normalized.sourceContainerEntryIds.map(() => "");
    normalized.metadataSourceOrigins = normalized.metadataSourceOrigins.map((origin) => ({
        ...origin,
        observedReadEntryId: "",
    }));
    normalized.sourceEvidence = normalized.sourceEvidence.map((evidence) =>
        evidence.evidenceOrigin === "observed_read" ? { ...evidence, observedReadEntryId: "" } : evidence,
    );
    if (normalized.nativeRepresentation.representationSource !== "canonical_files") {
        normalized.nativeRepresentation.files = normalized.nativeRepresentation.files.map((file) =>
            file.fragmentOrigin === undefined
                ? file
                : {
                      ...file,
                      fragmentOrigin: { ...file.fragmentOrigin, observedReadEntryId: "" },
                  },
        );
        if (normalized.nativeRepresentation.representationSource === "separate_file_graph") {
            normalized.nativeRepresentation.directories = normalized.nativeRepresentation.directories.map((directory) => ({
                ...directory,
                observedReadEntryIds: directory.observedReadEntryIds.map(() => ""),
            }));
        }
    }
    return normalized;
}

function mergeCandidateOrigins(
    left: AdapterExtractedAssetCandidate,
    right: AdapterExtractedAssetCandidate,
): AdapterExtractedAssetCandidate {
    const merged = structuredClone(left);
    merged.sourceRootIds = uniqueSorted([...left.sourceRootIds, ...right.sourceRootIds]);
    const fileOrigins = new Map(merged.sourceFileOrigins.map((origin) => [origin.logicalPath, origin]));
    for (const origin of right.sourceFileOrigins) {
        const current = fileOrigins.get(origin.logicalPath) as (typeof merged.sourceFileOrigins)[number];
        current.observedReadEntryIds = uniqueSorted([...current.observedReadEntryIds, ...origin.observedReadEntryIds]);
    }
    merged.sourceFileOrigins = [...fileOrigins.values()].sort((a, b) => compareCodeUnitText(a.logicalPath, b.logicalPath));
    merged.sourceContainerEntryIds = uniqueSorted([...left.sourceContainerEntryIds, ...right.sourceContainerEntryIds]);
    merged.metadataSourceOrigins = uniqueMetadataOrigins([...left.metadataSourceOrigins, ...right.metadataSourceOrigins]);
    merged.sourceEvidence = uniqueSourceEvidence([...left.sourceEvidence, ...right.sourceEvidence]);
    if (
        merged.nativeRepresentation.representationSource === "separate_file_graph" &&
        right.nativeRepresentation.representationSource === "separate_file_graph"
    ) {
        const rightDirectories = new Map(
            right.nativeRepresentation.directories.map((directory) => [directory.relativePath, directory]),
        );
        merged.nativeRepresentation.directories = merged.nativeRepresentation.directories.map((directory) => ({
            ...directory,
            observedReadEntryIds: uniqueSorted([
                ...directory.observedReadEntryIds,
                ...(rightDirectories.get(directory.relativePath) as typeof directory).observedReadEntryIds,
            ]),
        }));
    }
    return merged;
}

function uniqueMetadataOrigins(values: readonly CandidateMetadataSourceOrigin[]): CandidateMetadataSourceOrigin[] {
    const byKey = new Map<string, CandidateMetadataSourceOrigin>();
    for (const value of values) byKey.set(`${value.metadataSubject}\0${value.observedReadEntryId}`, value);
    return [...byKey.entries()].sort(([left], [right]) => compareCodeUnitText(left, right)).map(([, value]) => value);
}

function uniqueSourceEvidence(values: readonly SourceEvidence[]): SourceEvidence[] {
    const byKey = new Map<string, SourceEvidence>();
    for (const value of values) byKey.set(JSON.stringify(value), value);
    return [...byKey.entries()].sort(([left], [right]) => compareCodeUnitText(left, right)).map(([, value]) => value);
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort(compareCodeUnitText);
}
