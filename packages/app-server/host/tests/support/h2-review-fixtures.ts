import type {
    AdapterReadResult,
    DeploymentRenderPreviewView,
    DeploymentView,
    ImportPreviewSnapshotV1,
    ProbeResult,
    RenderedTargetInspectionResult,
    Sha256Digest,
} from "@oaam/core";
import { ASSET_ID, PROJECT_ID, SHA, VERSION_ID } from "./host-test-fixtures";

export const H2_DIGEST = SHA as Sha256Digest;
export const H2_SOURCE_ROOT_ID = "source-root-1";

export function h2ProbeResult(): ProbeResult {
    return {
        status: "complete",
        observation: {
            adapterId: "CLAUDECODE" as ProbeResult["observation"]["adapterId"],
            platformContext: { platform: "linux", platformInstanceId: "local", accessRootPath: "/trusted" },
            observedAgentRuntimes: [
                {
                    agentRuntimeId:
                        "CLAUDE_CODE_CLI" as ProbeResult["observation"]["observedAgentRuntimes"][number]["agentRuntimeId"],
                    versionText: "2.1.0",
                    installationEvidence: [],
                    sourceRootIds: [H2_SOURCE_ROOT_ID],
                    agentRuntimeResourceIds: [],
                    observedProjectIds: ["observed-project"],
                    installationStatus: "available",
                    projectDiscoveryStatus: "complete",
                    diagnostics: [],
                },
            ],
            sourceRoots: [
                {
                    sourceRootId: H2_SOURCE_ROOT_ID,
                    rootRole: "source",
                    sourceDomain: "project_root",
                    path: "/project/.claude",
                    accessStatus: "available",
                    locatorEvidence: [
                        {
                            locatorKind: "runtime_known_rule",
                            locatorKey: "project_claude",
                            evidenceLevel: "agent_runtime_verified",
                        },
                    ],
                    diagnostics: [],
                },
            ],
            agentRuntimeResources: [],
            observedProjects: [
                {
                    observedProjectId: "observed-project",
                    runtimeProjectKey: "project",
                    displayName: "Project",
                    workspaces: [{ sourceRootId: H2_SOURCE_ROOT_ID, role: "primary" }],
                    evidence: [],
                    diagnostics: [],
                },
            ],
            targetCandidates: [
                {
                    targetCandidateId: "target-1",
                    targetRootPath: "/project",
                    targetKind: "project",
                    displayName: "Project",
                    entryApplicabilities: [
                        {
                            agentRuntimeId:
                                "CLAUDE_CODE_CLI" as ProbeResult["observation"]["observedAgentRuntimes"][number]["agentRuntimeId"],
                            status: "ready_for_plan",
                            locatorEvidence: [],
                            diagnostics: [],
                        },
                    ],
                    diagnostics: [],
                },
            ],
        },
        diagnostics: [],
    };
}

export function h2ReadResult(probe = h2ProbeResult()): AdapterReadResult {
    return {
        status: "complete",
        readTarget: {
            adapterId: probe.observation.adapterId,
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: probe.observation,
                sourceRootIds: [H2_SOURCE_ROOT_ID],
            },
        },
        readAuthorityFingerprint: H2_DIGEST,
        readSnapshotFingerprint: H2_DIGEST,
        sourceRoots: probe.observation.sourceRoots,
        sourceReadObligations: [],
        readAccessOutcomes: [],
        observedReadEntries: [],
        externalAttestationReceipts: [],
        sourceParseReports: [],
        candidates: [
            {
                candidateId: "candidate-1",
                adapterId: probe.observation.adapterId,
                kind: "Guidance",
                typeData: { schemaVersion: 1 },
                sourceRootIds: [H2_SOURCE_ROOT_ID],
                scope: "project",
                projectRootPath: "/project",
                scopePath: "",
                displayName: "Guidance",
                displayDescription: "",
                files: [
                    {
                        logicalPath: "AGENTS.md",
                        role: "entry",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        text: "# Guidance",
                        executable: false,
                    },
                    {
                        logicalPath: "assets/data.bin",
                        role: "resource",
                        contentKind: "binary",
                        mediaType: "application/octet-stream",
                        bytes: new Uint8Array([1, 2, 3]),
                        executable: false,
                    },
                ],
                nativeRepresentation: { representationSource: "canonical_files", dialectId: "claudecode.guidance" },
                dialectRestorationTransition: { action: "inherit" },
                status: "complete",
                assetCandidateStatus: "importable",
                promotionSafety: "ordinary_user_asset",
                sourceFileOrigins: [],
                sourceContainerEntryIds: [],
                metadataSourceOrigins: [],
                sourceEvidence: [],
                diagnostics: [],
            },
        ],
        sourceReports: [{ sourceRootId: H2_SOURCE_ROOT_ID, status: "scanned", diagnostics: [] }],
        diagnostics: [],
    };
}

