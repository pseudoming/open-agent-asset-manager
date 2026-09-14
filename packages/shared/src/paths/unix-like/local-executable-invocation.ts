import * as childProcess from "node:child_process";
import fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
    type LocalExecutableEnvironmentEntry,
    type LocalExecutableTreeInvocationResult,
    type LocalProcessExecutableIdentity,
    type OwnedInvocationProcessIdentity,
    validateLocalExecutableTreeInvocationInput,
} from "../path-environment";
import { observeLocalProcessExecutableBounded } from "./process-observation";

const INVOCATION_TOKEN_NAME = "OAAM_INVOCATION_TOKEN";
const PROCESS_SCAN_INTERVAL_MILLISECONDS = 10;
const TERMINATION_GRACE_MILLISECONDS = 200;
const MAXIMUM_PROC_FILE_BYTES = 256 * 1_024;
const MAXIMUM_PROCESSES = 65_536;

interface ProcessFact extends OwnedInvocationProcessIdentity {
    readonly parentProcessId: number;
    readonly carriesInvocationToken: boolean;
}

interface InvocationState {
    readonly observed: Map<number, OwnedInvocationProcessIdentity>;
    readonly stdout: Buffer[];
    readonly stderr: Buffer[];
    outputBytes: number;
    outputLimitExceeded: boolean;
    scanFailed: boolean;
}

export async function invokeLocalExecutableTreeBounded(
    executablePath: string,
    expectedExecutableIdentity: LocalProcessExecutableIdentity,
    arguments_: readonly string[],
    workingDirectory: string,
    environmentEntries: readonly LocalExecutableEnvironmentEntry[],
    invocationToken: string,
    timeoutMilliseconds: number,
    maximumOutputBytes: number,
): Promise<LocalExecutableTreeInvocationResult> {
    validateLocalExecutableTreeInvocationInput(
        executablePath,
        expectedExecutableIdentity,
        arguments_,
        workingDirectory,
        environmentEntries,
        invocationToken,
        timeoutMilliseconds,
        maximumOutputBytes,
    );
    const environment = Object.fromEntries(environmentEntries.map((entry) => [entry.name, entry.value]));
    environment[INVOCATION_TOKEN_NAME] = invocationToken;
    const child = childProcess.spawn(executablePath, [...arguments_], {
        cwd: workingDirectory,
        env: environment,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const state: InvocationState = {
        observed: new Map(),
        stdout: [],
        stderr: [],
        outputBytes: 0,
        outputLimitExceeded: false,
        scanFailed: false,
    };
    captureOutput(child.stdout, state, state.stdout, maximumOutputBytes);
    captureOutput(child.stderr, state, state.stderr, maximumOutputBytes);

    const spawned = await waitForSpawn(child);
    if (!spawned || child.pid === undefined) {
        return result(state, "failed", null, null, null, true, true, "spawn_failed");
    }
    const rootProcess = observeRoot(child.pid, executablePath, expectedExecutableIdentity);
    if (rootProcess === null) {
        await terminateOwnedInvocation(child, null, state, invocationToken);
        return result(
            state,
            "failed",
            null,
            null,
            null,
            ownedInvocationAbsent(state, invocationToken),
            tokenAbsent(invocationToken),
            "root_identity_unavailable",
        );
    }
    state.observed.set(rootProcess.processId, rootProcess);
    observeInvocation(state, rootProcess.processId, invocationToken);

    let timedOut = false;
    let exitCode: number | null = null;
    let signal: string | null = null;
    const scanTimer = setInterval(() => {
        try {
            observeInvocation(state, rootProcess.processId, invocationToken);
        } catch {
            state.scanFailed = true;
        }
    }, PROCESS_SCAN_INTERVAL_MILLISECONDS);
    const timeout = setTimeout(() => {
        timedOut = true;
        void terminateOwnedInvocation(child, rootProcess, state, invocationToken);
    }, timeoutMilliseconds);
    try {
        const closed = await waitForClose(child);
        exitCode = closed.exitCode;
        signal = closed.signal;
    } finally {
        clearInterval(scanTimer);
        clearTimeout(timeout);
    }
    try {
        observeInvocation(state, rootProcess.processId, invocationToken);
    } catch {
        state.scanFailed = true;
    }

    const treeAbsentAfterExit = ownedInvocationAbsent(state, invocationToken);
    const tokenAbsentAfterExit = tokenAbsent(invocationToken);
    const residualAfterExit = !treeAbsentAfterExit || !tokenAbsentAfterExit;
    const naturalSuccess = !timedOut && !state.outputLimitExceeded && !state.scanFailed && exitCode === 0;
    if (!naturalSuccess || residualAfterExit) {
        await terminateOwnedInvocation(child, rootProcess, state, invocationToken);
    }
    const cleanupComplete = ownedInvocationAbsent(state, invocationToken);
    const invocationTokenAbsent = tokenAbsent(invocationToken);
    if (!cleanupComplete || !invocationTokenAbsent) {
        return result(
            state,
            "cleanup_failed",
            exitCode,
            signal,
            rootProcess,
            cleanupComplete,
            invocationTokenAbsent,
            "process_tree_remains",
        );
    }
    if (timedOut) {
        return result(state, "timed_out", exitCode, signal, rootProcess, true, true, "timeout");
    }
    if (state.outputLimitExceeded) {
        return result(state, "failed", exitCode, signal, rootProcess, true, true, "output_limit");
    }
    if (state.scanFailed) {
        return result(state, "failed", exitCode, signal, rootProcess, true, true, "process_observation_failed");
    }
    if (residualAfterExit) {
        return result(state, "failed", exitCode, signal, rootProcess, true, true, "residual_process");
    }
    if (exitCode !== 0) {
        return result(state, "failed", exitCode, signal, rootProcess, true, true, "exit");
    }
    return result(state, "complete", exitCode, signal, rootProcess, true, true, "");
}

function captureOutput(
    stream: NodeJS.ReadableStream,
    state: InvocationState,
    destination: Buffer[],
    maximumOutputBytes: number,
): void {
    stream.on("data", (value: unknown) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
        state.outputBytes += bytes.byteLength;
        if (state.outputBytes > maximumOutputBytes) {
            state.outputLimitExceeded = true;
            return;
        }
        destination.push(bytes);
    });
}

function waitForSpawn(child: childProcess.ChildProcess): Promise<boolean> {
    if (child.pid !== undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
        child.once("spawn", () => resolve(true));
        child.once("error", () => resolve(false));
    });
}

