/** Provider render-analysis and dialect-input validation. */

import type { RenderOutcomeDetailsV1, RenderOutputUnit, RequiredRenderSemantic } from "../contracts/deployment-authority";
import type { AdapterProviderSummary, AdapterAssetTargetCapabilityAvailable } from "../contracts/source-import";
import type {
    AdapterRenderAnalysisResult,
    ProviderRenderDialectInputsForAsset,
    RenderAnalysisInput,
    RenderAnalysisView,
    RenderDeploymentInput,
    SemanticRenderOption,
} from "../contracts/render";
import type { AssetKind, Sha256Digest } from "../contracts/primitives";
import type { OperationDiagnostic } from "../types";
import {
    computeProviderRenderDialectInputFingerprint,
    computeRenderApprovalFingerprint,
    computeRenderDegradationFingerprint,
    computeRenderOptionFingerprint,
    computeRenderOutputUnitFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import type { RenderRegistrySnapshot } from "./render-registry";
import { isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import { binaryPayloadStats, textPayloadStats } from "../catalog/payload-store";
import {
    deriveRequiredRenderSemanticsV1,
    requireSemanticAsset,
    reversePolicyFits,
    versionRefKey,
    semanticVersionKey,
    requireSortedUnique,
} from "./render-semantics";
import { RenderAnalysisFailure, diagnosticFromError, compareUtf8Bytes } from "./render-analysis-shared";
import { isExplicitUnsupportedAnalysis } from "./render-analysis-refusal";
import { projectProviderTargetFileSnapshots } from "./render-dialect-authority";
import { validateNativeRepresentationInput } from "./render-native-representation-validation";
import { validateCanonicalNativePreservationSeed } from "./canonical-native-preservation-seed";
import { renderDialectScopeKey, renderDialectScopes } from "./render-dialect-scope";

export { validateNativeRepresentationInput };

const RENDER_DEGRADATION_KINDS = new Set<string>([
    "target_runtime_missing_asset_kind",
    "trigger_or_loading_level_lost",
    "workflow_trigger_lost",
    "workflow_permission_lost",
    "workflow_runtime_lost",
    "workflow_variable_lost",
    "permission_or_tool_boundary_lost",
    "folder_asset_flattened",
    "memory_semantics_lost",
    "runtime_specific_metadata_lost",
    "reverse_extract_pollution_risk",
]);

/**
 * Bind cell-local target-handler options to the complete final Provider dispatch.
 *
 * Adapter Framework deliberately gives each private target handler only its semantic/dialect
 * closure. The authenticated final Provider facade uses this helper after composing those
 * closures so Core validation and later selection bind every option to the complete Provider
 * input without exposing unrelated dialect payloads to an individual handler.
 */
export function rebindAdapterRenderAnalysisOptionFingerprints(
    provider: Pick<AdapterProviderSummary, "adapterId" | "version">,
    input: Pick<RenderAnalysisInput, "deployment" | "dialectInputs">,
    result: AdapterRenderAnalysisResult,
): AdapterRenderAnalysisResult {
    const providerRenderDialectInputFingerprint = computeProviderRenderDialectInputFingerprint({
        adapterId: provider.adapterId,
        adapterVersion: provider.version,
        dialectInputs: input.dialectInputs,
    });
    return {
        ...structuredClone(result),
        semanticOptions: result.semanticOptions.map((option) => {
            const { optionFingerprint: _optionFingerprint, diagnostics: _diagnostics, ...fingerprintPreimage } = option;
            return {
                ...structuredClone(option),
                optionFingerprint: computeRenderOptionFingerprint({
                    adapterId: provider.adapterId,
                    adapterVersion: provider.version,
                    renderInputFingerprint: input.deployment.renderInputFingerprint,
                    providerRenderDialectInputFingerprint,
                    option: fingerprintPreimage,
                }),
            };
        }),
    };
}

export function validateAdapterRenderAnalysisResult(
    provider: AdapterProviderSummary,
    input: RenderAnalysisInput,
    result: AdapterRenderAnalysisResult,
): OperationDiagnostic[] {
    try {
        validateProviderAnalysisInput(provider, input);
        if (
            (result.status !== "complete" && result.status !== "partial" && result.status !== "failed") ||
            !Array.isArray(result.outputUnits) ||
            !Array.isArray(result.semanticOptions) ||
            !Array.isArray(result.blockedSemanticRefs) ||
            !Array.isArray(result.diagnostics)
        ) {
            throw new RenderAnalysisFailure(
                "render.provider_result_shape_invalid",
                "provider analysis result has an invalid status or collection shape",
            );
        }
        const semantics = new Map(input.requiredSemantics.map((semantic) => [semantic.semanticRefFingerprint, semantic]));
        if (semantics.size !== input.requiredSemantics.length || semantics.size === 0) {
            throw new RenderAnalysisFailure(
                "render.semantic_input_invalid",
                "provider semantic set must be non-empty and unique",
            );
        }
        const outputUnits = new Map<string, RenderOutputUnit>();
        for (const outputUnit of result.outputUnits) {
            validateOutputUnit(outputUnit);
            if (outputUnits.has(outputUnit.outputUnitFingerprint)) {
                throw new RenderAnalysisFailure("render.output_unit_duplicate", "provider repeated an output unit");
            }
            outputUnits.set(outputUnit.outputUnitFingerprint, outputUnit);
        }
        const dialectFingerprint = computeProviderRenderDialectInputFingerprint({
            adapterId: provider.adapterId,
            adapterVersion: provider.version,
            dialectInputs: input.dialectInputs,
        });
        const optionIds = new Set<string>();
        const refsWithOptions = new Set<string>();
        const referencedUnits = new Set<string>();
        for (const option of result.semanticOptions) {
            const semantic = semantics.get(option.semanticRefFingerprint);
            if (semantic === undefined) {
                throw new RenderAnalysisFailure("render.option_foreign_semantic", "provider returned a foreign semantic option");
            }
            if (optionIds.has(option.optionFingerprint)) {
                throw new RenderAnalysisFailure("render.option_duplicate", "provider repeated an option fingerprint");
            }
            optionIds.add(option.optionFingerprint);
            refsWithOptions.add(option.semanticRefFingerprint);
            validateOption(provider, input, semantic, option, outputUnits, dialectFingerprint);
            for (const unit of option.requiredOutputUnitFingerprints) referencedUnits.add(unit);
        }
        const blocked = new Set<string>();
        for (const record of result.blockedSemanticRefs) {
            if (!semantics.has(record.semanticRefFingerprint) || blocked.has(record.semanticRefFingerprint)) {
                throw new RenderAnalysisFailure("render.blocked_ref_invalid", "blocked semantic ref is foreign or duplicated");
            }
            if (record.reasonCode.trim().length === 0) {
                throw new RenderAnalysisFailure("render.blocked_reason_missing", "blocked semantic requires a reason code");
            }
            blocked.add(record.semanticRefFingerprint);
        }
        for (const semantic of input.requiredSemantics) {
            const hasOptions = refsWithOptions.has(semantic.semanticRefFingerprint);
            const isBlocked = blocked.has(semantic.semanticRefFingerprint);
            if (hasOptions === isBlocked) {
                throw new RenderAnalysisFailure(
                    "render.semantic_closure_invalid",
                    "semantic must have options xor one blocked record",
                );
            }
            if (semantic.subject.subjectKind === "missing_required_file_role" && !isBlocked) {
                throw new RenderAnalysisFailure("render.missing_entry_not_blocked", "missing required entry must be blocked");
            }
        }
        if (
            stableStringify([...referencedUnits].sort(compareUtf8Bytes)) !==
            stableStringify([...outputUnits.keys()].sort(compareUtf8Bytes))
        ) {
            throw new RenderAnalysisFailure(
                "render.output_unit_closure_invalid",
                "output units must equal the option-referenced set",
            );
        }
        return [];
    } catch (error) {
        return [diagnosticFromError(error)];
    }
}

export function validateAnalysisView(
    view: RenderAnalysisView,
    deployment: RenderDeploymentInput,
    registry: RenderRegistrySnapshot,
): void {
    if (view.renderInputFingerprint !== deployment.renderInputFingerprint) {
        throw new RenderAnalysisFailure("render.analysis_input_mismatch", "analysis view belongs to another render input");
    }
    const expected = deriveRequiredRenderSemanticsV1(deployment);
    if (stableStringify(view.requiredSemantics) !== stableStringify(expected)) {
        throw new RenderAnalysisFailure("render.analysis_semantics_mismatch", "analysis required semantics were changed");
    }
    const providerIds = new Set<string>();
    const descriptors = new Map<string, RenderOutputUnit>();
    for (const analysis of view.analyses) {
        if (providerIds.has(analysis.adapterId)) {
            throw new RenderAnalysisFailure("render.analysis_provider_duplicate", "analysis repeats a provider");
        }
        providerIds.add(analysis.adapterId);
        const provider = registry.getProvider(analysis.adapterId);
        if (
            provider === null ||
            !provider.enabled ||
            provider.version !== analysis.adapterVersion ||
            (analysis.status === "failed" && !isExplicitUnsupportedAnalysis(analysis))
        ) {
            throw new RenderAnalysisFailure("render.analysis_provider_stale", "analysis provider identity/version is stale");
        }
        if (analysis.status === "failed") {
            const required = expected
                .filter((semantic) => registry.getOwner(semantic.consumerAgentRuntimeId)?.adapterId === analysis.adapterId)
                .map((semantic) => semantic.semanticRefFingerprint)
                .sort(compareUtf8Bytes);
            const blocked = analysis.blockedSemanticRefs.map((ref) => ref.semanticRefFingerprint).sort(compareUtf8Bytes);
            if (stableStringify(required) !== stableStringify(blocked)) {
                throw new RenderAnalysisFailure(
                    "render.analysis_refusal_coverage_invalid",
                    "negative analysis must classify every owned semantic exactly once",
                );
            }
        }
        for (const unit of analysis.outputUnits) {
            const previous = descriptors.get(unit.outputUnitFingerprint);
            if (previous !== undefined && stableStringify(previous) !== stableStringify(unit)) {
                throw new RenderAnalysisFailure(
                    "render.output_unit_conflict",
                    "providers disagree on one output-unit descriptor",
                );
            }
            descriptors.set(unit.outputUnitFingerprint, unit);
        }
    }
    const expectedProviderIds = new Set<string>();
    for (const semantic of expected) {
        const owner = registry.getOwner(semantic.consumerAgentRuntimeId);
        if (owner === null) {
            throw new RenderAnalysisFailure("render.analysis_owner_missing", "analysis omitted a consumer owner");
        }
        expectedProviderIds.add(owner.adapterId);
    }
    if (
        stableStringify([...providerIds].sort(compareUtf8Bytes)) !==
        stableStringify([...expectedProviderIds].sort(compareUtf8Bytes))
    ) {
        throw new RenderAnalysisFailure(
            "render.analysis_owner_cardinality",
            "analysis providers must exactly equal the required consumer owners",
        );
    }
}

export function buildProviderAnalysisInput(
    deployment: RenderDeploymentInput,
    _provider: AdapterProviderSummary,
    semantics: readonly RequiredRenderSemantic[],
    dialectInputs: ProviderRenderDialectInputsForAsset[],
): RenderAnalysisInput {
    const consumerIds = new Set(semantics.map((item) => item.consumerAgentRuntimeId));
    const versionKeys = new Set([
        ...semantics.map((item) => semanticVersionKey(item.subject)),
        ...dialectInputs.map((group) => versionRefKey(group.targetVersion)),
    ]);
    const targetContexts = deployment.targetContexts.filter((item) => consumerIds.has(item.agentRuntimeId));
    const assets = deployment.assets.filter((item) => versionKeys.has(versionRefKey(item.version.ref)));
    validateDialectInputProjection(dialectInputs, assets, semantics);
    const targetFileSnapshots = projectProviderTargetFileSnapshots({
        targetFileSnapshots: deployment.targetFileSnapshots,
        dialectInputs,
    });
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: deployment.platform,
            platformInstanceId: deployment.platformInstanceId,
            targetContexts,
            assets,
            ...(targetFileSnapshots === undefined ? {} : { targetFileSnapshots }),
            renderInputFingerprint: deployment.renderInputFingerprint,
        },
        requiredSemantics: [...semantics],
        dialectInputs,
    };
}

