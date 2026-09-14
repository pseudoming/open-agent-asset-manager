import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAssetManifest } from "../../../src/catalog/asset-manifest";
import { writeProjectManifest } from "../../../src/catalog/project-authority";
import { publishInitialAssetVersion, readVersionAuthority } from "../../../src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../../src/catalog/version-dialect-registry";
import { executeDeployment as executeDeploymentProduction } from "../../../src/deployment/deployment-executor";
import { readDeploymentView } from "../../../src/deployment/deployment-view";
import { tryAcquireAuthorityLockLease, tryAcquireAuthorityLocks } from "../../../src/foundation/authority-locks";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";
import { computeAppliedRenderSnapshotFingerprint } from "../../../src/foundation/fingerprint";
import {
    acquireAllLocks,
    computeDeploymentOperationKey,
    computePhysicalClosureKeys,
} from "../../../src/foundation/physical-path-locks";
import { type CoreServiceConfiguration, createCoreService } from "../../../src/index";
import { clearRegistry } from "../../../src/orchestration/adapter-registry";
import { type CoreServiceTestConfiguration, createCoreServiceForTest } from "../../../src/orchestration/core-service";
import { deploymentInspectionInternalsForTest } from "../../../src/orchestration/deployment-inspection-service";
import type { DeploymentRenderServiceDependencies } from "../../../src/orchestration/deployment-render-service";
import { closeDb, getDb } from "../../../src/persistence/db";
import {
    getDeployment,
    getDeploymentAsset,
    getDeploymentFile,
    insertDeployment,
    insertDeploymentRenderSnapshot,
    softDeleteDeployment,
    softDeleteDeploymentAsset,
    softDeleteDeploymentFile,
    updateDeployment,
    upsertDeploymentAsset,
    upsertDeploymentFile,
} from "../../../src/persistence/state-db";
import {
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
} from "../../../src/render/deployment-render-authority";
import {
    createNativeProjectGuidanceProviderSupport,
    nativeProjectGuidanceRegistryComponentsForTest,
    resolveObservedNativeProjectGuidanceTargetContextForTest,
    type VerifiedNativeProjectGuidanceBuild,
} from "../../../src/render/native-project-guidance";
import { createRenderRegistry } from "../../../src/render/render-registry";
import { resolveCoreRenderSelection, resolveCoreRenderSelectionWithAuthorityLeases } from "../../../src/render/render-selection";
import type {
    AdapterId,
    AdapterProbeResult,
    AdapterProvider,
    AdapterProviderSummary,
    DeployWithRenderSelectionInput,
    OperationDiagnostic,
    ProbeResult,
    RenderAnalysisView,
    RenderMaterializationResult,
    RenderSelectionRequest,
    UuidV4,
} from "../../../src/types";
import { makeContractProvider } from "../../adapters/fixtures/adapter-contract-fixtures";
import { ASSET_ID, makeAsset, makeTextFile, makeVersionClosure, PROJECT_ID, VERSION_ID } from "../../catalog/fixtures/version-v2";

export const ADAPTER_ID = "CLAUDE_CODE" as AdapterId;

export const AGENT_RUNTIME_ID = "CLAUDE_CODE_CLI";

export const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111" as UuidV4;

export const PUBLISH_TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";

export const MISSING_DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333" as UuidV4;

export const MISSING_VERSION_ID = "44444444-4444-4444-8444-444444444444" as UuidV4;

export const SECOND_ASSET_ID = "66666666-6666-4666-8666-666666666666" as UuidV4;

export const PREPARATION_ID = "77777777-7777-4777-8777-777777777777" as UuidV4;

export const REVERSE_TRANSACTION_ID = "88888888-8888-4888-8888-888888888888" as UuidV4;

export const REVERSE_VERSION_ID = "99999999-9999-4999-8999-999999999999" as UuidV4;

export const PREPARATION_ID_2 = "12121212-1212-4212-8212-121212121212" as UuidV4;

export const REVERSE_TRANSACTION_ID_2 = "13131313-1313-4313-8313-131313131313" as UuidV4;

export const REVERSE_VERSION_ID_2 = "14141414-1414-4414-8414-141414141414" as UuidV4;

export const BUILD_BYTES = new Uint8Array(Buffer.from("oaam-core-service-render-fixture"));

export const BUILD_IDENTITY = sha256Bytes(BUILD_BYTES);

export const FIXTURE_SET_FINGERPRINT = `sha256:${"f".repeat(64)}` as const;

