import type { RestrictedUsageExpectations, RestrictedUsageObservation } from "../orchestration/restricted-target-usage-codec";
/** Private App Server operation protocol; this is not a filesystem or shell API. */
import type { DeploymentInspectionTargetPlan } from "../orchestration/deployment-inspection-capture";
import type { RestrictedInspectionFailure } from "../orchestration/restricted-target-inspection-codec";
import type { PosixRelativePath, RenderTargetFileSnapshotV1 } from "../types";
import type { ActiveJournalV3, ActiveJournalV4 } from "./deployment-journal";
import { MAXIMUM_MANAGED_PREVIEW_BYTES } from "./deployment-managed-directory-graph";
import type { VerifiedTarget } from "./deployment-target-verify";
import type {
    RestrictedContainerCaptureWire,
    RestrictedContainerFailure,
    RestrictedContainerPatchWire,
} from "./restricted-target-container-codec";
import type { RestrictedGraphPrepareWire, RestrictedReplacementAuthorityWire } from "./restricted-target-graph-codec";
import type { RestrictedGraphPreparationResult, RestrictedGraphStep } from "./restricted-target-graph-operation";
import type { RestrictedPreviewWire } from "./restricted-target-preview-codec";

export const RESTRICTED_TARGET_PROTOCOL = "oaam.restricted-target.v2";
// Three independently retained images (baseline, desired and reviewed rollback),
// encoded as base64, plus bounded graph/journal/envelope metadata. This covers
// the reviewed four-MiB directory cases; the actual full envelope remains bounded.
export const RESTRICTED_TARGET_MAX_FRAME_BYTES = 3 * 4 * Math.ceil(MAXIMUM_MANAGED_PREVIEW_BYTES / 3) + 1024 * 1024;

export interface RestrictedTargetRootBinding {
    bindingId: string;
    platformInstanceId: string;
    targetRootPath: string;
    executionRootPath: string;
}

export interface RestrictedTargetBinding extends RestrictedTargetRootBinding {
    deploymentId: string;
}

/** Read-only usage never acquires a Deployment or journal identity. */
export interface RestrictedUsageTargetBinding extends RestrictedTargetRootBinding {
    kind: "asset_usage";
}

export interface RestrictedTargetSession {
    hostInstanceId: string;
    sessionId: string;
}

export type RestrictedTargetOperation =
    | { kind: "asset_usage"; expectations: RestrictedUsageExpectations }
    | { kind: "prepare_graph"; input: RestrictedGraphPrepareWire }
    | { kind: "execute_graph"; preparationId: string; journal: ActiveJournalV3 | ActiveJournalV4 }
    | { kind: "continue_graph"; journal: ActiveJournalV3 | ActiveJournalV4 }
    | { kind: "recover_graph"; journal: ActiveJournalV3 | ActiveJournalV4; side: "old" | "new" }
    | { kind: "preview"; input: RestrictedPreviewWire }
    | { kind: "inspection_capture"; plan: DeploymentInspectionTargetPlan }
    | { kind: "memory_catalog_snapshots"; paths: PosixRelativePath[] }
    | { kind: "container_patches"; intents: RestrictedContainerPatchWire[] };

export interface RestrictedTargetRequest extends RestrictedTargetSession {
    protocol: typeof RESTRICTED_TARGET_PROTOCOL;
    operationId: string;
    sequence: number;
    bindingId: string;
    operation: RestrictedTargetOperation;
}

export type RestrictedTargetExecutionResult =
    | { outcome: "verified"; verified: VerifiedTarget[] }
    | { outcome: "conflict" | "uncertain" };

export type RestrictedTargetResult =
    | { kind: "asset_usage"; observations: RestrictedUsageObservation[] }
    | { kind: "prepare_graph"; result: RestrictedGraphPreparationResult }
    | { kind: "execute_graph" | "continue_graph" | "recover_graph"; step: RestrictedGraphStep }
    | { kind: "preview"; outcome: "captured"; authority: RestrictedReplacementAuthorityWire }
    | { kind: "preview"; outcome: "failed"; code: string; message: string }
    | { kind: "inspection_capture"; outcome: "captured"; authority: RestrictedReplacementAuthorityWire }
    | { kind: "inspection_capture"; outcome: "failed"; failure: RestrictedInspectionFailure }
    | { kind: "memory_catalog_snapshots"; outcome: "captured"; snapshots: RenderTargetFileSnapshotV1[] }
    | { kind: "memory_catalog_snapshots"; outcome: "failed"; code: string; message: string; retryable: boolean }
    | { kind: "container_patches"; outcome: "captured"; targets: RestrictedContainerCaptureWire[] }
    | { kind: "container_patches"; outcome: "failed"; failure: RestrictedContainerFailure };

export interface RestrictedTargetResponse extends RestrictedTargetSession {
    protocol: typeof RESTRICTED_TARGET_PROTOCOL;
    operationId: string;
    sequence: number;
    bindingId: string;
    result: RestrictedTargetResult;
}
