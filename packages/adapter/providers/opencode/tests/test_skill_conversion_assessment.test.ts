import type {
    AdapterNativeProjectExactGraphRenderDeclarationV1,
    AdapterProviderSummary,
    MaterializedRenderFile,
    RenderMaterializationInput,
    ProviderRenderDialectInputsForAsset,
    RenderAnalysisInput,
    RenderDeploymentInput,
    TargetAgentRuntimeRenderContext,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import { createVersionDialectRegistry } from "../../../../core/src/catalog/version-dialect-registry";
import {
    computeRenderInputFingerprint,
    computeTargetApplicabilityFingerprint,
} from "../../../../core/src/foundation/fingerprint";
import { adapterRenderRegistryComponents } from "../../../../core/src/render/adapter-render-contract-registration";
import { isExactGraphNativeConsistencySatisfied } from "../../../../core/src/render/native-project-exact-graph-consistency";
import { resolveProviderExactFileDialectInputs } from "../../../../core/src/render/render-dialect-authority";
import { canonicalValueForSemantic } from "../../../../core/src/render/render-materialization-coverage";
import { createRenderRegistry } from "../../../../core/src/render/render-registry";
import { deriveRequiredRenderSemanticsV1 } from "../../../../core/src/render/render-semantics";
import { opencodeProvider } from "../src/opencode-provider";
import { OPENCODE_NATIVE_DIALECTS } from "../src/opencode-source-read-model";
import { readBoth, validationInput } from "./opencode-skill-interpretation-test-fixtures";
import {
    ASSET_ID,
    baseAnalysisFixture,
    materializationInput,
    PROJECT_ID,
    supportFor,
    type SkillVariant,
    VERSION_ID,
} from "./opencode-skill-target-test-fixtures";

const provider: AdapterProviderSummary = {
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
const components = adapterRenderRegistryComponents(
    [provider],
    new Map([[provider.adapterId, opencodeProvider.canonicalMaterializationValidators!]]),
);
const registry = createRenderRegistry({ providers: [provider], ...components });
const dialectRegistry = createVersionDialectRegistry(opencodeProvider.dialectContracts.native, [], [], []);
function context(agentRuntimeId: "OPENCODE_CLI" | "OPENCODE_APP"): TargetAgentRuntimeRenderContext {
    const declaration = provider.renderContractDeclarations.find(
        (item): item is AdapterNativeProjectExactGraphRenderDeclarationV1 =>
            item.declarationKind === "native_project_exact_graph_v1" &&
            item.assetKind === "Skill" &&
            item.agentRuntimeId === agentRuntimeId,
    );
    if (declaration === undefined) throw new Error("missing exact Skill declaration");
    const schema = provider.targetContextSchemas.find(
        (schema) => schema.targetContextSchemaId === declaration.target.targetContextSchemaId,
    );
    const build = declaration.verifiedBuilds.find((build) => build.platform === "wsl" && build.versionText === "1.18.15");
    if (schema === undefined || build === undefined) throw new Error("missing exact target facts");
    const preimage = {
        schemaVersion: 1 as const,
        agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        targetContextSchemaId: schema.targetContextSchemaId,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        renderFacts: [
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" as const },
            { key: "oaam.project-binding", value: "registered", evidenceLevel: "agent_runtime_verified" as const },
            ...Object.entries(declaration.target.requiredFacts).map(([key, value]) => ({
                key,
                value,
                evidenceLevel: "agent_runtime_verified" as const,
            })),
        ],
    };
    return {
        ...preimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: preimage,
            entryClass: agentRuntimeId === "OPENCODE_CLI" ? "cli" : "app",
        }),
    };
}
async function sourceFixture(slash: string, both = false, variant: SkillVariant = "project_folder") {
    const candidates = await readBoth(slash),
        source = validationInput(candidates.historical);
    const analysis = baseAnalysisFixture(variant, VERSION_ID, source.canonicalFiles, [], supportFor(variant));
    const asset = analysis.deployment.assets[0]!;
    asset.version.canonical = structuredClone(source.canonical);
    asset.version.versionCanonicalContentFingerprint = source.representation.canonicalContentFingerprint;
    const consumers: [string, ...string[]] = both ? ["OPENCODE_APP", "OPENCODE_CLI"] : ["OPENCODE_CLI"];
    const contexts =
        variant === "project_folder"
            ? consumers.map((runtime) => context(runtime as "OPENCODE_CLI" | "OPENCODE_APP"))
            : analysis.deployment.targetContexts;
    const { renderInputFingerprint: _old, ...base } = analysis.deployment;
    const preimage = {
        ...base,
        deploymentId: "77777777-7777-4777-8777-777777777777",
        consumerAgentRuntimeIds: consumers,
        targetContexts: contexts,
        projectId: variant === "project_folder" ? PROJECT_ID : "",
        targetRootPath: "/tmp/oaam-opencode-conversion-fixture",
        renderRegistryFingerprint: registry.fingerprint,
    };
    const deployment: RenderDeploymentInput = { ...preimage, renderInputFingerprint: computeRenderInputFingerprint(preimage) };
    const requiredSemantics = deriveRequiredRenderSemanticsV1(deployment);
    const { files: descriptors, ...representation } = source.representation;
    const available: ProviderRenderDialectInputsForAsset[] = [
        {
            targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
            consumerAgentRuntimeIds: consumers,
            inputs: [
                {
                    inputKind: "native_representation",
                    inputRole: "current_exact",
                    representation,
                    files: descriptors.map((descriptor) => {
                        const file = source.nativeFiles.find((file) => file.relativePath === descriptor.relativePath);
                        if (file === undefined) throw new Error("source payload missing");
                        return descriptor.contentKind === "text"
                            ? { ...descriptor, contentKind: "text" as const, text: new TextDecoder().decode(file.bytes) }
                            : { ...descriptor, contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) };
                    }),
                },
            ],
        },
    ];
    const dialectInputs = resolveProviderExactFileDialectInputs({
        provider,
        deployment,
        semantics: requiredSemantics,
        available,
        dialectRegistry,
        renderRegistry: registry,
    });
    const input: RenderAnalysisInput = { schemaVersion: 1, deployment, requiredSemantics, dialectInputs };
    return { source, deployment, input, available };
}
function token(input: RenderAnalysisInput, runtime = "OPENCODE_CLI") {
    const result = input.dialectInputs.find((group) => group.consumerAgentRuntimeIds.includes(runtime))?.inputs[0];
    if (result === undefined) throw new Error("missing selected token");
    return result;
}

