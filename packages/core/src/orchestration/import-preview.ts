/** Import preview, freshness, and duplicate reconciliation. */

import type {
    AdapterReadResult,
    ExtractedAssetCandidate,
    ImportAcceptRequest,
    ImportPreviewItem,
    ImportPreviewSnapshotV1,
} from "../contracts/source-import";
import type { EpochMillis, Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { PortableDialectSourceRuntimeV1 } from "../contracts/dialect";
import {
    computeImportCandidateFingerprint,
    computeImportPreviewSnapshotFingerprint,
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { validateAdapterReadResultSnapshot } from "../source-import/source-contract-validator";
import type { ImportServiceConfiguration, AssetAuthorityRecord, CandidateMaterial } from "./import-service-shared";
import {
    ZERO_FILE_ID,
    ImportServiceFailure,
    requireUserAction,
    diagnosticFromError,
    importDiagnostic,
    compareUtf8Bytes,
} from "./import-service-shared";
import { buildCandidateMaterial, deriveCallableBindingRequests, validateCallableBindings } from "./import-material";
import { readAssetCatalog, resolveCandidateProjectId } from "./import-authority";

export function buildPreview(
    configuration: ImportServiceConfiguration,
    inputReadResults: readonly AdapterReadResult[],
    previewedAt: EpochMillis,
): ImportPreviewSnapshotV1 {
    if (inputReadResults.length === 0) {
        throw new ImportServiceFailure("import.preview_empty", "import preview requires at least one read result");
    }
    const readResults = [...inputReadResults].sort((left, right) =>
        compareUtf8Bytes(left.readSnapshotFingerprint, right.readSnapshotFingerprint),
    );
    if (new Set(readResults.map((item) => item.readSnapshotFingerprint)).size !== readResults.length) {
        throw new ImportServiceFailure(
            "import.read_snapshot_duplicate",
            "import preview contains a duplicate read snapshot",
            "invalid_schema",
        );
    }
    const observations: Array<{
        candidate: ExtractedAssetCandidate;
        readResult: AdapterReadResult;
    }> = [];
    const candidateIds = new Set<string>();
    for (const result of readResults) {
        const issues = validateAdapterReadResultSnapshot(result);
        if (result.status !== "complete" || issues.length > 0) {
            throw new ImportServiceFailure(
                "import.read_snapshot_invalid",
                "import preview accepts only complete validated read-result closures",
                "invalid_schema",
            );
        }
        for (const candidate of result.candidates) {
            if (candidateIds.has(candidate.candidateId)) {
                throw new ImportServiceFailure(
                    "import.candidate_duplicate",
                    `candidateId is not globally unique: ${candidate.candidateId}`,
                    "invalid_schema",
                );
            }
            candidateIds.add(candidate.candidateId);
            observations.push({ candidate, readResult: result });
        }
    }

    const catalog = readAssetCatalog(configuration);
    const items = reconcileSnapshotCandidateObservations(observations).map((observation) =>
        observation.conflicted
            ? blockedSameSourceCandidate(observation.candidate)
            : reconcileCandidate(configuration, observation.candidate, observation.readResult, catalog),
    );
    const base = { schemaVersion: 1 as const, previewedAt, readResults, items };
    return {
        ...base,
        snapshotFingerprint: computeImportPreviewSnapshotFingerprint(base),
    };
}

export function reconcileSnapshotCandidateObservations(
    observations: ReadonlyArray<{
        candidate: ExtractedAssetCandidate;
        readResult: AdapterReadResult;
    }>,
): Array<{
    candidate: ExtractedAssetCandidate;
    readResult: AdapterReadResult;
    conflicted: boolean;
}> {
    const groups = new Map<string, Array<{ candidate: ExtractedAssetCandidate; readResult: AdapterReadResult }>>();
    for (const observation of observations) {
        const key = candidatePhysicalSourceSlotKey(observation.readResult, observation.candidate);
        const current = groups.get(key) ?? [];
        current.push(observation);
        groups.set(key, current);
    }
    return [...groups.values()]
        .map((group) => {
            const ordered = [...group].sort((left, right) =>
                compareUtf8Bytes(left.candidate.candidateId, right.candidate.candidateId),
            );
            const candidate = ordered[0]?.candidate as ExtractedAssetCandidate;
            const semanticKeys = new Set(ordered.map((item) => candidateReconciliationSemanticKey(item.candidate)));
            return {
                candidate,
                readResult: ordered[0]?.readResult as AdapterReadResult,
                conflicted: semanticKeys.size !== 1,
            };
        })
        .sort((left, right) => compareUtf8Bytes(left.candidate.candidateId, right.candidate.candidateId));
}

export function blockedSameSourceCandidate(candidate: ExtractedAssetCandidate): ImportPreviewItem {
    return {
        candidateId: candidate.candidateId,
        freshness: "fresh",
        callableBindingRequests: deriveCallableBindingRequests(candidate),
        diagnostics: [
            ...candidate.diagnostics,
            importDiagnostic(
                "import.same_source_interpretation_conflict",
                "the same physical source produced incompatible candidate interpretations",
                "conflict",
                "asset",
                false,
            ),
        ],
        action: "blocked",
    };
}

export function reconcileCandidate(
    configuration: ImportServiceConfiguration,
    candidate: ExtractedAssetCandidate,
    readResult: AdapterReadResult,
    catalog: readonly AssetAuthorityRecord[],
): ImportPreviewItem {
    const callableBindingRequests = deriveCallableBindingRequests(candidate);
    const base = {
        candidateId: candidate.candidateId,
        freshness: "fresh" as const,
        callableBindingRequests,
        diagnostics: candidate.diagnostics,
    };
    if (candidate.assetCandidateStatus !== "importable") return { ...base, action: "incomplete" };
    try {
        const projectId = resolveCandidateProjectId(configuration, candidate);
        // A required user Subagent binding is operation-local and will replace the raw selector
        // before publication. Use a valid non-persisted sentinel here so preview can validate the
        // final portable branch without treating an unresolved user selector as runtime-native.
        const previewBindings = callableBindingRequests
            .filter((request) => request.required && request.subject.subjectKind === "workflow_execution_agent")
            .map((request) => ({
                subject: request.subject,
                targetAssetVersionId: ZERO_FILE_ID,
            }));
        const material = buildCandidateMaterial(
            candidate,
            previewBindings,
            null,
            configuration.dialectRegistry,
            candidateSourceRuntimes(configuration, readResult, candidate),
            { next: () => ZERO_FILE_ID },
        );
        if (candidate.status !== "complete" || callableBindingRequests.some((item) => item.required)) {
            return { ...base, action: "create_asset" };
        }
        const duplicates = findExactDuplicateVersions(catalog, candidate, projectId, computeMaterialFingerprint(material));
        if (duplicates.length > 1) {
            return {
                ...base,
                action: "blocked",
                diagnostics: [
                    ...base.diagnostics,
                    importDiagnostic(
                        "import.duplicate_ambiguous",
                        "the same canonical asset exists in multiple Asset histories",
                        "conflict",
                        "asset",
                        false,
                    ),
                ],
            };
        }
        return duplicates[0] === undefined
            ? { ...base, action: "create_asset" }
            : { ...base, action: "duplicate", ...duplicates[0] };
    } catch (error) {
        return {
            ...base,
            action: "blocked",
            diagnostics: [...base.diagnostics, diagnosticFromError(error, "asset")],
        };
    }
}

export function candidateSourceRuntimes(
    configuration: ImportServiceConfiguration,
    readResult: AdapterReadResult,
    candidate: ExtractedAssetCandidate,
): PortableDialectSourceRuntimeV1[] {
    const candidateObligationIds = new Set(
        readResult.sourceParseReports.flatMap((report) =>
            report.readEntryDispositions.flatMap((disposition) =>
                disposition.disposition !== "ignored" && disposition.candidateIds.includes(candidate.candidateId)
                    ? [disposition.sourceReadObligationId]
                    : [],
            ),
        ),
    );
    const observedVersions = new Map<string, string>();
    if (readResult.readTarget.sourceSelector.selectorKind === "probe_roots") {
        for (const observed of readResult.readTarget.sourceSelector.observation.observedAgentRuntimes) {
            observedVersions.set(observed.agentRuntimeId, observed.versionText);
        }
    }
    const sources = new Map<string, PortableDialectSourceRuntimeV1>();
    for (const obligation of readResult.sourceReadObligations) {
        if (!candidateObligationIds.has(obligation.sourceReadObligationId)) continue;
        const agentRuntimeId = configuration.resolveSourceCapabilityAgentRuntimeId(
            candidate.adapterId,
            obligation.sourceCapabilityFingerprint,
        );
        if (agentRuntimeId === null) {
            throw new ImportServiceFailure(
                "import.source_capability_unavailable",
                "candidate source capability is no longer registered",
                "unsupported",
            );
        }
        const source = {
            agentRuntimeId,
            versionText: observedVersions.get(agentRuntimeId) ?? "",
        };
        sources.set(`${source.agentRuntimeId}\0${source.versionText}`, source);
    }
    if (sources.size === 0) {
        throw new ImportServiceFailure(
            "import.source_runtime_unresolved",
            "candidate is not bound to a registered source agent runtime",
            "invalid_schema",
        );
    }
    return [...sources.values()].sort((left, right) =>
        compareUtf8Bytes(`${left.agentRuntimeId}\0${left.versionText}`, `${right.agentRuntimeId}\0${right.versionText}`),
    );
}

export function computeMaterialFingerprint(material: CandidateMaterial): Sha256Digest {
    return computeVersionFingerprint(
        computeVersionCanonicalContentFingerprint(
            material.canonical,
            material.files.map((item) => item.file),
        ),
        material.nativeRepresentations,
        material.restorationRefs,
        material.portableDialectContracts,
    );
}

export function findExactDuplicateVersions(
    catalog: readonly AssetAuthorityRecord[],
    candidate: ExtractedAssetCandidate,
    projectId: UuidV4 | "",
    fingerprint: Sha256Digest,
): Array<{ assetId: UuidV4; versionId: UuidV4 }> {
    return catalog.flatMap(({ asset, versions }) =>
        asset.deleted ||
        asset.kind !== candidate.kind ||
        asset.scope !== candidate.scope ||
        asset.projectId !== projectId ||
        asset.scopePath !== candidate.scopePath
            ? []
            : versions
                  .filter(
                      (version) => version.manifest.status === candidate.status && version.manifest.fingerprint === fingerprint,
                  )
                  .map((version) => ({
                      assetId: asset.assetId,
                      versionId: version.manifest.versionId,
                  })),
    );
}

export function validateAcceptRequest(
    configuration: ImportServiceConfiguration,
    input: ImportAcceptRequest,
): {
    candidate: ExtractedAssetCandidate;
    readResult: AdapterReadResult;
    candidateFingerprint: Sha256Digest;
} {
    const recomputed = buildPreview(configuration, input.previewSnapshot.readResults, input.previewSnapshot.previewedAt);
    if (stableStringify(recomputed) !== stableStringify(input.previewSnapshot)) {
        throw new ImportServiceFailure(
            "import.preview_tampered_or_stale",
            "import preview no longer matches its complete source and Asset authority closure",
            "conflict",
            true,
        );
    }
    return validateAcceptedCandidateFromSnapshot(input, recomputed);
}

/**
 * Reuse a snapshot that the batch orchestrator validated before its first publish.
 *
 * Earlier successful items intentionally change the catalog projection of that same preview.
 * The batch orchestrator is the only caller of this path. Source sampling belongs to this batch;
 * each item still checks candidate, binding-target, duplicate and current publication authority.
 */
export function validateBatchAcceptedRequest(input: ImportAcceptRequest): {
    candidate: ExtractedAssetCandidate;
    readResult: AdapterReadResult;
    candidateFingerprint: Sha256Digest;
} {
    return validateAcceptedCandidateFromSnapshot(input, input.previewSnapshot);
}

function validateAcceptedCandidateFromSnapshot(
    input: ImportAcceptRequest,
    snapshot: ImportPreviewSnapshotV1,
): {
    candidate: ExtractedAssetCandidate;
    readResult: AdapterReadResult;
    candidateFingerprint: Sha256Digest;
} {
    const item = snapshot.items.find((candidate) => candidate.candidateId === input.decision.candidateId);
    if (item === undefined) {
        throw new ImportServiceFailure("import.candidate_missing", "accepted candidate is absent from the preview");
    }
    if (item.action === "duplicate" || item.action === "incomplete" || item.action === "blocked") {
        throw new ImportServiceFailure(
            "import.candidate_not_creatable",
            `candidate action ${item.action} cannot publish a new Version`,
        );
    }
    const located = snapshot.readResults
        .flatMap((readResult) => readResult.candidates.map((candidate) => ({ candidate, readResult })))
        .find(({ candidate }) => candidate.candidateId === input.decision.candidateId) as {
        candidate: ExtractedAssetCandidate;
        readResult: AdapterReadResult;
    };
    validateCallableBindings(item.callableBindingRequests, input.decision.callableBindings);
    if (input.decision.freshness.freshnessAction === "accept_preview_snapshot") {
        requireUserAction(input.decision.freshness.userActionId, "freshness.userActionId");
    }
    return {
        candidate: located.candidate,
        readResult: located.readResult,
        candidateFingerprint: computeImportCandidateFingerprint(located.candidate),
    };
}

export async function selectFreshCandidate(
    configuration: ImportServiceConfiguration,
    candidate: ExtractedAssetCandidate,
    previousRead: AdapterReadResult,
    input: ImportAcceptRequest,
): Promise<{ candidate: ExtractedAssetCandidate; readResult: AdapterReadResult }> {
    if (input.decision.freshness.freshnessAction === "accept_preview_snapshot") {
        return { candidate, readResult: previousRead };
    }
    const previousSnapshot = structuredClone(previousRead);
    const refreshed = structuredClone(await configuration.refreshReadResult(structuredClone(previousSnapshot)));
    if (refreshed.status !== "complete") {
        throw new ImportServiceFailure(
            "import.source_refresh_failed",
            "the current source could not be refreshed",
            "unavailable",
            true,
        );
    }
    if (
        validateAdapterReadResultSnapshot(refreshed.value).length > 0 ||
        refreshed.value.readSnapshotFingerprint !== previousSnapshot.readSnapshotFingerprint
    ) {
        throw sourceChangedFailure();
    }
    const sourceSlot = stableStringify({
        adapterId: candidate.adapterId,
        physicalSourceSlot: candidatePhysicalSourceSlotKey(previousSnapshot, candidate),
    });
    const matches = refreshed.value.candidates.filter(
        (item) =>
            stableStringify({
                adapterId: item.adapterId,
                physicalSourceSlot: candidatePhysicalSourceSlotKey(refreshed.value, item),
            }) === sourceSlot,
    );
    const reconciled = reconcileSnapshotCandidateObservations(
        matches.map((item) => ({ candidate: item, readResult: refreshed.value })),
    );
    const refreshedObservation = reconciled[0];
    if (
        reconciled.length !== 1 ||
        refreshedObservation === undefined ||
        refreshedObservation.conflicted ||
        candidateRefreshSemanticKey(refreshedObservation.candidate) !== candidateRefreshSemanticKey(candidate)
    ) {
        throw sourceChangedFailure();
    }
    return {
        candidate: refreshedObservation.candidate,
        readResult: refreshed.value,
    };
}

export function sourceChangedFailure(): ImportServiceFailure {
    return new ImportServiceFailure(
        "import.source_changed",
        "the source or its exact parsed candidate changed after preview; refresh the preview",
        "conflict",
        true,
    );
}

export function candidatePhysicalSourceSlotKey(result: AdapterReadResult, candidate: ExtractedAssetCandidate): string {
    const entries = new Map(result.observedReadEntries.map((entry) => [entry.observedReadEntryId, entry]));
    // validateAdapterReadResultSnapshot has already proved every candidate-origin ID resolves.
    const physicalIdentity = (entryId: string): Sha256Digest =>
        (entries.get(entryId) as AdapterReadResult["observedReadEntries"][number]).physicalIdentityFingerprint;
    // External attestations are explanatory evidence, not parser/source origins. They remain in
    // the exact candidate snapshot but must not split one physical source slot into two Assets.
    return stableStringify({
        kind: candidate.kind,
        scope: candidate.scope,
        projectRootPath: candidate.projectRootPath,
        scopePath: candidate.scopePath,
        files: candidate.sourceFileOrigins.map((origin) => ({
            logicalPath: origin.logicalPath,
            physicalIdentities: origin.observedReadEntryIds.map(physicalIdentity).sort(compareUtf8Bytes),
        })),
        containers: candidate.sourceContainerEntryIds.map(physicalIdentity).sort(compareUtf8Bytes),
        metadata: candidate.metadataSourceOrigins.map((origin) => ({
            metadataSubject: origin.metadataSubject,
            physicalIdentity: physicalIdentity(origin.observedReadEntryId),
        })),
    });
}

export function candidateRefreshSemanticKey(candidate: ExtractedAssetCandidate): string {
    const { candidateId: _operationLocalCandidateId, ...semanticCandidate } = candidate;
    return stableStringify(semanticCandidate);
}

export function candidateReconciliationSemanticKey(candidate: ExtractedAssetCandidate): string {
    const {
        candidateId: _candidateId,
        adapterId: _adapterId,
        sourceRootIds: _sourceRootIds,
        sourceFileOrigins: _sourceFileOrigins,
        sourceContainerEntryIds: _sourceContainerEntryIds,
        metadataSourceOrigins: _metadataSourceOrigins,
        sourceEvidence: _sourceEvidence,
        diagnostics: _diagnostics,
        ...semanticCandidate
    } = candidate;
    const native = semanticCandidate.nativeRepresentation;
    // Directory origins are source evidence just like sourceContainerEntryIds. The validated
    // physical slot already binds their identities; sibling reads issue different local IDs.
    // Keep the exact candidate untouched for snapshot fingerprints and freshness validation.
    return stableStringify({
        ...semanticCandidate,
        nativeRepresentation:
            native.representationSource === "separate_file_graph"
                ? {
                      ...native,
                      directories: native.directories.map(({ observedReadEntryIds: _origins, ...directory }) => directory),
                  }
                : native,
    });
}
