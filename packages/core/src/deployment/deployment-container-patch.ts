/** Action-time resolution of reviewed fragment materializations against live target containers. */

import type { MaterializedRenderFile } from "../contracts/render";
import type { CoreResult, OperationDiagnostic } from "../types";
import { completeResult } from "../foundation/core-result";
import { replaceJsoncTopLevelPropertyValue } from "../foundation/jsonc-top-level-property";
import { isCanonicalRelativePath } from "../foundation/validators";
import type { CoreRenderMaterializationView } from "../render/render-materialization";
import type { CoreMaterializedRenderFile } from "../render/render-materialization-contract";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { absPath, createTargetIo, ioReadStableIfPresent } from "./deployment-target-io";

const MAX_JSONC_PATCH_CONTAINER_BYTES = 4 * 1024 * 1024;

export interface DeploymentContainerPatchIntent {
    relativePath: string;
    propertyName: string;
    fragment: Uint8Array;
}

export interface CapturedDeploymentContainerPatchTarget {
    relativePath: string;
    currentBytes: Uint8Array | null;
}

export function deploymentContainerPatchIntents(
    materialization: CoreRenderMaterializationView,
): DeploymentContainerPatchIntent[] {
    return materialization.units.flatMap((unit) =>
        unit.files.flatMap((file) => {
            if (file.containerPatch === undefined) return [];
            if (
                file.content.contentKind !== "binary" ||
                file.executable ||
                file.containerPatch.patchKind !== "jsonc_top_level_property_value"
            ) {
                throw new ContainerPatchFailure(
                    "render.materialization_container_patch_rejected",
                    "JSONC container patch must contain non-executable binary fragment bytes",
                    "unsupported",
                );
            }
            return [
                {
                    relativePath: file.relativePath,
                    propertyName: file.containerPatch.propertyName,
                    fragment: new Uint8Array(file.content.bytes),
                },
            ];
        }),
    );
}

/** Read one complete set of reviewed container intents inside the selected target binding. */
export function captureDeploymentContainerPatchTargets(
    intents: readonly DeploymentContainerPatchIntent[],
    targetRootPath: string,
): CoreResult<CapturedDeploymentContainerPatchTarget[]> {
    try {
        for (const intent of intents) {
            if (!isCanonicalRelativePath(intent.relativePath)) throw new Error("noncanonical JSONC patch target");
            replaceJsoncTopLevelPropertyValue(null, intent.propertyName, intent.fragment);
        }
        const context = createTargetIo(targetRootPath);
        return completeResult(
            [...new Set(intents.map((intent) => intent.relativePath))].map((relativePath) => ({
                relativePath,
                currentBytes: readContainer(context, relativePath),
            })),
        );
    } catch (error) {
        return failed(error);
    }
}

/** Preserve materialization authority and apply the original patch algorithm to captured target bytes. */
export function resolveCapturedDeploymentContainerPatches(
    materialization: CoreRenderMaterializationView,
    captured: readonly CapturedDeploymentContainerPatchTarget[],
): CoreResult<CoreRenderMaterializationView> {
    try {
        const paths = new Set(deploymentContainerPatchIntents(materialization).map((intent) => intent.relativePath));
        const targets = new Map(captured.map((target) => [target.relativePath, target.currentBytes]));
        if (
            targets.size !== captured.length ||
            targets.size !== paths.size ||
            [...targets.keys()].some((path) => !paths.has(path))
        ) {
            throw new Error("captured container targets do not match the reviewed materialization");
        }
        const resolved = structuredClone(materialization);
        resolved.units = resolved.units.map((unit) => ({
            ...unit,
            files: resolveFilesWithRead(unit.files, (relativePath) => {
                const bytes = targets.get(relativePath);
                if (bytes === undefined || (bytes !== null && !(bytes instanceof Uint8Array)))
                    throw new Error("invalid captured container bytes");
                requireContainerSize(bytes);
                return bytes === null ? null : new Uint8Array(bytes);
            }),
        }));
        return completeResult(resolved);
    } catch (error) {
        return failed(error);
    }
}

export function resolveDeploymentContainerPatches(
    materialization: CoreRenderMaterializationView,
    targetRootPath: string,
): CoreResult<CoreRenderMaterializationView> {
    try {
        const resolved = structuredClone(materialization);
        resolved.units = resolved.units.map((unit) => ({
            ...unit,
            files: resolveFiles(unit.files, targetRootPath),
        }));
        return completeResult(resolved);
    } catch (error) {
        return failed(error);
    }
}

function resolveFiles(files: readonly MaterializedRenderFile[], targetRootPath: string): CoreMaterializedRenderFile[] {
    const context = createTargetIo(targetRootPath);
    return resolveFilesWithRead(files, (relativePath) => readContainer(context, relativePath));
}

function readContainer(context: ReturnType<typeof createTargetIo>, relativePath: string): Uint8Array | null {
    let current: Uint8Array | null;
    try {
        current = ioReadStableIfPresent(context, absPath(context, relativePath))?.bytes ?? null;
    } catch (error) {
        throw new ContainerPatchFailure(
            "render.materialization_container_patch_target_unavailable",
            `cannot read the exact JSONC patch target ${relativePath}: ${String(error)}`,
            "unavailable",
            true,
        );
    }
    requireContainerSize(current);
    return current;
}

function requireContainerSize(current: Uint8Array | null): void {
    if (current !== null && current.byteLength > MAX_JSONC_PATCH_CONTAINER_BYTES) {
        throw new ContainerPatchFailure(
            "render.materialization_container_patch_limit",
            `JSONC patch target exceeds the ${MAX_JSONC_PATCH_CONTAINER_BYTES}-byte limit`,
            "unsupported",
        );
    }
}

function resolveFilesWithRead(
    files: readonly MaterializedRenderFile[],
    readCurrent: (relativePath: string) => Uint8Array | null,
): CoreMaterializedRenderFile[] {
    return files.map((file) => {
        if (file.containerPatch === undefined) return structuredClone(file);
        const current = readCurrent(file.relativePath);
        try {
            if (file.content.contentKind !== "binary" || file.executable) {
                throw new Error("JSONC container patch must contain non-executable binary fragment bytes");
            }
            const bytes = replaceJsoncTopLevelPropertyValue(current, file.containerPatch.propertyName, file.content.bytes);
            const { containerPatch: _patch, ...result } = file;
            return {
                ...result,
                content: { contentKind: "binary" as const, bytes },
                containerPatchPreimageHash: current === null ? null : sha256Bytes(current),
            };
        } catch (error) {
            throw new ContainerPatchFailure(
                "render.materialization_container_patch_rejected",
                `cannot apply the reviewed JSONC property patch at ${file.relativePath}: ${String(error)}`,
                "unsupported",
            );
        }
    });
}

class ContainerPatchFailure extends Error {
    public constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"],
        readonly retryable = false,
    ) {
        super(message);
    }
}

function failed<T>(error: unknown): CoreResult<T> {
    const known = error instanceof ContainerPatchFailure;
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code: known ? error.code : "render.materialization_container_patch_internal_error",
                message: known ? error.message : String(error),
                operation: "render",
                causeKind: known ? error.causeKind : "internal_error",
                path: "",
                traceId: "",
                retryable: known ? error.retryable : false,
                suggestedActions: [],
                rawSummary: "",
            },
        ],
    };
}

/** Narrow test seam for live-target patch resolution. */
export const deploymentContainerPatchInternalsForTest = Object.freeze({ resolveFiles });
