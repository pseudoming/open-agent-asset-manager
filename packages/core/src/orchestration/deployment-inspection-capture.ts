/** Physical target capture and diff construction for deployment inspection. */

import {
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
    SafeFilesystemError,
    samePhysicalPathIdentity,
    type StableRegularFileRead,
} from "@oaam/shared/filesystem";
import { joinPhysicalAccessPath } from "@oaam/shared/paths";
import { binaryPayloadStats, normalizeText } from "../catalog/payload-store";
import type { AppliedRenderSnapshotV1, RenderOutputUnit } from "../contracts/deployment-authority";
import type {
    ChangedRenderedTargetFileInput,
    RenderedTargetInspectionFileState,
    RenderedTargetInspectionInput,
} from "../contracts/reverse";
import { readDeploymentPayload } from "../deployment/deployment-payload-store";
import type { ActiveDeploymentBaseline } from "../deployment/deployment-state-ops";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "../deployment/deployment-target-replacement";
import {
    MAXIMUM_MANAGED_PREVIEW_BYTES,
    desiredDirectoryPathsForBoundaries,
    type CapturedManagedDirectoryGraph,
} from "../deployment/deployment-managed-directory-graph";
import {
    computeRenderedTargetAttributeChangeFingerprint,
    computeRenderedTargetDiffHunkFingerprint,
    computeRenderedTargetInventoryDeltaFingerprint,
    computeRenderedTargetInspectionScopeFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { isCanonicalRelativePath } from "../foundation/validators";
import { compareUtf8Bytes } from "../foundation/text-order";
import { projectInspectionSafeAppliedRenderSnapshot } from "../render/render-inspection";
import type { PosixRelativePath, Sha256Digest, TargetFileContent, UuidV4 } from "../types";
import { deploymentInspectionFailure as failure } from "./deployment-inspection-errors";
import type { DeploymentRenderServiceConfiguration } from "./deployment-render-service";

const DIFF_ALGORITHM_VERSION = "core_byte_ranges_v1";
const MAXIMUM_MANAGED_DIRECTORY_ENTRIES = 2_048;
const MAXIMUM_ADDED_FILE_BYTES = 4 * 1024 * 1024;

interface CapturedManagedFile {
    relativePath: PosixRelativePath;
    outputUnitFingerprint: Sha256Digest;
    current: StableRegularFileRead;
}

interface CapturedManagedDirectories {
    files: Map<string, CapturedManagedFile>;
    inventories: RenderedTargetInspectionInput["inspectionScope"]["directoryInventories"];
    directories: CapturedManagedDirectoryGraph["directories"];
}

/** The physical capture needs compiled claims and baseline ownership, not State rows or payloads. */
export interface DeploymentInspectionTargetPlan {
    compilationFingerprint: Sha256Digest;
    outputUnits: RenderOutputUnit[];
    baselineFiles: Array<{
        relativePath: string;
        outputUnitFingerprint: Sha256Digest;
        managedDirectoryBoundaryPaths: string[];
    }>;
}

export type CaptureDeploymentInspectionTarget = (
    plan: DeploymentInspectionTargetPlan,
    targetRootPath: string,
) => DeploymentRuntimeReplacementAuthorityV1;

export function captureDeploymentInspectionInput(
    configuration: DeploymentRenderServiceConfiguration,
    deploymentId: UuidV4,
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
    baseline: ActiveDeploymentBaseline[],
    targetRootPath: string,
    captureTarget: CaptureDeploymentInspectionTarget = captureDeploymentInspectionTarget,
): {
    input: RenderedTargetInspectionInput;
    runtimeReplacementAuthority: DeploymentRuntimeReplacementAuthorityV1;
} {
    const claims = new Map(
        snapshot.outputUnits.flatMap((unit) => unit.claims.map((claim) => [claim.relativePath, { unit, claim }] as const)),
    );
    const baselinePaths = baseline.map((item) => item.relativePath).sort(compareUtf8Bytes);
    const claimPaths = [...claims.keys()].sort(compareUtf8Bytes);
    if (JSON.stringify(baselinePaths) !== JSON.stringify(claimPaths)) {
        throw failure(
            "scan.target_profile_outside_t5",
            "the active Deployment baseline does not match the exact applied output claims",
            "unsupported",
            false,
        );
    }

    const targetPlan: DeploymentInspectionTargetPlan = {
        compilationFingerprint: snapshot.compilationFingerprint,
        outputUnits: structuredClone(snapshot.outputUnits),
        baselineFiles: baseline.map((row) => ({
            relativePath: row.relativePath,
            outputUnitFingerprint: row.baselineState.provenance.outputUnitFingerprint,
            managedDirectoryBoundaryPaths: [...row.managedDirectoryBoundaryPaths],
        })),
    };
    const targetAuthority = captureTarget(targetPlan, targetRootPath);
    const managed = projectCapturedInspectionGraph(targetPlan, targetAuthority);
    const currentFiles = new Map(targetAuthority.files.map((file) => [file.relativePath, currentFromAuthority(file)]));
    const captured = baseline.map((row) => {
        // The exact sorted path closure was proved above, so this lookup is total.
        const claim = claims.get(row.relativePath) as NonNullable<ReturnType<typeof claims.get>>;
        const appliedBytes = readDeploymentPayload({
            deploymentsRoot: configuration.deploymentsRoot,
            deploymentId,
            contentHash: row.baselineState.appliedPayload.contentHash,
            expectedByteSize: row.baselineState.appliedPayload.byteSize,
        });
        const appliedContent = contentFromBytes(appliedBytes, row.baselineState.appliedPayload.contentKind);
        const current = currentFiles.get(row.relativePath)!;
        return { row, claim, appliedBytes, appliedContent, current };
    });

    const fileStates: RenderedTargetInspectionFileState[] = captured.map((item) => {
        if (item.current === null) {
            return {
                relativePath: item.row.relativePath as PosixRelativePath,
                state: "missing",
                appliedContentHash: item.row.baselineState.appliedPayload.contentHash,
                appliedExecutable: item.row.baselineState.appliedExecutable,
                outputUnitFingerprint: item.claim.unit.outputUnitFingerprint,
                provenanceFingerprint: item.row.baselineState.provenance.provenanceFingerprint,
            };
        }
        const currentHash = binaryPayloadStats(item.current.bytes).contentHash;
        const state =
            currentHash === item.row.baselineState.appliedPayload.contentHash &&
            item.current.executable === item.row.baselineState.appliedExecutable
                ? "unchanged"
                : "changed";
        return {
            relativePath: item.row.relativePath as PosixRelativePath,
            state,
            appliedContentHash: item.row.baselineState.appliedPayload.contentHash,
            currentContentHash: currentHash,
            appliedExecutable: item.row.baselineState.appliedExecutable,
            currentExecutable: item.current.executable,
            outputUnitFingerprint: item.claim.unit.outputUnitFingerprint,
            provenanceFingerprint: item.row.baselineState.provenance.provenanceFingerprint,
        };
    });
    const claimedPaths = new Set(baselinePaths);
    const added = [...managed.files.values()]
        .filter((file) => !claimedPaths.has(file.relativePath))
        .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    fileStates.push(
        ...added.map(
            (file): RenderedTargetInspectionFileState => ({
                relativePath: file.relativePath,
                state: "added",
                currentContentHash: binaryPayloadStats(file.current.bytes).contentHash,
                currentExecutable: file.current.executable,
                outputUnitFingerprint: file.outputUnitFingerprint,
            }),
        ),
    );
    fileStates.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const scopePreimage = { fileStates, directoryInventories: managed.inventories };
    const inspectionScopeFingerprint = computeRenderedTargetInspectionScopeFingerprint({
        deploymentId,
        appliedCompilationFingerprint: snapshot.compilationFingerprint,
        scope: scopePreimage,
    });
    const stateByPath = new Map(fileStates.map((state) => [state.relativePath, state]));
    const files: ChangedRenderedTargetFileInput[] = [];
    for (const item of captured) {
        const state = stateByPath.get(item.row.relativePath) as RenderedTargetInspectionFileState;
        if (state.state === "unchanged") continue;
        const appliedLength = item.appliedBytes.length;
        if (state.state === "missing") {
            const diffHunks =
                appliedLength === 0
                    ? []
                    : [fullHunk(item.row.relativePath, state.appliedContentHash, "missing", appliedLength, 0)];
            files.push({
                fileState: "baseline_missing" as const,
                relativePath: item.row.relativePath as PosixRelativePath,
                appliedContent: item.appliedContent,
                currentContent: { contentKind: "missing" as const },
                diffHunks,
                provenance: item.row.baselineState.provenance,
            });
            continue;
        }
        // The only remaining branch of RenderedTargetInspectionFileState is
        // `changed`: `missing` returned above and `unchanged` continued.
        const changed = state as Extract<RenderedTargetInspectionFileState, { state: "unchanged" | "changed" }>;
        const current = item.current as NonNullable<typeof item.current>;
        const currentContent = contentFromBytes(current.bytes, item.row.baselineState.appliedPayload.contentKind, true);
        const diffHunks =
            changed.appliedContentHash === changed.currentContentHash
                ? []
                : [
                      fullHunk(
                          item.row.relativePath,
                          changed.appliedContentHash,
                          changed.currentContentHash,
                          appliedLength,
                          current.bytes.length,
                      ),
                  ];
        const attributeChanges =
            changed.appliedExecutable === changed.currentExecutable
                ? []
                : [
                      {
                          attributeKind: "executable" as const,
                          appliedValue: changed.appliedExecutable,
                          currentValue: changed.currentExecutable,
                          attributeChangeFingerprint: computeRenderedTargetAttributeChangeFingerprint({
                              relativePath: item.row.relativePath,
                              inspectionScopeFingerprint,
                              change: {
                                  attributeKind: "executable",
                                  appliedValue: changed.appliedExecutable,
                                  currentValue: changed.currentExecutable,
                              },
                          }),
                      },
                  ];
        files.push({
            fileState: "baseline_changed" as const,
            relativePath: item.row.relativePath as PosixRelativePath,
            appliedContent: item.appliedContent,
            currentContent,
            diffHunks,
            attributeChanges,
            provenance: item.row.baselineState.provenance,
        });
    }
    for (const item of added) {
        const stats = binaryPayloadStats(item.current.bytes);
        const currentContent = contentFromBytes(item.current.bytes, "text", true);
        files.push({
            fileState: "added_managed_descendant",
            relativePath: item.relativePath,
            currentContent,
            diffHunks:
                item.current.bytes.length === 0
                    ? []
                    : [
                          fullHunk(
                              item.relativePath,
                              binaryPayloadStats(new Uint8Array()).contentHash,
                              stats.contentHash,
                              0,
                              item.current.bytes.length,
                          ),
                      ],
        });
    }
    files.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const inventoryDeltas = [
        ...captured.flatMap((item) => {
            if (item.current !== null || item.row.managedDirectoryBoundaryPaths.length === 0) return [];
            return [
                makeInventoryDelta(
                    snapshot,
                    inspectionScopeFingerprint,
                    item.claim.unit.outputUnitFingerprint,
                    item.row.relativePath,
                    "file_deleted",
                ),
            ];
        }),
        ...added.map((item) =>
            makeInventoryDelta(snapshot, inspectionScopeFingerprint, item.outputUnitFingerprint, item.relativePath, "file_added"),
        ),
    ].sort((left, right) => compareUtf8Bytes(left.inventoryDeltaFingerprint, right.inventoryDeltaFingerprint));
    return {
        input: {
            schemaVersion: 1,
            deploymentId,
            appliedRenderSnapshot: projectInspectionSafeAppliedRenderSnapshot(snapshot),
            inspectionScope: { inspectionScopeFingerprint, ...scopePreimage },
            files,
            inventoryDeltas,
        },
        runtimeReplacementAuthority: structuredClone(targetAuthority),
    };
}

/** One physical sample supplies both inspection and subsequent replacement CAS authority. */
export function captureDeploymentInspectionTarget(
    plan: DeploymentInspectionTargetPlan,
    targetRootPath: string,
): DeploymentRuntimeReplacementAuthorityV1 {
    const claimedPaths = new Set(plan.baselineFiles.map((row) => row.relativePath));
    const managed = captureManagedDirectories(plan, targetRootPath, claimedPaths);
    const files = plan.baselineFiles.map((row): DeploymentRuntimeReplacementAuthorityV1["files"][number] => {
        const managedFile = managed.files.get(row.relativePath);
        let current: StableRegularFileRead | null;
        if (row.managedDirectoryBoundaryPaths.length > 0) {
            if (managedFile !== undefined) requireManagedFileOwner(managedFile.outputUnitFingerprint, row.outputUnitFingerprint);
            current = managedFile?.current ?? null;
        } else {
            try {
                current = readRegularFileNoFollow(joinPhysicalTargetPath(targetRootPath, row.relativePath));
            } catch (error) {
                if (!(error instanceof SafeFilesystemError) || error.failureKind !== "not_found") throw error;
                current = null;
            }
        }
        return authorityFile(row.relativePath, current);
    });
    for (const file of managed.files.values()) {
        if (!claimedPaths.has(file.relativePath)) files.push(authorityFile(file.relativePath, file.current));
    }
    return inspectionAuthority(plan, files, managed);
}

/** Validate a service capture without touching either target or Host payload storage. */
export function validateCapturedDeploymentInspectionTarget(
    plan: DeploymentInspectionTargetPlan,
    authority: DeploymentRuntimeReplacementAuthorityV1,
): void {
    projectCapturedInspectionGraph(plan, authority);
}

function projectCapturedInspectionGraph(
    plan: DeploymentInspectionTargetPlan,
    authority: DeploymentRuntimeReplacementAuthorityV1,
): CapturedManagedDirectories {
    const baseline = new Map(plan.baselineFiles.map((row) => [row.relativePath, row]));
    const boundaries = plan.outputUnits.flatMap((unit) =>
        unit.managedDirectoryBoundaries.map((boundary) => ({ unit, boundary })),
    );
    const seen = new Set<string>();
    const files = new Map<string, CapturedManagedFile>();
    let managedBytes = 0;
    for (const file of authority.files) {
        if (!isCanonicalRelativePath(file.relativePath) || seen.has(file.relativePath))
            throw new Error("invalid inspection file closure");
        seen.add(file.relativePath);
        const owners = boundaries.filter(({ boundary }) => file.relativePath.startsWith(`${boundary.relativePath}/`));
        if (owners.length > 1) throw new Error("inspection boundaries overlap");
        const owner = owners[0];
        const row = baseline.get(file.relativePath);
        if (row === undefined && (owner === undefined || file.expectedState !== "present"))
            throw new Error("unrelated inspection file");
        if (row !== undefined && owner !== undefined)
            requireManagedFileOwner(owner.unit.outputUnitFingerprint, row.outputUnitFingerprint);
        const current = currentFromAuthority(file);
        if (current !== null && owner !== undefined) {
            managedBytes += current.bytes.byteLength;
            files.set(file.relativePath, {
                relativePath: file.relativePath as PosixRelativePath,
                outputUnitFingerprint: owner.unit.outputUnitFingerprint,
                current,
            });
        }
    }
    if (plan.baselineFiles.some((row) => !seen.has(row.relativePath)))
        throw new Error("inspection capture omits a baseline file");
    const directoryPaths = new Set<string>();
    const directories: CapturedManagedDirectories["directories"] = [];
    for (const directory of authority.directories) {
        if (
            !isCanonicalRelativePath(directory.relativePath) ||
            seen.has(directory.relativePath) ||
            directoryPaths.has(directory.relativePath)
        )
            throw new Error("invalid inspection directory closure");
        directoryPaths.add(directory.relativePath);
        if (
            boundaries.filter(
                ({ boundary }) =>
                    directory.relativePath === boundary.relativePath ||
                    directory.relativePath.startsWith(`${boundary.relativePath}/`),
            ).length !== 1
        )
            throw new Error("unrelated inspection directory");
        if (directory.expectedState === "present") {
            if (directory.expectedIdentity.entryKind !== "directory") throw new Error("invalid inspection directory identity");
            directories.push({ relativePath: directory.relativePath, identity: structuredClone(directory.expectedIdentity) });
        } else if (directory.expectedState !== "missing") throw new Error("invalid inspection directory state");
    }
    const presentDirectories = new Set(directories.map((directory) => directory.relativePath));
    for (const relativePath of [...files.keys(), ...presentDirectories]) {
        // File insertion and the directory loop above already established this exact owner.
        const owner = boundaries.find(
            ({ boundary }) => relativePath === boundary.relativePath || relativePath.startsWith(`${boundary.relativePath}/`),
        )!;
        let parent = files.has(relativePath) ? relativePath.slice(0, relativePath.lastIndexOf("/")) : relativePath;
        while (parent.length >= owner.boundary.relativePath.length) {
            if (!presentDirectories.has(parent)) throw new Error("inspection graph omits a present ancestor directory");
            if (parent === owner.boundary.relativePath) break;
            parent = parent.slice(0, parent.lastIndexOf("/"));
        }
    }
    if (files.size + directories.length > MAXIMUM_MANAGED_DIRECTORY_ENTRIES || managedBytes > MAXIMUM_MANAGED_PREVIEW_BYTES)
        throw new Error("inspection graph exceeds its bounded preview limit");
    const inventories = boundaries
        .map(({ unit, boundary }) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            boundary: structuredClone(boundary),
            currentDescendantPaths: [...files.keys()]
                .filter((relativePath) => relativePath.startsWith(`${boundary.relativePath}/`))
                .sort(compareUtf8Bytes) as PosixRelativePath[],
        }))
        .sort((left, right) =>
            compareUtf8Bytes(
                `${left.outputUnitFingerprint}\0${left.boundary.relativePath}`,
                `${right.outputUnitFingerprint}\0${right.boundary.relativePath}`,
            ),
        );
    const managed = { files, inventories, directories };
    const projected = inspectionAuthority(
        plan,
        authority.files.map((file) => authorityFile(file.relativePath, currentFromAuthority(file))),
        managed,
    );
    if (stableStringify(projected) !== stableStringify(authority))
        throw new Error("inspection capture changes its exact graph authority");
    return managed;
}

