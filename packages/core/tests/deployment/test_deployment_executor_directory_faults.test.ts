import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanJournals } from "../../src/deployment/deployment-journal";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";
import {
    D1,
    type H,
    executeDeploymentForTest,
    executeRawStrict,
    harness,
    textPlan,
} from "./fixtures/deployment-executor-test-fixtures";

describe("executeDeployment — managed-directory fault transitions", () => {
    let h: H;

    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("rejects an unmanaged-removal authority that overlaps the compiled target before journal publication", () => {
        const targetPlan = textPlan("a.md", "# desired");
        const result = executeRawStrict(h.opts, targetPlan, makeExecutionAuthority(targetPlan), {
            files: [{ relativePath: "a.md", expectedState: "missing" }],
            directories: [],
            managedDirectoryBoundaryPaths: [],
            desiredManagedDirectoryBoundaryPaths: [],
            unmanagedRemovalPaths: ["a.md"],
            directoryRemovalPaths: [],
        });
        expect(result).toEqual(expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_needs_support" }));
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    });

    it("maps a directory-planning TOCTOU to target-unavailable before journal publication", () => {
        const result = executeDeploymentForTest(h.opts, textPlan("nested/a.md", "# desired"), {
            preflightExecutableTransitions: () => {
                fs.writeFileSync(path.join(h.root, "nested"), "not a directory");
                return null;
            },
        });
        expect(result).toEqual(
            expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_by_deploy_target_unavailable" }),
        );
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    });

    it("retains the journal when a planned missing directory appears before ensure", () => {
        const baseDb = h.db;
        const faultingDb = {
            exec: (sql: string) => {
                const result = baseDb.exec(sql);
                if (sql === "COMMIT") fs.writeFileSync(path.join(h.root, "nested"), "appeared");
                return result;
            },
            prepare: baseDb.prepare.bind(baseDb),
            pragma: baseDb.pragma.bind(baseDb),
            transaction: baseDb.transaction.bind(baseDb),
        } as unknown as Database.Database;
        const result = executeDeploymentForTest({ ...h.opts, db: faultingDb }, textPlan("nested/a.md", "# desired"), {});
        expect(result).toEqual(
            expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_by_deploy_target_unavailable" }),
        );
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
    });

    it("retains the journal when conflict cleanup observes a replaced created directory", () => {
        const result = executeDeploymentForTest(h.opts, textPlan("nested/a.md", "# desired"), {
            casWriteAll: () => {
                fs.renameSync(path.join(h.root, "nested"), path.join(h.root, "nested-replaced-away"));
                fs.mkdirSync(path.join(h.root, "nested"));
                return {
                    ok: false,
                    written: [],
                    mutated: [],
                    stop: { kind: "third_value", relativePath: "a-later.md" },
                };
            },
        });
        expect(result).toEqual(
            expect.objectContaining({ outcome: "blocked", reasonCode: "blocked_by_deploy_target_unavailable" }),
        );
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toHaveLength(1);
        expect(fs.statSync(path.join(h.root, "nested")).isDirectory()).toBe(true);
    });
});
