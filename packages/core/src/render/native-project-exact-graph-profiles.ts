/** Frozen current-exact/parent-rebase project and global graph components. */

import type {
    AdapterNativeExactGraphRenderDeclarationV1,
    AdapterNativeGlobalExactGraphRenderDeclarationV1,
    AdapterNativeProjectExactGraphRenderDeclarationV1,
    AdapterProviderSummary,
    MaterializationProfileId,
    NativeProjectExactGraphAssetKind,
} from "../contracts/source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../contracts/target-build-compatibility";
import type {
    ConsumerOutputContractConformanceV1,
    OutputContractDefinitionV1,
    VersionedContractComponentRef,
} from "../contracts/render";
import type { AgentRuntimeId, PosixRelativePath, Sha256Digest } from "../types";
import {
    computeConsumerConformanceFingerprint,
    computeMaterializationProfileConstraintFingerprint,
    computeOutputContractFingerprint,
    fingerprintDomain,
} from "../foundation/fingerprint";
import { deepFreezeChildrenFirst } from "../foundation/deep-freeze";
import { isCanonicalRelativePath } from "../foundation/validators";
import { component, requireStaticTargetFacts } from "./native-project-guidance-profiles";
import { requireComponent } from "./native-project-exact-file-profiles";

const FIXTURE_SET_DOMAIN = "oaam.render.exact-graph-fixture-set.v1";
const EXACT_GRAPH_ASSET_KINDS = new Set<NativeProjectExactGraphAssetKind>(["Rule", "Workflow", "Skill", "Subagent"]);

export interface NativeProjectExactGraphProfileDefinition {
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    assetKind: NativeProjectExactGraphAssetKind;
    nativeDialectId: string;
    targetScope: "project" | "global";
    graphValidator: VersionedContractComponentRef;
    reverseParser: VersionedContractComponentRef;
    rebaseMaterializer: VersionedContractComponentRef | null;
    canonicalMaterialization: NonNullable<AdapterNativeExactGraphRenderDeclarationV1["canonicalMaterialization"]> | null;
    restorationDialectIds: readonly string[];
    jsoncTopLevelPropertyPatch?: {
        propertyName: string;
        allowedContainerRelativePaths: readonly PosixRelativePath[];
    };
    targetContextSchemaId: string;
    requiredFacts: Readonly<Record<string, string>>;
}

export type VerifiedNativeProjectExactGraphBuild = AdapterNativeProjectExactGraphRenderDeclarationV1["verifiedBuilds"][number];
export type VerifiedNativeGlobalExactGraphBuild = AdapterNativeGlobalExactGraphRenderDeclarationV1["verifiedBuilds"][number];
export type VerifiedNativeExactGraphBuild = AdapterNativeExactGraphRenderDeclarationV1["verifiedBuilds"][number];

export interface NativeProjectExactGraphContractParts {
    profile: NativeProjectExactGraphProfileDefinition;
    components: {
        path: VersionedContractComponentRef;
        marker: VersionedContractComponentRef;
        wrapper: VersionedContractComponentRef;
        materialize: VersionedContractComponentRef;
        reverse: VersionedContractComponentRef;
    };
    outputContract: OutputContractDefinitionV1;
}

export function isNativeProjectExactGraphAssetKind(value: unknown): value is NativeProjectExactGraphAssetKind {
    return typeof value === "string" && EXACT_GRAPH_ASSET_KINDS.has(value as NativeProjectExactGraphAssetKind);
}

