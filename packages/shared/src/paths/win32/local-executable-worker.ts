import { parentPort, workerData } from "node:worker_threads";
import { SafeFilesystemError } from "../../filesystem/filesystem-types";
import { createWin32LocalExecutableInvocationMechanics } from "./local-executable-invocation";
import type { LocalInvocationArguments } from "./local-executable-worker-client";

async function run(): Promise<void> {
    if (parentPort === null) return;
    try {
        const input = workerData as LocalInvocationArguments;
        const result = await createWin32LocalExecutableInvocationMechanics().invokeLocalExecutableTreeBounded(...input);
        parentPort.postMessage({ kind: "result", result });
    } catch (error) {
        parentPort.postMessage(
            error instanceof SafeFilesystemError
                ? { kind: "error", failureKind: error.failureKind, systemCode: error.systemCode }
                : { kind: "error", failureKind: "io_error", systemCode: "LOCAL_INVOCATION_WORKER_FAILED" },
        );
    } finally {
        parentPort.close();
    }
}

void run();
