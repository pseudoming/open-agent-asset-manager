/** Catalog, import, dialect, and promotion fingerprint families. */
import type { AssetVersionFileV2 } from "../contracts/asset-version";
import type { PortableAssetVersionArchiveIndexV1 } from "../contracts/asset-version-archive";
import type {
    AdapterEnablementSettingV1,
    WatchedEnvironmentSelectorV1,
    WatchedScanIntentV1,
    WatchedSourceSelectorV1,
} from "../contracts/core-service";
import type {
    NativeDialectContractDefinitionV1,
    PortableEntryDialectContractDefinitionV1,
    PortableSelectorDialectContractDefinitionV1,
    RestorationDialectContractDefinitionV1,
} from "../contracts/dialect";
import type {
    ImportProvenanceAuthorityV1,
    ImportProvenanceAuthorityV2,
    ImportSourceSnapshotV1,
    PromotionGrantV1,
    RestrictedSourcePromotionFullAccessSettingV1,
    VersionDialectRestorationPayloadRefV1,
    VersionNativeRepresentation,
    VersionNativeRepresentationV1,
    VersionNativeRepresentationV2,
    VersionOriginAuthorityV1,
    VersionPortableDialectContractRefV1,
} from "../contracts/persistence";
import type { Sha256Digest } from "../contracts/primitives";
import type { AdapterReadResult, ExtractedAssetCandidate, ImportPreviewItem } from "../contracts/source-import";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import { compareCodeUnitText, fingerprintDomain } from "./fingerprint-base";

const VERSION_CANONICAL_DOMAIN = "oaam.asset.version-canonical-content.v1";
const VERSION_NATIVE_DOMAIN = "oaam.asset.version-native-representation.v1";
const VERSION_NATIVE_V2_DOMAIN = "oaam.asset.version-native-representation.v2";
const NATIVE_DIALECT_CONTRACT_DOMAIN = "oaam.asset.native-representation-dialect-contract.v1";
const RESTORATION_DIALECT_CONTRACT_DOMAIN = "oaam.asset.dialect-restoration-contract.v1";
const PORTABLE_ENTRY_DIALECT_CONTRACT_DOMAIN = "oaam.asset.portable-entry-dialect-contract.v1";
const PORTABLE_SELECTOR_DIALECT_CONTRACT_DOMAIN = "oaam.asset.portable-selector-dialect-contract.v1";
const VERSION_FINAL_DOMAIN = "oaam.asset.version.v2";
const IMPORT_PROVENANCE_DOMAIN = "oaam.import.provenance-authority.v1";
const IMPORT_SOURCE_SNAPSHOT_DOMAIN = "oaam.import.source-snapshot.v1";
const IMPORT_CANDIDATE_DOMAIN = "oaam.import.candidate.v1";
const IMPORT_PREVIEW_SNAPSHOT_DOMAIN = "oaam.import.preview-snapshot.v1";
const VERSION_ORIGIN_DOMAIN = "oaam.version.origin-authority.v1";
const PROMOTION_GRANT_DOMAIN = "oaam.promotion.grant.v1";
const RESTRICTED_SOURCE_FULL_ACCESS_DOMAIN = "oaam.promotion.full-access-setting.v1";
const ADAPTER_ENABLEMENT_SETTING_DOMAIN = "oaam.settings.adapter-enablement.v1";
const WATCHED_SCAN_INTENT_SETTING_DOMAIN = "oaam.settings.watched-scan-intent.v1";
const WATCHED_SOURCE_SELECTOR_DOMAIN = "oaam.settings.watched-source-selector.v1";
const PORTABLE_ASSET_VERSION_ARCHIVE_INDEX_DOMAIN = "oaam.asset.version-archive-index.v1";

export function computeNativeDialectContractFingerprint(definition: NativeDialectContractDefinitionV1): Sha256Digest {
    return fingerprintDomain(NATIVE_DIALECT_CONTRACT_DOMAIN, {
        dialectId: definition.dialectId,
        kind: definition.kind,
        nativeFileGraphSchema: definition.nativeFileGraphSchema,
        contentNormalization: definition.contentNormalization,
        nativeToCanonicalParser: definition.nativeToCanonicalParser,
        canonicalConsistencyValidator: definition.canonicalConsistencyValidator,
        rebaseMaterializer: definition.rebaseMaterializer,
        targetApplicabilityPredicate: definition.targetApplicabilityPredicate,
    });
}

export function computeRestorationDialectContractFingerprint(definition: RestorationDialectContractDefinitionV1): Sha256Digest {
    return fingerprintDomain(RESTORATION_DIALECT_CONTRACT_DOMAIN, {
        dialectId: definition.dialectId,
        kind: definition.kind,
        payloadCodecValidator: definition.payloadCodecValidator,
        transitionValidator: definition.transitionValidator,
    });
}

