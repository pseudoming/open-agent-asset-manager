/**
 * Candidate-level validation against a Core-owned adapter read ledger.
 *
 * The provider-result validator owns report/disposition completeness. This
 * module owns candidate shape, scope, file graph and reverse-origin closure.
 */

import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AdapterReadTarget,
    AssetVersionFileContentV2,
    ManagedTargetReadGuard,
    ObservedReadEntry,
    OperationDiagnostic,
    ProviderReadEntryDisposition,
    ReadAccessOutcome,
    ReadEntryHandle,
    Sha256Digest,
    SourceReadObligation,
} from "../types";
import { isManagedTargetPath } from "../adapters/adapter-read-managed-target";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { canonicalMediaType, inferCanonicalMediaType } from "../foundation/media-type";
import { isCanonicalRelativePath } from "../foundation/validators";
import { readJsoncTopLevelPropertyValue } from "../foundation/jsonc-top-level-property";
import { isCompleteNativeDirectoryGraph } from "../foundation/native-directory-graph";
import { getAssetSpecHandler } from "../specs/registry";
import {
    candidateFileHash,
    compareCodeUnitText,
    isSortedUnique,
    sameStringSet,
    sourceDiagnostic,
} from "./source-read-validation-helpers";

export function validateCandidates(
    target: AdapterReadTarget,
    candidateList: AdapterExtractedAssetCandidate[],
    candidates: ReadonlyMap<string, AdapterExtractedAssetCandidate>,
    dispositions: ReadonlyMap<string, ProviderReadEntryDisposition>,
    handles: ReadonlyMap<string, ReadEntryHandle>,
    outcomes: ReadonlyMap<string, ReadAccessOutcome>,
    entries: ReadonlyMap<string, ObservedReadEntry>,
    filePayloads: ReadonlyMap<string, Uint8Array> | null,
    obligations: ReadonlyMap<string, SourceReadObligation>,
    capabilities: ReadonlyMap<string, AdapterAssetSourceCapability>,
    guards: readonly ManagedTargetReadGuard[],
    diagnostics: OperationDiagnostic[],
): void {
    const referencedCandidateIds = [...dispositions.values()].flatMap((disposition) =>
        disposition.disposition === "ignored" ? [] : disposition.candidateIds,
    );
    if (!sameStringSet(candidates.keys(), referencedCandidateIds)) {
        diagnostics.push(
            sourceDiagnostic("read.candidate_disposition_mismatch", "candidate/disposition membership is not exact"),
        );
    }
    for (const candidate of candidateList) {
        if (
            !getAssetSpecHandler(candidate.kind).isCanonicalPair({
                kind: candidate.kind,
                typeData: candidate.typeData,
            })
        ) {
            diagnostics.push(sourceDiagnostic("read.candidate_type_data_invalid", "candidate kind/typeData pair is invalid"));
        } else {
            validateCandidateFileGraph(candidate, diagnostics);
        }
        const candidateDispositions = [...dispositions.values()].filter(
            (disposition): disposition is Exclude<ProviderReadEntryDisposition, { disposition: "ignored" }> =>
                disposition.disposition !== "ignored" && disposition.candidateIds.includes(candidate.candidateId),
        );
        const candidateObligations = candidateDispositions
            .map((disposition) => obligations.get(disposition.sourceReadObligationId))
            .filter((obligation): obligation is SourceReadObligation => obligation !== undefined);
        const expectedRoots = candidateObligations.map((obligation) => obligation.sourceRootId);
        if (!isSortedUnique(candidate.sourceRootIds) || !sameStringSet(candidate.sourceRootIds, expectedRoots)) {
            diagnostics.push(sourceDiagnostic("read.candidate_root_mismatch", "candidate roots do not match its dispositions"));
        }
        if (
            candidateObligations.some(
                (obligation) => capabilities.get(obligation.sourceCapabilityFingerprint)?.assetKind !== candidate.kind,
            )
        ) {
            diagnostics.push(
                sourceDiagnostic("read.candidate_kind_mismatch", "candidate kind does not match its source capability"),
            );
        }
        validateCandidateScope(target, candidate, diagnostics);
        validateCandidateOrigins(candidate, candidateDispositions, handles, outcomes, entries, filePayloads, guards, diagnostics);
    }
}

