/** Rendered-target state, attribution, and reverse-proof validation. */

import type { OperationDiagnostic, Sha256Digest } from "../types";
import type { AppliedRenderSnapshotV1, RenderOutputUnit } from "../contracts/deployment-authority";
import type {
    AdapterRenderedTargetInspectionResult,
    AttributedSemanticChange,
    ChangedRenderedTargetFileInput,
    InspectionSafeAppliedRenderSnapshotV1,
    RenderedFileAttributionResult,
    RenderedTargetInspectionInput,
    RenderedTargetInspectionResult,
    RenderedTargetInspectionFileState,
    RenderedTargetInventoryDelta,
    ReverseInspectionCoverageProof,
} from "../contracts/reverse";
import {
    computeAttributedSemanticChangeFingerprint,
    computeRenderedTargetAttributeChangeFingerprint,
    computeRenderedTargetDiffHunkFingerprint,
    computeRenderedTargetInspectionResultFingerprint,
    computeRenderedTargetInspectionScopeFingerprint,
    computeRenderedTargetInventoryDeltaFingerprint,
    computeReverseInspectionCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { validateAppliedRenderSnapshot, validateTargetFileRenderProvenance } from "./deployment-render-authority";
import { binaryPayloadStats } from "../catalog/payload-store";
import { isCanonicalRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import {
    contentByteLength,
    contentHash,
    InspectionFailure,
    isStrictDescendant,
    requireExactSet,
    requireHashes,
    requireSortedUniqueHashes,
    requireSortedUniquePaths,
} from "./render-inspection-primitives";
import { projectAppliedAssetsForInspectionUnits } from "./render-inspection-applied-assets";

export {
    contentByteLength,
    contentHash,
    failedInspectionResult as failed,
    InspectionFailure,
    isStrictDescendant,
    requireExactSet,
    requireHashes,
    requireSortedUniqueHashes,
    requireSortedUniquePaths,
} from "./render-inspection-primitives";

const DIFF_ALGORITHM_VERSION = "core_byte_ranges_v1";
const EMPTY_CONTENT_HASH = binaryPayloadStats(new Uint8Array()).contentHash;

export function projectInspectionSafeAppliedRenderSnapshot(
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
): InspectionSafeAppliedRenderSnapshotV1 {
    const { promotionAuthorizations: _promotion, decisions, ...safe } = snapshot;
    return {
        ...structuredClone(safe),
        decisions: decisions.map((decision) => {
            const { approval: _approval, ...projected } = decision;
            return structuredClone(projected);
        }),
    };
}

export function validateInspectionInput(input: {
    appliedRenderSnapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
    inspection: RenderedTargetInspectionInput;
}): void {
    validateAppliedRenderSnapshot(input.appliedRenderSnapshot);
    if (
        input.inspection.schemaVersion !== 1 ||
        !isUuidV4(input.inspection.deploymentId) ||
        stableStringify(input.inspection.appliedRenderSnapshot) !==
            stableStringify(projectInspectionSafeAppliedRenderSnapshot(input.appliedRenderSnapshot))
    ) {
        throw new InspectionFailure(
            "render.inspection_snapshot_mismatch",
            "inspection does not carry the exact authorization-free applied snapshot",
        );
    }
    validateInspectionScope(input.inspection, input.appliedRenderSnapshot);
    validateAppliedAssetProjection(input.inspection, input.appliedRenderSnapshot);
    validateChangedFiles(input.inspection, input.appliedRenderSnapshot);
    validateInventoryDeltas(input.inspection, input.appliedRenderSnapshot);
}

function validateAppliedAssetProjection(
    inspection: RenderedTargetInspectionInput,
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
): void {
    if (inspection.appliedAssets === undefined) return;
    const expected = [
        ...new Set(
            snapshot.decisions.map(
                (decision) => `${decision.semanticRef.subject.assetId}\0${decision.semanticRef.subject.versionId}`,
            ),
        ),
    ].sort(compareUtf8Bytes);
    const actual = inspection.appliedAssets
        .map((asset) => `${asset.version.ref.assetId}\0${asset.version.ref.versionId}`)
        .sort(compareUtf8Bytes);
    requireExactSet(actual, expected, "inspection applied Asset projection");
}

export function validateInspectionScope(
    inspection: RenderedTargetInspectionInput,
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
): void {
    const units = new Map(snapshot.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit]));
    const paths = new Set<string>();
    for (const state of inspection.inspectionScope.fileStates) {
        const unit = units.get(state.outputUnitFingerprint);
        const isClaim = unit?.claims.some((claim) => claim.relativePath === state.relativePath);
        const isManagedDescendant = unit?.managedDirectoryBoundaries.some((boundary) =>
            isStrictDescendant(state.relativePath, boundary.relativePath),
        );
        if (
            !isCanonicalRelativePath(state.relativePath) ||
            paths.has(state.relativePath) ||
            unit === undefined ||
            (state.state === "added" ? !isManagedDescendant : !isClaim)
        ) {
            throw new InspectionFailure(
                "render.inspection_scope_file_invalid",
                "inspection scope paths must be unique canonical claims or managed descendants",
            );
        }
        paths.add(state.relativePath);
        validateFileStateHashes(state);
    }
    const inventoryKeys = new Set<string>();
    for (const inventory of inspection.inspectionScope.directoryInventories) {
        const key = `${inventory.outputUnitFingerprint}\0${inventory.boundary.relativePath}`;
        const unit = units.get(inventory.outputUnitFingerprint);
        if (
            unit === undefined ||
            inventory.boundary.boundaryKind !== "directory_inventory" ||
            !isCanonicalRelativePath(inventory.boundary.relativePath) ||
            !unit.managedDirectoryBoundaries.some(
                (boundary) =>
                    boundary.boundaryKind === inventory.boundary.boundaryKind &&
                    boundary.relativePath === inventory.boundary.relativePath,
            ) ||
            inventoryKeys.has(key)
        ) {
            throw new InspectionFailure(
                "render.inspection_scope_inventory_invalid",
                "inspection directory inventory is foreign, duplicated, or malformed",
            );
        }
        inventoryKeys.add(key);
        requireSortedUniquePaths(inventory.currentDescendantPaths, inventory.boundary.relativePath);
        const expectedCurrentFiles = inspection.inspectionScope.fileStates
            .filter(
                (state) =>
                    state.outputUnitFingerprint === inventory.outputUnitFingerprint &&
                    state.state !== "missing" &&
                    isStrictDescendant(state.relativePath, inventory.boundary.relativePath),
            )
            .map((state) => state.relativePath);
        requireExactSet(
            inventory.currentDescendantPaths,
            expectedCurrentFiles,
            "inspection managed-directory current file closure",
        );
    }
    requireExactSet(
        [...inventoryKeys],
        snapshot.outputUnits.flatMap((unit) =>
            unit.managedDirectoryBoundaries.map((boundary) => `${unit.outputUnitFingerprint}\0${boundary.relativePath}`),
        ),
        "inspection managed-directory inventory closure",
    );
    const { inspectionScopeFingerprint: _stored, ...scopePreimage } = inspection.inspectionScope;
    const expected = computeRenderedTargetInspectionScopeFingerprint({
        deploymentId: inspection.deploymentId,
        appliedCompilationFingerprint: snapshot.compilationFingerprint,
        scope: scopePreimage,
    });
    if (inspection.inspectionScope.inspectionScopeFingerprint !== expected) {
        throw new InspectionFailure(
            "render.inspection_scope_fingerprint_mismatch",
            "inspection scope fingerprint mismatch",
            "conflict",
            true,
        );
    }
}

