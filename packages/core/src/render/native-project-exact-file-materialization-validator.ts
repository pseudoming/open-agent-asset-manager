/** Exact-file materialization proof validation for one registered profile. */

import type { MaterializationValidatorImplementation } from "./render-registry";
import type { NativeProjectExactFileProfileDefinition } from "./native-project-exact-file-profiles";
import { computeSemanticCoverageFingerprint, stableStringify } from "../foundation/fingerprint";
import { getAssetSpecHandler } from "../specs/registry";
import { assetSemanticKinds, entrySemanticKind } from "./render-semantics";
import { compareUtf8Bytes } from "./native-project-guidance-profiles";

export function makeExactFileMaterializationValidator(
    profile: NativeProjectExactFileProfileDefinition,
    ref: MaterializationValidatorImplementation["ref"],
): MaterializationValidatorImplementation {
    return {
        ref,
        validate(input) {
            const catalogTypeValue = input.canonicalValues.find(
                (value) =>
                    value.valueKind === "asset_type_data" &&
                    value.value.kind === "Memory" &&
                    value.value.typeData.entityRole === "catalog",
            );
            if (catalogTypeValue !== undefined) {
                return validateMemoryCatalogMaterialization(input, profile);
            }
            const semanticRefs = input.selectedSemantics
                .map((semantic) => semantic.semanticRefFingerprint)
                .sort(compareUtf8Bytes);
            const expectedKinds = [...assetSemanticKinds(profile.assetKind), entrySemanticKind(profile.assetKind)].sort(
                compareUtf8Bytes,
            );
            const valueByRef = new Map(input.canonicalValues.map((value) => [value.semanticRefFingerprint, value]));
            const inventorySemantic = input.selectedSemantics.find(
                (semantic) => semantic.semanticKind === "asset.file_inventory",
            );
            const entrySemantic = input.selectedSemantics.find(
                (semantic) => semantic.semanticKind === entrySemanticKind(profile.assetKind),
            );
            const inventory =
                inventorySemantic === undefined ? undefined : valueByRef.get(inventorySemantic.semanticRefFingerprint);
            const entryValue = entrySemantic === undefined ? undefined : valueByRef.get(entrySemantic.semanticRefFingerprint);
            const inventoryFile = inventory?.valueKind === "file_inventory" ? inventory.value[0] : undefined;
            const typeValues = input.selectedSemantics
                .filter(
                    (semantic) => semantic.subject.subjectKind === "asset" && semantic.semanticKind !== "asset.file_inventory",
                )
                .map((semantic) => valueByRef.get(semantic.semanticRefFingerprint));
            const nativeGroup = input.dialectInputs[0];
            const nativeInputs = nativeGroup?.inputs.filter((candidate) => candidate.inputKind === "native_representation");
            const restorationInputs = nativeGroup?.inputs.filter((candidate) => candidate.inputKind === "dialect_restoration");
            const native = nativeInputs?.[0];
            const nativeFile = native?.inputKind === "native_representation" ? native.files[0] : undefined;
            const claim = input.outputUnit.claims[0];
            const file = input.files[0];
            const valid =
                input.profile.materializationProfileId === profile.materializationProfileId &&
                input.selectedSemantics
                    .map((semantic) => semantic.semanticKind)
                    .sort(compareUtf8Bytes)
                    .join("\0") === expectedKinds.join("\0") &&
                new Set(semanticRefs).size === semanticRefs.length &&
                input.canonicalValues.length === input.selectedSemantics.length &&
                typeValues.length === assetSemanticKinds(profile.assetKind).length - 1 &&
                typeValues.every(
                    (value) =>
                        value?.valueKind === "asset_type_data" &&
                        value.value.kind === profile.assetKind &&
                        stableStringify(value.value) === stableStringify(typeValues[0]?.value),
                ) &&
                inventory?.valueKind === "file_inventory" &&
                inventory.value.length === 1 &&
                inventoryFile?.role === "entry" &&
                inventoryFile.contentKind === "text" &&
                inventoryFile.executable === false &&
                entryValue?.valueKind === "file_content" &&
                entryValue.value.contentKind === "text" &&
                getAssetSpecHandler(profile.assetKind).validateEntryText(entryValue.value.text) &&
                input.dialectInputs.length === 1 &&
                nativeInputs?.length === 1 &&
                restorationInputs !== undefined &&
                nativeGroup?.inputs.length === 1 + restorationInputs.length &&
                stableStringify(restorationInputs.map((item) => item.restoration.dialectId)) ===
                    stableStringify(profile.restorationDialectIds) &&
                native?.inputKind === "native_representation" &&
                (native.inputRole === "current_exact" ||
                    (native.inputRole === "parent_rebase_seed" && profile.rebaseMaterializer !== null)) &&
                native.representation.dialectId === profile.nativeDialectId &&
                native.files.length === 1 &&
                nativeFile?.contentKind === "text" &&
                nativeFile.executable === false &&
                input.outputUnit.claims.length === 1 &&
                input.outputUnit.managedDirectoryBoundaries.length === 0 &&
                claim?.relativePath === nativeFile.relativePath &&
                claim.contentKind === "text" &&
                claim.executable === false &&
                input.files.length === 1 &&
                file?.relativePath === nativeFile.relativePath &&
                file.content.contentKind === "text" &&
                (native.inputRole === "parent_rebase_seed" || file.content.text === nativeFile.text) &&
                file.executable === false &&
                file.sectionBindings.length === 0 &&
                stableStringify(file.semanticRefFingerprints) === stableStringify(semanticRefs) &&
                input.selectedOptions.length === semanticRefs.length &&
                input.selectedOptions.every(
                    (option) =>
                        semanticRefs.includes(option.semanticRefFingerprint) &&
                        option.outcome === "preserved" &&
                        option.renderStrategy === "native_file" &&
                        option.actualReverseExtractPolicy === "can_reconcile" &&
                        stableStringify(option.requiredOutputUnitFingerprints) ===
                            stableStringify([input.outputUnit.outputUnitFingerprint]),
                );
            if (!valid) throw new Error("native project exact-file materialization violates its profile");
            return {
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                coveredSemanticRefFingerprints: semanticRefs,
                coverageFingerprint: computeSemanticCoverageFingerprint({
                    outputContractFingerprint: input.contract.outputContractFingerprint,
                    profileConstraintFingerprint: input.profile.profileConstraintFingerprint,
                    outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                    canonicalValues: input.canonicalValues,
                    files: input.files,
                    coveredSemanticRefFingerprints: semanticRefs,
                }),
            };
        },
    };
}

