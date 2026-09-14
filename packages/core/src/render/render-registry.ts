import type {
    AdapterAssetTargetCapabilityAvailable,
    AdapterProviderSummary,
    AgentRuntimeDescriptor,
    MaterializationProfileId,
    MaterializerCapabilityKey,
} from "../contracts/source-import";
import type {
    CanonicalRenderSemanticValue,
    ConsumerOutputContractConformanceV1,
    MaterializedRenderFile,
    MaterializationSafeSelectedSemanticOption,
    OutputContractDefinitionV1,
    OutputContractMaterializationProfile,
    ProviderRenderDialectInputsForAsset,
    TargetAgentRuntimeRenderContext,
    VersionedContractComponentRef,
} from "../contracts/render";
import type { AssetKind, Sha256Digest } from "../contracts/primitives";
import type {
    AppliedRenderSnapshotV1,
    MaterializationSemanticCoverageProof,
    RenderOutputUnit,
    RenderStrategy,
    RequiredRenderSemantic,
} from "../contracts/deployment-authority";
import type {
    AdapterRenderedTargetInspectionResult,
    ChangedRenderedTargetFileInput,
    RenderedTargetInventoryDelta,
    ReverseInspectionCoverageProof,
} from "../contracts/reverse";
import {
    computeConsumerConformanceFingerprint,
    computeMaterializationProfileConstraintFingerprint,
    computeOutputContractFingerprint,
    computeRenderRegistryFingerprint,
    computeTargetApplicabilityFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { deepFreezeChildrenFirst } from "../foundation/deep-freeze";
import type { CanonicalMaterializationValidatorsByAdapter } from "./canonical-materialization-validation";
import {
    findCanonicalMaterializationValidator,
    snapshotCanonicalMaterializationValidators,
} from "./canonical-materialization-validation";
import {
    assessRegisteredCanonicalMaterialization,
    type CanonicalMaterializationAssessmentRequest,
} from "./canonical-materialization-assessment";
import type { RenderDegradationKind } from "../contracts/deployment-authority";
import { isSha256Digest } from "../foundation/validators";

const OUTPUT_CONTRACT_ID = /^[A-Z][A-Z0-9_]*_V[1-9][0-9]*$/;

export interface TargetApplicabilityPredicateImplementation {
    ref: VersionedContractComponentRef;
    /** Only Core-compiled compatibility predicates may opt out of the legacy exact-hash prefilter. */
    allowsBuildIdentityMismatch?: true;
    evaluate(context: TargetAgentRuntimeRenderContext): boolean;
}

export interface MaterializationValidatorImplementation {
    ref: VersionedContractComponentRef;
    validate(input: {
        contract: OutputContractDefinitionV1;
        profile: OutputContractMaterializationProfile;
        outputUnit: RenderOutputUnit;
        selectedSemantics: RequiredRenderSemantic[];
        canonicalValues: CanonicalRenderSemanticValue[];
        selectedOptions: MaterializationSafeSelectedSemanticOption[];
        dialectInputs: ProviderRenderDialectInputsForAsset[];
        files: MaterializedRenderFile[];
    }): MaterializationSemanticCoverageProof;
}

export interface ReverseInspectionValidatorImplementation {
    ref: VersionedContractComponentRef;
    validate(input: {
        contract: OutputContractDefinitionV1;
        outputUnit: RenderOutputUnit;
        appliedRenderSnapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
        inspectionScopeFingerprint: Sha256Digest;
        files: ChangedRenderedTargetFileInput[];
        inventoryDeltas: RenderedTargetInventoryDelta[];
        adapterResult: AdapterRenderedTargetInspectionResult;
    }): ReverseInspectionCoverageProof;
}

export interface RenderRegistryConfiguration {
    canonicalMaterializationValidators?: CanonicalMaterializationValidatorsByAdapter;
    providers: readonly AdapterProviderSummary[];
    outputContracts: readonly OutputContractDefinitionV1[];
    consumerConformances: readonly ConsumerOutputContractConformanceV1[];
    targetApplicabilityPredicates: readonly TargetApplicabilityPredicateImplementation[];
    materializationValidators: readonly MaterializationValidatorImplementation[];
    reverseInspectionValidators: readonly ReverseInspectionValidatorImplementation[];
}

export interface RenderConformanceRequirement {
    context: TargetAgentRuntimeRenderContext;
    assetKind: AssetKind;
    renderStrategy: RenderStrategy;
}

export interface RenderMaterializerCandidate {
    rendererAdapterId: string;
    rendererAdapterVersion: string;
    materializerCapabilityKey: MaterializerCapabilityKey;
    materializationProfileId: MaterializationProfileId;
    profileConstraintFingerprint: Sha256Digest;
}

export interface RenderRegistrySnapshot {
    assessCanonicalMaterialization(request: CanonicalMaterializationAssessmentRequest): RenderDegradationKind[] | null;
    readonly fingerprint: Sha256Digest;
    listProviders(): readonly AdapterProviderSummary[];
    getProvider(adapterId: string): AdapterProviderSummary | null;
    getOwner(agentRuntimeId: string): AdapterProviderSummary | null;
    getDescriptor(agentRuntimeId: string): AgentRuntimeDescriptor | null;
    getOutputContract(outputContractId: string): OutputContractDefinitionV1 | null;
    validateTargetContext(context: TargetAgentRuntimeRenderContext): void;
    findTargetCapability(input: {
        provider: AdapterProviderSummary;
        agentRuntimeId: string;
        assetKind: AssetKind;
        renderStrategy: RenderStrategy;
        outputContractId: string;
        outputContractFingerprint: Sha256Digest;
    }): AdapterAssetTargetCapabilityAvailable | null;
    findMaterializerCandidates(
        outputUnit: RenderOutputUnit,
        requirements: readonly RenderConformanceRequirement[],
    ): RenderMaterializerCandidate[];
    validateOutputContractMaterialization(
        input: Parameters<MaterializationValidatorImplementation["validate"]>[0],
    ): MaterializationSemanticCoverageProof;
    validateOutputContractReverseInspection(
        input: Parameters<ReverseInspectionValidatorImplementation["validate"]>[0],
    ): ReverseInspectionCoverageProof;
}

export function createRenderRegistry(configuration: RenderRegistryConfiguration): RenderRegistrySnapshot {
    const providers = deepFreezeChildrenFirst(
        structuredClone([...configuration.providers]).sort((left, right) => compareUtf8Bytes(left.adapterId, right.adapterId)),
    );
    const providerById = uniqueBy(providers, (item) => item.adapterId, "provider adapterId");
    const canonicalValidators = new Map(
        [...(configuration.canonicalMaterializationValidators ?? new Map()).entries()].map(
            ([adapterId, validators]) => [adapterId, snapshotCanonicalMaterializationValidators(validators)] as const,
        ),
    );
    for (const provider of providers) {
        for (const declaration of provider.renderContractDeclarations) {
            if (!("canonicalMaterialization" in declaration) || declaration.canonicalMaterialization?.assessesLoss !== true)
                continue;
            const validator = findCanonicalMaterializationValidator(canonicalValidators, provider.adapterId, {
                ...declaration,
                materializer: declaration.canonicalMaterialization.materializer,
            });
            if (
                (declaration.declarationKind !== "native_project_exact_graph_v1" &&
                    declaration.declarationKind !== "native_global_exact_graph_v1") ||
                typeof validator?.assessLoss !== "function"
            )
                throw new Error("canonical loss assessment requires one registered exact-graph validator");
        }
    }
    const ownerByRuntime = new Map<string, AdapterProviderSummary>();
    const descriptorByRuntime = new Map<string, AgentRuntimeDescriptor>();
    for (const provider of providers) {
        requireText(provider.adapterId, "provider adapterId");
        requireText(provider.version, "provider version");
        for (const descriptor of provider.agentRuntimes) {
            if (ownerByRuntime.has(descriptor.agentRuntimeId)) {
                throw new Error(`duplicate agent-runtime owner: ${descriptor.agentRuntimeId}`);
            }
            ownerByRuntime.set(descriptor.agentRuntimeId, provider);
            descriptorByRuntime.set(descriptor.agentRuntimeId, descriptor);
        }
        validateProviderStaticRows(provider);
    }

    const outputContracts = deepFreezeChildrenFirst(
        structuredClone([...configuration.outputContracts]).sort((left, right) =>
            compareUtf8Bytes(left.outputContractId, right.outputContractId),
        ),
    );
    const contractById = uniqueBy(outputContracts, (item) => item.outputContractId, "output contract id");
    uniqueBy(outputContracts, (item) => item.outputContractFingerprint, "output contract fingerprint");
    for (const contract of outputContracts) validateOutputContract(contract);

    const predicateEntries = configuration.targetApplicabilityPredicates.map((item) => {
        const ref = deepFreezeChildrenFirst(structuredClone(item.ref));
        requireComponent(ref, "target applicability predicate");
        return Object.freeze({
            ref,
            evaluate: item.evaluate,
            ...(item.allowsBuildIdentityMismatch === true ? { allowsBuildIdentityMismatch: true as const } : {}),
        });
    });
    const predicates = uniqueBy(predicateEntries, (item) => componentKey(item.ref), "target applicability predicate");
    const materializationValidators = componentImplementations(
        configuration.materializationValidators,
        "materialization validator",
    );
    const reverseInspectionValidators = componentImplementations(
        configuration.reverseInspectionValidators,
        "reverse inspection validator",
    );
    const conformances = deepFreezeChildrenFirst(
        structuredClone([...configuration.consumerConformances]).sort((left, right) =>
            compareUtf8Bytes(left.conformanceFingerprint, right.conformanceFingerprint),
        ),
    );
    uniqueBy(conformances, conformanceKey, "consumer conformance key");
    uniqueBy(conformances, (item) => item.conformanceFingerprint, "consumer conformance fingerprint");
    for (const conformance of conformances) {
        validateConsumerConformance(conformance, contractById, providerById, ownerByRuntime, descriptorByRuntime, predicates);
    }
    validateProviderContractReferences(providers, contractById);
    for (const contract of outputContracts) {
        if (!materializationValidators.has(componentKey(contract.materializationValidator))) {
            throw new Error("output contract materialization validator is not registered");
        }
        if (!reverseInspectionValidators.has(componentKey(contract.reverseInspectionValidator))) {
            throw new Error("output contract reverse inspection validator is not registered");
        }
    }

    const fingerprint = computeRenderRegistryFingerprint({
        providers,
        outputContracts,
        consumerConformances: conformances,
    });

    return Object.freeze({
        fingerprint,
        listProviders: () => providers,
        getProvider: (adapterId: string) => providerById.get(adapterId) ?? null,
        getOwner: (agentRuntimeId: string) => ownerByRuntime.get(agentRuntimeId) ?? null,
        getDescriptor: (agentRuntimeId: string) => descriptorByRuntime.get(agentRuntimeId) ?? null,
        getOutputContract: (outputContractId: string) => contractById.get(outputContractId) ?? null,
        validateTargetContext(context: TargetAgentRuntimeRenderContext): void {
            if (context.schemaVersion !== 1) {
                throw new Error("target context schemaVersion must be 1");
            }
            const owner = ownerByRuntime.get(context.agentRuntimeId);
            const descriptor = descriptorByRuntime.get(context.agentRuntimeId);
            if (owner === undefined || descriptor === undefined) {
                throw new Error(`target context has no owner: ${context.agentRuntimeId}`);
            }
            const schema = owner.targetContextSchemas.find(
                (item) => item.targetContextSchemaId === context.targetContextSchemaId,
            );
            if (
                schema === undefined ||
                schema.agentRuntimeId !== context.agentRuntimeId ||
                schema.schemaFingerprint !== context.targetContextSchemaFingerprint
            ) {
                throw new Error("target context schema does not match its owner registry");
            }
            requireText(context.versionText, "target context versionText");
            requireText(context.buildIdentity, "target context buildIdentity");
            const actualKeys = context.renderFacts.map((fact) => fact.key);
            const expectedKeys = schema.factRules.map((rule) => rule.key).sort(compareUtf8Bytes);
            if (
                new Set(actualKeys).size !== actualKeys.length ||
                stableStringify([...actualKeys].sort(compareUtf8Bytes)) !== stableStringify(expectedKeys)
            ) {
                throw new Error("target context render facts do not match its schema exact key set");
            }
            for (const fact of context.renderFacts) {
                requireText(fact.key, "render fact key");
                if (fact.value.trim() !== fact.value || !SOURCE_EVIDENCE_LEVELS.has(fact.evidenceLevel)) {
                    throw new Error("render fact value/evidence must be canonical and recognized");
                }
            }
            const { targetApplicabilityFingerprint: _stored, ...preimage } = context;
            const expected = computeTargetApplicabilityFingerprint({
                context: preimage,
                entryClass: descriptor.entryClass,
            });
            if (context.targetApplicabilityFingerprint !== expected) {
                throw new Error("target applicability fingerprint mismatch");
            }
        },
        findTargetCapability(input: {
            provider: AdapterProviderSummary;
            agentRuntimeId: string;
            assetKind: AssetKind;
            renderStrategy: RenderStrategy;
            outputContractId: string;
            outputContractFingerprint: Sha256Digest;
        }): AdapterAssetTargetCapabilityAvailable | null {
            const matches = input.provider.assetTargetCapabilities.filter(
                (capability): capability is AdapterAssetTargetCapabilityAvailable =>
                    "renderStrategy" in capability &&
                    capability.entrySupportStatus === "supported" &&
                    capability.agentRuntimeId === input.agentRuntimeId &&
                    capability.assetKind === input.assetKind &&
                    capability.renderStrategy === input.renderStrategy &&
                    capability.outputContractId === input.outputContractId &&
                    capability.outputContractFingerprint === input.outputContractFingerprint,
            );
            if (matches.length > 1) throw new Error("target capability is ambiguous");
            return matches[0] ?? null;
        },
        findMaterializerCandidates(
            outputUnit: RenderOutputUnit,
            requirements: readonly RenderConformanceRequirement[],
        ): RenderMaterializerCandidate[] {
            const contract = contractById.get(outputUnit.outputContractId);
            if (contract === undefined || contract.outputContractFingerprint !== outputUnit.outputContractFingerprint) {
                return [];
            }
            const candidates: RenderMaterializerCandidate[] = [];
            for (const provider of providers.filter((item) => item.enabled)) {
                for (const capability of provider.materializerCapabilities) {
                    if (
                        capability.outputContractId !== outputUnit.outputContractId ||
                        capability.outputContractFingerprint !== outputUnit.outputContractFingerprint
                    ) {
                        continue;
                    }
                    for (const profileId of capability.materializationProfileIds) {
                        const profile = contract.materializationProfiles.find(
                            (item) => item.materializationProfileId === profileId,
                        );
                        if (
                            profile !== undefined &&
                            requirements.every((requirement) =>
                                hasCurrentConformance(conformances, predicates, requirement, contract, profile),
                            )
                        ) {
                            candidates.push({
                                rendererAdapterId: provider.adapterId,
                                rendererAdapterVersion: provider.version,
                                materializerCapabilityKey: capability.materializerCapabilityKey,
                                materializationProfileId: profile.materializationProfileId,
                                profileConstraintFingerprint: profile.profileConstraintFingerprint,
                            });
                        }
                    }
                }
            }
            return candidates.sort((left, right) =>
                compareUtf8Bytes(
                    `${left.rendererAdapterId}\0${left.materializerCapabilityKey}\0${left.materializationProfileId}`,
                    `${right.rendererAdapterId}\0${right.materializerCapabilityKey}\0${right.materializationProfileId}`,
                ),
            );
        },
        assessCanonicalMaterialization(request: CanonicalMaterializationAssessmentRequest) {
            return assessRegisteredCanonicalMaterialization(providerById.get(request.adapterId), canonicalValidators, request);
        },
        validateOutputContractMaterialization(
            input: Parameters<MaterializationValidatorImplementation["validate"]>[0],
        ): MaterializationSemanticCoverageProof {
            const registered = contractById.get(input.contract.outputContractId);
            const profile = registered?.materializationProfiles.find(
                (item) => item.materializationProfileId === input.profile.materializationProfileId,
            );
            if (
                registered === undefined ||
                registered.outputContractFingerprint !== input.contract.outputContractFingerprint ||
                profile === undefined ||
                profile.profileConstraintFingerprint !== input.profile.profileConstraintFingerprint
            ) {
                throw new Error("materialization validator input is not from this registry");
            }
            const implementation = materializationValidators.get(componentKey(registered.materializationValidator));
            return structuredClone((implementation as MaterializationValidatorImplementation).validate(input));
        },
        validateOutputContractReverseInspection(
            input: Parameters<ReverseInspectionValidatorImplementation["validate"]>[0],
        ): ReverseInspectionCoverageProof {
            const registered = contractById.get(input.contract.outputContractId);
            if (registered === undefined || registered.outputContractFingerprint !== input.contract.outputContractFingerprint) {
                throw new Error("reverse inspection validator input is not from this registry");
            }
            const implementation = reverseInspectionValidators.get(componentKey(registered.reverseInspectionValidator));
            return structuredClone((implementation as ReverseInspectionValidatorImplementation).validate(input));
        },
    });
}

function componentImplementations<T extends { ref: VersionedContractComponentRef }>(
    values: readonly T[],
    label: string,
): Map<string, T> {
    const result = new Map<string, T>();
    for (const value of values) {
        requireComponent(value.ref, label);
        const key = componentKey(value.ref);
        if (result.has(key)) throw new Error(`duplicate ${label}: ${key}`);
        result.set(
            key,
            Object.freeze({
                ...value,
                ref: deepFreezeChildrenFirst(structuredClone(value.ref)),
            }) as T,
        );
    }
    return result;
}

function validateOutputContract(contract: OutputContractDefinitionV1): void {
    if (contract.schemaVersion !== 1 || !OUTPUT_CONTRACT_ID.test(contract.outputContractId)) {
        throw new Error(`invalid OutputContractId: ${contract.outputContractId}`);
    }
    requireComponent(contract.pathAndFileGrammar, "pathAndFileGrammar");
    requireComponent(contract.markerAndSectionGrammar, "markerAndSectionGrammar");
    requireComponent(contract.generatedWrapperGrammar, "generatedWrapperGrammar");
    requireComponent(contract.materializationValidator, "materializationValidator");
    requireComponent(contract.reverseInspectionValidator, "reverseInspectionValidator");
    const profiles = uniqueBy(
        contract.materializationProfiles,
        (item) => item.materializationProfileId,
        `profile in ${contract.outputContractId}`,
    );
    if (profiles.size === 0) throw new Error("output contract requires a materialization profile");
    const { outputContractFingerprint: _stored, ...preimage } = contract;
    const expected = computeOutputContractFingerprint(preimage);
    if (!isSha256Digest(contract.outputContractFingerprint) || expected !== contract.outputContractFingerprint) {
        throw new Error(`output contract fingerprint mismatch: ${contract.outputContractId}`);
    }
    for (const profile of contract.materializationProfiles) {
        requireText(profile.materializationProfileId, "materializationProfileId");
        requireComponent(profile.constraintValidator, "profile constraintValidator");
        const profileFingerprint = computeMaterializationProfileConstraintFingerprint({
            outputContractFingerprint: contract.outputContractFingerprint,
            materializationProfileId: profile.materializationProfileId,
            constraintValidator: profile.constraintValidator,
        });
        if (profile.profileConstraintFingerprint !== profileFingerprint) {
            throw new Error(`profile constraint fingerprint mismatch: ${profile.materializationProfileId}`);
        }
    }
}

function validateConsumerConformance(
    conformance: ConsumerOutputContractConformanceV1,
    contracts: ReadonlyMap<string, OutputContractDefinitionV1>,
    providers: ReadonlyMap<string, AdapterProviderSummary>,
    owners: ReadonlyMap<string, AdapterProviderSummary>,
    descriptors: ReadonlyMap<string, AgentRuntimeDescriptor>,
    predicates: ReadonlyMap<string, TargetApplicabilityPredicateImplementation>,
): void {
    const owner = owners.get(conformance.agentRuntimeId);
    const descriptor = descriptors.get(conformance.agentRuntimeId);
    if (owner === undefined || descriptor === undefined || !providers.has(owner.adapterId)) {
        throw new Error(`conformance references unknown consumer: ${conformance.agentRuntimeId}`);
    }
    const contract = contracts.get(conformance.outputContractId);
    const profile = contract?.materializationProfiles.find(
        (item) => item.materializationProfileId === conformance.materializationProfileId,
    );
    if (
        contract === undefined ||
        contract.outputContractFingerprint !== conformance.outputContractFingerprint ||
        profile === undefined
    ) {
        throw new Error("conformance references an unknown output contract/profile");
    }
    if (!predicates.has(componentKey(conformance.targetApplicabilityPredicate))) {
        throw new Error("conformance target applicability predicate is not registered");
    }
    requireText(conformance.buildIdentity, "conformance buildIdentity");
    if (
        conformance.evidenceLevel !== "agent_runtime_verified" ||
        conformance.status !== "passed" ||
        !isSha256Digest(conformance.fixtureSetFingerprint)
    ) {
        throw new Error("consumer conformance is not an exact verified passing fixture row");
    }
    const staticCapability = owner.assetTargetCapabilities.find(
        (item): item is AdapterAssetTargetCapabilityAvailable =>
            "renderStrategy" in item &&
            item.entrySupportStatus === "supported" &&
            item.agentRuntimeId === conformance.agentRuntimeId &&
            item.assetKind === conformance.assetKind &&
            item.renderStrategy === conformance.renderStrategy &&
            item.outputContractId === conformance.outputContractId &&
            item.outputContractFingerprint === conformance.outputContractFingerprint,
    );
    if (staticCapability === undefined) {
        throw new Error("conformance has no supported consumer target capability");
    }
    if (staticCapability.targetContextSchemaFingerprint !== conformance.targetContextSchemaFingerprint) {
        throw new Error("conformance target schema does not match its consumer capability");
    }
    const { conformanceFingerprint: _stored, ...preimage } = conformance;
    const expected = computeConsumerConformanceFingerprint({
        conformance: preimage,
        entryClass: descriptor.entryClass,
    });
    if (conformance.conformanceFingerprint !== expected) {
        throw new Error("consumer conformance fingerprint mismatch");
    }
}

function validateProviderContractReferences(
    providers: readonly AdapterProviderSummary[],
    contracts: ReadonlyMap<string, OutputContractDefinitionV1>,
): void {
    const materializerKeys = new Set<string>();
    for (const provider of providers) {
        for (const capability of provider.assetTargetCapabilities) {
            if (!("renderStrategy" in capability)) continue;
            const contract = contracts.get(capability.outputContractId);
            if (contract === undefined || contract.outputContractFingerprint !== capability.outputContractFingerprint) {
                throw new Error("provider target capability references an unknown output contract");
            }
        }
        for (const capability of provider.materializerCapabilities) {
            if (materializerKeys.has(capability.materializerCapabilityKey)) {
                throw new Error("duplicate materializer capability key across providers");
            }
            materializerKeys.add(capability.materializerCapabilityKey);
            const contract = contracts.get(capability.outputContractId);
            if (contract === undefined || contract.outputContractFingerprint !== capability.outputContractFingerprint) {
                throw new Error("materializer references an unknown output contract");
            }
            for (const profile of capability.materializationProfileIds) {
                if (!contract.materializationProfiles.some((item) => item.materializationProfileId === profile)) {
                    throw new Error("materializer references an unknown profile");
                }
            }
        }
    }
}

function validateProviderStaticRows(provider: AdapterProviderSummary): void {
    const schemas = uniqueBy(
        provider.targetContextSchemas,
        (item) => item.targetContextSchemaId,
        `target context schema in ${provider.adapterId}`,
    );
    for (const schema of schemas.values()) {
        requireText(schema.targetContextSchemaId, "targetContextSchemaId");
        if (!isSha256Digest(schema.schemaFingerprint)) {
            throw new Error("target context schema fingerprint must be SHA-256");
        }
        uniqueBy(schema.factRules, (rule) => rule.key, "target context fact key");
        for (const rule of schema.factRules) {
            requireText(rule.key, "target context fact key");
            requireComponent(rule.normalization, "target context normalization");
        }
    }
    uniqueBy(
        provider.assetTargetCapabilities,
        (capability) => {
            const { diagnostics: _diagnostics, ...semantic } = capability;
            return stableStringify(semantic);
        },
        `target capability in ${provider.adapterId}`,
    );
    for (const materializer of provider.materializerCapabilities) {
        requireText(materializer.materializerCapabilityKey, "materializerCapabilityKey");
        if (
            materializer.materializationProfileIds.length === 0 ||
            new Set(materializer.materializationProfileIds).size !== materializer.materializationProfileIds.length
        ) {
            throw new Error("materializer profiles must be unique and non-empty");
        }
    }
}

function hasCurrentConformance(
    conformances: readonly ConsumerOutputContractConformanceV1[],
    predicates: ReadonlyMap<string, TargetApplicabilityPredicateImplementation>,
    requirement: RenderConformanceRequirement,
    contract: OutputContractDefinitionV1,
    profile: OutputContractMaterializationProfile,
): boolean {
    const matches = conformances.filter(
        (item) =>
            item.outputContractId === contract.outputContractId &&
            item.outputContractFingerprint === contract.outputContractFingerprint &&
            item.materializationProfileId === profile.materializationProfileId &&
            item.agentRuntimeId === requirement.context.agentRuntimeId &&
            item.targetContextSchemaFingerprint === requirement.context.targetContextSchemaFingerprint &&
            item.assetKind === requirement.assetKind &&
            item.renderStrategy === requirement.renderStrategy,
    );
    const applicable = matches.filter((candidate) => {
        const predicate = predicates.get(componentKey(candidate.targetApplicabilityPredicate));
        return (
            (candidate.buildIdentity === requirement.context.buildIdentity || predicate?.allowsBuildIdentityMismatch === true) &&
            predicate?.evaluate(requirement.context) === true
        );
    });
    return applicable.length === 1;
}

function conformanceKey(item: ConsumerOutputContractConformanceV1): string {
    const { conformanceFingerprint: _fingerprint, ...preimage } = item;
    return stableStringify(preimage);
}

function componentKey(ref: VersionedContractComponentRef): string {
    return `${ref.componentId}\0${ref.componentVersion}\0${ref.configFingerprint}`;
}

function requireComponent(ref: VersionedContractComponentRef, label: string): void {
    requireText(ref.componentId, `${label}.componentId`);
    if (!Number.isInteger(ref.componentVersion) || ref.componentVersion < 1) {
        throw new Error(`${label}.componentVersion must be positive`);
    }
    if (!isSha256Digest(ref.configFingerprint)) {
        throw new Error(`${label}.configFingerprint must be SHA-256`);
    }
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string, label: string): Map<string, T> {
    const result = new Map<string, T>();
    for (const value of values) {
        const key = keyOf(value);
        if (result.has(key)) throw new Error(`duplicate ${label}: ${key}`);
        result.set(key, value);
    }
    return result;
}

function requireText(value: string, label: string): void {
    if (value.length === 0 || value.trim() !== value || value.includes("\0")) {
        throw new Error(`${label} must be canonical non-blank text`);
    }
}

const SOURCE_EVIDENCE_LEVELS = new Set<string>([
    "agent_runtime_verified",
    "local_artifact",
    "source_code",
    "docs_declared",
    "user_provided",
    "agent_answer",
]);
