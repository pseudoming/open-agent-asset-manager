import { describe, expect, it } from "vitest";
import {
    type AssetSummaryView,
    buildAssetUsageAnalysisRequests,
    buildDeploymentCreateRequest,
    buildRenderSelection,
    collectDeploymentTargets,
    collectDeploymentToolObservations,
    currentProjectPromotionAuthorization,
    deploymentTargetMatchesSubject,
    deploymentTargetSemanticKey,
    type ProjectView,
    projectRenderReview,
    type RenderAnalysisView,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import type { AdapterProviderView } from "../src/renderer/features/discovery/discovery-model";
import { localizedText } from "../src/renderer/presentation";
import { DEPLOYMENT_PROVIDERS, PROBE_REVIEW, SHA_A, SHA_B, SHA_C } from "./catalog-deployment-test-fixtures";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";

const PROJECT: ProjectView = {
    projectId: PROJECT_ID,
    displayName: "OAAM",
    rootPath: "/workspace/oaam",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

const ASSET: AssetSummaryView = {
    assetId: ASSET_ID,
    kind: "Guidance",
    scope: "project",
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guidance",
    displayDescription: "Current project guidance",
    currentVersionId: VERSION_ID,
    currentRevision: 2,
    currentFingerprint: SHA_A,
    currentVersionStatus: "complete",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

const INCOMPLETE_ASSET: AssetSummaryView = {
    ...ASSET,
    assetId: "55555555-5555-4555-8555-555555555555",
    currentVersionId: "66666666-6666-4666-8666-666666666666",
    displayName: "Incomplete workflow",
    kind: "Workflow",
    currentVersionStatus: "incomplete",
};

const RENDER_ANALYSIS: RenderAnalysisView = {
    deploymentId: DEPLOYMENT_ID,
    renderInputFingerprint: SHA_A,
    semantics: [
        {
            semanticRefFingerprint: SHA_A,
            consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
            semanticKind: "guidance.content",
            subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
        },
    ],
    outputUnits: [
        {
            outputUnitFingerprint: SHA_B,
            claims: [{ relativePath: "CLAUDE.md", contentKind: "text", executable: false }],
            managedDirectoryPaths: [],
        },
    ],
    options: [
        {
            optionFingerprint: SHA_B,
            semanticRefFingerprint: SHA_A,
            renderStrategy: "native_file",
            actualReverseExtractPolicy: "can_reconcile",
            requiredOutputUnitFingerprints: [SHA_B],
            outcome: "preserved",
            approvalState: "not_required",
            reasonCode: "native",
            diagnostics: [],
        },
        {
            optionFingerprint: SHA_C,
            semanticRefFingerprint: SHA_A,
            renderStrategy: "inline",
            actualReverseExtractPolicy: "unsupported",
            requiredOutputUnitFingerprints: [SHA_B],
            outcome: "degraded",
            degradationKinds: ["runtime_specific_metadata_lost"],
            approvalState: "required",
            approvalConcerns: ["semantic_degradation", "reverse_extract_unsupported"],
            approvalFingerprint: SHA_C,
            reasonCode: "degraded",
            diagnostics: [],
        },
    ],
    promotionAuthorizationInspections: [],
    blockedSemantics: [],
    diagnostics: [],
};

const FIRST_RENDER_OPTION = RENDER_ANALYSIS.options[0];
if (FIRST_RENDER_OPTION === undefined) throw new Error("render fixture requires one option");

describe("Desktop catalog and deployment request model", () => {
    it("uses only the exact Core authorization inspection for the current Project target", () => {
        const target = collectDeploymentTargets(PROBE_REVIEW)[0];
        if (target === undefined) throw new Error("exact Project target is required");
        const deployment: DeploymentView = {
            deploymentId: DEPLOYMENT_ID,
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            environment: { platform: "linux", platformInstanceId: "local" },
            targetRootPath: PROJECT.rootPath,
            stage: "blocked",
            reason: "review",
            actionHints: ["review_deployment"],
            freshness: { state: "never", attemptedAt: 0, lastCompleteAt: 0 },
            deleted: false,
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
            createdAt: 1,
            updatedAt: 2,
        };
        const inspection = {
            promotionAuthorizationState: "required" as const,
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            target: { targetKind: "project" as const, projectId: PROJECT_ID },
            versionOriginAuthorityFingerprint: SHA_A,
        };
        const authorize = (analysis: RenderAnalysisView) =>
            currentProjectPromotionAuthorization({
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                target,
                deployment,
                asset: ASSET,
                analysis,
            });
        expect(authorize({ ...RENDER_ANALYSIS, promotionAuthorizationInspections: [inspection] })).toEqual({
            status: "required",
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            projectId: PROJECT_ID,
        });
        expect(
            authorize({
                ...RENDER_ANALYSIS,
                promotionAuthorizationInspections: [
                    {
                        ...inspection,
                        promotionAuthorizationState: "authorized",
                        authorizationSource: "version_target_grant",
                        authorityId: PROJECT_ID,
                        authorityRevision: 1,
                        authorityFingerprint: SHA_B,
                    },
                ],
            }),
        ).toEqual({ status: "authorized" });
        expect(
            authorize({
                ...RENDER_ANALYSIS,
                promotionAuthorizationInspections: [{ ...inspection, promotionAuthorizationState: "not_required" }],
            }),
        ).toEqual({ status: "not_applicable" });
        expect(
            authorize({
                ...RENDER_ANALYSIS,
                promotionAuthorizationInspections: [
                    {
                        promotionAuthorizationState: "unavailable",
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        target: inspection.target,
                        diagnosticCode: "render.promotion_authority_unavailable",
                    },
                ],
            }),
        ).toEqual({ status: "unavailable" });
        for (const wrong of [
            { ...inspection, assetId: INCOMPLETE_ASSET.assetId },
            { ...inspection, versionId: INCOMPLETE_ASSET.currentVersionId },
            {
                ...inspection,
                target: { targetKind: "project" as const, projectId: "77777777-7777-4777-8777-777777777777" },
            },
        ]) {
            expect(authorize({ ...RENDER_ANALYSIS, promotionAuthorizationInspections: [wrong] })).toEqual({
                status: "invalid",
            });
        }
        expect(authorize({ ...RENDER_ANALYSIS, promotionAuthorizationInspections: [inspection, inspection] })).toEqual({
            status: "invalid",
        });
    });

    it("projects exact current target/runtime/Version identities and rejects every implicit default", () => {
        const targets = collectDeploymentTargets(PROBE_REVIEW);
        expect(collectDeploymentTargets(undefined)).toEqual([]);
        expect(targets).toEqual([
            expect.objectContaining({
                key: deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "target-candidate"),
                probeToken: "probe-token",
                readyAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                unavailableAgentRuntimeIds: ["CLAUDE_CODE_APP"],
            }),
            expect.objectContaining({
                key: deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "unready-candidate"),
                readyAgentRuntimeIds: [],
            }),
        ]);
        expect(collectDeploymentTargets({ ...PROBE_REVIEW, probeToken: "replacement-token" })[0]?.key).toBe(targets[0]?.key);
        expect(
            currentProjectPromotionAuthorization({
                subject: { subjectKind: "global" },
                target: undefined,
                deployment: undefined,
                asset: undefined,
                analysis: undefined,
            }),
        ).toEqual({ status: "not_applicable" });
        expect(
            deploymentTargetMatchesSubject(
                targets[0] as (typeof targets)[number],
                { subjectKind: "project", projectId: PROJECT_ID },
                [PROJECT],
            ),
        ).toBe(true);
        expect(
            deploymentTargetMatchesSubject(
                { ...(targets[0] as (typeof targets)[number]), displayPath: "/workspace/historical" },
                { subjectKind: "project", projectId: PROJECT_ID },
                [PROJECT],
            ),
        ).toBe(false);
        expect(
            deploymentTargetMatchesSubject(
                {
                    ...(targets[0] as (typeof targets)[number]),
                    displayPath: "C:\\Workspace\\OAAM",
                    platform: "win32",
                    platformInstanceId: "win32",
                },
                { subjectKind: "project", projectId: PROJECT_ID },
                [{ ...PROJECT, rootPath: "c:\\workspace\\oaam" }],
            ),
        ).toBe(true);
        expect(
            deploymentTargetMatchesSubject(
                {
                    ...(targets[0] as (typeof targets)[number]),
                    displayPath: "\\\\wsl.localhost\\Ubuntu\\workspace\\oaam",
                    platform: "wsl",
                    platformInstanceId: "Ubuntu",
                },
                { subjectKind: "project", projectId: PROJECT_ID },
                [PROJECT],
            ),
        ).toBe(true);
        expect(
            deploymentTargetMatchesSubject(
                {
                    ...(targets[0] as (typeof targets)[number]),
                    displayPath: "\\\\wsl.localhost\\Debian\\workspace\\oaam",
                    platform: "wsl",
                    platformInstanceId: "Ubuntu",
                },
                { subjectKind: "project", projectId: PROJECT_ID },
                [PROJECT],
            ),
        ).toBe(false);
        expect(
            buildAssetUsageAnalysisRequests({ subjectKind: "project", projectId: PROJECT_ID }, targets, {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                allowIncomplete: false,
            }),
        ).toEqual([
            {
                targetKey: deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "target-candidate"),
                params: {
                    probeToken: "probe-token",
                    probeResultRowId: "probe-row",
                    targetRowId: "target-row",
                    subject: { subjectKind: "project", projectId: PROJECT_ID },
                    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
                },
            },
        ]);
        expect(buildAssetUsageAnalysisRequests({ subjectKind: "project", projectId: PROJECT_ID }, targets, undefined)).toEqual(
            [],
        );

        const base = {
            subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
            targetKey: targets[0]?.key ?? "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI", "CLAUDE_CODE_CLI"],
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        };
        expect(buildDeploymentCreateRequest(base, targets, [PROJECT], [ASSET])).toEqual({
            status: "ready",
            params: {
                probeToken: "probe-token",
                probeResultRowId: "probe-row",
                targetRowId: "target-row",
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
            },
        });
        expect(
            buildDeploymentCreateRequest(
                { ...base, subject: { subjectKind: "project", projectId: "99999999-9999-4999-8999-999999999999" } },
                targets,
                [PROJECT],
                [ASSET],
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("catalog.validation.choose_project") });
        expect(buildDeploymentCreateRequest({ ...base, targetKey: "" }, targets, [PROJECT], [ASSET])).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.choose_target"),
        });
        expect(
            buildDeploymentCreateRequest(
                base,
                [{ ...(targets[0] as (typeof targets)[number]), displayPath: "/wrong" }],
                [PROJECT],
                [ASSET],
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("catalog.validation.choose_target") });
        expect(
            buildDeploymentCreateRequest(
                { ...base, subject: { subjectKind: "global" } },
                [{ ...(targets[0] as (typeof targets)[number]), targetKind: "global" }],
                [PROJECT],
                [ASSET],
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("catalog.validation.asset_missing") });
        expect(buildDeploymentCreateRequest({ ...base, consumerAgentRuntimeIds: [] }, targets, [PROJECT], [ASSET])).toMatchObject(
            { status: "invalid", message: localizedText("catalog.validation.choose_runtime") },
        );
        expect(
            buildDeploymentCreateRequest({ ...base, consumerAgentRuntimeIds: ["CLAUDE_CODE_APP"] }, targets, [PROJECT], [ASSET]),
        ).toMatchObject({ status: "invalid", message: localizedText("catalog.validation.choose_runtime") });
        expect(buildDeploymentCreateRequest({ ...base, assets: [] }, targets, [PROJECT], [ASSET])).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.choose_asset"),
        });
        expect(
            buildDeploymentCreateRequest(
                { ...base, assets: [{ assetId: "absent", versionId: VERSION_ID, allowIncomplete: false }] },
                targets,
                [PROJECT],
                [ASSET],
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("catalog.validation.asset_missing") });
        expect(
            buildDeploymentCreateRequest(
                {
                    ...base,
                    assets: [
                        {
                            assetId: INCOMPLETE_ASSET.assetId,
                            versionId: INCOMPLETE_ASSET.currentVersionId,
                            allowIncomplete: false,
                        },
                    ],
                },
                targets,
                [PROJECT],
                [INCOMPLETE_ASSET],
            ),
        ).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.asset_incomplete", { asset: INCOMPLETE_ASSET.displayName }),
        });
        expect(
            buildDeploymentCreateRequest(
                base,
                targets,
                [PROJECT],
                [{ ...ASSET, currentVersionId: "77777777-7777-4777-8777-777777777777" }],
            ),
        ).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.asset_version_changed", { asset: ASSET.displayName }),
        });
        expect(
            buildDeploymentCreateRequest(
                {
                    ...base,
                    assets: [
                        { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
                        { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
                    ],
                },
                targets,
                [PROJECT],
                [ASSET],
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("catalog.validation.asset_duplicate") });
    });

    it("keeps one stable tool identity while classifying current probe outcomes without stale fallback", () => {
        const projectTarget = PROBE_REVIEW.results[0]?.targets[0];
        const probeResult = PROBE_REVIEW.results[0];
        if (projectTarget === undefined || probeResult === undefined) throw new Error("probe fixture is incomplete");
        const semanticReceipt = (review: typeof PROBE_REVIEW) =>
            collectDeploymentToolObservations(review, DEPLOYMENT_PROVIDERS, "Guidance", collectDeploymentTargets(review)).map(
                (observation) => ({
                    key: observation.key,
                    versionText: observation.versionText,
                    state: observation.state,
                    reasonCodes: observation.reasonCodes,
                    targetKey: observation.target?.key,
                }),
            );

        const expected = semanticReceipt(PROBE_REVIEW);
        expect(expected).toEqual([
            {
                key: JSON.stringify(["CLAUDECODE", "linux", "local", "CLAUDE_CODE_CLI", "target-candidate"]),
                versionText: "2.1.220",
                state: "ready",
                reasonCodes: ["catalog.target.ready"],
                targetKey: deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "target-candidate"),
            },
        ]);
        for (let index = 0; index < 10; index += 1) {
            const review = {
                ...PROBE_REVIEW,
                probeToken: `probe-token-${index}`,
                results: [
                    {
                        ...probeResult,
                        rowId: `probe-row-${index}`,
                        runtimes: probeResult.runtimes.map((runtime) => ({ ...runtime, rowId: `runtime-${index}` })),
                        targets: probeResult.targets.map((target) => ({
                            ...target,
                            rowId: `target-${index}-${target.targetCandidateId}`,
                        })),
                    },
                ],
            } satisfies typeof PROBE_REVIEW;
            expect(semanticReceipt(review)).toEqual(expected);
        }

        const unknownReview = {
            ...PROBE_REVIEW,
            results: [
                {
                    ...probeResult,
                    targets: [
                        {
                            ...projectTarget,
                            entryApplicabilities: projectTarget.entryApplicabilities.map((entry) => ({
                                ...entry,
                                status: "unknown" as const,
                                diagnostics:
                                    entry.agentRuntimeId === "CLAUDE_CODE_CLI"
                                        ? [
                                              {
                                                  severity: "warning" as const,
                                                  code: "probe.current_observation_failed",
                                                  operation: "adapter.probe",
                                                  causeKind: "unavailable" as const,
                                                  retryable: true,
                                                  suggestedActions: ["retry" as const],
                                                  message: "current observation failed",
                                              },
                                          ]
                                        : entry.diagnostics,
                            })),
                        },
                    ],
                    diagnostics: [
                        {
                            severity: "warning" as const,
                            code: "probe.sibling_observation_failed",
                            operation: "adapter.probe",
                            causeKind: "unavailable" as const,
                            retryable: true,
                            suggestedActions: ["retry"],
                            message: "current observation failed",
                        },
                    ],
                },
            ],
        } satisfies typeof PROBE_REVIEW;
        expect(semanticReceipt(unknownReview)).toEqual([
            expect.objectContaining({
                state: "current_observation_failed",
                reasonCodes: ["probe.current_observation_failed"],
                targetKey: deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "target-candidate"),
            }),
        ]);

        const providerFailedReview = {
            ...PROBE_REVIEW,
            results: [
                {
                    ...probeResult,
                    status: "failed" as const,
                    diagnostics: [
                        {
                            severity: "error" as const,
                            code: "probe.sibling_provider_failed",
                            operation: "adapter.probe",
                            causeKind: "unavailable" as const,
                            retryable: true,
                            suggestedActions: ["retry" as const],
                            message: "a sibling observation failed",
                        },
                    ],
                },
            ],
        } satisfies typeof PROBE_REVIEW;
        expect(semanticReceipt(providerFailedReview)).toEqual(expected);

        const notInstalledReview = {
            ...PROBE_REVIEW,
            results: [
                {
                    ...probeResult,
                    runtimes: probeResult.runtimes.map((runtime) => ({
                        ...runtime,
                        versionText: "",
                        installationStatus: "not_found" as const,
                    })),
                    targets: [],
                },
            ],
        } satisfies typeof PROBE_REVIEW;
        expect(semanticReceipt(notInstalledReview)).toEqual([
            expect.objectContaining({ state: "not_installed", targetKey: undefined, versionText: "" }),
        ]);

        const duplicateTargetReview = {
            ...PROBE_REVIEW,
            results: [{ ...probeResult, targets: [projectTarget, { ...projectTarget, rowId: "duplicate-row" }] }],
        } satisfies typeof PROBE_REVIEW;
        expect(collectDeploymentTargets(duplicateTargetReview)).toEqual([]);
        expect(semanticReceipt(duplicateTargetReview)).toEqual([
            expect.objectContaining({
                key: JSON.stringify(["CLAUDECODE", "linux", "local", "CLAUDE_CODE_CLI", null]),
                state: "current_observation_failed",
                targetKey: undefined,
            }),
        ]);

        const secondTargetReview = {
            ...PROBE_REVIEW,
            results: [
                {
                    ...probeResult,
                    targets: [
                        projectTarget,
                        {
                            ...projectTarget,
                            rowId: "second-target-row",
                            targetCandidateId: "second-target-candidate",
                            displayName: "Second exact Project target",
                            displayPath: "/workspace/second",
                            entryApplicabilities: projectTarget.entryApplicabilities.filter(
                                (entry) => entry.agentRuntimeId === "CLAUDE_CODE_CLI",
                            ),
                        },
                    ],
                },
            ],
        } satisfies typeof PROBE_REVIEW;
        expect(semanticReceipt(secondTargetReview)).toEqual([
            expect.objectContaining({
                key: JSON.stringify(["CLAUDECODE", "linux", "local", "CLAUDE_CODE_CLI", "second-target-candidate"]),
                targetKey: deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "second-target-candidate"),
            }),
            expect.objectContaining({
                key: JSON.stringify(["CLAUDECODE", "linux", "local", "CLAUDE_CODE_CLI", "target-candidate"]),
                targetKey: deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "target-candidate"),
            }),
        ]);
    });

    it.each([
        "Guidance",
        "Rule",
        "Workflow",
        "Skill",
        "Subagent",
        "Memory",
    ] as const)("isolates exact runtime and capability facts for %s target observations", (assetKind) => {
        type TargetCapability = AdapterProviderView["targetCapabilities"][number];
        const provider = (targetCapabilities: readonly TargetCapability[]): readonly AdapterProviderView[] => [
            { ...DEPLOYMENT_PROVIDERS[0], targetCapabilities },
        ];
        const availableCapability = (
            entrySupportStatus: "supported" | "docs_declared_unverified",
            renderStrategy: "native_file" | "inline",
            code?: string,
        ): TargetCapability => ({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            assetKind,
            entrySupportStatus,
            renderStrategy,
            reverseExtractPolicy: "can_reconcile",
            diagnostics:
                code === undefined
                    ? []
                    : [
                          {
                              severity: "warning",
                              code,
                              operation: "adapter_provider.list",
                              causeKind: "unsupported",
                              retryable: false,
                              suggestedActions: [],
                              message: code,
                          },
                      ],
        });
        const unavailableCapability = (entrySupportStatus: "unsupported" | "deferred"): TargetCapability => ({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            assetKind,
            entrySupportStatus,
            diagnostics: [
                {
                    severity: "warning",
                    code: `capability.${entrySupportStatus}`,
                    operation: "adapter_provider.list",
                    causeKind: "unsupported",
                    retryable: false,
                    suggestedActions: [],
                    message: entrySupportStatus,
                },
            ],
        });
        const observe = (providers: readonly AdapterProviderView[], review: typeof PROBE_REVIEW = PROBE_REVIEW) =>
            collectDeploymentToolObservations(review, providers, assetKind, collectDeploymentTargets(review)).filter(
                (row) => row.agentRuntimeId === "CLAUDE_CODE_CLI",
            );
        const probeResult = PROBE_REVIEW.results[0];
        if (probeResult === undefined) throw new Error("probe fixture is incomplete");
        const siblingFailureReview = {
            ...PROBE_REVIEW,
            results: [
                {
                    ...probeResult,
                    status: "failed" as const,
                    runtimes: [
                        ...probeResult.runtimes,
                        {
                            ...probeResult.runtimes[0],
                            rowId: "claude-app-runtime",
                            agentRuntimeId: "CLAUDE_CODE_APP",
                            versionText: "",
                            installationStatus: "unknown" as const,
                            diagnostics: [
                                {
                                    severity: "warning" as const,
                                    code: "claudecode_app_observation_failed",
                                    operation: "adapter.probe",
                                    causeKind: "partial" as const,
                                    retryable: true,
                                    suggestedActions: ["retry" as const],
                                    message: "Claude App observation failed",
                                },
                            ],
                        },
                    ],
                    diagnostics: [
                        {
                            severity: "warning" as const,
                            code: "claudecode_provider_partial",
                            operation: "adapter.probe",
                            causeKind: "partial" as const,
                            retryable: true,
                            suggestedActions: ["retry" as const],
                            message: "provider partial",
                        },
                    ],
                },
            ],
        } satisfies typeof PROBE_REVIEW;

        expect(
            observe(
                provider([availableCapability("supported", "native_file"), availableCapability("supported", "inline")]),
                siblingFailureReview,
            ),
        ).toEqual([
            expect.objectContaining({
                state: "ready",
                versionText: "2.1.220",
                reasonCodes: ["catalog.target.ready"],
            }),
        ]);

        for (const entrySupportStatus of ["unsupported", "deferred"] as const) {
            expect(observe(provider([unavailableCapability(entrySupportStatus)]))).toEqual([
                expect.objectContaining({
                    state: "unsupported",
                    reasonCodes: [`capability.${entrySupportStatus}`],
                }),
            ]);
        }

        expect(
            observe(provider([availableCapability("docs_declared_unverified", "native_file", "capability.unverified")])),
        ).toEqual([expect.objectContaining({ state: "unsupported", reasonCodes: ["capability.unverified"] })]);

        const notInstalledReview = {
            ...PROBE_REVIEW,
            results: [
                {
                    ...probeResult,
                    runtimes: probeResult.runtimes.map((runtime) => ({
                        ...runtime,
                        versionText: "",
                        installationStatus: "not_found" as const,
                        diagnostics: [
                            {
                                severity: "warning" as const,
                                code: "runtime.not_found",
                                operation: "adapter.probe",
                                causeKind: "not_found" as const,
                                retryable: false,
                                suggestedActions: [] as const,
                                message: "runtime not found",
                            },
                        ],
                    })),
                },
            ],
        } satisfies typeof PROBE_REVIEW;
        expect(observe(provider([availableCapability("supported", "native_file")]), notInstalledReview)).toEqual([
            expect.objectContaining({ state: "not_installed", reasonCodes: ["runtime.not_found"] }),
        ]);

        const exactRuntimeFailureReview = {
            ...PROBE_REVIEW,
            results: [
                {
                    ...probeResult,
                    runtimes: probeResult.runtimes.map((runtime) => ({
                        ...runtime,
                        versionText: "",
                        installationStatus: "unknown" as const,
                        diagnostics: [
                            {
                                severity: "warning" as const,
                                code: "runtime.observation_failed",
                                operation: "adapter.probe",
                                causeKind: "partial" as const,
                                retryable: true,
                                suggestedActions: ["retry" as const],
                                message: "runtime observation failed",
                                path: "/runtime/exact-launcher",
                            },
                        ],
                    })),
                },
            ],
        } satisfies typeof PROBE_REVIEW;
        expect(observe(provider([availableCapability("supported", "native_file")]), exactRuntimeFailureReview)).toEqual([
            expect.objectContaining({
                state: "current_observation_failed",
                reasonCodes: ["runtime.observation_failed"],
                checkedPaths: ["/runtime/exact-launcher"],
            }),
        ]);

        const unrelatedSourceReview = {
            ...PROBE_REVIEW,
            results: [
                {
                    ...probeResult,
                    sources: [
                        {
                            rowId: "unrelated-source-row",
                            sourceRootId: "unrelated-source-root",
                            rootRole: "project_actual" as const,
                            sourceDomain: "project_root" as const,
                            displayPath: "/project/AGENTS.md",
                            accessStatus: "available" as const,
                            locatorIdentities: [
                                {
                                    locatorKind: "user_provided_path" as const,
                                    locatorKey: "probe_project_root",
                                    evidenceLevel: "user_provided" as const,
                                },
                            ],
                            diagnostics: [],
                        },
                    ],
                    runtimes: probeResult.runtimes.map((runtime) => ({
                        ...runtime,
                        sourceRootRowIds: ["unrelated-source-row"],
                    })),
                },
            ],
        } satisfies typeof PROBE_REVIEW;
        expect(observe(provider([availableCapability("supported", "native_file")]), unrelatedSourceReview)).toEqual([
            expect.objectContaining({ state: "ready", checkedPaths: [] }),
        ]);

        expect(
            observe(
                provider([
                    availableCapability("supported", "native_file"),
                    availableCapability("docs_declared_unverified", "inline", "capability.unverified"),
                ]),
            ),
        ).toEqual([
            expect.objectContaining({
                state: "ready",
                reasonCodes: ["catalog.target.ready"],
            }),
        ]);

        expect(observe(provider([unavailableCapability("unsupported"), unavailableCapability("deferred")]))).toEqual([
            expect.objectContaining({
                state: "unsupported",
                reasonCodes: ["catalog.target.unsupported"],
            }),
        ]);
    });

    it("requires exactly one current render option per semantic input and explicit degradation evidence", () => {
        expect(
            buildRenderSelection({ ...RENDER_ANALYSIS, semantics: [], outputUnits: [], options: [] }, [], "action"),
        ).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.render_none"),
        });
        expect(buildRenderSelection(RENDER_ANALYSIS, [], "action")).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.render_missing"),
        });
        expect(
            buildRenderSelection(
                RENDER_ANALYSIS,
                [
                    { semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false },
                    { semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false },
                ],
                "action",
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("catalog.validation.render_duplicate") });
        expect(
            buildRenderSelection(
                RENDER_ANALYSIS,
                [
                    { semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false },
                    { semanticRefFingerprint: SHA_C, optionFingerprint: SHA_B, approved: false },
                ],
                "action",
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("catalog.validation.render_missing") });
        expect(
            buildRenderSelection(
                RENDER_ANALYSIS,
                [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_C, approved: false }],
                "action",
            ),
        ).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.render_approval", { strategy: "inline" }),
        });
        expect(
            buildRenderSelection(
                RENDER_ANALYSIS,
                [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_C, approved: true }],
                " ",
            ),
        ).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.render_approval_evidence"),
        });
        expect(
            buildRenderSelection(
                RENDER_ANALYSIS,
                [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_C, approved: true }],
                "action",
            ),
        ).toEqual({
            status: "ready",
            selection: {
                schemaVersion: 1,
                renderInputFingerprint: SHA_A,
                semanticOptions: [{ optionFingerprint: SHA_C, approval: { action: "approve_once", userActionId: "action" } }],
            },
        });
        expect(
            buildRenderSelection(
                RENDER_ANALYSIS,
                [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false }],
                "action",
            ),
        ).toMatchObject({
            status: "ready",
            selection: { semanticOptions: [{ approval: { action: "none" } }] },
        });
    });

    it("fails closed when render semantics, options, blocked rows, or target claims do not form one review", () => {
        const review = projectRenderReview(RENDER_ANALYSIS);
        expect(review.status).toBe("ready");
        if (review.status !== "ready") throw new Error("expected a complete render review");
        expect(review.groups).toHaveLength(1);
        expect(review.groups[0]).toMatchObject({
            semantic: { semanticRefFingerprint: SHA_A, semanticKind: "guidance.content" },
            options: [
                {
                    option: { optionFingerprint: SHA_B },
                    outputUnits: [{ outputUnitFingerprint: SHA_B }],
                },
                {
                    option: { optionFingerprint: SHA_C },
                    outputUnits: [{ outputUnitFingerprint: SHA_B }],
                },
            ],
        });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                semantics: [...RENDER_ANALYSIS.semantics, ...RENDER_ANALYSIS.semantics],
            }),
        ).toMatchObject({ status: "invalid" });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                outputUnits: [...RENDER_ANALYSIS.outputUnits, ...RENDER_ANALYSIS.outputUnits],
            }),
        ).toMatchObject({ status: "invalid" });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                options: [{ ...FIRST_RENDER_OPTION, semanticRefFingerprint: SHA_C }],
            }),
        ).toMatchObject({ status: "invalid" });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                options: [{ ...FIRST_RENDER_OPTION, requiredOutputUnitFingerprints: [SHA_C] }],
            }),
        ).toMatchObject({ status: "invalid" });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                options: [{ ...FIRST_RENDER_OPTION, requiredOutputUnitFingerprints: [SHA_B, SHA_B] }],
            }),
        ).toMatchObject({ status: "invalid" });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                blockedSemantics: [{ semanticRefFingerprint: SHA_C, reasonCode: "unsupported", diagnostics: [] }],
            }),
        ).toMatchObject({ status: "invalid" });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                blockedSemantics: [
                    { semanticRefFingerprint: SHA_A, reasonCode: "unsupported", diagnostics: [] },
                    { semanticRefFingerprint: SHA_A, reasonCode: "unsupported", diagnostics: [] },
                ],
            }),
        ).toMatchObject({ status: "invalid" });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                blockedSemantics: [{ semanticRefFingerprint: SHA_A, reasonCode: "unsupported", diagnostics: [] }],
            }),
        ).toMatchObject({ status: "invalid" });
        expect(projectRenderReview({ ...RENDER_ANALYSIS, options: [] })).toMatchObject({ status: "invalid" });
        expect(
            projectRenderReview({
                ...RENDER_ANALYSIS,
                options: [],
                blockedSemantics: [{ semanticRefFingerprint: SHA_A, reasonCode: "unsupported", diagnostics: [] }],
            }),
        ).toMatchObject({
            status: "ready",
            groups: [{ options: [], blocked: { semanticRefFingerprint: SHA_A, reasonCode: "unsupported" } }],
        });
    });
});
