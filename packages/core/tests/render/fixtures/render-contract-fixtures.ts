import { computeTargetContextSchemaFingerprint } from "../../../src/adapters/adapter-contract-validator";
import type { RenderOutcomeDetailsV1, RenderOutputUnit } from "../../../src/contracts/deployment-authority";
import type {
    AdapterRenderAnalysisResult,
    ConsumerOutputContractConformanceV1,
    OutputContractDefinitionV1,
    RenderAnalysisInput,
    RenderAssetInput,
    RenderDeploymentInput,
    SemanticRenderOption,
    TargetAgentRuntimeRenderContext,
    VersionedContractComponentRef,
} from "../../../src/contracts/render";
import {
    computeConsumerConformanceFingerprint,
    computeMaterializationProfileConstraintFingerprint,
    computeOutputContractFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeRenderApprovalFingerprint,
    computeRenderDegradationFingerprint,
    computeRenderInputFingerprint,
    computeRenderOptionFingerprint,
    computeRenderOutputUnitFingerprint,
    computeReverseInspectionCoverageFingerprint,
    computeSemanticCoverageFingerprint,
    computeTargetApplicabilityFingerprint,
} from "../../../src/foundation/fingerprint";
import { createRenderRegistry, type RenderRegistrySnapshot } from "../../../src/render/render-registry";
import type { AdapterId, AdapterProviderSummary, AgentRuntimeId, AssetKind, OperationDiagnostic } from "../../../src/types";
import { ASSET_ID, FILE_ID, makeVersionClosure, VERSION_ID } from "../../catalog/fixtures/version-v2";

export const RENDER_ADAPTER_ID = "RENDER_FIXTURE" as AdapterId;
export const RENDER_RUNTIME_ID = "RENDER_FIXTURE_CLI" as AgentRuntimeId;
export const RENDER_DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
export const RENDER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const OUTPUT_CONTRACT_ID = "OAAM_TEST_MARKDOWN_V1";
export const MATERIALIZER_KEY = "oaam.test.markdown.materializer";
export const PROFILE_ID = "default";

const HASH_1 = `sha256:${"1".repeat(64)}` as const;
const HASH_2 = `sha256:${"2".repeat(64)}` as const;
const HASH_3 = `sha256:${"3".repeat(64)}` as const;
const HASH_4 = `sha256:${"4".repeat(64)}` as const;
const HASH_5 = `sha256:${"5".repeat(64)}` as const;
const HASH_6 = `sha256:${"6".repeat(64)}` as const;

export function component(id: string, hash = HASH_1): VersionedContractComponentRef {
    return { componentId: id, componentVersion: 1, configFingerprint: hash };
}

export function makeOutputContract(): OutputContractDefinitionV1 {
    const contract: OutputContractDefinitionV1 = {
        schemaVersion: 1,
        outputContractId: OUTPUT_CONTRACT_ID,
        outputContractFingerprint: HASH_1,
        pathAndFileGrammar: component("oaam.test.path", HASH_1),
        markerAndSectionGrammar: component("oaam.test.marker", HASH_2),
        generatedWrapperGrammar: component("oaam.test.wrapper", HASH_3),
        materializationValidator: component("oaam.test.materialize", HASH_4),
        reverseInspectionValidator: component("oaam.test.reverse", HASH_5),
        materializationProfiles: [
            {
                materializationProfileId: PROFILE_ID,
                profileConstraintFingerprint: HASH_1,
                constraintValidator: component("oaam.test.profile", HASH_6),
            },
        ],
    };
    const { outputContractFingerprint: _stored, ...contractPreimage } = contract;
    contract.outputContractFingerprint = computeOutputContractFingerprint(contractPreimage);
    contract.materializationProfiles[0]!.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
        outputContractFingerprint: contract.outputContractFingerprint,
        materializationProfileId: PROFILE_ID,
        constraintValidator: contract.materializationProfiles[0]!.constraintValidator,
    });
    return contract;
}

