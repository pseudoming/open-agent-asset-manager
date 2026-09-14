/**
 * Public source-discovery observations and probe request/result contracts.
 */

import type { OperationDiagnostic } from "./common";
import type { AdapterId, AgentRuntimeId, OperationStatus, Platform, Sha256Digest } from "./primitives";

export type AgentRuntimeEntryClass = "cli" | "app" | "ide";

export interface AgentRuntimeDescriptor {
    agentRuntimeId: AgentRuntimeId;
    displayName: string;
    entryClass: AgentRuntimeEntryClass;
}

export type SourceEvidenceLevel =
    | "agent_runtime_verified"
    | "local_artifact"
    | "source_code"
    | "docs_declared"
    | "user_provided"
    | "agent_answer";

export interface InstallationEvidence {
    kind: "executable" | "launcher" | "app_bundle" | "install_root" | "version_command";
    path: string;
    evidenceLevel: SourceEvidenceLevel;
    diagnostics: OperationDiagnostic[];
    /**
     * Fresh Provider-owned physical observation from this exact probe operation.
     *
     * This ephemeral fact lets a read-only target check reuse the hash that the
     * Provider already bound before/after its executable observation. It is not
     * persisted, is not a write authority, and action-time render/deploy still
     * performs its own fresh physical revalidation.
     */
    currentBuildObservation?: {
        buildIdentity: Sha256Digest;
        byteSize: number;
        executable: boolean;
        identity: {
            deviceId: string;
            fileId: string;
            entryKind: "file";
        };
    };
}

export type InstallationStatus = "available" | "not_found" | "needs_permission" | "version_incompatible" | "unknown";

export type ProjectDiscoveryStatus = "complete" | "partial" | "not_found" | "needs_permission" | "unknown";

export type ResourceAccessStatus = "available" | "not_found" | "needs_permission" | "unknown";
export type TargetCandidateStatus = "ready_for_plan" | "invalid" | "unknown";

export interface ObservedAgentRuntime {
    agentRuntimeId: AgentRuntimeId;
    versionText: string;
    installationEvidence: InstallationEvidence[];
    sourceRootIds: string[];
    agentRuntimeResourceIds: string[];
    observedProjectIds: string[];
    installationStatus: InstallationStatus;
    projectDiscoveryStatus: ProjectDiscoveryStatus;
    diagnostics: OperationDiagnostic[];
}

export type SourceDomain =
    | "family_shared"
    | "agent_runtime_private"
    | "project_root"
    | "project_keyed"
    | "external_managed"
    | "unknown";

export type RootLocatorKind =
    | "runtime_known_rule"
    | "runtime_declared_path"
    | "project_registry_entry"
    | "user_provided_path"
    | "unknown";

export type RootRole = "config" | "source" | "project_actual" | "unknown";

export type SourcePathMechanism = "fixed_file" | "directory_entry" | "recursive_entry" | "manifest_declared" | "unknown";

export interface PathLocatorEvidence {
    locatorKind: RootLocatorKind;
    locatorKey: string;
    evidenceLevel: SourceEvidenceLevel;
}

export interface SourceRoot {
    sourceRootId: string;
    rootRole: RootRole;
    sourceDomain: SourceDomain;
    path: string;
    accessStatus: ResourceAccessStatus;
    locatorEvidence: PathLocatorEvidence[];
    diagnostics: OperationDiagnostic[];
}

export type AgentRuntimeResourceRole = "agent_runtime_data" | "project_registry";

export interface ObservedAgentRuntimeResource {
    agentRuntimeResourceId: string;
    roles: AgentRuntimeResourceRole[];
    path: string;
    accessStatus: ResourceAccessStatus;
    locatorEvidence: PathLocatorEvidence[];
    diagnostics: OperationDiagnostic[];
}

export type ObservedProjectWorkspaceRole = "primary" | "additional";

export interface ObservedProjectWorkspace {
    sourceRootId: string;
    role: ObservedProjectWorkspaceRole;
}

