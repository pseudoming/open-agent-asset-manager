/** Deployment-owned applied/residual payload pool. No DB mutation occurs here. */

import * as path from "node:path";
import { durableEnsureDirectory, durableRemoveDirectoryTree } from "@oaam/shared/filesystem";
import type { ContentKind, Sha256Digest, UuidV4 } from "../contracts/primitives";
import { readPayload, writePayloadBytes } from "../catalog/payload-store";
import { isSha256Digest, isUuidV4 } from "../foundation/validators";

export interface DeploymentPayloadInput {
    contentKind: ContentKind;
    contentHash: Sha256Digest;
    bytes: Uint8Array;
}

interface DeploymentPayloadPublishHooks {
    afterStaging(): void;
    beforePublish(payload: DeploymentPayloadInput): void;
    beforeCleanup(): void;
}

const NO_HOOKS: DeploymentPayloadPublishHooks = {
    afterStaging: () => undefined,
    beforePublish: () => undefined,
    beforeCleanup: () => undefined,
};

export function publishDeploymentPayloads(input: {
    deploymentsRoot: string;
    deploymentId: UuidV4;
    transactionId: UuidV4;
    payloads: DeploymentPayloadInput[];
}): void {
    publishDeploymentPayloadsCore(input, NO_HOOKS);
}

/** Test-only kill-point seam; production uses publishDeploymentPayloads. */
export function publishDeploymentPayloadsForTest(
    input: {
        deploymentsRoot: string;
        deploymentId: UuidV4;
        transactionId: UuidV4;
        payloads: DeploymentPayloadInput[];
    },
    hooks: Partial<DeploymentPayloadPublishHooks>,
): void {
    publishDeploymentPayloadsCore(input, { ...NO_HOOKS, ...hooks });
}

function publishDeploymentPayloadsCore(
    input: {
        deploymentsRoot: string;
        deploymentId: UuidV4;
        transactionId: UuidV4;
        payloads: DeploymentPayloadInput[];
    },
    hooks: DeploymentPayloadPublishHooks,
): void {
    requireCanonicalDeploymentsRoot(input.deploymentsRoot);
    requireUuid(input.deploymentId, "deploymentId");
    requireUuid(input.transactionId, "transactionId");
    const unique = normalizePayloads(input.payloads);
    durableEnsureDirectory(path.dirname(input.deploymentsRoot), path.basename(input.deploymentsRoot));
    const deploymentRoot = path.join(input.deploymentsRoot, input.deploymentId);
    durableEnsureDirectory(input.deploymentsRoot, input.deploymentId);
    durableEnsureDirectory(deploymentRoot, ".staging");
    const stagingParent = path.join(deploymentRoot, ".staging");
    durableEnsureDirectory(stagingParent, input.transactionId);
    const stagingRoot = path.join(stagingParent, input.transactionId);

    for (const payload of unique) {
        const staged = writePayloadBytes(stagingRoot, payload.bytes);
        if (staged.contentHash !== payload.contentHash) {
            throw new Error("deployment payload declared hash does not match staged bytes");
        }
    }
    hooks.afterStaging();
    for (const payload of unique) {
        hooks.beforePublish(payload);
        const staged = readPayload(stagingRoot, payload.contentHash, payload.bytes.length);
        // readPayload verified the staged digest and writePayloadBytes verifies
        // the published digest; a third equality branch here would duplicate
        // those two authority checks without adding a distinct failure mode.
        writePayloadBytes(deploymentRoot, staged.bytes);
    }
    hooks.beforeCleanup();
    if (!durableRemoveDirectoryTree(stagingRoot)) {
        throw new Error("deployment payload staging root disappeared before cleanup");
    }
}

export function readDeploymentPayload(input: {
    deploymentsRoot: string;
    deploymentId: UuidV4;
    contentHash: Sha256Digest;
    expectedByteSize: number;
}): Uint8Array {
    requireCanonicalDeploymentsRoot(input.deploymentsRoot);
    requireUuid(input.deploymentId, "deploymentId");
    if (!isSha256Digest(input.contentHash)) throw new Error("contentHash must be a SHA-256 digest");
    if (!Number.isInteger(input.expectedByteSize) || input.expectedByteSize < 0) {
        throw new Error("expectedByteSize must be a non-negative integer");
    }
    return readPayload(path.join(input.deploymentsRoot, input.deploymentId), input.contentHash, input.expectedByteSize).bytes;
}

function normalizePayloads(payloads: DeploymentPayloadInput[]): DeploymentPayloadInput[] {
    const byHash = new Map<string, DeploymentPayloadInput>();
    for (const payload of payloads) {
        if (payload.contentKind !== "text" && payload.contentKind !== "binary") {
            throw new Error("deployment payload contentKind is invalid");
        }
        if (!isSha256Digest(payload.contentHash)) {
            throw new Error("deployment payload contentHash must be a SHA-256 digest");
        }
        const previous = byHash.get(payload.contentHash);
        if (previous !== undefined) {
            if (!Buffer.from(previous.bytes).equals(Buffer.from(payload.bytes))) {
                throw new Error("same deployment payload hash names different content");
            }
            continue;
        }
        byHash.set(payload.contentHash, {
            ...payload,
            bytes: new Uint8Array(payload.bytes),
        });
    }
    // Map keys are unique, so equality cannot occur here.
    return [...byHash.values()].sort((left, right) => (left.contentHash < right.contentHash ? -1 : 1));
}

function requireUuid(value: unknown, label: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error(`${label} must be a UUID v4`);
}

function requireCanonicalDeploymentsRoot(root: string): void {
    if (
        root.length === 0 ||
        root.includes("\0") ||
        !path.isAbsolute(root) ||
        path.normalize(root) !== root ||
        root.endsWith(path.sep) ||
        root === path.parse(root).root
    ) {
        throw new Error("deploymentsRoot must be a non-root canonical absolute path");
    }
}
