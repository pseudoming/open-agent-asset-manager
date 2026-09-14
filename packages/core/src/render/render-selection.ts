import type { VersionDialectRegistryV1 } from "../catalog/version-authority";
import type { RenderOutputUnit, RequiredRenderSemantic, SelectedOutputUnitRenderer } from "../contracts/deployment-authority";
import type { EpochMillis, Sha256Digest } from "../contracts/primitives";
import type {
    ConfirmOneTimeRenderApprovalInput,
    MaterializationSafeRenderSelection,
    RenderAnalysisResult,
    RenderAnalysisView,
    RenderDeploymentInput,
    RenderSelectionRequest,
    RequestedSemanticOption,
    ResolvedCoreRenderSelection,
    ResolvedSelectedSemanticOption,
    SemanticRenderOption,
} from "../contracts/render";
import { type AuthorityLockLeaseProof, assertAuthorityLockLease } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";
import { computeRenderObservationSelectionFingerprint, computeRenderSelectionFingerprint } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import type { AdapterProviderSummary, CoreResult } from "../types";
import { validateAnalysisView, validateRenderDeploymentInput } from "./render-analysis";
import type { RenderConformanceRequirement, RenderRegistrySnapshot } from "./render-registry";
import {
    acquireRenderSelectionAssetLocks,
    acquireRenderSelectionSettingsLock,
    failedRenderSelectionResult,
    RenderSelectionFailure,
    requireRenderSelectionUserText,
    validatePhysicalOutputClosure,
} from "./render-selection-guards";
import { chooseObservationMatch } from "./render-observation-option-ranking";
import { resolvePromotionAuthorizations, type StagedRenderSelectionAuthority } from "./render-promotion-authorization";

export interface SavedRenderPolicyResolution {
    policyId: string;
    policyRevision: number;
    approvalFingerprint: Sha256Digest;
    resolvedAt: EpochMillis;
}

export interface ResolveSavedRenderPolicyInput {
    policyId: string;
    approvalFingerprint: Sha256Digest;
    deployment: RenderDeploymentInput;
    semantic: RequiredRenderSemantic;
    option: SemanticRenderOption;
}

export interface RenderSelectionConfiguration {
    assetsRoot: string;
    oaamRoot: string;
    authorityLocksRoot: string;
    dialectRegistry: VersionDialectRegistryV1;
    registry: RenderRegistrySnapshot;
    confirmOneTimeApproval(input: ConfirmOneTimeRenderApprovalInput): EpochMillis | null;
    resolveSavedPolicy(input: ResolveSavedRenderPolicyInput): SavedRenderPolicyResolution | null;
    now?: () => EpochMillis;
}

export interface ResolveRenderSelectionInput {
    deployment: RenderDeploymentInput;
    analysis: RenderAnalysisView;
    request: RenderSelectionRequest;
}

export interface AssetUsageObservationSelection {
    readonly selectionFingerprint: Sha256Digest;
    readonly selection: MaterializationSafeRenderSelection;
}

/**
 * Resolve one deterministic Provider-backed selection for fresh target observation.
 * This is deliberately approval- and promotion-free: it can only feed the
 * read-only materializer and is not accepted by compile/deploy.
 */
