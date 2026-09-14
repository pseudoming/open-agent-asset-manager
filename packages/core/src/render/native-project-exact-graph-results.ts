/** Exact native scope-bound graph matching and result construction. */

import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type {
    AdapterMaterializerCapability,
    AdapterTargetContextSchemaDeclaration,
    NativeProjectExactGraphAssetKind,
} from "../contracts/source-import";
import type {
    OutputContractDefinitionV1,
    ProviderRenderDialectInput,
    RenderAnalysisInput,
    RenderNativeRepresentationFileInput,
    VersionedContractComponentRef,
    CanonicalRenderEntryValidationInput,
    CanonicalNativePreservationSeed,
    CanonicalMaterializationAssessmentInput,
} from "../contracts/render";
import type { TargetFileContent, VersionRef } from "../contracts/common";
import type { AdapterId, AssetKind, OperationDiagnostic, PosixRelativePath, Sha256Digest } from "../types";
import { computeRenderOutputUnitFingerprint, stableStringify } from "../foundation/fingerprint";
import { isCanonicalRelativePath } from "../foundation/validators";
import { getAssetSpecHandler } from "../specs/registry";
import { assetSemanticKinds, fileSemanticKinds, versionRefKey } from "./render-semantics";
import { compareUtf8Bytes, diagnostic } from "./native-project-guidance-profiles";
import { isStrictDescendant } from "./render-inspection-primitives";
import type { NativeProjectExactGraphProfileDefinition } from "./native-project-exact-graph-profiles";

import { hasExactNativeDirectoryGraph } from "./native-directory-graph";
export { hasExactNativeDirectoryGraph } from "./native-directory-graph";
import { projectCanonicalOutputDirectories } from "./canonical-materialization-directories";
import {
    assessCanonicalMaterializationLosses,
    canonicalMaterializationAssessmentInput,
} from "./canonical-materialization-assessment";

import type { NativeDialectGraphRebaseMaterializerV1 as NativeProjectExactGraphRebaseMaterializer } from "../contracts/dialect";

type ProjectedAsset = RenderAnalysisInput["deployment"]["assets"][number];
type NativeInput = Extract<ProviderRenderDialectInput, { inputKind: "native_representation" }>;
type RestorationInput = Extract<ProviderRenderDialectInput, { inputKind: "dialect_restoration" }>;
type CanonicalMaterializationInput = Extract<ProviderRenderDialectInput, { inputKind: "canonical_materialization" }>;

export interface NativeProjectExactGraphProjection {
    /** Stable Provider-owned identity for collision detection; normally the native entry path. */
    graphIdentityRelativePath: PosixRelativePath;
    /** Exact native-to-Version path mapping. Every native and canonical file must appear exactly once. */
    files: {
        nativeRelativePath: PosixRelativePath;
        canonicalLogicalPath: PosixRelativePath;
    }[];
    /** Directories whose complete inventory belongs to this graph. A standalone graph may have none. */
    managedDirectoryBoundaries: PosixRelativePath[];
}

export type {
    NativeDialectGraphRebaseInputV1 as NativeProjectExactGraphRebaseInput,
    NativeDialectGraphRebaseMaterializerV1 as NativeProjectExactGraphRebaseMaterializer,
} from "../contracts/dialect";

export interface NativeProjectExactGraphCanonicalMaterializationInput {
    assetKind: NativeProjectExactGraphAssetKind;
    nativeDialectId: string;
    targetCanonical: Extract<ProjectedAsset["version"]["canonical"], { kind: NativeProjectExactGraphAssetKind }>;
    targetFiles: AssetVersionFileContentV2[];
    targetVersion: VersionRef;
    targetScope: "project" | "global";
    restorationInputs: RestorationInput[];
    nativePreservationSeed?: CanonicalNativePreservationSeed;
}