export function groupSemanticsByOwner(
    semantics: readonly RequiredRenderSemantic[],
    registry: RenderRegistrySnapshot,
): Array<[AdapterProviderSummary, RequiredRenderSemantic[]]> {
    const groups = new Map<string, { provider: AdapterProviderSummary; semantics: RequiredRenderSemantic[] }>();
    for (const semantic of semantics) {
        const provider = registry.getOwner(semantic.consumerAgentRuntimeId);
        if (provider === null) {
            throw new RenderAnalysisFailure(
                "render.consumer_owner_missing",
                `no provider owns ${semantic.consumerAgentRuntimeId}`,
            );
        }
        const group = groups.get(provider.adapterId) ?? { provider, semantics: [] };
        group.semantics.push(semantic);
        groups.set(provider.adapterId, group);
    }
    return [...groups.values()]
        .sort((left, right) => compareUtf8Bytes(left.provider.adapterId, right.provider.adapterId))
        .map((item) => [item.provider, item.semantics] as [AdapterProviderSummary, RequiredRenderSemantic[]]);
}

export function validateProviderAnalysisInput(provider: AdapterProviderSummary, input: RenderAnalysisInput): void {
    if (input.schemaVersion !== 1 || input.deployment.schemaVersion !== 1) {
        throw new RenderAnalysisFailure("render.provider_input_schema", "provider analysis input schema is invalid");
    }
    const owned = new Set(provider.agentRuntimes.map((item) => item.agentRuntimeId));
    if (input.deployment.targetContexts.some((item) => !owned.has(item.agentRuntimeId))) {
        throw new RenderAnalysisFailure(
            "render.provider_input_foreign_context",
            "provider input includes a foreign target context",
        );
    }
    if (input.requiredSemantics.some((item) => !owned.has(item.consumerAgentRuntimeId))) {
        throw new RenderAnalysisFailure("render.provider_input_foreign_semantic", "provider input includes a foreign semantic");
    }
    const contextSet = new Set(input.deployment.targetContexts.map((item) => item.agentRuntimeId));
    if (input.requiredSemantics.some((item) => !contextSet.has(item.consumerAgentRuntimeId))) {
        throw new RenderAnalysisFailure(
            "render.provider_input_context_missing",
            "provider input omitted a required target context",
        );
    }
    validateDialectInputProjection(input.dialectInputs, input.deployment.assets, input.requiredSemantics);
    const projectedTargetSnapshots = projectProviderTargetFileSnapshots({
        targetFileSnapshots: input.deployment.targetFileSnapshots,
        dialectInputs: input.dialectInputs,
    });
    if (stableStringify(projectedTargetSnapshots) !== stableStringify(input.deployment.targetFileSnapshots)) {
        throw new RenderAnalysisFailure(
            "render.provider_target_snapshot_projection_invalid",
            "provider input includes foreign or incomplete target file snapshots",
        );
    }
}

