/** Authority-focused split from the original oversized Deployment test suite. */

import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
    commitReverseAcceptSuccessCrashDurable,
    prepareDeploymentSuccessAuthority,
    readDeploymentSuccessPostcondition,
    validateDeploymentSuccessPostcondition,
} from "../../src/deployment/deployment-state-authority";
import {
    DEPLOYMENT_ID,
    makeRemovalSuccessInput,
    makeSuccessInput,
    seedActiveFile,
    textPlan,
} from "../reverse/fixtures/reverse-accept-db-fixtures";
import {
    type MutablePostcondition,
    databasePath,
    mutablePostcondition,
    freshDatabase,
    makeForeignResidual,
} from "./fixtures/deployment-state-authority-test-fixtures";

describe("deployment success postcondition validator", () => {
    it("rejects malformed discriminators, identities, closures and non-empty success evidence", () => {
        const base = mutablePostcondition();
        expect(() => validateDeploymentSuccessPostcondition(base)).not.toThrow();
        const cases: Array<{
            name: string;
            mutate(value: MutablePostcondition): void;
            expected: RegExp;
        }> = [
            {
                name: "extra field",
                mutate: (value) => {
                    (value as unknown as Record<string, unknown>).extra = true;
                },
                expected: /exact object/,
            },
            {
                name: "schema",
                mutate: (value) => {
                    value.schemaVersion = 2;
                },
                expected: /discriminator/,
            },
            {
                name: "state",
                mutate: (value) => {
                    value.deploymentObservationState = "partial";
                },
                expected: /discriminator/,
            },
            {
                name: "deployment ID",
                mutate: (value) => {
                    value.deploymentId = "bad";
                },
                expected: /deploymentId/,
            },
            {
                name: "transaction ID",
                mutate: (value) => {
                    value.commitTransactionId = "bad";
                },
                expected: /commitTransactionId/,
            },
            {
                name: "observation attempt type",
                mutate: (value) => {
                    value.deploymentObservationAttemptedAt = "1";
                },
                expected: /complete observation times are invalid/,
            },
            {
                name: "zero observation attempt",
                mutate: (value) => {
                    value.deploymentObservationAttemptedAt = 0;
                    value.deploymentLastCompleteObservationAt = 0;
                },
                expected: /complete observation times are invalid/,
            },
            {
                name: "mismatched observation times",
                mutate: (value) => {
                    value.deploymentLastCompleteObservationAt = (value.deploymentObservationAttemptedAt as number) - 1;
                },
                expected: /complete observation times are invalid/,
            },
            {
                name: "file closure",
                mutate: (value) => {
                    value.files = "bad" as unknown as Array<Record<string, unknown>>;
                },
                expected: /closures/,
            },
            {
                name: "residual closure",
                mutate: (value) => {
                    value.residualAuthorities = "bad" as unknown as Array<Record<string, unknown>>;
                },
                expected: /closures/,
            },
            {
                name: "blocking evidence",
                mutate: (value) => {
                    value.deploymentBlockingEvidence.reasonCode = "blocked";
                },
                expected: /canonical empty/,
            },
        ];
        for (const testCase of cases) {
            const candidate = structuredClone(base);
            testCase.mutate(candidate);
            expect(() => validateDeploymentSuccessPostcondition(candidate), testCase.name).toThrow(testCase.expected);
        }
    });

    it("validates active and removed file branches against exact residual closure", () => {
        const active = mutablePostcondition(textPlan("active.md"));
        const activeCases: Array<{
            name: string;
            mutate(value: Record<string, unknown>): void;
            expected: RegExp;
        }> = [
            {
                name: "object",
                mutate: (value) => {
                    value.rowState = undefined;
                },
                expected: /exact present branch/,
            },
            {
                name: "path",
                mutate: (value) => {
                    value.relativePath = "a//b";
                },
                expected: /relativePath/,
            },
            {
                name: "identity",
                mutate: (value) => {
                    value.deploymentFileId = "bad";
                },
                expected: /deploymentFileId mismatch/,
            },
            {
                name: "exact keys",
                mutate: (value) => {
                    value.extra = true;
                },
                expected: /exact present branch/,
            },
            {
                name: "observed digest",
                mutate: (value) => {
                    value.observedContentHash = `sha256:${"f".repeat(64)}`;
                },
                expected: /applied and observed state differ/,
            },
        ];
        for (const testCase of activeCases) {
            const candidate = structuredClone(active);
            testCase.mutate(candidate.files[0]!);
            expect(() => validateDeploymentSuccessPostcondition(candidate), testCase.name).toThrow(testCase.expected);
        }
        expect(() => validateDeploymentSuccessPostcondition({ ...active, files: [null] })).toThrow(/file must be an object/);

        seedActiveFile(databasePath, "removed.md");
        const removal = makeRemovalSuccessInput(databasePath, "removed.md");
        const removed = prepareDeploymentSuccessAuthority(databasePath, removal)
            .expectedSuccessPostcondition as unknown as MutablePostcondition;
        expect(() => validateDeploymentSuccessPostcondition(removed)).not.toThrow();
        const removedExtra = structuredClone(removed);
        removedExtra.files[0]!.extra = true;
        expect(() => validateDeploymentSuccessPostcondition(removedExtra)).toThrow(/exact missing branch/);
        const unresolved = structuredClone(removed);
        unresolved.residualAuthorities = [];
        expect(() => validateDeploymentSuccessPostcondition(unresolved)).toThrow(/unresolved residual authority/);
        const foreign = structuredClone(removed);
        foreign.residualAuthorities[0] = makeForeignResidual(foreign.residualAuthorities[0]!);
        expect(() => validateDeploymentSuccessPostcondition(foreign)).toThrow(/another Deployment/);
        const duplicate = structuredClone(removed);
        duplicate.residualAuthorities.push(structuredClone(duplicate.residualAuthorities[0]!));
        expect(() => validateDeploymentSuccessPostcondition(duplicate)).toThrow(/must be unique/);
    });
});