function currentFromAuthority(file: DeploymentRuntimeReplacementAuthorityV1["files"][number]): StableRegularFileRead | null {
    if (file.expectedState === "missing") return null;
    if (
        file.expectedState !== "present" ||
        !(file.expectedBytes instanceof Uint8Array) ||
        typeof file.expectedExecutable !== "boolean" ||
        file.expectedIdentity?.entryKind !== "file"
    )
        throw new Error("invalid inspection file bytes or identity");
    return {
        bytes: new Uint8Array(file.expectedBytes),
        executable: file.expectedExecutable,
        identity: structuredClone(file.expectedIdentity),
    };
}

function authorityFile(
    relativePath: string,
    current: StableRegularFileRead | null,
): DeploymentRuntimeReplacementAuthorityV1["files"][number] {
    return current === null
        ? { relativePath, expectedState: "missing" }
        : {
              relativePath,
              expectedState: "present",
              expectedBytes: new Uint8Array(current.bytes),
              expectedExecutable: current.executable,
              expectedIdentity: structuredClone(current.identity),
          };
}

function inspectionAuthority(
    plan: DeploymentInspectionTargetPlan,
    files: DeploymentRuntimeReplacementAuthorityV1["files"],
    managed: CapturedManagedDirectories,
): DeploymentRuntimeReplacementAuthorityV1 {
    const baselinePaths = new Set(plan.baselineFiles.map((file) => file.relativePath));
    const boundaryPaths = plan.outputUnits
        .flatMap((unit) => unit.managedDirectoryBoundaries.map((boundary) => boundary.relativePath))
        .sort(compareUtf8Bytes);
    return {
        files: files.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath)),
        directories: directoryReplacementAuthority(plan, managed),
        managedDirectoryBoundaryPaths: boundaryPaths,
        desiredManagedDirectoryBoundaryPaths: [...boundaryPaths],
        unmanagedRemovalPaths: [...managed.files.keys()]
            .filter((relativePath) => !baselinePaths.has(relativePath))
            .sort(compareUtf8Bytes),
        directoryRemovalPaths: directoryRemovalPaths(plan, managed),
    };
}