export function validateCandidateFileGraph(candidate: AdapterExtractedAssetCandidate, diagnostics: OperationDiagnostic[]): void {
    validateWorkflowExecutionAgentBindingInput(candidate, diagnostics);
    validateMemoryCatalogMemberBindingInputs(candidate, diagnostics);
    const logicalPaths = candidate.files.map((file) => file.logicalPath);
    if (
        logicalPaths.some((logicalPath) => !isCanonicalRelativePath(logicalPath)) ||
        new Set(logicalPaths).size !== logicalPaths.length
    ) {
        diagnostics.push(
            sourceDiagnostic(
                "read.candidate_file_graph_invalid",
                "candidate files require unique canonical POSIX-relative paths",
            ),
        );
    }
    if (candidate.nativeRepresentation.representationSource !== "canonical_files") {
        const nativePaths = candidate.nativeRepresentation.files.map((file) => file.relativePath);
        if (
            nativePaths.some((relativePath) => !isCanonicalRelativePath(relativePath)) ||
            new Set(nativePaths).size !== nativePaths.length
        ) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.candidate_native_graph_invalid",
                    "candidate native files require unique canonical POSIX-relative paths",
                ),
            );
        }
        if (candidate.nativeRepresentation.representationSource === "separate_file_graph") {
            const directoryPaths = candidate.nativeRepresentation.directories.map((directory) => directory.relativePath);
            const directoryIds = candidate.nativeRepresentation.directories.flatMap(
                (directory) => directory.observedReadEntryIds,
            );
            if (
                directoryPaths.length === 0 ||
                directoryPaths.some((relativePath) => !isCanonicalRelativePath(relativePath)) ||
                !isSortedUnique(directoryPaths) ||
                new Set(directoryIds).size !== directoryIds.length ||
                candidate.nativeRepresentation.directories.some(
                    (directory) => directory.observedReadEntryIds.length === 0 || !isSortedUnique(directory.observedReadEntryIds),
                ) ||
                directoryPaths.some((relativePath) => nativePaths.includes(relativePath)) ||
                !isCompleteNativeDirectoryGraph(directoryPaths, nativePaths)
            ) {
                diagnostics.push(
                    sourceDiagnostic(
                        "read.candidate_native_directory_graph_invalid",
                        "candidate native directories require a complete sorted observed graph without file collisions",
                    ),
                );
            }
        }
    }
    const mediaTypeInvalid = candidate.files.some(
        (file) =>
            canonicalMediaType(file.mediaType) !== file.mediaType ||
            inferCanonicalMediaType(file.logicalPath, file.contentKind) !== file.mediaType,
    );
    const nativeMediaTypeInvalid =
        candidate.nativeRepresentation.representationSource !== "canonical_files" &&
        candidate.nativeRepresentation.files.some(
            (file) =>
                canonicalMediaType(file.mediaType) !== file.mediaType ||
                inferCanonicalMediaType(file.relativePath, file.contentKind) !== file.mediaType,
        );
    if (mediaTypeInvalid || nativeMediaTypeInvalid) {
        diagnostics.push(
            sourceDiagnostic(
                "read.candidate_media_type_invalid",
                "candidate files must use Core canonical logical-path media classification",
            ),
        );
    }
    if (candidate.status !== "complete") {
        return;
    }

    const handler = getAssetSpecHandler(candidate.kind);
    const entries = candidate.files.filter((file) => file.role === "entry");
    const entryRule = handler.completeEntryRule(candidate);
    const entryValid =
        entryRule === "zero"
            ? entries.length === 0
            : entries.length === 1 && entries[0]?.contentKind === "text" && handler.validateEntryText(entries[0].text);
    if (!entryValid) {
        diagnostics.push(
            sourceDiagnostic(
                "read.candidate_complete_entry_invalid",
                "complete candidate does not satisfy its AssetKind entry rule",
            ),
        );
    }
    const files = candidate.files.map(candidateFileForSpecValidation);
    if (handler.validateFiles(candidate, files).length > 0) {
        diagnostics.push(
            sourceDiagnostic(
                "read.candidate_spec_files_invalid",
                "complete candidate files do not satisfy their AssetKind contract",
            ),
        );
    }
}

