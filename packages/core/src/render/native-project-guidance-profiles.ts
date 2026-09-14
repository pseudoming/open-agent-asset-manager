/** Frozen native project-Guidance profiles and contract components. */

import type {
    AdapterAssetTargetCapabilityAvailable,
    AdapterMaterializerCapability,
    AdapterNativeGlobalGuidanceRenderDeclarationV1,
    AdapterNativeGuidanceRenderDeclarationV1,
    AdapterNativeProjectGuidanceRenderDeclarationV1,
    AdapterProviderSummary,
    AdapterTargetContextSchemaDeclaration,
    AgentRuntimeDescriptor,
    MaterializationProfileId,
    ProbeResult,
    SourceEvidenceLevel,
    TargetCandidate,
} from "../contracts/source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../contracts/target-build-compatibility";
import type {
    AdapterRenderAnalysisResult,
    ConsumerOutputContractConformanceV1,
    OutputContractDefinitionV1,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
    TargetAgentRuntimeRenderContext,
    VersionedContractComponentRef,
} from "../contracts/render";
import type { AdapterRenderedTargetInspectionResult, RenderedTargetInspectionInput } from "../contracts/reverse";
import type { AdapterId, AgentRuntimeId, OperationDiagnostic, PosixRelativePath, Sha256Digest } from "../types";
import {
    computeConsumerConformanceFingerprint,
    computeMaterializationProfileConstraintFingerprint,
    computeOutputContractFingerprint,
    fingerprintDomain,
} from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { deepFreezeChildrenFirst } from "../foundation/deep-freeze";
import { computeTargetContextSchemaFingerprint } from "../adapters/adapter-contract-validator";
import type { StableRegularFileRead } from "@oaam/shared/filesystem";

export { compareUtf8Bytes } from "../foundation/text-order";

const COMPONENT_CONFIG_DOMAIN = "oaam.render.component-config.v1";
const FIXTURE_SET_DOMAIN = "oaam.render.fixture-set.v1";
export const PROJECT_BINDING_FACT_KEY = "oaam.project-binding";
export const PLATFORM_FACT_KEY = "oaam.platform";
export const TARGET_KIND_FACT_KEY = "oaam.target-kind";

export interface NativeProjectGuidanceProfileDefinition {
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    relativePath: PosixRelativePath;
    targetContextSchemaId: string;
    requiredFacts: Readonly<Record<string, string>>;
    targetScope: "project" | "global";
}

export interface NativeProjectGuidanceTargetDeclaration {
    relativePath: PosixRelativePath;
    targetContextSchemaId: string;
    requiredFacts: Readonly<Record<string, string>>;
}

export type VerifiedNativeProjectGuidanceBuild = AdapterNativeProjectGuidanceRenderDeclarationV1["verifiedBuilds"][number];
export type VerifiedNativeGlobalGuidanceBuild = AdapterNativeGlobalGuidanceRenderDeclarationV1["verifiedBuilds"][number];
export type VerifiedNativeGuidanceBuild = AdapterNativeGuidanceRenderDeclarationV1["verifiedBuilds"][number];

export interface NativeProjectGuidanceProviderSupport {
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeProjectGuidanceRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}

export interface NativeGlobalGuidanceProviderSupport {
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeGlobalGuidanceRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}

export interface ResolveObservedNativeProjectGuidanceTargetContextInput {
    provider: AdapterProviderSummary;
    probeResult: ProbeResult;
    agentRuntimeId: AgentRuntimeId;
    targetRootPath: string;
    projectRootPath: string;
    /** Exact schemas advertised for the Asset kinds in this operation. */
    targetContextSchemaIds?: readonly string[];
}

export type ObservedNativeProjectGuidanceTargetContextResolution =
    | {
          status: "complete";
          targetContext: TargetAgentRuntimeRenderContext;
          diagnostics: [];
      }
    | {
          status: "failed";
          diagnostics: [OperationDiagnostic, ...OperationDiagnostic[]];
      };

export interface NativeProjectGuidanceObservationDependenciesForTest {
    verifiedBuilds: readonly VerifiedNativeProjectGuidanceBuild[];
    readBuildArtifact(filePath: string): StableRegularFileRead;
}

export interface NativeProjectGuidanceContractParts {
    profile: NativeProjectGuidanceProfileDefinition;
    components: {
        path: VersionedContractComponentRef;
        marker: VersionedContractComponentRef;
        wrapper: VersionedContractComponentRef;
        materialize: VersionedContractComponentRef;
        reverse: VersionedContractComponentRef;
    };
    outputContract: OutputContractDefinitionV1;
}

