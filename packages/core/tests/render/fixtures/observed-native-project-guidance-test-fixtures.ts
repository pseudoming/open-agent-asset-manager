/** Deterministic observed-target fixture shared by target-context responsibility tests. */

import * as path from "node:path";
import type {
    AdapterProviderSummary,
    ObservedProjectEvidence,
    ProbeResult,
    SourceEvidenceLevel,
} from "../../../src/contracts/source-import";
import type {
    NativeProjectGuidanceObservationDependenciesForTest,
    ResolveObservedNativeProjectGuidanceTargetContextInput,
    VerifiedNativeProjectGuidanceBuild,
} from "../../../src/render/native-project-guidance";
import { createNativeProjectGuidanceProviderSupport } from "../../../src/render/native-project-guidance";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";

export const BUILD_BYTES = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x01]);
export const BUILD_IDENTITY = sha256Bytes(BUILD_BYTES);
const FIXTURE_FINGERPRINT = sha256Bytes(new TextEncoder().encode("observed target fixture"));
const PROFILE_ID = "antigravity-cli-project-guidance-v1";

export interface Fixture {
    input: ResolveObservedNativeProjectGuidanceTargetContextInput;
    build: VerifiedNativeProjectGuidanceBuild;
    dependencies: NativeProjectGuidanceObservationDependenciesForTest;
}

export function makeFixture(
    options: { projectEvidenceLevel?: SourceEvidenceLevel; accessRootPath?: string; targetRootPath?: string } = {},
): Fixture {
    const accessRootPath = options.accessRootPath ?? "/fixture";
    const targetRootPath = options.targetRootPath ?? "/fixture/project";
    const descriptor = {
        agentRuntimeId: "ANTIGRAVITY_CLI" as const,
        displayName: "Antigravity CLI fixture",
        entryClass: "cli" as const,
    };
    const build: VerifiedNativeProjectGuidanceBuild = {
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: "9.9.9-test",
        buildIdentity: BUILD_IDENTITY,
        platform: "wsl",
        materializationProfileId: PROFILE_ID,
        fixtureSetFingerprint: FIXTURE_FINGERPRINT,
    };
    const support = createNativeProjectGuidanceProviderSupport({
        adapterId: "ANTIGRAVITY",
        adapterVersion: "0.3.0",
        agentRuntimes: [descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        outputContractId: "TEST_ANTIGRAVITY_NATIVE_PROJECT_GUIDANCE_V1",
        materializationProfileId: PROFILE_ID,
        target: {
            relativePath: "AGENTS.md",
            targetContextSchemaId: "ANTIGRAVITY_CLI_PROJECT_GUIDANCE_TARGET_V1",
            requiredFacts: {
                "oaam.project-binding": "registered",
            },
        },
        verifiedBuilds: [build],
    });
    const provider: AdapterProviderSummary = {
        adapterId: "ANTIGRAVITY",
        displayName: "Antigravity fixture",
        version: "0.3.0",
        enabled: true,
        agentRuntimes: [descriptor],
        targetContextSchemas: [support.targetContextSchema],
        assetSourceCapabilities: [],
        assetTargetCapabilities: [support.targetCapability],
        materializerCapabilities: [support.materializerCapability],
        renderContractDeclarations: [support.renderContractDeclaration],
    };
    const projectEvidenceLevel = options.projectEvidenceLevel ?? "local_artifact";
    const projectEvidence: ObservedProjectEvidence = {
        evidenceKind: "agent_runtime_resource",
        agentRuntimeResourceId: "registry-resource",
        locatorKey: "project-a",
        evidenceLevel: projectEvidenceLevel,
    };
    const probeResult: ProbeResult = {
        status: "partial",
        observation: {
            adapterId: "ANTIGRAVITY",
            platformContext: {
                platform: "wsl",
                platformInstanceId: "wsl-test",
                accessRootPath,
            },
            observedAgentRuntimes: [
                {
                    agentRuntimeId: descriptor.agentRuntimeId,
                    versionText: "",
                    installationEvidence: [
                        {
                            kind: "executable",
                            path: path.posix.join(accessRootPath, "bin", "consumer"),
                            evidenceLevel: "local_artifact",
                            diagnostics: [],
                        },
                    ],
                    sourceRootIds: ["project-root"],
                    agentRuntimeResourceIds: ["registry-resource"],
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
                    path: targetRootPath,
                    accessStatus: "available",
                    locatorEvidence: [
                        {
                            locatorKind: "project_registry_entry",
                            locatorKey: "project-a",
                            evidenceLevel: projectEvidenceLevel,
                        },
                    ],
                    diagnostics: [],
                },
            ],
            agentRuntimeResources: [
                {
                    agentRuntimeResourceId: "registry-resource",
                    roles: ["project_registry"],
                    path: path.posix.join(accessRootPath, "registry.json"),
                    accessStatus: "available",
                    locatorEvidence: [
                        {
                            locatorKind: "runtime_known_rule",
                            locatorKey: "project_registry",
                            evidenceLevel: projectEvidenceLevel,
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
                    evidence: [projectEvidence],
                    diagnostics: [],
                },
            ],
            targetCandidates: [
                {
                    targetCandidateId: "project-target",
                    targetRootPath,
                    targetKind: "project",
                    displayName: "Project A",
                    entryApplicabilities: [
                        {
                            agentRuntimeId: descriptor.agentRuntimeId,
                            status: "ready_for_plan",
                            locatorEvidence: [
                                {
                                    locatorKind: "project_registry_entry",
                                    locatorKey: "project-a",
                                    evidenceLevel: projectEvidenceLevel,
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
    return {
        input: {
            provider,
            probeResult,
            agentRuntimeId: descriptor.agentRuntimeId,
            targetRootPath,
            projectRootPath: targetRootPath,
        },
        build,
        dependencies: {
            verifiedBuilds: [build],
            readBuildArtifact: () => stableRead(BUILD_BYTES, true),
        },
    };
}

function stableRead(bytes: Uint8Array, executable: boolean) {
    return {
        bytes: new Uint8Array(bytes),
        executable,
        identity: { deviceId: "1", fileId: "2", entryKind: "file" as const },
    };
}
