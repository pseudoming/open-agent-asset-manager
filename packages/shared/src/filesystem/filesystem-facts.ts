import {
    type PhysicalPathIdentity,
    SafeFilesystemError,
    type SafeFilesystemFailureKind,
    type SafeFilesystemOperation,
} from "./filesystem-types";

export type FilesystemFailureSource = "safe_filesystem_error" | "node_errno_error" | "unknown";

export interface FilesystemFailureInspection {
    source: FilesystemFailureSource;
    failureKind: SafeFilesystemFailureKind;
    systemCode: string;
}

export interface FilesystemStatSample {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    isFile(): boolean;
    isDirectory(): boolean;
}

export function inspectFilesystemFailure(error: unknown): FilesystemFailureInspection {
    if (error instanceof SafeFilesystemError) {
        return {
            source: "safe_filesystem_error",
            failureKind: error.failureKind,
            systemCode: error.systemCode,
        };
    }
    if (error instanceof Error && "code" in error) {
        const systemCode = filesystemSystemCode(error);
        return {
            source: "node_errno_error",
            failureKind: failureKindForSystemCode(systemCode),
            systemCode,
        };
    }
    return { source: "unknown", failureKind: "io_error", systemCode: "UNKNOWN" };
}

export function filesystemSystemCode(error: unknown): string {
    return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "UNKNOWN") : "UNKNOWN";
}

export function toSafeFilesystemError(
    error: unknown,
    operation: SafeFilesystemOperation,
    targetPath: string,
): SafeFilesystemError {
    if (error instanceof SafeFilesystemError) return error;
    const inspection = inspectFilesystemFailure(error);
    return new SafeFilesystemError({
        failureKind: inspection.failureKind,
        operation,
        targetPath,
        systemCode: inspection.systemCode,
        message: `${operation} failed for ${targetPath} (${inspection.systemCode})`,
    });
}

export function filesystemEntryKind(stat: FilesystemStatSample): "file" | "directory" | null {
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return null;
}

export function sameFilesystemIdentity(left: FilesystemStatSample, right: FilesystemStatSample): boolean {
    return left.dev === right.dev && left.ino === right.ino && filesystemEntryKind(left) === filesystemEntryKind(right);
}

export function samePhysicalPathIdentity(left: PhysicalPathIdentity, right: PhysicalPathIdentity): boolean {
    return left.deviceId === right.deviceId && left.fileId === right.fileId && left.entryKind === right.entryKind;
}

export function sameFilesystemStableSample(left: FilesystemStatSample, right: FilesystemStatSample): boolean {
    return (
        sameFilesystemIdentity(left, right) &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

function failureKindForSystemCode(systemCode: string): SafeFilesystemFailureKind {
    if (systemCode === "ENOENT") return "not_found";
    if (systemCode === "EACCES" || systemCode === "EPERM") return "permission_denied";
    if (systemCode === "ELOOP") return "symlink_or_reparse";
    if (systemCode === "ENOTDIR" || systemCode === "EISDIR") return "wrong_entry_type";
    if (systemCode === "ENOSYS" || systemCode === "ENOTSUP" || systemCode === "EOPNOTSUPP") {
        return "unsupported_platform";
    }
    return "io_error";
}
