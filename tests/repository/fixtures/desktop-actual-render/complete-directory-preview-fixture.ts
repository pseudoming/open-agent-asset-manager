import { parseProtocolTerminalOutcome, type ProtocolOperationName } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../../../packages/client/desktop/src/renderer/client";
import type {
    AssetSummaryView,
    DeploymentView,
    ProjectView,
    RenderAnalysisView,
    RenderPreviewView,
} from "../../../../packages/client/desktop/src/renderer/features/catalog-deployment/catalog-deployment-model";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

export const COMPLETE_DIRECTORY_PREVIEW_OPERATIONS: readonly ProtocolOperationName[] = Object.freeze([
    "deployment.render_analyze",
    "deployment.render_preview",
]);

const PROJECT: ProjectView = Object.freeze({
    projectId: PROJECT_ID,
    displayName: "Open Agent Asset Manager",
    rootPath: "/workspace/open-agent-asset-manager",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
});

const ASSET: AssetSummaryView = Object.freeze({
    assetId: ASSET_ID,
    kind: "Skill",
    scope: "project",
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Release helper",
    displayDescription: "A complete directory Skill with owned resources",
    currentVersionId: VERSION_ID,
    currentRevision: 2,
    currentFingerprint: DIGEST_A,
    currentVersionStatus: "complete",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
});

const DEPLOYMENT: DeploymentView = Object.freeze({
    deploymentId: DEPLOYMENT_ID,
    subject: Object.freeze({ subjectKind: "project" as const, projectId: PROJECT_ID }),
    consumerAgentRuntimeIds: Object.freeze(["CLAUDE_CODE_CLI"]),
    environment: Object.freeze({ platform: "wsl" as const, platformInstanceId: "Ubuntu" }),
    targetRootPath: PROJECT.rootPath,
    stage: "in_sync",
    reason: "complete-directory-preview",
    actionHints: Object.freeze(["review_deployment"]),
    freshness: Object.freeze({ state: "never" as const, attemptedAt: 0, lastCompleteAt: 0 }),
    deleted: false,
    assets: Object.freeze([Object.freeze({ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false })]),
    createdAt: 1,
    updatedAt: 2,
});

const ANALYSIS: RenderAnalysisView = Object.freeze({
    deploymentId: DEPLOYMENT_ID,
    renderInputFingerprint: DIGEST_A,
    semantics: Object.freeze([
        Object.freeze({
            semanticRefFingerprint: DIGEST_A,
            consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
            semanticKind: "skill.body" as const,
            subject: Object.freeze({
                subjectKind: "file" as const,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                fileId: FILE_ID,
            }),
        }),
    ]),
    outputUnits: Object.freeze([
        Object.freeze({
            outputUnitFingerprint: DIGEST_B,
            claims: Object.freeze([
                Object.freeze({
                    relativePath: ".claude/skills/release-helper/SKILL.md",
                    contentKind: "text" as const,
                    executable: false,
                }),
                Object.freeze({
                    relativePath: ".claude/skills/release-helper/resources/reference.md",
                    contentKind: "text" as const,
                    executable: false,
                }),
            ]),
            managedDirectoryPaths: Object.freeze([".claude/skills/release-helper"]),
        }),
    ]),
    options: Object.freeze([
        Object.freeze({
            optionFingerprint: DIGEST_B,
            semanticRefFingerprint: DIGEST_A,
            renderStrategy: "native_file" as const,
            actualReverseExtractPolicy: "can_reconcile" as const,
            requiredOutputUnitFingerprints: Object.freeze([DIGEST_B]),
            outcome: "preserved" as const,
            approvalState: "not_required" as const,
            reasonCode: "native_project_complete_skill_preserved",
            diagnostics: Object.freeze([]),
        }),
    ]),
    promotionAuthorizationInspections: Object.freeze([]),
    blockedSemantics: Object.freeze([]),
    diagnostics: Object.freeze([]),
});

