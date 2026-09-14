/** One native project file encoding a complete Subagent canonical graph. */

import { normalizeText } from "../catalog/payload-store";
import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type { RenderSemanticKind } from "../contracts/deployment-authority";
import type { AdapterMaterializerCapability, AdapterTargetContextSchemaDeclaration } from "../contracts/source-import";
import type {
    OutputContractDefinitionV1,
    ProviderRenderDialectInput,
    RenderAnalysisInput,
    VersionedContractComponentRef,
} from "../contracts/render";
import type { TargetFileContent } from "../contracts/common";
import type { AdapterId, OperationDiagnostic, PosixRelativePath, Sha256Digest, VersionRef } from "../types";
import { computeRenderOutputUnitFingerprint, stableStringify } from "../foundation/fingerprint";
import { getAssetSpecHandler } from "../specs/registry";
import { assetSemanticKinds, fileSemanticKinds, versionRefKey } from "./render-semantics";
import { compareUtf8Bytes, diagnostic } from "./native-project-guidance-profiles";
import type { NativeProjectEncodedFileProfileDefinition } from "./native-project-encoded-file-profiles";

type ProjectedAsset = RenderAnalysisInput["deployment"]["assets"][number];
type NativeInput = Extract<ProviderRenderDialectInput, { inputKind: "native_representation" }>;
type RestorationInput = Extract<ProviderRenderDialectInput, { inputKind: "dialect_restoration" }>;

export interface EncodedCanonicalSectionDescriptor {
    sectionHandle: string;
    semanticKind: Extract<RenderSemanticKind, "subagent.invoked_context" | "subagent.resource">;
}

export interface DecodedCanonicalSection {
    sectionHandle: string;
    canonicalContent: TargetFileContent;
}

export interface NativeProjectEncodedFileRebaseInput {
    assetKind: "Subagent";
    nativeDialectId: string;
    targetCanonical: Extract<ProjectedAsset["version"]["canonical"], { kind: "Subagent" }>;
    targetFiles: AssetVersionFileContentV2[];
    parent: {
        sourceVersion: VersionRef;
        representation: NativeInput["representation"];
        file: Extract<NativeInput["files"][number], { contentKind: "text" }>;
    };
    restorationInputs: RestorationInput[];
}

export interface NativeProjectEncodedFileRebaseMaterializer {
    ref: VersionedContractComponentRef;
    materialize(input: NativeProjectEncodedFileRebaseInput): { nativeText: string } | null;
}

export interface NativeProjectEncodedFileProviderBehavior {
    adapterId: AdapterId;
    adapterVersion: string;
    profile: NativeProjectEncodedFileProfileDefinition;
    profileConstraintFingerprint: Sha256Digest;
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    materializerCapability: AdapterMaterializerCapability;
    outputContract: OutputContractDefinitionV1;
    validatePath(relativePath: PosixRelativePath): boolean;
    decodeNativeFile(input: {
        assetKind: "Subagent";
        nativeDialectId: string;
        relativePath: PosixRelativePath;
        nativeText: string;
        sections: EncodedCanonicalSectionDescriptor[];
    }): { sections: DecodedCanonicalSection[] } | null;
    rebaseMaterializer: NativeProjectEncodedFileRebaseMaterializer;
}

export type NativeProjectEncodedFileRenderAsset = ProjectedAsset & {
    version: ProjectedAsset["version"] & {
        canonical: Extract<ProjectedAsset["version"]["canonical"], { kind: "Subagent" }>;
    };
};

export interface NativeProjectEncodedFileResolvedAsset {
    asset: NativeProjectEncodedFileRenderAsset;
    native: NativeInput;
    restorationInputs: RestorationInput[];
    nativeFile: Extract<NativeInput["files"][number], { contentKind: "text" }>;
    materializedText: string;
    sections: EncodedCanonicalSectionDescriptor[];
}