export type ObservedProjectEvidence =
    | {
          evidenceKind: "agent_runtime_resource";
          agentRuntimeResourceId: string;
          locatorKey: string;
          evidenceLevel: SourceEvidenceLevel;
      }
    | {
          evidenceKind: "environment" | "invocation";
          locatorKey: string;
          evidenceLevel: SourceEvidenceLevel;
      };

export interface ObservedProject {
    observedProjectId: string;
    runtimeProjectKey: string;
    displayName: string;
    workspaces: ObservedProjectWorkspace[];
    evidence: ObservedProjectEvidence[];
    diagnostics: OperationDiagnostic[];
}

/**
 * A bounded, non-authoritative reference from metadata in the selected
 * environment to a Project environment that has not been selected or read.
 *
 * This is intentionally not a SourceRoot, ObservedProject or TargetCandidate:
 * it cannot authorize probing, reading, registration, import or deployment.
 */
export interface ObservedProjectEnvironmentReference {
    referenceId: string;
    agentRuntimeId: AgentRuntimeId;
    referenceKind: "project";
    referencedEnvironment: {
        platform: "wsl";
        platformInstanceId: string;
    };
    validationState: "not_checked";
    evidence: {
        agentRuntimeResourceId: string;
        locatorKey: string;
        evidenceLevel: SourceEvidenceLevel;
    };
}

export interface TargetEntryApplicability {
    agentRuntimeId: AgentRuntimeId;
    status: TargetCandidateStatus;
    locatorEvidence: PathLocatorEvidence[];
    diagnostics: OperationDiagnostic[];
}

export interface TargetCandidate {
    targetCandidateId: string;
    targetRootPath: string;
    targetKind: "global" | "project" | "directory" | "unknown";
    displayName: string;
    entryApplicabilities: TargetEntryApplicability[];
    diagnostics: OperationDiagnostic[];
}

export interface AdapterProbeObservation {
    observedAgentRuntimes: ObservedAgentRuntime[];
    sourceRoots: SourceRoot[];
    agentRuntimeResources: ObservedAgentRuntimeResource[];
    observedProjects: ObservedProject[];
    targetCandidates: TargetCandidate[];
    /** Absent for Providers that do not expose a bounded cross-environment reference. */
    environmentReferences?: ObservedProjectEnvironmentReference[];
}

export interface PlatformContext {
    platform: Platform;
    platformInstanceId: string;
    accessRootPath: string;
}

export type ProbeObservation = AdapterProbeObservation & {
    adapterId: AdapterId;
    platformContext: PlatformContext;
};

export type AdapterProbeContext =
    | { authorizationScope: "global"; platformContext: PlatformContext; installationRootPath?: string }
    | {
          authorizationScope: "project";
          platformContext: PlatformContext;
          projectRootPath: string;
          installationRootPath?: string;
      }
    | {
          authorizationScope: "directory";
          platformContext: PlatformContext;
          directoryRootPath: string;
          installationRootPath?: string;
      };

export type ProbeAuthorizationTarget =
    | { authorizationScope: "global"; installationRootPath?: string }
    | { authorizationScope: "project"; projectRootPath: string; installationRootPath?: string }
    | { authorizationScope: "directory"; directoryRootPath: string; installationRootPath?: string };

export interface ProbeAdaptersInput {
    adapterIds?: AdapterId[];
    contexts: PlatformContext[];
    target: ProbeAuthorizationTarget;
}

export type ProbeAdapterProgress =
    | {
          stage: "provider_probe";
          completedUnits: 0;
          totalUnits: number;
      }
    | {
          stage: "provider_probe";
          completedUnits: number;
          totalUnits: number;
          adapterId: AdapterId;
          platformContext: PlatformContext;
          outcome: OperationStatus;
          elapsedMilliseconds: number;
      };

export type ProbeAdaptersObserver = (progress: ProbeAdapterProgress) => void;

export interface AdapterProbeResult {
    status: OperationStatus;
    observation: AdapterProbeObservation;
    diagnostics: OperationDiagnostic[];
}

export type ProbeResult = Omit<AdapterProbeResult, "observation"> & {
    observation: ProbeObservation;
};
