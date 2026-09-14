/** Provider-owned parse result validation against Core read authority. */

import type {
    AdapterProviderReadResult,
    AdapterReadTarget,
    ManagedTargetReadGuard,
    ObservedReadEntry,
    OperationDiagnostic,
    ProviderReadEntryDisposition,
    ProviderSourceParseReport,
    ReadAccessOutcome,
    ReadEntryHandle,
    SourceReadObligation,
} from "../types";
import type { AdapterReadLedgerSnapshot } from "../adapters/adapter-read-access";
import type { PreparedRead } from "./source-read-execution";
import { validateCandidates } from "./source-read-candidate-validator";
import { isSortedUnique, sameStringSet, sourceDiagnostic, uniqueMap } from "./source-read-validation-helpers";

export function validateProviderReadResult(
    target: AdapterReadTarget,
    prepared: PreparedRead,
    guards: readonly ManagedTargetReadGuard[],
    ledger: AdapterReadLedgerSnapshot,
    result: AdapterProviderReadResult,
): OperationDiagnostic[] {
    const diagnostics: OperationDiagnostic[] = [];
    const roots = new Map(prepared.roots.map((root) => [root.sourceRootId, root]));
    const obligations = new Map(prepared.obligations.map((obligation) => [obligation.sourceReadObligationId, obligation]));
    const capabilities = new Map(prepared.capabilities.map((capability) => [capability.sourceCapabilityFingerprint, capability]));
    const handles = uniqueMap(ledger.handles, (handle) => handle.readEntryHandleId, "read.handle_duplicate", diagnostics);
    const outcomes = uniqueMap(ledger.outcomes, (outcome) => outcome.readAccessOutcomeId, "read.outcome_duplicate", diagnostics);
    const entries = uniqueMap(ledger.entries, (entry) => entry.observedReadEntryId, "read.entry_duplicate", diagnostics);
    const reports = uniqueMap(
        result.sourceParseReports,
        (report) => report.sourceRootId,
        "read.parse_report_duplicate",
        diagnostics,
    );
    const candidates = uniqueMap(
        result.candidates,
        (candidate) => candidate.candidateId,
        "read.candidate_duplicate",
        diagnostics,
    );
    const dispositionIds = new Set<string>();
    const handleDisposition = new Map<string, ProviderReadEntryDisposition>();

    if (!sameStringSet(roots.keys(), reports.keys())) {
        diagnostics.push(
            sourceDiagnostic("read.parse_report_root_mismatch", "provider reports do not exactly cover selected roots"),
        );
    }
    for (const report of result.sourceParseReports) {
        const expectedObligations = prepared.obligations
            .filter((obligation) => obligation.sourceRootId === report.sourceRootId)
            .map((obligation) => obligation.sourceReadObligationId);
        if (!sameStringSet(expectedObligations, report.sourceReadObligationIds)) {
            diagnostics.push(sourceDiagnostic("read.parse_report_obligation_mismatch", "parse report obligations are not exact"));
        }
        for (const entryId of report.observedReadEntryIds) {
            if (entries.get(entryId)?.sourceRootId !== report.sourceRootId) {
                diagnostics.push(sourceDiagnostic("read.parse_report_entry_foreign", "parse report references a foreign entry"));
            }
        }
        for (const disposition of report.readEntryDispositions) {
            if (dispositionIds.has(disposition.readEntryDispositionId)) {
                diagnostics.push(sourceDiagnostic("read.disposition_duplicate", "disposition IDs must be unique"));
            }
            dispositionIds.add(disposition.readEntryDispositionId);
            if (handleDisposition.has(disposition.readEntryHandleId)) {
                diagnostics.push(sourceDiagnostic("read.handle_disposition_duplicate", "a handle has more than one disposition"));
            }
            handleDisposition.set(disposition.readEntryHandleId, disposition);
            validateDisposition(disposition, report, handles, outcomes, entries, obligations, diagnostics);
        }
    }
    for (const handle of ledger.handles) {
        if (!handleDisposition.has(handle.readEntryHandleId)) {
            diagnostics.push(
                sourceDiagnostic("read.handle_disposition_missing", "a Core-issued handle has no terminal disposition"),
            );
        }
    }
    validateObligationCompleteness(prepared, ledger, handleDisposition, diagnostics);
    validateCandidates(
        target,
        result.candidates,
        candidates,
        handleDisposition,
        handles,
        outcomes,
        entries,
        new Map(ledger.filePayloads.map((payload) => [payload.observedReadEntryId, payload.bytes])),
        obligations,
        capabilities,
        guards,
        diagnostics,
    );
    return diagnostics;
}

