/** Phase 21 T3 recovery/scope gate tests with real SQLite authority relationships. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CoreMutationScopeError, createCoreMutationScopeGateForTest } from "../../src/orchestration/core-mutation-scope";
import { closeDb, getDb } from "../../src/persistence/db";
import { insertDeployment, upsertDeploymentAsset } from "../../src/persistence/state-db";
import type { ActiveJournalReservationScanResult } from "../../src/deployment/deployment-journal";
import type { ReverseAcceptReservationScanResult } from "../../src/reverse/reverse-accept-marker";
import type { Sha256Digest, UuidV4 } from "../../src/types";

const DEPLOYMENT = "00000000-0000-4000-8000-000000000301" as UuidV4;
const MISSING_DEPLOYMENT = "00000000-0000-4000-8000-000000000302" as UuidV4;
const ASSET = "00000000-0000-4000-8000-000000000303" as UuidV4;
const OTHER_ASSET = "00000000-0000-4000-8000-000000000304" as UuidV4;
const VERSION = "00000000-0000-4000-8000-000000000305" as UuidV4;
const PREPARATION = "00000000-0000-4000-8000-000000000306" as UuidV4;
const COMMIT = "00000000-0000-4000-8000-000000000307" as UuidV4;
const SHA = `sha256:${"a".repeat(64)}` as Sha256Digest;

let sandbox = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-mutation-scope-"));
    closeDb();
    const db = getDb(path.join(sandbox, "state.db"));
    insertDeployment(db, {
        deploymentId: DEPLOYMENT,
        consumerAgentRuntimeIds: '["CLAUDE_CODE_CLI"]',
        platform: "linux",
        platformInstanceId: "local-linux",
        targetRootPath: sandbox,
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: JSON.stringify({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [],
        }),
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence: "{}",
        deleted: 0,
        createdAt: 1,
        updatedAt: 1,
    });
    upsertDeploymentAsset(db, DEPLOYMENT, ASSET, VERSION, 0, 0, 1);
});

afterEach(() => {
    closeDb();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function journal(deploymentId = DEPLOYMENT): ActiveJournalReservationScanResult {
    return {
        corruptTxnIds: [],
        journals: [
            {
                schemaVersion: 1,
                transactionId: COMMIT,
                deploymentId,
                createdAt: 1,
                compilationFingerprint: SHA,
                reservedPhysicalKeys: [],
                entries: [],
            },
        ],
    };
}

function reverse(assetIds: UuidV4[] = [], globalFreeze = false): ReverseAcceptReservationScanResult {
    return {
        globalFreeze,
        activePreparations:
            assetIds.length === 0
                ? []
                : [
                      {
                          schemaVersion: 1,
                          preparationId: PREPARATION,
                          deploymentId: DEPLOYMENT,
                          commitTransactionId: COMMIT,
                          assetIds,
                          preparationIdentityFingerprint: SHA,
                      },
                  ],
    };
}

function gate(deploymentScan: ActiveJournalReservationScanResult, reverseScan: ReverseAcceptReservationScanResult = reverse()) {
    return createCoreMutationScopeGateForTest(
        { db: getDb(), transactionsRoot: path.join(sandbox, "transactions") },
        {
            scanDeploymentReservations: () => deploymentScan,
            scanReverseReservations: () => reverseScan,
        },
    );
}

function expectBlocked(action: () => void, code: string): void {
    expect(action).toThrowError(expect.objectContaining<Partial<CoreMutationScopeError>>({ code }));
}

describe("Core public mutation recovery/scope gate", () => {
    it("fails closed for corrupt journals and journals without durable Deployment authority", () => {
        expectBlocked(
            () =>
                gate({ journals: [], corruptTxnIds: ["corrupt"] }).assertMutationScope({
                    assetIds: [],
                    settingsAuthority: false,
                }),
            "mutation_scope.corrupt_deployment_journal",
        );
        expectBlocked(
            () => gate(journal(MISSING_DEPLOYMENT)).assertMutationScope({ assetIds: [], settingsAuthority: false }),
            "mutation_scope.journal_deployment_missing",
        );
    });

    it("blocks only an asset mutation that overlaps an unresolved Deployment journal", () => {
        expectBlocked(
            () =>
                gate(journal()).assertMutationScope({
                    assetIds: [ASSET],
                    settingsAuthority: false,
                }),
            "mutation_scope.deployment_recovery_active",
        );
        expect(() =>
            gate(journal()).assertMutationScope({
                assetIds: [OTHER_ASSET],
                settingsAuthority: false,
            }),
        ).not.toThrow();
    });

    it("blocks reverse global/settings and exact asset overlap while permitting disjoint scope", () => {
        expectBlocked(
            () =>
                gate({ journals: [], corruptTxnIds: [] }, reverse([], true)).assertMutationScope({
                    assetIds: [],
                    settingsAuthority: false,
                }),
            "mutation_scope.reverse_accept_active",
        );
        expectBlocked(
            () =>
                gate({ journals: [], corruptTxnIds: [] }, reverse([OTHER_ASSET])).assertMutationScope({
                    assetIds: [],
                    settingsAuthority: true,
                }),
            "mutation_scope.reverse_accept_active",
        );
        expectBlocked(
            () =>
                gate({ journals: [], corruptTxnIds: [] }, reverse([ASSET])).assertMutationScope({
                    assetIds: [ASSET],
                    settingsAuthority: false,
                }),
            "mutation_scope.reverse_accept_active",
        );
        expect(() =>
            gate({ journals: [], corruptTxnIds: [] }, reverse([OTHER_ASSET])).assertMutationScope({
                assetIds: [ASSET],
                settingsAuthority: false,
            }),
        ).not.toThrow();
    });
});
