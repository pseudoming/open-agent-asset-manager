import * as crypto from "node:crypto";
import * as path from "node:path";
import {
    durableEnsureDirectory,
    durableRemoveDirectoryTree,
    durableRemoveRegularFile,
    durableReplaceFile,
    readRegularFileNoFollow,
} from "@oaam/shared/filesystem";
import { decodeReviewRecord, encodeReviewRecord, type HostReviewRecordKind } from "./review-record-codec";

export type HostReviewRecordInvalidationReason = "replaced" | "accepted" | "cancelled" | "expired" | "evicted";

interface ReviewRecordMetadata {
    readonly token: string;
    readonly kind: HostReviewRecordKind;
    readonly ownerConnectionId: string;
    readonly replacementKey: string;
    readonly parentTokens: readonly string[];
    readonly filePath: string;
    readonly byteLength: number;
    readonly contentHash: string;
    readonly createdAt: number;
    readonly expiresAt: number;
}

export interface PutHostReviewRecordInput {
    readonly kind: HostReviewRecordKind;
    readonly ownerConnectionId: string;
    readonly replacementKey: string;
    readonly parentTokens?: readonly string[];
    readonly payload: unknown;
}

export interface HostReviewRecordStoreOptions {
    readonly rootPath: string;
    readonly createToken: () => string;
    readonly now?: () => number;
    readonly maximumRecords?: number;
    readonly maximumBytes?: number;
    readonly maximumAgeMs?: number;
    readonly onInvalidated?: (
        ownerConnectionId: string,
        kind: HostReviewRecordKind,
        token: string,
        reason: HostReviewRecordInvalidationReason,
    ) => void;
}

export class HostReviewRecordCapacityError extends Error {
    public constructor() {
        super("Host review-record capacity is exhausted");
        this.name = "HostReviewRecordCapacityError";
    }
}

const DEFAULT_MAXIMUM_RECORDS = 16;
export const DEFAULT_HOST_REVIEW_RECORD_MAXIMUM_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAXIMUM_AGE_MS = 2 * 60 * 60 * 1000;

export function createOwnedReviewSpoolRoot(
    parentPath: string,
    createSegment: () => string = () => `oaam-host-review-${crypto.randomUUID()}`,
): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const segment = createSegment();
        const result = durableEnsureDirectory(parentPath, segment);
        if (result.created) return path.join(parentPath, segment);
    }
    throw new Error("Host could not allocate a new review-record spool root");
}

export class HostReviewRecordStore {
    readonly #rootPath: string;
    readonly #createToken: () => string;
    readonly #now: () => number;
    readonly #maximumRecords: number;
    readonly #maximumBytes: number;
    readonly #maximumAgeMs: number;
    readonly #onInvalidated:
        | ((
              ownerConnectionId: string,
              kind: HostReviewRecordKind,
              token: string,
              reason: HostReviewRecordInvalidationReason,
          ) => void)
        | undefined;
    readonly #records = new Map<string, ReviewRecordMetadata>();
    #totalBytes = 0;
    #closed = false;

