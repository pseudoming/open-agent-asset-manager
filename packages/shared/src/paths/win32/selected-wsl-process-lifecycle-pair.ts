import { execFileSync } from "node:child_process";
import { SafeFilesystemError } from "../../filesystem/filesystem-types";
import { type OwnedInvocationProcessIdentity, validateSelectedWslProcessLifecyclePairInput } from "../path-environment";
import { isSafeDistroName } from "../wsl-distro-discovery";
import {
    decodeSelectedWslAscii,
    mapSelectedWslCommandError,
    selectedWslOperationDeadline,
} from "./selected-wsl-process-validation";

const OPERATION = "observe_selected_wsl_process";
const MAXIMUM_STAT_BYTES = 16_384;
const MAXIMUM_OUTPUT_BYTES = 4 * MAXIMUM_STAT_BYTES;

interface LifecyclePairDependencies {
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

/** Both exact PIDs must exist; absence remains the separate single-PID cleanup observation. */
export function createWin32SelectedWslProcessLifecyclePairMechanics(overrides: Partial<LifecyclePairDependencies> = {}): {
    readonly observeSelectedWslProcessLifecyclePairBounded: (
        distroName: string,
        processIds: readonly [number, number],
        timeoutMilliseconds: number,
    ) => readonly [OwnedInvocationProcessIdentity, OwnedInvocationProcessIdentity];
} {
    const dependencies: LifecyclePairDependencies = { executeFileSync: execFileSync, now: Date.now, ...overrides };
    return {
        observeSelectedWslProcessLifecyclePairBounded(distroName, processIds, timeoutMilliseconds) {
            if (!isSafeDistroName(distroName)) throw new TypeError("distroName must identify one safe selected WSL distribution");
            validateSelectedWslProcessLifecyclePairInput(processIds, timeoutMilliseconds);
            const ids = [processIds[0], processIds[1]] as const;
            const targetPath = `wsl:${distroName}:/proc/${ids.join(",")}/stat`;
            const deadline = selectedWslOperationDeadline(dependencies.now(), timeoutMilliseconds);
            const remaining = deadline - dependencies.now();
            if (remaining <= 0) throw timedOut(targetPath);
            let output: Buffer;
            try {
                const result = dependencies.executeFileSync(
                    "wsl.exe",
                    [
                        "-d",
                        distroName,
                        "--exec",
                        "/usr/bin/env",
                        "-i",
                        "LC_ALL=C",
                        "LANG=C",
                        "/bin/cat",
                        "--",
                        ...ids.flatMap((pid) => [`/proc/${pid}/stat`, `/proc/${pid}/stat`]),
                    ],
                    {
                        timeout: remaining,
                        maxBuffer: MAXIMUM_OUTPUT_BYTES + 1,
                        windowsHide: true,
                        stdio: ["ignore", "pipe", "pipe"],
                    },
                );
                output = typeof result === "string" ? Buffer.from(result) : result;
            } catch (error) {
                throw mapSelectedWslCommandError(error, OPERATION, targetPath);
            }
            if (dependencies.now() >= deadline) throw timedOut(targetPath);
            if (output.byteLength > MAXIMUM_OUTPUT_BYTES) throw outputLimit(targetPath);
            return parsePair(output, ids, targetPath);
        },
    };
}

function parsePair(
    output: Buffer,
    processIds: readonly [number, number],
    targetPath: string,
): readonly [OwnedInvocationProcessIdentity, OwnedInvocationProcessIdentity] {
    let text = decodeSelectedWslAscii(output, OPERATION, targetPath);
    if (!Buffer.from(text, "utf8").equals(output)) throw invalidStat(targetPath);
    const observations: OwnedInvocationProcessIdentity[] = [];
    for (const processId of processIds.flatMap((pid) => [pid, pid])) {
        // Linux comm is at most 15 bytes and may contain parentheses or newlines.
        // A complete numeric tail through starttime cannot fit inside comm, so this
        // boundary does not mistake a name's newline or ") S 0" text for a record.
        const match = /^([1-9][0-9]*) \(([\s\S]{0,15})\) ([A-Za-z])((?: +[+-]?[0-9]+){19,})\n/u.exec(text);
        if (match === null) throw invalidStat(targetPath);
        const token = match[4]!.trim().split(/ +/u)[18]!;
        if (Number(match[1]) !== processId || Buffer.byteLength(match[2]!, "utf8") > 15 || !/^[0-9]+$/u.test(token))
            throw invalidStat(targetPath);
        if (Buffer.byteLength(match[0], "utf8") > MAXIMUM_STAT_BYTES) throw outputLimit(targetPath);
        observations.push({ processId, lifecycleToken: token });
        text = text.slice(match[0].length);
    }
    if (text.length !== 0) throw invalidStat(targetPath);
    if (
        observations[0]!.lifecycleToken !== observations[1]!.lifecycleToken ||
        observations[2]!.lifecycleToken !== observations[3]!.lifecycleToken
    ) {
        throw new SafeFilesystemError({
            failureKind: "stale",
            operation: OPERATION,
            targetPath,
            systemCode: "WSL_PROCESS_TRANSITION",
            message: "selected WSL process changed during lifecycle observation",
        });
    }
    return [observations[1]!, observations[3]!];
}

function invalidStat(targetPath: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "io_error",
        operation: OPERATION,
        targetPath,
        systemCode: "INVALID_PROC_STAT",
        message: "selected WSL process pair lacks four complete ordered stat observations",
    });
}

function outputLimit(targetPath: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "resource_limit",
        operation: OPERATION,
        targetPath,
        systemCode: "OUTPUT_LIMIT",
        message: "selected WSL process observation exceeded its output limit",
    });
}

function timedOut(targetPath: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "stale",
        operation: OPERATION,
        targetPath,
        systemCode: "ETIMEDOUT",
        message: "selected WSL process observation exceeded its deadline",
    });
}

export const { observeSelectedWslProcessLifecyclePairBounded } = createWin32SelectedWslProcessLifecyclePairMechanics();