export function findEncodedFileAssets(
    input: Pick<RenderAnalysisInput, "deployment" | "dialectInputs">,
    behavior: NativeProjectEncodedFileProviderBehavior,
): NativeProjectEncodedFileResolvedAsset[] | null {
    if (
        input.deployment.assets.length === 0 ||
        input.deployment.targetContexts.length !== 1 ||
        input.dialectInputs.length !== input.deployment.assets.length
    ) {
        return null;
    }
    const assetKeys = input.deployment.assets.map((asset) => versionRefKey(asset.version.ref));
    const dialectKeys = input.dialectInputs.map((group) => versionRefKey(group.targetVersion));
    if (
        new Set(assetKeys).size !== assetKeys.length ||
        new Set(dialectKeys).size !== dialectKeys.length ||
        stableStringify([...assetKeys].sort(compareUtf8Bytes)) !== stableStringify([...dialectKeys].sort(compareUtf8Bytes))
    ) {
        return null;
    }
    const dialectByVersion = new Map(input.dialectInputs.map((group) => [versionRefKey(group.targetVersion), group]));
    const resolved: NativeProjectEncodedFileResolvedAsset[] = [];
    for (const asset of input.deployment.assets) {
        if (asset.version.canonical.kind !== "Subagent") return null;
        const files = asset.version.files;
        const entry = files.find((file) => file.file.role === "entry");
        const resources = files.filter((file) => file.file.role === "resource");
        const projected = exactEncodedInputs(
            dialectByVersion.get(versionRefKey(asset.version.ref)) as RenderAnalysisInput["dialectInputs"][number],
            asset,
            behavior,
        );
        const sections = encodedSectionDescriptors(asset);
        if (
            (behavior.profile.targetScope === "project"
                ? asset.scope !== "project" || asset.projectId === ""
                : asset.scope !== "global" || asset.projectId !== "") ||
            asset.scopePath !== "" ||
            asset.version.status !== "complete" ||
            files.length < 1 ||
            files.length > 2 ||
            entry?.contentKind !== "text" ||
            resources.length !== files.length - 1 ||
            files.some((file) => file.contentKind !== "text" || file.file.executable) ||
            !getAssetSpecHandler("Subagent").validateEntryText(entry.text) ||
            getAssetSpecHandler("Subagent").validateFiles(asset.version.canonical, files).length !== 0 ||
            sections === null ||
            projected === null
        ) {
            return null;
        }
        const materializedText =
            projected.native.inputRole === "current_exact"
                ? projected.nativeFile.text
                : safeEncodedRebase(
                      behavior,
                      asset as NativeProjectEncodedFileRenderAsset,
                      projected.native as Extract<NativeInput, { inputRole: "parent_rebase_seed" }>,
                      projected.nativeFile,
                      projected.restorationInputs,
                      sections,
                  );
        if (
            materializedText === null ||
            !decodedContentMatches(behavior, projected.nativeFile.relativePath, materializedText, sections, files)
        ) {
            return null;
        }
        resolved.push({
            asset: asset as NativeProjectEncodedFileRenderAsset,
            native: projected.native,
            restorationInputs: projected.restorationInputs,
            nativeFile: projected.nativeFile,
            materializedText,
            sections,
        });
    }
    resolved.sort((left, right) =>
        compareUtf8Bytes(
            `${left.nativeFile.relativePath}\0${versionRefKey(left.asset.version.ref)}`,
            `${right.nativeFile.relativePath}\0${versionRefKey(right.asset.version.ref)}`,
        ),
    );
    return new Set(resolved.map((item) => item.nativeFile.relativePath)).size === resolved.length ? resolved : null;
}

