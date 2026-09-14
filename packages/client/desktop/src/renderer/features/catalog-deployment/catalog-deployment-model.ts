import type {
    ProtocolDiagnosticV1,
    ProtocolOperationParams,
    ProtocolOperationResult,
    ProtocolOperationTerminal,
} from "@oaam/app-server-protocol";
import {
    type DesktopDisplayText,
    type DesktopMessageId,
    type DesktopMessageValues,
    localizedText,
    uniqueProtocolDiagnostics,
} from "../../presentation";
import type { AdapterProviderView } from "../discovery/presentation";

type OutcomeValue<
    TName extends "project.list" | "asset.list" | "asset.get" | "asset_version.get" | "deployment.list" | "promotion_grant.list",
> = Extract<ProtocolOperationResult<TName>, { readonly value: unknown }>["value"];
type TerminalValue<
    TName extends
        | "adapter.probe"
        | "asset_usage.analyze"
        | "deployment.render_analyze"
        | "deployment.render_preview"
        | "deployment.inspect_rendered_target"
        | "reverse_accept.prepare"
        | "reverse_accept.commit",
> = Extract<ProtocolOperationTerminal<TName>, { readonly value: unknown }>["value"];

export function replaceCatalogProjectionById<T>(values: readonly T[], next: T, id: (value: T) => string): readonly T[] {
    return Object.freeze([...values.filter((value) => id(value) !== id(next)), next]);
}

export type ProjectView = OutcomeValue<"project.list">["projects"][number];
export type AssetSummaryView = OutcomeValue<"asset.list">["assets"][number];
export type AssetView = Extract<OutcomeValue<"asset.get">, { readonly found: true }>["value"];
export type AssetVersionView = Extract<OutcomeValue<"asset_version.get">, { readonly found: true }>["value"];
export type DeploymentView = OutcomeValue<"deployment.list">["deployments"][number];
export type PromotionGrantView = OutcomeValue<"promotion_grant.list">["grants"][number];
export type ProbeReviewView = TerminalValue<"adapter.probe">;
export type AssetUsageView = TerminalValue<"asset_usage.analyze">;
export type RenderAnalysisView = TerminalValue<"deployment.render_analyze">;
export type RenderPreviewView = TerminalValue<"deployment.render_preview">;
export type RenderOptionView = RenderAnalysisView["options"][number];
export type RenderSemanticView = RenderAnalysisView["semantics"][number];
export type RenderOutputUnitView = RenderAnalysisView["outputUnits"][number];
export type InspectionSummaryView = TerminalValue<"deployment.inspect_rendered_target">;
export type ReversePreparationView = TerminalValue<"reverse_accept.prepare">;
export type PreparedReverseView = Extract<ReversePreparationView, { readonly preparationState: "prepared" }>;
export type ReverseCommitView = TerminalValue<"reverse_accept.commit">;
export type InspectionDetailView = Extract<
    ProtocolOperationResult<"rendered_inspection.detail">,
    { readonly value: unknown }
>["value"];

export interface DeploymentTargetView {
    readonly key: string;
    readonly probeToken: string;
    readonly probeResultRowId: string;
    readonly targetRowId: string;
    readonly targetCandidateId: string;
    readonly adapterId: string;
    readonly platform: "win32" | "wsl" | "darwin" | "linux";
    readonly platformInstanceId: string;
    readonly targetKind: "global" | "project" | "directory" | "unknown";
    readonly displayName: string;
    readonly displayPath: string;
    readonly runtimeIdentities: readonly DeploymentTargetRuntimeIdentity[];
    readonly readyAgentRuntimeIds: readonly string[];
    readonly unavailableAgentRuntimeIds: readonly string[];
}

export interface DeploymentTargetRuntimeIdentity {
    readonly agentRuntimeId: string;
    readonly runtimeRowId: string;
    readonly versionText: string;
}

export type DeploymentToolObservationState = "ready" | "not_installed" | "unsupported" | "current_observation_failed";

export interface DeploymentToolObservationView {
    readonly key: string;
    readonly adapterId: string;
    readonly platform: DeploymentTargetView["platform"];
    readonly platformInstanceId: string;
    readonly agentRuntimeId: string;
    readonly versionText: string;
    readonly state: DeploymentToolObservationState;
    readonly reasonCodes: readonly string[];
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
    readonly checkedPaths: readonly string[];
    readonly target: DeploymentTargetView | undefined;
}

export interface DeploymentAssetSelection {
    readonly assetId: string;
    readonly versionId: string;
    readonly allowIncomplete: boolean;
}

