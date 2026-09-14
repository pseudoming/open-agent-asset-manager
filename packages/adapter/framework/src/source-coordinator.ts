/** Fixed source-read/report orchestration; family hooks cannot replace accounting. */

import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AdapterProviderReadInput,
    AdapterProviderReadResult,
    AssetKind,
    OperationDiagnostic,
    ProviderReadEntryDisposition,
    ProviderSourceParseReport,
    SourceReadObligation,
    SourceRoot,
} from "@oaam/core";
import { appendCoalescedCandidates } from "./source-candidate-coalescing";
import type { SourceCandidateBuilder, SourceContextBase, SourceScanResultBase } from "./source-model";
import type { AssetReaderDisposition, SourceUnavailableDisposition } from "./source-registry";
import { compareCodeUnitText } from "./source-text";

export interface SourceReadCoordinatorDiagnostics {
    unknownAuthority(root: SourceRoot | undefined): OperationDiagnostic;
    capabilityNotCallable(root: SourceRoot, capability: AdapterAssetSourceCapability): OperationDiagnostic;
    readerUnavailable(root: SourceRoot, unavailable: SourceUnavailableDisposition): OperationDiagnostic;
    contextUnresolved(root: SourceRoot, capability: AdapterAssetSourceCapability): OperationDiagnostic;
    rootWithoutObligation(root: SourceRoot): OperationDiagnostic;
}

export interface SourceReadCoordinatorHooks<
    Context extends SourceContextBase<string, object>,
    Scan extends SourceScanResultBase,
> {
    getReader(kind: AssetKind): AssetReaderDisposition<SourceCandidateBuilder<Context, Scan>>;
    resolveContext(input: AdapterProviderReadInput, root: SourceRoot, capability: AdapterAssetSourceCapability): Context | null;
    scan(
        input: AdapterProviderReadInput,
        obligation: SourceReadObligation,
        capability: AdapterAssetSourceCapability,
        context: Context,
    ): Promise<Scan>;
    candidateIdentityConflict?: SourceCandidateIdentityConflictPolicy;
    diagnostics: SourceReadCoordinatorDiagnostics;
}

export interface SourceCandidateIdentityConflictPolicy {
    identityKey(candidate: AdapterExtractedAssetCandidate): string | null;
    diagnostic(candidate: AdapterExtractedAssetCandidate, identityKey: string): OperationDiagnostic;
}

const REPORT_STATUS_PRIORITY: Record<ProviderSourceParseReport["status"], number> = {
    malformed_source: 7,
    unknown_schema: 6,
    unsupported: 5,
    parsed: 4,
    skipped_ignored_source: 3,
    empty: 2,
    deferred: 1,
};

export async function coordinateSourceRead<Context extends SourceContextBase<string, object>, Scan extends SourceScanResultBase>(
    input: AdapterProviderReadInput,
    capabilities: readonly AdapterAssetSourceCapability[],
    hooks: SourceReadCoordinatorHooks<Context, Scan>,
): Promise<AdapterProviderReadResult> {
    const capabilityByFingerprint = new Map(
        capabilities.map((capability) => [capability.sourceCapabilityFingerprint, capability]),
    );
    const roots = selectedSourceRoots(input);
    const reports = new Map<string, ProviderSourceParseReport>();
    const candidates: AdapterProviderReadResult["candidates"] = [];
    const diagnostics: OperationDiagnostic[] = [];

    for (const obligation of [...input.sourceReadObligations].sort(compareObligation)) {
        const capability = capabilityByFingerprint.get(obligation.sourceCapabilityFingerprint);
        const root = roots.get(obligation.sourceRootId);
        if (capability === undefined || root === undefined) {
            const diagnostic = hooks.diagnostics.unknownAuthority(root);
            diagnostics.push(diagnostic);
            if (root !== undefined) {
                mergeReport(reports, root.sourceRootId, obligation.sourceReadObligationId, {
                    status: "malformed_source",
                    diagnostics: [diagnostic],
                });
            }
            continue;
        }
        if (capability.entrySupportStatus !== "supported" || capability.readPolicy === "report_only") {
            const diagnostic = hooks.diagnostics.capabilityNotCallable(root, capability);
            diagnostics.push(diagnostic);
            mergeReport(reports, root.sourceRootId, obligation.sourceReadObligationId, {
                status: capability.entrySupportStatus === "unsupported" ? "unsupported" : "deferred",
                diagnostics: [diagnostic],
            });
            continue;
        }
        const reader = hooks.getReader(capability.assetKind);
        if (reader.disposition !== "reader") {
            const diagnostic = hooks.diagnostics.readerUnavailable(root, reader);
            diagnostics.push(diagnostic);
            mergeReport(reports, root.sourceRootId, obligation.sourceReadObligationId, {
                status: reader.disposition,
                diagnostics: [diagnostic],
            });
            continue;
        }
        const context = hooks.resolveContext(input, root, capability);
        if (context === null) {
            const diagnostic = hooks.diagnostics.contextUnresolved(root, capability);
            diagnostics.push(diagnostic);
            mergeReport(reports, root.sourceRootId, obligation.sourceReadObligationId, {
                status: "malformed_source",
                diagnostics: [diagnostic],
            });
            continue;
        }
        const scan = await hooks.scan(input, obligation, capability, context);
        const built = reader.buildCandidates(context, scan);
        appendCoalescedCandidates(candidates, built.candidates);
        const operationDiagnostics = [...scan.diagnostics, ...built.diagnostics];
        diagnostics.push(...operationDiagnostics);
        mergeReport(reports, root.sourceRootId, obligation.sourceReadObligationId, {
            status:
                built.candidates.length > 0
                    ? "parsed"
                    : scan.hadIgnoredSource || built.ignoredSource
                      ? "skipped_ignored_source"
                      : "empty",
            observedReadEntryIds: scan.observedReadEntryIds,
            dispositions: scan.dispositions,
            diagnostics: operationDiagnostics,
        });
    }

    for (const root of roots.values()) {
        if (reports.has(root.sourceRootId)) continue;
        const diagnostic = hooks.diagnostics.rootWithoutObligation(root);
        reports.set(root.sourceRootId, {
            sourceRootId: root.sourceRootId,
            sourceReadObligationIds: [],
            status: "deferred",
            observedReadEntryIds: [],
            readEntryDispositions: [],
            diagnostics: [diagnostic],
        });
    }

    applyCandidateIdentityConflicts(candidates, hooks.candidateIdentityConflict);

    return {
        candidates: candidates.sort((left, right) => compareCodeUnitText(left.candidateId, right.candidateId)),
        sourceParseReports: [...reports.values()]
            .map(normalizeParseReport)
            .sort((left, right) => compareCodeUnitText(left.sourceRootId, right.sourceRootId)),
        diagnostics,
    };
}

