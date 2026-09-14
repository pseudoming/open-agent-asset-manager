import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryAcquireAuthorityLockLease } from "../../src/foundation/authority-locks";
import {
    acquireAllLocks,
    computeDeploymentOperationKey,
    computePhysicalClosureKeys,
    lockFilePath,
} from "../../src/foundation/physical-path-locks";
import type { UuidV4 } from "../../src/types";

/**
 * Real-process portion of the Stage-R crash matrix.
 *
 * The injected protocol matrix remains in the marker/service/reconcile test
 * suites. This file deliberately claims only what it drives: a child process
 * owns the exact reverse-accept operation and physical lock closure, is killed
 * with SIGKILL, and production acquisition reuses every neutral inode without
 * external relocation or inferring ownership from a timestamp or PID.
 */

const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000009001" as UuidV4;
const ASSET_ID = "00000000-0000-4000-8000-000000009002";
const CHILD_SCRIPT = path.resolve(__dirname, "fixtures/reverse-accept-stale-lock-child.ts");
const VITE_NODE = path.resolve(__dirname, "../../../../node_modules/vite-node/vite-node.mjs");

let root = "";
let transactionsRoot = "";
let authorityLocksRoot = "";
let targetRoot = "";
let child: ChildProcessWithoutNullStreams | undefined;
let ownedBirth: string | null = null;
const closed = new WeakSet<ChildProcessWithoutNullStreams>();
function birth(pid: number): string | null {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    } catch {
        return null;
    }
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-reverse-crash-matrix-"));
    transactionsRoot = path.join(root, "transactions");
    authorityLocksRoot = path.join(root, "authority-locks");
    targetRoot = path.join(root, "target");
    fs.mkdirSync(targetRoot);
});

afterEach(async () => {
    if (child !== undefined) {
        if (child.pid !== undefined && birth(child.pid) === ownedBirth) child.kill("SIGKILL");
        await waitForExit(child);
        expect(birth(child.pid!)).not.toBe(ownedBirth);
    }
    child = undefined;
    fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("reverse-accept real process crash matrix", () => {
    it("reacquires every killed-process authority, operation, and physical lock on the same neutral inode", async () => {
        const signalPath = path.join(root, "locks-acquired.signal");
        const operationKey = computeDeploymentOperationKey(DEPLOYMENT_ID);
        const physicalKeys = computePhysicalClosureKeys(process.platform, targetRoot, [
            { relativePath: "CLAUDE.md", entryKind: "file" },
        ]);
        const keys = [operationKey, ...physicalKeys];

        child = spawn(
            process.execPath,
            [VITE_NODE, CHILD_SCRIPT, transactionsRoot, authorityLocksRoot, targetRoot, DEPLOYMENT_ID, ASSET_ID, signalPath],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        child.once("close", () => closed.add(child!));
        ownedBirth = birth(child.pid!);
        expect(ownedBirth).not.toBeNull();
        const stderr: Buffer[] = [];
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        await waitForSignalOrEarlyExit(child, signalPath, stderr);
        expect(JSON.parse(fs.readFileSync(signalPath, "utf8"))).toEqual({ pid: child.pid, birth: ownedBirth });

        const authorityLockPaths = [
            path.join(authorityLocksRoot, "assets", `${ASSET_ID}.lock`),
            path.join(authorityLocksRoot, "settings", "settings.lock"),
        ];
        const operationAndPhysicalLockPaths = keys.map((key) => lockFilePath(transactionsRoot, key));
        const lockPaths = [...authorityLockPaths, ...operationAndPhysicalLockPaths];
        expect(lockPaths.every((file) => fs.existsSync(file))).toBe(true);
        const identities = lockPaths.map((file) => {
            const stat = fs.statSync(file, { bigint: true });
            return [stat.dev, stat.ino, stat.size];
        });
        expect(acquireAllLocks(transactionsRoot, keys)).toBeNull();
        expect(tryAcquireAuthorityLockLease(authorityLocksRoot, "assets", [ASSET_ID])).toBeNull();
        expect(tryAcquireAuthorityLockLease(authorityLocksRoot, "settings", ["settings"])).toBeNull();
        expect(birth(child.pid!)).toBe(ownedBirth);
        expect(child.kill("SIGKILL")).toBe(true);
        expect(await waitForExit(child)).toEqual({ code: null, signal: "SIGKILL" });

        const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");
        for (const file of lockPaths) fs.utimesSync(file, oldTimestamp, oldTimestamp);
        expect(lockPaths.every((file) => fs.statSync(file).mtimeMs < new Date("2001-01-01T00:00:00.000Z").getTime())).toBe(true);

        const assetLease = tryAcquireAuthorityLockLease(authorityLocksRoot, "assets", [ASSET_ID]);
        expect(assetLease).not.toBeNull();
        const settingsLease = tryAcquireAuthorityLockLease(authorityLocksRoot, "settings", ["settings"]);
        expect(settingsLease).not.toBeNull();
        const reacquired = acquireAllLocks(transactionsRoot, keys);
        expect(reacquired).not.toBeNull();
        reacquired?.release();
        settingsLease?.release();
        assetLease?.release();
        expect(
            lockPaths.map((file) => {
                const stat = fs.statSync(file, { bigint: true });
                return [stat.dev, stat.ino, stat.size];
            }),
        ).toEqual(identities);
    });
});

async function waitForSignalOrEarlyExit(
    running: ChildProcessWithoutNullStreams,
    signalPath: string,
    stderr: Buffer[],
): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(signalPath)) {
        if (running.exitCode !== null || running.signalCode !== null) {
            throw new Error(`stale-lock child exited before kill point: ${Buffer.concat(stderr).toString("utf-8")}`);
        }
        if (Date.now() > deadline) {
            throw new Error(`stale-lock child did not reach kill point: ${Buffer.concat(stderr).toString("utf-8")}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
}

function waitForExit(running: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (closed.has(running)) return Promise.resolve({ code: running.exitCode, signal: running.signalCode });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("owned reverse lock process did not close")), 4_000);
        running.once("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
    });
}