export function resolveAssetUsageObservationSelection(
    sourceInput: Pick<ResolveRenderSelectionInput, "deployment" | "analysis">,
    registry: RenderRegistrySnapshot,
    consumerAgentRuntimeIds: readonly string[],
): CoreResult<AssetUsageObservationSelection> {
    try {
        const input = structuredClone(sourceInput);
        validateRenderDeploymentInput(input.deployment, registry);
        validateAnalysisView(input.analysis, input.deployment, registry);
        const selectedConsumers = new Set(consumerAgentRuntimeIds);
        const semantics = input.analysis.requiredSemantics.filter((semantic) =>
            selectedConsumers.has(semantic.consumerAgentRuntimeId),
        );
        if (semantics.length === 0) {
            throw new RenderSelectionFailure(
                "asset_usage.observation_semantics_missing",
                "fresh target observation has no selected consumer semantics",
                "unsupported",
            );
        }
        // validateAnalysisView has already proved one current analysis for each
        // required Provider owner. Index that authority once instead of
        // re-testing the same adapter/version invariant inside every semantic.
        const analysesByAdapterId = new Map(input.analysis.analyses.map((analysis) => [analysis.adapterId, analysis]));
        const selected: SelectedOptionRecord[] = semantics.map((semantic) => {
            // validateAnalysisView has already proved an exact owner for every required semantic.
            const owner = registry.getOwner(semantic.consumerAgentRuntimeId) as AdapterProviderSummary;
            const analysis = analysesByAdapterId.get(owner.adapterId) as RenderAnalysisResult;
            const matches = analysis.semanticOptions
                .filter((option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint)
                .map((option) => ({ analysis, option }));
            const match = chooseObservationMatch(matches);
            if (match === null) {
                throw new RenderSelectionFailure(
                    "asset_usage.observation_option_unavailable",
                    "fresh target observation has no deterministic exact Provider option",
                    "unsupported",
                );
            }
            return {
                semantic,
                analysis: match.analysis,
                option: match.option,
                request: {
                    optionFingerprint: match.option.optionFingerprint,
                    approvalRequest: { approvalAction: "none" },
                },
            };
        });
        const outputUnits = resolveSelectedOutputUnits(selected, input.analysis.analyses);
        const outputUnitRenderers = resolveOutputUnitRenderers(selected, outputUnits, input.deployment, registry);
        const semanticOptions = selected
            .map(({ option }) => {
                const base = {
                    optionFingerprint: option.optionFingerprint,
                    semanticRefFingerprint: option.semanticRefFingerprint,
                    renderStrategy: option.renderStrategy,
                    actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                    requiredOutputUnitFingerprints: [...option.requiredOutputUnitFingerprints],
                };
                return option.outcome === "preserved"
                    ? ({ ...base, outcome: "preserved" } as const)
                    : ({ ...base, outcome: "degraded", degradationFingerprint: option.degradationFingerprint } as const);
            })
            .sort((left, right) => compareUtf8Bytes(left.semanticRefFingerprint, right.semanticRefFingerprint));
        const selection: MaterializationSafeRenderSelection = {
            schemaVersion: 1,
            semanticOptions,
            outputUnits,
            outputUnitRenderers,
        };
        return completeResult({
            selection,
            selectionFingerprint: computeRenderObservationSelectionFingerprint({
                renderInputFingerprint: input.deployment.renderInputFingerprint,
                selection,
            }),
        });
    } catch (error) {
        return failedRenderSelectionResult(error);
    }
}

/** CoreService has no client approval authority port until the client workflow is assembled. */
export function denyUnverifiedOneTimeRenderApproval(): null {
    return null;
}

/** CoreService has no saved-policy authority port until durable client settings are assembled. */
export function resolveNoSavedRenderPolicy(): null {
    return null;
}

export interface RenderSelectionAuthorityLeases {
    assetAuthorityLeaseProof: AuthorityLockLeaseProof;
    settingsAuthorityLeaseProof: AuthorityLockLeaseProof;
}

export function resolveCoreRenderSelection(
    sourceInput: ResolveRenderSelectionInput,
    configuration: RenderSelectionConfiguration,
): CoreResult<ResolvedCoreRenderSelection> {
    return resolveCoreRenderSelectionCore(sourceInput, configuration, null, null);
}

/**
 * Internal Stage-R entry for a caller that must hold Asset and settings
 * authorities across selection, filesystem publication, and the final DB
 * commit. Runtime-validated leases prevent a boolean "already locked" bypass.
 */
export function resolveCoreRenderSelectionWithAuthorityLeases(
    sourceInput: ResolveRenderSelectionInput,
    configuration: RenderSelectionConfiguration,
    leases: RenderSelectionAuthorityLeases,
): CoreResult<ResolvedCoreRenderSelection> {
    return resolveCoreRenderSelectionCore(sourceInput, configuration, leases, null);
}

/** Stage-R selection for one final-but-unpublished Version under live authority leases. */
export function resolveCoreRenderSelectionForStagedVersion(
    sourceInput: ResolveRenderSelectionInput,
    configuration: RenderSelectionConfiguration,
    leases: RenderSelectionAuthorityLeases,
    staged: StagedRenderSelectionAuthority,
): CoreResult<ResolvedCoreRenderSelection> {
    return resolveCoreRenderSelectionCore(sourceInput, configuration, leases, staged);
}

function resolveCoreRenderSelectionCore(
    sourceInput: ResolveRenderSelectionInput,
    configuration: RenderSelectionConfiguration,
    leases: RenderSelectionAuthorityLeases | null,
    staged: StagedRenderSelectionAuthority | null,
): CoreResult<ResolvedCoreRenderSelection> {
    try {
        const input = structuredClone(sourceInput);
        configuration = Object.freeze({ ...configuration });
        validateRenderDeploymentInput(input.deployment, configuration.registry);
        validateAnalysisView(input.analysis, input.deployment, configuration.registry);
        if (
            input.request.schemaVersion !== 1 ||
            input.request.renderInputFingerprint !== input.deployment.renderInputFingerprint
        ) {
            throw new RenderSelectionFailure(
                "render.selection_request_stale",
                "render selection request belongs to another analysis input",
                "conflict",
                true,
            );
        }
        const selected = resolveRequestedOptions(input, configuration.registry);
        const outputUnits = resolveSelectedOutputUnits(selected, input.analysis.analyses);
        const outputUnitRenderers = resolveOutputUnitRenderers(selected, outputUnits, input.deployment, configuration.registry);
        const assetIds = input.deployment.assets.map((item) => item.version.ref.assetId).sort(compareUtf8Bytes);
        const releaseAssets =
            leases === null
                ? acquireRenderSelectionAssetLocks(configuration.authorityLocksRoot, assetIds)
                : (() => {
                      assertAuthorityLockLease(
                          leases.assetAuthorityLeaseProof,
                          configuration.authorityLocksRoot,
                          "assets",
                          assetIds,
                      );
                      return () => undefined;
                  })();
        try {
            const releaseSettings =
                leases === null
                    ? acquireRenderSelectionSettingsLock(configuration.authorityLocksRoot)
                    : (() => {
                          assertAuthorityLockLease(
                              leases.settingsAuthorityLeaseProof,
                              configuration.authorityLocksRoot,
                              "settings",
                              ["settings"],
                          );
                          return () => undefined;
                      })();
            try {
                const resolvedOptions = selected.map((item) =>
                    resolveOptionApproval(
                        input.deployment,
                        item.semantic,
                        item.analysis,
                        item.option,
                        item.request,
                        configuration,
                    ),
                );
                const promotionAuthorizations = resolvePromotionAuthorizations(input.deployment, configuration, staged);
                const selectionPreimage = {
                    compilerPolicyVersion: "core_render_policy_v1" as const,
                    renderInputFingerprint: input.deployment.renderInputFingerprint,
                    semanticOptions: resolvedOptions.sort((left, right) =>
                        compareUtf8Bytes(left.semanticRefFingerprint, right.semanticRefFingerprint),
                    ),
                    outputUnits,
                    outputUnitRenderers,
                    promotionAuthorizations,
                };
                return completeResult({
                    schemaVersion: 1,
                    ...selectionPreimage,
                    selectionFingerprint: computeRenderSelectionFingerprint(selectionPreimage),
                });
            } finally {
                releaseSettings();
            }
        } finally {
            releaseAssets();
        }
    } catch (error) {
        return failedRenderSelectionResult(error);
    }
}

/**
 * Return one safe default only where the approved partial order is decisive.
 * native_file/native_directory/native_graph deliberately remain incomparable; a caller must
 * ask the user instead of inventing a universal rank.
 */
export function recommendDefaultRenderOption(options: readonly SemanticRenderOption[]): SemanticRenderOption | null {
    const safe = options.filter((option) => option.approvalRequirement.approvalState === "not_required");
    if (safe.length === 1) return safe[0] as SemanticRenderOption;
    if (safe.length === 0) return null;
    const rank = new Map([
        ["native_import", 0],
        ["inline", 1],
        ["reference_with_intro", 2],
    ]);
    if (safe.some((option) => !rank.has(option.renderStrategy))) return null;
    return [...safe].sort((left, right) => {
        const rankDifference = (rank.get(left.renderStrategy) as number) - (rank.get(right.renderStrategy) as number);
        return rankDifference === 0 ? compareUtf8Bytes(left.optionFingerprint, right.optionFingerprint) : rankDifference;
    })[0] as SemanticRenderOption;
}

interface SelectedOptionRecord {
    semantic: RequiredRenderSemantic;
    analysis: RenderAnalysisResult;
    option: SemanticRenderOption;
    request: RequestedSemanticOption;
}

function resolveRequestedOptions(input: ResolveRenderSelectionInput, registry: RenderRegistrySnapshot): SelectedOptionRecord[] {
    const requests = new Map<string, RequestedSemanticOption>();
    for (const request of input.request.semanticOptions) {
        if (requests.has(request.optionFingerprint)) {
            throw new RenderSelectionFailure(
                "render.selection_option_duplicate",
                "selection request repeats an option fingerprint",
            );
        }
        requests.set(request.optionFingerprint, request);
    }
    if (requests.size !== input.analysis.requiredSemantics.length) {
        throw new RenderSelectionFailure(
            "render.selection_cardinality",
            "selection request must choose exactly one option per semantic",
        );
    }
    const records: SelectedOptionRecord[] = [];
    const chosenSemantics = new Set<string>();
    for (const [optionFingerprint, request] of requests) {
        const matches = input.analysis.analyses.flatMap((analysis) =>
            analysis.semanticOptions
                .filter((option) => option.optionFingerprint === optionFingerprint)
                .map((option) => ({ analysis, option })),
        );
        if (matches.length !== 1) {
            throw new RenderSelectionFailure(
                "render.selection_option_unknown",
                "selected option must resolve exactly once in the fresh analysis",
            );
        }
        const match = matches[0] as {
            analysis: RenderAnalysisResult;
            option: SemanticRenderOption;
        };
        const semantic = input.analysis.requiredSemantics.find(
            (item) => item.semanticRefFingerprint === match.option.semanticRefFingerprint,
        );
        if (semantic === undefined || chosenSemantics.has(semantic.semanticRefFingerprint)) {
            throw new RenderSelectionFailure(
                "render.selection_semantic_duplicate",
                "selection repeats or cannot resolve a required semantic",
            );
        }
        const owner = registry.getOwner(semantic.consumerAgentRuntimeId);
        if (owner === null || owner.adapterId !== match.analysis.adapterId || owner.version !== match.analysis.adapterVersion) {
            throw new RenderSelectionFailure(
                "render.selection_owner_mismatch",
                "selected option does not come from the current consumer owner",
            );
        }
        chosenSemantics.add(semantic.semanticRefFingerprint);
        records.push({
            semantic,
            analysis: match.analysis,
            option: match.option,
            request,
        });
    }
    return records;
}

function resolveOptionApproval(
    deployment: RenderDeploymentInput,
    semantic: RequiredRenderSemantic,
    analysis: RenderAnalysisResult,
    option: SemanticRenderOption,
    request: RequestedSemanticOption,
    configuration: RenderSelectionConfiguration,
): ResolvedSelectedSemanticOption {
    let approval: ResolvedSelectedSemanticOption["approval"];
    if (option.approvalRequirement.approvalState === "not_required") {
        if (request.approvalRequest.approvalAction !== "none") {
            throw new RenderSelectionFailure("render.approval_unexpected", "safe option cannot carry a user approval request");
        }
        approval = { approvalState: "not_required" };
    } else if (request.approvalRequest.approvalAction === "approve_once") {
        requireRenderSelectionUserText(request.approvalRequest.userActionId, "userActionId");
        const resolvedAt = configuration.confirmOneTimeApproval(
            structuredClone({
                userActionId: request.approvalRequest.userActionId,
                approvalFingerprint: option.approvalRequirement.approvalFingerprint,
                deployment,
                semantic,
                option,
            }),
        );
        if (resolvedAt === null) {
            throw new RenderSelectionFailure(
                "render.one_time_approval_unverified",
                "one-time user action does not authorize the exact current approval fingerprint",
                "conflict",
            );
        }
        requireApprovalResolutionTime(resolvedAt);
        approval = {
            approvalState: "approved",
            approvalSource: "one_time_user_approval",
            userActionEvidenceId: request.approvalRequest.userActionId,
            resolvedAt,
            approvalFingerprint: option.approvalRequirement.approvalFingerprint,
        };
    } else if (request.approvalRequest.approvalAction === "use_saved_policy") {
        requireRenderSelectionUserText(request.approvalRequest.policyId, "policyId");
        const resolution = structuredClone(
            configuration.resolveSavedPolicy(
                structuredClone({
                    policyId: request.approvalRequest.policyId,
                    approvalFingerprint: option.approvalRequirement.approvalFingerprint,
                    deployment,
                    semantic,
                    option,
                }),
            ),
        );
        if (
            resolution === null ||
            resolution.policyId !== request.approvalRequest.policyId ||
            resolution.approvalFingerprint !== option.approvalRequirement.approvalFingerprint ||
            !Number.isInteger(resolution.policyRevision) ||
            resolution.policyRevision < 1 ||
            !Number.isSafeInteger(resolution.resolvedAt) ||
            resolution.resolvedAt < 0
        ) {
            throw new RenderSelectionFailure(
                "render.saved_policy_stale",
                "saved policy does not authorize the exact current approval fingerprint",
                "conflict",
                true,
            );
        }
        approval = {
            approvalState: "approved",
            approvalSource: "saved_user_policy",
            policyId: resolution.policyId,
            policyRevision: resolution.policyRevision,
            resolvedAt: resolution.resolvedAt,
            approvalFingerprint: resolution.approvalFingerprint,
        };
    } else {
        throw new RenderSelectionFailure(
            "render.approval_required",
            "selected render degradation requires exact user approval",
            "conflict",
        );
    }
    const base = {
        consumerOwnerAdapterId: analysis.adapterId,
        consumerOwnerAdapterVersion: analysis.adapterVersion,
        optionFingerprint: option.optionFingerprint,
        semanticRefFingerprint: option.semanticRefFingerprint,
        renderStrategy: option.renderStrategy,
        actualReverseExtractPolicy: option.actualReverseExtractPolicy,
        requiredOutputUnitFingerprints: [...option.requiredOutputUnitFingerprints],
        approval,
    };
    return option.outcome === "preserved"
        ? { ...base, outcome: "preserved" }
        : {
              ...base,
              outcome: "degraded",
              degradationFingerprint: option.degradationFingerprint,
          };
}

function requireApprovalResolutionTime(value: EpochMillis): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RenderSelectionFailure(
            "render.resolution_time_invalid",
            "render approval resolution time must be a non-negative safe integer",
        );
    }
}