export function validateFileStateHashes(state: RenderedTargetInspectionFileState): void {
    if (state.state === "missing") {
        requireHashes([state.appliedContentHash, state.outputUnitFingerprint, state.provenanceFingerprint]);
        return;
    }
    if (state.state === "added") {
        requireHashes([state.currentContentHash, state.outputUnitFingerprint]);
        return;
    }
    requireHashes([state.appliedContentHash, state.currentContentHash, state.outputUnitFingerprint, state.provenanceFingerprint]);
}

export function validateChangedFiles(
    inspection: RenderedTargetInspectionInput,
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
): void {
    const states = new Map(inspection.inspectionScope.fileStates.map((state) => [state.relativePath, state]));
    const expectedPaths = inspection.inspectionScope.fileStates
        .filter((state) => state.state !== "unchanged")
        .map((state) => state.relativePath);
    requireExactSet(
        inspection.files.map((file) => file.relativePath),
        expectedPaths,
        "changed inspection input closure",
    );
    for (const file of inspection.files) {
        const state = states.get(file.relativePath) as RenderedTargetInspectionFileState;
        if (
            (file.fileState === "baseline_changed" && state.state !== "changed") ||
            (file.fileState === "baseline_missing" && state.state !== "missing") ||
            (file.fileState === "added_managed_descendant" && state.state !== "added")
        ) {
            throw new InspectionFailure(
                "render.inspection_file_state_mismatch",
                "changed file branch does not match its scope state",
            );
        }
        if (file.fileState === "baseline_changed") {
            const changedState = state as Extract<
                RenderedTargetInspectionFileState,
                { provenanceFingerprint: Sha256Digest; currentContentHash: Sha256Digest }
            >;
            validateTargetFileRenderProvenance(file.provenance);
            if (
                file.provenance.provenanceFingerprint !== changedState.provenanceFingerprint ||
                file.provenance.outputUnitFingerprint !== changedState.outputUnitFingerprint ||
                contentHash(file.appliedContent) !== changedState.appliedContentHash ||
                contentHash(file.currentContent) !== changedState.currentContentHash
            ) {
                throw new InspectionFailure(
                    "render.inspection_file_authority_mismatch",
                    "changed file bytes/provenance contradict the scope",
                );
            }
            const executableChanged = changedState.appliedExecutable !== changedState.currentExecutable;
            if (file.attributeChanges.length !== (executableChanged ? 1 : 0)) {
                throw new InspectionFailure(
                    "render.inspection_attribute_closure_invalid",
                    "executable change evidence must be present exactly when the attribute changed",
                );
            }
            if (changedState.appliedContentHash !== changedState.currentContentHash && file.diffHunks.length === 0) {
                throw new InspectionFailure(
                    "render.inspection_hunk_missing",
                    "changed content requires Core-derived diff evidence",
                );
            }
            validateHunks(
                file,
                changedState.appliedContentHash,
                changedState.currentContentHash,
                contentByteLength(file.appliedContent),
                contentByteLength(file.currentContent),
            );
            for (const change of file.attributeChanges) {
                const { attributeChangeFingerprint: _stored, ...preimage } = change;
                const expected = computeRenderedTargetAttributeChangeFingerprint({
                    relativePath: file.relativePath,
                    inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
                    change: preimage,
                });
                if (
                    change.attributeKind !== "executable" ||
                    change.appliedValue === change.currentValue ||
                    change.appliedValue !== changedState.appliedExecutable ||
                    change.currentValue !== changedState.currentExecutable ||
                    change.attributeChangeFingerprint !== expected
                ) {
                    throw new InspectionFailure(
                        "render.inspection_attribute_invalid",
                        "runtime attribute change is stale or not a change",
                    );
                }
            }
        } else if (file.fileState === "baseline_missing") {
            const missingState = state as Extract<RenderedTargetInspectionFileState, { state: "missing" }>;
            validateTargetFileRenderProvenance(file.provenance);
            if (
                file.currentContent.contentKind !== "missing" ||
                file.provenance.provenanceFingerprint !== missingState.provenanceFingerprint ||
                file.provenance.outputUnitFingerprint !== missingState.outputUnitFingerprint ||
                contentHash(file.appliedContent) !== missingState.appliedContentHash
            ) {
                throw new InspectionFailure(
                    "render.inspection_file_authority_mismatch",
                    "missing file bytes/provenance contradict the scope",
                );
            }
            if (contentByteLength(file.appliedContent) > 0 && file.diffHunks.length === 0) {
                throw new InspectionFailure(
                    "render.inspection_hunk_missing",
                    "deleting non-empty content requires Core-derived diff evidence",
                );
            }
            validateHunks(file, missingState.appliedContentHash, "missing", contentByteLength(file.appliedContent), 0);
        } else {
            const addedState = state as Extract<RenderedTargetInspectionFileState, { state: "added" }>;
            const unit = snapshot.outputUnits.find((item) => item.outputUnitFingerprint === addedState.outputUnitFingerprint);
            const matchingInventory = inspection.inspectionScope.directoryInventories.find(
                (inventory) =>
                    inventory.outputUnitFingerprint === addedState.outputUnitFingerprint &&
                    inventory.currentDescendantPaths.includes(file.relativePath) &&
                    unit?.managedDirectoryBoundaries.some(
                        (boundary) =>
                            boundary.relativePath === inventory.boundary.relativePath &&
                            isStrictDescendant(file.relativePath, boundary.relativePath),
                    ),
            );
            if (matchingInventory === undefined || contentHash(file.currentContent) !== addedState.currentContentHash) {
                throw new InspectionFailure(
                    "render.inspection_file_authority_mismatch",
                    "added file is outside its managed inventory or its bytes contradict the scope",
                );
            }
            if (contentByteLength(file.currentContent) > 0 && file.diffHunks.length === 0) {
                throw new InspectionFailure(
                    "render.inspection_hunk_missing",
                    "adding non-empty content requires Core-derived diff evidence",
                );
            }
            validateHunks(file, EMPTY_CONTENT_HASH, addedState.currentContentHash, 0, contentByteLength(file.currentContent));
        }
    }
}