export type AssetUsageTargetView = { readonly diagnostics?: readonly ProtocolDiagnosticV1[] } & (
    | { readonly targetKey: string; readonly status: "ready"; readonly usage: AssetUsageView }
    | {
          readonly targetKey: string;
          readonly status: "failed";
          readonly failureKind: "permission_denied" | "tool_changed" | "verification_failed" | "interrupted";
      }
);

export interface AssetUsageAnalysisRequest {
    readonly targetKey: string;
    readonly params: ProtocolOperationParams<"asset_usage.analyze">;
}

export type DeploymentWorkspaceSubject =
    | { readonly subjectKind: "global" }
    | { readonly subjectKind: "project"; readonly projectId: string };

export function deploymentAssetsForSubject(
    assets: readonly AssetSummaryView[],
    subject: DeploymentWorkspaceSubject,
): readonly AssetSummaryView[] {
    return Object.freeze(
        assets.filter(
            (asset) =>
                !asset.deleted &&
                (subject.subjectKind === "global"
                    ? asset.scope === "global"
                    : asset.scope === "global" || (asset.scope === "project" && asset.projectId === subject.projectId)),
        ),
    );
}

export function deploymentsForSubject(
    deployments: readonly DeploymentView[],
    subject: DeploymentWorkspaceSubject,
): readonly DeploymentView[] {
    return Object.freeze(
        deployments.filter(
            (deployment) =>
                !deployment.deleted &&
                (subject.subjectKind === "global"
                    ? deployment.subject.subjectKind === "global"
                    : deployment.subject.subjectKind === "project" && deployment.subject.projectId === subject.projectId),
        ),
    );
}

export function deploymentStatusMessage(
    deployment: Pick<DeploymentView, "actionHints" | "freshness" | "stage">,
): DesktopMessageId {
    if (deployment.stage === "conflict") return "catalog.ui.status.external_changes";
    if (deployment.stage === "needs_repair") return "catalog.ui.status.repair_available";
    if (deployment.stage === "blocked") {
        if (deployment.actionHints.includes("recover")) return "catalog.ui.status.paused_for_safety";
        if (deployment.actionHints.includes("contact_support")) return "catalog.ui.status.support_required";
        return "catalog.ui.status.review_required";
    }
    return deployment.freshness.state === "never"
        ? "catalog.ui.status.first_deployment"
        : deployment.actionHints.includes("review_deployment")
          ? "catalog.version_update.pending"
          : deployment.freshness.state === "complete"
            ? "catalog.ui.status.up_to_date"
            : "catalog.ui.status.needs_checking";
}

export function deploymentFreshnessLabel(
    deployment: Pick<DeploymentView, "freshness">,
    resolvedLocale: string,
    text: (id: DesktopMessageId, values?: DesktopMessageValues) => string,
): string {
    const freshness = deployment.freshness;
    if (freshness.state === "never") return text("catalog.ui.freshness.never");
    const formatDate = (value: number): string =>
        new Intl.DateTimeFormat(resolvedLocale, { dateStyle: "medium", timeStyle: "short" }).format(value);
    const attempt = formatDate(freshness.attemptedAt);
    const lastComplete =
        freshness.lastCompleteAt === 0 ? text("catalog.ui.freshness.no_complete") : formatDate(freshness.lastCompleteAt);
    switch (freshness.state) {
        case "in_progress":
            return text("catalog.ui.freshness.in_progress", { attempt, lastComplete });
        case "partial":
            return text("catalog.ui.freshness.partial", { attempt, lastComplete });
        case "failed":
            return text("catalog.ui.freshness.failed", { attempt, lastComplete });
        case "complete":
            return text("catalog.ui.freshness.complete", { time: lastComplete });
    }
}

export interface DeploymentCreateSelection {
    readonly subject: DeploymentWorkspaceSubject;
    readonly targetKey: string;
    readonly consumerAgentRuntimeIds: readonly string[];
    readonly assets: readonly DeploymentAssetSelection[];
}

export interface RenderOptionSelection {
    readonly semanticRefFingerprint: string;
    readonly optionFingerprint: string;
    readonly approved: boolean;
}

export type DeploymentCreateBuildResult =
    | { readonly status: "ready"; readonly params: ProtocolOperationParams<"deployment.create"> }
    | { readonly status: "invalid"; readonly message: DesktopDisplayText };

export type RenderSelectionBuildResult =
    | { readonly status: "ready"; readonly selection: ProtocolOperationParams<"deployment.render_preview">["selection"] }
    | { readonly status: "invalid"; readonly message: DesktopDisplayText };