export function validateOption(
    provider: AdapterProviderSummary,
    input: RenderAnalysisInput,
    semantic: RequiredRenderSemantic,
    option: SemanticRenderOption,
    outputUnits: ReadonlyMap<string, RenderOutputUnit>,
    dialectFingerprint: Sha256Digest,
): void {
    requireSortedUnique(option.requiredOutputUnitFingerprints, "requiredOutputUnitFingerprints");
    if (option.requiredOutputUnitFingerprints.length === 0 || option.reasonCode.trim().length === 0) {
        throw new RenderAnalysisFailure("render.option_shape_invalid", "semantic option requires output units and reason code");
    }
    validateOutcomeAndApproval(provider, input, option);
    const asset = requireSemanticAsset(input, semantic);
    const kind = asset.version.canonical.kind;
    const units = option.requiredOutputUnitFingerprints.map((fingerprint) => {
        const unit = outputUnits.get(fingerprint);
        if (unit === undefined)
            throw new RenderAnalysisFailure("render.option_unit_missing", "semantic option references a missing output unit");
        return unit;
    });
    const capabilities = units.map((unit) => findStaticCapability(provider, input, semantic, kind, option, unit));
    if (capabilities.some((item) => item === null)) {
        throw new RenderAnalysisFailure(
            "render.option_capability_missing",
            "semantic option is outside supported static target capability",
        );
    }
    for (const capability of capabilities as AdapterAssetTargetCapabilityAvailable[]) {
        if (!reversePolicyFits(capability.reverseExtractPolicy, option.actualReverseExtractPolicy)) {
            throw new RenderAnalysisFailure(
                "render.option_reverse_policy_invalid",
                "semantic option contradicts static reverse policy",
            );
        }
    }
    const { optionFingerprint: _stored, diagnostics: _diagnostics, ...preimage } = option;
    const expected = computeRenderOptionFingerprint({
        adapterId: provider.adapterId,
        adapterVersion: provider.version,
        renderInputFingerprint: input.deployment.renderInputFingerprint,
        providerRenderDialectInputFingerprint: dialectFingerprint,
        option: preimage,
    });
    if (option.optionFingerprint !== expected) {
        throw new RenderAnalysisFailure("render.option_fingerprint_mismatch", "semantic option fingerprint mismatch");
    }
}

