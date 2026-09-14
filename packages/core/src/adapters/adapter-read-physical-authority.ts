/**
 * Core-owned physical filesystem authority for adapter reads.
 *
 * This module owns no-follow identity resolution, physical-path locking and
 * stable-closure comparison. The adapter read facade owns operation sequencing
 * and the externally visible ledger.
 */

import type {
    BoundedRegularFileReadInput,
    PhysicalPathIdentity,
    StableDirectoryInventory,
    StableRegularFileRead,
} from "@oaam/shared/filesystem";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import type { AdapterAssetSourceCapability, ObservedReadEntry, Platform, Sha256Digest } from "../types";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { fingerprintDomain } from "../foundation/fingerprint";
import { joinPhysicalAccessPath, splitPhysicalAccessPath } from "@oaam/shared/paths";
import { computePhysicalAccessClosureKeys } from "../foundation/physical-path-locks";
import { ReadAccessFailure, type AdapterReadOperationLimits } from "./adapter-read-budget";

const PHYSICAL_IDENTITY_DOMAIN = "oaam.read.physical-identity.v1";
const DIRECTORY_INVENTORY_DOMAIN = "oaam.read.directory-inventory.v1";

export interface ReadFilesystem {
    readRegularFileNoFollow(filePath: string, maximumBytes?: number): StableRegularFileRead;
    readRegularFilesNoFollow(inputs: readonly BoundedRegularFileReadInput[], maximumTotalBytes: number): StableRegularFileRead[];
    inventoryDirectoryNoFollow(directoryPath: string, maximumEntries?: number): StableDirectoryInventory;
}

export type LockBatch = (transactionsRoot: string, physicalKeys: string[]) => { release(): void } | null;

export type ReadAuthorityRevalidator = () => boolean;

interface PhysicalReadAuthorityInput {
    platform: Platform;
    transactionsRoot: string;
}

interface PhysicalReadHandle {
    handle: {
        relativePath: string;
        entryKind: "file" | "directory";
    };
    rootPath: string;
    absolutePath: string;
    physicalIdentityFingerprint: Sha256Digest;
}

export function resolveRootIdentity(
    filesystem: ReadFilesystem,
    absolutePath: string,
    mechanism: AdapterAssetSourceCapability["sourcePathMechanism"],
    limits: AdapterReadOperationLimits,
): PhysicalPathIdentity {
    if (mechanism === "fixed_file" || mechanism === "manifest_declared") {
        return filesystem.readRegularFileNoFollow(absolutePath, limits.maxReadBytes).identity;
    }
    if (mechanism === "directory_entry" || mechanism === "recursive_entry") {
        return filesystem.inventoryDirectoryNoFollow(absolutePath, limits.maxIssuedHandles).identity;
    }
    throw new ReadAccessFailure("io_error", "source path mechanism is not readable");
}

export function resolveChildIdentity(
    filesystem: ReadFilesystem,
    absolutePath: string,
    maximumEntries: number,
): PhysicalPathIdentity {
    const { parentPath, name } = splitPhysicalAccessPath(absolutePath);
    const child = filesystem
        .inventoryDirectoryNoFollow(parentPath, maximumEntries)
        .entries.find((entry) => entry.relativeName === name);
    if (child === undefined) {
        throw new ReadAccessFailure("not_found", "source entry was not found");
    }
    return child.identity;
}

export function withPhysicalLock<T>(
    input: PhysicalReadAuthorityInput,
    handle: PhysicalReadHandle,
    lockBatch: LockBatch,
    revalidateAuthority: ReadAuthorityRevalidator,
    operation: () => T,
): T {
    return withPhysicalPathLock(
        input,
        handle.rootPath,
        handle.handle.relativePath,
        lockBatch,
        revalidateAuthority,
        operation,
        handle.handle.entryKind,
    );
}

export function withPhysicalPathLock<T>(
    input: PhysicalReadAuthorityInput,
    rootPath: string,
    relativePath: string,
    lockBatch: LockBatch,
    revalidateAuthority: ReadAuthorityRevalidator,
    operation: () => T,
    entryKind: "file" | "directory" = "file",
): T {
    let lock: { release(): void } | null;
    try {
        lock = lockBatch(
            input.transactionsRoot,
            computePhysicalAccessClosureKeys(input.platform, rootPath, [
                {
                    relativePath,
                    entryKind,
                },
            ]),
        );
    } catch (error) {
        throw new ReadAccessFailure("io_error", `physical lock failed: ${String(error)}`);
    }
    if (lock === null) {
        throw new ReadAccessFailure("busy", "physical source path is busy");
    }
    try {
        requireCurrentAuthority(revalidateAuthority);
        return operation();
    } finally {
        lock.release();
    }
}

export function requireCurrentAuthority(revalidateAuthority: ReadAuthorityRevalidator): void {
    if (!revalidateAuthority()) {
        throw new ReadAccessFailure("stale", "durable managed-target or reservation authority changed before source access");
    }
}

export function requireIdentity(platform: Platform, handle: PhysicalReadHandle, identity: PhysicalPathIdentity): void {
    if (handle.physicalIdentityFingerprint !== physicalIdentityFingerprint(platform, identity)) {
        throw new ReadAccessFailure("stale", "source entry physical identity changed");
    }
}