function validateMemoryCatalogMemberBindingInputs(
    candidate: AdapterExtractedAssetCandidate,
    diagnostics: OperationDiagnostic[],
): void {
    if (candidate.kind !== "Memory") return;
    const inputs = candidate.memoryCatalogMemberBindingInputs;
    if (candidate.typeData.entityRole === "unit") {
        if (inputs !== undefined) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.memory_catalog_binding_input_invalid",
                    "Memory Unit candidates cannot carry Catalog member binding inputs",
                ),
            );
        }
        return;
    }
    if (candidate.status !== "complete") {
        if (inputs !== undefined) validateMemoryCatalogBindingArray(inputs, diagnostics);
        return;
    }
    if (candidate.typeData.members.length !== 0 || !Array.isArray(inputs)) {
        diagnostics.push(
            sourceDiagnostic(
                "read.memory_catalog_binding_input_invalid",
                "complete source Memory Catalogs require operation-local member bindings and no persisted member ids",
            ),
        );
        return;
    }
    validateMemoryCatalogBindingArray(inputs, diagnostics);
}

function validateMemoryCatalogBindingArray(inputs: unknown, diagnostics: OperationDiagnostic[]): void {
    if (!Array.isArray(inputs)) {
        diagnostics.push(
            sourceDiagnostic(
                "read.memory_catalog_binding_input_invalid",
                "Memory Catalog member bindings must be an ordered array",
            ),
        );
        return;
    }
    const rawTargets = new Set<string>();
    for (const input of inputs) {
        if (
            typeof input !== "object" ||
            input === null ||
            Object.keys(input).sort().join("\0") !== "rawTarget\0routingHint\0routingTitle" ||
            !("rawTarget" in input) ||
            !("routingTitle" in input) ||
            !("routingHint" in input) ||
            typeof input.rawTarget !== "string" ||
            !isCanonicalRelativePath(input.rawTarget) ||
            rawTargets.has(input.rawTarget) ||
            typeof input.routingTitle !== "string" ||
            input.routingTitle.trim() === "" ||
            typeof input.routingHint !== "string"
        ) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.memory_catalog_binding_input_invalid",
                    "Memory Catalog member bindings require ordered unique paths, non-blank titles, and text hints",
                ),
            );
            return;
        }
        rawTargets.add(input.rawTarget);
    }
}

function validateWorkflowExecutionAgentBindingInput(
    candidate: AdapterExtractedAssetCandidate,
    diagnostics: OperationDiagnostic[],
): void {
    if (candidate.kind !== "Workflow") {
        return;
    }
    const input = candidate.workflowExecutionAgentBindingInput;
    const implementation = candidate.typeData.implementation;
    if (input.bindingInputKind === "none") {
        if (implementation.kind === "instructions" && implementation.execution.agent.mode !== "agent_runtime_default") {
            diagnostics.push(
                sourceDiagnostic(
                    "read.workflow_agent_binding_input_invalid",
                    "Workflow binding input 'none' requires an executable or runtime-default execution agent",
                ),
            );
        }
        return;
    }
    if (
        input.rawTarget.trim() === "" ||
        implementation.kind !== "instructions" ||
        implementation.execution.agent.mode !== "agent_runtime_named" ||
        implementation.execution.agent.selector !== input.rawTarget
    ) {
        diagnostics.push(
            sourceDiagnostic(
                "read.workflow_agent_binding_input_invalid",
                "Workflow binding input must exactly classify its runtime-named execution-agent selector",
            ),
        );
    }
}

