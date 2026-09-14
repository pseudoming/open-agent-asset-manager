/** Stable read-snapshot closure and replay validation. */

import type {
    AdapterReadResult,
    AdapterReadTarget,
    ExtractedAssetCandidate,
    ObservedReadEntry,
    OperationDiagnostic,
    ProviderReadEntryDisposition,
    ProviderSourceParseReport,
    ReadAccessOutcome,
    Sha256Digest,
    SourceReadObligation,
    SourceRoot,
} from "../types";
import { fingerprintDomain, stableStringify } from "../foundation/fingerprint";
import { BUILTIN_ASSET_KINDS, getAssetSpecHandler } from "../specs/registry";
import {
    validateCandidateFileGraph,
    validateCandidateOrigins,
    validateCandidateScopePair,
} from "./source-read-candidate-validator";
import { aggregateReadStatus } from "./source-read-result";
import {
    compareObligation,
    compareObservedEntry,
    compareCodeUnitText,
    isSortedUnique,
    sameStringSet,
    sourceDiagnostic,
    uniqueMap,
} from "./source-read-validation-helpers";

const READ_SNAPSHOT_DOMAIN = "oaam.read.stable-closure.v1";

export function computeReadSnapshotFingerprint(
    readTarget: AdapterReadTarget,
    readAuthorityFingerprint: Sha256Digest,
    obligations: readonly SourceReadObligation[],
    entries: readonly ObservedReadEntry[],
    receiptFingerprints: readonly Sha256Digest[],
    parseReports: readonly ProviderSourceParseReport[],
): Sha256Digest {
    const dispositions = parseReports
        .flatMap((report) => report.readEntryDispositions)
        .sort((left, right) => compareCodeUnitText(left.readEntryDispositionId, right.readEntryDispositionId));
    return fingerprintDomain(READ_SNAPSHOT_DOMAIN, {
        readTarget,
        readAuthorityFingerprint,
        obligations: [...obligations].sort(compareObligation),
        entries: [...entries].sort(compareObservedEntry),
        receiptFingerprints: [...receiptFingerprints].sort(compareCodeUnitText),
        dispositions,
    });
}