export function makeProviderSummary(
    input: {
        adapterId?: AdapterId;
        agentRuntimeId?: AgentRuntimeId;
        version?: string;
        enabled?: boolean;
        kinds?: AssetKind[];
        strategies?: Array<"native_import" | "inline" | "reference_with_intro">;
        contract?: OutputContractDefinitionV1;
    } = {},
): AdapterProviderSummary {
    const adapterId = input.adapterId ?? RENDER_ADAPTER_ID;
    const agentRuntimeId = input.agentRuntimeId ?? RENDER_RUNTIME_ID;
    const contract = input.contract ?? makeOutputContract();
    const kinds = input.kinds ?? ["Guidance"];
    const strategies = input.strategies ?? ["inline"];
    const agentRuntimes = [{ agentRuntimeId, displayName: `${agentRuntimeId} fixture`, entryClass: "cli" as const }];
    const schema = {
        targetContextSchemaId: `${adapterId}.target.v1`,
        schemaFingerprint: HASH_1,
        agentRuntimeId,
        factRules: [
            {
                key: "layout",
                valueKind: "canonical_string" as const,
                normalization: component("oaam.test.canonical-string", HASH_2),
            },
        ],
        diagnostics: [] as OperationDiagnostic[],
    };
    schema.schemaFingerprint = computeTargetContextSchemaFingerprint({ adapterId, agentRuntimes }, schema)!;
    return {
        adapterId,
        displayName: `Fixture ${adapterId}`,
        version: input.version ?? "1.0.0",
        enabled: input.enabled ?? true,
        agentRuntimes,
        targetContextSchemas: [schema],
        assetSourceCapabilities: [],
        assetTargetCapabilities: kinds.flatMap((assetKind) =>
            strategies.map((renderStrategy) => ({
                agentRuntimeId,
                entrySupportStatus: "supported" as const,
                assetKind,
                renderStrategy,
                outputContractId: contract.outputContractId,
                outputContractFingerprint: contract.outputContractFingerprint,
                targetContextSchemaId: schema.targetContextSchemaId,
                targetContextSchemaFingerprint: schema.schemaFingerprint,
                reverseExtractPolicy: "can_reconcile" as const,
                diagnostics: [],
            })),
        ),
        materializerCapabilities: [
            {
                materializerCapabilityKey: `${adapterId}.${MATERIALIZER_KEY}`,
                outputContractId: contract.outputContractId,
                outputContractFingerprint: contract.outputContractFingerprint,
                materializationProfileIds: [PROFILE_ID],
                diagnostics: [],
            },
        ],
        renderContractDeclarations: [],
    };
}

export function makeTargetContext(
    provider: AdapterProviderSummary,
    agentRuntimeId = provider.agentRuntimes[0]!.agentRuntimeId,
): TargetAgentRuntimeRenderContext {
    const descriptor = provider.agentRuntimes.find((item) => item.agentRuntimeId === agentRuntimeId)!;
    const schema = provider.targetContextSchemas.find((item) => item.agentRuntimeId === agentRuntimeId)!;
    const preimage = {
        schemaVersion: 1 as const,
        agentRuntimeId,
        versionText: "fixture-1.0.0",
        buildIdentity: "fixture-build-1",
        targetContextSchemaId: schema.targetContextSchemaId,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        renderFacts: [{ key: "layout", value: "markdown", evidenceLevel: "agent_runtime_verified" as const }],
    };
    return {
        ...preimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: preimage,
            entryClass: descriptor.entryClass,
        }),
    };
}