export function makeNativeProjectExactGraphContractParts(
    declaration: AdapterNativeExactGraphRenderDeclarationV1,
): NativeProjectExactGraphContractParts {
    if (!isNativeProjectExactGraphAssetKind(declaration.assetKind)) {
        throw new Error("native exact-graph profile has an unsupported AssetKind");
    }
    requireStaticTargetFacts(declaration.target.requiredFacts);
    const targetScope = declaration.declarationKind === "native_project_exact_graph_v1" ? "project" : "global";
    const graphValidator =
        declaration.declarationKind === "native_project_exact_graph_v1"
            ? declaration.projectGraphValidator
            : declaration.globalGraphValidator;
    requireComponent(graphValidator, `${targetScope} graph validator`);
    requireComponent(declaration.reverseParser, "reverse parser");
    if (declaration.rebaseMaterializer !== null) requireComponent(declaration.rebaseMaterializer, "rebase materializer");
    const canonicalMaterialization = declaration.canonicalMaterialization ?? null;
    if (canonicalMaterialization !== null) {
        requireComponent(canonicalMaterialization.materializer, "canonical materializer");
        requireCanonicalMaterialization(canonicalMaterialization);
    }
    requireSortedDialectIds(declaration.restorationDialectIds);
    requireJsoncTopLevelPropertyPatch(declaration.jsoncTopLevelPropertyPatch);
    if (declaration.nativeDialectId.trim() === "" || declaration.nativeDialectId.includes("\0")) {
        throw new Error("native exact-graph profile has an invalid dialect identity");
    }
    const profile: NativeProjectExactGraphProfileDefinition = deepFreezeChildrenFirst({
        materializationProfileId: declaration.materializationProfileId,
        agentRuntimeId: declaration.agentRuntimeId,
        assetKind: declaration.assetKind,
        nativeDialectId: declaration.nativeDialectId,
        targetScope,
        graphValidator: structuredClone(graphValidator),
        reverseParser: structuredClone(declaration.reverseParser),
        rebaseMaterializer: declaration.rebaseMaterializer === null ? null : structuredClone(declaration.rebaseMaterializer),
        canonicalMaterialization: canonicalMaterialization === null ? null : structuredClone(canonicalMaterialization),
        restorationDialectIds: structuredClone(declaration.restorationDialectIds),
        ...(declaration.jsoncTopLevelPropertyPatch === undefined
            ? {}
            : { jsoncTopLevelPropertyPatch: structuredClone(declaration.jsoncTopLevelPropertyPatch) }),
        targetContextSchemaId: declaration.target.targetContextSchemaId,
        requiredFacts: structuredClone(declaration.target.requiredFacts),
    });
    const prefix = `oaam.native-${targetScope}-exact-graph.${declaration.outputContractId.toLowerCase()}`;
    const pathGrammar =
        targetScope === "project"
            ? {
                  shape: "one-provider-validated-project-relative-native-file-graph",
                  assetKind: profile.assetKind,
                  nativeDialectId: profile.nativeDialectId,
                  projectGraphValidator: profile.graphValidator,
              }
            : {
                  shape: "one-provider-validated-global-relative-native-file-graph",
                  assetKind: profile.assetKind,
                  nativeDialectId: profile.nativeDialectId,
                  targetScope: profile.targetScope,
                  globalGraphValidator: profile.graphValidator,
              };
    const components = deepFreezeChildrenFirst({
        path: component(`${prefix}.path`, pathGrammar),
        marker: component(`${prefix}.marker`, { markers: "none" }),
        wrapper: component(`${prefix}.wrapper`, { wrappers: "none" }),
        materialize: component(`${prefix}.materialize`, {
            semantics: "all-required-semantics-for-one-complete-file-graph-asset",
            bytes:
                profile.canonicalMaterialization !== null
                    ? "exact-current-validated-parent-rebase-or-reviewed-canonical-migration"
                    : profile.rebaseMaterializer === null
                      ? "exact-current-native-graph"
                      : "exact-current-or-validated-immediate-parent-graph-rebase",
            nativeDialectId: profile.nativeDialectId,
            rebaseMaterializer: profile.rebaseMaterializer,
            restorationDialectIds: profile.restorationDialectIds,
            ...(profile.jsoncTopLevelPropertyPatch === undefined
                ? {}
                : { jsoncTopLevelPropertyPatch: profile.jsoncTopLevelPropertyPatch }),
            ...(profile.canonicalMaterialization === null ? {} : { canonicalMaterialization: profile.canonicalMaterialization }),
        }),
        reverse: component(`${prefix}.reverse`, {
            mode: "provider-parsed-existing-files-only",
            parser: profile.reverseParser,
            content: "reconcile",
            executable: "reconcile",
            addition: "conflict",
            deletion: "conflict",
            pathMutation: "conflict",
            nativeGraph: "validate-complete-current-target",
        }),
    });
    return deepFreezeChildrenFirst({
        profile,
        components,
        outputContract: makeOutputContract(declaration.outputContractId, profile, components),
    });
}

