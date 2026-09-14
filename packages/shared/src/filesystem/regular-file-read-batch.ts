import { isCanonicalPhysicalAccessPath } from "../paths/physical-access-paths";
import { SafeFilesystemError, type StableRegularFileRead } from "./filesystem-types";

export interface BoundedRegularFileReadInput {
    readonly filePath: string;
    readonly maximumBytes: number;
}

/** Validate the whole bounded request before any filesystem access. */
export function validateRegularFileReadBatch(
    inputs: readonly BoundedRegularFileReadInput[],
    maximumTotalBytes: number,
): readonly BoundedRegularFileReadInput[] {
    if (
        !Array.isArray(inputs) ||
        inputs.length > 64 ||
        !Number.isSafeInteger(maximumTotalBytes) ||
        maximumTotalBytes < 0 ||
        maximumTotalBytes > 128 * 1_024 * 1_024
    ) {
        throw readBatchLimit("", "regular-file batch exceeds its entry or retained-byte bound");
    }
    const seen = new Set<string>();
    return Array.from(inputs, (input) => {
        if (
            input === null ||
            typeof input !== "object" ||
            !isCanonicalPhysicalAccessPath(input.filePath) ||
            seen.has(input.filePath)
        ) {
            throw new SafeFilesystemError({
                failureKind: "invalid_path",
                operation: "read_regular_file",
                targetPath: "",
                systemCode: "INVALID_READ_BATCH_PATH",
                message: "regular-file batch paths must be canonical and unique",
            });
        }
        if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 0) {
            throw readBatchLimit(input.filePath, "regular-file batch item has an invalid byte bound");
        }
        seen.add(input.filePath);
        return { filePath: input.filePath, maximumBytes: input.maximumBytes };
    });
}

/** The serial target implementation has the same bounded, all-or-error result contract. */
export function readRegularFileBatchSequentially(
    inputs: readonly BoundedRegularFileReadInput[],
    maximumTotalBytes: number,
    read: (filePath: string, maximumBytes: number) => StableRegularFileRead,
): StableRegularFileRead[] {
    const request = validateRegularFileReadBatch(inputs, maximumTotalBytes);
    const results: StableRegularFileRead[] = [];
    let remaining = maximumTotalBytes;
    try {
        for (const input of request) {
            const result = readBatchFile(input, remaining, read);
            results.push(result);
            remaining -= result.bytes.byteLength;
            if (remaining < 0 || result.bytes.byteLength > input.maximumBytes) {
                throw readBatchLimit(input.filePath, "regular-file batch result exceeds its byte bound");
            }
        }
        return results;
    } catch (error) {
        for (const result of results) result.bytes.fill(0);
        throw error;
    }
}

/** A smaller transport/retention bound is not the caller's per-file bound. */
export function readBatchFile(
    input: BoundedRegularFileReadInput,
    remainingBytes: number,
    read: (filePath: string, maximumBytes: number) => StableRegularFileRead,
): StableRegularFileRead {
    const maximumBytes = Math.min(input.maximumBytes, remainingBytes);
    try {
        return read(input.filePath, maximumBytes);
    } catch (error) {
        if (maximumBytes < input.maximumBytes && error instanceof SafeFilesystemError && error.failureKind === "resource_limit") {
            throw readBatchCapacity(input.filePath);
        }
        throw error;
    }
}

export function readBatchCapacity(targetPath: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "resource_limit",
        operation: "read_regular_file",
        targetPath,
        systemCode: "READ_BATCH_CAPACITY",
        message: "the complete read exceeds this batch's transport or retention capacity",
    });
}

export function readBatchLimit(targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "resource_limit",
        operation: "read_regular_file",
        targetPath,
        systemCode: "READ_BATCH_LIMIT",
        message,
    });
}