export function makeConformances(
    provider: AdapterProviderSummary,
    contract: OutputContractDefinitionV1,
): ConsumerOutputContractConformanceV1[] {
    return provider.assetTargetCapabilities.flatMap((capability) => {
        if (!("renderStrategy" in capability) || capability.entrySupportStatus !== "supported") {
            return [];
        }
        const descriptor = provider.agentRuntimes.find((entry) => entry.agentRuntimeId === capability.agentRuntimeId)!;
        const context = makeTargetContext(provider, descriptor.agentRuntimeId);
        const preimage = {
            outputContractId: contract.outputContractId,
            outputContractFingerprint: contract.outputContractFingerprint,
            materializationProfileId: PROFILE_ID,
            agentRuntimeId: capability.agentRuntimeId,
            buildIdentity: context.buildIdentity,
            targetContextSchemaFingerprint: context.targetContextSchemaFingerprint,
            targetApplicabilityPredicate: component("oaam.test.applicable", HASH_3),
            assetKind: capability.assetKind,
            renderStrategy: capability.renderStrategy,
            fixtureSetFingerprint: HASH_4,
            evidenceLevel: "agent_runtime_verified" as const,
            status: "passed" as const,
        };
        return [
            {
                ...preimage,
                conformanceFingerprint: computeConsumerConformanceFingerprint({
                    conformance: preimage,
                    entryClass: descriptor.entryClass,
                }),
            },
        ];
    });
}

export function makeRenderRegistry(
    input: {
        providers?: AdapterProviderSummary[];
        contract?: OutputContractDefinitionV1;
        predicateResult?: boolean;
        mutateMaterializationProof?: (
            proof: import("../../../src/contracts/deployment-authority").MaterializationSemanticCoverageProof,
        ) => void;
        inspectMaterializationInput?: (
            input: Parameters<
                import("../../../src/render/render-registry").MaterializationValidatorImplementation["validate"]
            >[0],
        ) => void;
        mutateReverseProof?: (proof: import("../../../src/contracts/reverse").ReverseInspectionCoverageProof) => void;
    } = {},
): RenderRegistrySnapshot {
    const contract = input.contract ?? makeOutputContract();
    const providers = input.providers ?? [makeProviderSummary({ contract })];
    return createRenderRegistry({
        providers,
        outputContracts: [contract],
        consumerConformances: providers.flatMap((provider) => makeConformances(provider, contract)),
        targetApplicabilityPredicates: [
            {
                ref: component("oaam.test.applicable", HASH_3),
                evaluate: () => input.predicateResult ?? true,
            },
        ],
        materializationValidators: [
            makeMaterializationValidator(contract, input.mutateMaterializationProof, input.inspectMaterializationInput),
        ],
        reverseInspectionValidators: [makeReverseInspectionValidator(contract, input.mutateReverseProof)],
    });
}

export function makeMaterializationValidator(
    contract: OutputContractDefinitionV1,
    mutate?: (proof: import("../../../src/contracts/deployment-authority").MaterializationSemanticCoverageProof) => void,
    inspect?: (
        input: Parameters<import("../../../src/render/render-registry").MaterializationValidatorImplementation["validate"]>[0],
    ) => void,
) {
    return {
        ref: contract.materializationValidator,
        validate(
            input: Parameters<
                import("../../../src/render/render-registry").MaterializationValidatorImplementation["validate"]
            >[0],
        ) {
            inspect?.(input);
            const coveredSemanticRefFingerprints = input.selectedSemantics
                .map((semantic) => semantic.semanticRefFingerprint)
                .sort();
            const proof = {
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                coveredSemanticRefFingerprints,
                coverageFingerprint: computeSemanticCoverageFingerprint({
                    outputContractFingerprint: input.contract.outputContractFingerprint,
                    profileConstraintFingerprint: input.profile.profileConstraintFingerprint,
                    outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                    canonicalValues: input.canonicalValues,
                    files: input.files,
                    coveredSemanticRefFingerprints,
                }),
            };
            mutate?.(proof);
            return proof;
        },
    };
}

