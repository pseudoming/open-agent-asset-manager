import { localTargetTransactions } from "../../src/deployment/local-target-transaction";
/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import {
    executeDeployment as executeCompiledDeployment,
    executeDeploymentForTest as executeDeploymentForTestStrict,
} from "../../src/deployment/deployment-executor";
import {
    softDeleteDeploymentAsset,
    upsertDeploymentAsset,
    updateDeployment,
    getDeployment,
    getDeploymentFile,
} from "../../src/persistence/state-db";
import { scanJournals } from "../../src/deployment/deployment-journal";
import { parseDeploymentFileBaselineState } from "../../src/render/deployment-render-authority";
import { finalizeTargetFileRenderProvenance } from "../../src/render/deployment-render-authority";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";
import {
    computeAppliedRenderSnapshotFingerprint,
    computeRenderOutputUnitFingerprint,
    computeSemanticRefFingerprint,
} from "../../src/foundation/fingerprint";
import { recoverDeployment } from "../../src/deployment/deployment-recovery";
import { readDeploymentPayload } from "../../src/deployment/deployment-payload-store";
import { makeCompiledLifecycleFixture } from "../render/fixtures/render-lifecycle-fixtures";
import { openValidatedCompiledDeploymentPlan, type ValidatedCompiledDeploymentPlan } from "../../src/render/render-compiler";
import { acquireAllLocks, computePhysicalKeys } from "../../src/foundation/physical-path-locks";
import { loadDeploymentBaseline } from "../../src/deployment/deployment-state-ops";
import { captureDeploymentPreWritePreview } from "../../src/deployment/deployment-prewrite-preview";
import {
    D1,
    D2,
    A1,
    V1,
    sha,
    type H,
    harness,
    executeDeployment,
    executeRawStrict,
    executeDeploymentForTest,
    seedRealBaseline,
    textPlan,
    writeFile,
    readFile,
    exists,
} from "./fixtures/deployment-executor-test-fixtures";