describe("success-postcondition projection from proposed and stored state", () => {
    it("rejects invalid time, duplicate paths, noncanonical paths and every active mismatch", () => {
        const invalidTime = makeSuccessInput();
        invalidTime.now = -1;
        expect(() => prepareDeploymentSuccessAuthority(databasePath, invalidTime)).toThrow(/epoch milliseconds/);

        const duplicate = makeSuccessInput(textPlan("active.md"));
        duplicate.verifiedActiveFiles.push(structuredClone(duplicate.verifiedActiveFiles[0]!));
        expect(() => prepareDeploymentSuccessAuthority(databasePath, duplicate)).toThrow(/duplicate success postcondition path/);

        const badPath = makeSuccessInput(textPlan("active.md"));
        badPath.verifiedActiveFiles[0]!.verified.relativePath = "a//b";
        expect(() => prepareDeploymentSuccessAuthority(databasePath, badPath)).toThrow(/relativePath is not canonical/);

        const cases: Array<{
            name: string;
            mutate(file: Record<string, unknown>): void;
        }> = [
            {
                name: "observed state",
                mutate: (file) => {
                    (file.verified as Record<string, unknown>).observedState = "missing";
                },
            },
            {
                name: "applied hash",
                mutate: (file) => {
                    (file.verified as Record<string, unknown>).appliedContentHash = `sha256:${"e".repeat(64)}`;
                },
            },
            {
                name: "observed hash",
                mutate: (file) => {
                    (file.verified as Record<string, unknown>).observedContentHash = `sha256:${"e".repeat(64)}`;
                },
            },
            {
                name: "executable observation",
                mutate: (file) => {
                    (file.verified as Record<string, unknown>).observedExecutable = true;
                },
            },
            {
                name: "render snapshot provenance",
                mutate: (file) => {
                    (file.provenance as Record<string, unknown>).appliedRenderSnapshotFingerprint = `sha256:${"e".repeat(64)}`;
                },
            },
        ];
        for (const testCase of cases) {
            const input = makeSuccessInput(textPlan("active.md"));
            testCase.mutate(input.verifiedActiveFiles[0] as unknown as Record<string, unknown>);
            expect(() => prepareDeploymentSuccessAuthority(databasePath, input), testCase.name).toThrow(
                /cannot form an exact postcondition/,
            );
        }
    });

    it("rejects active/removal overlap, foreign removal, missing prior and omitted active rows", () => {
        seedActiveFile(databasePath, "active.md");
        const removal = makeRemovalSuccessInput(databasePath, "active.md");
        const overlap = makeSuccessInput(textPlan("active.md"));
        overlap.newlyRemoved = structuredClone(removal.newlyRemoved);
        expect(() => prepareDeploymentSuccessAuthority(databasePath, overlap)).toThrow(/active and removed/);

        const foreign = makeSuccessInput();
        foreign.newlyRemoved = [
            makeForeignResidual(
                removal.newlyRemoved[0] as unknown as Record<string, unknown>,
            ) as unknown as (typeof foreign.newlyRemoved)[number],
        ];
        expect(() => prepareDeploymentSuccessAuthority(databasePath, foreign)).toThrow(/belongs to another Deployment/);

        const sourcePath = freshDatabase("removal-source");
        seedActiveFile(sourcePath, "orphan.md");
        const noPrior = makeRemovalSuccessInput(sourcePath, "orphan.md");
        expect(() => prepareDeploymentSuccessAuthority(databasePath, noPrior)).toThrow(/consume a current active baseline/);

        expect(() => prepareDeploymentSuccessAuthority(databasePath, makeSuccessInput())).toThrow(
            /omits a current active baseline/,
        );
    });

    it("retains prior removed rows and cumulative residual closure on a later success", () => {
        seedActiveFile(databasePath, "removed.md");
        const removal = makeRemovalSuccessInput(databasePath, "removed.md");
        commitReverseAcceptSuccessCrashDurable({
            databasePath,
            successCommit: removal,
            preparedAuthority: prepareDeploymentSuccessAuthority(databasePath, removal),
        });

        const later = makeSuccessInput(
            {
                schemaVersion: 1,
                targetFiles: [...textPlan("z.md").targetFiles, ...textPlan("a.md").targetFiles],
            },
            "44444444-4444-4444-8444-444444444444",
        );
        const prepared = prepareDeploymentSuccessAuthority(databasePath, later);
        expect(prepared.expectedSuccessPostcondition.files.map((file) => file.relativePath)).toEqual([
            "a.md",
            "removed.md",
            "z.md",
        ]);
        expect(prepared.expectedSuccessPostcondition.residualAuthorities).toEqual(removal.newlyRemoved);

        const repeatedRemoval = makeSuccessInput(
            { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] },
            "55555555-5555-4555-8555-555555555555",
        );
        repeatedRemoval.newlyRemoved = structuredClone(removal.newlyRemoved);
        expect(() => prepareDeploymentSuccessAuthority(databasePath, repeatedRemoval)).toThrow(
            /consume a current active baseline/,
        );
    });

    it("rejects every non-success stored state while reopening committed postconditions", () => {
        const committedPath = freshDatabase("stored-success");
        const success = makeSuccessInput({
            schemaVersion: 1,
            targetFiles: [...textPlan("z.md").targetFiles, ...textPlan("a.md").targetFiles],
        });
        const prepared = prepareDeploymentSuccessAuthority(committedPath, success);
        commitReverseAcceptSuccessCrashDurable({
            databasePath: committedPath,
            successCommit: success,
            preparedAuthority: prepared,
        });
        expect(readDeploymentSuccessPostcondition(committedPath, DEPLOYMENT_ID, success.transactionId)).toEqual(
            prepared.expectedSuccessPostcondition,
        );

        const missingPath = freshDatabase("missing-deployment");
        const missing = new Database(missingPath);
        missing.prepare("DELETE FROM deployments").run();
        missing.close();
        expect(() => readDeploymentSuccessPostcondition(missingPath, DEPLOYMENT_ID, success.transactionId)).toThrow(
            /active Deployment/,
        );

        const mutations: Array<[string, string, RegExp]> = [
            ["deleted", "UPDATE deployments SET deleted=1", /active Deployment/],
            [
                "transaction",
                "UPDATE deployments SET committed_transaction_id='44444444-4444-4444-8444-444444444444'",
                /requested success transaction/,
            ],
            ["observation", "UPDATE deployments SET observation_state='partial'", /requested success transaction/],
            [
                "blocking evidence",
                'UPDATE deployments SET blocking_evidence=\'{"schemaVersion":1,"reasonCode":"blocked","operation":"deploy","contextFingerprint":"x","occurredAt":1,"diagnostics":[],"suggestedActions":[],"retryable":false}\'',
                /canonical empty/,
            ],
            [
                "active observed missing",
                "UPDATE deployment_files SET observed_state='missing', observed_content_hash='', observed_executable=0",
                /not observed present/,
            ],
        ];
        for (const [name, sql, expected] of mutations) {
            const casePath = freshDatabase(`stored-${name.replaceAll(" ", "-")}`);
            const caseSuccess = makeSuccessInput(textPlan("active.md"));
            const casePrepared = prepareDeploymentSuccessAuthority(casePath, caseSuccess);
            commitReverseAcceptSuccessCrashDurable({
                databasePath: casePath,
                successCommit: caseSuccess,
                preparedAuthority: casePrepared,
            });
            const db = new Database(casePath);
            db.pragma("ignore_check_constraints = ON");
            db.exec(sql);
            db.close();
            expect(() => readDeploymentSuccessPostcondition(casePath, DEPLOYMENT_ID, caseSuccess.transactionId), name).toThrow(
                expected,
            );
        }
    });
});
