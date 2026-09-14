/** Wrong-owner calls fail before target I/O; real local staging damage retains recovery material. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveJournalV2, ActiveJournalV3, ActiveJournalV4 } from "../../src/deployment/deployment-journal";
import { defaultTargetTransactionDependencies } from "../../src/deployment/deployment-target-transaction-dependencies";
import { bindLocalTargetTransactions, localTargetTransactions } from "../../src/deployment/local-target-transaction";
import { selectedWslTargetTransactions } from "../../src/deployment/selected-wsl-target-transaction";
import { createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import { withSelectedWslTargetExecution } from "../../src/orchestration/selected-wsl-target-execution";
import { getDeployment } from "../../src/persistence/state-db";
import { D1, D2, TXN_NO, harness, sha } from "./fixtures/deployment-recovery-test-fixtures";

let h: ReturnType<typeof harness>;
beforeEach(() => {
    h = harness("");
});
afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
});
function input() {
    return { ctx: h.ctx, transactionsRoot: h.txnRoot, deps: defaultTargetTransactionDependencies };
}
function journal(): ActiveJournalV2 {
    return {
        schemaVersion: 2,
        transactionId: TXN_NO,
        deploymentId: D1,
        createdAt: 1,
        compilationFingerprint: sha("compiled"),
        reservedPhysicalKeys: [],
        entries: [],
        directoryEntries: [],
        managedDirectoryBoundaries: [],
    };
}
function preparation() {
    return {
        transactionId: TXN_NO,
        compilationFingerprint: sha("compiled"),
        entries: [],
        managedDirectoryBoundaries: [],
        desiredDirectoryPaths: [],
    };
}
function publication(source: ActiveJournalV2 | ActiveJournalV3): ActiveJournalV4 {
    return {
        ...source,
        schemaVersion: 4,
        targetExecution: source.schemaVersion === 3 ? source.targetExecution : { kind: "host" },
        staging: { rootPath: path.join(h.root, "staging"), identity: null },
        publicationPhase: "publishing",
        publications: [],
    };
}
function selected(failCleanup = false) {
    const binding = {
        bindingId: randomUUID(),
        deploymentId: D1,
        platformInstanceId: "selected-fixture",
        targetRootPath: h.root,
        executionRootPath: h.root,
    };
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const service = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 10_000 });
    const exchange = vi.fn((request) => service.handle(request));
    const bound = createRestrictedTargetChannel(session, exchange).bind(binding);
    const execution = failCleanup
        ? {
              ...bound,
              graph: {
                  ...bound.graph,
                  recoverPublication: vi.fn((source: ActiveJournalV4) => ({ outcome: "io_failed" as const, journal: source })),
              },
          }
        : bound;
    const operations = selectedWslTargetTransactions(execution).create(input());
    const prepared = operations.prepare(preparation());
    if (prepared.outcome !== "ready") throw new Error("fixture graph preparation did not complete");
    const owned = prepared.prepared.prepareJournal(journal());
    if (owned.schemaVersion !== 3) throw new Error("fixture must produce the current selected graph journal");
    return { execution, operations, prepared: prepared.prepared, owned, exchange };
}

describe("explicit target transaction boundaries", () => {
    it("binds local journals to the authorized Deployment and refuses a changed creation root", () => {
        const target = getDeployment(h.db, D1)!;
        const bound = bindLocalTargetTransactions(target);
        target.targetRootPath = path.join(h.root, "changed-after-binding");
        expect(bound.ownsJournal(journal())).toBe(true);
        expect(bound.ownsJournal({ ...journal(), deploymentId: D2 })).toBe(false);
        expect(() => bound.create({ ...input(), ctx: { ...h.ctx, targetRootPath: target.targetRootPath } })).toThrow(
            "authorized operation",
        );
        expect(fs.readdirSync(h.root)).toEqual([]);
    });

    it("refuses a selected journal at every local physical operation", () => {
        const remote = selected(),
            local = localTargetTransactions.create(input());
        const result = local.prepare(preparation());
        if (result.outcome !== "ready") throw new Error("local preparation failed");
        expect(local.recover(remote.owned, "old")).toBe("io_failed");
        expect(() => result.prepared.execute(remote.owned)).toThrow("selected-WSL journal");
        expect(() => result.prepared.verify(remote.owned)).toThrow("selected-WSL journal");
        expect(() => result.prepared.finalize(remote.owned)).toThrow("selected-WSL journal");
        expect(fs.readdirSync(h.root)).toEqual([]);
    });

    it("keeps foreign staging bytes when local publication cleanup cannot finish", () => {
        const local = localTargetTransactions.create(input()).prepare(preparation());
        if (local.outcome !== "ready") throw new Error("local preparation failed");
        const damaged = publication(journal());
        fs.writeFileSync(damaged.staging.rootPath, "foreign staging bytes");
        expect(() => local.prepared.finalize(damaged)).toThrow("retains recovery material");
        expect(fs.readFileSync(damaged.staging.rootPath, "utf8")).toBe("foreign staging bytes");
    });

    it("refuses wrong-owner selected calls and verification without a successful execution receipt", () => {
        const h = selected(),
            calls = h.exchange.mock.calls.length;
        expect(h.operations.recover(journal(), "old")).toBe("io_failed");
        expect(() => h.prepared.execute(journal())).toThrow("write journal mismatch");
        expect(() => h.prepared.verify(journal())).toThrow("no successful execution receipt");
        expect(() => h.prepared.verify(h.owned)).toThrow("no successful execution receipt");
        expect(() => h.prepared.finalize(journal())).toThrow("finalization journal mismatch");
        expect(h.exchange).toHaveBeenCalledTimes(calls);
    });

    it("retains selected publication recovery when the channel reports failed cleanup", () => {
        const h = selected(true),
            source = publication(h.owned);
        const failed = h.execution.graph.recoverPublication;
        expect(() => h.prepared.finalize(source)).toThrow("retains recovery material");
        expect(failed).toHaveBeenCalledWith(source, "new", expect.any(Function));
    });

    it.each([
        "linux",
        "wsl",
    ] as const)("does not admit a %s target with a local physical root through selected-WSL entry", async (platform) => {
        const run = vi.fn();
        await expect(
            withSelectedWslTargetExecution(
                { platformContexts: [] },
                {
                    platform,
                    platformInstanceId: "fixture",
                    deploymentId: D1,
                    targetRootPath: h.root,
                },
                run,
            ),
        ).rejects.toThrow("requires its exact physical target");
        expect(run).not.toHaveBeenCalled();
    });
});
