import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeploymentCommitReceipt, readDeploymentCommitReceipt } from "../../src/deployment/deployment-commit-receipts";
import {
    commitReverseAcceptSuccessCrashDurable,
    commitReverseAcceptSuccessCrashDurableForTest,
    commitReverseAcceptVersionSelectionSuccessCrashDurable,
    commitReverseAcceptVersionSelectionSuccessCrashDurableForTest,
    prepareDeploymentSuccessAuthority,
    prepareReverseAcceptDeploymentSuccessAuthority,
    readCanonicalDeploymentPreCommitDatabaseState,
    readDeploymentSuccessPostcondition,
    validateDeploymentCommitReceiptReadbackForTest,
    validateDeploymentSuccessPostcondition,
} from "../../src/deployment/deployment-state-authority";
import { listDeploymentAssets, softDeleteDeploymentAsset, upsertDeploymentAsset } from "../../src/persistence/state-db";
import { computePreCommitDatabaseStateFingerprint } from "../../src/foundation/fingerprint";
import {
    DEPLOYMENT_ID,
    TRANSACTION_ID,
    initializeStateDatabase,
    makeRemovalSuccessInput,
    makeSuccessInput,
    seedActiveFile,
    seedDeployment,
    textPlan,
} from "../reverse/fixtures/reverse-accept-db-fixtures";