describe("executeDeployment — fault injection via test seam", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("blocks when the locked journal-reservation rescan throws or reports corruption", () => {
        const throwing = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            scanActiveJournalReservations: () => {
                throw new Error("reservation scan EIO");
            },
        });
        expect(throwing.reasonCode).toBe("blocked_by_recovery_state_unavailable");
        expect(fs.existsSync(path.join(h.root, "a.md"))).toBe(false);

        const corrupt = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            scanActiveJournalReservations: () => ({
                journals: [],
                corruptTxnIds: ["11111111-1111-4111-8111-111111111111"],
            }),
        });
        expect(corrupt.reasonCode).toBe("blocked_by_recovery_state_unavailable");
        expect(fs.existsSync(path.join(h.root, "a.md"))).toBe(false);
    });

    it("populateOldBytes read_failed → blocked_by_deploy_target_unavailable", () => {
        const r = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            populateOldBytes: () => ({ kind: "read_failed", relativePath: "a.md" }),
        });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_deploy_target_unavailable");
        // The deploy failure is recorded as blocking evidence, not as a target-observation attempt.
        const dep = getDeployment(h.db, D1)!;
        expect(dep.observationState).toBe("never");
        expect(dep.observationAttemptedAt).toBe(0);
        expect(dep.lastCompleteObservationAt).toBe(0);
        expect(dep.blockingEvidence).toContain("blocked_by_deploy_target_unavailable");
    });

    it("executable preflight failure blocks before journal publication and target CAS", () => {
        let casCalls = 0;
        const r = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            preflightExecutableTransitions: () => "a.md",
            casWriteAll: () => {
                casCalls += 1;
                return { ok: true, written: ["a.md"], mutated: ["a.md"], stop: null };
            },
        });

        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_needs_support");
        expect(casCalls).toBe(0);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
        expect(fs.existsSync(path.join(h.root, "a.md"))).toBe(false);
    });

    it("casWriteAll write_failed → blocked, journal belongs to this deployment + unresolved", () => {
        const r = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            casWriteAll: () => ({
                ok: false,
                written: [],
                mutated: [],
                stop: { kind: "write_failed", relativePath: "a.md" },
            }),
        });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_deploy_target_unavailable");
        // journal is unresolved AND belongs to this deployment (not just "some dir exists")
        const scan = scanJournals(h.txnRoot, D1);
        expect(scan.matchingTxnIds.length).toBe(1);
    });

    it("verifyAll !ok → blocked_by_deploy_verification_failed with diagnostics", () => {
        const failDiag = {
            severity: "error" as const,
            code: "deploy_verification_failed",
            message: "hash mismatch on a.md",
            operation: "deploy" as const,
            causeKind: "verification_failed" as const,
            path: "a.md",
            traceId: "",
            retryable: false,
            suggestedActions: [],
            rawSummary: "",
        };
        const r = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            verifyAll: () => ({ ok: false, verified: [], failures: [failDiag] }),
        });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_deploy_verification_failed");
        expect(r.diagnostics.length).toBe(1);
        expect(r.diagnostics[0].message).toContain("hash mismatch");
    });

    it("verify module claiming an uncompiled path throws and leaves the journal unresolved", () => {
        const ghostHash = sha("ghost");
        expect(() =>
            executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
                verifyAll: () => ({
                    ok: true,
                    failures: [],
                    verified: [
                        {
                            relativePath: "ghost.md",
                            appliedContentHash: ghostHash,
                            appliedExecutable: false,
                            observedState: "present",
                            observedContentHash: ghostHash,
                            observedExecutable: false,
                        },
                    ],
                }),
            }),
        ).toThrow(/exact compiled target path set/);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
    });

    it("verify module omitting a compiled path throws and leaves the journal unresolved", () => {
        expect(() =>
            executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
                verifyAll: () => ({ ok: true, failures: [], verified: [] }),
            }),
        ).toThrow(/exact compiled target path set/);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe("");
    });

    it("payload publication failure preserves the old DB baseline and recovery restores old runtime bytes", () => {
        seedRealBaseline(h, D1, "a.md", "# old");
        writeFile(h.root, "a.md", "# old");
        const before = getDeployment(h.db, D1)!;
        expect(() =>
            executeDeploymentForTest(h.opts, textPlan("a.md", "# new"), {
                publishDeploymentPayloads: () => {
                    throw new Error("payload publish EIO");
                },
            }),
        ).toThrow(/payload publish EIO/);
        expect(readFile(h.root, "a.md")).toBe("# new");
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe(before.committedTransactionId);
        expect(parseDeploymentFileBaselineState(getDeploymentFile(h.db, D1, "a.md")!.baselineState)).toMatchObject({
            rowState: "active",
            appliedPayload: { contentHash: sha("# old") },
        });
        const transactionId = scanJournals(h.txnRoot, D1).matchingTxnIds[0]!;
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions).outcome).toBe("recovered_to_old");
        expect(readFile(h.root, "a.md")).toBe("# old");
    });

    it("DB transaction failure leaves only an unreferenced payload and recovery restores old runtime bytes", () => {
        seedRealBaseline(h, D1, "a.md", "# old");
        writeFile(h.root, "a.md", "# old");
        const before = getDeployment(h.db, D1)!;
        const faultingDb = {
            exec: h.db.exec.bind(h.db),
            prepare: h.db.prepare.bind(h.db),
            pragma: h.db.pragma.bind(h.db),
            transaction: () => () => {
                throw new Error("DB commit boundary EIO");
            },
        } as unknown as Database.Database;
        expect(() => executeDeploymentForTest({ ...h.opts, db: faultingDb }, textPlan("a.md", "# new"), {})).toThrow(
            /DB commit boundary EIO/,
        );
        expect(getDeployment(h.db, D1)).toEqual(before);
        expect(
            Buffer.from(
                readDeploymentPayload({
                    deploymentsRoot: h.deploymentsRoot,
                    deploymentId: D1,
                    contentHash: sha("# new") as `sha256:${string}`,
                    expectedByteSize: Buffer.byteLength("# new"),
                }),
            ).toString(),
        ).toBe("# new");
        const transactionId = scanJournals(h.txnRoot, D1).matchingTxnIds[0]!;
        expect(recoverDeployment(h.db, h.txnRoot, transactionId, localTargetTransactions).outcome).toBe("recovered_to_old");
        expect(readFile(h.root, "a.md")).toBe("# old");
    });

    it("conflict third_value + deleteJournal throws → blocked, journal reservation persists (discoverable)", () => {
        const r = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            casWriteAll: () => ({
                ok: false,
                written: [],
                mutated: [],
                stop: { kind: "third_value", relativePath: "a.md" },
            }),
            deleteJournal: () => {
                throw new Error("marker stuck");
            },
        });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_deploy_target_unavailable");
        // journal marker/reservation still discoverable for this deployment
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds.length).toBe(1);
    });

    it("conflict third_value + deleteJournal succeeds → conflict (journal resolved)", () => {
        const r = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            casWriteAll: () => ({
                ok: false,
                written: [],
                mutated: [],
                stop: { kind: "third_value", relativePath: "a.md" },
            }),
            deleteJournal: () => {
                /* success */
            },
        });
        expect(r.outcome).toBe("conflict");
    });

    it("conflict rollback verification failure → blocked and journal remains recoverable", () => {
        const r = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            casWriteAll: () => ({
                ok: false,
                written: ["a.md"],
                mutated: ["a.md"],
                stop: { kind: "third_value", relativePath: "later.md" },
            }),
            rollbackToOld: () => ({ ok: false, failedRelativePaths: ["a.md"] }),
        });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_deploy_target_unavailable");
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
    });

    it("success commit + deleteJournal throws → committed with warning, journal reservation persists", () => {
        const r = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            deleteJournal: () => {
                throw new Error("marker stuck");
            },
        });
        expect(r.outcome).toBe("committed");
        expect(r.transactionId).not.toBe("");
        expect(r.diagnostics.length).toBe(1);
        expect(r.diagnostics[0].code).toBe("journal_marker_stuck");
        expect(r.diagnostics[0].severity).toBe("warning");
        // success baseline committed
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe(r.transactionId);
        // journal marker still discoverable (reservation persists despite committed success)
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds.length).toBe(1);
    });
});