function exactEncodedInputs(
    group: RenderAnalysisInput["dialectInputs"][number],
    asset: ProjectedAsset,
    behavior: NativeProjectEncodedFileProviderBehavior,
): {
    native: NativeInput;
    nativeFile: Extract<NativeInput["files"][number], { contentKind: "text" }>;
    restorationInputs: RestorationInput[];
} | null {
    const nativeInputs = group.inputs.filter(
        (candidate): candidate is NativeInput => candidate.inputKind === "native_representation",
    );
    const restorationInputs = group.inputs.filter(
        (candidate): candidate is RestorationInput => candidate.inputKind === "dialect_restoration",
    );
    const native = nativeInputs[0];
    const file = native?.files[0];
    if (
        versionRefKey(group.targetVersion) !== versionRefKey(asset.version.ref) ||
        nativeInputs.length !== 1 ||
        group.inputs.length !== 1 + restorationInputs.length ||
        native === undefined ||
        native.representation.dialectId !== behavior.profile.nativeDialectId ||
        native.files.length !== 1 ||
        (native.inputRole === "parent_rebase_seed" &&
            (native.sourceVersion.assetId !== group.targetVersion.assetId ||
                native.sourceVersion.versionId === group.targetVersion.versionId)) ||
        restorationInputs.some((item) => item.restoration?.dialectId === undefined) ||
        stableStringify(restorationInputs.map((item) => item.restoration.dialectId)) !==
            stableStringify(behavior.profile.restorationDialectIds) ||
        file?.contentKind !== "text" ||
        file.executable ||
        normalizeText(file.text).normalized !== file.text ||
        !safePathValidation(behavior, file.relativePath)
    ) {
        return null;
    }
    return { native, nativeFile: file, restorationInputs };
}

function safeEncodedRebase(
    behavior: NativeProjectEncodedFileProviderBehavior,
    asset: NativeProjectEncodedFileRenderAsset,
    native: Extract<NativeInput, { inputRole: "parent_rebase_seed" }>,
    nativeFile: Extract<NativeInput["files"][number], { contentKind: "text" }>,
    restorationInputs: RestorationInput[],
    sections: EncodedCanonicalSectionDescriptor[],
): string | null {
    try {
        const result = behavior.rebaseMaterializer.materialize(
            structuredClone({
                assetKind: "Subagent" as const,
                nativeDialectId: behavior.profile.nativeDialectId,
                targetCanonical: asset.version.canonical,
                targetFiles: asset.version.files,
                parent: {
                    sourceVersion: native.sourceVersion,
                    representation: native.representation,
                    file: nativeFile,
                },
                restorationInputs,
            }),
        );
        if (
            result === null ||
            Object.keys(result).length !== 1 ||
            typeof result.nativeText !== "string" ||
            normalizeText(result.nativeText).normalized !== result.nativeText ||
            result.nativeText.trim() === ""
        ) {
            return null;
        }
        return decodedContentMatches(behavior, nativeFile.relativePath, result.nativeText, sections, asset.version.files)
            ? result.nativeText
            : null;
    } catch {
        return null;
    }
}

export function encodedSectionDescriptors(asset: ProjectedAsset): EncodedCanonicalSectionDescriptor[] | null {
    const descriptors = asset.version.files.flatMap((file): EncodedCanonicalSectionDescriptor[] => {
        const semanticKinds = fileSemanticKinds("Subagent", file);
        const sectionHandle = asset.sectionHandles[file.file.fileId];
        if (
            sectionHandle === undefined ||
            semanticKinds.length !== 1 ||
            (semanticKinds[0] !== "subagent.invoked_context" && semanticKinds[0] !== "subagent.resource")
        ) {
            return [];
        }
        return [{ sectionHandle, semanticKind: semanticKinds[0] }];
    });
    return descriptors.length === asset.version.files.length &&
        new Set(descriptors.map((item) => item.sectionHandle)).size === descriptors.length
        ? descriptors.sort((left, right) => compareUtf8Bytes(left.sectionHandle, right.sectionHandle))
        : null;
}

export function safeDecodeNativeFile(
    behavior: NativeProjectEncodedFileProviderBehavior,
    relativePath: PosixRelativePath,
    nativeText: string,
    sections: EncodedCanonicalSectionDescriptor[],
): DecodedCanonicalSection[] | null {
    try {
        const result = behavior.decodeNativeFile({
            assetKind: "Subagent",
            nativeDialectId: behavior.profile.nativeDialectId,
            relativePath,
            nativeText,
            sections: structuredClone(sections),
        });
        if (result === null || Object.keys(result).length !== 1 || !Array.isArray(result.sections)) return null;
        const decoded = result.sections.map((section) => structuredClone(section));
        const expectedHandles = sections.map((section) => section.sectionHandle).sort(compareUtf8Bytes);
        const actualHandles = decoded.map((section) => section.sectionHandle).sort(compareUtf8Bytes);
        if (
            decoded.length !== sections.length ||
            new Set(actualHandles).size !== actualHandles.length ||
            stableStringify(actualHandles) !== stableStringify(expectedHandles) ||
            decoded.some(
                (section) =>
                    section.canonicalContent.contentKind !== "text" ||
                    normalizeText(section.canonicalContent.text).normalized !== section.canonicalContent.text ||
                    section.canonicalContent.text.trim() === "",
            )
        ) {
            return null;
        }
        return decoded.sort((left, right) => compareUtf8Bytes(left.sectionHandle, right.sectionHandle));
    } catch {
        return null;
    }
}

