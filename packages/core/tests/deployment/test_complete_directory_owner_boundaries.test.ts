import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectDirectoryNoFollow, type PhysicalPathIdentity } from "@oaam/shared/filesystem";
import {
    validateDeploymentExecutionAuthority,
    validateTargetPlanPaths,
} from "../../src/deployment/deployment-execution-validation";
import {
    isDirectoryIdentityOrNull,
    isValidJournalDirectoryEntries,
    isValidManagedDirectoryBoundaries,
} from "../../src/deployment/deployment-journal-directory-validation";
import type { ActiveJournalV2, JournalDirectoryEntry, JournalEntry } from "../../src/deployment/deployment-journal";
import {
    ensureManagedTargetDirectories,
    planManagedTargetDirectories,
    resolveManagedDirectoryBoundaryAuthority,
} from "../../src/deployment/deployment-managed-directory-execution";
import {
    captureManagedDirectoryGraph,
    desiredManagedDirectoryPaths,
    desiredDirectoryPathsForBoundaries,
} from "../../src/deployment/deployment-managed-directory-graph";
import { buildUnmanagedRemovalEntries } from "../../src/deployment/deployment-target-entries";
import {
    cleanupTargetDirectories,
    createTargetIo,
    createTargetIoForTest,
    ensureTargetDirectory,
    ioReadStable,
    planTargetDirectories,
    removeTargetDirectories,
    restoreTargetDirectory,
} from "../../src/deployment/deployment-target-io";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "../../src/deployment/deployment-target-replacement";
import { computeAppliedRenderSnapshotFingerprint, computeRenderOutputUnitFingerprint } from "../../src/foundation/fingerprint";
import { finalizeTargetFileRenderProvenance } from "../../src/render/deployment-render-authority";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";
import { b64, sha } from "./fixtures/deployment-target-io-test-fixtures";

const FP = `sha256:${"a".repeat(64)}`;

function identity(fileId: string): PhysicalPathIdentity {
    return { deviceId: "device", fileId, entryKind: "directory" };
}

function entry(
    relativePath: string,
    options: { removal?: boolean; authority?: JournalEntry["entryAuthority"] } = {},
): JournalEntry {
    const removal = options.removal ?? false;
    return {
        relativePath,
        oldHash: "",
        oldBytesBase64: "",
        oldExecutable: false,
        oldProvenanceFingerprint: "",
        oldMaterializationFingerprint: "",
        newHash: removal ? "" : sha("desired"),
        newBytesBase64: removal ? "" : b64("desired"),
        newExecutable: false,
        newProvenanceFingerprint: removal ? "" : FP,
        newMaterializationFingerprint: removal ? "" : FP,
        isRemoval: removal,
        entryAuthority: options.authority ?? "managed_baseline",
    };
}

function plan(boundaries: string[]): TargetPlan {
    return {
        schemaVersion: 1,
        managedDirectoryBoundaries: boundaries.map((relativePath) => ({
            relativePath,
            outputUnitFingerprint: FP,
        })),
        targetFiles: [],
    };
}

