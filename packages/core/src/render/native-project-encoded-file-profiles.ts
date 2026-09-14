/** Frozen project-scoped one-native-file canonical graph components. */

import type {
    ConsumerOutputContractConformanceV1,
    OutputContractDefinitionV1,
    VersionedContractComponentRef,
} from "../contracts/render";
import type {
    AdapterNativeEncodedFileRenderDeclarationV1,
    AdapterNativeGlobalEncodedFileRenderDeclarationV1,
    AdapterNativeProjectEncodedFileRenderDeclarationV1,
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
import { isCanonicalRelativePath } from "../foundation/validators";
import type { AgentRuntimeId, PosixRelativePath, Sha256Digest } from "../types";
import { requireComponent } from "./native-project-exact-file-profiles";
import { component, requireStaticTargetFacts } from "./native-project-guidance-profiles";

const FIXTURE_SET_DOMAIN = "oaam.render.encoded-file-fixture-set.v1";

export interface NativeProjectEncodedFileProfileDefinition {
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    assetKind: "Subagent";
    nativeDialectId: string;
    pathValidator: VersionedContractComponentRef;
    reverseParser: VersionedContractComponentRef;
    rebaseMaterializer: VersionedContractComponentRef;
    restorationDialectIds: readonly string[];
    targetContextSchemaId: string;
    requiredFacts: Readonly<Record<string, string>>;
    targetScope: "project" | "global";
}

export type VerifiedNativeProjectEncodedFileBuild = AdapterNativeProjectEncodedFileRenderDeclarationV1["verifiedBuilds"][number];
export type VerifiedNativeGlobalEncodedFileBuild = AdapterNativeGlobalEncodedFileRenderDeclarationV1["verifiedBuilds"][number];
export type VerifiedNativeEncodedFileBuild = AdapterNativeEncodedFileRenderDeclarationV1["verifiedBuilds"][number];

export interface NativeProjectEncodedFileContractParts {
    profile: NativeProjectEncodedFileProfileDefinition;
    components: {
        path: VersionedContractComponentRef;
        marker: VersionedContractComponentRef;
        wrapper: VersionedContractComponentRef;
        materialize: VersionedContractComponentRef;
        reverse: VersionedContractComponentRef;
    };
    outputContract: OutputContractDefinitionV1;
}

export function makeNativeProjectEncodedFileContractParts(
    declaration: AdapterNativeEncodedFileRenderDeclarationV1,
): NativeProjectEncodedFileContractParts {
    if (declaration.assetKind !== "Subagent") {
        throw new Error("native encoded-file profile accepts only Subagent");
    }
    requireStaticTargetFacts(declaration.target.requiredFacts);
    const targetScope = declaration.declarationKind === "native_project_encoded_file_v1" ? "project" : "global";
    const pathValidator =
        declaration.declarationKind === "native_project_encoded_file_v1"
            ? declaration.projectPathValidator
            : declaration.globalPathValidator;
    requireComponent(pathValidator, `${targetScope} path validator`);
    requireComponent(declaration.reverseParser, "reverse parser");
    requireComponent(declaration.rebaseMaterializer, "rebase materializer");
    requireSortedDialectIds(declaration.restorationDialectIds);
    if (declaration.nativeDialectId.trim() === "" || declaration.nativeDialectId.includes("\0")) {
        throw new Error("native encoded-file profile has an invalid dialect identity");
    }
    const profile: NativeProjectEncodedFileProfileDefinition = deepFreezeChildrenFirst({
        materializationProfileId: declaration.materializationProfileId,
        agentRuntimeId: declaration.agentRuntimeId,
        assetKind: declaration.assetKind,
        nativeDialectId: declaration.nativeDialectId,
        pathValidator: structuredClone(pathValidator),
        reverseParser: structuredClone(declaration.reverseParser),
        rebaseMaterializer: structuredClone(declaration.rebaseMaterializer),
        restorationDialectIds: structuredClone(declaration.restorationDialectIds),
        targetContextSchemaId: declaration.target.targetContextSchemaId,
        requiredFacts: structuredClone(declaration.target.requiredFacts),
        targetScope,
    });
    const prefix = `oaam.native-${targetScope}-encoded-file.${declaration.outputContractId.toLowerCase()}`;
    const components = deepFreezeChildrenFirst({
        path: component(`${prefix}.path`, {
            shape: `one-provider-validated-${targetScope}-relative-native-file-encoding-one-entry-and-optional-resource`,
            assetKind: profile.assetKind,
            nativeDialectId: profile.nativeDialectId,
            ...(targetScope === "project"
                ? { projectPathValidator: profile.pathValidator }
                : { globalPathValidator: profile.pathValidator }),
        }),
        marker: component(`${prefix}.marker`, { markers: "durable-canonical-file-section-handles" }),
        wrapper: component(`${prefix}.wrapper`, { wrappers: "none" }),
        materialize: component(`${prefix}.materialize`, {
            semantics: "all-required-semantics-for-one-complete-entry-and-optional-resource-asset",
            bytes: "exact-current-or-validated-immediate-parent-encoded-file-rebase",
            nativeDialectId: profile.nativeDialectId,
            rebaseMaterializer: profile.rebaseMaterializer,
            restorationDialectIds: profile.restorationDialectIds,
        }),
        reverse: component(`${prefix}.reverse`, {
            mode: "provider-decoded-section-attribution",
            parser: profile.reverseParser,
            content: "reconcile-per-canonical-file",
            executable: "conflict",
            addition: "conflict",
            deletion: "conflict",
            pathMutation: "conflict",
            nativeFile: "validate-complete-current-target",
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
    profile: NativeProjectEncodedFileProfileDefinition,
    components: NativeProjectEncodedFileContractParts["components"],
): OutputContractDefinitionV1 {
    const constraintValidator = component(
        `oaam.native-${profile.targetScope}-encoded-file.${outputContractId.toLowerCase()}.profile.${profile.materializationProfileId}`,
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

export function makeEncodedFileApplicabilityPredicateRef(
    build: VerifiedNativeEncodedFileBuild,
    targetScope: NativeProjectEncodedFileProfileDefinition["targetScope"] = "project",
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1,
): VersionedContractComponentRef {
    return component(
        `oaam.native-${targetScope}-encoded-file.applicability.${build.agentRuntimeId.toLowerCase()}.${build.versionText}`,
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

export function makeEncodedFileConsumerConformance(
    provider: AdapterProviderSummary,
    declaration: AdapterNativeEncodedFileRenderDeclarationV1,
    build: VerifiedNativeEncodedFileBuild,
): ConsumerOutputContractConformanceV1 {
    const { profile, outputContract } = makeNativeProjectEncodedFileContractParts(declaration);
    const descriptor = provider.agentRuntimes.find((entry) => entry.agentRuntimeId === build.agentRuntimeId);
    const schema = provider.targetContextSchemas.find(
        (entry) => entry.agentRuntimeId === build.agentRuntimeId && entry.targetContextSchemaId === profile.targetContextSchemaId,
    );
    if (descriptor === undefined || schema === undefined) {
        throw new Error("verified native encoded-file conformance is incomplete");
    }
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileId: build.materializationProfileId,
        agentRuntimeId: build.agentRuntimeId,
        buildIdentity: build.buildIdentity,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        targetApplicabilityPredicate: makeEncodedFileApplicabilityPredicateRef(
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

export function createVerifiedNativeProjectEncodedFileBuild(
    input: Omit<VerifiedNativeProjectEncodedFileBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        nativeDialectId: string;
        projectPathValidator: VersionedContractComponentRef;
        reverseParser: VersionedContractComponentRef;
        rebaseMaterializer: VersionedContractComponentRef;
        restorationDialectIds: readonly string[];
        parentRebaseFixtureId: string;
        targetRelativePath: PosixRelativePath;
        canonicalLogicalPaths: PosixRelativePath[];
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeProjectEncodedFileBuild {
    requireComponent(input.projectPathValidator, "project path validator");
    requireComponent(input.reverseParser, "reverse parser");
    requireComponent(input.rebaseMaterializer, "rebase materializer");
    requireSortedDialectIds(input.restorationDialectIds);
    if (
        !isCanonicalRelativePath(input.targetRelativePath) ||
        input.canonicalLogicalPaths.length < 1 ||
        input.canonicalLogicalPaths.length > 2 ||
        new Set(input.canonicalLogicalPaths).size !== input.canonicalLogicalPaths.length ||
        input.canonicalLogicalPaths.some((path) => !isCanonicalRelativePath(path))
    ) {
        throw new Error("native encoded-file fixture paths are invalid");
    }
    const {
        fixtureId,
        nativeDialectId,
        projectPathValidator,
        reverseParser,
        rebaseMaterializer,
        restorationDialectIds,
        parentRebaseFixtureId,
        targetRelativePath,
        canonicalLogicalPaths,
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
            assetKind: "Subagent",
            nativeDialectId,
            projectPathValidator,
            reverseParser,
            rebaseMaterializer,
            restorationDialectIds,
            parentRebaseFixtureId,
            targetRelativePath,
            canonicalLogicalPaths,
            exactLoadMarker,
            reverseFixtureId,
            evidenceLevel: "agent_runtime_verified",
            l3: "passed",
            l4: "contract_fixture_passed",
        }),
    };
}

export function createVerifiedNativeGlobalEncodedFileBuild(
    input: Omit<VerifiedNativeGlobalEncodedFileBuild, "fixtureSetFingerprint"> & {
        fixtureId: string;
        nativeDialectId: string;
        globalPathValidator: VersionedContractComponentRef;
        reverseParser: VersionedContractComponentRef;
        rebaseMaterializer: VersionedContractComponentRef;
        restorationDialectIds: readonly string[];
        parentRebaseFixtureId: string;
        targetRelativePath: PosixRelativePath;
        canonicalLogicalPaths: PosixRelativePath[];
        exactLoadMarker: string;
        reverseFixtureId: string;
    },
): VerifiedNativeGlobalEncodedFileBuild {
    requireComponent(input.globalPathValidator, "global path validator");
    requireComponent(input.reverseParser, "reverse parser");
    requireComponent(input.rebaseMaterializer, "rebase materializer");
    requireSortedDialectIds(input.restorationDialectIds);
    if (
        !isCanonicalRelativePath(input.targetRelativePath) ||
        input.canonicalLogicalPaths.length < 1 ||
        input.canonicalLogicalPaths.length > 2 ||
        new Set(input.canonicalLogicalPaths).size !== input.canonicalLogicalPaths.length ||
        input.canonicalLogicalPaths.some((path) => !isCanonicalRelativePath(path))
    ) {
        throw new Error("native encoded-file fixture paths are invalid");
    }
    const {
        fixtureId,
        nativeDialectId,
        globalPathValidator,
        reverseParser,
        rebaseMaterializer,
        restorationDialectIds,
        parentRebaseFixtureId,
        targetRelativePath,
        canonicalLogicalPaths,
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
            assetKind: "Subagent",
            nativeDialectId,
            globalPathValidator,
            reverseParser,
            rebaseMaterializer,
            restorationDialectIds,
            parentRebaseFixtureId,
            targetRelativePath,
            canonicalLogicalPaths,
            exactLoadMarker,
            reverseFixtureId,
            evidenceLevel: "agent_runtime_verified",
            l3: "passed",
            l4: "contract_fixture_passed",
        }),
    };
}

export function profileConfig(profile: NativeProjectEncodedFileProfileDefinition) {
    const base = {
        materializationProfileId: profile.materializationProfileId,
        agentRuntimeId: profile.agentRuntimeId,
        assetKind: profile.assetKind,
        nativeDialectId: profile.nativeDialectId,
        reverseParser: profile.reverseParser,
        rebaseMaterializer: profile.rebaseMaterializer,
        restorationDialectIds: profile.restorationDialectIds,
        targetContextSchemaId: profile.targetContextSchemaId,
        requiredFacts: profile.requiredFacts,
    };
    return profile.targetScope === "project"
        ? { ...base, projectPathValidator: profile.pathValidator }
        : { ...base, targetScope: "global", globalPathValidator: profile.pathValidator };
}

function requireSortedDialectIds(values: readonly string[]): void {
    if (
        !Array.isArray(values) ||
        values.some((value) => typeof value !== "string" || value.trim() !== value || value === "" || value.includes("\0")) ||
        values.some((value, index) => index > 0 && (values[index - 1] as string) >= value)
    ) {
        throw new Error("native encoded-file restoration dialect ids must be sorted unique non-blank ids");
    }
}
