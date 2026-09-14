/** Exact Guidance semantic matching and blocked/result construction. */

import { normalizeText } from "../catalog/payload-store";
import type { AdapterMaterializerCapability, AdapterTargetContextSchemaDeclaration } from "../contracts/source-import";
import type {
    AdapterRenderAnalysisResult,
    OutputContractDefinitionV1,
    RenderAnalysisInput,
    RenderMaterializationResult,
} from "../contracts/render";
import type {
    AdapterRenderedTargetInspectionResult,
    ChangedRenderedTargetFileInput,
    RenderedTargetInspectionInput,
} from "../contracts/reverse";
import type { AdapterId, OperationDiagnostic, PosixRelativePath, Sha256Digest } from "../types";
import { computeRenderOutputUnitFingerprint, stableStringify } from "../foundation/fingerprint";
import type { NativeProjectGuidanceProfileDefinition } from "./native-project-guidance-profiles";
import { compareUtf8Bytes, diagnostic } from "./native-project-guidance-profiles";

export interface NativeProjectGuidanceProviderBehavior {
    adapterId: AdapterId;
    adapterVersion: string;
    profile: NativeProjectGuidanceProfileDefinition;
    profileConstraintFingerprint: Sha256Digest;
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    materializerCapability: AdapterMaterializerCapability;
    outputContract: OutputContractDefinitionV1;
}

export function targetBlockedDiagnostic(behavior: NativeProjectGuidanceProviderBehavior, message: string): OperationDiagnostic {
    return diagnostic(
        "render",
        `${behavior.adapterId.toLowerCase()}_${behavior.profile.targetScope}_guidance_target_blocked`,
        message,
        "unsupported",
        "error",
    );
}

export function inspectionConflictDiagnostic(path: string): OperationDiagnostic {
    return {
        ...diagnostic(
            "scan",
            "project_guidance_reverse_conflict",
            "The whole-file Guidance change cannot be uniquely reconciled",
            "conflict",
            "warning",
        ),
        path,
    };
}

export function blockedInspection(behavior: NativeProjectGuidanceProviderBehavior): AdapterRenderedTargetInspectionResult {
    return {
        status: "failed",
        changes: [],
        files: [],
        diagnostics: [
            targetBlockedDiagnostic(
                behavior,
                `native ${behavior.profile.targetScope} Guidance inspection is outside the exact applied output closure`,
            ),
        ],
    };
}

export function isExactGuidanceSemantic(
    input: Pick<RenderAnalysisInput, "deployment">,
    semantic: RenderAnalysisInput["requiredSemantics"][number],
    asset: RenderAnalysisInput["deployment"]["assets"][number],
    behavior: NativeProjectGuidanceProviderBehavior,
): boolean {
    const context = input.deployment.targetContexts.find(
        (candidate) => candidate.agentRuntimeId === semantic.consumerAgentRuntimeId,
    );
    const entry = asset.version.files[0];
    const subjectMatchesAsset =
        semantic.subject.assetId === asset.version.ref.assetId && semantic.subject.versionId === asset.version.ref.versionId;
    const subjectMatchesKind =
        semantic.semanticKind === "guidance.content"
            ? semantic.subject.subjectKind === "file" && semantic.subject.fileId === entry?.file.fileId
            : (semantic.semanticKind === "asset.file_inventory" || semantic.semanticKind === "guidance.base_context") &&
              semantic.subject.subjectKind === "asset";
    return (
        semantic.consumerAgentRuntimeId === behavior.profile.agentRuntimeId &&
        context?.targetContextSchemaId === behavior.targetContextSchema.targetContextSchemaId &&
        context.targetContextSchemaFingerprint === behavior.targetContextSchema.schemaFingerprint &&
        subjectMatchesAsset &&
        subjectMatchesKind
    );
}

export function findExactGuidanceAsset(
    deployment: Pick<RenderAnalysisInput["deployment"], "assets" | "targetContexts">,
    targetScope: NativeProjectGuidanceProviderBehavior["profile"]["targetScope"] = "project",
): RenderAnalysisInput["deployment"]["assets"][number] | null {
    if (deployment.assets.length !== 1) return null;
    const guidanceAssets = deployment.assets.filter((asset) => asset.version.canonical.kind === "Guidance");
    if (guidanceAssets.length !== 1) return null;
    const asset = guidanceAssets[0];
    const entry = asset?.version.files[0];
    return asset !== undefined &&
        (targetScope === "project"
            ? asset.scope === "project" && asset.projectId !== ""
            : asset.scope === "global" && asset.projectId === "") &&
        asset.scopePath === "" &&
        asset.version.status === "complete" &&
        asset.version.canonical.kind === "Guidance" &&
        asset.version.files.length === 1 &&
        entry?.file.role === "entry" &&
        entry.contentKind === "text" &&
        entry.file.executable === false &&
        entry.file.references.length === 0 &&
        normalizeText(entry.text).normalized === entry.text &&
        entry.text.trim().length > 0
        ? asset
        : null;
}

export function hasExactGuidanceSemanticClosure(
    semantics: readonly RenderAnalysisInput["requiredSemantics"][number][],
    asset: RenderAnalysisInput["deployment"]["assets"][number],
): boolean {
    const expected = ["asset.file_inventory", "guidance.base_context", "guidance.content"];
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

export function blockedAnalysis(
    input: RenderAnalysisInput,
    behavior: NativeProjectGuidanceProviderBehavior,
): AdapterRenderAnalysisResult {
    const diagnostic = targetBlockedDiagnostic(
        behavior,
        `native ${behavior.profile.targetScope} Guidance requires one complete ${behavior.profile.targetScope}-scoped text entry and an exact target context`,
    );
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: `${behavior.profile.targetScope}_guidance_target_not_applicable`,
            diagnostics: [diagnostic],
        })),
        diagnostics: [diagnostic],
    };
}

export function blockedMaterialization(behavior: NativeProjectGuidanceProviderBehavior): RenderMaterializationResult {
    return {
        status: "failed",
        materializationState: "blocked",
        reasonCode: "project_guidance_materialization_input_invalid",
        diagnostics: [
            targetBlockedDiagnostic(behavior, "native project Guidance materialization input is not the selected exact closure"),
        ],
    };
}

export function makeOutputUnit(relativePath: PosixRelativePath, outputContract: OutputContractDefinitionV1) {
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        claims: [{ relativePath, contentKind: "text" as const, executable: false }],
        managedDirectoryBoundaries: [],
    };
    return {
        ...preimage,
        outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage),
    };
}

export function fileOutputUnit(input: RenderedTargetInspectionInput, file: ChangedRenderedTargetFileInput): Sha256Digest {
    const state = input.inspectionScope.fileStates.find((candidate) => candidate.relativePath === file.relativePath);
    return state?.outputUnitFingerprint ?? ("" as Sha256Digest);
}
