import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDeploymentCommitReceipt } from "../../src/deployment/deployment-commit-receipts";
import {
    prepareDeploymentSuccessAuthority,
    readCanonicalDeploymentPreCommitDatabaseState,
    readDeploymentSuccessPostcondition,
} from "../../src/deployment/deployment-state-authority";
import type { CommitReverseAcceptSuccessCrashDurableInput } from "../../src/deployment/deployment-state-authority";
import {
    DEPLOYMENT_ID,
    TRANSACTION_ID,
    initializeStateDatabase,
    makeSuccessInput,
    seedDeployment,
    textPlan,
} from "./fixtures/reverse-accept-db-fixtures";

/**
 * Real SQLite subprocess tests. They prove SIGKILL/reopen behavior at the
 * transaction COMMIT boundary; they do not claim to simulate physical power
 * loss. Protocol-only fault injection is kept in the marker/service/reconcile
 * suites and is named separately there.
 */

const CHILD_SCRIPT = path.resolve(__dirname, "fixtures/reverse-accept-db-crash-child.ts");
const VITE_NODE = path.resolve(__dirname, "../../../../node_modules/vite-node/vite-node.mjs");

let root: string;
let databasePath: string;
let child: ChildProcessWithoutNullStreams | undefined;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-reverse-db-crash-"));
    databasePath = path.join(root, "state.db");
    initializeStateDatabase(databasePath);
    seedDeployment(databasePath);
});

afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
    }
    child = undefined;
    fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("reverse-accept database crash durability", () => {
    it("a real process death before COMMIT reopens the exact pre-state with no receipt", async () => {
        const input = makeCommitInput();
        const before = readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID);

        await runUntilKillPoint(input, "before_commit");

        expect(readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID)).toEqual(before);
        expect(readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({ receiptState: "missing" });
    });

    it("a real process death after COMMIT reopens the exact receipt and success state", async () => {
        const input = makeCommitInput();

        await runUntilKillPoint(input, "after_commit");

        expect(readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({
            receiptState: "available",
            receipt: input.preparedAuthority.commitReceipt,
        });
        expect(readDeploymentSuccessPostcondition(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual(
            input.preparedAuthority.expectedSuccessPostcondition,
        );
    });
});

function makeCommitInput(): CommitReverseAcceptSuccessCrashDurableInput {
    const successCommit = makeSuccessInput(textPlan("crash.md", "# durable"));
    return {
        databasePath,
        successCommit,
        preparedAuthority: prepareDeploymentSuccessAuthority(databasePath, successCommit),
    };
}

async function runUntilKillPoint(
    input: CommitReverseAcceptSuccessCrashDurableInput,
    killPoint: "before_commit" | "after_commit",
): Promise<void> {
    const inputPath = path.join(root, `${killPoint}.json`);
    const signalPath = path.join(root, `${killPoint}.signal`);
    fs.writeFileSync(inputPath, JSON.stringify(input), { flag: "wx" });
    child = spawn(process.execPath, [VITE_NODE, CHILD_SCRIPT, inputPath, signalPath, killPoint], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    await waitForSignalOrEarlyExit(child, signalPath, stderr);
    expect(child.kill("SIGKILL")).toBe(true);
    const result = await waitForExit(child);
    expect(result).toEqual({ code: null, signal: "SIGKILL" });
}

async function waitForSignalOrEarlyExit(
    running: ChildProcessWithoutNullStreams,
    signalPath: string,
    stderr: Buffer[],
): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(signalPath)) {
        if (running.exitCode !== null || running.signalCode !== null) {
            throw new Error(`crash child exited before kill point: ${Buffer.concat(stderr).toString("utf-8")}`);
        }
        if (Date.now() > deadline) {
            throw new Error(`crash child did not reach kill point: ${Buffer.concat(stderr).toString("utf-8")}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
}

function waitForExit(running: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (running.exitCode !== null || running.signalCode !== null) {
        return Promise.resolve({ code: running.exitCode, signal: running.signalCode });
    }
    return new Promise((resolve) => {
        running.once("exit", (code, signal) => resolve({ code, signal }));
    });
}