export interface NativeProjectExactGraphCanonicalMaterializer {
    ref: VersionedContractComponentRef;
    degradationKinds: [
        CanonicalMaterializationInput["degradationKinds"][number],
        ...CanonicalMaterializationInput["degradationKinds"],
    ];
    assessLoss?(input: CanonicalMaterializationAssessmentInput): CanonicalMaterializationInput["degradationKinds"] | null;
    /** Provider-owned alternate kind when canonical materialization is an explicit substitute. */
    substituteAssetKind?: AssetKind;
    reasonCode: string;
    preservationDialectIds?: string[];
    requiresNativeSourceAssessment?: true;
    diagnosticMessage: string;
    /** Independently parse and check the generated entry against the source canonical authority. */
    validateEntry(input: CanonicalRenderEntryValidationInput): boolean;
    materialize(
        input: NativeProjectExactGraphCanonicalMaterializationInput,
    ): { nativeFiles: RenderNativeRepresentationFileInput[] } | null;
}

export interface NativeProjectExactGraphProviderBehavior {
    adapterId: AdapterId;
    adapterVersion: string;
    profile: NativeProjectExactGraphProfileDefinition;
    profileConstraintFingerprint: Sha256Digest;
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    materializerCapability: AdapterMaterializerCapability;
    outputContract: OutputContractDefinitionV1;
    projectNativeGraph(files: readonly RenderNativeRepresentationFileInput[]): NativeProjectExactGraphProjection | null;
    parseChangedNativeFile(input: {
        assetKind: NativeProjectExactGraphAssetKind;
        nativeDialectId: string;
        relativePath: PosixRelativePath;
        appliedContent: TargetFileContent;
        currentContent: TargetFileContent;
    }): { canonicalContent: TargetFileContent } | null;
    rebaseMaterializer: NativeProjectExactGraphRebaseMaterializer | null;
    canonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer | null;
}

export type NativeProjectExactGraphRenderAsset = ProjectedAsset & {
    version: ProjectedAsset["version"] & {
        canonical: Extract<ProjectedAsset["version"]["canonical"], { kind: NativeProjectExactGraphAssetKind }>;
    };
};

interface NativeProjectExactGraphResolvedAssetBase {
    asset: NativeProjectExactGraphRenderAsset;
    restorationInputs: RestorationInput[];
    nativeFiles: RenderNativeRepresentationFileInput[];
    /** Complete immutable Version-owned graph, or null when no directory authority was saved. */
    nativeDirectoryPaths: PosixRelativePath[] | null;
    projection: NativeProjectExactGraphProjection;
}

export type NativeProjectExactGraphResolvedAsset = NativeProjectExactGraphResolvedAssetBase &
    (
        | {
              native: NativeInput;
              canonicalMaterialization: null;
              canonicalMaterializer: null;
          }
        | {
              native: null;
              canonicalMaterialization: CanonicalMaterializationInput;
              canonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer;
          }
    );