export function validateAdapterReadResultSnapshot(result: AdapterReadResult): OperationDiagnostic[] {
    const diagnostics: OperationDiagnostic[] = [];
    const roots = uniqueMap(result.sourceRoots, (root) => root.sourceRootId, "read.root_duplicate", diagnostics);
    const obligations = uniqueMap(
        result.sourceReadObligations,
        (obligation) => obligation.sourceReadObligationId,
        "read.obligation_duplicate",
        diagnostics,
    );
    const outcomes = uniqueMap(
        result.readAccessOutcomes,
        (outcome) => outcome.readAccessOutcomeId,
        "read.outcome_duplicate",
        diagnostics,
    );
    const entries = uniqueMap(
        result.observedReadEntries,
        (entry) => entry.observedReadEntryId,
        "read.entry_duplicate",
        diagnostics,
    );
    uniqueMap(
        result.externalAttestationReceipts,
        (receipt) => receipt.externalAttestationReceiptId,
        "read.receipt_duplicate",
        diagnostics,
    );
    const candidates = uniqueMap(
        result.candidates,
        (candidate) => candidate.candidateId,
        "read.candidate_duplicate",
        diagnostics,
    );
    const parseReports = uniqueMap(
        result.sourceParseReports,
        (report) => report.sourceRootId,
        "read.parse_report_duplicate",
        diagnostics,
    );
    const sourceReports = uniqueMap(
        result.sourceReports,
        (report) => report.sourceRootId,
        "read.source_report_duplicate",
        diagnostics,
    );
    const dispositions = uniqueMap(
        result.sourceParseReports.flatMap((report) => report.readEntryDispositions),
        (disposition) => disposition.readEntryDispositionId,
        "read.disposition_duplicate",
        diagnostics,
    );
    validateSnapshotReadTarget(result, roots, diagnostics);
    validateSnapshotTrace(result.readAccessOutcomes, result.sourceParseReports, entries, diagnostics);
    if (!sameStringSet(roots.keys(), parseReports.keys()) || !sameStringSet(roots.keys(), sourceReports.keys())) {
        diagnostics.push(sourceDiagnostic("read.report_root_mismatch", "selected roots and terminal reports differ"));
    }
    for (const obligation of result.sourceReadObligations) {
        if (!roots.has(obligation.sourceRootId)) {
            diagnostics.push(sourceDiagnostic("read.obligation_root_missing", "obligation references a missing root"));
        }
    }
    for (const outcome of result.readAccessOutcomes) {
        if (!roots.has(outcome.sourceRootId) || !obligations.has(outcome.sourceReadObligationId)) {
            diagnostics.push(sourceDiagnostic("read.outcome_authority_missing", "outcome authority reference is missing"));
        }
        for (const entryId of outcome.observedReadEntryIds) {
            if (!entries.has(entryId))
                diagnostics.push(sourceDiagnostic("read.outcome_entry_missing", "outcome references a missing entry"));
        }
    }
    for (const entry of result.observedReadEntries) {
        if (!roots.has(entry.sourceRootId)) {
            diagnostics.push(sourceDiagnostic("read.entry_root_missing", "observed entry references a missing root"));
        }
    }
    const expectedFingerprint = computeReadSnapshotFingerprint(
        result.readTarget,
        result.readAuthorityFingerprint,
        result.sourceReadObligations,
        result.observedReadEntries,
        result.externalAttestationReceipts.map((receipt) => receipt.attestationReceiptFingerprint),
        result.sourceParseReports,
    );
    if (expectedFingerprint !== result.readSnapshotFingerprint) {
        diagnostics.push(
            sourceDiagnostic("read.snapshot_fingerprint_mismatch", "read snapshot fingerprint does not match its closure"),
        );
    }
    if (outcomes.size !== result.readAccessOutcomes.length) {
        diagnostics.push(sourceDiagnostic("read.outcome_cardinality_mismatch", "read outcome cardinality is not exact"));
    }
    validateSnapshotCandidates(result.candidates, candidates, dispositions, obligations, outcomes, entries, diagnostics);
    if (result.status !== aggregateReadStatus(result.sourceReports)) {
        diagnostics.push(sourceDiagnostic("read.status_mismatch", "read status does not match terminal source reports"));
    }
    return diagnostics;
}

function validateSnapshotReadTarget(
    result: AdapterReadResult,
    roots: ReadonlyMap<string, SourceRoot>,
    diagnostics: OperationDiagnostic[],
): void {
    const selector = result.readTarget.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        if (roots.size !== 1 || stableStringify([...roots.values()][0]) !== stableStringify(selector.binding.sourceRoot)) {
            diagnostics.push(
                sourceDiagnostic("read.target_root_mismatch", "user-selected read target and selected source root differ"),
            );
        }
    } else {
        if (selector.observation.adapterId !== result.readTarget.adapterId) {
            diagnostics.push(
                sourceDiagnostic("read.target_adapter_mismatch", "read target and probe observation identify different adapters"),
            );
        }
        const observedRoots = new Map(selector.observation.sourceRoots.map((root) => [root.sourceRootId, root]));
        if (!sameStringSet(roots.keys(), selector.sourceRootIds)) {
            diagnostics.push(
                sourceDiagnostic("read.target_root_mismatch", "read target root membership and selected source roots differ"),
            );
        }
        for (const [rootId, root] of roots) {
            if (stableStringify(observedRoots.get(rootId)) !== stableStringify(root)) {
                diagnostics.push(
                    sourceDiagnostic("read.target_root_mismatch", "read target observation and selected source root differ"),
                );
            }
        }
    }
    const allowedKinds = new Set(result.readTarget.allowedKinds ?? BUILTIN_ASSET_KINDS);
    for (const candidate of result.candidates) {
        if (candidate.adapterId !== result.readTarget.adapterId || !allowedKinds.has(candidate.kind)) {
            diagnostics.push(
                sourceDiagnostic("read.target_candidate_mismatch", "candidate adapter or kind is outside the read target"),
            );
        }
    }
}

interface SnapshotProducedHandle {
    sourceReadObligationId: string;
    sourceRootId: string;
}