export function validateOutcomeAndApproval(
    provider: AdapterProviderSummary,
    input: RenderAnalysisInput,
    option: SemanticRenderOption,
): void {
    if (option.outcome !== "preserved" && option.outcome !== "degraded") {
        throw new RenderAnalysisFailure("render.outcome_invalid", "render outcome must be preserved or degraded");
    }
    if (
        option.actualReverseExtractPolicy !== "can_reconcile" &&
        option.actualReverseExtractPolicy !== "ignore_generated_wrapper" &&
        option.actualReverseExtractPolicy !== "unsupported"
    ) {
        throw new RenderAnalysisFailure("render.reverse_policy_invalid", "actual reverse-extract policy is invalid");
    }
    const requiredConcerns = [
        ...(option.outcome === "degraded" ? ["semantic_degradation" as const] : []),
        ...(option.actualReverseExtractPolicy === "unsupported" ? ["reverse_extract_unsupported" as const] : []),
    ].sort(compareUtf8Bytes);
    if (
        option.substituteAssetKind !== undefined &&
        (option.outcome !== "degraded" || !option.degradationKinds.includes("target_runtime_missing_asset_kind"))
    ) {
        throw new RenderAnalysisFailure(
            "render.substitute_kind_invalid",
            "structured substitute kind requires a missing-target-AssetKind degradation",
        );
    }
    if (option.outcome === "degraded") {
        requireSortedUnique(option.degradationKinds, "degradationKinds");
        if (option.degradationKinds.length === 0) {
            throw new RenderAnalysisFailure("render.degradation_empty", "degraded option requires at least one degradation kind");
        }
        if (option.degradationKinds.some((kind) => !RENDER_DEGRADATION_KINDS.has(kind))) {
            throw new RenderAnalysisFailure(
                "render.degradation_kind_invalid",
                "degraded option requires only known degradation kinds",
            );
        }
        const expected = computeRenderDegradationFingerprint({
            adapterId: provider.adapterId,
            adapterVersion: provider.version,
            renderInputFingerprint: input.deployment.renderInputFingerprint,
            semanticRefFingerprint: option.semanticRefFingerprint,
            renderStrategy: option.renderStrategy,
            outcome: option,
            actualReverseExtractPolicy: option.actualReverseExtractPolicy,
            reasonCode: option.reasonCode,
        });
        if (option.degradationFingerprint !== expected) {
            throw new RenderAnalysisFailure("render.degradation_fingerprint_mismatch", "degradation fingerprint mismatch");
        }
    }
    if (requiredConcerns.length === 0) {
        if (option.approvalRequirement.approvalState !== "not_required") {
            throw new RenderAnalysisFailure("render.approval_overclaimed", "safe preserved option must not request approval");
        }
        return;
    }
    if (
        option.approvalRequirement.approvalState !== "required" ||
        stableStringify([...option.approvalRequirement.concerns].sort(compareUtf8Bytes)) !== stableStringify(requiredConcerns)
    ) {
        throw new RenderAnalysisFailure("render.approval_concerns_invalid", "approval concerns do not match terminal loss facts");
    }
    const outcome: RenderOutcomeDetailsV1 =
        option.outcome === "preserved"
            ? { outcome: "preserved" }
            : {
                  outcome: "degraded",
                  degradationKinds: option.degradationKinds,
                  degradationFingerprint: option.degradationFingerprint,
              };
    const expected = computeRenderApprovalFingerprint({
        renderInputFingerprint: input.deployment.renderInputFingerprint,
        semanticRefFingerprint: option.semanticRefFingerprint,
        renderStrategy: option.renderStrategy,
        outcome,
        actualReverseExtractPolicy: option.actualReverseExtractPolicy,
        concerns: requiredConcerns,
    });
    if (option.approvalRequirement.approvalFingerprint !== expected) {
        throw new RenderAnalysisFailure("render.approval_fingerprint_mismatch", "approval fingerprint mismatch");
    }
}

