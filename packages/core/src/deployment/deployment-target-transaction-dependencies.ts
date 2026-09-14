/** Physical transaction defaults, shared by production execution and recovery. */
import { deleteJournal } from "./deployment-journal";
import { casWriteAll, preflightExecutableTransitions } from "./deployment-target-cas";
import { populateOldBytes } from "./deployment-target-entries";
import { rollbackToOld } from "./deployment-target-io";
import { verifyAll } from "./deployment-target-verify";

export const defaultTargetTransactionDependencies = {
    populateOldBytes,
    preflightExecutableTransitions,
    casWriteAll,
    rollbackToOld,
    verifyAll,
    deleteJournal,
};
export type TargetTransactionDependencies = typeof defaultTargetTransactionDependencies;
