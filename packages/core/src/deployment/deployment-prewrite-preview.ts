import type { ActiveDeploymentBaseline } from "./deployment-state-ops";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "./deployment-target-replacement";
import type { TargetPlan } from "./deployment-target-plan";
import { validateTargetPlanPaths } from "./deployment-execution-validation";
import { absPath, createTargetIo, ioReadStableIfPresent } from "./deployment-target-io";
import type {
    DeploymentPreviewContent,
    DeploymentPreviewDirectory,
    DeploymentPreviewFile,
    DeploymentPreviewFileState,
    DeploymentPreviewReplacementScope,
    DeploymentRenderPreviewFingerprintInput,
    DeploymentRenderPreviewView,
} from "../contracts/render-preview";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { computeDeploymentRenderPreviewFingerprint } from "../foundation/fingerprint";
import { stableStringify } from "../foundation/fingerprint";
import { isCanonicalRelativePath } from "../foundation/validators";
import { compareUtf8Bytes } from "../foundation/text-order";
import type { PhysicalPathIdentity, StableRegularFileRead } from "@oaam/shared/filesystem";
import {
    captureManagedDirectoryGraph,
    desiredDirectoryPathsForBoundaries,
    desiredManagedDirectoryPaths,
    type CapturedManagedDirectoryGraph,
} from "./deployment-managed-directory-graph";

const MAXIMUM_PREVIEW_FILES = 256;
const MAXIMUM_PREVIEW_TEXT_BYTES = 4 * 1024 * 1024;

export interface CapturedDeploymentPreWritePreview {
    view: DeploymentRenderPreviewView;
    runtimeReplacementAuthority: DeploymentRuntimeReplacementAuthorityV1;
}

export interface DeploymentPreWritePreviewInput {
    deploymentId: UuidV4;
    targetRootPath: string;
    renderInputFingerprint: Sha256Digest;
    selectionFingerprint: Sha256Digest;
    compilationFingerprint: Sha256Digest;
    targetPlan: TargetPlan;
    baseline: DeploymentPreWriteBaseline[];
}

/** Only the last-success facts used by preview; State rows and payload locators remain with the Host. */
export type DeploymentPreWriteBaseline = Pick<ActiveDeploymentBaseline, "relativePath" | "managedDirectoryBoundaryPaths"> & {
    baselineState: {
        appliedPayload: Pick<ActiveDeploymentBaseline["baselineState"]["appliedPayload"], "contentHash">;
        appliedExecutable: boolean;
    };
};

function reviewedBoundaries(input: DeploymentPreWritePreviewInput): string[] {
    const pathFailure = validateTargetPlanPaths(input.targetPlan);
    if (pathFailure !== null) throw new DeploymentPreWritePreviewError("render.preview_target_invalid", pathFailure);
    if (
        input.baseline.some(
            (file) =>
                !isCanonicalRelativePath(file.relativePath) ||
                file.managedDirectoryBoundaryPaths.some((boundary) => !isCanonicalRelativePath(boundary)),
        )
    ) {
        throw new DeploymentPreWritePreviewError("render.preview_target_invalid", "preview baseline has a noncanonical path");
    }
    return [
        ...new Set([
            ...input.targetPlan.managedDirectoryBoundaries.map((boundary) => boundary.relativePath),
            ...input.baseline.flatMap((file) => file.managedDirectoryBoundaryPaths),
        ]),
    ].sort(compareUtf8Bytes);
}

export function captureDeploymentPreWritePreview(input: DeploymentPreWritePreviewInput): CapturedDeploymentPreWritePreview {
    const reviewedBoundaryPaths = reviewedBoundaries(input);
    let managedGraph: ReturnType<typeof captureManagedDirectoryGraph>;
    try {
        managedGraph = captureManagedDirectoryGraph(
            input.targetRootPath,
            reviewedBoundaryPaths.map((relativePath) => ({ relativePath })),
        );
    } catch (error) {
        throw new DeploymentPreWritePreviewError(
            "render.preview_target_unavailable",
            `cannot capture the complete managed target graph: ${String(error)}`,
        );
    }
    const context = createTargetIo(input.targetRootPath);
    return buildPreWritePreview(input, managedGraph, (relativePath, preferredContentKind, retained) =>
        captureCurrent(context, relativePath, preferredContentKind, retained),
    );
}