describe("executeDeploymentForTest — strict raw authority validator", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    function expectAuthorityBlocked(plan: TargetPlan, mutate: (authority: ReturnType<typeof makeExecutionAuthority>) => void) {
        const authority = makeExecutionAuthority(plan);
        mutate(authority);
        const result = executeRawStrict(h.opts, plan, authority);
        expect(result.outcome).toBe("blocked");
        expect(result.reasonCode).toBe("blocked_needs_support");
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    }

    it("blocks a compile-time AppliedInputs snapshot that no longer matches current Deployment intent", () => {
        const plan = textPlan("a.md", "# x");
        const authority = makeExecutionAuthority(plan, { assets: [] });
        const result = executeRawStrict(h.opts, plan, authority);
        expect(result.outcome).toBe("blocked");
        expect(result.reasonCode).toBe("blocked_needs_support");
        expect(result.diagnostics[0]?.message).toContain("stale Deployment execution inputs");
        expect(exists(h.root, "a.md")).toBe(false);
        expect(scanJournals(h.txnRoot, D1)).toEqual({ matchingTxnIds: [], corruptTxnIds: [] });
    });

    function refinalize(
        authority: ReturnType<typeof makeExecutionAuthority>,
        changes: Partial<
            Omit<ReturnType<typeof makeExecutionAuthority>["targetFileProvenance"][number]["provenance"], "provenanceFingerprint">
        >,
    ): void {
        const current = authority.targetFileProvenance[0]!.provenance;
        const { provenanceFingerprint: _stored, ...preimage } = current;
        authority.targetFileProvenance[0]!.provenance = finalizeTargetFileRenderProvenance({
            ...preimage,
            ...changes,
        });
    }

    it("rejects missing path coverage and non-canonical provenance ordering", () => {
        expectAuthorityBlocked(textPlan("a.md", "a"), (authority) => {
            authority.targetFileProvenance = [];
        });
        const plan: TargetPlan = {
            schemaVersion: 1,
            managedDirectoryBoundaries: [],
            targetFiles: [textPlan("a.md", "a").targetFiles[0]!, textPlan("b.md", "b").targetFiles[0]!],
        };
        expectAuthorityBlocked(plan, (authority) => {
            authority.targetFileProvenance.reverse();
        });
        expectAuthorityBlocked(plan, (authority) => {
            authority.targetFileProvenance[1]!.relativePath = authority.targetFileProvenance[0]!.relativePath;
        });
        expect(executeRawStrict(h.opts, plan, makeExecutionAuthority(plan)).outcome).toBe("committed");
    });

    it("rejects provenance bound to another snapshot, output unit, semantic, or section handle", () => {
        const plan = textPlan("a.md", "a");
        expectAuthorityBlocked(plan, (authority) =>
            refinalize(authority, {
                appliedRenderSnapshotFingerprint: `sha256:${"c".repeat(64)}`,
            }),
        );
        expectAuthorityBlocked(plan, (authority) =>
            refinalize(authority, {
                outputUnitFingerprint: `sha256:${"d".repeat(64)}`,
            }),
        );
        expectAuthorityBlocked(plan, (authority) =>
            refinalize(authority, {
                semanticRefFingerprints: [`sha256:${"e".repeat(64)}`],
            }),
        );
        expectAuthorityBlocked(plan, (authority) =>
            refinalize(authority, {
                sectionBindings: [{ sectionHandle: "unexpected", semanticRefFingerprints: [] }],
            }),
        );
    });

    it("rejects missing, mismatched, or duplicate render output claims", () => {
        const twoFilePlan: TargetPlan = {
            schemaVersion: 1,
            managedDirectoryBoundaries: [],
            targetFiles: [
                {
                    relativePath: "a.md",
                    content: { contentKind: "text", text: "a" },
                    executable: false,
                    renderedSectionIds: [],
                },
                {
                    relativePath: "b.md",
                    content: { contentKind: "text", text: "b" },
                    executable: false,
                    renderedSectionIds: [],
                },
            ],
        };
        const oneFilePlan = textPlan("a.md", "a");
        const extraClaim = makeExecutionAuthority(twoFilePlan);
        extraClaim.targetFileProvenance = extraClaim.targetFileProvenance.filter((item) => item.relativePath === "a.md");
        expect(executeRawStrict(h.opts, oneFilePlan, extraClaim).outcome).toBe("blocked");

        const wrongUnit = makeExecutionAuthority(twoFilePlan);
        const bUnit = wrongUnit.targetFileProvenance.find((item) => item.relativePath === "b.md")!.provenance
            .outputUnitFingerprint;
        const aItem = wrongUnit.targetFileProvenance.find((item) => item.relativePath === "a.md")!;
        const { provenanceFingerprint: _aStored, ...aPreimage } = aItem.provenance;
        aItem.provenance = finalizeTargetFileRenderProvenance({
            ...aPreimage,
            outputUnitFingerprint: bUnit,
        });
        expect(executeRawStrict(h.opts, twoFilePlan, wrongUnit).outcome).toBe("blocked");

        const textAuthority = makeExecutionAuthority(oneFilePlan);
        const binaryPlan: TargetPlan = {
            schemaVersion: 1,
            managedDirectoryBoundaries: [],
            targetFiles: [
                {
                    relativePath: "a.md",
                    content: { contentKind: "binary", bytes: new Uint8Array(Buffer.from("a")) },
                    executable: false,
                    renderedSectionIds: [],
                },
            ],
        };
        expect(executeRawStrict(h.opts, binaryPlan, textAuthority).outcome).toBe("blocked");
        const executablePlan: TargetPlan = {
            ...oneFilePlan,
            targetFiles: [{ ...oneFilePlan.targetFiles[0]!, executable: true }],
        };
        expect(executeRawStrict(h.opts, executablePlan, textAuthority).outcome).toBe("blocked");

        const duplicateClaim = makeExecutionAuthority(twoFilePlan);
        const oldUnit = duplicateClaim.appliedRenderSnapshot.outputUnits.find((unit) => unit.claims[0]?.relativePath === "b.md")!;
        const { outputUnitFingerprint: oldUnitFingerprint, ...unitPreimage } = oldUnit;
        const newUnit = {
            ...unitPreimage,
            outputContractId: "p6-test-duplicate-claim-v1",
            claims: [{ ...oldUnit.claims[0]!, relativePath: "a.md" }],
        };
        const newUnitFingerprint = computeRenderOutputUnitFingerprint(newUnit);
        const oldUnitIndex = duplicateClaim.appliedRenderSnapshot.outputUnits.indexOf(oldUnit);
        duplicateClaim.appliedRenderSnapshot.outputUnits[oldUnitIndex] = {
            ...newUnit,
            outputUnitFingerprint: newUnitFingerprint,
        };
        for (const renderer of duplicateClaim.appliedRenderSnapshot.outputUnitRenderers) {
            if (renderer.outputUnitFingerprint === oldUnitFingerprint) {
                renderer.outputUnitFingerprint = newUnitFingerprint;
            }
        }
        for (const proof of duplicateClaim.appliedRenderSnapshot.semanticCoverageProofs) {
            if (proof.outputUnitFingerprint === oldUnitFingerprint) {
                proof.outputUnitFingerprint = newUnitFingerprint;
            }
        }
        duplicateClaim.appliedRenderSnapshot.outputUnits.sort((a, b) =>
            a.outputUnitFingerprint.localeCompare(b.outputUnitFingerprint),
        );
        duplicateClaim.appliedRenderSnapshot.outputUnitRenderers.sort((a, b) =>
            a.outputUnitFingerprint.localeCompare(b.outputUnitFingerprint),
        );
        duplicateClaim.appliedRenderSnapshot.semanticCoverageProofs.sort((a, b) =>
            a.outputUnitFingerprint.localeCompare(b.outputUnitFingerprint),
        );
        const newSnapshotFingerprint = computeAppliedRenderSnapshotFingerprint(duplicateClaim.appliedRenderSnapshot);
        for (const item of duplicateClaim.targetFileProvenance) {
            const { provenanceFingerprint: _stored, ...preimage } = item.provenance;
            item.provenance = finalizeTargetFileRenderProvenance({
                ...preimage,
                appliedRenderSnapshotFingerprint: newSnapshotFingerprint,
                outputUnitFingerprint:
                    preimage.outputUnitFingerprint === oldUnitFingerprint ? newUnitFingerprint : preimage.outputUnitFingerprint,
            });
        }
        expect(executeRawStrict(h.opts, twoFilePlan, duplicateClaim).outcome).toBe("blocked");
    });

    it("accepts a non-empty semantic decision closure", () => {
        const plan = textPlan("a.md", "a");
        const authority = makeExecutionAuthority(plan);
        const semanticPreimage = {
            consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
            subject: { subjectKind: "asset" as const, assetId: A1, versionId: V1 },
            semanticKind: "guidance.content" as const,
        };
        const semanticRef = {
            ...semanticPreimage,
            semanticRefFingerprint: computeSemanticRefFingerprint(semanticPreimage),
        };
        const unitFingerprint = authority.appliedRenderSnapshot.outputUnits[0]!.outputUnitFingerprint;
        authority.appliedRenderSnapshot.decisions = [
            {
                semanticRef,
                consumerOwnerAdapterId: "claudecode",
                consumerOwnerAdapterVersion: "p6-test",
                optionFingerprint: `sha256:${"a".repeat(64)}`,
                renderStrategy: "native_file",
                approval: { approvalState: "not_required" },
                actualReverseExtractPolicy: "can_reconcile",
                outputUnitFingerprints: [unitFingerprint],
                outcome: "preserved",
            },
        ];
        const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(authority.appliedRenderSnapshot);
        refinalize(authority, {
            appliedRenderSnapshotFingerprint: snapshotFingerprint,
            semanticRefFingerprints: [semanticRef.semanticRefFingerprint],
        });
        plan.targetFiles[0]!.semanticRefFingerprints = [semanticRef.semanticRefFingerprint];
        expect(executeRawStrict(h.opts, plan, authority).outcome).toBe("committed");
    });
});