export function validateHunks(
    file: ChangedRenderedTargetFileInput,
    appliedContentHash: Sha256Digest,
    currentContentHash: Sha256Digest | "missing",
    appliedByteLength: number,
    currentByteLength: number,
): void {
    const seen = new Set<string>();
    for (const hunk of file.diffHunks) {
        const { hunkFingerprint: _stored, ...preimage } = hunk;
        const expected = computeRenderedTargetDiffHunkFingerprint({
            relativePath: file.relativePath,
            appliedContentHash,
            currentContentHash,
            diffAlgorithmVersion: DIFF_ALGORITHM_VERSION,
            hunk: preimage,
        });
        if (
            seen.has(hunk.hunkFingerprint) ||
            ![hunk.appliedStartByte, hunk.appliedEndByte, hunk.currentStartByte, hunk.currentEndByte].every(
                (value) => Number.isSafeInteger(value) && value >= 0,
            ) ||
            hunk.appliedStartByte > hunk.appliedEndByte ||
            hunk.currentStartByte > hunk.currentEndByte ||
            hunk.appliedEndByte > appliedByteLength ||
            hunk.currentEndByte > currentByteLength ||
            hunk.hunkFingerprint !== expected
        ) {
            throw new InspectionFailure("render.inspection_hunk_invalid", "diff hunk is duplicated, malformed, or stale");
        }
        seen.add(hunk.hunkFingerprint);
    }
}