function validateSnapshotTrace(
    outcomeList: ReadAccessOutcome[],
    parseReports: ProviderSourceParseReport[],
    entries: ReadonlyMap<string, ObservedReadEntry>,
    diagnostics: OperationDiagnostic[],
): void {
    const produced = new Map<string, SnapshotProducedHandle>();
    for (const outcome of outcomeList) {
        for (const handleId of outcome.producedReadEntryHandleIds) {
            if (produced.has(handleId)) {
                diagnostics.push(sourceDiagnostic("read.handle_produced_duplicate", "a read handle was produced more than once"));
            }
            produced.set(handleId, {
                sourceReadObligationId: outcome.sourceReadObligationId,
                sourceRootId: outcome.sourceRootId,
            });
        }
    }
    for (const outcome of outcomeList) {
        if (outcome.operation === "resolve_root" || outcome.operation === "resolve_entry") {
            const expectedProduced = outcome.status === "succeeded" ? 1 : 0;
            if (outcome.producedReadEntryHandleIds.length !== expectedProduced || outcome.observedReadEntryIds.length !== 0) {
                diagnostics.push(
                    sourceDiagnostic("read.resolve_outcome_cardinality_invalid", "resolve outcome cardinality is invalid"),
                );
            }
            continue;
        }
        const subjectOutcome = outcome as ReadAccessOutcome & { subjectReadEntryHandleId: string };
        const subject = produced.get(subjectOutcome.subjectReadEntryHandleId);
        if (
            subject === undefined ||
            subject.sourceReadObligationId !== subjectOutcome.sourceReadObligationId ||
            subject.sourceRootId !== subjectOutcome.sourceRootId
        ) {
            diagnostics.push(
                sourceDiagnostic("read.outcome_subject_authority_invalid", "outcome subject is not a Core-produced handle"),
            );
        }
        if (
            subjectOutcome.operation === "list_directory" &&
            subjectOutcome.status !== "succeeded" &&
            subjectOutcome.producedReadEntryHandleIds.length !== 0
        ) {
            diagnostics.push(sourceDiagnostic("read.failed_list_produced_handle", "failed directory listing produced handles"));
        }
        const expectedEntries = subjectOutcome.operation === "final_validate" ? 1 : subjectOutcome.status === "succeeded" ? 1 : 0;
        if (subjectOutcome.observedReadEntryIds.length !== expectedEntries) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.outcome_entry_cardinality_invalid",
                    "read/list/final outcome entry cardinality is invalid",
                ),
            );
        }
    }

    const dispositionCounts = new Map<string, number>();
    for (const report of parseReports) {
        for (const disposition of report.readEntryDispositions) {
            dispositionCounts.set(disposition.readEntryHandleId, (dispositionCounts.get(disposition.readEntryHandleId) ?? 0) + 1);
            const authority = produced.get(disposition.readEntryHandleId);
            if (
                authority === undefined ||
                authority.sourceReadObligationId !== disposition.sourceReadObligationId ||
                authority.sourceRootId !== report.sourceRootId
            ) {
                diagnostics.push(
                    sourceDiagnostic("read.disposition_authority_mismatch", "snapshot disposition authority is invalid"),
                );
                continue;
            }
            validateSnapshotDisposition(disposition, outcomeList, entries, diagnostics);
        }
    }
    for (const handleId of produced.keys()) {
        if (dispositionCounts.get(handleId) !== 1) {
            diagnostics.push(
                sourceDiagnostic("read.handle_disposition_cardinality_invalid", "produced handle lacks one exact disposition"),
            );
        }
    }
}

