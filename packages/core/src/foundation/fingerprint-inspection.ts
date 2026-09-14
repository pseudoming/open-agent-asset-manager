/** Rendered-target inspection and reverse-attribution fingerprints. */

import type {
    AttributedSemanticChange,
    RenderedFileAttributionResult,
    RenderedTargetAttributeChange,
    RenderedTargetDiffHunk,
    RenderedTargetInspectionScope,
    RenderedTargetInventoryDelta,
    ReverseInspectionCoverageProof,
} from "../contracts/reverse";
import type { Sha256Digest } from "../contracts/primitives";
import { compareCodeUnitText, fingerprintDomain } from "./fingerprint-base";

const DIFF_HUNK_DOMAIN = "oaam.render.diff-hunk.v1";
const RUNTIME_ATTRIBUTE_CHANGE_DOMAIN = "oaam.render.runtime-attribute-change.v1";
const INVENTORY_DELTA_DOMAIN = "oaam.render.inventory-delta.v1";
const INSPECTION_SCOPE_DOMAIN = "oaam.render.inspection-scope.v1";
const ATTRIBUTED_CHANGE_DOMAIN = "oaam.render.attributed-change.v1";
const REVERSE_COVERAGE_DOMAIN = "oaam.render.reverse-coverage.v1";
const INSPECTION_RESULT_DOMAIN = "oaam.render.inspection-result.v1";

export function computeRenderedTargetDiffHunkFingerprint(input: {
    relativePath: string;
    appliedContentHash: Sha256Digest;
    currentContentHash: Sha256Digest | "missing";
    diffAlgorithmVersion: string;
    hunk: Omit<RenderedTargetDiffHunk, "hunkFingerprint">;
}): Sha256Digest {
    return fingerprintDomain(DIFF_HUNK_DOMAIN, input);
}

export function computeRenderedTargetAttributeChangeFingerprint(input: {
    relativePath: string;
    inspectionScopeFingerprint: Sha256Digest;
    change: Omit<RenderedTargetAttributeChange, "attributeChangeFingerprint">;
}): Sha256Digest {
    return fingerprintDomain(RUNTIME_ATTRIBUTE_CHANGE_DOMAIN, input);
}

export function computeRenderedTargetInventoryDeltaFingerprint(input: {
    inspectionScopeFingerprint: Sha256Digest;
    delta: Omit<RenderedTargetInventoryDelta, "inventoryDeltaFingerprint">;
}): Sha256Digest {
    return fingerprintDomain(INVENTORY_DELTA_DOMAIN, input);
}

export function computeRenderedTargetInspectionScopeFingerprint(input: {
    deploymentId: string;
    appliedCompilationFingerprint: Sha256Digest;
    scope: Omit<RenderedTargetInspectionScope, "inspectionScopeFingerprint">;
}): Sha256Digest {
    return fingerprintDomain(INSPECTION_SCOPE_DOMAIN, {
        deploymentId: input.deploymentId,
        appliedCompilationFingerprint: input.appliedCompilationFingerprint,
        fileStates: [...input.scope.fileStates].sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath)),
        directoryInventories: [...input.scope.directoryInventories]
            .sort((left, right) =>
                compareCodeUnitText(
                    `${left.outputUnitFingerprint}\0${left.boundary.relativePath}`,
                    `${right.outputUnitFingerprint}\0${right.boundary.relativePath}`,
                ),
            )
            .map((inventory) => ({
                ...inventory,
                currentDescendantPaths: [...inventory.currentDescendantPaths].sort(compareCodeUnitText),
            })),
    });
}

export function computeAttributedSemanticChangeFingerprint(input: {
    inspectionScopeFingerprint: Sha256Digest;
    change: Omit<AttributedSemanticChange, "changeFingerprint">;
}): Sha256Digest {
    return fingerprintDomain(ATTRIBUTED_CHANGE_DOMAIN, {
        inspectionScopeFingerprint: input.inspectionScopeFingerprint,
        ...input.change,
        semanticRefFingerprints: [...input.change.semanticRefFingerprints].sort(compareCodeUnitText),
    });
}

export function computeReverseInspectionCoverageFingerprint(input: {
    outputContractFingerprint: Sha256Digest;
    outputUnitFingerprint: Sha256Digest;
    inspectionScopeFingerprint: Sha256Digest;
    diffHunks: readonly RenderedTargetDiffHunk[];
    attributeChanges: readonly RenderedTargetAttributeChange[];
    inventoryDeltas: readonly RenderedTargetInventoryDelta[];
    changes: readonly AttributedSemanticChange[];
    files: readonly RenderedFileAttributionResult[];
    proof: Omit<ReverseInspectionCoverageProof, "reverseCoverageFingerprint">;
}): Sha256Digest {
    return fingerprintDomain(REVERSE_COVERAGE_DOMAIN, {
        outputContractFingerprint: input.outputContractFingerprint,
        outputUnitFingerprint: input.outputUnitFingerprint,
        inspectionScopeFingerprint: input.inspectionScopeFingerprint,
        diffHunks: [...input.diffHunks].sort((left, right) => compareCodeUnitText(left.hunkFingerprint, right.hunkFingerprint)),
        attributeChanges: [...input.attributeChanges].sort((left, right) =>
            compareCodeUnitText(left.attributeChangeFingerprint, right.attributeChangeFingerprint),
        ),
        inventoryDeltas: [...input.inventoryDeltas].sort((left, right) =>
            compareCodeUnitText(left.inventoryDeltaFingerprint, right.inventoryDeltaFingerprint),
        ),
        changes: [...input.changes].sort((left, right) => compareCodeUnitText(left.changeFingerprint, right.changeFingerprint)),
        files: [...input.files].sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath)),
        coveredHunkFingerprints: [...input.proof.coveredHunkFingerprints].sort(compareCodeUnitText),
        coveredAttributeChangeFingerprints: [...input.proof.coveredAttributeChangeFingerprints].sort(compareCodeUnitText),
        coveredInventoryDeltaFingerprints: [...input.proof.coveredInventoryDeltaFingerprints].sort(compareCodeUnitText),
        coveredChangeFingerprints: [...input.proof.coveredChangeFingerprints].sort(compareCodeUnitText),
    });
}

export function computeRenderedTargetInspectionResultFingerprint(input: {
    inspectionScopeFingerprint: Sha256Digest;
    changes: readonly AttributedSemanticChange[];
    files: readonly RenderedFileAttributionResult[];
    reverseCoverageProofs: readonly ReverseInspectionCoverageProof[];
}): Sha256Digest {
    return fingerprintDomain(INSPECTION_RESULT_DOMAIN, {
        inspectionScopeFingerprint: input.inspectionScopeFingerprint,
        changes: [...input.changes].sort((left, right) => compareCodeUnitText(left.changeFingerprint, right.changeFingerprint)),
        files: [...input.files].sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath)),
        reverseCoverageProofs: [...input.reverseCoverageProofs].sort((left, right) =>
            compareCodeUnitText(left.outputUnitFingerprint, right.outputUnitFingerprint),
        ),
    });
}