export function computePortableEntryDialectContractFingerprint(
    definition: PortableEntryDialectContractDefinitionV1,
): Sha256Digest {
    return fingerprintDomain(PORTABLE_ENTRY_DIALECT_CONTRACT_DOMAIN, {
        kind: definition.kind,
        field: definition.field,
        dialectId: definition.dialectId,
        applicableAgentRuntimeIds: definition.applicableAgentRuntimeIds,
        canonicalEntryValidator: definition.canonicalEntryValidator,
        sourceApplicabilityValidator: definition.sourceApplicabilityValidator,
    });
}

export function computePortableSelectorDialectContractFingerprint(
    definition: PortableSelectorDialectContractDefinitionV1,
): Sha256Digest {
    return fingerprintDomain(PORTABLE_SELECTOR_DIALECT_CONTRACT_DOMAIN, {
        kind: definition.kind,
        field: definition.field,
        dialectId: definition.dialectId,
        applicableAgentRuntimeIds: definition.applicableAgentRuntimeIds,
        selectorSemanticsValidator: definition.selectorSemanticsValidator,
        sourceApplicabilityValidator: definition.sourceApplicabilityValidator,
    });
}

export function computeVersionCanonicalContentFingerprint(
    canonical: AssetKindTypeDataV2,
    files: readonly AssetVersionFileV2[],
): Sha256Digest {
    return fingerprintDomain(VERSION_CANONICAL_DOMAIN, {
        kind: canonical.kind,
        typeData: canonical.typeData,
        files: [...files].sort(compareLogicalPath).map((file) => ({
            logicalPath: file.logicalPath,
            role: file.role,
            contentHash: file.contentHash,
            contentKind: file.contentKind,
            mediaType: file.mediaType,
            byteSize: file.byteSize,
            executable: file.executable,
            references: file.references.map((reference) => {
                const base = {
                    kind: reference.kind,
                    rawTarget: reference.rawTarget,
                    required: reference.required,
                    resolution: reference.resolution,
                };
                if (reference.resolution === "resolved_version_file") {
                    return { ...base, targetLogicalPath: reference.targetLogicalPath };
                }
                if (reference.resolution === "resolved_asset_version") {
                    return { ...base, targetAssetVersionId: reference.targetAssetVersionId };
                }
                return base;
            }),
        })),
    });
}

export function computeVersionNativeRepresentationFingerprint(
    representation:
        | Omit<VersionNativeRepresentationV1, "representationFingerprint">
        | Omit<VersionNativeRepresentationV2, "representationFingerprint">,
): Sha256Digest {
    const common = {
        schemaVersion: representation.schemaVersion,
        dialectId: representation.dialectId,
        dialectContractFingerprint: representation.dialectContractFingerprint,
        versionCanonicalContentFingerprint: representation.canonicalContentFingerprint,
        files: [...representation.files].sort(compareRelativePath),
    };
    return representation.schemaVersion === 1
        ? fingerprintDomain(VERSION_NATIVE_DOMAIN, common)
        : fingerprintDomain(VERSION_NATIVE_V2_DOMAIN, {
              ...common,
              directories: [...representation.directories].sort(compareCodeUnitText),
          });
}

export function computeImportProvenanceAuthorityFingerprint(
    authority:
        | Omit<ImportProvenanceAuthorityV1, "authorityFingerprint">
        | Omit<ImportProvenanceAuthorityV2, "authorityFingerprint">,
): Sha256Digest {
    return fingerprintDomain(IMPORT_PROVENANCE_DOMAIN, authority);
}

export function computeImportSourceSnapshotFingerprint(
    snapshot: Omit<ImportSourceSnapshotV1, "snapshotFingerprint">,
): Sha256Digest {
    return fingerprintDomain(IMPORT_SOURCE_SNAPSHOT_DOMAIN, snapshot);
}

export function computePortableAssetVersionArchiveIndexFingerprint(
    index: Omit<PortableAssetVersionArchiveIndexV1, "indexFingerprint">,
): Sha256Digest {
    return fingerprintDomain(PORTABLE_ASSET_VERSION_ARCHIVE_INDEX_DOMAIN, index);
}

/** Bind the complete, strict operation-local candidate including its source closure. */
export function computeImportCandidateFingerprint(candidate: ExtractedAssetCandidate): Sha256Digest {
    return fingerprintDomain(IMPORT_CANDIDATE_DOMAIN, candidate);
}

/**
 * Bind the complete preview material. Callers must already have validated each
 * AdapterReadResult closure; this function supplies the owner-defined outer
 * ordering so array arrival order cannot create a second preview identity.
 */
