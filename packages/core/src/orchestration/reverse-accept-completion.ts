/** Complete one committed reverse acceptance without replaying Deployment journals. */

import type { CoreResult } from "../contracts/core-service";
import type { CommitRenderedTargetAcceptInput, RenderedTargetAcceptCommitView } from "../contracts/reverse";
import type { ReverseAcceptReconcileResult } from "../reverse/reverse-accept-reconcile";
import type { OperationDiagnostic, UuidV4, VersionRef } from "../types";

interface ReverseAcceptCompletionDependencies {
    commit(input: CommitRenderedTargetAcceptInput): Promise<CoreResult<RenderedTargetAcceptCommitView>>;
    finalize(preparationId: UuidV4, version: VersionRef): ReverseAcceptReconcileResult;
    reindex(assetId: UuidV4): CoreResult<{ diagnostics: OperationDiagnostic[] }>;
}

export async function commitAndCompleteReverseAccept(
    sourceInput: CommitRenderedTargetAcceptInput,
    dependencies: ReverseAcceptCompletionDependencies,
): Promise<CoreResult<RenderedTargetAcceptCommitView>> {
    let preparationId: UuidV4;
    try {
        preparationId = sourceInput.preparationId;
    } catch {
        // The existing commit owns invalid-input diagnostics, including getters.
        return dependencies.commit(sourceInput);
    }
    const committed = await dependencies.commit(sourceInput);
    if (committed.value.commitState !== "committed") return committed;

    // The commit Promise resolves after its Asset/settings/Deployment/path
    // leases are released. Finalization obtains its own ordered locks.
    try {
        const terminal = dependencies.finalize(preparationId, committed.value.version);
        if (
            !(terminal.reconcileState === "retired" && terminal.terminalState === "consumed") &&
            !(terminal.reconcileState === "resolved" && terminal.preparationState === "retired")
        ) {
            const reason = terminal.reconcileState === "recovery_required" ? terminal.reasonCode : terminal.reconcileState;
            return completionPending(committed, "reverse_accept.completion_pending", "reverse_accept", reason);
        }
    } catch (error) {
        const reason = error instanceof TypeError ? "invalid_terminal_binding" : "terminal_persistence_unavailable";
        return completionPending(committed, "reverse_accept.completion_pending", "reverse_accept", reason);
    }

    // The reservation is released only by a durable, verified retired marker.
    // A derived-index failure must not change the already committed outcome.
    try {
        const indexed = dependencies.reindex(committed.value.version.assetId);
        if (indexed.status === "failed") {
            return completionPending(committed, "reverse_accept.index_refresh_pending", "reindex", "failed", indexed.diagnostics);
        }
        const diagnostics = [...indexed.diagnostics, ...indexed.value.diagnostics];
        if (indexed.status !== "complete" || diagnostics.some((diagnostic) => diagnostic.severity !== "info")) {
            return completionPending(committed, "reverse_accept.index_refresh_pending", "reindex", indexed.status, diagnostics);
        }
        return committed;
    } catch {
        return completionPending(committed, "reverse_accept.index_refresh_pending", "reindex", "asset_index_refresh_failed");
    }
}

function completionPending(
    committed: CoreResult<RenderedTargetAcceptCommitView>,
    code: string,
    operation: OperationDiagnostic["operation"],
    reason: string,
    diagnostics: OperationDiagnostic[] = [],
): CoreResult<RenderedTargetAcceptCommitView> {
    const message = "The new Version was saved. Recover this managed location to finish updating its local state.";
    return {
        ...committed,
        diagnostics: [
            ...committed.diagnostics,
            {
                severity: "warning",
                code,
                message,
                path: "",
                traceId: "",
                operation,
                causeKind: "partial",
                retryable: true,
                suggestedActions: ["retry"],
                rawSummary: `${message} (${reason})`,
            },
            ...diagnostics,
        ],
    };
}
