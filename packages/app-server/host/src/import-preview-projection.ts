import type { ImportPreviewItem, ImportPreviewSnapshotV1 } from "@oaam/core";
import { requireImportPreviewCandidate } from "./import-preview-file-authority";

function previewStatus(item: ImportPreviewItem, candidateStatus: "importable" | "incomplete") {
    if (item.action === "duplicate") return "duplicate" as const;
    if (item.action === "blocked") return "blocked" as const;
    if (item.action === "incomplete" || candidateStatus === "incomplete") return "incomplete" as const;
    return "importable" as const;
}

export function projectImportPreviewCandidates(snapshot: ImportPreviewSnapshotV1, maximumSummarySelectors: number) {
    return snapshot.items.map((item) => {
        const candidate = requireImportPreviewCandidate(
            snapshot,
            item.candidateId,
            new TypeError("Import preview item has no exact candidate"),
        );
        const logicalPaths = candidate.files.map((file) => file.logicalPath).sort();
        const callableBindingRequests = item.callableBindingRequests.map((request) => ({
            subject: { ...request.subject },
            rawTarget: request.rawTarget,
            required: request.required,
        }));
        return {
            candidateId: item.candidateId,
            kind: candidate.kind,
            ...(candidate.kind === "Memory" ? { memoryEntityRole: candidate.typeData.entityRole } : {}),
            scope: candidate.scope,
            displayName: candidate.displayName,
            displayDescription: candidate.displayDescription,
            status: previewStatus(item, candidate.assetCandidateStatus),
            freshness: item.freshness,
            fileCount: logicalPaths.length,
            logicalPaths: logicalPaths.slice(0, maximumSummarySelectors),
            logicalPathsTruncated: logicalPaths.length > maximumSummarySelectors,
            diagnosticCodes: item.diagnostics.slice(0, maximumSummarySelectors).map((diagnostic) => diagnostic.code),
            callableBindingRequestCount: callableBindingRequests.length,
            callableBindingRequests: callableBindingRequests.slice(0, maximumSummarySelectors),
            callableBindingRequestsTruncated: callableBindingRequests.length > maximumSummarySelectors,
        };
    });
}
