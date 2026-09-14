import { posix, win32 } from "node:path";
import { SafeFilesystemError } from "../filesystem/filesystem-types";
import type { PlatformContextRegularFileReadInput } from "./path-environment";
import { isSafeDistroName } from "./wsl-distro-discovery";

/** Pure path-coordinate conversion for one exact selected distribution and access root. */
export function createSelectedWslPathProjection(distroName: string, hostAccessRootPath: string) {
    const executionAccessRootPath = selectedWslRuntimeRootPath(distroName, hostAccessRootPath, hostAccessRootPath);
    const accessSegments = selectedWslUncSegments(hostAccessRootPath, distroName, true, hostAccessRootPath);
    function toExecution(hostPath: string): string {
        const segments = selectedWslUncSegments(hostPath, distroName, true, hostPath);
        if (segments.length < accessSegments.length || accessSegments.some((segment, index) => segment !== segments[index])) {
            throw invalidSelectedWslProjection(hostPath, "selected WSL path is outside its exact access root");
        }
        return `/${segments.join("/")}`;
    }
    function toHost(executionPath: string): string {
        if (
            !posix.isAbsolute(executionPath) ||
            posix.normalize(executionPath) !== executionPath ||
            executionPath.normalize("NFC") !== executionPath ||
            executionPath.includes("\0") ||
            (executionPath !== "/" && executionPath.endsWith("/"))
        ) {
            throw invalidSelectedWslProjection(executionPath, "selected WSL execution path is not canonical");
        }
        const hostPath = `\\\\wsl.localhost\\${distroName}\\${executionPath.slice(1).split("/").join("\\")}`;
        if (toExecution(hostPath) !== executionPath) {
            throw invalidSelectedWslProjection(executionPath, "selected WSL path does not round-trip exactly");
        }
        return hostPath;
    }
    return Object.freeze({ executionAccessRootPath, toExecution, toHost });
}

/** Match one exact selected-WSL Host root to its canonical local execution root. */
export function isSelectedWslPhysicalRootMapping(hostRootPath: string, executionRootPath: string, distroName: string): boolean {
    if (
        !isSafeDistroName(distroName) ||
        !posix.isAbsolute(executionRootPath) ||
        posix.normalize(executionRootPath) !== executionRootPath ||
        executionRootPath.normalize("NFC") !== executionRootPath ||
        executionRootPath === "/" ||
        executionRootPath.includes("\0")
    ) {
        return false;
    }
    if (hostRootPath === executionRootPath) return true;
    try {
        return selectedWslRuntimeRootPath(distroName, hostRootPath, hostRootPath) === executionRootPath;
    } catch {
        return false;
    }
}

/** @internal Exact Host-visible projection shared by selected-WSL read owners. */
export function selectedWslRuntimePath(input: PlatformContextRegularFileReadInput): string {
    if (!isSafeDistroName(input.platformInstanceId)) {
        throw invalidSelectedWslProjection(input.filePath, "selected WSL distribution identity is invalid");
    }
    const accessSegments = selectedWslUncSegments(input.accessRootPath, input.platformInstanceId, true, input.filePath);
    const fileSegments = selectedWslUncSegments(input.filePath, input.platformInstanceId, false, input.filePath);
    if (
        fileSegments.length <= accessSegments.length ||
        accessSegments.some((segment, index) => fileSegments[index] !== segment)
    ) {
        throw invalidSelectedWslProjection(input.filePath, "selected WSL file is outside its exact access root");
    }
    return `/${fileSegments.join("/")}`;
}

/** @internal Exact selected access-root projection used by the target-side batch helper. */
export function selectedWslRuntimeRootPath(platformInstanceId: string, accessRootPath: string, targetPath: string): string {
    if (!isSafeDistroName(platformInstanceId)) {
        throw invalidSelectedWslProjection(targetPath, "selected WSL distribution identity is invalid");
    }
    const segments = selectedWslUncSegments(accessRootPath, platformInstanceId, true, targetPath);
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function selectedWslUncSegments(
    value: string,
    distroName: string,
    allowDistroRoot: boolean,
    targetPath: string,
): readonly string[] {
    const distroRoot = `\\\\wsl.localhost\\${distroName}\\`;
    if (
        value.length > 32_767 ||
        value.normalize("NFC") !== value ||
        win32.normalize(value) !== value ||
        !value.startsWith(distroRoot)
    ) {
        throw invalidSelectedWslProjection(targetPath, "selected WSL path does not use its exact canonical distribution root");
    }
    const relative = value.slice(distroRoot.length);
    if (relative === "") {
        if (allowDistroRoot) return Object.freeze([]);
        throw invalidSelectedWslProjection(targetPath, "selected WSL file does not identify a regular-file child");
    }
    if (value.endsWith(win32.sep)) {
        throw invalidSelectedWslProjection(targetPath, "selected WSL child path has a non-canonical trailing separator");
    }
    const segments = relative.split(win32.sep);
    if (segments.some((segment) => !isCanonicalWin32Segment(segment))) {
        throw invalidSelectedWslProjection(targetPath, "selected WSL path contains an ambiguous segment");
    }
    return Object.freeze(segments);
}

function isCanonicalWin32Segment(value: string): boolean {
    return (
        value.length > 0 &&
        value !== "." &&
        value !== ".." &&
        !value.endsWith(".") &&
        !value.endsWith(" ") &&
        ![...value].some(isForbiddenWin32SegmentCharacter)
    );
}

function isForbiddenWin32SegmentCharacter(value: string): boolean {
    const codePoint = value.codePointAt(0);
    return (codePoint !== undefined && codePoint < 0x20) || '"<>|?*:/\\'.includes(value);
}

function invalidSelectedWslProjection(targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "invalid_path",
        operation: "read_regular_file",
        targetPath,
        systemCode: "INVALID_SELECTED_WSL_PROJECTION",
        message,
    });
}
