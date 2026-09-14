/** One owned physical graph, its original journal and the serialized target channel. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, vi } from "vitest";
import {
    type ActiveJournalV3,
    publishJournal,
    readJournal,
    recordJournalCreatedDirectory,
    recordJournalRestoredDirectory,
} from "../../../src/deployment/deployment-journal";
import { captureDeploymentPreWritePreview } from "../../../src/deployment/deployment-prewrite-preview";
import { buildDeployEntries, buildUnmanagedRemovalEntries } from "../../../src/deployment/deployment-target-entries";
import type { TargetPlan } from "../../../src/deployment/deployment-target-plan";
import type { RestrictedTargetRequest, RestrictedTargetResponse } from "../../../src/deployment/restricted-target-contract";
import {
    createRestrictedTargetGraphOperation,
    type RestrictedGraphStep,
} from "../../../src/deployment/restricted-target-graph-operation";
import { restrictedGraphJournalFingerprint } from "../../../src/deployment/restricted-target-graph-contract";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";
import { computePhysicalClosureKeys } from "../../../src/foundation/physical-path-locks";
import { createRestrictedTargetChannel } from "../../../src/orchestration/restricted-target-channel";
import { createRestrictedTargetService } from "../../../src/orchestration/restricted-target-service";

export const FP = sha256Bytes(Buffer.from("graph authority"));
const roots: string[] = [];
const openedDirectories: number[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const descriptor of openedDirectories.splice(0)) fs.closeSync(descriptor);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

export function fixture(existingDirectories = false, removeOldDirectory = false, leaf = "leaf", seed?: (target: string) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-graph-"));
    roots.push(root);
    const target = path.join(root, "target");
    const transactions = path.join(root, "transactions");
    fs.mkdirSync(target);
    if (existingDirectories) {
        fs.mkdirSync(path.join(target, leaf, "empty"), { recursive: true });
        fs.mkdirSync(path.join(target, leaf, "resources"));
    }
    if (removeOldDirectory) {
        fs.mkdirSync(path.join(target, leaf, "obsolete/empty"), { recursive: true });
        fs.writeFileSync(path.join(target, leaf, "obsolete/old.bin"), Buffer.from([0, 255, 10, 128]), { mode: 0o750 });
        // Keep the removed historical inodes alive so the interruption control
        // deterministically compares different real filesystem identities.
        openedDirectories.push(
            fs.openSync(path.join(target, leaf, "obsolete"), "r"),
            fs.openSync(path.join(target, leaf, "obsolete/empty"), "r"),
        );
    }
    seed?.(target);
    const binding = {
        bindingId: randomUUID(),
        deploymentId: randomUUID(),
        platformInstanceId: "test-selected",
        targetRootPath: target,
        executionRootPath: target,
    };
    const directories = [leaf, `${leaf}/empty`, `${leaf}/resources`];
    const targetPlan: TargetPlan = {
        schemaVersion: 1,
        targetFiles: [
            { relativePath: `${leaf}/SKILL.md`, text: "# Complete skill\n", executable: false },
            { relativePath: `${leaf}/resources/run.sh`, text: "#!/bin/sh\nexit 0\n", executable: true },
        ].map((file) => ({
            relativePath: file.relativePath,
            executable: file.executable,
            content: { contentKind: "text", text: file.text },
            outputUnitFingerprint: FP,
            materializationFingerprint: FP,
            semanticRefFingerprints: [FP],
            sectionBindings: [],
        })),
        managedDirectoryBoundaries: [{ relativePath: leaf, outputUnitFingerprint: FP, desiredDirectoryPaths: directories }],
    };
    const preview = captureDeploymentPreWritePreview({
        deploymentId: binding.deploymentId,
        targetRootPath: target,
        renderInputFingerprint: FP,
        selectionFingerprint: FP,
        compilationFingerprint: FP,
        targetPlan,
        baseline: [],
    });
    const input = {
        compilationFingerprint: FP,
        entries: [
            ...buildDeployEntries(targetPlan, new Map()).map((entry) => ({
                ...entry,
                newProvenanceFingerprint: FP,
                newMaterializationFingerprint: FP,
            })),
            ...buildUnmanagedRemovalEntries(
                preview.runtimeReplacementAuthority,
                new Set(targetPlan.targetFiles.map((file) => file.relativePath)),
                new Set(),
            ),
        ],
        managedDirectoryBoundaries: [leaf],
        desiredDirectoryPaths: directories,
        // This fixture's retained schema-3 journal keeps exact-current authority.
        // Publication tests explicitly request the schema-3 preview's new scope.
        runtimeReplacementAuthority: (({ replacementScope: _scope, ...legacy }) => legacy)(preview.runtimeReplacementAuthority),
    };
    const operation = createRestrictedTargetGraphOperation(binding);
    const result = operation.prepare(input);
    if (result.outcome !== "ready") throw new Error(`graph preparation failed: ${result.outcome}`);
    const { prepared } = result;
    const journal: ActiveJournalV3 = {
        schemaVersion: 3,
        transactionId: randomUUID(),
        deploymentId: binding.deploymentId,
        createdAt: Date.now(),
        compilationFingerprint: prepared.compilationFingerprint,
        entries: prepared.entries,
        managedDirectoryBoundaries: prepared.managedDirectoryBoundaries,
        directoryEntries: prepared.directoryEntries,
        targetExecution: prepared.targetExecution,
        reservedPhysicalKeys: computePhysicalClosureKeys("wsl", target, [
            ...prepared.entries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
                containingDirectoryBoundaries: [leaf],
            })),
            ...prepared.directoryEntries.map((entry) => ({ relativePath: entry.relativePath, entryKind: "directory" as const })),
        ]),
    };
    publishJournal(transactions, journal);
    return { root, target, transactions, binding, input, prepared, journal, operation, leaf, preview };
}

export type Fixture = ReturnType<typeof fixture>;
export function persist(h: Fixture, journal: ActiveJournalV3, step: RestrictedGraphStep): ActiveJournalV3 {
    if (step.kind !== "directory_receipt_required") throw new Error("expected a directory receipt request");
    expect(step.journalFingerprint).toBe(restrictedGraphJournalFingerprint(journal));
    const current = readJournal(h.transactions, journal.transactionId);
    expect(current).toEqual(journal);
    return step.side === "old"
        ? recordJournalRestoredDirectory(h.transactions, journal, step.relativePath, step.identity)
        : recordJournalCreatedDirectory(h.transactions, journal, step.relativePath, step.identity);
}

export function finish(h: Fixture) {
    let journal = h.journal;
    let step = h.operation.execute(h.prepared.preparationId, journal);
    const receipts: string[] = [];
    while (step.kind === "directory_receipt_required") {
        receipts.push(step.relativePath);
        if (receipts.length > h.journal.directoryEntries.length) throw new Error("unexpected duplicate directory receipt");
        expect(fs.existsSync(path.join(h.target, h.leaf, "SKILL.md"))).toBe(false);
        journal = persist(h, journal, step);
        step = h.operation.continue(journal);
    }
    return { journal, step, receipts };
}

export function wire(h: Fixture, corrupt?: (response: RestrictedTargetResponse) => void) {
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const service = createRestrictedTargetService({ ...session, deadlineAt: Date.now() + 60_000, bindings: [h.binding] });
    const requests: RestrictedTargetRequest[] = [];
    const channel = createRestrictedTargetChannel(session, (request) => {
        const detached = JSON.parse(JSON.stringify(request)) as RestrictedTargetRequest;
        requests.push(detached);
        const response = service.handle(detached);
        corrupt?.(response);
        return JSON.parse(JSON.stringify(response));
    });
    const graph = channel.bind(h.binding).graph;
    if (graph === undefined) throw new Error("the production target channel did not expose graph execution");
    const persistReceipt = (
        journal: ActiveJournalV3,
        relativePath: string,
        identity: Parameters<typeof recordJournalCreatedDirectory>[3],
        side: "old" | "new",
    ) => {
        return side === "old"
            ? recordJournalRestoredDirectory(h.transactions, journal, relativePath, identity)
            : recordJournalCreatedDirectory(h.transactions, journal, relativePath, identity);
    };
    return { channel, graph, requests, persistReceipt };
}
