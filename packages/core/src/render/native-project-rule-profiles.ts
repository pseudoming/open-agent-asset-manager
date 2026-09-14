/** Frozen native project-Rule profiles and contract components. */

import type {
    ConsumerOutputContractConformanceV1,
    OutputContractDefinitionV1,
    VersionedContractComponentRef,
} from "../contracts/render";
import type {
    AdapterNativeGlobalRuleRenderDeclarationV1,
    AdapterNativeProjectRuleRenderDeclarationV1,
    AdapterNativeRuleRenderDeclarationV1,
    AdapterProviderSummary,
    MaterializationProfileId,
} from "../contracts/source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../contracts/target-build-compatibility";
import { deepFreezeChildrenFirst } from "../foundation/deep-freeze";
import {
    computeConsumerConformanceFingerprint,
    computeMaterializationProfileConstraintFingerprint,
    computeOutputContractFingerprint,
    fingerprintDomain,
} from "../foundation/fingerprint";
import type { AgentRuntimeId, PosixRelativePath, Sha256Digest } from "../types";
import { component, requireStaticTargetFacts } from "./native-project-guidance-profiles";

const FIXTURE_SET_DOMAIN = "oaam.render.fixture-set.v1";

export interface NativeProjectRuleProfileDefinition {
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    relativeDirectory: PosixRelativePath;
    fileNameSuffix: string;
    targetContextSchemaId: string;
    requiredFacts: Readonly<Record<string, string>>;
    targetScope: "project" | "global";
}

export interface NativeProjectRuleTargetDeclaration {
    relativeDirectory: PosixRelativePath;
    fileNameSuffix: string;
    targetContextSchemaId: string;
    requiredFacts: Readonly<Record<string, string>>;
}

export type VerifiedNativeProjectRuleBuild = AdapterNativeProjectRuleRenderDeclarationV1["verifiedBuilds"][number];
export type VerifiedNativeGlobalRuleBuild = AdapterNativeGlobalRuleRenderDeclarationV1["verifiedBuilds"][number];
export type VerifiedNativeRuleBuild = AdapterNativeRuleRenderDeclarationV1["verifiedBuilds"][number];

export interface NativeProjectRuleContractParts {
    profile: NativeProjectRuleProfileDefinition;
    components: {
        path: VersionedContractComponentRef;
        marker: VersionedContractComponentRef;
        wrapper: VersionedContractComponentRef;
        materialize: VersionedContractComponentRef;
        reverse: VersionedContractComponentRef;
    };
    outputContract: OutputContractDefinitionV1;
}