describe("complete-directory pure authority boundaries", () => {
    it("rejects non-canonical, duplicate, unsorted, and overlapping managed boundaries", () => {
        for (const boundaries of [["../leaf"], ["leaf", "leaf"], ["z", "a"], ["leaf", "leaf/nested"]]) {
            expect(validateTargetPlanPaths(plan(boundaries))).not.toBeNull();
        }
        expect(validateTargetPlanPaths(plan(["a", "z"]))).toBeNull();
    });

    it("retains an explicit empty directory without changing historical inferred plans", () => {
        const explicit = plan(["leaf"]);
        explicit.managedDirectoryBoundaries[0]!.desiredDirectoryPaths = ["leaf", "leaf/empty", "leaf/resources"];
        expect(validateTargetPlanPaths(explicit)).toBeNull();
        expect(desiredManagedDirectoryPaths(explicit)).toEqual(["leaf", "leaf/empty", "leaf/resources"]);

        explicit.managedDirectoryBoundaries[0]!.desiredDirectoryPaths = ["leaf", "leaf/resources"];
        expect(validateTargetPlanPaths(explicit)).toBeNull();
        explicit.managedDirectoryBoundaries[0]!.desiredDirectoryPaths = ["leaf/empty"];
        expect(validateTargetPlanPaths(explicit)).toContain("desired-directory");
        explicit.managedDirectoryBoundaries[0]!.desiredDirectoryPaths = ["leaf", "leaf/SKILL.md"];
        explicit.targetFiles = [{ ...entry("leaf/SKILL.md"), content: { contentKind: "text", text: "skill" } }] as never;
        expect(validateTargetPlanPaths(explicit)).toContain("desired-directory");
    });

    it("binds execution authority to the exact sorted boundary projection", () => {
        const targetPlan: TargetPlan = {
            schemaVersion: 1,
            managedDirectoryBoundaries: [],
            targetFiles: [
                {
                    relativePath: "leaf/SKILL.md",
                    content: { contentKind: "text", text: "skill" },
                    executable: false,
                    renderedSectionIds: [],
                },
            ],
        };
        const authority = makeExecutionAuthority(targetPlan);
        expect(validateDeploymentExecutionAuthority(targetPlan, authority)).toBeNull();
        authority.appliedRenderSnapshot.outputUnits[0]!.managedDirectoryBoundaries = [
            {
                schemaVersion: 2,
                relativePath: "leaf",
                boundaryKind: "directory_inventory",
                desiredDirectoryPaths: ["leaf", "leaf/empty"],
            },
            { relativePath: "z", boundaryKind: "directory_inventory" },
        ];
        const unit = authority.appliedRenderSnapshot.outputUnits[0]!;
        const { outputUnitFingerprint: _oldUnitFingerprint, ...unitPreimage } = unit;
        unit.outputUnitFingerprint = computeRenderOutputUnitFingerprint(unitPreimage);
        authority.appliedRenderSnapshot.outputUnitRenderers[0]!.outputUnitFingerprint = unit.outputUnitFingerprint;
        authority.appliedRenderSnapshot.semanticCoverageProofs[0]!.outputUnitFingerprint = unit.outputUnitFingerprint;
        targetPlan.targetFiles[0]!.outputUnitFingerprint = unit.outputUnitFingerprint;
        targetPlan.managedDirectoryBoundaries = [
            {
                relativePath: "leaf",
                outputUnitFingerprint: unit.outputUnitFingerprint,
                desiredDirectoryPaths: ["leaf", "leaf/empty"],
            },
            { relativePath: "z", outputUnitFingerprint: unit.outputUnitFingerprint },
        ];
        const currentProvenance = authority.targetFileProvenance[0]!.provenance;
        const { provenanceFingerprint: _oldProvenanceFingerprint, ...provenancePreimage } = currentProvenance;
        authority.targetFileProvenance[0]!.provenance = finalizeTargetFileRenderProvenance({
            ...provenancePreimage,
            appliedRenderSnapshotFingerprint: computeAppliedRenderSnapshotFingerprint(authority.appliedRenderSnapshot),
            outputUnitFingerprint: unit.outputUnitFingerprint,
        });
        expect(validateDeploymentExecutionAuthority(targetPlan, authority)).toBeNull();
        targetPlan.managedDirectoryBoundaries[0]!.desiredDirectoryPaths = ["leaf"];
        expect(validateDeploymentExecutionAuthority(targetPlan, authority)).toContain("managed-directory boundaries");
    });

    it("validates boundary and directory-journal grammar across every state dimension", () => {
        expect(isValidManagedDirectoryBoundaries(null)).toBe(false);
        expect(isValidManagedDirectoryBoundaries(["../leaf"])).toBe(false);
        expect(isValidManagedDirectoryBoundaries(["b", "a"])).toBe(false);
        expect(isValidManagedDirectoryBoundaries(["a", "a"])).toBe(false);
        expect(isValidManagedDirectoryBoundaries(["a", "a/b"])).toBe(false);
        expect(isValidManagedDirectoryBoundaries(["a", "b"])).toBe(true);

        const files = [entry("leaf/SKILL.md")];
        const valid: JournalDirectoryEntry[] = [
            {
                relativePath: "leaf",
                oldState: "missing",
                desiredState: "present",
                oldIdentity: null,
                createdIdentity: null,
            },
        ];
        expect(isValidJournalDirectoryEntries(valid, files, ["leaf"])).toBe(true);
        const nestedFiles = [entry("leaf/a/SKILL.md"), entry("leaf/b/SKILL.md")];
        const nestedDirectories: JournalDirectoryEntry[] = [
            { ...valid[0]!, relativePath: "leaf" },
            { ...valid[0]!, relativePath: "leaf/a" },
            { ...valid[0]!, relativePath: "leaf/b" },
        ];
        expect(isValidJournalDirectoryEntries(nestedDirectories, nestedFiles, ["leaf"])).toBe(true);
        expect(isValidJournalDirectoryEntries([valid[0]!, { ...valid[0]!, relativePath: "leaf/empty" }], files, ["leaf"])).toBe(
            true,
        );
        expect(
            isValidJournalDirectoryEntries([valid[0]!, { ...valid[0]!, relativePath: "leaf/deep/empty" }], files, ["leaf"]),
        ).toBe(false);
        expect(isValidJournalDirectoryEntries([valid[0]!, { ...valid[0]!, relativePath: "outside" }], files, ["leaf"])).toBe(
            false,
        );
        expect(
            isValidJournalDirectoryEntries([valid[0]!, { ...valid[0]!, relativePath: "leaf/SKILL.md" }], files, ["leaf"]),
        ).toBe(false);
        expect(
            isValidJournalDirectoryEntries(
                [
                    { ...valid[0]!, relativePath: "empty-boundary" },
                    { ...valid[0]!, relativePath: "outside" },
                ],
                [entry("outside/SKILL.md")],
                ["empty-boundary"],
            ),
        ).toBe(true);
        expect(
            isValidJournalDirectoryEntries(
                [
                    { ...valid[0]!, relativePath: "leaf" },
                    { ...valid[0]!, relativePath: "outside" },
                    { ...valid[0]!, relativePath: "leaf/nested" },
                ],
                [entry("outside/SKILL.md")],
                ["leaf", "leaf/nested"],
            ),
        ).toBe(false);
        expect(isValidJournalDirectoryEntries([...nestedDirectories].reverse(), nestedFiles, ["leaf"])).toBe(false);
        expect(isValidJournalDirectoryEntries(null, files, ["leaf"])).toBe(false);
        expect(isValidJournalDirectoryEntries(new Array(4_097).fill(null), files, ["leaf"])).toBe(false);
        expect(
            isValidJournalDirectoryEntries(
                [],
                [entry("outside.txt", { removal: true, authority: "explicit_unmanaged_replacement" })],
                ["leaf"],
            ),
        ).toBe(false);
        expect(isValidJournalDirectoryEntries(valid, [entry("leaf/nested/SKILL.md")], ["leaf", "leaf/nested"])).toBe(false);

        const invalid: unknown[] = [
            [null],
            [{ ...valid[0], extra: true }],
            [{ ...valid[0], relativePath: "../leaf" }],
            [{ ...valid[0], oldState: "unknown" }],
            [{ ...valid[0], desiredState: "unknown" }],
            [{ ...valid[0], oldIdentity: "bad" }],
            [{ ...valid[0], createdIdentity: "bad" }],
            [{ ...valid[0], oldState: "present", oldIdentity: null }],
            [{ ...valid[0], oldIdentity: identity("unexpected") }],
            [{ ...valid[0], desiredState: "missing" }],
            [
                {
                    ...valid[0],
                    relativePath: "outside",
                    desiredState: "missing",
                    oldState: "present",
                    oldIdentity: identity("outside"),
                },
            ],
            [{ ...valid[0] }, { ...valid[0] }],
            [
                { ...valid[0], relativePath: "leaf/nested" },
                { ...valid[0], relativePath: "leaf" },
            ],
            [],
        ];
        for (const value of invalid) expect(isValidJournalDirectoryEntries(value, files, ["leaf"])).toBe(false);

        expect(isDirectoryIdentityOrNull(null)).toBe(true);
        expect(isDirectoryIdentityOrNull("bad")).toBe(false);
        expect(isDirectoryIdentityOrNull({ deviceId: "", fileId: "id", entryKind: "directory" })).toBe(false);
        expect(isDirectoryIdentityOrNull({ deviceId: "bad\0id", fileId: "id", entryKind: "directory" })).toBe(false);
        expect(isDirectoryIdentityOrNull({ deviceId: "dev", fileId: "", entryKind: "directory" })).toBe(false);
        expect(isDirectoryIdentityOrNull({ deviceId: "dev", fileId: "bad\0id", entryKind: "directory" })).toBe(false);
        expect(isDirectoryIdentityOrNull({ deviceId: "dev", fileId: "id", entryKind: "file" })).toBe(false);
        expect(isDirectoryIdentityOrNull(identity("id"))).toBe(true);
    });

    it("rejects unmanaged removals that overlap compiled or baseline paths or lack present authority", () => {
        const authority: DeploymentRuntimeReplacementAuthorityV1 = {
            files: [{ relativePath: "leaf/old.txt", expectedState: "missing" }],
            directories: [],
            managedDirectoryBoundaryPaths: ["leaf"],
            desiredManagedDirectoryBoundaryPaths: ["leaf"],
            unmanagedRemovalPaths: ["leaf/old.txt"],
            directoryRemovalPaths: [],
        };
        expect(() => buildUnmanagedRemovalEntries(authority, new Set(["leaf/old.txt"]), new Set())).toThrow(/overlaps/);
        expect(() => buildUnmanagedRemovalEntries(authority, new Set(), new Set(["leaf/old.txt"]))).toThrow(/overlaps/);
        expect(() => buildUnmanagedRemovalEntries(authority, new Set(), new Set())).toThrow(/present-file authority/);
    });

    it("requires exact union and desired managed-boundary authority", () => {
        const targetPlan = plan(["leaf"]);
        expect(() => resolveManagedDirectoryBoundaryAuthority(targetPlan, [], undefined)).toThrow(/fresh runtime preview/);
        const authority: DeploymentRuntimeReplacementAuthorityV1 = {
            files: [],
            directories: [],
            managedDirectoryBoundaryPaths: [],
            desiredManagedDirectoryBoundaryPaths: ["leaf"],
            unmanagedRemovalPaths: [],
            directoryRemovalPaths: [],
        };
        expect(() => resolveManagedDirectoryBoundaryAuthority(targetPlan, [], authority)).toThrow(/exact managed-directory/);
        authority.managedDirectoryBoundaryPaths = ["leaf"];
        authority.desiredManagedDirectoryBoundaryPaths = [];
        expect(() => resolveManagedDirectoryBoundaryAuthority(targetPlan, [], authority)).toThrow(/exact desired/);
        authority.desiredManagedDirectoryBoundaryPaths = ["leaf"];
        expect(resolveManagedDirectoryBoundaryAuthority(targetPlan, [], authority)).toEqual(["leaf"]);
    });
});

