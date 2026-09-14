/** Stable bounded capture and comparison for complete managed leaf directories. */

import {
    inventoryDirectoryNoFollow,
    inspectFilesystemFailure,
    readRegularFileNoFollow,
    samePhysicalPathIdentity,
    type PhysicalPathIdentity,
    type StableDirectoryInventory,
    type StableRegularFileRead,
} from "@oaam/shared/filesystem";
import { joinPhysicalAccessPath } from "@oaam/shared/paths";
import type { TargetPlan } from "./deployment-target-plan";
import { compareUtf8Bytes } from "../foundation/text-order";
import { getJournalRuntimeRollbackState, type JournalDirectoryEntry, type JournalEntry } from "./deployment-journal";

export const MAXIMUM_MANAGED_PREVIEW_ENTRIES = 256;
export const MAXIMUM_MANAGED_PREVIEW_BYTES = 4 * 1024 * 1024;

/** Structural parent positions may need creation, without becoming managed content boundaries. */
export function managedDirectoryAncestorPaths(boundaries: readonly string[]): string[] {
    const parents = new Set<string>();
    for (const boundary of boundaries) {
        const segments = boundary.split("/");
        segments.pop();
        let current = "";
        for (const segment of segments) {
            current = current === "" ? segment : `${current}/${segment}`;
            parents.add(current);
        }
    }
    return [...parents].sort(compareUtf8Bytes);
}

export interface CapturedManagedDirectoryGraph {
    files: Array<{ relativePath: string; current: StableRegularFileRead }>;
    directories: Array<{ relativePath: string; identity: PhysicalPathIdentity }>;
}

export function desiredManagedDirectoryPaths(plan: TargetPlan): string[] {
    const desired = new Set<string>();
    for (const boundary of plan.managedDirectoryBoundaries) {
        const paths =
            boundary.desiredDirectoryPaths ??
            desiredDirectoryPathsForBoundaries(
                [boundary],
                plan.targetFiles.map((file) => file.relativePath),
            );
        for (const path of paths) desired.add(path);
    }
    return [...desired].sort(compareUtf8Bytes);
}

export function desiredDirectoryPathsForBoundaries(
    boundaries: readonly { relativePath: string; desiredDirectoryPaths?: readonly string[] }[],
    filePaths: readonly string[],
): string[] {
    const desired = new Set<string>();
    for (const boundary of boundaries) {
        if (boundary.desiredDirectoryPaths !== undefined) {
            for (const relativePath of boundary.desiredDirectoryPaths) desired.add(relativePath);
            continue;
        }
        desired.add(boundary.relativePath);
        for (const filePath of filePaths) {
            if (!filePath.startsWith(`${boundary.relativePath}/`)) continue;
            const suffix = filePath.slice(boundary.relativePath.length + 1).split("/");
            suffix.pop();
            let current = boundary.relativePath;
            for (const segment of suffix) {
                current = `${current}/${segment}`;
                desired.add(current);
            }
        }
    }
    return [...desired].sort(compareUtf8Bytes);
}

export function captureManagedDirectoryGraph(
    targetRootPath: string,
    boundaries: readonly { relativePath: string }[],
    limits: { maximumEntries?: number; maximumBytes?: number } = {},
): CapturedManagedDirectoryGraph {
    const budget = {
        entries: limits.maximumEntries ?? MAXIMUM_MANAGED_PREVIEW_ENTRIES,
        bytes: limits.maximumBytes ?? MAXIMUM_MANAGED_PREVIEW_BYTES,
    };
    const files = new Map<string, StableRegularFileRead>();
    const directories = new Map<string, PhysicalPathIdentity>();
    for (const boundary of boundaries) {
        captureDirectory(targetRootPath, boundary.relativePath, true, budget, files, directories);
    }
    return {
        files: [...files]
            .map(([relativePath, current]) => ({ relativePath, current }))
            .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath)),
        directories: [...directories]
            .map(([relativePath, identity]) => ({ relativePath, identity }))
            .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath)),
    };
}

/** Verify that one captured leaf boundary contains exactly the journal side's
 * files and directories. Content/executable verification remains per-file. */