/** Recompute every view/confirmation field from the exact operation's captured facts, without target I/O. */
export function projectCapturedDeploymentPreWritePreview(
    input: DeploymentPreWritePreviewInput,
    source: DeploymentRuntimeReplacementAuthorityV1,
): CapturedDeploymentPreWritePreview {
    const boundaries = reviewedBoundaries(input);
    const authority = structuredClone(source);
    const requiredFiles = new Set([
        ...input.targetPlan.targetFiles.map((file) => file.relativePath),
        ...input.baseline.map((file) => file.relativePath),
    ]);
    const files = new Map(authority.files.map((file) => [file.relativePath, file]));
    const belongs = (relativePath: string) =>
        boundaries.some((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`));
    if (
        files.size !== authority.files.length ||
        [...requiredFiles].some((relativePath) => !files.has(relativePath)) ||
        authority.files.some(
            (file) =>
                !isCanonicalRelativePath(file.relativePath) ||
                (!requiredFiles.has(file.relativePath) && !belongs(file.relativePath)),
        ) ||
        authority.directories.some(
            (directory) => !isCanonicalRelativePath(directory.relativePath) || !belongs(directory.relativePath),
        ) ||
        stableStringify(authority.managedDirectoryBoundaryPaths) !== stableStringify(boundaries)
    ) {
        throw new DeploymentPreWritePreviewError(
            "render.preview_target_invalid",
            "captured preview does not match its exact target closure",
        );
    }
    const current = (relativePath: string): StableRegularFileRead | null => {
        // Capture paths come from the plan, baseline and this already-validated file set.
        const file = files.get(relativePath)!;
        if (file.expectedState === "missing") return null;
        if (file.expectedIdentity === undefined)
            throw new DeploymentPreWritePreviewError(
                "render.preview_target_invalid",
                "captured preview file identity is missing",
            );
        return { bytes: file.expectedBytes, executable: file.expectedExecutable, identity: file.expectedIdentity };
    };
    const graph: CapturedManagedDirectoryGraph = {
        files: authority.files
            .filter((file) => file.expectedState === "present" && belongs(file.relativePath))
            .map((file) => ({ relativePath: file.relativePath, current: current(file.relativePath)! })),
        directories: authority.directories
            .filter((directory) => directory.expectedState === "present")
            .map((directory) => ({
                relativePath: directory.relativePath,
                identity: (directory as Extract<typeof directory, { expectedState: "present" }>).expectedIdentity,
            })),
    };
    const projected = buildPreWritePreview(input, graph, (relativePath, preferredContentKind) =>
        projectCurrent(current(relativePath), preferredContentKind),
    );
    if (stableStringify(projected.runtimeReplacementAuthority) !== stableStringify(authority)) {
        throw new DeploymentPreWritePreviewError(
            "render.preview_target_invalid",
            "captured preview changes its replacement authority",
        );
    }
    return projected;
}

function buildPreWritePreview(
    input: DeploymentPreWritePreviewInput,
    managedGraph: CapturedManagedDirectoryGraph,
    capture: (
        relativePath: string,
        preferredContentKind: "text" | "binary" | undefined,
        retained?: StableRegularFileRead,
    ) => ReturnType<typeof projectCurrent>,
): CapturedDeploymentPreWritePreview {
    const reviewedBoundaryPaths = reviewedBoundaries(input);
    const desiredByPath = new Map(input.targetPlan.targetFiles.map((file) => [file.relativePath, file]));
    const baselineByPath = new Map(input.baseline.map((file) => [file.relativePath, file]));
    const managedFilesByPath = new Map(managedGraph.files.map((file) => [file.relativePath, file.current]));
    const paths = [...new Set([...desiredByPath.keys(), ...baselineByPath.keys(), ...managedFilesByPath.keys()])].sort(
        compareUtf8Bytes,
    );
    if (paths.length > MAXIMUM_PREVIEW_FILES) {
        throw new DeploymentPreWritePreviewError(
            "render.preview_file_limit",
            `pre-write preview exceeds the ${MAXIMUM_PREVIEW_FILES}-file review limit`,
        );
    }

    const authorityFiles: DeploymentRuntimeReplacementAuthorityV1["files"] = [];
    const files: DeploymentPreviewFile[] = [];
    const replacementScope = targetReplacementScope(input.targetPlan);
    let textBytes = 0;
    for (const relativePath of paths) {
        const desiredFile = desiredByPath.get(relativePath);
        const baseline = baselineByPath.get(relativePath);
        const currentCapture = capture(relativePath, desiredFile?.content.contentKind, managedFilesByPath.get(relativePath));
        authorityFiles.push(
            currentCapture.bytes === undefined
                ? { relativePath, expectedState: "missing" }
                : {
                      relativePath,
                      expectedState: "present",
                      expectedBytes: currentCapture.bytes,
                      expectedExecutable: currentCapture.view.executable,
                      expectedIdentity: currentCapture.identity,
                  },
        );
        const desired = desiredFile === undefined ? ({ state: "missing" } as const) : desiredState(desiredFile);
        const current = currentCapture.state;
        if (
            desiredFile?.containerPatchPreimageHash !== undefined &&
            desiredFile.containerPatchPreimageHash !== (current.state === "missing" ? null : current.contentHash)
        ) {
            throw new DeploymentPreWritePreviewError(
                "render.preview_container_changed",
                `shared-container content changed after patch materialization at ${relativePath}`,
            );
        }
        textBytes += textByteLength(current) + textByteLength(desired);
        if (textBytes > MAXIMUM_PREVIEW_TEXT_BYTES) {
            throw new DeploymentPreWritePreviewError(
                "render.preview_text_limit",
                `pre-write preview exceeds the ${MAXIMUM_PREVIEW_TEXT_BYTES}-byte text review limit`,
            );
        }
        files.push({
            relativePath,
            baselineState: baseline === undefined ? "unmanaged" : "managed",
            changeKind:
                baseline === undefined
                    ? classifyUnmanagedChange(current, desired)
                    : classifyManagedChange(current, desired, baseline, isCompleteReplacement(replacementScope, relativePath)),
            current,
            desired,
        });
    }
    const desiredDirectoryPaths = new Set(desiredManagedDirectoryPaths(input.targetPlan));
    const baselineDirectoryPaths = new Set(
        desiredDirectoryPathsForBoundaries(
            reviewedBoundaryPaths.map((relativePath) => ({ relativePath })),
            input.baseline.map((file) => file.relativePath),
        ),
    );
    const currentDirectoriesByPath = new Map(
        managedGraph.directories.map((directory) => [directory.relativePath, directory.identity]),
    );
    const directoryPaths = [
        ...new Set([...desiredDirectoryPaths, ...baselineDirectoryPaths, ...currentDirectoriesByPath.keys()]),
    ].sort(compareUtf8Bytes);
    const directories = directoryPaths.map((relativePath): DeploymentPreviewDirectory => {
        const currentState = currentDirectoriesByPath.has(relativePath) ? "present" : "missing";
        const desiredState = desiredDirectoryPaths.has(relativePath) ? "present" : "missing";
        const baselineState = baselineDirectoryPaths.has(relativePath) ? "managed" : "unmanaged";
        return {
            managedBoundaryRelativePath: requireManagedBoundary(reviewedBoundaryPaths, relativePath),
            relativePath,
            baselineState,
            changeKind:
                desiredState === "present"
                    ? currentState === "missing"
                        ? "create"
                        : "unchanged"
                    : baselineState === "managed"
                      ? "remove_managed"
                      : "remove_unmanaged",
            currentState,
            desiredState,
        };
    });
    const actionState = files.some((file) => file.changeKind === "managed_conflict")
        ? "blocked_managed_conflict"
        : files.some((file) => file.changeKind === "replace_unmanaged") ||
            directories.some((directory) => directory.changeKind === "remove_unmanaged")
          ? "requires_unmanaged_replacement"
          : "ready_apply";
    const preimage = previewFingerprintInput(input, replacementScope, files, directories);
    return {
        view: {
            schemaVersion: 3,
            deploymentId: input.deploymentId,
            renderInputFingerprint: input.renderInputFingerprint,
            selectionFingerprint: input.selectionFingerprint,
            compilationFingerprint: input.compilationFingerprint,
            previewFingerprint: computeDeploymentRenderPreviewFingerprint(preimage),
            replacementScope,
            actionState,
            files,
            directories,
        },
        runtimeReplacementAuthority: {
            replacementScope: structuredClone(replacementScope),
            files: authorityFiles,
            directories: directories.map((directory) => {
                const identity = currentDirectoriesByPath.get(directory.relativePath);
                return identity === undefined
                    ? { relativePath: directory.relativePath, expectedState: "missing" as const }
                    : {
                          relativePath: directory.relativePath,
                          expectedState: "present" as const,
                          expectedIdentity: identity,
                      };
            }),
            managedDirectoryBoundaryPaths: reviewedBoundaryPaths,
            desiredManagedDirectoryBoundaryPaths: input.targetPlan.managedDirectoryBoundaries.map(
                (boundary) => boundary.relativePath,
            ),
            unmanagedRemovalPaths: files
                .filter(
                    (file) =>
                        file.baselineState === "unmanaged" &&
                        file.current.state === "present" &&
                        file.desired.state === "missing",
                )
                .map((file) => file.relativePath),
            directoryRemovalPaths: directories
                .filter((directory) => directory.desiredState === "missing" && directory.currentState === "present")
                .map((directory) => directory.relativePath),
        },
    };
}

function captureCurrent(
    context: ReturnType<typeof createTargetIo>,
    relativePath: string,
    preferredContentKind: "text" | "binary" | undefined,
    retained?: StableRegularFileRead,
): ReturnType<typeof projectCurrent> {
    const absolutePath = absPath(context, relativePath);
    try {
        return projectCurrent(retained ?? ioReadStableIfPresent(context, absolutePath), preferredContentKind);
    } catch (error) {
        throw new DeploymentPreWritePreviewError(
            "render.preview_target_unavailable",
            `cannot read the exact preview target ${relativePath}: ${String(error)}`,
        );
    }
}

function projectCurrent(
    stable: StableRegularFileRead | null,
    preferredContentKind: "text" | "binary" | undefined,
):
    | {
          state: Extract<DeploymentPreviewFileState, { state: "missing" }>;
          bytes: undefined;
          identity: undefined;
          view: { executable: false };
      }
    | {
          state: Extract<DeploymentPreviewFileState, { state: "present" }>;
          bytes: Uint8Array;
          identity: PhysicalPathIdentity;
          view: Extract<DeploymentPreviewFileState, { state: "present" }>;
      } {
    if (stable === null)
        return { state: { state: "missing" }, bytes: undefined, identity: undefined, view: { executable: false } };
    const { bytes, executable, identity } = stable;
    const content = contentPreview(bytes, executable, preferredContentKind);
    return { state: { state: "present", ...content }, bytes, identity, view: { state: "present", ...content } };
}

function desiredState(file: TargetPlan["targetFiles"][number]): Extract<DeploymentPreviewFileState, { state: "present" }> {
    const bytes = file.content.contentKind === "text" ? new TextEncoder().encode(file.content.text) : file.content.bytes;
    const content =
        file.content.contentKind === "text"
            ? ({
                  contentKind: "text" as const,
                  contentHash: sha256Bytes(bytes),
                  byteSize: bytes.byteLength,
                  executable: file.executable,
                  text: file.content.text,
              } satisfies DeploymentPreviewContent)
            : ({
                  contentKind: "binary" as const,
                  contentHash: sha256Bytes(bytes),
                  byteSize: bytes.byteLength,
                  executable: file.executable,
              } satisfies DeploymentPreviewContent);
    return { state: "present", ...content };
}

function contentPreview(
    bytes: Uint8Array,
    executable: boolean,
    preferredContentKind: "text" | "binary" | undefined,
): DeploymentPreviewContent {
    if (preferredContentKind !== "binary") {
        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            return { contentKind: "text", contentHash: sha256Bytes(bytes), byteSize: bytes.byteLength, executable, text };
        } catch {
            // A target that is not strict UTF-8 remains reviewable as binary metadata.
        }
    }
    return { contentKind: "binary", contentHash: sha256Bytes(bytes), byteSize: bytes.byteLength, executable };
}

function classifyUnmanagedChange(
    current: DeploymentPreviewFileState,
    desired: DeploymentPreviewFileState,
): DeploymentPreviewFile["changeKind"] {
    if (desired.state === "missing") return "replace_unmanaged";
    if (current.state === "missing") return "create";
    return statesEqual(current, desired) ? "establish_baseline" : "replace_unmanaged";
}

function classifyManagedChange(
    current: DeploymentPreviewFileState,
    desired: DeploymentPreviewFileState,
    baseline: DeploymentPreWriteBaseline,
    completeReplacement: boolean,
): DeploymentPreviewFile["changeKind"] {
    if (desired.state === "missing" && current.state === "missing") return "remove_managed";
    if (!completeReplacement && !currentMatchesBaseline(current, baseline)) return "managed_conflict";
    if (desired.state === "missing") return "remove_managed";
    if (current.state === "missing") return "create";
    return statesEqual(current, desired) ? "unchanged" : "update_managed";
}

function currentMatchesBaseline(
    current: DeploymentPreviewFileState,
    baseline: DeploymentPreWriteBaseline,
): current is Extract<DeploymentPreviewFileState, { state: "present" }> {
    return (
        current.state === "present" &&
        current.contentHash === baseline.baselineState.appliedPayload.contentHash &&
        current.executable === baseline.baselineState.appliedExecutable
    );
}

function statesEqual(
    left: Extract<DeploymentPreviewFileState, { state: "present" }>,
    right: Extract<DeploymentPreviewFileState, { state: "present" }>,
): boolean {
    return left.contentHash === right.contentHash && left.executable === right.executable;
}

function textByteLength(state: DeploymentPreviewFileState): number {
    return state.state === "present" && state.contentKind === "text" ? state.byteSize : 0;
}

function previewFingerprintInput(
    input: {
        deploymentId: UuidV4;
        renderInputFingerprint: Sha256Digest;
        selectionFingerprint: Sha256Digest;
        compilationFingerprint: Sha256Digest;
    },
    replacementScope: DeploymentPreviewReplacementScope,
    files: DeploymentPreviewFile[],
    directories: DeploymentPreviewDirectory[],
): DeploymentRenderPreviewFingerprintInput {
    const stateReceipt = (state: DeploymentPreviewFileState) =>
        state.state === "missing"
            ? ({ state: "missing" } as const)
            : {
                  state: "present" as const,
                  contentKind: state.contentKind,
                  contentHash: state.contentHash,
                  byteSize: state.byteSize,
                  executable: state.executable,
              };
    return {
        deploymentId: input.deploymentId,
        renderInputFingerprint: input.renderInputFingerprint,
        selectionFingerprint: input.selectionFingerprint,
        compilationFingerprint: input.compilationFingerprint,
        replacementScope,
        desiredFiles: files
            .filter((file) => file.desired.state === "present")
            .map((file) => ({
                relativePath: file.relativePath,
                desired: stateReceipt(file.desired),
            })),
        desiredDirectories: directories
            .filter((directory) => directory.desiredState === "present")
            .map((directory) => ({
                managedBoundaryRelativePath: directory.managedBoundaryRelativePath,
                relativePath: directory.relativePath,
            })),
        protectedFiles: files
            .filter((file) => !isCompleteReplacement(replacementScope, file.relativePath))
            .map((file) => ({
                relativePath: file.relativePath,
                baselineState: file.baselineState,
                changeKind: file.changeKind,
                current: stateReceipt(file.current),
                desired: stateReceipt(file.desired),
            })),
        protectedDirectories: directories
            .filter((directory) => !isCompleteReplacement(replacementScope, directory.relativePath))
            .map((directory) => ({ ...directory })),
    };
}

function targetReplacementScope(plan: TargetPlan): DeploymentPreviewReplacementScope {
    const directoryPaths = plan.managedDirectoryBoundaries.map((boundary) => boundary.relativePath);
    return {
        filePaths: plan.targetFiles
            .filter(
                (file) =>
                    file.containerPatchPreimageHash === undefined &&
                    !directoryPaths.some((boundary) => file.relativePath.startsWith(`${boundary}/`)),
            )
            .map((file) => file.relativePath)
            .sort(compareUtf8Bytes),
        directoryPaths,
    };
}

function isCompleteReplacement(scope: DeploymentPreviewReplacementScope, relativePath: string): boolean {
    return (
        scope.filePaths.some((file) => file === relativePath) ||
        scope.directoryPaths.some((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`))
    );
}

function requireManagedBoundary(
    boundaryPaths: readonly string[],
    relativePath: string,
): TargetPlan["managedDirectoryBoundaries"][number]["relativePath"] {
    const matches = boundaryPaths.filter((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`));
    if (matches.length !== 1) throw new Error("preview directory does not belong to one exact managed boundary");
    return matches[0] as TargetPlan["managedDirectoryBoundaries"][number]["relativePath"];
}

export class DeploymentPreWritePreviewError extends Error {
    public constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "DeploymentPreWritePreviewError";
    }
}
