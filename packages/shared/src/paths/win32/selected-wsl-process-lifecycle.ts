import { execFileSync } from "node:child_process";
import { SafeFilesystemError } from "../../filesystem/filesystem-types";
import { type OwnedInvocationProcessIdentity, validateSelectedWslProcessLifecycleInput } from "../path-environment";
import { isSafeDistroName } from "../wsl-distro-discovery";
import {
    decodeSelectedWslAscii,
    mapSelectedWslCommandError,
    selectedWslOperationDeadline,
} from "./selected-wsl-process-validation";

const OPERATION = "observe_selected_wsl_process";
const MAXIMUM_STAT_BYTES = 16_384;

interface LifecycleDependencies {
    readonly executeFileSync: (
        executable: string,
        arguments_: readonly string[],
        options: {
            readonly timeout: number;
            readonly maxBuffer: number;
            readonly windowsHide: boolean;
            readonly stdio: readonly ["ignore", "pipe", "pipe"];
        },
    ) => Buffer | string;
    readonly now: () => number;
}

/** Exact-PID cleanup observation; deliberately independent of executable matching and process tables. */
export function createWin32SelectedWslProcessLifecycleMechanics(overrides: Partial<LifecycleDependencies> = {}): {
    readonly observeSelectedWslProcessLifecycleBounded: (
        distroName: string,
        processId: number,
        timeoutMilliseconds: number,
    ) => OwnedInvocationProcessIdentity | null;
} {
    const dependencies: LifecycleDependencies = { executeFileSync: execFileSync, now: Date.now, ...overrides };
    return {
        observeSelectedWslProcessLifecycleBounded(distroName, processId, timeoutMilliseconds) {
            if (!isSafeDistroName(distroName)) throw new TypeError("distroName must identify one safe selected WSL distribution");
            validateSelectedWslProcessLifecycleInput(processId, timeoutMilliseconds);
            const deadline = selectedWslOperationDeadline(dependencies.now(), timeoutMilliseconds);
            const runtimePath = `/proc/${processId}/stat`;
            const targetPath = `wsl:${distroName}:${runtimePath}`;
            const read = () => readLifecycle(dependencies, distroName, processId, runtimePath, targetPath, deadline);
            const before = read();
            const after = read();
            if (before !== after) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation: OPERATION,
                    targetPath,
                    systemCode: "WSL_PROCESS_TRANSITION",
                    message: "selected WSL process changed during lifecycle observation",
                });
            }
            return after === null ? null : { processId, lifecycleToken: after };
        },
    };
}

function readLifecycle(
    dependencies: LifecycleDependencies,
    distroName: string,
    processId: number,
    runtimePath: string,
    targetPath: string,
    deadline: number,
): string | null {
    const timeout = deadline - dependencies.now();
    if (timeout <= 0) {
        throw new SafeFilesystemError({
            failureKind: "stale",
            operation: OPERATION,
            targetPath,
            systemCode: "ETIMEDOUT",
            message: "selected WSL process observation exceeded its deadline",
        });
    }
    let output: Buffer;
    try {
        const result = dependencies.executeFileSync(
            "wsl.exe",
            ["-d", distroName, "--exec", "/usr/bin/env", "-i", "LC_ALL=C", "LANG=C", "/bin/cat", "--", runtimePath],
            { timeout, maxBuffer: MAXIMUM_STAT_BYTES + 1, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        output = typeof result === "string" ? Buffer.from(result, "utf8") : result;
    } catch (error) {
        if (isExactMissingStat(error, runtimePath)) return null;
        throw mapSelectedWslCommandError(error, OPERATION, targetPath);
    }
    if (output.byteLength > MAXIMUM_STAT_BYTES) {
        throw new SafeFilesystemError({
            failureKind: "resource_limit",
            operation: OPERATION,
            targetPath,
            systemCode: "OUTPUT_LIMIT",
            message: "selected WSL process observation exceeded its output limit",
        });
    }
    const stat = decodeSelectedWslAscii(output, OPERATION, targetPath).trim();
    const prefix = `${processId} (`;
    const delimiter = stat.lastIndexOf(") ");
    const fields =
        delimiter < prefix.length
            ? []
            : stat
                  .slice(delimiter + 2)
                  .trim()
                  .split(/\s+/u);
    const token = fields[19];
    if (!stat.startsWith(prefix) || !/^[A-Za-z]$/u.test(fields[0] ?? "") || token === undefined || !/^[0-9]+$/u.test(token)) {
        throw new SafeFilesystemError({
            failureKind: "io_error",
            operation: OPERATION,
            targetPath,
            systemCode: "INVALID_PROC_STAT",
            message: "selected WSL process stat lacks its exact PID and lifecycle token",
        });
    }
    return token;
}

/** A missing executable or generic nonzero exit is never proof that this PID is absent. */
function isExactMissingStat(error: unknown, runtimePath: string): boolean {
    if (!(error instanceof Error)) return false;
    const details = error as Error & {
        status?: unknown;
        signal?: unknown;
        killed?: unknown;
        stdout?: unknown;
        stderr?: unknown;
        code?: unknown;
    };
    return (
        details.status === 1 &&
        details.signal === null &&
        details.killed !== true &&
        (details.code === undefined || details.code === null || details.code === 1) &&
        Buffer.isBuffer(details.stdout) &&
        details.stdout.byteLength === 0 &&
        Buffer.isBuffer(details.stderr) &&
        details.stderr.equals(Buffer.from(`/bin/cat: ${runtimePath}: No such file or directory\n`, "ascii"))
    );
}

export const { observeSelectedWslProcessLifecycleBounded } = createWin32SelectedWslProcessLifecycleMechanics();
