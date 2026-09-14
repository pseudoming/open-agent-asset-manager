import type { AdapterId, ContentKind, EpochMillis, PosixRelativePath, Sha256Digest, UuidV4 } from "./primitives";
import type { PortableDialectFieldV1 } from "./dialect";
import type { RootLocatorKind, RootRole, SourceDomain, SourceEvidenceLevel } from "./source-import-probe";

export type SourcePromotionSafety = "default_promotable" | "requires_user_confirmation";

export interface VersionNativeRepresentationFileV1 {
    relativePath: PosixRelativePath;
    contentKind: ContentKind;
    mediaType: string;
    contentHash: Sha256Digest;
    byteSize: number;
    executable: boolean;
}

export interface VersionNativeRepresentationV1 {
    schemaVersion: 1;
    dialectId: string;
    dialectContractFingerprint: Sha256Digest;
    canonicalContentFingerprint: Sha256Digest;
    files: VersionNativeRepresentationFileV1[];
    representationFingerprint: Sha256Digest;
}

/**
 * Complete native directory graph authority.
 *
 * V1 remains the exact historical file-only envelope. V2 adds the byte-less
 * directory membership that a copied/reopened Version needs in order to
 * reproduce empty directories without consulting import provenance or a live
 * source tree.
 */
export interface VersionNativeRepresentationV2 {
    schemaVersion: 2;
    dialectId: string;
    dialectContractFingerprint: Sha256Digest;
    canonicalContentFingerprint: Sha256Digest;
    directories: PosixRelativePath[];
    files: VersionNativeRepresentationFileV1[];
    representationFingerprint: Sha256Digest;
}

export type VersionNativeRepresentation = VersionNativeRepresentationV1 | VersionNativeRepresentationV2;

export interface VersionDialectRestorationPayloadRefV1 {
    dialectId: string;
    restorationContractFingerprint: Sha256Digest;
    contentHash: Sha256Digest;
}

export interface VersionPortableDialectContractRefV1 {
    field: PortableDialectFieldV1;
    dialectId: string;
    dialectContractFingerprint: Sha256Digest;
}

export type AcceptedImportPromotionDispositionV1 =
    | {
          promotionAction: "import_only";
          userActionEvidenceId: string;
      }
    | {
          promotionAction: "grant_current_version_current_target";
          promotionGrantId: UuidV4;
          userActionEvidenceId: string;
      }
    | {
          promotionAction: "grant_asset_all_versions_current_target";
          promotionGrantId: UuidV4;
          userActionEvidenceId: string;
      };

export interface ImportProvenanceAuthorityV1 {
    schemaVersion: 1;
    importProvenanceId: string;
    assetId: UuidV4;
    versionId: UuidV4;
    previewSnapshotFingerprint: Sha256Digest;
    candidateFingerprint: Sha256Digest;
    acceptedFreshness: "current_source_verified" | "user_approved_preview_snapshot";
    acceptedPromotion: AcceptedImportPromotionDispositionV1;
    promotionSafety: SourcePromotionSafety;
    importedAt: EpochMillis;
    authorityFingerprint: Sha256Digest;
}

export interface ImportSourceRootSnapshotV1 {
    sourceRootId: string;
    rootRole: RootRole;
    sourceDomain: SourceDomain;
    path: string;
    locatorEvidence: Array<{
        locatorKind: RootLocatorKind;
        locatorKey: string;
        evidenceLevel: SourceEvidenceLevel;
    }>;
}

export type ImportSourceEntrySnapshotV1 =
    | {
          observedReadEntryId: string;
          sourceRootId: string;
          relativePath: PosixRelativePath | "";
          entryKind: "file";
          contentHash: Sha256Digest;
          executable: boolean;
          physicalIdentityFingerprint: Sha256Digest;
      }
    | {
          observedReadEntryId: string;
          sourceRootId: string;
          relativePath: PosixRelativePath | "";
          entryKind: "directory";
          physicalIdentityFingerprint: Sha256Digest;
          directoryInventoryFingerprint: Sha256Digest;
      };

export interface ImportSourceFileOriginSnapshotV1 {
    logicalPath: PosixRelativePath;
    observedReadEntryIds: string[];
}

export interface ImportSourceMetadataOriginSnapshotV1 {
    metadataSubject: "display_name" | "display_description" | "type_data";
    observedReadEntryId: string;
}

export type ImportSourceEvidenceSnapshotV1 =
    | {
          evidenceOrigin: "observed_read";
          observedReadEntryId: string;
          kind: "path" | "document" | "database" | "frontmatter" | "import" | "summary" | "other";
          value: string;
          evidenceLevel: SourceEvidenceLevel;
      }
    | { evidenceOrigin: "external_attestation"; externalAttestationReceiptId: string };

export interface ImportExternalAttestationSnapshotV1 {
    externalAttestationReceiptId: string;
    verifier: {
        componentId: string;
        componentVersion: number;
        configFingerprint: Sha256Digest;
    };
    subject:
        | {
              subjectKind: "source_root_entry";
              sourceRootId: string;
              relativePath: PosixRelativePath | "";
          }
        | { subjectKind: "agent_runtime"; agentRuntimeId: string };
    subjectFingerprint: Sha256Digest;
    verifierInputFingerprint: Sha256Digest;
    attestedKind: "environment" | "document" | "summary" | "other";
    attestedValue: string;
    evidenceLevel: SourceEvidenceLevel;
    verifierResultFingerprint: Sha256Digest;
    attestationReceiptFingerprint: Sha256Digest;
}