export function makeReverseInspectionValidator(
    contract: OutputContractDefinitionV1,
    mutate?: (proof: import("../../../src/contracts/reverse").ReverseInspectionCoverageProof) => void,
) {
    return {
        ref: contract.reverseInspectionValidator,
        validate(
            input: Parameters<
                import("../../../src/render/render-registry").ReverseInspectionValidatorImplementation["validate"]
            >[0],
        ) {
            const diffHunks = input.files.flatMap((file) => file.diffHunks);
            const attributeChanges = input.files.flatMap((file) =>
                file.fileState === "baseline_changed" ? file.attributeChanges : [],
            );
            const proof = {
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                coveredHunkFingerprints: diffHunks.map((item) => item.hunkFingerprint).sort(),
                coveredAttributeChangeFingerprints: attributeChanges.map((item) => item.attributeChangeFingerprint).sort(),
                coveredInventoryDeltaFingerprints: input.inventoryDeltas.map((item) => item.inventoryDeltaFingerprint).sort(),
                coveredChangeFingerprints: input.adapterResult.changes.map((item) => item.changeFingerprint).sort(),
            };
            const completed = {
                ...proof,
                reverseCoverageFingerprint: computeReverseInspectionCoverageFingerprint({
                    outputContractFingerprint: input.contract.outputContractFingerprint,
                    outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                    inspectionScopeFingerprint: input.inspectionScopeFingerprint,
                    diffHunks,
                    attributeChanges,
                    inventoryDeltas: input.inventoryDeltas,
                    changes: input.adapterResult.changes,
                    files: input.adapterResult.files,
                    proof,
                }),
            };
            mutate?.(completed);
            return completed;
        },
    };
}

export function makeGuidanceRenderAsset(overrides: Partial<RenderAssetInput> = {}): RenderAssetInput {
    const closure = makeVersionClosure();
    return {
        scope: "global",
        projectId: "",
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId: VERSION_ID },
            versionFingerprint: closure.manifest.fingerprint,
            versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
            status: closure.manifest.status,
            canonical: {
                kind: closure.manifest.kind,
                typeData: closure.manifest.typeData,
            } as RenderAssetInput["version"]["canonical"],
            files: closure.files,
        },
        sectionHandles: { [FILE_ID]: "fixture-section" },
        ...overrides,
    };
}

export function makeRenderDeployment(
    registry: RenderRegistrySnapshot,
    provider = registry.listProviders()[0]!,
    overrides: Partial<RenderDeploymentInput> = {},
): RenderDeploymentInput {
    const preimage = {
        schemaVersion: 1 as const,
        deploymentId: RENDER_DEPLOYMENT_ID,
        consumerAgentRuntimeIds: [provider.agentRuntimes[0]!.agentRuntimeId],
        platform: "linux" as const,
        platformInstanceId: "local-linux",
        targetRootPath: "/tmp/oaam-render-target",
        projectId: "",
        targetContexts: [makeTargetContext(provider)],
        renderRegistryFingerprint: registry.fingerprint,
        assets: [makeGuidanceRenderAsset()],
        ...overrides,
    };
    return {
        ...preimage,
        renderInputFingerprint: computeRenderInputFingerprint(preimage),
    };
}

export function makeOutputUnit(
    contract: OutputContractDefinitionV1,
    relativePath = "AGENTS.md",
    managedDirectoryBoundary?: string,
    additionalClaimPaths: string[] = [],
    contentKind: "text" | "binary" = "text",
    additionalManagedDirectoryBoundaries: string[] = [],
    desiredDirectoryPaths?: string[],
): RenderOutputUnit {
    const preimage = {
        outputContractId: contract.outputContractId,
        outputContractFingerprint: contract.outputContractFingerprint,
        claims: [relativePath, ...additionalClaimPaths]
            .map((claimPath) => ({
                relativePath: claimPath,
                contentKind,
                executable: false,
            }))
            .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
        managedDirectoryBoundaries: [
            ...(managedDirectoryBoundary === undefined ? [] : [managedDirectoryBoundary]),
            ...additionalManagedDirectoryBoundaries,
        ]
            .sort()
            .map((boundaryPath) =>
                desiredDirectoryPaths !== undefined && boundaryPath === managedDirectoryBoundary
                    ? {
                          schemaVersion: 2 as const,
                          relativePath: boundaryPath,
                          boundaryKind: "directory_inventory" as const,
                          desiredDirectoryPaths: [...desiredDirectoryPaths],
                      }
                    : {
                          relativePath: boundaryPath,
                          boundaryKind: "directory_inventory" as const,
                      },
            ),
    };
    return {
        ...preimage,
        outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage),
    };
}