export function validateInventoryDeltas(
    inspection: RenderedTargetInspectionInput,
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
): void {
    const unitIds = new Set(snapshot.outputUnits.map((unit) => unit.outputUnitFingerprint));
    const semanticRefs = new Set(
        snapshot.decisions
            .filter((decision) => decision.semanticRef.semanticKind === "asset.file_inventory")
            .map((decision) => decision.semanticRef.semanticRefFingerprint),
    );
    const seen = new Set<string>();
    const coveredStateKeys = new Set<string>();
    const states = new Map(inspection.inspectionScope.fileStates.map((state) => [state.relativePath, state]));
    for (const delta of inspection.inventoryDeltas) {
        const { inventoryDeltaFingerprint: _stored, ...preimage } = delta;
        const expected = computeRenderedTargetInventoryDeltaFingerprint({
            inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
            delta: preimage,
        });
        const state = states.get(delta.relativePath);
        const inventory = inspection.inspectionScope.directoryInventories.find(
            (item) =>
                item.outputUnitFingerprint === delta.outputUnitFingerprint &&
                isStrictDescendant(delta.relativePath, item.boundary.relativePath),
        );
        const stateMatchesDelta =
            (delta.deltaKind === "file_added" && state?.state === "added") ||
            (delta.deltaKind === "file_deleted" && state?.state === "missing");
        const inventoryMatchesDelta =
            inventory !== undefined &&
            (delta.deltaKind === "file_added"
                ? inventory.currentDescendantPaths.includes(delta.relativePath)
                : !inventory.currentDescendantPaths.includes(delta.relativePath));
        if (
            seen.has(delta.inventoryDeltaFingerprint) ||
            !unitIds.has(delta.outputUnitFingerprint) ||
            !semanticRefs.has(delta.inventorySemanticRefFingerprint) ||
            !isCanonicalRelativePath(delta.relativePath) ||
            (delta.deltaKind !== "file_added" && delta.deltaKind !== "file_deleted") ||
            !stateMatchesDelta ||
            !inventoryMatchesDelta ||
            delta.inventoryDeltaFingerprint !== expected
        ) {
            throw new InspectionFailure(
                "render.inspection_inventory_delta_invalid",
                "inventory delta is foreign, duplicated, malformed, or stale",
            );
        }
        seen.add(delta.inventoryDeltaFingerprint);
        coveredStateKeys.add(`${delta.outputUnitFingerprint}\0${delta.relativePath}\0${delta.deltaKind}`);
    }
    for (const state of states.values()) {
        if (state.state !== "added" && state.state !== "missing") continue;
        const inventory = inspection.inspectionScope.directoryInventories.find(
            (item) =>
                item.outputUnitFingerprint === state.outputUnitFingerprint &&
                isStrictDescendant(state.relativePath, item.boundary.relativePath),
        );
        if (inventory === undefined) continue;
        const deltaKind = state.state === "added" ? "file_added" : "file_deleted";
        if (!coveredStateKeys.has(`${state.outputUnitFingerprint}\0${state.relativePath}\0${deltaKind}`)) {
            throw new InspectionFailure(
                "render.inspection_inventory_delta_missing",
                "managed inventory change is missing its Core-derived delta",
            );
        }
    }
}

