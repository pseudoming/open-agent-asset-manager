/**
 * Action-time validation for an explicitly approved runtime replacement.
 *
 * A schema-3 preview confirms the desired Version and exact complete physical
 * replacement scope. Under the target locks, that scope captures the actual
 * operation-start state as the recovery old side, including later in-scope edits.
 * Protected paths outside that scope and legacy repair authorities still require
 * their exact reviewed current state. Recovery therefore retains the actual
 * approved pre-operation bytes rather than substituting an older OAAM baseline.
 */

import type { JournalEntry } from "./deployment-journal";
import { bytesToBase64, sha256Bytes } from "../foundation/crypto-bytes";
import { samePhysicalPathIdentity, type PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { captureManagedDirectoryGraph, desiredDirectoryPathsForBoundaries } from "./deployment-managed-directory-graph";
import { absPath, ioReadStableIfPresent, type TargetIoContext } from "./deployment-target-io";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isCompleteReplacementPath, type CompleteReplacementScope } from "./deployment-publication-model";

export interface DeploymentRuntimeReplacementAuthorityV1 {
    /** Present only for a schema-3 desired-target confirmation, never a historical inspection token. */
    replacementScope?: CompleteReplacementScope;
    files: (
        | { relativePath: string; expectedState: "missing" }
        | {
              relativePath: string;
              expectedState: "present";
              expectedBytes: Uint8Array;
              expectedExecutable: boolean;
              /** Required for a descendant of a complete managed-directory
               * boundary; retained as optional only for legacy single-file
               * repair authorities outside a directory graph. */
              expectedIdentity?: PhysicalPathIdentity;
          }
    )[];
    directories: (
        | { relativePath: string; expectedState: "missing" }
        | { relativePath: string; expectedState: "present"; expectedIdentity: PhysicalPathIdentity }
    )[];
    /** Union of desired and prior managed leaf boundaries reviewed now. */
    managedDirectoryBoundaryPaths: string[];
    /** Exact subset emitted by the current compiled target plan. */
    desiredManagedDirectoryBoundaryPaths: string[];
    unmanagedRemovalPaths: string[];
    /** Exact reviewed current directories absent from the desired leaf graph,
     * whether they were part of the prior managed graph or newly unmanaged. */
    directoryRemovalPaths: string[];
}

export type RuntimeReplacementResult = { status: "applied" } | { status: "conflict"; reason: string };

