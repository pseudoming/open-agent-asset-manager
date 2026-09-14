import { UUID_A, UUID_C } from "./protocol-fixture-primitives";

export const ASSET_USAGE_ANALYZE_PARAMS = Object.freeze({
    probeToken: "probe-token",
    probeResultRowId: "probe-result-1",
    targetRowId: "target-row-1",
    subject: { subjectKind: "project", projectId: UUID_A },
    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
    asset: { assetId: UUID_A, versionId: UUID_C, allowIncomplete: false },
});

export const ASSET_USAGE_TERMINAL_VALUE = Object.freeze({
    schemaVersion: 2,
    assetId: UUID_A,
    versionId: UUID_C,
    relationships: [
        {
            agentRuntimeId: "CLAUDE_CODE_CLI",
            capability: "direct",
            observedTargetState: "already_usable",
            managedState: "none",
            substitute: null,
            deploymentIds: [],
            appliedDeploymentIds: [],
            degradationKinds: [],
            reasonCodes: ["claude_code_guidance_preserved"],
            diagnostics: [],
            requiresReview: false,
        },
    ],
});
