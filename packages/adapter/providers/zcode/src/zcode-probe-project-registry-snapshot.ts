/** Preserve ZCode diagnostic names while sharing physical snapshot capture. */
import {
    CommittedSqliteSnapshotError,
    readCommittedSqliteSnapshot,
    type CommittedSqliteSnapshotDependencies,
} from "@oaam/shared/filesystem";

export class ZcodeRegistrySnapshotError extends Error {
    public constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "ZcodeRegistrySnapshotError";
    }
}

export function readZcodeProjectRegistrySnapshot(
    registryPath: string,
    overrides: Partial<CommittedSqliteSnapshotDependencies> = {},
): Buffer {
    try {
        return readCommittedSqliteSnapshot(registryPath, overrides);
    } catch (error) {
        if (error instanceof CommittedSqliteSnapshotError) {
            const codes = {
                sqlite_snapshot_unstable: "zcode_project_registry_snapshot_unstable",
                sqlite_snapshot_wal_invalid: "zcode_project_registry_wal_invalid",
                sqlite_snapshot_journal_active: "zcode_project_registry_journal_active",
            } as const;
            throw new ZcodeRegistrySnapshotError(codes[error.code], error.message);
        }
        throw error;
    }
}
