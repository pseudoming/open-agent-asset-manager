import { createHash } from "node:crypto";
import { posix, type win32 } from "node:path";
import { performance } from "node:perf_hooks";
import {
    inspectDirectoryNoFollow,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
    samePhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import type { RestrictedArtifactManifest } from "./restricted-artifact-package";

export interface RestrictedCodeVerificationTiming {
    readonly totalMilliseconds: number;
    readonly directoryMilliseconds: number;
    /** Includes descriptor/path and metadata work inside the stable-read owner. */
    readonly stableReadMilliseconds: number;
    readonly hashMilliseconds: number;
    readonly fileCount: number;
    readonly byteCount: number;
}

export class RestrictedCodePackageError extends Error {
    public constructor(
        public readonly code: "digest_mismatch" | "metadata_changed",
        public readonly relativePath: string,
    ) {
        super(`restricted code package ${code}`);
    }
}

/** The selected Shared build performs all physical reads on its own filesystem. */
export function verifyRestrictedCodeInventory(
    rootPath: string,
    manifest: RestrictedArtifactManifest,
    paths: typeof posix | typeof win32,
    requireExecutable: boolean,
): RestrictedCodeVerificationTiming {
    const started = performance.now();
    let directoryMilliseconds = 0;
    let stableReadMilliseconds = 0;
    let hashMilliseconds = 0;
    let byteCount = 0;
    const rootStarted = performance.now();
    const rootIdentity = inspectDirectoryNoFollow(rootPath);
    directoryMilliseconds += performance.now() - rootStarted;
    const files = new Map(manifest.files.map((file) => [file.relativePath, file]));
    const directories = new Set<string>([""]);
    for (const file of files.keys()) {
        let directory = posix.dirname(file);
        while (directory !== ".") {
            directories.add(directory);
            directory = posix.dirname(directory);
        }
    }
    const seen = new Set<string>();
    for (const directory of directories) {
        const inventoryStarted = performance.now();
        const inventory = inventoryDirectoryNoFollow(paths.join(rootPath, directory), 256);
        directoryMilliseconds += performance.now() - inventoryStarted;
        for (const entry of inventory.entries) {
            const relative = posix.join(directory, entry.relativeName);
            if (entry.identity.entryKind === "directory" && directories.has(relative)) continue;
            const expected = files.get(relative);
            if (entry.identity.entryKind !== "file" || expected === undefined || seen.has(relative))
                throw new Error("restricted code package has an unexpected entry");
            const readStarted = performance.now();
            const observed = readRegularFileNoFollow(paths.join(rootPath, relative), expected.bytes);
            stableReadMilliseconds += performance.now() - readStarted;
            if (
                !samePhysicalPathIdentity(entry.identity, observed.identity) ||
                observed.bytes.byteLength !== expected.bytes ||
                (requireExecutable && expected.executable && !observed.executable)
            )
                throw new RestrictedCodePackageError("metadata_changed", relative);
            const hashStarted = performance.now();
            const digest = createHash("sha256").update(observed.bytes).digest("hex");
            hashMilliseconds += performance.now() - hashStarted;
            if (digest !== expected.sha256) throw new RestrictedCodePackageError("digest_mismatch", relative);
            byteCount += observed.bytes.byteLength;
            seen.add(relative);
        }
    }
    const finalStarted = performance.now();
    const finalIdentity = inspectDirectoryNoFollow(rootPath);
    directoryMilliseconds += performance.now() - finalStarted;
    if (seen.size !== files.size || !samePhysicalPathIdentity(rootIdentity, finalIdentity))
        throw new Error("restricted code package root or complete inventory changed");
    return Object.freeze({
        totalMilliseconds: performance.now() - started,
        directoryMilliseconds,
        stableReadMilliseconds,
        hashMilliseconds,
        fileCount: seen.size,
        byteCount,
    });
}
