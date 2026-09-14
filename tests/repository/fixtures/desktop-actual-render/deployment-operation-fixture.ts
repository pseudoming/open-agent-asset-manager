import {
    type ProtocolDiagnosticV1,
    type ProtocolOperationName,
    parseProtocolTerminalOutcome,
    protocolDiagnosticSchema,
} from "@oaam/app-server-protocol";
import { ClientTransportError } from "@oaam/client-framework";
import type {
    DesktopApplicationClientApi,
    DesktopLongOperationListener,
} from "../../../../packages/client/desktop/src/renderer/client";
import type {
    AssetSummaryView,
    DeploymentView,
    InspectionDetailView,
    InspectionSummaryView,
    ProjectView,
    RenderAnalysisView,
    RenderPreviewView,
} from "../../../../packages/client/desktop/src/renderer/features/catalog-deployment/catalog-deployment-model";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

export const DEPLOYMENT_OPERATION_FIXTURE_OPERATIONS: readonly ProtocolOperationName[] = Object.freeze([
    "deployment.render_analyze",
    "deployment.render_preview",
    "deployment.deploy",
    "deployment.scan",
    "deployment.inspect_rendered_target",
    "rendered_inspection.detail",
    "deployment.repair",
    "deployment.recover",
    "reverse_accept.prepare",
    "reverse_accept.commit",
    "reverse_accept.cancel",
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
    kind: "Workflow",
    scope: "project",
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Release workflow",
    displayDescription: "Current Project release instructions",
    currentVersionId: VERSION_ID,
    currentRevision: 2,
    currentFingerprint: DIGEST_A,
    currentVersionStatus: "complete",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
});

function deployment(
    stage: DeploymentView["stage"],
    actionHints?: DeploymentView["actionHints"],
    firstDeployment = false,
): DeploymentView {
    const resolvedHints: DeploymentView["actionHints"] =
        actionHints ??
        (stage === "blocked"
            ? ["recover"]
            : stage === "conflict"
              ? ["review_external_changes", "check_now"]
              : stage === "needs_repair"
                ? ["review_repair", "check_now"]
                : stage === "in_sync"
                  ? ["check_now"]
                  : []);
    return Object.freeze({
        deploymentId: DEPLOYMENT_ID,
        subject: Object.freeze({ subjectKind: "project" as const, projectId: PROJECT_ID }),
        consumerAgentRuntimeIds: Object.freeze(["CLAUDE_CODE_CLI"]),
        environment: Object.freeze({ platform: "wsl" as const, platformInstanceId: "Ubuntu" }),
        targetRootPath: "/workspace/open-agent-asset-manager",
        stage,
        reason: stage,
        actionHints: Object.freeze(resolvedHints),
        freshness: firstDeployment
            ? Object.freeze({ state: "never" as const, attemptedAt: 0, lastCompleteAt: 0 })
            : Object.freeze({ state: "complete" as const, attemptedAt: 2, lastCompleteAt: 2 }),
        deleted: false,
        assets: Object.freeze([Object.freeze({ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false })]),
        createdAt: 1,
        updatedAt: 2,
    });
}

const INITIAL_DEPLOYMENT = deployment("in_sync", ["review_deployment"], true);

const RENDER_SEMANTIC = Object.freeze({
    semanticRefFingerprint: DIGEST_A,
    consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
    semanticKind: "workflow.content" as const,
    subject: Object.freeze({
        subjectKind: "file" as const,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        fileId: FILE_ID,
    }),
});

const RENDER_ANALYSIS: RenderAnalysisView = Object.freeze({
    deploymentId: DEPLOYMENT_ID,
    renderInputFingerprint: DIGEST_A,
    semantics: Object.freeze([RENDER_SEMANTIC]),
    outputUnits: Object.freeze([
        Object.freeze({
            outputUnitFingerprint: DIGEST_B,
            claims: Object.freeze([
                Object.freeze({
                    relativePath: ".claude/commands/oaam-release.md",
                    contentKind: "text" as const,
                    executable: false,
                }),
            ]),
            managedDirectoryPaths: Object.freeze([]),
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
            reasonCode: "native_project_exact_file_preserved",
            diagnostics: Object.freeze([]),
        }),
    ]),
    promotionAuthorizationInspections: Object.freeze([]),
    blockedSemantics: Object.freeze([]),
    diagnostics: Object.freeze([]),
});