function candidateFileForSpecValidation(input: AdapterExtractedAssetCandidate["files"][number]): AssetVersionFileContentV2 {
    const bytes = input.contentKind === "text" ? Buffer.from(input.text, "utf-8") : input.bytes;
    const file = {
        fileId: "00000000-0000-4000-8000-000000000000" as const,
        logicalPath: input.logicalPath,
        role: input.role,
        contentHash: sha256Bytes(bytes),
        contentKind: input.contentKind,
        mediaType: input.mediaType,
        byteSize: bytes.byteLength,
        executable: input.executable,
        references: input.references ?? [],
    };
    return input.contentKind === "text"
        ? { file, contentKind: "text", text: input.text }
        : { file, contentKind: "binary", bytes: input.bytes };
}

function validateCandidateScope(
    target: AdapterReadTarget,
    candidate: AdapterExtractedAssetCandidate,
    diagnostics: OperationDiagnostic[],
): void {
    if (target.sourceSelector.selectorKind === "user_selected_root") {
        const binding = target.sourceSelector.binding;
        if (candidate.scope !== binding.assetScope || candidate.projectRootPath !== binding.projectRootPath) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.candidate_user_scope_mismatch",
                    "candidate does not match the user-selected scope binding",
                ),
            );
        }
    } else {
        validateCandidateScopePair(candidate, diagnostics);
    }
}

export function validateCandidateScopePair(candidate: AdapterExtractedAssetCandidate, diagnostics: OperationDiagnostic[]): void {
    if (
        (candidate.scope === "global" && candidate.projectRootPath !== "") ||
        (candidate.scope === "project" && candidate.projectRootPath === "")
    ) {
        diagnostics.push(sourceDiagnostic("read.candidate_scope_invalid", "candidate scope/projectRootPath pair is invalid"));
    }
}

