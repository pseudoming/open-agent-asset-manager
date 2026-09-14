/** Core-owned pre-analysis receipts for shared Memory Catalog targets. */

import { readRegularFileNoFollow, SafeFilesystemError } from "@oaam/shared/filesystem";
import { joinPhysicalAccessPath } from "@oaam/shared/paths";
import { binaryPayloadStats } from "../catalog/payload-store";
import type { ProviderRenderDialectInputsForAsset, RenderAssetInput, RenderTargetFileSnapshotV1 } from "../contracts/render";
import type { PosixRelativePath } from "../types";
import { isCanonicalRelativePath } from "../foundation/validators";
import { compareUtf8Bytes } from "../foundation/text-order";
import { versionRefKey } from "../render/render-semantics";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";

const MAXIMUM_SHARED_TARGET_BYTES = 4 * 1024 * 1024;
const MAXIMUM_SHARED_TARGET_PATHS = 16;

export type CaptureMemoryCatalogTargets = (
    paths: readonly PosixRelativePath[],
    targetRootPath: string,
) => RenderTargetFileSnapshotV1[];

export function captureMemoryCatalogTargetFileSnapshots(
    input: {
        targetRootPath: string;
        assets: readonly RenderAssetInput[];
        dialectInputs: readonly ProviderRenderDialectInputsForAsset[];
    },
    capture: CaptureMemoryCatalogTargets = captureMemoryCatalogTargets,
): RenderTargetFileSnapshotV1[] {
    const catalogVersions = new Set(
        input.assets
            .filter(
                (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog",
            )
            .map((asset) => versionRefKey(asset.version.ref)),
    );
    if (catalogVersions.size === 0) return [];
    const paths = new Set<PosixRelativePath>();
    for (const group of input.dialectInputs) {
        if (!catalogVersions.has(versionRefKey(group.targetVersion))) continue;
        for (const dialectInput of group.inputs) {
            if (dialectInput.inputKind !== "native_representation") continue;
            for (const file of dialectInput.files) {
                if (!isCanonicalRelativePath(file.relativePath)) {
                    throw snapshotFailure(
                        "render.shared_target_path_invalid",
                        "Memory Catalog native target path is not canonical",
                        false,
                    );
                }
                paths.add(file.relativePath);
            }
        }
    }
    if (paths.size === 0 || paths.size > MAXIMUM_SHARED_TARGET_PATHS) {
        throw snapshotFailure(
            "render.shared_target_path_closure_invalid",
            "Memory Catalog target snapshot requires a bounded non-empty native path closure",
            false,
        );
    }
    return capture([...paths].sort(compareUtf8Bytes), input.targetRootPath);
}

/** Read only the exact declared Catalog paths, with the original per-file byte bound. */
export function captureMemoryCatalogTargets(
    paths: readonly PosixRelativePath[],
    targetRootPath: string,
): RenderTargetFileSnapshotV1[] {
    if (!isMemoryCatalogTargetPaths(paths))
        throw snapshotFailure(
            "render.shared_target_path_closure_invalid",
            "Memory Catalog target snapshot requires a bounded non-empty native path closure",
            false,
        );
    return paths.map((relativePath) => captureOne(targetRootPath, relativePath));
}

export function isMemoryCatalogTargetPaths(value: unknown): value is PosixRelativePath[] {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= MAXIMUM_SHARED_TARGET_PATHS &&
        value.every(isCanonicalRelativePath) &&
        new Set(value).size === value.length &&
        JSON.stringify(value) === JSON.stringify([...value].sort(compareUtf8Bytes))
    );
}

function captureOne(targetRootPath: string, relativePath: PosixRelativePath): RenderTargetFileSnapshotV1 {
    const absolutePath = joinPhysicalAccessPath(targetRootPath, relativePath);
    try {
        const current = readRegularFileNoFollow(absolutePath, MAXIMUM_SHARED_TARGET_BYTES);
        const stats = binaryPayloadStats(current.bytes);
        return {
            relativePath,
            snapshotState: "present",
            contentHash: stats.contentHash,
            byteSize: stats.byteSize,
            executable: current.executable,
        };
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
            return { relativePath, snapshotState: "missing" };
        }
        throw snapshotFailure(
            "render.shared_target_unavailable",
            `Memory Catalog target snapshot failed for ${relativePath}: ${String(error)}`,
            true,
        );
    }
}

function snapshotFailure(code: string, message: string, retryable: boolean): DeploymentRenderFailure {
    return new DeploymentRenderFailure(code, message, "unavailable", retryable, []);
}
