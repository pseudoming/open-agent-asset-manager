import type {
    NativeProjectExactFileProviderSupport,
    NativeProjectExactGraphProviderSupport,
    NativeGlobalExactGraphProviderSupport,
    RenderAnalysisInput,
    RenderMaterializationInput,
} from "@oaam/core";
import { makeNativeProjectExactFileContractParts } from "../../../core/src/render/native-project-exact-file";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { claudecodeProvider } from "../src/claudecode-provider";
import { createClaudeWorkflowCanonicalSupports } from "../src/claudecode-target-workflow-canonical";

export const currentClaudeWorkflowTestSupports = createClaudeWorkflowCanonicalSupports({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    cliProjectSchema: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
    appProjectSchema: "CLAUDE_CODE_APP_PROJECT_GUIDANCE_TARGET_V1",
    cliGlobalSchema: "CLAUDE_CODE_CLI_GLOBAL_CONFIG_TARGET_V1",
    appGlobalSchema: "CLAUDE_CODE_APP_GLOBAL_CONFIG_TARGET_V1",
});
type Support =
    | NativeProjectExactFileProviderSupport
    | NativeProjectExactGraphProviderSupport
    | NativeGlobalExactGraphProviderSupport;

export function makeClaudeNativeMaterializationInput(
    analysisInput: RenderAnalysisInput,
    support: Support,
): RenderMaterializationInput {
    const analysis = support.analyze(analysisInput);
    if (analysis.status !== "complete") throw new Error("Native target analysis fixture did not close");
    const declaration = support.renderContractDeclaration;
    const contract = (
        declaration.declarationKind === "native_project_exact_file_v1"
            ? makeNativeProjectExactFileContractParts(declaration)
            : makeNativeProjectExactGraphContractParts(declaration)
    ).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Native target profile is missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(analysisInput.deployment),
        requiredSemantics: structuredClone(analysisInput.requiredSemantics),
        dialectInputs: structuredClone(analysisInput.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "CLAUDECODE",
                rendererAdapterVersion: claudecodeProvider.version,
                materializerCapabilityKey: support.materializerCapability.materializerCapabilityKey,
                materializationProfileId: declaration.materializationProfileId,
                profileConstraintFingerprint: profile.profileConstraintFingerprint,
            })),
            semanticOptions: analysis.semanticOptions.map((option) => ({
                optionFingerprint: option.optionFingerprint,
                semanticRefFingerprint: option.semanticRefFingerprint,
                renderStrategy: option.renderStrategy,
                actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                outcome: "preserved",
            })),
        },
    };
}
