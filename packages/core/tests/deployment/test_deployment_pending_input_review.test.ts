import { localTargetTransactions } from "../../src/deployment/local-target-transaction";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDeploymentForTest } from "../../src/deployment/deployment-executor";
import { publishJournal } from "../../src/deployment/deployment-journal";
import { readDeploymentView } from "../../src/deployment/deployment-view";
import {
    insertDeployment,
    listDeploymentAssets,
    reassignSortOrders,
    softDeleteDeploymentAsset,
    updateDeployment,
} from "../../src/persistence/state-db";
import type { AppliedAssetInputSnapshot, UuidV4 } from "../../src/types";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";
import { D1, makeDeploymentRow, SCHEMA_PATH, textPlan } from "./fixtures/deployment-state-ops-test-fixtures";

const A1 = "00000000-0000-4000-8000-000000000010";
const A2 = "00000000-0000-4000-8000-000000000011";
const V1 = "00000000-0000-4000-8000-000000000020";
const V2 = "00000000-0000-4000-8000-000000000021";
const V3 = "00000000-0000-4000-8000-000000000022";
const applied: AppliedAssetInputSnapshot[] = [
    { assetId: A1, versionId: V1, allowIncomplete: false },
    { assetId: A2, versionId: V2, allowIncomplete: false },
];

describe("Pending Deployment input review from durable authority", () => {
    let root: string;
    let db: Database.Database;
    let databasePath: string;
    let transactionsRoot: string;
    let targetRoot: string;
    let now = 1_000;
    const view = () => {
        const result = readDeploymentView({ db, deploymentId: D1, transactionsRoot });
        if (result === null) throw new Error("Expected the retained Deployment");
        return result;
    };
    const select = (assets: AppliedAssetInputSnapshot[]) => {
        for (const current of listDeploymentAssets(db, D1, false)) softDeleteDeploymentAsset(db, D1, current.assetId, ++now);
        reassignSortOrders(
            db,
            D1,
            assets.map((asset) => asset.assetId),
            new Map(
                assets.map((asset) => [
                    asset.assetId,
                    { versionId: asset.versionId, allowIncomplete: asset.allowIncomplete ? 1 : 0 },
                ]),
            ),
            ++now,
        );
    };
    const apply = (assets: AppliedAssetInputSnapshot[], text: string) => {
        const plan = textPlan("AGENTS.md", text);
        return executeDeploymentForTest(
            {
                targetExecution: localTargetTransactions,
                db,
                deploymentId: D1,
                transactionsRoot,
                deploymentsRoot: path.join(root, "deployments"),
                now: () => ++now,
            },
            plan,
            makeExecutionAuthority(plan, { deploymentId: D1, assets }),
            {},
        );
    };

    beforeEach(() => {
        now = 1_000;
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-pending-input-review-"));
        databasePath = path.join(root, "state.db");
        transactionsRoot = path.join(root, "transactions");
        targetRoot = path.join(root, "target");
        for (const directory of [transactionsRoot, targetRoot, path.join(root, "deployments")]) fs.mkdirSync(directory);
        db = new Database(databasePath);
        db.pragma("foreign_keys = ON");
        db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
        insertDeployment(db, makeDeploymentRow(D1, { targetRootPath: targetRoot }));
        select(applied);
        expect(apply(applied, "version one").outcome).toBe("committed");
        expect(view().derivedStatus.actionHints).toEqual(["check_now"]);
    });
    afterEach(() => {
        if (db.open) db.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("reopens a pending Version, permits reverting it, and clears review only after the new bytes commit", () => {
        const next = [{ ...applied[0]!, versionId: V3 }, applied[1]!];
        const oldBaseline = view().appliedInputsSnapshot;
        select(next);
        db.close();
        db = new Database(databasePath);
        expect(view().derivedStatus).toMatchObject({ stage: "in_sync", actionHints: ["check_now", "review_deployment"] });
        expect(view().appliedInputsSnapshot).toEqual(oldBaseline);
        expect(fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf8")).toBe("version one");
        select(applied);
        expect(view().derivedStatus.actionHints).toEqual(["check_now"]);
        select(next);
        expect(apply(next, "version three").outcome).toBe("committed");
        expect(view().derivedStatus.actionHints).toEqual(["check_now"]);
        expect(view().appliedInputsSnapshot.assets).toEqual(next);
        expect(fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf8")).toBe("version three");
    });

    it.each([
        ["asset order", [applied[1]!, applied[0]!]],
        ["incomplete consent", [{ ...applied[0]!, allowIncomplete: true }, applied[1]!]],
        ["asset removal", [applied[0]!]],
        [
            "same-count asset replacement",
            [{ ...applied[0]!, assetId: "00000000-0000-4000-8000-000000000012" as UuidV4 }, applied[1]!],
        ],
    ] as const)("retains review for a changed %s without changing the applied baseline", (_name, selection) => {
        select([...selection]);
        expect(view().derivedStatus.actionHints).toContain("review_deployment");
        expect(view().appliedInputsSnapshot.assets).toEqual(applied);
    });

    it.each([["CODEX_CLI"], ["CLAUDE_CODE_CLI", "CODEX_CLI"]])("retains review for changed consumers %j", (...consumers) => {
        updateDeployment(db, D1, { consumerAgentRuntimeIds: JSON.stringify(consumers) }, ++now);
        expect(view().derivedStatus.actionHints).toContain("review_deployment");
        expect(view().appliedInputsSnapshot.consumerAgentRuntimeIds).toEqual(["CLAUDE_CODE_CLI"]);
    });

    it("preserves recorded conflict and repair priorities, and an actual unresolved recovery journal blocks review", () => {
        select([{ ...applied[0]!, versionId: V3 }, applied[1]!]);
        db.prepare("UPDATE deployment_files SET observed_content_hash = ? WHERE deployment_id = ?").run(
            `sha256:${"f".repeat(64)}`,
            D1,
        );
        expect(view().derivedStatus).toMatchObject({
            stage: "conflict",
            actionHints: ["review_external_changes", "check_now", "review_deployment"],
        });
        db.prepare(
            "UPDATE deployment_files SET observed_state = 'missing', observed_content_hash = '', observed_executable = 0 WHERE deployment_id = ?",
        ).run(D1);
        expect(view().derivedStatus).toMatchObject({
            stage: "needs_repair",
            actionHints: ["review_repair", "check_now", "review_deployment"],
        });
        publishJournal(transactionsRoot, {
            schemaVersion: 1,
            transactionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            deploymentId: D1,
            createdAt: ++now,
            compilationFingerprint: `sha256:${"a".repeat(64)}`,
            entries: [],
            reservedPhysicalKeys: [],
        });
        expect(view().derivedStatus).toMatchObject({ stage: "blocked", actionHints: ["recover"] });
        updateDeployment(db, D1, { deleted: 1 }, ++now);
        expect(view().derivedStatus).toMatchObject({ stage: "deleted", actionHints: [] });
    });
});
