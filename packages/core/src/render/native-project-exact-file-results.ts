/** Exact current-native one-file matching and result construction. */

import { normalizeText } from "../catalog/payload-store";
import type { AdapterMaterializerCapability, AdapterTargetContextSchemaDeclaration } from "../contracts/source-import";
import type {
    AdapterRenderAnalysisResult,
    OutputContractDefinitionV1,
    ProviderRenderDialectInput,
    RenderAnalysisInput,
    RenderMaterializationResult,
} from "../contracts/render";
import type {
    AdapterRenderedTargetInspectionResult,
    ChangedRenderedTargetFileInput,
    RenderedTargetInspectionInput,
} from "../contracts/reverse";
import type {
    AdapterId,
    AssetKindTypeDataV2,
    AssetVersionFileContentV2,
    OperationDiagnostic,
    PosixRelativePath,
    Sha256Digest,
    VersionedContractComponentRef,
    VersionRef,
} from "../types";
import type { MemoryCatalogTypeDataV2 } from "../contracts/specs";
import { computeRenderOutputUnitFingerprint, stableStringify } from "../foundation/fingerprint";
import { getAssetSpecHandler } from "../specs/registry";
import { assetSemanticKinds, entrySemanticKind, versionRefKey } from "./render-semantics";
import { compareUtf8Bytes, diagnostic } from "./native-project-guidance-profiles";
import type { NativeProjectExactFileProfileDefinition } from "./native-project-exact-file-profiles";

export interface NativeProjectExactFileProviderBehavior {
    adapterId: AdapterId;
    adapterVersion: string;
    profile: NativeProjectExactFileProfileDefinition;
    profileConstraintFingerprint: Sha256Digest;
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    materializerCapability: AdapterMaterializerCapability;
    outputContract: OutputContractDefinitionV1;
    validateProjectPath(relativePath: PosixRelativePath): boolean;
    parseChangedNativeText(input: {
        assetKind: NativeProjectExactFileProfileDefinition["assetKind"];
        nativeDialectId: string;
        relativePath: PosixRelativePath;
        appliedNativeText: string;
        currentNativeText: string;
    }): { canonicalEntryText: string } | null;
    memoryCatalog: {
        parse(input: { nativeDialectId: string; relativePath: PosixRelativePath; nativeText: string }): {
            members: Array<{
                relativePath: PosixRelativePath;
                routingTitle: string;
                routingHint: string;
            }>;
        } | null;
        resolveMemberPath(input: {
            targetAssetVersionId: string;
            memberAsset: ProjectedAsset;
            dialectInputs: RenderAnalysisInput["dialectInputs"];
        }): PosixRelativePath | null;
    } | null;
    rebaseMaterializer: NativeProjectExactFileRebaseMaterializer | null;
}

type ProjectedAsset = RenderAnalysisInput["deployment"]["assets"][number];
type NativeProjectExactFileCanonical =
    | Extract<AssetKindTypeDataV2, { kind: "Rule" | "Workflow" | "Skill" | "Subagent" }>
    | Extract<AssetKindTypeDataV2, { kind: "Memory" }>;
export type NativeProjectExactFileRenderAsset = ProjectedAsset & {
    version: ProjectedAsset["version"] & {
        canonical: NativeProjectExactFileCanonical;
    };
};

type ExactNativeRepresentationInput = Extract<ProviderRenderDialectInput, { inputKind: "native_representation" }>;
type ExactRestorationInput = Extract<ProviderRenderDialectInput, { inputKind: "dialect_restoration" }>;

export interface ExactNativeInput {
    input: ExactNativeRepresentationInput;
    file: Extract<
        Extract<ProviderRenderDialectInput, { inputKind: "native_representation" }>["files"][number],
        { contentKind: "text" }
    >;
}

type ParentNativeInput = ExactNativeInput & {
    input: Extract<ExactNativeRepresentationInput, { inputRole: "parent_rebase_seed" }>;
};

export interface NativeProjectExactFileRebaseInput {
    assetKind: NativeProjectExactFileProfileDefinition["assetKind"];
    nativeDialectId: string;
    targetCanonical: NativeProjectExactFileCanonical;
    targetFiles: AssetVersionFileContentV2[];
    parent: {
        sourceVersion: VersionRef;
        representation: ExactNativeRepresentationInput["representation"];
        file: ExactNativeInput["file"];
    };
    restorationInputs: ExactRestorationInput[];
    memoryCatalogMembers: NativeProjectMemoryCatalogMemberTarget[];
}

export interface NativeProjectMemoryCatalogMemberTarget {
    targetAssetVersionId: string;
    relativePath: PosixRelativePath;
    routingTitle: string;
    routingHint: string;
}