export function validateCandidateOrigins(
    candidate: AdapterExtractedAssetCandidate,
    candidateDispositions: Array<Exclude<ProviderReadEntryDisposition, { disposition: "ignored" }>>,
    handles: ReadonlyMap<string, ReadEntryHandle>,
    outcomes: ReadonlyMap<string, ReadAccessOutcome>,
    entries: ReadonlyMap<string, ObservedReadEntry>,
    filePayloads: ReadonlyMap<string, Uint8Array> | null,
    guards: readonly ManagedTargetReadGuard[],
    diagnostics: OperationDiagnostic[],
): void {
    const allowedEntryIds = new Set<string>();
    const dispositionOriginIds = new Map<string, Set<string>>();
    for (const disposition of candidateDispositions) {
        const ids =
            disposition.disposition === "traversed" ? [disposition.observedDirectoryEntryId] : disposition.observedReadEntryIds;
        dispositionOriginIds.set(disposition.readEntryHandleId, new Set(ids));
        for (const id of ids) {
            allowedEntryIds.add(id);
        }
    }
    const referenced = new Set<string>();
    const files = new Map(candidate.files.map((file) => [file.logicalPath, file]));
    const filePaths = candidate.files.map((file) => file.logicalPath);
    const originPaths = candidate.sourceFileOrigins.map((origin) => origin.logicalPath);
    if (files.size !== candidate.files.length || !isSortedUnique(originPaths) || !sameStringSet(filePaths, originPaths)) {
        diagnostics.push(
            sourceDiagnostic(
                "read.candidate_file_origin_mismatch",
                "candidate files and source file origins must be a canonical one-to-one set",
            ),
        );
    }
    for (const origin of candidate.sourceFileOrigins) {
        const file = files.get(origin.logicalPath);
        if (file === undefined || origin.observedReadEntryIds.length === 0 || !isSortedUnique(origin.observedReadEntryIds)) {
            diagnostics.push(
                sourceDiagnostic("read.candidate_file_origin_missing", "source file origin references a missing candidate file"),
            );
            continue;
        }
        for (const entryId of origin.observedReadEntryIds) {
            const entry = entries.get(entryId);
            referenced.add(entryId);
            const requiresCanonicalByteIdentity = candidate.nativeRepresentation.representationSource === "canonical_files";
            if (
                entry?.entryKind !== "file" ||
                !allowedEntryIds.has(entryId) ||
                (requiresCanonicalByteIdentity &&
                    (entry.contentHash !== candidateFileHash(file) || entry.executable !== file.executable))
            ) {
                diagnostics.push(
                    sourceDiagnostic(
                        "read.candidate_file_origin_invalid",
                        requiresCanonicalByteIdentity
                            ? "canonical candidate file origin does not match observed bytes"
                            : "derived candidate file origin is outside the observed source closure",
                    ),
                );
            }
        }
    }
    validateSeparateNativeOrigins(candidate, allowedEntryIds, entries, filePayloads, referenced, diagnostics);
    if (!isSortedUnique(candidate.sourceContainerEntryIds)) {
        diagnostics.push(
            sourceDiagnostic("read.candidate_container_origins_not_canonical", "container origins must be sorted and unique"),
        );
    }
    for (const entryId of candidate.sourceContainerEntryIds) {
        referenced.add(entryId);
        if (entries.get(entryId)?.entryKind !== "directory" || !allowedEntryIds.has(entryId)) {
            diagnostics.push(
                sourceDiagnostic("read.candidate_container_origin_invalid", "candidate container origin is invalid"),
            );
        }
    }
    const metadataKeys = candidate.metadataSourceOrigins.map(
        (origin) => `${origin.metadataSubject}\0${origin.observedReadEntryId}`,
    );
    if (!isSortedUnique(metadataKeys)) {
        diagnostics.push(
            sourceDiagnostic("read.candidate_metadata_origins_not_canonical", "metadata origins must be sorted and unique"),
        );
    }
    for (const origin of candidate.metadataSourceOrigins) {
        referenced.add(origin.observedReadEntryId);
        if (entries.get(origin.observedReadEntryId)?.entryKind !== "file" || !allowedEntryIds.has(origin.observedReadEntryId)) {
            diagnostics.push(sourceDiagnostic("read.candidate_metadata_origin_invalid", "candidate metadata origin is invalid"));
        }
    }
    for (const evidence of candidate.sourceEvidence) {
        if (evidence.evidenceOrigin === "external_attestation") {
            diagnostics.push(
                sourceDiagnostic("read.candidate_attestation_unknown", "candidate references an unissued attestation receipt"),
            );
        } else {
            referenced.add(evidence.observedReadEntryId);
            if (!allowedEntryIds.has(evidence.observedReadEntryId)) {
                diagnostics.push(
                    sourceDiagnostic("read.candidate_evidence_foreign", "candidate evidence is outside its disposition closure"),
                );
            }
        }
    }
    for (const disposition of candidateDispositions) {
        const ids = dispositionOriginIds.get(disposition.readEntryHandleId) as Set<string>;
        if (![...ids].some((id) => referenced.has(id))) {
            diagnostics.push(
                sourceDiagnostic("read.candidate_reverse_origin_missing", "candidate disposition has no reverse origin"),
            );
        }
        const handle = handles.get(disposition.readEntryHandleId);
        if (handle !== undefined && isManagedTargetPath(guards, handle.sourceRootId, handle.relativePath)) {
            diagnostics.push(sourceDiagnostic("read.candidate_managed_origin", "candidate includes a managed target origin"));
        }
        if (disposition.disposition === "parsed") {
            const outcome = outcomes.get(disposition.readAccessOutcomeId);
            if (outcome?.operation !== "read_file") {
                diagnostics.push(
                    sourceDiagnostic("read.candidate_parse_outcome_missing", "candidate parsed origin has no read outcome"),
                );
            }
        }
    }
}