const BLOCKED_ANALYSIS: RenderAnalysisView = Object.freeze({
    deploymentId: DEPLOYMENT_ID,
    renderInputFingerprint: DIGEST_A,
    semantics: Object.freeze([RENDER_SEMANTIC]),
    outputUnits: Object.freeze([]),
    options: Object.freeze([]),
    promotionAuthorizationInspections: Object.freeze([]),
    blockedSemantics: Object.freeze([
        Object.freeze({
            semanticRefFingerprint: DIGEST_A,
            reasonCode: "claudecode_project_workflow_exact_file_blocked",
            diagnostics: Object.freeze([
                fixtureDiagnostic(
                    "render",
                    "fixture raw blocked-render diagnostic",
                    "unsupported",
                    Object.freeze(["choose_target"]),
                ),
            ]),
        }),
    ]),
    diagnostics: Object.freeze([]),
});

const RENDER_PREVIEW: RenderPreviewView = Object.freeze({
    schemaVersion: 3,
    previewToken: "actual-render-deployment-preview",
    deploymentId: DEPLOYMENT_ID,
    renderInputFingerprint: DIGEST_A,
    selectionFingerprint: DIGEST_B,
    compilationFingerprint: DIGEST_A,
    previewFingerprint: DIGEST_C,
    replacementScope: Object.freeze({
        filePaths: Object.freeze([".claude/commands/oaam-release.md"]),
        directoryPaths: Object.freeze([]),
    }),
    actionState: "ready_apply",
    files: Object.freeze([
        Object.freeze({
            relativePath: ".claude/commands/oaam-release.md",
            baselineState: "unmanaged" as const,
            changeKind: "create" as const,
            current: Object.freeze({ state: "missing" as const }),
            desired: Object.freeze({
                state: "present" as const,
                contentKind: "text" as const,
                contentHash: DIGEST_A,
                byteSize: 62,
                executable: false,
                text: "---\ndescription: Release workflow\n---\nRun the release checks.\n",
            }),
        }),
    ]),
    directories: Object.freeze([]),
});

const INSPECTION: InspectionSummaryView = Object.freeze({
    inspectionToken: "actual-render-deployment-inspection",
    deploymentId: DEPLOYMENT_ID,
    inspectionResultFingerprint: DIGEST_C,
    changeCount: 1,
    conflictCount: 1,
    details: Object.freeze([
        Object.freeze({
            selector: "semantic-1",
            detailKind: "semantic_change" as const,
            displayName: "Workflow instructions",
        }),
    ]),
    detailsTruncated: false,
});

const INSPECTION_DETAIL: InspectionDetailView = Object.freeze({
    inspectionToken: INSPECTION.inspectionToken,
    selector: "semantic-1",
    detailKind: "semantic_change",
    changeKind: "file_content_replacement",
    changeFingerprint: DIGEST_C,
    content: Object.freeze({
        contentKind: "text" as const,
        mediaType: "text/markdown",
        text: Object.freeze({ text: "# Changed outside OAAM\n", byteLength: 23, truncated: false }),
        contentHash: DIGEST_C,
    }),
});

const REVERSE_PREPARATION_IDS = Object.freeze([
    "60000000-0000-4000-8000-000000000001",
    "60000000-0000-4000-8000-000000000002",
    "60000000-0000-4000-8000-000000000003",
    "60000000-0000-4000-8000-000000000004",
    "60000000-0000-4000-8000-000000000005",
    "60000000-0000-4000-8000-000000000006",
    "60000000-0000-4000-8000-000000000007",
    "60000000-0000-4000-8000-000000000008",
]);

function preparedReverseOutcome(index: number) {
    const preparationId = REVERSE_PREPARATION_IDS[index];
    if (preparationId === undefined) throw new Error(`missing reverse preparation fixture ${String(index)}`);
    return parseProtocolTerminalOutcome("reverse_accept.prepare", {
        status: "complete",
        value: {
            preparationState: "prepared",
            preparationId,
            preparationRevision: 1,
            expiresAt: 1_900_000_000_000,
            promotionState: "user_confirmation_required",
            renderAnalysis: RENDER_ANALYSIS,
        },
        diagnostics: [],
    });
}