function validateSnapshotDisposition(
    disposition: ProviderReadEntryDisposition,
    outcomeList: ReadAccessOutcome[],
    entries: ReadonlyMap<string, ObservedReadEntry>,
    diagnostics: OperationDiagnostic[],
): void {
    if (disposition.disposition === "ignored") {
        if (disposition.reasonCode.trim() === "") {
            diagnostics.push(sourceDiagnostic("read.ignored_reason_missing", "ignored snapshot disposition requires a reason"));
        }
        return;
    }
    if (!isSortedUnique(disposition.candidateIds)) {
        diagnostics.push(
            sourceDiagnostic("read.disposition_candidates_not_canonical", "snapshot candidateIds must be sorted and unique"),
        );
    }
    if (disposition.disposition === "traversed") {
        const outcome = outcomeList.find((item) => item.readAccessOutcomeId === disposition.listDirectoryOutcomeId);
        if (outcome?.operation !== "list_directory") {
            diagnostics.push(
                sourceDiagnostic("read.traversed_outcome_invalid", "snapshot traversal does not bind its exact outcome"),
            );
        } else if (
            outcome.status !== "succeeded" ||
            outcome.subjectReadEntryHandleId !== disposition.readEntryHandleId ||
            entries.get(disposition.observedDirectoryEntryId)?.entryKind !== "directory" ||
            !outcome.observedReadEntryIds.includes(disposition.observedDirectoryEntryId)
        ) {
            diagnostics.push(
                sourceDiagnostic("read.traversed_outcome_invalid", "snapshot traversal does not bind its exact outcome"),
            );
        }
        return;
    }
    const outcome = outcomeList.find((item) => item.readAccessOutcomeId === disposition.readAccessOutcomeId);
    if (outcome?.operation !== "read_file") {
        diagnostics.push(sourceDiagnostic("read.parsed_outcome_invalid", "snapshot parse does not bind its exact outcome"));
    } else if (
        outcome.status !== "succeeded" ||
        outcome.subjectReadEntryHandleId !== disposition.readEntryHandleId ||
        !sameStringSet(outcome.observedReadEntryIds, disposition.observedReadEntryIds) ||
        disposition.observedReadEntryIds.some((entryId) => entries.get(entryId)?.entryKind !== "file")
    ) {
        diagnostics.push(sourceDiagnostic("read.parsed_outcome_invalid", "snapshot parse does not bind its exact outcome"));
    }
}

function validateSnapshotCandidates(
    candidateList: ExtractedAssetCandidate[],
    candidates: ReadonlyMap<string, ExtractedAssetCandidate>,
    dispositions: ReadonlyMap<string, ProviderReadEntryDisposition>,
    obligations: ReadonlyMap<string, SourceReadObligation>,
    outcomes: ReadonlyMap<string, ReadAccessOutcome>,
    entries: ReadonlyMap<string, ObservedReadEntry>,
    diagnostics: OperationDiagnostic[],
): void {
    const referencedCandidateIds = [...dispositions.values()].flatMap((disposition) =>
        disposition.disposition === "ignored" ? [] : disposition.candidateIds,
    );
    if (!sameStringSet(candidates.keys(), referencedCandidateIds)) {
        diagnostics.push(
            sourceDiagnostic("read.candidate_disposition_mismatch", "snapshot candidate/disposition membership is not exact"),
        );
    }
    for (const candidate of candidateList) {
        if (
            !getAssetSpecHandler(candidate.kind).isCanonicalPair({
                kind: candidate.kind,
                typeData: candidate.typeData,
            })
        ) {
            diagnostics.push(
                sourceDiagnostic("read.candidate_type_data_invalid", "snapshot candidate kind/typeData pair is invalid"),
            );
        } else {
            validateCandidateFileGraph(candidate, diagnostics);
        }
        const candidateDispositions = [...dispositions.values()].filter(
            (disposition): disposition is Exclude<ProviderReadEntryDisposition, { disposition: "ignored" }> =>
                disposition.disposition !== "ignored" && disposition.candidateIds.includes(candidate.candidateId),
        );
        const expectedRoots = candidateDispositions
            .map((disposition) => obligations.get(disposition.sourceReadObligationId)?.sourceRootId)
            .filter((sourceRootId): sourceRootId is string => sourceRootId !== undefined);
        if (!isSortedUnique(candidate.sourceRootIds) || !sameStringSet(candidate.sourceRootIds, expectedRoots)) {
            diagnostics.push(
                sourceDiagnostic("read.candidate_root_mismatch", "snapshot candidate roots do not match its dispositions"),
            );
        }
        validateCandidateScopePair(candidate, diagnostics);
        validateCandidateOrigins(candidate, candidateDispositions, new Map(), outcomes, entries, null, [], diagnostics);
    }
}
