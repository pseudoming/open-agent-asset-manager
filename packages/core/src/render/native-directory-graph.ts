/** Core logical checks for an immutable owned directory graph. */

import type { PosixRelativePath } from "../contracts/primitives";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isCanonicalRelativePath } from "../foundation/validators";
import { isStrictDescendant } from "./render-inspection-primitives";

export function hasExactNativeDirectoryGraph(
    directoryPaths: readonly PosixRelativePath[],
    filePaths: readonly PosixRelativePath[],
    boundaries: readonly PosixRelativePath[],
): boolean {
    if (
        directoryPaths.length === 0 ||
        new Set(directoryPaths).size !== directoryPaths.length ||
        stableStringify([...directoryPaths].sort(compareUtf8Bytes)) !== stableStringify(directoryPaths) ||
        directoryPaths.some((path) => !isCanonicalRelativePath(path) || filePaths.includes(path)) ||
        boundaries.some((boundary) => !directoryPaths.includes(boundary))
    ) {
        return false;
    }
    const directorySet = new Set<string>(directoryPaths);
    const ownerFor = (path: string): PosixRelativePath | null => {
        const owners = boundaries.filter((boundary) => path === boundary || isStrictDescendant(path, boundary));
        return owners.length === 1 ? (owners[0] as PosixRelativePath) : null;
    };
    if (directoryPaths.some((path) => ownerFor(path) === null) || filePaths.some((path) => ownerFor(path) === null)) {
        return false;
    }
    for (const path of [...directoryPaths, ...filePaths]) {
        const boundary = ownerFor(path) as PosixRelativePath;
        if (path === boundary) continue;
        let current = path.slice(0, path.lastIndexOf("/"));
        while (current !== boundary) {
            if (!directorySet.has(current)) return false;
            current = current.slice(0, current.lastIndexOf("/"));
        }
    }
    return true;
}