function fixtureDiagnostic(
    operation: ProtocolDiagnosticV1["operation"],
    message: string,
    causeKind: ProtocolDiagnosticV1["causeKind"] = "internal_error",
    suggestedActions: ProtocolDiagnosticV1["suggestedActions"] = Object.freeze(["retry"]),
): ProtocolDiagnosticV1 {
    return protocolDiagnosticSchema.parse({
        severity: "error",
        code: "fixture.operation_failed",
        operation,
        causeKind,
        retryable: true,
        suggestedActions,
        message,
    });
}

function recordFixtureAction(name: string): number {
    const key = `oaam${name}`;
    const count = Number.parseInt(document.documentElement.dataset[key] ?? "0", 10) + 1;
    document.documentElement.dataset[key] = String(count);
    return count;
}

function waitForRelease(eventName: string): Promise<void> {
    return new Promise((resolve) => {
        document.addEventListener(eventName, () => resolve(), { once: true });
    });
}

function emitProgress<
    TName extends
        | "deployment.render_analyze"
        | "deployment.render_preview"
        | "deployment.deploy"
        | "deployment.scan"
        | "deployment.inspect_rendered_target"
        | "deployment.repair"
        | "deployment.recover"
        | "reverse_accept.prepare"
        | "reverse_accept.commit"
        | "reverse_accept.cancel",
>(operation: TName, listener?: DesktopLongOperationListener<TName>): void {
    listener?.({
        status: "accepted",
        operation,
        operationId: `actual-render-${operation}`,
    });
    listener?.({
        status: "progress",
        operation,
        operationId: `actual-render-${operation}`,
        sequence: 1,
        progress: {
            stage: `fixture.${operation}`,
            completedUnits: 1,
            totalUnits: 2,
        },
    } as Parameters<NonNullable<typeof listener>>[0]);
}