export function findExactGraphAssets(
    input: Pick<RenderAnalysisInput, "deployment" | "dialectInputs">,
    behavior: NativeProjectExactGraphProviderBehavior,
): NativeProjectExactGraphResolvedAsset[] | null {
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
    const resolved: NativeProjectExactGraphResolvedAsset[] = [];
    for (const asset of input.deployment.assets) {
        if (asset.version.canonical.kind !== behavior.profile.assetKind) return null;
        const entryFiles = asset.version.files.filter((file) => file.file.role === "entry");
        const group = dialectByVersion.get(versionRefKey(asset.version.ref)) as (typeof input.dialectInputs)[number];
        const projected = exactGraphInputs(group, asset, behavior);
        if (
            !matchesExactGraphTargetScope(asset, behavior.profile.targetScope) ||
            asset.scopePath !== "" ||
            asset.version.status !== "complete" ||
            asset.version.files.length === 0 ||
            entryFiles.length !== 1 ||
            entryFiles[0]?.contentKind !== "text" ||
            !getAssetSpecHandler(behavior.profile.assetKind).validateEntryText(entryFiles[0].text) ||
            projected === null
        ) {
            return null;
        }
        const nativeFiles = projected.native
            ? projected.native.inputRole === "current_exact"
                ? cloneNativeFiles(projected.native.files)
                : safeNativeGraphRebase(
                      behavior,
                      behavior.rebaseMaterializer as NativeProjectExactGraphRebaseMaterializer,
                      asset as NativeProjectExactGraphRenderAsset,
                      projected.native as Extract<NativeInput, { inputRole: "parent_rebase_seed" }>,
                      projected.restorationInputs,
                  )
            : safeCanonicalGraphMaterialization(
                  behavior,
                  projected.canonicalMaterializer,
                  asset as NativeProjectExactGraphRenderAsset,
                  projected.restorationInputs,
                  projected.canonicalMaterialization.nativePreservationSeed,
              );
        if (nativeFiles === null) return null;
        const projection = safeGraphProjection(behavior, nativeFiles, asset.version.files);
        if (projection === null) return null;
        const logicalDirectoryPaths = projected.canonicalMaterialization?.logicalDirectoryPaths;
        const nativeDirectoryPaths =
            projected.native?.representation.schemaVersion === 2
                ? [...projected.native.representation.directories]
                : projectCanonicalOutputDirectories(logicalDirectoryPaths, projection);
        if (logicalDirectoryPaths !== undefined && nativeDirectoryPaths === null) return null;
        if (
            nativeDirectoryPaths !== null &&
            !hasExactNativeDirectoryGraph(
                nativeDirectoryPaths,
                nativeFiles.map((file) => file.relativePath),
                projection.managedDirectoryBoundaries,
            )
        ) {
            return null;
        }
        const resolvedBase: NativeProjectExactGraphResolvedAssetBase = {
            asset: asset as NativeProjectExactGraphRenderAsset,
            restorationInputs: projected.restorationInputs,
            nativeFiles,
            nativeDirectoryPaths,
            projection,
        };
        resolved.push(
            projected.native === null
                ? {
                      ...resolvedBase,
                      native: null,
                      canonicalMaterialization: projected.canonicalMaterialization,
                      canonicalMaterializer: projected.canonicalMaterializer,
                  }
                : {
                      ...resolvedBase,
                      native: projected.native,
                      canonicalMaterialization: null,
                      canonicalMaterializer: null,
                  },
        );
    }
    resolved.sort((left, right) =>
        compareUtf8Bytes(
            `${left.projection.graphIdentityRelativePath}\0${versionRefKey(left.asset.version.ref)}`,
            `${right.projection.graphIdentityRelativePath}\0${versionRefKey(right.asset.version.ref)}`,
        ),
    );
    return new Set(resolved.map((item) => item.projection.graphIdentityRelativePath)).size === resolved.length ? resolved : null;
}

function matchesExactGraphTargetScope(
    asset: ProjectedAsset,
    targetScope: NativeProjectExactGraphProfileDefinition["targetScope"],
): boolean {
    return targetScope === "project"
        ? asset.scope === "project" && asset.projectId !== ""
        : asset.scope === "global" && asset.projectId === "";
}

