import { selectedWslTargetTransactions } from "../../src/deployment/selected-wsl-target-transaction";
import { localTargetTransactions } from "../../src/deployment/local-target-transaction";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeDeploymentForTest } from "../../src/deployment/deployment-executor";
import { readJournal, scanJournals, deleteJournal } from "../../src/deployment/deployment-journal";
import { captureDeploymentPreWritePreview as captureCurrentPreWritePreview } from "../../src/deployment/deployment-prewrite-preview";
import { recoverDeployment, recoverDeploymentForTest } from "../../src/deployment/deployment-recovery";
import * as targetIo from "../../src/deployment/deployment-target-io";
import { casWriteAll as writeDeploymentTargets } from "../../src/deployment/deployment-target-cas";
import { verifyAll as verifyDeploymentTargets } from "../../src/deployment/deployment-target-verify";
import { acquireAllLocks, computePhysicalClosureKeys } from "../../src/foundation/physical-path-locks";
import {
    softDeleteDeploymentAsset,
    updateDeployment,
    upsertDeploymentAsset,
    upsertDeploymentFile,
    getDeployment,
} from "../../src/persistence/state-db";
import { createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import type { RestrictedTargetRequest, RestrictedTargetResponse } from "../../src/deployment/restricted-target-contract";
import { serializeDeploymentFileBaselineState } from "../../src/render/deployment-render-authority";
import { openValidatedCompiledDeploymentPlan } from "../../src/render/render-compiler";
import { makeCompiledLifecycleFixture } from "../render/fixtures/render-lifecycle-fixtures";
import { A1, D1, type H, harness, seedRealBaseline } from "./fixtures/deployment-executor-test-fixtures";

/** Historical V2/V3 requests keep their current-content CAS and per-entry receipt semantics. */
function captureDeploymentPreWritePreview(input: Parameters<typeof captureCurrentPreWritePreview>[0]) {
    const preview = captureCurrentPreWritePreview(input);
    const { replacementScope: _currentScope, ...runtimeReplacementAuthority } = preview.runtimeReplacementAuthority;
    return { ...preview, runtimeReplacementAuthority };
}

async function prepareCompleteDirectoryFixture(
    h: H,
    options: {
        seedOldGraph?: boolean;
        desiredDirectoryPaths?: string[];
        selectedWsl?: boolean;
        nativeWsl?: boolean;
        missingAncestors?: boolean;
        looseFile?: boolean;
    } = {},
) {
    const renderFixtureRoot = path.join(h.deploymentsRoot, "graph-fault-render-fixture");
    fs.mkdirSync(renderFixtureRoot, { recursive: true });
    const targetRootPath =
        options.selectedWsl === true ? `\\\\wsl.localhost\\test-selected\\${h.root.slice(1).replaceAll("/", "\\")}` : h.root;
    const fixture = await makeCompiledLifecycleFixture(renderFixtureRoot, {
        analysisResultOptions: {
            relativePath: options.looseFile ? "loose.md" : "skills/demo/SKILL.md",
            ...(options.looseFile ? {} : { managedDirectoryBoundary: "skills/demo" }),
            ...(options.desiredDirectoryPaths === undefined ? {} : { desiredDirectoryPaths: options.desiredDirectoryPaths }),
        },
        deploymentOverrides: {
            deploymentId: D1,
            targetRootPath,
            ...(options.selectedWsl === true || options.nativeWsl === true
                ? { platform: "wsl", platformInstanceId: "test-selected" }
                : {}),
        },
    });
    softDeleteDeploymentAsset(h.db, D1, A1, 5100);
    for (const [index, asset] of fixture.appliedInputsSnapshot.assets.entries()) {
        upsertDeploymentAsset(h.db, D1, asset.assetId, asset.versionId, index, asset.allowIncomplete ? 1 : 0, 5200 + index);
    }
    updateDeployment(
        h.db,
        D1,
        {
            consumerAgentRuntimeIds: JSON.stringify(fixture.appliedInputsSnapshot.consumerAgentRuntimeIds),
            targetRootPath,
            ...(options.selectedWsl === true || options.nativeWsl === true
                ? { platform: "wsl", platformInstanceId: "test-selected" }
                : {}),
        },
        5000,
    );
    if (options.seedOldGraph === false) {
        if (!options.missingAncestors) fs.mkdirSync(path.join(h.root, "skills"), { recursive: true });
    } else {
        fs.mkdirSync(path.join(h.root, "skills/demo/empty"), { recursive: true });
        fs.writeFileSync(path.join(h.root, "skills/demo/unmanaged.txt"), "remove me\n");
    }

    const compiled = openValidatedCompiledDeploymentPlan(fixture.compiledToken);
    const snapshot = compiled.executionAuthority.appliedRenderSnapshot;
    const reviewed = captureDeploymentPreWritePreview({
        deploymentId: D1,
        targetRootPath: h.root,
        renderInputFingerprint: snapshot.renderInputFingerprint,
        selectionFingerprint: snapshot.selectionFingerprint,
        compilationFingerprint: snapshot.compilationFingerprint,
        targetPlan: compiled.targetPlan,
        baseline: [],
    });
    return { compiled, reviewed };
}

type PreparedCompleteDirectoryFixture = Awaited<ReturnType<typeof prepareCompleteDirectoryFixture>>;

function connectGraph(
    h: H,
    hooks: {
        before?: (request: RestrictedTargetRequest) => void;
        after?: (response: RestrictedTargetResponse) => void;
    } = {},
) {
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const binding = {
        bindingId: randomUUID(),
        deploymentId: D1,
        platformInstanceId: "test-selected",
        targetRootPath: getDeployment(h.db, D1)!.targetRootPath,
        executionRootPath: h.root,
    };
    const requests: RestrictedTargetRequest[] = [];
    const service = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
    const channel = createRestrictedTargetChannel(session, (request) => {
        const detached = JSON.parse(JSON.stringify(request)) as RestrictedTargetRequest;
        requests.push(detached);
        hooks.before?.(detached);
        const response = service.handle(detached);
        hooks.after?.(response);
        return JSON.parse(JSON.stringify(response));
    });
    const execution = channel.bind(binding);
    h.opts.targetExecution = selectedWslTargetTransactions(execution);
    return { execution, requests, channel };
}

function retainCommitNoJournal(h: H, fixture: PreparedCompleteDirectoryFixture): string {
    expect(() => {
        const result = executeDeploymentForTest(
            h.opts,
            fixture.compiled.targetPlan,
            fixture.compiled.executionAuthority,
            {
                publishDeploymentPayloads: () => {
                    throw new Error("injected post-write payload publication failure");
                },
            },
            fixture.reviewed.runtimeReplacementAuthority,
        );
        throw new Error(`Expected the post-write failure seam, received ${JSON.stringify(result)}`);
    }).toThrow(/injected post-write payload publication failure/);
    const transactionId = scanJournals(h.txnRoot, D1).matchingTxnIds[0];
    if (transactionId === undefined) throw new Error("expected retained commit-no journal");
    return transactionId;
}

function retainCommitYesJournal(h: H, fixture: PreparedCompleteDirectoryFixture): string {
    const result = executeDeploymentForTest(
        h.opts,
        fixture.compiled.targetPlan,
        fixture.compiled.executionAuthority,
        {
            deleteJournal: () => {
                throw new Error("injected committed journal retention");
            },
        },
        fixture.reviewed.runtimeReplacementAuthority,
    );
    expect(result).toEqual(expect.objectContaining({ outcome: "committed" }));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("journal_marker_stuck");
    const transactionId = scanJournals(h.txnRoot, D1).matchingTxnIds[0];
    if (transactionId === undefined) throw new Error("expected retained commit-yes journal");
    return transactionId;
}

describe("executeDeployment — complete-directory recovery", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it.each([
        "host",
        "restricted",
    ] as const)("%s reserves a missing shared ancestor and recovers its real created graph after a commit-no failure", async (backend) => {
        const fixture = await prepareCompleteDirectoryFixture(h, {
            seedOldGraph: false,
            missingAncestors: true,
            selectedWsl: backend === "restricted",
            desiredDirectoryPaths: ["skills/demo", "skills/demo/empty"],
        });
        if (backend === "restricted") connectGraph(h);
        expect(fs.readdirSync(h.root)).toEqual([]);
        const transactionId = retainCommitNoJournal(h, fixture);
        const journal = readJournal(h.txnRoot, transactionId);
        if (journal === null || journal.schemaVersion === 1) throw new Error("expected complete graph journal");
        expect(journal.directoryEntries.map((entry) => entry.relativePath)).toEqual([
            "skills",
            "skills/demo",
            "skills/demo/empty",
        ]);
        expect(journal.directoryEntries.every((entry) => entry.createdIdentity !== null)).toBe(true);
        const deployment = getDeployment(h.db, D1)!;
        const ancestorKeys = computePhysicalClosureKeys(deployment.platform, deployment.targetRootPath, [
            { relativePath: "skills", entryKind: "directory" },
        ]);
        expect(journal.reservedPhysicalKeys).toEqual(expect.arrayContaining(ancestorKeys));
        expect(fs.readFileSync(path.join(h.root, "skills/demo/SKILL.md")).length).toBeGreaterThan(0);
        const execution =
            backend === "restricted" ? selectedWslTargetTransactions(connectGraph(h).execution) : localTargetTransactions;
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, execution)).toEqual({
            outcome: "recovered_to_old",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.readdirSync(h.root)).toEqual([]);
        expect(readJournal(h.txnRoot, transactionId)).toBeNull();
    });

    it.each([
        "host",
        "restricted",
    ] as const)("%s honors a pre-held missing ancestor lock before graph preparation or creation", async (backend) => {
        const fixture = await prepareCompleteDirectoryFixture(h, {
            seedOldGraph: false,
            missingAncestors: true,
            selectedWsl: backend === "restricted",
        });
        const peer = backend === "restricted" ? connectGraph(h) : undefined;
        const deployment = getDeployment(h.db, D1)!;
        const lease = acquireAllLocks(
            h.txnRoot,
            computePhysicalClosureKeys(deployment.platform, deployment.targetRootPath, [
                { relativePath: "skills", entryKind: "directory" },
            ]),
        );
        if (lease === null) throw new Error("fixture ancestor lease unavailable");
        try {
            expect(
                executeDeploymentForTest(
                    h.opts,
                    fixture.compiled.targetPlan,
                    fixture.compiled.executionAuthority,
                    {},
                    fixture.reviewed.runtimeReplacementAuthority,
                ),
            ).toEqual(expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_by_deploy_target_locked" }));
            expect(fs.readdirSync(h.root)).toEqual([]);
            expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
            if (peer !== undefined) expect(peer.requests).toEqual([]);
        } finally {
            lease.release();
        }
    });

    it("creates, journals, verifies, and recovers one explicit V2 empty leaf directory", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h, {
            seedOldGraph: false,
            desiredDirectoryPaths: ["skills/demo", "skills/demo/empty"],
        });
        const retained = executeDeploymentForTest(
            h.opts,
            fixture.compiled.targetPlan,
            fixture.compiled.executionAuthority,
            {
                deleteJournal: () => {
                    throw new Error("injected committed journal retention");
                },
            },
            fixture.reviewed.runtimeReplacementAuthority,
        );
        expect(retained).toEqual(expect.objectContaining({ outcome: "committed" }));
        expect(fs.statSync(path.join(h.root, "skills/demo/empty")).isDirectory()).toBe(true);
        const transactionId = scanJournals(h.txnRoot, D1).matchingTxnIds[0];
        expect(transactionId).toBeDefined();
        const journal = readJournal(h.txnRoot, transactionId as string);
        if (journal?.schemaVersion !== 2) throw new Error("expected readable v2 journal");
        expect(journal.directoryEntries.map((entry) => entry.relativePath)).toEqual(["skills/demo", "skills/demo/empty"]);
        const minimumKeys = computePhysicalClosureKeys("linux", h.root, [
            ...journal.entries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
                containingDirectoryBoundaries: ["skills/demo"],
            })),
            ...journal.directoryEntries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "directory" as const,
                containingDirectoryBoundaries: ["skills/demo"],
            })),
        ]);
        expect(journal.reservedPhysicalKeys).toEqual(expect.arrayContaining(minimumKeys));
        expect(recoverDeployment(h.db, h.txnRoot, transactionId as string, localTargetTransactions)).toEqual({
            outcome: "recovered_to_new",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.statSync(path.join(h.root, "skills/demo/empty")).isDirectory()).toBe(true);
    });

    it("removes an explicit V2 empty leaf again when commit-no recovery restores the absent graph", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h, {
            seedOldGraph: false,
            desiredDirectoryPaths: ["skills/demo", "skills/demo/empty"],
        });
        expect(() =>
            executeDeploymentForTest(
                h.opts,
                fixture.compiled.targetPlan,
                fixture.compiled.executionAuthority,
                {
                    publishDeploymentPayloads: () => {
                        throw new Error("injected post-write payload publication failure");
                    },
                },
                fixture.reviewed.runtimeReplacementAuthority,
            ),
        ).toThrow(/injected post-write payload publication failure/);
        expect(fs.statSync(path.join(h.root, "skills/demo/empty")).isDirectory()).toBe(true);
        const transactionId = scanJournals(h.txnRoot, D1).matchingTxnIds[0];
        expect(transactionId).toBeDefined();
        expect(recoverDeployment(h.db, h.txnRoot, transactionId as string, localTargetTransactions)).toEqual({
            outcome: "recovered_to_old",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.existsSync(path.join(h.root, "skills/demo"))).toBe(false);
    });

    it("recovers the exact old leaf graph after a post-write commit failure without touching siblings", async () => {
        const renderFixtureRoot = path.join(h.deploymentsRoot, "graph-recovery-render-fixture");
        fs.mkdirSync(renderFixtureRoot, { recursive: true });
        const fixture = await makeCompiledLifecycleFixture(renderFixtureRoot, {
            analysisResultOptions: {
                relativePath: "skills/demo/SKILL.md",
                managedDirectoryBoundary: "skills/demo",
            },
            deploymentOverrides: { deploymentId: D1, targetRootPath: h.root },
        });
        softDeleteDeploymentAsset(h.db, D1, A1, 5100);
        for (const [index, asset] of fixture.appliedInputsSnapshot.assets.entries()) {
            upsertDeploymentAsset(h.db, D1, asset.assetId, asset.versionId, index, asset.allowIncomplete ? 1 : 0, 5200 + index);
        }
        updateDeployment(
            h.db,
            D1,
            {
                consumerAgentRuntimeIds: JSON.stringify(fixture.appliedInputsSnapshot.consumerAgentRuntimeIds),
                targetRootPath: h.root,
            },
            5000,
        );
        fs.mkdirSync(path.join(h.root, "skills/demo/empty"), { recursive: true });
        fs.mkdirSync(path.join(h.root, "skills/sibling"), { recursive: true });
        fs.writeFileSync(path.join(h.root, "skills/demo/unmanaged.txt"), "restore me\n");
        fs.writeFileSync(path.join(h.root, "skills/sibling/KEEP.md"), "sibling\n");

        const compiled = openValidatedCompiledDeploymentPlan(fixture.compiledToken);
        const snapshot = compiled.executionAuthority.appliedRenderSnapshot;
        const reviewed = captureDeploymentPreWritePreview({
            deploymentId: D1,
            targetRootPath: h.root,
            renderInputFingerprint: snapshot.renderInputFingerprint,
            selectionFingerprint: snapshot.selectionFingerprint,
            compilationFingerprint: snapshot.compilationFingerprint,
            targetPlan: compiled.targetPlan,
            baseline: [],
        });
        expect(() =>
            executeDeploymentForTest(
                h.opts,
                compiled.targetPlan,
                compiled.executionAuthority,
                {
                    publishDeploymentPayloads: () => {
                        throw new Error("injected post-write payload publication failure");
                    },
                },
                reviewed.runtimeReplacementAuthority,
            ),
        ).toThrow(/injected post-write payload publication failure/);
        expect(fs.existsSync(path.join(h.root, "skills/demo/SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(h.root, "skills/demo/unmanaged.txt"))).toBe(false);
        expect(fs.existsSync(path.join(h.root, "skills/demo/empty"))).toBe(false);

        const transactionId = scanJournals(h.txnRoot, D1).matchingTxnIds[0];
        expect(transactionId).toBeDefined();
        const journal = readJournal(h.txnRoot, transactionId as string);
        if (journal?.schemaVersion !== 2) throw new Error("expected readable v2 journal");
        const minimumKeys = computePhysicalClosureKeys("linux", h.root, [
            ...journal.entries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
                containingDirectoryBoundaries: journal.managedDirectoryBoundaries.filter((boundary) =>
                    entry.relativePath.startsWith(`${boundary}/`),
                ),
            })),
            ...journal.directoryEntries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "directory" as const,
                containingDirectoryBoundaries: journal.managedDirectoryBoundaries.filter(
                    (boundary) => entry.relativePath === boundary || entry.relativePath.startsWith(`${boundary}/`),
                ),
            })),
        ]);
        expect(journal.reservedPhysicalKeys).toEqual(expect.arrayContaining(minimumKeys));
        expect(recoverDeployment(h.db, h.txnRoot, transactionId as string, localTargetTransactions)).toEqual({
            outcome: "recovered_to_old",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.existsSync(path.join(h.root, "skills/demo/SKILL.md"))).toBe(false);
        expect(fs.readFileSync(path.join(h.root, "skills/demo/unmanaged.txt"), "utf8")).toBe("restore me\n");
        expect(fs.statSync(path.join(h.root, "skills/demo/empty")).isDirectory()).toBe(true);
        expect(fs.readFileSync(path.join(h.root, "skills/sibling/KEEP.md"), "utf8")).toBe("sibling\n");
    });

    it("retains the journal when a reviewed directory-removal identity changes after file CAS", async () => {
        const { compiled, reviewed } = await prepareCompleteDirectoryFixture(h);
        const result = executeDeploymentForTest(
            h.opts,
            compiled.targetPlan,
            compiled.executionAuthority,
            {
                casWriteAll: (entries, ctx) => {
                    const written = writeDeploymentTargets(entries, ctx);
                    fs.renameSync(path.join(h.root, "skills/demo/empty"), path.join(h.root, "skills/demo/empty-replaced-away"));
                    fs.mkdirSync(path.join(h.root, "skills/demo/empty"));
                    return written;
                },
            },
            reviewed.runtimeReplacementAuthority,
        );
        expect(result).toEqual(
            expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_by_deploy_target_unavailable" }),
        );
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
    });

    it("blocks when exact files verify but the complete managed graph gains one extra file", async () => {
        const { compiled, reviewed } = await prepareCompleteDirectoryFixture(h);
        const result = executeDeploymentForTest(
            h.opts,
            compiled.targetPlan,
            compiled.executionAuthority,
            {
                verifyAll: (entries, ctx) => {
                    const verified = verifyDeploymentTargets(entries, ctx);
                    fs.writeFileSync(path.join(h.root, "skills/demo/ghost.txt"), "third value");
                    return verified;
                },
            },
            reviewed.runtimeReplacementAuthority,
        );
        expect(result).toEqual(
            expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_by_deploy_verification_failed" }),
        );
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
    });

    it("maps an unreadable post-write managed graph to verification blocked", async () => {
        const { compiled, reviewed } = await prepareCompleteDirectoryFixture(h);
        const result = executeDeploymentForTest(
            h.opts,
            compiled.targetPlan,
            compiled.executionAuthority,
            {
                verifyAll: (entries, ctx) => {
                    const verified = verifyDeploymentTargets(entries, ctx);
                    fs.rmSync(path.join(h.root, "skills/demo"), { recursive: true });
                    fs.writeFileSync(path.join(h.root, "skills/demo"), "not a directory");
                    return verified;
                },
            },
            reviewed.runtimeReplacementAuthority,
        );
        expect(result).toEqual(
            expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_by_deploy_verification_failed" }),
        );
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
    });

    it("accepts an explicit unmanaged replacement only from an exact removed DB row", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const transactionId = retainCommitNoJournal(h, fixture);
        upsertDeploymentFile(
            h.db,
            D1,
            "skills/demo/unmanaged.txt",
            serializeDeploymentFileBaselineState({
                rowState: "removed",
                latestResidualAuthorityId: `sha256:${"a".repeat(64)}`,
            }),
            "missing",
            "",
            0,
            6_000,
            6_000,
        );
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "recovered_to_old",
            reasonCode: "",
            journalResolved: true,
        });
    });

    it("rejects an explicit unmanaged replacement when the DB row remains active", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const transactionId = retainCommitNoJournal(h, fixture);
        seedRealBaseline(h, D1, "skills/demo/unmanaged.txt", "remove me\n");
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_state_unavailable",
            journalResolved: false,
        });
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([transactionId]);
    });

    it("finishes an exact committed v2 graph whose directory receipts remain current", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const transactionId = retainCommitYesJournal(h, fixture);
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "recovered_to_new",
            reasonCode: "",
            journalResolved: true,
        });
    });

    it("blocks committed recovery when a desired directory identity changed", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const transactionId = retainCommitYesJournal(h, fixture);
        fs.renameSync(path.join(h.root, "skills/demo"), path.join(h.root, "skills/demo-replaced-away"));
        fs.mkdirSync(path.join(h.root, "skills/demo"), { recursive: true });
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_changed",
            journalResolved: false,
        });
    });

    it("retains a committed journal when a recreated OAAM directory cannot replace its receipt", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h, { seedOldGraph: false });
        const transactionId = retainCommitYesJournal(h, fixture);
        fs.rmSync(path.join(h.root, "skills/demo"), { recursive: true });
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_unavailable",
            journalResolved: false,
        });
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([transactionId]);
    });

    it("retains a committed journal when a reviewed removed directory reappears", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const transactionId = retainCommitYesJournal(h, fixture);
        fs.mkdirSync(path.join(h.root, "skills/demo/empty"));
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_unavailable",
            journalResolved: false,
        });
    });

    it("retains a committed journal when the exact managed graph gains a third value", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const transactionId = retainCommitYesJournal(h, fixture);
        fs.writeFileSync(path.join(h.root, "skills/demo/ghost.txt"), "third value");
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_unavailable",
            journalResolved: false,
        });
    });

    it("blocks commit-no recovery when an old directory returns with a different identity", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const retainedOldDirectory = fs.openSync(path.join(h.root, "skills/demo/empty"), "r");
        try {
            const transactionId = retainCommitNoJournal(h, fixture);
            fs.mkdirSync(path.join(h.root, "skills/demo/empty"));
            expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
                outcome: "blocked",
                reasonCode: "blocked_by_recovery_target_changed",
                journalResolved: false,
            });
        } finally {
            fs.closeSync(retainedOldDirectory);
        }
    });

    it("retains a commit-no journal when the restored managed graph has an extra file", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const transactionId = retainCommitNoJournal(h, fixture);
        fs.writeFileSync(path.join(h.root, "skills/demo/ghost.txt"), "third value");
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_unavailable",
            journalResolved: false,
        });
    });

    it("retains a commit-no journal when an OAAM-created directory changes before cleanup", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h, { seedOldGraph: false });
        const transactionId = retainCommitNoJournal(h, fixture);
        fs.renameSync(path.join(h.root, "skills/demo"), path.join(h.root, "skills/demo-replaced-away"));
        fs.mkdirSync(path.join(h.root, "skills/demo"));
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_unavailable",
            journalResolved: false,
        });
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([transactionId]);
    });

    it("maps a no-follow managed-graph capture failure to recovery target unavailable", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h);
        const transactionId = retainCommitNoJournal(h, fixture);
        fs.symlinkSync(path.join(h.root, "outside"), path.join(h.root, "skills/demo/ghost-link"));
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_unavailable",
            journalResolved: false,
        });
    });
});

