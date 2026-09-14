import type {
    InspectionDetailView,
    InspectionSummaryView,
    ProbeReviewView,
    PreparedReverseView,
    RenderAnalysisView,
    RenderPreviewView,
    ReverseCommitView,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import type { AdapterProviderView } from "../src/renderer/features/discovery/discovery-model";

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_C = "c".repeat(64);
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";

export const DEPLOYMENT_PROVIDERS = [
    {
        adapterId: "CLAUDECODE",
        displayName: "Claude Code",
        version: "1.0.0",
        enabled: true,
        agentRuntimes: [
            { agentRuntimeId: "CLAUDE_CODE_CLI", displayName: "Claude Code CLI", entryClass: "cli" },
            { agentRuntimeId: "CLAUDE_CODE_APP", displayName: "Claude Code App", entryClass: "app" },
        ],
        sourceCapabilities: [],
        targetCapabilities: [
            {
                agentRuntimeId: "CLAUDE_CODE_CLI",
                assetKind: "Guidance",
                entrySupportStatus: "supported",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                diagnostics: [],
            },
        ],
    },
] as const satisfies readonly AdapterProviderView[];

export const PROBE_REVIEW: ProbeReviewView = {
    probeToken: "probe-token",
    results: [
        {
            rowId: "probe-row",
            adapterId: "CLAUDECODE",
            environment: { platform: "linux", platformInstanceId: "local" },
            status: "complete",
            runtimes: [
                {
                    rowId: "claude-cli-runtime",
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    versionText: "2.1.220",
                    installationStatus: "available",
                    projectDiscoveryStatus: "complete",
                    sourceRootRowIds: [],
                    diagnostics: [],
                },
            ],
            sources: [],
            projects: [],
            targets: [
                {
                    rowId: "target-row",
                    targetCandidateId: "target-candidate",
                    targetKind: "project",
                    displayName: "OAAM project",
                    displayPath: "/workspace/oaam",
                    entryApplicabilities: [
                        { agentRuntimeId: "CLAUDE_CODE_CLI", status: "ready_for_plan", diagnostics: [] },
                        { agentRuntimeId: "CLAUDE_CODE_APP", status: "unknown", diagnostics: [] },
                    ],
                    diagnostics: [],
                },
                {
                    rowId: "unready-target",
                    targetCandidateId: "unready-candidate",
                    targetKind: "directory",
                    displayName: "Unverified directory",
                    displayPath: "/workspace/unverified",
                    entryApplicabilities: [{ agentRuntimeId: "CLAUDE_CODE_APP", status: "invalid", diagnostics: [] }],
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        },
    ],
};

export const RENDER_ANALYSIS: RenderAnalysisView = {
    deploymentId: DEPLOYMENT_ID,
    renderInputFingerprint: SHA_A,
    semantics: [
        {
            semanticRefFingerprint: SHA_A,
            consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
            semanticKind: "guidance.content",
            subject: { subjectKind: "file", assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID },
        },
    ],
    outputUnits: [
        {
            outputUnitFingerprint: SHA_B,
            claims: [
                { relativePath: "CLAUDE.md", contentKind: "text", executable: false },
                { relativePath: "bin/helper", contentKind: "binary", executable: true },
            ],
            managedDirectoryPaths: [".claude/skills"],
        },
    ],
    options: [
        {
            optionFingerprint: SHA_B,
            semanticRefFingerprint: SHA_A,
            renderStrategy: "native_file",
            actualReverseExtractPolicy: "can_reconcile",
            requiredOutputUnitFingerprints: [SHA_B],
            outcome: "preserved",
            approvalState: "not_required",
            reasonCode: "native",
            diagnostics: [],
        },
        {
            optionFingerprint: SHA_C,
            semanticRefFingerprint: SHA_A,
            renderStrategy: "inline",
            actualReverseExtractPolicy: "unsupported",
            requiredOutputUnitFingerprints: [SHA_B],
            outcome: "degraded",
            degradationKinds: ["runtime_specific_metadata_lost"],
            approvalState: "required",
            approvalConcerns: ["semantic_degradation", "reverse_extract_unsupported"],
            approvalFingerprint: SHA_C,
            reasonCode: "degraded",
            diagnostics: [],
        },
    ],
    promotionAuthorizationInspections: [
        {
            promotionAuthorizationState: "not_required",
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            target: { targetKind: "project", projectId: PROJECT_ID },
            versionOriginAuthorityFingerprint: SHA_A,
        },
    ],
    blockedSemantics: [],
    diagnostics: [],
};

export const RENDER_PREVIEW: RenderPreviewView = {
    schemaVersion: 3,
    previewToken: "render-preview-token",
    deploymentId: DEPLOYMENT_ID,
    renderInputFingerprint: SHA_A,
    selectionFingerprint: SHA_B,
    compilationFingerprint: SHA_A,
    previewFingerprint: SHA_B,
    replacementScope: { filePaths: ["CLAUDE.md"], directoryPaths: [] },
    actionState: "ready_apply",
    files: [
        {
            relativePath: "CLAUDE.md",
            baselineState: "unmanaged",
            changeKind: "create",
            current: { state: "missing" },
            desired: {
                state: "present",
                contentKind: "text",
                contentHash: SHA_A,
                byteSize: 18,
                executable: false,
                text: "# Project guidance\n",
            },
        },
    ],
    directories: [],
};

export const INSPECTION: InspectionSummaryView = {
    inspectionToken: "inspection-token",
    deploymentId: DEPLOYMENT_ID,
    inspectionResultFingerprint: SHA_B,
    changeCount: 2,
    conflictCount: 1,
    details: [
        { selector: "semantic-1", detailKind: "semantic_change", displayName: "Guidance content" },
        { selector: "file-1", detailKind: "file_attribution", displayName: "AGENTS.md" },
    ],
    detailsTruncated: true,
};

export const INSPECTION_DETAIL: InspectionDetailView = {
    inspectionToken: "inspection-token",
    selector: "semantic-1",
    detailKind: "semantic_change",
    changeKind: "file_content_replacement",
    changeFingerprint: SHA_C,
    content: {
        contentKind: "text",
        mediaType: "text/markdown",
        text: { text: "# changed", byteLength: 9, truncated: false },
        contentHash: SHA_C,
    },
};

export const PREPARED_REVERSE: PreparedReverseView = {
    preparationState: "prepared",
    preparationId: "66666666-6666-4666-8666-666666666666",
    preparationRevision: 1,
    expiresAt: 1_800_000_000_000,
    promotionState: "user_confirmation_required",
    renderAnalysis: RENDER_ANALYSIS,
};

export const COMMITTED_REVERSE: ReverseCommitView = {
    commitState: "committed",
    version: { assetId: ASSET_ID, versionId: "77777777-7777-4777-8777-777777777777" },
};
