import type { AssetKindTypeDataV2 } from "./specs";
import type {
    AppliedRenderDecisionBaseV1,
    AppliedRenderSnapshotV1,
    RenderManagedDirectoryBoundary,
    RenderOutcomeDetailsV1,
    TargetFileRenderProvenanceV1,
} from "./deployment-authority";
import type { FileRole, EpochMillis, OperationStatus, PosixRelativePath, Sha256Digest, UuidV4 } from "./primitives";
import type { OperationDiagnostic, TargetFileContent } from "./common";
import type { VersionRef } from "./common";
import type { RenderAnalysisView, RenderAssetInput, RenderSelectionRequest } from "./render";

export type InspectionSafeAppliedRenderDecisionV1 = Omit<AppliedRenderDecisionBaseV1, "approval"> & RenderOutcomeDetailsV1;

export type InspectionSafeAppliedRenderSnapshotV1 = Omit<
    Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
    "promotionAuthorizations" | "decisions"
> & { decisions: InspectionSafeAppliedRenderDecisionV1[] };

export interface RenderedTargetInspectionInput {
    schemaVersion: 1;
    deploymentId: UuidV4;
    appliedRenderSnapshot: InspectionSafeAppliedRenderSnapshotV1;
    /**
     * Core-projected immutable inputs for only the Assets whose semantics are
     * owned by this inspection partition. Older non-aggregate handlers may
     * ignore an absent projection; aggregate reverse must fail closed without
     * it.
     */
    appliedAssets?: RenderAssetInput[];
    inspectionScope: RenderedTargetInspectionScope;
    files: ChangedRenderedTargetFileInput[];
    inventoryDeltas: RenderedTargetInventoryDelta[];
}

export type RenderedTargetInspectionFileState =
    | {
          relativePath: PosixRelativePath;
          state: "unchanged" | "changed";
          appliedContentHash: Sha256Digest;
          currentContentHash: Sha256Digest;
          appliedExecutable: boolean;
          currentExecutable: boolean;
          outputUnitFingerprint: Sha256Digest;
          provenanceFingerprint: Sha256Digest;
      }
    | {
          relativePath: PosixRelativePath;
          state: "missing";
          appliedContentHash: Sha256Digest;
          appliedExecutable: boolean;
          outputUnitFingerprint: Sha256Digest;
          provenanceFingerprint: Sha256Digest;
      }
    | {
          relativePath: PosixRelativePath;
          state: "added";
          currentContentHash: Sha256Digest;
          currentExecutable: boolean;
          outputUnitFingerprint: Sha256Digest;
      };

export interface RenderedTargetInspectionScope {
    inspectionScopeFingerprint: Sha256Digest;
    fileStates: RenderedTargetInspectionFileState[];
    directoryInventories: {
        outputUnitFingerprint: Sha256Digest;
        boundary: RenderManagedDirectoryBoundary;
        currentDescendantPaths: PosixRelativePath[];
    }[];
}

export type ChangedRenderedTargetFileInput =
    | {
          fileState: "baseline_changed";
          relativePath: PosixRelativePath;
          appliedContent: TargetFileContent;
          currentContent: TargetFileContent;
          diffHunks: RenderedTargetDiffHunk[];
          attributeChanges: RenderedTargetAttributeChange[];
          provenance: TargetFileRenderProvenanceV1;
      }
    | {
          fileState: "baseline_missing";
          relativePath: PosixRelativePath;
          appliedContent: TargetFileContent;
          currentContent: { contentKind: "missing" };
          diffHunks: RenderedTargetDiffHunk[];
          provenance: TargetFileRenderProvenanceV1;
      }
    | {
          fileState: "added_managed_descendant";
          relativePath: PosixRelativePath;
          currentContent: TargetFileContent;
          diffHunks: RenderedTargetDiffHunk[];
      };

export interface RenderedTargetAttributeChange {
    attributeChangeFingerprint: Sha256Digest;
    attributeKind: "executable";
    appliedValue: boolean;
    currentValue: boolean;
}

export interface RenderedTargetInventoryDelta {
    inventoryDeltaFingerprint: Sha256Digest;
    outputUnitFingerprint: Sha256Digest;
    relativePath: PosixRelativePath;
    deltaKind: "file_added" | "file_deleted";
    inventorySemanticRefFingerprint: Sha256Digest;
}

export interface RenderedTargetDiffHunk {
    hunkFingerprint: Sha256Digest;
    appliedStartByte: number;
    appliedEndByte: number;
    currentStartByte: number;
    currentEndByte: number;
}