const PREVIEW: RenderPreviewView = Object.freeze({
    schemaVersion: 3,
    previewToken: "actual-render-complete-directory-preview",
    deploymentId: DEPLOYMENT_ID,
    renderInputFingerprint: DIGEST_A,
    selectionFingerprint: DIGEST_B,
    compilationFingerprint: DIGEST_C,
    previewFingerprint: DIGEST_C,
    replacementScope: Object.freeze({
        filePaths: Object.freeze([]),
        directoryPaths: Object.freeze([".claude/skills/release-helper"]),
    }),
    actionState: "requires_unmanaged_replacement",
    files: Object.freeze([
        Object.freeze({
            relativePath: ".claude/skills/release-helper/SKILL.md",
            baselineState: "managed" as const,
            changeKind: "update_managed" as const,
            current: Object.freeze({
                state: "present" as const,
                contentKind: "text" as const,
                contentHash: DIGEST_A,
                byteSize: 18,
                executable: false,
                text: "# Previous helper\n",
            }),
            desired: Object.freeze({
                state: "present" as const,
                contentKind: "text" as const,
                contentHash: DIGEST_B,
                byteSize: 17,
                executable: false,
                text: "# Release helper\n",
            }),
        }),
        Object.freeze({
            relativePath: ".claude/skills/release-helper/resources/reference.md",
            baselineState: "unmanaged" as const,
            changeKind: "create" as const,
            current: Object.freeze({ state: "missing" as const }),
            desired: Object.freeze({
                state: "present" as const,
                contentKind: "text" as const,
                contentHash: DIGEST_C,
                byteSize: 12,
                executable: false,
                text: "# Reference\n",
            }),
        }),
        Object.freeze({
            relativePath: ".claude/skills/release-helper/old.bin",
            baselineState: "managed" as const,
            changeKind: "remove_managed" as const,
            current: Object.freeze({
                state: "present" as const,
                contentKind: "binary" as const,
                contentHash: DIGEST_A,
                byteSize: 4,
                executable: false,
            }),
            desired: Object.freeze({ state: "missing" as const }),
        }),
        Object.freeze({
            relativePath: ".claude/skills/release-helper/scratch/local.txt",
            baselineState: "unmanaged" as const,
            changeKind: "replace_unmanaged" as const,
            current: Object.freeze({
                state: "present" as const,
                contentKind: "text" as const,
                contentHash: DIGEST_B,
                byteSize: 6,
                executable: false,
                text: "local\n",
            }),
            desired: Object.freeze({ state: "missing" as const }),
        }),
    ]),
    directories: Object.freeze([
        Object.freeze({
            managedBoundaryRelativePath: ".claude/skills/release-helper",
            relativePath: ".claude/skills/release-helper",
            baselineState: "managed" as const,
            changeKind: "unchanged" as const,
            currentState: "present" as const,
            desiredState: "present" as const,
        }),
        Object.freeze({
            managedBoundaryRelativePath: ".claude/skills/release-helper",
            relativePath: ".claude/skills/release-helper/resources",
            baselineState: "unmanaged" as const,
            changeKind: "create" as const,
            currentState: "missing" as const,
            desiredState: "present" as const,
        }),
        Object.freeze({
            managedBoundaryRelativePath: ".claude/skills/release-helper",
            relativePath: ".claude/skills/release-helper/empty",
            baselineState: "unmanaged" as const,
            changeKind: "create" as const,
            currentState: "missing" as const,
            desiredState: "present" as const,
        }),
        Object.freeze({
            managedBoundaryRelativePath: ".claude/skills/release-helper",
            relativePath: ".claude/skills/release-helper/old",
            baselineState: "managed" as const,
            changeKind: "remove_managed" as const,
            currentState: "present" as const,
            desiredState: "missing" as const,
        }),
        Object.freeze({
            managedBoundaryRelativePath: ".claude/skills/release-helper",
            relativePath: ".claude/skills/release-helper/scratch",
            baselineState: "unmanaged" as const,
            changeKind: "remove_unmanaged" as const,
            currentState: "present" as const,
            desiredState: "missing" as const,
        }),
    ]),
});

export function createCompleteDirectoryPreviewFixtureClient(enabled: boolean): Readonly<Partial<DesktopApplicationClientApi>> {
    if (!enabled) return Object.freeze({});
    return Object.freeze({
        async listAdapterProviders() {
            return {
                status: "complete" as const,
                value: Object.freeze({
                    providers: Object.freeze([
                        Object.freeze({
                            adapterId: "CLAUDECODE",
                            displayName: "Claude Code",
                            version: "1.0.0",
                            enabled: true,
                            agentRuntimes: Object.freeze([
                                Object.freeze({
                                    agentRuntimeId: "CLAUDE_CODE_CLI",
                                    displayName: "Claude Code CLI",
                                    entryClass: "cli" as const,
                                }),
                            ]),
                            sourceCapabilities: Object.freeze([]),
                            targetCapabilities: Object.freeze([]),
                        }),
                    ]),
                }),
                diagnostics: Object.freeze([]),
            };
        },
        async getAdapterEnablement() {
            return {
                status: "complete" as const,
                value: Object.freeze({
                    configVersion: 1 as const,
                    settingId: "adapter_enablement_v1" as const,
                    revision: 1,
                    enabledAdapterIds: Object.freeze(["CLAUDECODE"]),
                    userActionEvidenceId: "actual-render-complete-directory-enablement",
                    updatedAt: 1,
                    settingFingerprint: DIGEST_A,
                }),
                diagnostics: Object.freeze([]),
            };
        },
        async listProjects() {
            return {
                status: "complete" as const,
                value: Object.freeze({ projects: Object.freeze([PROJECT]) }),
                diagnostics: Object.freeze([]),
            };
        },
        async listAssets() {
            return {
                status: "complete" as const,
                value: Object.freeze({ assets: Object.freeze([ASSET]) }),
                diagnostics: Object.freeze([]),
            };
        },
        async listDeployments() {
            return {
                status: "complete" as const,
                value: Object.freeze({ deployments: Object.freeze([DEPLOYMENT]) }),
                diagnostics: Object.freeze([]),
            };
        },
        async analyzeDeployment() {
            document.documentElement.dataset.oaamCompleteDirectoryAnalyzeCount = "1";
            return { status: "complete" as const, value: ANALYSIS, diagnostics: Object.freeze([]) };
        },
        async previewDeployment(input) {
            document.documentElement.dataset.oaamCompleteDirectoryPreviewRequest = JSON.stringify(input);
            return parseProtocolTerminalOutcome("deployment.render_preview", {
                status: "complete",
                value: PREVIEW,
                diagnostics: [],
            });
        },
    });
}