export function makeNativeProjectRuleContractParts(
    declaration: Pick<
        AdapterNativeRuleRenderDeclarationV1,
        "declarationKind" | "outputContractId" | "materializationProfileId" | "agentRuntimeId" | "target"
    >,
): NativeProjectRuleContractParts {
    requireStaticTargetFacts(declaration.target.requiredFacts);
    const targetScope = declaration.declarationKind === "native_project_rule_v1" ? "project" : "global";
    const profile: NativeProjectRuleProfileDefinition = deepFreezeChildrenFirst({
        materializationProfileId: declaration.materializationProfileId,
        agentRuntimeId: declaration.agentRuntimeId,
        relativeDirectory: declaration.target.relativeDirectory,
        fileNameSuffix: declaration.target.fileNameSuffix,
        targetContextSchemaId: declaration.target.targetContextSchemaId,
        requiredFacts: structuredClone(declaration.target.requiredFacts),
        targetScope,
    });
    const prefix = `oaam.native-${targetScope}-rule.${declaration.outputContractId.toLowerCase()}`;
    const components = deepFreezeChildrenFirst({
        path: component(`${prefix}.path`, {
            shape: "one-declared-directory-markdown-file-named-for-rule",
            profile: profileConfig(profile),
        }),
        marker: component(`${prefix}.marker`, { markers: "none" }),
        wrapper: component(`${prefix}.wrapper`, { wrappers: "none" }),
        materialize: component(`${prefix}.materialize`, {
            semantics: ["asset.file_inventory", "rule.activation", "rule.content"],
            bytes: "exact-canonical-entry-text",
        }),
        reverse: component(`${prefix}.reverse`, {
            mode: "whole-file-rule-content-only",
            attributes: "conflict",
            deletion: "conflict",
            pathMutation: "conflict",
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
    profile: NativeProjectRuleProfileDefinition,
    components: NativeProjectRuleContractParts["components"],
): OutputContractDefinitionV1 {
    const constraintValidator = component(
        `oaam.native-${profile.targetScope}-rule.${outputContractId.toLowerCase()}.profile.${profile.materializationProfileId}`,
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
    for (const candidate of draft.materializationProfiles) {
        candidate.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
            outputContractFingerprint: draft.outputContractFingerprint,
            materializationProfileId: candidate.materializationProfileId,
            constraintValidator: candidate.constraintValidator,
        });
    }
    return deepFreezeChildrenFirst(draft);
}

export function makeRuleApplicabilityPredicateRef(
    build: VerifiedNativeRuleBuild,
    targetScope: NativeProjectRuleProfileDefinition["targetScope"] = "project",
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1,
): VersionedContractComponentRef {
    return component(`oaam.native-${targetScope}-rule.applicability.${build.agentRuntimeId.toLowerCase()}.${build.versionText}`, {
        agentRuntimeId: build.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        platform: build.platform,
        materializationProfileId: build.materializationProfileId,
        ...(buildCompatibility === undefined ? {} : { buildCompatibility }),
    });
}

export function makeRuleConsumerConformance(
    provider: AdapterProviderSummary,
    declaration: AdapterNativeRuleRenderDeclarationV1,
    build: VerifiedNativeRuleBuild,
): ConsumerOutputContractConformanceV1 {
    const { profile, outputContract } = makeNativeProjectRuleContractParts(declaration);
    const descriptor = provider.agentRuntimes.find((entry) => entry.agentRuntimeId === build.agentRuntimeId);
    const schema = provider.targetContextSchemas.find(
        (entry) => entry.agentRuntimeId === build.agentRuntimeId && entry.targetContextSchemaId === profile.targetContextSchemaId,
    );
    if (descriptor === undefined || schema === undefined) {
        throw new Error("verified native Rule conformance has no provider schema");
    }
    const predicate = makeRuleApplicabilityPredicateRef(build, profile.targetScope, declaration.buildCompatibility);
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileId: build.materializationProfileId,
        agentRuntimeId: build.agentRuntimeId,
        buildIdentity: build.buildIdentity,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        targetApplicabilityPredicate: predicate,
        assetKind: "Rule" as const,
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

export function createVerifiedNativeProjectRuleBuild(
    input: Omit<VerifiedNativeProjectRuleBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        targetRelativeDirectory: PosixRelativePath;
        targetFileNameSuffix: string;
        fixtureRuleName: string;
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeProjectRuleBuild {
    const {
        fixtureId,
        targetRelativeDirectory,
        targetFileNameSuffix,
        fixtureRuleName,
        exactLoadMarker,
        reverseFixtureId,
        ...build
    } = input;
    return {
        ...build,
        fixtureSetFingerprint: fingerprintDomain(FIXTURE_SET_DOMAIN, {
            fixtureId,
            agentRuntimeId: input.agentRuntimeId,
            versionText: input.versionText,
            buildIdentity: input.buildIdentity,
            platform: input.platform,
            materializationProfileId: input.materializationProfileId,
            targetRelativeDirectory,
            targetFileNameSuffix,
            fixtureRuleName,
            exactLoadMarker,
            reverseFixtureId,
            evidenceLevel: "agent_runtime_verified",
            l3: "passed",
            l4: "contract_fixture_passed",
        }),
    };
}

export function createVerifiedNativeGlobalRuleBuild(
    input: Omit<VerifiedNativeGlobalRuleBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        targetRelativeDirectory: PosixRelativePath;
        targetFileNameSuffix: string;
        fixtureRuleName: string;
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeGlobalRuleBuild {
    const {
        fixtureId,
        targetRelativeDirectory,
        targetFileNameSuffix,
        fixtureRuleName,
        exactLoadMarker,
        reverseFixtureId,
        ...build
    } = input;
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
            targetRelativeDirectory,
            targetFileNameSuffix,
            fixtureRuleName,
            exactLoadMarker,
            reverseFixtureId,
            evidenceLevel: "agent_runtime_verified",
            l3: "passed",
            l4: "contract_fixture_passed",
        }),
    };
}

export function findNativeProjectRuleDeclaration(
    provider: Pick<AdapterProviderSummary, "renderContractDeclarations">,
    agentRuntimeId: AgentRuntimeId,
): AdapterNativeProjectRuleRenderDeclarationV1 {
    const matches = provider.renderContractDeclarations.filter(
        (declaration): declaration is AdapterNativeProjectRuleRenderDeclarationV1 =>
            declaration.declarationKind === "native_project_rule_v1" && declaration.agentRuntimeId === agentRuntimeId,
    );
    if (matches.length !== 1) {
        throw new Error("native project Rule requires exactly one provider declaration");
    }
    return matches[0] as AdapterNativeProjectRuleRenderDeclarationV1;
}

export function nativeProjectRuleRelativePath(
    profile: Pick<NativeProjectRuleProfileDefinition, "relativeDirectory" | "fileNameSuffix">,
    ruleName: string,
): PosixRelativePath {
    if (!isSafePortableRuleName(ruleName)) throw new Error("native project Rule name is not a safe portable filename stem");
    return `${profile.relativeDirectory}/${ruleName}${profile.fileNameSuffix}` as PosixRelativePath;
}

export function nativeProjectRuleNameFromRelativePath(
    profile: Pick<NativeProjectRuleProfileDefinition, "relativeDirectory" | "fileNameSuffix">,
    relativePath: PosixRelativePath,
): string | null {
    const prefix = `${profile.relativeDirectory}/`;
    if (!relativePath.startsWith(prefix) || !relativePath.endsWith(profile.fileNameSuffix)) return null;
    const name = relativePath.slice(prefix.length, -profile.fileNameSuffix.length);
    return isSafePortableRuleName(name) ? name : null;
}

export function isSafePortableRuleName(value: string): boolean {
    if (value.length === 0 || value.length > 120) return false;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        const alphaNumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
        if (!alphaNumeric && code !== 45 && code !== 95) return false;
    }
    return true;
}

export function isNativeProjectRuleFileNameSuffix(value: string): boolean {
    return value === ".md";
}

export function ruleProfileConfig(profile: NativeProjectRuleProfileDefinition) {
    const base = {
        materializationProfileId: profile.materializationProfileId,
        agentRuntimeId: profile.agentRuntimeId,
        relativeDirectory: profile.relativeDirectory,
        fileNameSuffix: profile.fileNameSuffix,
        targetContextSchemaId: profile.targetContextSchemaId,
        requiredFacts: profile.requiredFacts,
    };
    return profile.targetScope === "project" ? base : { ...base, targetScope: profile.targetScope };
}

function profileConfig(profile: NativeProjectRuleProfileDefinition) {
    return ruleProfileConfig(profile);
}
