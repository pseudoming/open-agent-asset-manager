import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
    SafeFilesystemError,
    type StableDirectoryInventory,
} from "@oaam/shared/filesystem";
import { readPlatformContextRegularFileNoFollow } from "@oaam/shared/paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadAccessFailure } from "../../src/adapters/adapter-read-budget";
import { physicalIdentityFingerprint } from "../../src/adapters/adapter-read-physical-authority";
import { resolveDeploymentContainerPatches } from "../../src/deployment/deployment-container-patch";
import {
    assetUsageTargetObservationInternalsForTest,
    observeAssetUsageTarget,
} from "../../src/orchestration/asset-usage-target-observation";
import { createTargetCheckObservationSnapshot } from "../../src/render/native-project-target-observation-snapshot";
import type { CoreRenderMaterializationView } from "../../src/render/render-materialization";
import type { ImportSourceSnapshotV1, MaterializedRenderFile, PlatformContext, Sha256Digest } from "../../src/types";

const SHA = `sha256:${"a".repeat(64)}` as Sha256Digest;
const SEMANTIC = `sha256:${"b".repeat(64)}` as Sha256Digest;

describe("fresh read-only Asset usage target observation", () => {
    let targetRoot = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-asset-usage-observation-"));
        platformContext = { platform: "linux", platformInstanceId: "local", accessRootPath: targetRoot };
    });

    afterEach(() => {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    });

    it("distinguishes absent, exact current-Version bytes, different bytes, and an unreadable target", () => {
        const current = materialization([textFile("AGENTS.md", "# current Version\n")]);
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("absent");

        fs.writeFileSync(path.join(targetRoot, "AGENTS.md"), "# current Version\n");
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("already_usable");

        fs.writeFileSync(path.join(targetRoot, "AGENTS.md"), "# older Version\n");
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("different");

        fs.rmSync(path.join(targetRoot, "AGENTS.md"));
        fs.symlinkSync(path.join(targetRoot, "missing-source"), path.join(targetRoot, "AGENTS.md"));
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("unknown");
    });

    it("requires the complete owned directory graph instead of accepting an entry-file match", () => {
        const current = materialization(
            [textFile(".agents/demo/agent.md", "# demo\n"), textFile(".agents/demo/references/guide.md", "# guide\n")],
            [".agents/demo"],
        );
        fs.mkdirSync(path.join(targetRoot, ".agents", "demo", "references"), { recursive: true });
        fs.writeFileSync(path.join(targetRoot, ".agents", "demo", "agent.md"), "# demo\n");
        fs.writeFileSync(path.join(targetRoot, ".agents", "demo", "references", "guide.md"), "# guide\n");
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("already_usable");

        fs.writeFileSync(path.join(targetRoot, ".agents", "demo", "stale.txt"), "stale\n");
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("different");

        fs.rmSync(path.join(targetRoot, ".agents"), { recursive: true, force: true });
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("absent");
    });

    it("keeps an explicit Version-native empty directory in the exact target graph", () => {
        const boundary = ".agents/demo";
        const current = materialization(
            [textFile(`${boundary}/agent.md`, "# demo\n"), textFile(`${boundary}/references/guide.md`, "# guide\n")],
            [
                {
                    relativePath: boundary,
                    desiredDirectoryPaths: [boundary, `${boundary}/empty`, `${boundary}/references`],
                },
            ],
        );
        fs.mkdirSync(path.join(targetRoot, boundary, "empty"), { recursive: true });
        fs.mkdirSync(path.join(targetRoot, boundary, "references"), { recursive: true });
        fs.writeFileSync(path.join(targetRoot, boundary, "agent.md"), "# demo\n");
        fs.writeFileSync(path.join(targetRoot, boundary, "references", "guide.md"), "# guide\n");
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("already_usable");

        fs.rmSync(path.join(targetRoot, boundary, "empty"), { recursive: true });
        expect(observe(current, targetRoot, platformContext).observedTargetState).toBe("different");
    });

    it("compares the complete resolved shared JSONC document while preserving unrelated content", () => {
        const targetPath = path.join(targetRoot, "settings.jsonc");
        const matching = '{\n  "provider": { "theme": "warm" },\n  "instructions": ["current.md"]\n}\n';
        fs.writeFileSync(targetPath, matching);
        const fragment = materialization([
            {
                ...binaryFile("settings.jsonc", new TextEncoder().encode('["current.md"]')),
                containerPatch: {
                    patchKind: "jsonc_top_level_property_value",
                    propertyName: "instructions",
                },
            },
        ]);
        const resolvedMatching = resolveDeploymentContainerPatches(fragment, targetRoot);
        expect(resolvedMatching.status).toBe("complete");
        expect(observe(resolvedMatching.value, targetRoot, platformContext).observedTargetState).toBe("already_usable");

        fs.writeFileSync(targetPath, '{\n  "provider": { "theme": "warm" },\n  "instructions": ["old.md"]\n}\n');
        const resolvedDifferent = resolveDeploymentContainerPatches(fragment, targetRoot);
        expect(resolvedDifferent.status).toBe("complete");
        expect(observe(resolvedDifferent.value, targetRoot, platformContext).observedTargetState).toBe("different");
    });

    it("accepts a same-context shared physical file but keeps an unproved cross-context alias unknown", () => {
        const current = materialization([textFile("AGENTS.md", "# shared\n")]);
        const targetPath = path.join(targetRoot, "AGENTS.md");
        fs.writeFileSync(targetPath, "# shared\n");
        const identity = readRegularFileNoFollow(targetPath).identity;

        const sameContext = sourceSnapshot(physicalIdentityFingerprint("linux", identity));
        expect(observe(current, targetRoot, platformContext, sameContext)).toEqual({
            observedTargetState: "already_usable",
            physicalRelation: "same_context_source",
        });

        const crossContext = sourceSnapshot(physicalIdentityFingerprint("wsl", identity));
        expect(observe(current, targetRoot, platformContext, crossContext)).toEqual({
            observedTargetState: "unknown",
            physicalRelation: "cross_context_unverified",
        });

        const sourceWithDirectory = sourceSnapshot(physicalIdentityFingerprint("linux", identity), true);
        expect(observe(current, targetRoot, platformContext, sourceWithDirectory)).toEqual({
            observedTargetState: "already_usable",
            physicalRelation: "same_context_source",
        });
    });

    it("preserves physical relation evidence when current target bytes differ", () => {
        const current = materialization([textFile("AGENTS.md", "# current\n")]);
        const targetPath = path.join(targetRoot, "AGENTS.md");
        fs.writeFileSync(targetPath, "# older\n");
        const identity = readRegularFileNoFollow(targetPath).identity;

        expect(
            observe(current, targetRoot, platformContext, sourceSnapshot(physicalIdentityFingerprint("linux", identity))),
        ).toEqual({ observedTargetState: "different", physicalRelation: "same_context_source" });
        expect(
            observe(current, targetRoot, platformContext, sourceSnapshot(physicalIdentityFingerprint("wsl", identity))),
        ).toEqual({ observedTargetState: "different", physicalRelation: "cross_context_unverified" });
    });

    it("fails closed for empty, oversized, duplicate-output, and duplicate-boundary observations", () => {
        expect(observe(materialization([]), targetRoot, platformContext).observedTargetState).toBe("unknown");
        expect(
            observe(materialization([textFile("large.md", "x".repeat(4 * 1024 * 1024 + 1))]), targetRoot, platformContext)
                .observedTargetState,
        ).toBe("unknown");

        const repeated = textFile("AGENTS.md", "# repeated\n");
        expect(
            observe(materialization([repeated, structuredClone(repeated)]), targetRoot, platformContext).observedTargetState,
        ).toBe("unknown");
        expect(
            observe(materialization([textFile("tree/AGENTS.md", "# tree\n")], ["tree", "tree"]), targetRoot, platformContext)
                .observedTargetState,
        ).toBe("unknown");
    });

    it("maps only a typed selected-WSL not_found read to absent", () => {
        const wslContext: PlatformContext = {
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example\\project",
        };
        const observeFailure = (failureKind: "not_found" | "permission_denied") =>
            assetUsageTargetObservationInternalsForTest.observeWithDependencies(
                {
                    materialization: materialization([textFile("CLAUDE.md", "# current Version\n")]),
                    targetRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example\\project",
                    platformContext: wslContext,
                },
                {
                    readRegularFile: (input) => {
                        throw new SafeFilesystemError({
                            failureKind,
                            operation: "inspect_regular_file",
                            targetPath: input.filePath,
                            systemCode: failureKind === "not_found" ? "ENOENT" : "WSL_EXIT_1",
                            message: "selected WSL fixture failure",
                        });
                    },
                    inventoryDirectory: inventoryDirectoryNoFollow,
                },
            );

        expect(observeFailure("not_found").observedTargetState).toBe("absent");
        expect(observeFailure("permission_denied")).toEqual({
            observedTargetState: "unknown",
            physicalRelation: "distinct_or_not_imported",
            failureStatus: "permission_denied",
        });
    });

    it.each([
        "permission_denied",
        "blocked_managed_target",
        "blocked_symlink_or_reparse",
        "resource_limit_exceeded",
        "busy",
        "stale",
        "io_error",
    ] as const)("preserves %s through the primed read and strips raw error details", async (status) => {
        const snapshot = createTargetCheckObservationSnapshot();
        const readRegularFile = vi.fn(async () => {
            throw new ReadAccessFailure(status, "/private/source: raw error");
        });
        const location = { targetRootPath: targetRoot, platformContext, targetCheckSnapshot: snapshot };
        await assetUsageTargetObservationInternalsForTest.primeAsyncWithDependencies(
            { ...location, relativePaths: ["AGENTS.md"] },
            { readRegularFile },
        );
        const result = await assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
            { ...location, materialization: materialization([textFile("AGENTS.md", "content")]) },
            { readRegularFile, inventoryDirectory: inventoryDirectoryNoFollow },
        );
        expect(result).toEqual({
            observedTargetState: "unknown",
            physicalRelation: "distinct_or_not_imported",
            failureStatus: status,
        });
        expect(readRegularFile).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).not.toMatch(/private|raw error/);
    });

    it("classifies an oversized expected file as a resource limit before any async physical read", async () => {
        const readRegularFile = vi.fn(async (input: { filePath: string }) => readRegularFileNoFollow(input.filePath));
        const result = await assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
            {
                materialization: materialization([textFile("large.md", "x".repeat(4 * 1024 * 1024 + 1))]),
                targetRootPath: targetRoot,
                platformContext,
            },
            { readRegularFile, inventoryDirectory: inventoryDirectoryNoFollow },
        );
        expect(result).toEqual({
            observedTargetState: "unknown",
            physicalRelation: "distinct_or_not_imported",
            failureStatus: "resource_limit_exceeded",
        });
        expect(readRegularFile).not.toHaveBeenCalled();
    });

    it("starts independent stable file reads together and preserves exact failure semantics", async () => {
        await expect(
            assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
                { materialization: materialization([]), targetRootPath: targetRoot, platformContext },
                {
                    readRegularFile: async (input) => readPlatformContextRegularFileNoFollow(input),
                    inventoryDirectory: inventoryDirectoryNoFollow,
                },
            ),
        ).resolves.toEqual({ observedTargetState: "unknown", physicalRelation: "distinct_or_not_imported" });

        const current = materialization([
            textFile("one.md", "one\n"),
            textFile("two.md", "two\n"),
            textFile("three.md", "three\n"),
        ]);
        const pending = new Map<
            string,
            {
                readonly promise: Promise<ReturnType<typeof readRegularFileNoFollow>>;
                resolve(value: ReturnType<typeof readRegularFileNoFollow>): void;
            }
        >();
        const readRegularFile = vi.fn((input: { readonly filePath: string }) => {
            let resolve!: (value: ReturnType<typeof readRegularFileNoFollow>) => void;
            const promise = new Promise<ReturnType<typeof readRegularFileNoFollow>>((settle) => {
                resolve = settle;
            });
            pending.set(input.filePath, { promise, resolve });
            return promise;
        });
        const running = assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
            { materialization: current, targetRootPath: targetRoot, platformContext },
            { readRegularFile, inventoryDirectory: inventoryDirectoryNoFollow },
        );
        await vi.waitFor(() => expect(readRegularFile).toHaveBeenCalledTimes(3));
        expect([...pending.keys()].sort()).toEqual(
            ["one.md", "three.md", "two.md"].map((name) => path.join(targetRoot, name)).sort(),
        );
        for (const [name, text] of [
            ["one.md", "one\n"],
            ["two.md", "two\n"],
            ["three.md", "three\n"],
        ] as const) {
            const filePath = path.join(targetRoot, name);
            fs.writeFileSync(filePath, text);
            pending.get(filePath)?.resolve(readRegularFileNoFollow(filePath));
        }
        await expect(running).resolves.toEqual({
            observedTargetState: "already_usable",
            physicalRelation: "distinct_or_not_imported",
        });

        const onePath = path.join(targetRoot, "one.md");
        await expect(
            assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
                {
                    materialization: materialization([textFile("one.md", "one\n")]),
                    targetRootPath: targetRoot,
                    platformContext,
                    sourceSnapshot: sourceSnapshot(
                        physicalIdentityFingerprint("linux", readRegularFileNoFollow(onePath).identity),
                        true,
                    ),
                },
                {
                    readRegularFile: async (input) => readPlatformContextRegularFileNoFollow(input),
                    inventoryDirectory: inventoryDirectoryNoFollow,
                },
            ),
        ).resolves.toEqual({ observedTargetState: "already_usable", physicalRelation: "same_context_source" });

        const failed = await assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
            { materialization: current, targetRootPath: targetRoot, platformContext },
            {
                readRegularFile: async (input) => {
                    if (input.filePath.endsWith("two.md")) {
                        throw new SafeFilesystemError({
                            failureKind: "permission_denied",
                            operation: "read_regular_file",
                            targetPath: input.filePath,
                            systemCode: "EACCES",
                            message: "fixture permission failure",
                        });
                    }
                    return readPlatformContextRegularFileNoFollow(input);
                },
                inventoryDirectory: inventoryDirectoryNoFollow,
            },
        );
        expect(failed.observedTargetState).toBe("unknown");
    });

    it("uses one operation-local target sample for concurrent provider comparisons", async () => {
        const targetPath = path.join(targetRoot, "AGENTS.md");
        const snapshot = createTargetCheckObservationSnapshot();
        let release!: (value: ReturnType<typeof readRegularFileNoFollow>) => void;
        const pending = new Promise<ReturnType<typeof readRegularFileNoFollow>>((resolve) => {
            release = resolve;
        });
        const readRegularFile = vi.fn(() => pending);
        const observeWithContent = (content: string) =>
            assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
                {
                    materialization: materialization([textFile("AGENTS.md", content)]),
                    targetRootPath: targetRoot,
                    platformContext,
                    targetCheckSnapshot: snapshot,
                },
                { readRegularFile, inventoryDirectory: inventoryDirectoryNoFollow },
            );
        const matchingOne = observeWithContent("shared\n");
        const matchingTwo = observeWithContent("shared\n");
        const different = observeWithContent("different\n");
        await vi.waitFor(() => expect(readRegularFile).toHaveBeenCalledTimes(1));
        fs.writeFileSync(targetPath, "shared\n");
        release(readRegularFileNoFollow(targetPath));
        await expect(Promise.all([matchingOne, matchingTwo, different])).resolves.toEqual([
            { observedTargetState: "already_usable", physicalRelation: "distinct_or_not_imported" },
            { observedTargetState: "already_usable", physicalRelation: "distinct_or_not_imported" },
            { observedTargetState: "different", physicalRelation: "distinct_or_not_imported" },
        ]);
        expect(readRegularFile).toHaveBeenCalledTimes(1);
    });

    it("primes validated target claims once and retains an exact read failure for later classification", async () => {
        const snapshot = createTargetCheckObservationSnapshot();
        const targetPath = path.join(targetRoot, "AGENTS.md");
        fs.writeFileSync(targetPath, "primed\n");
        const readRegularFile = vi.fn(async (input: { readonly filePath: string }) => readRegularFileNoFollow(input.filePath));
        await assetUsageTargetObservationInternalsForTest.primeAsyncWithDependencies(
            {
                relativePaths: ["AGENTS.md", "AGENTS.md"],
                targetRootPath: targetRoot,
                platformContext,
                targetCheckSnapshot: snapshot,
            },
            { readRegularFile },
        );
        fs.writeFileSync(targetPath, "changed after prime\n");
        await expect(
            assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
                {
                    materialization: materialization([textFile("AGENTS.md", "primed\n")]),
                    targetRootPath: targetRoot,
                    platformContext,
                    targetCheckSnapshot: snapshot,
                },
                { readRegularFile, inventoryDirectory: inventoryDirectoryNoFollow },
            ),
        ).resolves.toMatchObject({ observedTargetState: "already_usable" });
        expect(readRegularFile).toHaveBeenCalledTimes(1);

        await assetUsageTargetObservationInternalsForTest.primeAsyncWithDependencies(
            { relativePaths: ["AGENTS.md"], targetRootPath: targetRoot, platformContext },
            { readRegularFile },
        );
        expect(readRegularFile).toHaveBeenCalledTimes(1);

        const missingSnapshot = createTargetCheckObservationSnapshot();
        const missingRead = vi.fn(async (input: { readonly filePath: string }) => {
            throw new SafeFilesystemError({
                failureKind: "not_found",
                operation: "read_regular_file",
                targetPath: input.filePath,
                systemCode: "ENOENT",
                message: "fixture target is absent",
            });
        });
        await assetUsageTargetObservationInternalsForTest.primeAsyncWithDependencies(
            {
                relativePaths: ["missing.md"],
                targetRootPath: targetRoot,
                platformContext,
                targetCheckSnapshot: missingSnapshot,
            },
            { readRegularFile: missingRead },
        );
        await expect(
            assetUsageTargetObservationInternalsForTest.observeAsyncWithDependencies(
                {
                    materialization: materialization([textFile("missing.md", "missing\n")]),
                    targetRootPath: targetRoot,
                    platformContext,
                    targetCheckSnapshot: missingSnapshot,
                },
                { readRegularFile: missingRead, inventoryDirectory: inventoryDirectoryNoFollow },
            ),
        ).resolves.toMatchObject({ observedTargetState: "absent" });
        expect(missingRead).toHaveBeenCalledTimes(1);
    });

    it("fails closed when a nested directory disappears or changes during complete-graph observation", () => {
        const current = materialization(
            [textFile("tree/AGENTS.md", "# tree\n"), textFile("tree/references/guide.md", "# guide\n")],
            ["tree"],
        );
        fs.mkdirSync(path.join(targetRoot, "tree", "references"), { recursive: true });
        fs.writeFileSync(path.join(targetRoot, "tree", "AGENTS.md"), "# tree\n");
        fs.writeFileSync(path.join(targetRoot, "tree", "references", "guide.md"), "# guide\n");

        const rootInventory = directoryInventory("root", [
            { relativeName: "AGENTS.md", identity: { deviceId: "device", fileId: "entry", entryKind: "file" } },
            {
                relativeName: "references",
                identity: { deviceId: "device", fileId: "references", entryKind: "directory" },
            },
        ]);
        const disappeared = assetUsageTargetObservationInternalsForTest.observeWithDependencies(
            { materialization: current, targetRootPath: targetRoot, platformContext },
            {
                readRegularFile: readPlatformContextRegularFileNoFollow,
                inventoryDirectory: (directoryPath) => {
                    if (directoryPath.endsWith("/references")) {
                        throw new SafeFilesystemError({
                            failureKind: "not_found",
                            operation: "inventory_directory",
                            targetPath: directoryPath,
                            message: "fixture nested directory disappeared",
                        });
                    }
                    return rootInventory;
                },
            },
        );
        expect(disappeared).toMatchObject({ observedTargetState: "unknown", failureStatus: "stale" });

        let inventoryCalls = 0;
        const changed = assetUsageTargetObservationInternalsForTest.observeWithDependencies(
            {
                materialization: materialization([textFile("tree/AGENTS.md", "# tree\n")], ["tree"]),
                targetRootPath: targetRoot,
                platformContext,
            },
            {
                readRegularFile: readPlatformContextRegularFileNoFollow,
                inventoryDirectory: () => {
                    inventoryCalls += 1;
                    return directoryInventory(inventoryCalls === 1 ? "before" : "after", [
                        {
                            relativeName: "AGENTS.md",
                            identity: { deviceId: "device", fileId: "entry", entryKind: "file" },
                        },
                    ]);
                },
            },
        );
        expect(changed).toMatchObject({ observedTargetState: "unknown", failureStatus: "stale" });
    });
});

