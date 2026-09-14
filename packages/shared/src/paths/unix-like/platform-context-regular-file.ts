import type { StableRegularFileRead } from "../../filesystem/filesystem-types";
import { type PlatformContextRegularFileReadInput, validatePlatformContextRegularFileReadInput } from "../path-environment";
import { readRegularFileNoFollow } from "./safe-filesystem";

export function readPlatformContextRegularFileNoFollow(input: PlatformContextRegularFileReadInput): StableRegularFileRead {
    validatePlatformContextRegularFileReadInput(input);
    return readRegularFileNoFollow(input.filePath, input.maximumBytes);
}
