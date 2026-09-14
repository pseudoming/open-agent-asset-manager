import type { Database } from "better-sqlite3";
import type { OperationDiagnostic } from "../types";
import { updateDeployment } from "../persistence/state-db";

interface BlockingContext {
    readonly db: Database;
    readonly now: () => number;
}

export interface BlockedDeploymentResult {
    readonly outcome: "blocked";
    readonly reasonCode: string;
    readonly diagnostics: OperationDiagnostic[];
    readonly transactionId: string;
}

/** Write blocking evidence to state DB and return the corresponding result. */
export function blocked(
    opts: BlockingContext,
    deploymentId: string,
    reasonCode: string,
    message: string,
): BlockedDeploymentResult {
    const now = opts.now();
    const evidence = JSON.stringify({
        schemaVersion: 1,
        reasonCode,
        operation: "deploy" as const,
        contextFingerprint: "",
        occurredAt: now,
        diagnostics: [],
        suggestedActions: [],
        retryable: false,
    });
    updateDeployment(opts.db, deploymentId, { blockingEvidence: evidence }, now);
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: reasonCode,
        message,
        operation: "deploy",
        causeKind: "internal_error",
        path: "",
        traceId: "",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
    return { outcome: "blocked", reasonCode, diagnostics: [diagnostic], transactionId: "" };
}

/** Persist blocking evidence while retaining an explicit diagnostic list. */
export function blockedRaw(
    opts: BlockingContext,
    deploymentId: string,
    reasonCode: string,
    diagnostics: OperationDiagnostic[],
    transactionId: string,
): BlockedDeploymentResult {
    const now = opts.now();
    const evidence = JSON.stringify({
        schemaVersion: 1,
        reasonCode,
        operation: "deploy" as const,
        contextFingerprint: "",
        occurredAt: now,
        diagnostics: [],
        suggestedActions: [],
        retryable: false,
    });
    updateDeployment(opts.db, deploymentId, { blockingEvidence: evidence }, now);
    return { outcome: "blocked", reasonCode, diagnostics, transactionId };
}

/** Missing/deleted Deployments lose write authority and return a passive result. */
export function blockedPassive(reasonCode: string, message: string): BlockedDeploymentResult {
    return {
        outcome: "blocked",
        reasonCode,
        diagnostics: [
            {
                severity: "error",
                code: reasonCode,
                message,
                operation: "deploy",
                causeKind: "not_found",
                path: "",
                traceId: "",
                retryable: false,
                suggestedActions: [],
                rawSummary: "",
            },
        ],
        transactionId: "",
    };
}
