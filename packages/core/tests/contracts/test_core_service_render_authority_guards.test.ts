import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { writeProjectManifest } from "../../src/catalog/project-authority";
import { executeDeployment as executeDeploymentProduction } from "../../src/deployment/deployment-executor";
import { tryAcquireAuthorityLockLease } from "../../src/foundation/authority-locks";
import { type CoreServiceConfiguration, createCoreService } from "../../src/index";
import { resolveRenderTargetContext } from "../../src/orchestration/deployment-render-authority";
import { deploymentRenderServiceInternalsForTest } from "../../src/orchestration/deployment-render-service";
import { getDb } from "../../src/persistence/db";
import { softDeleteDeploymentAsset, updateDeployment, upsertDeploymentAsset } from "../../src/persistence/state-db";
import { resolveCoreRenderSelection, resolveCoreRenderSelectionWithAuthorityLeases } from "../../src/render/render-selection";
import { ASSET_ID, PROJECT_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    ADAPTER_ID,
    AGENT_RUNTIME_ID,
    analyzeAndSelect,
    completeProbe,
    currentProbeResult,
    DEPLOYMENT_ID,
    databasePath,
    diagnostic,
    MISSING_VERSION_ID,
    materializeCalls,
    oaamRoot,
    previewedApply,
    probeCalls,
    provider,
    resolveObservedTarget,
    resolverCalls,
    SECOND_ASSET_ID,
    sandbox,
    seedAuthority,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";

describe("CoreService render authority guards", () => {
    it("requires the action-time Asset lease set to cover the exact selected Asset authorities", () => {
        const requireCoverage = deploymentRenderServiceInternalsForTest.requireActionTimeAssetLeaseCoverage;
        expect(() => requireCoverage([ASSET_ID, SECOND_ASSET_ID], [SECOND_ASSET_ID, ASSET_ID, ASSET_ID])).not.toThrow();
        for (const current of [[ASSET_ID], [ASSET_ID, SECOND_ASSET_ID, VERSION_ID]] as const) {
            expect(() => requireCoverage([ASSET_ID, SECOND_ASSET_ID], current)).toThrow(
                expect.objectContaining({ code: "render.action_time_context_changed" }),
            );
        }
    });

    it("passes only the current AssetKind target schemas into observed target resolution", () => {
        const selected = provider();
        const guidanceCapability = selected.assetTargetCapabilities.find(
            (capability) =>
                capability.agentRuntimeId === AGENT_RUNTIME_ID &&
                capability.assetKind === "Guidance" &&
                capability.entrySupportStatus === "supported" &&
                "targetContextSchemaId" in capability,
        );
        if (guidanceCapability === undefined || !("targetContextSchemaId" in guidanceCapability)) {
            throw new Error("Guidance target capability fixture is missing");
        }
        selected.assetTargetCapabilities.push({
            ...guidanceCapability,
            assetKind: "Rule",
            targetContextSchemaId: "FIXTURE_SIBLING_RULE_TARGET_V1",
        } as never);
        let receivedSchemaIds: readonly string[] | undefined;
        const adapterProbe = completeProbe();

        const context = resolveRenderTargetContext(
            {
                agentRuntimeId: AGENT_RUNTIME_ID as never,
                targetRootPath: targetRoot,
                projectRootPath: targetRoot,
                ownerAdapterId: ADAPTER_ID,
                provider: selected,
                probeResults: [
                    {
                        ...adapterProbe,
                        observation: {
                            ...adapterProbe.observation,
                            adapterId: ADAPTER_ID,
                            platformContext: {
                                platform: "wsl",
                                platformInstanceId: "wsl-test",
                                accessRootPath: sandbox,
                            },
                        },
                    },
                ],
                assetKinds: ["Guidance"],
            },
            (input) => {
                receivedSchemaIds = input.targetContextSchemaIds;
                return resolveObservedTarget(input);
            },
        );

        expect(context.targetContextSchemaId).toBe(guidanceCapability.targetContextSchemaId);
        expect(receivedSchemaIds).toEqual([guidanceCapability.targetContextSchemaId]);
    });

    it("keeps synchronous render-target resolution fail-closed for invalid cardinality and async owners", () => {
        const selected = provider();
        const adapterProbe = completeProbe();
        const input = {
            agentRuntimeId: AGENT_RUNTIME_ID as never,
            targetRootPath: targetRoot,
            projectRootPath: targetRoot,
            ownerAdapterId: ADAPTER_ID,
            provider: selected,
            probeResults: [
                {
                    ...adapterProbe,
                    observation: {
                        ...adapterProbe.observation,
                        adapterId: ADAPTER_ID,
                        platformContext: {
                            platform: "wsl" as const,
                            platformInstanceId: "wsl-test",
                            accessRootPath: sandbox,
                        },
                    },
                },
            ],
            assetKinds: ["Guidance" as const],
        };

        expect(() => resolveRenderTargetContext({ ...input, probeResults: [] }, resolveObservedTarget)).toThrow(
            "target probe did not return exactly one owner result",
        );
        expect(() => resolveRenderTargetContext(input, async (resolverInput) => resolveObservedTarget(resolverInput))).toThrow(
            "synchronous target-context resolution received an asynchronous owner",
        );
    });

    it("probes the registered Project root without pretending a distinct directory target is the Project", async () => {
        seedAuthority();
        const directoryTarget = path.join(sandbox, "profile", "projects", "project-a", "memory");
        fs.mkdirSync(directoryTarget, { recursive: true });
        updateDeployment(getDb(databasePath), DEPLOYMENT_ID, { targetRootPath: directoryTarget }, 3);
        const selected = provider();
        selected.probe = async (input) => {
            expect(input).toMatchObject({ authorizationScope: "project", projectRootPath: targetRoot });
            const result = completeProbe();
            const targetCandidate = result.observation.targetCandidates[0];
            if (targetCandidate === undefined) throw new Error("directory target fixture is missing");
            targetCandidate.targetRootPath = directoryTarget;
            targetCandidate.targetKind = "directory";
            return result;
        };

        const analyzed = await service(selected).analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("native_guidance_provider_declaration_invalid");
    });

    it.each(["missing", "deleted"] as const)("blocks render when the Deployment Project authority is %s", async (state) => {
        seedAuthority();
        const projectsRoot = path.join(oaamRoot, "projects");
        if (state === "missing") {
            fs.rmSync(path.join(projectsRoot, PROJECT_ID), { recursive: true, force: true });
        } else {
            writeProjectManifest(projectsRoot, {
                schemaVersion: 1,
                projectId: PROJECT_ID,
                rootPath: targetRoot,
                displayName: "Fixture Project",
                deleted: true,
                createdAt: 1,
                updatedAt: 3,
            });
        }
        const analyzed = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.project_unavailable");
        expect(probeCalls).toBe(0);
    });

    it("blocks when durable Deployment intent points at a missing Version authority", async () => {
        seedAuthority();
        upsertDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, SECOND_ASSET_ID, MISSING_VERSION_ID, 0, 0, 3);
        const analyzed = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.version_authority_stale");
        expect(analyzed.diagnostics[0]?.retryable).toBe(true);
        expect(probeCalls).toBe(0);
    });

    it("maps malformed durable Deployment bytes to an internal failure instead of normalizing them", async () => {
        seedAuthority();
        updateDeployment(getDb(databasePath), DEPLOYMENT_ID, { consumerAgentRuntimeIds: "[1]" }, 3);
        const analyzed = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.core_service_internal_error");
        expect(analyzed.diagnostics[0]?.message).toContain("consumerAgentRuntimeIds");
    });

    it("fails closed after the owning adapter is disabled", async () => {
        seedAuthority();
        const core = service();
        const current = core.getAdapterEnablement().value;
        expect(
            core.replaceAdapterEnablement({
                expectedRevision: current.revision,
                expectedSettingFingerprint: current.settingFingerprint,
                enabledAdapterIds: [],
                userActionId: "disable-render-provider",
            }).status,
        ).toBe("complete");
        const analyzed = await core.analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.consumer_owner_unavailable");
        expect(probeCalls).toBe(0);
    });

    it("preserves the concrete probe failure and does not run target resolution", async () => {
        seedAuthority();
        const selected = provider();
        selected.probe = async () => {
            throw new Error("fixture probe failure");
        };
        const analyzed = await service(selected).analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("probe_error");
        expect(resolverCalls).toBe(0);
    });

    it("fails closed when a partial probe omits the owning adapter result", async () => {
        seedAuthority();
        const probeDiagnostic = diagnostic("fixture_partial_probe", "warning");
        const analyzed = await service(provider(), Number.POSITIVE_INFINITY, {
            probeAdapters: async () => ({
                status: "partial",
                value: [],
                diagnostics: [probeDiagnostic],
            }),
        }).analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.probe_result_cardinality");
        expect(resolverCalls).toBe(0);
    });

    it("returns partial analysis when a successful probe carries a diagnostic", async () => {
        seedAuthority();
        const warning = diagnostic("fixture_probe_warning", "warning");
        const analyzed = await service(provider({ probeDiagnostics: [warning] })).analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("partial");
        expect(analyzed.diagnostics).toContainEqual(warning);
        expect(analyzed.value.promotionAuthorizationInspections).toEqual([
            expect.objectContaining({
                promotionAuthorizationState: "not_required",
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                target: { targetKind: "project", projectId: PROJECT_ID },
            }),
        ]);
    });

    it("keeps successful Provider analysis visible when the subsequent authority inspection becomes unavailable", async () => {
        seedAuthority();
        const selected = provider();
        const analyzeRender = selected.analyzeRender;
        selected.analyzeRender = async (input) => {
            const result = await analyzeRender(input);
            fs.writeFileSync(path.join(oaamRoot, "assets", ASSET_ID, "versions", VERSION_ID, "version.json"), "{corrupt");
            return result;
        };

        const analyzed = await service(selected).analyzeDeploymentRender(DEPLOYMENT_ID);

        expect(analyzed).toMatchObject({
            status: "partial",
            value: {
                analyses: [{ status: "complete" }],
                promotionAuthorizationInspections: [
                    {
                        promotionAuthorizationState: "unavailable",
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        target: { targetKind: "project", projectId: PROJECT_ID },
                        diagnosticCode: "render.promotion_authority_unavailable",
                    },
                ],
            },
            diagnostics: [{ code: "render.promotion_authority_unavailable" }],
        });
    });

    it("projects exact-target Asset usage through read-only materialization without creating a Deployment", async () => {
        seedAuthority();
        const core = service();
        const before = core.listDeployments();
        expect(before.status).toBe("complete");

        const usage = await core.analyzeAssetUsage({
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: [AGENT_RUNTIME_ID as never],
            platform: "wsl",
            platformInstanceId: "wsl-test",
            targetRootPath: targetRoot,
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
            currentProbeResults: [currentProbeResult()],
        });

        expect(usage.status, JSON.stringify(usage.diagnostics)).toBe("complete");
        expect(usage.value).toMatchObject({
            schemaVersion: 2,
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            relationships: [
                {
                    agentRuntimeId: AGENT_RUNTIME_ID,
                    capability: "direct",
                    observedTargetState: "absent",
                    managedState: "configured",
                    substitute: null,
                    deploymentIds: [DEPLOYMENT_ID],
                    appliedDeploymentIds: [],
                    degradationKinds: [],
                    diagnostics: [],
                    requiresReview: false,
                },
            ],
        });
        expect(core.listDeployments()).toEqual(before);
        expect(materializeCalls).toBe(1);
    });

    it.each([
        {
            label: "a non-canonical runtime identity",
            input: { consumerAgentRuntimeIds: ["claude_code_cli"] },
        },
        {
            label: "a non-absolute target path",
            input: { targetRootPath: "relative/target" },
        },
        {
            label: "a forged Project identity",
            input: { projectId: "../outside-project-authority" },
        },
    ])("rejects $label before an Asset relationship probe", async ({ input }) => {
        seedAuthority();
        const usage = await service().analyzeAssetUsage({
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: [AGENT_RUNTIME_ID as never],
            platform: "wsl",
            platformInstanceId: "wsl-test",
            targetRootPath: targetRoot,
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
            currentProbeResults: [currentProbeResult()],
            ...input,
        });

        expect(usage).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "asset_usage.input_invalid", causeKind: "invalid_schema" }],
        });
        expect(materializeCalls).toBe(0);
    });

    it("classifies an explicit Provider conversion separately from direct and unavailable use", async () => {
        seedAuthority();
        const analysis = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analysis.status, JSON.stringify(analysis.diagnostics)).toBe("complete");
        const transformed = structuredClone(analysis.value);
        const option = transformed.analyses[0]?.semanticOptions[0];
        if (option === undefined) throw new Error("fixture render option is unavailable");
        transformed.analyses[0]!.semanticOptions[0] = {
            ...option,
            outcome: "degraded",
            degradationKinds: ["target_runtime_missing_asset_kind"],
            degradationFingerprint: "sha256:fixture" as never,
            reasonCode: "fixture_workflow_converted_to_skill",
        };

        expect(
            deploymentRenderServiceInternalsForTest.classifyAssetUsageRelationship(AGENT_RUNTIME_ID as never, transformed),
        ).toEqual({
            capability: "transformed",
            substitute: null,
            degradationKinds: ["target_runtime_missing_asset_kind"],
            reasonCodes: expect.arrayContaining(["fixture_workflow_converted_to_skill"]),
            diagnostics: [],
            requiresReview: true,
        });
        expect(materializeCalls).toBe(0);
    });

    it.each([
        {
            label: "platform root is below the target",
            contexts: () => [
                {
                    platform: "wsl" as const,
                    platformInstanceId: "wsl-test",
                    accessRootPath: path.join(targetRoot, "child"),
                },
            ],
        },
        {
            label: "platform root is a sibling of the target",
            contexts: () => [
                {
                    platform: "wsl" as const,
                    platformInstanceId: "wsl-test",
                    accessRootPath: path.join(sandbox, "other"),
                },
            ],
        },
    ])("rejects when $label", async ({ contexts }) => {
        seedAuthority();
        const analyzed = await service(
            provider(),
            Number.POSITIVE_INFINITY,
            {},
            {
                platformContexts: contexts(),
            },
        ).analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.platform_context_ambiguous");
        expect(probeCalls).toBe(0);
    });

    it("selects the exact platform instance when another same-platform context contains the target", async () => {
        seedAuthority();
        const analyzed = await service(
            provider(),
            Number.POSITIVE_INFINITY,
            {},
            {
                platformContexts: [
                    { platform: "wsl", platformInstanceId: "other-wsl", accessRootPath: sandbox },
                    { platform: "wsl", platformInstanceId: "wsl-test", accessRootPath: sandbox },
                ],
            },
        ).analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).not.toBe("failed");
        expect(probeCalls).toBe(1);
    });

    it("uses win32 path grammar and rejects a target on another drive", async () => {
        seedAuthority();
        updateDeployment(
            getDb(databasePath),
            DEPLOYMENT_ID,
            { platform: "win32", platformInstanceId: "windows-c", targetRootPath: "D:\\oaam-project" },
            3,
        );
        const analyzed = await service(
            provider(),
            Number.POSITIVE_INFINITY,
            {},
            {
                platformContexts: [
                    {
                        platform: "win32",
                        platformInstanceId: "windows-c",
                        accessRootPath: "C:\\oaam-root",
                    },
                ],
            },
        ).analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.platform_context_ambiguous");
        expect(probeCalls).toBe(0);
    });

    it("ignores structural authority extras and fails an unendorsed build closed", async () => {
        seedAuthority();
        const configuration: CoreServiceConfiguration = {
            providers: [provider()],
            platformContexts: [
                {
                    platform: "wsl",
                    platformInstanceId: "exact-root",
                    accessRootPath: targetRoot,
                },
            ],
            oaamRoot,
            databasePath,
        };
        for (const key of ["now", "newUuid", "renderAnalysisValidator"] as const) {
            Object.defineProperty(configuration, key, {
                enumerable: true,
                get() {
                    throw new Error(`production factory read test-only ${key}`);
                },
            });
        }
        const core = createCoreService(configuration);
        const current = core.getAdapterEnablement().value;
        expect(
            core.replaceAdapterEnablement({
                expectedRevision: current.revision,
                expectedSettingFingerprint: current.settingFingerprint,
                enabledAdapterIds: [ADAPTER_ID],
                userActionId: "enable-production-provider",
            }).status,
        ).toBe("complete");
        const analyzed = await core.analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).not.toBe("render.core_service_internal_error");
        expect(materializeCalls).toBe(0);
    });

    it("applies the confirmed complete file when an external editor changes it after preview", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        const input = await previewedApply(core, request);
        const target = path.join(targetRoot, "CLAUDE.md");
        fs.writeFileSync(target, "# Outside value\n");
        const deployed = await core.deployDeployment(input);
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(materializeCalls).toBe(2);
        expect(fs.readFileSync(target, "utf8")).toBe("# Project guidance\n");
    });

    it("lets the executor reject durable Deployment inputs changed after the single action-time draft", async () => {
        seedAuthority();
        let materializations = 0;
        const core = service(
            provider({
                afterMaterialize() {
                    materializations += 1;
                    if (materializations === 2) {
                        softDeleteDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID, 70);
                    }
                },
            }),
        );
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("blocked_needs_support");
        expect(materializeCalls).toBe(2);
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
    });

    it("blocks when the selection authority returns a different action-time fingerprint", async () => {
        seedAuthority();
        let selectionCalls = 0;
        const core = service(provider(), Number.POSITIVE_INFINITY, {
            resolveSelection(input, configuration, leases) {
                selectionCalls += 1;
                const result =
                    leases === undefined
                        ? resolveCoreRenderSelection(input, configuration)
                        : resolveCoreRenderSelectionWithAuthorityLeases(input, configuration, leases);
                if (selectionCalls === 2 && result.status !== "failed") {
                    result.value.selectionFingerprint = `sha256:${"9".repeat(64)}`;
                }
                return result;
            },
        });
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("render.materialization_selection_fingerprint_mismatch");
        expect(selectionCalls).toBe(2);
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
    });

    it("blocks when an Asset authority is busy before action-time preparation", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        const input = await previewedApply(core, request);
        const competingLease = tryAcquireAuthorityLockLease(path.join(oaamRoot, "transactions", "authority-locks"), "assets", [
            ASSET_ID,
        ]);
        if (competingLease === null) throw new Error("fixture could not acquire competing Asset lease");
        const deployed = await core.deployDeployment(input);
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("render.asset_locked");
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
        competingLease.release();
    });

    it("releases its Asset lease when the action-time settings authority is busy", async () => {
        seedAuthority();
        const locksRoot = path.join(oaamRoot, "transactions", "authority-locks");
        const core = service();
        const request = await analyzeAndSelect(core);
        const input = await previewedApply(core, request);
        const competingLease = tryAcquireAuthorityLockLease(locksRoot, "settings", ["settings"]);
        if (competingLease === null) throw new Error("fixture could not acquire competing settings lease");
        const deployed = await core.deployDeployment(input);
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("render.settings_locked");
        const reacquiredAsset = tryAcquireAuthorityLockLease(locksRoot, "assets", [ASSET_ID]);
        expect(reacquiredAsset).not.toBeNull();
        reacquiredAsset?.release();
        competingLease.release();
    });

    it("holds Asset and settings authority leases through the executor handoff", async () => {
        seedAuthority();
        const locksRoot = path.join(oaamRoot, "transactions", "authority-locks");
        let assetLeaseWasHeld = false;
        let settingsLeaseWasHeld = false;
        const core = service(provider(), Number.POSITIVE_INFINITY, {
            executeDeployment: () => {
                const assetLease = tryAcquireAuthorityLockLease(locksRoot, "assets", [ASSET_ID]);
                const settingsLease = tryAcquireAuthorityLockLease(locksRoot, "settings", ["settings"]);
                assetLeaseWasHeld = assetLease === null;
                settingsLeaseWasHeld = settingsLease === null;
                assetLease?.release();
                settingsLease?.release();
                return {
                    outcome: "blocked",
                    reasonCode: "fixture_executor_boundary",
                    diagnostics: [],
                    transactionId: "fixture-no-commit",
                };
            },
        });
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("fixture_executor_boundary");
        expect(assetLeaseWasHeld).toBe(true);
        expect(settingsLeaseWasHeld).toBe(true);
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
    });

    it("lets the real executor reject a post-recheck Deployment intent race before writing", async () => {
        seedAuthority();
        const core = service(provider(), Number.POSITIVE_INFINITY, {
            executeDeployment(input, compiledPlan) {
                softDeleteDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID, 80);
                return executeDeploymentProduction(input, compiledPlan);
            },
        });
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("blocked_needs_support");
        expect(deployed.diagnostics[0]?.message).toContain("stale Deployment execution inputs");
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
        expect(
            fs
                .readdirSync(path.join(oaamRoot, "transactions"))
                .filter((entry) => entry !== "authority-locks" && entry !== "locks"),
        ).toEqual([]);
    });

    it.each([
        {
            outcome: "conflict" as const,
            reasonCode: "",
            expectedCode: "render.executor_blocked",
            expectedCause: "conflict" as const,
            retryable: false,
        },
        {
            outcome: "blocked" as const,
            reasonCode: "fixture_executor_blocked",
            expectedCode: "fixture_executor_blocked",
            expectedCause: "unavailable" as const,
            retryable: true,
        },
    ])("maps executor $outcome without pretending it committed", async (testCase) => {
        seedAuthority();
        const core = service(provider(), Number.POSITIVE_INFINITY, {
            executeDeployment: () => ({
                outcome: testCase.outcome,
                reasonCode: testCase.reasonCode,
                diagnostics: [],
                transactionId: "fixture-no-commit",
            }),
        });
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]).toMatchObject({
            code: testCase.expectedCode,
            causeKind: testCase.expectedCause,
            retryable: testCase.retryable,
            suggestedActions: testCase.retryable ? ["retry"] : [],
        });
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
    });

    it("reports a missing post-commit Deployment view only after the real executor committed", async () => {
        seedAuthority();
        const core = service(provider(), Number.POSITIVE_INFINITY, {
            readDeploymentView: () => null,
        });
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("render.deployment_missing_after_commit");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf-8")).toBe("# Project guidance\n");
    });

    it("maps a non-Error composition fault to an internal diagnostic", async () => {
        seedAuthority();
        const core = service(provider(), Number.POSITIVE_INFINITY, {
            buildRenderRegistry: () => {
                throw "fixture registry fault";
            },
        });
        const analyzed = await core.analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]).toMatchObject({
            code: "render.core_service_internal_error",
            message: "fixture registry fault",
        });
    });

    it("blocks deploy when a corrupt journal freezes the mutation scope", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        const input = await previewedApply(core, request);
        const corruptTxnId = "55555555-5555-4555-8555-555555555555";
        const corruptRoot = path.join(oaamRoot, "transactions", corruptTxnId);
        fs.mkdirSync(corruptRoot, { recursive: true });
        fs.writeFileSync(path.join(corruptRoot, "journal.json"), "not-json");
        const callsBeforeDeploy = materializeCalls;
        const deployed = await core.deployDeployment(input);
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("mutation_scope.corrupt_deployment_journal");
        expect(materializeCalls).toBe(callsBeforeDeploy);
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
    });
});