function desiredDirectoryPaths(
    snapshot: Pick<Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>, "outputUnits">,
): string[] {
    const boundaries = snapshot.outputUnits.flatMap((unit) => unit.managedDirectoryBoundaries);
    const files = snapshot.outputUnits.flatMap((unit) => unit.claims.map((claim) => claim.relativePath));
    return desiredDirectoryPathsForBoundaries(boundaries, files);
}

function directoryReplacementAuthority(
    snapshot: Pick<Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>, "outputUnits">,
    graph: Pick<CapturedManagedDirectoryGraph, "directories">,
): DeploymentRuntimeReplacementAuthorityV1["directories"] {
    const current = new Map(graph.directories.map((directory) => [directory.relativePath, directory.identity]));
    return [...new Set([...desiredDirectoryPaths(snapshot), ...current.keys()])].sort(compareUtf8Bytes).map((relativePath) => {
        const identity = current.get(relativePath);
        return identity === undefined
            ? { relativePath, expectedState: "missing" as const }
            : { relativePath, expectedState: "present" as const, expectedIdentity: identity };
    });
}

function directoryRemovalPaths(
    snapshot: Pick<Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>, "outputUnits">,
    graph: Pick<CapturedManagedDirectoryGraph, "directories">,
): string[] {
    const desired = new Set(desiredDirectoryPaths(snapshot));
    return graph.directories
        .map((directory) => directory.relativePath)
        .filter((relativePath) => !desired.has(relativePath))
        .sort(compareUtf8Bytes);
}