function observe(
    materializationView: CoreRenderMaterializationView,
    targetRootPath: string,
    platformContext: PlatformContext,
    sourceSnapshot?: ImportSourceSnapshotV1,
) {
    return observeAssetUsageTarget({
        materialization: materializationView,
        targetRootPath,
        platformContext,
        ...(sourceSnapshot === undefined ? {} : { sourceSnapshot }),
    });
}

function textFile(relativePath: string, text: string): MaterializedRenderFile {
    return {
        relativePath: relativePath as never,
        content: { contentKind: "text", text },
        executable: false,
        semanticRefFingerprints: [SEMANTIC],
        sectionBindings: [],
    };
}

function binaryFile(relativePath: string, bytes: Uint8Array): MaterializedRenderFile {
    return {
        relativePath: relativePath as never,
        content: { contentKind: "binary", bytes },
        executable: false,
        semanticRefFingerprints: [SEMANTIC],
        sectionBindings: [],
    };
}

function materialization(
    files: MaterializedRenderFile[],
    managedDirectoryBoundaries: Array<string | { readonly relativePath: string; readonly desiredDirectoryPaths: string[] }> = [],
): CoreRenderMaterializationView {
    return {
        schemaVersion: 1,
        renderInputFingerprint: SHA,
        selectionFingerprint: SHA,
        units: [
            {
                outputUnit: {
                    outputUnitFingerprint: SHA,
                    outputContractId: "TEST_ASSET_USAGE_OUTPUT",
                    outputContractFingerprint: SHA,
                    claims: files.map((file) => ({
                        relativePath: file.relativePath,
                        contentKind: file.content.contentKind,
                        executable: file.executable,
                    })),
                    managedDirectoryBoundaries: managedDirectoryBoundaries.map((boundary) =>
                        typeof boundary === "string"
                            ? { relativePath: boundary as never, boundaryKind: "directory_inventory" }
                            : {
                                  schemaVersion: 2,
                                  relativePath: boundary.relativePath as never,
                                  boundaryKind: "directory_inventory",
                                  desiredDirectoryPaths: boundary.desiredDirectoryPaths as never,
                              },
                    ),
                },
                renderer: {
                    outputUnitFingerprint: SHA,
                    rendererAdapterId: "TEST" as never,
                    rendererAdapterVersion: "1.0.0",
                    materializerCapabilityKey: "test:materializer" as never,
                    materializationProfileId: "test-profile" as never,
                    profileConstraintFingerprint: SHA,
                },
                providerRenderDialectInputFingerprint: SHA,
                materializationFingerprint: SHA,
                semanticCoverageProof: {
                    outputUnitFingerprint: SHA,
                    coveredSemanticRefFingerprints: [SEMANTIC],
                    coverageFingerprint: SHA,
                },
                files,
            },
        ],
    };
}

