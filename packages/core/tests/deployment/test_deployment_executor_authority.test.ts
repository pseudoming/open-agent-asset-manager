/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { insertDeployment, updateDeployment, getDeployment } from "../../src/persistence/state-db";
import { publishJournal, scanJournals } from "../../src/deployment/deployment-journal";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import type { UuidV4 } from "../../src/types";
import { writeProjectManifest } from "../../src/catalog/project-authority";
import {
    D1,
    D2,
    P1,
    sha,
    deployRow,
    type H,
    harness,
    executeDeployment,
    seedRealBaseline,
    textPlan,
    exists,
} from "./fixtures/deployment-executor-test-fixtures";

describe("executeDeployment — deployment not found / deleted", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("blocks when deployment row missing — row not created, no state mutation", () => {
        h.opts.deploymentId = D2; // no row for D2
        const r = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_needs_support");
        // D2 still doesn't exist (no phantom row written)
        expect(getDeployment(h.db, D2)).toBeNull();
    });

    it("blocks a relative target root before any runtime write or journal", () => {
        const relativeRoot = path.relative(process.cwd(), h.root);
        h.db.prepare("UPDATE deployments SET target_root_path=? WHERE deployment_id=?").run(relativeRoot, D1);
        const result = executeDeployment(h.opts, textPlan("must-not-write.md", "# unsafe"));
        expect(result.outcome).toBe("blocked");
        expect(result.reasonCode).toBe("blocked_needs_support");
        expect(exists(h.root, "must-not-write.md")).toBe(false);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    });

    it("blocks when deployment is soft-deleted — deleted row NOT mutated", () => {
        // Record original state before deploy attempt.
        const before = getDeployment(h.db, D1);
        h.db.prepare("UPDATE deployments SET deleted = 1 WHERE deployment_id = ?").run(D1);
        const r = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_needs_support");
        // The deleted row must NOT have been mutated (no blockingEvidence/observationState write).
        const after = getDeployment(h.db, D1);
        expect(after?.observationState).toBe(before?.observationState);
        expect(after?.blockingEvidence).toBe(before?.blockingEvidence);
        expect(after?.updatedAt).toBe(before?.updatedAt);
    });

    it("soft-deleted deployment + matching unresolved journal → passive blocked, deleted row NOT mutated (audit Addition 20)", () => {
        // The freeze gate writes blockingEvidence via blocked(); if it ran before
        // the missing/deleted check, a deleted deployment with a leftover journal
        // would have its row mutated. The reorder (read deployment first) ensures
        // deleted always takes blockedPassive regardless of journal state.
        const before = getDeployment(h.db, D1);
        h.db.prepare("UPDATE deployments SET deleted = 1 WHERE deployment_id = ?").run(D1);
        // Seed a matching unresolved journal so the freeze gate WOULD fire if it
        // ran before the missing/deleted check.
        publishJournal(h.txnRoot, {
            schemaVersion: 1,
            transactionId: "dead0000-0000-4000-8000-00000000dead",
            deploymentId: D1,
            createdAt: 1,
            compilationFingerprint: sha("freeze-fixture"),
            reservedPhysicalKeys: [],
            entries: [],
        });
        const r = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_needs_support");
        // NOT blocked_by_recovery_state_unavailable — that would mean freeze gate ran.
        // Deleted row untouched.
        const after = getDeployment(h.db, D1);
        expect(after?.observationState).toBe(before?.observationState);
        expect(after?.blockingEvidence).toBe(before?.blockingEvidence);
        expect(after?.updatedAt).toBe(before?.updatedAt);
    });

    it("soft-deleted deployment + corrupt journal → passive blocked, deleted row NOT mutated (audit Addition 20)", () => {
        const before = getDeployment(h.db, D1);
        h.db.prepare("UPDATE deployments SET deleted = 1 WHERE deployment_id = ?").run(D1);
        // Seed a corrupt journal dir so the freeze gate WOULD fire on corrupt.
        const corruptTxn = "beef0000-0000-4000-8000-00000000beef";
        fs.mkdirSync(path.join(h.txnRoot, corruptTxn), { recursive: true });
        fs.writeFileSync(path.join(h.txnRoot, corruptTxn, "journal.json"), "garbage");
        const r = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_needs_support");
        const after = getDeployment(h.db, D1);
        expect(after?.observationState).toBe(before?.observationState);
        expect(after?.blockingEvidence).toBe(before?.blockingEvidence);
        expect(after?.updatedAt).toBe(before?.updatedAt);
    });

    it("missing deployment + matching unresolved journal → passive blocked, no phantom row (audit Addition 20)", () => {
        // No deployment row for D2; seed a journal "belonging" to D2 so the
        // freeze gate WOULD fire if it ran before the missing check.
        h.opts.deploymentId = D2;
        publishJournal(h.txnRoot, {
            schemaVersion: 1,
            transactionId: "dead0000-0000-4000-8000-00000000dea2",
            deploymentId: D2,
            createdAt: 1,
            compilationFingerprint: sha("freeze-fixture"),
            reservedPhysicalKeys: [],
            entries: [],
        });
        const r = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_needs_support");
        // No phantom row created.
        expect(getDeployment(h.db, D2)).toBeNull();
    });
});

