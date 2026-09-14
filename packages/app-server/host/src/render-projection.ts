import type {
    AssetUsageProjectionView,
    DeploymentRenderAnalysisView,
    DeploymentRenderPreviewView,
    ReindexReport,
    RenderAnalysisView,
    RenderedTargetAcceptCommitView,
    RenderSelectionRequest,
} from "@oaam/core";
import { projectDiagnostic, toCoreSha256, toProtocolSha256 } from "./core-outcome";

export function projectAssetUsage(
    value: AssetUsageProjectionView,
    expected: {
        readonly assetId: string;
        readonly versionId: string;
        readonly agentRuntimeIds: readonly string[];
    },
) {
    const expectedRuntimeIds = [...expected.agentRuntimeIds].sort();
    const actualRuntimeIds = value.relationships.map((relationship) => relationship.agentRuntimeId).sort();
    if (
        value.assetId !== expected.assetId ||
        value.versionId !== expected.versionId ||
        JSON.stringify(actualRuntimeIds) !== JSON.stringify(expectedRuntimeIds)
    ) {
        throw new TypeError("Asset usage projection does not match the exact request identity");
    }
    return {
        schemaVersion: value.schemaVersion,
        assetId: value.assetId,
        versionId: value.versionId,
        relationships: value.relationships.map((relationship) => ({
            agentRuntimeId: relationship.agentRuntimeId,
            capability: relationship.capability,
            observedTargetState: relationship.observedTargetState,
            managedState: relationship.managedState,
            substitute: relationship.substitute === null ? null : { ...relationship.substitute },
            deploymentIds: [...relationship.deploymentIds],
            appliedDeploymentIds: [...relationship.appliedDeploymentIds],
            degradationKinds: [...relationship.degradationKinds],
            reasonCodes: [...relationship.reasonCodes],
            diagnostics: relationship.diagnostics.map(projectDiagnostic),
            requiresReview: relationship.requiresReview,
        })),
    };
}

export function toCoreRenderSelection(selection: {
    readonly schemaVersion: 1;
    readonly renderInputFingerprint: string;
    readonly semanticOptions: readonly {
        readonly optionFingerprint: string;
        readonly approval:
            | { readonly action: "none" }
            | { readonly action: "approve_once"; readonly userActionId: string }
            | { readonly action: "use_saved_policy"; readonly policyId: string };
    }[];
}): RenderSelectionRequest {
    return {
        schemaVersion: 1,
        renderInputFingerprint: toCoreSha256(selection.renderInputFingerprint),
        semanticOptions: selection.semanticOptions.map((option) => ({
            optionFingerprint: toCoreSha256(option.optionFingerprint),
            approvalRequest:
                option.approval.action === "none"
                    ? { approvalAction: "none" }
                    : option.approval.action === "approve_once"
                      ? { approvalAction: "approve_once", userActionId: option.approval.userActionId }
                      : { approvalAction: "use_saved_policy", policyId: option.approval.policyId },
        })),
    };
}

