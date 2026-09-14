/** Deployment render-authority finalization and canonical JSON codecs. */

import type {
    AppliedRenderSnapshotRefV1,
    AppliedRenderSnapshotV1,
    DeploymentFileAuthorityProjectionInputV1,
    DeploymentFileAuthorityProjectionV1,
    DeploymentFileBaselineStateV1,
    DeploymentResidualRenderAuthorityV1,
    RemovalIntentFingerprintInputV1,
    RenderedSectionBinding,
    TargetFileRenderProvenanceV1,
} from "../contracts/deployment-authority";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { AppliedInputsSnapshotV1 } from "../types";
import {
    computeAppliedRenderSnapshotFingerprint,
    computeDeploymentResidualAuthorityFingerprint,
    computeDeploymentResidualAuthorityId,
    computeRemovalIntentFingerprint,
    computeTargetFileRenderProvenanceFingerprint,
} from "../foundation/fingerprint";
import {
    validateAppliedRenderSnapshot,
    validateAppliedRenderSnapshotRef,
    validateTargetFileRenderProvenance,
    validateDeploymentResidualAuthority,
    validateDeploymentFileBaselineState,
    validateResidualPreimage,
    validateResidualBody,
    validateRemovalIntent,
    validateObservation,
    requireSortedUnique,
    requireArray,
    requireObject,
    requireExactKeys,
    requireUuid,
    requirePath,
    requireNonBlank,
    requireBoolean,
    requireEpoch,
    prettyCanonicalJson,
} from "./deployment-render-authority-validation";

export interface FinalizeTargetFileRenderProvenanceInput {
    schemaVersion: 1;
    appliedRenderSnapshotFingerprint: Sha256Digest;
    outputUnitFingerprint: Sha256Digest;
    materializationFingerprint: Sha256Digest;
    semanticRefFingerprints: Sha256Digest[];
    sectionBindings: RenderedSectionBinding[];
}

export type FinalizeDeploymentResidualAuthorityInput = Omit<
    DeploymentResidualRenderAuthorityV1,
    "residualAuthorityId" | "residualAuthorityFingerprint"
>;

export function finalizeTargetFileRenderProvenance(input: FinalizeTargetFileRenderProvenanceInput): TargetFileRenderProvenanceV1 {
    const provenance: TargetFileRenderProvenanceV1 = {
        ...input,
        provenanceFingerprint: computeTargetFileRenderProvenanceFingerprint(input),
    };
    validateTargetFileRenderProvenance(provenance);
    return provenance;
}

export function finalizeDeploymentResidualAuthority(
    input: FinalizeDeploymentResidualAuthorityInput,
): DeploymentResidualRenderAuthorityV1 {
    validateResidualPreimage(input);
    const withId = {
        ...input,
        residualAuthorityId: computeDeploymentResidualAuthorityId(input),
    };
    const residual: DeploymentResidualRenderAuthorityV1 = {
        ...withId,
        residualAuthorityFingerprint: computeDeploymentResidualAuthorityFingerprint(withId),
    };
    validateDeploymentResidualAuthority(residual);
    return residual;
}

export function makeRemovalIntentFingerprint(input: RemovalIntentFingerprintInputV1): Sha256Digest {
    validateRemovalIntent(input);
    return computeRemovalIntentFingerprint(input);
}

export function serializeAppliedRenderSnapshot(snapshot: AppliedRenderSnapshotV1): string {
    validateAppliedRenderSnapshot(snapshot);
    return prettyCanonicalJson(snapshot);
}

export function serializeAppliedInputsSnapshot(snapshot: AppliedInputsSnapshotV1): string {
    validateAppliedInputsSnapshot(snapshot);
    return prettyCanonicalJson(snapshot);
}

export function parseAppliedInputsSnapshot(json: string, expectedDeploymentId: UuidV4): AppliedInputsSnapshotV1 {
    const parsed: unknown = JSON.parse(json);
    validateAppliedInputsSnapshot(parsed);
    if (parsed.deploymentId !== expectedDeploymentId) {
        throw new Error("AppliedInputsSnapshot does not belong to the enclosing Deployment");
    }
    return parsed;
}

export function validateAppliedInputsSnapshot(value: unknown): asserts value is AppliedInputsSnapshotV1 {
    const object = requireObject(value, "AppliedInputsSnapshot");
    requireExactKeys(object, ["schemaVersion", "deploymentId", "consumerAgentRuntimeIds", "assets"], "AppliedInputsSnapshot");
    if (object.schemaVersion !== 1) throw new Error("AppliedInputsSnapshot schemaVersion must be 1");
    requireUuid(object.deploymentId, "AppliedInputsSnapshot.deploymentId");
    const consumers = requireArray(object.consumerAgentRuntimeIds, "consumerAgentRuntimeIds");
    consumers.forEach((consumer) => {
        requireNonBlank(consumer, "consumerAgentRuntimeId");
        if ((consumer as string) !== (consumer as string).toUpperCase()) {
            throw new Error("consumerAgentRuntimeIds must use canonical uppercase IDs");
        }
    });
    requireSortedUnique(consumers, (consumer) => consumer as string, "consumerAgentRuntimeIds");
    const assets = requireArray(object.assets, "AppliedInputsSnapshot.assets");
    const seenAssets = new Set<string>();
    for (const asset of assets) {
        const item = requireObject(asset, "AppliedInputsSnapshot asset");
        requireExactKeys(item, ["assetId", "versionId", "allowIncomplete"], "AppliedInputsSnapshot asset");
        requireUuid(item.assetId, "snapshot assetId");
        requireUuid(item.versionId, "snapshot versionId");
        requireBoolean(item.allowIncomplete, "snapshot allowIncomplete");
        if (seenAssets.has(item.assetId)) throw new Error("AppliedInputsSnapshot assetId must be unique");
        seenAssets.add(item.assetId);
    }
}