export function h2PreviewSnapshot(read = h2ReadResult()): ImportPreviewSnapshotV1 {
    return {
        schemaVersion: 2,
        previewedAt: 1 as ImportPreviewSnapshotV1["previewedAt"],
        readResults: [read],
        items: [
            {
                candidateId: "candidate-1",
                action: "create_asset",
                freshness: "fresh",
                callableBindingRequests: [],
                diagnostics: [],
            },
        ],
        snapshotFingerprint: H2_DIGEST,
    };
}

export function h2Deployment(): DeploymentView {
    return {
        deploymentId: VERSION_ID as DeploymentView["deploymentId"],
        projectId: PROJECT_ID,
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI" as DeploymentView["consumerAgentRuntimeIds"][number]],
        platform: "linux",
        platformInstanceId: "local",
        targetRootPath: "/project",
        appliedInputsSnapshot: {} as DeploymentView["appliedInputsSnapshot"],
        observationState: "complete",
        observationAttemptedAt: 2 as DeploymentView["observationAttemptedAt"],
        lastCompleteObservationAt: 2 as DeploymentView["lastCompleteObservationAt"],
        blockingEvidence: {} as DeploymentView["blockingEvidence"],
        deleted: false,
        createdAt: 1 as DeploymentView["createdAt"],
        updatedAt: 2 as DeploymentView["updatedAt"],
        derivedStatus: { stage: "in_sync", reason: "ok", actionHints: ["check_now"], diagnostics: [], observationWarnings: [] },
        assets: [
            {
                assetId: ASSET_ID as DeploymentView["assets"][number]["assetId"],
                versionId: VERSION_ID as DeploymentView["assets"][number]["versionId"],
                allowIncomplete: false,
            },
        ],
        files: [],
    };
}

export function h2RenderPreview(
    actionState: DeploymentRenderPreviewView["actionState"] = "ready_apply",
): DeploymentRenderPreviewView {
    return {
        schemaVersion: 3,
        deploymentId: VERSION_ID as DeploymentRenderPreviewView["deploymentId"],
        renderInputFingerprint: H2_DIGEST,
        selectionFingerprint: H2_DIGEST,
        compilationFingerprint: H2_DIGEST,
        previewFingerprint: H2_DIGEST,
        replacementScope: { filePaths: [], directoryPaths: [] },
        actionState,
        files: [],
        directories: [],
    };
}

export function h2Inspection(): RenderedTargetInspectionResult {
    return {
        status: "complete",
        inspectionScopeFingerprint: H2_DIGEST,
        changes: [
            {
                changeKind: "file_content_replacement",
                changeFingerprint: H2_DIGEST,
                semanticRefFingerprints: [H2_DIGEST],
                replacementContent: { contentKind: "text", text: "changed" },
            },
        ],
        files: [
            {
                relativePath: "AGENTS.md" as RenderedTargetInspectionResult["files"][number]["relativePath"],
                attributionState: "conflict",
                reasonCode: "ambiguous",
                diagnostics: [],
            },
        ],
        reverseCoverageProofs: [],
        inspectionResultFingerprint: H2_DIGEST,
        diagnostics: [],
    };
}
