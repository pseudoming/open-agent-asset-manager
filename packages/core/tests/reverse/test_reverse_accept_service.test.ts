import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoreResult } from "../../src/contracts/core-service";
import type { RenderAnalysisView } from "../../src/contracts/render";
import type { Sha256Digest, UuidV4 } from "../../src/types";
import { acquireAllLocks, computeDeploymentOperationKey } from "../../src/foundation/physical-path-locks";
import { computeAssetManifestAuthoritySetFingerprint, stableStringify } from "../../src/foundation/fingerprint";
import {
    ReverseAcceptMarkerStoreError,
    buildPreparedReverseAcceptMarker,
    buildReverseAcceptPreparationIdentity,
    createReverseAcceptMarkerStore,
    createReverseAcceptMarkerStoreForTest,
    type ReverseAcceptRenderAnalysisValidator,
    type ReverseAcceptMarkerStore,
} from "../../src/reverse/reverse-accept-marker";
import {
    createReverseAcceptService,
    createReverseAcceptServiceForTest,
    type FreshReverseAcceptPreparationDraft,
    type ReverseAcceptServiceConfiguration,
} from "../../src/reverse/reverse-accept-service";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-dialect-registry";

const PREPARATION_ID = "00000000-0000-4000-8000-000000000201" as UuidV4;
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000202" as UuidV4;
const STAGED_VERSION_ID = "00000000-0000-4000-8000-000000000203" as UuidV4;
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000204" as UuidV4;
const OTHER_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000208" as UuidV4;
const ASSET_A = "00000000-0000-4000-8000-000000000205" as UuidV4;
const ASSET_B = "00000000-0000-4000-8000-000000000206" as UuidV4;
const PREVIOUS_VERSION_ID = "00000000-0000-4000-8000-000000000207" as UuidV4;
const HASH_1 = `sha256:${"1".repeat(64)}` as Sha256Digest;
const HASH_2 = `sha256:${"2".repeat(64)}` as Sha256Digest;
const HASH_3 = `sha256:${"3".repeat(64)}` as Sha256Digest;
const HASH_4 = `sha256:${"4".repeat(64)}` as Sha256Digest;

const ANALYSIS: RenderAnalysisView = {
    renderInputFingerprint: HASH_4,
    requiredSemantics: [],
    analyses: [],
};
const ANALYSIS_VALIDATOR: ReverseAcceptRenderAnalysisValidator = {
    validate(value: unknown): asserts value is RenderAnalysisView {
        if (stableStringify(value) !== stableStringify(ANALYSIS)) {
            throw new Error("render analysis fixture mismatch");
        }
    },
};

let sandbox = "";
let transactionsRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-reverse-service-"));
    transactionsRoot = path.join(sandbox, "transactions");
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function draft(overrides: Partial<FreshReverseAcceptPreparationDraft> = {}): FreshReverseAcceptPreparationDraft {
    return {
        deploymentAuthorityFingerprint: HASH_1,
        // Deliberately reverse arrival order: Core owns canonical sorting.
        assetManifestAuthorities: [
            { assetId: ASSET_B, assetManifestAuthorityFingerprint: HASH_2 },
            { assetId: ASSET_A, assetManifestAuthorityFingerprint: HASH_1 },
        ],
        inspectionScopeFingerprint: HASH_2,
        inspectionResultFingerprint: HASH_3,
        stagedAssetId: ASSET_A,
        stagedVersionFingerprint: HASH_4,
        stagedVersionOriginDraft: {
            previousVersionId: PREVIOUS_VERSION_ID,
            previousVersionOriginAuthorityFingerprint: HASH_2,
            promotionRequirement: "requires_current_authorization",
        },
        promotionState: "user_confirmation_required",
        renderAnalysis: ANALYSIS,
        ...overrides,
    };
}

function completeDraft(
    value = draft(),
    status: "complete" | "partial" = "complete",
): CoreResult<FreshReverseAcceptPreparationDraft> {
    return {
        status,
        value,
        diagnostics:
            status === "partial"
                ? [
                      {
                          severity: "warning",
                          code: "fixture.partial",
                          message: "fixture partial",
                          path: "",
                          traceId: "",
                          operation: "reverse_accept",
                          causeKind: "partial",
                          retryable: false,
                          suggestedActions: ["choose_target"],
                          rawSummary: "fixture partial",
                      },
                  ]
                : [],
    };
}

