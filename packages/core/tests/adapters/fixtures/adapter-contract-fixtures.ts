import {
    computeSourceCapabilityFingerprint,
    computeTargetContextSchemaFingerprint,
} from "../../../src/adapters/adapter-contract-validator";
import type {
    AdapterId,
    AdapterProbeResult,
    AdapterProvider,
    AgentRuntimeId,
    AssetKind,
    OperationDiagnostic,
    Sha256Digest,
} from "../../../src/types";

export const TEST_ASSET_KINDS: AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];

export function testDiagnostic(code: string, operation: OperationDiagnostic["operation"] = "internal"): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message: code,
        path: "",
        traceId: "",
        operation,
        causeKind: "internal_error",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}

export function completeNotFoundProbe(agentRuntimeId: AgentRuntimeId): AdapterProbeResult {
    return {
        status: "complete",
        observation: {
            observedAgentRuntimes: [
                {
                    agentRuntimeId,
                    versionText: "",
                    installationEvidence: [
                        {
                            kind: "executable",
                            path: `/trusted-check/${agentRuntimeId}`,
                            evidenceLevel: "agent_runtime_verified",
                            diagnostics: [],
                        },
                    ],
                    sourceRootIds: [],
                    agentRuntimeResourceIds: [],
                    observedProjectIds: [],
                    installationStatus: "not_found",
                    projectDiscoveryStatus: "not_found",
                    diagnostics: [],
                },
            ],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics: [],
    };
}

export function partialUnknownProbe(agentRuntimeId: AgentRuntimeId): AdapterProbeResult {
    return {
        status: "partial",
        observation: {
            observedAgentRuntimes: [
                {
                    agentRuntimeId,
                    versionText: "",
                    installationEvidence: [],
                    sourceRootIds: [],
                    agentRuntimeResourceIds: [],
                    observedProjectIds: [],
                    installationStatus: "unknown",
                    projectDiscoveryStatus: "unknown",
                    diagnostics: [testDiagnostic("discovery_incomplete", "probe")],
                },
            ],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics: [testDiagnostic("discovery_incomplete", "probe")],
    };
}

export function makeContractProvider(adapterId: AdapterId, probeResult?: AdapterProbeResult): AdapterProvider {
    const agentRuntimeId = `${adapterId}_CLI`;
    const provider: AdapterProvider = {
        adapterId,
        displayName: `Mock ${adapterId}`,
        version: "2.3.4",
        agentRuntimes: [{ agentRuntimeId, displayName: "Mock CLI", entryClass: "cli" }],
        targetContextSchemas: [],
        assetSourceCapabilities: [],
        assetTargetCapabilities: TEST_ASSET_KINDS.map((assetKind) => ({
            agentRuntimeId,
            entrySupportStatus: "deferred",
            assetKind,
            diagnostics: [testDiagnostic("deferred", "render")],
        })),
        materializerCapabilities: [],
        renderContractDeclarations: [],
        dialectContracts: {
            native: [],
            restoration: [],
            portableEntries: [],
            portableSelectors: [],
        },
        async probe() {
            return probeResult ?? completeNotFoundProbe(agentRuntimeId);
        },
        async read() {
            return { candidates: [], sourceParseReports: [], diagnostics: [] };
        },
        async analyzeRender() {
            return {
                status: "failed",
                outputUnits: [],
                semanticOptions: [],
                blockedSemanticRefs: [],
                diagnostics: [],
            };
        },
        async materializeRender() {
            return {
                status: "failed",
                materializationState: "blocked",
                reasonCode: "test",
                diagnostics: [],
            };
        },
        async inspectRenderedTarget() {
            return { status: "failed", changes: [], files: [], diagnostics: [] };
        },
    };
    provider.assetSourceCapabilities = TEST_ASSET_KINDS.map((assetKind) => {
        const row = {
            sourceCapabilityFingerprint: "sha256:placeholder",
            agentRuntimeId,
            entrySupportStatus: "deferred" as const,
            rootLocatorKind: "unknown" as const,
            rootRole: "unknown" as const,
            sourceDomain: "unknown" as const,
            assetKind,
            sourcePathMechanism: "unknown" as const,
            evidenceLevel: "docs_declared" as const,
            readPolicy: "report_only" as const,
            diagnostics: [testDiagnostic("deferred", "read")],
        };
        return {
            ...row,
            sourceCapabilityFingerprint: computeSourceCapabilityFingerprint(provider, row) as Sha256Digest,
        };
    });
    return provider;
}

export function addValidTargetSchemaAndMaterializer(provider: AdapterProvider): AdapterProvider {
    const agentRuntimeId = provider.agentRuntimes[0]?.agentRuntimeId as AgentRuntimeId;
    const schema: AdapterProvider["targetContextSchemas"][number] = {
        targetContextSchemaId: `${provider.adapterId}.target.v1`,
        schemaFingerprint: "sha256:placeholder",
        agentRuntimeId,
        factRules: [
            {
                key: "root",
                valueKind: "canonical_string" as const,
                normalization: {
                    componentId: "oaam.path.canonical",
                    componentVersion: 1,
                    configFingerprint: `sha256:${"1".repeat(64)}`,
                },
            },
        ],
        diagnostics: [],
    };
    schema.schemaFingerprint = computeTargetContextSchemaFingerprint(provider, schema) as Sha256Digest;
    provider.targetContextSchemas = [schema];
    provider.assetTargetCapabilities = [
        {
            agentRuntimeId,
            entrySupportStatus: "supported",
            assetKind: "Guidance",
            renderStrategy: "inline",
            outputContractId: "oaam.guidance.inline.v1",
            outputContractFingerprint: `sha256:${"2".repeat(64)}`,
            targetContextSchemaId: schema.targetContextSchemaId,
            targetContextSchemaFingerprint: schema.schemaFingerprint,
            reverseExtractPolicy: "can_reconcile",
            diagnostics: [],
        },
        ...TEST_ASSET_KINDS.filter((kind) => kind !== "Guidance").map((assetKind) => ({
            agentRuntimeId,
            entrySupportStatus: "deferred" as const,
            assetKind,
            diagnostics: [testDiagnostic("deferred", "render")],
        })),
    ];
    provider.materializerCapabilities = [
        {
            materializerCapabilityKey: `${provider.adapterId}.guidance.inline`,
            outputContractId: "oaam.guidance.inline.v1",
            outputContractFingerprint: `sha256:${"2".repeat(64)}`,
            materializationProfileIds: ["default"],
            diagnostics: [],
        },
    ];
    return provider;
}
