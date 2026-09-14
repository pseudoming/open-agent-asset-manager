/** Persistent, same-filesystem locations for Core-owned physical recovery material. */
import { directoriesShareFilesystem } from "@oaam/shared/filesystem";
import {
    getPhysicalHomeDirectory,
    isCanonicalPhysicalAccessPath,
    isSelectedWslPhysicalRootMapping,
    joinPhysicalAccessPath,
    physicalAccessPathContains,
    relatePhysicalAccessPaths,
    splitPhysicalAccessPath,
} from "@oaam/shared/paths";
import type { JournalPublication } from "./deployment-publication-model";
import { absPath, type TargetIoContext } from "./deployment-target-io";
import type { RestrictedTargetBinding } from "./restricted-target-contract";

export interface PublicationStagingParents {
    /** State-owned persistent root; never projected into another Environment. */
    stateRootPath?: string;
    /** Exact Project manifest root in the target's physical coordinates. */
    projectRootPath?: string;
}

export function selectPublicationStagingRoot(
    ctx: TargetIoContext,
    transactionId: string,
    publications: readonly JournalPublication[],
    managedDirectoryBoundaries: readonly string[],
    parents: PublicationStagingParents,
): string {
    const targetParents = [
        ...new Set(publications.map((unit) => splitPhysicalAccessPath(absPath(ctx, unit.relativePath)).parentPath)),
    ];
    const hasDirectory = publications.some((unit) => unit.kind === "directory");
    const loadingContainers = hasDirectory
        ? managedDirectoryBoundaries.map((boundary) => splitPhysicalAccessPath(absPath(ctx, boundary)).parentPath)
        : [];
    const project =
        parents.projectRootPath !== undefined && physicalAccessPathContains(parents.projectRootPath, ctx.targetRootPath)
            ? parents.projectRootPath
            : undefined;
    // File-only slots have opaque extensionless names, never a runtime entry
    // such as SKILL.md. They do not require a separate full-tree loading scope.
    const candidates = [
        ...(!hasDirectory && targetParents.length > 0 ? [() => targetParents[0]] : []),
        () => parents.stateRootPath,
        () => project,
        () => getPhysicalHomeDirectory(ctx.targetRootPath),
        // Config roots can contain their loading container (skills/<leaf>),
        // while direct Skill roots are themselves that container. The same
        // exclusion check distinguishes these shapes without Provider path names.
        () => ctx.targetRootPath,
        () => splitPhysicalAccessPath(ctx.targetRootPath).parentPath,
    ];
    const attempted = new Set<string>();
    for (const candidate of candidates) {
        try {
            const parent = candidate();
            if (parent === undefined || !isCanonicalPhysicalAccessPath(parent) || attempted.has(parent)) continue;
            attempted.add(parent);
            const root = joinPhysicalAccessPath(parent, `oaam-deployment-${transactionId}`);
            if (loadingContainers.some((container) => physicalAccessPathContains(container, root))) continue;
            if (targetParents.every((targetParent) => directoriesShareFilesystem(parent, targetParent))) return root;
        } catch {
            /* Try the next bounded persistent owner; no target or candidate has been written. */
        }
    }
    throw new Error("no persistent same-filesystem OAAM publication location is available outside the target loading containers");
}

/** Project coordinates come from a known ancestor mapping, never a guessed drive mount. */
export function projectPublicationRootForBinding(projectRootPath: string, binding: RestrictedTargetBinding): string | undefined {
    if (!isCanonicalPhysicalAccessPath(projectRootPath)) return undefined;
    const relation = relatePhysicalAccessPaths(projectRootPath, binding.targetRootPath);
    if (relation.kind !== "equal" && relation.kind !== "root_contains_candidate") return undefined;
    let executionProjectRoot = binding.executionRootPath;
    if (relation.kind === "root_contains_candidate") {
        for (const _segment of relation.relativePath.split("/"))
            executionProjectRoot = splitPhysicalAccessPath(executionProjectRoot).parentPath;
    }
    return isSelectedWslPhysicalRootMapping(projectRootPath, executionProjectRoot, binding.platformInstanceId)
        ? executionProjectRoot
        : undefined;
}