describe("executeDeployment — Project authority gate", () => {
    let h: H;
    let projectsRoot: string;
    beforeEach(() => {
        h = harness();
        projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-exec-projects-"));
        updateDeployment(h.db, D1, { projectId: P1 }, 1_100);
    });
    afterEach(() => {
        h.cleanup();
        fs.rmSync(projectsRoot, { recursive: true, force: true });
    });

    it("blocks a project-scoped Deployment when no Project authority root was supplied", () => {
        const result = executeDeployment(h.opts, textPlan("a.md", "# unsafe"));
        expect(result).toMatchObject({ outcome: "blocked", reasonCode: "blocked_needs_support" });
        expect(exists(h.root, "a.md")).toBe(false);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    });

    it.each([
        { label: "missing", deleted: null },
        { label: "deleted", deleted: true },
    ])("blocks a $label Project before journal or runtime mutation", ({ deleted }) => {
        h.opts.projectsRoot = projectsRoot;
        if (deleted !== null) {
            writeProjectManifest(projectsRoot, {
                schemaVersion: 1,
                projectId: P1 as UuidV4,
                rootPath: h.root,
                displayName: "Deleted",
                deleted,
                createdAt: 1,
                updatedAt: 2,
            });
        }
        const result = executeDeployment(h.opts, textPlan("a.md", "# unsafe"));
        expect(result).toMatchObject({ outcome: "blocked", reasonCode: "blocked_needs_support" });
        expect(exists(h.root, "a.md")).toBe(false);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    });

    it("honors an unresolved journal before recording a missing Project failure", () => {
        h.opts.projectsRoot = projectsRoot;
        const transactionId = "fa110000-0000-4000-8000-00000000fa11";
        publishJournal(h.txnRoot, {
            schemaVersion: 1,
            transactionId,
            deploymentId: D1,
            createdAt: 1,
            entries: [],
            compilationFingerprint: sha("project-freeze-fixture"),
            reservedPhysicalKeys: [],
        });

        const result = executeDeployment(h.opts, textPlan("a.md", "# unsafe"));
        expect(result).toMatchObject({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_state_unavailable",
        });
        expect(result.diagnostics[0]?.message).toMatch(/unresolved journal/);
        expect(exists(h.root, "a.md")).toBe(false);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([transactionId]);
    });

    it("blocks corrupt Project authority instead of treating it as a missing Project", () => {
        h.opts.projectsRoot = projectsRoot;
        const projectDirectory = path.join(projectsRoot, P1);
        fs.mkdirSync(projectDirectory, { recursive: true });
        fs.writeFileSync(path.join(projectDirectory, "project.json"), "{bad");
        const result = executeDeployment(h.opts, textPlan("a.md", "# unsafe"));
        expect(result).toMatchObject({ outcome: "blocked", reasonCode: "blocked_needs_support" });
        expect(result.diagnostics[0]?.message).toMatch(/Project authority is unavailable/);
        expect(exists(h.root, "a.md")).toBe(false);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds).toEqual([]);
    });
});