export type RenderReviewProjection =
    | {
          readonly status: "ready";
          readonly groups: readonly {
              readonly semantic: RenderSemanticView;
              readonly options: readonly {
                  readonly option: RenderOptionView;
                  readonly outputUnits: readonly RenderOutputUnitView[];
              }[];
              readonly blocked: RenderAnalysisView["blockedSemantics"][number] | undefined;
          }[];
      }
    | { readonly status: "invalid"; readonly message: DesktopDisplayText };

export function includeSingletonRenderSelections(
    review: Extract<RenderReviewProjection, { readonly status: "ready" }>,
    selections: readonly RenderOptionSelection[],
): readonly RenderOptionSelection[] {
    const selectedSemanticRefs = new Set(selections.map((selection) => selection.semanticRefFingerprint));
    const implicit = review.groups.flatMap((group) => {
        const onlyOption = group.options.length === 1 ? group.options[0]?.option : undefined;
        if (onlyOption === undefined || selectedSemanticRefs.has(group.semantic.semanticRefFingerprint)) return [];
        return [
            Object.freeze({
                semanticRefFingerprint: group.semantic.semanticRefFingerprint,
                optionFingerprint: onlyOption.optionFingerprint,
                approved: false,
            }),
        ];
    });
    return implicit.length === 0 ? selections : Object.freeze([...selections, ...implicit]);
}

export type CurrentProjectPromotionAuthorization =
    | { readonly status: "not_applicable" }
    | { readonly status: "invalid" }
    | { readonly status: "authorized" }
    | { readonly status: "unavailable" }
    | {
          readonly status: "required";
          readonly assetId: string;
          readonly versionId: string;
          readonly projectId: string;
      };

export function deploymentTargetSemanticKey(
    adapterId: string,
    platform: DeploymentTargetView["platform"],
    platformInstanceId: string,
    targetCandidateId: string,
): string {
    return JSON.stringify([adapterId, platform, platformInstanceId, targetCandidateId]);
}

export function collectDeploymentTargets(probeReview: ProbeReviewView | undefined): readonly DeploymentTargetView[] {
    if (probeReview === undefined) return Object.freeze([]);
    const projected = probeReview.results.flatMap((result) =>
        result.targets.map((target) => {
            const runtimeIdentities = target.entryApplicabilities.flatMap((entry) => {
                const matches = result.runtimes.filter(
                    (runtime) =>
                        runtime.agentRuntimeId === entry.agentRuntimeId &&
                        runtime.installationStatus === "available" &&
                        runtime.versionText.trim() !== "",
                );
                return matches.length === 1
                    ? [
                          Object.freeze({
                              agentRuntimeId: entry.agentRuntimeId,
                              runtimeRowId: (matches[0] as (typeof matches)[number]).rowId,
                              versionText: (matches[0] as (typeof matches)[number]).versionText,
                          }),
                      ]
                    : [];
            });
            const readyAgentRuntimeIds = target.entryApplicabilities
                .filter(
                    (entry) =>
                        entry.status === "ready_for_plan" &&
                        runtimeIdentities.some((runtime) => runtime.agentRuntimeId === entry.agentRuntimeId),
                )
                .map((entry) => entry.agentRuntimeId);
            const unavailableAgentRuntimeIds = target.entryApplicabilities
                .filter((entry) => !readyAgentRuntimeIds.includes(entry.agentRuntimeId))
                .map((entry) => entry.agentRuntimeId);
            return Object.freeze({
                key: deploymentTargetSemanticKey(
                    result.adapterId,
                    result.environment.platform,
                    result.environment.platformInstanceId,
                    target.targetCandidateId,
                ),
                probeToken: probeReview.probeToken,
                probeResultRowId: result.rowId,
                targetRowId: target.rowId,
                targetCandidateId: target.targetCandidateId,
                adapterId: result.adapterId,
                platform: result.environment.platform,
                platformInstanceId: result.environment.platformInstanceId,
                targetKind: target.targetKind,
                displayName: target.displayName,
                displayPath: target.displayPath,
                runtimeIdentities: Object.freeze(runtimeIdentities),
                readyAgentRuntimeIds: Object.freeze(readyAgentRuntimeIds),
                unavailableAgentRuntimeIds: Object.freeze(unavailableAgentRuntimeIds),
            });
        }),
    );
    const keyCounts = new Map<string, number>();
    for (const target of projected) keyCounts.set(target.key, (keyCounts.get(target.key) ?? 0) + 1);
    return Object.freeze(projected.filter((target) => keyCounts.get(target.key) === 1));
}

