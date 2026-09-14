import crypto from "node:crypto";
import * as path from "node:path";
import { samePhysicalPathIdentity } from "../../filesystem/filesystem-facts";
import {
    DurableFilesystemMutationError,
    type DurableMutationState,
    type PhysicalPathIdentity,
    type SafeFilesystemFailureKind,
    type SafeFilesystemOperation,
} from "../../filesystem/filesystem-types";
import type {
    LocalExecutableEnvironmentEntry,
    LocalExecutableTreeInvocationResult,
    LocalProcessExecutableIdentity,
} from "../path-environment";
import type { Win32NativeFilesystemAddon } from "./native-addon";
import { resolveWin32PackagedWorkerPath } from "./packaged-worker-path";

const RECYCLE_WORKER_TIMEOUT_MILLISECONDS = 10_000;
const RECYCLE_WORKER_MAXIMUM_OUTPUT_BYTES = 8 * 1_024;
const FAILURE_KINDS = new Set<SafeFilesystemFailureKind>([
    "invalid_path",
    "not_found",
    "permission_denied",
    "symlink_or_reparse",
    "wrong_entry_type",
    "resource_limit",
    "stale",
    "unsupported_platform",
    "io_error",
]);
const MUTATION_STATES = new Set<DurableMutationState>(["not_applied", "may_have_applied"]);

export interface Win32RecycleWorkerRequest {
    readonly targetPath: string;
    readonly expectedIdentity: PhysicalPathIdentity;
    readonly maximumEntries: number;
}

export type Win32RecycleWorker = (native: Win32NativeFilesystemAddon, request: Win32RecycleWorkerRequest) => boolean;

export interface Win32RecycleWorkerDependencies {
    readonly executablePath: string;
    readonly workerPath: string;
    readonly environmentEntries: readonly LocalExecutableEnvironmentEntry[];
    readonly createInvocationToken: () => string;
}

interface WorkerFailure {
    readonly schemaVersion: 1;
    readonly status: "failed";
    readonly failureKind: SafeFilesystemFailureKind;
    readonly systemCode: string;
    readonly mutationState: DurableMutationState;
    readonly message: string;
}

function uniqueEnvironmentValue(environment: NodeJS.ProcessEnv, firstName: string, secondName: string): string | undefined {
    const first = environment[firstName];
    const second = environment[secondName];
    if (first !== undefined && second !== undefined && first.toLowerCase() !== second.toLowerCase()) {
        throw new TypeError(`${firstName} conflicts with its Windows environment alias`);
    }
    return first ?? second;
}

function trustedWindowsShellRoot(environment: NodeJS.ProcessEnv): { readonly systemRoot: string; readonly systemDrive: string } {
    const systemRoot = uniqueEnvironmentValue(environment, "SystemRoot", "SYSTEMROOT");
    if (
        systemRoot === undefined ||
        systemRoot.length === 0 ||
        systemRoot.trim() !== systemRoot ||
        systemRoot.includes("\0") ||
        !path.win32.isAbsolute(systemRoot) ||
        path.win32.normalize(systemRoot) !== systemRoot
    ) {
        throw new TypeError("Recycle Bin worker requires one canonical SystemRoot");
    }
    const parsed = path.win32.parse(systemRoot);
    if (parsed.root.length !== 3 || path.win32.join(parsed.root, "Windows").toLowerCase() !== systemRoot.toLowerCase()) {
        throw new TypeError("Recycle Bin worker SystemRoot does not identify the Windows directory");
    }
    const windowsDirectory = environment.WINDIR;
    if (
        windowsDirectory !== undefined &&
        (path.win32.normalize(windowsDirectory) !== windowsDirectory ||
            windowsDirectory.toLowerCase() !== systemRoot.toLowerCase())
    ) {
        throw new TypeError("Recycle Bin worker SystemRoot and WINDIR disagree");
    }
    const systemDrive = parsed.root.slice(0, 2);
    const observedSystemDrive = uniqueEnvironmentValue(environment, "SystemDrive", "SYSTEMDRIVE");
    if (
        observedSystemDrive !== undefined &&
        observedSystemDrive.length > 0 &&
        observedSystemDrive.toLowerCase() !== systemDrive.toLowerCase()
    ) {
        throw new TypeError("Recycle Bin worker SystemDrive disagrees with SystemRoot");
    }
    return { systemRoot, systemDrive };
}