function exactGraphInputs(
    group: RenderAnalysisInput["dialectInputs"][number],
    asset: ProjectedAsset,
    behavior: NativeProjectExactGraphProviderBehavior,
):
    | ({ restorationInputs: RestorationInput[] } & (
          | { native: NativeInput; canonicalMaterialization: null; canonicalMaterializer: null }
          | {
                native: null;
                canonicalMaterialization: CanonicalMaterializationInput;
                canonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer;
            }
      ))
    | null {
    const nativeInputs = group.inputs.filter(
        (candidate): candidate is NativeInput => candidate.inputKind === "native_representation",
    );
    const restorationInputs = group.inputs.filter(
        (candidate): candidate is RestorationInput => candidate.inputKind === "dialect_restoration",
    );
    const canonicalInputs = group.inputs.filter(
        (candidate): candidate is CanonicalMaterializationInput => candidate.inputKind === "canonical_materialization",
    );
    let authority:
        | { native: NativeInput; canonicalMaterialization: null; canonicalMaterializer: null }
        | {
              native: null;
              canonicalMaterialization: CanonicalMaterializationInput;
              canonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer;
          };
    if (nativeInputs.length === 1 && canonicalInputs.length === 0) {
        authority = {
            native: nativeInputs[0] as NativeInput,
            canonicalMaterialization: null,
            canonicalMaterializer: null,
        };
    } else if (nativeInputs.length === 0 && canonicalInputs.length === 1) {
        const canonicalMaterialization = canonicalInputs[0] as CanonicalMaterializationInput;
        const canonicalMaterializer = behavior.canonicalMaterializer;
        if (canonicalMaterializer === null || !matchesCanonicalMaterialization(canonicalMaterialization, behavior, asset)) {
            return null;
        }
        authority = { native: null, canonicalMaterialization, canonicalMaterializer };
    } else {
        return null;
    }
    const candidate = authority.native;
    if (
        versionRefKey(group.targetVersion) !== versionRefKey(asset.version.ref) ||
        group.inputs.length !== 1 + restorationInputs.length ||
        (candidate !== null && candidate.representation.dialectId !== behavior.profile.nativeDialectId) ||
        (candidate !== null && candidate.files.length === 0) ||
        (candidate?.inputRole === "parent_rebase_seed" && behavior.rebaseMaterializer === null) ||
        (candidate?.inputRole === "parent_rebase_seed" &&
            (candidate.sourceVersion.assetId !== group.targetVersion.assetId ||
                candidate.sourceVersion.versionId === group.targetVersion.versionId)) ||
        stableStringify(restorationInputs.map((item) => item.restoration.dialectId)) !==
            stableStringify(behavior.profile.restorationDialectIds)
    ) {
        return null;
    }
    return {
        ...authority,
        restorationInputs,
    };
}

function matchesCanonicalMaterialization(
    input: CanonicalMaterializationInput | undefined,
    behavior: NativeProjectExactGraphProviderBehavior,
    asset: ProjectedAsset,
): input is CanonicalMaterializationInput {
    const declared = behavior.profile.canonicalMaterialization;
    return (
        input !== undefined &&
        declared !== null &&
        input.nativeDialectId === behavior.profile.nativeDialectId &&
        stableStringify(input.materializer) === stableStringify(declared.materializer) &&
        stableStringify(input.degradationKinds) ===
            stableStringify(
                assessCanonicalMaterializationLosses(
                    declared,
                    behavior.canonicalMaterializer,
                    canonicalMaterializationAssessmentInput(
                        asset,
                        behavior.profile.nativeDialectId,
                        behavior.profile.targetScope,
                        input.nativePreservationSeed,
                    ),
                ),
            ) &&
        input.substituteAssetKind === declared.substituteAssetKind &&
        input.reasonCode === declared.reasonCode &&
        (input.nativePreservationSeed === undefined ||
            declared.preservationDialectIds?.includes(input.nativePreservationSeed.representation.dialectId) === true)
    );
}

