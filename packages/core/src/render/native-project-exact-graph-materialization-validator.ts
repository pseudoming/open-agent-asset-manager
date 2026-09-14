/** Exact-graph materialization proof validation for one registered profile. */

import type { MaterializationValidatorImplementation } from "./render-registry";
import type { NativeProjectExactGraphProfileDefinition } from "./native-project-exact-graph-profiles";
import type {
    AdapterCanonicalMaterializationValidatorV1,
    CanonicalRenderSemanticValue,
    ProviderRenderDialectInput,
} from "../contracts/render";
import { binaryPayloadStats, bytesForPayload } from "../catalog/payload-store";
import {
    computeCanonicalRenderSemanticValueFingerprint,
    computeSemanticCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { assetSemanticKinds, entrySemanticKind } from "./render-semantics";
import { compareUtf8Bytes } from "./native-project-guidance-profiles";
import { hasExactGraphBoundaryClosure, hasExactNativeDirectoryGraph } from "./native-project-exact-graph-results";
import { projectCanonicalOutputDirectories } from "./canonical-materialization-directories";
import {
    assessCanonicalMaterializationLosses,
    isCanonicalMaterializationLossListAllowed,
} from "./canonical-materialization-assessment";

type CanonicalSemanticValuePreimage = CanonicalRenderSemanticValue extends infer T
    ? T extends CanonicalRenderSemanticValue
        ? Omit<T, "canonicalValueFingerprint">
        : never
    : never;

export function makeExactGraphMaterializationValidator(
    profile: NativeProjectExactGraphProfileDefinition,
    ref: MaterializationValidatorImplementation["ref"],
    canonicalValidator?: AdapterCanonicalMaterializationValidatorV1,
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
            const nativeGroup = input.dialectInputs[0];
            const nativeInputs = nativeGroup?.inputs.filter((candidate) => candidate.inputKind === "native_representation");
            const canonicalInputs = nativeGroup?.inputs.filter(
                (candidate) => candidate.inputKind === "canonical_materialization",
            );
            const restorationInputs = nativeGroup?.inputs.filter((candidate) => candidate.inputKind === "dialect_restoration");
            const native = nativeInputs?.[0];
            const canonical = canonicalInputs?.[0];
            const claims = new Map(input.outputUnit.claims.map((claim) => [claim.relativePath, claim]));
            const materialized = new Map(input.files.map((file) => [file.relativePath, file]));
            const nativeFiles = new Map(
                native?.inputKind === "native_representation" ? native.files.map((file) => [file.relativePath, file]) : [],
            );
            const inventoryRows = new Map(
                inventory?.valueKind === "file_inventory" ? inventory.value.map((file) => [file.logicalPath, file]) : [],
            );
            const assetKinds = assetSemanticKinds(profile.assetKind).sort(compareUtf8Bytes);
            const selectedAssetKinds = input.selectedSemantics
                .filter((semantic) => semantic.subject.subjectKind === "asset")
                .map((semantic) => semantic.semanticKind)
                .sort(compareUtf8Bytes);
            const managedBoundaries = input.outputUnit.managedDirectoryBoundaries;
            const canonicalMapping = input.files.flatMap((file) => {
                const ids = new Set(
                    file.semanticRefFingerprints.flatMap((fingerprint) => {
                        const semantic = input.selectedSemantics.find((item) => item.semanticRefFingerprint === fingerprint);
                        return semantic?.subject.subjectKind === "file" ? [semantic.subject.fileId] : [];
                    }),
                );
                const source = ids.size === 1 ? [...inventoryRows.values()].find((row) => ids.has(row.fileId)) : undefined;
                return source === undefined
                    ? []
                    : [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: source.logicalPath }];
            });
            const explicitNativeDirectories =
                native?.inputKind === "native_representation" && native.representation.schemaVersion === 2
                    ? native.representation.directories
                    : projectCanonicalOutputDirectories(canonical?.logicalDirectoryPaths, {
                          files: canonicalMapping,
                          managedDirectoryBoundaries: managedBoundaries.map((boundary) => boundary.relativePath),
                      });
            const explicitOutputDirectories = managedBoundaries.flatMap((boundary) =>
                "desiredDirectoryPaths" in boundary ? boundary.desiredDirectoryPaths : [],
            );
            const nativeMode = nativeInputs?.length === 1 && canonicalInputs?.length === 0;
            const canonicalMode =
                nativeInputs?.length === 0 &&
                canonicalInputs?.length === 1 &&
                profile.canonicalMaterialization !== null &&
                canonical?.inputKind === "canonical_materialization" &&
                canonical.nativeDialectId === profile.nativeDialectId &&
                stableStringify(canonical.materializer) === stableStringify(profile.canonicalMaterialization.materializer) &&
                isCanonicalMaterializationLossListAllowed(profile.canonicalMaterialization, canonical.degradationKinds) &&
                canonical.substituteAssetKind === profile.canonicalMaterialization.substituteAssetKind &&
                canonical.reasonCode === profile.canonicalMaterialization.reasonCode &&
                (canonical.nativePreservationSeed === undefined ||
                    profile.canonicalMaterialization.preservationDialectIds?.includes(
                        canonical.nativePreservationSeed.representation.dialectId,
                    ) === true) &&
                canonicalValidator !== undefined &&
                canonicalValidator.outputContractId === input.outputUnit.outputContractId &&
                canonicalValidator.materializationProfileId === profile.materializationProfileId &&
                stableStringify(canonicalValidator.materializer) === stableStringify(canonical.materializer) &&
                (canonical.logicalDirectoryPaths === undefined || explicitNativeDirectories !== null);
            const graphFileCount = nativeMode ? native?.files.length : canonicalMode ? inventoryRows.size : 0;
            const representedCanonicalFiles = new Set<string>();
            const valid =
                input.profile.materializationProfileId === profile.materializationProfileId &&
                selectedAssetKinds.join("\0") === assetKinds.join("\0") &&
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
                            assetKind: profile.assetKind,
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
                            : value?.valueKind === "asset_type_data" && value.value.kind === profile.assetKind;
                    }) &&
                input.selectedSemantics
                    .filter((semantic) => semantic.subject.subjectKind === "file")
                    .every((semantic) => valueByRef.get(semantic.semanticRefFingerprint)?.valueKind === "file_content") &&
                inventory?.valueKind === "file_inventory" &&
                inventory.value.length >= 1 &&
                inventory.value.filter((file) => file.role === "entry").length === 1 &&
                input.dialectInputs.length === 1 &&
                (nativeMode || canonicalMode) &&
                restorationInputs !== undefined &&
                nativeGroup?.inputs.length === 1 + restorationInputs.length &&
                stableStringify(restorationInputs.map((item) => item.restoration.dialectId)) ===
                    stableStringify(profile.restorationDialectIds) &&
                (!nativeMode ||
                    (native?.inputKind === "native_representation" &&
                        (native.inputRole === "current_exact" ||
                            (native.inputRole === "parent_rebase_seed" && profile.rebaseMaterializer !== null)) &&
                        native.representation.dialectId === profile.nativeDialectId &&
                        native.files.length === inventory.value.length)) &&
                managedBoundaries.every((boundary) => boundary.boundaryKind === "directory_inventory") &&
                hasExactGraphBoundaryClosure(
                    input.outputUnit.claims.map((claim) => claim.relativePath),
                    managedBoundaries.map((boundary) => boundary.relativePath),
                    profile.jsoncTopLevelPropertyPatch !== undefined,
                ) &&
                (explicitNativeDirectories === null
                    ? explicitOutputDirectories.length === 0
                    : managedBoundaries.every((boundary) => "desiredDirectoryPaths" in boundary) &&
                      hasExactNativeDirectoryGraph(
                          explicitNativeDirectories,
                          input.outputUnit.claims.map((claim) => claim.relativePath),
                          managedBoundaries.map((boundary) => boundary.relativePath),
                      ) &&
                      stableStringify([...explicitOutputDirectories].sort(compareUtf8Bytes)) ===
                          stableStringify(explicitNativeDirectories)) &&
                input.outputUnit.claims.length === graphFileCount &&
                claims.size === graphFileCount &&
                input.files.length === graphFileCount &&
                materialized.size === graphFileCount &&
                (!nativeMode || nativeFiles.size === graphFileCount) &&
                input.files.every((file) => {
                    const claim = claims.get(file.relativePath);
                    const nativeFile = nativeFiles.get(file.relativePath);
                    const representedFileIds = new Set(
                        file.semanticRefFingerprints.flatMap((fingerprint) => {
                            const semantic = input.selectedSemantics.find(
                                (candidate) => candidate.semanticRefFingerprint === fingerprint,
                            );
                            return semantic?.subject.subjectKind === "file" ? [semantic.subject.fileId] : [];
                        }),
                    );
                    const canonicalFile =
                        representedFileIds.size === 1
                            ? [...inventoryRows.values()].find((candidate) => candidate.fileId === [...representedFileIds][0])
                            : undefined;
                    if (claim === undefined || canonicalFile === undefined || representedCanonicalFiles.has(canonicalFile.fileId))
                        return false;
                    representedCanonicalFiles.add(canonicalFile.fileId);
                    const fileRefs = input.selectedSemantics
                        .filter(
                            (semantic) =>
                                (semantic.subject.subjectKind === "file" && semantic.subject.fileId === canonicalFile.fileId) ||
                                (canonicalFile.role === "entry" && semantic.subject.subjectKind === "asset"),
                        )
                        .map((semantic) => semantic.semanticRefFingerprint)
                        .sort(compareUtf8Bytes);
                    const contentMatchesCurrent = canonicalMode
                        ? canonicalFile.role === "entry"
                            ? validatesCanonicalEntry(input, profile, canonical!, canonicalValidator!, canonicalFile.fileId, file)
                            : binaryPayloadStats(
                                  bytesForPayload(
                                      file.content.contentKind === "text" ? file.content.text : file.content.bytes,
                                      file.content.contentKind,
                                  ),
                              ).contentHash === canonicalFile.contentHash
                        : nativeFile !== undefined &&
                          native?.inputKind === "native_representation" &&
                          (native.inputRole !== "current_exact" ||
                              (nativeFile.contentKind === "text"
                                  ? file.content.contentKind === "text" && file.content.text === nativeFile.text
                                  : file.content.contentKind === "binary" &&
                                    Buffer.compare(Buffer.from(file.content.bytes), Buffer.from(nativeFile.bytes)) === 0));
                    return (
                        claim !== undefined &&
                        (!nativeMode || claim.contentKind === nativeFile?.contentKind) &&
                        claim.contentKind === canonicalFile.contentKind &&
                        (!canonicalMode ||
                            graphFileCount === 1 ||
                            (managedBoundaries.length === 1 &&
                                file.relativePath === `${managedBoundaries[0]?.relativePath}/${canonicalFile.logicalPath}`)) &&
                        (canonicalFile.role !== "entry" ||
                            fileRefs.some(
                                (fingerprint) =>
                                    input.selectedSemantics.find((semantic) => semantic.semanticRefFingerprint === fingerprint)
                                        ?.semanticKind === entrySemanticKind(profile.assetKind),
                            )) &&
                        claim.executable === canonicalFile.executable &&
                        (!nativeMode ||
                            native?.inputKind !== "native_representation" ||
                            native.inputRole !== "current_exact" ||
                            claim.executable === nativeFile?.executable) &&
                        file.content.contentKind === claim.contentKind &&
                        file.executable === claim.executable &&
                        file.sectionBindings.length === 0 &&
                        stableStringify(file.semanticRefFingerprints) === stableStringify(fileRefs) &&
                        contentMatchesCurrent
                    );
                }) &&
                input.selectedOptions.length === selectedRefs.length &&
                input.selectedOptions.every(
                    (option) =>
                        selectedRefs.includes(option.semanticRefFingerprint) &&
                        (nativeMode || (canonicalMode && canonical?.degradationKinds.length === 0)
                            ? option.outcome === "preserved"
                            : option.outcome === "degraded" && profile.canonicalMaterialization !== null) &&
                        option.renderStrategy === "native_graph" &&
                        option.actualReverseExtractPolicy === "can_reconcile" &&
                        stableStringify(option.requiredOutputUnitFingerprints) ===
                            stableStringify([input.outputUnit.outputUnitFingerprint]),
                );
            if (!valid) throw new Error(`native ${profile.targetScope} exact-graph materialization violates its profile`);
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