function assertGeneratedGraph(
    value: Awaited<ReturnType<typeof sourceFixture>>,
    request: RenderMaterializationInput,
    files: MaterializedRenderFile[],
): void {
    const outputUnit = request.selection.outputUnits[0]!,
        renderer = request.selection.outputUnitRenderers[0]!;
    const contract = registry.getOutputContract(outputUnit.outputContractId)!;
    const proof = registry.validateOutputContractMaterialization({
        contract,
        profile: contract.materializationProfiles.find(
            (profile) => profile.materializationProfileId === renderer.materializationProfileId,
        )!,
        outputUnit,
        selectedSemantics: request.requiredSemantics,
        canonicalValues: request.requiredSemantics.map((semantic) => canonicalValueForSemantic(value.deployment, semantic)),
        selectedOptions: request.selection.semanticOptions,
        dialectInputs: request.dialectInputs,
        files,
    });
    expect(
        isExactGraphNativeConsistencySatisfied({
            deployment: value.deployment,
            provider,
            semantics: request.requiredSemantics,
            dialectInputs: request.dialectInputs,
            outputUnit,
            renderer,
            files,
            dialectRegistry,
            renderRegistry: registry,
            canonicalCoverageProof: proof,
        }),
    ).toBe(true);
}

describe("OpenCode current CLI conversion of immutable v1 Skills", () => {
    it.each([
        { slash: "", losses: ["trigger_or_loading_level_lost"] },
        { slash: "slash: false\n", losses: ["trigger_or_loading_level_lost"] },
        { slash: "slash: true\n", losses: [] },
    ])("preserves the original graph and reports only $losses for $slash", async ({ slash, losses }) => {
        const value = await sourceFixture(slash),
            before = structuredClone(value);
        const selected = token(value.input);
        expect(selected.inputKind).toBe("canonical_materialization");
        if (selected.inputKind !== "canonical_materialization") throw new Error("expected v1-to-v2 conversion");
        expect(selected.nativeDialectId).toBe(OPENCODE_NATIVE_DIALECTS.skillCli);
        expect(selected.degradationKinds).toEqual(losses);
        expect(selected.nativePreservationSeed?.representation.dialectId).toBe(OPENCODE_NATIVE_DIALECTS.skill);
        const analysis = await opencodeProvider.analyzeRender(value.input);
        expect(analysis.status).toBe("complete");
        expect(analysis.semanticOptions.length).toBe(value.input.requiredSemantics.length);
        for (const option of analysis.semanticOptions) {
            expect(option.outcome).toBe(losses.length === 0 ? "preserved" : "degraded");
            expect(option.approvalRequirement.approvalState).toBe(losses.length === 0 ? "not_required" : "required");
            if (option.outcome === "degraded") expect(option.degradationKinds).toEqual(losses);
            if (losses.length === 0) expect(option.diagnostics).toEqual([]);
        }
        const request = materializationInput(value.input, "project_folder"),
            result = await opencodeProvider.materializeRender(request);
        if (result.materializationState !== "materialized") throw new Error("old Skill failed to materialize");
        const files = result.materializedUnits[0]?.files;
        expect(files).toHaveLength(4);
        for (const file of files) {
            const original = value.source.nativeFiles.find((item) => item.relativePath === file.relativePath)!;
            const descriptor = value.source.representation.files.find((item) => item.relativePath === file.relativePath)!;
            const bytes = file.content.contentKind === "text" ? new TextEncoder().encode(file.content.text) : file.content.bytes;
            expect(bytes).toEqual(original.bytes);
            expect(file.executable).toBe(descriptor.executable);
        }
        assertGeneratedGraph(value, request, files);
        expect(value).toEqual(before);
    });

    it.each([
        "",
        "slash: true\n",
    ])("keeps exact CLI and App selections distinct at the same physical source for %s", async (slash) => {
        const value = await sourceFixture(slash, true),
            cli = token(value.input),
            app = token(value.input, "OPENCODE_APP");
        expect(value.input.dialectInputs).toHaveLength(2);
        expect(cli.inputKind).toBe("canonical_materialization");
        expect(app.inputKind).toBe("native_representation");
        if (cli.inputKind !== "canonical_materialization" || app.inputKind !== "native_representation")
            throw new Error("wrong consumer interpretation");
        expect(cli.nativeDialectId).toBe(OPENCODE_NATIVE_DIALECTS.skillCli);
        expect(app.representation.dialectId).toBe(OPENCODE_NATIVE_DIALECTS.skill);
        expect(cli.degradationKinds).toEqual(slash === "" ? ["trigger_or_loading_level_lost"] : []);
        expect(cli.nativePreservationSeed?.files).toEqual(app.files);
        const analysis = await opencodeProvider.analyzeRender(value.input);
        expect(analysis.status).toBe("complete");
        expect(new Set(analysis.outputUnits.map((unit) => unit.outputContractId))).toEqual(
            new Set(["OPENCODE_CLI_NATIVE_PROJECT_SKILL_DIRECTORY_V2", "OPENCODE_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1"]),
        );
        for (const option of analysis.semanticOptions) {
            const semantic = value.input.requiredSemantics.find(
                (item) => item.semanticRefFingerprint === option.semanticRefFingerprint,
            )!;
            expect(option.outcome).toBe(
                semantic.consumerAgentRuntimeId === "OPENCODE_CLI" && slash === "" ? "degraded" : "preserved",
            );
        }
    });

    it.each([
        "global_config_folder",
        "shared_directory_folder",
    ] as const)("preserves old project-native resources when converting to %s", async (variant) => {
        const value = await sourceFixture("slash: true\n", false, variant);
        const selected = token(value.input);
        if (selected.inputKind !== "canonical_materialization") throw new Error("expected preserved canonical authority");
        expect(selected.degradationKinds).toEqual([]);
        const request = materializationInput(value.input, variant),
            result = await opencodeProvider.materializeRender(request);
        if (result.materializationState !== "materialized") throw new Error("supported target layout was blocked");
        const boundary = (variant === "global_config_folder" ? "skills/" : "") + "oaam-skill-" + ASSET_ID.slice(0, 8);
        const files = result.materializedUnits[0]!.files;
        expect(files).toHaveLength(value.source.canonicalFiles.length);
        for (const file of files) {
            expect(file.relativePath.startsWith(boundary + "/")).toBe(true);
            const logicalPath = file.relativePath.slice(boundary.length + 1);
            const original = value.source.nativeFiles.find(
                (item) => item.relativePath === ".opencode/skills/review/" + logicalPath,
            );
            expect(original).toBeDefined();
            const bytes = file.content.contentKind === "text" ? new TextEncoder().encode(file.content.text) : file.content.bytes;
            expect(bytes).toEqual(original!.bytes);
        }
        const entry = files.find((file) => file.relativePath.endsWith("/SKILL.md"))!,
            sourceEntry = value.source.canonicalFiles.find((file) => file.file.role === "entry")!;
        if (sourceEntry.contentKind !== "text") throw new Error("text source missing");
        const checker = opencodeProvider.canonicalMaterializationValidators?.find(
            (checker) => checker.materializer.componentId === selected.materializer.componentId,
        );
        if (checker === undefined) throw new Error("registered target entry checker missing");
        expect(
            checker.validateEntry({
                canonical: value.source.canonical,
                canonicalEntry: { contentKind: "text", text: sourceEntry.text },
                nativeEntry: { relativePath: entry.relativePath, content: entry.content },
                targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                targetScope: "global",
                nativeDialectId: selected.nativeDialectId,
                nativePreservationSeed: selected.nativePreservationSeed,
            }),
        ).toBe(true);
        assertGeneratedGraph(value, request, files);
    });

    it("rejects policy loss, an independent trigger and changed command identity before issuing a conversion token", async () => {
        const value = await sourceFixture("slash: true\n"),
            selected = token(value.input);
        if (selected.inputKind !== "canonical_materialization") throw new Error("canonical token absent");
        const checker = opencodeProvider.canonicalMaterializationValidators?.find(
            (checker) => checker.materializer.componentId === selected.materializer.componentId,
        );
        if (checker?.assessLoss === undefined) throw new Error("registered loss assessor missing");
        const canonicalEntry = value.source.canonicalFiles.find((file) => file.file.role === "entry")!;
        if (canonicalEntry.contentKind !== "text") throw new Error("text source missing");
        const input = {
            canonical: value.source.canonical,
            canonicalEntry: { contentKind: "text" as const, text: canonicalEntry.text },
            targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
            targetScope: "project" as const,
            nativeDialectId: selected.nativeDialectId,
            nativePreservationSeed: selected.nativePreservationSeed,
        };
        expect(checker.assessLoss?.(input)).toEqual([]);
        for (const change of ["policy", "trigger", "name"] as const) {
            const invalid = structuredClone(input);
            if (invalid.canonical.kind !== "Skill") throw new Error("expected Skill");
            if (change === "policy")
                invalid.canonical.typeData.toolPolicy.denied = [{ dialectId: "fixture-tool-selector-v1", selector: "Bash" }];
            if (change === "trigger") invalid.canonical.typeData.whenToUse = "Independent trigger";
            if (change === "name") invalid.canonical.typeData.invocation.user = { mode: "direct", commandName: "different" };
            expect(checker.assessLoss?.(invalid)).toBeNull();
        }
    });
});
