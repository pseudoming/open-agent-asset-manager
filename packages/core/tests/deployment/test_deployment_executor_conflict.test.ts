/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeDeploymentForTest as executeDeploymentForTestStrict } from "../../src/deployment/deployment-executor";
import { insertDeployment, upsertDeploymentAsset, getDeployment } from "../../src/persistence/state-db";
import { publishJournal, scanJournals } from "../../src/deployment/deployment-journal";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import * as targetIo from "../../src/deployment/deployment-target-io";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";
import { acquireAllLocks, computeDeploymentOperationKey, computePhysicalKeys } from "../../src/foundation/physical-path-locks";
import {
    D1,
    D2,
    A1,
    V1,
    sha,
    deployRow,
    type H,
    harness,
    executeDeployment,
    seedRealBaseline,
    textPlan,
    writeFile,
    readFile,
    exists,
} from "./fixtures/deployment-executor-test-fixtures";

describe("executeDeployment — freeze gate (unresolved journal)", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("blocks when a matching unresolved journal exists", () => {
        // publish a journal manually to simulate an unresolved tx
        const txnId = "dead0000-0000-4000-8000-00000000dead";
        publishJournal(h.txnRoot, {
            schemaVersion: 1,
            transactionId: txnId,
            deploymentId: D1,
            createdAt: 1,
            entries: [],
            compilationFingerprint: sha("freeze-fixture"),
            reservedPhysicalKeys: [],
        });
        const r = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
    });

    it("blocks when a corrupt journal dir exists", () => {
        const corruptTxn = "beef0000-0000-4000-8000-00000000beef";
        fs.mkdirSync(path.join(h.txnRoot, corruptTxn), { recursive: true });
        fs.writeFileSync(path.join(h.txnRoot, corruptTxn, "journal.json"), "garbage");
        const r = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
    });
});

describe("executeDeployment — double occupancy", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("blocks when another active deployment owns the target path", () => {
        insertDeployment(h.db, deployRow(D2, h.root)); // same root
        seedRealBaseline(h, D2, "shared.md", "# other");

        const r = executeDeployment(h.opts, textPlan("shared.md", "# mine"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_deploy_target_locked");
        // no write happened
        expect(exists(h.root, "shared.md")).toBe(false);
    });
});

describe("executeDeployment — conflict (third_value)", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("runtime hand-edited → conflict, runtime untouched, journal resolved", () => {
        // baseline says file should be "# v1" but runtime has hand-edit
        seedRealBaseline(h, D1, "a.md", "# v1");
        writeFile(h.root, "a.md", "# hand-edit");

        const r = executeDeployment(h.opts, textPlan("a.md", "# v2"));
        expect(r.outcome).toBe("conflict");
        // runtime untouched (hand-edit preserved)
        expect(readFile(h.root, "a.md")).toBe("# hand-edit");
        // baseline not advanced
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe("");
    });

    it("normal conflict where journal resolves cleanly → outcome=conflict", () => {
        seedRealBaseline(h, D1, "a.md", "# base");
        writeFile(h.root, "a.md", "# base");
        writeFile(h.root, "a.md", "# hand"); // diverge from baseline
        const r = executeDeployment(h.opts, textPlan("a.md", "# v2"));
        expect(r.outcome).toBe("conflict");
    });

    it("rolls back only earlier CAS writes and preserves the later third-value file", () => {
        seedRealBaseline(h, D1, "a.md", "# old-a");
        seedRealBaseline(h, D1, "b.md", "# old-b");
        writeFile(h.root, "a.md", "# old-a");
        writeFile(h.root, "b.md", "# user-edit-b");
        const plan: TargetPlan = {
            schemaVersion: 1,
            managedDirectoryBoundaries: [],
            targetFiles: [
                {
                    relativePath: "a.md",
                    content: { contentKind: "text", text: "# new-a" },
                    executable: false,
                    renderedSectionIds: [],
                },
                {
                    relativePath: "b.md",
                    content: { contentKind: "text", text: "# new-b" },
                    executable: false,
                    renderedSectionIds: [],
                },
            ],
        };
        const result = executeDeployment(h.opts, plan);
        expect(result.outcome).toBe("conflict");
        expect(readFile(h.root, "a.md")).toBe("# old-a");
        expect(readFile(h.root, "b.md")).toBe("# user-edit-b");
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    });

    it("does not resurrect an already-missing removal when a later removal conflicts", () => {
        seedRealBaseline(h, D1, "a.md", "# old-a");
        seedRealBaseline(h, D1, "b.md", "# old-b");
        // a.md was already absent before this deploy; b.md is a user third
        // value. Removal a is a successful no-op, not a mutation to rollback.
        writeFile(h.root, "b.md", "# user-edit-b");
        const emptyPlan: TargetPlan = { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] };
        const result = executeDeployment(h.opts, emptyPlan);
        expect(result.outcome).toBe("conflict");
        expect(exists(h.root, "a.md")).toBe(false);
        expect(readFile(h.root, "b.md")).toBe("# user-edit-b");
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    });

    it("retains the real journal when an earlier successful write changes before conflict rollback", () => {
        for (const name of ["a.md", "b.md"]) {
            seedRealBaseline(h, D1, name, "# old");
            writeFile(h.root, name, "# old");
        }
        const plan: TargetPlan = {
            schemaVersion: 1,
            managedDirectoryBoundaries: [],
            targetFiles: [...textPlan("a.md", "# new-a").targetFiles, ...textPlan("b.md", "# new-b").targetFiles],
        };
        const originalWrite = targetIo.ioWrite;
        const write = vi.spyOn(targetIo, "ioWrite").mockImplementationOnce((...args) => {
            originalWrite(...args);
            expect(readFile(h.root, "a.md")).toBe("# new-a");
            writeFile(h.root, "a.md", "# external after first write");
            writeFile(h.root, "b.md", "# external before second CAS");
        });
        try {
            const result = executeDeployment(h.opts, plan);
            expect(write).toHaveBeenCalledOnce();
            expect(result.outcome).toBe("blocked");
            expect(result.reasonCode).toBe("blocked_by_deploy_target_unavailable");
            expect(readFile(h.root, "a.md")).toBe("# external after first write");
            expect(readFile(h.root, "b.md")).toBe("# external before second CAS");
            expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
        } finally {
            write.mockRestore();
        }
    });
});