describe("complete-directory physical directory owner", () => {
    let root = "";
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-directory-owner-"));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("keeps injected stable reads bounded and defaults an omitted executable observation to false", () => {
        const ctx = createTargetIoForTest(root, {
            readFile: () => Buffer.from("abc"),
            writeFile: () => undefined,
            deleteFile: () => undefined,
            fileExists: () => true,
        });
        expect(ioReadStable(ctx, path.join(root, "file"))).toMatchObject({
            executable: false,
            identity: { entryKind: "file" },
        });
        expect(() => ioReadStable(ctx, path.join(root, "file"), 2)).toThrow(/bounded read limit/);
    });

    it("plans exact desired and reviewed-removal directory states", () => {
        const ctx = createTargetIo(root);
        fs.mkdirSync(path.join(root, "leaf/old"), { recursive: true });
        const oldIdentity = inspectDirectoryNoFollow(path.join(root, "leaf/old"));
        const planned = planTargetDirectories(
            ctx,
            [entry("leaf/new/SKILL.md")],
            [{ relativePath: "leaf/old", expectedIdentity: oldIdentity }],
            ["leaf"],
            ["leaf", "leaf/empty", "leaf/new"],
        );
        expect(planned.map(({ relativePath, oldState, desiredState }) => ({ relativePath, oldState, desiredState }))).toEqual([
            { relativePath: "leaf", oldState: "present", desiredState: "present" },
            { relativePath: "leaf/empty", oldState: "missing", desiredState: "present" },
            { relativePath: "leaf/new", oldState: "missing", desiredState: "present" },
            { relativePath: "leaf/old", oldState: "present", desiredState: "missing" },
        ]);
        expect(() => planTargetDirectories(ctx, [entry("leaf/new/SKILL.md")], [], ["leaf"], ["leaf"])).toThrow(
            /target-file parent/,
        );
        expect(() =>
            planTargetDirectories(ctx, [entry("leaf/new/SKILL.md")], [], ["leaf"], ["leaf", "leaf/new", "leaf/new"]),
        ).toThrow(/unique/);
        expect(() => planTargetDirectories(ctx, [], [], ["leaf"], ["foreign"])).toThrow(/exactly one/);
        expect(() => planTargetDirectories(ctx, [], [], ["leaf"], ["leaf", "leaf/deep/empty"])).toThrow(/every directory parent/);
        expect(() => planTargetDirectories(ctx, [entry("leaf/SKILL.md")], [], ["leaf"], ["leaf", "leaf/SKILL.md"])).toThrow(
            /both a file and a directory/,
        );
        expect(() =>
            planTargetDirectories(
                ctx,
                [],
                [{ relativePath: "leaf/old", expectedIdentity: oldIdentity }],
                ["leaf"],
                ["leaf", "leaf/old"],
            ),
        ).toThrow(/both desired and removed/);
        expect(() => planTargetDirectories(ctx, [entry("leaf/nested/x.md")], [], ["leaf", "leaf/nested"])).toThrow(/overlapping/);
        expect(() =>
            planTargetDirectories(ctx, [entry("leaf/old/x.md")], [{ relativePath: "leaf/old", expectedIdentity: oldIdentity }]),
        ).toThrow(/both desired and removed/);
        expect(() => planTargetDirectories(ctx, [], [{ relativePath: "missing", expectedIdentity: oldIdentity }])).toThrow(
            /disappeared/,
        );
        expect(() => planTargetDirectories(ctx, [], [{ relativePath: "leaf/old", expectedIdentity: identity("wrong") }])).toThrow(
            /changed/,
        );
        fs.writeFileSync(path.join(root, "plain"), "file");
        expect(() => planTargetDirectories(ctx, [entry("plain/child.md")])).toThrow();
    });

    it("ensures and restores only the journaled directory identity", () => {
        const ctx = createTargetIo(root);
        const missing: JournalDirectoryEntry = {
            relativePath: "leaf",
            oldState: "missing",
            desiredState: "present",
            oldIdentity: null,
            createdIdentity: null,
        };
        const created = ensureTargetDirectory(ctx, missing);
        expect(created.created).toBe(true);
        const retained = { ...missing, createdIdentity: created.identity };
        expect(ensureTargetDirectory(ctx, retained).created).toBe(false);
        expect(() => ensureTargetDirectory(ctx, { ...retained, createdIdentity: identity("wrong") })).toThrow(/changed identity/);
        expect(() => ensureTargetDirectory(ctx, { ...missing, createdIdentity: null })).toThrow(/appeared/);
        expect(() => ensureTargetDirectory(ctx, { ...missing, desiredState: "missing" })).toThrow(/desired state/);
        const present = { ...retained, oldState: "present" as const, oldIdentity: created.identity, createdIdentity: null };
        expect(ensureTargetDirectory(ctx, present).created).toBe(false);
        expect(() => ensureTargetDirectory(ctx, { ...present, oldIdentity: null })).toThrow(/changed/);

        expect(() => restoreTargetDirectory(ctx, missing)).toThrow(/old state/);
        expect(() => restoreTargetDirectory(ctx, { ...present, oldIdentity: identity("wrong") })).toThrow(/changed/);
        restoreTargetDirectory(ctx, present);
        fs.rmdirSync(path.join(root, "leaf"));
        restoreTargetDirectory(ctx, present);
        expect(fs.statSync(path.join(root, "leaf")).isDirectory()).toBe(true);
    });

    it("cleans and removes only exact empty directory identities", () => {
        const ctx = createTargetIo(root);
        fs.mkdirSync(path.join(root, "created"));
        const createdIdentity = inspectDirectoryNoFollow(path.join(root, "created"));
        const createdEntry: JournalDirectoryEntry = {
            relativePath: "created",
            oldState: "missing",
            desiredState: "present",
            oldIdentity: null,
            createdIdentity,
        };
        expect(cleanupTargetDirectories(ctx, [{ ...createdEntry, oldState: "present" }])).toEqual({
            ok: true,
            failedRelativePaths: [],
        });
        expect(cleanupTargetDirectories(ctx, [{ ...createdEntry, relativePath: "already-gone" }])).toEqual({
            ok: true,
            failedRelativePaths: [],
        });
        expect(cleanupTargetDirectories(ctx, [{ ...createdEntry, createdIdentity: null }])).toEqual({
            ok: false,
            failedRelativePaths: ["created"],
        });
        expect(cleanupTargetDirectories(ctx, [{ ...createdEntry, createdIdentity: identity("wrong") }])).toEqual({
            ok: false,
            failedRelativePaths: ["created"],
        });
        expect(cleanupTargetDirectories(ctx, [createdEntry])).toEqual({ ok: true, failedRelativePaths: [] });
        expect(fs.existsSync(path.join(root, "created"))).toBe(false);

        fs.mkdirSync(path.join(root, "remove/nonempty"), { recursive: true });
        fs.writeFileSync(path.join(root, "remove/nonempty/file"), "x");
        const removeIdentity = inspectDirectoryNoFollow(path.join(root, "remove"));
        const removal: JournalDirectoryEntry = {
            relativePath: "remove",
            oldState: "present",
            desiredState: "missing",
            oldIdentity: removeIdentity,
            createdIdentity: null,
        };
        expect(removeTargetDirectories(ctx, [{ ...removal, oldIdentity: null }])).toEqual({
            ok: false,
            failedRelativePaths: ["remove"],
        });
        expect(removeTargetDirectories(ctx, [{ ...removal, oldIdentity: identity("wrong") }])).toEqual({
            ok: false,
            failedRelativePaths: ["remove"],
        });
        expect(removeTargetDirectories(ctx, [removal])).toEqual({ ok: false, failedRelativePaths: ["remove"] });
        fs.rmSync(path.join(root, "remove/nonempty"), { recursive: true });
        expect(removeTargetDirectories(ctx, [removal])).toEqual({ ok: true, failedRelativePaths: [] });
        expect(removeTargetDirectories(ctx, [{ ...removal, relativePath: "missing" }])).toEqual({
            ok: true,
            failedRelativePaths: [],
        });
    });

    it("captures missing, duplicate, invalid, bounded, and exact directory graphs", () => {
        expect(captureManagedDirectoryGraph(root, [{ relativePath: "missing" }])).toEqual({ files: [], directories: [] });
        fs.writeFileSync(path.join(root, "plain"), "file");
        expect(() => captureManagedDirectoryGraph(root, [{ relativePath: "plain" }])).toThrow();
        fs.mkdirSync(path.join(root, "leaf/nested"), { recursive: true });
        fs.writeFileSync(path.join(root, "leaf/SKILL.md"), "skill");
        expect(() => captureManagedDirectoryGraph(root, [{ relativePath: "leaf" }, { relativePath: "leaf" }])).toThrow(/overlap/);
        expect(() => captureManagedDirectoryGraph(root, [{ relativePath: "leaf" }], { maximumEntries: 1 })).toThrow(
            /bounded.*limit/,
        );
        expect(() => captureManagedDirectoryGraph(root, [{ relativePath: "leaf" }], { maximumBytes: 1 })).toThrow();
        const graph = captureManagedDirectoryGraph(root, [{ relativePath: "leaf" }]);
        expect(graph.files.map((file) => file.relativePath)).toEqual(["leaf/SKILL.md"]);
        expect(graph.directories.map((directory) => directory.relativePath)).toEqual(["leaf", "leaf/nested"]);
        expect(desiredDirectoryPathsForBoundaries([{ relativePath: "leaf" }], ["leaf/a/b/file.md"])).toEqual([
            "leaf",
            "leaf/a",
            "leaf/a/b",
        ]);
        expect(
            desiredDirectoryPathsForBoundaries(
                [{ relativePath: "leaf", desiredDirectoryPaths: ["leaf", "leaf/empty"] }],
                ["leaf/a/b/file.md"],
            ),
        ).toEqual(["leaf", "leaf/empty"]);
    });

    it("maps managed-directory planning and receipt failures before file mutation", () => {
        const ctx = createTargetIo(root);
        const authority: DeploymentRuntimeReplacementAuthorityV1 = {
            files: [],
            directories: [],
            managedDirectoryBoundaryPaths: ["leaf"],
            desiredManagedDirectoryBoundaryPaths: ["leaf"],
            unmanagedRemovalPaths: [],
            directoryRemovalPaths: ["leaf/old"],
        };
        expect(() => planManagedTargetDirectories(ctx, [], authority, ["leaf"], ["leaf"])).toThrow(/reviewed directory removal/);

        const journal: ActiveJournalV2 = {
            schemaVersion: 2,
            transactionId: "11111111-1111-4111-8111-111111111111",
            deploymentId: "22222222-2222-4222-8222-222222222222",
            createdAt: 1,
            compilationFingerprint: FP,
            reservedPhysicalKeys: [],
            entries: [],
            managedDirectoryBoundaries: ["leaf"],
            directoryEntries: [
                {
                    relativePath: "missing-parent/child",
                    oldState: "missing",
                    desiredState: "present",
                    oldIdentity: null,
                    createdIdentity: null,
                },
            ],
        };
        expect(
            ensureManagedTargetDirectories({
                ctx,
                journal,
                transactionsRoot: path.join(root, "transactions"),
                deleteJournal: () => true,
            }),
        ).toMatchObject({ ok: false, message: expect.stringContaining("ensure failed") });

        const receiptJournal: ActiveJournalV2 = {
            ...journal,
            directoryEntries: [
                { ...journal.directoryEntries[0]!, relativePath: "leaf" },
                {
                    relativePath: "stable",
                    oldState: "present",
                    desiredState: "present",
                    oldIdentity: identity("stable"),
                    createdIdentity: null,
                },
            ],
        };
        let deleteAttempts = 0;
        const receiptFailure = ensureManagedTargetDirectories({
            ctx,
            journal: receiptJournal,
            transactionsRoot: path.join(root, "missing-transactions"),
            deleteJournal: () => {
                deleteAttempts += 1;
                throw new Error("delete failure");
            },
        });
        expect(receiptFailure).toMatchObject({ ok: false, message: expect.stringContaining("receipt failed") });
        expect(deleteAttempts).toBe(1);
        expect(fs.existsSync(path.join(root, "leaf"))).toBe(false);
    });
});