function captureManagedDirectories(
    snapshot: Pick<Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>, "outputUnits">,
    targetRootPath: string,
    claimedPaths: ReadonlySet<string>,
): CapturedManagedDirectories {
    const files = new Map<string, CapturedManagedFile>();
    const inventories: CapturedManagedDirectories["inventories"] = [];
    const directories = new Map<string, StableRegularFileRead["identity"]>();
    const seenPaths = new Set<string>();
    // Preserve the former authority-graph pass's aggregate limits while
    // deriving file review and directory authority from one stable capture.
    const budget = { remainingEntries: MAXIMUM_MANAGED_DIRECTORY_ENTRIES, remainingBytes: MAXIMUM_MANAGED_PREVIEW_BYTES };
    for (const unit of snapshot.outputUnits) {
        for (const boundary of unit.managedDirectoryBoundaries) {
            const captured = captureManagedDirectoryTree(
                targetRootPath,
                boundary.relativePath,
                budget,
                claimedPaths,
                true,
                directories,
                seenPaths,
            );
            for (const current of captured) {
                files.set(current.relativePath, {
                    relativePath: current.relativePath,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    current: current.current,
                });
            }
            inventories.push({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                boundary: structuredClone(boundary),
                currentDescendantPaths: captured.map((item) => item.relativePath).sort(compareUtf8Bytes),
            });
        }
    }
    inventories.sort((left, right) =>
        compareUtf8Bytes(
            `${left.outputUnitFingerprint}\0${left.boundary.relativePath}`,
            `${right.outputUnitFingerprint}\0${right.boundary.relativePath}`,
        ),
    );
    return {
        files,
        inventories,
        directories: [...directories]
            .map(([relativePath, identity]) => ({ relativePath, identity }))
            .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath)),
    };
}