describe("selected-WSL graph execution through Core State and original journal recovery", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        h.cleanup();
    });

    async function prepare() {
        return prepareCompleteDirectoryFixture(h, {
            selectedWsl: true,
            seedOldGraph: false,
            desiredDirectoryPaths: ["skills/demo", "skills/demo/empty"],
        });
    }

    it.each([
        "old",
        "new",
    ])("preserves a real native-WSL v2 %s journal without granting a new execution binding", async (side) => {
        const fixture = await prepareCompleteDirectoryFixture(h, { nativeWsl: true, seedOldGraph: false, looseFile: true });
        if (side === "old")
            expect(() =>
                executeDeploymentForTest(h.opts, fixture.compiled.targetPlan, fixture.compiled.executionAuthority, {
                    publishDeploymentPayloads: () => {
                        throw new Error("retained legacy post-write publication failure");
                    },
                }),
            ).toThrow("retained legacy post-write publication failure");
        else
            expect(
                executeDeploymentForTest(h.opts, fixture.compiled.targetPlan, fixture.compiled.executionAuthority, {
                    deleteJournal: () => {
                        throw new Error("retained committed legacy journal");
                    },
                }).outcome,
            ).toBe("committed");
        const txnId = scanJournals(h.txnRoot, D1).matchingTxnIds[0]!;
        expect(readJournal(h.txnRoot, txnId)?.schemaVersion).toBe(2);
        const journalPath = path.join(h.txnRoot, txnId, "journal.json");
        const journalBefore = fs.readFileSync(journalPath);
        const targetBefore = fs.readFileSync(path.join(h.root, "loose.md"));
        const deploymentBefore = getDeployment(h.db, D1);
        const reopened = connectGraph(h);
        expect(recoverDeployment(h.db, h.txnRoot, txnId, selectedWslTargetTransactions(reopened.execution))).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_state_unavailable",
            journalResolved: false,
        });
        expect(reopened.requests).toEqual([]);
        expect(fs.readFileSync(path.join(h.root, "loose.md"))).toEqual(targetBefore);
        expect(getDeployment(h.db, D1)).toEqual(deploymentBefore);
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe(side === "new" ? txnId : "");
        expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
        expect(recoverDeployment(h.db, h.txnRoot, txnId, localTargetTransactions)).toEqual({
            outcome: side === "new" ? "recovered_to_new" : "recovered_to_old",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.existsSync(path.join(h.root, "loose.md"))).toBe(side === "new");
        expect(getDeployment(h.db, D1)).toEqual(deploymentBefore);
    });

    it("commits a loose file through the graph owner without replacement authority", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h, { selectedWsl: true, seedOldGraph: false, looseFile: true });
        const connection = connectGraph(h);
        const result = executeDeploymentForTest(h.opts, fixture.compiled.targetPlan, fixture.compiled.executionAuthority, {});
        expect(result.outcome).toBe("committed");
        expect(connection.requests[0]!.operation.kind).toBe("prepare_graph");
        expect(connection.requests[0]!.operation).not.toHaveProperty("input.runtimeReplacementAuthority");
        expect(fs.readFileSync(path.join(h.root, "loose.md"), "utf8")).not.toBe("");
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe(result.transactionId);
        expect(readJournal(h.txnRoot, result.transactionId)).toBeNull();
    });

    it.each([
        "conflict",
        "unavailable",
        "unsupported",
    ])("retains the original graph preparation refusal %s in Core", async (kind) => {
        const fixture = await prepare();
        const connection = connectGraph(h);
        if (kind === "conflict") {
            fs.mkdirSync(path.join(h.root, "skills/demo"));
            fs.writeFileSync(path.join(h.root, "skills/demo/SKILL.md"), "third value");
        } else if (kind === "unavailable") fs.mkdirSync(path.join(h.root, "skills/demo/SKILL.md"), { recursive: true });
        else
            vi.spyOn(targetIo, "ioAssertExecutableStateSupported").mockImplementation(() => {
                throw new Error("mode unavailable");
            });
        const result = executeDeploymentForTest(
            h.opts,
            fixture.compiled.targetPlan,
            fixture.compiled.executionAuthority,
            {},
            fixture.reviewed.runtimeReplacementAuthority,
        );
        expect(result.outcome).toBe(kind === "conflict" ? "conflict" : "blocked");
        expect(connection.requests.map((request) => request.operation.kind)).toEqual(["prepare_graph"]);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe("");
    });

    it.each([
        false,
        true,
    ])("preserves an actual post-preparation CAS conflict with journal cleanup failure %s", async (cleanupFails) => {
        const fixture = await prepareCompleteDirectoryFixture(h, {
            selectedWsl: true,
            desiredDirectoryPaths: ["skills/demo", "skills/demo/empty"],
        });
        connectGraph(h, {
            after(response) {
                if (response.result.kind === "prepare_graph" && response.result.result.outcome === "ready")
                    fs.writeFileSync(path.join(h.root, "skills/demo/SKILL.md"), "third value");
            },
        });
        const result = executeDeploymentForTest(
            h.opts,
            fixture.compiled.targetPlan,
            fixture.compiled.executionAuthority,
            cleanupFails
                ? {
                      deleteJournal: () => {
                          throw new Error("journal cleanup failure");
                      },
                  }
                : {},
            fixture.reviewed.runtimeReplacementAuthority,
        );
        expect(result.outcome).toBe(cleanupFails ? "blocked" : "conflict");
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(cleanupFails ? 1 : 0);
        expect(fs.readFileSync(path.join(h.root, "skills/demo/SKILL.md"), "utf8")).toBe("third value");
        expect(fs.readFileSync(path.join(h.root, "skills/demo/unmanaged.txt"), "utf8")).toBe("remove me\n");
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe("");
    });

    it("records an old-directory recreation through Core before restoring the original uncommitted graph", async () => {
        const fixture = await prepareCompleteDirectoryFixture(h, { selectedWsl: true, desiredDirectoryPaths: ["skills/demo"] });
        connectGraph(h);
        const txnId = retainCommitNoJournal(h, fixture);
        const original = readJournal(h.txnRoot, txnId);
        expect(fs.existsSync(path.join(h.root, "skills/demo/empty"))).toBe(false);
        expect(recoverDeploymentForTest(h.db, targetIo.createTargetIo(h.root), h.txnRoot, txnId, deleteJournal)).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_unavailable",
            journalResolved: false,
        });
        expect(readJournal(h.txnRoot, txnId)).toEqual(original);
        let receipts = 0;
        const reopened = connectGraph(h, {
            before(request) {
                if (request.operation.kind !== "continue_graph") return;
                expect(readJournal(h.txnRoot, txnId)).toEqual(request.operation.journal);
                expect(
                    request.operation.journal.directoryEntries.find((entry) => entry.relativePath === "skills/demo/empty")!
                        .restoredIdentity,
                ).not.toBeNull();
                receipts++;
            },
        });
        expect(recoverDeployment(h.db, h.txnRoot, txnId, selectedWslTargetTransactions(reopened.execution)).outcome).toBe(
            "recovered_to_old",
        );
        expect(receipts).toBe(1);
        expect(fs.readdirSync(path.join(h.root, "skills/demo/empty"))).toEqual([]);
        expect(fs.readFileSync(path.join(h.root, "skills/demo/unmanaged.txt"), "utf8")).toBe("remove me\n");
        expect(fs.existsSync(path.join(h.root, "skills/demo/SKILL.md"))).toBe(false);
        expect(readJournal(h.txnRoot, txnId)).toBeNull();
    });

    it.each(["binding", "graph"])("rejects an unavailable recovery %s before original target IO", async (kind) => {
        const fixture = await prepare();
        connectGraph(h);
        const txnId = retainCommitNoJournal(h, fixture);
        const original = readJournal(h.txnRoot, txnId);
        const reopened = connectGraph(h);
        const execution =
            kind === "graph"
                ? { ...reopened.execution, graph: undefined }
                : { ...reopened.execution, binding: { ...reopened.execution.binding, deploymentId: randomUUID() } };
        expect(recoverDeployment(h.db, h.txnRoot, txnId, selectedWslTargetTransactions(execution))).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_state_unavailable",
            journalResolved: false,
        });
        expect(reopened.requests).toEqual([]);
        expect(readJournal(h.txnRoot, txnId)).toEqual(original);
    });

    it("rejects an old-side persistence callback supplied by a faulty forward-execution dependency", async () => {
        const fixture = await prepare();
        const connection = connectGraph(h);
        const graph = connection.execution.graph!;
        h.opts.targetExecution = selectedWslTargetTransactions({
            ...connection.execution,
            graph: {
                ...graph,
                execute(id, journal, persist) {
                    return graph.execute(id, journal, (current, relativePath, identity) =>
                        persist(current, relativePath, identity, "old"),
                    );
                },
            },
        });
        const result = executeDeploymentForTest(
            h.opts,
            fixture.compiled.targetPlan,
            fixture.compiled.executionAuthority,
            {},
            fixture.reviewed.runtimeReplacementAuthority,
        );
        expect(result.outcome).toBe("blocked");
        const [txnId] = scanJournals(h.txnRoot, D1).matchingTxnIds;
        const journal = readJournal(h.txnRoot, txnId!);
        if (journal?.schemaVersion !== 3) throw new Error("expected original v3 journal");
        expect(journal.directoryEntries.every((entry) => entry.createdIdentity === null && entry.restoredIdentity === null)).toBe(
            true,
        );
        expect(fs.readdirSync(path.join(h.root, "skills/demo"))).toEqual([]);
    });

    it("retains the original journal when actual recovery encounters a physical delete failure", async () => {
        const fixture = await prepare();
        connectGraph(h);
        const txnId = retainCommitNoJournal(h, fixture);
        const original = readJournal(h.txnRoot, txnId);
        const before = fs.readFileSync(path.join(h.root, "skills/demo/SKILL.md"));
        vi.spyOn(targetIo, "ioDelete").mockImplementation(() => {
            throw new Error("physical delete failure");
        });
        expect(recoverDeployment(h.db, h.txnRoot, txnId, selectedWslTargetTransactions(connectGraph(h).execution))).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_unavailable",
            journalResolved: false,
        });
        expect(readJournal(h.txnRoot, txnId)).toEqual(original);
        expect(fs.readFileSync(path.join(h.root, "skills/demo/SKILL.md"))).toEqual(before);
    });

    it("commits a complete graph with an inaccessible Host target spelling while State and directory receipts stay in Core", async () => {
        const fixture = await prepare();
        const connection = connectGraph(h);
        const hostRead = vi.fn(() => {
            throw new Error("Host target read must not run for the complete graph");
        });
        const result = executeDeploymentForTest(
            h.opts,
            fixture.compiled.targetPlan,
            fixture.compiled.executionAuthority,
            {
                populateOldBytes: hostRead,
                preflightExecutableTransitions: hostRead,
                casWriteAll: hostRead,
                verifyAll: hostRead,
            },
            fixture.reviewed.runtimeReplacementAuthority,
        );
        expect(result.outcome).toBe("committed");
        expect(hostRead).not.toHaveBeenCalled();
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe(result.transactionId);
        expect(readJournal(h.txnRoot, result.transactionId)).toBeNull();
        expect(fs.readFileSync(path.join(h.root, "skills/demo/SKILL.md"), "utf8")).not.toBe("");
        expect(fs.readdirSync(path.join(h.root, "skills/demo/empty"))).toEqual([]);
        expect(connection.requests.map((request) => request.operation.kind)).toEqual([
            "prepare_graph",
            "execute_graph",
            "continue_graph",
            "continue_graph",
        ]);
    });

    it("reopens the original uncommitted v3 journal and restores the old graph through a fresh execution owner", async () => {
        const fixture = await prepare();
        connectGraph(h);
        const txnId = retainCommitNoJournal(h, fixture);
        const original = readJournal(h.txnRoot, txnId);
        expect(original?.schemaVersion).toBe(3);
        if (original?.schemaVersion !== 3) throw new Error("expected a v3 journal");
        expect(original.targetExecution.targetRootPath).toBe(getDeployment(h.db, D1)!.targetRootPath);
        expect(original.targetExecution.executionRootPath).toBe(h.root);
        expect(original.directoryEntries.every((entry) => entry.createdIdentity !== null)).toBe(true);
        const reopened = connectGraph(h);
        expect(recoverDeployment(h.db, h.txnRoot, txnId, selectedWslTargetTransactions(reopened.execution))).toEqual({
            outcome: "recovered_to_old",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.readdirSync(path.join(h.root, "skills"))).toEqual([]);
        expect(readJournal(h.txnRoot, txnId)).toBeNull();
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe("");
    });

    it("uses Core's committed transaction direction to verify and resolve a retained v3 journal", async () => {
        const fixture = await prepare();
        connectGraph(h);
        const txnId = retainCommitYesJournal(h, fixture);
        const before = fs.readFileSync(path.join(h.root, "skills/demo/SKILL.md"));
        expect(readJournal(h.txnRoot, txnId)?.schemaVersion).toBe(3);
        const reopened = connectGraph(h);
        expect(recoverDeployment(h.db, h.txnRoot, txnId, selectedWslTargetTransactions(reopened.execution))).toEqual({
            outcome: "recovered_to_new",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.readFileSync(path.join(h.root, "skills/demo/SKILL.md"))).toEqual(before);
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe(txnId);
        expect(readJournal(h.txnRoot, txnId)).toBeNull();
    });

    it("retains an unreceipted created directory when the first execution response is lost", async () => {
        const fixture = await prepare();
        connectGraph(h, {
            after(response) {
                if (response.result.kind === "execute_graph" && response.result.step.kind === "directory_receipt_required")
                    throw new Error("injected lost creation response");
            },
        });
        const result = executeDeploymentForTest(
            h.opts,
            fixture.compiled.targetPlan,
            fixture.compiled.executionAuthority,
            {},
            fixture.reviewed.runtimeReplacementAuthority,
        );
        expect(result.outcome).toBe("blocked");
        const [txnId] = scanJournals(h.txnRoot, D1).matchingTxnIds;
        if (txnId === undefined) throw new Error("missing unresolved journal");
        const original = readJournal(h.txnRoot, txnId);
        expect(original?.schemaVersion).toBe(3);
        const reopened = connectGraph(h);
        expect(recoverDeployment(h.db, h.txnRoot, txnId, selectedWslTargetTransactions(reopened.execution))).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_changed",
            journalResolved: false,
        });
        expect(readJournal(h.txnRoot, txnId)).toEqual(original);
        expect(fs.readdirSync(path.join(h.root, "skills/demo"))).toEqual([]);
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe("");
    });

    it("recovers the durable directory receipt when its continuation never reaches the previous service", async () => {
        const fixture = await prepare();
        connectGraph(h, {
            before(request) {
                if (request.operation.kind === "continue_graph") throw new Error("injected continuation delivery loss");
            },
        });
        expect(
            executeDeploymentForTest(
                h.opts,
                fixture.compiled.targetPlan,
                fixture.compiled.executionAuthority,
                {},
                fixture.reviewed.runtimeReplacementAuthority,
            ).outcome,
        ).toBe("blocked");
        const [txnId] = scanJournals(h.txnRoot, D1).matchingTxnIds;
        if (txnId === undefined) throw new Error("missing unresolved journal");
        const journal = readJournal(h.txnRoot, txnId);
        if (journal?.schemaVersion !== 3) throw new Error("expected a v3 journal");
        expect(journal.directoryEntries[0]!.createdIdentity).not.toBeNull();
        expect(journal.directoryEntries[1]!.createdIdentity).toBeNull();
        const reopened = connectGraph(h);
        expect(recoverDeployment(h.db, h.txnRoot, txnId, selectedWslTargetTransactions(reopened.execution))).toEqual({
            outcome: "recovered_to_old",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.readdirSync(path.join(h.root, "skills"))).toEqual([]);
    });
});