export interface RuntimeFixtureProfile {
    adapterId: AdapterId;
    agentRuntimeId: "CLAUDE_CODE_CLI" | "ANTIGRAVITY_CLI";
    materializationProfileId: string;
    outputContractId: string;
    relativePath: "CLAUDE.md" | "AGENTS.md";
    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1" | "ANTIGRAVITY_CLI_PROJECT_GUIDANCE_TARGET_V1";
    requiredFacts: Record<string, string>;
}

export const CLAUDE_CODE_FIXTURE: RuntimeFixtureProfile = {
    adapterId: ADAPTER_ID,
    agentRuntimeId: AGENT_RUNTIME_ID,
    materializationProfileId: "claude-code-cli-project-guidance-v1",
    outputContractId: "TEST_CLAUDECODE_NATIVE_PROJECT_GUIDANCE_V1",
    relativePath: "CLAUDE.md",
    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
    requiredFacts: {},
};

export const ANTIGRAVITY_FIXTURE: RuntimeFixtureProfile = {
    adapterId: "ANTIGRAVITY" as AdapterId,
    agentRuntimeId: "ANTIGRAVITY_CLI",
    materializationProfileId: "antigravity-cli-project-guidance-v1",
    outputContractId: "TEST_ANTIGRAVITY_NATIVE_PROJECT_GUIDANCE_V1",
    relativePath: "AGENTS.md",
    targetContextSchemaId: "ANTIGRAVITY_CLI_PROJECT_GUIDANCE_TARGET_V1",
    requiredFacts: { "oaam.project-binding": "registered" },
};

export let sandbox = "";

export let oaamRoot = "";

export let targetRoot = "";

export let databasePath = "";

export let executablePath = "";

export let materializeCalls = 0;

export let probeCalls = 0;

export let resolverCalls = 0;

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-core-render-"));
    oaamRoot = path.join(sandbox, "oaam");
    targetRoot = path.join(sandbox, "project");
    databasePath = path.join(sandbox, "state.db");
    executablePath = path.join(sandbox, "bin", "claude");
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.mkdirSync(targetRoot);
    fs.writeFileSync(executablePath, BUILD_BYTES, { mode: 0o755 });
    materializeCalls = 0;
    probeCalls = 0;
    resolverCalls = 0;
    clearRegistry();
    closeDb();
});