export interface ImportSourceSnapshotV1 {
    schemaVersion: 1;
    adapterId: AdapterId;
    roots: ImportSourceRootSnapshotV1[];
    entries: ImportSourceEntrySnapshotV1[];
    fileOrigins: ImportSourceFileOriginSnapshotV1[];
    sourceContainerEntryIds: string[];
    metadataOrigins: ImportSourceMetadataOriginSnapshotV1[];
    evidence: ImportSourceEvidenceSnapshotV1[];
    externalAttestations: ImportExternalAttestationSnapshotV1[];
    snapshotFingerprint: Sha256Digest;
}

export interface ImportProvenanceAuthorityV2 {
    schemaVersion: 2;
    importProvenanceId: string;
    assetId: UuidV4;
    versionId: UuidV4;
    previewSnapshotFingerprint: Sha256Digest;
    candidateFingerprint: Sha256Digest;
    acceptedFreshness: "current_source_verified" | "user_approved_preview_snapshot";
    acceptedPromotion: AcceptedImportPromotionDispositionV1;
    promotionSafety: SourcePromotionSafety;
    importedAt: EpochMillis;
    sourceSnapshot: ImportSourceSnapshotV1;
    authorityFingerprint: Sha256Digest;
}

export type ImportProvenanceAuthority = ImportProvenanceAuthorityV1 | ImportProvenanceAuthorityV2;

export type VersionPromotionRequirement = "not_required" | "requires_current_authorization";
export type CopiedSourcePromotionSafety = SourcePromotionSafety | "not_applicable";

export type VersionOriginAuthorityV1 =
    | {
          schemaVersion: 1;
          assetId: UuidV4;
          versionId: UuidV4;
          originKind: "import";
          importProvenanceId: string;
          importProvenanceAuthorityFingerprint: Sha256Digest;
          promotionRequirement: "requires_current_authorization";
          createdAt: EpochMillis;
          authorityFingerprint: Sha256Digest;
      }
    | {
          schemaVersion: 1;
          assetId: UuidV4;
          versionId: UuidV4;
          originKind: "user_created";
          userActionEvidenceId: string;
          promotionRequirement: "not_required";
          createdAt: EpochMillis;
          authorityFingerprint: Sha256Digest;
      }
    | {
          schemaVersion: 1;
          assetId: UuidV4;
          versionId: UuidV4;
          originKind: "asset_copy";
          sourceAssetId: UuidV4;
          sourceVersionId: UuidV4;
          sourceVersionFingerprint: Sha256Digest;
          sourceVersionOriginAuthorityFingerprint: Sha256Digest;
          sourcePromotionSafety: CopiedSourcePromotionSafety;
          userActionEvidenceId: string;
          promotionRequirement: VersionPromotionRequirement;
          createdAt: EpochMillis;
          authorityFingerprint: Sha256Digest;
      }
    | {
          schemaVersion: 1;
          assetId: UuidV4;
          versionId: UuidV4;
          originKind: "reverse_accept";
          previousVersionId: UuidV4;
          previousVersionOriginAuthorityFingerprint: Sha256Digest;
          reversePreparationIdentityFingerprint: Sha256Digest;
          userActionEvidenceId: string;
          promotionRequirement: VersionPromotionRequirement;
          createdAt: EpochMillis;
          authorityFingerprint: Sha256Digest;
      };

export type PersistedVersionSourceAuthorityV1 =
    | {
          originAuthority: Extract<VersionOriginAuthorityV1, { originKind: "import" }>;
          importProvenanceAuthority: ImportProvenanceAuthority;
      }
    | {
          originAuthority: Exclude<VersionOriginAuthorityV1, { originKind: "import" }>;
      };

export interface PersistedVersionAuthorityFieldsV1 {
    versionCanonicalContentFingerprint: Sha256Digest;
    portableDialectContracts: VersionPortableDialectContractRefV1[];
    nativeRepresentations: VersionNativeRepresentation[];
    dialectRestorationPayloads: VersionDialectRestorationPayloadRefV1[];
}

export type PromotionGrantSubject =
    | { subjectKind: "asset_version"; assetId: UuidV4; versionId: UuidV4 }
    | {
          subjectKind: "asset_all_versions";
          assetId: UuidV4;
          activationVersionId: UuidV4;
      };

export type PromotionGrantTarget =
    | { targetKind: "project"; projectId: UuidV4 }
    | {
          targetKind: "global_target";
          targetAuthorityFingerprint: Sha256Digest;
      };

export interface PromotionGrantV1 {
    schemaVersion: 1;
    promotionGrantId: UuidV4;
    subject: PromotionGrantSubject;
    target: PromotionGrantTarget;
    grantState: "active" | "revoked";
    revision: number;
    userActionEvidenceId: string;
    updatedAt: EpochMillis;
    grantFingerprint: Sha256Digest;
}

export type RestrictedSourcePromotionFullAccessSettingV1 =
    | {
          configVersion: 1;
          settingId: "restricted_source_promotion_full_access_v1";
          state: "disabled";
          revision: number;
          updatedAt: EpochMillis;
          settingFingerprint: Sha256Digest;
      }
    | {
          configVersion: 1;
          settingId: "restricted_source_promotion_full_access_v1";
          state: "enabled";
          revision: number;
          userActionEvidenceId: string;
          enabledAt: EpochMillis;
          settingFingerprint: Sha256Digest;
      };
