/** Canonical Version material, callable bindings, and restoration transitions. */

import type { CallableBindingRequestV1, ExtractedAssetCandidate, ResolvedCallableBindingV1 } from "../contracts/source-import";
import type { AssetVersionFileContentV2, AssetVersionManifestV2 } from "../contracts/asset-version";
import type {
    ImportProvenanceAuthority,
    VersionNativeRepresentation,
    VersionNativeRepresentationV1,
    VersionNativeRepresentationV2,
    VersionOriginAuthorityV1,
} from "../contracts/persistence";
import type { AssetKindTypeDataV2, MemoryTypeDataV2, WorkflowTypeDataV2 } from "../contracts/specs";
import type { PortableDialectSourceRuntimeV1 } from "../contracts/dialect";
import type { EpochMillis, UuidV4 } from "../contracts/primitives";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../foundation/fingerprint";
import { binaryPayloadStats, canonicalMediaType, normalizeText, textPayloadStats } from "../catalog/payload-store";
import {
    readVersionAuthority,
    type RestorationPayloadClosureV1,
    type VersionAuthorityClosureV1,
    type VersionDialectRegistryV1,
} from "../catalog/version-authority";
import { isUuidV4 } from "../foundation/validators";
import type { ImportServiceConfiguration, CandidateMaterial } from "./import-service-shared";
import { ImportServiceFailure, compareUtf8Bytes } from "./import-service-shared";
import { requireVersionOwner, requireActiveAsset } from "./import-authority";
import { resolvePortableDialectContractRefs } from "../catalog/portable-dialect-authority";