export function deploymentTargetRuntimeIdentity(
    target: DeploymentTargetView,
    agentRuntimeId: string,
): DeploymentTargetRuntimeIdentity | undefined {
    const matches = target.runtimeIdentities.filter((runtime) => runtime.agentRuntimeId === agentRuntimeId);
    return matches.length === 1 ? matches[0] : undefined;
}

type TargetCapabilityRow = AdapterProviderView["targetCapabilities"][number];

function commonCapabilityDiagnosticCodes(rows: readonly TargetCapabilityRow[]): readonly string[] {
    const first = rows[0];
    if (first === undefined) return Object.freeze([]);
    const codes = first.diagnostics.map((diagnostic) => diagnostic.code).filter((code) => code.trim() !== "");
    return Object.freeze(
        [...new Set(codes.filter((code) => rows.every((row) => row.diagnostics.some((item) => item.code === code))))].sort(),
    );
}

function classifyTargetCapabilityRows(rows: readonly TargetCapabilityRow[]): {
    readonly status: "supported" | "unsupported" | "invalid";
    readonly reasonCodes: readonly string[];
} {
    const supportedRows = rows.filter((row) => row.entrySupportStatus === "supported");
    if (supportedRows.length > 0) {
        return { status: "supported", reasonCodes: commonCapabilityDiagnosticCodes(supportedRows) };
    }
    if (
        rows.length > 0 &&
        rows.every(
            (row) =>
                row.entrySupportStatus === "docs_declared_unverified" ||
                row.entrySupportStatus === "unsupported" ||
                row.entrySupportStatus === "deferred",
        )
    ) {
        return { status: "unsupported", reasonCodes: commonCapabilityDiagnosticCodes(rows) };
    }
    return { status: "invalid", reasonCodes: Object.freeze([]) };
}