export function requiredInspectionUnits(inspection: RenderedTargetInspectionInput): Sha256Digest[] {
    return [
        ...new Set([
            ...inspection.inspectionScope.fileStates
                .filter((state) => state.state !== "unchanged")
                .map((state) => state.outputUnitFingerprint),
            ...inspection.inventoryDeltas.map((delta) => delta.outputUnitFingerprint),
        ]),
    ].sort(compareUtf8Bytes) as Sha256Digest[];
}

export function groupUnitsByRenderer(
    unitFingerprints: readonly Sha256Digest[],
    rendererByUnit: ReadonlyMap<
        string,
        Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>["outputUnitRenderers"][number]
    >,
): Array<{ adapterId: string; adapterVersion: string; unitFingerprints: Set<string> }> {
    const groups = new Map<string, { adapterId: string; adapterVersion: string; unitFingerprints: Set<string> }>();
    for (const fingerprint of unitFingerprints) {
        // validateAppliedRenderSnapshot already proves one renderer per output unit.
        const renderer = rendererByUnit.get(fingerprint) as NonNullable<ReturnType<typeof rendererByUnit.get>>;
        const key = `${renderer.rendererAdapterId}\0${renderer.rendererAdapterVersion}`;
        const group = groups.get(key) ?? {
            adapterId: renderer.rendererAdapterId,
            adapterVersion: renderer.rendererAdapterVersion,
            unitFingerprints: new Set<string>(),
        };
        group.unitFingerprints.add(fingerprint);
        groups.set(key, group);
    }
    return [...groups.values()].sort((left, right) =>
        compareUtf8Bytes(`${left.adapterId}\0${left.adapterVersion}`, `${right.adapterId}\0${right.adapterVersion}`),
    );
}

export function buildInspectionPartition(
    inspection: RenderedTargetInspectionInput,
    states: ReadonlyMap<string, RenderedTargetInspectionFileState>,
    units: ReadonlySet<string>,
): RenderedTargetInspectionInput {
    const appliedAssets = projectAppliedAssetsForInspectionUnits(inspection, units);
    return {
        schemaVersion: 1,
        deploymentId: inspection.deploymentId,
        appliedRenderSnapshot: structuredClone(inspection.appliedRenderSnapshot),
        ...(appliedAssets === undefined ? {} : { appliedAssets }),
        inspectionScope: structuredClone(inspection.inspectionScope),
        files: structuredClone(
            inspection.files.filter((file) =>
                units.has((states.get(file.relativePath) as RenderedTargetInspectionFileState).outputUnitFingerprint),
            ),
        ),
        inventoryDeltas: structuredClone(inspection.inventoryDeltas.filter((delta) => units.has(delta.outputUnitFingerprint))),
    };
}