afterEach(() => {
    closeDb();
    clearRegistry();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

export function verifiedBuild(fixture: RuntimeFixtureProfile = CLAUDE_CODE_FIXTURE): VerifiedNativeProjectGuidanceBuild {
    return {
        agentRuntimeId: fixture.agentRuntimeId,
        versionText: "9.9.9-test",
        buildIdentity: BUILD_IDENTITY,
        platform: "wsl",
        materializationProfileId: fixture.materializationProfileId,
        fixtureSetFingerprint: FIXTURE_SET_FINGERPRINT,
    };
}

export function resolveObservedTarget(
    input: Parameters<DeploymentRenderServiceDependencies["resolveObservedTargetContext"]>[0],
    fixture: RuntimeFixtureProfile = CLAUDE_CODE_FIXTURE,
) {
    return resolveObservedNativeProjectGuidanceTargetContextForTest(input, {
        verifiedBuilds: [verifiedBuild(fixture)],
        readBuildArtifact: () => ({
            bytes: new Uint8Array(BUILD_BYTES),
            executable: true,
            identity: { deviceId: "1", fileId: "2", entryKind: "file" },
        }),
    });
}

export function completeProbe(fixture: RuntimeFixtureProfile = CLAUDE_CODE_FIXTURE): AdapterProbeResult {
    return {
        status: "complete",
        observation: {
            observedAgentRuntimes: [
                {
                    agentRuntimeId: fixture.agentRuntimeId,
                    versionText: verifiedBuild(fixture).versionText,
                    installationEvidence: [
                        {
                            kind: "executable",
                            path: executablePath,
                            evidenceLevel: "agent_runtime_verified",
                            diagnostics: [],
                        },
                    ],
                    sourceRootIds: ["project-root"],
                    agentRuntimeResourceIds: ["project-registry"],
                    observedProjectIds: ["project-a"],
                    installationStatus: "available",
                    projectDiscoveryStatus: "complete",
                    diagnostics: [],
                },
            ],
            sourceRoots: [
                {
                    sourceRootId: "project-root",
                    rootRole: "project_actual",
                    sourceDomain: "project_root",
                    path: targetRoot,
                    accessStatus: "available",
                    locatorEvidence: [
                        {
                            locatorKind: "project_registry_entry",
                            locatorKey: "project-a",
                            evidenceLevel: "agent_runtime_verified",
                        },
                    ],
                    diagnostics: [],
                },
            ],
            agentRuntimeResources: [
                {
                    agentRuntimeResourceId: "project-registry",
                    roles: ["project_registry"],
                    path: path.join(sandbox, "project-registry.json"),
                    accessStatus: "available",
                    locatorEvidence: [
                        {
                            locatorKind: "runtime_known_rule",
                            locatorKey: "project_registry",
                            evidenceLevel: "agent_runtime_verified",
                        },
                    ],
                    diagnostics: [],
                },
            ],
            observedProjects: [
                {
                    observedProjectId: "project-a",
                    runtimeProjectKey: "project-a",
                    displayName: "Project A",
                    workspaces: [{ sourceRootId: "project-root", role: "primary" }],
                    evidence: [
                        {
                            evidenceKind: "agent_runtime_resource",
                            agentRuntimeResourceId: "project-registry",
                            locatorKey: "project-a",
                            evidenceLevel: "agent_runtime_verified",
                        },
                    ],
                    diagnostics: [],
                },
            ],
            targetCandidates: [
                {
                    targetCandidateId: "project-target",
                    targetRootPath: targetRoot,
                    targetKind: "project",
                    displayName: "Project A",
                    entryApplicabilities: [
                        {
                            agentRuntimeId: fixture.agentRuntimeId,
                            status: "ready_for_plan",
                            locatorEvidence: [
                                {
                                    locatorKind: "project_registry_entry",
                                    locatorKey: "project-a",
                                    evidenceLevel: "agent_runtime_verified",
                                },
                            ],
                            diagnostics: [],
                        },
                    ],
                    diagnostics: [],
                },
            ],
        },
        diagnostics: [],
    };
}

export function currentProbeResult(fixture: RuntimeFixtureProfile = CLAUDE_CODE_FIXTURE): ProbeResult {
    const result = completeProbe(fixture);
    return {
        ...result,
        observation: {
            ...result.observation,
            adapterId: fixture.adapterId,
            platformContext: {
                platform: "wsl",
                platformInstanceId: "wsl-test",
                accessRootPath: sandbox,
            },
        },
    };
}

export function provider(
    options: {
        adapterVersion?: string;
        materializationFailure?: boolean;
        materializationFailureOnCall?: number;
        probeDiagnostics?: OperationDiagnostic[];
        afterMaterialize?: () => void;
    } = {},
    fixture: RuntimeFixtureProfile = CLAUDE_CODE_FIXTURE,
): AdapterProvider {
    const selected = makeContractProvider(fixture.adapterId, completeProbe(fixture));
    selected.version = options.adapterVersion ?? selected.version;
    const support = createNativeProjectGuidanceProviderSupport({
        adapterId: fixture.adapterId,
        adapterVersion: selected.version,
        agentRuntimes: selected.agentRuntimes,
        agentRuntimeId: fixture.agentRuntimeId,
        outputContractId: fixture.outputContractId,
        materializationProfileId: fixture.materializationProfileId,
        target: {
            relativePath: fixture.relativePath,
            targetContextSchemaId: fixture.targetContextSchemaId,
            requiredFacts: structuredClone(fixture.requiredFacts),
        },
        verifiedBuilds: [verifiedBuild(fixture)],
    });
    selected.targetContextSchemas = [support.targetContextSchema];
    selected.assetTargetCapabilities = selected.assetTargetCapabilities.map((capability) =>
        capability.assetKind === "Guidance" ? support.targetCapability : capability,
    );
    selected.materializerCapabilities = [support.materializerCapability];
    selected.renderContractDeclarations = [support.renderContractDeclaration];
    selected.probe = async () => {
        probeCalls += 1;
        const result = completeProbe(fixture);
        result.diagnostics = structuredClone(options.probeDiagnostics ?? []);
        return result;
    };
    selected.analyzeRender = async (input) => support.analyze(input);
    selected.materializeRender = async (input) => {
        materializeCalls += 1;
        const result: RenderMaterializationResult =
            options.materializationFailure || options.materializationFailureOnCall === materializeCalls
                ? {
                      status: "failed",
                      materializationState: "blocked",
                      reasonCode: "fixture_materialization_failed",
                      diagnostics: [diagnostic("fixture_materialization_failed")],
                  }
                : support.materialize(input);
        options.afterMaterialize?.();
        return result;
    };
    selected.inspectRenderedTarget = async (input) => support.inspect(input);
    return selected;
}

export function diagnostic(code: string, severity: OperationDiagnostic["severity"] = "error"): OperationDiagnostic {
    return {
        severity,
        code,
        message: code,
        path: "",
        traceId: "",
        operation: "render",
        causeKind: "verification_failed",
        retryable: false,
        suggestedActions: [],
        rawSummary: code,
    };
}

export function seedAuthority(
    version = makeVersionClosure({
        files: [makeTextFile("# Project guidance\n", "GUIDANCE.md")],
    }),
): void {
    fs.mkdirSync(oaamRoot, { recursive: true });
    writeProjectManifest(path.join(oaamRoot, "projects"), {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        rootPath: targetRoot,
        displayName: "Fixture Project",
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
    });
    fs.mkdirSync(path.join(oaamRoot, "assets"), { recursive: true });
    publishInitialAssetVersion({
        assetsRoot: path.join(oaamRoot, "assets"),
        transactionId: PUBLISH_TRANSACTION_ID,
        asset: makeAsset([version.manifest.versionId], {
            scope: "project",
            projectId: PROJECT_ID,
            scopePath: "",
        }),
        version,
        dialectRegistry: createVersionDialectRegistry([], [], [], []),
    });
    insertDeployment(getDb(databasePath), {
        deploymentId: DEPLOYMENT_ID,
        consumerAgentRuntimeIds: JSON.stringify([AGENT_RUNTIME_ID]),
        platform: "wsl",
        platformInstanceId: "wsl-test",
        targetRootPath: targetRoot,
        projectId: PROJECT_ID,
        committedTransactionId: "",
        appliedInputsSnapshot: JSON.stringify({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            consumerAgentRuntimeIds: [AGENT_RUNTIME_ID],
            assets: [],
        }),
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence:
            '{"schemaVersion":1,"reasonCode":"","operation":"","contextFingerprint":"","occurredAt":0,"diagnostics":[],"suggestedActions":[],"retryable":false}',
        deleted: 0,
        createdAt: 1,
        updatedAt: 1,
    });
    upsertDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID, version.manifest.versionId, 1, 0, 2);
}

export function seedGlobalAuthority(): void {
    const text = "# Global guidance\n";
    fs.mkdirSync(oaamRoot, { recursive: true });
    fs.mkdirSync(path.join(oaamRoot, "assets"), { recursive: true });
    publishInitialAssetVersion({
        assetsRoot: path.join(oaamRoot, "assets"),
        transactionId: PUBLISH_TRANSACTION_ID,
        asset: makeAsset([VERSION_ID], {
            scope: "global",
            projectId: "",
            scopePath: "",
        }),
        version: makeVersionClosure({
            files: [makeTextFile(text, "GUIDANCE.md")],
        }),
        dialectRegistry: createVersionDialectRegistry([], [], [], []),
    });
    insertDeployment(getDb(databasePath), {
        deploymentId: DEPLOYMENT_ID,
        consumerAgentRuntimeIds: JSON.stringify([AGENT_RUNTIME_ID]),
        platform: "wsl",
        platformInstanceId: "wsl-test",
        targetRootPath: targetRoot,
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: JSON.stringify({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            consumerAgentRuntimeIds: [AGENT_RUNTIME_ID],
            assets: [],
        }),
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence:
            '{"schemaVersion":1,"reasonCode":"","operation":"","contextFingerprint":"","occurredAt":0,"diagnostics":[],"suggestedActions":[],"retryable":false}',
        deleted: 0,
        createdAt: 1,
        updatedAt: 1,
    });
    upsertDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID, VERSION_ID, 1, 0, 2);
}