function makeOutputContract(
    outputContractId: string,
    profile: NativeProjectExactGraphProfileDefinition,
    components: NativeProjectExactGraphContractParts["components"],
): OutputContractDefinitionV1 {
    const constraintValidator = component(
        `oaam.native-${profile.targetScope}-exact-graph.${outputContractId.toLowerCase()}.profile.${profile.materializationProfileId}`,
        profileConfig(profile),
    );
    const materializationProfile = {
        materializationProfileId: profile.materializationProfileId,
        profileConstraintFingerprint: "" as Sha256Digest,
        constraintValidator,
    };
    const draft: OutputContractDefinitionV1 = {
        schemaVersion: 1,
        outputContractId,
        outputContractFingerprint: "" as Sha256Digest,
        pathAndFileGrammar: components.path,
        markerAndSectionGrammar: components.marker,
        generatedWrapperGrammar: components.wrapper,
        materializationValidator: components.materialize,
        reverseInspectionValidator: components.reverse,
        materializationProfiles: [materializationProfile],
    };
    const { outputContractFingerprint: _stored, ...preimage } = draft;
    draft.outputContractFingerprint = computeOutputContractFingerprint(preimage);
    materializationProfile.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
        outputContractFingerprint: draft.outputContractFingerprint,
        materializationProfileId: profile.materializationProfileId,
        constraintValidator,
    });
    return deepFreezeChildrenFirst(draft);
}

export function makeExactGraphApplicabilityPredicateRef(
    build: VerifiedNativeExactGraphBuild,
    targetScope: NativeProjectExactGraphProfileDefinition["targetScope"] = "project",
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1,
): VersionedContractComponentRef {
    const prefix = targetScope === "project" ? "oaam.native-project-exact-graph" : "oaam.native-global-exact-graph";
    const common = {
        agentRuntimeId: build.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        platform: build.platform,
        materializationProfileId: build.materializationProfileId,
        ...(buildCompatibility === undefined ? {} : { buildCompatibility }),
    };
    return component(
        `${prefix}.applicability.${build.agentRuntimeId.toLowerCase()}.${build.versionText}`,
        targetScope === "project" ? common : { ...common, targetScope },
    );
}

