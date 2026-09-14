/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as publicationIo from "../../src/deployment/deployment-publication-io";
import * as path from "node:path";
import { executeDeploymentForTest as executeDeploymentForTestStrict } from "../../src/deployment/deployment-executor";
import { getDeployment, getDeploymentFile } from "../../src/persistence/state-db";
import { readJournal, scanJournals } from "../../src/deployment/deployment-journal";
import { parseDeploymentFileBaselineState } from "../../src/render/deployment-render-authority";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";
import {
    D1,
    A1,
    sha,
    type H,
    harness,
    executeDeployment,
    seedRealBaseline,
    textPlan,
    writeFile,
    readFile,
    exists,
} from "./fixtures/deployment-executor-test-fixtures";

describe("executeDeployment — committed (happy path)", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("first deploy: writes target, commits baseline + txnId + observationState=complete + snapshot", () => {
        const r = executeDeployment(h.opts, textPlan("AGENTS.md", "# hello"));
        expect(r.outcome).toBe("committed");
        expect(r.transactionId).not.toBe("");

        // runtime written
        expect(readFile(h.root, "AGENTS.md")).toBe("# hello");

        // deployment updated
        const dep = getDeployment(h.db, D1)!;
        expect(dep.committedTransactionId).toBe(r.transactionId);
        expect(dep.observationState).toBe("complete");
        // snapshot updated with asset
        const snap = JSON.parse(dep.appliedInputsSnapshot);
        expect(snap.assets[0].assetId).toBe(A1);
        expect(snap.consumerAgentRuntimeIds).toEqual(["CLAUDE_CODE_CLI"]);

        // DeploymentFile baseline
        const f = getDeploymentFile(h.db, D1, "AGENTS.md")!;
        expect(parseDeploymentFileBaselineState(f.baselineState)).toMatchObject({
            rowState: "active",
            appliedPayload: { contentHash: sha("# hello") },
        });
        expect(f.observedState).toBe("present");
    });

    it("redeploy with existing baseline: overwrites + advances baseline", () => {
        // seed baseline + runtime
        seedRealBaseline(h, D1, "a.md", "# v1");
        writeFile(h.root, "a.md", "# v1");

        const r = executeDeployment(h.opts, textPlan("a.md", "# v2"));
        expect(r.outcome).toBe("committed");
        expect(readFile(h.root, "a.md")).toBe("# v2");
        expect(parseDeploymentFileBaselineState(getDeploymentFile(h.db, D1, "a.md")!.baselineState)).toMatchObject({
            rowState: "active",
            appliedPayload: { contentHash: sha("# v2") },
        });
    });

    it("removal candidate: runtime deleted and current row advances to removed residual", () => {
        seedRealBaseline(h, D1, "old.md", "# old");
        writeFile(h.root, "old.md", "# old");

        const r = executeDeployment(h.opts, textPlan("new.md", "# new"));
        expect(r.outcome).toBe("committed");
        expect(exists(h.root, "old.md")).toBe(false);
        expect(getDeploymentFile(h.db, D1, "old.md")!.deleted).toBe(0);
        expect(parseDeploymentFileBaselineState(getDeploymentFile(h.db, D1, "old.md")!.baselineState).rowState).toBe("removed");
        expect(exists(h.root, "new.md")).toBe(true);
    });
});

describe("executeDeployment — inspected runtime replacement authority", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
        seedRealBaseline(h, D1, "a.md", "# baseline");
    });
    afterEach(() => h.cleanup());

    it("replaces the exact inspected third value and commits the new baseline", () => {
        writeFile(h.root, "a.md", "# user edit");
        const plan = textPlan("a.md", "# desired");
        const result = executeDeploymentForTestStrict(
            h.opts,
            plan,
            makeExecutionAuthority(plan),
            {},
            {
                files: [
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# user edit"),
                        expectedExecutable: false,
                    },
                ],
            },
        );
        expect(result.outcome).toBe("committed");
        expect(readFile(h.root, "a.md")).toBe("# desired");
        expect(parseDeploymentFileBaselineState(getDeploymentFile(h.db, D1, "a.md")!.baselineState)).toMatchObject({
            appliedPayload: { contentHash: sha("# desired") },
        });
    });

    it("uses an inspected absence as rollback authority", () => {
        const plan = textPlan("a.md", "# desired");
        const result = executeDeploymentForTestStrict(
            h.opts,
            plan,
            makeExecutionAuthority(plan),
            {},
            { files: [{ relativePath: "a.md", expectedState: "missing" }] },
        );
        expect(result.outcome).toBe("committed");
        expect(readFile(h.root, "a.md")).toBe("# desired");
    });

    it("refuses a stale inspection before publishing a journal or writing runtime", () => {
        writeFile(h.root, "a.md", "# changed after inspection");
        const plan = textPlan("a.md", "# desired");
        const result = executeDeploymentForTestStrict(
            h.opts,
            plan,
            makeExecutionAuthority(plan),
            {},
            {
                files: [
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# inspected"),
                        expectedExecutable: false,
                    },
                ],
            },
        );
        expect(result.outcome).toBe("conflict");
        expect(result.reasonCode).toContain("changed after inspection");
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
        expect(readFile(h.root, "a.md")).toBe("# changed after inspection");
    });

    it("publishes the inspected user bytes as journal old-state before a write failure", () => {
        writeFile(h.root, "a.md", "# user edit");
        const plan = textPlan("a.md", "# desired");
        const failedWrite = vi.spyOn(publicationIo, "createRestorationFile").mockImplementation(() => {
            throw new Error("actual V4 preparation write boundary failed");
        });
        const result = executeDeploymentForTestStrict(
            h.opts,
            plan,
            makeExecutionAuthority(plan),
            {},
            {
                replacementScope: { filePaths: [], directoryPaths: [] },
                directories: [],
                managedDirectoryBoundaryPaths: [],
                desiredManagedDirectoryBoundaryPaths: [],
                unmanagedRemovalPaths: [],
                directoryRemovalPaths: [],
                files: [
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# user edit"),
                        expectedExecutable: false,
                    },
                ],
            },
        );
        expect(failedWrite).toHaveBeenCalledOnce();
        failedWrite.mockRestore();
        expect(result.outcome).toBe("blocked");
        const scan = scanJournals(h.txnRoot, D1);
        expect(scan.matchingTxnIds).toHaveLength(1);
        const journal = readJournal(h.txnRoot, scan.matchingTxnIds[0] as string);
        expect(journal?.entries).toHaveLength(1);
        expect(journal!.entries[0]!.oldHash).toBe(sha("# baseline"));
        expect(journal!.entries[0]!.runtimeRollbackOverride).toEqual({
            state: "present",
            contentHash: sha("# user edit"),
            bytesBase64: Buffer.from("# user edit").toString("base64"),
            executable: false,
        });
    });
});