function validateMemoryCatalogMaterialization(
    input: Parameters<MaterializationValidatorImplementation["validate"]>[0],
    profile: NativeProjectExactFileProfileDefinition,
) {
    const semanticRefs = input.selectedSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(compareUtf8Bytes);
    const expectedKinds = [...assetSemanticKinds("Memory")].sort(compareUtf8Bytes);
    const valueByRef = new Map(input.canonicalValues.map((value) => [value.semanticRefFingerprint, value]));
    const inventorySemantic = input.selectedSemantics.find((semantic) => semantic.semanticKind === "asset.file_inventory");
    const inventory = inventorySemantic === undefined ? undefined : valueByRef.get(inventorySemantic.semanticRefFingerprint);
    const typeValues = input.selectedSemantics
        .filter((semantic) => semantic.semanticKind !== "asset.file_inventory")
        .map((semantic) => valueByRef.get(semantic.semanticRefFingerprint));
    const typeValue = typeValues[0];
    const subject = input.selectedSemantics[0]?.subject;
    const nativeGroup = input.dialectInputs.find(
        (group) => group.targetVersion.assetId === subject?.assetId && group.targetVersion.versionId === subject?.versionId,
    );
    const nativeInputs = nativeGroup?.inputs.filter((candidate) => candidate.inputKind === "native_representation");
    const restorationInputs = nativeGroup?.inputs.filter((candidate) => candidate.inputKind === "dialect_restoration");
    const native = nativeInputs?.find(
        (candidate) =>
            candidate.inputKind === "native_representation" && candidate.representation.dialectId === profile.nativeDialectId,
    );
    const nativeFile = native?.inputKind === "native_representation" ? native.files[0] : undefined;
    const claim = input.outputUnit.claims[0];
    const file = input.files[0];
    const valid =
        profile.assetKind === "Memory" &&
        input.profile.materializationProfileId === profile.materializationProfileId &&
        input.selectedSemantics
            .map((semantic) => semantic.semanticKind)
            .sort(compareUtf8Bytes)
            .join("\0") === expectedKinds.join("\0") &&
        input.selectedSemantics.every(
            (semantic) =>
                semantic.subject.subjectKind === "asset" &&
                semantic.subject.assetId === subject?.assetId &&
                semantic.subject.versionId === subject?.versionId,
        ) &&
        new Set(semanticRefs).size === semanticRefs.length &&
        input.canonicalValues.length === input.selectedSemantics.length &&
        inventory?.valueKind === "file_inventory" &&
        inventory.value.length === 0 &&
        typeValues.length === assetSemanticKinds("Memory").length - 1 &&
        typeValue?.valueKind === "asset_type_data" &&
        typeValue.value.kind === "Memory" &&
        typeValue.value.typeData.entityRole === "catalog" &&
        nativeGroup !== undefined &&
        nativeInputs?.length === 1 &&
        restorationInputs?.length === 0 &&
        native?.inputKind === "native_representation" &&
        (native.inputRole === "current_exact" ||
            (native.inputRole === "parent_rebase_seed" && profile.rebaseMaterializer !== null)) &&
        native.representation.dialectId === profile.nativeDialectId &&
        native.files.length === 1 &&
        nativeFile?.contentKind === "text" &&
        nativeFile.executable === false &&
        input.outputUnit.claims.length === 1 &&
        input.outputUnit.managedDirectoryBoundaries.length === 0 &&
        claim?.relativePath === nativeFile.relativePath &&
        claim.contentKind === "text" &&
        claim.executable === false &&
        input.files.length === 1 &&
        file?.relativePath === nativeFile.relativePath &&
        file.content.contentKind === "text" &&
        (native.inputRole === "parent_rebase_seed" || file.content.text === nativeFile.text) &&
        file.executable === false &&
        file.sectionBindings.length === 0 &&
        stableStringify(file.semanticRefFingerprints) === stableStringify(semanticRefs) &&
        input.selectedOptions.length === semanticRefs.length &&
        input.selectedOptions.every(
            (option) =>
                semanticRefs.includes(option.semanticRefFingerprint) &&
                option.outcome === "preserved" &&
                option.renderStrategy === "native_file" &&
                option.actualReverseExtractPolicy === "can_reconcile" &&
                stableStringify(option.requiredOutputUnitFingerprints) ===
                    stableStringify([input.outputUnit.outputUnitFingerprint]),
        );
    if (!valid) throw new Error("native project Memory Catalog materialization violates its profile");
    return {
        outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
        coveredSemanticRefFingerprints: semanticRefs,
        coverageFingerprint: computeSemanticCoverageFingerprint({
            outputContractFingerprint: input.contract.outputContractFingerprint,
            profileConstraintFingerprint: input.profile.profileConstraintFingerprint,
            outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
            canonicalValues: input.canonicalValues,
            files: input.files,
            coveredSemanticRefFingerprints: semanticRefs,
        }),
    };
}