export function findStaticCapability(
    provider: AdapterProviderSummary,
    input: RenderAnalysisInput,
    semantic: RequiredRenderSemantic,
    kind: AssetKind,
    option: SemanticRenderOption,
    unit: RenderOutputUnit,
): AdapterAssetTargetCapabilityAvailable | null {
    // validateProviderAnalysisInput has already proved an exact context set for
    // every consumer semantic before this helper is reached.
    const context = input.deployment.targetContexts.find(
        (item) => item.agentRuntimeId === semantic.consumerAgentRuntimeId,
    ) as RenderAnalysisInput["deployment"]["targetContexts"][number];
    const matches = provider.assetTargetCapabilities.filter(
        (capability): capability is AdapterAssetTargetCapabilityAvailable =>
            "renderStrategy" in capability &&
            capability.entrySupportStatus === "supported" &&
            capability.agentRuntimeId === semantic.consumerAgentRuntimeId &&
            capability.assetKind === kind &&
            capability.renderStrategy === option.renderStrategy &&
            capability.outputContractId === unit.outputContractId &&
            capability.outputContractFingerprint === unit.outputContractFingerprint &&
            capability.targetContextSchemaId === context.targetContextSchemaId &&
            capability.targetContextSchemaFingerprint === context.targetContextSchemaFingerprint,
    );
    return matches.length === 1 ? (matches[0] as AdapterAssetTargetCapabilityAvailable) : null;
}