let root: string;
let databasePath: string;
const ALT_DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const ALT_TRANSACTION_ID = "33333333-3333-4333-8333-333333333333";
const ALT_DIGEST = `sha256:${"f".repeat(64)}` as const;
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const OLD_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const NEW_VERSION_ID = "66666666-6666-4666-8666-666666666666";

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-state-authority-"));
    databasePath = path.join(root, "state.db");
    initializeStateDatabase(databasePath);
    seedDeployment(databasePath);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe("Deployment state authority preparation and FULL commit", () => {
    it("changes one DeploymentAsset Version in the same FULL success transaction", () => {
        const db = new Database(databasePath);
        upsertDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID, OLD_VERSION_ID, 0, 0, 2_000);
        db.close();
        const successCommit = makeSuccessInput();
        successCommit.appliedInputsSnapshot.assets = [{ assetId: ASSET_ID, versionId: NEW_VERSION_ID, allowIncomplete: false }];
        const transition = {
            assetId: ASSET_ID,
            previousVersionId: OLD_VERSION_ID,
            stagedVersionId: NEW_VERSION_ID,
        } as const;
        const preparedAuthority = prepareReverseAcceptDeploymentSuccessAuthority(databasePath, successCommit, transition);

        const result = commitReverseAcceptVersionSelectionSuccessCrashDurable({
            databasePath,
            successCommit,
            preparedAuthority,
            deploymentAssetTransition: transition,
        });
        expect(result.commitState).toBe("committed");
        const reopened = new Database(databasePath);
        expect(listDeploymentAssets(reopened, DEPLOYMENT_ID, false)).toEqual([
            expect.objectContaining({
                assetId: ASSET_ID,
                versionId: NEW_VERSION_ID,
                sortOrder: 0,
                allowIncomplete: 0,
                createdAt: 2_000,
                updatedAt: successCommit.now,
            }),
        ]);
        reopened.close();
    });

    it("rolls back the DeploymentAsset Version transition with every later authority", () => {
        const db = new Database(databasePath);
        upsertDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID, OLD_VERSION_ID, 0, 0, 2_000);
        db.close();
        const successCommit = makeSuccessInput();
        successCommit.appliedInputsSnapshot.assets = [{ assetId: ASSET_ID, versionId: NEW_VERSION_ID, allowIncomplete: false }];
        const transition = {
            assetId: ASSET_ID,
            previousVersionId: OLD_VERSION_ID,
            stagedVersionId: NEW_VERSION_ID,
        } as const;
        const preparedAuthority = prepareReverseAcceptDeploymentSuccessAuthority(databasePath, successCommit, transition);
        expect(() =>
            commitReverseAcceptVersionSelectionSuccessCrashDurableForTest(
                {
                    databasePath,
                    successCommit,
                    preparedAuthority,
                    deploymentAssetTransition: transition,
                },
                {
                    afterSuccessMutation() {
                        throw new Error("fault after reverse success mutation");
                    },
                },
            ),
        ).toThrow(/fault after reverse success mutation/);
        const reopened = new Database(databasePath);
        expect(listDeploymentAssets(reopened, DEPLOYMENT_ID, false)[0]?.versionId).toBe(OLD_VERSION_ID);
        reopened.close();
        expect(readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({
            receiptState: "missing",
        });
    });

    it("rejects every inexact reverse DeploymentAsset transition before opening FULL", () => {
        const OTHER_ASSET_ID = "77777777-7777-4777-8777-777777777777";
        const OTHER_OLD_VERSION_ID = "88888888-8888-4888-8888-888888888888";
        const db = new Database(databasePath);
        upsertDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID, OLD_VERSION_ID, 1, 0, 2_000);
        upsertDeploymentAsset(db, DEPLOYMENT_ID, OTHER_ASSET_ID, OTHER_OLD_VERSION_ID, 0, 1, 2_000);
        db.close();
        const successCommit = makeSuccessInput();
        successCommit.appliedInputsSnapshot.assets = [
            {
                assetId: OTHER_ASSET_ID,
                versionId: OTHER_OLD_VERSION_ID,
                allowIncomplete: true,
            },
            { assetId: ASSET_ID, versionId: NEW_VERSION_ID, allowIncomplete: false },
        ];
        const valid = {
            assetId: ASSET_ID,
            previousVersionId: OLD_VERSION_ID,
            stagedVersionId: NEW_VERSION_ID,
        } as const;
        type Transition = Parameters<typeof prepareReverseAcceptDeploymentSuccessAuthority>[2];
        const cases: Array<{ label: string; transition: unknown; mutate?: () => void }> = [
            { label: "non-object", transition: "bad" },
            { label: "extra field", transition: { ...valid, extra: true } },
            { label: "invalid Asset ID", transition: { ...valid, assetId: "bad" } },
            {
                label: "invalid previous Version ID",
                transition: { ...valid, previousVersionId: "bad" },
            },
            {
                label: "invalid staged Version ID",
                transition: { ...valid, stagedVersionId: "bad" },
            },
            {
                label: "same old and staged Version",
                transition: { ...valid, stagedVersionId: OLD_VERSION_ID },
            },
            {
                label: "foreign success Deployment",
                transition: valid,
                mutate: () => {
                    successCommit.deploymentId = ALT_DEPLOYMENT_ID;
                },
            },
            {
                label: "foreign snapshot Deployment",
                transition: valid,
                mutate: () => {
                    successCommit.appliedInputsSnapshot.deploymentId = ALT_DEPLOYMENT_ID;
                },
            },
            {
                label: "missing active Asset",
                transition: { ...valid, assetId: ALT_DEPLOYMENT_ID },
            },
            {
                label: "wrong old Version",
                transition: { ...valid, previousVersionId: OTHER_OLD_VERSION_ID },
            },
            {
                label: "changed consumers",
                transition: valid,
                mutate: () => {
                    successCommit.appliedInputsSnapshot.consumerAgentRuntimeIds = ["OPENCODE_CLI"];
                },
            },
            {
                label: "missing unchanged Asset",
                transition: valid,
                mutate: () => {
                    successCommit.appliedInputsSnapshot.assets = [
                        {
                            assetId: ASSET_ID,
                            versionId: NEW_VERSION_ID,
                            allowIncomplete: false,
                        },
                    ];
                },
            },
        ];

        for (const testCase of cases) {
            const candidate = structuredClone(successCommit);
            testCase.mutate?.();
            const mutated = structuredClone(successCommit);
            Object.assign(successCommit, candidate);
            expect(
                () => prepareReverseAcceptDeploymentSuccessAuthority(databasePath, mutated, testCase.transition as Transition),
                testCase.label,
            ).toThrow();
        }
    });

    it("detects a DeploymentAsset mutation after the pre-state CAS and rolls back", () => {
        const db = new Database(databasePath);
        upsertDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID, OLD_VERSION_ID, 0, 0, 2_000);
        db.close();
        const successCommit = makeSuccessInput();
        successCommit.appliedInputsSnapshot.assets = [{ assetId: ASSET_ID, versionId: NEW_VERSION_ID, allowIncomplete: false }];
        const transition = {
            assetId: ASSET_ID,
            previousVersionId: OLD_VERSION_ID,
            stagedVersionId: NEW_VERSION_ID,
        } as const;
        const preparedAuthority = prepareReverseAcceptDeploymentSuccessAuthority(databasePath, successCommit, transition);
        expect(() =>
            commitReverseAcceptVersionSelectionSuccessCrashDurableForTest(
                {
                    databasePath,
                    successCommit,
                    preparedAuthority,
                    deploymentAssetTransition: transition,
                },
                {
                    afterPreStateCas(transaction) {
                        softDeleteDeploymentAsset(transaction as unknown as Database.Database, DEPLOYMENT_ID, ASSET_ID, 8_000);
                    },
                },
            ),
        ).toThrow(/lost its exact old authority/);
        const reopened = new Database(databasePath);
        expect(listDeploymentAssets(reopened, DEPLOYMENT_ID, false)[0]?.versionId).toBe(OLD_VERSION_ID);
        reopened.close();
    });

    it("rejects a reverse transition timestamp older than its current relationship", () => {
        const db = new Database(databasePath);
        upsertDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID, OLD_VERSION_ID, 0, 0, 10_000);
        db.close();
        const successCommit = makeSuccessInput();
        successCommit.appliedInputsSnapshot.assets = [{ assetId: ASSET_ID, versionId: NEW_VERSION_ID, allowIncomplete: false }];
        const transition = {
            assetId: ASSET_ID,
            previousVersionId: OLD_VERSION_ID,
            stagedVersionId: NEW_VERSION_ID,
        } as const;
        const preparedAuthority = prepareReverseAcceptDeploymentSuccessAuthority(databasePath, successCommit, transition);
        expect(() =>
            commitReverseAcceptVersionSelectionSuccessCrashDurable({
                databasePath,
                successCommit,
                preparedAuthority,
                deploymentAssetTransition: transition,
            }),
        ).toThrow(/time precedes current authority/);
    });
    it("binds canonical pre-state, exact postcondition and receipt, then commits atomically", () => {
        const successCommit = makeSuccessInput(textPlan("a.md", "# new", true));
        const before = readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID);
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        expect(preparedAuthority.preCommitDatabaseState).toEqual(before);
        expect(preparedAuthority.expectedSuccessPostcondition.files).toHaveLength(1);
        expect(preparedAuthority.expectedSuccessPostcondition.files[0]).toMatchObject({
            rowState: "active",
            relativePath: "a.md",
            observedState: "present",
            observedExecutable: true,
        });

        const result = commitReverseAcceptSuccessCrashDurable({
            databasePath,
            successCommit,
            preparedAuthority,
        });
        expect(result).toEqual({
            commitState: "committed",
            commitReceipt: preparedAuthority.commitReceipt,
            successPostcondition: preparedAuthority.expectedSuccessPostcondition,
        });
        expect(readDeploymentSuccessPostcondition(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual(
            preparedAuthority.expectedSuccessPostcondition,
        );
        expect(readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({
            receiptState: "available",
            receipt: preparedAuthority.commitReceipt,
        });
    });

    it("classifies an exact duplicate without rewriting success state", () => {
        const successCommit = makeSuccessInput();
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        commitReverseAcceptSuccessCrashDurable({ databasePath, successCommit, preparedAuthority });
        const committed = readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID);
        const duplicate = commitReverseAcceptSuccessCrashDurable({
            databasePath,
            successCommit,
            preparedAuthority,
        });
        expect(duplicate.commitState).toBe("already_committed");
        expect(readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID)).toEqual(committed);
    });

    it("rejects a valid but contradictory receipt under the same composite key", () => {
        const successCommit = makeSuccessInput();
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        commitReverseAcceptSuccessCrashDurable({ databasePath, successCommit, preparedAuthority });

        const alternatePreState = structuredClone(preparedAuthority.preCommitDatabaseState);
        alternatePreState.deployment.updatedAt += 1;
        const alternateReceipt = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId: preparedAuthority.commitReceipt.deploymentId,
            commitTransactionId: preparedAuthority.commitReceipt.commitTransactionId,
            preCommitDatabaseStateFingerprint: computePreCommitDatabaseStateFingerprint(alternatePreState),
            appliedInputsSnapshotFingerprint: preparedAuthority.commitReceipt.appliedInputsSnapshotFingerprint,
            appliedRenderSnapshotFingerprint: preparedAuthority.commitReceipt.appliedRenderSnapshotFingerprint,
            deploymentFileBaselineSetFingerprint: preparedAuthority.commitReceipt.deploymentFileBaselineSetFingerprint,
        });
        expect(() =>
            commitReverseAcceptSuccessCrashDurable({
                databasePath,
                successCommit,
                preparedAuthority: {
                    ...preparedAuthority,
                    preCommitDatabaseState: alternatePreState,
                    commitReceipt: alternateReceipt,
                },
            }),
        ).toThrow(/contradicts/);
    });

    it("fails the pre-state CAS after concurrent state drift and writes no receipt", () => {
        const successCommit = makeSuccessInput();
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        const db = new Database(databasePath);
        db.prepare("UPDATE deployments SET updated_at=updated_at+1 WHERE deployment_id=?").run(DEPLOYMENT_ID);
        db.close();
        expect(() =>
            commitReverseAcceptSuccessCrashDurable({
                databasePath,
                successCommit,
                preparedAuthority,
            }),
        ).toThrow(/pre-commit database state CAS mismatch/);
        expect(readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({ receiptState: "missing" });
        expect(readCommittedTransactionId()).toBe("");
    });

    it("rolls back success rows and receipt at every injected pre-COMMIT boundary", () => {
        const hookCases = [
            "afterPreStateCas",
            "afterSuccessMutation",
            "beforeReceiptInsert",
            "afterReceiptInsert",
            "beforeCommit",
        ] as const;
        for (const hookName of hookCases) {
            const casePath = path.join(root, `${hookName}.db`);
            initializeStateDatabase(casePath);
            seedDeployment(casePath);
            const successCommit = makeSuccessInput();
            const preparedAuthority = prepareDeploymentSuccessAuthority(casePath, successCommit);
            const before = readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID);
            const fail = () => {
                throw new Error(`fault:${hookName}`);
            };
            const hooks = hookName === "beforeCommit" ? { fullTransaction: { beforeCommit: fail } } : { [hookName]: fail };
            expect(() =>
                commitReverseAcceptSuccessCrashDurableForTest(
                    { databasePath: casePath, successCommit, preparedAuthority },
                    hooks,
                ),
            ).toThrow(`fault:${hookName}`);
            expect(readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID)).toEqual(before);
            expect(readDeploymentCommitReceipt(casePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({ receiptState: "missing" });
        }
    });

    it("a post-COMMIT fault reports unknown while receipt and postcondition reopen exact", () => {
        const successCommit = makeSuccessInput();
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        expect(() =>
            commitReverseAcceptSuccessCrashDurableForTest(
                { databasePath, successCommit, preparedAuthority },
                {
                    fullTransaction: {
                        afterCommit() {
                            throw new Error("lost after durable commit");
                        },
                    },
                },
            ),
        ).toThrow(/lost after durable commit/);
        expect(readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({
            receiptState: "available",
            receipt: preparedAuthority.commitReceipt,
        });
        expect(readDeploymentSuccessPostcondition(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual(
            preparedAuthority.expectedSuccessPostcondition,
        );
    });

    it("preserves cumulative removed authority and current removed pointer", () => {
        seedActiveFile(databasePath, "old.md", "# old");
        const successCommit = makeRemovalSuccessInput(databasePath, "old.md");
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        expect(preparedAuthority.expectedSuccessPostcondition.files).toEqual([
            expect.objectContaining({
                rowState: "removed",
                relativePath: "old.md",
                observedState: "missing",
                latestResidualAuthorityId: successCommit.newlyRemoved[0]?.residualAuthorityId,
            }),
        ]);
        expect(preparedAuthority.expectedSuccessPostcondition.residualAuthorities).toEqual(successCommit.newlyRemoved);
        commitReverseAcceptSuccessCrashDurable({ databasePath, successCommit, preparedAuthority });
        expect(readDeploymentSuccessPostcondition(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual(
            preparedAuthority.expectedSuccessPostcondition,
        );
    });
});

describe("Deployment state authority input and receipt joins", () => {
    it("rejects non-object authority branches and every mismatched identity join", () => {
        const successCommit = makeSuccessInput();
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        const base = { databasePath, successCommit, preparedAuthority };

        expect(() =>
            commitReverseAcceptSuccessCrashDurable({
                ...base,
                successCommit: null as unknown as typeof successCommit,
            }),
        ).toThrow(/exact authority objects/);
        expect(() =>
            commitReverseAcceptSuccessCrashDurable({
                ...base,
                preparedAuthority: null as unknown as typeof preparedAuthority,
            }),
        ).toThrow(/exact authority objects/);

        const mutations: Array<(input: typeof base) => void> = [
            (input) => {
                input.successCommit.deploymentId = ALT_DEPLOYMENT_ID;
            },
            (input) => {
                input.successCommit.transactionId = ALT_TRANSACTION_ID;
            },
            (input) => {
                input.preparedAuthority.preCommitDatabaseState.deployment.deploymentId = ALT_DEPLOYMENT_ID;
            },
            (input) => {
                input.preparedAuthority.expectedSuccessPostcondition.deploymentId = ALT_DEPLOYMENT_ID;
            },
            (input) => {
                input.preparedAuthority.expectedSuccessPostcondition.commitTransactionId = ALT_TRANSACTION_ID;
            },
        ];
        for (const mutate of mutations) {
            const candidate = structuredClone(base);
            mutate(candidate);
            expect(() => commitReverseAcceptSuccessCrashDurable(candidate)).toThrow(/identities do not join exactly/);
        }
    });

    it("rejects each independently mismatched fingerprint join", () => {
        const successCommit = makeSuccessInput();
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        const base = { databasePath, successCommit, preparedAuthority };

        const changedPreState = structuredClone(base);
        changedPreState.preparedAuthority.preCommitDatabaseState.deployment.updatedAt += 1;
        expect(() => commitReverseAcceptSuccessCrashDurable(changedPreState)).toThrow(/fingerprint join is invalid/);

        for (const field of [
            "appliedInputsSnapshotFingerprint",
            "appliedRenderSnapshotFingerprint",
            "deploymentFileBaselineSetFingerprint",
        ] as const) {
            const candidate = structuredClone(base);
            const { commitReceiptFingerprint: _commitReceiptFingerprint, ...receiptPreimage } =
                candidate.preparedAuthority.commitReceipt;
            candidate.preparedAuthority.commitReceipt = buildDeploymentCommitReceipt({
                ...receiptPreimage,
                [field]: ALT_DIGEST,
            });
            expect(() => commitReverseAcceptSuccessCrashDurable(candidate), field).toThrow(/fingerprint join is invalid/);
        }
    });

    it("fails closed on missing and contradictory receipt readback results", () => {
        const successCommit = makeSuccessInput();
        const expected = prepareDeploymentSuccessAuthority(databasePath, successCommit).commitReceipt;
        expect(() => validateDeploymentCommitReceiptReadbackForTest({ receiptState: "missing" }, expected)).toThrow(
            /readback failed/,
        );
        const { commitReceiptFingerprint: _commitReceiptFingerprint, ...receiptPreimage } = expected;
        const other = buildDeploymentCommitReceipt({
            ...receiptPreimage,
            appliedInputsSnapshotFingerprint: ALT_DIGEST,
        });
        expect(() =>
            validateDeploymentCommitReceiptReadbackForTest({ receiptState: "available", receipt: other }, expected),
        ).toThrow(/readback failed/);
        expect(
            validateDeploymentCommitReceiptReadbackForTest({ receiptState: "available", receipt: expected }, expected),
        ).toEqual(expected);
    });
});

describe("Deployment state authority fail-closed validation", () => {
    it("rejects invalid database paths, identities and missing deployments", () => {
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(":memory:", DEPLOYMENT_ID)).toThrow(/canonical absolute/);
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(databasePath, "bad" as typeof DEPLOYMENT_ID)).toThrow(
            /deploymentId/,
        );
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(databasePath, "00000000-0000-4000-8000-000000000002")).toThrow(
            /not found/,
        );
        expect(() => readDeploymentSuccessPostcondition(databasePath, DEPLOYMENT_ID, "bad" as typeof TRANSACTION_ID)).toThrow(
            /commitTransactionId/,
        );
    });

    it("rejects hidden missing sentinels and invalid present hashes", () => {
        seedActiveFile(databasePath, "a.md");
        const db = new Database(databasePath);
        db.prepare("UPDATE deployment_files SET observed_state='missing' WHERE deployment_id=?").run(DEPLOYMENT_ID);
        db.close();
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID)).toThrow(
            /hidden physical values/,
        );

        const secondPath = path.join(root, "bad-present.db");
        initializeStateDatabase(secondPath);
        seedDeployment(secondPath);
        seedActiveFile(secondPath, "a.md");
        const second = new Database(secondPath);
        second.prepare("UPDATE deployment_files SET observed_content_hash='bad' WHERE deployment_id=?").run(DEPLOYMENT_ID);
        second.close();
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(secondPath, DEPLOYMENT_ID)).toThrow(/invalid content hash/);
    });

    it("rejects invalid Deployment scalar authority instead of normalizing it away", () => {
        const cases: Array<[string, unknown, RegExp]> = [
            ["consumer_agent_runtime_ids", '["Z","A"]', /sorted/],
            ["target_root_path", "relative", /targetRootPath/],
            ["project_id", "bad", /projectId/],
            ["committed_transaction_id", "bad", /committedTransactionId/],
            ["observation_state", "bogus", /ObservationState/],
            ["blocking_evidence", "{}", /DeploymentBlockingEvidence/],
        ];
        for (const [column, value, expected] of cases) {
            const casePath = path.join(root, `${column}.db`);
            initializeStateDatabase(casePath);
            seedDeployment(casePath);
            const db = new Database(casePath);
            db.pragma("ignore_check_constraints = ON");
            db.prepare(`UPDATE deployments SET ${column}=? WHERE deployment_id=?`).run(value, DEPLOYMENT_ID);
            db.close();
            expect(() => readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID)).toThrow(expected);
        }
        for (const [label, value] of [
            ["blank-platform-instance", " "],
            ["nul-platform-instance", "local\0other"],
        ] as const) {
            const casePath = path.join(root, `${label}.db`);
            initializeStateDatabase(casePath);
            seedDeployment(casePath);
            const db = new Database(casePath);
            db.pragma("ignore_check_constraints = ON");
            db.prepare("UPDATE deployments SET platform_instance_id=? WHERE deployment_id=?").run(value, DEPLOYMENT_ID);
            db.close();
            expect(() => readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID)).toThrow(/platformInstanceId/);
        }
    });

    it("rejects postcondition DTO extras and non-canonical file order", () => {
        const successCommit = makeSuccessInput(textPlan("b.md"));
        const prepared = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        expect(() =>
            validateDeploymentSuccessPostcondition({
                ...prepared.expectedSuccessPostcondition,
                extra: true,
            }),
        ).toThrow(/exact object/);
        const duplicate = structuredClone(prepared.expectedSuccessPostcondition);
        duplicate.files.push(structuredClone(duplicate.files[0]!));
        expect(() => validateDeploymentSuccessPostcondition(duplicate)).toThrow(/unique/);
    });
});

function readCommittedTransactionId(): string {
    const db = new Database(databasePath, { readonly: true });
    try {
        return (
            db.prepare("SELECT committed_transaction_id FROM deployments").get() as {
                committed_transaction_id: string;
            }
        ).committed_transaction_id;
    } finally {
        db.close();
    }
}