export function applyRuntimeReplacementAuthority(
    entries: JournalEntry[],
    ctx: TargetIoContext,
    authority: DeploymentRuntimeReplacementAuthorityV1,
    exactDesiredDirectoryPaths: readonly string[],
): RuntimeReplacementResult {
    if (authority.replacementScope !== undefined)
        return applyCompleteReplacement(entries, ctx, authority, exactDesiredDirectoryPaths);
    const expected = [...authority.files].sort((left, right) =>
        Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
    );
    const entryPaths = entries
        .map((entry) => entry.relativePath)
        .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    const expectedPaths = expected.map((file) => file.relativePath);
    if (new Set(expectedPaths).size !== expectedPaths.length || JSON.stringify(expectedPaths) !== JSON.stringify(entryPaths)) {
        return conflict("runtime replacement authority does not cover the exact target closure");
    }

    const boundaryPaths = sortedUnique(authority.managedDirectoryBoundaryPaths ?? []);
    const desiredBoundaryPaths = sortedUnique(authority.desiredManagedDirectoryBoundaryPaths ?? []);
    const directories = authority.directories ?? [];
    const unmanagedRemovalPaths = authority.unmanagedRemovalPaths ?? [];
    const directoryRemovalPaths = authority.directoryRemovalPaths ?? [];
    const directoryPaths = directories.map((entry) => entry.relativePath);
    if (
        boundaryPaths === null ||
        desiredBoundaryPaths === null ||
        desiredBoundaryPaths.some((boundary) => !boundaryPaths.includes(boundary)) ||
        sortedUnique(directoryPaths) === null ||
        sortedUnique(unmanagedRemovalPaths) === null ||
        sortedUnique(directoryRemovalPaths) === null
    ) {
        return conflict("runtime replacement directory authority is not canonical");
    }
    const minimumDesiredDirectoryPaths = desiredDirectoryPathsForBoundaries(
        desiredBoundaryPaths.map((relativePath) => ({ relativePath })),
        entries.filter((entry) => !entry.isRemoval).map((entry) => entry.relativePath),
    );
    const desiredDirectoryPaths = sortedUnique(exactDesiredDirectoryPaths);
    if (
        desiredDirectoryPaths === null ||
        minimumDesiredDirectoryPaths.some((relativePath) => !desiredDirectoryPaths.includes(relativePath)) ||
        desiredDirectoryPaths.some(
            (relativePath) =>
                !desiredBoundaryPaths.some((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`)),
        )
    ) {
        return conflict("runtime replacement desired directory authority is not canonical");
    }
    let graph: ReturnType<typeof captureManagedDirectoryGraph>;
    try {
        graph = captureManagedDirectoryGraph(
            ctx.targetRootPath,
            boundaryPaths.map((relativePath) => ({ relativePath })),
        );
    } catch {
        return conflict("runtime managed-directory graph could not be rechecked");
    }
    const exactDirectoryPaths = [
        ...new Set([...desiredDirectoryPaths, ...graph.directories.map((entry) => entry.relativePath)]),
    ].sort(compareUtf8Bytes);
    if (JSON.stringify(directoryPaths) !== JSON.stringify(exactDirectoryPaths)) {
        return conflict("runtime replacement authority does not cover the exact managed-directory closure");
    }
    const desiredDirectoryPathSet = new Set(desiredDirectoryPaths);
    const currentDirectoryPathSet = new Set(graph.directories.map((entry) => entry.relativePath));
    for (const directory of directories) {
        if ((directory.expectedState === "present") !== currentDirectoryPathSet.has(directory.relativePath)) {
            return changed(directory.relativePath);
        }
    }
    const expectedDirectoryRemovals = graph.directories
        .map((entry) => entry.relativePath)
        .filter((relativePath) => !desiredDirectoryPathSet.has(relativePath))
        .sort(compareUtf8Bytes);
    if (JSON.stringify(directoryRemovalPaths) !== JSON.stringify(expectedDirectoryRemovals)) {
        return conflict("runtime replacement authority does not cover the exact directory removal set");
    }
    const expectedUnmanagedRemovals = entries
        .filter((entry) => entry.entryAuthority === "explicit_unmanaged_replacement")
        .map((entry) => entry.relativePath)
        .sort(compareUtf8Bytes);
    if (JSON.stringify(unmanagedRemovalPaths) !== JSON.stringify(expectedUnmanagedRemovals)) {
        return conflict("runtime replacement authority does not cover the exact unmanaged-file removal set");
    }
    const expectedGraphFiles = expected.filter((file) => belongsToBoundary(file.relativePath, boundaryPaths));
    const expectedPresentGraphFiles = expectedGraphFiles.filter(
        (file): file is Extract<(typeof expectedGraphFiles)[number], { expectedState: "present" }> =>
            file.expectedState === "present",
    );
    if (
        JSON.stringify(graph.files.map((file) => file.relativePath)) !==
        JSON.stringify(expectedPresentGraphFiles.map((file) => file.relativePath))
    ) {
        return conflict("runtime managed-directory file inventory changed after preview");
    }
    const expectedPresentDirectories = directories.filter(
        (entry): entry is Extract<(typeof directories)[number], { expectedState: "present" }> =>
            entry.expectedState === "present",
    );
    const graphFiles = new Map(graph.files.map((file) => [file.relativePath, file.current]));
    for (const expectedFile of expectedPresentGraphFiles) {
        const current = graphFiles.get(expectedFile.relativePath);
        if (
            current === undefined ||
            expectedFile.expectedIdentity === undefined ||
            !samePhysicalPathIdentity(current.identity, expectedFile.expectedIdentity) ||
            current.executable !== expectedFile.expectedExecutable ||
            !Buffer.from(current.bytes).equals(Buffer.from(expectedFile.expectedBytes))
        ) {
            return changed(expectedFile.relativePath);
        }
    }
    const graphDirectories = new Map(graph.directories.map((entry) => [entry.relativePath, entry.identity]));
    for (const expectedDirectory of expectedPresentDirectories) {
        const current = graphDirectories.get(expectedDirectory.relativePath);
        if (current === undefined || !samePhysicalPathIdentity(current, expectedDirectory.expectedIdentity)) {
            return changed(expectedDirectory.relativePath);
        }
    }

    const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
    for (const file of expected) {
        const entry = entriesByPath.get(file.relativePath) as JournalEntry;
        const abs = absPath(ctx, file.relativePath);
        let live: ReturnType<typeof ioReadStableIfPresent>;
        try {
            live = graphFiles.get(file.relativePath) ?? ioReadStableIfPresent(ctx, abs);
        } catch {
            return conflict(`runtime state could not be rechecked: ${file.relativePath}`);
        }
        if (file.expectedState === "missing") {
            if (live !== null) return changed(file.relativePath);
            entry.runtimeRollbackOverride = { state: "missing" };
            continue;
        }
        if (live === null) return changed(file.relativePath);
        if (
            !Buffer.from(live.bytes).equals(Buffer.from(file.expectedBytes)) ||
            live.executable !== file.expectedExecutable ||
            (file.expectedIdentity !== undefined && !samePhysicalPathIdentity(live.identity, file.expectedIdentity))
        ) {
            return changed(file.relativePath);
        }
        entry.runtimeRollbackOverride = {
            state: "present",
            contentHash: sha256Bytes(file.expectedBytes),
            bytesBase64: bytesToBase64(file.expectedBytes),
            executable: file.expectedExecutable,
        };
    }
    return { status: "applied" };
}

function applyCompleteReplacement(
    entries: JournalEntry[],
    ctx: TargetIoContext,
    authority: DeploymentRuntimeReplacementAuthorityV1,
    exactDesiredDirectoryPaths: readonly string[],
): RuntimeReplacementResult {
    const scope = authority.replacementScope!;
    if (
        sortedUnique(scope.filePaths) === null ||
        sortedUnique(scope.directoryPaths) === null ||
        scope.filePaths.some(
            (relativePath) => !entries.some((entry) => entry.relativePath === relativePath && !entry.isRemoval),
        ) ||
        scope.directoryPaths.some((relativePath) => !authority.desiredManagedDirectoryBoundaryPaths.includes(relativePath))
    )
        return conflict("complete replacement scope differs from the desired target closure");
    const protectedPath = (relativePath: string) => !isCompleteReplacementPath(scope, relativePath);
    const protectedAuthority: DeploymentRuntimeReplacementAuthorityV1 = {
        files: authority.files.filter((file) => protectedPath(file.relativePath)),
        directories: authority.directories.filter((directory) => protectedPath(directory.relativePath)),
        managedDirectoryBoundaryPaths: authority.managedDirectoryBoundaryPaths.filter(protectedPath),
        desiredManagedDirectoryBoundaryPaths: authority.desiredManagedDirectoryBoundaryPaths.filter(protectedPath),
        unmanagedRemovalPaths: authority.unmanagedRemovalPaths.filter(protectedPath),
        directoryRemovalPaths: authority.directoryRemovalPaths.filter(protectedPath),
    };
    const guarded = applyRuntimeReplacementAuthority(
        entries.filter((entry) => protectedPath(entry.relativePath)),
        ctx,
        protectedAuthority,
        exactDesiredDirectoryPaths.filter(protectedPath),
    );
    if (guarded.status === "conflict") return guarded;
    for (const entry of entries.filter((entry) => !protectedPath(entry.relativePath))) {
        try {
            const live = ioReadStableIfPresent(ctx, absPath(ctx, entry.relativePath));
            entry.runtimeRollbackOverride =
                live === null
                    ? { state: "missing" }
                    : {
                          state: "present",
                          contentHash: sha256Bytes(live.bytes),
                          bytesBase64: bytesToBase64(live.bytes),
                          executable: live.executable,
                      };
        } catch {
            return conflict(`complete replacement target could not be captured: ${entry.relativePath}`);
        }
    }
    return { status: "applied" };
}

function sortedUnique(values: readonly string[]): string[] | null {
    const sorted = [...values].sort(compareUtf8Bytes);
    return new Set(values).size === values.length && JSON.stringify(sorted) === JSON.stringify(values) ? sorted : null;
}

function belongsToBoundary(relativePath: string, boundaries: readonly string[]): boolean {
    return boundaries.some((boundary) => relativePath.startsWith(`${boundary}/`));
}

function changed(relativePath: string): RuntimeReplacementResult {
    return conflict(`runtime changed after inspection: ${relativePath}`);
}

function conflict(reason: string): RuntimeReplacementResult {
    return { status: "conflict", reason };
}