function configuration(overrides: Partial<ReverseAcceptServiceConfiguration> = {}): ReverseAcceptServiceConfiguration {
    const ids = [PREPARATION_ID, TRANSACTION_ID, STAGED_VERSION_ID];
    return {
        transactionsRoot,
        assetsRoot: path.join(sandbox, "assets"),
        deploymentsRoot: path.join(sandbox, "deployments"),
        authorityLocksRoot: path.join(sandbox, "authority-locks"),
        databasePath: path.join(sandbox, "state.db"),
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        preparationTtlMs: 1_000,
        renderAnalysisValidator: ANALYSIS_VALIDATOR,
        resolveFreshPreparation: async () => completeDraft(),
        resolveFreshCommit: async () => ({
            status: "failed",
            value: null as never,
            diagnostics: [],
        }),
        now: () => 10_000,
        newUuid: () => ids.shift()!,
        ...overrides,
    };
}

function preparedMarkerForDeployment(deploymentId: UuidV4) {
    const source = draft();
    const assetManifestAuthorities = [...source.assetManifestAuthorities].sort((left, right) =>
        left.assetId.localeCompare(right.assetId),
    );
    const identity = buildReverseAcceptPreparationIdentity({
        preparationId: PREPARATION_ID,
        deploymentId,
        commitTransactionId: TRANSACTION_ID,
        assetIds: assetManifestAuthorities.map((item) => item.assetId),
    });
    return buildPreparedReverseAcceptMarker(
        {
            identity,
            preparedAt: 10_000,
            expiresAt: 11_000,
            deploymentAuthorityFingerprint: source.deploymentAuthorityFingerprint,
            assetManifestAuthorities,
            assetManifestAuthoritySetFingerprint: computeAssetManifestAuthoritySetFingerprint(assetManifestAuthorities),
            inspectionScopeFingerprint: source.inspectionScopeFingerprint,
            inspectionResultFingerprint: source.inspectionResultFingerprint,
            stagedAssetId: source.stagedAssetId,
            stagedVersionId: STAGED_VERSION_ID,
            stagedVersionFingerprint: source.stagedVersionFingerprint,
            stagedVersionOriginDraft: source.stagedVersionOriginDraft,
            renderAnalysis: source.renderAnalysis,
        },
        ANALYSIS_VALIDATOR,
    );
}

async function prepare(service = createReverseAcceptService(configuration())) {
    return service.prepareRenderedTargetAccept({
        deploymentId: DEPLOYMENT_ID,
        inspectionResultFingerprint: HASH_3,
    });
}

