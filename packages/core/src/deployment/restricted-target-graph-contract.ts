/** Private complete-graph request and receipt contracts shared by channel and execution state machines. */
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { fingerprintDomain } from "../foundation/fingerprint";
import type { ActiveJournalV3, ActiveJournalV4, JournalDirectoryEntryV3, JournalEntry } from "./deployment-journal";
import type { SelectedWslJournalExecution } from "./deployment-journal-execution";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "./deployment-target-replacement";
import type { TargetRecoveryOutcome } from "./deployment-file-recovery";
import type { RestrictedTargetExecutionResult } from "./restricted-target-contract";

export interface RestrictedGraphPrepareInput {
    publicationTransactionId?: string;
    publicationProjectRootPath?: string;
    compilationFingerprint: string;
    entries: JournalEntry[];
    managedDirectoryBoundaries: string[];
    desiredDirectoryPaths: string[];
    runtimeReplacementAuthority?: DeploymentRuntimeReplacementAuthorityV1;
}

export interface RestrictedGraphPrepared {
    publication?: { transactionId: string; staging: ActiveJournalV4["staging"]; publications: ActiveJournalV4["publications"] };
    preparationId: string;
    compilationFingerprint: string;
    entries: JournalEntry[];
    managedDirectoryBoundaries: string[];
    directoryEntries: JournalDirectoryEntryV3[];
    targetExecution: SelectedWslJournalExecution;
}

export type RestrictedGraphPreparationResult =
    | { outcome: "ready"; prepared: RestrictedGraphPrepared }
    | { outcome: "unavailable" | "unsupported" | "conflict" };

export type RestrictedGraphStep =
    | { kind: "publication_receipt_required"; journalFingerprint: string; journal: ActiveJournalV4 }
    | {
          kind: "directory_receipt_required";
          side: "old" | "new";
          journalFingerprint: string;
          relativePath: string;
          identity: PhysicalPathIdentity;
      }
    | { kind: "executed"; result: RestrictedTargetExecutionResult }
    | { kind: "recovered"; outcome: TargetRecoveryOutcome };

export function restrictedGraphJournalFingerprint(journal: ActiveJournalV3 | ActiveJournalV4): string {
    return fingerprintDomain("oaam.restricted-target.journal.v1", journal);
}
