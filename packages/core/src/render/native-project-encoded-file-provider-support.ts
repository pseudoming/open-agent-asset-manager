/** Provider-owned construction for one encoded native project file. */

import type {
    AdapterRenderAnalysisResult,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
    VersionedContractComponentRef,
} from "../contracts/render";
import type { AdapterRenderedTargetInspectionResult, RenderedTargetInspectionInput } from "../contracts/reverse";
import type {
    AdapterAssetTargetCapabilityAvailable,
    AdapterMaterializerCapability,
    AdapterNativeEncodedFileRenderDeclarationV1,
    AdapterNativeGlobalEncodedFileRenderDeclarationV1,
    AdapterNativeProjectEncodedFileRenderDeclarationV1,
    AgentRuntimeDescriptor,
    MaterializationProfileId,
    MaterializerCapabilityKey,
} from "../contracts/source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../contracts/target-build-compatibility";
import { deepFreezeChildrenFirst } from "../foundation/deep-freeze";
import type { AdapterId, AgentRuntimeId, PosixRelativePath } from "../types";
import {
    analyzeNativeProjectEncodedFile,
    inspectNativeProjectEncodedFile,
    materializeNativeProjectEncodedFile,
} from "./native-project-encoded-file-behavior";
import {
    makeNativeProjectEncodedFileContractParts,
    type VerifiedNativeEncodedFileBuild,
    type VerifiedNativeGlobalEncodedFileBuild,
    type VerifiedNativeProjectEncodedFileBuild,
} from "./native-project-encoded-file-profiles";
import type {
    DecodedCanonicalSection,
    EncodedCanonicalSectionDescriptor,
    NativeProjectEncodedFileProviderBehavior,
    NativeProjectEncodedFileRebaseMaterializer,
} from "./native-project-encoded-file-results";
import { makeTargetContextSchema } from "./native-project-guidance-profiles";

export interface NativeProjectEncodedFileProviderSupport {
    targetContextSchema: ReturnType<typeof makeTargetContextSchema>;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeProjectEncodedFileRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}

export interface NativeGlobalEncodedFileProviderSupport {
    targetContextSchema: ReturnType<typeof makeTargetContextSchema>;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeGlobalEncodedFileRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}

export interface NativeProjectEncodedFileComponent {
    ref: VersionedContractComponentRef;
}

export function createNativeProjectEncodedFileProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    materializerCapabilityKey?: MaterializerCapabilityKey;
    nativeDialectId: string;
    projectPathValidator: NativeProjectEncodedFileComponent & {
        validate(relativePath: PosixRelativePath): boolean;
    };
    reverseParser: NativeProjectEncodedFileComponent & {
        decode(input: {
            assetKind: "Subagent";
            nativeDialectId: string;
            relativePath: PosixRelativePath;
            nativeText: string;
            sections: EncodedCanonicalSectionDescriptor[];
        }): { sections: DecodedCanonicalSection[] } | null;
    };
    rebaseMaterializer: NativeProjectEncodedFileRebaseMaterializer;
    restorationDialectIds: readonly string[];
    target: { targetContextSchemaId: string; requiredFacts: Readonly<Record<string, string>> };
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeProjectEncodedFileBuild[];
}): NativeProjectEncodedFileProviderSupport {
    return createNativeEncodedFileProviderSupport({
        ...input,
        targetScope: "project",
        pathValidator: input.projectPathValidator,
    }) as NativeProjectEncodedFileProviderSupport;
}

export function createNativeGlobalEncodedFileProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    materializerCapabilityKey?: MaterializerCapabilityKey;
    nativeDialectId: string;
    globalPathValidator: NativeProjectEncodedFileComponent & {
        validate(relativePath: PosixRelativePath): boolean;
    };
    reverseParser: NativeProjectEncodedFileComponent & {
        decode(input: {
            assetKind: "Subagent";
            nativeDialectId: string;
            relativePath: PosixRelativePath;
            nativeText: string;
            sections: EncodedCanonicalSectionDescriptor[];
        }): { sections: DecodedCanonicalSection[] } | null;
    };
    rebaseMaterializer: NativeProjectEncodedFileRebaseMaterializer;
    restorationDialectIds: readonly string[];
    target: { targetContextSchemaId: string; requiredFacts: Readonly<Record<string, string>> };
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeGlobalEncodedFileBuild[];
}): NativeGlobalEncodedFileProviderSupport {
    return createNativeEncodedFileProviderSupport({
        ...input,
        targetScope: "global",
        pathValidator: input.globalPathValidator,
    }) as NativeGlobalEncodedFileProviderSupport;
}

function createNativeEncodedFileProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    materializerCapabilityKey?: MaterializerCapabilityKey;
    nativeDialectId: string;
    pathValidator: NativeProjectEncodedFileComponent & {
        validate(relativePath: PosixRelativePath): boolean;
    };
    reverseParser: NativeProjectEncodedFileComponent & {
        decode(input: {
            assetKind: "Subagent";
            nativeDialectId: string;
            relativePath: PosixRelativePath;
            nativeText: string;
            sections: EncodedCanonicalSectionDescriptor[];
        }): { sections: DecodedCanonicalSection[] } | null;
    };
    rebaseMaterializer: NativeProjectEncodedFileRebaseMaterializer;
    restorationDialectIds: readonly string[];
    target: { targetContextSchemaId: string; requiredFacts: Readonly<Record<string, string>> };
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeEncodedFileBuild[];
    targetScope: "project" | "global";
}): NativeProjectEncodedFileProviderSupport | NativeGlobalEncodedFileProviderSupport {
    if (
        typeof input.pathValidator.validate !== "function" ||
        typeof input.reverseParser.decode !== "function" ||
        typeof input.rebaseMaterializer.materialize !== "function"
    ) {
        throw new Error("native encoded-file support requires Provider-owned path, decoder and rebase implementations");
    }
    const declarationBase = {
        schemaVersion: 1,
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        agentRuntimeId: input.agentRuntimeId,
        assetKind: "Subagent",
        nativeDialectId: input.nativeDialectId,
        reverseParser: structuredClone(input.reverseParser.ref),
        rebaseMaterializer: structuredClone(input.rebaseMaterializer.ref),
        restorationDialectIds: structuredClone([...input.restorationDialectIds]),
        target: structuredClone(input.target),
        ...(input.buildCompatibility === undefined ? {} : { buildCompatibility: structuredClone(input.buildCompatibility) }),
        verifiedBuilds: structuredClone([...input.verifiedBuilds]),
    } as const;
    const renderContractDeclaration: AdapterNativeEncodedFileRenderDeclarationV1 =
        input.targetScope === "project"
            ? deepFreezeChildrenFirst({
                  ...declarationBase,
                  declarationKind: "native_project_encoded_file_v1" as const,
                  projectPathValidator: structuredClone(input.pathValidator.ref),
              })
            : deepFreezeChildrenFirst({
                  ...declarationBase,
                  declarationKind: "native_global_encoded_file_v1" as const,
                  globalPathValidator: structuredClone(input.pathValidator.ref),
              });
    const { profile, outputContract } = makeNativeProjectEncodedFileContractParts(renderContractDeclaration);
    const descriptor = input.agentRuntimes.find((entry) => entry.agentRuntimeId === input.agentRuntimeId);
    if (descriptor === undefined) throw new Error("native encoded-file support references an unknown agent runtime");
    if (
        input.verifiedBuilds.length === 0 ||
        input.verifiedBuilds.some(
            (build) =>
                build.agentRuntimeId !== input.agentRuntimeId ||
                build.materializationProfileId !== input.materializationProfileId,
        )
    ) {
        throw new Error("native encoded-file verified builds do not belong to the declaration");
    }
    const targetContextSchema = makeTargetContextSchema(input.adapterId, descriptor, profile);
    const targetCapability: AdapterAssetTargetCapabilityAvailable = {
        agentRuntimeId: input.agentRuntimeId,
        entrySupportStatus: "supported",
        assetKind: "Subagent",
        renderStrategy: "native_graph",
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        targetContextSchemaId: targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: targetContextSchema.schemaFingerprint,
        reverseExtractPolicy: "can_reconcile",
        diagnostics: [],
    };
    const materializerCapabilityKey =
        input.materializerCapabilityKey ?? `${input.adapterId.toLowerCase()}.${input.targetScope}-subagent-encoded-file-v1`;
    if (
        materializerCapabilityKey.trim() === "" ||
        materializerCapabilityKey.trim() !== materializerCapabilityKey ||
        materializerCapabilityKey.includes("\0")
    ) {
        throw new Error("native encoded-file materializer capability key must be canonical non-blank text");
    }
    const materializerCapability: AdapterMaterializerCapability = {
        materializerCapabilityKey,
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileIds: [input.materializationProfileId],
        diagnostics: [],
    };
    const materializationProfile = outputContract
        .materializationProfiles[0] as (typeof outputContract.materializationProfiles)[number];
    const behavior: NativeProjectEncodedFileProviderBehavior = {
        adapterId: input.adapterId,
        adapterVersion: input.adapterVersion,
        profile,
        profileConstraintFingerprint: materializationProfile.profileConstraintFingerprint,
        targetContextSchema,
        materializerCapability,
        outputContract,
        validatePath: input.pathValidator.validate,
        decodeNativeFile: input.reverseParser.decode,
        rebaseMaterializer: input.rebaseMaterializer,
    };
    return {
        targetContextSchema,
        targetCapability,
        materializerCapability,
        renderContractDeclaration,
        analyze: (value) => analyzeNativeProjectEncodedFile(value, behavior),
        materialize: (value) => materializeNativeProjectEncodedFile(value, behavior),
        inspect: (value) => inspectNativeProjectEncodedFile(value, behavior),
    } as NativeProjectEncodedFileProviderSupport | NativeGlobalEncodedFileProviderSupport;
}