function validatesCanonicalEntry(
    input: Parameters<MaterializationValidatorImplementation["validate"]>[0],
    profile: NativeProjectExactGraphProfileDefinition,
    token: Extract<ProviderRenderDialectInput, { inputKind: "canonical_materialization" }>,
    validator: AdapterCanonicalMaterializationValidatorV1,
    fileId: string,
    file: Parameters<MaterializationValidatorImplementation["validate"]>[0]["files"][number],
): boolean {
    // The caller has validated canonical mode, the complete semantic closure and the file's unique mapping.
    const canonical = input.canonicalValues.find((value) => value.valueKind === "asset_type_data")!;
    const source = input.canonicalValues.find(
        (value): value is Extract<CanonicalRenderSemanticValue, { valueKind: "file_content" }> =>
            value.valueKind === "file_content" &&
            input.selectedSemantics.some(
                (semantic) =>
                    semantic.semanticRefFingerprint === value.semanticRefFingerprint &&
                    semantic.subject.subjectKind === "file" &&
                    semantic.subject.fileId === fileId,
            ),
    )!;
    const group = input.dialectInputs[0]!;
    const assessmentInput = {
        canonical: canonical.value,
        canonicalEntry: source.value,
        targetVersion: group.targetVersion,
        targetScope: profile.targetScope,
        nativeDialectId: profile.nativeDialectId,
        ...(token.nativePreservationSeed === undefined ? {} : { nativePreservationSeed: token.nativePreservationSeed }),
    };
    const assessed = assessCanonicalMaterializationLosses(profile.canonicalMaterialization!, validator, assessmentInput);
    if (assessed === null || stableStringify(assessed) !== stableStringify(token.degradationKinds)) return false;
    try {
        return (
            validator.validateEntry(
                structuredClone({
                    ...assessmentInput,
                    nativeEntry: { relativePath: file.relativePath, content: file.content },
                }),
            ) === true
        );
    } catch {
        return false;
    }
}