export type AttributedSemanticChange =
    | {
          changeKind: "asset_type_data_replacement";
          changeFingerprint: Sha256Digest;
          semanticRefFingerprints: Sha256Digest[];
          replacement: AssetKindTypeDataV2;
      }
    | {
          changeKind: "file_content_replacement";
          changeFingerprint: Sha256Digest;
          semanticRefFingerprints: Sha256Digest[];
          replacementContent: TargetFileContent;
      }
    | {
          changeKind: "file_deletion";
          changeFingerprint: Sha256Digest;
          semanticRefFingerprints: Sha256Digest[];
          fileId: UuidV4;
      }
    | {
          changeKind: "file_executable_replacement";
          changeFingerprint: Sha256Digest;
          semanticRefFingerprints: Sha256Digest[];
          fileId: UuidV4;
          executable: boolean;
      }
    | {
          changeKind: "file_addition";
          changeFingerprint: Sha256Digest;
          semanticRefFingerprints: Sha256Digest[];
          logicalPath: PosixRelativePath;
          role: FileRole;
          content: TargetFileContent;
          executable: boolean;
      };

export interface RenderedDiffHunkAttribution {
    attributionKind: "semantic";
    hunkFingerprint: Sha256Digest;
    semanticRefFingerprints: Sha256Digest[];
}

export type RenderedFileAttributionResult =
    | {
          relativePath: PosixRelativePath;
          attributionState: "uniquely_attributable";
          changeFingerprints: Sha256Digest[];
          hunkAttributions: RenderedDiffHunkAttribution[];
          diagnostics: OperationDiagnostic[];
      }
    | {
          relativePath: PosixRelativePath;
          attributionState: "whole_file_adoption_required";
          diagnostics: OperationDiagnostic[];
      }
    | {
          relativePath: PosixRelativePath;
          attributionState: "conflict";
          reasonCode: string;
          diagnostics: OperationDiagnostic[];
      };

export interface AdapterRenderedTargetInspectionResult {
    status: OperationStatus;
    changes: AttributedSemanticChange[];
    files: RenderedFileAttributionResult[];
    diagnostics: OperationDiagnostic[];
}

export interface ReverseInspectionCoverageProof {
    outputUnitFingerprint: Sha256Digest;
    coveredHunkFingerprints: Sha256Digest[];
    coveredAttributeChangeFingerprints: Sha256Digest[];
    coveredInventoryDeltaFingerprints: Sha256Digest[];
    coveredChangeFingerprints: Sha256Digest[];
    reverseCoverageFingerprint: Sha256Digest;
}

export interface RenderedTargetInspectionResult {
    status: OperationStatus;
    inspectionScopeFingerprint: Sha256Digest;
    changes: AttributedSemanticChange[];
    files: RenderedFileAttributionResult[];
    reverseCoverageProofs: ReverseInspectionCoverageProof[];
    inspectionResultFingerprint: Sha256Digest;
    diagnostics: OperationDiagnostic[];
}

/** Bind prepare to the exact inspection preview the user is accepting. */
export interface PrepareRenderedTargetAcceptInput {
    deploymentId: UuidV4;
    inspectionResultFingerprint: Sha256Digest;
}

export type ReverseNewVersionPromotionRequest =
    | { promotionAction: "use_existing_authority" }
    | { promotionAction: "grant_staged_version_current_target" };

/** Public prepare view. Durable marker/locator fields deliberately stay internal to Core. */
export type RenderedTargetAcceptPreparationView =
    | {
          preparationState: "prepared";
          preparationId: UuidV4;
          preparationRevision: number;
          expiresAt: EpochMillis;
          promotionState: "already_authorized" | "user_confirmation_required";
          renderAnalysis: RenderAnalysisView;
      }
    | { preparationState: "not_prepared" };

export interface CommitRenderedTargetAcceptInput {
    preparationId: UuidV4;
    expectedPreparationRevision: number;
    userActionId: string;
    newVersionPromotion: ReverseNewVersionPromotionRequest;
    renderSelectionRequest: RenderSelectionRequest;
}

export type RenderedTargetAcceptCommitView =
    | { commitState: "committed"; version: VersionRef }
    | { commitState: "not_committed"; versionPublicationState: "not_published" }
    | {
          commitState: "not_committed";
          versionPublicationState: "published_not_selected";
          version: VersionRef;
      }
    | {
          commitState: "recovery_required";
          reasonCode:
              | "receipt_contradiction"
              | "database_postcondition_partial"
              | "asset_filesystem_mismatch"
              | "durability_unconfirmed";
      }
    | { commitState: "outcome_unavailable" };

export interface CancelRenderedTargetAcceptInput {
    preparationId: UuidV4;
    expectedPreparationRevision: number;
}