export function buildCandidateMaterial(
    candidate: ExtractedAssetCandidate,
    bindings: readonly ResolvedCallableBindingV1[],
    parent: VersionAuthorityClosureV1 | null,
    registry: VersionDialectRegistryV1,
    sourceRuntimes: readonly PortableDialectSourceRuntimeV1[],
    ids: { next(label: string): UuidV4 },
): CandidateMaterial {
    const canonical = applyCanonicalBindings(candidate, bindings);
    const bindingBySubject = new Map(bindings.map((binding) => [bindingSubjectKey(binding.subject), binding]));
    const files = [...candidate.files]
        .sort((left, right) => compareUtf8Bytes(left.logicalPath, right.logicalPath))
        .map((input): AssetVersionFileContentV2 => {
            const references = (input.references ?? []).map((reference, index) => {
                const binding = bindingBySubject.get(
                    bindingSubjectKey({
                        subjectKind: "file_reference",
                        logicalPath: input.logicalPath,
                        referenceIndex: index,
                    }),
                );
                return binding === undefined
                    ? structuredClone(reference)
                    : {
                          kind: reference.kind,
                          rawTarget: reference.rawTarget,
                          required: reference.required,
                          diagnostics: structuredClone(reference.diagnostics),
                          resolution: "resolved_asset_version" as const,
                          targetAssetVersionId: binding.targetAssetVersionId,
                      };
            });
            if (input.contentKind === "text") {
                const normalized = normalizeText(input.text);
                const stats = textPayloadStats(input.text);
                return {
                    contentKind: "text",
                    text: normalized.normalized,
                    file: {
                        fileId: ids.next(`fileId:${input.logicalPath}`),
                        logicalPath: input.logicalPath,
                        role: input.role,
                        contentHash: stats.contentHash,
                        contentKind: "text",
                        mediaType: canonicalMediaType(input.mediaType),
                        byteSize: stats.byteSize,
                        executable: input.executable,
                        references,
                    },
                };
            }
            const stats = binaryPayloadStats(input.bytes);
            return {
                contentKind: "binary",
                bytes: new Uint8Array(input.bytes),
                file: {
                    fileId: ids.next(`fileId:${input.logicalPath}`),
                    logicalPath: input.logicalPath,
                    role: input.role,
                    contentHash: stats.contentHash,
                    contentKind: "binary",
                    mediaType: canonicalMediaType(input.mediaType),
                    byteSize: stats.byteSize,
                    executable: input.executable,
                    references,
                },
            };
        });
    const canonicalFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        files.map((item) => item.file),
    );
    const portableDialectContracts = (() => {
        try {
            return resolvePortableDialectContractRefs(canonical, files, candidate.status, registry, sourceRuntimes);
        } catch (error) {
            throw new ImportServiceFailure(
                "import.portable_dialect_contract_rejected",
                error instanceof Error ? error.message : String(error),
                "unsupported",
            );
        }
    })();
    const nativeContract = registry.getNative(candidate.kind, candidate.nativeRepresentation.dialectId);
    if (nativeContract === null) {
        throw new ImportServiceFailure(
            "import.native_contract_missing",
            `native dialect contract is not registered: ${candidate.nativeRepresentation.dialectId}`,
            "unsupported",
        );
    }
    const nativeFiles =
        candidate.nativeRepresentation.representationSource === "canonical_files"
            ? candidate.files.map((file) => ({
                  relativePath: file.logicalPath,
                  contentKind: file.contentKind,
                  mediaType: canonicalMediaType(file.mediaType),
                  bytes: file.contentKind === "text" ? Buffer.from(file.text, "utf-8") : new Uint8Array(file.bytes),
                  executable: file.executable,
              }))
            : candidate.nativeRepresentation.files.map((file) => ({
                  relativePath: file.relativePath,
                  contentKind: file.contentKind,
                  mediaType: canonicalMediaType(file.mediaType),
                  bytes: new Uint8Array(file.bytes),
                  executable: file.executable,
              }));
    nativeFiles.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const nativeDescriptors = nativeFiles.map((file) => {
        const stats = binaryPayloadStats(file.bytes);
        return {
            relativePath: file.relativePath,
            contentKind: file.contentKind,
            mediaType: file.mediaType,
            contentHash: stats.contentHash,
            byteSize: stats.byteSize,
            executable: file.executable,
        };
    });
    const nativePreimage:
        | Omit<VersionNativeRepresentationV1, "representationFingerprint">
        | Omit<VersionNativeRepresentationV2, "representationFingerprint"> =
        candidate.nativeRepresentation.representationSource === "separate_file_graph"
            ? {
                  schemaVersion: 2,
                  dialectId: candidate.nativeRepresentation.dialectId,
                  dialectContractFingerprint: nativeContract.contractFingerprint,
                  canonicalContentFingerprint: canonicalFingerprint,
                  directories: candidate.nativeRepresentation.directories
                      .map((directory) => directory.relativePath)
                      .sort(compareUtf8Bytes),
                  files: nativeDescriptors,
              }
            : {
                  schemaVersion: 1,
                  dialectId: candidate.nativeRepresentation.dialectId,
                  dialectContractFingerprint: nativeContract.contractFingerprint,
                  canonicalContentFingerprint: canonicalFingerprint,
                  files: nativeDescriptors,
              };
    const nativeRepresentations: VersionNativeRepresentation[] = [
        {
            ...nativePreimage,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(nativePreimage),
        } as VersionNativeRepresentation,
    ];
    const nativePayloads = [
        {
            dialectId: candidate.nativeRepresentation.dialectId,
            files: nativeFiles.map((file) => ({
                relativePath: file.relativePath,
                bytes: file.bytes,
            })),
        },
    ];
    const inherited =
        parent === null
            ? []
            : parent.restorationPayloads.map((payload) => ({
                  dialectId: payload.dialectId,
                  bytes: new Uint8Array(payload.bytes),
              }));
    const restorationPayloads = applyRestorationTransition(inherited, candidate, registry);
    const restorationRefs = restorationPayloads.map((payload) => {
        // Replacements are validated by applyRestorationTransition; inherited
        // payloads were validated while reopening the exact parent closure.
        const contract = registry.getRestoration(candidate.kind, payload.dialectId) as NonNullable<
            ReturnType<VersionDialectRegistryV1["getRestoration"]>
        >;
        return {
            dialectId: payload.dialectId,
            restorationContractFingerprint: contract.contractFingerprint,
            contentHash: binaryPayloadStats(payload.bytes).contentHash,
        };
    });
    return {
        canonical,
        files,
        portableDialectContracts,
        nativePayloads,
        nativeRepresentations,
        restorationPayloads,
        restorationRefs,
    };
}