export function collectDeploymentToolObservations(
    probeReview: ProbeReviewView | undefined,
    providers: readonly AdapterProviderView[],
    assetKind: AssetSummaryView["kind"] | undefined,
    targets: readonly DeploymentTargetView[],
): readonly DeploymentToolObservationView[] {
    if (probeReview === undefined || assetKind === undefined) return Object.freeze([]);
    const observations: DeploymentToolObservationView[] = [];
    for (const result of probeReview.results) {
        const provider = providers.find((candidate) => candidate.adapterId === result.adapterId);
        if (provider === undefined) continue;
        const capabilityGroups = new Map<string, typeof provider.targetCapabilities>();
        for (const capability of provider.targetCapabilities.filter((candidate) => candidate.assetKind === assetKind)) {
            capabilityGroups.set(capability.agentRuntimeId, [
                ...(capabilityGroups.get(capability.agentRuntimeId) ?? []),
                capability,
            ]);
        }
        const agentRuntimeIds = [...capabilityGroups.keys()].sort();
        for (const agentRuntimeId of agentRuntimeIds) {
            const capabilityRows = capabilityGroups.get(agentRuntimeId) ?? [];
            const capability = classifyTargetCapabilityRows(capabilityRows);
            const runtimeRows = result.runtimes.filter((runtime) => runtime.agentRuntimeId === agentRuntimeId);
            const candidateTargets = targets.filter(
                (target) =>
                    target.adapterId === result.adapterId &&
                    target.platform === result.environment.platform &&
                    target.platformInstanceId === result.environment.platformInstanceId &&
                    [...target.readyAgentRuntimeIds, ...target.unavailableAgentRuntimeIds].includes(agentRuntimeId),
            );
            const runtime = runtimeRows.length === 1 ? runtimeRows[0] : undefined;
            for (const target of candidateTargets.length === 0 ? [undefined] : candidateTargets) {
                const protocolCandidateRows =
                    target === undefined
                        ? []
                        : result.targets.filter((candidate) => candidate.targetCandidateId === target.targetCandidateId);
                const protocolCandidate = protocolCandidateRows.length === 1 ? protocolCandidateRows[0] : undefined;
                const applicabilityRows =
                    protocolCandidate?.entryApplicabilities.filter((entry) => entry.agentRuntimeId === agentRuntimeId) ?? [];
                const applicability = applicabilityRows.length === 1 ? applicabilityRows[0] : undefined;
                let state: DeploymentToolObservationState;
                if (capability.status === "invalid") {
                    state = "current_observation_failed";
                } else if (capability.status === "unsupported") {
                    state = "unsupported";
                } else if (runtimeRows.length === 1 && runtime?.installationStatus === "not_found") {
                    state = "not_installed";
                } else if (runtimeRows.length === 1 && runtime?.installationStatus === "version_incompatible") {
                    state = "unsupported";
                } else if (
                    runtimeRows.length === 1 &&
                    runtime?.installationStatus === "available" &&
                    runtime.versionText.trim() !== "" &&
                    target?.readyAgentRuntimeIds.includes(agentRuntimeId) === true &&
                    applicability?.status === "ready_for_plan"
                ) {
                    state = "ready";
                } else {
                    state = "current_observation_failed";
                }
                const capabilityReasonCodes = new Set(capability.reasonCodes);
                const diagnostics = uniqueProtocolDiagnostics([
                    ...capabilityRows.flatMap((row) =>
                        row.diagnostics.filter((diagnostic) => capabilityReasonCodes.has(diagnostic.code)),
                    ),
                    ...runtimeRows.flatMap((row) => row.diagnostics),
                    ...(protocolCandidate?.diagnostics ?? []),
                    ...(applicability?.diagnostics ?? []),
                ]);
                const reasonCodes = [...capability.reasonCodes, ...diagnostics.map((diagnostic) => diagnostic.code)].filter(
                    (code) => code.trim() !== "",
                );
                const checkedPaths = diagnostics
                    .flatMap((diagnostic) => (diagnostic.path === undefined ? [] : [diagnostic.path]))
                    .filter((path, index, paths) => path.trim() !== "" && paths.indexOf(path) === index);
                const fallbackReason = `catalog.target.${state}`;
                observations.push(
                    Object.freeze({
                        key: JSON.stringify([
                            result.adapterId,
                            result.environment.platform,
                            result.environment.platformInstanceId,
                            agentRuntimeId,
                            target?.targetCandidateId ?? null,
                        ]),
                        adapterId: result.adapterId,
                        platform: result.environment.platform,
                        platformInstanceId: result.environment.platformInstanceId,
                        agentRuntimeId,
                        versionText: runtimeRows.length === 1 ? (runtime?.versionText ?? "") : "",
                        state,
                        reasonCodes: Object.freeze(
                            [...new Set(reasonCodes.length === 0 ? [fallbackReason] : reasonCodes)].sort(),
                        ),
                        diagnostics,
                        checkedPaths: Object.freeze(checkedPaths.sort()),
                        target,
                    }),
                );
            }
        }
    }
    return Object.freeze(observations.sort((left, right) => left.key.localeCompare(right.key)));
}

export function currentProjectPromotionAuthorization(input: {
    readonly subject: DeploymentWorkspaceSubject;
    readonly target: DeploymentTargetView | undefined;
    readonly deployment: DeploymentView | undefined;
    readonly asset: AssetSummaryView | undefined;
    readonly analysis: RenderAnalysisView | undefined;
}): CurrentProjectPromotionAuthorization {
    const { subject, target, deployment, asset, analysis } = input;
    if (subject.subjectKind !== "project" || target === undefined || deployment === undefined || asset === undefined) {
        return { status: "not_applicable" };
    }
    const runtimeId = deployment.consumerAgentRuntimeIds[0];
    if (
        deployment.subject.subjectKind !== "project" ||
        deployment.subject.projectId !== subject.projectId ||
        deployment.consumerAgentRuntimeIds.length !== 1 ||
        runtimeId === undefined ||
        target.targetKind !== "project" ||
        target.platform !== deployment.environment.platform ||
        target.platformInstanceId !== deployment.environment.platformInstanceId ||
        !sameProjectedTargetRoot(target, deployment.targetRootPath) ||
        deploymentTargetRuntimeIdentity(target, runtimeId) === undefined ||
        asset.scope !== "project" ||
        asset.projectId !== subject.projectId ||
        deployment.assets.length !== 1 ||
        deployment.assets[0]?.assetId !== asset.assetId
    ) {
        return { status: "invalid" };
    }
    if (deployment.assets[0]?.versionId !== asset.currentVersionId) return { status: "not_applicable" };
    if (analysis === undefined || analysis.deploymentId !== deployment.deploymentId) return { status: "not_applicable" };
    const inspections = analysis.promotionAuthorizationInspections.filter(
        (inspection) =>
            inspection.assetId === asset.assetId &&
            inspection.versionId === asset.currentVersionId &&
            inspection.target.targetKind === "project" &&
            inspection.target.projectId === subject.projectId,
    );
    if (analysis.promotionAuthorizationInspections.length !== 1 || inspections.length !== 1) {
        return { status: "invalid" };
    }
    const inspection = inspections[0] as RenderAnalysisView["promotionAuthorizationInspections"][number];
    if (inspection.promotionAuthorizationState === "not_required") return { status: "not_applicable" };
    if (inspection.promotionAuthorizationState === "authorized") return { status: "authorized" };
    if (inspection.promotionAuthorizationState === "unavailable") return { status: "unavailable" };
    return {
        status: "required",
        assetId: asset.assetId,
        versionId: asset.currentVersionId,
        projectId: subject.projectId,
    };
}