/** @internal Exact Windows Shell environment projected into the private Recycle Bin worker. */
export function projectWin32RecycleWorkerEnvironment(
    environment: NodeJS.ProcessEnv,
    electronRunAsNode: boolean,
): LocalExecutableEnvironmentEntry[] {
    const trusted = trustedWindowsShellRoot(environment);
    const entries: LocalExecutableEnvironmentEntry[] = [{ name: "SystemRoot", value: trusted.systemRoot }];
    for (const name of ["WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"] as const) {
        const value = environment[name];
        if (typeof value === "string") entries.push({ name, value });
    }
    entries.push({ name: "SystemDrive", value: trusted.systemDrive });
    if (electronRunAsNode) entries.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
    return entries;
}

function environmentEntries(): LocalExecutableEnvironmentEntry[] {
    return projectWin32RecycleWorkerEnvironment(process.env, process.versions.electron !== undefined);
}

function mutationFailure(
    operation: SafeFilesystemOperation,
    targetPath: string,
    systemCode: string,
    message: string,
    mutationState: DurableMutationState = "may_have_applied",
    failureKind: SafeFilesystemFailureKind = "io_error",
): DurableFilesystemMutationError {
    return new DurableFilesystemMutationError({
        operation,
        failureKind,
        targetPath,
        systemCode,
        message,
        mutationState,
    });
}

function requireExecutableIdentity(
    identity: PhysicalPathIdentity,
    operation: SafeFilesystemOperation,
    targetPath: string,
    label: string,
): LocalProcessExecutableIdentity {
    if (identity.entryKind !== "file") {
        throw mutationFailure(
            operation,
            targetPath,
            "WINDOWS_RECYCLE_WORKER_IDENTITY_INVALID",
            `${label} is not a regular file`,
            "not_applied",
            "wrong_entry_type",
        );
    }
    return {
        deviceId: identity.deviceId,
        fileId: identity.fileId,
        entryKind: "file",
    };
}

