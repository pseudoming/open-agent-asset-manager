import { describe, expect, it } from "vitest";
import type {
    AdapterAssetSourceCapability,
    AdapterProviderReadInput,
    OperationDiagnostic,
    ReadEntryHandle,
    SourceReadObligation,
    SourceRoot,
} from "@oaam/core";
import { traverseSourceRead, unavailableReferencedSourceFileRead, type SourceContextBase } from "../src";

type Context = SourceContextBase<"fixture">;

describe("unavailableReferencedSourceFileRead", () => {
    it("fails closed when a synthetic native-reopen scan cannot discover another file", async () => {
        await expect(unavailableReferencedSourceFileRead("unobserved.md")).resolves.toEqual({
            state: "failed",
            failureStatus: "not_found",
        });
    });
});

const root: SourceRoot = {
    sourceRootId: "root",
    rootRole: "source",
    sourceDomain: "family_shared",
    path: "/fixture",
    accessStatus: "available",
    locatorEvidence: [],
    diagnostics: [],
} as SourceRoot;

const obligation: SourceReadObligation = {
    sourceReadObligationId: "obligation",
    sourceRootId: "root",
    sourceCapabilityFingerprint: `sha256:${"1".repeat(64)}`,
};

const capability: AdapterAssetSourceCapability = {
    sourceCapabilityFingerprint: obligation.sourceCapabilityFingerprint,
    agentRuntimeId: "FIXTURE_CLI",
    entrySupportStatus: "supported",
    rootLocatorKind: "runtime_known_rule",
    rootRole: "source",
    sourceDomain: "family_shared",
    assetKind: "Guidance",
    sourcePathMechanism: "recursive_entry",
    evidenceLevel: "agent_runtime_verified",
    readPolicy: "auto_read",
    diagnostics: [],
};

function capabilityFor(
    sourcePathMechanism: AdapterAssetSourceCapability["sourcePathMechanism"],
    overrides: Partial<AdapterAssetSourceCapability> = {},
): AdapterAssetSourceCapability {
    return { ...capability, sourcePathMechanism, ...overrides };
}

const context: Context = {
    root,
    scope: "global",
    projectRootPath: "",
    layout: "fixture",
};

function handle(id: string, relativePath: string, entryKind: "file" | "directory"): ReadEntryHandle {
    return {
        readEntryHandleId: id,
        sourceReadObligationId: obligation.sourceReadObligationId,
        sourceRootId: root.sourceRootId,
        relativePath,
        entryKind,
    } as ReadEntryHandle;
}

function diagnostic(code: string): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message: code,
        path: root.path,
        traceId: "",
        operation: "read",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}

function policy(onFileReadFailure?: (relativePath: string) => void, onDirectoryReadFailure?: (relativePath: string) => void) {
    return {
        shouldEnterDirectory: (_kind: string, _context: Context, relativePath: string) => relativePath === "relevant",
        shouldReadFile: (_kind: string, _context: Context, relativePath: string) => relativePath.endsWith(".md"),
        dispositionId: (entry: ReadEntryHandle) => `disposition:${entry.readEntryHandleId}`,
        rootEntryKindDiagnostic: (_context: Context, expectedKind: "file" | "directory") =>
            diagnostic(`fixture.root_not_${expectedKind}`),
        mechanismNotCallableDiagnostic: () => diagnostic("fixture.mechanism_not_callable"),
        onFileReadFailure,
        onDirectoryReadFailure,
    };
}