export function validateOutputUnit(unit: RenderOutputUnit): void {
    if (unit.claims.length === 0) throw new RenderAnalysisFailure("render.output_claim_missing", "output unit requires a claim");
    requireSortedUnique(
        unit.claims.map((claim) => claim.relativePath),
        "output claim paths",
    );
    const paths = new Set<string>();
    for (const claim of unit.claims) {
        if (
            !isCanonicalRelativePath(claim.relativePath) ||
            paths.has(claim.relativePath) ||
            (claim.contentKind !== "text" && claim.contentKind !== "binary") ||
            typeof claim.executable !== "boolean"
        ) {
            throw new RenderAnalysisFailure(
                "render.output_claim_invalid",
                "output claim path, content kind, or executable flag is invalid",
            );
        }
        paths.add(claim.relativePath);
    }
    const claimPaths = [...paths];
    for (const path of claimPaths) {
        if (claimPaths.some((other) => other !== path && path.startsWith(`${other}/`))) {
            throw new RenderAnalysisFailure(
                "render.output_claim_prefix_conflict",
                "one output claim treats another file claim as a directory",
            );
        }
    }
    requireSortedUnique(
        unit.managedDirectoryBoundaries.map((boundary) => boundary.relativePath),
        "managed directory boundary paths",
    );
    const boundaries = new Set<string>();
    for (const boundary of unit.managedDirectoryBoundaries) {
        if (
            !isCanonicalRelativePath(boundary.relativePath) ||
            boundaries.has(boundary.relativePath) ||
            boundary.boundaryKind !== "directory_inventory"
        ) {
            throw new RenderAnalysisFailure("render.output_boundary_invalid", "managed boundary is invalid or duplicated");
        }
        if (
            claimPaths.some(
                (claimPath) => boundary.relativePath === claimPath || boundary.relativePath.startsWith(`${claimPath}/`),
            )
        ) {
            throw new RenderAnalysisFailure(
                "render.output_boundary_claim_invalid",
                "managed boundary cannot equal or descend from a file claim",
            );
        }
        if ("desiredDirectoryPaths" in boundary) {
            requireSortedUnique(boundary.desiredDirectoryPaths, "desired directory paths");
            if (
                boundary.desiredDirectoryPaths.length === 0 ||
                boundary.desiredDirectoryPaths[0] !== boundary.relativePath ||
                boundary.desiredDirectoryPaths.some(
                    (path) =>
                        !isCanonicalRelativePath(path) ||
                        (path !== boundary.relativePath && !path.startsWith(`${boundary.relativePath}/`)) ||
                        claimPaths.includes(path),
                )
            ) {
                throw new RenderAnalysisFailure(
                    "render.output_directory_graph_invalid",
                    "managed desired-directory graph is invalid",
                );
            }
        }
        boundaries.add(boundary.relativePath);
    }
    const { outputUnitFingerprint: _stored, ...preimage } = unit;
    if (computeRenderOutputUnitFingerprint(preimage) !== unit.outputUnitFingerprint) {
        throw new RenderAnalysisFailure("render.output_unit_fingerprint_mismatch", "output unit fingerprint mismatch");
    }
}