function resolveSelectedOutputUnits(
    selected: readonly SelectedOptionRecord[],
    analyses: readonly RenderAnalysisResult[],
): RenderOutputUnit[] {
    const descriptors = new Map<string, RenderOutputUnit>();
    for (const analysis of analyses) {
        for (const unit of analysis.outputUnits) {
            descriptors.set(unit.outputUnitFingerprint, unit);
        }
    }
    const required = new Set(selected.flatMap((item) => item.option.requiredOutputUnitFingerprints));
    const units = [...required].map((fingerprint) => {
        return descriptors.get(fingerprint) as RenderOutputUnit;
    });
    validatePhysicalOutputClosure(units);
    return units.sort((left, right) => compareUtf8Bytes(left.outputUnitFingerprint, right.outputUnitFingerprint));
}

function resolveOutputUnitRenderers(
    selected: readonly SelectedOptionRecord[],
    outputUnits: readonly RenderOutputUnit[],
    deployment: RenderDeploymentInput,
    registry: RenderRegistrySnapshot,
): SelectedOutputUnitRenderer[] {
    const contexts = new Map(deployment.targetContexts.map((context) => [context.agentRuntimeId, context]));
    return outputUnits.map((unit) => {
        const requirements: RenderConformanceRequirement[] = [];
        for (const record of selected.filter((item) =>
            item.option.requiredOutputUnitFingerprints.includes(unit.outputUnitFingerprint),
        )) {
            const context = contexts.get(record.semantic.consumerAgentRuntimeId);
            const asset = deployment.assets.find(
                (item) =>
                    item.version.ref.assetId === record.semantic.subject.assetId &&
                    item.version.ref.versionId === record.semantic.subject.versionId,
            );
            requirements.push({
                context: context as RenderDeploymentInput["targetContexts"][number],
                assetKind: (asset as RenderDeploymentInput["assets"][number]).version.canonical.kind,
                renderStrategy: record.option.renderStrategy,
            });
        }
        const candidates = registry.findMaterializerCandidates(unit, requirements);
        if (candidates.length === 0) {
            throw new RenderSelectionFailure(
                "render.materializer_missing",
                "no current renderer/profile has exact consumer conformance",
                "unsupported",
            );
        }
        const selectedRenderer = candidates[0] as (typeof candidates)[number];
        return {
            outputUnitFingerprint: unit.outputUnitFingerprint,
            ...selectedRenderer,
        };
    });
}
