/** Typed descriptor-safe filesystem results and failures. */

export type SafeFilesystemFailureKind =
    | "invalid_path"
    | "not_found"
    | "permission_denied"
    | "symlink_or_reparse"
    | "wrong_entry_type"
    | "resource_limit"
    | "stale"
    | "unsupported_platform"
    | "io_error";

export type SafeFilesystemOperation =
    | "read_regular_file"
    | "inspect_regular_file"
    | "inspect_directory"
    | "inspect_filesystem_capacity"
    | "inventory_directory"
    | "observe_local_process"
    | "invoke_local_executable"
    | "observe_selected_wsl_process"
    | "invoke_selected_wsl_executable"
    | "confirm_durable_file"
    | "confirm_durable_directory"
    | "confirm_durable_tree"
    | "durable_ensure_directory"
    | "durable_create_file"
    | "durable_replace_file"
    | "durable_remove_file"
    | "permanent_remove_file"
    | "durable_remove_tree"
    | "durable_publish_file"
    | "durable_publish_directory"
    | "atomic_write_file"
    | "lock_file"
    | "chmod_file";

/**
 * Typed failure from a descriptor-safe filesystem operation.
 *
 * `systemCode` is diagnostic only. Callers must branch on `failureKind`, not
 * platform-specific errno strings.
 */
export class SafeFilesystemError extends Error {
    readonly failureKind: SafeFilesystemFailureKind;
    readonly operation: SafeFilesystemOperation;
    readonly targetPath: string;
    readonly systemCode: string;

    constructor(input: {
        failureKind: SafeFilesystemFailureKind;
        operation: SafeFilesystemOperation;
        targetPath: string;
        systemCode?: string;
        message: string;
    }) {
        super(input.message);
        this.name = "SafeFilesystemError";
        this.failureKind = input.failureKind;
        this.operation = input.operation;
        this.targetPath = input.targetPath;
        this.systemCode = input.systemCode ?? "UNKNOWN";
    }
}

export type DurableMutationState = "not_applied" | "may_have_applied";

/**
 * A failed durable replacement must say whether rename already succeeded.
 * `may_have_applied` is intentionally fail-closed: callers must re-open and
 * reconcile instead of assuming either the old or new published state is current.
 */
export class DurableFilesystemMutationError extends SafeFilesystemError {
    readonly mutationState: DurableMutationState;

    constructor(input: {
        operation?: SafeFilesystemOperation;
        failureKind: SafeFilesystemFailureKind;
        targetPath: string;
        systemCode?: string;
        message: string;
        mutationState: DurableMutationState;
    }) {
        super({
            failureKind: input.failureKind,
            operation: input.operation ?? "durable_replace_file",
            targetPath: input.targetPath,
            systemCode: input.systemCode,
            message: input.message,
        });
        this.name = "DurableFilesystemMutationError";
        this.mutationState = input.mutationState;
    }
}

export interface PhysicalPathIdentity {
    deviceId: string;
    fileId: string;
    entryKind: "file" | "directory";
}

export interface FilesystemCapacity {
    availableBytes: number;
    totalBytes: number;
}

export interface StableRegularFileRead {
    bytes: Uint8Array;
    executable: boolean;
    identity: PhysicalPathIdentity;
}

/**
 * One stable byte range from a regular file.
 *
 * `byteOffset + bytes.byteLength` never exceeds `totalBytes`. Both metadata
 * and bytes are sampled through the same no-follow handle.
 */
export interface StableRegularFileRangeRead {
    bytes: Uint8Array;
    byteOffset: number;
    totalBytes: number;
    executable: boolean;
    identity: PhysicalPathIdentity;
}

export interface StableDirectoryInventoryEntry {
    relativeName: string;
    identity: PhysicalPathIdentity;
}

export interface StableDirectoryInventory {
    identity: PhysicalPathIdentity;
    entries: StableDirectoryInventoryEntry[];
}

export interface EnsuredDirectory {
    identity: PhysicalPathIdentity;
    created: boolean;
}

export interface BoundedDirectoryEntry {
    name: string;
    entryKind: "file" | "directory" | "other";
}