export function buildImportedVersionClosure(input: {
    assetId: UuidV4;
    versionId: UuidV4;
    revision: number;
    parentVersionId: UuidV4 | "";
    importedAt: EpochMillis;
    material: CandidateMaterial;
    candidate: ExtractedAssetCandidate;
    originAuthority: Extract<VersionOriginAuthorityV1, { originKind: "import" }>;
    importProvenanceAuthority: ImportProvenanceAuthority;
}): VersionAuthorityClosureV1 {
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        input.material.canonical,
        input.material.files.map((item) => item.file),
    );
    const manifest: AssetVersionManifestV2 = {
        schemaVersion: 2,
        versionId: input.versionId,
        assetId: input.assetId,
        revision: input.revision,
        fingerprint: computeVersionFingerprint(
            versionCanonicalContentFingerprint,
            input.material.nativeRepresentations,
            input.material.restorationRefs,
            input.material.portableDialectContracts,
        ),
        status: input.candidate.status,
        diagnostics: input.candidate.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
            path: diagnostic.path,
            traceId: diagnostic.traceId,
        })),
        ...input.material.canonical,
        files: input.material.files.map((item) => item.file),
        changeKind: input.parentVersionId === "" ? "create" : "extract",
        sourceVersionId: input.parentVersionId,
        sourceDeploymentId: "",
        changeNote: "",
        createdAt: input.importedAt,
        versionCanonicalContentFingerprint,
        portableDialectContracts: input.material.portableDialectContracts,
        nativeRepresentations: input.material.nativeRepresentations,
        dialectRestorationPayloads: input.material.restorationRefs,
        originAuthority: input.originAuthority,
        importProvenanceAuthority: input.importProvenanceAuthority,
    };
    return {
        manifest,
        files: input.material.files,
        nativePayloads: input.material.nativePayloads,
        restorationPayloads: input.material.restorationPayloads,
    };
}

export function applyCanonicalBindings(
    candidate: ExtractedAssetCandidate,
    bindings: readonly ResolvedCallableBindingV1[],
): AssetKindTypeDataV2 {
    const canonical = {
        kind: candidate.kind,
        typeData: structuredClone(candidate.typeData),
    } as AssetKindTypeDataV2;
    const workflowBinding = bindings.find((binding) => binding.subject.subjectKind === "workflow_execution_agent");
    if (workflowBinding !== undefined) {
        const workflow = canonical.typeData as WorkflowTypeDataV2;
        const implementation = workflow.implementation as Extract<WorkflowTypeDataV2["implementation"], { kind: "instructions" }>;
        implementation.execution.agent = {
            mode: "bound",
            targetAssetVersionId: workflowBinding.targetAssetVersionId,
        };
    }
    if (candidate.kind === "Memory" && candidate.typeData.entityRole === "catalog") {
        const inputs = candidate.memoryCatalogMemberBindingInputs ?? [];
        type CatalogBinding = ResolvedCallableBindingV1 & {
            subject: Extract<ResolvedCallableBindingV1["subject"], { subjectKind: "memory_catalog_member" }>;
        };
        // validateCallableBindings is the single acceptance gate for this
        // operation-local list. A Catalog has no canonical files and therefore
        // cannot have either of the other callable-binding subject families.
        const catalogBindings = bindings as readonly CatalogBinding[];
        const byIndex = new Map(catalogBindings.map((binding) => [binding.subject.memberIndex, binding] as const));
        if (byIndex.size === inputs.length) {
            (canonical.typeData as Extract<MemoryTypeDataV2, { entityRole: "catalog" }>).members = inputs.map(
                (input, memberIndex) => ({
                    targetAssetVersionId: (byIndex.get(memberIndex) as ResolvedCallableBindingV1).targetAssetVersionId,
                    routingTitle: input.routingTitle,
                    routingHint: input.routingHint,
                }),
            );
        }
    }
    return canonical;
}

