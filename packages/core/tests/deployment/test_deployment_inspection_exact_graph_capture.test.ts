/** Physical managed-directory capture for exact native file graphs. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SafeFilesystemError, type StableDirectoryInventory } from "@oaam/shared/filesystem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import type { TargetFileRenderProvenanceV1 } from "../../src/contracts/deployment-authority";
import { publishDeploymentPayloads } from "../../src/deployment/deployment-payload-store";
import { computeTargetFileRenderProvenanceFingerprint } from "../../src/foundation/fingerprint";
import { deploymentInspectionCaptureInternalsForTest } from "../../src/orchestration/deployment-inspection-capture";
import { deploymentInspectionInternalsForTest } from "../../src/orchestration/deployment-inspection-service";
import {
    validateChangedFiles,
    validateInspectionScope,
    validateInventoryDeltas,
} from "../../src/render/render-inspection-validation";
import type { PosixRelativePath, Sha256Digest, UuidV4 } from "../../src/types";
import {
    GRAPH_BINARY_RESOURCE_PATH,
    GRAPH_BOUNDARY,
    GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
    GRAPH_ENTRY_PATH,
    changedExactGraphInspection,
    exactGraphMaterializationInput,
    fullExactGraphAppliedSnapshot,
    makeExactGraphFixture,
} from "../render/fixtures/native-project-exact-graph-test-fixtures";

const TRANSACTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UuidV4;

const observations = vi.hoisted(() => ({ read: vi.fn(), inventory: vi.fn() }));
vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        readRegularFileNoFollow: (...args: Parameters<typeof actual.readRegularFileNoFollow>) => {
            observations.read(...args);
            return actual.readRegularFileNoFollow(...args);
        },
        inventoryDirectoryNoFollow: (...args: Parameters<typeof actual.inventoryDirectoryNoFollow>) => {
            const result = actual.inventoryDirectoryNoFollow(...args);
            return observations.inventory(...args, result) ?? result;
        },
    };
});

describe("deployment inspection exact-graph capture", () => {
    let root = "";

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-exact-graph-capture-"));
        observations.read.mockReset();
        observations.inventory.mockReset();
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("uses one fresh file sample and a before/after pair for each directory to produce both review and replacement authority", () => {
        const fixture = makeCaptureFixture(root);
        observations.read.mockClear();
        observations.inventory.mockClear();
        const first = capture(fixture);
        const targetReads = () =>
            observations.read.mock.calls.filter(([filePath]) => filePath.startsWith(fixture.targetRoot + path.sep));
        const directoryPaths = first.runtimeReplacementAuthority.directories
            .filter((directory) => directory.expectedState === "present")
            .map((directory) => path.join(fixture.targetRoot, directory.relativePath));
        expect(
            targetReads()
                .map(([filePath]) => filePath)
                .sort(),
        ).toEqual(fixture.materialized.files.map((file) => path.join(fixture.targetRoot, file.relativePath)).sort());
        expect(observations.inventory.mock.calls.map(([filePath]) => filePath).sort()).toEqual(
            directoryPaths.flatMap((filePath) => [filePath, filePath]).sort(),
        );
        const original = first.runtimeReplacementAuthority.files.find((file) => file.relativePath === GRAPH_ENTRY_PATH)!;
        fs.writeFileSync(path.join(fixture.targetRoot, GRAPH_ENTRY_PATH), GRAPH_CHANGED_NATIVE_ENTRY_TEXT);
        const empty = `${GRAPH_BOUNDARY}/resources/late-empty`;
        fs.mkdirSync(path.join(fixture.targetRoot, empty));
        observations.read.mockClear();
        observations.inventory.mockClear();
        const second = capture(fixture);
        expect(targetReads()).toHaveLength(fixture.materialized.files.length);
        expect(observations.inventory).toHaveBeenCalledTimes((directoryPaths.length + 1) * 2);
        expect(second.input.inspectionScope.inspectionScopeFingerprint).not.toBe(
            first.input.inspectionScope.inspectionScopeFingerprint,
        );
        expect(second.runtimeReplacementAuthority.files.find((file) => file.relativePath === GRAPH_ENTRY_PATH)).not.toEqual(
            original,
        );
        expect(second.runtimeReplacementAuthority.directoryRemovalPaths).toContain(empty);
        expect(second.runtimeReplacementAuthority.directories).toContainEqual(
            expect.objectContaining({ relativePath: empty, expectedState: "present" }),
        );
    });

    it("rejects overlapping empty directory boundaries even when no file is attributed twice", () => {
        const fixture = makeCaptureFixture(root);
        const empty = `${GRAPH_BOUNDARY}/resources/empty` as PosixRelativePath;
        fs.mkdirSync(path.join(fixture.targetRoot, empty));
        const other = structuredClone(fixture.snapshot.outputUnits[0]!);
        other.claims = [];
        other.outputUnitFingerprint = digest("8");
        other.managedDirectoryBoundaries = [{ relativePath: empty, boundaryKind: "directory_inventory" }];
        fixture.snapshot.outputUnits.push(other);
        expect(() => capture(fixture)).toThrow(/boundaries overlap/);
    });

    it.each(["parent_child_identity", "after_membership"])("rejects %s drift in the one captured graph", (change) => {
        const fixture = makeCaptureFixture(root);
        const boundary = path.join(fixture.targetRoot, GRAPH_BOUNDARY);
        const child = path.join(boundary, "resources");
        let boundaryCalls = 0;
        observations.inventory.mockImplementation((filePath, _maximumEntries, inventory: StableDirectoryInventory) => {
            if (change === "parent_child_identity" && filePath === child) {
                return { ...inventory, identity: { ...inventory.identity, fileId: "replaced-child" } };
            }
            if (filePath === boundary && ++boundaryCalls === 2 && change === "after_membership") {
                return { ...inventory, entries: [] };
            }
            return inventory;
        });
        expect(() => capture(fixture)).toThrowError(
            expect.objectContaining({
                failureKind: "stale",
                systemCode: change === "parent_child_identity" ? "MANAGED_TREE_DIRECTORY_CHANGED" : "MANAGED_TREE_CHANGED",
            }),
        );
    });

    it.each([
        "file_then_directory",
        "directory_then_file",
    ])("rejects %s duplicate descendant names before reading them as another kind", (change) => {
        const fixture = makeCaptureFixture(root);
        const boundary = path.join(fixture.targetRoot, GRAPH_BOUNDARY);
        observations.inventory.mockImplementation((filePath, _maximumEntries, inventory: StableDirectoryInventory) => {
            if (filePath !== boundary) return inventory;
            const file = inventory.entries.find((entry) => entry.identity.entryKind === "file")!;
            const directory = inventory.entries.find((entry) => entry.identity.entryKind === "directory")!;
            return {
                ...inventory,
                entries:
                    change === "file_then_directory"
                        ? [file, { ...directory, relativeName: file.relativeName }]
                        : [directory, { ...file, relativeName: directory.relativeName }],
            };
        });
        expect(() => capture(fixture)).toThrow(/boundaries overlap/);
    });

    it("rejects a later boundary root that was already captured as a file", () => {
        const fixture = makeCaptureFixture(root);
        const other = structuredClone(fixture.snapshot.outputUnits[0]!);
        other.claims = [];
        other.outputUnitFingerprint = digest("8");
        other.managedDirectoryBoundaries = [{ relativePath: GRAPH_ENTRY_PATH, boundaryKind: "directory_inventory" }];
        fixture.snapshot.outputUnits.push(other);
        expect(() => capture(fixture)).toThrow(/boundaries overlap/);
    });

    it("retains the former authority capture's shared 4 MiB bound across distinct boundaries", () => {
        const fixture = makeCaptureFixture(root);
        const secondBoundary = ".fixture/other" as PosixRelativePath;
        const added = path.join(fixture.targetRoot, secondBoundary, "large.bin");
        fs.mkdirSync(path.dirname(added), { recursive: true });
        fs.writeFileSync(added, Buffer.alloc(4 * 1024 * 1024, 1));
        const other = structuredClone(fixture.snapshot.outputUnits[0]!);
        other.claims = [];
        other.outputUnitFingerprint = digest("8");
        other.managedDirectoryBoundaries = [{ relativePath: secondBoundary, boundaryKind: "directory_inventory" }];
        fixture.snapshot.outputUnits.push(other);
        expect(() => capture(fixture)).toThrowError(expect.objectContaining({ failureKind: "resource_limit" }));
        expect(observations.read.mock.calls.find(([filePath]) => filePath === added)?.[1]).toBeLessThan(4 * 1024 * 1024);
    });

    it.each([
        "directory",
        "file",
    ])("counts boundary roots and descendants toward the same 2,048-entry bound before another %s", (kind) => {
        const fixture = makeCaptureFixture(root);
        const initial = capture(fixture).runtimeReplacementAuthority;
        const occupied = initial.files.length + initial.directories.filter((entry) => entry.expectedState === "present").length;
        const boundaries = fixture.snapshot.outputUnits[0]!.managedDirectoryBoundaries;
        const emptyCount = 2048 - occupied - (kind === "file" ? 1 : 0);
        for (let index = 0; index <= emptyCount; index++) {
            const relativePath = `.fixture/empty-${String(index).padStart(4, "0")}` as PosixRelativePath;
            fs.mkdirSync(path.join(fixture.targetRoot, relativePath));
            boundaries.push({ relativePath, boundaryKind: "directory_inventory" });
            if (kind === "file" && index === emptyCount)
                fs.writeFileSync(path.join(fixture.targetRoot, relativePath, "last.bin"), "a");
        }
        expect(() => capture(fixture)).toThrow(/bounded preview.*limit/);
    });

    it("does not read even an empty added file after the 4 MiB capture budget is exhausted", () => {
        const fixture = makeCaptureFixture(root);
        const directory = path.join(fixture.targetRoot, GRAPH_BOUNDARY);
        fs.writeFileSync(path.join(directory, "0-large.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
        fs.writeFileSync(path.join(directory, "1-empty.bin"), "");
        expect(() => capture(fixture)).toThrow(/bounded preview limit/);
        expect(observations.read.mock.calls.some(([filePath]) => filePath === path.join(directory, "1-empty.bin"))).toBe(false);
    });

    it("captures the complete managed graph while projecting only the changed file to Provider inspection", () => {
        const fixture = makeCaptureFixture(root);
        fs.writeFileSync(path.join(fixture.targetRoot, GRAPH_ENTRY_PATH), GRAPH_CHANGED_NATIVE_ENTRY_TEXT);

        const captured = capture(fixture);
        validateCapturedInspection(fixture.snapshot, captured.input);
        expect(captured.input.inspectionScope.fileStates).toHaveLength(3);
        expect(captured.input.files).toEqual([
            expect.objectContaining({ fileState: "baseline_changed", relativePath: GRAPH_ENTRY_PATH }),
        ]);
        expect(captured.input.inspectionScope.directoryInventories).toEqual([
            expect.objectContaining({
                boundary: { relativePath: GRAPH_BOUNDARY, boundaryKind: "directory_inventory" },
                currentDescendantPaths: fixture.materialized.files.map((file) => file.relativePath).sort(),
            }),
        ]);
        expect(captured.input.inventoryDeltas).toEqual([]);
        expect(captured.runtimeReplacementAuthority.files).toHaveLength(3);

        const inspected = fixture.fixture.support.inspect(captured.input);
        expect(inspected).toMatchObject({ status: "complete", files: [{ attributionState: "uniquely_attributable" }] });
        expect(inspected.changes).toHaveLength(1);
    });

    it("reports added and deleted descendants and binds the full leaf graph into replacement authority", () => {
        const fixture = makeCaptureFixture(root);
        fs.rmSync(path.join(fixture.targetRoot, GRAPH_BINARY_RESOURCE_PATH));
        const addedPath = `${GRAPH_BOUNDARY}/resources/unmanaged.txt` as PosixRelativePath;
        const emptyAddedPath = `${GRAPH_BOUNDARY}/resources/empty.txt` as PosixRelativePath;
        fs.writeFileSync(path.join(fixture.targetRoot, addedPath), "unmanaged\n");
        fs.writeFileSync(path.join(fixture.targetRoot, emptyAddedPath), "");

        const captured = capture(fixture);
        validateCapturedInspection(fixture.snapshot, captured.input);
        expect(
            captured.input.inventoryDeltas
                .map((delta) => [delta.relativePath, delta.deltaKind])
                .sort(([left], [right]) => String(left).localeCompare(String(right))),
        ).toEqual(
            [
                [GRAPH_BINARY_RESOURCE_PATH, "file_deleted"],
                [addedPath, "file_added"],
                [emptyAddedPath, "file_added"],
            ].sort(([left], [right]) => String(left).localeCompare(String(right))),
        );
        expect(captured.input.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ fileState: "baseline_missing", relativePath: GRAPH_BINARY_RESOURCE_PATH }),
                expect.objectContaining({ fileState: "added_managed_descendant", relativePath: addedPath }),
            ]),
        );
        expect(captured.runtimeReplacementAuthority.files.map((file) => file.relativePath)).toContain(addedPath);
        expect(captured.runtimeReplacementAuthority.unmanagedRemovalPaths).toEqual([addedPath, emptyAddedPath].sort());
        expect(captured.runtimeReplacementAuthority.managedDirectoryBoundaryPaths).toEqual([GRAPH_BOUNDARY]);
    });

    it("fails closed for stale ownership, missing inventory semantics and unsafe managed roots", () => {
        const wrongOwner = makeCaptureFixture(root);
        wrongOwner.baseline[0]!.baselineState.provenance.outputUnitFingerprint = digest("7");
        expect(() => capture(wrongOwner)).toThrow(/attributed to more than one output unit/);

        const missingSemantic = makeCaptureFixture(root);
        missingSemantic.snapshot.decisions = missingSemantic.snapshot.decisions.filter(
            (decision) => decision.semanticRef.semanticKind !== "asset.file_inventory",
        );
        fs.rmSync(path.join(missingSemantic.targetRoot, GRAPH_BINARY_RESOURCE_PATH));
        expect(() => capture(missingSemantic)).toThrow(/no unique applied file-inventory semantic/);

        const unsafe = makeCaptureFixture(root);
        const outside = path.join(root, "outside");
        fs.mkdirSync(outside);
        fs.rmSync(path.join(unsafe.targetRoot, GRAPH_BOUNDARY), { recursive: true });
        fs.symlinkSync(outside, path.join(unsafe.targetRoot, GRAPH_BOUNDARY), "dir");
        expect(() => capture(unsafe)).toThrow(SafeFilesystemError);
    });

    it("captures a missing boundary and sorts multiple non-overlapping managed inventories", () => {
        const missing = makeCaptureFixture(root);
        fs.rmSync(path.join(missing.targetRoot, GRAPH_BOUNDARY), { recursive: true });
        const missingCapture = capture(missing);
        expect(missingCapture.input.inspectionScope.fileStates.every((state) => state.state === "missing")).toBe(true);
        expect(missingCapture.input.inventoryDeltas).toHaveLength(3);

        const multiple = makeCaptureFixture(root);
        const secondBoundary = ".fixture/other" as PosixRelativePath;
        fs.mkdirSync(path.join(multiple.targetRoot, secondBoundary), { recursive: true });
        const secondUnit = structuredClone(multiple.snapshot.outputUnits[0]!);
        secondUnit.outputUnitFingerprint = digest("8");
        secondUnit.claims = [];
        secondUnit.managedDirectoryBoundaries = [{ relativePath: secondBoundary, boundaryKind: "directory_inventory" }];
        multiple.snapshot.outputUnits.push(secondUnit);
        expect(capture(multiple).input.inspectionScope.directoryInventories.map((item) => item.boundary.relativePath)).toEqual(
            [GRAPH_BOUNDARY, secondBoundary].sort(),
        );

        const overlapping = makeCaptureFixture(root);
        const overlapUnit = structuredClone(overlapping.snapshot.outputUnits[0]!);
        overlapUnit.outputUnitFingerprint = digest("9");
        overlapUnit.claims = [];
        overlapping.snapshot.outputUnits.push(overlapUnit);
        expect(() => capture(overlapping)).toThrow(/boundaries overlap/);
    });

    it("guards filesystem race identities without relying on a nondeterministic physical race", () => {
        const identity = { deviceId: "dev", fileId: "file", entryKind: "file" as const };
        const otherIdentity = { ...identity, fileId: "other" };
        const directoryIdentity = { deviceId: "dev", fileId: "dir", entryKind: "directory" as const };
        const inventory: StableDirectoryInventory = {
            identity: directoryIdentity,
            entries: [{ relativeName: "a", identity }],
        };
        expect(deploymentInspectionCaptureInternalsForTest.sameDirectoryInventory(inventory, structuredClone(inventory))).toBe(
            true,
        );
        for (const changed of [
            { ...structuredClone(inventory), identity: { ...directoryIdentity, fileId: "other-dir" } },
            { ...structuredClone(inventory), entries: [] },
            { ...structuredClone(inventory), entries: [{ relativeName: "b", identity }] },
            { ...structuredClone(inventory), entries: [{ relativeName: "a", identity: otherIdentity }] },
        ]) {
            expect(deploymentInspectionCaptureInternalsForTest.sameDirectoryInventory(inventory, changed)).toBe(false);
        }
        expect(() =>
            deploymentInspectionCaptureInternalsForTest.requireStableManagedDirectoryInventory(
                inventory,
                { ...structuredClone(inventory), entries: [] },
                "/tmp/fixture",
            ),
        ).toThrow(/managed directory changed/);
        deploymentInspectionCaptureInternalsForTest.requireStableManagedDirectoryInventory(
            inventory,
            structuredClone(inventory),
            "/tmp/fixture",
        );
        expect(() =>
            deploymentInspectionCaptureInternalsForTest.requireManagedFileIdentity(identity, otherIdentity, "/tmp/fixture/a"),
        ).toThrow(/file identity changed/);
        deploymentInspectionCaptureInternalsForTest.requireManagedFileIdentity(identity, identity, "/tmp/fixture/a");
        deploymentInspectionCaptureInternalsForTest.requireManagedFileOwner(digest("1"), digest("1"));
        expect(() => deploymentInspectionCaptureInternalsForTest.requireManagedFileOwner(digest("1"), digest("2"))).toThrow(
            /attributed to more than one output unit/,
        );
        const missing = new SafeFilesystemError({
            failureKind: "not_found",
            operation: "inventory_directory",
            targetPath: "/tmp/missing",
            message: "missing",
        });
        expect(deploymentInspectionCaptureInternalsForTest.isAllowedMissingManagedDirectory(missing, true)).toBe(true);
        expect(deploymentInspectionCaptureInternalsForTest.isAllowedMissingManagedDirectory(missing, false)).toBe(false);
        expect(deploymentInspectionCaptureInternalsForTest.isAllowedMissingManagedDirectory(new Error("other"), true)).toBe(
            false,
        );
    });
});

function makeCaptureFixture(root: string) {
    const fixtureRoot = fs.mkdtempSync(path.join(root, "case-"));
    const fixture = makeExactGraphFixture();
    const materializationInput = exactGraphMaterializationInput(fixture);
    const materializedResult = fixture.support.materialize(materializationInput);
    if (materializedResult.materializationState !== "materialized") throw new Error("graph materialization fixture blocked");
    const materialized = materializedResult.materializedUnits[0]!;
    const inspectionFixture = changedExactGraphInspection(fixture, materializationInput);
    const snapshot = fullExactGraphAppliedSnapshot(inspectionFixture.appliedRenderSnapshot);
    const targetRoot = path.join(fixtureRoot, "target");
    const deploymentsRoot = path.join(fixtureRoot, "deployments");
    fs.mkdirSync(targetRoot);
    const provenanceByPath = new Map(
        inspectionFixture.files.flatMap((file) =>
            file.fileState === "baseline_changed" ? [[file.relativePath, validProvenance(file.provenance)] as const] : [],
        ),
    );
    const payloads = materialized.files.map((file) => {
        const bytes = bytesForContent(file.content);
        const stats = binaryPayloadStats(bytes);
        const absolute = path.join(targetRoot, file.relativePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
        if (file.executable) fs.chmodSync(absolute, 0o700);
        return { contentKind: file.content.contentKind, contentHash: stats.contentHash, bytes };
    });
    publishDeploymentPayloads({
        deploymentsRoot,
        deploymentId: fixture.deployment.deploymentId as UuidV4,
        transactionId: TRANSACTION_ID,
        payloads,
    });
    const baseline = materialized.files.map((file) => {
        const bytes = bytesForContent(file.content);
        const stats = binaryPayloadStats(bytes);
        const provenance = provenanceByPath.get(file.relativePath);
        if (provenance === undefined) throw new Error(`missing provenance for ${file.relativePath}`);
        return {
            relativePath: file.relativePath,
            baselineState: {
                rowState: "active" as const,
                appliedPayload: {
                    contentKind: file.content.contentKind,
                    contentHash: stats.contentHash,
                    byteSize: stats.byteSize,
                },
                appliedExecutable: file.executable,
                provenance: structuredClone(provenance) as TargetFileRenderProvenanceV1,
            },
            managedDirectoryBoundaryPaths: [GRAPH_BOUNDARY],
        };
    });
    return { fixture, materialized, snapshot, targetRoot, deploymentsRoot, baseline };
}

function capture(fixture: ReturnType<typeof makeCaptureFixture>) {
    return deploymentInspectionInternalsForTest.captureInspectionInput(
        { deploymentsRoot: fixture.deploymentsRoot } as never,
        fixture.fixture.deployment.deploymentId as UuidV4,
        fixture.snapshot,
        fixture.baseline as never,
        fixture.targetRoot,
    );
}

function validateCapturedInspection(
    snapshot: ReturnType<typeof makeCaptureFixture>["snapshot"],
    input: ReturnType<typeof capture>["input"],
): void {
    validateInspectionScope(input, snapshot);
    validateChangedFiles(input, snapshot);
    validateInventoryDeltas(input, snapshot);
}

function bytesForContent(content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array }) {
    return content.contentKind === "text" ? new Uint8Array(Buffer.from(content.text, "utf8")) : new Uint8Array(content.bytes);
}

function validProvenance(provenance: TargetFileRenderProvenanceV1): TargetFileRenderProvenanceV1 {
    const { provenanceFingerprint: _stored, ...preimage } = structuredClone(provenance);
    return { ...preimage, provenanceFingerprint: computeTargetFileRenderProvenanceFingerprint(preimage) };
}

function digest(character: string): Sha256Digest {
    return `sha256:${character.repeat(64)}` as Sha256Digest;
}
