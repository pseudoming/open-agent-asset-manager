import { SafeFilesystemError, type StableRegularFileRead } from "../../filesystem/filesystem-types";
import {
    type PlatformContextRegularFileReadInput,
    type PlatformContextRegularFileSnapshot,
    snapshotStableRegularFileRead,
    validatePlatformContextRegularFileReadInput,
    validatePlatformContextRegularFileSnapshotInput,
} from "../path-environment";
import { loadWin32NativeFilesystemAddon, type Win32NativeFilesystemAddon } from "./native-addon";
import { isAnyWslPath } from "./selected-wsl-helper-paths";

interface PlatformContextRegularFileDependencies {
    readonly readRegularFileNoFollow: (filePath: string, maximumBytes?: number) => StableRegularFileRead;
}

let native: Win32NativeFilesystemAddon | null = null;
const DEFAULT_DEPENDENCIES: PlatformContextRegularFileDependencies = {
    readRegularFileNoFollow: (filePath, maximumBytes = Number.MAX_SAFE_INTEGER) => {
        native ??= loadWin32NativeFilesystemAddon();
        return native.readRegularFile(filePath, maximumBytes);
    },
};

/** Windows owns only its local file reads; selected WSL observations execute inside Linux. */
export function createWin32PlatformContextRegularFileReader(
    overrides: Partial<PlatformContextRegularFileDependencies> = {},
): (input: PlatformContextRegularFileReadInput) => StableRegularFileRead {
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
    return (input) => {
        validatePlatformContextRegularFileReadInput(input);
        if (input.platform === "wsl" || isAnyWslPath(input.filePath)) {
            throw new SafeFilesystemError({
                failureKind: "unsupported_platform",
                operation: "read_regular_file",
                targetPath: input.filePath,
                systemCode: "WSL_READ_REQUIRES_LINUX_EXECUTION",
                message: "selected WSL files must be read in their Linux execution context",
            });
        }
        return dependencies.readRegularFileNoFollow(input.filePath, input.maximumBytes);
    };
}

export const readPlatformContextRegularFileNoFollow = createWin32PlatformContextRegularFileReader();

export async function readPlatformContextRegularFileNoFollowBounded(
    input: PlatformContextRegularFileReadInput,
    timeoutMilliseconds: number,
): Promise<StableRegularFileRead> {
    validatePlatformContextRegularFileSnapshotInput(input, timeoutMilliseconds);
    return readPlatformContextRegularFileNoFollow(input);
}

export async function snapshotPlatformContextRegularFileNoFollowBounded(
    input: PlatformContextRegularFileReadInput,
    timeoutMilliseconds: number,
): Promise<PlatformContextRegularFileSnapshot> {
    validatePlatformContextRegularFileSnapshotInput(input, timeoutMilliseconds);
    return snapshotStableRegularFileRead(readPlatformContextRegularFileNoFollow(input));
}
