/** Physical committed SQLite image capture. No SQL is executed and no source or sidecar is written. */
import { type BigIntStats, lstatSync } from "node:fs";
import { inspectFilesystemFailure } from "../filesystem/filesystem-facts";

const MAX_REGISTRY_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_MILLISECONDS = 5_000;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

type SnapshotFailureCode = "sqlite_snapshot_unstable" | "sqlite_snapshot_wal_invalid" | "sqlite_snapshot_journal_active";

export class CommittedSqliteSnapshotError extends Error {
    public constructor(
        public readonly code: SnapshotFailureCode,
        message: string,
    ) {
        super(message);
        this.name = "CommittedSqliteSnapshotError";
    }
}

export interface CommittedSqliteSnapshotDependencies {
    readonly read: (filePath: string, maximumBytes: number) => Uint8Array;
    readonly stat: (filePath: string) => BigIntStats;
    readonly now: () => number;
}

export function captureCommittedSqliteSnapshot(
    registryPath: string,
    read: CommittedSqliteSnapshotDependencies["read"],
    overrides: Partial<CommittedSqliteSnapshotDependencies> = {},
): Buffer {
    const dependencies: CommittedSqliteSnapshotDependencies = {
        read,
        stat: (filePath) => lstatSync(filePath, { bigint: true }),
        now: () => performance.now(),
        ...overrides,
    };
    const deadline = dependencies.now() + MAX_SNAPSHOT_MILLISECONDS;
    const ensureTime = (): void => {
        if (dependencies.now() > deadline) unstable("SQLite snapshot exceeded its bounded observation time");
    };
    const inspect = (): readonly (string | undefined)[] => {
        ensureTime();
        const main = fileStamp(registryPath, dependencies);
        if (main === undefined) unstable("SQLite database disappeared during observation");
        const wal = fileStamp(`${registryPath}-wal`, dependencies);
        const journal = fileStamp(`${registryPath}-journal`, dependencies, true);
        return [main, wal, journal];
    };
    const before = inspect();
    const main = Buffer.from(dependencies.read(registryPath, MAX_REGISTRY_BYTES));
    const wal = before[1] === undefined ? null : Buffer.from(dependencies.read(`${registryPath}-wal`, MAX_REGISTRY_BYTES));
    assertSameStamps(before, inspect());
    if (!main.equals(dependencies.read(registryPath, MAX_REGISTRY_BYTES))) {
        unstable("SQLite main database changed during snapshot capture");
    }
    if (wal !== null && !wal.equals(dependencies.read(`${registryPath}-wal`, MAX_REGISTRY_BYTES))) {
        unstable("SQLite WAL changed during snapshot capture");
    }
    assertSameStamps(before, inspect());
    const result = committedDatabaseImage(main, wal, ensureTime);
    ensureTime();
    return result;
}

function fileStamp(filePath: string, dependencies: CommittedSqliteSnapshotDependencies, journal = false): string | undefined {
    let stat: BigIntStats;
    try {
        stat = dependencies.stat(filePath);
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.source === "node_errno_error" && failure.systemCode === "ENOENT") return undefined;
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) unstable("SQLite database snapshot requires trusted regular files");
    if (journal && stat.size !== 0n) {
        throw new CommittedSqliteSnapshotError(
            "sqlite_snapshot_journal_active",
            "SQLite database has a rollback journal; a committed snapshot could not be established",
        );
    }
    if (stat.size > BigInt(MAX_REGISTRY_BYTES)) throw new RangeError("SQLite database snapshot file exceeds its byte limit");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function assertSameStamps(before: readonly (string | undefined)[], after: readonly (string | undefined)[]): void {
    if (before.some((stamp, index) => stamp !== after[index]))
        unstable("SQLite main/WAL identity or metadata changed during capture");
}

interface WalFrame {
    readonly page: number;
    readonly offset: number;
}