function sourceSnapshot(physicalIdentity: Sha256Digest, includeDirectory = false): ImportSourceSnapshotV1 {
    return {
        schemaVersion: 1,
        adapterId: "TEST" as never,
        roots: [
            {
                sourceRootId: "source-root",
                rootRole: "project_actual",
                sourceDomain: "project_root",
                path: "/source",
                locatorEvidence: [],
            },
        ],
        entries: [
            {
                observedReadEntryId: "source-entry",
                sourceRootId: "source-root",
                relativePath: "AGENTS.md",
                entryKind: "file",
                contentHash: SHA,
                executable: false,
                physicalIdentityFingerprint: physicalIdentity,
            },
            ...(includeDirectory
                ? [
                      {
                          observedReadEntryId: "source-directory",
                          sourceRootId: "source-root",
                          relativePath: "nested" as const,
                          entryKind: "directory" as const,
                          physicalIdentityFingerprint: SHA,
                      },
                  ]
                : []),
        ],
        fileOrigins: [{ logicalPath: "AGENTS.md", observedReadEntryIds: ["source-entry"] }],
        sourceContainerEntryIds: [],
        metadataOrigins: [],
        evidence: [],
        externalAttestations: [],
        snapshotFingerprint: SHA,
    };
}

function directoryInventory(fileId: string, entries: StableDirectoryInventory["entries"]): StableDirectoryInventory {
    return {
        identity: { deviceId: "device", fileId, entryKind: "directory" },
        entries,
    };
}