export type TrustedTargetEvidenceLevel = Extract<
    SourceEvidenceLevel,
    "agent_runtime_verified" | "local_artifact" | "user_provided"
>;

export function makeNativeProjectGuidanceContractParts(
    declaration: Pick<
        AdapterNativeGuidanceRenderDeclarationV1,
        "declarationKind" | "outputContractId" | "materializationProfileId" | "agentRuntimeId" | "target"
    >,
): NativeProjectGuidanceContractParts {
    requireStaticTargetFacts(declaration.target.requiredFacts);
    const targetScope = declaration.declarationKind === "native_project_guidance_v1" ? "project" : "global";
    const profile: NativeProjectGuidanceProfileDefinition = deepFreezeChildrenFirst({
        materializationProfileId: declaration.materializationProfileId,
        agentRuntimeId: declaration.agentRuntimeId,
        relativePath: declaration.target.relativePath,
        targetContextSchemaId: declaration.target.targetContextSchemaId,
        requiredFacts: structuredClone(declaration.target.requiredFacts),
        targetScope,
    });
    const componentPrefix = `oaam.native-${targetScope}-guidance.${declaration.outputContractId.toLowerCase()}`;
    const components = deepFreezeChildrenFirst({
        path: component(`${componentPrefix}.path`, {
            shape: "one-root-level-markdown-file",
            profile: profileConfig(profile),
        }),
        marker: component(`${componentPrefix}.marker`, { markers: "none" }),
        wrapper: component(`${componentPrefix}.wrapper`, { wrappers: "none" }),
        materialize: component(`${componentPrefix}.materialize`, {
            semantics: ["asset.file_inventory", "guidance.base_context", "guidance.content"],
            bytes: "exact-canonical-entry-text",
        }),
        reverse: component(`${componentPrefix}.reverse`, {
            mode: "whole-file-guidance-content-only",
            attributes: "conflict",
            deletion: "conflict",
        }),
    });
    const outputContract = makeOutputContract(declaration.outputContractId, profile, components);
    return deepFreezeChildrenFirst({ profile, components, outputContract });
}

export function makeOutputContract(
    outputContractId: string,
    profile: NativeProjectGuidanceProfileDefinition,
    components: NativeProjectGuidanceContractParts["components"],
): OutputContractDefinitionV1 {
    const constraintValidator = component(
        `oaam.native-${profile.targetScope}-guidance.${outputContractId.toLowerCase()}.profile.${profile.materializationProfileId}`,
        profileConfig(profile),
    );
    const profiles = [
        {
            materializationProfileId: profile.materializationProfileId,
            profileConstraintFingerprint: "" as Sha256Digest,
            constraintValidator,
        },
    ];
    const draft: OutputContractDefinitionV1 = {
        schemaVersion: 1,
        outputContractId,
        outputContractFingerprint: "" as Sha256Digest,
        pathAndFileGrammar: components.path,
        markerAndSectionGrammar: components.marker,
        generatedWrapperGrammar: components.wrapper,
        materializationValidator: components.materialize,
        reverseInspectionValidator: components.reverse,
        materializationProfiles: profiles,
    };
    const { outputContractFingerprint: _stored, ...preimage } = draft;
    draft.outputContractFingerprint = computeOutputContractFingerprint(preimage);
    for (const profile of draft.materializationProfiles) {
        profile.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
            outputContractFingerprint: draft.outputContractFingerprint,
            materializationProfileId: profile.materializationProfileId,
            constraintValidator: profile.constraintValidator,
        });
    }
    return deepFreezeChildrenFirst(draft);
}

export function makeTargetContextSchema(
    adapterId: AdapterId,
    descriptor: AgentRuntimeDescriptor,
    profile: Pick<NativeProjectGuidanceProfileDefinition, "targetContextSchemaId" | "requiredFacts">,
): AdapterTargetContextSchemaDeclaration {
    const schema: AdapterTargetContextSchemaDeclaration = {
        targetContextSchemaId: profile.targetContextSchemaId,
        schemaFingerprint: "" as Sha256Digest,
        agentRuntimeId: descriptor.agentRuntimeId,
        factRules: orderedTargetFactKeys(profile)
            .map((key) => ({
                key,
                valueKind: "canonical_string" as const,
                normalization: component("oaam.native-project-guidance.canonical-string", {
                    key,
                }),
            }))
            .sort((left, right) => compareUtf8Bytes(left.key, right.key)),
        diagnostics: [],
    };
    schema.schemaFingerprint = computeTargetContextSchemaFingerprint(
        { adapterId, agentRuntimes: [descriptor] },
        schema,
    ) as Sha256Digest;
    return schema;
}

