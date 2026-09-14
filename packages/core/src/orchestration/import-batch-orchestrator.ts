/** Preview-wide batch import validation, dependency ordering, and item ledger projection. */

import { validatePromotionGrantTarget } from "../catalog/promotion-grant-store";
import type { VersionRef } from "../contracts/common";
import type { CoreResult } from "../contracts/core-service";
import type {
    CallableBindingSubjectV1,
    ImportAcceptBatchDecision,
    ImportAcceptBatchItemResultV1,
    ImportAcceptBatchRequest,
    ImportAcceptBatchResultV1,
    ImportAcceptRequest,
    ImportPreviewItem,
    ResolvedCallableBindingV1,
} from "../contracts/source-import";
import { completeResult } from "../foundation/core-result";
import { stableStringify } from "../foundation/fingerprint";
import { hasExactKeys, isStrictObject, isUuidV4 } from "../foundation/validators";
import { validateCallableBindings } from "./import-material";
import { buildPreview } from "./import-preview";
import type { ImportServiceConfiguration } from "./import-service-shared";
import {
    compareUtf8Bytes,
    diagnosticFromError,
    failed,
    ImportServiceFailure,
    importDiagnostic,
    requireUserAction,
} from "./import-service-shared";

type AcceptSingleImport = (input: ImportAcceptRequest) => Promise<CoreResult<VersionRef>>;

interface ValidatedBatch {
    input: ImportAcceptBatchRequest;
    decisions: Map<string, ImportAcceptBatchDecision>;
    dependencies: Map<string, string[]>;
    executionOrder: string[];
    resultOrder: string[];
}

export async function acceptImportBatch(
    configuration: ImportServiceConfiguration,
    sourceInput: ImportAcceptBatchRequest,
    acceptSingleImport: AcceptSingleImport,
): Promise<CoreResult<ImportAcceptBatchResultV1>> {
    let validated: ValidatedBatch;
    try {
        validated = validateBatchRequest(configuration, structuredClone(sourceInput));
    } catch (error) {
        return failed(error, "version");
    }

    const results = new Map<string, ImportAcceptBatchItemResultV1>();
    for (const candidateId of validated.executionOrder) {
        const decision = validated.decisions.get(candidateId) as ImportAcceptBatchDecision;
        const failedDependencyCandidateIds = collectFailedDependencies(candidateId, validated.dependencies, results);
        if (failedDependencyCandidateIds.length > 0) {
            results.set(candidateId, {
                status: "dependency_failed",
                candidateId,
                failedDependencyCandidateIds,
                diagnostics: [
                    importDiagnostic(
                        "import.batch_dependency_failed",
                        "one or more selected callable dependencies did not complete",
                        "conflict",
                        "version",
                        false,
                    ),
                ],
            });
            continue;
        }

        try {
            const resolvedDecision = resolveBatchDecision(decision, results);
            const result = await acceptSingleImport({
                previewSnapshot: validated.input.previewSnapshot,
                decision: resolvedDecision,
            });
            results.set(
                candidateId,
                result.status !== "failed"
                    ? {
                          status: "complete",
                          candidateId,
                          version: structuredClone(result.value),
                          diagnostics: structuredClone(result.diagnostics),
                      }
                    : {
                          status: "failed",
                          candidateId,
                          diagnostics: structuredClone(result.diagnostics),
                      },
            );
        } catch (error) {
            results.set(candidateId, {
                status: "failed",
                candidateId,
                diagnostics: [diagnosticFromError(error, "version")],
            });
        }
    }

    return completeResult({
        schemaVersion: 1,
        items: validated.resultOrder.map((candidateId) =>
            structuredClone(results.get(candidateId) as ImportAcceptBatchItemResultV1),
        ),
    });
}

