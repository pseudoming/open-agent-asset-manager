import * as path from "node:path";
import { inventoryDirectoryNoFollow, SafeFilesystemError } from "@oaam/shared/filesystem";
import type { Database } from "better-sqlite3";
import type { StateRestoreOrphanEvidenceV1 } from "../types";
import { scanActiveJournalReservations } from "../deployment/deployment-journal";
import { compareUtf8Bytes } from "../foundation/text-order";
import { listDeployments } from "../persistence/state-db";

/**
 * Report only OAAM-local Deployment material that the restored State DB cannot
 * own. Runtime target bytes are intentionally outside this scan.
 */
export function scanStateRestoreOrphanEvidence(input: {
    db: Database;
    deploymentsRoot: string;
    transactionsRoot: string;
}): StateRestoreOrphanEvidenceV1[] {
    const deploymentIds = new Set(listDeployments(input.db, true).map((deployment) => deployment.deploymentId));
    const evidence: StateRestoreOrphanEvidenceV1[] = [];
    for (const entry of inventoryDeploymentPayloadEntries(input.deploymentsRoot)) {
        if (entry.identity.entryKind !== "directory" || !deploymentIds.has(entry.relativeName)) {
            evidence.push({
                evidenceKind: "deployment_payload",
                path: path.join(input.deploymentsRoot, entry.relativeName),
            });
        }
    }
    const journals = scanActiveJournalReservations(input.transactionsRoot);
    for (const journal of journals.journals) {
        if (!deploymentIds.has(journal.deploymentId)) {
            evidence.push({
                evidenceKind: "deployment_journal",
                path: path.join(input.transactionsRoot, journal.transactionId, "journal.json"),
            });
        }
    }
    for (const transactionId of journals.corruptTxnIds) {
        evidence.push({
            evidenceKind: "corrupt_deployment_journal",
            path: path.join(input.transactionsRoot, transactionId, "journal.json"),
        });
    }
    return evidence.sort((left, right) => {
        const pathOrder = compareUtf8Bytes(left.path, right.path);
        return pathOrder === 0 ? compareUtf8Bytes(left.evidenceKind, right.evidenceKind) : pathOrder;
    });
}

function inventoryDeploymentPayloadEntries(deploymentsRoot: string): ReturnType<typeof inventoryDirectoryNoFollow>["entries"] {
    try {
        return inventoryDirectoryNoFollow(deploymentsRoot).entries;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
}

/** @internal Exact no-adoption inventory seam for fault tests. */
export const stateRestoreOrphanInternalsForTest = Object.freeze({
    inventoryDeploymentPayloadEntries,
});