export function computeImportPreviewSnapshotFingerprint(input: {
    schemaVersion: 1;
    previewedAt: number;
    readResults: readonly AdapterReadResult[];
    items: readonly ImportPreviewItem[];
}): Sha256Digest {
    return fingerprintDomain(IMPORT_PREVIEW_SNAPSHOT_DOMAIN, {
        schemaVersion: input.schemaVersion,
        previewedAt: input.previewedAt,
        readResults: [...input.readResults].sort((left, right) =>
            compareCodeUnitText(left.readSnapshotFingerprint, right.readSnapshotFingerprint),
        ),
        items: [...input.items].sort((left, right) => compareCodeUnitText(left.candidateId, right.candidateId)),
    });
}

export function computeVersionOriginAuthorityFingerprint(
    authority: Omit<VersionOriginAuthorityV1, "authorityFingerprint">,
): Sha256Digest {
    return fingerprintDomain(VERSION_ORIGIN_DOMAIN, authority);
}

export function computePromotionGrantFingerprint(grant: Omit<PromotionGrantV1, "grantFingerprint">): Sha256Digest {
    return fingerprintDomain(PROMOTION_GRANT_DOMAIN, grant);
}

export function computeRestrictedSourceFullAccessSettingFingerprint(
    setting: RestrictedSourcePromotionFullAccessSettingV1 extends infer T
        ? T extends { settingFingerprint: Sha256Digest }
            ? Omit<T, "settingFingerprint">
            : never
        : never,
): Sha256Digest {
    return fingerprintDomain(RESTRICTED_SOURCE_FULL_ACCESS_DOMAIN, setting);
}

export function computeAdapterEnablementSettingFingerprint(
    setting: AdapterEnablementSettingV1 extends infer T
        ? T extends { settingFingerprint: Sha256Digest }
            ? Omit<T, "settingFingerprint">
            : never
        : never,
): Sha256Digest {
    return fingerprintDomain(ADAPTER_ENABLEMENT_SETTING_DOMAIN, setting);
}

export function computeWatchedSourceSelectorFingerprint(
    environment: WatchedEnvironmentSelectorV1,
    selector: WatchedSourceSelectorV1 extends infer T
        ? T extends { selectorFingerprint: Sha256Digest }
            ? Omit<T, "selectorFingerprint">
            : never
        : never,
): Sha256Digest {
    return fingerprintDomain(WATCHED_SOURCE_SELECTOR_DOMAIN, { environment, selector });
}

export function computeWatchedScanIntentSettingFingerprint(
    setting: WatchedScanIntentV1 extends infer T
        ? T extends { settingFingerprint: Sha256Digest }
            ? Omit<T, "settingFingerprint">
            : never
        : never,
): Sha256Digest {
    return fingerprintDomain(WATCHED_SCAN_INTENT_SETTING_DOMAIN, setting);
}

export function computeVersionFingerprint(
    versionCanonicalContentFingerprint: Sha256Digest,
    nativeRepresentations: readonly VersionNativeRepresentation[],
    dialectRestorationPayloads: readonly VersionDialectRestorationPayloadRefV1[],
    portableDialectContracts: readonly VersionPortableDialectContractRefV1[],
): Sha256Digest {
    return fingerprintDomain(VERSION_FINAL_DOMAIN, {
        versionCanonicalContentFingerprint,
        nativeRepresentationFingerprints: [...nativeRepresentations]
            .sort(compareDialectId)
            .map((representation) => representation.representationFingerprint),
        dialectRestorationPayloads: [...dialectRestorationPayloads].sort(compareDialectId).map((payload) => ({
            dialectId: payload.dialectId,
            restorationContractFingerprint: payload.restorationContractFingerprint,
            contentHash: payload.contentHash,
        })),
        portableDialectContracts: [...portableDialectContracts]
            .sort((left, right) => compareCodeUnitText(`${left.field}\0${left.dialectId}`, `${right.field}\0${right.dialectId}`))
            .map((contract) => ({
                field: contract.field,
                dialectId: contract.dialectId,
                dialectContractFingerprint: contract.dialectContractFingerprint,
            })),
    });
}

function compareLogicalPath(left: AssetVersionFileV2, right: AssetVersionFileV2): number {
    return compareCodeUnitText(left.logicalPath, right.logicalPath);
}

function compareRelativePath(
    left: VersionNativeRepresentation["files"][number],
    right: VersionNativeRepresentation["files"][number],
): number {
    return compareCodeUnitText(left.relativePath, right.relativePath);
}

function compareDialectId<T extends { dialectId: string }>(left: T, right: T): number {
    return compareCodeUnitText(left.dialectId, right.dialectId);
}