export function partitionForUnit(
    partition: RenderedTargetInspectionInput,
    states: ReadonlyMap<string, RenderedTargetInspectionFileState>,
    unitFingerprint: string,
): RenderedTargetInspectionInput {
    return {
        ...partition,
        ...(partition.appliedAssets === undefined
            ? {}
            : { appliedAssets: projectAppliedAssetsForInspectionUnits(partition, new Set([unitFingerprint])) }),
        files: partition.files.filter((file) => states.get(file.relativePath)?.outputUnitFingerprint === unitFingerprint),
        inventoryDeltas: partition.inventoryDeltas.filter((delta) => delta.outputUnitFingerprint === unitFingerprint),
    };
}

export function resultForUnit(
    result: AdapterRenderedTargetInspectionResult,
    unitInput: RenderedTargetInspectionInput,
): AdapterRenderedTargetInspectionResult {
    const paths = new Set(unitInput.files.map((file) => file.relativePath));
    const files = result.files.filter((file) => paths.has(file.relativePath));
    const changeIds = new Set(
        files.flatMap((file) => (file.attributionState === "uniquely_attributable" ? file.changeFingerprints : [])),
    );
    return {
        status: result.status,
        changes: result.changes.filter((change) => changeIds.has(change.changeFingerprint)),
        files,
        diagnostics: result.diagnostics,
    };
}

export function validateAdapterInspectionResult(
    result: AdapterRenderedTargetInspectionResult,
    partition: RenderedTargetInspectionInput,
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
): void {
    if (
        result.status !== "complete" ||
        !Array.isArray(result.changes) ||
        !Array.isArray(result.files) ||
        !Array.isArray(result.diagnostics)
    ) {
        throw new InspectionFailure(
            "render.inspection_provider_shape_invalid",
            "inspection provider result has an invalid shape",
        );
    }
    requireExactSet(
        result.files.map((file) => file.relativePath),
        partition.files.map((file) => file.relativePath),
        "provider inspection file closure",
    );
    const semanticRefs = new Set(snapshot.decisions.map((decision) => decision.semanticRef.semanticRefFingerprint));
    const changes = new Map<string, AttributedSemanticChange>();
    for (const change of result.changes) {
        requireSortedUniqueHashes(change.semanticRefFingerprints, "attributed change refs");
        const { changeFingerprint: _stored, ...preimage } = change;
        const expected = computeAttributedSemanticChangeFingerprint({
            inspectionScopeFingerprint: partition.inspectionScope.inspectionScopeFingerprint,
            change: preimage,
        });
        if (
            changes.has(change.changeFingerprint) ||
            change.semanticRefFingerprints.length === 0 ||
            change.semanticRefFingerprints.some((ref) => !semanticRefs.has(ref)) ||
            change.changeFingerprint !== expected
        ) {
            throw new InspectionFailure("render.inspection_change_invalid", "adapter change is foreign, duplicated, or stale");
        }
        changes.set(change.changeFingerprint, change);
    }
    const referencedChanges = new Set<string>();
    for (const file of result.files) {
        const inputFile = partition.files.find(
            (item) => item.relativePath === file.relativePath,
        ) as ChangedRenderedTargetFileInput;
        if (file.attributionState === "uniquely_attributable") {
            requireSortedUniqueHashes(file.changeFingerprints, "file change refs");
            if (file.changeFingerprints.some((fingerprint) => !changes.has(fingerprint))) {
                throw new InspectionFailure(
                    "render.inspection_file_change_unknown",
                    "file attribution references an unknown change",
                );
            }
            for (const fingerprint of file.changeFingerprints) referencedChanges.add(fingerprint);
            const inputHunks = inputFile.diffHunks.map((hunk) => hunk.hunkFingerprint);
            requireExactSet(
                file.hunkAttributions.map((item) => item.hunkFingerprint),
                inputHunks,
                "file hunk attribution closure",
            );
            for (const attribution of file.hunkAttributions) {
                requireSortedUniqueHashes(attribution.semanticRefFingerprints, "hunk semantic refs");
                if (
                    attribution.attributionKind !== "semantic" ||
                    attribution.semanticRefFingerprints.length === 0 ||
                    attribution.semanticRefFingerprints.some((ref) => !semanticRefs.has(ref))
                ) {
                    throw new InspectionFailure(
                        "render.inspection_hunk_attribution_invalid",
                        "hunk attribution is empty or foreign",
                    );
                }
            }
        } else if (file.attributionState === "conflict") {
            if (file.reasonCode.trim().length === 0) {
                throw new InspectionFailure(
                    "render.inspection_conflict_reason_missing",
                    "conflict attribution requires a reason code",
                );
            }
        }
    }
    requireExactSet([...referencedChanges], [...changes.keys()], "referenced change closure");
}

