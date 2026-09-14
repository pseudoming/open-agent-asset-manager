import { describe, expect, it } from "vitest";
import {
    buildImportBatchRequest,
    callableBindingSubjectKey,
    canTargetBinding,
    canTargetExistingAsset,
    type ExistingAssetSummaryView,
    type ImportBindingSelection,
    type ImportCandidateView,
    type ImportDestinationSelection,
    type ImportPreviewView,
} from "../src/renderer/features/import-review/import-review-model";
import { localizedText } from "../src/renderer/presentation";

const DIGEST = "a".repeat(64);
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ASSET_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_VERSION_ID = "44444444-4444-4444-8444-444444444444";

function candidate(
    candidateId: string,
    kind: ImportCandidateView["kind"],
    options: Partial<ImportCandidateView> = {},
): ImportCandidateView {
    return {
        candidateId,
        kind,
        scope: "project",
        displayName: candidateId,
        displayDescription: `${candidateId} description`,
        status: "importable",
        freshness: "fresh",
        fileCount: 1,
        logicalPaths: [`${candidateId}.md`],
        logicalPathsTruncated: false,
        callableBindingRequestCount: options.callableBindingRequests?.length ?? 0,
        callableBindingRequests: [],
        callableBindingRequestsTruncated: false,
        ...options,
    };
}

const WORKFLOW_BINDING = {
    subject: { subjectKind: "workflow_execution_agent" as const },
    rawTarget: "reviewer",
    required: true,
};
const OPTIONAL_FILE_BINDING = {
    subject: { subjectKind: "file_reference" as const, logicalPath: "nested.md", referenceIndex: 0 },
    rawTarget: "./nested.md",
    required: false,
};
const MEMORY_MEMBER_BINDING = {
    subject: { subjectKind: "memory_catalog_member" as const, memberIndex: 0 },
    rawTarget: "topics/topic.md",
    required: true,
};
const PREVIEW: ImportPreviewView = {
    previewToken: "preview-token",
    snapshotFingerprint: DIGEST,
    candidates: [
        candidate("workflow", "Workflow", { callableBindingRequests: [WORKFLOW_BINDING, OPTIONAL_FILE_BINDING] }),
        candidate("subagent", "Subagent"),
        candidate("skill", "Skill"),
        candidate("stale", "Guidance", { freshness: "stale" }),
        candidate("blocked", "Memory", { status: "blocked" }),
    ],
};

function existingAsset(
    assetId: string,
    currentVersionId: string,
    kind: ExistingAssetSummaryView["kind"],
    displayName: string,
): ExistingAssetSummaryView {
    return {
        assetId,
        kind,
        scope: "global",
        scopePath: "",
        displayName,
        displayDescription: "",
        currentVersionId,
        currentRevision: 1,
        currentFingerprint: DIGEST,
        currentVersionStatus: "complete",
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
    };
}

const EXISTING_SUBAGENT = existingAsset(ASSET_ID, VERSION_ID, "Subagent", "Existing reviewer");
const EXISTING_WORKFLOW = existingAsset(WORKFLOW_ASSET_ID, WORKFLOW_VERSION_ID, "Workflow", "Existing workflow");

function createAssetDestinations(candidateIds: readonly string[]): readonly ImportDestinationSelection[] {
    return candidateIds.map((candidateId) => ({ candidateId, action: "create_asset" as const }));
}

function buildNewAssetBatch(
    preview: ImportPreviewView,
    selectedCandidateIds: readonly string[],
    bindingSelections: readonly ImportBindingSelection[],
    userActionId: string,
) {
    return buildImportBatchRequest(
        preview,
        selectedCandidateIds,
        createAssetDestinations(selectedCandidateIds),
        bindingSelections,
        [],
        userActionId,
    );
}

