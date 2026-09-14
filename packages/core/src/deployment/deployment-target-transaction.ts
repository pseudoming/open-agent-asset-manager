/** Private semantic target operations; Core retains journal, occupancy and commit authority. */
import type { TargetTransactionDependencies } from "./deployment-target-transaction-dependencies";
import type { TargetRecoveryOutcome } from "./deployment-file-recovery";
import type { ActiveJournal, ActiveJournalV2, DirectoryJournal, JournalEntry } from "./deployment-journal";
import type { TargetIoContext } from "./deployment-target-io";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "./deployment-target-replacement";
import type { VerifiedTarget } from "./deployment-target-verify";
import type { DeploymentRow } from "../persistence/state-db";
import type { OperationDiagnostic } from "../types";

export type TargetTransactionFailure =
    | { outcome: "conflict"; reasonCode: string }
    | { outcome: "blocked"; reasonCode: string; message: string; diagnostics?: OperationDiagnostic[] };

export interface TargetTransactionPreparationInput {
    transactionId: string;
    projectRootPath?: string;
    compilationFingerprint: string;
    entries: JournalEntry[];
    managedDirectoryBoundaries: string[];
    desiredDirectoryPaths: string[];
    runtimeReplacementAuthority?: DeploymentRuntimeReplacementAuthorityV1;
}

export interface PreparedTargetTransaction {
    readonly entries: JournalEntry[];
    readonly directoryEntries: ActiveJournalV2["directoryEntries"];
    prepareJournal(base: Omit<ActiveJournalV2, "schemaVersion">): DirectoryJournal;
    execute(journal: DirectoryJournal): { outcome: "executed"; journal: DirectoryJournal } | TargetTransactionFailure;
    verify(journal: DirectoryJournal): { outcome: "verified"; verified: VerifiedTarget[] } | TargetTransactionFailure;
    finalize(journal: DirectoryJournal): void;
}

export interface DeploymentTargetTransaction {
    prepare(
        input: TargetTransactionPreparationInput,
    ): { outcome: "ready"; prepared: PreparedTargetTransaction } | TargetTransactionFailure;
    recover(journal: ActiveJournal, side: "old" | "new"): TargetRecoveryOutcome;
}

export interface DeploymentTargetTransactions {
    readonly kind: "host" | "selected_wsl";
    ownsDeployment(deployment: DeploymentRow): boolean;
    ownsJournal(journal: ActiveJournal): boolean;
    create(input: {
        ctx: TargetIoContext;
        transactionsRoot: string;
        deps: TargetTransactionDependencies;
    }): DeploymentTargetTransaction;
}

export function targetTransactionUnavailable(message: string): TargetTransactionFailure {
    return { outcome: "blocked", reasonCode: "blocked_by_deploy_target_unavailable", message };
}
