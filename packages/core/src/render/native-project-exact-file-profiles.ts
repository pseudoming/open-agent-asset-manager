/** Frozen current-exact/parent-rebase project-file profiles and contract components. */

import type {
    AdapterNativeProjectExactFileRenderDeclarationV1,
    AdapterProviderSummary,
    MaterializationProfileId,
    NativeProjectExactFileAssetKind,
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
import { isSha256Digest } from "../foundation/validators";
import { component, makeTargetContextSchema, requireStaticTargetFacts } from "./native-project-guidance-profiles";

const FIXTURE_SET_DOMAIN = "oaam.render.fixture-set.v1";
const EXACT_FILE_ASSET_KINDS = new Set<NativeProjectExactFileAssetKind>(["Rule", "Workflow", "Skill", "Subagent", "Memory"]);

export interface NativeProjectExactFileProfileDefinition {
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    assetKind: NativeProjectExactFileAssetKind;
    nativeDialectId: string;
    projectPathValidator: VersionedContractComponentRef;
    reverseParser: VersionedContractComponentRef;
    rebaseMaterializer: VersionedContractComponentRef | null;
    restorationDialectIds: readonly string[];
    targetContextSchemaId: string;
    requiredFacts: Readonly<Record<string, string>>;
}

export type VerifiedNativeProjectExactFileBuild = AdapterNativeProjectExactFileRenderDeclarationV1["verifiedBuilds"][number];

export interface NativeProjectExactFileContractParts {
    profile: NativeProjectExactFileProfileDefinition;
    components: {
        path: VersionedContractComponentRef;
        marker: VersionedContractComponentRef;
        wrapper: VersionedContractComponentRef;
        materialize: VersionedContractComponentRef;
        reverse: VersionedContractComponentRef;
    };
    outputContract: OutputContractDefinitionV1;
}

export function isNativeProjectExactFileAssetKind(value: unknown): value is NativeProjectExactFileAssetKind {
    return typeof value === "string" && EXACT_FILE_ASSET_KINDS.has(value as NativeProjectExactFileAssetKind);
}

export function makeNativeProjectExactFileContractParts(
    declaration: Pick<
        AdapterNativeProjectExactFileRenderDeclarationV1,
        | "outputContractId"
        | "materializationProfileId"
        | "agentRuntimeId"
        | "assetKind"
        | "nativeDialectId"
        | "projectPathValidator"
        | "reverseParser"
        | "rebaseMaterializer"
        | "restorationDialectIds"
        | "target"
    >,
): NativeProjectExactFileContractParts {
    if (!isNativeProjectExactFileAssetKind(declaration.assetKind)) {
        throw new Error("native exact-file profile has an unsupported AssetKind");
    }
    requireStaticTargetFacts(declaration.target.requiredFacts);
    requireComponent(declaration.projectPathValidator, "project path validator");
    requireComponent(declaration.reverseParser, "reverse parser");
    if (declaration.rebaseMaterializer !== null) {
        requireComponent(declaration.rebaseMaterializer, "rebase materializer");
    }
    requireSortedDialectIds(declaration.restorationDialectIds);
    if (declaration.nativeDialectId.trim() === "" || declaration.nativeDialectId.includes("\0")) {
        throw new Error("native exact-file profile has an invalid dialect identity");
    }
    const profile: NativeProjectExactFileProfileDefinition = deepFreezeChildrenFirst({
        materializationProfileId: declaration.materializationProfileId,
        agentRuntimeId: declaration.agentRuntimeId,
        assetKind: declaration.assetKind,
        nativeDialectId: declaration.nativeDialectId,
        projectPathValidator: structuredClone(declaration.projectPathValidator),
        reverseParser: structuredClone(declaration.reverseParser),
        rebaseMaterializer: declaration.rebaseMaterializer === null ? null : structuredClone(declaration.rebaseMaterializer),
        restorationDialectIds: structuredClone(declaration.restorationDialectIds),
        targetContextSchemaId: declaration.target.targetContextSchemaId,
        requiredFacts: structuredClone(declaration.target.requiredFacts),
    });
    const prefix = `oaam.native-project-exact-file.${declaration.outputContractId.toLowerCase()}`;
    const components = deepFreezeChildrenFirst({
        path: component(`${prefix}.path`, {
            shape: "one-provider-validated-project-relative-native-file",
            assetKind: profile.assetKind,
            nativeDialectId: profile.nativeDialectId,
            projectPathValidator: profile.projectPathValidator,
        }),
        marker: component(`${prefix}.marker`, { markers: "none" }),
        wrapper: component(`${prefix}.wrapper`, { wrappers: "none" }),
        materialize: component(`${prefix}.materialize`, {
            semantics: "all-required-semantics-for-one-complete-entry-only-asset",
            bytes:
                profile.rebaseMaterializer === null
                    ? "exact-current-native-representation"
                    : "exact-current-or-validated-immediate-parent-rebase",
            nativeDialectId: profile.nativeDialectId,
            rebaseMaterializer: profile.rebaseMaterializer,
            restorationDialectIds: profile.restorationDialectIds,
        }),
        reverse: component(`${prefix}.reverse`, {
            mode: "provider-parsed-canonical-entry-only",
            parser: profile.reverseParser,
            attributes: "conflict",
            deletion: "conflict",
            pathMutation: "conflict",
            nativeBytes: "preserve-current-target",
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
    profile: NativeProjectExactFileProfileDefinition,
    components: NativeProjectExactFileContractParts["components"],
): OutputContractDefinitionV1 {
    const constraintValidator = component(
        `oaam.native-project-exact-file.${outputContractId.toLowerCase()}.profile.${profile.materializationProfileId}`,
        profileConfig(profile),
    );
    const materializationProfile = {
        materializationProfileId: profile.materializationProfileId,
        profileConstraintFingerprint: "" as Sha256Digest,
        constraintValidator,
    };
    const profiles = [materializationProfile];
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
    materializationProfile.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
        outputContractFingerprint: draft.outputContractFingerprint,
        materializationProfileId: profile.materializationProfileId,
        constraintValidator,
    });
    return deepFreezeChildrenFirst(draft);
}

export function makeExactFileApplicabilityPredicateRef(
    build: VerifiedNativeProjectExactFileBuild,
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1,
): VersionedContractComponentRef {
    return component(`oaam.native-project-exact-file.applicability.${build.agentRuntimeId.toLowerCase()}.${build.versionText}`, {
        agentRuntimeId: build.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        platform: build.platform,
        materializationProfileId: build.materializationProfileId,
        ...(buildCompatibility === undefined ? {} : { buildCompatibility }),
    });
}

export function makeExactFileConsumerConformance(
    provider: AdapterProviderSummary,
    declaration: AdapterNativeProjectExactFileRenderDeclarationV1,
    build: VerifiedNativeProjectExactFileBuild,
): ConsumerOutputContractConformanceV1 {
    const { profile, outputContract } = makeNativeProjectExactFileContractParts(declaration);
    const descriptor = provider.agentRuntimes.find((entry) => entry.agentRuntimeId === build.agentRuntimeId);
    const schema = provider.targetContextSchemas.find(
        (entry) => entry.agentRuntimeId === build.agentRuntimeId && entry.targetContextSchemaId === profile.targetContextSchemaId,
    );
    if (descriptor === undefined || schema === undefined) {
        throw new Error("verified native exact-file conformance has no provider schema");
    }
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileId: build.materializationProfileId,
        agentRuntimeId: build.agentRuntimeId,
        buildIdentity: build.buildIdentity,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        targetApplicabilityPredicate: makeExactFileApplicabilityPredicateRef(build, declaration.buildCompatibility),
        assetKind: declaration.assetKind,
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

export function createVerifiedNativeProjectExactFileBuild(
    input: Omit<VerifiedNativeProjectExactFileBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        assetKind: NativeProjectExactFileAssetKind;
        nativeDialectId: string;
        projectPathValidator: VersionedContractComponentRef;
        reverseParser: VersionedContractComponentRef;
        rebaseMaterializer: VersionedContractComponentRef | null;
        restorationDialectIds: readonly string[];
        parentRebaseFixtureId: string;
        targetRelativePath: PosixRelativePath;
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeProjectExactFileBuild {
    const {
        fixtureId,
        assetKind,
        nativeDialectId,
        projectPathValidator,
        reverseParser,
        rebaseMaterializer,
        restorationDialectIds,
        parentRebaseFixtureId,
        targetRelativePath,
        exactLoadMarker,
        reverseFixtureId,
        ...build
    } = input;
    if (!isNativeProjectExactFileAssetKind(assetKind)) throw new Error("exact-file fixture AssetKind is unsupported");
    if (rebaseMaterializer !== null) requireComponent(rebaseMaterializer, "rebase materializer");
    requireSortedDialectIds(restorationDialectIds);
    if (
        typeof parentRebaseFixtureId !== "string" ||
        parentRebaseFixtureId.trim() !== parentRebaseFixtureId ||
        (rebaseMaterializer === null ? parentRebaseFixtureId !== "" : parentRebaseFixtureId.length === 0)
    ) {
        throw new Error("exact-file parent rebase fixture identity does not match the declared capability");
    }
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
            projectPathValidator,
            reverseParser,
            rebaseMaterializer,
            restorationDialectIds,
            parentRebaseFixtureId,
            targetRelativePath,
            exactLoadMarker,
            reverseFixtureId,
            evidenceLevel: "agent_runtime_verified",
            l3: "passed",
            l4: "contract_fixture_passed",
        }),
    };
}

export function findNativeProjectExactFileDeclaration(
    provider: Pick<AdapterProviderSummary, "renderContractDeclarations">,
    agentRuntimeId: AgentRuntimeId,
    assetKind: NativeProjectExactFileAssetKind,
): AdapterNativeProjectExactFileRenderDeclarationV1 {
    const matches = provider.renderContractDeclarations.filter(
        (declaration): declaration is AdapterNativeProjectExactFileRenderDeclarationV1 =>
            declaration.declarationKind === "native_project_exact_file_v1" &&
            declaration.agentRuntimeId === agentRuntimeId &&
            declaration.assetKind === assetKind,
    );
    if (matches.length !== 1) throw new Error("native project exact-file target requires one provider declaration");
    return matches[0] as AdapterNativeProjectExactFileRenderDeclarationV1;
}

export function profileConfig(profile: NativeProjectExactFileProfileDefinition) {
    return {
        materializationProfileId: profile.materializationProfileId,
        agentRuntimeId: profile.agentRuntimeId,
        assetKind: profile.assetKind,
        nativeDialectId: profile.nativeDialectId,
        projectPathValidator: profile.projectPathValidator,
        reverseParser: profile.reverseParser,
        rebaseMaterializer: profile.rebaseMaterializer,
        restorationDialectIds: profile.restorationDialectIds,
        targetContextSchemaId: profile.targetContextSchemaId,
        requiredFacts: profile.requiredFacts,
    };
}

export function requireComponent(ref: VersionedContractComponentRef, label: string): void {
    if (
        typeof ref !== "object" ||
        ref === null ||
        typeof ref.componentId !== "string" ||
        ref.componentId.trim() === "" ||
        ref.componentId.includes("\0") ||
        !Number.isSafeInteger(ref.componentVersion) ||
        ref.componentVersion < 1 ||
        !isSha256Digest(ref.configFingerprint)
    ) {
        throw new Error(`native exact-file ${label} component is invalid`);
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
        throw new Error("native exact-file restoration dialect ids must be sorted unique non-blank ids");
    }
}

export { makeTargetContextSchema };