function validateDisposition(
    disposition: ProviderReadEntryDisposition,
    report: ProviderSourceParseReport,
    handles: ReadonlyMap<string, ReadEntryHandle>,
    outcomes: ReadonlyMap<string, ReadAccessOutcome>,
    entries: ReadonlyMap<string, ObservedReadEntry>,
    obligations: ReadonlyMap<string, SourceReadObligation>,
    diagnostics: OperationDiagnostic[],
): void {
    const handle = handles.get(disposition.readEntryHandleId);
    const obligation = obligations.get(disposition.sourceReadObligationId);
    if (
        handle === undefined ||
        obligation === undefined ||
        handle.sourceReadObligationId !== disposition.sourceReadObligationId ||
        obligation.sourceRootId !== report.sourceRootId
    ) {
        diagnostics.push(sourceDiagnostic("read.disposition_authority_mismatch", "disposition authority is invalid"));
        return;
    }
    if (disposition.disposition === "ignored") {
        if (disposition.reasonCode.trim() === "") {
            diagnostics.push(sourceDiagnostic("read.ignored_reason_missing", "ignored disposition requires a reason"));
        }
        return;
    }
    if (!isSortedUnique(disposition.candidateIds)) {
        diagnostics.push(sourceDiagnostic("read.disposition_candidates_not_canonical", "candidateIds must be sorted and unique"));
    }
    if (disposition.disposition === "traversed") {
        const outcome = outcomes.get(disposition.listDirectoryOutcomeId);
        const entry = entries.get(disposition.observedDirectoryEntryId);
        if (
            outcome?.operation !== "list_directory" ||
            outcome.status !== "succeeded" ||
            outcome.subjectReadEntryHandleId !== disposition.readEntryHandleId ||
            entry?.entryKind !== "directory" ||
            !outcome.observedReadEntryIds.includes(disposition.observedDirectoryEntryId)
        ) {
            diagnostics.push(
                sourceDiagnostic("read.traversed_outcome_invalid", "traversed disposition does not bind its exact list outcome"),
            );
        }
        return;
    }
    const outcome = outcomes.get(disposition.readAccessOutcomeId);
    if (
        outcome?.operation !== "read_file" ||
        outcome.status !== "succeeded" ||
        outcome.subjectReadEntryHandleId !== disposition.readEntryHandleId ||
        !sameStringSet(outcome.observedReadEntryIds, disposition.observedReadEntryIds) ||
        disposition.observedReadEntryIds.some((entryId) => entries.get(entryId)?.entryKind !== "file")
    ) {
        diagnostics.push(
            sourceDiagnostic("read.parsed_outcome_invalid", "parsed disposition does not bind its exact read outcome"),
        );
    }
}

function validateObligationCompleteness(
    prepared: PreparedRead,
    ledger: AdapterReadLedgerSnapshot,
    dispositions: ReadonlyMap<string, ProviderReadEntryDisposition>,
    diagnostics: OperationDiagnostic[],
): void {
    const capabilities = new Map(prepared.capabilities.map((capability) => [capability.sourceCapabilityFingerprint, capability]));
    for (const obligation of prepared.obligations) {
        const rootHandle = ledger.handles.find(
            (handle) => handle.sourceReadObligationId === obligation.sourceReadObligationId && handle.relativePath === "",
        );
        const rootResolves = ledger.outcomes.filter(
            (outcome) =>
                outcome.operation === "resolve_root" && outcome.sourceReadObligationId === obligation.sourceReadObligationId,
        );
        const rootResolve = rootResolves[0];
        if (rootResolves.length !== 1 || rootResolve === undefined) {
            diagnostics.push(sourceDiagnostic("read.obligation_root_unresolved", "obligation did not resolve its root"));
            continue;
        }
        if (rootResolve.status !== "succeeded") {
            if (rootHandle !== undefined) {
                diagnostics.push(
                    sourceDiagnostic("read.obligation_failed_root_has_handle", "failed root resolution cannot issue a handle"),
                );
            }
            continue;
        }
        if (rootHandle === undefined) {
            diagnostics.push(
                sourceDiagnostic("read.obligation_root_unresolved", "successful root resolution did not issue a handle"),
            );
            continue;
        }
        const disposition = dispositions.get(rootHandle.readEntryHandleId);
        const mechanism = capabilities.get(obligation.sourceCapabilityFingerprint)?.sourcePathMechanism;
        const expectedDisposition = mechanism === "fixed_file" || mechanism === "manifest_declared" ? "parsed" : "traversed";
        if (disposition?.disposition !== expectedDisposition) {
            diagnostics.push(
                sourceDiagnostic("read.obligation_root_unconsumed", "root handle did not satisfy its path mechanism"),
            );
        }
    }
}