export function applyRestorationTransition(
    inherited: RestorationPayloadClosureV1[],
    candidate: ExtractedAssetCandidate,
    registry: VersionDialectRegistryV1,
): RestorationPayloadClosureV1[] {
    const dialectId = candidate.nativeRepresentation.dialectId;
    const retained = inherited.filter((item) => item.dialectId !== dialectId);
    if (candidate.dialectRestorationTransition.action === "inherit") {
        return inherited.sort((left, right) => compareUtf8Bytes(left.dialectId, right.dialectId));
    }
    if (candidate.dialectRestorationTransition.action === "clear") {
        return retained.sort((left, right) => compareUtf8Bytes(left.dialectId, right.dialectId));
    }
    const contract = registry.getRestoration(candidate.kind, dialectId);
    const bytes = new Uint8Array(candidate.dialectRestorationTransition.bytes);
    if (contract === null || !contract.validatePayload(bytes)) {
        throw new ImportServiceFailure(
            "import.restoration_contract_missing",
            `restoration dialect contract rejected: ${dialectId}`,
            "unsupported",
        );
    }
    return [...retained, { dialectId, bytes }].sort((left, right) => compareUtf8Bytes(left.dialectId, right.dialectId));
}

export function deriveCallableBindingRequests(candidate: ExtractedAssetCandidate): CallableBindingRequestV1[] {
    const requests: CallableBindingRequestV1[] = [];
    if (candidate.kind === "Workflow" && candidate.workflowExecutionAgentBindingInput.bindingInputKind === "raw_selector") {
        requests.push({
            subject: { subjectKind: "workflow_execution_agent" },
            rawTarget: candidate.workflowExecutionAgentBindingInput.rawTarget,
            required: candidate.workflowExecutionAgentBindingInput.required,
        });
    }
    if (candidate.kind === "Memory" && candidate.typeData.entityRole === "catalog") {
        for (const [memberIndex, member] of (candidate.memoryCatalogMemberBindingInputs ?? []).entries()) {
            requests.push({
                subject: { subjectKind: "memory_catalog_member", memberIndex },
                rawTarget: member.rawTarget,
                required: true,
            });
        }
    }
    for (const file of candidate.files) {
        for (const [referenceIndex, reference] of (file.references ?? []).entries()) {
            if (reference.kind === "execute" && reference.resolution === "unresolved") {
                requests.push({
                    subject: {
                        subjectKind: "file_reference",
                        logicalPath: file.logicalPath,
                        referenceIndex,
                    },
                    rawTarget: reference.rawTarget,
                    required: reference.required,
                });
            }
        }
    }
    return requests.sort((left, right) => compareUtf8Bytes(bindingSubjectKey(left.subject), bindingSubjectKey(right.subject)));
}

export function validateCallableBindings(
    requests: readonly CallableBindingRequestV1[],
    bindings: readonly ResolvedCallableBindingV1[],
): void {
    const requestMap = new Map(requests.map((request) => [bindingSubjectKey(request.subject), request]));
    const bindingMap = new Map<string, ResolvedCallableBindingV1>();
    for (const binding of bindings) {
        const key = bindingSubjectKey(binding.subject);
        if (!requestMap.has(key) || bindingMap.has(key) || !isUuidV4(binding.targetAssetVersionId)) {
            throw new ImportServiceFailure(
                "import.binding_invalid",
                "callable bindings contain an extra, duplicate, or malformed subject",
                "invalid_schema",
            );
        }
        bindingMap.set(key, binding);
    }
    if ([...requestMap].some(([key, request]) => request.required && !bindingMap.has(key))) {
        throw new ImportServiceFailure(
            "import.binding_required_missing",
            "a required callable binding was not resolved",
            "conflict",
        );
    }
}