export function parseAppliedRenderSnapshot(json: string, expectedFingerprint?: Sha256Digest): AppliedRenderSnapshotV1 {
    const parsed: unknown = JSON.parse(json);
    validateAppliedRenderSnapshot(parsed);
    if (expectedFingerprint !== undefined && computeAppliedRenderSnapshotFingerprint(parsed) !== expectedFingerprint) {
        throw new Error("AppliedRenderSnapshot fingerprint mismatch");
    }
    return parsed;
}

export function serializeAppliedRenderSnapshotRef(ref: AppliedRenderSnapshotRefV1): string {
    validateAppliedRenderSnapshotRef(ref);
    return prettyCanonicalJson(ref);
}

export function parseAppliedRenderSnapshotRef(json: string): AppliedRenderSnapshotRefV1 {
    const parsed: unknown = JSON.parse(json);
    validateAppliedRenderSnapshotRef(parsed);
    return parsed;
}

export function serializeDeploymentFileBaselineState(state: DeploymentFileBaselineStateV1): string {
    validateDeploymentFileBaselineState(state);
    return prettyCanonicalJson(state);
}

export function parseDeploymentFileBaselineState(json: string): DeploymentFileBaselineStateV1 {
    const parsed: unknown = JSON.parse(json);
    validateDeploymentFileBaselineState(parsed);
    return parsed;
}

export function serializeDeploymentResidualAuthority(residual: DeploymentResidualRenderAuthorityV1): string {
    validateDeploymentResidualAuthority(residual);
    return prettyCanonicalJson(residual);
}

export function parseDeploymentResidualAuthority(json: string): DeploymentResidualRenderAuthorityV1 {
    const parsed: unknown = JSON.parse(json);
    validateDeploymentResidualAuthority(parsed);
    return parsed;
}

export function serializeDeploymentResidualAuthorityBody(residual: DeploymentResidualRenderAuthorityV1): string {
    validateDeploymentResidualAuthority(residual);
    const {
        residualAuthorityId: _id,
        residualAuthorityFingerprint: _fingerprint,
        deploymentId: _deploymentId,
        relativePath: _relativePath,
        ...body
    } = residual;
    return prettyCanonicalJson(body);
}

export function parseDeploymentResidualAuthorityRow(input: {
    residualAuthorityId: string;
    residualAuthorityFingerprint: Sha256Digest;
    deploymentId: UuidV4;
    relativePath: string;
    authorityBody: string;
}): DeploymentResidualRenderAuthorityV1 {
    const body: unknown = JSON.parse(input.authorityBody);
    validateResidualBody(body);
    const residual: DeploymentResidualRenderAuthorityV1 = {
        ...body,
        residualAuthorityId: input.residualAuthorityId,
        residualAuthorityFingerprint: input.residualAuthorityFingerprint,
        deploymentId: input.deploymentId,
        relativePath: input.relativePath,
    };
    validateDeploymentResidualAuthority(residual);
    return residual;
}

export function projectDeploymentFileAuthority(
    input: DeploymentFileAuthorityProjectionInputV1,
): DeploymentFileAuthorityProjectionV1 {
    requireNonBlank(input.deploymentFileId, "deploymentFileId");
    requirePath(input.relativePath, "relativePath");
    requireEpoch(input.observedAt, "observedAt");
    requireEpoch(input.createdAt, "createdAt");
    requireEpoch(input.updatedAt, "updatedAt");
    validateDeploymentFileBaselineState(input.baselineState);
    validateObservation(input.observation);
    const base = {
        deploymentFileId: input.deploymentFileId,
        relativePath: input.relativePath,
        observedAt: input.observedAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
    };
    if (input.baselineState.rowState === "removed") {
        if (input.observation.observedState !== "missing") {
            throw new Error("removed DeploymentFile authority must be observed missing");
        }
        return {
            ...base,
            rowState: "removed",
            latestResidualAuthorityId: input.baselineState.latestResidualAuthorityId,
            observation: input.observation,
        };
    }
    return {
        ...base,
        rowState: "active",
        appliedPayload: input.baselineState.appliedPayload,
        appliedExecutable: input.baselineState.appliedExecutable,
        provenance: input.baselineState.provenance,
        observation: input.observation,
    };
}