function validateBatchRequest(configuration: ImportServiceConfiguration, input: ImportAcceptBatchRequest): ValidatedBatch {
    if (!isStrictObject(input) || !hasExactKeys(input, ["previewSnapshot", "decisions"]) || !Array.isArray(input.decisions)) {
        throw invalidBatch("batch request must contain exactly previewSnapshot and decisions");
    }
    if (input.decisions.length === 0) {
        throw invalidBatch("batch decisions must be non-empty");
    }

    const preview = buildPreview(
        configuration,
        structuredClone(input.previewSnapshot.readResults),
        input.previewSnapshot.previewedAt,
    );
    if (stableStringify(preview) !== stableStringify(input.previewSnapshot)) {
        throw new ImportServiceFailure(
            "import.preview_tampered_or_stale",
            "import preview no longer matches its complete source and Asset authority closure",
            "conflict",
            true,
        );
    }

    const itemByCandidateId = new Map(preview.items.map((item) => [item.candidateId, item]));
    const decisions = new Map<string, ImportAcceptBatchDecision>();
    const dependencies = new Map<string, string[]>();
    for (const decision of input.decisions) {
        validateBatchDecisionShape(decision);
        if (decisions.has(decision.candidateId)) {
            throw invalidBatch(`batch candidateId is duplicated: ${decision.candidateId}`);
        }
        const item = itemByCandidateId.get(decision.candidateId);
        if (item === undefined) {
            throw invalidBatch(`batch candidate is absent from the preview: ${decision.candidateId}`);
        }
        requireCreatableItem(item);
        decisions.set(decision.candidateId, decision);
    }

    for (const decision of decisions.values()) {
        const item = itemByCandidateId.get(decision.candidateId) as ImportPreviewItem;
        const syntheticBindings = decision.callableBindings.map((binding) => validateBatchBinding(binding, decisions));
        validateCallableBindings(item.callableBindingRequests, syntheticBindings);
        dependencies.set(
            decision.candidateId,
            decision.callableBindings
                .flatMap((binding) => ("targetCandidateId" in binding ? [binding.targetCandidateId] : []))
                .sort(compareUtf8Bytes),
        );
    }

    const previewOrder = preview.items.map((item) => item.candidateId).filter((candidateId) => decisions.has(candidateId));
    return {
        input,
        decisions,
        dependencies,
        executionOrder: dependencyFirstOrder(previewOrder, dependencies),
        resultOrder: previewOrder,
    };
}

function validateBatchDecisionShape(value: unknown): asserts value is ImportAcceptBatchDecision {
    if (!isStrictObject(value) || typeof value.candidateId !== "string" || value.candidateId.length === 0) {
        throw invalidBatch("batch decision candidateId must be non-empty");
    }
    const action = value.action;
    const expectedKeys =
        action === "create_asset"
            ? ["candidateId", "action", "freshness", "promotion", "callableBindings"]
            : action === "create_version"
              ? ["candidateId", "action", "assetId", "parentVersionId", "freshness", "promotion", "callableBindings"]
              : [];
    if (expectedKeys.length === 0 || !hasExactKeys(value, expectedKeys)) {
        throw invalidBatch("batch decision action or fields are invalid");
    }
    if (action === "create_version" && (!isUuidV4(value.assetId) || !isUuidV4(value.parentVersionId))) {
        throw invalidBatch("create_version batch decision requires UUID v4 assetId and parentVersionId");
    }
    validateFreshnessDisposition(value.freshness);
    validatePromotionDisposition(value.promotion);
    if (!Array.isArray(value.callableBindings)) {
        throw invalidBatch("batch decision callableBindings must be an array");
    }
}

function validateFreshnessDisposition(value: unknown): void {
    if (!isStrictObject(value)) throw invalidBatch("batch freshness disposition must be an object");
    if (value.freshnessAction === "require_current_source" && hasExactKeys(value, ["freshnessAction"])) return;
    if (
        value.freshnessAction === "accept_preview_snapshot" &&
        hasExactKeys(value, ["freshnessAction", "userActionId"]) &&
        typeof value.userActionId === "string"
    ) {
        requireUserAction(value.userActionId, "freshness.userActionId");
        return;
    }
    throw invalidBatch("batch freshness disposition is invalid");
}

function validatePromotionDisposition(value: unknown): void {
    if (!isStrictObject(value)) throw invalidBatch("batch promotion disposition must be an object");
    if (
        value.promotionAction === "import_only" &&
        hasExactKeys(value, ["promotionAction", "userActionId"]) &&
        typeof value.userActionId === "string"
    ) {
        requireUserAction(value.userActionId, "promotion.userActionId");
        return;
    }
    if (
        (value.promotionAction === "grant_current_version_current_target" ||
            value.promotionAction === "grant_asset_all_versions_current_target") &&
        hasExactKeys(value, ["promotionAction", "target", "userActionId"]) &&
        typeof value.userActionId === "string"
    ) {
        requireUserAction(value.userActionId, "promotion.userActionId");
        try {
            validatePromotionGrantTarget(value.target);
        } catch {
            throw invalidBatch("batch promotion target is invalid");
        }
        return;
    }
    throw invalidBatch("batch promotion disposition is invalid");
}