export function deploymentTargetMatchesSubject(
    target: DeploymentTargetView,
    subject: DeploymentWorkspaceSubject,
    projects: readonly ProjectView[],
): boolean {
    if (subject.subjectKind === "global") return target.targetKind === "global";
    if (target.targetKind !== "project") return false;
    const project = projects.find((candidate) => candidate.projectId === subject.projectId && !candidate.deleted);
    return project !== undefined && sameProjectedTargetRoot(target, project.rootPath);
}

export function deploymentTargetForDeployment(
    targets: readonly DeploymentTargetView[],
    deployment: DeploymentView,
): DeploymentTargetView | undefined {
    const matches = targets.filter(
        (target) =>
            target.platform === deployment.environment.platform &&
            target.platformInstanceId === deployment.environment.platformInstanceId &&
            sameProjectedTargetRoot(target, deployment.targetRootPath) &&
            deployment.consumerAgentRuntimeIds.every(
                (agentRuntimeId) => deploymentTargetRuntimeIdentity(target, agentRuntimeId) !== undefined,
            ),
    );
    return matches.length === 1 ? matches[0] : undefined;
}

function sameProjectedTargetRoot(target: DeploymentTargetView, projectRootPath: string): boolean {
    if (target.platform === "wsl") {
        const targetRuntimePath = comparableWslRuntimePath(target.displayPath, target.platformInstanceId);
        const projectRuntimePath = comparableWslRuntimePath(projectRootPath, target.platformInstanceId);
        return targetRuntimePath !== null && projectRuntimePath !== null && targetRuntimePath === projectRuntimePath;
    }
    if (target.platform === "win32") {
        if (!isWindowsHostPath(target.displayPath) || !isWindowsHostPath(projectRootPath)) return false;
        return (
            target.displayPath
                .replaceAll("/", "\\")
                .localeCompare(projectRootPath.replaceAll("/", "\\"), "en", { sensitivity: "accent" }) === 0
        );
    }
    return isCanonicalPosixPath(target.displayPath) && target.displayPath === projectRootPath;
}

function comparableWslRuntimePath(value: string, platformInstanceId: string): string | null {
    if (isCanonicalPosixPath(value)) return value;
    const match = /^\\\\wsl\.localhost\\([^\\]+)\\?(.*)$/iu.exec(value);
    if (
        match?.[1] === undefined ||
        match[2] === undefined ||
        match[1].localeCompare(platformInstanceId, "en", { sensitivity: "accent" }) !== 0
    ) {
        return null;
    }
    const relative = match[2];
    if (relative === "") return "/";
    const segments = relative.split("\\");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
    return `/${segments.join("/")}`;
}

function isCanonicalPosixPath(value: string): boolean {
    return (
        value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("//") &&
        !value.split("/").some((segment, index) => index > 0 && (segment === "." || segment === ".."))
    );
}

function isWindowsHostPath(value: string): boolean {
    return /^[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value);
}

