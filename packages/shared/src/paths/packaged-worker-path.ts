import { win32 } from "node:path";

/** Resolve one trusted Windows package entry to its physical unpacked location. */
export function resolveWin32PackagedWorkerPath(resolvedWorkerPath: string): string {
    if (
        resolvedWorkerPath.length === 0 ||
        resolvedWorkerPath.length > 32_767 ||
        resolvedWorkerPath.includes("\0") ||
        !win32.isAbsolute(resolvedWorkerPath) ||
        win32.normalize(resolvedWorkerPath) !== resolvedWorkerPath
    ) {
        throw new TypeError("worker path must be one canonical absolute Windows path");
    }

    const archiveSegment = `${win32.sep}app.asar${win32.sep}`;
    const lowerPath = resolvedWorkerPath.toLowerCase();
    const archiveIndex = lowerPath.indexOf(archiveSegment);
    if (archiveIndex < 0) return resolvedWorkerPath;
    if (lowerPath.indexOf(archiveSegment, archiveIndex + archiveSegment.length) >= 0) {
        throw new TypeError("worker path contains more than one Electron archive boundary");
    }

    return `${resolvedWorkerPath.slice(0, archiveIndex)}${win32.sep}app.asar.unpacked${win32.sep}${resolvedWorkerPath.slice(
        archiveIndex + archiveSegment.length,
    )}`;
}