function captureManagedDirectoryTree(
    targetRootPath: string,
    boundaryRelativePath: PosixRelativePath,
    budget: { remainingEntries: number; remainingBytes: number },
    claimedPaths: ReadonlySet<string>,
    allowMissingDirectory: boolean,
    directories: Map<string, StableRegularFileRead["identity"]>,
    seenPaths: Set<string>,
): Array<{ relativePath: PosixRelativePath; current: StableRegularFileRead }> {
    requireUnseenManagedPath(seenPaths, boundaryRelativePath);
    if (budget.remainingEntries <= 0) throw new Error("managed target graph exceeds the bounded preview entry limit");
    const directoryPath = joinPhysicalTargetPath(targetRootPath, boundaryRelativePath);
    let before: ReturnType<typeof inventoryDirectoryNoFollow>;
    try {
        before = inventoryDirectoryNoFollow(directoryPath, budget.remainingEntries);
    } catch (error) {
        if (isAllowedMissingManagedDirectory(error, allowMissingDirectory)) return [];
        throw error;
    }
    budget.remainingEntries -= 1;
    seenPaths.add(boundaryRelativePath);
    directories.set(boundaryRelativePath, before.identity);
    const files: Array<{ relativePath: PosixRelativePath; current: StableRegularFileRead }> = [];
    for (const entry of before.entries) {
        const relativePath = `${boundaryRelativePath}/${entry.relativeName}` as PosixRelativePath;
        if (entry.identity.entryKind === "directory") {
            files.push(
                ...captureManagedDirectoryTree(targetRootPath, relativePath, budget, claimedPaths, false, directories, seenPaths),
            );
            if (!samePhysicalPathIdentity(entry.identity, directories.get(relativePath)!)) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation: "inventory_directory",
                    targetPath: joinPhysicalTargetPath(targetRootPath, relativePath),
                    systemCode: "MANAGED_TREE_DIRECTORY_CHANGED",
                    message: "managed directory identity changed during inspection",
                });
            }
            continue;
        }
        requireUnseenManagedPath(seenPaths, relativePath);
        if (budget.remainingEntries <= 0 || budget.remainingBytes <= 0) {
            throw new Error("managed target graph exceeds its bounded preview limit");
        }
        budget.remainingEntries -= 1;
        const current = readRegularFileNoFollow(
            joinPhysicalTargetPath(targetRootPath, relativePath),
            Math.min(claimedPaths.has(relativePath) ? Number.MAX_SAFE_INTEGER : MAXIMUM_ADDED_FILE_BYTES, budget.remainingBytes),
        );
        requireManagedFileIdentity(entry.identity, current.identity, joinPhysicalTargetPath(targetRootPath, relativePath));
        seenPaths.add(relativePath);
        budget.remainingBytes -= current.bytes.byteLength;
        files.push({ relativePath, current });
    }
    const after = inventoryDirectoryNoFollow(directoryPath, before.entries.length);
    requireStableManagedDirectoryInventory(before, after, directoryPath);
    return files;
}

