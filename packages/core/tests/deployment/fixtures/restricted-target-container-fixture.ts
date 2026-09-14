/** Actual Core complete-graph materialization with a shared JSONC container fragment. */
import { createVersionDialectRegistry } from "../../../src/catalog/version-dialect-registry";
import { computeRenderSelectionFingerprint } from "../../../src/foundation/fingerprint";
import { materializeRenderDeployment } from "../../../src/render/render-materialization";
import {
    GRAPH_BINARY_RESOURCE_PATH,
    exactGraphMaterializationInput,
    makeExactGraphFixture,
} from "../../render/fixtures/native-project-exact-graph-test-fixtures";
export async function patchMaterialization(targetRootPath: string) {
    const fixture = makeExactGraphFixture({
        jsoncTopLevelPropertyPatch: { propertyName: "instructions", allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH] },
        targetRootPath,
    });
    const analysis = fixture.support.analyze(fixture.analysisInput);
    if (analysis.status !== "complete") throw new Error("exact graph patch analysis did not close");
    const providerSelection = exactGraphMaterializationInput(fixture).selection;
    const preimage = {
        schemaVersion: 1 as const,
        compilerPolicyVersion: "core_render_policy_v1" as const,
        renderInputFingerprint: fixture.deployment.renderInputFingerprint,
        semanticOptions: providerSelection.semanticOptions.map((option) => ({
            ...option,
            consumerOwnerAdapterId: fixture.provider.adapterId,
            consumerOwnerAdapterVersion: fixture.provider.version,
            approval: { approvalState: "not_required" as const },
        })),
        outputUnits: providerSelection.outputUnits,
        outputUnitRenderers: providerSelection.outputUnitRenderers,
        promotionAuthorizations: [],
    };
    const result = await materializeRenderDeployment(
        {
            deployment: fixture.deployment,
            analysis: {
                renderInputFingerprint: fixture.deployment.renderInputFingerprint,
                requiredSemantics: fixture.requiredSemantics,
                analyses: [{ ...analysis, adapterId: fixture.provider.adapterId, adapterVersion: fixture.provider.version }],
            },
            selection: { ...preimage, selectionFingerprint: computeRenderSelectionFingerprint(preimage) },
        },
        {
            registry: fixture.registry,
            dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect], [], [], []),
            resolveDialectInputs: () => structuredClone(fixture.analysisInput.dialectInputs),
            dispatch: async (_adapterId, input) => ({
                status: "complete",
                value: fixture.support.materialize(input),
                diagnostics: [],
            }),
        },
    );
    if (result.status !== "complete") throw new Error(JSON.stringify(result.diagnostics));
    return result.value;
}