export interface NativeProjectExactFileRebaseMaterializer {
    ref: VersionedContractComponentRef;
    materialize(input: NativeProjectExactFileRebaseInput): { nativeText: string } | null;
}

export interface NativeProjectExactFileResolvedAsset {
    asset: NativeProjectExactFileRenderAsset;
    native: ExactNativeInput;
    restorationInputs: ExactRestorationInput[];
    materializedText: string;
    memoryCatalogMembers: NativeProjectMemoryCatalogMemberTarget[];
}

export function findExactFileAssets(
    input: Pick<RenderAnalysisInput, "deployment" | "dialectInputs">,
    behavior: NativeProjectExactFileProviderBehavior,
): NativeProjectExactFileResolvedAsset[] | null {
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
    const primaryAssets = (input.deployment.assets as ProjectedAsset[]).filter((asset) =>
        behavior.memoryCatalog === null
            ? !(asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog")
            : asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog",
    );
    if (primaryAssets.length === 0) return null;
    if (
        behavior.memoryCatalog !== null &&
        input.deployment.assets.some(
            (asset) =>
                asset.version.canonical.kind !== "Memory" ||
                (asset.version.canonical.typeData.entityRole !== "catalog" &&
                    asset.version.canonical.typeData.entityRole !== "unit"),
        )
    ) {
        return null;
    }
    const resolved: NativeProjectExactFileResolvedAsset[] = [];
    for (const asset of primaryAssets) {
        if (
            asset.version.canonical.kind !== behavior.profile.assetKind ||
            (asset.version.canonical.kind === "Memory" &&
                (behavior.memoryCatalog === null
                    ? asset.version.canonical.typeData.entityRole !== "unit"
                    : asset.version.canonical.typeData.entityRole !== "catalog"))
        ) {
            return null;
        }
        const entry = asset.version.files[0];
        const projected = exactNativeInputs(
            dialectByVersion.get(versionRefKey(asset.version.ref)) as RenderAnalysisInput["dialectInputs"][number],
            asset,
            behavior,
        );
        const isCatalog = asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog";
        const memoryCatalogMembers = isCatalog
            ? resolveMemoryCatalogMembers(asset, input, behavior)
            : ([] as NativeProjectMemoryCatalogMemberTarget[]);
        if (
            asset.scope !== "project" ||
            asset.projectId === "" ||
            asset.scopePath !== "" ||
            asset.version.status !== "complete" ||
            (isCatalog
                ? asset.version.files.length !== 0 || memoryCatalogMembers === null
                : asset.version.files.length !== 1 ||
                  entry?.file.role !== "entry" ||
                  entry.contentKind !== "text" ||
                  entry.file.executable ||
                  entry.file.references.length !== 0 ||
                  normalizeText(entry.text).normalized !== entry.text ||
                  entry.text.trim() === "" ||
                  !getAssetSpecHandler(behavior.profile.assetKind).validateEntryText(entry.text)) ||
            projected === null
        ) {
            return null;
        }
        const typedAsset = asset as NativeProjectExactFileRenderAsset;
        const materializedText =
            projected.native.input.inputRole === "current_exact"
                ? projected.native.file.text
                : safeNativeRebase(
                      behavior,
                      behavior.rebaseMaterializer as NativeProjectExactFileRebaseMaterializer,
                      typedAsset,
                      projected.native as ParentNativeInput,
                      projected.restorationInputs,
                      memoryCatalogMembers as NativeProjectMemoryCatalogMemberTarget[],
                  );
        if (
            materializedText === null ||
            (isCatalog &&
                (!targetSnapshotMatchesSeed(input.deployment, projected.native) ||
                    !memoryCatalogTextMatches(
                        behavior,
                        projected.native.file.relativePath,
                        materializedText,
                        memoryCatalogMembers as NativeProjectMemoryCatalogMemberTarget[],
                    )))
        ) {
            return null;
        }
        resolved.push({
            asset: typedAsset,
            native: projected.native,
            restorationInputs: projected.restorationInputs,
            materializedText,
            memoryCatalogMembers: memoryCatalogMembers as NativeProjectMemoryCatalogMemberTarget[],
        });
    }
    resolved.sort((left, right) =>
        compareUtf8Bytes(
            `${left.native.file.relativePath}\0${versionRefKey(left.asset.version.ref)}`,
            `${right.native.file.relativePath}\0${versionRefKey(right.asset.version.ref)}`,
        ),
    );
    return new Set(resolved.map((item) => item.native.file.relativePath)).size === resolved.length ? resolved : null;
}

function resolveMemoryCatalogMembers(
    catalog: ProjectedAsset,
    input: Pick<RenderAnalysisInput, "deployment" | "dialectInputs">,
    behavior: NativeProjectExactFileProviderBehavior,
): NativeProjectMemoryCatalogMemberTarget[] | null {
    const catalogBehavior = behavior.memoryCatalog as NonNullable<NativeProjectExactFileProviderBehavior["memoryCatalog"]>;
    const result: NativeProjectMemoryCatalogMemberTarget[] = [];
    const catalogCanonical = catalog.version.canonical as { kind: "Memory"; typeData: MemoryCatalogTypeDataV2 };
    for (const member of catalogCanonical.typeData.members) {
        const matches = input.deployment.assets.filter(
            (candidate) => candidate.version.ref.versionId === member.targetAssetVersionId,
        );
        const memberAsset = matches[0];
        if (
            matches.length !== 1 ||
            memberAsset === undefined ||
            memberAsset.version.canonical.kind !== "Memory" ||
            memberAsset.version.canonical.typeData.entityRole !== "unit" ||
            memberAsset.version.status !== "complete" ||
            memberAsset.scope !== catalog.scope ||
            memberAsset.projectId !== catalog.projectId ||
            memberAsset.scopePath !== catalog.scopePath
        ) {
            return null;
        }
        let relativePath: PosixRelativePath | null;
        try {
            relativePath = catalogBehavior.resolveMemberPath({
                targetAssetVersionId: member.targetAssetVersionId,
                memberAsset,
                dialectInputs: input.dialectInputs,
            });
        } catch {
            return null;
        }
        if (relativePath === null || !safeCanonicalPath(relativePath)) return null;
        result.push({ ...structuredClone(member), relativePath });
    }
    return new Set(result.map((member) => member.relativePath)).size === result.length ? result : null;
}

function targetSnapshotMatchesSeed(deployment: RenderAnalysisInput["deployment"], native: ExactNativeInput): boolean {
    const snapshots = deployment.targetFileSnapshots ?? [];
    const matches = snapshots.filter((snapshot) => snapshot.relativePath === native.file.relativePath);
    if (matches.length !== 1) return false;
    const snapshot = matches[0];
    return (
        snapshot?.snapshotState === "missing" ||
        (snapshot?.snapshotState === "present" &&
            snapshot.contentHash === native.file.contentHash &&
            snapshot.byteSize === native.file.byteSize &&
            snapshot.executable === native.file.executable)
    );
}

function safeCanonicalPath(relativePath: PosixRelativePath): boolean {
    return (
        relativePath !== "" &&
        !relativePath.includes("\\") &&
        !relativePath.includes("\0") &&
        relativePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
}

function exactNativeInputs(
    group: RenderAnalysisInput["dialectInputs"][number],
    asset: ProjectedAsset,
    behavior: NativeProjectExactFileProviderBehavior,
): { native: ExactNativeInput; restorationInputs: ExactRestorationInput[] } | null {
    const nativeInputs = group.inputs.filter(
        (candidate): candidate is ExactNativeRepresentationInput => candidate.inputKind === "native_representation",
    );
    const restorationInputs = group.inputs.filter(
        (candidate): candidate is ExactRestorationInput => candidate.inputKind === "dialect_restoration",
    );
    const candidate = nativeInputs?.[0];
    const restorationIds = restorationInputs?.map((input) => input.restoration.dialectId);
    if (
        versionRefKey(group.targetVersion) !== versionRefKey(asset.version.ref) ||
        nativeInputs?.length !== 1 ||
        restorationInputs === undefined ||
        group.inputs.length !== 1 + restorationInputs.length ||
        candidate === undefined ||
        candidate.representation.dialectId !== behavior.profile.nativeDialectId ||
        candidate.files.length !== 1 ||
        (candidate.inputRole === "parent_rebase_seed" && behavior.rebaseMaterializer === null) ||
        (candidate.inputRole === "parent_rebase_seed" &&
            (candidate.sourceVersion === undefined ||
                candidate.sourceVersion.assetId !== group.targetVersion.assetId ||
                candidate.sourceVersion.versionId === group.targetVersion.versionId)) ||
        stableStringify(restorationIds) !== stableStringify(behavior.profile.restorationDialectIds)
    ) {
        return null;
    }
    const file = candidate.files[0];
    if (
        file?.contentKind !== "text" ||
        file.executable ||
        normalizeText(file.text).normalized !== file.text ||
        !safePathValidation(behavior, file.relativePath)
    ) {
        return null;
    }
    return { native: { input: candidate, file }, restorationInputs };
}

export function safePathValidation(behavior: NativeProjectExactFileProviderBehavior, relativePath: PosixRelativePath): boolean {
    try {
        return behavior.validateProjectPath(relativePath) === true;
    } catch {
        return false;
    }
}

export function safeReverseParse(
    behavior: NativeProjectExactFileProviderBehavior,
    relativePath: PosixRelativePath,
    appliedNativeText: string,
    currentNativeText: string,
): { canonicalEntryText: string } | null {
    try {
        const parsed = behavior.parseChangedNativeText({
            assetKind: behavior.profile.assetKind,
            nativeDialectId: behavior.profile.nativeDialectId,
            relativePath,
            appliedNativeText,
            currentNativeText,
        });
        if (
            parsed === null ||
            typeof parsed !== "object" ||
            typeof parsed.canonicalEntryText !== "string" ||
            normalizeText(parsed.canonicalEntryText).normalized !== parsed.canonicalEntryText ||
            parsed.canonicalEntryText.trim() === "" ||
            !getAssetSpecHandler(behavior.profile.assetKind).validateEntryText(parsed.canonicalEntryText)
        ) {
            return null;
        }
        return { canonicalEntryText: parsed.canonicalEntryText };
    } catch {
        return null;
    }
}

function safeNativeRebase(
    behavior: NativeProjectExactFileProviderBehavior,
    materializer: NativeProjectExactFileRebaseMaterializer,
    asset: NativeProjectExactFileRenderAsset,
    native: ParentNativeInput,
    restorationInputs: ExactRestorationInput[],
    memoryCatalogMembers: NativeProjectMemoryCatalogMemberTarget[],
): string | null {
    try {
        const result = materializer.materialize(
            structuredClone({
                assetKind: behavior.profile.assetKind,
                nativeDialectId: behavior.profile.nativeDialectId,
                targetCanonical: asset.version.canonical,
                targetFiles: asset.version.files,
                parent: {
                    sourceVersion: native.input.sourceVersion,
                    representation: native.input.representation,
                    file: native.file,
                },
                restorationInputs,
                memoryCatalogMembers,
            }),
        );
        if (
            result === null ||
            typeof result !== "object" ||
            Object.keys(result).length !== 1 ||
            typeof result.nativeText !== "string" ||
            normalizeText(result.nativeText).normalized !== result.nativeText ||
            result.nativeText.trim() === ""
        ) {
            return null;
        }
        if (asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog") {
            return memoryCatalogTextMatches(behavior, native.file.relativePath, result.nativeText, memoryCatalogMembers)
                ? result.nativeText
                : null;
        }
        const parsed = safeReverseParse(behavior, native.file.relativePath, result.nativeText, result.nativeText);
        const targetEntry = asset.version.files.find((file) => file.file.role === "entry");
        return targetEntry?.contentKind === "text" && parsed?.canonicalEntryText === targetEntry.text ? result.nativeText : null;
    } catch {
        return null;
    }
}

export function safeMemoryCatalogParse(
    behavior: NativeProjectExactFileProviderBehavior,
    relativePath: PosixRelativePath,
    nativeText: string,
): NativeProjectMemoryCatalogMemberTarget[] | null {
    if (behavior.memoryCatalog === null) return null;
    try {
        const parsed = behavior.memoryCatalog.parse({
            nativeDialectId: behavior.profile.nativeDialectId,
            relativePath,
            nativeText,
        });
        if (parsed === null || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.members)) return null;
        const members = parsed.members.map((member) => ({
            targetAssetVersionId: "",
            relativePath: member.relativePath,
            routingTitle: member.routingTitle,
            routingHint: member.routingHint,
        }));
        if (
            members.some(
                (member) =>
                    !safeCanonicalPath(member.relativePath) ||
                    member.routingTitle.trim() === "" ||
                    member.routingTitle.includes("\0") ||
                    member.routingHint.includes("\0"),
            ) ||
            new Set(members.map((member) => member.relativePath)).size !== members.length
        ) {
            return null;
        }
        return members;
    } catch {
        return null;
    }
}

function memoryCatalogTextMatches(
    behavior: NativeProjectExactFileProviderBehavior,
    relativePath: PosixRelativePath,
    nativeText: string,
    expected: readonly NativeProjectMemoryCatalogMemberTarget[],
): boolean {
    const parsed = safeMemoryCatalogParse(behavior, relativePath, nativeText);
    return (
        parsed !== null &&
        stableStringify(parsed.map(({ targetAssetVersionId: _ignored, ...member }) => member)) ===
            stableStringify(expected.map(({ targetAssetVersionId: _ignored, ...member }) => member))
    );
}

export function isExactFileSemantic(
    input: Pick<RenderAnalysisInput, "deployment">,
    semantic: RenderAnalysisInput["requiredSemantics"][number],
    asset: NativeProjectExactFileRenderAsset,
    behavior: NativeProjectExactFileProviderBehavior,
): boolean {
    const context = input.deployment.targetContexts.find(
        (candidate) => candidate.agentRuntimeId === semantic.consumerAgentRuntimeId,
    );
    const isCatalog = asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog";
    const entry = asset.version.files[0];
    const entryKind = entrySemanticKind(behavior.profile.assetKind);
    const subjectMatches =
        !isCatalog && semantic.semanticKind === entryKind
            ? semantic.subject.subjectKind === "file" && semantic.subject.fileId === entry?.file.fileId
            : assetSemanticKinds(behavior.profile.assetKind).includes(semantic.semanticKind) &&
              semantic.subject.subjectKind === "asset";
    return (
        semantic.consumerAgentRuntimeId === behavior.profile.agentRuntimeId &&
        context?.targetContextSchemaId === behavior.targetContextSchema.targetContextSchemaId &&
        context.targetContextSchemaFingerprint === behavior.targetContextSchema.schemaFingerprint &&
        semantic.subject.assetId === asset.version.ref.assetId &&
        semantic.subject.versionId === asset.version.ref.versionId &&
        subjectMatches
    );
}

export function hasExactFileSemanticClosure(
    semantics: readonly RenderAnalysisInput["requiredSemantics"][number][],
    asset: NativeProjectExactFileRenderAsset,
    behavior: NativeProjectExactFileProviderBehavior,
): boolean {
    const expected = [
        ...assetSemanticKinds(behavior.profile.assetKind),
        ...(asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog"
            ? []
            : [entrySemanticKind(behavior.profile.assetKind)]),
    ].sort(compareUtf8Bytes);
    const kinds = semantics.map((semantic) => semantic.semanticKind).sort(compareUtf8Bytes);
    const refs = semantics.map((semantic) => semantic.semanticRefFingerprint);
    return (
        new Set(refs).size === refs.length &&
        semantics.every(
            (semantic) =>
                semantic.subject.assetId === asset.version.ref.assetId &&
                semantic.subject.versionId === asset.version.ref.versionId,
        ) &&
        stableStringify(kinds) === stableStringify(expected)
    );
}

export function makeExactFileOutputUnit(relativePath: PosixRelativePath, outputContract: OutputContractDefinitionV1) {
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        claims: [{ relativePath, contentKind: "text" as const, executable: false }],
        managedDirectoryBoundaries: [],
    };
    return { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
}

export function exactFileOutputUnit(input: RenderedTargetInspectionInput, file: ChangedRenderedTargetFileInput): Sha256Digest {
    return (
        input.inspectionScope.fileStates.find((candidate) => candidate.relativePath === file.relativePath)
            ?.outputUnitFingerprint ?? ("" as Sha256Digest)
    );
}

export function exactFileDiagnostic(
    behavior: NativeProjectExactFileProviderBehavior,
    message: string,
    severity: OperationDiagnostic["severity"] = "error",
): OperationDiagnostic {
    return diagnostic(
        severity === "warning" ? "scan" : "render",
        `${behavior.adapterId.toLowerCase()}_project_${behavior.profile.assetKind.toLowerCase()}_exact_file_blocked`,
        message,
        severity === "warning" ? "conflict" : "unsupported",
        severity,
    );
}

export function blockedExactFileAnalysis(
    input: RenderAnalysisInput,
    behavior: NativeProjectExactFileProviderBehavior,
): AdapterRenderAnalysisResult {
    const issue = exactFileDiagnostic(
        behavior,
        "native project exact-file target requires one validated current or immediate-parent native file",
    );
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: "native_project_exact_file_not_applicable",
            diagnostics: [issue],
        })),
        diagnostics: [issue],
    };
}

export function blockedExactFileMaterialization(behavior: NativeProjectExactFileProviderBehavior): RenderMaterializationResult {
    return {
        status: "failed",
        materializationState: "blocked",
        reasonCode: "native_project_exact_file_materialization_invalid",
        diagnostics: [exactFileDiagnostic(behavior, "exact-file materialization input is not the selected native closure")],
    };
}

export function blockedExactFileInspection(
    behavior: NativeProjectExactFileProviderBehavior,
): AdapterRenderedTargetInspectionResult {
    return {
        status: "failed",
        changes: [],
        files: [],
        diagnostics: [exactFileDiagnostic(behavior, "exact-file inspection is outside the applied output closure")],
    };
}
