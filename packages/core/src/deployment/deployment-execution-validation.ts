/** Pre-write target-plan and execution-authority validation for deployment execution. */

import type { AppliedInputsSnapshotV1 } from "../types";
import type { AppliedRenderSnapshotV1, TargetFileRenderProvenanceV1 } from "../contracts/deployment-authority";
import type { TargetPlan } from "./deployment-target-plan";
import { isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import {
    validateAppliedInputsSnapshot,
    validateAppliedRenderSnapshot,
    validateTargetFileRenderProvenance,
} from "../render/deployment-render-authority";
import { computeAppliedRenderSnapshotFingerprint } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";

export interface DeploymentExecutionAuthorityV1 {
    appliedInputsSnapshot: AppliedInputsSnapshotV1;
    appliedRenderSnapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
    targetFileProvenance: {
        relativePath: string;
        provenance: TargetFileRenderProvenanceV1;
    }[];
}

/**
 * Validate every target path before lock, journal, or runtime write authority is acquired.
 *
 * A non-duplicate alias such as `a//b.md` would pass a merely POSIX-relative check and then reach
 * occupancy, lock, journal, and CAS authorities as a distinct raw string from `a/b.md`. Requiring
 * the canonical relative form at this entry point closes that single-writer bypass. Duplicate
 * detection remains explicit even though canonical equality makes raw and normalized values equal.
 */
export function validateTargetPlanPaths(plan: TargetPlan): string | null {
    const seen = new Set<string>();
    for (const targetFile of plan.targetFiles) {
        if (!isCanonicalRelativePath(targetFile.relativePath)) {
            return `invalid (non-canonical) relativePath in target plan: ${JSON.stringify(targetFile.relativePath)}`;
        }
        if (seen.has(targetFile.relativePath)) {
            return `duplicate relativePath in target plan: ${targetFile.relativePath}`;
        }
        seen.add(targetFile.relativePath);
        if (
            targetFile.containerPatchPreimageHash !== undefined &&
            targetFile.containerPatchPreimageHash !== null &&
            !isSha256Digest(targetFile.containerPatchPreimageHash)
        ) {
            return "shared-container patch preimage must be a content hash or missing state";
        }
    }
    const boundaries = plan.managedDirectoryBoundaries.map((boundary) => boundary.relativePath);
    if (
        plan.targetFiles.some(
            (file) =>
                file.containerPatchPreimageHash !== undefined &&
                boundaries.some((boundary) => file.relativePath.startsWith(`${boundary}/`)),
        )
    ) {
        return "shared-container patches cannot be included in a complete-directory replacement";
    }
    if (
        new Set(boundaries).size !== boundaries.length ||
        boundaries.some((boundary) => !isCanonicalRelativePath(boundary)) ||
        JSON.stringify([...boundaries].sort()) !== JSON.stringify(boundaries)
    ) {
        return "managed directory boundaries must be sorted unique canonical relative paths";
    }
    if (
        boundaries.some((boundary, index) =>
            boundaries.some(
                (candidate, candidateIndex) =>
                    index !== candidateIndex && (boundary.startsWith(`${candidate}/`) || candidate.startsWith(`${boundary}/`)),
            ),
        )
    ) {
        return "managed directory boundaries must not overlap";
    }
    for (const boundary of plan.managedDirectoryBoundaries) {
        if (boundary.desiredDirectoryPaths === undefined) continue;
        if (
            boundary.desiredDirectoryPaths.length === 0 ||
            boundary.desiredDirectoryPaths[0] !== boundary.relativePath ||
            new Set(boundary.desiredDirectoryPaths).size !== boundary.desiredDirectoryPaths.length ||
            JSON.stringify([...boundary.desiredDirectoryPaths].sort()) !== JSON.stringify(boundary.desiredDirectoryPaths) ||
            boundary.desiredDirectoryPaths.some(
                (path) =>
                    !isCanonicalRelativePath(path) ||
                    (path !== boundary.relativePath && !path.startsWith(`${boundary.relativePath}/`)) ||
                    seen.has(path),
            )
        ) {
            return "managed desired-directory paths must be a sorted canonical graph below their boundary";
        }
    }
    return null;
}

export function validateDeploymentExecutionAuthority(plan: TargetPlan, authority: DeploymentExecutionAuthorityV1): string | null {
    try {
        validateAppliedInputsSnapshot(authority.appliedInputsSnapshot);
        validateAppliedRenderSnapshot(authority.appliedRenderSnapshot);
        const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(authority.appliedRenderSnapshot);
        const items = [...authority.targetFileProvenance].sort((left, right) =>
            left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
        );
        if (items.some((item, index) => item !== authority.targetFileProvenance[index])) {
            throw new Error("targetFileProvenance must be sorted by relativePath");
        }
        const planPaths = plan.targetFiles.map((file) => file.relativePath).sort();
        const authorityPaths = items.map((item) => item.relativePath);
        if (JSON.stringify(planPaths) !== JSON.stringify(authorityPaths)) {
            throw new Error("targetFileProvenance must cover the exact target plan path set");
        }
        const outputUnits = new Set(authority.appliedRenderSnapshot.outputUnits.map((unit) => unit.outputUnitFingerprint));
        const expectedBoundaries = authority.appliedRenderSnapshot.outputUnits
            .flatMap((unit) =>
                unit.managedDirectoryBoundaries.map((boundary) => ({
                    relativePath: boundary.relativePath,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    ...("desiredDirectoryPaths" in boundary
                        ? { desiredDirectoryPaths: [...boundary.desiredDirectoryPaths] }
                        : {}),
                })),
            )
            .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
        if (JSON.stringify(plan.managedDirectoryBoundaries) !== JSON.stringify(expectedBoundaries)) {
            throw new Error("target plan managed-directory boundaries disagree with the applied render snapshot");
        }
        const semanticRefs = new Set(
            authority.appliedRenderSnapshot.decisions.map((decision) => decision.semanticRef.semanticRefFingerprint),
        );
        const planByPath = new Map(plan.targetFiles.map((file) => [file.relativePath, file]));
        const claimByPath = new Map<
            string,
            {
                outputUnitFingerprint: string;
                contentKind: "text" | "binary";
                executable: boolean;
            }
        >();
        for (const unit of authority.appliedRenderSnapshot.outputUnits) {
            for (const claim of unit.claims) {
                if (claimByPath.has(claim.relativePath)) {
                    throw new Error("render output units claim one target path more than once");
                }
                claimByPath.set(claim.relativePath, {
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    contentKind: claim.contentKind,
                    executable: claim.executable,
                });
            }
        }
        if (JSON.stringify([...claimByPath.keys()].sort()) !== JSON.stringify(planPaths)) {
            throw new Error("render output claims must cover the exact target plan path set");
        }
        for (const item of items) {
            validateTargetFileRenderProvenance(item.provenance);
            if (item.provenance.appliedRenderSnapshotFingerprint !== snapshotFingerprint) {
                throw new Error("target provenance references another render snapshot");
            }
            if (!outputUnits.has(item.provenance.outputUnitFingerprint)) {
                throw new Error("target provenance references an unknown output unit");
            }
            if (item.provenance.semanticRefFingerprints.some((ref) => !semanticRefs.has(ref))) {
                throw new Error("target provenance references an unknown semantic");
            }
            // Exact path-set equality above proves this lookup exists.
            const planFile = planByPath.get(item.relativePath) as TargetPlan["targetFiles"][number];
            const claim = claimByPath.get(item.relativePath) as {
                outputUnitFingerprint: string;
                contentKind: "text" | "binary";
                executable: boolean;
            };
            if (
                claim.outputUnitFingerprint !== item.provenance.outputUnitFingerprint ||
                claim.contentKind !== planFile.content.contentKind ||
                claim.executable !== planFile.executable
            ) {
                throw new Error("target plan/provenance disagrees with its render output claim");
            }
            if (
                planFile.outputUnitFingerprint !== item.provenance.outputUnitFingerprint ||
                planFile.materializationFingerprint !== item.provenance.materializationFingerprint ||
                JSON.stringify(planFile.semanticRefFingerprints) !== JSON.stringify(item.provenance.semanticRefFingerprints) ||
                JSON.stringify(planFile.sectionBindings) !== JSON.stringify(item.provenance.sectionBindings)
            ) {
                throw new Error("compiled TargetPlan disagrees with strict provenance");
            }
        }
        return null;
    } catch (error) {
        return `invalid Deployment execution authority: ${String(error)}`;
    }
}