function requireUnseenManagedPath(seenPaths: ReadonlySet<string>, relativePath: string): void {
    if (seenPaths.has(relativePath)) {
        throw failure(
            "scan.managed_directory_ownership_conflict",
            "managed directory boundaries overlap on one physical target path",
            "conflict",
            true,
        );
    }
}

function requireManagedFileOwner(actual: Sha256Digest, expected: Sha256Digest): void {
    if (actual === expected) return;
    throw failure(
        "scan.managed_directory_ownership_conflict",
        "a managed target file was attributed to more than one output unit",
        "conflict",
        true,
    );
}

function isAllowedMissingManagedDirectory(error: unknown, allowMissingDirectory: boolean): boolean {
    return allowMissingDirectory && error instanceof SafeFilesystemError && error.failureKind === "not_found";
}

function requireManagedFileIdentity(
    expected: StableRegularFileRead["identity"],
    actual: StableRegularFileRead["identity"],
    targetPath: string,
): void {
    if (samePhysicalPathIdentity(expected, actual)) return;
    throw new SafeFilesystemError({
        failureKind: "stale",
        operation: "inventory_directory",
        targetPath,
        systemCode: "MANAGED_TREE_FILE_CHANGED",
        message: "managed directory file identity changed during inspection",
    });
}

function requireStableManagedDirectoryInventory(
    before: ReturnType<typeof inventoryDirectoryNoFollow>,
    after: ReturnType<typeof inventoryDirectoryNoFollow>,
    directoryPath: string,
): void {
    if (sameDirectoryInventory(before, after)) return;
    throw new SafeFilesystemError({
        failureKind: "stale",
        operation: "inventory_directory",
        targetPath: directoryPath,
        systemCode: "MANAGED_TREE_CHANGED",
        message: "managed directory changed during inspection",
    });
}

