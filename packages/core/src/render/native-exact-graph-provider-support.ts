/** Provider-owned construction for scope-bound exact graph support. */

import type {
    AdapterAssetTargetCapabilityAvailable,
    AdapterMaterializerCapability,
    AdapterNativeExactGraphRenderDeclarationV1,
    AdapterNativeGlobalExactGraphRenderDeclarationV1,
    AdapterNativeProjectExactGraphRenderDeclarationV1,
    AgentRuntimeDescriptor,
    MaterializationProfileId,
    MaterializerCapabilityKey,
    NativeProjectExactGraphAssetKind,
} from "../contracts/source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../contracts/target-build-compatibility";
import type {
    AdapterRenderAnalysisResult,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
    RenderNativeRepresentationFileInput,
    VersionedContractComponentRef,
    AdapterCanonicalMaterializationValidatorV1,
} from "../contracts/render";
import type { AdapterRenderedTargetInspectionResult, RenderedTargetInspectionInput } from "../contracts/reverse";
import type { AdapterId, AgentRuntimeId } from "../types";
import { deepFreezeChildrenFirst } from "../foundation/deep-freeze";
import { makeTargetContextSchema } from "./native-project-guidance-profiles";
import {
    analyzeNativeProjectExactGraph,
    inspectNativeProjectExactGraph,
    materializeNativeProjectExactGraph,
} from "./native-project-exact-graph-behavior";
import type {
    NativeProjectExactGraphProviderBehavior,
    NativeProjectExactGraphCanonicalMaterializer,
    NativeProjectExactGraphProjection,
    NativeProjectExactGraphRebaseMaterializer,
} from "./native-project-exact-graph-results";
import {
    type VerifiedNativeExactGraphBuild,
    type VerifiedNativeGlobalExactGraphBuild,
    type VerifiedNativeProjectExactGraphBuild,
    makeNativeProjectExactGraphContractParts,
} from "./native-project-exact-graph-profiles";

export interface NativeProjectExactGraphProviderSupport {
    canonicalMaterializationValidators: readonly AdapterCanonicalMaterializationValidatorV1[];
    targetContextSchema: ReturnType<typeof makeTargetContextSchema>;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeProjectExactGraphRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}

export interface NativeGlobalExactGraphProviderSupport {
    canonicalMaterializationValidators: readonly AdapterCanonicalMaterializationValidatorV1[];
    targetContextSchema: ReturnType<typeof makeTargetContextSchema>;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeGlobalExactGraphRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}

export interface NativeProjectExactGraphComponent {
    ref: VersionedContractComponentRef;
}

export interface NativeGlobalExactGraphComponent {
    ref: VersionedContractComponentRef;
    validate(files: readonly RenderNativeRepresentationFileInput[]): NativeProjectExactGraphProjection | null;
}

export function createNativeProjectExactGraphProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    assetKind: NativeProjectExactGraphAssetKind;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    materializerCapabilityKey?: MaterializerCapabilityKey;
    nativeDialectId: string;
    projectGraphValidator: NativeProjectExactGraphComponent & {
        project(files: readonly RenderNativeRepresentationFileInput[]): NativeProjectExactGraphProjection | null;
    };
    reverseParser: NativeProjectExactGraphComponent & {
        parse: NativeProjectExactGraphProviderBehavior["parseChangedNativeFile"];
    };
    rebaseMaterializer: NativeProjectExactGraphRebaseMaterializer | null;
    canonicalMaterializer?: NativeProjectExactGraphCanonicalMaterializer;
    restorationDialectIds: readonly string[];
    jsoncTopLevelPropertyPatch?: AdapterNativeExactGraphRenderDeclarationV1["jsoncTopLevelPropertyPatch"];
    target: { targetContextSchemaId: string; requiredFacts: Readonly<Record<string, string>> };
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeProjectExactGraphBuild[];
}): NativeProjectExactGraphProviderSupport {
    const { projectGraphValidator, ...common } = input;
    return createNativeExactGraphProviderSupport({
        ...common,
        targetScope: "project",
        graphValidator: { ref: projectGraphValidator.ref, validate: projectGraphValidator.project },
    }) as NativeProjectExactGraphProviderSupport;
}

export function createNativeGlobalExactGraphProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    assetKind: NativeProjectExactGraphAssetKind;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    materializerCapabilityKey?: MaterializerCapabilityKey;
    nativeDialectId: string;
    globalGraphValidator: NativeGlobalExactGraphComponent;
    reverseParser: NativeProjectExactGraphComponent & {
        parse: NativeProjectExactGraphProviderBehavior["parseChangedNativeFile"];
    };
    rebaseMaterializer: NativeProjectExactGraphRebaseMaterializer | null;
    canonicalMaterializer?: NativeProjectExactGraphCanonicalMaterializer;
    restorationDialectIds: readonly string[];
    jsoncTopLevelPropertyPatch?: AdapterNativeExactGraphRenderDeclarationV1["jsoncTopLevelPropertyPatch"];
    target: { targetContextSchemaId: string; requiredFacts: Readonly<Record<string, string>> };
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeGlobalExactGraphBuild[];
}): NativeGlobalExactGraphProviderSupport {
    const { globalGraphValidator, ...common } = input;
    return createNativeExactGraphProviderSupport({
        ...common,
        targetScope: "global",
        graphValidator: globalGraphValidator,
    }) as NativeGlobalExactGraphProviderSupport;
}

function createNativeExactGraphProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    assetKind: NativeProjectExactGraphAssetKind;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    materializerCapabilityKey?: MaterializerCapabilityKey;
    nativeDialectId: string;
    targetScope: "project" | "global";
    graphValidator: NativeProjectExactGraphComponent & {
        validate(files: readonly RenderNativeRepresentationFileInput[]): NativeProjectExactGraphProjection | null;
    };
    reverseParser: NativeProjectExactGraphComponent & {
        parse: NativeProjectExactGraphProviderBehavior["parseChangedNativeFile"];
    };
    rebaseMaterializer: NativeProjectExactGraphRebaseMaterializer | null;
    canonicalMaterializer?: NativeProjectExactGraphCanonicalMaterializer;
    restorationDialectIds: readonly string[];
    jsoncTopLevelPropertyPatch?: AdapterNativeExactGraphRenderDeclarationV1["jsoncTopLevelPropertyPatch"];
    target: { targetContextSchemaId: string; requiredFacts: Readonly<Record<string, string>> };
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeExactGraphBuild[];
}): NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport {
    if (
        typeof input.graphValidator.validate !== "function" ||
        typeof input.reverseParser.parse !== "function" ||
        (input.canonicalMaterializer !== undefined &&
            (typeof input.canonicalMaterializer.materialize !== "function" ||
                typeof input.canonicalMaterializer.validateEntry !== "function" ||
                (input.canonicalMaterializer.assessLoss !== undefined &&
                    typeof input.canonicalMaterializer.assessLoss !== "function")))
    ) {
        throw new Error("native exact-graph support requires Provider-owned graph and parser implementations");
    }
    const declarationBase = {
        schemaVersion: 1,
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        agentRuntimeId: input.agentRuntimeId,
        assetKind: input.assetKind,
        nativeDialectId: input.nativeDialectId,
        reverseParser: structuredClone(input.reverseParser.ref),
        rebaseMaterializer: input.rebaseMaterializer === null ? null : structuredClone(input.rebaseMaterializer.ref),
        ...(input.canonicalMaterializer === undefined
            ? {}
            : {
                  canonicalMaterialization: {
                      materializer: structuredClone(input.canonicalMaterializer.ref),
                      degradationKinds: structuredClone(input.canonicalMaterializer.degradationKinds),
                      ...(input.canonicalMaterializer.substituteAssetKind === undefined
                          ? {}
                          : { substituteAssetKind: input.canonicalMaterializer.substituteAssetKind }),
                      reasonCode: input.canonicalMaterializer.reasonCode,
                      ...(input.canonicalMaterializer.assessLoss === undefined ? {} : { assessesLoss: true as const }),
                      ...(input.canonicalMaterializer.requiresNativeSourceAssessment === undefined
                          ? {}
                          : { requiresNativeSourceAssessment: input.canonicalMaterializer.requiresNativeSourceAssessment }),
                      ...(input.canonicalMaterializer.preservationDialectIds === undefined
                          ? {}
                          : {
                                preservationDialectIds: structuredClone(input.canonicalMaterializer.preservationDialectIds),
                            }),
                  },
              }),
        restorationDialectIds: structuredClone([...input.restorationDialectIds]),
        ...(input.jsoncTopLevelPropertyPatch === undefined
            ? {}
            : { jsoncTopLevelPropertyPatch: structuredClone(input.jsoncTopLevelPropertyPatch) }),
        target: structuredClone(input.target),
        ...(input.buildCompatibility === undefined ? {} : { buildCompatibility: structuredClone(input.buildCompatibility) }),
        verifiedBuilds: structuredClone([...input.verifiedBuilds]),
    } as const;
    const renderContractDeclaration: AdapterNativeExactGraphRenderDeclarationV1 = deepFreezeChildrenFirst(
        input.targetScope === "project"
            ? {
                  ...declarationBase,
                  declarationKind: "native_project_exact_graph_v1" as const,
                  projectGraphValidator: structuredClone(input.graphValidator.ref),
              }
            : {
                  ...declarationBase,
                  declarationKind: "native_global_exact_graph_v1" as const,
                  globalGraphValidator: structuredClone(input.graphValidator.ref),
              },
    );
    const { profile, outputContract } = makeNativeProjectExactGraphContractParts(renderContractDeclaration);
    const descriptor = input.agentRuntimes.find((entry) => entry.agentRuntimeId === input.agentRuntimeId);
    if (descriptor === undefined) throw new Error("native exact-graph support references an unknown agent runtime");
    if (
        input.verifiedBuilds.length === 0 ||
        input.verifiedBuilds.some(
            (build) =>
                build.agentRuntimeId !== input.agentRuntimeId ||
                build.materializationProfileId !== input.materializationProfileId,
        )
    ) {
        throw new Error("native exact-graph verified builds do not belong to the declaration");
    }
    const targetContextSchema = makeTargetContextSchema(input.adapterId, descriptor, profile);
    const targetCapability: AdapterAssetTargetCapabilityAvailable = {
        agentRuntimeId: input.agentRuntimeId,
        entrySupportStatus: "supported",
        assetKind: input.assetKind,
        renderStrategy: "native_graph",
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        targetContextSchemaId: targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: targetContextSchema.schemaFingerprint,
        reverseExtractPolicy: "can_reconcile",
        diagnostics: [],
    };
    const materializerCapabilityKey =
        input.materializerCapabilityKey ??
        `${input.adapterId.toLowerCase()}.${input.targetScope}-${input.assetKind.toLowerCase()}-exact-graph-v1`;
    if (
        materializerCapabilityKey.trim() === "" ||
        materializerCapabilityKey.trim() !== materializerCapabilityKey ||
        materializerCapabilityKey.includes("\0")
    ) {
        throw new Error("native exact-graph materializer capability key must be canonical non-blank text");
    }
    const materializerCapability: AdapterMaterializerCapability = {
        materializerCapabilityKey,
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileIds: [input.materializationProfileId],
        diagnostics: [],
    };
    const [materializationProfile] = outputContract.materializationProfiles as [
        (typeof outputContract.materializationProfiles)[number],
    ];
    const behavior: NativeProjectExactGraphProviderBehavior = {
        adapterId: input.adapterId,
        adapterVersion: input.adapterVersion,
        profile,
        profileConstraintFingerprint: materializationProfile.profileConstraintFingerprint,
        targetContextSchema,
        materializerCapability,
        outputContract,
        projectNativeGraph: input.graphValidator.validate,
        parseChangedNativeFile: input.reverseParser.parse,
        rebaseMaterializer: input.rebaseMaterializer,
        canonicalMaterializer: input.canonicalMaterializer ?? null,
    };
    return {
        canonicalMaterializationValidators:
            input.canonicalMaterializer === undefined
                ? []
                : [
                      {
                          outputContractId: input.outputContractId,
                          materializationProfileId: input.materializationProfileId,
                          materializer: structuredClone(input.canonicalMaterializer.ref),
                          validateEntry: input.canonicalMaterializer.validateEntry,
                          ...(input.canonicalMaterializer.assessLoss === undefined
                              ? {}
                              : { assessLoss: input.canonicalMaterializer.assessLoss }),
                      },
                  ],
        targetContextSchema,
        targetCapability,
        materializerCapability,
        renderContractDeclaration,
        analyze: (value) => analyzeNativeProjectExactGraph(value, behavior),
        materialize: (value) => materializeNativeProjectExactGraph(value, behavior),
        inspect: (value) => inspectNativeProjectExactGraph(value, behavior),
    } as NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport;
}
