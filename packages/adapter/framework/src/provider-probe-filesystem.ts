/** Bounded physical observations owned by Framework for local Provider execution. */
/** Narrow, read-only physical-file sampling surface for Provider probe evidence. */

import type { Sha256Digest } from "@oaam/core";
import {
    type BoundedDirectoryEntry,
    observeDirectoryMembersBounded,
    inspectDirectoryNoFollow,
    inspectRegularFileNoFollow,
    inventoryDirectoryNoFollow,
    type PhysicalPathIdentity,
    readRegularFileNoFollow,
    readRegularFileRangeNoFollow,
    samePhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import * as crypto from "node:crypto";

export type ProviderPathIdentity = Readonly<PhysicalPathIdentity>;

export interface ProviderDirectoryInventory {
    readonly identity: ProviderPathIdentity;
    readonly entries: readonly {
        readonly relativeName: string;
        readonly identity: ProviderPathIdentity;
    }[];
}

export interface ProviderRegularFileIdentity {
    readonly deviceId: string;
    readonly fileId: string;
    readonly entryKind: "file";
}

export interface ProviderRegularFileSnapshot {
    readonly identity: ProviderRegularFileIdentity;
    readonly sha256: Sha256Digest;
}

export interface ProviderRegularFileRead {
    readonly bytes: Uint8Array;
    readonly executable: boolean;
    readonly identity: ProviderRegularFileIdentity;
}

export interface ProviderRegularFileRangeRead {
    readonly bytes: Uint8Array;
    readonly byteOffset: number;
    readonly totalBytes: number;
    readonly executable: boolean;
    readonly identity: ProviderRegularFileIdentity;
}

export function inspectProviderRegularFileNoFollow(filePath: string): ProviderRegularFileIdentity {
    return inspectRegularFileNoFollow(filePath) as ProviderRegularFileIdentity;
}

export function inspectProviderDirectoryNoFollow(directoryPath: string): ProviderPathIdentity {
    return inspectDirectoryNoFollow(directoryPath);
}

export function inventoryProviderDirectoryNoFollow(directoryPath: string, maximumEntries: number): ProviderDirectoryInventory {
    return inventoryDirectoryNoFollow(directoryPath, maximumEntries);
}

/** Shallow membership observation; not a descriptor-bound or content snapshot. */
export function observeProviderDirectoryMembersBounded(
    directoryPath: string,
    maximumEntries: number,
): readonly BoundedDirectoryEntry[] {
    return observeDirectoryMembersBounded(directoryPath, maximumEntries);
}

export function sameProviderPathIdentity(left: ProviderPathIdentity, right: ProviderPathIdentity): boolean {
    return samePhysicalPathIdentity(left, right);
}

export function readProviderRegularFileNoFollow(filePath: string, maximumBytes: number): ProviderRegularFileRead {
    const read = readRegularFileNoFollow(filePath, maximumBytes);
    return { bytes: read.bytes, executable: read.executable, identity: read.identity as ProviderRegularFileIdentity };
}

export function snapshotProviderRegularFileNoFollow(filePath: string, maximumBytes: number): ProviderRegularFileSnapshot {
    const read = readRegularFileNoFollow(filePath, maximumBytes);
    return {
        identity: read.identity as ProviderRegularFileIdentity,
        sha256: `sha256:${crypto.createHash("sha256").update(read.bytes).digest("hex")}`,
    };
}

export function readProviderRegularFileRangeNoFollow(
    filePath: string,
    byteOffset: number,
    maximumBytes: number,
): ProviderRegularFileRangeRead {
    const read = readRegularFileRangeNoFollow(filePath, byteOffset, maximumBytes);
    return {
        bytes: read.bytes,
        byteOffset: read.byteOffset,
        totalBytes: read.totalBytes,
        executable: read.executable,
        identity: read.identity as ProviderRegularFileIdentity,
    };
}

export function sameProviderRegularFileIdentity(left: ProviderRegularFileIdentity, right: ProviderRegularFileIdentity): boolean {
    return samePhysicalPathIdentity(left as PhysicalPathIdentity, right as PhysicalPathIdentity);
}