export function service(
    selectedProvider = provider(),
    resolverFailsAfter = Number.POSITIVE_INFINITY,
    dependencyOverrides: Partial<DeploymentRenderServiceDependencies> = {},
    configurationOverrides: Partial<CoreServiceTestConfiguration> = {},
    fixture: RuntimeFixtureProfile = CLAUDE_CODE_FIXTURE,
) {
    const build = verifiedBuild(fixture);
    const core = createCoreServiceForTest(
        {
            providers: [selectedProvider],
            platformContexts: [
                {
                    platform: "wsl",
                    platformInstanceId: "wsl-test",
                    accessRootPath: sandbox,
                },
            ],
            oaamRoot,
            databasePath,
            now: (() => {
                let value = 10;
                return () => (value += 1);
            })(),
            ...configurationOverrides,
        },
        {
            resolveProjectId: () => PROJECT_ID,
            buildRenderRegistry(providers: AdapterProviderSummary[]) {
                return createRenderRegistry({
                    providers,
                    ...nativeProjectGuidanceRegistryComponentsForTest(providers, [build]),
                });
            },
            resolveObservedTargetContext(input) {
                resolverCalls += 1;
                if (resolverCalls > resolverFailsAfter) {
                    return {
                        status: "failed",
                        diagnostics: [diagnostic("fixture_observed_context_changed")],
                    };
                }
                return resolveObservedTarget(input, fixture);
            },
            ...dependencyOverrides,
        },
    );
    return enableFixtureAdapters(core, [fixture.adapterId]);
}