function stableDirectoryPass(
    filesystem: ReadFilesystem,
    platform: Platform,
    handle: PhysicalReadHandle,
    expected: Extract<ObservedReadEntry, { entryKind: "directory" }>,
    limits: AdapterReadOperationLimits,
): boolean {
    const actual = filesystem.inventoryDirectoryNoFollow(handle.absolutePath, limits.maxIssuedHandles);
    return (
        physicalIdentityFingerprint(platform, actual.identity) === expected.physicalIdentityFingerprint &&
        directoryInventoryFingerprint(expected.sourceRootId, expected.relativePath, platform, actual) ===
            expected.directoryInventoryFingerprint
    );
}

interface StableReadSubject {
    handle: PhysicalReadHandle;
    expected: ObservedReadEntry;
    byteSize: number;
}

interface FileReadSubject extends StableReadSubject {
    expected: Extract<ObservedReadEntry, { entryKind: "file" }>;
}

function recordFileMatches(
    platform: Platform,
    actual: StableRegularFileRead,
    subjects: readonly FileReadSubject[],
    matches: Map<ObservedReadEntry, boolean>,
): void {
    const identityFingerprint = physicalIdentityFingerprint(platform, actual.identity);
    const contentHash = sha256Bytes(actual.bytes);
    for (const { expected } of subjects) {
        matches.set(
            expected,
            identityFingerprint === expected.physicalIdentityFingerprint &&
                contentHash === expected.contentHash &&
                actual.executable === expected.executable,
        );
    }
}

/** One independent closure pass; grouping never survives this invocation or its caller's lock boundary. */
export function stableClosurePass(
    filesystem: ReadFilesystem,
    platform: Platform,
    subjects: readonly StableReadSubject[],
    limits: AdapterReadOperationLimits,
): boolean[] {
    const matches = new Map<ObservedReadEntry, boolean>();
    const filesByPath = new Map<string, FileReadSubject[]>();
    for (const subject of subjects) {
        if (subject.expected.entryKind !== "file") continue;
        const aliases = filesByPath.get(subject.handle.absolutePath) ?? [];
        aliases.push({ ...subject, expected: subject.expected });
        filesByPath.set(subject.handle.absolutePath, aliases);
    }
    const batchMaximumBytes = Math.min(limits.maxReadBytes, 128 * 1_024 * 1_024);
    let batch: FileReadSubject[] = [];
    let retainedBytes = 0;
    const readSingle = (aliases: readonly FileReadSubject[]): void => {
        const actual = filesystem.readRegularFileNoFollow(aliases[0]!.handle.absolutePath, limits.maxReadBytes);
        recordFileMatches(platform, actual, aliases, matches);
    };
    const flush = (): void => {
        if (batch.length === 0) return;
        if (batch.length === 1) {
            readSingle(filesByPath.get(batch[0]!.handle.absolutePath)!);
            batch = [];
            retainedBytes = 0;
            return;
        }
        let reads: StableRegularFileRead[];
        try {
            reads = filesystem.readRegularFilesNoFollow(
                batch.map(({ handle }) => ({ filePath: handle.absolutePath, maximumBytes: limits.maxReadBytes })),
                batchMaximumBytes,
            );
        } catch (error) {
            if (
                !(error instanceof SafeFilesystemError) ||
                error.failureKind !== "resource_limit" ||
                error.systemCode !== "READ_BATCH_CAPACITY"
            )
                throw error;
            for (const subject of batch) readSingle(filesByPath.get(subject.handle.absolutePath)!);
            batch = [];
            retainedBytes = 0;
            return;
        }
        try {
            if (reads.length !== batch.length)
                throw new ReadAccessFailure("io_error", "stable read batch did not cover its exact file set");
            for (const [index, { handle }] of batch.entries()) {
                const actual = reads[index]!;
                recordFileMatches(platform, actual, filesByPath.get(handle.absolutePath)!, matches);
            }
        } finally {
            for (const read of reads) read.bytes.fill(0);
        }
        batch = [];
        retainedBytes = 0;
    };
    for (const aliases of filesByPath.values()) {
        const subject = aliases[0]!;
        // A file above the batch retention cap stays alone: flush uses the
        // original scalar limit for every singleton, including a large file.
        if (batch.length === 64 || retainedBytes + subject.byteSize > batchMaximumBytes) flush();
        batch.push({ ...subject, expected: subject.expected });
        retainedBytes += subject.byteSize;
    }
    flush();
    return subjects.map(({ handle, expected }) =>
        expected.entryKind === "directory"
            ? stableDirectoryPass(filesystem, platform, handle, expected, limits)
            : (matches.get(expected) as boolean),
    );
}

export function physicalIdentityFingerprint(platform: Platform, identity: PhysicalPathIdentity): Sha256Digest {
    return fingerprintDomain(PHYSICAL_IDENTITY_DOMAIN, {
        platform,
        deviceId: identity.deviceId,
        fileId: identity.fileId,
        entryKind: identity.entryKind,
    });
}

export function directoryInventoryFingerprint(
    sourceRootId: string,
    relativePath: string,
    platform: Platform,
    inventory: StableDirectoryInventory,
): Sha256Digest {
    return fingerprintDomain(DIRECTORY_INVENTORY_DOMAIN, {
        sourceRootId,
        relativePath,
        children: inventory.entries.map((entry) => ({
            relativeName: entry.relativeName,
            entryKind: entry.identity.entryKind,
            physicalIdentityFingerprint: physicalIdentityFingerprint(platform, entry.identity),
        })),
    });
}

export function absoluteEntryPath(rootPath: string, relativePath: string): string {
    return joinPhysicalAccessPath(rootPath, relativePath);
}

export function joinRelative(parent: string, child: string): string {
    return parent === "" ? child : `${parent}/${child}`;
}