export function buildDeploymentCreateRequest(
    selection: DeploymentCreateSelection,
    targets: readonly DeploymentTargetView[],
    projects: readonly ProjectView[],
    assets: readonly AssetSummaryView[],
): DeploymentCreateBuildResult {
    const subject = selection.subject;
    if (
        subject.subjectKind === "project" &&
        !projects.some((candidate) => candidate.projectId === subject.projectId && !candidate.deleted)
    ) {
        return { status: "invalid", message: localizedText("catalog.validation.choose_project") };
    }
    const target = targets.find((candidate) => candidate.key === selection.targetKey);
    if (target === undefined) return { status: "invalid", message: localizedText("catalog.validation.choose_target") };
    if (!deploymentTargetMatchesSubject(target, subject, projects)) {
        return { status: "invalid", message: localizedText("catalog.validation.choose_target") };
    }
    const selectedRuntimeIds = [...new Set(selection.consumerAgentRuntimeIds)];
    if (
        selectedRuntimeIds.length === 0 ||
        selectedRuntimeIds.some((agentRuntimeId) => !target.readyAgentRuntimeIds.includes(agentRuntimeId))
    ) {
        return { status: "invalid", message: localizedText("catalog.validation.choose_runtime") };
    }
    const selectedAssetIds = new Set<string>();
    const deploymentAssets: ProtocolOperationParams<"deployment.create">["assets"][number][] = [];
    for (const selected of selection.assets) {
        if (selectedAssetIds.has(selected.assetId)) {
            return { status: "invalid", message: localizedText("catalog.validation.asset_duplicate") };
        }
        selectedAssetIds.add(selected.assetId);
        const asset = assets.find((candidate) => candidate.assetId === selected.assetId && !candidate.deleted);
        if (asset === undefined) {
            return { status: "invalid", message: localizedText("catalog.validation.asset_missing") };
        }
        if (asset.currentVersionId !== selected.versionId) {
            return {
                status: "invalid",
                message: localizedText("catalog.validation.asset_version_changed", { asset: asset.displayName }),
            };
        }
        if (
            subject.subjectKind === "global"
                ? asset.scope !== "global"
                : asset.scope !== "global" && asset.projectId !== subject.projectId
        ) {
            return { status: "invalid", message: localizedText("catalog.validation.asset_missing") };
        }
        if (asset.currentVersionStatus === "incomplete" && !selected.allowIncomplete) {
            return {
                status: "invalid",
                message: localizedText("catalog.validation.asset_incomplete", { asset: asset.displayName }),
            };
        }
        deploymentAssets.push({
            assetId: asset.assetId,
            versionId: selected.versionId,
            allowIncomplete: selected.allowIncomplete,
        });
    }
    const firstAsset = deploymentAssets[0];
    const firstRuntime = selectedRuntimeIds[0];
    if (firstAsset === undefined) {
        return { status: "invalid", message: localizedText("catalog.validation.choose_asset") };
    }
    if (firstRuntime === undefined) {
        return { status: "invalid", message: localizedText("catalog.validation.choose_runtime") };
    }
    return {
        status: "ready",
        params: {
            probeToken: target.probeToken,
            probeResultRowId: target.probeResultRowId,
            targetRowId: target.targetRowId,
            subject,
            consumerAgentRuntimeIds: [firstRuntime, ...selectedRuntimeIds.slice(1)],
            assets: [firstAsset, ...deploymentAssets.slice(1)],
        },
    };
}

export function buildAssetUsageAnalysisRequests(
    subject: DeploymentWorkspaceSubject,
    targets: readonly DeploymentTargetView[],
    asset: DeploymentAssetSelection | undefined,
): readonly AssetUsageAnalysisRequest[] {
    if (asset === undefined) return Object.freeze([]);
    return Object.freeze(
        targets
            .filter((target) => target.targetKind === subject.subjectKind && target.readyAgentRuntimeIds.length > 0)
            .map((target): AssetUsageAnalysisRequest => {
                const firstAgentRuntimeId = target.readyAgentRuntimeIds[0];
                if (firstAgentRuntimeId === undefined) {
                    throw new Error("asset usage target lost its ready runtime identity");
                }
                return {
                    targetKey: target.key,
                    params: {
                        probeToken: target.probeToken,
                        probeResultRowId: target.probeResultRowId,
                        targetRowId: target.targetRowId,
                        subject,
                        consumerAgentRuntimeIds: [firstAgentRuntimeId, ...target.readyAgentRuntimeIds.slice(1)],
                        asset: { ...asset },
                    },
                };
            }),
    );
}

