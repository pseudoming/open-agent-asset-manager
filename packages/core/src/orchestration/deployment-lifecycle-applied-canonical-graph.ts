/** Applied conversion proof and source-native reconstruction for ordinary foreign reverse. */
import { binaryPayloadStats, bytesForPayload, normalizeText } from "../catalog/payload-store";
import type { VersionAuthorityClosureV1 } from "../catalog/version-authority";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type { VersionNativeRepresentation } from "../contracts/persistence";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type {
    MaterializedRenderFile,
    ProviderRenderDialectInputsForAsset,
    RenderNativeRepresentationFileInput,
} from "../contracts/render";
import { computeVersionNativeRepresentationFingerprint, stableStringify } from "../foundation/fingerprint";
import { inferCanonicalMediaType } from "../foundation/media-type";
import { compareUtf8Bytes } from "../foundation/text-order";
import { canonicalValueForSemantic, isMaterializationCoverageProofBound } from "../render/render-materialization-coverage";
import { projectVersionDialectInputs } from "../render/render-dialect-authority";
import type { Sha256Digest } from "../types";
import type { RenderRegistrySnapshot } from "../render/render-registry";
import type { DeploymentInspectionAuthorityV1 } from "./deployment-inspection-service";
import type { StagedReverseVersionContentV1 } from "./deployment-lifecycle-model";
import { lifecycleFailure } from "./deployment-lifecycle-shared";

type GraphCanonical = Extract<AssetKindTypeDataV2, { kind: "Rule" | "Workflow" | "Skill" | "Subagent" }>;

/** Reconstruct only bytes that the complete inspected applied closure already owns. */
export function readAppliedCanonicalGraphFiles(input: {
    inspected: DeploymentInspectionAuthorityV1;
    outputUnitFingerprint: Sha256Digest;
}): RenderNativeRepresentationFileInput[] | null {
    const outputUnit = input.inspected.appliedRenderSnapshot.outputUnits.find(
        (candidate) => candidate.outputUnitFingerprint === input.outputUnitFingerprint,
    );
    if (outputUnit === undefined || outputUnit.claims.length === 0) return null;
    const claims = new Map(outputUnit.claims.map((claim) => [claim.relativePath, claim]));
    const states = input.inspected.input.inspectionScope.fileStates.filter(
        (state) => state.outputUnitFingerprint === input.outputUnitFingerprint,
    );
    const statesByPath = new Map(states.map((state) => [state.relativePath, state]));
    const authority = input.inspected.runtimeReplacementAuthority.files.filter((file) => claims.has(file.relativePath));
    const authorityByPath = new Map(authority.map((file) => [file.relativePath, file]));
    const changedByPath = new Map(
        input.inspected.input.files.filter((file) => claims.has(file.relativePath)).map((file) => [file.relativePath, file]),
    );
    if (
        claims.size !== outputUnit.claims.length ||
        statesByPath.size !== states.length ||
        authorityByPath.size !== authority.length ||
        claims.size !== statesByPath.size ||
        claims.size !== authorityByPath.size
    ) {
        return null;
    }
    const files: RenderNativeRepresentationFileInput[] = [];
    for (const claim of [...claims.values()].sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath))) {
        const state = statesByPath.get(claim.relativePath);
        const current = authorityByPath.get(claim.relativePath);
        const changed = changedByPath.get(claim.relativePath);
        if (
            state === undefined ||
            current === undefined ||
            state.state === "missing" ||
            state.state === "added" ||
            current.expectedState !== "present" ||
            claim.executable !== state.appliedExecutable ||
            (state.state === "changed" && changed?.fileState !== "baseline_changed") ||
            (state.state === "unchanged" && changed !== undefined)
        ) {
            return null;
        }
        const appliedContent = changed?.fileState === "baseline_changed" ? changed.appliedContent : null;
        if (appliedContent !== null && appliedContent.contentKind !== claim.contentKind) return null;
        const bytes =
            appliedContent === null
                ? new Uint8Array(current.expectedBytes)
                : bytesForPayload(
                      appliedContent.contentKind === "text" ? appliedContent.text : appliedContent.bytes,
                      appliedContent.contentKind,
                  );
        const stats = binaryPayloadStats(bytes);
        if (stats.contentHash !== state.appliedContentHash) return null;
        const base = {
            relativePath: claim.relativePath,
            contentKind: claim.contentKind,
            mediaType: inferCanonicalMediaType(claim.relativePath, claim.contentKind),
            contentHash: stats.contentHash,
            byteSize: stats.byteSize,
            executable: state.appliedExecutable,
        };
        if (claim.contentKind === "text") {
            const normalized = normalizeText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            if (!Buffer.from(normalized.bytes).equals(Buffer.from(bytes))) return null;
            files.push({ ...base, contentKind: "text", text: normalized.normalized });
        } else {
            files.push({ ...base, contentKind: "binary", bytes });
        }
    }
    return files;
}