export function applicabilityPredicateRef(
    build: VerifiedNativeGuidanceBuild,
    targetScope: NativeProjectGuidanceProfileDefinition["targetScope"] = "project",
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1,
): VersionedContractComponentRef {
    return component(
        `oaam.native-${targetScope}-guidance.applicability.${build.agentRuntimeId.toLowerCase()}.${build.versionText}`,
        {
            agentRuntimeId: build.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: build.materializationProfileId,
            ...(buildCompatibility === undefined ? {} : { buildCompatibility }),
        },
    );
}

export function makeConsumerConformance(
    provider: AdapterProviderSummary,
    declaration: AdapterNativeGuidanceRenderDeclarationV1,
    build: VerifiedNativeGuidanceBuild,
): ConsumerOutputContractConformanceV1 {
    const { profile, outputContract } = makeNativeProjectGuidanceContractParts(declaration);
    const descriptor = provider.agentRuntimes.find((entry) => entry.agentRuntimeId === build.agentRuntimeId);
    const schema = provider.targetContextSchemas.find(
        (entry) => entry.agentRuntimeId === build.agentRuntimeId && entry.targetContextSchemaId === profile.targetContextSchemaId,
    );
    if (descriptor === undefined || schema === undefined) {
        throw new Error("verified native Guidance conformance has no provider schema");
    }
    const predicate = applicabilityPredicateRef(build, profile.targetScope, declaration.buildCompatibility);
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileId: build.materializationProfileId,
        agentRuntimeId: build.agentRuntimeId,
        buildIdentity: build.buildIdentity,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        targetApplicabilityPredicate: predicate,
        assetKind: "Guidance" as const,
        renderStrategy: "native_file" as const,
        fixtureSetFingerprint: build.fixtureSetFingerprint,
        evidenceLevel: "agent_runtime_verified" as const,
        status: "passed" as const,
    };
    return {
        ...preimage,
        conformanceFingerprint: computeConsumerConformanceFingerprint({
            conformance: preimage,
            entryClass: descriptor.entryClass,
        }),
    };
}

