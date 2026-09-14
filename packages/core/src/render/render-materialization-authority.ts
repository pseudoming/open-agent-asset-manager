/** Authority-only projections and validation shared by write and read-only render materialization. */

import type {
    MaterializationSafeRenderSelection,
    MaterializationSafeSelectedSemanticOption,
    RenderAnalysisView,
    RenderDeploymentInput,
    ResolvedCoreRenderSelection,
} from "../contracts/render";
import { computeRenderObservationSelectionFingerprint, stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import type { OperationDiagnostic, Sha256Digest } from "../types";
import { validateAnalysisView } from "./render-analysis";
import type { RenderRegistrySnapshot } from "./render-registry";

export interface MaterializationSelectionAuthority {
    readonly selectionFingerprint: Sha256Digest;
    readonly selection: MaterializationSafeRenderSelection;
}

export function resolvedSelectionAuthority(selection: ResolvedCoreRenderSelection): MaterializationSelectionAuthority {
    return {
        selectionFingerprint: selection.selectionFingerprint,
        selection: {
            schemaVersion: 1,
            semanticOptions: selection.semanticOptions.map(materializationSafeOption),
            outputUnits: structuredClone(selection.outputUnits),
            outputUnitRenderers: structuredClone(selection.outputUnitRenderers),
        },
    };
}

export function validateObservationMaterializationClosure(
    input: {
        deployment: RenderDeploymentInput;
        analysis: RenderAnalysisView;
        observationSelection: MaterializationSelectionAuthority;
    },
    registry: RenderRegistrySnapshot,
): void {
    const authority = input.observationSelection;
    if (
        input.deployment.renderRegistryFingerprint !== registry.fingerprint ||
        input.analysis.renderInputFingerprint !== input.deployment.renderInputFingerprint ||
        authority.selection.schemaVersion !== 1 ||
        computeRenderObservationSelectionFingerprint({
            renderInputFingerprint: input.deployment.renderInputFingerprint,
            selection: authority.selection,
        }) !== authority.selectionFingerprint
    ) {
        throw new MaterializationFailure(
            "asset_usage.observation_selection_stale",
            "read-only target observation does not share one fresh render authority",
            "conflict",
            true,
        );
    }
    validateAnalysisView(input.analysis, input.deployment, registry);
    const requiredRefs = new Set(input.analysis.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint));
    if (
        authority.selection.semanticOptions.length === 0 ||
        new Set(authority.selection.semanticOptions.map((option) => option.semanticRefFingerprint)).size !==
            authority.selection.semanticOptions.length ||
        authority.selection.semanticOptions.some((option) => !requiredRefs.has(option.semanticRefFingerprint))
    ) {
        throw new MaterializationFailure(
            "asset_usage.observation_semantic_closure_invalid",
            "read-only target observation semantic closure is empty, duplicated, or foreign",
            "conflict",
            true,
        );
    }
    requireExactSet(
        authority.selection.outputUnitRenderers.map((renderer) => renderer.outputUnitFingerprint),
        authority.selection.outputUnits.map((unit) => unit.outputUnitFingerprint),
        "observed renderer closure",
    );
    const analysisOptions = input.analysis.analyses.flatMap((analysis) => analysis.semanticOptions);
    for (const selected of authority.selection.semanticOptions) {
        const source = analysisOptions.find((option) => option.optionFingerprint === selected.optionFingerprint);
        const sourceSafe = source === undefined ? undefined : materializationSafeOption(source);
        if (sourceSafe === undefined || stableStringify(sourceSafe) !== stableStringify(selected)) {
            throw new MaterializationFailure(
                "asset_usage.observation_option_stale",
                "read-only target observation selected a foreign or changed Provider option",
                "conflict",
                true,
            );
        }
    }
    const analysisUnits = new Map(
        input.analysis.analyses.flatMap((analysis) =>
            analysis.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit] as const),
        ),
    );
    for (const unit of authority.selection.outputUnits) {
        if (stableStringify(analysisUnits.get(unit.outputUnitFingerprint)) !== stableStringify(unit)) {
            throw new MaterializationFailure(
                "asset_usage.observation_output_stale",
                "read-only target observation selected a foreign or changed output unit",
                "conflict",
                true,
            );
        }
    }
}

export class MaterializationFailure extends Error {
    public constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
        readonly retryable = false,
    ) {
        super(message);
    }
}

type RenderSemanticOption =
    | ResolvedCoreRenderSelection["semanticOptions"][number]
    | RenderAnalysisView["analyses"][number]["semanticOptions"][number];

function materializationSafeOption(option: RenderSemanticOption): MaterializationSafeSelectedSemanticOption {
    const base = {
        optionFingerprint: option.optionFingerprint,
        semanticRefFingerprint: option.semanticRefFingerprint,
        renderStrategy: option.renderStrategy,
        actualReverseExtractPolicy: option.actualReverseExtractPolicy,
        requiredOutputUnitFingerprints: [...option.requiredOutputUnitFingerprints],
    };
    return option.outcome === "preserved"
        ? { ...base, outcome: "preserved" }
        : { ...base, outcome: "degraded", degradationFingerprint: option.degradationFingerprint };
}

function requireExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
    if (
        new Set(actual).size !== actual.length ||
        new Set(expected).size !== expected.length ||
        stableStringify([...actual].sort(compareUtf8Bytes)) !== stableStringify([...expected].sort(compareUtf8Bytes))
    ) {
        throw new MaterializationFailure("render.materialization_closure_mismatch", `${label} is not exact`);
    }
}