describe("reverse-accept prepare/cancel service", () => {
    it("publishes only prepared marker/locator and returns the minimal public view", async () => {
        let resolverInput: unknown;
        const service = createReverseAcceptService(
            configuration({
                resolveFreshPreparation: async (input) => {
                    resolverInput = input;
                    return completeDraft();
                },
            }),
        );
        const result = await prepare(service);
        expect(result).toEqual({
            status: "complete",
            value: {
                preparationState: "prepared",
                preparationId: PREPARATION_ID,
                preparationRevision: 1,
                expiresAt: 11_000,
                promotionState: "user_confirmation_required",
                renderAnalysis: ANALYSIS,
            },
            diagnostics: [],
        });
        expect(resolverInput).toMatchObject({
            request: {
                deploymentId: DEPLOYMENT_ID,
                inspectionResultFingerprint: HASH_3,
            },
            preparationId: PREPARATION_ID,
            commitTransactionId: TRANSACTION_ID,
            stagedVersionId: STAGED_VERSION_ID,
        });

        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const marker = store.readMarker(PREPARATION_ID);
        expect(marker.state).toBe("available");
        if (marker.state === "available" && marker.value.preparationState === "prepared") {
            expect(marker.value.identity.assetIds).toEqual([ASSET_A, ASSET_B]);
            expect(marker.value.stagedVersionId).toBe(STAGED_VERSION_ID);
            expect(marker.value.stagedVersionOriginDraft).toEqual(draft().stagedVersionOriginDraft);
        }
        expect(store.readLocator(PREPARATION_ID).state).toBe("available");
        expect(fs.existsSync(path.join(sandbox, "assets"))).toBe(false);
        expect(fs.existsSync(path.join(sandbox, "state.db"))).toBe(false);
    });

    it("preserves a truthful partial result after durable preparation", async () => {
        const service = createReverseAcceptService(
            configuration({
                resolveFreshPreparation: async () => completeDraft(draft(), "partial"),
            }),
        );
        const result = await prepare(service);
        expect(result.status).toBe("partial");
        expect(result.value.preparationState).toBe("prepared");
        expect(result.diagnostics.map((item) => item.code)).toEqual(["fixture.partial"]);
    });

    it("accepts a no-promotion origin only as already authorized", async () => {
        const service = createReverseAcceptService(
            configuration({
                resolveFreshPreparation: async () =>
                    completeDraft(
                        draft({
                            stagedVersionOriginDraft: {
                                previousVersionId: PREVIOUS_VERSION_ID,
                                previousVersionOriginAuthorityFingerprint: HASH_2,
                                promotionRequirement: "not_required",
                            },
                            promotionState: "already_authorized",
                        }),
                    ),
            }),
        );
        const result = await prepare(service);
        expect(result.status).toBe("complete");
        expect(result.value).toMatchObject({
            preparationState: "prepared",
            promotionState: "already_authorized",
        });
    });

    it("does not publish marker or locator when fresh resolution fails", async () => {
        const service = createReverseAcceptService(
            configuration({
                resolveFreshPreparation: async () => ({
                    status: "failed",
                    value: draft(),
                    diagnostics: [
                        {
                            severity: "error",
                            code: "fixture.failed",
                            message: "fresh resolution failed",
                            path: "",
                            traceId: "",
                            operation: "reverse_accept",
                            causeKind: "conflict",
                            retryable: false,
                            suggestedActions: ["retry"],
                            rawSummary: "fresh resolution failed",
                        },
                    ],
                }),
            }),
        );
        const result = await prepare(service);
        expect(result).toMatchObject({
            status: "failed",
            value: { preparationState: "not_prepared" },
        });
        expect(result.diagnostics[0]?.code).toBe("fixture.failed");
        expect(fs.existsSync(transactionsRoot)).toBe(false);
    });

    it("does not return prepared when marker is durable but locator publication fails", async () => {
        const config = configuration();
        const store = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            beforeLocatorPublish: () => {
                throw new Error("locator-fault");
            },
        });
        const service = createReverseAcceptServiceForTest(config, store);
        const result = await prepare(service);
        expect(result).toMatchObject({
            status: "failed",
            value: { preparationState: "not_prepared" },
        });
        expect(result.diagnostics[0]?.message).toContain("locator-fault");
        expect(store.readMarker(PREPARATION_ID).state).toBe("available");
        expect(store.readLocator(PREPARATION_ID)).toEqual({ state: "missing" });
    });

    it("cancels exactly one prepared revision and keeps locator identity", async () => {
        const service = createReverseAcceptService(configuration());
        await prepare(service);
        const result = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });
        expect(result).toEqual({ status: "complete", value: undefined, diagnostics: [] });
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const marker = store.readMarker(PREPARATION_ID);
        expect(marker.state).toBe("available");
        if (marker.state === "available") {
            expect(marker.value.preparationState).toBe("cancelled");
            expect(marker.value.preparationRevision).toBe(2);
        }
        expect(store.readLocator(PREPARATION_ID).state).toBe("available");

        const repeated = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });
        expect(repeated.status).toBe("failed");
        expect(repeated.diagnostics[0]?.code).toBe("reverse_accept.preparation_terminal");
    });

    it("marks an elapsed preparation expired instead of cancelling it", async () => {
        let clock = 10_000;
        const service = createReverseAcceptService(configuration({ now: () => clock }));
        await prepare(service);
        clock = 11_000;
        const result = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("reverse_accept.preparation_expired");
        const marker = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR).readMarker(PREPARATION_ID);
        expect(marker.state).toBe("available");
        if (marker.state === "available") expect(marker.value.preparationState).toBe("expired");
    });

    it("fails closed when the cancellation clock becomes invalid", async () => {
        let clock = 10_000;
        const service = createReverseAcceptService(configuration({ now: () => clock }));
        await prepare(service);
        clock = -1;
        const result = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("reverse_accept.invalid_clock");
    });

    it("rejects stale cancellation before mutation", async () => {
        const service = createReverseAcceptService(configuration());
        await prepare(service);
        const result = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 2,
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("reverse_accept.revision_stale");
        const marker = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR).readMarker(PREPARATION_ID);
        expect(marker.state).toBe("available");
        if (marker.state === "available") expect(marker.value.preparationState).toBe("prepared");
    });

    it("uses the deployment operation mutex so ordinary deploy or commit blocks cancel", async () => {
        const service = createReverseAcceptService(configuration());
        await prepare(service);
        const operationLock = acquireAllLocks(transactionsRoot, [computeDeploymentOperationKey(DEPLOYMENT_ID)]);
        expect(operationLock).not.toBeNull();
        try {
            const result = await service.cancelRenderedTargetAccept({
                preparationId: PREPARATION_ID,
                expectedPreparationRevision: 1,
            });
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toBe("reverse_accept.preparation_busy");
        } finally {
            operationLock?.release();
        }
    });

    it("uses the ordinary deployment operation mutex before publishing a preparation", async () => {
        const operationLock = acquireAllLocks(transactionsRoot, [computeDeploymentOperationKey(DEPLOYMENT_ID)]);
        expect(operationLock).not.toBeNull();
        try {
            const result = await prepare(createReverseAcceptService(configuration()));
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toBe("reverse_accept.preparation_busy");
            expect(createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR).readMarker(PREPARATION_ID)).toEqual({
                state: "missing",
            });
        } finally {
            operationLock?.release();
        }
    });

    it("fails closed when marker is missing or corrupt and never uses locator as state authority", async () => {
        const service = createReverseAcceptService(configuration());
        const missing = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });
        expect(missing.diagnostics[0]?.code).toBe("reverse_accept.marker_unavailable");

        await prepare(service);
        const markerPath = path.join(transactionsRoot, "reverse-accept", PREPARATION_ID, "marker.json");
        fs.writeFileSync(markerPath, "{corrupt");
        const corrupt = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });
        expect(corrupt.diagnostics[0]?.code).toBe("reverse_accept.marker_unavailable");
    });

    it("rechecks the marker after acquiring the mutex instead of trusting the initial read", async () => {
        const producer = createReverseAcceptService(configuration());
        await prepare(producer);
        const base = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        let reads = 0;
        const changingStore: ReverseAcceptMarkerStore = {
            ...base,
            readMarker(preparationId) {
                reads += 1;
                return reads === 1 ? base.readMarker(preparationId) : { state: "missing" };
            },
        };
        const service = createReverseAcceptServiceForTest(configuration(), changingStore);
        const result = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("reverse_accept.marker_unavailable");
        expect(reads).toBe(2);
    });

    it("fails closed when preparation identity changes while acquiring its Deployment mutex", async () => {
        const producer = createReverseAcceptService(configuration());
        await prepare(producer);
        const base = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const locatorPath = path.join(transactionsRoot, "reverse-accept-locators", `${PREPARATION_ID}.json`);
        const locatorBefore = fs.readFileSync(locatorPath);
        const replacement = preparedMarkerForDeployment(OTHER_DEPLOYMENT_ID);
        let reads = 0;
        const changingStore: ReverseAcceptMarkerStore = {
            ...base,
            readMarker(preparationId) {
                reads += 1;
                return reads === 1 ? base.readMarker(preparationId) : { state: "available", value: replacement };
            },
        };
        const service = createReverseAcceptServiceForTest(configuration(), changingStore);
        const result = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("reverse_accept.identity_changed");
        expect(reads).toBe(2);
        expect(fs.readFileSync(locatorPath)).toEqual(locatorBefore);
        expect(base.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "prepared" },
        });
    });

    it("repairs a missing locator under the mutex before cancellation", async () => {
        const service = createReverseAcceptService(configuration());
        await prepare(service);
        const locatorPath = path.join(transactionsRoot, "reverse-accept-locators", `${PREPARATION_ID}.json`);
        fs.rmSync(locatorPath);
        const result = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
        });
        expect(result.status).toBe("complete");
        expect(fs.existsSync(locatorPath)).toBe(true);
    });

    it("validates public input, identity allocation, clock, and TTL before claiming success", async () => {
        const invalidInput = createReverseAcceptService(configuration());
        expect(
            await invalidInput.prepareRenderedTargetAccept({
                deploymentId: "bad" as UuidV4,
                inspectionResultFingerprint: HASH_3,
            }),
        ).toMatchObject({ status: "failed", value: { preparationState: "not_prepared" } });

        const invalidUuid = createReverseAcceptService(configuration({ newUuid: () => "bad" as UuidV4 }));
        expect((await prepare(invalidUuid)).diagnostics[0]?.code).toBe("reverse_accept.invalid_uuid");

        const duplicateUuid = createReverseAcceptService(configuration({ newUuid: () => PREPARATION_ID }));
        expect((await prepare(duplicateUuid)).diagnostics[0]?.code).toBe("reverse_accept.uuid_collision");

        const ids = [PREPARATION_ID, TRANSACTION_ID, PREVIOUS_VERSION_ID];
        const reusedPreviousVersion = createReverseAcceptService(configuration({ newUuid: () => ids.shift()! }));
        expect((await prepare(reusedPreviousVersion)).diagnostics[0]?.code).toBe("reverse_accept.uuid_collision");

        const invalidClock = createReverseAcceptService(configuration({ now: () => -1 }));
        expect((await prepare(invalidClock)).diagnostics[0]?.code).toBe("reverse_accept.invalid_clock");

        const overflow = createReverseAcceptService(configuration({ now: () => Number.MAX_SAFE_INTEGER }));
        expect((await prepare(overflow)).diagnostics[0]?.code).toBe("reverse_accept.invalid_ttl");
    });

    it("rejects invalid configuration, fresh draft variants, and invalid cancel input", async () => {
        expect(() => createReverseAcceptService(configuration({ preparationTtlMs: 0 }))).toThrow(/positive safe integer/);
        for (const [label, root] of [
            ["empty", ""],
            ["nul", `${sandbox}/bad\0root`],
            ["relative", "relative/root"],
            ["noncanonical", `${sandbox}/../authority`],
            ["trailing separator", `${sandbox}${path.sep}`],
            ["filesystem root", path.parse(sandbox).root],
        ] as const) {
            expect(() => createReverseAcceptService(configuration({ assetsRoot: root })), label).toThrow(
                /canonical absolute path/,
            );
        }
        for (const field of ["transactionsRoot", "deploymentsRoot", "authorityLocksRoot", "databasePath"] as const) {
            expect(() => createReverseAcceptService(configuration({ [field]: "relative/root" })), field).toThrow(
                /canonical absolute path/,
            );
        }

        const invalidDrafts: FreshReverseAcceptPreparationDraft[] = [
            null as never,
            { ...draft(), unexpected: true } as FreshReverseAcceptPreparationDraft,
            draft({ inspectionResultFingerprint: HASH_4 }),
            draft({ stagedAssetId: "bad" as UuidV4 }),
            draft({ stagedAssetId: PREVIOUS_VERSION_ID }),
            draft({ assetManifestAuthorities: [] }),
            draft({ assetManifestAuthorities: [null as never] }),
            draft({
                assetManifestAuthorities: [
                    {
                        assetId: ASSET_A,
                        assetManifestAuthorityFingerprint: HASH_1,
                        unexpected: true,
                    } as never,
                ],
            }),
            draft({
                assetManifestAuthorities: [{ assetId: "bad" as UuidV4, assetManifestAuthorityFingerprint: HASH_1 }],
            }),
            draft({
                assetManifestAuthorities: [{ assetId: ASSET_A, assetManifestAuthorityFingerprint: "bad" as Sha256Digest }],
            }),
            draft({
                assetManifestAuthorities: [
                    { assetId: ASSET_A, assetManifestAuthorityFingerprint: HASH_1 },
                    { assetId: ASSET_A, assetManifestAuthorityFingerprint: HASH_2 },
                ],
            }),
            draft({
                promotionState: "bad" as FreshReverseAcceptPreparationDraft["promotionState"],
            }),
            draft({ deploymentAuthorityFingerprint: "bad" as Sha256Digest }),
            draft({
                stagedVersionOriginDraft: {
                    previousVersionId: "bad" as UuidV4,
                    previousVersionOriginAuthorityFingerprint: HASH_2,
                    promotionRequirement: "not_required",
                },
            }),
            draft({
                stagedVersionOriginDraft: {
                    previousVersionId: PREVIOUS_VERSION_ID,
                    previousVersionOriginAuthorityFingerprint: "bad" as Sha256Digest,
                    promotionRequirement: "not_required",
                },
            }),
            draft({
                stagedVersionOriginDraft: {
                    previousVersionId: PREVIOUS_VERSION_ID,
                    previousVersionOriginAuthorityFingerprint: HASH_2,
                    promotionRequirement: "bad" as never,
                },
            }),
            draft({
                stagedVersionOriginDraft: {
                    previousVersionId: PREVIOUS_VERSION_ID,
                    previousVersionOriginAuthorityFingerprint: HASH_2,
                    promotionRequirement: "not_required",
                    unexpected: true,
                } as never,
                promotionState: "already_authorized",
            }),
            draft({
                stagedVersionOriginDraft: {
                    previousVersionId: PREVIOUS_VERSION_ID,
                    previousVersionOriginAuthorityFingerprint: HASH_2,
                    promotionRequirement: "not_required",
                },
            }),
            draft({ renderAnalysis: { ...ANALYSIS, analyses: [{ bad: true }] } as never }),
        ];
        for (const invalid of invalidDrafts) {
            const service = createReverseAcceptService(
                configuration({ resolveFreshPreparation: async () => completeDraft(invalid) }),
            );
            expect((await prepare(service)).status).toBe("failed");
        }

        const service = createReverseAcceptService(configuration());
        const extraPrepare = await service.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: HASH_3,
            unexpected: true,
        } as never);
        expect(extraPrepare.diagnostics[0]?.code).toBe("reverse_accept.invalid_prepare_input");
        const invalidCancel = await service.cancelRenderedTargetAccept({
            preparationId: "bad" as UuidV4,
            expectedPreparationRevision: 0,
        });
        expect(invalidCancel.diagnostics[0]?.code).toBe("reverse_accept.invalid_cancel_input");
        const extraCancel = await service.cancelRenderedTargetAccept({
            preparationId: PREPARATION_ID,
            expectedPreparationRevision: 1,
            unexpected: true,
        } as never);
        expect(extraCancel.diagnostics[0]?.code).toBe("reverse_accept.invalid_cancel_input");
    });

    it("maps a busy prepare mutex and an unexpected marker failure to typed diagnostics", async () => {
        const busy = createReverseAcceptServiceForTest(
            configuration(),
            createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR),
            () => null,
        );
        expect((await prepare(busy)).diagnostics[0]?.code).toBe("reverse_accept.preparation_busy");

        const explodingStore = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            beforeMarkerPublish: () => {
                throw "non-error";
            },
        });
        const exploding = createReverseAcceptServiceForTest(configuration(), explodingStore);
        const result = await prepare(exploding);
        expect(result.diagnostics[0]?.code).toBe("reverse_accept.internal_failure");
        expect(result.diagnostics[0]?.message).toBe("unknown reverse-accept failure");
    });

    it("maps marker-store CAS/state and availability failures without exposing internal evidence", async () => {
        for (const [code, expectedCause] of [
            ["marker_revision_stale", "conflict"],
            ["marker_state_conflict", "conflict"],
            ["marker_exists", "unavailable"],
        ] as const) {
            const base = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
            const faulting: ReverseAcceptMarkerStore = {
                ...base,
                publishPrepared() {
                    throw new ReverseAcceptMarkerStoreError(code, `fault ${code}`);
                },
            };
            const service = createReverseAcceptServiceForTest(configuration(), faulting);
            const result = await prepare(service);
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]).toMatchObject({
                code: `reverse_accept.${code}`,
                causeKind: expectedCause,
            });
        }
    });

    it("uses production clock and UUID defaults when tests do not override them", async () => {
        const config = configuration();
        delete config.now;
        delete config.newUuid;
        let resolvedIds: { preparationId: UuidV4; commitTransactionId: UuidV4; stagedVersionId: UuidV4 } | undefined;
        config.resolveFreshPreparation = async (input) => {
            resolvedIds = {
                preparationId: input.preparationId,
                commitTransactionId: input.commitTransactionId,
                stagedVersionId: input.stagedVersionId,
            };
            return completeDraft();
        };
        const before = Date.now();
        const result = await prepare(createReverseAcceptService(config));
        const after = Date.now();
        expect(result.status).toBe("complete");
        expect(result.value.preparationState).toBe("prepared");
        if (result.value.preparationState === "prepared") {
            expect(result.value.expiresAt).toBeGreaterThanOrEqual(before + 1_000);
            expect(result.value.expiresAt).toBeLessThanOrEqual(after + 1_000);
        }
        expect(resolvedIds).toBeDefined();
        expect(new Set(Object.values(resolvedIds!)).size).toBe(3);
    });
});
