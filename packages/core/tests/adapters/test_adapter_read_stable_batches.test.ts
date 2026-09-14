import { withReadBatch } from "./fixtures/adapter-read-filesystem";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/** Phase 18 A3 Core-owned read-port unit and fault-injection tests. */

import { describe, expect, it, vi } from "vitest";
import {
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
    readRegularFilesNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import {
    createAdapterReadOperationForTest,
    DEFAULT_ADAPTER_READ_OPERATION_LIMITS,
    type AdapterReadOperationLimits,
    type CreateAdapterReadOperationInput,
} from "../../src/adapters/adapter-read-access";
import type { AdapterAssetSourceCapability, SourceReadObligation } from "../../src/types";

const FP1 = `sha256:${"1".repeat(64)}` as const;
const FP2 = `sha256:${"2".repeat(64)}` as const;
const FILE_ID = { deviceId: "1", fileId: "10", entryKind: "file" as const };
const DIR_ID = { deviceId: "1", fileId: "20", entryKind: "directory" as const };
const CHILD_ID = { deviceId: "1", fileId: "21", entryKind: "file" as const };

function capability(
    sourcePathMechanism: AdapterAssetSourceCapability["sourcePathMechanism"] = "fixed_file",
): AdapterAssetSourceCapability {
    return {
        sourceCapabilityFingerprint: FP1,
        agentRuntimeId: "MOCK_CLI",
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: "source",
        sourceDomain: "agent_runtime_private",
        assetKind: "Guidance",
        sourcePathMechanism,
        evidenceLevel: "agent_runtime_verified",
        readPolicy: "auto_read",
        diagnostics: [],
    };
}

function obligation(fingerprint = FP1): SourceReadObligation {
    return {
        sourceReadObligationId: "obl-1",
        sourceRootId: "root-1",
        sourceCapabilityFingerprint: fingerprint,
    };
}

function input(
    sourcePathMechanism: AdapterAssetSourceCapability["sourcePathMechanism"] = "fixed_file",
): CreateAdapterReadOperationInput {
    return {
        platform: "linux",
        sourceRoots: [
            {
                sourceRootId: "root-1",
                rootRole: "source",
                sourceDomain: "agent_runtime_private",
                path: "/source/root",
                accessStatus: "available",
                locatorEvidence: [
                    {
                        locatorKind: "runtime_known_rule",
                        locatorKey: "mock",
                        evidenceLevel: "agent_runtime_verified",
                    },
                ],
                diagnostics: [],
            },
        ],
        sourceReadObligations: [obligation()],
        sourceCapabilities: [capability(sourcePathMechanism)],
        managedTargetGuards: [],
        readAuthorityFingerprint: FP2,
        transactionsRoot: "/transactions",
    };
}

function fileSystem(bytes = Buffer.from("hello")) {
    return {
        readRegularFileNoFollow: () => ({ bytes, executable: false, identity: FILE_ID }),
        inventoryDirectoryNoFollow: () => ({ identity: DIR_ID, entries: [] }),
    };
}

function limitedInput(
    sourcePathMechanism: AdapterAssetSourceCapability["sourcePathMechanism"],
    overrides: Partial<AdapterReadOperationLimits>,
): CreateAdapterReadOperationInput {
    return {
        ...input(sourcePathMechanism),
        limits: { ...DEFAULT_ADAPTER_READ_OPERATION_LIMITS, ...overrides },
    };
}

const lockBatch = () => ({ release() {} });

describe("Core source closure file batches", () => {
    it("reads a real file above the 128 MiB batch cap at its original per-file limit in both complete passes", async () => {
        const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-source-large-single-"));
        try {
            const names = ["a-small", "b-large", "c-small"];
            const largeSize = 128 * 1024 * 1024 + 1;
            for (const name of names) fs.writeFileSync(path.join(rootPath, name), "a");
            fs.truncateSync(path.join(rootPath, "b-large"), largeSize);
            const operationInput = limitedInput("directory_entry", { maxReadBytes: largeSize + 2 });
            operationInput.sourceRoots[0]!.path = rootPath;
            const scalarCalls: Array<[string, number | undefined]> = [];
            const readMany = vi.fn(() => {
                throw new Error("the large file must remain alone between its neighboring files");
            });
            const operation = createAdapterReadOperationForTest(
                operationInput,
                {
                    readRegularFileNoFollow(filePath, maximumBytes) {
                        scalarCalls.push([filePath, maximumBytes]);
                        return readRegularFileNoFollow(filePath, maximumBytes);
                    },
                    readRegularFilesNoFollow: readMany,
                    inventoryDirectoryNoFollow,
                },
                lockBatch,
            );
            const resolved = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
            if (resolved.state !== "succeeded") throw new Error("expected large-file directory");
            const listed = await operation.readAccess.listDirectory(resolved.value.readEntryHandleId);
            if (listed.state !== "succeeded") throw new Error("expected large-file listing");
            for (const child of listed.value.children)
                expect((await operation.readAccess.readFile(child.readEntryHandleId)).state).toBe("succeeded");
            scalarCalls.length = 0;
            expect(operation.finalValidate().valid).toBe(true);
            expect(scalarCalls).toEqual([...names, ...names].map((name) => [path.join(rootPath, name), largeSize + 2]));
            expect(readMany).not.toHaveBeenCalled();
            expect(fs.statSync(path.join(rootPath, "b-large")).size).toBe(largeSize);
        } finally {
            fs.rmSync(rootPath, { recursive: true, force: true });
        }
    });

    it.each([65, 66])("bounds both fresh passes to 64 unique files, preserving all %s source outcomes", async (count) => {
        const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-source-batch-count-"));
        try {
            for (let index = 0; index < count; index++)
                fs.writeFileSync(path.join(rootPath, String(index).padStart(3, "0")), "a");
            const operationInput = input("directory_entry");
            operationInput.sourceRoots[0]!.path = rootPath;
            const read = vi.fn(readRegularFileNoFollow),
                readMany = vi.fn(readRegularFilesNoFollow);
            const operation = createAdapterReadOperationForTest(
                operationInput,
                {
                    readRegularFileNoFollow: read,
                    readRegularFilesNoFollow: readMany,
                    inventoryDirectoryNoFollow,
                },
                lockBatch,
            );
            const resolved = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
            if (resolved.state !== "succeeded") throw new Error("expected bounded directory");
            const listed = await operation.readAccess.listDirectory(resolved.value.readEntryHandleId);
            if (listed.state !== "succeeded") throw new Error("expected bounded directory listing");
            for (const child of listed.value.children)
                expect((await operation.readAccess.readFile(child.readEntryHandleId)).state).toBe("succeeded");
            read.mockClear();
            expect(operation.finalValidate().valid).toBe(true);
            expect(readMany.mock.calls.map(([requests]) => requests.length)).toEqual(count === 65 ? [64, 64] : [64, 2, 64, 2]);
            expect(read).toHaveBeenCalledTimes(count === 65 ? 2 : 0);
            expect(
                operation
                    .snapshot()
                    .outcomes.filter((outcome) => outcome.operation === "final_validate")
                    .map((outcome) => outcome.status),
            ).toEqual(Array(count + 1).fill("succeeded"));
        } finally {
            fs.rmSync(rootPath, { recursive: true, force: true });
        }
    });

    it.each([
        false,
        true,
    ])("samples one shared file once per pass while comparing both obligations (different expectations: %s)", async (different) => {
        const operationInput = input();
        operationInput.sourceReadObligations.push({ ...obligation(), sourceReadObligationId: "obl-2" });
        let bytes = Buffer.from("hello");
        const read = vi.fn(() => ({ bytes: new Uint8Array(bytes), executable: false, identity: FILE_ID }));
        const readMany = vi.fn(() => {
            throw new Error("one unique file needs no batch");
        });
        const operation = createAdapterReadOperationForTest(
            operationInput,
            {
                ...withReadBatch(fileSystem()),
                readRegularFileNoFollow: read,
                readRegularFilesNoFollow: readMany,
            },
            lockBatch,
        );
        for (const { sourceReadObligationId } of operationInput.sourceReadObligations) {
            if (different && sourceReadObligationId === "obl-2") bytes = Buffer.from("after");
            const resolved = await operation.readAccess.resolveRootEntry(sourceReadObligationId, "root-1");
            if (resolved.state !== "succeeded") throw new Error("expected file root");
            expect((await operation.readAccess.readFile(resolved.value.readEntryHandleId)).state).toBe("succeeded");
        }
        read.mockClear();
        expect(operation.finalValidate().valid).toBe(!different);
        expect(read).toHaveBeenCalledTimes(2);
        expect(readMany).not.toHaveBeenCalled();
    });

    it.each([
        "both_within_file_cap",
        "later_over_file_cap",
        "first_over_file_cap",
    ])("preserves real file-growth failure classification: %s", async (change) => {
        const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-source-growth-"));
        try {
            const firstPath = path.join(rootPath, "a"),
                secondPath = path.join(rootPath, "b");
            fs.writeFileSync(firstPath, "a");
            fs.writeFileSync(secondPath, "b");
            const operationInput = limitedInput("directory_entry", { maxReadBytes: 2 });
            operationInput.sourceRoots[0]!.path = rootPath;
            const read = vi.fn(readRegularFileNoFollow),
                readMany = vi.fn(readRegularFilesNoFollow);
            const operation = createAdapterReadOperationForTest(
                operationInput,
                {
                    readRegularFileNoFollow: read,
                    readRegularFilesNoFollow: readMany,
                    inventoryDirectoryNoFollow,
                },
                lockBatch,
            );
            const resolved = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
            if (resolved.state !== "succeeded") throw new Error("expected growth directory");
            const listing = await operation.readAccess.listDirectory(resolved.value.readEntryHandleId);
            if (listing.state !== "succeeded") throw new Error("expected growth listing");
            for (const child of listing.value.children)
                expect((await operation.readAccess.readFile(child.readEntryHandleId)).state).toBe("succeeded");
            fs.writeFileSync(firstPath, change === "first_over_file_cap" ? "aaa" : "aa");
            fs.writeFileSync(secondPath, change === "later_over_file_cap" ? "bbb" : "bb");
            read.mockClear();
            expect(operation.finalValidate().valid).toBe(false);
            const expectedStatus = change === "both_within_file_cap" ? "stale" : "resource_limit_exceeded";
            expect(
                operation
                    .snapshot()
                    .outcomes.filter((outcome) => outcome.operation === "final_validate")
                    .map((outcome) => outcome.status),
            ).toEqual(Array(3).fill(expectedStatus));
            expect(readMany).toHaveBeenCalledTimes(change === "both_within_file_cap" ? 2 : 1);
            expect(read).toHaveBeenCalledTimes(change === "both_within_file_cap" ? 4 : change === "later_over_file_cap" ? 2 : 0);
        } finally {
            fs.rmSync(rootPath, { recursive: true, force: true });
        }
    });

    it.each([
        "unchanged",
        "second_content",
        "second_identity",
        "second_executable",
        "second_failure",
        "incomplete_batch",
        "duplicate_roots",
        "duplicate_conflict",
        "reordered_batch",
    ])("keeps two independently fresh complete file batches under the closure lock: %s", async (change) => {
        const contents = new Map([0, 1, 2, 3].map((index) => [`/source/root/${index}.md`, Buffer.from(`file ${index}`)]));
        let batchCalls = 0;
        let lockHeld = false;
        const duplicated = change === "duplicate_roots" || change === "duplicate_conflict";
        const readMany = vi.fn((requests: readonly { filePath: string; maximumBytes: number }[], maximumTotalBytes: number) => {
            expect(lockHeld).toBe(true);
            expect(maximumTotalBytes).toBe(DEFAULT_ADAPTER_READ_OPERATION_LIMITS.maxReadBytes);
            expect(requests.map((request) => request.filePath)).toEqual([...contents.keys()]);
            batchCalls += 1;
            if (batchCalls === 2 && change === "second_failure")
                throw new SafeFilesystemError({
                    failureKind: "permission_denied",
                    operation: "read_regular_file",
                    targetPath: "/source/root/0.md",
                    message: "second pass denied",
                });
            const reads = requests.map(({ filePath }) => ({
                bytes: new Uint8Array(contents.get(filePath)!),
                executable: batchCalls === 2 && change === "second_executable",
                identity: { ...FILE_ID, fileId: batchCalls === 2 && change === "second_identity" ? "replacement" : filePath },
            }));
            if (batchCalls === 2 && change === "second_content") reads[0]!.bytes.fill(88);
            return change === "incomplete_batch" ? reads.slice(0, 3) : change === "reordered_batch" ? reads.reverse() : reads;
        });
        const operationInput = input("directory_entry");
        if (duplicated) operationInput.sourceReadObligations.push({ ...obligation(), sourceReadObligationId: "obl-2" });
        const operation = createAdapterReadOperationForTest(
            operationInput,
            {
                readRegularFileNoFollow(filePath) {
                    return {
                        bytes: new Uint8Array(contents.get(filePath)!),
                        executable: false,
                        identity: { ...FILE_ID, fileId: filePath },
                    };
                },
                inventoryDirectoryNoFollow() {
                    return {
                        identity: DIR_ID,
                        entries: [...contents.keys()].map((filePath, index) => ({
                            relativeName: `${index}.md`,
                            identity: { ...FILE_ID, fileId: filePath },
                        })),
                    };
                },
                readRegularFilesNoFollow: readMany,
            },
            () => {
                lockHeld = true;
                return {
                    release() {
                        lockHeld = false;
                    },
                };
            },
        );
        for (const { sourceReadObligationId } of operationInput.sourceReadObligations) {
            if (sourceReadObligationId === "obl-2" && change === "duplicate_conflict")
                contents.set("/source/root/0.md", Buffer.from("different"));
            const root = await operation.readAccess.resolveRootEntry(sourceReadObligationId, "root-1");
            if (root.state !== "succeeded") throw new Error("expected directory root");
            const listed = await operation.readAccess.listDirectory(root.value.readEntryHandleId);
            if (listed.state !== "succeeded") throw new Error("expected directory listing");
            for (const entry of listed.value.children) {
                expect((await operation.readAccess.readFile(entry.readEntryHandleId)).state).toBe("succeeded");
            }
        }
        const validated = operation.finalValidate();
        const valid = change === "unchanged" || change === "duplicate_roots";
        expect(validated.valid).toBe(valid);
        expect(batchCalls).toBe(change === "incomplete_batch" ? 1 : 2);
        expect(lockHeld).toBe(false);
        const finalOutcomes = operation.snapshot().outcomes.filter((outcome) => outcome.operation === "final_validate");
        expect(finalOutcomes).toHaveLength(duplicated ? 10 : 5);
        expect(
            finalOutcomes.every(
                (outcome) =>
                    outcome.status ===
                    (valid
                        ? "succeeded"
                        : change === "second_failure"
                          ? "permission_denied"
                          : change === "incomplete_batch"
                            ? "io_error"
                            : "stale"),
            ),
        ).toBe(true);
    });
});
