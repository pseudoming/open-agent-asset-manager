import type { AdapterProviderSummary, AdapterRenderAnalysisResult, RenderAnalysisInput, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    makeVerifiedNativeProjectGuidanceTargetContextForTest,
    nativeProjectGuidanceRegistryComponents,
} from "../../../core/src/render/native-project-guidance";
import { opencodeProvider } from "../src/opencode-provider";
import {
    appendOpencodeBuildCompatibilityWarning,
    OPENCODE_CLI_PROJECT_GUIDANCE_BUILD_DECLARATION,
    OPENCODE_TARGET_BUILD_COMPATIBILITY,
    resolveOpencodeTargetBuildCompatibility,
} from "../src/opencode-target-build-compatibility";

const HASH = `sha256:${"9".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";
const RUNTIME_CASES = [
    {
        agentRuntimeId: "OPENCODE_CLI",
        displayName: "OpenCode CLI",
        outputContractId: "OPENCODE_NATIVE_PROJECT_GUIDANCE_V1",
        materializerCapabilityKey: "opencode.project-guidance-native-v1",
    },
    {
        agentRuntimeId: "OPENCODE_APP",
        displayName: "OpenCode App",
        outputContractId: "OPENCODE_APP_NATIVE_PROJECT_GUIDANCE_V1",
        materializerCapabilityKey: "opencode.app-project-guidance-native-v1",
    },
] as const;
type RuntimeCase = (typeof RUNTIME_CASES)[number];

function providerSummary(): AdapterProviderSummary {
    return {
        adapterId: opencodeProvider.adapterId,
        displayName: opencodeProvider.displayName,
        version: opencodeProvider.version,
        enabled: true,
        agentRuntimes: opencodeProvider.agentRuntimes,
        targetContextSchemas: opencodeProvider.targetContextSchemas,
        assetSourceCapabilities: opencodeProvider.assetSourceCapabilities,
        assetTargetCapabilities: opencodeProvider.assetTargetCapabilities,
        materializerCapabilities: opencodeProvider.materializerCapabilities,
        renderContractDeclarations: opencodeProvider.renderContractDeclarations,
    };
}

function targetContext(runtimeCase: RuntimeCase) {
    const declaration = opencodeProvider.renderContractDeclarations.find(
        (candidate) =>
            candidate.declarationKind === "native_project_guidance_v1" && candidate.agentRuntimeId === runtimeCase.agentRuntimeId,
    );
    const build = declaration?.verifiedBuilds.filter((candidate) => candidate.platform === "wsl").at(-1);
    if (build === undefined) throw new Error("OpenCode verified Guidance build is missing");
    return makeVerifiedNativeProjectGuidanceTargetContextForTest({ provider: providerSummary(), build });
}

function input(runtimeCase: RuntimeCase): RenderAnalysisInput {
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "wsl",
            targetContexts: [targetContext(runtimeCase)],
            assets: [
                {
                    scope: "project",
                    projectId: "44444444-4444-4444-8444-444444444444",
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId: VERSION_ID },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
                        files: [
                            {
                                contentKind: "text",
                                text: "# Project guidance\n",
                                file: {
                                    fileId: FILE_ID,
                                    logicalPath: "AGENTS.md",
                                    role: "entry",
                                    contentHash: HASH,
                                    contentKind: "text",
                                    mediaType: "text/markdown",
                                    byteSize: 19,
                                    executable: false,
                                    references: [],
                                },
                            },
                        ],
                    },
                    sectionHandles: { [FILE_ID]: "guidance-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            {
                semanticRefFingerprint: `sha256:${"1".repeat(64)}`,
                consumerAgentRuntimeId: runtimeCase.agentRuntimeId,
                subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                semanticKind: "asset.file_inventory",
            },
            {
                semanticRefFingerprint: `sha256:${"2".repeat(64)}`,
                consumerAgentRuntimeId: runtimeCase.agentRuntimeId,
                subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                semanticKind: "guidance.base_context",
            },
            {
                semanticRefFingerprint: `sha256:${"3".repeat(64)}`,
                consumerAgentRuntimeId: runtimeCase.agentRuntimeId,
                subject: { subjectKind: "file", assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID },
                semanticKind: "guidance.content",
            },
        ],
        dialectInputs: [],
    };
}

function firstAsset(value: RenderAnalysisInput): RenderAnalysisInput["deployment"]["assets"][number] {
    const asset = value.deployment.assets[0];
    if (asset === undefined) throw new Error("OpenCode Guidance target fixture has no Asset");
    return asset;
}

function firstFile(value: RenderAnalysisInput): RenderAnalysisInput["deployment"]["assets"][number]["version"]["files"][number] {
    const file = firstAsset(value).version.files[0];
    if (file === undefined) throw new Error("OpenCode Guidance target fixture has no entry file");
    return file;
}

describe("OpenCode CLI exact platform Guidance anchors", () => {
    it("keeps the WSL history and adds the independently loaded Win32 build", () => {
        const declaration = opencodeProvider.renderContractDeclarations.find(
            (candidate) =>
                candidate.declarationKind === "native_project_guidance_v1" && candidate.agentRuntimeId === "OPENCODE_CLI",
        );
        expect(declaration?.verifiedBuilds.map((build) => build.platform)).toEqual(["wsl", "wsl", "win32"]);
        expect(declaration?.verifiedBuilds[2]).toMatchObject({
            versionText: "1.18.15",
            buildIdentity: "sha256:fd254474def7ee35f07416cf4674c361f07e7bcd9c7ffb284af21bb011066ee3",
        });
    });

    it("routes installed 1.18.11 to the 1.17.11 WSL anchor and shares the render verdict", async () => {
        const current = {
            agentRuntimeId: "OPENCODE_CLI" as const,
            versionText: "1.18.11",
            buildIdentity: "sha256:8eb15fe87080dd11aa095cc0391eb3536d55a46fa9e4427c6a8b664d390ac089" as const,
            platform: "wsl" as const,
        };
        expect(resolveOpencodeTargetBuildCompatibility(current, OPENCODE_CLI_PROJECT_GUIDANCE_BUILD_DECLARATION)).toMatchObject({
            status: "compatible",
            reason: "newer_build",
            anchor: { versionText: "1.17.11" },
        });

        const analysisInput = input(RUNTIME_CASES[0]);
        const context = analysisInput.deployment.targetContexts[0];
        if (context === undefined) throw new Error("OpenCode CLI target context is missing");
        context.versionText = current.versionText;
        context.buildIdentity = current.buildIdentity;
        await expect(opencodeProvider.analyzeRender(analysisInput)).resolves.toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_compatibility_inferred" })],
        });
    });

    it("uses the same Provider-owned policy for older and denied project Guidance builds", () => {
        expect(
            resolveOpencodeTargetBuildCompatibility(
                {
                    agentRuntimeId: "OPENCODE_CLI",
                    versionText: "1.17.10",
                    buildIdentity: `sha256:${"c".repeat(64)}`,
                    platform: "wsl",
                },
                OPENCODE_CLI_PROJECT_GUIDANCE_BUILD_DECLARATION,
            ),
        ).toMatchObject({ status: "blocked", reason: "older_than_earliest_anchor" });

        const deniedIdentity = `sha256:${"d".repeat(64)}` as const;
        expect(
            resolveOpencodeTargetBuildCompatibility(
                {
                    agentRuntimeId: "OPENCODE_CLI",
                    versionText: "1.18.11",
                    buildIdentity: deniedIdentity,
                    platform: "wsl",
                },
                {
                    ...OPENCODE_CLI_PROJECT_GUIDANCE_BUILD_DECLARATION,
                    buildCompatibility: {
                        ...OPENCODE_TARGET_BUILD_COMPATIBILITY,
                        deniedBuilds: [
                            {
                                versionText: "1.18.11",
                                buildIdentity: deniedIdentity,
                                reasonCode: "fixture_deny",
                            },
                        ],
                    },
                },
            ),
        ).toMatchObject({ status: "blocked", reason: "denied_build", denyReasonCode: "fixture_deny" });
    });
});

describe.each(RUNTIME_CASES)("$displayName exact project Guidance target", (runtimeCase) => {
    it("claims one AGENTS.md output and preserves the complete Guidance semantic closure", async () => {
        const result = await opencodeProvider.analyzeRender(input(runtimeCase));

        expect(result).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(result.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId: runtimeCase.outputContractId,
                claims: [{ relativePath: "AGENTS.md", contentKind: "text", executable: false }],
                managedDirectoryBoundaries: [],
            }),
        ]);
        expect(result.semanticOptions).toHaveLength(3);
        expect(result.semanticOptions.every((option) => option.outcome === "preserved")).toBe(true);
        expect(result.semanticOptions.every((option) => option.renderStrategy === "native_file")).toBe(true);
        expect(result.semanticOptions.every((option) => option.actualReverseExtractPolicy === "can_reconcile")).toBe(true);
    });

    it.each([
        ["global scope", (value: RenderAnalysisInput) => (firstAsset(value).scope = "global")],
        ["nested scope", (value: RenderAnalysisInput) => (firstAsset(value).scopePath = "nested")],
        ["incomplete version", (value: RenderAnalysisInput) => (firstAsset(value).version.status = "incomplete")],
        ["executable entry", (value: RenderAnalysisInput) => (firstFile(value).file.executable = true)],
        ["extra file", (value: RenderAnalysisInput) => firstAsset(value).version.files.push({} as never)],
    ])("blocks %s instead of silently degrading it", async (_label, mutate) => {
        const candidate = structuredClone(input(runtimeCase));
        mutate(candidate);

        const result = await opencodeProvider.analyzeRender(candidate);

        expect(result).toMatchObject({ status: "failed", outputUnits: [], semanticOptions: [] });
        expect(result.blockedSemanticRefs).toHaveLength(3);
        expect(result.blockedSemanticRefs.every((item) => item.reasonCode === "project_guidance_target_not_applicable")).toBe(
            true,
        );
    });

    it("blocks incomplete materialization and inspection inputs through the registered handlers", async () => {
        const analysisInput = input(runtimeCase);
        const analysis = await opencodeProvider.analyzeRender(analysisInput);
        const outputUnit = analysis.outputUnits[0];
        const materializer = opencodeProvider.materializerCapabilities.find(
            (candidate) => candidate.materializerCapabilityKey === runtimeCase.materializerCapabilityKey,
        );
        const profile = nativeProjectGuidanceRegistryComponents([providerSummary()]).outputContracts.find(
            (candidate) => candidate.outputContractId === runtimeCase.outputContractId,
        )?.materializationProfiles[0];
        if (outputUnit === undefined || materializer === undefined || profile === undefined) {
            throw new Error("OpenCode materialization fixture is incomplete");
        }
        const outputUnitRenderer = {
            outputUnitFingerprint: outputUnit.outputUnitFingerprint,
            rendererAdapterId: opencodeProvider.adapterId,
            rendererAdapterVersion: opencodeProvider.version,
            materializerCapabilityKey: materializer.materializerCapabilityKey,
            materializationProfileId: profile.materializationProfileId,
            profileConstraintFingerprint: profile.profileConstraintFingerprint,
        };
        const materialized = await opencodeProvider.materializeRender({
            schemaVersion: 1,
            deployment: analysisInput.deployment,
            requiredSemantics: analysisInput.requiredSemantics,
            dialectInputs: analysisInput.dialectInputs,
            selection: {
                schemaVersion: 1,
                outputUnits: [outputUnit],
                outputUnitRenderers: [outputUnitRenderer],
                semanticOptions: analysis.semanticOptions,
            },
        } as never);
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [expect.objectContaining({ outputUnitFingerprint: outputUnit.outputUnitFingerprint })],
        });

        const inspected = await opencodeProvider.inspectRenderedTarget({
            schemaVersion: 1,
            deploymentId: "55555555-5555-4555-8555-555555555555",
            files: [],
            inventoryDeltas: [
                {
                    inventoryDeltaFingerprint: HASH,
                    outputUnitFingerprint: outputUnit.outputUnitFingerprint,
                    relativePath: "extra.md",
                    deltaKind: "file_added",
                    inventorySemanticRefFingerprint: HASH,
                },
            ],
            appliedRenderSnapshot: {
                outputUnits: [outputUnit],
                outputUnitRenderers: [outputUnitRenderer],
                decisions: [],
            },
            inspectionScope: {
                inspectionScopeFingerprint: HASH,
                fileStates: [],
                directoryInventories: [],
            },
        } as never);
        expect(inspected).toMatchObject({
            status: "failed",
            files: [],
            changes: [],
        });
    });

    it("adds warnings only for one valid compatible target context", () => {
        const declaration = opencodeProvider.renderContractDeclarations.find(
            (candidate) =>
                candidate.declarationKind === "native_project_guidance_v1" &&
                candidate.agentRuntimeId === runtimeCase.agentRuntimeId,
        );
        if (declaration === undefined) throw new Error("OpenCode Guidance declaration is missing");
        const baseline: AdapterRenderAnalysisResult = {
            status: "complete",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: [],
            diagnostics: [],
        };
        const withoutContext = input(runtimeCase);
        withoutContext.deployment.targetContexts = [];
        expect(appendOpencodeBuildCompatibilityWarning(baseline, withoutContext, declaration)).toBe(baseline);

        const duplicateContext = input(runtimeCase);
        const duplicatedTarget = duplicateContext.deployment.targetContexts[0];
        if (duplicatedTarget === undefined) throw new Error("OpenCode target context is missing");
        duplicateContext.deployment.targetContexts.push(structuredClone(duplicatedTarget));
        expect(appendOpencodeBuildCompatibilityWarning(baseline, duplicateContext, declaration)).toBe(baseline);

        const invalidPlatform = input(runtimeCase);
        const target = invalidPlatform.deployment.targetContexts[0];
        if (target === undefined) throw new Error("OpenCode target context is missing");
        const platformFact = target.renderFacts.find((fact) => fact.key === "oaam.platform");
        if (platformFact === undefined) throw new Error("OpenCode platform fact is missing");
        platformFact.value = "future-platform";
        expect(appendOpencodeBuildCompatibilityWarning(baseline, invalidPlatform, declaration)).toBe(baseline);

        const invalidHash = input(runtimeCase);
        const invalidHashTarget = invalidHash.deployment.targetContexts[0];
        if (invalidHashTarget === undefined) throw new Error("OpenCode target context is missing");
        invalidHashTarget.buildIdentity = "invalid";
        expect(appendOpencodeBuildCompatibilityWarning(baseline, invalidHash, declaration)).toBe(baseline);

        expect(appendOpencodeBuildCompatibilityWarning(baseline, input(runtimeCase), declaration)).toBe(baseline);

        const compatible = input(runtimeCase);
        const compatibleTarget = compatible.deployment.targetContexts[0];
        if (compatibleTarget === undefined) throw new Error("OpenCode target context is missing");
        compatibleTarget.versionText = "99.0.0";
        compatibleTarget.buildIdentity = `sha256:${"a".repeat(64)}`;
        expect(appendOpencodeBuildCompatibilityWarning(baseline, compatible, declaration)).toMatchObject({
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_compatibility_inferred" })],
        });
    });
});
