/** Materialization proof validation for one encoded project Subagent file. */

import type { CanonicalRenderSemanticValue } from "../contracts/render";
import {
    computeCanonicalRenderSemanticValueFingerprint,
    computeSemanticCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { assetSemanticKinds } from "./render-semantics";
import { compareUtf8Bytes } from "./native-project-guidance-profiles";
import type { MaterializationValidatorImplementation } from "./render-registry";
import type { NativeProjectEncodedFileProfileDefinition } from "./native-project-encoded-file-profiles";

type CanonicalSemanticValuePreimage = CanonicalRenderSemanticValue extends infer T
    ? T extends CanonicalRenderSemanticValue
        ? Omit<T, "canonicalValueFingerprint">
        : never
    : never;

export function makeEncodedFileMaterializationValidator(
    profile: NativeProjectEncodedFileProfileDefinition,
    ref: MaterializationValidatorImplementation["ref"],
): MaterializationValidatorImplementation {
    return {
        ref,
        validate(input) {
            const selectedRefs = input.selectedSemantics
                .map((semantic) => semantic.semanticRefFingerprint)
                .sort(compareUtf8Bytes);
            const valueByRef = new Map(input.canonicalValues.map((value) => [value.semanticRefFingerprint, value]));
            const inventorySemantic = input.selectedSemantics.find(
                (semantic) => semantic.semanticKind === "asset.file_inventory" && semantic.subject.subjectKind === "asset",
            );
            const inventory =
                inventorySemantic === undefined ? undefined : valueByRef.get(inventorySemantic.semanticRefFingerprint);
            const inventoryRows = inventory?.valueKind === "file_inventory" ? inventory.value : [];
            const nativeGroup = input.dialectInputs[0];
            const nativeInputs = nativeGroup?.inputs.filter((candidate) => candidate.inputKind === "native_representation");
            const restorationInputs = nativeGroup?.inputs.filter((candidate) => candidate.inputKind === "dialect_restoration");
            const native = nativeInputs?.[0];
            const nativeFile = native?.inputKind === "native_representation" ? native.files[0] : undefined;
            const claim = input.outputUnit.claims[0];
            const file = input.files[0];
            const sectionFileIds = file?.sectionBindings.flatMap((binding) => {
                if (binding.semanticRefFingerprints.length !== 1) return [];
                const semantic = input.selectedSemantics.find(
                    (candidate) => candidate.semanticRefFingerprint === binding.semanticRefFingerprints[0],
                );
                return semantic?.subject.subjectKind === "file" ? [semantic.subject.fileId] : [];
            });
            const selectedAssetKinds = input.selectedSemantics
                .filter((semantic) => semantic.subject.subjectKind === "asset")
                .map((semantic) => semantic.semanticKind)
                .sort(compareUtf8Bytes);
            const expectedAssetKinds = assetSemanticKinds("Subagent").sort(compareUtf8Bytes);
            const valid =
                input.profile.materializationProfileId === profile.materializationProfileId &&
                selectedAssetKinds.join("\0") === expectedAssetKinds.join("\0") &&
                new Set(selectedRefs).size === selectedRefs.length &&
                input.canonicalValues.length === input.selectedSemantics.length &&
                input.canonicalValues.every((value) => {
                    const semantic = input.selectedSemantics.find(
                        (candidate) => candidate.semanticRefFingerprint === value.semanticRefFingerprint,
                    );
                    if (semantic === undefined) return false;
                    const { canonicalValueFingerprint, ...preimage } = value;
                    return (
                        canonicalValueFingerprint ===
                        computeCanonicalRenderSemanticValueFingerprint({
                            semantic,
                            assetKind: "Subagent",
                            value: preimage as CanonicalSemanticValuePreimage,
                        })
                    );
                }) &&
                input.selectedSemantics
                    .filter((semantic) => semantic.subject.subjectKind === "asset")
                    .every((semantic) => {
                        const value = valueByRef.get(semantic.semanticRefFingerprint);
                        return semantic.semanticKind === "asset.file_inventory"
                            ? value?.valueKind === "file_inventory"
                            : value?.valueKind === "asset_type_data" && value.value.kind === "Subagent";
                    }) &&
                input.selectedSemantics
                    .filter((semantic) => semantic.subject.subjectKind === "file")
                    .every((semantic) => valueByRef.get(semantic.semanticRefFingerprint)?.valueKind === "file_content") &&
                inventory?.valueKind === "file_inventory" &&
                inventoryRows.length >= 1 &&
                inventoryRows.length <= 2 &&
                inventoryRows.filter((row) => row.role === "entry").length === 1 &&
                inventoryRows.every((row) => row.contentKind === "text" && !row.executable) &&
                input.dialectInputs.length === 1 &&
                nativeInputs?.length === 1 &&
                restorationInputs?.every((item) => item.restoration?.dialectId !== undefined) &&
                nativeGroup?.inputs.length === 1 + restorationInputs.length &&
                stableStringify(restorationInputs.map((item) => item.restoration.dialectId)) ===
                    stableStringify(profile.restorationDialectIds) &&
                native?.inputKind === "native_representation" &&
                (native.inputRole === "current_exact" || native.inputRole === "parent_rebase_seed") &&
                native.representation.dialectId === profile.nativeDialectId &&
                native.files.length === 1 &&
                nativeFile?.contentKind === "text" &&
                !nativeFile.executable &&
                input.outputUnit.claims.length === 1 &&
                input.outputUnit.managedDirectoryBoundaries.length === 0 &&
                claim?.relativePath === nativeFile.relativePath &&
                claim.contentKind === "text" &&
                !claim.executable &&
                input.files.length === 1 &&
                file?.relativePath === nativeFile.relativePath &&
                file.content.contentKind === "text" &&
                (native.inputRole === "parent_rebase_seed" || file.content.text === nativeFile.text) &&
                !file.executable &&
                stableStringify(file.semanticRefFingerprints) === stableStringify(selectedRefs) &&
                file.sectionBindings.length === inventoryRows.length &&
                sectionFileIds !== undefined &&
                sectionFileIds.length === inventoryRows.length &&
                new Set(sectionFileIds).size === inventoryRows.length &&
                stableStringify([...sectionFileIds].sort(compareUtf8Bytes)) ===
                    stableStringify(inventoryRows.map((row) => row.fileId).sort(compareUtf8Bytes)) &&
                input.selectedOptions.length === selectedRefs.length &&
                input.selectedOptions.every(
                    (option) =>
                        selectedRefs.includes(option.semanticRefFingerprint) &&
                        option.outcome === "preserved" &&
                        option.renderStrategy === "native_graph" &&
                        option.actualReverseExtractPolicy === "can_reconcile" &&
                        stableStringify(option.requiredOutputUnitFingerprints) ===
                            stableStringify([input.outputUnit.outputUnitFingerprint]),
                );
            if (!valid) throw new Error("native project encoded-file materialization violates its profile");
            return {
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                coveredSemanticRefFingerprints: selectedRefs,
                coverageFingerprint: computeSemanticCoverageFingerprint({
                    outputContractFingerprint: input.contract.outputContractFingerprint,
                    profileConstraintFingerprint: input.profile.profileConstraintFingerprint,
                    outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                    canonicalValues: input.canonicalValues,
                    files: input.files,
                    coveredSemanticRefFingerprints: selectedRefs,
                }),
            };
        },
    };
}