export function createDeploymentOperationFixtureClient(enabled: boolean): Readonly<Partial<DesktopApplicationClientApi>> {
    if (!enabled) return Object.freeze({});
    let providerLoadCount = 0;
    let analysisCount = 0;
    let previewCount = 0;
    let scanCount = 0;
    let inspectionCount = 0;
    let reversePrepareCount = 0;
    let reverseCommitCount = 0;
    let reverseCancelCount = 0;
    let currentDeployment = INITIAL_DEPLOYMENT;
    let currentAsset = ASSET;
    let reverseRefreshPending = false;

    return Object.freeze({
        async listAdapterProviders() {
            providerLoadCount += 1;
            recordFixtureAction("DeploymentProviderLoadCount");
            // The Asset library performs one ordinary provider projection before the user opens
            // the Deployment workspace. Keep the deferred/failing call bound to Deployment's own
            // target discovery rather than consuming it in the library target-support projection.
            if (providerLoadCount === 2) {
                await waitForRelease("oaam-fixture-release-deployment-target-load");
                return {
                    status: "failed" as const,
                    diagnostics: Object.freeze([
                        fixtureDiagnostic("settings", "fixture raw target-loading failure", "unavailable"),
                    ]),
                };
            }
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
                    userActionEvidenceId: "actual-render-deployment-enablement",
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
            if (reverseRefreshPending) {
                reverseRefreshPending = false;
                await waitForRelease("oaam-fixture-release-reverse-refresh");
            }
            return {
                status: "complete" as const,
                value: Object.freeze({ assets: Object.freeze([currentAsset]) }),
                diagnostics: Object.freeze([]),
            };
        },
        async listDeployments() {
            return {
                status: "complete" as const,
                value: Object.freeze({ deployments: Object.freeze([currentDeployment]) }),
                diagnostics: Object.freeze([]),
            };
        },
        async analyzeDeployment(_input, listener) {
            analysisCount += 1;
            recordFixtureAction("DeploymentAnalyzeCount");
            emitProgress("deployment.render_analyze", listener);
            if (analysisCount === 1) {
                await waitForRelease("oaam-fixture-release-deployment-analysis");
                return {
                    status: "complete" as const,
                    value: BLOCKED_ANALYSIS,
                    diagnostics: Object.freeze([]),
                };
            }
            if (analysisCount === 3) {
                throw new ClientTransportError(
                    "uncertain",
                    "deployment.render_analyze",
                    "actual-render-analysis-uncertain",
                    "fixture uncertain render analysis",
                    new Error("fixture transport closed"),
                );
            }
            return {
                status: "complete" as const,
                value: RENDER_ANALYSIS,
                diagnostics: Object.freeze([]),
            };
        },
        async previewDeployment(_input, listener) {
            previewCount += 1;
            recordFixtureAction("DeploymentPreviewCount");
            emitProgress("deployment.render_preview", listener);
            if (previewCount === 1) {
                throw new ClientTransportError(
                    "uncertain",
                    "deployment.render_preview",
                    "actual-render-preview-uncertain",
                    "fixture uncertain target preview",
                    new Error("fixture transport closed"),
                );
            }
            await waitForRelease("oaam-fixture-release-deployment-preview");
            return {
                status: "complete" as const,
                value: RENDER_PREVIEW,
                diagnostics: Object.freeze([]),
            };
        },
        async deploy(_input, listener) {
            recordFixtureAction("DeploymentDeployCount");
            emitProgress("deployment.deploy", listener);
            await waitForRelease("oaam-fixture-release-deployment-deploy");
            currentDeployment = deployment("in_sync");
            return {
                status: "complete" as const,
                value: currentDeployment,
                diagnostics: Object.freeze([]),
            };
        },
        async scanDeployment(_input, listener) {
            scanCount += 1;
            recordFixtureAction("DeploymentScanCount");
            emitProgress("deployment.scan", listener);
            if (scanCount === 4) {
                return {
                    status: "failed" as const,
                    diagnostics: Object.freeze([
                        fixtureDiagnostic("scan", "fixture raw Deployment scan failure", "verification_failed"),
                    ]),
                };
            }
            currentDeployment =
                scanCount === 1
                    ? deployment("conflict")
                    : scanCount === 2
                      ? deployment("needs_repair")
                      : scanCount === 3
                        ? deployment("blocked")
                        : deployment("conflict");
            return {
                status: "complete" as const,
                value: currentDeployment,
                diagnostics: Object.freeze([]),
            };
        },
        async inspectRenderedTarget(_input, listener) {
            inspectionCount += 1;
            recordFixtureAction("DeploymentInspectionCount");
            emitProgress("deployment.inspect_rendered_target", listener);
            if (inspectionCount === 1) {
                throw new ClientTransportError(
                    "uncertain",
                    "deployment.inspect_rendered_target",
                    "actual-render-inspection-uncertain",
                    "fixture uncertain target inspection",
                    new Error("fixture transport closed"),
                );
            }
            return {
                status: "complete" as const,
                value: INSPECTION,
                diagnostics: Object.freeze([]),
            };
        },
        async getRenderedInspectionDetail() {
            return {
                status: "complete" as const,
                value: INSPECTION_DETAIL,
                diagnostics: Object.freeze([]),
            };
        },
        async repairDeployment(_input, listener) {
            recordFixtureAction("DeploymentRepairCount");
            emitProgress("deployment.repair", listener);
            await waitForRelease("oaam-fixture-release-deployment-repair");
            currentDeployment = deployment("in_sync");
            return {
                status: "complete" as const,
                value: currentDeployment,
                diagnostics: Object.freeze([]),
            };
        },
        async recoverDeployment(_input, listener) {
            recordFixtureAction("DeploymentRecoverCount");
            emitProgress("deployment.recover", listener);
            await waitForRelease("oaam-fixture-release-deployment-recover");
            currentDeployment = deployment("in_sync");
            return {
                status: "complete" as const,
                value: currentDeployment,
                diagnostics: Object.freeze([]),
            };
        },
        async prepareReverseAccept(_input, listener) {
            reversePrepareCount += 1;
            recordFixtureAction("ReversePrepareCount");
            emitProgress("reverse_accept.prepare", listener);
            if (reversePrepareCount === 1) {
                await waitForRelease("oaam-fixture-release-reverse-prepare");
                return parseProtocolTerminalOutcome("reverse_accept.prepare", {
                    status: "failed",
                    value: { preparationState: "not_prepared" },
                    diagnostics: [
                        fixtureDiagnostic(
                            "reverse_accept",
                            "fixture raw reverse preparation warning",
                            "verification_failed",
                            Object.freeze(["rebuild_deployment"]),
                        ),
                    ],
                });
            }
            if (reversePrepareCount === 2) {
                return parseProtocolTerminalOutcome("reverse_accept.prepare", {
                    status: "failed",
                    diagnostics: [
                        fixtureDiagnostic(
                            "reverse_accept",
                            "fixture raw reverse preparation failure",
                            "conflict",
                            Object.freeze(["retry"]),
                        ),
                    ],
                });
            }
            return preparedReverseOutcome(reversePrepareCount - 3);
        },
        async cancelReverseAccept(_input, listener) {
            reverseCancelCount += 1;
            recordFixtureAction("ReverseCancelCount");
            emitProgress("reverse_accept.cancel", listener);
            if (reverseCancelCount === 1) {
                await waitForRelease("oaam-fixture-release-reverse-cancel");
                return parseProtocolTerminalOutcome("reverse_accept.cancel", {
                    status: "failed",
                    diagnostics: [
                        fixtureDiagnostic(
                            "reverse_accept",
                            "fixture raw reverse cancellation failure",
                            "conflict",
                            Object.freeze(["retry"]),
                        ),
                    ],
                });
            }
            return parseProtocolTerminalOutcome("reverse_accept.cancel", {
                status: "complete",
                value: {},
                diagnostics: [],
            });
        },
        async commitReverseAccept(_input, listener) {
            reverseCommitCount += 1;
            recordFixtureAction("ReverseCommitCount");
            emitProgress("reverse_accept.commit", listener);
            if (reverseCommitCount === 1) {
                await waitForRelease("oaam-fixture-release-reverse-commit");
                currentAsset = {
                    ...ASSET,
                    currentVersionId: "70000000-0000-4000-8000-000000000001",
                    currentRevision: 3,
                    currentFingerprint: DIGEST_B,
                };
                currentDeployment = {
                    ...deployment("in_sync"),
                    assets: [{ assetId: ASSET_ID, versionId: currentAsset.currentVersionId, allowIncomplete: false }],
                };
                reverseRefreshPending = true;
                return parseProtocolTerminalOutcome("reverse_accept.commit", {
                    status: "complete",
                    value: {
                        commitState: "committed",
                        version: {
                            assetId: ASSET_ID,
                            versionId: "70000000-0000-4000-8000-000000000001",
                        },
                    },
                    diagnostics: [],
                });
            }
            if (reverseCommitCount === 2) {
                return parseProtocolTerminalOutcome("reverse_accept.commit", {
                    status: "partial",
                    value: {
                        commitState: "not_committed",
                        versionPublicationState: "published_not_selected",
                        version: {
                            assetId: ASSET_ID,
                            versionId: "70000000-0000-4000-8000-000000000002",
                        },
                    },
                    diagnostics: [],
                });
            }
            if (reverseCommitCount === 3) {
                return parseProtocolTerminalOutcome("reverse_accept.commit", {
                    status: "failed",
                    value: { commitState: "not_committed", versionPublicationState: "not_published" },
                    diagnostics: [],
                });
            }
            if (reverseCommitCount === 4) {
                return parseProtocolTerminalOutcome("reverse_accept.commit", {
                    status: "failed",
                    value: { commitState: "recovery_required", reasonCode: "durability_unconfirmed" },
                    diagnostics: [],
                });
            }
            if (reverseCommitCount === 5) {
                return parseProtocolTerminalOutcome("reverse_accept.commit", {
                    status: "failed",
                    value: { commitState: "outcome_unavailable" },
                    diagnostics: [],
                });
            }
            return parseProtocolTerminalOutcome("reverse_accept.commit", {
                status: "failed",
                diagnostics: [
                    fixtureDiagnostic(
                        "reverse_accept",
                        "fixture raw reverse commit failure",
                        "conflict",
                        Object.freeze(["retry"]),
                    ),
                ],
            });
        },
    });
}
