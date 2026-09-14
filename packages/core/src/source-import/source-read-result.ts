/** Core-owned candidate identity rewrite and terminal source reporting. */

import type {
    AdapterId,
    AdapterProviderReadResult,
    AdapterReadResult,
    ExtractedAssetCandidate,
    ProviderSourceParseReport,
    ReadAccessOutcome,
    Sha256Digest,
    SourceReadReport,
    SourceRoot,
} from "../types";
import { fingerprintDomain } from "../foundation/fingerprint";
import { compareCodeUnitText } from "./source-read-validation-helpers";

const READ_CANDIDATE_ID_DOMAIN = "oaam.read.candidate-id.v1";

export function rewriteCandidateIds(
    adapterId: AdapterId,
    readAuthorityFingerprint: Sha256Digest,
    result: AdapterProviderReadResult,
): { candidates: ExtractedAssetCandidate[]; sourceParseReports: ProviderSourceParseReport[] } {
    const ids = new Map(
        result.candidates.map((candidate, index) => [
            candidate.candidateId,
            fingerprintDomain(READ_CANDIDATE_ID_DOMAIN, {
                adapterId,
                readAuthorityFingerprint,
                providerCandidateId: candidate.candidateId,
                index,
            }),
        ]),
    );
    return {
        candidates: result.candidates.map((candidate) => ({
            ...candidate,
            candidateId: ids.get(candidate.candidateId) as string,
            adapterId,
        })),
        sourceParseReports: result.sourceParseReports.map((report) => ({
            ...report,
            readEntryDispositions: report.readEntryDispositions.map((disposition) =>
                disposition.disposition === "ignored"
                    ? disposition
                    : {
                          ...disposition,
                          candidateIds: disposition.candidateIds.map((id) => ids.get(id) ?? id).sort(compareCodeUnitText),
                      },
            ),
        })),
    };
}

export function deriveSourceReports(
    roots: readonly SourceRoot[],
    parseReports: readonly ProviderSourceParseReport[],
    outcomes: readonly ReadAccessOutcome[],
    invalid: boolean,
): SourceReadReport[] {
    const parseByRoot = new Map(parseReports.map((report) => [report.sourceRootId, report]));
    return roots.map((root) => {
        const rootOutcomes = outcomes.filter((outcome) => outcome.sourceRootId === root.sourceRootId);
        const failed = rootOutcomes.filter((outcome) => outcome.status !== "succeeded");
        let status: SourceReadReport["status"];
        if (invalid) status = "blocked";
        else if (failed.some((outcome) => outcome.status === "not_found")) status = "not_found";
        else if (failed.some((outcome) => outcome.status === "permission_denied")) status = "permission_denied";
        else if (failed.length > 0)
            status = rootOutcomes.some((outcome) => outcome.status === "succeeded") ? "partial" : "blocked";
        else status = parseStatusToSourceStatus((parseByRoot.get(root.sourceRootId) as ProviderSourceParseReport).status);
        return {
            sourceRootId: root.sourceRootId,
            status,
            diagnostics: [
                ...(parseByRoot.get(root.sourceRootId)?.diagnostics ?? []),
                ...failed.flatMap((outcome) => outcome.diagnostics),
            ],
        };
    });
}

function parseStatusToSourceStatus(status: ProviderSourceParseReport["status"]): SourceReadReport["status"] {
    return status === "parsed" ? "scanned" : status;
}

export function aggregateReadStatus(reports: readonly SourceReadReport[]): AdapterReadResult["status"] {
    const failed = new Set<SourceReadReport["status"]>(["blocked", "permission_denied", "malformed_source", "unknown_schema"]);
    const hasFailure = reports.some((report) => failed.has(report.status));
    const hasPartial = reports.some((report) => report.status === "partial");
    if (!hasFailure && !hasPartial) return "complete";
    if (hasPartial) return "partial";
    const hasComplete = reports.some((report) => !failed.has(report.status) && report.status !== "partial");
    return hasComplete ? "partial" : "failed";
}
