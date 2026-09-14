import type { StateBackupExecutionObserver, StateBackupExecutionStage } from "../types";

export function reportStateBackupProgress(
    observer: StateBackupExecutionObserver | undefined,
    stage: StateBackupExecutionStage,
    completedUnits: number,
    totalUnits: number,
): void {
    if (observer === undefined) return;
    try {
        observer.report({ stage, completedUnits, totalUnits });
    } catch {
        // Progress is advisory. A broken observer cannot change backup authority or commit outcome.
    }
}