describe("executeDeployment — opaque compiled-plan production handoff", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("rejects forged/foreign tokens before I/O and commits one genuine compiled lifecycle", async () => {
        expect(() => executeCompiledDeployment(h.opts, {} as ValidatedCompiledDeploymentPlan)).toThrow(
            /forged or belongs to another process/,
        );
        expect(fs.readdirSync(h.root)).toEqual([]);

        const renderFixtureRoot = path.join(h.deploymentsRoot, "render-fixture");
        fs.mkdirSync(renderFixtureRoot, { recursive: true });
        const fixture = await makeCompiledLifecycleFixture(renderFixtureRoot, {
            deploymentOverrides: {
                deploymentId: D1,
                targetRootPath: h.root,
            },
        });
        const foreign = executeCompiledDeployment({ ...h.opts, deploymentId: D2 }, fixture.compiledToken);
        expect(foreign).toEqual(expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_needs_support" }));
        expect(fs.readdirSync(h.root)).toEqual([]);

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
        const committed = executeCompiledDeployment(h.opts, fixture.compiledToken);
        expect(committed.outcome).toBe("committed");
        expect(readFile(h.root, "AGENTS.md")).toBe("# materialized\n");
    });

    it("locks managed directory boundaries for writes and later removals", async () => {
        const renderFixtureRoot = path.join(h.deploymentsRoot, "boundary-render-fixture");
        fs.mkdirSync(renderFixtureRoot, { recursive: true });
        const fixture = await makeCompiledLifecycleFixture(renderFixtureRoot, {
            analysisResultOptions: {
                relativePath: "skills/demo/SKILL.md",
                managedDirectoryBoundary: "skills/demo",
            },
            deploymentOverrides: { deploymentId: D1, targetRootPath: h.root },
        });
        const compiled = openValidatedCompiledDeploymentPlan(fixture.compiledToken);
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
        fs.mkdirSync(path.join(h.root, "skills"));
        expect(executeDeploymentForTestStrict(h.opts, compiled.targetPlan, compiled.executionAuthority, {})).toEqual(
            expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_needs_support" }),
        );
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
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

        const boundaryKey = computePhysicalKeys("linux", h.root, ["skills/demo"])[0] as string;
        let boundaryLock = acquireAllLocks(h.txnRoot, [boundaryKey]);
        expect(boundaryLock).not.toBeNull();
        try {
            expect(
                executeDeploymentForTestStrict(
                    h.opts,
                    compiled.targetPlan,
                    compiled.executionAuthority,
                    {},
                    reviewed.runtimeReplacementAuthority,
                ),
            ).toEqual(
                expect.objectContaining({
                    outcome: "blocked",
                    reasonCode: "blocked_by_deploy_target_locked",
                }),
            );
            expect(fs.existsSync(path.join(h.root, "skills", "demo", "SKILL.md"))).toBe(false);

            boundaryLock?.release();
            const boundaryResult = executeDeploymentForTestStrict(
                h.opts,
                compiled.targetPlan,
                compiled.executionAuthority,
                {},
                reviewed.runtimeReplacementAuthority,
            );
            expect(boundaryResult).toEqual(expect.objectContaining({ outcome: "committed" }));
            expect(loadDeploymentBaseline(h.db, D1)[0]?.managedDirectoryBoundaryPaths).toEqual(["skills/demo"]);

            boundaryLock = acquireAllLocks(h.txnRoot, [boundaryKey]);
            expect(boundaryLock).not.toBeNull();
            const emptyPlan: TargetPlan = { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] };
            const removalAuthority = makeExecutionAuthority(emptyPlan, fixture.appliedInputsSnapshot);
            const removalReview = captureDeploymentPreWritePreview({
                deploymentId: D1,
                targetRootPath: h.root,
                renderInputFingerprint: removalAuthority.appliedRenderSnapshot.renderInputFingerprint,
                selectionFingerprint: removalAuthority.appliedRenderSnapshot.selectionFingerprint,
                compilationFingerprint: removalAuthority.appliedRenderSnapshot.compilationFingerprint,
                targetPlan: emptyPlan,
                baseline: loadDeploymentBaseline(h.db, D1),
            });
            expect(executeRawStrict(h.opts, emptyPlan, removalAuthority, removalReview.runtimeReplacementAuthority)).toEqual(
                expect.objectContaining({
                    outcome: "blocked",
                    reasonCode: "blocked_by_deploy_target_locked",
                }),
            );
            expect(readFile(h.root, "skills/demo/SKILL.md")).toBe("# materialized\n");

            boundaryLock?.release();
            fs.mkdirSync(path.join(h.root, "skills/sibling"));
            fs.writeFileSync(path.join(h.root, "skills/sibling/KEEP.md"), "sibling\n");
            expect(executeRawStrict(h.opts, emptyPlan, removalAuthority, removalReview.runtimeReplacementAuthority)).toEqual(
                expect.objectContaining({ outcome: "committed" }),
            );
            expect(fs.existsSync(path.join(h.root, "skills/demo"))).toBe(false);
            expect(fs.readFileSync(path.join(h.root, "skills/sibling/KEEP.md"), "utf8")).toBe("sibling\n");
            expect(fs.statSync(path.join(h.root, "skills")).isDirectory()).toBe(true);
        } finally {
            boundaryLock?.release();
        }
    });
});

