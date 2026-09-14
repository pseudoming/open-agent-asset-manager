/** Current Claude targets and the unchanged 0.8 Applied inspection partition. */
import { createTargetCoordinator, defineAdapterProvider } from "@oaam/adapter-framework";
import type { AdapterRetainedInspectionBindingV1 } from "@oaam/core";
import { createClaudeCodeProviderDefinition } from "./claudecode-provider-definition";
export { sanitizePath } from "./claudecode-paths";

export const claudecodeProvider = defineAdapterProvider({
    ...createClaudeCodeProviderDefinition("0.9.0"),
    retainedInspectionBindings: [historicalInspection()],
});

function historicalInspection(): AdapterRetainedInspectionBindingV1 {
    const old = createClaudeCodeProviderDefinition("0.8.0", false);
    const { inspectRenderedTarget } = createTargetCoordinator({
        adapterId: old.adapterId,
        adapterVersion: old.version,
        assetTargetCapabilities: old.assetTargetCapabilities,
        materializerCapabilities: old.materializerCapabilities,
        targetRender: old.targetRender,
    });
    return {
        schemaVersion: 1,
        rendererVersion: old.version,
        agentRuntimes: old.agentRuntimes,
        targetContextSchemas: old.targetContextSchemas,
        assetTargetCapabilities: old.assetTargetCapabilities,
        materializerCapabilities: old.materializerCapabilities,
        renderContractDeclarations: old.renderContractDeclarations,
        inspectRenderedTarget,
    };
}