function waitForClose(child: childProcess.ChildProcess): Promise<{ exitCode: number | null; signal: string | null }> {
    return new Promise((resolve) => {
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
        child.once("error", () => resolve({ exitCode: null, signal: null }));
    });
}

function observeRoot(
    processId: number,
    executablePath: string,
    expectedExecutableIdentity: LocalProcessExecutableIdentity,
): OwnedInvocationProcessIdentity | null {
    try {
        const observation = observeLocalProcessExecutableBounded(
            processId,
            executablePath,
            expectedExecutableIdentity,
            64 * 1_024,
        );
        return observation === null ? null : { processId: observation.processId, lifecycleToken: observation.lifecycleToken };
    } catch {
        return null;
    }
}

function observeInvocation(state: InvocationState, rootProcessId: number, invocationToken: string): void {
    const facts = readProcessFacts(invocationToken);
    const owned = new Set<number>([rootProcessId, ...state.observed.keys()]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const fact of facts) {
            if ((fact.carriesInvocationToken || owned.has(fact.parentProcessId)) && !owned.has(fact.processId)) {
                owned.add(fact.processId);
                changed = true;
            }
        }
    }
    for (const fact of facts) {
        if (!owned.has(fact.processId)) continue;
        const previous = state.observed.get(fact.processId);
        if (previous !== undefined && previous.lifecycleToken !== fact.lifecycleToken) {
            continue;
        }
        state.observed.set(fact.processId, {
            processId: fact.processId,
            lifecycleToken: fact.lifecycleToken,
        });
    }
}

function readProcessFacts(invocationToken: string): ProcessFact[] {
    const entries = fs.readdirSync("/proc").filter((entryName) => /^[1-9][0-9]*$/u.test(entryName));
    if (entries.length > MAXIMUM_PROCESSES) throw new RangeError("process inventory exceeds the reviewed bound");
    const facts: ProcessFact[] = [];
    for (const entryName of entries) {
        const processId = Number(entryName);
        const stat = readProcFileBounded(`/proc/${entryName}/stat`, 16 * 1_024);
        if (stat === null) continue;
        const parsed = parseProcStat(processId, stat.toString("utf8"));
        if (parsed === null) continue;
        const environment = readProcFileBounded(`/proc/${entryName}/environ`, MAXIMUM_PROC_FILE_BYTES);
        facts.push({
            ...parsed,
            carriesInvocationToken:
                environment !== null && environmentContains(environment, INVOCATION_TOKEN_NAME, invocationToken),
        });
    }
    return facts;
}