function committedDatabaseImage(main: Buffer, wal: Buffer | null, ensureTime: () => void): Buffer {
    if (main.length < 100 || !main.subarray(0, 16).equals(SQLITE_HEADER))
        throw new TypeError("SQLite database has an invalid SQLite header");
    const encodedPageSize = main.readUInt16BE(16);
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0 || main.length % pageSize !== 0) {
        invalidWal("SQLite database has an invalid SQLite page size or image length");
    }
    if (wal === null || wal.length === 0) return standalone(main);
    if (main[18] !== 2 || main[19] !== 2 || wal.length < 32) invalidWal("SQLite database and WAL formats are inconsistent");
    const magic = wal.readUInt32BE(0);
    if ((magic !== 0x377f0682 && magic !== 0x377f0683) || wal.readUInt32BE(4) !== 3_007_000 || wal.readUInt32BE(8) !== pageSize)
        invalidWal("SQLite WAL header format or page size is invalid");
    const bigEndianChecksum = magic === 0x377f0683;
    let checksum = updateChecksum(wal, 0, 24, [0, 0], bigEndianChecksum);
    requireChecksum(wal, 24, checksum);
    const salt1 = wal.readUInt32BE(16),
        salt2 = wal.readUInt32BE(20);
    const maximumPages = Math.floor(MAX_REGISTRY_BYTES / pageSize);
    const frames: WalFrame[] = [];
    let committedFrameCount = 0,
        committedPages = 0;
    // SQLite fileformat2 §4: salts terminate a reused WAL generation; only commit-marked prefixes are visible.
    for (let offset = 32; offset < wal.length; offset += 24 + pageSize) {
        ensureTime();
        if (offset + 24 > wal.length) invalidWal("SQLite WAL frame header is truncated");
        if (wal.readUInt32BE(offset + 8) !== salt1 || wal.readUInt32BE(offset + 12) !== salt2) break;
        if (offset + 24 + pageSize > wal.length) invalidWal("SQLite WAL frame content is truncated");
        const page = wal.readUInt32BE(offset),
            databasePages = wal.readUInt32BE(offset + 4);
        if (page === 0 || page > maximumPages || databasePages > maximumPages)
            invalidWal("SQLite WAL exceeds the bounded database page range");
        checksum = updateChecksum(wal, offset, 8, checksum, bigEndianChecksum);
        checksum = updateChecksum(wal, offset + 24, pageSize, checksum, bigEndianChecksum);
        requireChecksum(wal, offset + 16, checksum);
        frames.push({ page, offset: offset + 24 });
        if (databasePages !== 0) {
            committedFrameCount = frames.length;
            committedPages = databasePages;
        }
    }
    if (committedFrameCount === 0) return standalone(main);
    const result = Buffer.alloc(committedPages * pageSize);
    main.copy(result, 0, 0, Math.min(main.length, result.length));
    for (let index = 0; index < committedFrameCount; index += 1) {
        const frame = frames[index];
        if (frame !== undefined && frame.page <= committedPages) {
            wal.copy(result, (frame.page - 1) * pageSize, frame.offset, frame.offset + pageSize);
        }
    }
    if (!result.subarray(0, 16).equals(SQLITE_HEADER)) invalidWal("SQLite committed database header is invalid");
    return standalone(result);
}

function updateChecksum(
    bytes: Buffer,
    offset: number,
    length: number,
    initial: readonly [number, number],
    bigEndian: boolean,
): [number, number] {
    let [first, second] = initial;
    for (let index = offset; index < offset + length; index += 8) {
        const left = bigEndian ? bytes.readUInt32BE(index) : bytes.readUInt32LE(index);
        const right = bigEndian ? bytes.readUInt32BE(index + 4) : bytes.readUInt32LE(index + 4);
        first = (first + left + second) >>> 0;
        second = (second + right + first) >>> 0;
    }
    return [first, second];
}

function requireChecksum(bytes: Buffer, offset: number, checksum: readonly [number, number]): void {
    if (bytes.readUInt32BE(offset) !== checksum[0] || bytes.readUInt32BE(offset + 4) !== checksum[1]) {
        invalidWal("SQLite WAL checksum does not match the committed frame chain");
    }
}

function standalone(bytes: Buffer): Buffer {
    const result = Buffer.from(bytes);
    // sqlite3_deserialize cannot consume external WAL sidecars; only this private, committed image changes mode.
    result[18] = 1;
    result[19] = 1;
    return result;
}

function unstable(message: string): never {
    throw new CommittedSqliteSnapshotError("sqlite_snapshot_unstable", message);
}

function invalidWal(message: string): never {
    throw new CommittedSqliteSnapshotError("sqlite_snapshot_wal_invalid", message);
}