function decodedContentMatches(
    behavior: NativeProjectEncodedFileProviderBehavior,
    relativePath: PosixRelativePath,
    nativeText: string,
    sections: EncodedCanonicalSectionDescriptor[],
    canonicalFiles: readonly AssetVersionFileContentV2[],
): boolean {
    const decoded = safeDecodeNativeFile(behavior, relativePath, nativeText, sections);
    if (decoded === null || decoded.length !== canonicalFiles.length) return false;
    const sectionByKind = new Map(sections.map((section) => [section.semanticKind, section.sectionHandle]));
    return canonicalFiles.every((file) => {
        const kinds = fileSemanticKinds("Subagent", file);
        const handle = sectionByKind.get(kinds[0] as EncodedCanonicalSectionDescriptor["semanticKind"]);
        const value = decoded.find((section) => section.sectionHandle === handle)?.canonicalContent;
        return file.contentKind === "text" && value?.contentKind === "text" && value.text === file.text;
    });
}

export function hasEncodedFileSemanticClosure(
    semantics: readonly RenderAnalysisInput["requiredSemantics"][number][],
    asset: NativeProjectEncodedFileRenderAsset,
): boolean {
    const expected = [
        ...assetSemanticKinds("Subagent"),
        ...asset.version.files.flatMap((file) => fileSemanticKinds("Subagent", file)),
    ].sort(compareUtf8Bytes);
    const actual = semantics.map((semantic) => semantic.semanticKind).sort(compareUtf8Bytes);
    return (
        new Set(semantics.map((semantic) => semantic.semanticRefFingerprint)).size === semantics.length &&
        semantics.every(
            (semantic) =>
                semantic.subject.assetId === asset.version.ref.assetId &&
                semantic.subject.versionId === asset.version.ref.versionId,
        ) &&
        stableStringify(actual) === stableStringify(expected)
    );
}

export function canonicalSectionRefs(
    semantics: readonly RenderAnalysisInput["requiredSemantics"][number][],
    asset: NativeProjectEncodedFileRenderAsset,
    descriptor: EncodedCanonicalSectionDescriptor,
): Sha256Digest[] {
    const candidates = asset.version.files.filter((file) =>
        fileSemanticKinds("Subagent", file).includes(descriptor.semanticKind),
    );
    const file = candidates[0];
    if (candidates.length !== 1 || file === undefined) return [];
    return semantics
        .filter(
            (semantic) =>
                semantic.subject.subjectKind === "file" &&
                semantic.subject.fileId === file.file.fileId &&
                semantic.semanticKind === descriptor.semanticKind,
        )
        .map((semantic) => semantic.semanticRefFingerprint)
        .sort(compareUtf8Bytes);
}

export function makeEncodedFileOutputUnit(relativePath: PosixRelativePath, outputContract: OutputContractDefinitionV1) {
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        claims: [{ relativePath, contentKind: "text" as const, executable: false }],
        managedDirectoryBoundaries: [],
    };
    return { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
}

export function safePathValidation(behavior: NativeProjectEncodedFileProviderBehavior, relativePath: PosixRelativePath): boolean {
    try {
        return behavior.validatePath(relativePath) === true;
    } catch {
        return false;
    }
}

export function encodedFileDiagnostic(
    behavior: NativeProjectEncodedFileProviderBehavior,
    message: string,
    severity: OperationDiagnostic["severity"] = "error",
): OperationDiagnostic {
    return diagnostic(
        severity === "warning" ? "scan" : "render",
        `${behavior.adapterId.toLowerCase()}_${behavior.profile.targetScope}_subagent_encoded_file_blocked`,
        message,
        severity === "warning" ? "conflict" : "unsupported",
        severity,
    );
}