export function makeAnalysisResult(
    provider: AdapterProviderSummary,
    input: RenderAnalysisInput,
    contract: OutputContractDefinitionV1,
    options: {
        renderStrategy?: "native_file" | "native_import" | "inline" | "reference_with_intro";
        outcome?: "preserved" | "degraded";
        reversePolicy?: "can_reconcile" | "ignore_generated_wrapper" | "unsupported";
        relativePath?: string;
        managedDirectoryBoundary?: string;
        additionalManagedDirectoryBoundaries?: string[];
        additionalClaimPaths?: string[];
        additionalOutputUnitPaths?: string[];
        contentKind?: "text" | "binary";
        desiredDirectoryPaths?: string[];
    } = {},
): AdapterRenderAnalysisResult {
    const outputUnits = [
        makeOutputUnit(
            contract,
            options.relativePath,
            options.managedDirectoryBoundary,
            options.additionalClaimPaths,
            options.contentKind,
            options.additionalManagedDirectoryBoundaries,
            options.desiredDirectoryPaths,
        ),
        ...(options.additionalOutputUnitPaths ?? []).map((relativePath) =>
            makeOutputUnit(contract, relativePath, undefined, [], options.contentKind),
        ),
    ];
    const dialectFingerprint = computeProviderRenderDialectInputFingerprint({
        adapterId: provider.adapterId,
        adapterVersion: provider.version,
        dialectInputs: input.dialectInputs,
    });
    const semanticOptions = input.requiredSemantics.map((semantic) => {
        const renderStrategy = options.renderStrategy ?? "inline";
        const actualReverseExtractPolicy = options.reversePolicy ?? "can_reconcile";
        const reasonCode = options.outcome === "degraded" ? "fixture_degraded" : "fixture_native";
        const outcome: RenderOutcomeDetailsV1 =
            options.outcome === "degraded"
                ? {
                      outcome: "degraded",
                      degradationKinds: ["runtime_specific_metadata_lost"],
                      degradationFingerprint: HASH_1,
                  }
                : { outcome: "preserved" };
        if (outcome.outcome === "degraded") {
            outcome.degradationFingerprint = computeRenderDegradationFingerprint({
                adapterId: provider.adapterId,
                adapterVersion: provider.version,
                renderInputFingerprint: input.deployment.renderInputFingerprint,
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                renderStrategy,
                outcome,
                actualReverseExtractPolicy,
                reasonCode,
            });
        }
        const concerns = [
            ...(outcome.outcome === "degraded" ? ["semantic_degradation" as const] : []),
            ...(actualReverseExtractPolicy === "unsupported" ? ["reverse_extract_unsupported" as const] : []),
        ];
        const approvalRequirement =
            concerns.length === 0
                ? ({ approvalState: "not_required" } as const)
                : ({
                      approvalState: "required" as const,
                      concerns: concerns as [(typeof concerns)[number], ...(typeof concerns)[number][]],
                      approvalFingerprint: computeRenderApprovalFingerprint({
                          renderInputFingerprint: input.deployment.renderInputFingerprint,
                          semanticRefFingerprint: semantic.semanticRefFingerprint,
                          renderStrategy,
                          outcome,
                          actualReverseExtractPolicy,
                          concerns,
                      }),
                  } as const);
        const preimage = {
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            renderStrategy,
            actualReverseExtractPolicy,
            approvalRequirement,
            requiredOutputUnitFingerprints: outputUnits.map((outputUnit) => outputUnit.outputUnitFingerprint).sort(),
            reasonCode,
            ...outcome,
        };
        return {
            ...preimage,
            optionFingerprint: computeRenderOptionFingerprint({
                adapterId: provider.adapterId,
                adapterVersion: provider.version,
                renderInputFingerprint: input.deployment.renderInputFingerprint,
                providerRenderDialectInputFingerprint: dialectFingerprint,
                option: preimage,
            }),
            diagnostics: [],
        } as SemanticRenderOption;
    });
    return {
        status: "complete",
        outputUnits,
        semanticOptions,
        blockedSemanticRefs: [],
        diagnostics: [],
    };
}
