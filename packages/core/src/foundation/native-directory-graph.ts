/** Strict immutable native-directory membership shared by import, reopen, and render. */

import { compareUtf8Bytes } from "./text-order";
import { isCanonicalRelativePath } from "./validators";

export function isCompleteNativeDirectoryGraph(directories: readonly string[], files: readonly string[]): boolean {
    const directorySet = new Set(directories);
    const fileSet = new Set(files);
    const ownsRepresentationRoot = files.some((file) => !file.includes("/"));
    if (
        directories.length === 0 ||
        directorySet.size !== directories.length ||
        [...directories].sort(compareUtf8Bytes).some((path, index) => path !== directories[index]) ||
        directories.some((directory) => !isCanonicalRelativePath(directory) || fileSet.has(directory)) ||
        files.some((file) => !isCanonicalRelativePath(file))
    ) {
        return false;
    }
    for (const directory of directories) {
        const separator = directory.lastIndexOf("/");
        if (separator < 0) continue;
        const parent = directory.slice(0, separator);
        const belongsToOwnedRoot =
            ownsRepresentationRoot ||
            directories.some((candidate) => candidate !== directory && directory.startsWith(`${candidate}/`));
        if (belongsToOwnedRoot && !directorySet.has(parent)) return false;
    }
    return files.every((file) => {
        const separator = file.lastIndexOf("/");
        return separator < 0 || directorySet.has(file.slice(0, separator));
    });
}
