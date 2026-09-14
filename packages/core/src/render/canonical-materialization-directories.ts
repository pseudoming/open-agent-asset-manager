/** Project complete directory authority only from the current immutable Version graph. */

import type { VersionNativeRepresentation } from "../contracts/persistence";
import type { PosixRelativePath } from "../contracts/primitives";
import type { RenderAssetInput, RenderVersionDialectInputs } from "../contracts/render";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isCanonicalRelativePath } from "../foundation/validators";
import { hasExactNativeDirectoryGraph } from "./native-directory-graph";

/** Undefined directory facts are historical/absent; null rejects an ambiguous or inconsistent graph. */
export function projectCanonicalDirectoryAuthority(
    asset: RenderAssetInput,
    available: RenderVersionDialectInputs,
): { logicalDirectoryPaths?: PosixRelativePath[] } | null {
    if (
        available.targetVersion.assetId !== asset.version.ref.assetId ||
        available.targetVersion.versionId !== asset.version.ref.versionId
    )
        return null;
    const graphs = available.inputs.filter(
        (
            input,
        ): input is Extract<RenderVersionDialectInputs["inputs"][number], { inputKind: "native_representation" }> & {
            representation: Extract<VersionNativeRepresentation, { schemaVersion: 2 }>;
        } =>
            input.inputKind === "native_representation" &&
            input.inputRole === "current_exact" &&
            input.representation.schemaVersion === 2,
    );
    if (graphs.length === 0) return {};
    const logicalPaths = asset.version.files.map((file) => file.file.logicalPath);
    if (new Set(logicalPaths).size !== logicalPaths.length || logicalPaths.some((path) => !isCanonicalRelativePath(path)))
        return null;
    const projected: PosixRelativePath[][] = [];
    for (const graph of graphs) {
        const nativePaths = graph.files.map((file) => file.relativePath);
        if (nativePaths.length !== logicalPaths.length || new Set(nativePaths).size !== nativePaths.length) return null;
        const first = logicalPaths[0];
        if (first === undefined) return null;
        const roots = nativePaths
            .filter((path) => path.endsWith(`/${first}`))
            .map((path) => path.slice(0, -first.length - 1) as PosixRelativePath)
            .filter(
                (root) =>
                    isCanonicalRelativePath(root) &&
                    logicalPaths.every((path) => nativePaths.includes(`${root}/${path}` as PosixRelativePath)),
            );
        const root = roots[0];
        if (
            roots.length !== 1 ||
            root === undefined ||
            !hasExactNativeDirectoryGraph(graph.representation.directories, nativePaths, [root])
        )
            return null;
        projected.push(
            graph.representation.directories
                .filter((path) => path !== root)
                .map((path) => path.slice(root.length + 1) as PosixRelativePath),
        );
    }
    const directories = projected[0];
    if (directories === undefined || projected.some((paths) => stableStringify(paths) !== stableStringify(directories)))
        return null;
    return { logicalDirectoryPaths: [...directories] };
}

/** A complete foreign directory graph must retain every root-relative file and directory path. */
export function projectCanonicalOutputDirectories(
    logicalDirectoryPaths: readonly PosixRelativePath[] | undefined,
    projection: {
        files: readonly { nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }[];
        managedDirectoryBoundaries: readonly PosixRelativePath[];
    },
): PosixRelativePath[] | null {
    if (logicalDirectoryPaths === undefined) return null;
    const [root] = projection.managedDirectoryBoundaries;
    if (
        projection.managedDirectoryBoundaries.length !== 1 ||
        root === undefined ||
        logicalDirectoryPaths.some((path) => !isCanonicalRelativePath(path)) ||
        new Set(logicalDirectoryPaths).size !== logicalDirectoryPaths.length ||
        stableStringify([...logicalDirectoryPaths].sort(compareUtf8Bytes)) !== stableStringify(logicalDirectoryPaths) ||
        projection.files.some((file) => file.nativeRelativePath !== `${root}/${file.canonicalLogicalPath}`)
    )
        return null;
    const directories = [root, ...logicalDirectoryPaths.map((path) => `${root}/${path}` as PosixRelativePath)].sort(
        compareUtf8Bytes,
    );
    return hasExactNativeDirectoryGraph(
        directories,
        projection.files.map((file) => file.nativeRelativePath),
        [root],
    )
        ? directories
        : null;
}
