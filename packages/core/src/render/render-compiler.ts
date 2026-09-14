/** Core-only compilation of validated materialization into executor authority. */

import type { AppliedInputsSnapshotV1, CoreResult, OperationDiagnostic, Sha256Digest } from "../types";
import type {
    RenderAnalysisView,
    RenderDeploymentInput,
    ResolvedCoreRenderSelection,
    SemanticRenderOption,
} from "../contracts/render";
import type { AppliedRenderDecisionV1, AppliedRenderSnapshotV1 } from "../contracts/deployment-authority";
import type { CoreRenderMaterializationView } from "./render-materialization";
import type { TargetFilePlan, TargetPlan } from "../deployment/deployment-target-plan";
import type { DeploymentExecutionAuthorityV1 } from "../deployment/deployment-execution-validation";
import {
    computeAppliedRenderSnapshotFingerprint,
    computeCompilationFingerprint,
    computeRenderSelectionFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { completeResult } from "../foundation/core-result";
import { compareUtf8Bytes } from "../foundation/text-order";
import {
    finalizeTargetFileRenderProvenance,
    validateAppliedInputsSnapshot,
    validateAppliedRenderSnapshot,
} from "./deployment-render-authority";

declare const validatedCompiledPlanBrand: unique symbol;

/** Opaque, non-serializable process-local executor token. */
export interface ValidatedCompiledDeploymentPlan {
    readonly [validatedCompiledPlanBrand]: true;
}

export interface ValidatedCompiledDeploymentPlanData {
    deploymentInput: RenderDeploymentInput;
    analysis: RenderAnalysisView;
    selection: ResolvedCoreRenderSelection;
    materialization: CoreRenderMaterializationView;
    targetPlan: TargetPlan;
    executionAuthority: DeploymentExecutionAuthorityV1;
    compilationFingerprint: Sha256Digest;
}

export interface ValidatedCompiledDeploymentPreviewInput {
    targetPlan: TargetPlan;
    compilationFingerprint: Sha256Digest;
}

const COMPILED_PLAN_DATA = new WeakMap<object, ValidatedCompiledDeploymentPlanData>();

export function compileRenderDeployment(input: {
    deployment: RenderDeploymentInput;
    analysis: RenderAnalysisView;
    selection: ResolvedCoreRenderSelection;
    materialization: CoreRenderMaterializationView;
    appliedInputsSnapshot: AppliedInputsSnapshotV1;
}): CoreResult<ValidatedCompiledDeploymentPlan> {
    try {
        validateCompilerInput(input);
        const targetFiles = compileTargetFiles(input.materialization);
        const compilationFingerprint = computeCompilationFingerprint({
            deploymentId: input.deployment.deploymentId,
            renderInputFingerprint: input.deployment.renderInputFingerprint,
            selectionFingerprint: input.selection.selectionFingerprint,
            units: input.materialization.units.map((unit) => ({
                outputUnitFingerprint: unit.outputUnit.outputUnitFingerprint,
                materializationFingerprint: unit.materializationFingerprint,
                semanticCoverageFingerprint: unit.semanticCoverageProof.coverageFingerprint,
            })),
            files: targetFiles,
        });
        const appliedRenderSnapshot = buildAppliedRenderSnapshot(input, compilationFingerprint);
        validateAppliedRenderSnapshot(appliedRenderSnapshot);
        const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(appliedRenderSnapshot);
        const targetFileProvenance = targetFiles.map((file) => ({
            relativePath: file.relativePath,
            provenance: finalizeTargetFileRenderProvenance({
                schemaVersion: 1,
                appliedRenderSnapshotFingerprint: snapshotFingerprint,
                outputUnitFingerprint: file.outputUnitFingerprint,
                materializationFingerprint: file.materializationFingerprint,
                semanticRefFingerprints: [...file.semanticRefFingerprints],
                sectionBindings: structuredClone(file.sectionBindings),
            }),
        }));
        const data: ValidatedCompiledDeploymentPlanData = structuredClone({
            deploymentInput: input.deployment,
            analysis: input.analysis,
            selection: input.selection,
            materialization: input.materialization,
            targetPlan: {
                schemaVersion: 1,
                targetFiles,
                managedDirectoryBoundaries: input.selection.outputUnits
                    .flatMap((unit) =>
                        unit.managedDirectoryBoundaries.map((boundary) => ({
                            relativePath: boundary.relativePath,
                            outputUnitFingerprint: unit.outputUnitFingerprint,
                            ...("desiredDirectoryPaths" in boundary
                                ? { desiredDirectoryPaths: [...boundary.desiredDirectoryPaths] }
                                : {}),
                        })),
                    )
                    .sort(compareManagedDirectoryBoundaries),
            },
            executionAuthority: {
                appliedInputsSnapshot: input.appliedInputsSnapshot,
                appliedRenderSnapshot,
                targetFileProvenance,
            },
            compilationFingerprint,
        });
        const token = Object.freeze({}) as ValidatedCompiledDeploymentPlan;
        COMPILED_PLAN_DATA.set(token, data);
        return completeResult(token);
    } catch (error) {
        return failed(error);
    }
}

function compareManagedDirectoryBoundaries(left: { relativePath: string }, right: { relativePath: string }): number {
    return compareUtf8Bytes(left.relativePath, right.relativePath);
}

/** Internal executor bridge; architecture tests restrict its production consumer. */
export function openValidatedCompiledDeploymentPlan(token: ValidatedCompiledDeploymentPlan): ValidatedCompiledDeploymentPlanData {
    const data = COMPILED_PLAN_DATA.get(token);
    if (data === undefined) {
        throw new Error("compiled deployment plan token is forged or belongs to another process");
    }
    return structuredClone(data);
}

/** Narrow Core preview projection; architecture tests restrict its sole production consumer. */
export function projectValidatedCompiledDeploymentPreviewInput(
    token: ValidatedCompiledDeploymentPlan,
): ValidatedCompiledDeploymentPreviewInput {
    const data = openValidatedCompiledDeploymentPlan(token);
    return {
        targetPlan: data.targetPlan,
        compilationFingerprint: data.compilationFingerprint,
    };
}

function validateCompilerInput(input: {
    deployment: RenderDeploymentInput;
    analysis: RenderAnalysisView;
    selection: ResolvedCoreRenderSelection;
    materialization: CoreRenderMaterializationView;
    appliedInputsSnapshot: AppliedInputsSnapshotV1;
}): void {
    validateAppliedInputsSnapshot(input.appliedInputsSnapshot);
    if (
        input.appliedInputsSnapshot.deploymentId !== input.deployment.deploymentId ||
        stableStringify(input.appliedInputsSnapshot.consumerAgentRuntimeIds) !==
            stableStringify(input.deployment.consumerAgentRuntimeIds) ||
        stableStringify(input.appliedInputsSnapshot.assets) !==
            stableStringify(
                input.deployment.assets.map((asset) => ({
                    assetId: asset.version.ref.assetId,
                    versionId: asset.version.ref.versionId,
                    allowIncomplete: asset.allowIncomplete,
                })),
            )
    ) {
        throw new CompilerFailure(
            "render.compile_inputs_snapshot_mismatch",
            "AppliedInputsSnapshot does not describe the exact render input",
            "conflict",
            true,
        );
    }
    if (
        input.analysis.renderInputFingerprint !== input.deployment.renderInputFingerprint ||
        input.selection.renderInputFingerprint !== input.deployment.renderInputFingerprint ||
        input.materialization.renderInputFingerprint !== input.deployment.renderInputFingerprint ||
        input.materialization.selectionFingerprint !== input.selection.selectionFingerprint
    ) {
        throw new CompilerFailure(
            "render.compile_closure_stale",
            "compile inputs do not share one render/selection authority",
            "conflict",
            true,
        );
    }
    const { selectionFingerprint: _stored, schemaVersion: _schemaVersion, ...selectionPreimage } = input.selection;
    if (computeRenderSelectionFingerprint(selectionPreimage) !== input.selection.selectionFingerprint) {
        throw new CompilerFailure(
            "render.compile_selection_fingerprint_mismatch",
            "compile selection fingerprint is stale",
            "conflict",
            true,
        );
    }
    requireExactSet(
        input.materialization.units.map((unit) => unit.outputUnit.outputUnitFingerprint),
        input.selection.outputUnits.map((unit) => unit.outputUnitFingerprint),
        "compiled materialization unit closure",
    );
}

function compileTargetFiles(materialization: CoreRenderMaterializationView): TargetFilePlan[] {
    const files: TargetFilePlan[] = [];
    const paths = new Set<string>();
    for (const unit of materialization.units) {
        for (const file of unit.files) {
            if (file.containerPatch !== undefined) {
                throw new CompilerFailure(
                    "render.compile_container_patch_unresolved",
                    "a shared-container patch must be resolved by Core before compilation",
                );
            }
            if (paths.has(file.relativePath)) {
                throw new CompilerFailure(
                    "render.compile_target_path_overlap",
                    `multiple output units materialized ${file.relativePath}`,
                );
            }
            paths.add(file.relativePath);
            files.push({
                relativePath: file.relativePath,
                content: structuredClone(file.content),
                executable: file.executable,
                outputUnitFingerprint: unit.outputUnit.outputUnitFingerprint,
                materializationFingerprint: unit.materializationFingerprint,
                semanticRefFingerprints: [...file.semanticRefFingerprints],
                sectionBindings: structuredClone(file.sectionBindings),
                ...(file.containerPatchPreimageHash === undefined
                    ? {}
                    : { containerPatchPreimageHash: file.containerPatchPreimageHash }),
            });
        }
    }
    return files.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
}

function buildAppliedRenderSnapshot(
    input: {
        deployment: RenderDeploymentInput;
        analysis: RenderAnalysisView;
        selection: ResolvedCoreRenderSelection;
        materialization: CoreRenderMaterializationView;
    },
    compilationFingerprint: Sha256Digest,
): Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }> {
    const decisions = input.analysis.requiredSemantics.map((semantic): AppliedRenderDecisionV1 => {
        const selected = input.selection.semanticOptions.find(
            (option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint,
        ) as ResolvedCoreRenderSelection["semanticOptions"][number];
        const source = findSourceOption(input.analysis, selected.optionFingerprint);
        const base = {
            semanticRef: structuredClone(semantic),
            consumerOwnerAdapterId: selected.consumerOwnerAdapterId,
            consumerOwnerAdapterVersion: selected.consumerOwnerAdapterVersion,
            optionFingerprint: selected.optionFingerprint,
            renderStrategy: selected.renderStrategy,
            approval: structuredClone(selected.approval),
            actualReverseExtractPolicy: selected.actualReverseExtractPolicy,
            outputUnitFingerprints: [...selected.requiredOutputUnitFingerprints],
        };
        return source.outcome === "preserved"
            ? { ...base, outcome: "preserved" }
            : {
                  ...base,
                  outcome: "degraded",
                  degradationKinds: [...source.degradationKinds] as typeof source.degradationKinds,
                  degradationFingerprint: source.degradationFingerprint,
              };
    });
    return {
        schemaVersion: 1,
        snapshotState: "applied",
        renderInputFingerprint: input.deployment.renderInputFingerprint,
        compilerPolicyVersion: input.selection.compilerPolicyVersion,
        selectionFingerprint: input.selection.selectionFingerprint,
        compilationFingerprint,
        promotionAuthorizations: structuredClone(input.selection.promotionAuthorizations),
        decisions: decisions.sort((left, right) =>
            compareUtf8Bytes(left.semanticRef.semanticRefFingerprint, right.semanticRef.semanticRefFingerprint),
        ),
        outputUnits: structuredClone(input.selection.outputUnits),
        outputUnitRenderers: structuredClone(input.selection.outputUnitRenderers),
        semanticCoverageProofs: input.materialization.units
            .map((unit) => structuredClone(unit.semanticCoverageProof))
            .sort((left, right) => compareUtf8Bytes(left.outputUnitFingerprint, right.outputUnitFingerprint)),
    };
}

function findSourceOption(analysis: RenderAnalysisView, optionFingerprint: Sha256Digest): SemanticRenderOption {
    const matches = analysis.analyses.flatMap((item) =>
        item.semanticOptions.filter((option) => option.optionFingerprint === optionFingerprint),
    );
    if (matches.length !== 1) {
        throw new CompilerFailure(
            "render.compile_option_closure_invalid",
            "compiled option does not resolve exactly once in analysis",
        );
    }
    return matches[0] as SemanticRenderOption;
}

function requireExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
    if (
        new Set(actual).size !== actual.length ||
        new Set(expected).size !== expected.length ||
        stableStringify([...actual].sort(compareUtf8Bytes)) !== stableStringify([...expected].sort(compareUtf8Bytes))
    ) {
        throw new CompilerFailure("render.compile_closure_mismatch", `${label} is not exact`);
    }
}

class CompilerFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
        readonly retryable = false,
    ) {
        super(message);
    }
}

function failed<T>(error: unknown): CoreResult<T> {
    const known = error instanceof CompilerFailure;
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code: known ? error.code : "render.compile_internal_error",
                message: error instanceof Error ? error.message : String(error),
                operation: "render",
                causeKind: known ? error.causeKind : "internal_error",
                path: "",
                traceId: "",
                retryable: known ? error.retryable : false,
                suggestedActions: [],
                rawSummary: "",
            },
        ],
    };
}
