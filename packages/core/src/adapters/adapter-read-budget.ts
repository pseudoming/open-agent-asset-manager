/** Core-owned per-operation resource budget and terminal failure latch. */

import type { ReadAccessOutcomeStatus } from "../types";

export interface AdapterReadOperationLimits {
    maxIssuedHandles: number;
    maxListedDirectories: number;
    maxReadFiles: number;
    maxReadBytes: number;
    maxRelativePathDepth: number;
}

export const DEFAULT_ADAPTER_READ_OPERATION_LIMITS: Readonly<AdapterReadOperationLimits> = Object.freeze({
    maxIssuedHandles: 4096,
    maxListedDirectories: 1024,
    maxReadFiles: 4096,
    maxReadBytes: 64 * 1024 * 1024,
    maxRelativePathDepth: 64,
});

const ADAPTER_READ_OPERATION_LIMIT_KEYS = [
    "maxIssuedHandles",
    "maxListedDirectories",
    "maxReadFiles",
    "maxReadBytes",
    "maxRelativePathDepth",
] as const satisfies readonly (keyof AdapterReadOperationLimits)[];

const EXPECTED_LIMIT_KEYS = [...ADAPTER_READ_OPERATION_LIMIT_KEYS].sort().join("\0");

export class ReadAccessFailure extends Error {
    constructor(
        readonly status: Exclude<ReadAccessOutcomeStatus, "succeeded">,
        message: string,
    ) {
        super(message);
    }
}

export class AdapterReadBudget {
    readonly limits: Readonly<AdapterReadOperationLimits>;
    private issuedHandles = 0;
    private listedDirectories = 0;
    private readFiles = 0;
    private readBytes = 0;
    private terminalFailureValue: ReadAccessFailure | undefined;

    constructor(limits: AdapterReadOperationLimits) {
        if (Object.keys(limits).sort().join("\0") !== EXPECTED_LIMIT_KEYS) {
            throw new TypeError("adapter read limits must contain exactly the five Core-owned fields");
        }
        for (const name of ADAPTER_READ_OPERATION_LIMIT_KEYS) {
            const value = limits[name];
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new TypeError(`adapter read limit ${name} must be a non-negative safe integer`);
            }
        }
        this.limits = Object.freeze({ ...limits });
    }

    get terminalFailure(): ReadAccessFailure | undefined {
        return this.terminalFailureValue;
    }

    requireOpen(): void {
        if (this.terminalFailureValue !== undefined) throw this.terminalFailureValue;
    }

    requirePathDepth(relativePath: string): void {
        const depth = relativePath === "" ? 0 : relativePath.split("/").length;
        if (depth > this.limits.maxRelativePathDepth) {
            this.fail(`adapter read exceeded its relative-path depth limit (${this.limits.maxRelativePathDepth})`);
        }
    }

    requireIssuedHandleCapacity(addition: number): void {
        this.requireCapacity(this.issuedHandles, addition, this.limits.maxIssuedHandles, "issued-handle");
    }

    recordIssuedHandles(addition: number): void {
        this.issuedHandles += addition;
    }

    remainingIssuedHandles(): number {
        return this.limits.maxIssuedHandles - this.issuedHandles;
    }

    consumeListedDirectory(): void {
        this.requireCapacity(this.listedDirectories, 1, this.limits.maxListedDirectories, "listed-directory");
        this.listedDirectories += 1;
    }

    consumeReadFile(): void {
        this.requireCapacity(this.readFiles, 1, this.limits.maxReadFiles, "read-file");
        this.readFiles += 1;
    }

    remainingReadBytes(): number {
        return this.limits.maxReadBytes - this.readBytes;
    }

    consumeReadBytes(addition: number): void {
        this.requireCapacity(this.readBytes, addition, this.limits.maxReadBytes, "read-byte");
        this.readBytes += addition;
    }

    latch(failure: ReadAccessFailure): ReadAccessFailure {
        if (failure.status === "resource_limit_exceeded") {
            this.terminalFailureValue ??= failure;
        }
        return failure;
    }

    private requireCapacity(current: number, addition: number, maximum: number, label: string): void {
        this.requireOpen();
        if (addition > maximum - current) {
            this.fail(`adapter read exceeded its ${label} limit (${maximum})`);
        }
    }

    private fail(message: string): never {
        this.terminalFailureValue ??= new ReadAccessFailure("resource_limit_exceeded", message);
        throw this.terminalFailureValue;
    }
}
