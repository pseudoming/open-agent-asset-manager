import { describe, expect, it } from "vitest";
import { validateAdapterProbeResult } from "../../src/adapters/adapter-contract-validator";
import type { AdapterId, AgentRuntimeId, PlatformContext } from "../../src/types";
import { completeNotFoundProbe, makeContractProvider } from "./fixtures/adapter-contract-fixtures";

const ADAPTER_ID = "ENVIRONMENT_REFERENCE_VALIDATOR" as AdapterId;
const WINDOWS_CONTEXT: PlatformContext = {
    platform: "win32",
    platformInstanceId: "desktop-local",
    accessRootPath: "C:\\Users\\agent",
};
const LINUX_CONTEXT: PlatformContext = { platform: "linux", platformInstanceId: "test", accessRootPath: "/" };

function codes(diagnostics: Array<{ code: string }>): string[] {
    return diagnostics.map((item) => item.code);
}

function environmentReferenceProbe() {
    const provider = makeContractProvider(ADAPTER_ID);
    const runtimeId = provider.agentRuntimes[0]!.agentRuntimeId;
    const result = completeNotFoundProbe(runtimeId);
    const runtime = result.observation.observedAgentRuntimes[0]!;
    runtime.installationStatus = "available";
    runtime.versionText = "1.0.0";
    runtime.agentRuntimeResourceIds = ["registry"];
    result.observation.agentRuntimeResources = [
        {
            agentRuntimeResourceId: "registry",
            roles: ["project_registry"],
            path: "C:\\Users\\agent\\.runtime\\config.toml",
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "registry",
                    evidenceLevel: "local_artifact",
                },
            ],
            diagnostics: [],
        },
    ];
    result.observation.environmentReferences = [
        {
            referenceId: "reference",
            agentRuntimeId: runtimeId,
            referenceKind: "project",
            referencedEnvironment: { platform: "wsl", platformInstanceId: "Ubuntu" },
            validationState: "not_checked",
            evidence: {
                agentRuntimeResourceId: "registry",
                locatorKey: "trusted-project-row",
                evidenceLevel: "local_artifact",
            },
        },
    ];
    return { provider, result };
}

describe("probe environment-reference validator", () => {
    it("accepts one runtime-bound non-authoritative WSL Project reference", () => {
        const { provider, result } = environmentReferenceProbe();
        expect(validateAdapterProbeResult(provider, result, WINDOWS_CONTEXT)).toEqual([]);
    });

    it("rejects runtime and project-registry resource closure failures", () => {
        const { provider, result } = environmentReferenceProbe();

        const dangling = structuredClone(result);
        dangling.observation.environmentReferences![0]!.evidence.agentRuntimeResourceId = "missing";
        expect(codes(validateAdapterProbeResult(provider, dangling, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_evidence_invalid",
        );

        const unknownRuntime = structuredClone(result);
        unknownRuntime.observation.environmentReferences![0]!.agentRuntimeId = "UNKNOWN_RUNTIME" as AgentRuntimeId;
        expect(codes(validateAdapterProbeResult(provider, unknownRuntime, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_runtime_invalid",
        );

        const unavailableRuntime = structuredClone(result);
        unavailableRuntime.observation.observedAgentRuntimes[0]!.installationStatus = "not_found";
        expect(codes(validateAdapterProbeResult(provider, unavailableRuntime, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_runtime_invalid",
        );

        const resourceNotOwnedByRuntime = structuredClone(result);
        resourceNotOwnedByRuntime.observation.observedAgentRuntimes[0]!.agentRuntimeResourceIds = [];
        expect(codes(validateAdapterProbeResult(provider, resourceNotOwnedByRuntime, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_evidence_invalid",
        );

        const wrongResourceKind = structuredClone(result);
        wrongResourceKind.observation.agentRuntimeResources[0]!.roles = ["agent_runtime_data"];
        expect(codes(validateAdapterProbeResult(provider, wrongResourceKind, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_evidence_invalid",
        );

        const unavailableResource = structuredClone(result);
        unavailableResource.observation.agentRuntimeResources[0]!.accessStatus = "needs_permission";
        expect(codes(validateAdapterProbeResult(provider, unavailableResource, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_evidence_invalid",
        );
    });

    it("rejects duplicate identities and runtime-target tuples", () => {
        const { provider, result } = environmentReferenceProbe();
        const duplicateId = structuredClone(result);
        duplicateId.observation.environmentReferences!.push({
            ...duplicateId.observation.environmentReferences![0]!,
            referencedEnvironment: { platform: "wsl", platformInstanceId: "Debian" },
        });
        expect(codes(validateAdapterProbeResult(provider, duplicateId, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_duplicate",
        );

        const duplicateTuple = structuredClone(result);
        duplicateTuple.observation.environmentReferences!.push({
            ...duplicateTuple.observation.environmentReferences![0]!,
            referenceId: "reference-2",
        });
        expect(codes(validateAdapterProbeResult(provider, duplicateTuple, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_tuple_duplicate",
        );
    });

    it("rejects wrong origin, target, shape, and unsafe WSL instance identities", () => {
        const { provider, result } = environmentReferenceProbe();
        expect(codes(validateAdapterProbeResult(provider, result, LINUX_CONTEXT))).toContain(
            "probe.environment_reference_context_invalid",
        );

        const wrongTarget = structuredClone(result);
        wrongTarget.observation.environmentReferences![0]!.referencedEnvironment.platform = "linux" as never;
        expect(codes(validateAdapterProbeResult(provider, wrongTarget, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_context_invalid",
        );

        const wrongShape = structuredClone(result);
        wrongShape.observation.environmentReferences![0]!.referenceKind = "workspace" as never;
        wrongShape.observation.environmentReferences![0]!.validationState = "checked" as never;
        expect(codes(validateAdapterProbeResult(provider, wrongShape, WINDOWS_CONTEXT))).toContain(
            "probe.environment_reference_shape_invalid",
        );

        for (const unsafePlatformInstanceId of [
            "",
            ".",
            "..",
            " Ubuntu",
            "Ubuntu ",
            "Ubuntu.",
            "Ubuntu\\alias",
            "Ubuntu/alias",
        ]) {
            const unsafeInstance = structuredClone(result);
            unsafeInstance.observation.environmentReferences![0]!.referencedEnvironment.platformInstanceId =
                unsafePlatformInstanceId;
            expect(codes(validateAdapterProbeResult(provider, unsafeInstance, WINDOWS_CONTEXT))).toContain(
                "probe.environment_reference_instance_invalid",
            );
        }
    });
});
