import { SafeFilesystemError, type SafeFilesystemOperation } from "../../filesystem/filesystem-types";

export function decodeSelectedWslAscii(bytes: Uint8Array, operation: SafeFilesystemOperation, targetPath: string): string {
    try {
        const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if ([...value].some((character) => character !== "\t" && character !== "\n" && character !== "\r" && character < " ")) {
            throw new TypeError("control character");
        }
        return value;
    } catch {
        throw new SafeFilesystemError({
            failureKind: "io_error",
            operation,
            targetPath,
            systemCode: "INVALID_UTF8",
            message: "selected WSL operation returned invalid text",
        });
    }
}

export function mapSelectedWslCommandError(
    error: unknown,
    operation: SafeFilesystemOperation,
    targetPath: string,
): SafeFilesystemError {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
    const status =
        error instanceof Error && "status" in error && Number.isInteger((error as { status?: unknown }).status)
            ? Number((error as { status: number }).status)
            : null;
    if (
        code === "ETIMEDOUT" ||
        (error instanceof Error && "killed" in error && (error as { killed?: unknown }).killed === true)
    ) {
        return new SafeFilesystemError({
            failureKind: "stale",
            operation,
            targetPath,
            systemCode: "ETIMEDOUT",
            message: "selected WSL operation timed out",
        });
    }
    if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return new SafeFilesystemError({
            failureKind: "resource_limit",
            operation,
            targetPath,
            systemCode: code,
            message: "selected WSL operation exceeded its output limit",
        });
    }
    if (code === "ENOENT") {
        return new SafeFilesystemError({
            failureKind: "unsupported_platform",
            operation,
            targetPath,
            systemCode: code,
            message: "wsl.exe is unavailable on this target",
        });
    }
    if (code === "EACCES" || code === "EPERM") {
        return new SafeFilesystemError({
            failureKind: "permission_denied",
            operation,
            targetPath,
            systemCode: code,
            message: "selected WSL operation was denied",
        });
    }
    return new SafeFilesystemError({
        failureKind: "io_error",
        operation,
        targetPath,
        systemCode: status === null ? code || "WSL_COMMAND_FAILED" : `WSL_EXIT_${status}`,
        message: "selected WSL operation failed",
    });
}

export function selectedWslOperationDeadline(startedAt: number, timeoutMilliseconds: number): number {
    const deadline = startedAt + timeoutMilliseconds;
    if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isSafeInteger(deadline)) {
        throw new RangeError("selected WSL operation deadline must remain a non-negative safe integer");
    }
    return deadline;
}