describe("source traversal", () => {
    it("ignores a declared whole managed entry before raw access and retains independent files", async () => {
        const rootHandle = handle("root-dir", "", "directory");
        const managed = handle("managed", "relevant", "directory");
        const ordinary = handle("ordinary", "notes.md", "file");
        const outside = handle("outside", "unrelated.bin", "file");
        const calls = { resolve: 0, list: 0, read: 0 };
        const readInput = input({ rootHandle, calls, listings: new Map([["root-dir", [managed, ordinary, outside]]]) });
        readInput.managedTargetGuards = [
            {
                sourceRootId: root.sourceRootId,
                relativePath: "relevant",
                matchKind: "directory_prefix",
                managementState: "active_managed",
                deploymentId: "00000000-0000-4000-8000-000000000911",
                outputUnitFingerprint: obligation.sourceCapabilityFingerprint,
            },
        ];
        const ancestors: string[][] = [];
        const scan = await traverseSourceRead(readInput, obligation, capability, context, {
            ...policy(),
            isIndependentSourceEntry: (_kind, _context, _entry, ancestorFiles) => {
                ancestors.push(ancestorFiles.map((file) => file.relativePath));
                return true;
            },
        });
        expect(calls).toEqual({ resolve: 1, list: 1, read: 1 });
        expect(scan.files.map((file) => file.relativePath)).toEqual(["notes.md"]);
        expect(ancestors).toEqual([["notes.md", "unrelated.bin"]]);
        expect(scan.dispositions).toContainEqual(
            expect.objectContaining({
                readEntryHandleId: "managed",
                disposition: "ignored",
                reasonCode: "oaam_managed_source_entry",
            }),
        );
        expect(scan.dispositions).toContainEqual(
            expect.objectContaining({
                readEntryHandleId: "outside",
                disposition: "ignored",
                reasonCode: "outside_source_pattern",
            }),
        );
        expect(scan.diagnostics).toEqual([
            expect.objectContaining({ severity: "info", code: "read.managed_source_entry_ignored", path: "relevant" }),
        ]);
        readInput.readAccess.resolveEntry = async () => ({
            state: "failed",
            readAccessOutcomeId: "managed-reference",
            failureStatus: "blocked_managed_target",
            diagnostics: [],
        });
        expect(await scan.readReferencedFile("relevant/SKILL.md")).toEqual({
            state: "failed",
            failureStatus: "blocked_managed_target",
        });
    });

    it.each([
        undefined,
        false,
    ] as const)("delegates a guarded entry to Core when the independent boundary is %s", async (independent) => {
        const rootHandle = handle("root-dir", "", "directory"),
            managed = handle("managed", "relevant", "directory");
        const calls = { resolve: 0, list: 0, read: 0 };
        const readInput = input({
            rootHandle,
            calls,
            listings: new Map([["root-dir", [managed]]]),
            failedListHandleId: "managed",
        });
        readInput.managedTargetGuards = [
            {
                sourceRootId: root.sourceRootId,
                relativePath: "relevant",
                matchKind: "directory_prefix",
                managementState: "active_managed",
                deploymentId: "00000000-0000-4000-8000-000000000911",
                outputUnitFingerprint: obligation.sourceCapabilityFingerprint,
            },
        ];
        const scan = await traverseSourceRead(readInput, obligation, capability, context, {
            ...policy(),
            ...(independent === undefined ? {} : { isIndependentSourceEntry: () => independent }),
        });
        expect(calls.list).toBe(2);
        expect(scan.dispositions).toContainEqual(
            expect.objectContaining({ readEntryHandleId: "managed", reasonCode: "directory_unreadable" }),
        );
        expect(scan.diagnostics).toEqual([]);
    });

    it("returns an empty scan when Core cannot resolve the source root", async () => {
        const scan = await traverseSourceRead(input({ resolveState: "failed" }), obligation, capability, context, policy());
        expect(scan).toEqual(expect.objectContaining({ files: [], directories: [], dispositions: [], diagnostics: [] }));
    });

    it("classifies a file root as ignored with the family diagnostic", async () => {
        const scan = await traverseSourceRead(
            input({ rootHandle: handle("root-file", "", "file") }),
            obligation,
            capabilityFor("recursive_entry"),
            context,
            policy(),
        );
        expect(scan.hadIgnoredSource).toBe(true);
        expect(scan.diagnostics).toEqual([expect.objectContaining({ code: "fixture.root_not_directory" })]);
        expect(scan.dispositions).toEqual([
            expect.objectContaining({
                readEntryHandleId: "root-file",
                disposition: "ignored",
                reasonCode: "source_root_not_directory",
            }),
        ]);
    });

    it.each([
        "fixed_file",
        "manifest_declared",
    ] as const)("reads a %s root file directly and never lists it as a directory", async (sourcePathMechanism) => {
        const calls = { resolve: 0, list: 0, read: 0 };
        const rootFile = handle("root-file", "", "file");
        const scan = await traverseSourceRead(
            input({ rootHandle: rootFile, calls }),
            obligation,
            capabilityFor(sourcePathMechanism),
            context,
            policy(),
        );

        expect(calls).toEqual({ resolve: 1, list: 0, read: 1 });
        expect(scan.files).toEqual([expect.objectContaining({ handle: rootFile, relativePath: "" })]);
        expect(scan.directories).toEqual([]);
        expect(scan.dispositions).toEqual([
            expect.objectContaining({
                readEntryHandleId: rootFile.readEntryHandleId,
                disposition: "parsed",
                readAccessOutcomeId: `read:${rootFile.readEntryHandleId}`,
            }),
        ]);
    });

    it.each([
        "directory_entry",
        "recursive_entry",
    ] as const)("lists a %s root directory and never reads the root as a file", async (sourcePathMechanism) => {
        const calls = { resolve: 0, list: 0, read: 0 };
        const rootDirectory = handle("root-dir", "", "directory");
        const scan = await traverseSourceRead(
            input({ rootHandle: rootDirectory, calls }),
            obligation,
            capabilityFor(sourcePathMechanism),
            context,
            policy(),
        );

        expect(calls).toEqual({ resolve: 1, list: 1, read: 0 });
        expect(scan.files).toEqual([]);
        expect(scan.directories).toEqual([expect.objectContaining({ handle: rootDirectory, relativePath: "" })]);
        expect(scan.dispositions).toEqual([
            expect.objectContaining({
                readEntryHandleId: rootDirectory.readEntryHandleId,
                disposition: "traversed",
                listDirectoryOutcomeId: `list:${rootDirectory.readEntryHandleId}`,
            }),
        ]);
    });

    it("rejects a directory root for a file mechanism with a typed terminal disposition", async () => {
        const rootDirectory = handle("root-dir", "", "directory");
        const scan = await traverseSourceRead(
            input({ rootHandle: rootDirectory }),
            obligation,
            capabilityFor("fixed_file"),
            context,
            policy(),
        );

        expect(scan.hadIgnoredSource).toBe(true);
        expect(scan.diagnostics).toEqual([expect.objectContaining({ code: "fixture.root_not_file" })]);
        expect(scan.dispositions).toEqual([
            expect.objectContaining({
                readEntryHandleId: rootDirectory.readEntryHandleId,
                disposition: "ignored",
                reasonCode: "source_root_not_file",
            }),
        ]);
    });

    it.each([
        capabilityFor("unknown"),
        capabilityFor("fixed_file", { entrySupportStatus: "deferred" }),
        capabilityFor("fixed_file", { readPolicy: "report_only" }),
        capabilityFor("fixed_file", { readPolicy: "user_selected_root_only" }),
    ])("rejects a non-callable mechanism before resolving any root", async (row) => {
        const calls = { resolve: 0, list: 0, read: 0 };
        const scan = await traverseSourceRead(
            input({ rootHandle: handle("root-file", "", "file"), calls }),
            obligation,
            row,
            context,
            policy(),
        );

        expect(calls).toEqual({ resolve: 0, list: 0, read: 0 });
        expect(scan.hadIgnoredSource).toBe(true);
        expect(scan.diagnostics).toEqual([expect.objectContaining({ code: "fixture.mechanism_not_callable" })]);
        expect(scan.dispositions).toEqual([]);
    });

    it("closes every traversed, filtered, unreadable, and binary handle deterministically", async () => {
        const unreadable: string[] = [];
        const rootHandle = handle("root-dir", "", "directory");
        const relevant = handle("relevant", "relevant", "directory");
        const skippedDirectory = handle("skip-dir", "skip", "directory");
        const good = handle("good", "good.md", "file");
        const skippedFile = handle("skip-file", "skip.txt", "file");
        const unreadableFile = handle("unreadable", "relevant/unreadable.md", "file");
        const binaryFile = handle("binary", "relevant/binary.md", "file");
        const scan = await traverseSourceRead(
            input({
                rootHandle,
                listings: new Map([
                    [rootHandle.readEntryHandleId, [skippedFile, skippedDirectory, good, relevant]],
                    [relevant.readEntryHandleId, [unreadableFile, binaryFile]],
                ]),
                unreadableHandleId: unreadableFile.readEntryHandleId,
                binaryHandleId: binaryFile.readEntryHandleId,
            }),
            obligation,
            capability,
            context,
            policy((relativePath) => unreadable.push(relativePath)),
            { marker: "extension" },
        );

        expect(scan.marker).toBe("extension");
        expect(scan.directories.map((item) => item.relativePath)).toEqual(["", "relevant"]);
        expect(scan.files.map((item) => [item.relativePath, item.text])).toEqual([
            ["good.md", "good.md"],
            ["relevant/binary.md", null],
        ]);
        expect(unreadable).toEqual(["relevant/unreadable.md"]);
        expect(scan.dispositions).toHaveLength(7);
        expect(new Set(scan.dispositions.map((item) => item.readEntryHandleId)).size).toBe(7);
        expect(scan.observedReadEntryIds).toHaveLength(4);

        const goodRecord = scan.files.find((item) => item.handle === good);
        const rootRecord = scan.directories[0];
        if (goodRecord === undefined || rootRecord === undefined) {
            throw new Error("expected scanned records");
        }
        scan.attachCandidate("z", [goodRecord, rootRecord]);
        scan.attachCandidate("a", [goodRecord, rootRecord]);
        scan.attachCandidate("a", [goodRecord]);
        scan.attachCandidate("ignored", [{ ...goodRecord, handle: handle("unknown", "unknown.md", "file") }]);
        expect(
            scan.dispositions
                .filter((item) => item.disposition !== "ignored" && item.candidateIds.length > 0)
                .map((item) => item.candidateIds),
        ).toEqual([
            ["a", "z"],
            ["a", "z"],
        ]);

        scan.ignoreRecord(goodRecord, "candidate_rejected");
        scan.ignoreRecord(goodRecord, "ignored_twice");
        scan.ignoreHandle(rootHandle, "root_rejected");
        const extra = handle("extra", "extra.md", "file");
        scan.ignoreHandle(extra, "classification_only");
        scan.ignoreHandle(extra, "ignored_twice");
        expect(scan.hadIgnoredSource).toBe(true);
        expect(scan.dispositions).toHaveLength(8);
        expect(scan.dispositions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ readEntryHandleId: "good", reasonCode: "candidate_rejected" }),
                expect.objectContaining({ readEntryHandleId: "root-dir", reasonCode: "root_rejected" }),
                expect.objectContaining({ readEntryHandleId: "extra", reasonCode: "classification_only" }),
            ]),
        );
    });

    it("marks a failed directory list and failed file read without optional callbacks", async () => {
        const failedDirectory = await traverseSourceRead(
            input({ failedListHandleId: "root-dir" }),
            obligation,
            capability,
            context,
            policy(),
        );
        expect(failedDirectory.dispositions[0]).toEqual(expect.objectContaining({ reasonCode: "directory_unreadable" }));

        const rootHandle = handle("root-dir", "", "directory");
        const failedFile = handle("failed-file", "failed.md", "file");
        const scan = await traverseSourceRead(
            input({
                rootHandle,
                listings: new Map([[rootHandle.readEntryHandleId, [failedFile]]]),
                unreadableHandleId: failedFile.readEntryHandleId,
            }),
            obligation,
            capability,
            context,
            policy(),
        );
        expect(scan.dispositions).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: "file_unreadable" })]));
    });

    it("resolves manifest-referenced files through the same bounded authority and disposition ledger", async () => {
        const unreadable: string[] = [];
        const rootHandle = handle("root-dir", "", "directory");
        const known = handle("known", "known.md", "file");
        const extra = handle("extra", "extra.md", "file");
        const folder = handle("folder", "folder", "directory");
        const unreadableFile = handle("unreadable", "unreadable.md", "file");
        const scan = await traverseSourceRead(
            input({
                rootHandle,
                listings: new Map([[rootHandle.readEntryHandleId, [known]]]),
                resolvedEntries: new Map([
                    [extra.relativePath, extra],
                    [folder.relativePath, folder],
                    [unreadableFile.relativePath, unreadableFile],
                ]),
                unreadableHandleId: unreadableFile.readEntryHandleId,
            }),
            obligation,
            capability,
            context,
            policy((relativePath) => unreadable.push(relativePath)),
        );

        expect(await scan.readReferencedFile("known.md")).toEqual({
            state: "succeeded",
            file: expect.objectContaining({ relativePath: "known.md" }),
        });
        const added = await scan.readReferencedFile("extra.md");
        expect(added).toEqual({ state: "succeeded", file: expect.objectContaining({ relativePath: "extra.md" }) });
        if (added.state !== "succeeded") throw new Error("referenced fixture was not read");
        scan.attachCandidate("candidate", [added.file]);
        expect(scan.dispositions).toContainEqual(
            expect.objectContaining({
                readEntryHandleId: extra.readEntryHandleId,
                disposition: "parsed",
                candidateIds: ["candidate"],
            }),
        );
        expect(await scan.readReferencedFile("missing.md")).toEqual({ state: "failed", failureStatus: "not_found" });
        expect(await scan.readReferencedFile("folder")).toEqual({
            state: "failed",
            failureStatus: "not_file",
            handle: folder,
        });
        expect(await scan.readReferencedFile("unreadable.md")).toEqual({
            state: "failed",
            failureStatus: "io_error",
            handle: unreadableFile,
        });
        expect(unreadable).toEqual(["unreadable.md"]);
        expect(scan.dispositions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ readEntryHandleId: folder.readEntryHandleId, disposition: "ignored" }),
                expect.objectContaining({ readEntryHandleId: unreadableFile.readEntryHandleId, disposition: "ignored" }),
            ]),
        );
    });

    it("reports the exact unreadable directory path without exposing the Core read port", async () => {
        const unreadableDirectories: string[] = [];
        const rootHandle = handle("root-dir", "", "directory");
        const relevant = handle("relevant", "relevant", "directory");
        const scan = await traverseSourceRead(
            input({
                rootHandle,
                listings: new Map([[rootHandle.readEntryHandleId, [relevant]]]),
                failedListHandleId: relevant.readEntryHandleId,
            }),
            obligation,
            capability,
            context,
            policy(undefined, (relativePath) => unreadableDirectories.push(relativePath)),
        );
        expect(unreadableDirectories).toEqual(["relevant"]);
        expect(scan.dispositions).toContainEqual(
            expect.objectContaining({ readEntryHandleId: "relevant", reasonCode: "directory_unreadable" }),
        );
    });
});