export function projectRenderAnalysis(deploymentId: string, analysis: RenderAnalysisView | DeploymentRenderAnalysisView) {
    const outputUnits = new Map(
        analysis.analyses.flatMap((providerAnalysis) =>
            providerAnalysis.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit] as const),
        ),
    );
    return {
        deploymentId,
        renderInputFingerprint: toProtocolSha256(analysis.renderInputFingerprint),
        semantics: analysis.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: toProtocolSha256(semantic.semanticRefFingerprint),
            consumerAgentRuntimeId: semantic.consumerAgentRuntimeId,
            semanticKind: semantic.semanticKind,
            subject: { ...semantic.subject },
        })),
        outputUnits: [...outputUnits.values()].map((unit) => ({
            outputUnitFingerprint: toProtocolSha256(unit.outputUnitFingerprint),
            claims: unit.claims.map((claim) => ({ ...claim })),
            managedDirectoryPaths: unit.managedDirectoryBoundaries.map((boundary) => boundary.relativePath),
        })),
        options: analysis.analyses.flatMap((providerAnalysis) =>
            providerAnalysis.semanticOptions.map((option) => {
                const base = {
                    optionFingerprint: toProtocolSha256(option.optionFingerprint),
                    semanticRefFingerprint: toProtocolSha256(option.semanticRefFingerprint),
                    renderStrategy: option.renderStrategy,
                    actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                    requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints.map(toProtocolSha256),
                    reasonCode: option.reasonCode,
                    diagnostics: option.diagnostics.map(projectDiagnostic),
                };
                const outcome =
                    option.outcome === "preserved"
                        ? ({ outcome: "preserved" } as const)
                        : ({ outcome: "degraded", degradationKinds: [...option.degradationKinds] } as const);
                const approval =
                    option.approvalRequirement.approvalState === "not_required"
                        ? ({ approvalState: "not_required" } as const)
                        : ({
                              approvalState: "required" as const,
                              approvalConcerns: [...option.approvalRequirement.concerns],
                              approvalFingerprint: toProtocolSha256(option.approvalRequirement.approvalFingerprint),
                          } as const);
                return { ...base, ...outcome, ...approval };
            }),
        ),
        promotionAuthorizationInspections: ("promotionAuthorizationInspections" in analysis
            ? analysis.promotionAuthorizationInspections
            : []
        ).map((inspection) => {
            const target =
                inspection.target.targetKind === "project"
                    ? { targetKind: "project" as const, projectId: inspection.target.projectId }
                    : {
                          targetKind: "global_target" as const,
                          targetAuthorityFingerprint: toProtocolSha256(inspection.target.targetAuthorityFingerprint),
                      };
            const base = {
                promotionAuthorizationState: inspection.promotionAuthorizationState,
                assetId: inspection.assetId,
                versionId: inspection.versionId,
                target,
            };
            if (inspection.promotionAuthorizationState === "unavailable") {
                return { ...base, diagnosticCode: inspection.diagnosticCode };
            }
            const authority = {
                ...base,
                versionOriginAuthorityFingerprint: toProtocolSha256(inspection.versionOriginAuthorityFingerprint),
            };
            return inspection.promotionAuthorizationState === "authorized"
                ? {
                      ...authority,
                      authorizationSource: inspection.authorizationSource,
                      authorityId: inspection.authorityId,
                      authorityRevision: inspection.authorityRevision,
                      authorityFingerprint: toProtocolSha256(inspection.authorityFingerprint),
                  }
                : authority;
        }),
        blockedSemantics: analysis.analyses.flatMap((providerAnalysis) =>
            providerAnalysis.blockedSemanticRefs.map((blocked) => ({
                semanticRefFingerprint: toProtocolSha256(blocked.semanticRefFingerprint),
                reasonCode: blocked.reasonCode,
                diagnostics: blocked.diagnostics.map(projectDiagnostic),
            })),
        ),
        diagnostics: analysis.analyses.flatMap((providerAnalysis) => providerAnalysis.diagnostics.map(projectDiagnostic)),
    };
}

export function projectDeploymentRenderPreview(previewToken: string, preview: DeploymentRenderPreviewView) {
    const projectState = (state: DeploymentRenderPreviewView["files"][number]["current"]) =>
        state.state === "missing"
            ? ({ state: "missing" } as const)
            : state.contentKind === "text"
              ? {
                    state: "present" as const,
                    contentKind: "text" as const,
                    contentHash: toProtocolSha256(state.contentHash),
                    byteSize: state.byteSize,
                    executable: state.executable,
                    text: state.text,
                }
              : {
                    state: "present" as const,
                    contentKind: "binary" as const,
                    contentHash: toProtocolSha256(state.contentHash),
                    byteSize: state.byteSize,
                    executable: state.executable,
                };
    return {
        schemaVersion: preview.schemaVersion,
        previewToken,
        deploymentId: preview.deploymentId,
        renderInputFingerprint: toProtocolSha256(preview.renderInputFingerprint),
        selectionFingerprint: toProtocolSha256(preview.selectionFingerprint),
        compilationFingerprint: toProtocolSha256(preview.compilationFingerprint),
        previewFingerprint: toProtocolSha256(preview.previewFingerprint),
        replacementScope: {
            filePaths: [...preview.replacementScope.filePaths],
            directoryPaths: [...preview.replacementScope.directoryPaths],
        },
        actionState: preview.actionState,
        files: preview.files.map((file) => ({
            relativePath: file.relativePath,
            baselineState: file.baselineState,
            changeKind: file.changeKind,
            current: projectState(file.current),
            desired: projectState(file.desired),
        })),
        directories: preview.directories.map((directory) => ({ ...directory })),
    };
}

export function projectReverseCommit(commit: RenderedTargetAcceptCommitView) {
    return commit.commitState === "committed" ||
        (commit.commitState === "not_committed" && commit.versionPublicationState === "published_not_selected")
        ? { ...commit, version: { ...commit.version } }
        : { ...commit };
}

export function projectReindex(report: ReindexReport) {
    return {
        scannedAssets: report.scannedAssets,
        indexedAssets: report.indexedAssets,
        skippedAssets: report.skippedAssets,
        diagnostics: report.diagnostics.map(projectDiagnostic),
    };
}