function readProcFileBounded(filePath: string, maximumBytes: number): Buffer | null {
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const bytes = Buffer.alloc(maximumBytes + 1);
        const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
        if (count > maximumBytes) throw new RangeError("proc record exceeds the reviewed bound");
        return bytes.subarray(0, count);
    } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
        if (["EACCES", "ENOENT", "EPERM", "ESRCH"].includes(code)) return null;
        throw error;
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
    }
}

function parseProcStat(processId: number, value: string): ProcessFact | null {
    const closingDelimiter = value.lastIndexOf(") ");
    if (!value.startsWith(`${processId} (`) || closingDelimiter < 1) return null;
    const fields = value
        .slice(closingDelimiter + 2)
        .trim()
        .split(/\s+/u);
    const parentProcessId = Number(fields[1]);
    const lifecycleToken = fields[19];
    if (!Number.isSafeInteger(parentProcessId) || parentProcessId < 0 || !/^[0-9]+$/u.test(lifecycleToken ?? "")) {
        return null;
    }
    return {
        processId,
        parentProcessId,
        lifecycleToken: lifecycleToken as string,
        carriesInvocationToken: false,
    };
}

function environmentContains(bytes: Uint8Array, name: string, value: string): boolean {
    const expected = `${name}=${value}`;
    return Buffer.from(bytes).toString("utf8").split("\0").includes(expected);
}

async function terminateOwnedInvocation(
    child: childProcess.ChildProcess,
    root: OwnedInvocationProcessIdentity | null,
    state: InvocationState,
    invocationToken: string,
): Promise<void> {
    if (root !== null && sameLifecycle(root)) {
        try {
            process.kill(-root.processId, "SIGTERM");
        } catch {
            // The process group may already be gone.
        }
    } else {
        child.kill("SIGTERM");
    }
    signalExactObserved(state.observed.values(), "SIGTERM");
    await delay(TERMINATION_GRACE_MILLISECONDS);
    try {
        observeInvocation(state, root?.processId ?? -1, invocationToken);
    } catch {
        state.scanFailed = true;
    }
    signalExactObserved(state.observed.values(), "SIGKILL");
    await delay(TERMINATION_GRACE_MILLISECONDS);
}

function signalExactObserved(processes: Iterable<OwnedInvocationProcessIdentity>, signal: NodeJS.Signals): void {
    for (const processIdentity of processes) {
        if (!sameLifecycle(processIdentity)) continue;
        try {
            process.kill(processIdentity.processId, signal);
        } catch {
            // A process that disappeared after revalidation is already clean.
        }
    }
}

function sameLifecycle(identity: OwnedInvocationProcessIdentity): boolean {
    const stat = readProcFileBounded(`/proc/${identity.processId}/stat`, 16 * 1_024);
    const parsed = stat === null ? null : parseProcStat(identity.processId, stat.toString("utf8"));
    return parsed?.lifecycleToken === identity.lifecycleToken;
}

function ownedInvocationAbsent(state: InvocationState, invocationToken: string): boolean {
    if ([...state.observed.values()].some(sameLifecycle)) return false;
    return tokenAbsent(invocationToken);
}

function tokenAbsent(invocationToken: string): boolean {
    return !readProcessFacts(invocationToken).some((fact) => fact.carriesInvocationToken);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function result(
    state: InvocationState,
    status: LocalExecutableTreeInvocationResult["status"],
    exitCode: number | null,
    signal: string | null,
    rootProcess: OwnedInvocationProcessIdentity | null,
    cleanupComplete: boolean,
    invocationTokenAbsent: boolean,
    failureCode: string,
): LocalExecutableTreeInvocationResult {
    const retainNaturalExitStderr =
        status === "failed" &&
        failureCode === "exit" &&
        exitCode !== null &&
        exitCode !== 0 &&
        signal === null &&
        cleanupComplete &&
        invocationTokenAbsent;
    return {
        status,
        exitCode,
        signal,
        stdout: status === "complete" ? new Uint8Array(Buffer.concat(state.stdout)) : new Uint8Array(),
        stderr: status === "complete" || retainNaturalExitStderr ? new Uint8Array(Buffer.concat(state.stderr)) : new Uint8Array(),
        rootProcess,
        observedProcesses: [...state.observed.values()].sort((left, right) => left.processId - right.processId),
        cleanupComplete,
        invocationTokenAbsent,
        failureCode,
    };
}