    public constructor(options: HostReviewRecordStoreOptions) {
        this.#rootPath = options.rootPath;
        this.#createToken = options.createToken;
        this.#now = options.now ?? Date.now;
        this.#maximumRecords = options.maximumRecords ?? DEFAULT_MAXIMUM_RECORDS;
        this.#maximumBytes = options.maximumBytes ?? DEFAULT_HOST_REVIEW_RECORD_MAXIMUM_BYTES;
        this.#maximumAgeMs = options.maximumAgeMs ?? DEFAULT_MAXIMUM_AGE_MS;
        this.#onInvalidated = options.onInvalidated;
        if (this.#maximumRecords < 1 || this.#maximumBytes < 1 || this.#maximumAgeMs < 1) {
            throw new RangeError("Host review-record limits must be positive");
        }
        durableEnsureDirectory(path.dirname(this.#rootPath), path.basename(this.#rootPath));
    }

    public put(input: PutHostReviewRecordInput): string {
        this.#requireOpen();
        this.expire();
        for (const parentToken of input.parentTokens ?? []) {
            if (!this.#records.has(parentToken)) throw new TypeError("Host review-record parent is unavailable");
        }
        const encoded = encodeReviewRecord(input.kind, input.payload);
        if (encoded.byteLength > this.#maximumBytes) throw new HostReviewRecordCapacityError();
        const token = this.#newToken();
        const replacements = [...this.#records.values()].filter(
            (record) =>
                record.ownerConnectionId === input.ownerConnectionId &&
                record.kind === input.kind &&
                record.replacementKey === input.replacementKey,
        );
        const replacement = replacements[0];
        const replacementFilePath =
            replacement === undefined ? undefined : this.#invalidateTree(replacement.token, "replaced", true);
        while (
            this.#records.size >= this.#maximumRecords ||
            (this.#records.size > 0 && this.#totalBytes + encoded.byteLength > this.#maximumBytes)
        ) {
            const oldest = [...this.#records.values()].sort(
                (left, right) => left.createdAt - right.createdAt || (left.token < right.token ? -1 : 1),
            )[0] as ReviewRecordMetadata;
            this.#invalidateTree(oldest.token, "evicted");
        }
        const filePath =
            replacementFilePath ?? path.join(this.#rootPath, `${crypto.createHash("sha256").update(token).digest("hex")}.record`);
        durableReplaceFile(filePath, encoded);
        const createdAt = this.#now();
        this.#records.set(token, {
            token,
            kind: input.kind,
            ownerConnectionId: input.ownerConnectionId,
            replacementKey: input.replacementKey,
            parentTokens: Object.freeze([...(input.parentTokens ?? [])]),
            filePath,
            byteLength: encoded.byteLength,
            contentHash: crypto.createHash("sha256").update(encoded).digest("hex"),
            createdAt,
            expiresAt: createdAt + this.#maximumAgeMs,
        });
        this.#totalBytes += encoded.byteLength;
        return token;
    }

    public get<T>(token: string, kind: HostReviewRecordKind, validate: (value: unknown) => value is T): T | null {
        return this.#get(token, kind, undefined, validate);
    }

    public getOwned<T>(
        token: string,
        kind: HostReviewRecordKind,
        ownerConnectionId: string,
        validate: (value: unknown) => value is T,
    ): T | null {
        return this.#get(token, kind, ownerConnectionId, validate);
    }

    #get<T>(
        token: string,
        kind: HostReviewRecordKind,
        ownerConnectionId: string | undefined,
        validate: (value: unknown) => value is T,
    ): T | null {
        this.#requireOpen();
        this.expire();
        const record = this.#records.get(token);
        if (
            record === undefined ||
            record.kind !== kind ||
            (ownerConnectionId !== undefined && record.ownerConnectionId !== ownerConnectionId)
        ) {
            return null;
        }
        try {
            const bytes = readRegularFileNoFollow(record.filePath, record.byteLength).bytes;
            if (bytes.byteLength !== record.byteLength) throw new TypeError("Host review record was truncated");
            if (crypto.createHash("sha256").update(bytes).digest("hex") !== record.contentHash) {
                throw new TypeError("Host review record content changed after publication");
            }
            const value = decodeReviewRecord(bytes, record.kind);
            if (!validate(value)) throw new TypeError("Host review record failed its exact kind validator");
            return value;
        } catch {
            this.#invalidateTree(record.token, "evicted");
            return null;
        }
    }

    public remove(token: string, reason: HostReviewRecordInvalidationReason): boolean {
        this.#requireOpen();
        if (!this.#records.has(token)) return false;
        this.#invalidateTree(token, reason);
        return true;
    }

    public expire(): void {
        if (this.#closed) return;
        const now = this.#now();
        for (const record of [...this.#records.values()]) {
            if (record.expiresAt <= now && this.#records.has(record.token)) this.#invalidateTree(record.token, "expired");
        }
    }

    public close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#records.clear();
        this.#totalBytes = 0;
        durableRemoveDirectoryTree(this.#rootPath);
    }

    #newToken(): string {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const token = this.#createToken();
            if (token.length > 0 && token.trim() === token && !token.includes("\0") && !this.#records.has(token)) return token;
        }
        throw new Error("Host could not allocate a unique review-record token");
    }

    #invalidateTree(token: string, reason: HostReviewRecordInvalidationReason, retainRootFile = false): string | undefined {
        for (const child of [...this.#records.values()]) {
            if (child.parentTokens.includes(token)) this.#invalidateTree(child.token, reason);
        }
        const record = this.#records.get(token) as ReviewRecordMetadata;
        this.#removeOne(record, reason, retainRootFile);
        return retainRootFile ? record.filePath : undefined;
    }

    #removeOne(record: ReviewRecordMetadata, reason: HostReviewRecordInvalidationReason, retainFile: boolean): void {
        this.#records.delete(record.token);
        this.#totalBytes -= record.byteLength;
        if (!retainFile) {
            try {
                durableRemoveRegularFile(record.filePath);
            } catch {
                // Review records are disposable; a failed recycle leaves no live in-memory authority.
            }
        }
        this.#onInvalidated?.(record.ownerConnectionId, record.kind, record.token, reason);
    }

    #requireOpen(): void {
        if (this.#closed) throw new Error("Host review-record store is closed");
    }
}
