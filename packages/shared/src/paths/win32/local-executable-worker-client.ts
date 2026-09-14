import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SafeFilesystemError, type SafeFilesystemFailureKind } from "../../filesystem/filesystem-types";
import { type LocalExecutableTreeInvocationResult, validateLocalExecutableTreeInvocationInput } from "../path-environment";
import type { Win32LocalExecutableInvocationMechanics } from "./local-executable-invocation";
import { requireLocalExecutableTreeInvocationResult } from "./native-addon";
import { resolveWin32PackagedWorkerPath } from "./packaged-worker-path";

export type LocalInvocationArguments = Parameters<Win32LocalExecutableInvocationMechanics["invokeLocalExecutableTreeBounded"]>;

interface InvocationWorker {
    on(event: "message", listener: (message: unknown) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "exit", listener: (code: number) => void): this;
    terminate(): Promise<number>;
}

interface InvocationWorkerDependencies {
    readonly createWorker: (input: LocalInvocationArguments) => InvocationWorker;
}

const DEFAULT_DEPENDENCIES: InvocationWorkerDependencies = {
    createWorker: (workerData) =>
        new Worker(resolveWin32PackagedWorkerPath(join(__dirname, "local-executable-worker.js")), { workerData }),
};
const WORKER_CLEANUP_RESERVE_MILLISECONDS = 1_000;
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

/** @internal Isolate the native wait; its Job Object remains the sole process-tree owner. */
export async function invokeLocalExecutableInWorker(
    input: LocalInvocationArguments,
    overrides: Partial<InvocationWorkerDependencies> = {},
): Promise<LocalExecutableTreeInvocationResult> {
    validateLocalExecutableTreeInvocationInput(...input);
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
    const failure = (systemCode: string, failureKind: SafeFilesystemFailureKind = "io_error") =>
        new SafeFilesystemError({
            operation: "invoke_local_executable",
            targetPath: input[0],
            failureKind,
            systemCode,
            message: "bounded local executable worker failed closed",
        });
    let worker: InvocationWorker;
    try {
        worker = dependencies.createWorker(input);
    } catch {
        throw failure("LOCAL_INVOCATION_WORKER_PROTOCOL");
    }
    return new Promise((resolve, reject) => {
        let terminal = false;
        let received = false;
        let result: LocalExecutableTreeInvocationResult | null = null;
        const stop = (error: unknown): void => {
            if (terminal) return;
            terminal = true;
            clearTimeout(timer);
            // terminate waits for the synchronous native frame to unwind and release its owned Job Object.
            void Promise.resolve()
                .then(() => worker.terminate())
                .then(
                    () => reject(error),
                    () => reject(failure("LOCAL_INVOCATION_WORKER_CLEANUP")),
                );
        };
        const timer = setTimeout(() => stop(failure("ETIMEDOUT", "stale")), input[6] + WORKER_CLEANUP_RESERVE_MILLISECONDS);
        worker.on("message", (message) => {
            if (terminal) return;
            if (received) {
                stop(failure("LOCAL_INVOCATION_WORKER_PROTOCOL"));
                return;
            }
            received = true;
            try {
                if (hasExactKeys(message, ["kind", "result"]) && message.kind === "result") {
                    result = requireLocalExecutableTreeInvocationResult(message.result, input[0], input[7]);
                } else if (
                    hasExactKeys(message, ["kind", "failureKind", "systemCode"]) &&
                    message.kind === "error" &&
                    FAILURE_KINDS.has(message.failureKind as SafeFilesystemFailureKind) &&
                    typeof message.systemCode === "string" &&
                    message.systemCode.length > 0 &&
                    message.systemCode.length <= 1_024
                ) {
                    stop(failure(message.systemCode, message.failureKind as SafeFilesystemFailureKind));
                } else {
                    stop(failure("LOCAL_INVOCATION_WORKER_PROTOCOL"));
                }
            } catch (error) {
                stop(error);
            }
        });
        worker.once("error", () => stop(failure("LOCAL_INVOCATION_WORKER_PROTOCOL")));
        worker.once("exit", (code) => {
            if (terminal) return;
            terminal = true;
            clearTimeout(timer);
            if (code === 0 && result !== null) resolve(result);
            else reject(failure("LOCAL_INVOCATION_WORKER_PROTOCOL"));
        });
    });
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === keys.length &&
        keys.every((key) => Object.hasOwn(value, key))
    );
}