/** A converted target remains an applied conversion; it never acquires source-native same-content meaning. */
export function isAppliedCanonicalGraphCurrent(input: {
    inspected: DeploymentInspectionAuthorityV1;
    parent: VersionAuthorityClosureV1;
    outputUnitFingerprint: Sha256Digest;
    dialectInput: ProviderRenderDialectInputsForAsset;
    appliedRegistry: RenderRegistrySnapshot;
}): boolean {
    try {
        const snapshot = input.inspected.appliedRenderSnapshot;
        const units = snapshot.outputUnits.filter((unit) => unit.outputUnitFingerprint === input.outputUnitFingerprint);
        const renderers = snapshot.outputUnitRenderers.filter(
            (renderer) => renderer.outputUnitFingerprint === input.outputUnitFingerprint,
        );
        const retainedProofs = snapshot.semanticCoverageProofs.filter(
            (proof) => proof.outputUnitFingerprint === input.outputUnitFingerprint,
        );
        const unit = units[0],
            renderer = renderers[0],
            retained = retainedProofs[0];
        const nativeFiles = readAppliedCanonicalGraphFiles(input);
        if (
            units.length !== 1 ||
            renderers.length !== 1 ||
            retainedProofs.length !== 1 ||
            unit === undefined ||
            renderer === undefined ||
            retained === undefined ||
            nativeFiles === null
        )
            return false;
        const registry = input.appliedRegistry;
        const contract = registry.getOutputContract(unit.outputContractId);
        const profile = contract?.materializationProfiles.find(
            (item) => item.materializationProfileId === renderer.materializationProfileId,
        );
        if (
            contract === null ||
            profile === undefined ||
            contract.outputContractFingerprint !== unit.outputContractFingerprint ||
            profile.profileConstraintFingerprint !== renderer.profileConstraintFingerprint
        )
            return false;
        const decisions = snapshot.decisions.filter((decision) =>
            decision.outputUnitFingerprints.includes(unit.outputUnitFingerprint),
        );
        const semantics = decisions.map((decision) => decision.semanticRef);
        const materialized: MaterializedRenderFile[] = [];
        for (const file of nativeFiles) {
            const matches = input.parent.files.filter(
                (source) =>
                    (input.parent.files.length === 1 && nativeFiles.length === 1) ||
                    unit.managedDirectoryBoundaries.some(
                        (boundary) => file.relativePath === `${boundary.relativePath}/${source.file.logicalPath}`,
                    ),
            );
            const source = matches[0];
            if (matches.length !== 1 || source === undefined) return false;
            materialized.push({
                relativePath: file.relativePath,
                content:
                    file.contentKind === "text"
                        ? { contentKind: "text", text: file.text }
                        : { contentKind: "binary", bytes: file.bytes },
                executable: file.executable,
                semanticRefFingerprints: semantics
                    .filter(
                        (semantic) =>
                            (semantic.subject.subjectKind === "file" && semantic.subject.fileId === source.file.fileId) ||
                            (source.file.role === "entry" && semantic.subject.subjectKind === "asset"),
                    )
                    .map((semantic) => semantic.semanticRefFingerprint)
                    .sort(compareUtf8Bytes),
                sectionBindings: [],
            });
        }
        const canonicalValues = semantics.map((semantic) =>
            canonicalValueForSemantic(input.inspected.operation.deployment, semantic),
        );
        const selectedOptions = decisions.map((decision) => {
            const {
                semanticRef,
                consumerOwnerAdapterId: _owner,
                consumerOwnerAdapterVersion: _version,
                approval: _approval,
                outputUnitFingerprints,
                ...option
            } = decision;
            return {
                ...option,
                semanticRefFingerprint: semanticRef.semanticRefFingerprint,
                requiredOutputUnitFingerprints: outputUnitFingerprints,
            };
        });
        const proof = registry.validateOutputContractMaterialization({
            contract,
            profile,
            outputUnit: unit,
            selectedSemantics: semantics,
            canonicalValues,
            selectedOptions,
            dialectInputs: [input.dialectInput],
            files: materialized,
        });
        return (
            stableStringify(proof) === stableStringify(retained) &&
            isMaterializationCoverageProofBound(proof, {
                contractFingerprint: contract.outputContractFingerprint,
                profileFingerprint: profile.profileConstraintFingerprint,
                outputUnit: unit,
                expectedRefs: semantics.map((semantic) => semantic.semanticRefFingerprint),
                canonicalValues,
                files: materialized,
            })
        );
    } catch {
        return false;
    }
}

