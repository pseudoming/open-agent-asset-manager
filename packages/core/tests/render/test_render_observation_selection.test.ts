import { withAssetUsageTargetOperations } from "../../src/orchestration/deployment-target-operations";
import type { PlatformContext } from "../../src/types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVersionDialectRegistry, EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-dialect-registry";
import type { SemanticRenderOption } from "../../src/contracts/render";
import { clearRegistry, enableAdapter, registerAdapterProvider } from "../../src/orchestration/adapter-registry";
import { observeAssetUsageRenderTargets as captureAssetUsageRenderTargets } from "../../src/orchestration/asset-usage-render-observation";
import { createTargetCheckObservationSnapshot } from "../../src/render/native-project-target-observation-snapshot";
import { chooseObservationMatch } from "../../src/render/render-observation-option-ranking";
import { resolveAssetUsageObservationSelection } from "../../src/render/render-selection";
import {
    asExactGraphProvider,
    GRAPH_BINARY_RESOURCE_PATH,
    makeExactGraphFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";
import { makeLifecycleAdapterProvider, makeLifecycleFixture } from "./fixtures/render-lifecycle-fixtures";

let root = "";
beforeEach(() => {
    clearRegistry();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-render-observation-selection-"));
});
afterEach(() => {
    clearRegistry();
    fs.rmSync(root, { recursive: true, force: true });
});

function observeAssetUsageRenderTargets(
    input: Omit<Parameters<typeof captureAssetUsageRenderTargets>[0], "targetOperations"> & {
        targetRootPath: string;
        platformContext: PlatformContext;
    },
) {
    const { targetRootPath, platformContext, ...observation } = input;
    return withAssetUsageTargetOperations(
        { platformContexts: [platformContext] },
        {
            ...input.operation.deployment,
            platform: platformContext.platform,
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath,
        },
        (targetOperations) => captureAssetUsageRenderTargets({ ...observation, targetOperations }),
    );
}

describe("read-only render observation selection", () => {
    it("preserves selection and shared-container failures without target writes", async () => {
        const selectionFixture = await makeLifecycleFixture(fs.mkdtempSync(path.join(root, "selection-failure-")));
        const consumer = selectionFixture.deployment.consumerAgentRuntimeIds[0]!;
        const staleSelection = await observeAssetUsageRenderTargets({
            operation: {
                deployment: selectionFixture.deployment,
                registry: { ...selectionFixture.registry, fingerprint: `sha256:${"9".repeat(64)}` },
                dialectInputs: [],
                diagnostics: [],
            },
            analysis: selectionFixture.analysis,
            consumerAgentRuntimeIds: [consumer],
            targetRootPath: root,
            platformContext: { platform: "linux", platformInstanceId: "local", accessRootPath: root },
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(staleSelection.observedTargetStates.size).toBe(0);
        expect(staleSelection.diagnostics[0]?.code).toBe("render.registry_stale");

        const patchRoot = path.join(root, "container-patch");
        const patchFixture = makeExactGraphFixture({
            targetRootPath: patchRoot,
            jsoncTopLevelPropertyPatch: {
                propertyName: "instructions",
                allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH],
            },
        });
        fs.mkdirSync(path.dirname(path.join(patchRoot, GRAPH_BINARY_RESOURCE_PATH)), { recursive: true });
        fs.writeFileSync(path.join(patchRoot, GRAPH_BINARY_RESOURCE_PATH), "{}\n");
        const exactProvider = asExactGraphProvider(patchFixture);
        const liveProvider = makeLifecycleAdapterProvider(patchFixture.provider);
        liveProvider.dialectContracts = exactProvider.dialectContracts;
        liveProvider.analyzeRender = exactProvider.analyzeRender;
        liveProvider.materializeRender = exactProvider.materializeRender;
        liveProvider.inspectRenderedTarget = exactProvider.inspectRenderedTarget;
        const registration = registerAdapterProvider(liveProvider);
        expect(registration.status, JSON.stringify(registration.diagnostics)).toBe("complete");
        expect(enableAdapter(liveProvider.adapterId).status).toBe("complete");
        const providerAnalysis = patchFixture.support.analyze(patchFixture.analysisInput);
        if (providerAnalysis.status !== "complete") throw new Error("patch analysis fixture failed");
        const patchObservation = await observeAssetUsageRenderTargets({
            operation: {
                deployment: patchFixture.deployment,
                registry: patchFixture.registry,
                dialectInputs: structuredClone(patchFixture.analysisInput.dialectInputs),
                diagnostics: [],
            },
            analysis: {
                renderInputFingerprint: patchFixture.deployment.renderInputFingerprint,
                requiredSemantics: patchFixture.requiredSemantics,
                analyses: [
                    {
                        ...providerAnalysis,
                        adapterId: patchFixture.provider.adapterId,
                        adapterVersion: patchFixture.provider.version,
                    },
                ],
            },
            consumerAgentRuntimeIds: [patchFixture.descriptor.agentRuntimeId],
            targetRootPath: patchRoot,
            platformContext: { platform: "linux", platformInstanceId: "local", accessRootPath: patchRoot },
            dialectRegistry: createVersionDialectRegistry([patchFixture.nativeDialect], [], [], []),
        });
        expect(patchObservation.observedTargetStates.size).toBe(0);
        expect(patchObservation.diagnostics[0]?.code).toBe("render.materialization_container_patch_rejected");
    });

    it("selects one deterministic approval-free option and rejects missing semantics", async () => {
        const observationRoot = path.join(root, "observed-target");
        const observationFixture = makeExactGraphFixture({ targetRootPath: observationRoot });
        const exactProvider = asExactGraphProvider(observationFixture);
        const providerAnalysis = observationFixture.support.analyze(observationFixture.analysisInput);
        if (providerAnalysis.status !== "complete") throw new Error("observation analysis fixture failed");
        const liveProvider = makeLifecycleAdapterProvider(observationFixture.provider);
        liveProvider.dialectContracts = exactProvider.dialectContracts;
        liveProvider.analyzeRender = exactProvider.analyzeRender;
        liveProvider.materializeRender = exactProvider.materializeRender;
        liveProvider.inspectRenderedTarget = exactProvider.inspectRenderedTarget;
        const providerRegistration = registerAdapterProvider(liveProvider);
        expect(providerRegistration.status, JSON.stringify(providerRegistration.diagnostics)).toBe("complete");
        expect(enableAdapter(liveProvider.adapterId).status).toBe("complete");
        const observationInput = {
            operation: {
                deployment: observationFixture.deployment,
                registry: observationFixture.registry,
                dialectInputs: structuredClone(observationFixture.analysisInput.dialectInputs),
                diagnostics: [],
            },
            analysis: {
                renderInputFingerprint: observationFixture.deployment.renderInputFingerprint,
                requiredSemantics: observationFixture.requiredSemantics,
                analyses: [
                    {
                        ...providerAnalysis,
                        adapterId: observationFixture.provider.adapterId,
                        adapterVersion: observationFixture.provider.version,
                    },
                ],
            },
            consumerAgentRuntimeIds: [observationFixture.descriptor.agentRuntimeId],
            targetRootPath: observationRoot,
            platformContext: { platform: "linux", platformInstanceId: "local", accessRootPath: observationRoot },
            dialectRegistry: createVersionDialectRegistry([observationFixture.nativeDialect], [], [], []),
        } satisfies Parameters<typeof observeAssetUsageRenderTargets>[0];
        const observed = await observeAssetUsageRenderTargets({
            ...observationInput,
            targetCheckSnapshot: createTargetCheckObservationSnapshot(),
        });
        expect(observed.observedTargetStates.get(observationFixture.descriptor.agentRuntimeId)).toBe("absent");
        const observedWithoutSnapshot = await observeAssetUsageRenderTargets(observationInput);
        expect(observedWithoutSnapshot.observedTargetStates.get(observationFixture.descriptor.agentRuntimeId)).toBe("absent");

        clearRegistry();
        const fixture = await makeLifecycleFixture(fs.mkdtempSync(path.join(root, "observation-selection-")));
        const consumer = fixture.deployment.consumerAgentRuntimeIds[0]!;
        const noConsumer = resolveAssetUsageObservationSelection(
            { deployment: fixture.deployment, analysis: fixture.analysis },
            fixture.registry,
            [],
        );
        expect(noConsumer.diagnostics[0]?.code).toBe("asset_usage.observation_semantics_missing");

        const blocked = structuredClone(fixture.analysis);
        const semanticRefFingerprint = blocked.requiredSemantics[0]!.semanticRefFingerprint;
        blocked.analyses[0]!.semanticOptions = [];
        blocked.analyses[0]!.blockedSemanticRefs = [{ semanticRefFingerprint, reasonCode: "fixture_blocked", diagnostics: [] }];
        const noOption = resolveAssetUsageObservationSelection(
            { deployment: fixture.deployment, analysis: blocked },
            fixture.registry,
            [consumer],
        );
        expect(noOption.diagnostics[0]?.code).toBe("asset_usage.observation_option_unavailable");

        const degradedFixture = await makeLifecycleFixture(fs.mkdtempSync(path.join(root, "observation-degraded-")), {
            analysisResultOptions: { outcome: "degraded" },
            approveRequiredOption: true,
        });
        const degraded = resolveAssetUsageObservationSelection(
            { deployment: degradedFixture.deployment, analysis: degradedFixture.analysis },
            degradedFixture.registry,
            [degradedFixture.deployment.consumerAgentRuntimeIds[0]!],
        );
        expect(degraded.status).toBe("complete");
        expect(degraded.value.selection.semanticOptions[0]?.outcome).toBe("degraded");

        const base = fixture.analysis.analyses[0]!.semanticOptions[0]!;
        const option = (overrides: Partial<SemanticRenderOption>): SemanticRenderOption => ({
            ...structuredClone(base),
            ...overrides,
        });
        const ranked = (options: readonly SemanticRenderOption[]) =>
            chooseObservationMatch(options.map((candidate) => ({ analysis: fixture.analysis.analyses[0]!, option: candidate })))
                ?.option ?? null;
        const degradedOne = option({
            optionFingerprint: `sha256:${"4".repeat(64)}`,
            outcome: "degraded",
            degradationKinds: ["runtime_specific_metadata_lost"],
            degradationFingerprint: `sha256:${"5".repeat(64)}`,
        });
        const degradedTwo = option({
            optionFingerprint: `sha256:${"6".repeat(64)}`,
            outcome: "degraded",
            degradationKinds: ["runtime_specific_metadata_lost", "tool_permission_weakened"],
            degradationFingerprint: `sha256:${"7".repeat(64)}`,
        });
        expect(ranked([])).toBeNull();
        expect(ranked([degradedOne, base])).toBe(base);
        expect(ranked([degradedTwo, degradedOne])).toBe(degradedOne);
        const unsupportedReverse = option({
            optionFingerprint: `sha256:${"8".repeat(64)}`,
            actualReverseExtractPolicy: "unsupported",
        });
        expect(ranked([unsupportedReverse, base])).toBe(base);
        const laterFingerprint = option({ optionFingerprint: `sha256:${"f".repeat(64)}` });
        expect(ranked([laterFingerprint, base])).toBe(base);
    });
});
