import type { ReadFilesystem } from "../../../src/adapters/adapter-read-physical-authority";

type SingleReadFilesystem = Pick<ReadFilesystem, "readRegularFileNoFollow" | "inventoryDirectoryNoFollow">;

/** Preserve existing per-file fault seams while giving each batch result its own transferred bytes. */
export function withReadBatch(filesystem: SingleReadFilesystem): ReadFilesystem {
    return {
        ...filesystem,
        readRegularFilesNoFollow(inputs, maximumTotalBytes) {
            let remaining = maximumTotalBytes;
            const reads: ReturnType<ReadFilesystem["readRegularFilesNoFollow"]> = [];
            try {
                for (const input of inputs) {
                    const read = filesystem.readRegularFileNoFollow(input.filePath, Math.min(input.maximumBytes, remaining));
                    reads.push({ ...read, bytes: new Uint8Array(read.bytes) });
                    remaining -= read.bytes.byteLength;
                    if (remaining < 0) throw new Error("test filesystem exceeded the batch byte limit");
                }
                return reads;
            } catch (error) {
                for (const read of reads) read.bytes.fill(0);
                throw error;
            }
        },
    };
}
