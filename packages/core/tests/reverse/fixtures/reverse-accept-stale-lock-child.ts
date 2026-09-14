import * as fs from "node:fs";
import { tryAcquireAuthorityLockLease } from "../../../src/foundation/authority-locks";
import {
    acquireAllLocks,
    computeDeploymentOperationKey,
    computePhysicalClosureKeys,
} from "../../../src/foundation/physical-path-locks";
import type { UuidV4 } from "../../../src/types";

const [, , transactionsRoot, authorityLocksRoot, targetRoot, deploymentId, assetId, signalPath] = process.argv;
if (
    transactionsRoot === undefined ||
    authorityLocksRoot === undefined ||
    targetRoot === undefined ||
    deploymentId === undefined ||
    assetId === undefined ||
    signalPath === undefined
) {
    throw new Error("reverse-accept stale-lock child requires six arguments");
}

const assetAuthorityLease = tryAcquireAuthorityLockLease(authorityLocksRoot, "assets", [assetId]);
if (assetAuthorityLease === null) {
    throw new Error("reverse-accept stale-lock child could not acquire Asset authority lock");
}

const settingsAuthorityLease = tryAcquireAuthorityLockLease(authorityLocksRoot, "settings", ["settings"]);
if (settingsAuthorityLease === null) {
    assetAuthorityLease.release();
    throw new Error("reverse-accept stale-lock child could not acquire settings authority lock");
}

const operationLock = acquireAllLocks(transactionsRoot, [computeDeploymentOperationKey(deploymentId as UuidV4)]);
if (operationLock === null) {
    settingsAuthorityLease.release();
    assetAuthorityLease.release();
    throw new Error("reverse-accept stale-lock child could not acquire operation lock");
}

const physicalKeys = computePhysicalClosureKeys(process.platform, targetRoot, [{ relativePath: "CLAUDE.md", entryKind: "file" }]);
const physicalLocks = acquireAllLocks(transactionsRoot, physicalKeys);
if (physicalLocks === null) {
    operationLock.release();
    settingsAuthorityLease.release();
    assetAuthorityLease.release();
    throw new Error("reverse-accept stale-lock child could not acquire physical locks");
}

const stat = fs.readFileSync("/proc/self/stat", "utf8");
const birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
fs.writeFileSync(signalPath, JSON.stringify({ pid: process.pid, birth }), { flag: "wx" });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
physicalLocks.release();
operationLock.release();
settingsAuthorityLease.release();
assetAuthorityLease.release();
process.exitCode = 124;