describe("executeDeployment — lock failure", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("pre-held lock for target path → blocked_by_deploy_target_locked", () => {
        const key = computePhysicalKeys("linux", h.root, ["a.md"])[0] as string;
        const held = acquireAllLocks(h.txnRoot, [key]);
        expect(held).not.toBeNull();
        try {
            const r = executeDeployment(h.opts, textPlan("a.md", "# x"));
            expect(r.outcome).toBe("blocked");
            expect(r.reasonCode).toBe("blocked_by_deploy_target_locked");
        } finally {
            held?.release();
        }
    });

    it("pre-held immediate-parent lock blocks a new child write", () => {
        const key = computePhysicalKeys("linux", h.root, ["nested"])[0] as string;
        const held = acquireAllLocks(h.txnRoot, [key]);
        expect(held).not.toBeNull();
        try {
            const r = executeDeployment(h.opts, textPlan("nested/a.md", "# x"));
            expect(r).toEqual(expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_by_deploy_target_locked" }));
            expect(fs.existsSync(path.join(h.root, "nested", "a.md"))).toBe(false);
        } finally {
            held?.release();
        }
    });

    it("pre-held Deployment operation lock blocks before state or runtime mutation", () => {
        const before = getDeployment(h.db, D1);
        const operationLock = acquireAllLocks(h.txnRoot, [computeDeploymentOperationKey(D1)]);
        if (operationLock === null) throw new Error("fixture operation lock unavailable");
        try {
            expect(executeDeployment(h.opts, textPlan("a.md", "# x"))).toEqual(
                expect.objectContaining({
                    outcome: "blocked",
                    reasonCode: "blocked_by_deploy_target_locked",
                }),
            );
            expect(fs.readdirSync(h.root)).toEqual([]);
            expect(getDeployment(h.db, D1)).toEqual(before);
        } finally {
            operationLock.release();
        }
    });

    it("maps an unavailable Deployment operation-lock directory without mutating state", () => {
        const before = getDeployment(h.db, D1);
        fs.writeFileSync(path.join(h.txnRoot, "locks"), "not-a-directory");
        expect(executeDeployment(h.opts, textPlan("a.md", "# x"))).toEqual(
            expect.objectContaining({
                outcome: "blocked",
                reasonCode: "blocked_by_deploy_target_unavailable",
            }),
        );
        expect(fs.readdirSync(h.root)).toEqual([]);
        expect(getDeployment(h.db, D1)).toEqual(before);
    });

    it("a foreign unresolved journal keeps its physical reservation after locks release", () => {
        insertDeployment(h.db, deployRow(D2, h.root));
        upsertDeploymentAsset(h.db, D2, A1, V1, 1, 0, 5000);
        const plan = textPlan("a.md", "# foreign");
        const failed = executeDeploymentForTestStrict(
            { ...h.opts, deploymentId: D2 },
            plan,
            makeExecutionAuthority(plan, { deploymentId: D2 }),
            {
                casWriteAll: () => ({
                    ok: false,
                    stop: { kind: "write_failed", relativePath: "a.md" },
                    mutated: [],
                }),
            },
        );
        expect(failed.outcome).toBe("blocked");
        expect(scanJournals(h.txnRoot, D2).matchingTxnIds).toHaveLength(1);

        const local = executeDeployment(h.opts, textPlan("a.md", "# local"));
        expect(local).toEqual(
            expect.objectContaining({
                outcome: "blocked",
                reasonCode: "blocked_by_deploy_target_locked",
            }),
        );
        expect(fs.existsSync(path.join(h.root, "a.md"))).toBe(false);
    });
});