export function makeExactGraphConsumerConformance(
    provider: AdapterProviderSummary,
    declaration: AdapterNativeExactGraphRenderDeclarationV1,
    build: VerifiedNativeExactGraphBuild,
): ConsumerOutputContractConformanceV1 {
    const { profile, outputContract } = makeNativeProjectExactGraphContractParts(declaration);
    const descriptor = provider.agentRuntimes.find((entry) => entry.agentRuntimeId === build.agentRuntimeId);
    const schema = provider.targetContextSchemas.find(
        (entry) => entry.agentRuntimeId === build.agentRuntimeId && entry.targetContextSchemaId === profile.targetContextSchemaId,
    );
    if (descriptor === undefined || schema === undefined)
        throw new Error("verified native exact-graph conformance is incomplete");
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileId: build.materializationProfileId,
        agentRuntimeId: build.agentRuntimeId,
        buildIdentity: build.buildIdentity,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        targetApplicabilityPredicate: makeExactGraphApplicabilityPredicateRef(
            build,
            profile.targetScope,
            declaration.buildCompatibility,
        ),
        assetKind: declaration.assetKind,
        renderStrategy: "native_graph" as const,
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

export function createVerifiedNativeProjectExactGraphBuild(
    input: Omit<VerifiedNativeProjectExactGraphBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        assetKind: NativeProjectExactGraphAssetKind;
        nativeDialectId: string;
        projectGraphValidator: VersionedContractComponentRef;
        reverseParser: VersionedContractComponentRef;
        rebaseMaterializer: VersionedContractComponentRef | null;
        canonicalMaterialization?: AdapterNativeExactGraphRenderDeclarationV1["canonicalMaterialization"];
        restorationDialectIds: readonly string[];
        jsoncTopLevelPropertyPatch?: AdapterNativeExactGraphRenderDeclarationV1["jsoncTopLevelPropertyPatch"];
        parentRebaseFixtureId: string;
        targetGraphIdentity: PosixRelativePath;
        targetRelativePaths: PosixRelativePath[];
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeProjectExactGraphBuild {
    const { projectGraphValidator, ...build } = input;
    return createVerifiedNativeExactGraphBuild(build, "project", projectGraphValidator);
}

export function createVerifiedNativeGlobalExactGraphBuild(
    input: Omit<VerifiedNativeGlobalExactGraphBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        assetKind: NativeProjectExactGraphAssetKind;
        nativeDialectId: string;
        globalGraphValidator: VersionedContractComponentRef;
        reverseParser: VersionedContractComponentRef;
        rebaseMaterializer: VersionedContractComponentRef | null;
        canonicalMaterialization?: AdapterNativeExactGraphRenderDeclarationV1["canonicalMaterialization"];
        restorationDialectIds: readonly string[];
        jsoncTopLevelPropertyPatch?: AdapterNativeExactGraphRenderDeclarationV1["jsoncTopLevelPropertyPatch"];
        parentRebaseFixtureId: string;
        targetGraphIdentity: PosixRelativePath;
        targetRelativePaths: PosixRelativePath[];
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeGlobalExactGraphBuild {
    const { globalGraphValidator, ...build } = input;
    return createVerifiedNativeExactGraphBuild(build, "global", globalGraphValidator);
}

function createVerifiedNativeExactGraphBuild(
    input: Omit<VerifiedNativeExactGraphBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        assetKind: NativeProjectExactGraphAssetKind;
        nativeDialectId: string;
        reverseParser: VersionedContractComponentRef;
        rebaseMaterializer: VersionedContractComponentRef | null;
        canonicalMaterialization?: AdapterNativeExactGraphRenderDeclarationV1["canonicalMaterialization"];
        restorationDialectIds: readonly string[];
        jsoncTopLevelPropertyPatch?: AdapterNativeExactGraphRenderDeclarationV1["jsoncTopLevelPropertyPatch"];
        parentRebaseFixtureId: string;
        targetGraphIdentity: PosixRelativePath;
        targetRelativePaths: PosixRelativePath[];
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
    targetScope: "project" | "global",
    graphValidator: VersionedContractComponentRef,
): VerifiedNativeExactGraphBuild {
    const {
        fixtureId,
        assetKind,
        nativeDialectId,
        reverseParser,
        rebaseMaterializer,
        canonicalMaterialization,
        restorationDialectIds,
        jsoncTopLevelPropertyPatch,
        parentRebaseFixtureId,
        targetGraphIdentity,
        targetRelativePaths,
        exactLoadMarker,
        reverseFixtureId,
        ...build
    } = input;
    if (!isNativeProjectExactGraphAssetKind(assetKind)) throw new Error("exact-graph fixture AssetKind is unsupported");
    requireComponent(graphValidator, `${targetScope} graph validator`);
    requireComponent(reverseParser, "reverse parser");
    if (rebaseMaterializer !== null) requireComponent(rebaseMaterializer, "rebase materializer");
    if (canonicalMaterialization !== undefined) {
        requireComponent(canonicalMaterialization.materializer, "canonical materializer");
        requireCanonicalMaterialization(canonicalMaterialization);
    }
    requireSortedDialectIds(restorationDialectIds);
    return {
        ...build,
        fixtureSetFingerprint: fingerprintDomain(FIXTURE_SET_DOMAIN, {
            fixtureId,
            agentRuntimeId: input.agentRuntimeId,
            versionText: input.versionText,
            buildIdentity: input.buildIdentity,
            platform: input.platform,
            materializationProfileId: input.materializationProfileId,
            assetKind,
            nativeDialectId,
            ...(targetScope === "project"
                ? { projectGraphValidator: graphValidator }
                : { targetScope, globalGraphValidator: graphValidator }),
            reverseParser,
            rebaseMaterializer,
            ...(canonicalMaterialization === undefined ? {} : { canonicalMaterialization }),
            restorationDialectIds,
            ...(jsoncTopLevelPropertyPatch === undefined ? {} : { jsoncTopLevelPropertyPatch }),
            parentRebaseFixtureId,
            targetGraphIdentity,
            targetRelativePaths,
            exactLoadMarker,
            reverseFixtureId,
            evidenceLevel: "agent_runtime_verified",
            l3: "passed",
            l4: "contract_fixture_passed",
        }),
    };
}

export function profileConfig(profile: NativeProjectExactGraphProfileDefinition) {
    const common = {
        materializationProfileId: profile.materializationProfileId,
        agentRuntimeId: profile.agentRuntimeId,
        assetKind: profile.assetKind,
        nativeDialectId: profile.nativeDialectId,
        reverseParser: profile.reverseParser,
        rebaseMaterializer: profile.rebaseMaterializer,
        ...(profile.canonicalMaterialization === null ? {} : { canonicalMaterialization: profile.canonicalMaterialization }),
        restorationDialectIds: profile.restorationDialectIds,
        ...(profile.jsoncTopLevelPropertyPatch === undefined
            ? {}
            : { jsoncTopLevelPropertyPatch: profile.jsoncTopLevelPropertyPatch }),
        targetContextSchemaId: profile.targetContextSchemaId,
        requiredFacts: profile.requiredFacts,
    };
    return profile.targetScope === "project"
        ? { ...common, projectGraphValidator: profile.graphValidator }
        : { ...common, targetScope: profile.targetScope, globalGraphValidator: profile.graphValidator };
}

function requireCanonicalMaterialization(
    value: NonNullable<AdapterNativeExactGraphRenderDeclarationV1["canonicalMaterialization"]>,
): void {
    if (value.preservationDialectIds !== undefined) {
        requireSortedDialectIds(value.preservationDialectIds);
        if (value.preservationDialectIds.length === 0) throw new Error("native preservation dialect ids must not be empty");
    }
    if (
        (value.assessesLoss !== undefined && value.assessesLoss !== true) ||
        (value.requiresNativeSourceAssessment !== undefined &&
            (value.requiresNativeSourceAssessment !== true ||
                value.assessesLoss !== true ||
                value.preservationDialectIds === undefined)) ||
        !Array.isArray(value.degradationKinds) ||
        value.degradationKinds.length === 0 ||
        new Set(value.degradationKinds).size !== value.degradationKinds.length ||
        value.degradationKinds.some((kind, index) => index > 0 && (value.degradationKinds[index - 1] as string) >= kind) ||
        typeof value.reasonCode !== "string" ||
        value.reasonCode.trim() !== value.reasonCode ||
        value.reasonCode.length === 0 ||
        value.reasonCode.includes("\0") ||
        (value.substituteAssetKind !== undefined &&
            (!value.degradationKinds.includes("target_runtime_missing_asset_kind") ||
                !["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"].includes(value.substituteAssetKind)))
    ) {
        throw new Error("native exact-graph canonical materialization declaration is invalid");
    }
}

function requireSortedDialectIds(values: readonly string[]): void {
    if (
        !Array.isArray(values) ||
        values.some(
            (value) => typeof value !== "string" || value.trim() !== value || value.length === 0 || value.includes("\0"),
        ) ||
        values.some((value, index) => index > 0 && (values[index - 1] as string) >= value)
    ) {
        throw new Error("native exact-graph restoration dialect ids must be sorted unique non-blank ids");
    }
}

function requireJsoncTopLevelPropertyPatch(
    value: AdapterNativeExactGraphRenderDeclarationV1["jsoncTopLevelPropertyPatch"],
): void {
    if (value === undefined) return;
    if (
        value.propertyName.trim() === "" ||
        value.propertyName !== value.propertyName.trim() ||
        value.propertyName.includes("\0") ||
        !Array.isArray(value.allowedContainerRelativePaths) ||
        value.allowedContainerRelativePaths.length === 0 ||
        new Set(value.allowedContainerRelativePaths).size !== value.allowedContainerRelativePaths.length ||
        value.allowedContainerRelativePaths.some(
            (path, index) =>
                !isCanonicalRelativePath(path) ||
                (index > 0 && (value.allowedContainerRelativePaths[index - 1] as string) >= path),
        )
    ) {
        throw new Error("native exact-graph JSONC property patch declaration is invalid");
    }
}