export function mergeChanges(target: Map<string, AttributedSemanticChange>, changes: readonly AttributedSemanticChange[]): void {
    for (const change of changes) {
        // The validated fingerprint binds the complete canonical change body, so
        // the same fingerprint cannot denote two different changes here.
        target.set(change.changeFingerprint, change);
    }
}

export function validateReverseProof(
    proof: ReverseInspectionCoverageProof,
    input: {
        contractFingerprint: Sha256Digest;
        outputUnit: RenderOutputUnit;
        inspectionScopeFingerprint: Sha256Digest;
        files: ChangedRenderedTargetFileInput[];
        inventoryDeltas: RenderedTargetInventoryDelta[];
        result: AdapterRenderedTargetInspectionResult;
    },
): void {
    const hunks = input.files.flatMap((file) => file.diffHunks);
    const attributes = input.files.flatMap((file) => (file.fileState === "baseline_changed" ? file.attributeChanges : []));
    const expected = {
        hunk: hunks.map((item) => item.hunkFingerprint),
        attribute: attributes.map((item) => item.attributeChangeFingerprint),
        inventory: input.inventoryDeltas.map((item) => item.inventoryDeltaFingerprint),
        change: input.result.changes.map((item) => item.changeFingerprint),
    };
    requireSortedUniqueHashes(proof.coveredHunkFingerprints, "proof hunk refs");
    requireSortedUniqueHashes(proof.coveredAttributeChangeFingerprints, "proof attribute refs");
    requireSortedUniqueHashes(proof.coveredInventoryDeltaFingerprints, "proof inventory refs");
    requireSortedUniqueHashes(proof.coveredChangeFingerprints, "proof change refs");
    requireExactSet(proof.coveredHunkFingerprints, expected.hunk, "proof hunk closure");
    requireExactSet(proof.coveredAttributeChangeFingerprints, expected.attribute, "proof attribute closure");
    requireExactSet(proof.coveredInventoryDeltaFingerprints, expected.inventory, "proof inventory closure");
    requireExactSet(proof.coveredChangeFingerprints, expected.change, "proof change closure");
    const { reverseCoverageFingerprint: _stored, ...preimage } = proof;
    const fingerprint = computeReverseInspectionCoverageFingerprint({
        outputContractFingerprint: input.contractFingerprint,
        outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
        inspectionScopeFingerprint: input.inspectionScopeFingerprint,
        diffHunks: hunks,
        attributeChanges: attributes,
        inventoryDeltas: input.inventoryDeltas,
        changes: input.result.changes,
        files: input.result.files,
        proof: preimage,
    });
    if (
        proof.outputUnitFingerprint !== input.outputUnit.outputUnitFingerprint ||
        !isSha256Digest(proof.reverseCoverageFingerprint) ||
        proof.reverseCoverageFingerprint !== fingerprint
    ) {
        throw new InspectionFailure(
            "render.inspection_reverse_proof_invalid",
            "Core-owned reverse coverage proof is stale or malformed",
        );
    }
}

export function finalInspectionResult(
    inspectionScopeFingerprint: Sha256Digest,
    changes: AttributedSemanticChange[],
    files: RenderedFileAttributionResult[],
    reverseCoverageProofs: ReverseInspectionCoverageProof[],
    diagnostics: OperationDiagnostic[],
): RenderedTargetInspectionResult {
    changes.sort((left, right) => compareUtf8Bytes(left.changeFingerprint, right.changeFingerprint));
    files.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    reverseCoverageProofs.sort((left, right) => compareUtf8Bytes(left.outputUnitFingerprint, right.outputUnitFingerprint));
    return {
        status: "complete",
        inspectionScopeFingerprint,
        changes,
        files,
        reverseCoverageProofs,
        inspectionResultFingerprint: computeRenderedTargetInspectionResultFingerprint({
            inspectionScopeFingerprint,
            changes,
            files,
            reverseCoverageProofs,
        }),
        diagnostics,
    };
}
