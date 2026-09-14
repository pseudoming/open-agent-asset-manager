import type { AssetVersionManifestV2 } from "../contracts/asset-version";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type { VersionOriginAuthorityV1 } from "../contracts/persistence";
import type { ImportProvenanceAuthority, ImportSourceSnapshotV1 } from "../contracts/persistence";
import type { Diagnostic } from "../contracts/common";
import type { StrictSchema } from "../foundation/strict-schema";
import {
    schemaArrayWithUniqueKey as array,
    schemaLiteral as literal,
    schemaObject as object,
    schemaStringEnum as oneOf,
    schemaUnion as union,
    validateStrict,
} from "../foundation/strict-schema";
import {
    computeImportProvenanceAuthorityFingerprint,
    computeImportSourceSnapshotFingerprint,
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
    computeVersionOriginAuthorityFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { canonicalMediaType } from "./payload-store";
import { isAssetKindTypeDataV2 } from "../specs/validators";
import { isPosixRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import { isCompleteNativeDirectoryGraph } from "../foundation/native-directory-graph";

export interface VersionValidationResult {
    ok: boolean;
    diagnostics: Diagnostic[];
}

const text: StrictSchema = { kind: "string" };
const nonBlank: StrictSchema = { kind: "string", nonBlank: true };
const bool: StrictSchema = { kind: "boolean" };
const epoch: StrictSchema = { kind: "number", integer: true, min: 0 };
const positiveInteger: StrictSchema = { kind: "number", integer: true, min: 1 };
const uuid: StrictSchema = { kind: "custom", check: isUuidV4 };
const sha: StrictSchema = { kind: "custom", check: isSha256Digest };
const posixPath: StrictSchema = { kind: "custom", check: isPosixRelativePath };
const posixPathOrEmpty: StrictSchema = { kind: "custom", check: (value) => value === "" || isPosixRelativePath(value) };
const sourceVersion: StrictSchema = {
    kind: "custom",
    check: (value) => value === "" || isUuidV4(value),
};

const diagnostic = object({
    severity: oneOf("info", "warning", "error"),
    code: nonBlank,
    message: text,
    path: text,
    traceId: text,
});
const diagnostics = array(diagnostic);

const referenceBase = {
    kind: oneOf("include", "link", "execute"),
    rawTarget: text,
    required: bool,
    diagnostics,
};
const fileReference = union(
    object({
        ...referenceBase,
        resolution: literal("resolved_version_file"),
        targetLogicalPath: posixPath,
    }),
    object({
        ...referenceBase,
        resolution: literal("resolved_asset_version"),
        targetAssetVersionId: uuid,
    }),
    object({
        ...referenceBase,
        resolution: oneOf("unresolved", "external", "forbidden"),
    }),
);

const versionFile = object({
    fileId: uuid,
    logicalPath: posixPath,
    role: oneOf("entry", "resource", "dependency"),
    contentHash: sha,
    contentKind: oneOf("text", "binary"),
    mediaType: { kind: "custom", check: (value) => typeof value === "string" && canonicalMediaType(value) === value },
    byteSize: { kind: "number", integer: true, min: 0 },
    executable: bool,
    references: array(fileReference),
});

const nativeFile = object({
    relativePath: posixPath,
    contentKind: oneOf("text", "binary"),
    mediaType: { kind: "custom", check: (value) => typeof value === "string" && canonicalMediaType(value) === value },
    contentHash: sha,
    byteSize: { kind: "number", integer: true, min: 0 },
    executable: bool,
});
const nativeRepresentationV1 = object({
    schemaVersion: literal(1),
    dialectId: nonBlank,
    dialectContractFingerprint: sha,
    canonicalContentFingerprint: sha,
    files: array(nativeFile, (value) => (value as { relativePath: string }).relativePath),
    representationFingerprint: sha,
});
const nativeRepresentationV2 = object({
    schemaVersion: literal(2),
    dialectId: nonBlank,
    dialectContractFingerprint: sha,
    canonicalContentFingerprint: sha,
    directories: array(posixPath, (value) => value as string),
    files: array(nativeFile, (value) => (value as { relativePath: string }).relativePath),
    representationFingerprint: sha,
});
const nativeRepresentation = union(nativeRepresentationV1, nativeRepresentationV2);
const restorationPayload = object({
    dialectId: nonBlank,
    restorationContractFingerprint: sha,
    contentHash: sha,
});
const portableDialectContract = object({
    field: oneOf(
        "workflow_instruction",
        "workflow_executable",
        "skill_entry",
        "subagent_initial_prompt",
        "workflow_tool",
        "workflow_model",
        "workflow_effort",
        "workflow_shell",
        "skill_tool",
        "skill_agent",
        "skill_model",
        "skill_effort",
        "subagent_context",
        "subagent_tool",
        "subagent_permission",
        "subagent_model",
        "subagent_effort",
        "subagent_turn_limit",
        "subagent_color",
    ),
    dialectId: nonBlank,
    dialectContractFingerprint: sha,
});

const acceptedPromotion = union(
    object({ promotionAction: literal("import_only"), userActionEvidenceId: nonBlank }),
    object({
        promotionAction: literal("grant_current_version_current_target"),
        promotionGrantId: uuid,
        userActionEvidenceId: nonBlank,
    }),
    object({
        promotionAction: literal("grant_asset_all_versions_current_target"),
        promotionGrantId: uuid,
        userActionEvidenceId: nonBlank,
    }),
);
const importProvenanceV1 = object({
    schemaVersion: literal(1),
    importProvenanceId: nonBlank,
    assetId: uuid,
    versionId: uuid,
    previewSnapshotFingerprint: sha,
    candidateFingerprint: sha,
    acceptedFreshness: oneOf("current_source_verified", "user_approved_preview_snapshot"),
    acceptedPromotion,
    promotionSafety: oneOf("default_promotable", "requires_user_confirmation"),
    importedAt: epoch,
    authorityFingerprint: sha,
});

const evidenceLevel = oneOf(
    "agent_runtime_verified",
    "local_artifact",
    "source_code",
    "docs_declared",
    "user_provided",
    "agent_answer",
);
const sourceLocatorEvidence = object({
    locatorKind: oneOf("runtime_known_rule", "runtime_declared_path", "project_registry_entry", "user_provided_path", "unknown"),
    locatorKey: text,
    evidenceLevel,
});
const importSourceRoot = object({
    sourceRootId: nonBlank,
    rootRole: oneOf("config", "source", "project_actual", "unknown"),
    sourceDomain: oneOf("family_shared", "agent_runtime_private", "project_root", "project_keyed", "external_managed", "unknown"),
    path: nonBlank,
    locatorEvidence: array(sourceLocatorEvidence),
});
const importSourceEntry = union(
    object({
        observedReadEntryId: nonBlank,
        sourceRootId: nonBlank,
        relativePath: posixPathOrEmpty,
        entryKind: literal("file"),
        contentHash: sha,
        executable: bool,
        physicalIdentityFingerprint: sha,
    }),
    object({
        observedReadEntryId: nonBlank,
        sourceRootId: nonBlank,
        relativePath: posixPathOrEmpty,
        entryKind: literal("directory"),
        physicalIdentityFingerprint: sha,
        directoryInventoryFingerprint: sha,
    }),
);
const importSourceFileOrigin = object({
    logicalPath: posixPath,
    observedReadEntryIds: array(nonBlank, (value) => value as string),
});
const importSourceMetadataOrigin = object({
    metadataSubject: oneOf("display_name", "display_description", "type_data"),
    observedReadEntryId: nonBlank,
});
const importSourceEvidence = union(
    object({
        evidenceOrigin: literal("observed_read"),
        observedReadEntryId: nonBlank,
        kind: oneOf("path", "document", "database", "frontmatter", "import", "summary", "other"),
        value: text,
        evidenceLevel,
    }),
    object({
        evidenceOrigin: literal("external_attestation"),
        externalAttestationReceiptId: nonBlank,
    }),
);
const importAttestationSubject = union(
    object({
        subjectKind: literal("source_root_entry"),
        sourceRootId: nonBlank,
        relativePath: posixPathOrEmpty,
    }),
    object({
        subjectKind: literal("agent_runtime"),
        agentRuntimeId: nonBlank,
    }),
);
const importExternalAttestation = object({
    externalAttestationReceiptId: nonBlank,
    verifier: object({
        componentId: nonBlank,
        componentVersion: positiveInteger,
        configFingerprint: sha,
    }),
    subject: importAttestationSubject,
    subjectFingerprint: sha,
    verifierInputFingerprint: sha,
    attestedKind: oneOf("environment", "document", "summary", "other"),
    attestedValue: text,
    evidenceLevel,
    verifierResultFingerprint: sha,
    attestationReceiptFingerprint: sha,
});
const importSourceSnapshot = object({
    schemaVersion: literal(1),
    adapterId: nonBlank,
    roots: array(importSourceRoot, (value) => (value as { sourceRootId: string }).sourceRootId),
    entries: array(importSourceEntry, (value) => (value as { observedReadEntryId: string }).observedReadEntryId),
    fileOrigins: array(importSourceFileOrigin, (value) => (value as { logicalPath: string }).logicalPath),
    sourceContainerEntryIds: array(nonBlank, (value) => value as string),
    metadataOrigins: array(importSourceMetadataOrigin, (value) => {
        const origin = value as { metadataSubject: string; observedReadEntryId: string };
        return `${origin.metadataSubject}\0${origin.observedReadEntryId}`;
    }),
    evidence: array(importSourceEvidence, (value) => {
        const evidence = value as
            | { evidenceOrigin: "observed_read"; observedReadEntryId: string; kind: string; value: string; evidenceLevel: string }
            | { evidenceOrigin: "external_attestation"; externalAttestationReceiptId: string };
        return evidence.evidenceOrigin === "observed_read"
            ? `observed\0${evidence.observedReadEntryId}\0${evidence.kind}\0${evidence.value}\0${evidence.evidenceLevel}`
            : `external\0${evidence.externalAttestationReceiptId}`;
    }),
    externalAttestations: array(
        importExternalAttestation,
        (value) => (value as { externalAttestationReceiptId: string }).externalAttestationReceiptId,
    ),
    snapshotFingerprint: sha,
});
const importProvenanceV2 = object({
    schemaVersion: literal(2),
    importProvenanceId: nonBlank,
    assetId: uuid,
    versionId: uuid,
    previewSnapshotFingerprint: sha,
    candidateFingerprint: sha,
    acceptedFreshness: oneOf("current_source_verified", "user_approved_preview_snapshot"),
    acceptedPromotion,
    promotionSafety: oneOf("default_promotable", "requires_user_confirmation"),
    importedAt: epoch,
    sourceSnapshot: importSourceSnapshot,
    authorityFingerprint: sha,
});

const importOrigin = object({
    schemaVersion: literal(1),
    assetId: uuid,
    versionId: uuid,
    originKind: literal("import"),
    importProvenanceId: nonBlank,
    importProvenanceAuthorityFingerprint: sha,
    promotionRequirement: literal("requires_current_authorization"),
    createdAt: epoch,
    authorityFingerprint: sha,
});
const userOrigin = object({
    schemaVersion: literal(1),
    assetId: uuid,
    versionId: uuid,
    originKind: literal("user_created"),
    userActionEvidenceId: nonBlank,
    promotionRequirement: literal("not_required"),
    createdAt: epoch,
    authorityFingerprint: sha,
});
const assetCopyOrigin = object({
    schemaVersion: literal(1),
    assetId: uuid,
    versionId: uuid,
    originKind: literal("asset_copy"),
    sourceAssetId: uuid,
    sourceVersionId: uuid,
    sourceVersionFingerprint: sha,
    sourceVersionOriginAuthorityFingerprint: sha,
    sourcePromotionSafety: oneOf("default_promotable", "requires_user_confirmation", "not_applicable"),
    userActionEvidenceId: nonBlank,
    promotionRequirement: oneOf("not_required", "requires_current_authorization"),
    createdAt: epoch,
    authorityFingerprint: sha,
});
const reverseOrigin = object({
    schemaVersion: literal(1),
    assetId: uuid,
    versionId: uuid,
    originKind: literal("reverse_accept"),
    previousVersionId: uuid,
    previousVersionOriginAuthorityFingerprint: sha,
    reversePreparationIdentityFingerprint: sha,
    userActionEvidenceId: nonBlank,
    promotionRequirement: oneOf("not_required", "requires_current_authorization"),
    createdAt: epoch,
    authorityFingerprint: sha,
});

const manifestBase = {
    schemaVersion: literal(2),
    versionId: uuid,
    assetId: uuid,
    revision: positiveInteger,
    fingerprint: sha,
    status: oneOf("complete", "incomplete"),
    diagnostics,
    kind: oneOf("Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"),
    typeData: { kind: "custom", check: () => true } as StrictSchema,
    files: array(versionFile, (value) => (value as { logicalPath: string }).logicalPath),
    changeKind: oneOf("create", "extract", "edit", "sync", "rollback", "merge"),
    sourceVersionId: sourceVersion,
    sourceDeploymentId: sourceVersion,
    changeNote: text,
    createdAt: epoch,
    versionCanonicalContentFingerprint: sha,
    portableDialectContracts: array(portableDialectContract, (value) => {
        const contract = value as { field: string; dialectId: string };
        return `${contract.field}\0${contract.dialectId}`;
    }),
    nativeRepresentations: array(nativeRepresentation, (value) => (value as { dialectId: string }).dialectId),
    dialectRestorationPayloads: array(restorationPayload, (value) => (value as { dialectId: string }).dialectId),
};

const manifestSchema = union(
    object({
        ...manifestBase,
        originAuthority: importOrigin,
        importProvenanceAuthority: union(importProvenanceV1, importProvenanceV2),
    }),
    object({ ...manifestBase, originAuthority: union(userOrigin, assetCopyOrigin, reverseOrigin) }),
);

function errorDiagnostic(code: string, message: string): Diagnostic {
    return { severity: "error", code, message, path: "", traceId: "" };
}

export function validateVersionManifest(manifest: unknown): VersionValidationResult {
    if (!validateStrict(manifestSchema, manifest)) {
        return {
            ok: false,
            diagnostics: [errorDiagnostic("version.strict", "version manifest violates the strict V2 schema")],
        };
    }
    const value = manifest as AssetVersionManifestV2;
    const diagnostics: Diagnostic[] = [];
    const reject = (code: string, message: string) => diagnostics.push(errorDiagnostic(code, message));

    const canonical = { kind: value.kind, typeData: value.typeData };
    if (!isAssetKindTypeDataV2(canonical)) {
        reject("version.type_data", "kind and typeData are not a valid canonical pair");
    }
    if (value.changeKind === "create" ? value.sourceVersionId !== "" : value.sourceVersionId === "") {
        reject("version.lineage", "create requires no parent and every later Version requires an exact parent");
    }
    if (!isStrictlySorted(value.files, (file) => file.logicalPath)) {
        reject("version.file_order", "files must be strictly sorted by logicalPath");
    }
    for (const file of value.files) {
        const paths = new Set(value.files.map((candidate) => candidate.logicalPath));
        for (const reference of file.references) {
            if (reference.resolution === "resolved_version_file" && !paths.has(reference.targetLogicalPath)) {
                reject("version.reference", `missing target file: ${reference.targetLogicalPath}`);
            }
        }
    }

    const canonicalFingerprint = computeVersionCanonicalContentFingerprint(canonical as AssetKindTypeDataV2, value.files);
    if (canonicalFingerprint !== value.versionCanonicalContentFingerprint) {
        reject("version.canonical_fingerprint", "version canonical content fingerprint mismatch");
    }
    if (!isStrictlySorted(value.portableDialectContracts, (item) => `${item.field}\0${item.dialectId}`)) {
        reject("version.portable_dialect_order", "portable dialect contracts must be sorted uniquely by field and dialectId");
    }
    if (!isStrictlySorted(value.nativeRepresentations, (item) => item.dialectId)) {
        reject("version.native_order", "native representations must be sorted uniquely by dialectId");
    }
    for (const representation of value.nativeRepresentations) {
        if (representation.canonicalContentFingerprint !== canonicalFingerprint) {
            reject("version.native_binding", `native representation ${representation.dialectId} binds another canonical Version`);
        }
        if (!isStrictlySorted(representation.files, (file) => file.relativePath)) {
            reject("version.native_file_order", `native files for ${representation.dialectId} must be sorted uniquely`);
        }
        if (
            representation.schemaVersion === 2 &&
            (!isStrictlySorted(representation.directories, (directory) => directory) ||
                !isCompleteNativeDirectoryGraph(
                    representation.directories,
                    representation.files.map((file) => file.relativePath),
                ))
        ) {
            reject(
                "version.native_directory_graph",
                `native directories for ${representation.dialectId} must be a complete sorted graph without file collisions`,
            );
        }
        const { representationFingerprint: _stored, ...preimage } = representation;
        if (computeVersionNativeRepresentationFingerprint(preimage) !== representation.representationFingerprint) {
            reject("version.native_fingerprint", `native representation fingerprint mismatch: ${representation.dialectId}`);
        }
    }
    if (!isStrictlySorted(value.dialectRestorationPayloads, (item) => item.dialectId)) {
        reject("version.restoration_order", "restoration payloads must be sorted uniquely by dialectId");
    }
    if (
        computeVersionFingerprint(
            value.versionCanonicalContentFingerprint,
            value.nativeRepresentations,
            value.dialectRestorationPayloads,
            value.portableDialectContracts,
        ) !== value.fingerprint
    ) {
        reject("version.fingerprint", "final Version fingerprint mismatch");
    }
    validateSourceAuthority(value, reject);
    return { ok: diagnostics.length === 0, diagnostics };
}

function validateSourceAuthority(manifest: AssetVersionManifestV2, reject: (code: string, message: string) => void): void {
    const origin = manifest.originAuthority;
    if (origin.assetId !== manifest.assetId || origin.versionId !== manifest.versionId) {
        reject("version.origin_identity", "origin authority must match the enclosing Asset and Version");
    }
    if (
        origin.originKind === "asset_copy" &&
        ((origin.promotionRequirement === "not_required" && origin.sourcePromotionSafety !== "not_applicable") ||
            (origin.promotionRequirement === "requires_current_authorization" &&
                origin.sourcePromotionSafety === "not_applicable") ||
            origin.sourceVersionFingerprint !== manifest.fingerprint)
    ) {
        reject("version.copy_origin", "Asset-copy origin does not preserve the exact source promotion/content classification");
    }
    const { authorityFingerprint: _storedOrigin, ...originPreimage } = origin;
    if (
        computeVersionOriginAuthorityFingerprint(originPreimage as Omit<VersionOriginAuthorityV1, "authorityFingerprint">) !==
        origin.authorityFingerprint
    ) {
        reject("version.origin_fingerprint", "origin authority fingerprint mismatch");
    }
    if (origin.originKind !== "import") return;

    const provenance = (
        manifest as AssetVersionManifestV2 & {
            importProvenanceAuthority: ImportProvenanceAuthority;
        }
    ).importProvenanceAuthority;
    if (provenance.assetId !== manifest.assetId || provenance.versionId !== manifest.versionId) {
        reject("version.provenance_identity", "import provenance must match the enclosing Asset and Version");
    }
    const { authorityFingerprint: _storedProvenance, ...provenancePreimage } = provenance;
    if (computeImportProvenanceAuthorityFingerprint(provenancePreimage) !== provenance.authorityFingerprint) {
        reject("version.provenance_fingerprint", "import provenance fingerprint mismatch");
    }
    if (provenance.schemaVersion === 2) {
        validateImportSourceSnapshot(provenance.sourceSnapshot, reject);
    }
    if (
        origin.importProvenanceId !== provenance.importProvenanceId ||
        origin.importProvenanceAuthorityFingerprint !== provenance.authorityFingerprint
    ) {
        reject("version.provenance_binding", "import origin does not bind the exact provenance authority");
    }
}

function validateImportSourceSnapshot(snapshot: ImportSourceSnapshotV1, reject: (code: string, message: string) => void): void {
    const { snapshotFingerprint: _storedSnapshot, ...snapshotPreimage } = snapshot;
    if (computeImportSourceSnapshotFingerprint(snapshotPreimage) !== snapshot.snapshotFingerprint) {
        reject("version.source_snapshot_fingerprint", "import source snapshot fingerprint mismatch");
    }
    const rootIds = new Set(snapshot.roots.map((root) => root.sourceRootId));
    const entryIds = new Set(snapshot.entries.map((entry) => entry.observedReadEntryId));
    const receiptIds = new Set(snapshot.externalAttestations.map((receipt) => receipt.externalAttestationReceiptId));
    for (const entry of snapshot.entries) {
        if (!rootIds.has(entry.sourceRootId)) {
            reject("version.source_snapshot_root", `source snapshot entry references a missing root: ${entry.sourceRootId}`);
        }
    }
    for (const origin of snapshot.fileOrigins) {
        for (const entryId of origin.observedReadEntryIds) {
            if (!entryIds.has(entryId)) {
                reject("version.source_snapshot_entry", `file origin references a missing entry: ${entryId}`);
            }
        }
    }
    for (const entryId of snapshot.sourceContainerEntryIds) {
        if (!entryIds.has(entryId)) {
            reject("version.source_snapshot_entry", `source container references a missing entry: ${entryId}`);
        }
    }
    for (const origin of snapshot.metadataOrigins) {
        if (!entryIds.has(origin.observedReadEntryId)) {
            reject("version.source_snapshot_entry", `metadata origin references a missing entry: ${origin.observedReadEntryId}`);
        }
    }
    for (const evidence of snapshot.evidence) {
        if (evidence.evidenceOrigin === "observed_read" && !entryIds.has(evidence.observedReadEntryId)) {
            reject(
                "version.source_snapshot_entry",
                `source evidence references a missing entry: ${evidence.observedReadEntryId}`,
            );
        }
        if (evidence.evidenceOrigin === "external_attestation" && !receiptIds.has(evidence.externalAttestationReceiptId)) {
            reject(
                "version.source_snapshot_attestation",
                `source evidence references a missing attestation: ${evidence.externalAttestationReceiptId}`,
            );
        }
    }
    for (const receipt of snapshot.externalAttestations) {
        if (receipt.subject.subjectKind === "source_root_entry" && !rootIds.has(receipt.subject.sourceRootId)) {
            reject(
                "version.source_snapshot_root",
                `external attestation references a missing root: ${receipt.subject.sourceRootId}`,
            );
        }
    }
}

function isStrictlySorted<T>(values: readonly T[], key: (value: T) => string): boolean {
    return values.every((value, index) => index === 0 || key(values[index - 1]) < key(value));
}

export function serializeVersionManifest(manifest: AssetVersionManifestV2): string {
    const validation = validateVersionManifest(manifest);
    if (!validation.ok) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
    return `${JSON.stringify(JSON.parse(stableStringify(manifest)), null, 2)}\n`;
}

export function parseVersionManifest(json: string): AssetVersionManifestV2 {
    const parsed: unknown = JSON.parse(json);
    const validation = validateVersionManifest(parsed);
    if (!validation.ok) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
    return parsed as AssetVersionManifestV2;
}