describe("executeDeployment — end-to-end freeze after failed deploy", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("first deploy succeeds → second deploy with new plan also succeeds (no stale journal)", () => {
        const r1 = executeDeployment(h.opts, textPlan("a.md", "# v1"));
        expect(r1.outcome).toBe("committed");
        const r2 = executeDeployment(h.opts, textPlan("a.md", "# v2"));
        expect(r2.outcome).toBe("committed");
        expect(readFile(h.root, "a.md")).toBe("# v2");
    });

    it("conflict deploy resolves journal → next deploy proceeds (no freeze)", () => {
        // seed baseline + runtime at baseline
        seedRealBaseline(h, D1, "a.md", "# base");
        writeFile(h.root, "a.md", "# base");

        // first deploy: runtime hand-edited → conflict → journal resolved
        writeFile(h.root, "a.md", "# hand");
        const r1 = executeDeployment(h.opts, textPlan("a.md", "# new"));
        expect(r1.outcome).toBe("conflict");

        // fix runtime back to baseline → second deploy succeeds (journal was resolved)
        writeFile(h.root, "a.md", "# base");
        const r2 = executeDeployment(h.opts, textPlan("a.md", "# new2"));
        expect(r2.outcome).toBe("committed");
        expect(readFile(h.root, "a.md")).toBe("# new2");
    });

    it("failed deploy (write_failed) leaves unresolved journal → next deploy frozen by freeze gate", () => {
        // Step 1: inject write_failed via seam → blocked + journal unresolved
        const r1 = executeDeploymentForTest(h.opts, textPlan("a.md", "# x"), {
            casWriteAll: () => ({
                ok: false,
                written: [],
                mutated: [],
                stop: { kind: "write_failed", relativePath: "a.md" },
            }),
        });
        expect(r1.outcome).toBe("blocked");

        // Step 2: prove the journal is unresolved and belongs to this deployment
        const scan = scanJournals(h.txnRoot, D1);
        expect(scan.matchingTxnIds.length).toBe(1);

        // Step 3: production executeDeployment is now frozen by the freeze gate
        const r2 = executeDeployment(h.opts, textPlan("a.md", "# retry"));
        expect(r2.outcome).toBe("blocked");
        expect(r2.reasonCode).toBe("blocked_by_recovery_state_unavailable");
    });
});