export function safeGraphProjection(
    behavior: NativeProjectExactGraphProviderBehavior,
    nativeFiles: readonly RenderNativeRepresentationFileInput[],
    canonicalFiles?: readonly AssetVersionFileContentV2[],
): NativeProjectExactGraphProjection | null {
    try {
        const projected = behavior.projectNativeGraph(cloneNativeFiles(nativeFiles));
        if (projected === null || !isCanonicalRelativePath(projected.graphIdentityRelativePath)) return null;
        const nativePaths = nativeFiles.map((file) => file.relativePath).sort(compareUtf8Bytes);
        const mappingNativePaths = projected.files.map((file) => file.nativeRelativePath).sort(compareUtf8Bytes);
        const projectedCanonical = projected.files.map((file) => file.canonicalLogicalPath).sort(compareUtf8Bytes);
        const expectedCanonical = canonicalFiles?.map((file) => file.file.logicalPath).sort(compareUtf8Bytes);
        const identityMapping = projected.files.find((file) => file.nativeRelativePath === projected.graphIdentityRelativePath);
        const identityCanonicalFiles =
            canonicalFiles?.filter((file) => file.file.logicalPath === identityMapping?.canonicalLogicalPath) ?? [];
        const boundaries = [...projected.managedDirectoryBoundaries].sort(compareUtf8Bytes);
        const patch = behavior.profile.jsoncTopLevelPropertyPatch;
        const patchFiles =
            patch === undefined
                ? []
                : nativeFiles.filter((file) => patch.allowedContainerRelativePaths.includes(file.relativePath));
        if (
            new Set(nativePaths).size !== nativePaths.length ||
            new Set(mappingNativePaths).size !== mappingNativePaths.length ||
            new Set(projectedCanonical).size !== projectedCanonical.length ||
            stableStringify(nativePaths) !== stableStringify(mappingNativePaths) ||
            !nativePaths.includes(projected.graphIdentityRelativePath) ||
            projected.files.some(
                (file) =>
                    !isCanonicalRelativePath(file.nativeRelativePath) || !isCanonicalRelativePath(file.canonicalLogicalPath),
            ) ||
            !hasExactGraphBoundaryClosure(nativePaths, boundaries, behavior.profile.jsoncTopLevelPropertyPatch !== undefined) ||
            (patch !== undefined &&
                (patchFiles.length !== 1 || patchFiles[0]?.contentKind !== "binary" || patchFiles[0].executable)) ||
            (canonicalFiles !== undefined &&
                (identityMapping === undefined ||
                    identityCanonicalFiles.length !== 1 ||
                    (patch === undefined
                        ? identityCanonicalFiles[0]?.file.role !== "entry"
                        : !patch.allowedContainerRelativePaths.includes(projected.graphIdentityRelativePath) ||
                          identityCanonicalFiles[0]?.file.role !== "resource" ||
                          identityCanonicalFiles[0]?.contentKind !== "binary" ||
                          identityCanonicalFiles[0]?.file.executable))) ||
            (expectedCanonical !== undefined && stableStringify(expectedCanonical) !== stableStringify(projectedCanonical))
        ) {
            return null;
        }
        return {
            graphIdentityRelativePath: projected.graphIdentityRelativePath,
            files: projected.files
                .map((file) => ({ ...file }))
                .sort((left, right) => compareUtf8Bytes(left.nativeRelativePath, right.nativeRelativePath)),
            managedDirectoryBoundaries: boundaries,
        };
    } catch {
        return null;
    }
}

export function hasExactGraphBoundaryClosure(
    nativeRelativePaths: readonly PosixRelativePath[],
    managedDirectoryBoundaries: readonly PosixRelativePath[],
    listedFilesOnly = false,
): boolean {
    if (nativeRelativePaths.length === 0 || new Set(managedDirectoryBoundaries).size !== managedDirectoryBoundaries.length) {
        return false;
    }
    if (listedFilesOnly) return managedDirectoryBoundaries.length === 0;
    if (nativeRelativePaths.length > 1 && managedDirectoryBoundaries.length === 0) return false;
    if (
        managedDirectoryBoundaries.some(
            (boundary, index) =>
                !isCanonicalRelativePath(boundary) ||
                !nativeRelativePaths.some((path) => isStrictDescendant(path, boundary)) ||
                managedDirectoryBoundaries.some(
                    (candidate, candidateIndex) =>
                        candidateIndex !== index &&
                        (isStrictDescendant(boundary, candidate) || isStrictDescendant(candidate, boundary)),
                ),
        )
    ) {
        return false;
    }
    return (
        managedDirectoryBoundaries.length === 0 ||
        nativeRelativePaths.every(
            (path) => managedDirectoryBoundaries.filter((boundary) => isStrictDescendant(path, boundary)).length === 1,
        )
    );
}