export function projectRenderReview(analysis: RenderAnalysisView): RenderReviewProjection {
    const semantics = new Map<string, RenderSemanticView>();
    for (const semantic of analysis.semantics) {
        if (semantics.has(semantic.semanticRefFingerprint)) {
            return { status: "invalid", message: localizedText("catalog.validation.render_incomplete") };
        }
        semantics.set(semantic.semanticRefFingerprint, semantic);
    }
    const outputUnits = new Map<string, RenderOutputUnitView>();
    for (const unit of analysis.outputUnits) {
        if (outputUnits.has(unit.outputUnitFingerprint)) {
            return { status: "invalid", message: localizedText("catalog.validation.render_incomplete") };
        }
        outputUnits.set(unit.outputUnitFingerprint, unit);
    }
    const options = new Map<string, Array<{ readonly option: RenderOptionView; readonly outputUnits: RenderOutputUnitView[] }>>();
    const optionFingerprints = new Set<string>();
    for (const option of analysis.options) {
        if (!semantics.has(option.semanticRefFingerprint) || optionFingerprints.has(option.optionFingerprint)) {
            return { status: "invalid", message: localizedText("catalog.validation.render_incomplete") };
        }
        optionFingerprints.add(option.optionFingerprint);
        const seenUnits = new Set<string>();
        const resolvedUnits: RenderOutputUnitView[] = [];
        for (const fingerprint of option.requiredOutputUnitFingerprints) {
            const unit = outputUnits.get(fingerprint);
            if (unit === undefined || seenUnits.has(fingerprint)) {
                return { status: "invalid", message: localizedText("catalog.validation.render_incomplete") };
            }
            seenUnits.add(fingerprint);
            resolvedUnits.push(unit);
        }
        const group = options.get(option.semanticRefFingerprint);
        const projected = { option, outputUnits: resolvedUnits };
        if (group === undefined) options.set(option.semanticRefFingerprint, [projected]);
        else group.push(projected);
    }
    const blocked = new Map<string, RenderAnalysisView["blockedSemantics"][number]>();
    for (const item of analysis.blockedSemantics) {
        if (!semantics.has(item.semanticRefFingerprint) || blocked.has(item.semanticRefFingerprint)) {
            return { status: "invalid", message: localizedText("catalog.validation.render_incomplete") };
        }
        blocked.set(item.semanticRefFingerprint, item);
    }
    const groups = analysis.semantics.map((semantic) => {
        const semanticOptions = options.get(semantic.semanticRefFingerprint) ?? [];
        const blockedSemantic = blocked.get(semantic.semanticRefFingerprint);
        if ((semanticOptions.length === 0) === (blockedSemantic === undefined)) return null;
        return Object.freeze({
            semantic,
            options: Object.freeze(semanticOptions.map((option) => Object.freeze(option))),
            blocked: blockedSemantic,
        });
    });
    if (groups.some((group) => group === null)) {
        return { status: "invalid", message: localizedText("catalog.validation.render_incomplete") };
    }
    return {
        status: "ready",
        groups: Object.freeze(groups as Exclude<(typeof groups)[number], null>[]),
    };
}

export function buildRenderSelection(
    analysis: RenderAnalysisView,
    selections: readonly RenderOptionSelection[],
    userActionId: string,
): RenderSelectionBuildResult {
    const review = projectRenderReview(analysis);
    if (review.status === "invalid") return review;
    if (analysis.options.length === 0) {
        return { status: "invalid", message: localizedText("catalog.validation.render_none") };
    }
    const groups = review.groups.map((group) => group.options.map((option) => option.option));
    const selectedBySemanticRef = new Map(selections.map((selection) => [selection.semanticRefFingerprint, selection]));
    if (selectedBySemanticRef.size !== selections.length) {
        return { status: "invalid", message: localizedText("catalog.validation.render_duplicate") };
    }
    if (selectedBySemanticRef.size !== groups.filter((group) => group.length > 0).length) {
        return { status: "invalid", message: localizedText("catalog.validation.render_missing") };
    }
    const semanticOptions: ProtocolOperationParams<"deployment.render_preview">["selection"]["semanticOptions"][number][] = [];
    for (const group of groups) {
        const semanticRefFingerprint = group[0]?.semanticRefFingerprint;
        if (semanticRefFingerprint === undefined) continue;
        const selected = selectedBySemanticRef.get(semanticRefFingerprint);
        const option = group.find((candidate) => candidate.optionFingerprint === selected?.optionFingerprint);
        if (selected === undefined || option === undefined) {
            return { status: "invalid", message: localizedText("catalog.validation.render_missing") };
        }
        if (option.approvalState === "required" && !selected.approved) {
            return {
                status: "invalid",
                message: localizedText("catalog.validation.render_approval", { strategy: option.renderStrategy }),
            };
        }
        if (option.approvalState === "required" && userActionId.trim() === "") {
            return { status: "invalid", message: localizedText("catalog.validation.render_approval_evidence") };
        }
        semanticOptions.push({
            optionFingerprint: option.optionFingerprint,
            approval: option.approvalState === "required" ? { action: "approve_once", userActionId } : { action: "none" },
        });
    }
    return {
        status: "ready",
        selection: {
            schemaVersion: 1,
            renderInputFingerprint: analysis.renderInputFingerprint,
            semanticOptions,
        },
    };
}
