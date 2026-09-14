/** Memory Catalog-specific exact-file reverse validation and inspection. */

import { normalizeText } from "../catalog/payload-store";
import type {
    AdapterRenderedTargetInspectionResult,
    RenderedFileAttributionResult,
    RenderedTargetInspectionInput,
} from "../contracts/reverse";
import type { Sha256Digest } from "../types";
import {
    computeAttributedSemanticChangeFingerprint,
    computeReverseInspectionCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { compareUtf8Bytes } from "./native-project-guidance-profiles";
import {
    blockedExactFileInspection,
    exactFileDiagnostic,
    safeMemoryCatalogParse,
    type NativeProjectExactFileProviderBehavior,
} from "./native-project-exact-file-results";
import type { ReverseInspectionValidatorImplementation } from "./render-registry";

type ReverseValidationInput = Parameters<ReverseInspectionValidatorImplementation["validate"]>[0];
type ReverseValidationResult = ReturnType<ReverseInspectionValidatorImplementation["validate"]>;

export function validateNativeProjectMemoryCatalogReverse(input: ReverseValidationInput): ReverseValidationResult {
    const results = new Map(input.adapterResult.files.map((file) => [file.relativePath, file]));
    const changes = new Map(input.adapterResult.changes.map((change) => [change.changeFingerprint, change]));
    const supportRefs = input.appliedRenderSnapshot.decisions
        .filter(
            (decision) =>
                decision.semanticRef.semanticKind === "memory.support" &&
                decision.semanticRef.subject.subjectKind === "asset" &&
                decision.outputUnitFingerprints.includes(input.outputUnit.outputUnitFingerprint),
        )
        .map((decision) => decision.semanticRef.semanticRefFingerprint)
        .sort(compareUtf8Bytes);
    const file = input.files[0];
    const result = file === undefined ? undefined : results.get(file.relativePath);
    const referenced = result?.attributionState === "uniquely_attributable" ? result.changeFingerprints : [];
    const change = referenced.length === 1 ? changes.get(referenced[0] as Sha256Digest) : undefined;
    const valid =
        input.files.length === 1 &&
        file?.fileState === "baseline_changed" &&
        file.appliedContent.contentKind === "text" &&
        file.currentContent.contentKind === "text" &&
        normalizeText(file.currentContent.text).normalized === file.currentContent.text &&
        file.attributeChanges.length === 0 &&
        file.provenance.sectionBindings.length === 0 &&
        supportRefs.length === 1 &&
        result?.attributionState === "uniquely_attributable" &&
        result.hunkAttributions.length === file.diffHunks.length &&
        result.hunkAttributions.every(
            (attribution) => stableStringify(attribution.semanticRefFingerprints) === stableStringify(supportRefs),
        ) &&
        referenced.length === 1 &&
        change?.changeKind === "asset_type_data_replacement" &&
        change.replacement.kind === "Memory" &&
        change.replacement.typeData.entityRole === "catalog" &&
        stableStringify(change.semanticRefFingerprints) === stableStringify(supportRefs) &&
        input.inventoryDeltas.length === 0 &&
        results.size === 1 &&
        changes.size === 1;
    if (!valid) throw new Error("native project Memory Catalog reverse result violates its policy");
    const proof = {
        outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
        coveredHunkFingerprints: file.diffHunks.map((hunk) => hunk.hunkFingerprint).sort(compareUtf8Bytes),
        coveredAttributeChangeFingerprints: [],
        coveredInventoryDeltaFingerprints: [],
        coveredChangeFingerprints: [change.changeFingerprint],
    };
    return {
        ...proof,
        reverseCoverageFingerprint: computeReverseInspectionCoverageFingerprint({
            outputContractFingerprint: input.contract.outputContractFingerprint,
            outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
            inspectionScopeFingerprint: input.inspectionScopeFingerprint,
            diffHunks: file.diffHunks,
            attributeChanges: file.attributeChanges,
            inventoryDeltas: input.inventoryDeltas,
            changes: input.adapterResult.changes,
            files: input.adapterResult.files,
            proof,
        }),
    };
}

export function inspectNativeProjectMemoryCatalog(
    input: RenderedTargetInspectionInput,
    behavior: NativeProjectExactFileProviderBehavior,
    matchingUnits: RenderedTargetInspectionInput["appliedRenderSnapshot"]["outputUnits"],
): AdapterRenderedTargetInspectionResult {
    const outputUnit = matchingUnits[0];
    const file = input.files[0];
    const supportDecisions = input.appliedRenderSnapshot.decisions.filter(
        (decision) =>
            decision.semanticRef.semanticKind === "memory.support" &&
            decision.semanticRef.subject.subjectKind === "asset" &&
            outputUnit !== undefined &&
            decision.outputUnitFingerprints.includes(outputUnit.outputUnitFingerprint),
    );
    const decision = supportDecisions[0];
    const catalog = input.appliedAssets?.find(
        (asset) =>
            asset.version.ref.assetId === decision?.semanticRef.subject.assetId &&
            asset.version.ref.versionId === decision?.semanticRef.subject.versionId &&
            asset.version.canonical.kind === "Memory" &&
            asset.version.canonical.typeData.entityRole === "catalog",
    );
    const parsed =
        file?.fileState === "baseline_changed" && file.currentContent.contentKind === "text"
            ? safeMemoryCatalogParse(behavior, file.relativePath, file.currentContent.text)
            : null;
    const pathToUnit = catalog === undefined ? null : projectMemoryUnitPaths(input, catalog);
    const members =
        parsed === null || pathToUnit === null
            ? null
            : parsed.flatMap((member) => {
                  const unit = pathToUnit.get(member.relativePath);
                  return unit === undefined
                      ? []
                      : [
                            {
                                targetAssetVersionId: unit.version.ref.versionId,
                                routingTitle: member.routingTitle,
                                routingHint: member.routingHint,
                            },
                        ];
              });
    const semanticRefs = supportDecisions.map((item) => item.semanticRef.semanticRefFingerprint).sort(compareUtf8Bytes);
    if (
        outputUnit === undefined ||
        matchingUnits.length !== 1 ||
        file === undefined ||
        input.files.length !== 1 ||
        supportDecisions.length !== 1 ||
        catalog === undefined ||
        parsed === null ||
        pathToUnit === null ||
        members === null ||
        members.length !== parsed.length ||
        new Set(members.map((member) => member.targetAssetVersionId)).size !== members.length ||
        file.fileState !== "baseline_changed" ||
        file.appliedContent.contentKind !== "text" ||
        file.currentContent.contentKind !== "text" ||
        normalizeText(file.currentContent.text).normalized !== file.currentContent.text ||
        file.attributeChanges.length !== 0 ||
        file.provenance.sectionBindings.length !== 0
    ) {
        return blockedCatalogInspectionFile(behavior, file);
    }
    const replacement = {
        kind: "Memory" as const,
        typeData: { schemaVersion: 2 as const, entityRole: "catalog" as const, members },
    };
    const changePreimage = {
        changeKind: "asset_type_data_replacement" as const,
        semanticRefFingerprints: semanticRefs,
        replacement,
    };
    const change = {
        ...changePreimage,
        changeFingerprint: computeAttributedSemanticChangeFingerprint({
            inspectionScopeFingerprint: input.inspectionScope.inspectionScopeFingerprint,
            change: changePreimage,
        }),
    };
    return {
        status: "complete",
        changes: [change],
        files: [
            {
                relativePath: file.relativePath,
                attributionState: "uniquely_attributable",
                changeFingerprints: [change.changeFingerprint],
                hunkAttributions: file.diffHunks.map((hunk) => ({
                    attributionKind: "semantic" as const,
                    hunkFingerprint: hunk.hunkFingerprint,
                    semanticRefFingerprints: semanticRefs,
                })),
                diagnostics: [],
            },
        ],
        diagnostics: [],
    };
}

function projectMemoryUnitPaths(
    input: RenderedTargetInspectionInput,
    catalog: NonNullable<RenderedTargetInspectionInput["appliedAssets"]>[number],
): Map<string, NonNullable<RenderedTargetInspectionInput["appliedAssets"]>[number]> | null {
    const paths = new Map<string, NonNullable<RenderedTargetInspectionInput["appliedAssets"]>[number]>();
    for (const asset of input.appliedAssets as NonNullable<RenderedTargetInspectionInput["appliedAssets"]>) {
        if (
            asset.version.canonical.kind !== "Memory" ||
            asset.version.canonical.typeData.entityRole !== "unit" ||
            asset.version.status !== "complete" ||
            asset.scope !== catalog.scope ||
            asset.projectId !== catalog.projectId ||
            asset.scopePath !== catalog.scopePath
        ) {
            continue;
        }
        const decisions = input.appliedRenderSnapshot.decisions.filter(
            (decision) =>
                decision.semanticRef.semanticKind === "memory.support" &&
                decision.semanticRef.subject.assetId === asset.version.ref.assetId &&
                decision.semanticRef.subject.versionId === asset.version.ref.versionId,
        );
        const claims = decisions.flatMap((decision) =>
            decision.outputUnitFingerprints.flatMap(
                (fingerprint) =>
                    input.appliedRenderSnapshot.outputUnits.find((unit) => unit.outputUnitFingerprint === fingerprint)?.claims ??
                    [],
            ),
        );
        const uniquePaths = [...new Set(claims.map((claim) => claim.relativePath))];
        if (decisions.length !== 1 || uniquePaths.length !== 1 || paths.has(uniquePaths[0] as string)) return null;
        paths.set(uniquePaths[0] as string, asset);
    }
    return paths;
}

function blockedCatalogInspectionFile(
    behavior: NativeProjectExactFileProviderBehavior,
    file: RenderedTargetInspectionInput["files"][number] | undefined,
): AdapterRenderedTargetInspectionResult {
    if (file === undefined) return blockedExactFileInspection(behavior);
    const result: RenderedFileAttributionResult = {
        relativePath: file.relativePath,
        attributionState: "conflict",
        reasonCode: "native_project_memory_catalog_change_not_reconcilable",
        diagnostics: [exactFileDiagnostic(behavior, "changed Memory Catalog cannot be safely attributed", "warning")],
    };
    return { status: "complete", changes: [], files: [result], diagnostics: result.diagnostics };
}