describe("executeDeployment — path safety (pre-write validation)", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    function planWith(rel: string): TargetPlan {
        return {
            schemaVersion: 1,
            targetFiles: [
                {
                    relativePath: rel,
                    content: { contentKind: "text", text: "# x" },
                    executable: false,
                    renderedSectionIds: [],
                },
            ],
        };
    }

    it("../ traversal → blocked, no file written, no journal", () => {
        const r = executeDeployment(h.opts, planWith("../escape.md"));
        expect(r.outcome).toBe("blocked");
        expect(exists(h.root, "../escape.md")).toBe(false);
        // parent dir of targetRoot should not have escape.md
        expect(fs.existsSync(path.join(path.dirname(h.root), "escape.md"))).toBe(false);
    });

    it("absolute path /abs.md → blocked", () => {
        expect(executeDeployment(h.opts, planWith("/abs.md")).outcome).toBe("blocked");
    });

    it("backslash a\\b.md → blocked", () => {
        expect(executeDeployment(h.opts, planWith("a\\b.md")).outcome).toBe("blocked");
    });

    it("empty relativePath → blocked", () => {
        expect(executeDeployment(h.opts, planWith("")).outcome).toBe("blocked");
    });

    it("trailing slash a.md/ → blocked", () => {
        expect(executeDeployment(h.opts, planWith("a.md/")).outcome).toBe("blocked");
    });

    it("duplicate paths → blocked with duplicate message", () => {
        const plan: TargetPlan = {
            schemaVersion: 1,
            targetFiles: [
                {
                    relativePath: "a/b.md",
                    content: { contentKind: "text", text: "# 1" },
                    executable: false,
                    renderedSectionIds: [],
                },
                {
                    relativePath: "a/b.md",
                    content: { contentKind: "text", text: "# 2" },
                    executable: false,
                    renderedSectionIds: [],
                },
            ],
        };
        const r = executeDeployment(h.opts, plan);
        expect(r.outcome).toBe("blocked");
        expect(r.diagnostics[0].message).toContain("duplicate");
    });

    it("non-canonical alias a//b.md (single, not duplicate) → blocked, no runtime write, no journal, no baseline", () => {
        // a//b.md normalizes to a/b.md. isPosixRelativePath alone accepts it,
        // but it would bypass single-writer raw-string occupancy/lock matching
        // (another deployment owning a/b.md would not collide). Must be rejected
        // at path validation — before any lock/journal/write.
        const r = executeDeployment(h.opts, planWith("a//b.md"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_needs_support");
        // No runtime file written under either raw or normalized name.
        expect(exists(h.root, "a//b.md")).toBe(false);
        expect(exists(h.root, "a/b.md")).toBe(false);
        // No journal published.
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds.length).toBe(0);
        // No baseline commit.
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe("");
    });

    it("non-canonical a//b.md blocked BEFORE occupancy even when another deployment owns a/b.md", () => {
        // Seed a second active deployment D2 owning a/b.md at the same
        // platform + targetRootPath. If path validation let a//b.md through,
        // the raw-string occupancy query would NOT match a/b.md and D1 would
        // bypass D2's single-writer ownership. Canonical validation must block
        // at the path-validation step, independent of occupancy.
        insertDeployment(h.db, deployRow(D2, h.root));
        seedRealBaseline(h, D2, "a/b.md", "# d2");
        const r = executeDeployment(h.opts, planWith("a//b.md"));
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_needs_support");
        // D1 blocked at path validation; D2's ownership intact.
        expect(getDeployment(h.db, D2)!.committedTransactionId).toBe("");
        expect(exists(h.root, "a//b.md")).toBe(false);
        expect(exists(h.root, "a/b.md")).toBe(false);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds.length).toBe(0);
    });

    it("valid plan still passes path validation", () => {
        const r = executeDeployment(h.opts, textPlan("subdir/a.md", "# valid"));
        expect(r.outcome).toBe("committed");
    });
});
