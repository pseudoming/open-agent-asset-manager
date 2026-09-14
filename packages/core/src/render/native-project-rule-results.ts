/** Exact Rule semantic matching and blocked/result construction. */

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
import { compareUtf8Bytes, diagnostic } from "./native-project-guidance-profiles";
import type { NativeProjectRuleProfileDefinition } from "./native-project-rule-profiles";
import { isSafePortableRuleName, nativeProjectRuleRelativePath } from "./native-project-rule-profiles";

export interface NativeProjectRuleProviderBehavior {
    adapterId: AdapterId;
    adapterVersion: string;
    profile: NativeProjectRuleProfileDefinition;
    profileConstraintFingerprint: Sha256Digest;
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    materializerCapability: AdapterMaterializerCapability;
    outputContract: OutputContractDefinitionV1;
}

type RenderAsset = RenderAnalysisInput["deployment"]["assets"][number];
type NativeProjectRuleRenderAsset = Omit<RenderAsset, "version"> & {
    version: Omit<RenderAsset["version"], "canonical"> & {
        canonical: Extract<RenderAsset["version"]["canonical"], { kind: "Rule" }>;
    };
};

export function ruleTargetBlockedDiagnostic(behavior: NativeProjectRuleProviderBehavior, message: string): OperationDiagnostic {
    return diagnostic(
        "render",
        `${behavior.adapterId.toLowerCase()}_${behavior.profile.targetScope}_rule_target_blocked`,
        message,
        "unsupported",
        "error",
    );
}

export function ruleInspectionConflictDiagnostic(path: string): OperationDiagnostic {
    return {
        ...diagnostic(
            "scan",
            "project_rule_reverse_conflict",
            "The whole-file Rule change cannot be uniquely reconciled",
            "conflict",
            "warning",
        ),
        path,
    };
}

export function blockedRuleInspection(behavior: NativeProjectRuleProviderBehavior): AdapterRenderedTargetInspectionResult {
    return {
        status: "failed",
        changes: [],
        files: [],
        diagnostics: [
            ruleTargetBlockedDiagnostic(
                behavior,
                `native ${behavior.profile.targetScope} Rule inspection is outside the exact applied output closure`,
            ),
        ],
    };
}

export function isExactRuleSemantic(
    input: Pick<RenderAnalysisInput, "deployment">,
    semantic: RenderAnalysisInput["requiredSemantics"][number],
    asset: RenderAnalysisInput["deployment"]["assets"][number],
    behavior: NativeProjectRuleProviderBehavior,
): boolean {
    const context = input.deployment.targetContexts.find(
        (candidate) => candidate.agentRuntimeId === semantic.consumerAgentRuntimeId,
    );
    const entry = asset.version.files[0];
    const subjectMatchesAsset =
        semantic.subject.assetId === asset.version.ref.assetId && semantic.subject.versionId === asset.version.ref.versionId;
    const subjectMatchesKind =
        semantic.semanticKind === "rule.content"
            ? semantic.subject.subjectKind === "file" && semantic.subject.fileId === entry?.file.fileId
            : (semantic.semanticKind === "asset.file_inventory" || semantic.semanticKind === "rule.activation") &&
              semantic.subject.subjectKind === "asset";
    return (
        semantic.consumerAgentRuntimeId === behavior.profile.agentRuntimeId &&
        context?.targetContextSchemaId === behavior.targetContextSchema.targetContextSchemaId &&
        context.targetContextSchemaFingerprint === behavior.targetContextSchema.schemaFingerprint &&
        subjectMatchesAsset &&
        subjectMatchesKind
    );
}

export function findExactRuleAsset(
    deployment: Pick<RenderAnalysisInput["deployment"], "assets" | "targetContexts">,
    targetScope: NativeProjectRuleProviderBehavior["profile"]["targetScope"] = "project",
): NativeProjectRuleRenderAsset | null {
    if (deployment.assets.length !== 1) return null;
    const asset = deployment.assets[0] as RenderAsset;
    if (asset.version.canonical.kind !== "Rule") return null;
    const entry = asset.version.files[0];
    const typeData = asset.version.canonical.typeData;
    return (targetScope === "project"
        ? asset.scope === "project" && asset.projectId !== ""
        : asset.scope === "global" && asset.projectId === "") &&
        asset.scopePath === "" &&
        asset.version.status === "complete" &&
        typeData.schemaVersion === 2 &&
        isSafePortableRuleName(typeData.name) &&
        typeData.description === "" &&
        typeData.activation.mode === "always" &&
        asset.version.files.length === 1 &&
        entry?.file.role === "entry" &&
        entry.contentKind === "text" &&
        entry.file.executable === false &&
        entry.file.references.length === 0 &&
        normalizeText(entry.text).normalized === entry.text &&
        entry.text.trim().length > 0
        ? (asset as NativeProjectRuleRenderAsset)
        : null;
}

export function hasExactRuleSemanticClosure(
    semantics: readonly RenderAnalysisInput["requiredSemantics"][number][],
    asset: RenderAnalysisInput["deployment"]["assets"][number],
): boolean {
    const expected = ["asset.file_inventory", "rule.activation", "rule.content"];
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

export function blockedRuleAnalysis(
    input: RenderAnalysisInput,
    behavior: NativeProjectRuleProviderBehavior,
): AdapterRenderAnalysisResult {
    const diagnostic = ruleTargetBlockedDiagnostic(
        behavior,
        `native ${behavior.profile.targetScope} Rule requires one complete unconditional ${behavior.profile.targetScope}-scoped text entry with a safe name`,
    );
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: `${behavior.profile.targetScope}_rule_target_not_applicable`,
            diagnostics: [diagnostic],
        })),
        diagnostics: [diagnostic],
    };
}

export function blockedRuleMaterialization(behavior: NativeProjectRuleProviderBehavior): RenderMaterializationResult {
    return {
        status: "failed",
        materializationState: "blocked",
        reasonCode: "project_rule_materialization_input_invalid",
        diagnostics: [
            ruleTargetBlockedDiagnostic(behavior, "native project Rule materialization input is not the selected exact closure"),
        ],
    };
}

export function makeRuleOutputUnit(relativePath: PosixRelativePath, outputContract: OutputContractDefinitionV1) {
    const preimage = {
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        claims: [{ relativePath, contentKind: "text" as const, executable: false }] as [
            { relativePath: PosixRelativePath; contentKind: "text"; executable: false },
        ],
        managedDirectoryBoundaries: [],
    };
    return { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
}

export function outputUnitForRuleName(ruleName: string, behavior: NativeProjectRuleProviderBehavior) {
    return makeRuleOutputUnit(nativeProjectRuleRelativePath(behavior.profile, ruleName), behavior.outputContract);
}

export function ruleFileOutputUnit(input: RenderedTargetInspectionInput, file: ChangedRenderedTargetFileInput): Sha256Digest {
    const state = input.inspectionScope.fileStates.find((candidate) => candidate.relativePath === file.relativePath);
    return state?.outputUnitFingerprint ?? ("" as Sha256Digest);
}