function parseJsonRecord(bytes: Uint8Array, label: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
        throw new TypeError(`${label} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError(`${label} must be one JSON object`);
    }
    return parsed as Record<string, unknown>;
}

function parseComplete(result: LocalExecutableTreeInvocationResult): boolean {
    if (result.stderr.byteLength !== 0) throw new TypeError("successful recycle worker wrote stderr");
    const record = parseJsonRecord(result.stdout, "recycle worker result");
    if (
        JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["removed", "schemaVersion", "status"]) ||
        record.schemaVersion !== 1 ||
        record.status !== "complete" ||
        typeof record.removed !== "boolean"
    ) {
        throw new TypeError("recycle worker success does not match the reviewed protocol");
    }
    return record.removed;
}

function parseFailure(result: LocalExecutableTreeInvocationResult): WorkerFailure {
    const record = parseJsonRecord(result.stderr, "recycle worker failure");
    if (
        JSON.stringify(Object.keys(record).sort()) !==
            JSON.stringify(["failureKind", "message", "mutationState", "schemaVersion", "status", "systemCode"]) ||
        record.schemaVersion !== 1 ||
        record.status !== "failed" ||
        typeof record.failureKind !== "string" ||
        !FAILURE_KINDS.has(record.failureKind as SafeFilesystemFailureKind) ||
        typeof record.systemCode !== "string" ||
        record.systemCode.length === 0 ||
        typeof record.mutationState !== "string" ||
        !MUTATION_STATES.has(record.mutationState as DurableMutationState) ||
        typeof record.message !== "string" ||
        record.message.length === 0 ||
        record.message.length > 2_048
    ) {
        throw new TypeError("recycle worker failure does not match the reviewed protocol");
    }
    return record as unknown as WorkerFailure;
}

export function createWin32RecycleWorkerBounded(dependencies: Win32RecycleWorkerDependencies): Win32RecycleWorker {
    return (native, request) => {
        const operation: SafeFilesystemOperation =
            request.expectedIdentity.entryKind === "file" ? "durable_remove_file" : "durable_remove_tree";
        const executablePath = path.win32.resolve(dependencies.executablePath);
        const workerPath = resolveWin32PackagedWorkerPath(path.win32.resolve(dependencies.workerPath));
        const executableIdentity = requireExecutableIdentity(
            native.inspectRegularFile(executablePath),
            operation,
            request.targetPath,
            "Recycle Bin worker executable",
        );
        const workerIdentity = requireExecutableIdentity(
            native.inspectRegularFile(workerPath),
            operation,
            request.targetPath,
            "Recycle Bin worker script",
        );
        const invocationToken = dependencies.createInvocationToken();
        const result = native.invokeLocalExecutableTreeBounded(
            executablePath,
            executableIdentity,
            [
                workerPath,
                request.expectedIdentity.entryKind,
                request.targetPath,
                request.expectedIdentity.deviceId,
                request.expectedIdentity.fileId,
                request.expectedIdentity.entryKind,
                String(request.maximumEntries),
                invocationToken,
            ],
            path.win32.dirname(executablePath),
            dependencies.environmentEntries,
            invocationToken,
            RECYCLE_WORKER_TIMEOUT_MILLISECONDS,
            RECYCLE_WORKER_MAXIMUM_OUTPUT_BYTES,
        );
        const executableIdentityAfter = native.inspectRegularFile(executablePath);
        const workerIdentityAfter = native.inspectRegularFile(workerPath);
        if (
            !samePhysicalPathIdentity(executableIdentity, executableIdentityAfter) ||
            !samePhysicalPathIdentity(workerIdentity, workerIdentityAfter)
        ) {
            throw mutationFailure(
                operation,
                request.targetPath,
                "WINDOWS_RECYCLE_WORKER_IDENTITY_CHANGED",
                "Recycle Bin worker executable or script identity changed during the operation",
            );
        }
        if (!result.cleanupComplete || !result.invocationTokenAbsent) {
            throw mutationFailure(
                operation,
                request.targetPath,
                "WINDOWS_RECYCLE_WORKER_CLEANUP_FAILED",
                "Recycle Bin worker cleanup could not be proven",
            );
        }
        if (result.status === "complete") {
            try {
                return parseComplete(result);
            } catch (error) {
                throw mutationFailure(
                    operation,
                    request.targetPath,
                    "WINDOWS_RECYCLE_WORKER_PROTOCOL_FAILURE",
                    error instanceof Error ? error.message : "Recycle Bin worker returned an invalid result",
                );
            }
        }
        if (result.status === "failed" && result.failureCode === "exit" && result.exitCode === 70) {
            try {
                const failure = parseFailure(result);
                throw mutationFailure(
                    operation,
                    request.targetPath,
                    failure.systemCode,
                    failure.message,
                    failure.mutationState,
                    failure.failureKind,
                );
            } catch (error) {
                if (error instanceof DurableFilesystemMutationError) throw error;
                throw mutationFailure(
                    operation,
                    request.targetPath,
                    "WINDOWS_RECYCLE_WORKER_PROTOCOL_FAILURE",
                    error instanceof Error ? error.message : "Recycle Bin worker returned an invalid failure",
                );
            }
        }
        const systemCode =
            result.status === "timed_out"
                ? "WINDOWS_RECYCLE_WORKER_TIMEOUT"
                : result.status === "cleanup_failed"
                  ? "WINDOWS_RECYCLE_WORKER_CLEANUP_FAILED"
                  : "WINDOWS_RECYCLE_WORKER_FAILED";
        throw mutationFailure(
            operation,
            request.targetPath,
            systemCode,
            "Recycle Bin worker failed within the bounded owned-process authority",
        );
    };
}

export const invokeWin32RecycleWorkerBounded: Win32RecycleWorker = (native, request) =>
    createWin32RecycleWorkerBounded({
        executablePath: process.execPath,
        workerPath: require.resolve("./recycle-bin-worker"),
        environmentEntries: environmentEntries(),
        createInvocationToken: () => crypto.randomBytes(32).toString("hex"),
    })(native, request);