export function verifyManagedDirectoryGraph(input: {
    targetRootPath: string;
    boundaries: readonly string[];
    files: readonly JournalEntry[];
    directories: readonly JournalDirectoryEntry[];
    side: "old" | "new";
}): boolean {
    if (input.boundaries.length === 0) return true;
    const captured = captureManagedDirectoryGraph(
        input.targetRootPath,
        input.boundaries.map((relativePath) => ({ relativePath })),
    );
    const expectedFiles = input.files
        .filter((entry) => belongsToBoundary(entry.relativePath, input.boundaries))
        .filter((entry) => (input.side === "new" ? !entry.isRemoval : getJournalRuntimeRollbackState(entry).state === "present"))
        .map((entry) => entry.relativePath)
        .sort(compareUtf8Bytes);
    const expectedDirectories = input.directories
        .filter((entry) => belongsToBoundary(entry.relativePath, input.boundaries))
        .filter((entry) => (input.side === "new" ? entry.desiredState === "present" : entry.oldState === "present"))
        .map((entry) => entry.relativePath)
        .sort(compareUtf8Bytes);
    return (
        JSON.stringify(captured.files.map((entry) => entry.relativePath)) === JSON.stringify(expectedFiles) &&
        JSON.stringify(captured.directories.map((entry) => entry.relativePath)) === JSON.stringify(expectedDirectories)
    );
}

function captureDirectory(
    targetRootPath: string,
    relativePath: string,
    allowMissing: boolean,
    budget: { entries: number; bytes: number },
    files: Map<string, StableRegularFileRead>,
    directories: Map<string, PhysicalPathIdentity>,
): void {
    if (budget.entries <= 0) throw new Error("managed target graph exceeds the bounded preview entry limit");
    const absolutePath = joinPhysicalAccessPath(targetRootPath, relativePath);
    let before: StableDirectoryInventory;
    try {
        before = inventoryDirectoryNoFollow(absolutePath, budget.entries);
    } catch (error) {
        if (allowMissing && inspectFilesystemFailure(error).failureKind === "not_found") return;
        throw error;
    }
    budget.entries -= 1;
    if (directories.has(relativePath) || files.has(relativePath)) {
        throw new Error("managed target directory boundaries overlap");
    }
    directories.set(relativePath, before.identity);
    for (const entry of before.entries) {
        const childRelativePath = `${relativePath}/${entry.relativeName}`;
        if (entry.identity.entryKind === "directory") {
            captureDirectory(targetRootPath, childRelativePath, false, budget, files, directories);
            const childIdentity = directories.get(childRelativePath);
            if (childIdentity === undefined || !samePhysicalPathIdentity(childIdentity, entry.identity)) {
                throw new Error("managed target directory identity changed during capture");
            }
            continue;
        }
        if (budget.entries <= 0 || budget.bytes <= 0) {
            throw new Error("managed target graph exceeds its bounded preview limit");
        }
        budget.entries -= 1;
        const current = readRegularFileNoFollow(joinPhysicalAccessPath(targetRootPath, childRelativePath), budget.bytes);
        if (!samePhysicalPathIdentity(current.identity, entry.identity)) {
            throw new Error("managed target file identity changed during capture");
        }
        budget.bytes -= current.bytes.byteLength;
        if (files.has(childRelativePath) || directories.has(childRelativePath)) {
            throw new Error("managed target graph repeats one descendant path");
        }
        files.set(childRelativePath, current);
    }
    const after = inventoryDirectoryNoFollow(absolutePath, before.entries.length);
    if (!sameDirectoryInventory(before, after)) {
        throw new Error("managed target directory changed during capture");
    }
}

function sameDirectoryInventory(left: StableDirectoryInventory, right: StableDirectoryInventory): boolean {
    return (
        samePhysicalPathIdentity(left.identity, right.identity) &&
        left.entries.length === right.entries.length &&
        left.entries.every((entry, index) => {
            const candidate = right.entries[index];
            return (
                candidate !== undefined &&
                candidate.relativeName === entry.relativeName &&
                samePhysicalPathIdentity(candidate.identity, entry.identity)
            );
        })
    );
}

function belongsToBoundary(relativePath: string, boundaries: readonly string[]): boolean {
    return boundaries.some((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`));
}