interface InputOptions {
    resolveState?: "failed";
    rootHandle?: ReadEntryHandle;
    listings?: Map<string, ReadEntryHandle[]>;
    resolvedEntries?: Map<string, ReadEntryHandle>;
    failedListHandleId?: string;
    unreadableHandleId?: string;
    binaryHandleId?: string;
    calls?: { resolve: number; list: number; read: number };
}

function input(options: InputOptions = {}): AdapterProviderReadInput {
    const rootHandle = options.rootHandle ?? handle("root-dir", "", "directory");
    return {
        target: { sourceSelector: { selectorKind: "probe_roots" } },
        sourceReadObligations: [obligation],
        managedTargetGuards: [],
        readAuthorityFingerprint: obligation.sourceCapabilityFingerprint,
        readAccess: {
            async resolveRootEntry() {
                if (options.calls !== undefined) options.calls.resolve += 1;
                return options.resolveState === "failed"
                    ? {
                          state: "failed",
                          readAccessOutcomeId: "resolve-failed",
                          failureStatus: "io_error",
                          diagnostics: [],
                      }
                    : {
                          state: "succeeded",
                          readAccessOutcomeId: "resolve",
                          value: rootHandle,
                      };
            },
            async resolveEntry(_obligationId, _sourceRootId, relativePath) {
                if (options.calls !== undefined) options.calls.resolve += 1;
                const entry = options.resolvedEntries?.get(relativePath);
                return entry === undefined
                    ? {
                          state: "failed",
                          readAccessOutcomeId: `resolve-entry:${relativePath}`,
                          failureStatus: "not_found",
                          diagnostics: [],
                      }
                    : {
                          state: "succeeded",
                          readAccessOutcomeId: `resolve-entry:${relativePath}`,
                          value: entry,
                      };
            },
            async listDirectory(handleId) {
                if (options.calls !== undefined) options.calls.list += 1;
                if (options.failedListHandleId === handleId) {
                    return {
                        state: "failed",
                        readAccessOutcomeId: `list:${handleId}`,
                        failureStatus: "io_error",
                        diagnostics: [],
                    };
                }
                const current =
                    handleId === rootHandle.readEntryHandleId
                        ? rootHandle
                        : [...(options.listings?.values() ?? []), options.resolvedEntries?.values() ?? []]
                              .flatMap((entries) => [...entries])
                              .find((item) => item.readEntryHandleId === handleId);
                if (current === undefined) throw new Error(`unknown directory handle: ${handleId}`);
                return {
                    state: "succeeded",
                    readAccessOutcomeId: `list:${handleId}`,
                    value: {
                        directory: {
                            observedReadEntryId: `observed:${handleId}`,
                            sourceRootId: root.sourceRootId,
                            relativePath: current.relativePath,
                            entryKind: "directory",
                            physicalIdentityFingerprint: obligation.sourceCapabilityFingerprint,
                            directoryInventoryFingerprint: obligation.sourceCapabilityFingerprint,
                        },
                        children: options.listings?.get(handleId) ?? [],
                    },
                };
            },
            async readFile(handleId) {
                if (options.calls !== undefined) options.calls.read += 1;
                if (options.unreadableHandleId === handleId) {
                    return {
                        state: "failed",
                        readAccessOutcomeId: `read:${handleId}`,
                        failureStatus: "io_error",
                        diagnostics: [],
                    };
                }
                const current =
                    handleId === rootHandle.readEntryHandleId
                        ? rootHandle
                        : [...(options.listings?.values() ?? []), options.resolvedEntries?.values() ?? []]
                              .flatMap((entries) => [...entries])
                              .find((item) => item.readEntryHandleId === handleId);
                if (current === undefined) throw new Error(`unknown file handle: ${handleId}`);
                const bytes =
                    options.binaryHandleId === handleId ? new Uint8Array([0xff]) : new TextEncoder().encode(current.relativePath);
                return {
                    state: "succeeded",
                    readAccessOutcomeId: `read:${handleId}`,
                    value: {
                        entry: {
                            observedReadEntryId: `observed:${handleId}`,
                            sourceRootId: root.sourceRootId,
                            relativePath: current.relativePath,
                            entryKind: "file",
                            contentHash: obligation.sourceCapabilityFingerprint,
                            executable: false,
                            physicalIdentityFingerprint: obligation.sourceCapabilityFingerprint,
                        },
                        bytes,
                    },
                };
            },
            async verifyExternalAttestation() {
                throw new Error("not used");
            },
        },
    } as AdapterProviderReadInput;
}
