/** Canonical pre-commit database-state DTO validation scenarios. */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    commitReverseAcceptSuccessCrashDurable,
    prepareDeploymentSuccessAuthority,
    validateCanonicalDeploymentPreCommitDatabaseStateForTest,
} from "../../src/deployment/deployment-state-authority";
import { computeDeploymentAssetId } from "../../src/foundation/fingerprint";
import { DEPLOYMENT_ID, makeRemovalSuccessInput, seedActiveFile } from "../reverse/fixtures/reverse-accept-db-fixtures";
import {
    ASSET_ID,
    VERSION_ID,
    type MutablePreState,
    root,
    databasePath,
    mutablePreState,
    validAsset,
    makeForeignResidual,
} from "./fixtures/deployment-state-authority-test-fixtures";

describe("canonical pre-commit database-state validator", () => {
    it("accepts the exact Core projection and rejects malformed top-level branches", () => {
        const base = mutablePreState();
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(base)).not.toThrow();

        const cases: Array<{
            name: string;
            mutate(value: MutablePreState): void;
            expected: RegExp;
        }> = [
            {
                name: "schema discriminator",
                mutate: (value) => {
                    value.schemaVersion = 2;
                },
                expected: /exact v1/,
            },
            {
                name: "deployment exact keys",
                mutate: (value) => {
                    value.deployment.extra = true;
                },
                expected: /Deployment must be exact/,
            },
            {
                name: "deployment identity",
                mutate: (value) => {
                    value.deployment.deploymentId = "bad";
                },
                expected: /deploymentId/,
            },
            {
                name: "consumer array",
                mutate: (value) => {
                    value.deployment.consumerAgentRuntimeIds = "CLAUDE_CODE_CLI";
                },
                expected: /consumers/,
            },
            {
                name: "blank consumer",
                mutate: (value) => {
                    value.deployment.consumerAgentRuntimeIds = [""];
                },
                expected: /consumers/,
            },
            {
                name: "consumer order",
                mutate: (value) => {
                    value.deployment.consumerAgentRuntimeIds = ["Z", "A"];
                },
                expected: /sorted/,
            },
            {
                name: "platform",
                mutate: (value) => {
                    value.deployment.platform = "plan9";
                },
                expected: /Platform/,
            },
            {
                name: "blank platform instance identity",
                mutate: (value) => {
                    value.deployment.platformInstanceId = " ";
                },
                expected: /platformInstanceId/,
            },
            {
                name: "NUL platform instance identity",
                mutate: (value) => {
                    value.deployment.platformInstanceId = "local\0other";
                },
                expected: /platformInstanceId/,
            },
            {
                name: "target root",
                mutate: (value) => {
                    value.deployment.targetRootPath = "relative";
                },
                expected: /targetRootPath/,
            },
            {
                name: "project identity",
                mutate: (value) => {
                    value.deployment.projectId = "bad";
                },
                expected: /projectId/,
            },
            {
                name: "transaction identity",
                mutate: (value) => {
                    value.deployment.committedTransactionId = "bad";
                },
                expected: /transaction ID/,
            },
            {
                name: "inputs digest",
                mutate: (value) => {
                    value.deployment.appliedInputsSnapshotFingerprint = "bad";
                },
                expected: /SHA-256/,
            },
            {
                name: "render digest",
                mutate: (value) => {
                    value.deployment.appliedRenderSnapshotFingerprint = "bad";
                },
                expected: /SHA-256/,
            },
            {
                name: "observation state",
                mutate: (value) => {
                    value.deployment.observationState = "bogus";
                },
                expected: /ObservationState/,
            },
            {
                name: "negative observation attempt",
                mutate: (value) => {
                    value.deployment.observationAttemptedAt = -1;
                },
                expected: /observation times are invalid/,
            },
            {
                name: "never observation with attempt",
                mutate: (value) => {
                    value.deployment.observationAttemptedAt = 1;
                },
                expected: /never observation must use zero times/,
            },
            {
                name: "terminal observation without attempt",
                mutate: (value) => {
                    value.deployment.observationState = "failed";
                },
                expected: /terminal observation must have an attempt time/,
            },
            {
                name: "complete observation clock mismatch",
                mutate: (value) => {
                    value.deployment.observationState = "complete";
                    value.deployment.observationAttemptedAt = 2;
                    value.deployment.lastCompleteObservationAt = 1;
                },
                expected: /complete observation times must match/,
            },
            {
                name: "deleted flag",
                mutate: (value) => {
                    value.deployment.deleted = 0;
                },
                expected: /deleted must be boolean/,
            },
            {
                name: "created timestamp",
                mutate: (value) => {
                    value.deployment.createdAt = -1;
                },
                expected: /timestamps/,
            },
            {
                name: "updated timestamp",
                mutate: (value) => {
                    value.deployment.updatedAt = 0;
                },
                expected: /timestamps/,
            },
            {
                name: "asset closure",
                mutate: (value) => {
                    value.deploymentAssets = "bad" as unknown as Array<Record<string, unknown>>;
                },
                expected: /closures/,
            },
            {
                name: "file closure",
                mutate: (value) => {
                    value.deploymentFiles = "bad" as unknown as Array<Record<string, unknown>>;
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
        ];
        for (const testCase of cases) {
            const candidate = structuredClone(base);
            testCase.mutate(candidate);
            expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(candidate), testCase.name).toThrow(
                testCase.expected,
            );
        }
    });

    it("accepts every stable Platform and ObservationState branch", () => {
        const platformRoots = [
            ["linux", "/tmp/root"],
            ["wsl", "/mnt/c/root"],
            ["darwin", "/Users/test/root"],
            ["win32", "C:\\root"],
        ] as const;
        for (const [platform, targetRootPath] of platformRoots) {
            const candidate = mutablePreState();
            candidate.deployment.platform = platform;
            candidate.deployment.targetRootPath = targetRootPath;
            expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(candidate), platform).not.toThrow();
        }
        for (const observationState of ["never", "in_progress", "complete", "partial", "failed"]) {
            const candidate = mutablePreState();
            candidate.deployment.observationState = observationState;
            if (observationState === "complete") {
                candidate.deployment.observationAttemptedAt = 1;
                candidate.deployment.lastCompleteObservationAt = 1;
            } else if (observationState === "partial" || observationState === "failed") {
                candidate.deployment.observationAttemptedAt = 1;
                candidate.deployment.lastCompleteObservationAt = 0;
            }
            expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(candidate), observationState).not.toThrow();
        }
    });

    it("validates complete blocking evidence and every OperationDiagnostic field", () => {
        const validDiagnostic: Record<string, unknown> = {
            severity: "error",
            code: "blocked",
            message: "blocked",
            path: "",
            traceId: "trace",
            operation: "internal",
            causeKind: "internal_error",
            retryable: false,
            suggestedActions: [],
            rawSummary: "summary",
        };
        const withDiagnostic = mutablePreState();
        withDiagnostic.deployment.blockingEvidence = {
            schemaVersion: 1,
            reasonCode: "blocked",
            operation: "deploy",
            contextFingerprint: "context",
            occurredAt: 1,
            diagnostics: [validDiagnostic],
            suggestedActions: ["retry"],
            retryable: true,
        };
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(withDiagnostic)).not.toThrow();

        const evidenceCases: Array<{
            name: string;
            mutate(evidence: Record<string, unknown>): void;
            expected: RegExp;
        }> = [
            {
                name: "exact keys",
                mutate: (value) => {
                    value.extra = true;
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "schema",
                mutate: (value) => {
                    value.schemaVersion = 2;
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "reason",
                mutate: (value) => {
                    value.reasonCode = 1;
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "context",
                mutate: (value) => {
                    value.contextFingerprint = 1;
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "time",
                mutate: (value) => {
                    value.occurredAt = -1;
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "retryable",
                mutate: (value) => {
                    value.retryable = 0;
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "diagnostics",
                mutate: (value) => {
                    value.diagnostics = "bad";
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "actions",
                mutate: (value) => {
                    value.suggestedActions = "bad";
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "action item",
                mutate: (value) => {
                    value.suggestedActions = [1];
                },
                expected: /BlockingEvidence is invalid/,
            },
            {
                name: "operation",
                mutate: (value) => {
                    value.operation = "bogus";
                },
                expected: /operation is invalid/,
            },
        ];
        for (const testCase of evidenceCases) {
            const candidate = structuredClone(withDiagnostic);
            testCase.mutate(candidate.deployment.blockingEvidence as Record<string, unknown>);
            expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(candidate), testCase.name).toThrow(
                testCase.expected,
            );
        }

        const diagnosticCases: Array<{
            name: string;
            mutate(diagnostic: Record<string, unknown>): void;
        }> = [
            {
                name: "object",
                mutate: (value) => {
                    value.severity = undefined;
                },
            },
            {
                name: "exact keys",
                mutate: (value) => {
                    value.extra = true;
                },
            },
            {
                name: "severity",
                mutate: (value) => {
                    value.severity = "fatal";
                },
            },
            {
                name: "operation",
                mutate: (value) => {
                    value.operation = "bogus";
                },
            },
            {
                name: "cause",
                mutate: (value) => {
                    value.causeKind = "bogus";
                },
            },
            {
                name: "code",
                mutate: (value) => {
                    value.code = 1;
                },
            },
            {
                name: "message",
                mutate: (value) => {
                    value.message = 1;
                },
            },
            {
                name: "path",
                mutate: (value) => {
                    value.path = 1;
                },
            },
            {
                name: "trace",
                mutate: (value) => {
                    value.traceId = 1;
                },
            },
            {
                name: "retryable",
                mutate: (value) => {
                    value.retryable = 0;
                },
            },
            {
                name: "summary",
                mutate: (value) => {
                    value.rawSummary = 1;
                },
            },
            {
                name: "actions",
                mutate: (value) => {
                    value.suggestedActions = "bad";
                },
            },
            {
                name: "action item",
                mutate: (value) => {
                    value.suggestedActions = [1];
                },
            },
        ];
        for (const testCase of diagnosticCases) {
            const candidate = structuredClone(withDiagnostic);
            const diagnostics = (candidate.deployment.blockingEvidence as Record<string, unknown>).diagnostics as Array<
                Record<string, unknown>
            >;
            testCase.mutate(diagnostics[0]!);
            expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(candidate), testCase.name).toThrow(
                /OperationDiagnostic/,
            );
        }

        const nonObject = structuredClone(withDiagnostic);
        (nonObject.deployment.blockingEvidence as Record<string, unknown>).diagnostics = [null];
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(nonObject)).toThrow(/OperationDiagnostic/);
    });

    it("validates every DeploymentAsset field and canonical ordering", () => {
        const base = mutablePreState();
        base.deploymentAssets = [validAsset()];
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(base)).not.toThrow();

        const cases: Array<{
            name: string;
            mutate(value: Record<string, unknown>): void;
            expected: RegExp;
        }> = [
            {
                name: "exact keys",
                mutate: (value) => {
                    value.extra = true;
                },
                expected: /must be exact/,
            },
            {
                name: "asset UUID",
                mutate: (value) => {
                    value.assetId = "bad";
                },
                expected: /assetId/,
            },
            {
                name: "version UUID",
                mutate: (value) => {
                    value.versionId = "bad";
                },
                expected: /versionId/,
            },
            {
                name: "deterministic ID",
                mutate: (value) => {
                    value.deploymentAssetId = "bad";
                },
                expected: /deploymentAssetId mismatch/,
            },
            {
                name: "sort order",
                mutate: (value) => {
                    value.sortOrder = -1;
                },
                expected: /sortOrder/,
            },
            {
                name: "allow flag",
                mutate: (value) => {
                    value.allowIncomplete = 0;
                },
                expected: /flags/,
            },
            {
                name: "deleted flag",
                mutate: (value) => {
                    value.deleted = 0;
                },
                expected: /flags/,
            },
            {
                name: "timestamp",
                mutate: (value) => {
                    value.updatedAt = 0;
                },
                expected: /timestamps/,
            },
        ];
        for (const testCase of cases) {
            const candidate = structuredClone(base);
            testCase.mutate(candidate.deploymentAssets[0]!);
            expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(candidate), testCase.name).toThrow(
                testCase.expected,
            );
        }

        const second = { ...validAsset(), assetId: VERSION_ID, versionId: ASSET_ID };
        second.deploymentAssetId = computeDeploymentAssetId(DEPLOYMENT_ID, second.assetId);
        const unsorted = structuredClone(base);
        unsorted.deploymentAssets = [second, validAsset()];
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(unsorted)).toThrow(
            /deploymentAssets must be sorted/,
        );
    });

    it("validates active and removed DeploymentFile closures instead of trusting nested DTOs", () => {
        seedActiveFile(databasePath, "active.md");
        const active = mutablePreState();
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(active)).not.toThrow();
        const nonObject = structuredClone(active);
        nonObject.deploymentFiles = [null as unknown as Record<string, unknown>];
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(nonObject)).toThrow(/DeploymentFile must be exact/);

        const activeCases: Array<{
            name: string;
            mutate(value: Record<string, unknown>): void;
            expected: RegExp;
        }> = [
            {
                name: "path",
                mutate: (value) => {
                    value.relativePath = "../escape";
                },
                expected: /path/,
            },
            {
                name: "identity",
                mutate: (value) => {
                    value.deploymentFileId = "bad";
                },
                expected: /deploymentFileId mismatch/,
            },
            {
                name: "observed time",
                mutate: (value) => {
                    value.observedAt = -1;
                },
                expected: /observedAt/,
            },
            {
                name: "updated time",
                mutate: (value) => {
                    value.updatedAt = 0;
                },
                expected: /timestamps/,
            },
            {
                name: "active exact keys",
                mutate: (value) => {
                    value.extra = true;
                },
                expected: /active DeploymentFile must be exact/,
            },
            {
                name: "active payload",
                mutate: (value) => {
                    value.appliedPayload = {};
                },
                expected: /payload/i,
            },
        ];
        for (const testCase of activeCases) {
            const candidate = structuredClone(active);
            testCase.mutate(candidate.deploymentFiles[0]!);
            expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(candidate), testCase.name).toThrow(
                testCase.expected,
            );
        }

        const removal = makeRemovalSuccessInput(databasePath, "active.md");
        const prepared = prepareDeploymentSuccessAuthority(databasePath, removal);
        commitReverseAcceptSuccessCrashDurable({
            databasePath,
            successCommit: removal,
            preparedAuthority: prepared,
        });
        const removed = mutablePreState();
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(removed)).not.toThrow();

        const extra = structuredClone(removed);
        extra.deploymentFiles[0]!.extra = true;
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(extra)).toThrow(
            /removed DeploymentFile must be exact/,
        );
        const unresolved = structuredClone(removed);
        unresolved.residualAuthorities = [];
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(unresolved)).toThrow(
            /unresolved residual authority/,
        );
        const foreign = structuredClone(removed);
        foreign.residualAuthorities[0] = makeForeignResidual(foreign.residualAuthorities[0]!);
        expect(() => validateCanonicalDeploymentPreCommitDatabaseStateForTest(foreign)).toThrow(/another Deployment/);
    });
});