function applyCandidateIdentityConflicts(
    candidates: AdapterExtractedAssetCandidate[],
    policy: SourceCandidateIdentityConflictPolicy | undefined,
): void {
    if (policy === undefined) return;
    const groups = new Map<string, AdapterExtractedAssetCandidate[]>();
    for (const candidate of candidates) {
        const key = policy.identityKey(candidate);
        if (key === null) continue;
        const group = groups.get(key) ?? [];
        group.push(candidate);
        groups.set(key, group);
    }
    for (const [identityKey, group] of groups) {
        if (group.length < 2) continue;
        for (const candidate of group) {
            candidate.status = "incomplete";
            candidate.assetCandidateStatus = "incomplete";
            candidate.diagnostics.push(policy.diagnostic(candidate, identityKey));
        }
    }
}

function selectedSourceRoots(input: AdapterProviderReadInput): Map<string, SourceRoot> {
    const selector = input.target.sourceSelector;
    const roots =
        selector.selectorKind === "probe_roots"
            ? selector.observation.sourceRoots.filter((root) => selector.sourceRootIds.includes(root.sourceRootId))
            : [selector.binding.sourceRoot];
    return new Map(roots.map((root) => [root.sourceRootId, root]));
}

interface ReportContribution {
    status: ProviderSourceParseReport["status"];
    observedReadEntryIds?: string[];
    dispositions?: ProviderReadEntryDisposition[];
    diagnostics: OperationDiagnostic[];
}

function mergeReport(
    reports: Map<string, ProviderSourceParseReport>,
    sourceRootId: string,
    obligationId: string,
    contribution: ReportContribution,
): void {
    const current = reports.get(sourceRootId) ?? emptyParseReport(sourceRootId);
    current.sourceReadObligationIds.push(obligationId);
    current.observedReadEntryIds.push(...(contribution.observedReadEntryIds ?? []));
    current.readEntryDispositions.push(...(contribution.dispositions ?? []));
    current.diagnostics.push(...contribution.diagnostics);
    if (REPORT_STATUS_PRIORITY[contribution.status] > REPORT_STATUS_PRIORITY[current.status]) {
        current.status = contribution.status;
    }
    reports.set(sourceRootId, current);
}

function emptyParseReport(sourceRootId: string): ProviderSourceParseReport {
    return {
        sourceRootId,
        sourceReadObligationIds: [],
        status: "deferred",
        observedReadEntryIds: [],
        readEntryDispositions: [],
        diagnostics: [],
    };
}

function normalizeParseReport(report: ProviderSourceParseReport): ProviderSourceParseReport {
    return {
        ...report,
        sourceReadObligationIds: uniqueSorted(report.sourceReadObligationIds),
        observedReadEntryIds: uniqueSorted(report.observedReadEntryIds),
        readEntryDispositions: report.readEntryDispositions
            .map((disposition) =>
                disposition.disposition === "ignored"
                    ? disposition
                    : { ...disposition, candidateIds: uniqueSorted(disposition.candidateIds) },
            )
            .sort((left, right) => compareCodeUnitText(left.readEntryDispositionId, right.readEntryDispositionId)),
    };
}

function compareObligation(left: SourceReadObligation, right: SourceReadObligation): number {
    return compareCodeUnitText(left.sourceReadObligationId, right.sourceReadObligationId);
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort(compareCodeUnitText);
}