function sameDirectoryInventory(
    left: ReturnType<typeof inventoryDirectoryNoFollow>,
    right: ReturnType<typeof inventoryDirectoryNoFollow>,
): boolean {
    return (
        samePhysicalPathIdentity(left.identity, right.identity) &&
        left.entries.length === right.entries.length &&
        left.entries.every((entry, index) => {
            const rightEntry = right.entries[index];
            return (
                rightEntry !== undefined &&
                entry.relativeName === rightEntry.relativeName &&
                samePhysicalPathIdentity(entry.identity, rightEntry.identity)
            );
        })
    );
}

function makeInventoryDelta(
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
    inspectionScopeFingerprint: Sha256Digest,
    outputUnitFingerprint: Sha256Digest,
    relativePath: string,
    deltaKind: "file_added" | "file_deleted",
) {
    const refs = snapshot.decisions.filter(
        (decision) =>
            decision.semanticRef.semanticKind === "asset.file_inventory" &&
            decision.outputUnitFingerprints.includes(outputUnitFingerprint),
    );
    if (refs.length !== 1) {
        throw failure(
            "scan.managed_directory_inventory_semantic_invalid",
            "managed directory has no unique applied file-inventory semantic",
            "conflict",
            true,
        );
    }
    const [inventoryRef] = refs as [(typeof refs)[number]];
    const delta = {
        outputUnitFingerprint,
        relativePath: relativePath as PosixRelativePath,
        deltaKind,
        inventorySemanticRefFingerprint: inventoryRef.semanticRef.semanticRefFingerprint,
    };
    return {
        ...delta,
        inventoryDeltaFingerprint: computeRenderedTargetInventoryDeltaFingerprint({ inspectionScopeFingerprint, delta }),
    };
}