export function createVerifiedNativeProjectGuidanceBuild(
    input: Omit<VerifiedNativeProjectGuidanceBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        targetRelativePath: PosixRelativePath;
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeProjectGuidanceBuild {
    const { fixtureId, targetRelativePath, exactLoadMarker, reverseFixtureId, ...build } = input;
    return {
        ...build,
        fixtureSetFingerprint: fingerprintDomain(FIXTURE_SET_DOMAIN, {
            fixtureId,
            agentRuntimeId: input.agentRuntimeId,
            versionText: input.versionText,
            buildIdentity: input.buildIdentity,
            platform: input.platform,
            materializationProfileId: input.materializationProfileId,
            targetRelativePath,
            exactLoadMarker,
            reverseFixtureId,
            evidenceLevel: "agent_runtime_verified",
            l3: "passed",
            l4: "contract_fixture_passed",
        }),
    };
}

export function createVerifiedNativeGlobalGuidanceBuild(
    input: Omit<VerifiedNativeGlobalGuidanceBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        targetRelativePath: PosixRelativePath;
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeGlobalGuidanceBuild {
    const { fixtureId, targetRelativePath, exactLoadMarker, reverseFixtureId, ...build } = input;
    return {
        ...build,
        fixtureSetFingerprint: fingerprintDomain(FIXTURE_SET_DOMAIN, {
            fixtureId,
            agentRuntimeId: input.agentRuntimeId,
            versionText: input.versionText,
            buildIdentity: input.buildIdentity,
            platform: input.platform,
            materializationProfileId: input.materializationProfileId,
            targetScope: "global",
            targetRelativePath,
            exactLoadMarker,
            reverseFixtureId,
            evidenceLevel: "agent_runtime_verified",
            l3: "passed",
            l4: "contract_fixture_passed",
        }),
    };
}

export function requireVerifiedBuild(
    candidate: Readonly<VerifiedNativeGuidanceBuild>,
    registeredBuilds: readonly VerifiedNativeGuidanceBuild[],
): VerifiedNativeGuidanceBuild {
    const registered = registeredBuilds.find(
        (build) =>
            build.agentRuntimeId === candidate.agentRuntimeId &&
            build.versionText === candidate.versionText &&
            build.buildIdentity === candidate.buildIdentity &&
            build.platform === candidate.platform &&
            build.materializationProfileId === candidate.materializationProfileId &&
            build.fixtureSetFingerprint === candidate.fixtureSetFingerprint,
    );
    if (registered === undefined) {
        throw new Error("native Guidance target context requires a registered verified build");
    }
    return registered;
}

export function requireProfile(
    declaration: AdapterNativeGuidanceRenderDeclarationV1,
    materializationProfileId: MaterializationProfileId,
): NativeProjectGuidanceProfileDefinition {
    if (declaration.materializationProfileId !== materializationProfileId) {
        throw new Error("unknown native project Guidance profile");
    }
    const { profile } = makeNativeProjectGuidanceContractParts(declaration);
    return profile;
}

export function findNativeProjectGuidanceDeclaration(
    provider: Pick<AdapterProviderSummary, "renderContractDeclarations">,
    agentRuntimeId: AgentRuntimeId,
): AdapterNativeProjectGuidanceRenderDeclarationV1 {
    const matches = provider.renderContractDeclarations.filter(
        (declaration): declaration is AdapterNativeProjectGuidanceRenderDeclarationV1 =>
            declaration.declarationKind === "native_project_guidance_v1" && declaration.agentRuntimeId === agentRuntimeId,
    );
    if (matches.length !== 1) {
        throw new Error("native project Guidance requires exactly one provider declaration");
    }
    return matches[0] as AdapterNativeProjectGuidanceRenderDeclarationV1;
}

export function findNativeGuidanceDeclaration(
    provider: Pick<AdapterProviderSummary, "renderContractDeclarations">,
    agentRuntimeId: AgentRuntimeId,
    targetScope: NativeProjectGuidanceProfileDefinition["targetScope"],
): AdapterNativeGuidanceRenderDeclarationV1 {
    const declarationKind = targetScope === "project" ? "native_project_guidance_v1" : "native_global_guidance_v1";
    const matches = provider.renderContractDeclarations.filter(
        (declaration): declaration is AdapterNativeGuidanceRenderDeclarationV1 =>
            declaration.declarationKind === declarationKind && declaration.agentRuntimeId === agentRuntimeId,
    );
    if (matches.length !== 1) throw new Error(`native ${targetScope} Guidance requires exactly one provider declaration`);
    return matches[0] as AdapterNativeGuidanceRenderDeclarationV1;
}

export function profileConfig(profile: NativeProjectGuidanceProfileDefinition) {
    const base = {
        materializationProfileId: profile.materializationProfileId,
        agentRuntimeId: profile.agentRuntimeId,
        relativePath: profile.relativePath,
        targetContextSchemaId: profile.targetContextSchemaId,
        requiredFacts: profile.requiredFacts,
    };
    return profile.targetScope === "project" ? base : { ...base, targetScope: profile.targetScope };
}

export function orderedRequiredFacts(profile: Pick<NativeProjectGuidanceProfileDefinition, "requiredFacts">): [string, string][] {
    return Object.entries(profile.requiredFacts).sort(([left], [right]) => compareUtf8Bytes(left, right));
}

export function orderedTargetFactKeys(profile: Pick<NativeProjectGuidanceProfileDefinition, "requiredFacts">): string[] {
    return [PLATFORM_FACT_KEY, ...Object.keys(profile.requiredFacts)].sort(compareUtf8Bytes);
}

export function requireStaticTargetFacts(requiredFacts: Readonly<Record<string, string>>): void {
    if (Object.hasOwn(requiredFacts, PLATFORM_FACT_KEY)) {
        throw new Error("oaam.platform is build-bound and must not be duplicated as a static target fact");
    }
    const targetKind = requiredFacts[TARGET_KIND_FACT_KEY];
    if (targetKind !== undefined && !isExplicitTargetKind(targetKind)) {
        throw new Error("oaam.target-kind must name an explicit physical target kind");
    }
}

export function declarationAcceptsTargetKind(
    declaration: { target: { requiredFacts: Readonly<Record<string, string>> } },
    targetKind: TargetCandidate["targetKind"],
): boolean {
    const declared = declaration.target.requiredFacts[TARGET_KIND_FACT_KEY];
    if (declared !== undefined) return declared === targetKind;
    return targetKind === "project" || targetKind === "global";
}

function isExplicitTargetKind(value: string): value is Exclude<TargetCandidate["targetKind"], "unknown"> {
    return value === "project" || value === "global" || value === "directory";
}

export function component(componentId: string, config: unknown): VersionedContractComponentRef {
    return {
        componentId,
        componentVersion: 1,
        configFingerprint: fingerprintDomain(COMPONENT_CONFIG_DOMAIN, {
            componentId,
            componentVersion: 1,
            config,
        }),
    };
}

export function diagnostic(
    operation: OperationDiagnostic["operation"],
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    severity: OperationDiagnostic["severity"],
): OperationDiagnostic {
    return {
        severity,
        code,
        message,
        path: "",
        traceId: "",
        operation,
        causeKind,
        retryable: false,
        suggestedActions: severity === "error" ? ["skip"] : [],
        rawSummary: "",
    };
}