export function validateDialectInputProjection(
    dialectInputs: readonly ProviderRenderDialectInputsForAsset[],
    assets: readonly RenderDeploymentInput["assets"][number][],
    semantics: readonly RequiredRenderSemantic[],
): void {
    const allowed = new Map(assets.map((item) => [versionRefKey(item.version.ref), item] as const));
    const seen = new Set<string>();
    const scopes = renderDialectScopes(semantics, assets);
    for (const group of dialectInputs) {
        const key = versionRefKey(group.targetVersion);
        const asset = allowed.get(key);
        if (
            asset === undefined ||
            !Array.isArray(group.consumerAgentRuntimeIds) ||
            group.consumerAgentRuntimeIds.length === 0 ||
            group.inputs.length === 0
        ) {
            throw new RenderAnalysisFailure(
                "render.dialect_projection_invalid",
                "dialect input projection is foreign, duplicated, or empty",
            );
        }
        for (const [index, consumer] of group.consumerAgentRuntimeIds.entries()) {
            const scope = renderDialectScopeKey(consumer, group.targetVersion);
            if (
                typeof consumer !== "string" ||
                consumer.trim() !== consumer ||
                consumer.includes("\0") ||
                (index > 0 && compareUtf8Bytes(group.consumerAgentRuntimeIds[index - 1] as string, consumer) >= 0) ||
                !scopes.has(scope) ||
                seen.has(scope)
            ) {
                throw new RenderAnalysisFailure(
                    "render.dialect_consumer_scope_invalid",
                    "dialect authority has an unselected, duplicated or noncanonical consumer scope",
                );
            }
            seen.add(scope);
        }
        const inputKeys = new Set<string>();
        for (const item of group.inputs) {
            const inputKey = dialectInputKey(item);
            if (inputKeys.has(inputKey)) {
                throw new RenderAnalysisFailure(
                    "render.dialect_input_duplicate",
                    "dialect input projection repeats one operation-local input",
                );
            }
            inputKeys.add(inputKey);
            if (item.inputKind === "dialect_restoration") {
                validateRestorationInput(item);
            } else if (item.inputKind === "canonical_materialization") {
                validateCanonicalMaterializationInput(item);
                if (item.nativePreservationSeed !== undefined) {
                    validateCanonicalNativePreservationSeed(
                        item.nativePreservationSeed,
                        asset.version.versionCanonicalContentFingerprint,
                    );
                }
            } else {
                if (
                    item.inputRole === "parent_rebase_seed" &&
                    (item.sourceVersion.assetId !== group.targetVersion.assetId ||
                        item.sourceVersion.versionId === group.targetVersion.versionId)
                ) {
                    throw new RenderAnalysisFailure(
                        "render.parent_native_source_invalid",
                        "parent native input must identify a different Version of the target Asset",
                    );
                }
                validateNativeRepresentationInput(item, asset.version.versionCanonicalContentFingerprint);
            }
        }
    }
}