/** Only the source Provider interprets its bytes; Core retains membership, schema and publication validation. */
export function rebuildSourceNativeGraphs(input: {
    parent: VersionAuthorityClosureV1;
    canonical: GraphCanonical;
    files: AssetVersionFileContentV2[];
    versionCanonicalContentFingerprint: Sha256Digest;
    registry: VersionDialectRegistryV1;
}): Pick<StagedReverseVersionContentV1, "nativeRepresentations" | "nativePayloads"> {
    try {
        const projected = projectVersionDialectInputs(
            { assetId: input.parent.manifest.assetId, versionId: input.parent.manifest.versionId },
            {
                nativeRepresentations: input.parent.manifest.nativeRepresentations,
                dialectRestorationPayloads: input.parent.manifest.dialectRestorationPayloads,
                nativePayloads: input.parent.nativePayloads,
                restorationPayloads: input.parent.restorationPayloads,
            },
        );
        if (projected === null) throwSourceRebaseUnavailable();
        const parents = projected.inputs.filter((value) => value.inputKind === "native_representation");
        if (parents.length === 0) throwSourceRebaseUnavailable();
        const nativeRepresentations: VersionNativeRepresentation[] = [],
            nativePayloads: StagedReverseVersionContentV1["nativePayloads"] = [];
        for (const parent of parents) {
            const contract = input.registry.getNative(input.canonical.kind, parent.representation.dialectId);
            if (
                contract?.contractFingerprint !== parent.representation.dialectContractFingerprint ||
                contract.rebaseNativeGraph === undefined
            )
                throwSourceRebaseUnavailable();
            const result = contract.rebaseNativeGraph({
                assetKind: input.canonical.kind,
                nativeDialectId: parent.representation.dialectId,
                targetCanonical: input.canonical,
                targetFiles: input.files,
                parent: {
                    sourceVersion: { assetId: input.parent.manifest.assetId, versionId: input.parent.manifest.versionId },
                    representation: parent.representation,
                    files: parent.files,
                },
                restorationInputs: projected.inputs.filter((value) => value.inputKind === "dialect_restoration"),
            });
            const rebuilt = result?.nativeFiles;
            if (
                rebuilt === undefined ||
                stableStringify(rebuilt.map((file) => file.relativePath).sort(compareUtf8Bytes)) !==
                    stableStringify(parent.files.map((file) => file.relativePath).sort(compareUtf8Bytes))
            )
                throwSourceRebaseUnavailable();
            const payload = {
                dialectId: parent.representation.dialectId,
                files: rebuilt.map((file) => ({
                    relativePath: file.relativePath,
                    bytes: bytesForPayload(file.contentKind === "text" ? file.text : file.bytes, file.contentKind),
                })),
            };
            const descriptors = rebuilt
                .map((file) => {
                    const {
                        text: _text,
                        bytes: _bytes,
                        ...descriptor
                    } = file as RenderNativeRepresentationFileInput & { text?: string; bytes?: Uint8Array };
                    return descriptor;
                })
                .sort((a, b) => compareUtf8Bytes(a.relativePath, b.relativePath));
            const { representationFingerprint: _old, ...base } = parent.representation;
            const preimage = {
                ...base,
                canonicalContentFingerprint: input.versionCanonicalContentFingerprint,
                files: descriptors,
            };
            const representation = {
                ...preimage,
                representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
            } as VersionNativeRepresentation;
            if (
                !contract.validateSameContent({
                    canonical: input.canonical,
                    canonicalFiles: input.files,
                    representation,
                    nativeFiles: payload.files,
                })
            )
                throwSourceRebaseUnavailable();
            nativeRepresentations.push(representation);
            nativePayloads.push(payload);
        }
        return { nativeRepresentations, nativePayloads };
    } catch {
        throwSourceRebaseUnavailable();
    }
}

function throwSourceRebaseUnavailable(): never {
    throw lifecycleFailure(
        "reverse_accept.source_native_rebase_unavailable",
        "The source-native graph cannot be rebuilt completely by its declared Provider rebase component",
        "unsupported",
    );
}