function safeNativeGraphRebase(
    behavior: NativeProjectExactGraphProviderBehavior,
    materializer: NativeProjectExactGraphRebaseMaterializer,
    asset: NativeProjectExactGraphRenderAsset,
    native: Extract<NativeInput, { inputRole: "parent_rebase_seed" }>,
    restorationInputs: RestorationInput[],
): RenderNativeRepresentationFileInput[] | null {
    try {
        const result = materializer.materialize(
            structuredClone({
                assetKind: behavior.profile.assetKind,
                nativeDialectId: behavior.profile.nativeDialectId,
                targetCanonical: asset.version.canonical,
                targetFiles: asset.version.files,
                parent: {
                    sourceVersion: native.sourceVersion,
                    representation: native.representation,
                    files: native.files,
                },
                restorationInputs,
            }),
        );
        if (result === null || Object.keys(result).length !== 1 || !Array.isArray(result.nativeFiles)) return null;
        const files = cloneNativeFiles(result.nativeFiles);
        const parentShape = native.files.map(({ relativePath, contentKind, mediaType }) => ({
            relativePath,
            contentKind,
            mediaType,
        }));
        const resultShape = files.map(({ relativePath, contentKind, mediaType }) => ({
            relativePath,
            contentKind,
            mediaType,
        }));
        return safeGraphProjection(behavior, files, asset.version.files) === null ||
            stableStringify(parentShape) !== stableStringify(resultShape)
            ? null
            : files;
    } catch {
        return null;
    }
}

function safeCanonicalGraphMaterialization(
    behavior: NativeProjectExactGraphProviderBehavior,
    materializer: NativeProjectExactGraphCanonicalMaterializer,
    asset: NativeProjectExactGraphRenderAsset,
    restorationInputs: RestorationInput[],
    nativePreservationSeed: CanonicalNativePreservationSeed | undefined,
): RenderNativeRepresentationFileInput[] | null {
    try {
        const result = materializer.materialize(
            structuredClone({
                assetKind: behavior.profile.assetKind,
                nativeDialectId: behavior.profile.nativeDialectId,
                targetCanonical: asset.version.canonical,
                targetFiles: asset.version.files,
                targetVersion: asset.version.ref,
                targetScope: behavior.profile.targetScope,
                restorationInputs,
                ...(nativePreservationSeed === undefined ? {} : { nativePreservationSeed }),
            }),
        );
        if (result === null || Object.keys(result).length !== 1 || !Array.isArray(result.nativeFiles)) return null;
        const files = cloneNativeFiles(result.nativeFiles);
        return safeGraphProjection(behavior, files, asset.version.files) === null ? null : files;
    } catch {
        return null;
    }
}

export function safeGraphReverseParse(
    behavior: NativeProjectExactGraphProviderBehavior,
    relativePath: PosixRelativePath,
    appliedContent: TargetFileContent,
    currentContent: TargetFileContent,
): { canonicalContent: TargetFileContent } | null {
    try {
        const result = behavior.parseChangedNativeFile({
            assetKind: behavior.profile.assetKind,
            nativeDialectId: behavior.profile.nativeDialectId,
            relativePath,
            appliedContent: structuredClone(appliedContent),
            currentContent: structuredClone(currentContent),
        });
        if (
            result === null ||
            Object.keys(result).length !== 1 ||
            (result.canonicalContent.contentKind !== "text" && result.canonicalContent.contentKind !== "binary")
        ) {
            return null;
        }
        return { canonicalContent: structuredClone(result.canonicalContent) };
    } catch {
        return null;
    }
}

