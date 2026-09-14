import { withReadBatch } from "./fixtures/adapter-read-filesystem";
/** Phase 18 A3 Core-owned read-port unit and fault-injection tests. */

import { describe, expect, it } from "vitest";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
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

describe("Core-owned adapter read access", () => {
    it("resolves, reads, and validates a fixed file through opaque Core-issued records", async () => {
        const operation = createAdapterReadOperationForTest(input(), withReadBatch(fileSystem()), lockBatch);
        const resolved = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
        expect(resolved.state).toBe("succeeded");
        if (resolved.state !== "succeeded") throw new Error("expected resolved root");
        const read = await operation.readAccess.readFile(resolved.value.readEntryHandleId);
        expect(read.state).toBe("succeeded");
        expect(operation.finalValidate()).toEqual({ valid: true, diagnostics: [] });
        const ledger = operation.snapshot();
        expect(ledger.handles).toHaveLength(1);
        expect(ledger.entries).toEqual([expect.objectContaining({ entryKind: "file", relativePath: "", executable: false })]);
        expect(ledger.outcomes.map((outcome) => outcome.operation)).toEqual(["resolve_root", "read_file", "final_validate"]);
    });

    it("uses Win32 joins under a UNC root while retaining the logical WSL lock namespace", async () => {
        const uncRoot = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const expectedFile = `${uncRoot}\\nested\\AGENTS.md`;
        const expectedParent = `${uncRoot}\\nested`;
        const operationInput = input("recursive_entry");
        operationInput.platform = "wsl";
        operationInput.sourceRoots[0]!.path = uncRoot;
        const inventoryPaths: string[] = [];
        const readPaths: string[] = [];
        const lockKeys: string[][] = [];
        const operation = createAdapterReadOperationForTest(
            operationInput,
            withReadBatch({
                readRegularFileNoFollow(filePath) {
                    readPaths.push(filePath);
                    return { bytes: Buffer.from("# Guidance\n"), executable: false, identity: FILE_ID };
                },
                inventoryDirectoryNoFollow(directoryPath) {
                    inventoryPaths.push(directoryPath);
                    return {
                        identity: DIR_ID,
                        entries: [{ relativeName: "AGENTS.md", identity: FILE_ID }],
                    };
                },
            }),
            (_transactionsRoot, keys) => {
                lockKeys.push(keys);
                return { release() {} };
            },
        );

        const resolved = await operation.readAccess.resolveEntry("obl-1", "root-1", "nested/AGENTS.md");
        expect(resolved.state).toBe("succeeded");
        if (resolved.state !== "succeeded") throw new Error("expected UNC source entry");
        expect((await operation.readAccess.readFile(resolved.value.readEntryHandleId)).state).toBe("succeeded");
        expect(operation.finalValidate()).toEqual({ valid: true, diagnostics: [] });
        expect(inventoryPaths).toEqual([expectedParent]);
        expect(readPaths).toEqual([expectedFile, expectedFile, expectedFile]);
        expect(lockKeys.flat()).toEqual(expect.arrayContaining([`wsl\0${expectedParent}`, `wsl\0${expectedFile}`]));
        expect(lockKeys.flat().some((key) => key.startsWith("win32\0"))).toBe(false);
    });

    it("does not let adapter-visible read records mutate the Core ledger or source bytes", async () => {
        const originalBytes = Buffer.from("hello");
        const operationInput = input();
        const operation = createAdapterReadOperationForTest(operationInput, withReadBatch(fileSystem(originalBytes)), lockBatch);
        const resolved = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
        if (resolved.state !== "succeeded") throw new Error("expected resolved root");

        operationInput.sourceRoots[0]!.path = "/caller-mutated";
        resolved.value.sourceRootId = "provider-mutated";
        resolved.value.relativePath = "forged.md";
        const read = await operation.readAccess.readFile(resolved.value.readEntryHandleId);
        if (read.state !== "succeeded") throw new Error("expected file read");
        read.value.entry.sourceRootId = "provider-mutated";
        read.value.entry.relativePath = "forged.md";
        read.value.entry.contentHash = FP1;
        read.value.bytes[0] = 0;

        expect(operation.finalValidate()).toEqual({ valid: true, diagnostics: [] });
        expect(operation.snapshot().entries).toEqual([
            expect.objectContaining({
                sourceRootId: "root-1",
                relativePath: "",
                contentHash: `sha256:${"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}`,
            }),
        ]);
        expect(originalBytes.toString()).toBe("hello");

        const exposedSnapshot = operation.snapshot();
        exposedSnapshot.entries[0]!.relativePath = "snapshot-mutated.md";
        expect(operation.snapshot().entries[0]?.relativePath).toBe("");
    });

    it("lists a directory, resolves its children, and keeps file and inventory facts stable", async () => {
        const fsPort = {
            readRegularFileNoFollow: () => ({
                bytes: Buffer.from("child"),
                executable: true,
                identity: CHILD_ID,
            }),
            inventoryDirectoryNoFollow: (target: string) =>
                target === "/source/root"
                    ? {
                          identity: DIR_ID,
                          entries: [{ relativeName: "child.md", identity: CHILD_ID }],
                      }
                    : {
                          identity: DIR_ID,
                          entries: [{ relativeName: "child.md", identity: CHILD_ID }],
                      },
        };
        const operation = createAdapterReadOperationForTest(input("recursive_entry"), withReadBatch(fsPort), lockBatch);
        const root = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
        if (root.state !== "succeeded") throw new Error("expected directory root");
        const listed = await operation.readAccess.listDirectory(root.value.readEntryHandleId);
        if (listed.state !== "succeeded") throw new Error("expected directory list");
        expect(listed.value.children[0]?.relativePath).toBe("child.md");
        const child = await operation.readAccess.resolveEntry("obl-1", "root-1", "child.md");
        if (child.state !== "succeeded") throw new Error("expected resolved child");
        expect((await operation.readAccess.readFile(child.value.readEntryHandleId)).state).toBe("succeeded");
        expect(operation.finalValidate().valid).toBe(true);
        expect(operation.snapshot().entries.map((entry) => entry.entryKind)).toEqual(["directory", "file"]);
    });

    it("keeps nested directory children relative to the selected root", async () => {
        const nestedDirectory = { deviceId: "1", fileId: "30", entryKind: "directory" as const };
        const operation = createAdapterReadOperationForTest(
            input("recursive_entry"),
            withReadBatch({
                ...fileSystem(),
                inventoryDirectoryNoFollow: (target) =>
                    target === "/source/root"
                        ? {
                              identity: DIR_ID,
                              entries: [{ relativeName: "nested", identity: nestedDirectory }],
                          }
                        : {
                              identity: nestedDirectory,
                              entries: [{ relativeName: "child.md", identity: CHILD_ID }],
                          },
            }),
            lockBatch,
        );
        const root = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
        if (root.state !== "succeeded") throw new Error("expected root");
        const rootList = await operation.readAccess.listDirectory(root.value.readEntryHandleId);
        if (rootList.state !== "succeeded") throw new Error("expected root list");
        const nested = rootList.value.children[0]!;
        const nestedList = await operation.readAccess.listDirectory(nested.readEntryHandleId);
        if (nestedList.state !== "succeeded") throw new Error("expected nested list");
        expect(nestedList.value.children[0]?.relativePath).toBe("nested/child.md");
    });

    it("fails closed for unauthorized roots, noncanonical paths, unknown capabilities, and mechanisms", async () => {
        const fsPort = fileSystem();
        const unauthorized = createAdapterReadOperationForTest(input(), withReadBatch(fsPort), lockBatch);
        expect((await unauthorized.readAccess.resolveRootEntry("foreign", "root-1")).state).toBe("failed");
        expect((await unauthorized.readAccess.resolveEntry("obl-1", "root-1", "../escape")).state).toBe("failed");

        const missingCapabilityInput = input();
        missingCapabilityInput.sourceReadObligations = [obligation(FP2)];
        const missingCapability = createAdapterReadOperationForTest(missingCapabilityInput, withReadBatch(fsPort), lockBatch);
        expect((await missingCapability.readAccess.resolveRootEntry("obl-1", "root-1")).state).toBe("failed");

        const unknownMechanism = createAdapterReadOperationForTest(input("unknown"), withReadBatch(fsPort), lockBatch);
        expect((await unknownMechanism.readAccess.resolveRootEntry("obl-1", "root-1")).state).toBe("failed");
    });

    it("blocks entire-root, exact-file, and directory-prefix managed boundaries", async () => {
        for (const guard of [
            {
                sourceRootId: "root-1",
                matchKind: "entire_root" as const,
                managementState: "active_managed" as const,
                deploymentId: "00000000-0000-4000-8000-000000000001",
                outputUnitFingerprint: FP1,
            },
            {
                sourceRootId: "root-1",
                relativePath: "managed.md",
                matchKind: "exact_file" as const,
                managementState: "active_managed" as const,
                deploymentId: "00000000-0000-4000-8000-000000000001",
                appliedContentHash: FP1,
            },
            {
                sourceRootId: "root-1",
                relativePath: "managed",
                matchKind: "directory_prefix" as const,
                managementState: "residual_managed" as const,
                deploymentId: "00000000-0000-4000-8000-000000000001",
                outputUnitFingerprint: FP1,
            },
        ]) {
            const guardedInput = input("recursive_entry");
            guardedInput.managedTargetGuards = [guard];
            const operation = createAdapterReadOperationForTest(guardedInput, withReadBatch(fileSystem()), lockBatch);
            const result =
                guard.matchKind === "entire_root"
                    ? await operation.readAccess.resolveRootEntry("obl-1", "root-1")
                    : await operation.readAccess.resolveEntry(
                          "obl-1",
                          "root-1",
                          guard.matchKind === "exact_file" ? "managed.md" : "managed/child.md",
                      );
            expect(result).toEqual(
                expect.objectContaining({
                    state: "failed",
                    failureStatus: "blocked_managed_target",
                }),
            );
        }
    });

    it("maps typed filesystem failures without leaking raw errno semantics", async () => {
        const cases = [
            ["invalid_path", "io_error"],
            ["not_found", "not_found"],
            ["permission_denied", "permission_denied"],
            ["symlink_or_reparse", "blocked_symlink_or_reparse"],
            ["wrong_entry_type", "io_error"],
            ["resource_limit", "resource_limit_exceeded"],
            ["stale", "stale"],
            ["unsupported_platform", "io_error"],
            ["io_error", "io_error"],
        ] as const;
        for (const [failureKind, expected] of cases) {
            const fsPort = {
                ...fileSystem(),
                readRegularFileNoFollow: () => {
                    throw new SafeFilesystemError({
                        failureKind,
                        operation: "read_regular_file",
                        targetPath: "/source/root",
                        message: failureKind,
                    });
                },
            };
            const operation = createAdapterReadOperationForTest(input(), withReadBatch(fsPort), lockBatch);
            const result = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
            expect(result).toEqual(expect.objectContaining({ state: "failed", failureStatus: expected }));
        }
    });

    it("accepts exact read/list/handle/byte/depth budgets", async () => {
        const nestedDirectory = { deviceId: "1", fileId: "30", entryKind: "directory" as const };
        const operation = createAdapterReadOperationForTest(
            limitedInput("recursive_entry", {
                maxIssuedHandles: 3,
                maxListedDirectories: 2,
                maxReadFiles: 1,
                maxReadBytes: 5,
                maxRelativePathDepth: 2,
            }),
            withReadBatch({
                readRegularFileNoFollow: () => ({
                    bytes: Buffer.from("hello"),
                    executable: false,
                    identity: CHILD_ID,
                }),
                inventoryDirectoryNoFollow: (target) =>
                    target === "/source/root"
                        ? {
                              identity: DIR_ID,
                              entries: [{ relativeName: "nested", identity: nestedDirectory }],
                          }
                        : {
                              identity: nestedDirectory,
                              entries: [{ relativeName: "child.md", identity: CHILD_ID }],
                          },
            }),
            lockBatch,
        );
        const root = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
        if (root.state !== "succeeded") throw new Error("expected root");
        const first = await operation.readAccess.listDirectory(root.value.readEntryHandleId);
        if (first.state !== "succeeded") throw new Error("expected first list");
        const second = await operation.readAccess.listDirectory(first.value.children[0]!.readEntryHandleId);
        if (second.state !== "succeeded") throw new Error("expected second list");
        expect(await operation.readAccess.readFile(second.value.children[0]!.readEntryHandleId)).toEqual(
            expect.objectContaining({ state: "succeeded" }),
        );
        expect(operation.snapshot().handles).toHaveLength(3);
        expect(operation.finalValidate()).toEqual({ valid: true, diagnostics: [] });
    });

    it("fails atomically at the issued-handle limit and latches the typed terminal failure", async () => {
        const operation = createAdapterReadOperationForTest(
            limitedInput("recursive_entry", { maxIssuedHandles: 1 }),
            withReadBatch({
                ...fileSystem(),
                inventoryDirectoryNoFollow: () => ({
                    identity: DIR_ID,
                    entries: [{ relativeName: "child.md", identity: CHILD_ID }],
                }),
            }),
            lockBatch,
        );
        const root = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
        if (root.state !== "succeeded") throw new Error("expected root");
        const overflow = await operation.readAccess.listDirectory(root.value.readEntryHandleId);
        expect(overflow).toEqual(
            expect.objectContaining({
                state: "failed",
                failureStatus: "resource_limit_exceeded",
            }),
        );
        expect(operation.snapshot().handles).toHaveLength(1);
        expect(await operation.readAccess.resolveRootEntry("obl-1", "root-1")).toEqual(
            expect.objectContaining({
                state: "failed",
                failureStatus: "resource_limit_exceeded",
            }),
        );
        expect(operation.finalValidate()).toEqual(
            expect.objectContaining({
                valid: false,
                diagnostics: [expect.objectContaining({ code: "read.resource_limit_exceeded" })],
            }),
        );
    });

    it("enforces list, read, byte, and path-depth limits as distinct terminal failures", async () => {
        const directoryCases = [
            {
                limits: { maxListedDirectories: 0 },
                inventory: { identity: DIR_ID, entries: [] },
            },
            {
                limits: { maxRelativePathDepth: 0 },
                inventory: {
                    identity: DIR_ID,
                    entries: [{ relativeName: "child.md", identity: CHILD_ID }],
                },
            },
        ] as const;
        for (const item of directoryCases) {
            const operation = createAdapterReadOperationForTest(
                limitedInput("recursive_entry", item.limits),
                withReadBatch({
                    ...fileSystem(),
                    inventoryDirectoryNoFollow: () => item.inventory,
                }),
                lockBatch,
            );
            const root = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
            if (root.state !== "succeeded") throw new Error("expected root");
            expect(await operation.readAccess.listDirectory(root.value.readEntryHandleId)).toEqual(
                expect.objectContaining({
                    state: "failed",
                    failureStatus: "resource_limit_exceeded",
                }),
            );
        }

        for (const limits of [{ maxReadFiles: 0 }, { maxReadBytes: 4 }]) {
            const operation = createAdapterReadOperationForTest(
                limitedInput("fixed_file", limits),
                withReadBatch(fileSystem(Buffer.from("hello"))),
                lockBatch,
            );
            const root = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
            if (root.state !== "succeeded") throw new Error("expected root");
            expect(await operation.readAccess.readFile(root.value.readEntryHandleId)).toEqual(
                expect.objectContaining({
                    state: "failed",
                    failureStatus: "resource_limit_exceeded",
                }),
            );
        }
    });

    it("rejects invalid internal budget overrides before filesystem access", () => {
        expect(() =>
            createAdapterReadOperationForTest(
                limitedInput("fixed_file", { maxReadBytes: -1 }),
                withReadBatch(fileSystem()),
                lockBatch,
            ),
        ).toThrow("maxReadBytes must be a non-negative safe integer");

        for (const malformed of [{}, { ...DEFAULT_ADAPTER_READ_OPERATION_LIMITS, foreignLimit: 1 }]) {
            expect(() =>
                createAdapterReadOperationForTest(
                    {
                        ...input("fixed_file"),
                        limits: malformed as AdapterReadOperationLimits,
                    },
                    withReadBatch(fileSystem()),
                    lockBatch,
                ),
            ).toThrow("must contain exactly the five Core-owned fields");
        }
    });

    it("rejects missing or invalid children, wrong handle operations, and repeated consumption", async () => {
        const missingChild = createAdapterReadOperationForTest(input("recursive_entry"), withReadBatch(fileSystem()), lockBatch);
        expect((await missingChild.readAccess.resolveEntry("obl-1", "root-1", "missing.md")).failureStatus).toBe("not_found");

        const invalidChildFs = {
            ...fileSystem(),
            inventoryDirectoryNoFollow: () => ({
                identity: DIR_ID,
                entries: [{ relativeName: "../escape", identity: CHILD_ID }],
            }),
        };
        const invalidChild = createAdapterReadOperationForTest(
            input("recursive_entry"),
            withReadBatch(invalidChildFs),
            lockBatch,
        );
        const root = await invalidChild.readAccess.resolveRootEntry("obl-1", "root-1");
        if (root.state !== "succeeded") throw new Error("expected root");
        expect((await invalidChild.readAccess.listDirectory(root.value.readEntryHandleId)).state).toBe("failed");

        const file = createAdapterReadOperationForTest(input(), withReadBatch(fileSystem()), lockBatch);
        const fileRoot = await file.readAccess.resolveRootEntry("obl-1", "root-1");
        if (fileRoot.state !== "succeeded") throw new Error("expected file root");
        expect((await file.readAccess.listDirectory(fileRoot.value.readEntryHandleId)).state).toBe("failed");
        expect((await file.readAccess.readFile("unknown")).state).toBe("failed");
        expect((await file.readAccess.readFile(fileRoot.value.readEntryHandleId)).state).toBe("succeeded");
        expect((await file.readAccess.readFile(fileRoot.value.readEntryHandleId)).state).toBe("failed");

        const directory = createAdapterReadOperationForTest(input("directory_entry"), withReadBatch(fileSystem()), lockBatch);
        const directoryRoot = await directory.readAccess.resolveRootEntry("obl-1", "root-1");
        if (directoryRoot.state !== "succeeded") throw new Error("expected directory root");
        expect((await directory.readAccess.readFile(directoryRoot.value.readEntryHandleId)).state).toBe("failed");
    });

    it("reports busy and unexpected physical-lock failures before resolve or read", async () => {
        const busyResolve = createAdapterReadOperationForTest(input(), withReadBatch(fileSystem()), () => null);
        expect(await busyResolve.readAccess.resolveRootEntry("obl-1", "root-1")).toEqual(
            expect.objectContaining({ state: "failed", failureStatus: "busy" }),
        );

        let busyCalls = 0;
        const busyRead = createAdapterReadOperationForTest(input(), withReadBatch(fileSystem()), () => {
            busyCalls += 1;
            return busyCalls === 1 ? { release() {} } : null;
        });
        const busyRoot = await busyRead.readAccess.resolveRootEntry("obl-1", "root-1");
        if (busyRoot.state !== "succeeded") throw new Error("expected root");
        expect((await busyRead.readAccess.readFile(busyRoot.value.readEntryHandleId)).failureStatus).toBe("busy");

        const throwingResolve = createAdapterReadOperationForTest(input(), withReadBatch(fileSystem()), () => {
            throw new Error("lock failed");
        });
        expect(await throwingResolve.readAccess.resolveRootEntry("obl-1", "root-1")).toEqual(
            expect.objectContaining({ state: "failed", failureStatus: "io_error" }),
        );

        let throwingCalls = 0;
        const throwingRead = createAdapterReadOperationForTest(input(), withReadBatch(fileSystem()), () => {
            throwingCalls += 1;
            if (throwingCalls === 1) return { release() {} };
            throw new Error("lock failed");
        });
        const throwingRoot = await throwingRead.readAccess.resolveRootEntry("obl-1", "root-1");
        if (throwingRoot.state !== "succeeded") throw new Error("expected root");
        expect((await throwingRead.readAccess.readFile(throwingRoot.value.readEntryHandleId)).failureStatus).toBe("io_error");
    });

    it("detects physical replacement and both final-validation lock failures", async () => {
        let fileId = "10";
        const changingFs = {
            ...fileSystem(),
            readRegularFileNoFollow: () => ({
                bytes: Buffer.from("hello"),
                executable: false,
                identity: { ...FILE_ID, fileId },
            }),
        };
        const changed = createAdapterReadOperationForTest(input(), withReadBatch(changingFs), lockBatch);
        const root = await changed.readAccess.resolveRootEntry("obl-1", "root-1");
        if (root.state !== "succeeded") throw new Error("expected root");
        fileId = "11";
        expect((await changed.readAccess.readFile(root.value.readEntryHandleId)).failureStatus).toBe("stale");

        for (const finalLock of [
            () => null,
            () => {
                throw new Error("final lock");
            },
        ]) {
            let calls = 0;
            const lock = (...args: Parameters<typeof lockBatch>) => {
                calls += 1;
                return calls <= 2 ? lockBatch(...args) : finalLock();
            };
            const operation = createAdapterReadOperationForTest(input(), withReadBatch(fileSystem()), lock);
            const resolved = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
            if (resolved.state !== "succeeded") throw new Error("expected root");
            expect((await operation.readAccess.readFile(resolved.value.readEntryHandleId)).state).toBe("succeeded");
            expect(operation.finalValidate().valid).toBe(false);
        }
    });

    it("detects changed file bytes and changed directory inventory in either stable pass", async () => {
        let bytes = Buffer.from("before");
        const fileFs = fileSystem(bytes);
        fileFs.readRegularFileNoFollow = () => ({ bytes, executable: false, identity: FILE_ID });
        const file = createAdapterReadOperationForTest(input(), withReadBatch(fileFs), lockBatch);
        const fileRoot = await file.readAccess.resolveRootEntry("obl-1", "root-1");
        if (fileRoot.state !== "succeeded") throw new Error("expected root");
        await file.readAccess.readFile(fileRoot.value.readEntryHandleId);
        bytes = Buffer.from("after");
        expect(file.finalValidate().valid).toBe(false);

        let entries = [{ relativeName: "a.md", identity: CHILD_ID }];
        const dirFs = {
            ...fileSystem(),
            inventoryDirectoryNoFollow: () => ({ identity: DIR_ID, entries }),
        };
        const directory = createAdapterReadOperationForTest(input("directory_entry"), withReadBatch(dirFs), lockBatch);
        const dirRoot = await directory.readAccess.resolveRootEntry("obl-1", "root-1");
        if (dirRoot.state !== "succeeded") throw new Error("expected root");
        await directory.readAccess.listDirectory(dirRoot.value.readEntryHandleId);
        entries = [];
        expect(directory.finalValidate().valid).toBe(false);
    });

    it("uses canonical absolute file + immediate-parent keys with platform grammar", async () => {
        const winInput = input("recursive_entry");
        winInput.platform = "win32";
        winInput.sourceRoots[0]!.path = "C:\\source\\root";
        winInput.managedTargetGuards = [
            {
                sourceRootId: "foreign-root",
                matchKind: "entire_root",
                managementState: "active_managed",
                deploymentId: "00000000-0000-4000-8000-000000000001",
                outputUnitFingerprint: FP1,
            },
        ];
        const lockKeys: string[][] = [];
        const operation = createAdapterReadOperationForTest(
            winInput,
            withReadBatch({
                readRegularFileNoFollow: () => ({
                    bytes: Buffer.from("child"),
                    executable: false,
                    identity: CHILD_ID,
                }),
                inventoryDirectoryNoFollow: (target) => {
                    expect(target).toBe("C:\\source\\root");
                    return {
                        identity: DIR_ID,
                        entries: [{ relativeName: "child.md", identity: CHILD_ID }],
                    };
                },
            }),
            (_transactionsRoot, keys) => {
                lockKeys.push(keys);
                return { release() {} };
            },
        );
        const child = await operation.readAccess.resolveEntry("obl-1", "root-1", "child.md");
        if (child.state !== "succeeded") throw new Error("expected child");
        expect((await operation.readAccess.readFile(child.value.readEntryHandleId)).state).toBe("succeeded");
        expect(lockKeys).toEqual([
            ["win32\0C:\\source\\root", "win32\0C:\\source\\root\\child.md"],
            ["win32\0C:\\source\\root", "win32\0C:\\source\\root\\child.md"],
        ]);
    });

    it("maps unexpected filesystem errors and preserves final-validation failure status", async () => {
        const generic = createAdapterReadOperationForTest(
            input(),
            withReadBatch({
                ...fileSystem(),
                readRegularFileNoFollow: () => {
                    throw new Error("unexpected read");
                },
            }),
            lockBatch,
        );
        expect((await generic.readAccess.resolveRootEntry("obl-1", "root-1")).failureStatus).toBe("io_error");

        let reads = 0;
        const operation = createAdapterReadOperationForTest(
            input(),
            withReadBatch({
                ...fileSystem(),
                readRegularFileNoFollow: () => {
                    reads += 1;
                    if (reads >= 3) {
                        throw new SafeFilesystemError({
                            failureKind: "permission_denied",
                            operation: "read_regular_file",
                            targetPath: "/source/root",
                            message: "denied during final validation",
                        });
                    }
                    return { bytes: Buffer.from("hello"), executable: false, identity: FILE_ID };
                },
            }),
            lockBatch,
        );
        const resolved = await operation.readAccess.resolveRootEntry("obl-1", "root-1");
        if (resolved.state !== "succeeded") throw new Error("expected root");
        await operation.readAccess.readFile(resolved.value.readEntryHandleId);
        expect(operation.finalValidate().valid).toBe(false);
        expect(operation.snapshot().outcomes.at(-1)?.status).toBe("permission_denied");

        let boundedReads = 0;
        const bounded = createAdapterReadOperationForTest(
            limitedInput("fixed_file", { maxReadBytes: 5 }),
            withReadBatch({
                ...fileSystem(),
                readRegularFileNoFollow: () => {
                    boundedReads += 1;
                    if (boundedReads >= 3) {
                        throw new SafeFilesystemError({
                            failureKind: "resource_limit",
                            operation: "read_regular_file",
                            targetPath: "/source/root",
                            message: "grew during final validation",
                        });
                    }
                    return { bytes: Buffer.from("hello"), executable: false, identity: FILE_ID };
                },
            }),
            lockBatch,
        );
        const boundedRoot = await bounded.readAccess.resolveRootEntry("obl-1", "root-1");
        if (boundedRoot.state !== "succeeded") throw new Error("expected bounded root");
        await bounded.readAccess.readFile(boundedRoot.value.readEntryHandleId);
        expect(bounded.finalValidate()).toEqual(
            expect.objectContaining({
                valid: false,
                diagnostics: [expect.objectContaining({ code: "read.resource_limit_exceeded" })],
            }),
        );
    });

    it("fails external attestation when no frozen verifier is installed", async () => {
        const operation = createAdapterReadOperationForTest(input(), withReadBatch(fileSystem()), lockBatch);
        const result = await operation.readAccess.verifyExternalAttestation({
            verifier: {
                componentId: "mock",
                componentVersion: "1",
                configFingerprint: FP1,
            },
            subject: { subjectKind: "agent_runtime", agentRuntimeId: "MOCK_CLI" },
        });
        expect(result).toEqual(
            expect.objectContaining({
                state: "failed",
                failureStatus: "unsupported_verifier",
            }),
        );
    });
});