function validateSeparateNativeOrigins(
    candidate: AdapterExtractedAssetCandidate,
    allowedEntryIds: ReadonlySet<string>,
    entries: ReadonlyMap<string, ObservedReadEntry>,
    filePayloads: ReadonlyMap<string, Uint8Array> | null,
    referenced: Set<string>,
    diagnostics: OperationDiagnostic[],
): void {
    if (candidate.nativeRepresentation.representationSource === "canonical_files") {
        return;
    }

    const observedByByteIdentity = new Map<string, string[]>();
    for (const entryId of allowedEntryIds) {
        const entry = entries.get(entryId);
        if (entry?.entryKind !== "file") {
            continue;
        }
        const key = observedFileByteIdentity(entry.contentHash, entry.executable);
        const ids = observedByByteIdentity.get(key) ?? [];
        ids.push(entryId);
        observedByByteIdentity.set(key, ids);
    }
    for (const ids of observedByByteIdentity.values()) {
        ids.sort(compareCodeUnitText);
    }

    for (const file of candidate.nativeRepresentation.files) {
        if (file.fragmentOrigin !== undefined) {
            const origin = file.fragmentOrigin;
            const entry = entries.get(origin.observedReadEntryId);
            const payload = filePayloads?.get(origin.observedReadEntryId);
            referenced.add(origin.observedReadEntryId);
            let fragment: Uint8Array | undefined;
            try {
                fragment =
                    origin.fragmentKind === "jsonc_top_level_property_value" && payload !== undefined
                        ? readJsoncTopLevelPropertyValue(payload, origin.propertyName)?.valueBytes
                        : undefined;
            } catch {
                fragment = undefined;
            }
            if (
                entry?.entryKind !== "file" ||
                !allowedEntryIds.has(origin.observedReadEntryId) ||
                (filePayloads !== null &&
                    (fragment === undefined || Buffer.compare(Buffer.from(fragment), Buffer.from(file.bytes)) !== 0)) ||
                file.executable
            ) {
                diagnostics.push(
                    sourceDiagnostic(
                        "read.candidate_native_fragment_origin_invalid",
                        "separate native fragment does not exactly match its observed container property",
                    ),
                );
            }
            continue;
        }
        const key = observedFileByteIdentity(sha256Bytes(file.bytes), file.executable);
        const matchingIds = observedByByteIdentity.get(key);
        const matchedEntryId = matchingIds?.shift();
        if (matchedEntryId === undefined) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.candidate_native_origin_invalid",
                    "separate native file bytes do not match an unconsumed observed source file",
                ),
            );
            continue;
        }
        referenced.add(matchedEntryId);
    }
    if (candidate.nativeRepresentation.representationSource === "separate_file_graph") {
        const directoryOriginIds = candidate.nativeRepresentation.directories.flatMap(
            (directory) => directory.observedReadEntryIds,
        );
        for (const directory of candidate.nativeRepresentation.directories) {
            for (const observedReadEntryId of directory.observedReadEntryIds) {
                referenced.add(observedReadEntryId);
                if (entries.get(observedReadEntryId)?.entryKind !== "directory" || !allowedEntryIds.has(observedReadEntryId)) {
                    diagnostics.push(
                        sourceDiagnostic(
                            "read.candidate_native_directory_origin_invalid",
                            "native directory member is outside the observed source closure",
                        ),
                    );
                }
            }
        }
        const nativeContainerIds = candidate.sourceContainerEntryIds.filter((id) => entries.get(id)?.relativePath !== "");
        if (!sameStringSet(directoryOriginIds, nativeContainerIds)) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.candidate_native_directory_origin_mismatch",
                    "native directory members must exactly match the candidate container origins",
                ),
            );
        }
    }
}

function observedFileByteIdentity(contentHash: Sha256Digest, executable: boolean): string {
    return `${contentHash}\0${executable ? "1" : "0"}`;
}