export function multiRuntimeService(
    newUuid: () => UuidV4,
    providers = [provider({}, CLAUDE_CODE_FIXTURE), provider({}, ANTIGRAVITY_FIXTURE)],
) {
    const builds = [verifiedBuild(CLAUDE_CODE_FIXTURE), verifiedBuild(ANTIGRAVITY_FIXTURE)];
    const core = createCoreServiceForTest(
        {
            providers,
            platformContexts: [
                {
                    platform: "wsl",
                    platformInstanceId: "wsl-test",
                    accessRootPath: sandbox,
                },
            ],
            oaamRoot,
            databasePath,
            now: (() => {
                let value = 100;
                return () => (value += 1);
            })(),
            newUuid,
        },
        {
            resolveProjectId: () => PROJECT_ID,
            buildRenderRegistry(providerSummaries: AdapterProviderSummary[]) {
                return createRenderRegistry({
                    providers: providerSummaries,
                    ...nativeProjectGuidanceRegistryComponentsForTest(providerSummaries, builds),
                });
            },
            resolveObservedTargetContext(input) {
                const fixture = input.agentRuntimeId === "CLAUDE_CODE_CLI" ? CLAUDE_CODE_FIXTURE : ANTIGRAVITY_FIXTURE;
                return resolveObservedTarget(input, fixture);
            },
        },
    );
    return enableFixtureAdapters(
        core,
        providers.map((item) => item.adapterId),
    );
}

function enableFixtureAdapters<T extends ReturnType<typeof createCoreServiceForTest>>(
    core: T,
    enabledAdapterIds: AdapterId[],
): T {
    const current = core.getAdapterEnablement();
    if (current.status === "failed") throw new Error("fixture adapter enablement could not be read");
    const currentEnabled = new Set<AdapterId>(current.value.enabledAdapterIds);
    if (
        current.value.enabledAdapterIds.length === enabledAdapterIds.length &&
        enabledAdapterIds.every((adapterId) => currentEnabled.has(adapterId))
    ) {
        return core;
    }
    const enabled = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds,
        userActionId: "render-fixture-enable",
    });
    if (enabled.status === "failed") {
        throw new Error(`fixture adapter enablement failed: ${JSON.stringify(enabled.diagnostics)}`);
    }
    return core;
}

export function selectionRequest(analysis: RenderAnalysisView): RenderSelectionRequest {
    const semanticOptions = analysis.analyses.flatMap((item) => item.semanticOptions);
    return {
        schemaVersion: 1,
        renderInputFingerprint: analysis.renderInputFingerprint,
        semanticOptions: analysis.requiredSemantics.map((semantic) => {
            const matches = semanticOptions.filter((option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint);
            if (matches.length !== 1) throw new Error("selection fixture is not unique");
            return {
                optionFingerprint: matches[0]!.optionFingerprint,
                approvalRequest: { approvalAction: "none" },
            };
        }),
    };
}

export async function analyzeAndSelect(core: ReturnType<typeof service>) {
    const analysis = await core.analyzeDeploymentRender(DEPLOYMENT_ID);
    expect(analysis.status, JSON.stringify(analysis.diagnostics)).toBe("complete");
    return selectionRequest(analysis.value);
}

export async function previewRender(core: ReturnType<typeof service>, selection: RenderSelectionRequest) {
    return core.previewDeploymentRender({ deploymentId: DEPLOYMENT_ID, selectionRequest: selection });
}

export async function previewedApply(
    core: ReturnType<typeof service>,
    selection: RenderSelectionRequest,
): Promise<DeployWithRenderSelectionInput> {
    const preview = await previewRender(core, selection);
    expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
    return {
        deploymentId: DEPLOYMENT_ID,
        selectionRequest: selection,
        expectedPreviewFingerprint: preview.value.previewFingerprint,
        deploymentAction: "apply",
    };
}

export function reverseUuidSequence(
    values: UuidV4[] = [PREPARATION_ID, REVERSE_TRANSACTION_ID, REVERSE_VERSION_ID],
): () => UuidV4 {
    values = [...values];
    return () => {
        const value = values.shift();
        if (value === undefined) throw new Error("reverse UUID fixture exhausted");
        return value;
    };
}
