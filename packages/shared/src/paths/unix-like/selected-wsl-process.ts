import { SafeFilesystemError, type SafeFilesystemOperation } from "../../filesystem/filesystem-types";
import {
    type OwnedInvocationProcessIdentity,
    validateSelectedWslProcessLifecycleInput,
    validateSelectedWslProcessLifecyclePairInput,
} from "../path-environment";
import { isSafeDistroName } from "../wsl-distro-discovery";

const OBSERVE_OPERATION: SafeFilesystemOperation = "observe_selected_wsl_process";

export function observeSelectedWslProcessLifecycleBounded(
    distroName: string,
    processId: number,
    timeoutMilliseconds: number,
): OwnedInvocationProcessIdentity | null {
    requireInput(distroName);
    validateSelectedWslProcessLifecycleInput(processId, timeoutMilliseconds);
    throw unsupported(OBSERVE_OPERATION, distroName, `/proc/${processId}/stat`);
}

export function observeSelectedWslProcessLifecyclePairBounded(
    distroName: string,
    processIds: readonly [number, number],
    timeoutMilliseconds: number,
): readonly [OwnedInvocationProcessIdentity, OwnedInvocationProcessIdentity] {
    requireInput(distroName);
    validateSelectedWslProcessLifecyclePairInput(processIds, timeoutMilliseconds);
    throw unsupported(OBSERVE_OPERATION, distroName, `/proc/${processIds.join(",")}/stat`);
}

function requireInput(distroName: string): void {
    if (!isSafeDistroName(distroName)) throw new TypeError("distroName must identify one safe selected WSL distribution");
}

function unsupported(operation: SafeFilesystemOperation, distroName: string, runtimeExecutablePath: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "unsupported_platform",
        operation,
        targetPath: `wsl:${distroName}:${runtimeExecutablePath}`,
        systemCode: "UNIX_LIKE_TARGET",
        message: "Windows-hosted selected-WSL process mechanics are unavailable in a Unix-like target build",
    });
}