describe("Desktop import review request model", () => {
    it("builds one exact import-only batch and leaves dependency ordering to Core", () => {
        const workflow = PREVIEW.candidates[0] as ImportCandidateView;
        const request = buildNewAssetBatch(
            PREVIEW,
            ["workflow", "subagent"],
            [
                {
                    candidateId: "workflow",
                    subjectKey: callableBindingSubjectKey(WORKFLOW_BINDING.subject),
                    targetKind: "candidate",
                    targetCandidateId: "subagent",
                },
            ],
            "user-action",
        );

        expect(request).toEqual({
            status: "ready",
            params: {
                previewToken: "preview-token",
                expectedSnapshotFingerprint: DIGEST,
                decisions: [
                    {
                        candidateId: "workflow",
                        action: "create_asset",
                        freshness: { freshnessAction: "require_current_source" },
                        promotion: { promotionAction: "import_only", userActionId: "user-action" },
                        callableBindings: [
                            {
                                subject: { subjectKind: "workflow_execution_agent" },
                                targetCandidateId: "subagent",
                            },
                        ],
                    },
                    {
                        candidateId: "subagent",
                        action: "create_asset",
                        freshness: { freshnessAction: "require_current_source" },
                        promotion: { promotionAction: "import_only", userActionId: "user-action" },
                        callableBindings: [],
                    },
                ],
            },
        });
        expect(canTargetBinding(workflow.callableBindingRequests[0] as typeof WORKFLOW_BINDING, candidate("a", "Subagent"))).toBe(
            true,
        );
        expect(
            canTargetBinding(workflow.callableBindingRequests[1] as typeof OPTIONAL_FILE_BINDING, candidate("a", "Workflow")),
        ).toBe(true);
        expect(
            canTargetBinding(workflow.callableBindingRequests[1] as typeof OPTIONAL_FILE_BINDING, candidate("a", "Skill")),
        ).toBe(false);
    });

    it("binds a Memory Catalog only to an exact selected Unit candidate", () => {
        const catalog = candidate("catalog", "Memory", {
            memoryEntityRole: "catalog",
            fileCount: 0,
            logicalPaths: [],
            callableBindingRequests: [MEMORY_MEMBER_BINDING],
        });
        const unit = candidate("unit", "Memory", { memoryEntityRole: "unit" });
        const otherCatalog = candidate("other-catalog", "Memory", { memoryEntityRole: "catalog" });
        const preview: ImportPreviewView = {
            previewToken: "memory-preview",
            snapshotFingerprint: DIGEST,
            candidates: [catalog, unit, otherCatalog],
        };
        const subjectKey = callableBindingSubjectKey(MEMORY_MEMBER_BINDING.subject);
        expect(subjectKey).toBe("memory_catalog_member\u00000");
        expect(canTargetBinding(MEMORY_MEMBER_BINDING, unit)).toBe(true);
        expect(canTargetBinding(MEMORY_MEMBER_BINDING, otherCatalog)).toBe(false);
        expect(canTargetBinding(MEMORY_MEMBER_BINDING, candidate("guidance", "Guidance"))).toBe(false);

        expect(
            buildNewAssetBatch(
                preview,
                ["catalog", "unit"],
                [
                    {
                        candidateId: "catalog",
                        subjectKey,
                        targetKind: "candidate",
                        targetCandidateId: "unit",
                    },
                ],
                "memory-import",
            ),
        ).toEqual({
            status: "ready",
            params: {
                previewToken: "memory-preview",
                expectedSnapshotFingerprint: DIGEST,
                decisions: [
                    {
                        candidateId: "catalog",
                        action: "create_asset",
                        freshness: { freshnessAction: "require_current_source" },
                        promotion: { promotionAction: "import_only", userActionId: "memory-import" },
                        callableBindings: [
                            {
                                subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                                targetCandidateId: "unit",
                            },
                        ],
                    },
                    {
                        candidateId: "unit",
                        action: "create_asset",
                        freshness: { freshnessAction: "require_current_source" },
                        promotion: { promotionAction: "import_only", userActionId: "memory-import" },
                        callableBindings: [],
                    },
                ],
            },
        });
        expect(
            buildNewAssetBatch(
                preview,
                ["catalog", "other-catalog"],
                [
                    {
                        candidateId: "catalog",
                        subjectKey,
                        targetKind: "candidate",
                        targetCandidateId: "other-catalog",
                    },
                ],
                "memory-import",
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("import.validation.binding_stale") });

        const existingMemory = existingAsset(ASSET_ID, VERSION_ID, "Memory", "Unknown Memory role");
        expect(canTargetExistingAsset(MEMORY_MEMBER_BINDING, existingMemory)).toBe(false);
    });

    it("creates a Version only against the exact current parent and binds an existing compatible Version", () => {
        const subjectKey = callableBindingSubjectKey(WORKFLOW_BINDING.subject);
        const request = buildImportBatchRequest(
            PREVIEW,
            ["workflow"],
            [
                {
                    candidateId: "workflow",
                    action: "create_version",
                    assetId: WORKFLOW_ASSET_ID,
                    parentVersionId: WORKFLOW_VERSION_ID,
                },
            ],
            [
                {
                    candidateId: "workflow",
                    subjectKey,
                    targetKind: "asset_version",
                    targetAssetVersionId: VERSION_ID,
                },
            ],
            [EXISTING_WORKFLOW, EXISTING_SUBAGENT],
            "user-action",
        );
        expect(request).toMatchObject({
            status: "ready",
            params: {
                decisions: [
                    {
                        action: "create_version",
                        assetId: WORKFLOW_ASSET_ID,
                        parentVersionId: WORKFLOW_VERSION_ID,
                        callableBindings: [{ targetAssetVersionId: VERSION_ID }],
                    },
                ],
            },
        });
        expect(canTargetExistingAsset(WORKFLOW_BINDING, EXISTING_SUBAGENT)).toBe(true);
        expect(canTargetExistingAsset(WORKFLOW_BINDING, EXISTING_WORKFLOW)).toBe(false);

        expect(
            buildImportBatchRequest(
                PREVIEW,
                ["workflow"],
                [
                    {
                        candidateId: "workflow",
                        action: "create_version",
                        assetId: WORKFLOW_ASSET_ID,
                        parentVersionId: "55555555-5555-4555-8555-555555555555",
                    },
                ],
                [
                    {
                        candidateId: "workflow",
                        subjectKey,
                        targetKind: "asset_version",
                        targetAssetVersionId: VERSION_ID,
                    },
                ],
                [EXISTING_WORKFLOW, EXISTING_SUBAGENT],
                "user-action",
            ),
        ).toMatchObject({
            status: "invalid",
            message: localizedText("import.validation.destination_incompatible", { candidate: "workflow" }),
        });
    });

    it("rejects empty, stale, blocked, absent, missing, duplicate and incompatible dependency decisions", () => {
        expect(buildNewAssetBatch(PREVIEW, [], [], "action")).toMatchObject({ status: "invalid" });
        expect(buildNewAssetBatch(PREVIEW, ["stale"], [], "action")).toMatchObject({ status: "invalid" });
        expect(buildNewAssetBatch(PREVIEW, ["blocked"], [], "action")).toMatchObject({ status: "invalid" });
        expect(buildNewAssetBatch(PREVIEW, ["absent"], [], "action")).toMatchObject({ status: "invalid" });
        expect(buildNewAssetBatch(PREVIEW, ["subagent", "absent"], [], "action")).toMatchObject({
            status: "invalid",
            message: localizedText("import.validation.preview_membership"),
        });
        expect(buildImportBatchRequest(PREVIEW, ["subagent"], [], [], [], "action")).toMatchObject({
            status: "invalid",
            message: localizedText("import.validation.destination_choose", { candidate: "subagent" }),
        });
        expect(
            buildImportBatchRequest(
                PREVIEW,
                ["subagent"],
                [
                    { candidateId: "subagent", action: "create_asset" },
                    { candidateId: "subagent", action: "create_asset" },
                ],
                [],
                [],
                "action",
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("import.validation.destination_duplicate") });
        expect(
            buildImportBatchRequest(
                PREVIEW,
                ["subagent"],
                [
                    { candidateId: "subagent", action: "create_asset" },
                    { candidateId: "skill", action: "create_asset" },
                ],
                [],
                [],
                "action",
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("import.validation.destination_stale") });
        expect(
            buildNewAssetBatch(
                {
                    ...PREVIEW,
                    candidates: [
                        candidate("bounded", "Workflow", {
                            callableBindingRequestCount: 129,
                            callableBindingRequestsTruncated: true,
                        }),
                    ],
                },
                ["bounded"],
                [],
                "action",
            ),
        ).toMatchObject({
            status: "invalid",
            message: localizedText("import.validation.candidate_dependencies_truncated", { candidate: "bounded" }),
        });
        expect(buildNewAssetBatch(PREVIEW, ["workflow"], [], "action")).toMatchObject({
            status: "invalid",
            message: localizedText("import.validation.missing_binding", {
                candidate: "workflow",
                target: "reviewer",
            }),
        });
        const subjectKey = callableBindingSubjectKey(WORKFLOW_BINDING.subject);
        const binding = {
            candidateId: "workflow",
            subjectKey,
            targetKind: "candidate" as const,
            targetCandidateId: "skill",
        };
        expect(buildNewAssetBatch(PREVIEW, ["workflow", "skill"], [binding], "action")).toMatchObject({
            status: "invalid",
        });
        expect(
            buildNewAssetBatch(
                PREVIEW,
                ["workflow", "subagent"],
                [
                    { candidateId: "workflow", subjectKey, targetKind: "candidate", targetCandidateId: "subagent" },
                    { candidateId: "workflow", subjectKey, targetKind: "candidate", targetCandidateId: "subagent" },
                ],
                "action",
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("import.validation.binding_duplicate") });
        expect(
            buildImportBatchRequest(
                PREVIEW,
                ["subagent"],
                [{ candidateId: "subagent", action: "create_asset" }],
                [
                    {
                        candidateId: "workflow",
                        subjectKey,
                        targetKind: "candidate",
                        targetCandidateId: "subagent",
                    },
                ],
                [],
                "action",
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("import.validation.binding_stale") });
        expect(
            buildImportBatchRequest(
                PREVIEW,
                ["workflow"],
                [{ candidateId: "workflow", action: "create_asset" }],
                [
                    {
                        candidateId: "workflow",
                        subjectKey,
                        targetKind: "asset_version",
                        targetAssetVersionId: WORKFLOW_VERSION_ID,
                    },
                ],
                [EXISTING_WORKFLOW],
                "action",
            ),
        ).toMatchObject({ status: "invalid", message: localizedText("import.validation.binding_existing_stale") });
        expect(buildNewAssetBatch(PREVIEW, ["subagent"], [], " ")).toMatchObject({ status: "invalid" });
    });
});