export function validateRestorationInput(
    input: Extract<ProviderRenderDialectInputsForAsset["inputs"][number], { inputKind: "dialect_restoration" }>,
): void {
    const stats =
        input.content.contentKind === "text" ? textPayloadStats(input.content.text) : binaryPayloadStats(input.content.bytes);
    if (
        input.restoration.dialectId.trim().length === 0 ||
        !isSha256Digest(input.restoration.restorationContractFingerprint) ||
        stats.contentHash !== input.restoration.contentHash
    ) {
        throw new RenderAnalysisFailure(
            "render.restoration_payload_mismatch",
            "dialect restoration bytes contradict their authority ref",
        );
    }
}

function validateCanonicalMaterializationInput(
    input: Extract<ProviderRenderDialectInputsForAsset["inputs"][number], { inputKind: "canonical_materialization" }>,
): void {
    if (
        input.nativeDialectId.trim() !== input.nativeDialectId ||
        input.nativeDialectId.length === 0 ||
        input.nativeDialectId.includes("\0") ||
        input.materializer.componentId.trim() !== input.materializer.componentId ||
        input.materializer.componentId.length === 0 ||
        input.materializer.componentId.includes("\0") ||
        !Number.isSafeInteger(input.materializer.componentVersion) ||
        input.materializer.componentVersion < 1 ||
        !isSha256Digest(input.materializer.configFingerprint) ||
        !Array.isArray(input.degradationKinds) ||
        new Set(input.degradationKinds).size !== input.degradationKinds.length ||
        input.degradationKinds.some((kind, index) => index > 0 && (input.degradationKinds[index - 1] as string) >= kind) ||
        input.reasonCode.trim() !== input.reasonCode ||
        input.reasonCode.length === 0 ||
        input.reasonCode.includes("\0") ||
        (input.logicalDirectoryPaths !== undefined &&
            (!Array.isArray(input.logicalDirectoryPaths) ||
                input.logicalDirectoryPaths.some((path) => !isCanonicalRelativePath(path)) ||
                new Set(input.logicalDirectoryPaths).size !== input.logicalDirectoryPaths.length ||
                stableStringify([...input.logicalDirectoryPaths].sort(compareUtf8Bytes)) !==
                    stableStringify(input.logicalDirectoryPaths)))
    ) {
        throw new RenderAnalysisFailure(
            "render.canonical_materialization_authority_invalid",
            "canonical materialization input does not bind one immutable reviewed migration",
        );
    }
}

export function dialectInputKey(input: ProviderRenderDialectInputsForAsset["inputs"][number]): string {
    if (input.inputKind === "dialect_restoration") {
        return `${input.inputKind}\0${input.restoration.dialectId}`;
    }
    if (input.inputKind === "canonical_materialization") {
        return `${input.inputKind}\0${input.nativeDialectId}`;
    }
    return `${input.inputKind}\0${input.inputRole}\0${input.representation.dialectId}\0${
        input.inputRole === "parent_rebase_seed" ? versionRefKey(input.sourceVersion) : ""
    }`;
}