export function bindingSubjectKey(subject: CallableBindingRequestV1["subject"] | ResolvedCallableBindingV1["subject"]): string {
    if (subject.subjectKind === "workflow_execution_agent") return "workflow_execution_agent";
    if (subject.subjectKind === "memory_catalog_member") return `memory_catalog_member\0${subject.memberIndex}`;
    return `file_reference\0${subject.logicalPath}\0${subject.referenceIndex}`;
}

export function resolveBindingAssetIds(
    configuration: ImportServiceConfiguration,
    bindings: readonly ResolvedCallableBindingV1[],
): UuidV4[] {
    return bindings.map((binding) => requireVersionOwner(configuration, binding.targetAssetVersionId).asset.assetId);
}

export function revalidateBindingTargets(
    configuration: ImportServiceConfiguration,
    candidate: ExtractedAssetCandidate,
    projectId: UuidV4 | "",
    bindings: readonly ResolvedCallableBindingV1[],
): void {
    for (const binding of bindings) {
        const owner = requireVersionOwner(configuration, binding.targetAssetVersionId);
        if (owner.asset.deleted) {
            throw new ImportServiceFailure("import.binding_target_inactive", "callable binding targets a deleted Asset");
        }
        const version = owner.versions.find(
            (item) => item.manifest.versionId === binding.targetAssetVersionId,
        ) as VersionAuthorityClosureV1;
        if (version.manifest.status !== "complete") {
            throw new ImportServiceFailure("import.binding_target_incomplete", "callable binding target is absent or incomplete");
        }
        const kindFitsSubject = (() => {
            if (binding.subject.subjectKind === "workflow_execution_agent") return owner.asset.kind === "Subagent";
            if (binding.subject.subjectKind === "file_reference") {
                return owner.asset.kind === "Workflow" || owner.asset.kind === "Subagent";
            }
            return (
                candidate.kind === "Memory" &&
                candidate.typeData.entityRole === "catalog" &&
                owner.asset.kind === "Memory" &&
                version.manifest.kind === "Memory" &&
                version.manifest.typeData.entityRole === "unit" &&
                owner.asset.scope === candidate.scope &&
                owner.asset.projectId === projectId &&
                owner.asset.scopePath === candidate.scopePath
            );
        })();
        if (!kindFitsSubject) {
            throw new ImportServiceFailure(
                "import.binding_target_kind_invalid",
                "callable binding target kind does not fit its invocation position",
            );
        }
    }
}

export function requireParentVersion(
    configuration: ImportServiceConfiguration,
    assetId: UuidV4,
    parentVersionId: UuidV4,
): VersionAuthorityClosureV1 {
    const asset = requireActiveAsset(configuration.assetsRoot, assetId);
    if (!asset.versionIds.includes(parentVersionId)) {
        throw new ImportServiceFailure("import.parent_invalid", "create-version parent does not belong to the selected Asset");
    }
    const parent = readVersionAuthority(configuration.assetsRoot, assetId, parentVersionId, configuration.dialectRegistry);
    return parent as VersionAuthorityClosureV1;
}

export function validateCandidateTargetAsset(
    configuration: ImportServiceConfiguration,
    assetId: UuidV4,
    candidate: ExtractedAssetCandidate,
    projectId: UuidV4 | "",
): void {
    const asset = requireActiveAsset(configuration.assetsRoot, assetId);
    if (
        asset.kind !== candidate.kind ||
        asset.scope !== candidate.scope ||
        asset.projectId !== projectId ||
        asset.scopePath !== candidate.scopePath
    ) {
        throw new ImportServiceFailure(
            "import.target_asset_mismatch",
            "candidate kind/scope/project/scopePath does not match the selected Asset",
            "conflict",
        );
    }
}