function validateBatchBinding(
    value: unknown,
    decisions: ReadonlyMap<string, ImportAcceptBatchDecision>,
): ResolvedCallableBindingV1 {
    if (!isStrictObject(value)) throw invalidBatch("batch callable binding must be an object");
    validateBindingSubject(value.subject);
    if (hasExactKeys(value, ["subject", "targetAssetVersionId"]) && isUuidV4(value.targetAssetVersionId)) {
        return value as unknown as ResolvedCallableBindingV1;
    }
    if (
        hasExactKeys(value, ["subject", "targetCandidateId"]) &&
        typeof value.targetCandidateId === "string" &&
        decisions.has(value.targetCandidateId)
    ) {
        return {
            subject: value.subject as CallableBindingSubjectV1,
            targetAssetVersionId: "00000000-0000-4000-8000-000000000000",
        };
    }
    throw invalidBatch("batch callable binding target is malformed or is not selected");
}

function validateBindingSubject(value: unknown): asserts value is CallableBindingSubjectV1 {
    if (!isStrictObject(value)) throw invalidBatch("batch callable binding subject must be an object");
    if (value.subjectKind === "workflow_execution_agent" && hasExactKeys(value, ["subjectKind"])) return;
    if (
        value.subjectKind === "file_reference" &&
        hasExactKeys(value, ["subjectKind", "logicalPath", "referenceIndex"]) &&
        typeof value.logicalPath === "string" &&
        Number.isInteger(value.referenceIndex) &&
        (value.referenceIndex as number) >= 0
    ) {
        return;
    }
    if (
        value.subjectKind === "memory_catalog_member" &&
        hasExactKeys(value, ["subjectKind", "memberIndex"]) &&
        Number.isInteger(value.memberIndex) &&
        (value.memberIndex as number) >= 0
    ) {
        return;
    }
    throw invalidBatch("batch callable binding subject is invalid");
}

function requireCreatableItem(item: ImportPreviewItem): void {
    if (item.action !== "create_asset") {
        throw new ImportServiceFailure(
            "import.candidate_not_creatable",
            `candidate action ${item.action} cannot publish a new Version`,
        );
    }
}

function dependencyFirstOrder(candidateIds: readonly string[], dependencies: ReadonlyMap<string, readonly string[]>): string[] {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const result: string[] = [];
    const visit = (candidateId: string): void => {
        if (visiting.has(candidateId)) {
            throw new ImportServiceFailure(
                "import.batch_dependency_cycle",
                "batch callable dependency graph contains a cycle",
                "conflict",
            );
        }
        if (visited.has(candidateId)) return;
        visiting.add(candidateId);
        for (const dependencyId of dependencies.get(candidateId) as readonly string[]) visit(dependencyId);
        visiting.delete(candidateId);
        visited.add(candidateId);
        result.push(candidateId);
    };
    for (const candidateId of candidateIds) visit(candidateId);
    return result;
}

function collectFailedDependencies(
    candidateId: string,
    dependencies: ReadonlyMap<string, readonly string[]>,
    results: ReadonlyMap<string, ImportAcceptBatchItemResultV1>,
): string[] {
    const failed = new Set<string>();
    const visit = (dependencyId: string): void => {
        const result = results.get(dependencyId);
        if (result?.status !== "complete") failed.add(dependencyId);
        for (const nested of dependencies.get(dependencyId) as readonly string[]) visit(nested);
    };
    for (const dependencyId of dependencies.get(candidateId) as readonly string[]) visit(dependencyId);
    return [...failed].sort(compareUtf8Bytes);
}

function resolveBatchDecision(
    decision: ImportAcceptBatchDecision,
    results: ReadonlyMap<string, ImportAcceptBatchItemResultV1>,
): ImportAcceptRequest["decision"] {
    const callableBindings: ResolvedCallableBindingV1[] = decision.callableBindings.map((binding) =>
        "targetAssetVersionId" in binding
            ? structuredClone(binding)
            : {
                  subject: structuredClone(binding.subject),
                  targetAssetVersionId: (
                      results.get(binding.targetCandidateId) as Extract<ImportAcceptBatchItemResultV1, { status: "complete" }>
                  ).version.versionId,
              },
    );
    return decision.action === "create_asset"
        ? { ...structuredClone(decision), callableBindings }
        : { ...structuredClone(decision), callableBindings };
}

function invalidBatch(message: string): ImportServiceFailure {
    return new ImportServiceFailure("import.batch_invalid", message, "invalid_schema");
}
