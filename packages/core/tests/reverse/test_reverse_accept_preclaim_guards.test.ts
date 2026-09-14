import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { computeReverseAcceptMarkerFingerprint } from "../../src/foundation/fingerprint";
import { promotionTargetForDeployment } from "../../src/render/render-promotion-authorization";
import { buildReverseAcceptPreparationIdentity, createReverseAcceptMarkerStore } from "../../src/reverse/reverse-accept-marker";
import {
    createReverseAcceptService,
    createReverseAcceptServiceForTest,
    type FreshReverseAcceptCommitDraft,
} from "../../src/reverse/reverse-accept-service";
import type { Sha256Digest, UuidV4 } from "../../src/types";
import { ASSET_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import {
    ASSET_UUID,
    commitRequest,
    createHarness,
    exactAnalysisValidator,
    harness,
    HASH_A,
    HASH_B,
    HASH_C,
    PREPARATION_ID,
    prepare,
    PROMOTION_GRANT_ID,
    sequenceUuid,
    STAGED_VERSION_ID,
    TRANSACTION_UUID,
} from "./fixtures/reverse-accept-commit-test-fixtures";

describe("reverse-accept preclaim guards", () => {
    it("rejects every stale cross-authority join before publishing the staged Version", async () => {
        const cases: Array<{
            name: string;
            mutate(draft: FreshReverseAcceptCommitDraft): void;
        }> = [
            {
                name: "extra top-level field",
                mutate: (draft) => Object.assign(draft, { unexpected: true }),
            },
            {
                name: "invalid authority digest",
                mutate: (draft) => {
                    draft.deploymentAuthorityFingerprint = "bad" as Sha256Digest;
                },
            },
            {
                name: "changed Asset authority set",
                mutate: (draft) => {
                    draft.assetManifestAuthorities[0]!.assetManifestAuthorityFingerprint = HASH_C;
                },
            },
            {
                name: "stale Deployment authority",
                mutate: (draft) => {
                    draft.deploymentAuthorityFingerprint = HASH_B;
                },
            },
            {
                name: "stale inspection scope",
                mutate: (draft) => {
                    draft.inspectionScopeFingerprint = HASH_C;
                },
            },
            {
                name: "stale inspection result",
                mutate: (draft) => {
                    draft.inspectionResultFingerprint = HASH_B;
                },
            },
            {
                name: "wrong Deployment schema",
                mutate: (draft) => {
                    draft.deployment.schemaVersion = 2 as never;
                },
            },
            {
                name: "non-object Deployment",
                mutate: (draft) => {
                    draft.deployment = null as never;
                },
            },
            {
                name: "foreign Deployment",
                mutate: (draft) => {
                    draft.deployment.deploymentId = PREPARATION_ID;
                },
            },
            {
                name: "foreign Deployment platform",
                mutate: (draft) => {
                    draft.deployment.platform = "win32";
                    draft.deployment.targetRootPath = "C:\\runtime";
                },
            },
            {
                name: "foreign Deployment target root",
                mutate: (draft) => {
                    draft.deployment.targetRootPath = path.join(draft.deployment.targetRootPath, "other");
                },
            },
            {
                name: "foreign Deployment project",
                mutate: (draft) => {
                    draft.deployment.projectId = PREPARATION_ID;
                },
            },
            {
                name: "stale render input",
                mutate: (draft) => {
                    draft.deployment.renderInputFingerprint = HASH_A;
                },
            },
            {
                name: "changed render analysis",
                mutate: (draft) => {
                    draft.renderAnalysis = {
                        ...draft.renderAnalysis,
                        requiredSemantics: [{} as never],
                    };
                },
            },
            {
                name: "duplicate Deployment Asset",
                mutate: (draft) => {
                    draft.deployment.assets.push(structuredClone(draft.deployment.assets[0]!));
                },
            },
            {
                name: "missing Deployment Asset",
                mutate: (draft) => {
                    draft.deployment.assets = [];
                },
            },
            {
                name: "projection differs from staged Version",
                mutate: (draft) => {
                    draft.deployment.assets[0]!.version.versionFingerprint = HASH_A;
                },
            },
            {
                name: "staged origin differs from preparation",
                mutate: (draft) => {
                    if (draft.stagedVersion.manifest.originAuthority.originKind !== "reverse_accept") {
                        throw new Error("fixture reverse origin missing");
                    }
                    draft.stagedVersion.manifest.originAuthority.userActionEvidenceId = "changed";
                },
            },
            {
                name: "foreign success Deployment",
                mutate: (draft) => {
                    draft.successCommit.deploymentId = PREPARATION_ID;
                },
            },
            {
                name: "missing success lock closure",
                mutate: (draft) => {
                    draft.successCommit = null as never;
                },
            },
            {
                name: "foreign success transaction",
                mutate: (draft) => {
                    draft.successCommit.transactionId = PREPARATION_ID;
                },
            },
            {
                name: "different success time",
                mutate: (draft) => {
                    draft.successCommit.now += 1;
                },
            },
            {
                name: "stale success render input",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.renderInputFingerprint = HASH_A;
                },
            },
            {
                name: "stale selection fingerprint",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.selectionFingerprint = HASH_A;
                },
            },
            {
                name: "stale compilation fingerprint",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.compilationFingerprint = HASH_A;
                },
            },
            {
                name: "unsafe active-file lock path",
                mutate: (draft) => {
                    draft.successCommit.verifiedActiveFiles[0]!.verified.relativePath = "../outside.md";
                },
            },
            {
                name: "unsafe managed-boundary lock path",
                mutate: (draft) => {
                    draft.successCommit.appliedRenderSnapshot.outputUnits[0]!.managedDirectoryBoundaries = [
                        { relativePath: "../outside" },
                    ];
                },
            },
            {
                name: "changed AppliedInputsSnapshot",
                mutate: (draft) => {
                    draft.successCommit.appliedInputsSnapshot.assets[0]!.allowIncomplete = true;
                },
            },
            {
                name: "missing staged promotion authorization",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.promotionAuthorizations = [];
                },
            },
            {
                name: "duplicate staged promotion authorization",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.promotionAuthorizations.push(
                        structuredClone(draft.successCommit.appliedRenderSnapshot.promotionAuthorizations[0]!),
                    );
                },
            },
            {
                name: "foreign staged promotion target",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.promotionAuthorizations[0]!.target = {
                        targetKind: "project",
                        projectId: PREPARATION_ID,
                    };
                },
            },
            {
                name: "foreign staged origin authorization",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.promotionAuthorizations[0]!.versionOriginAuthorityFingerprint =
                        HASH_A;
                },
            },
            {
                name: "non-restricted Version unexpectedly authorized",
                mutate: (draft) => {
                    if (draft.successCommit.appliedRenderSnapshot.snapshotState !== "applied") {
                        throw new Error("fixture applied snapshot missing");
                    }
                    draft.successCommit.appliedRenderSnapshot.promotionAuthorizations[0] = {
                        promotionAuthorizationState: "authorized",
                        assetId: ASSET_UUID,
                        versionId: STAGED_VERSION_ID,
                        target: promotionTargetForDeployment(draft.deployment),
                        versionOriginAuthorityFingerprint: draft.stagedVersion.manifest.originAuthority.authorityFingerprint,
                        authorizationSource: "asset_all_versions_target_grant",
                        authorityId: PROMOTION_GRANT_ID,
                        authorityRevision: 1,
                        authorityFingerprint: HASH_A,
                    };
                },
            },
        ];
        for (const testCase of cases) {
            const isolated = createHarness();
            try {
                const service = createReverseAcceptService(
                    isolated.configuration({
                        resolveFreshCommit: async (input) => {
                            const value = isolated.makeCommitDraft(input.stagedVersionOriginAuthority, input.promotionGrantId);
                            testCase.mutate(value);
                            return { status: "complete", value, diagnostics: [] };
                        },
                    }),
                );
                await prepare(service);
                const result = await service.commitRenderedTargetAccept(commitRequest(isolated.analysis));
                expect(result.status, testCase.name).toBe("failed");
                expect(result.diagnostics.length, testCase.name).toBeGreaterThan(0);
                expect(fs.existsSync(path.join(isolated.assetsRoot, ASSET_ID, "versions", VERSION_ID_2)), testCase.name).toBe(
                    false,
                );
            } finally {
                fs.rmSync(isolated.root, { recursive: true, force: true });
            }
        }
    });

    it("fails closed at every lock, marker, clock, and resolver gate before claim", async () => {
        const missing = createReverseAcceptService(harness.configuration());
        expect((await missing.commitRenderedTargetAccept(commitRequest(harness.analysis))).diagnostics[0]?.code).toBe(
            "reverse_accept.marker_unavailable",
        );

        const invalid = createReverseAcceptService(harness.configuration());
        expect(
            (
                await invalid.commitRenderedTargetAccept({
                    ...commitRequest(harness.analysis),
                    userActionId: " ",
                })
            ).diagnostics[0]?.code,
        ).toBe("reverse_accept.invalid_commit_input");
        for (const newVersionPromotion of [
            { promotionAction: "use_existing_authority", extra: true },
            { promotionAction: "grant_staged_version_current_target", extra: true },
            { promotionAction: "future" },
        ]) {
            const result = await invalid.commitRenderedTargetAccept({
                ...commitRequest(harness.analysis),
                newVersionPromotion,
            } as never);
            expect(result.diagnostics[0]?.code).toBe("reverse_accept.invalid_commit_input");
        }

        const assetBusyHarness = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                assetBusyHarness.transactionsRoot,
                exactAnalysisValidator(assetBusyHarness.analysis),
            );
            const service = createReverseAcceptServiceForTest(assetBusyHarness.configuration(), store, undefined, {
                acquireAssetLocks: () => null,
            });
            await prepare(service);
            expect(
                (await service.commitRenderedTargetAccept(commitRequest(assetBusyHarness.analysis))).diagnostics[0]?.code,
            ).toBe("reverse_accept.asset_authority_busy");
        } finally {
            fs.rmSync(assetBusyHarness.root, { recursive: true, force: true });
        }

        const settingsBusyHarness = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                settingsBusyHarness.transactionsRoot,
                exactAnalysisValidator(settingsBusyHarness.analysis),
            );
            const service = createReverseAcceptServiceForTest(settingsBusyHarness.configuration(), store, undefined, {
                acquireSettingsLock: () => null,
            });
            await prepare(service);
            expect(
                (await service.commitRenderedTargetAccept(commitRequest(settingsBusyHarness.analysis))).diagnostics[0]?.code,
            ).toBe("reverse_accept.settings_authority_busy");
        } finally {
            fs.rmSync(settingsBusyHarness.root, { recursive: true, force: true });
        }

        const operationBusyHarness = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                operationBusyHarness.transactionsRoot,
                exactAnalysisValidator(operationBusyHarness.analysis),
            );
            let calls = 0;
            const service = createReverseAcceptServiceForTest(operationBusyHarness.configuration(), store, () => {
                calls += 1;
                return calls === 1 ? { release() {} } : null;
            });
            await prepare(service);
            expect(
                (await service.commitRenderedTargetAccept(commitRequest(operationBusyHarness.analysis))).diagnostics[0]?.code,
            ).toBe("reverse_accept.preparation_busy");
        } finally {
            fs.rmSync(operationBusyHarness.root, { recursive: true, force: true });
        }

        const targetBusyHarness = createHarness();
        try {
            const store = createReverseAcceptMarkerStore(
                targetBusyHarness.transactionsRoot,
                exactAnalysisValidator(targetBusyHarness.analysis),
            );
            let calls = 0;
            const service = createReverseAcceptServiceForTest(targetBusyHarness.configuration(), store, () => {
                calls += 1;
                return calls < 3 ? { release() {} } : null;
            });
            await prepare(service);
            expect(
                (await service.commitRenderedTargetAccept(commitRequest(targetBusyHarness.analysis))).diagnostics[0]?.code,
            ).toBe("reverse_accept.target_busy");
        } finally {
            fs.rmSync(targetBusyHarness.root, { recursive: true, force: true });
        }

        const resolverHarness = createHarness();
        try {
            const resolverDiagnostic = {
                severity: "error" as const,
                code: "fixture.render_blocked",
                message: "fixture render blocked",
                path: "",
                traceId: "",
                operation: "reverse_accept" as const,
                causeKind: "conflict" as const,
                retryable: true,
                suggestedActions: ["refresh"],
                rawSummary: "fixture render blocked",
            };
            const service = createReverseAcceptService(
                resolverHarness.configuration({
                    resolveFreshCommit: async () => ({
                        status: "failed",
                        value: null as never,
                        diagnostics: [resolverDiagnostic],
                    }),
                }),
            );
            await prepare(service);
            const result = await service.commitRenderedTargetAccept(commitRequest(resolverHarness.analysis));
            expect(result.diagnostics).toEqual([resolverDiagnostic]);
        } finally {
            fs.rmSync(resolverHarness.root, { recursive: true, force: true });
        }

        for (const [label, value] of [
            ["missing draft", null],
            ["missing lock closure", { deployment: {}, successCommit: null }],
        ] as const) {
            const malformedDraftHarness = createHarness();
            try {
                const service = createReverseAcceptService(
                    malformedDraftHarness.configuration({
                        resolveFreshCommit: async () => ({
                            status: "complete",
                            value: value as never,
                            diagnostics: [],
                        }),
                    }),
                );
                await prepare(service);
                const result = await service.commitRenderedTargetAccept(commitRequest(malformedDraftHarness.analysis));
                expect(result.status, label).toBe("failed");
                expect(result.diagnostics[0]?.code, label).toBe("reverse_accept.invalid_commit_draft");
            } finally {
                fs.rmSync(malformedDraftHarness.root, { recursive: true, force: true });
            }
        }

        const staleHarness = createHarness();
        try {
            const service = createReverseAcceptService(staleHarness.configuration());
            await prepare(service);
            expect(
                (
                    await service.commitRenderedTargetAccept({
                        ...commitRequest(staleHarness.analysis),
                        expectedPreparationRevision: 2,
                    })
                ).diagnostics[0]?.code,
            ).toBe("reverse_accept.revision_stale");
            await service.cancelRenderedTargetAccept({
                preparationId: PREPARATION_ID,
                expectedPreparationRevision: 1,
            });
            expect((await service.commitRenderedTargetAccept(commitRequest(staleHarness.analysis))).diagnostics[0]?.code).toBe(
                "reverse_accept.preparation_terminal",
            );
        } finally {
            fs.rmSync(staleHarness.root, { recursive: true, force: true });
        }

        const identityHarness = createHarness();
        try {
            const base = createReverseAcceptMarkerStore(
                identityHarness.transactionsRoot,
                exactAnalysisValidator(identityHarness.analysis),
            );
            let reads = 0;
            const store = {
                ...base,
                readMarker(preparationId: UuidV4) {
                    const result = base.readMarker(preparationId);
                    reads += 1;
                    if (reads !== 2 || result.state !== "available" || result.value.preparationState !== "prepared") {
                        return result;
                    }
                    const identity = buildReverseAcceptPreparationIdentity({
                        preparationId: result.value.identity.preparationId,
                        deploymentId: PREPARATION_ID,
                        commitTransactionId: result.value.identity.commitTransactionId,
                        assetIds: result.value.identity.assetIds,
                    });
                    const { markerFingerprint: _fingerprint, ...preimage } = result.value;
                    const changed = { ...preimage, identity };
                    return {
                        state: "available" as const,
                        value: {
                            ...changed,
                            markerFingerprint: computeReverseAcceptMarkerFingerprint(changed),
                        },
                    };
                },
            };
            const service = createReverseAcceptServiceForTest(identityHarness.configuration(), store);
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(identityHarness.analysis))).diagnostics[0]?.code).toBe(
                "reverse_accept.identity_changed",
            );
        } finally {
            fs.rmSync(identityHarness.root, { recursive: true, force: true });
        }

        const collisionHarness = createHarness("requires_current_authorization");
        try {
            const service = createReverseAcceptService(
                collisionHarness.configuration({
                    newUuid: sequenceUuid([PREPARATION_ID, TRANSACTION_UUID, STAGED_VERSION_ID, PREPARATION_ID]),
                }),
            );
            await prepare(service);
            const request = commitRequest(collisionHarness.analysis);
            request.newVersionPromotion = {
                promotionAction: "grant_staged_version_current_target",
            };
            expect((await service.commitRenderedTargetAccept(request)).diagnostics[0]?.code).toBe(
                "reverse_accept.uuid_collision",
            );
        } finally {
            fs.rmSync(collisionHarness.root, { recursive: true, force: true });
        }

        const expiredHarness = createHarness();
        try {
            let clock = 10_000;
            const service = createReverseAcceptService(expiredHarness.configuration({ now: () => clock }));
            await prepare(service);
            clock = 11_000;
            expect((await service.commitRenderedTargetAccept(commitRequest(expiredHarness.analysis))).diagnostics[0]?.code).toBe(
                "reverse_accept.preparation_expired",
            );
        } finally {
            fs.rmSync(expiredHarness.root, { recursive: true, force: true });
        }

        const invalidClockHarness = createHarness();
        try {
            let clock = 10_000;
            const service = createReverseAcceptService(invalidClockHarness.configuration({ now: () => clock }));
            await prepare(service);
            clock = -1;
            expect(
                (await service.commitRenderedTargetAccept(commitRequest(invalidClockHarness.analysis))).diagnostics[0]?.code,
            ).toBe("reverse_accept.invalid_clock");
        } finally {
            fs.rmSync(invalidClockHarness.root, { recursive: true, force: true });
        }
    });
});