export function graphSemanticRefs(
    semantics: readonly RenderAnalysisInput["requiredSemantics"][number][],
    asset: NativeProjectExactGraphRenderAsset,
    canonicalLogicalPath: string,
): Sha256Digest[] {
    const canonicalFile = asset.version.files.find((file) => file.file.logicalPath === canonicalLogicalPath);
    if (canonicalFile === undefined) return [];
    const fileKinds = fileSemanticKinds(asset.version.canonical.kind, canonicalFile);
    const refs = semantics
        .filter(
            (semantic) =>
                (semantic.subject.subjectKind === "file" &&
                    semantic.subject.fileId === canonicalFile.file.fileId &&
                    fileKinds.includes(semantic.semanticKind)) ||
                (canonicalFile.file.role === "entry" &&
                    semantic.subject.subjectKind === "asset" &&
                    assetSemanticKinds(asset.version.canonical.kind).includes(semantic.semanticKind)),
        )
        .map((semantic) => semantic.semanticRefFingerprint)
        .sort(compareUtf8Bytes);
    return refs;
}

export function canonicalPathForNativeGraphFile(
    projection: NativeProjectExactGraphProjection,
    nativeRelativePath: PosixRelativePath,
): PosixRelativePath {
    const matches = projection.files.filter((file) => file.nativeRelativePath === nativeRelativePath);
    if (matches.length !== 1) throw new Error("native exact-graph file has no unique canonical mapping");
    return (matches[0] as NativeProjectExactGraphProjection["files"][number]).canonicalLogicalPath;
}

export function hasExactGraphSemanticClosure(
    semantics: readonly RenderAnalysisInput["requiredSemantics"][number][],
    asset: NativeProjectExactGraphRenderAsset,
): boolean {
    const expected = [
        ...assetSemanticKinds(asset.version.canonical.kind),
        ...asset.version.files.flatMap((file) => fileSemanticKinds(asset.version.canonical.kind, file)),
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

export function makeExactGraphOutputUnit(
    resolved: Pick<NativeProjectExactGraphResolvedAsset, "nativeFiles" | "nativeDirectoryPaths" | "projection">,
    outputContract: OutputContractDefinitionV1,
) {
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        claims: resolved.nativeFiles
            .map((file) => ({ relativePath: file.relativePath, contentKind: file.contentKind, executable: file.executable }))
            .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath)),
        managedDirectoryBoundaries: resolved.projection.managedDirectoryBoundaries.map((relativePath) =>
            resolved.nativeDirectoryPaths === null
                ? {
                      relativePath,
                      boundaryKind: "directory_inventory" as const,
                  }
                : {
                      schemaVersion: 2 as const,
                      relativePath,
                      boundaryKind: "directory_inventory" as const,
                      desiredDirectoryPaths: resolved.nativeDirectoryPaths.filter(
                          (path) => path === relativePath || isStrictDescendant(path, relativePath),
                      ),
                  },
        ),
    };
    return { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
}

export function exactGraphDiagnostic(
    behavior: NativeProjectExactGraphProviderBehavior,
    message: string,
    severity: OperationDiagnostic["severity"] = "error",
): OperationDiagnostic {
    return diagnostic(
        severity === "warning" ? "scan" : "render",
        `${behavior.adapterId.toLowerCase()}_${behavior.profile.targetScope}_${behavior.profile.assetKind.toLowerCase()}_exact_graph_blocked`,
        message,
        severity === "warning" ? "conflict" : "unsupported",
        severity,
    );
}

function cloneNativeFiles(files: readonly RenderNativeRepresentationFileInput[]): RenderNativeRepresentationFileInput[] {
    return files
        .map((file) =>
            file.contentKind === "text"
                ? { ...structuredClone(file), text: file.text }
                : { ...structuredClone(file), bytes: new Uint8Array(file.bytes) },
        )
        .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
}