function fullHunk(
    relativePath: string,
    appliedContentHash: `sha256:${string}`,
    currentContentHash: `sha256:${string}` | "missing",
    appliedEndByte: number,
    currentEndByte: number,
) {
    const hunk = {
        appliedStartByte: 0,
        appliedEndByte,
        currentStartByte: 0,
        currentEndByte,
    };
    return {
        hunkFingerprint: computeRenderedTargetDiffHunkFingerprint({
            relativePath,
            appliedContentHash,
            currentContentHash,
            diffAlgorithmVersion: DIFF_ALGORITHM_VERSION,
            hunk,
        }),
        ...hunk,
    };
}

export function contentFromBytes(
    bytes: Uint8Array,
    contentKind: "text" | "binary",
    allowBinaryFallback = false,
): TargetFileContent {
    if (contentKind === "binary") return { contentKind: "binary", bytes: new Uint8Array(bytes) };
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!Buffer.from(normalizeText(text).bytes).equals(Buffer.from(bytes))) {
            if (allowBinaryFallback) {
                return { contentKind: "binary", bytes: new Uint8Array(bytes) };
            }
            throw new Error("applied text payload is not canonically encoded");
        }
        return { contentKind: "text", text };
    } catch (error) {
        if (allowBinaryFallback) return { contentKind: "binary", bytes: new Uint8Array(bytes) };
        throw error;
    }
}

export function joinPhysicalTargetPath(targetRootPath: string, relativePath: string): string {
    return joinPhysicalAccessPath(targetRootPath, relativePath);
}

export const deploymentInspectionCaptureInternalsForTest = Object.freeze({
    isAllowedMissingManagedDirectory,
    requireManagedFileIdentity,
    requireManagedFileOwner,
    requireStableManagedDirectoryInventory,
    sameDirectoryInventory,
});
