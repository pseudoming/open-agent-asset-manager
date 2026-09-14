/**
 * Preview-wide batch import ordering, validation, and partial-success semantics.
 */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { acceptImportBatch } from "../../src/orchestration/import-batch-orchestrator";
import { createImportService } from "../../src/orchestration/import-service";
import type {
    AdapterReadResult,
    FileReferenceV2,
    ImportAcceptBatchCallableBindingV1,
    ImportAcceptBatchDecision,
    ImportAcceptBatchRequest,
    ImportPreviewSnapshotV1,
    OperationDiagnostic,
    ReindexReport,
    UuidV4,
} from "../../src/types";
import {
    assetsRoot,
    candidateBase,
    makeGuidanceReadResult,
    makeReadResultFromProvider,
    makeService,
    makeServiceConfiguration,
    PROJECT_ID,
    providerForCandidate,
    sourceFile,
    subagentTypeData,
    workflowTypeData,
} from "./fixtures/import-service-test-fixtures";

const MISSING_ASSET_ID = "00000000-0000-4000-8000-000000009991" as UuidV4;
const MISSING_VERSION_ID = "00000000-0000-4000-8000-000000009992" as UuidV4;

describe("Core batch import", () => {
    it("publishes selected callable dependencies first and returns canonical preview order", async () => {
        const subagentRead = await makeSubagentRead();
        const workflowRead = await makeWorkflowRead(true);
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([workflowRead, subagentRead]).value;
        const subagentId = candidateIdForKind(subagentRead, "Subagent");
        const workflowId = candidateIdForKind(workflowRead, "Workflow");

        const result = await service.acceptImportBatch({
            previewSnapshot: preview,
            decisions: [
                batchDecision(workflowId, [
                    {
                        subject: { subjectKind: "workflow_execution_agent" },
                        targetCandidateId: subagentId,
                    },
                ]),
                batchDecision(subagentId),
            ],
        });

        expect(result.status).toBe("complete");
        expect(result.value.items.map((item) => item.candidateId)).toEqual(
            preview.items
                .filter((item) => item.candidateId === subagentId || item.candidateId === workflowId)
                .map((item) => item.candidateId),
        );
        expect(
            result.value.items.map((item) => item.status),
            JSON.stringify(result.value.items),
        ).toEqual(["complete", "complete"]);
        const subagent = completeItem(result.value.items, subagentId);
        const workflow = completeItem(result.value.items, workflowId);
        expect(workflow.version.versionId).not.toBe(subagent.version.versionId);

        const workflowManifest = JSON.parse(
            fs.readFileSync(
                `${assetsRoot}/${workflow.version.assetId}/versions/${workflow.version.versionId}/version.json`,
                "utf-8",
            ),
        ) as {
            typeData: {
                implementation: {
                    execution: {
                        agent: { mode: string; targetAssetVersionId: string };
                    };
                };
            };
        };
        expect(workflowManifest.typeData.implementation.execution.agent).toEqual({
            mode: "bound",
            targetAssetVersionId: subagent.version.versionId,
        });
    });

    it("keeps a projection-partial dependency usable after its Version authority commits", async () => {
        const subagentRead = await makeSubagentRead();
        const workflowRead = await makeWorkflowRead(true);
        const diagnostic = projectionDiagnostic();
        const service = makeService(async (previous) => previous, {
            reindexImportedAsset: () => ({
                status: "failed",
                value: undefined as ReindexReport,
                diagnostics: [diagnostic],
            }),
        });
        const preview = service.previewImport([workflowRead, subagentRead]).value;
        const subagentId = candidateIdForKind(subagentRead, "Subagent");
        const workflowId = candidateIdForKind(workflowRead, "Workflow");

        const result = await service.acceptImportBatch({
            previewSnapshot: preview,
            decisions: [
                batchDecision(workflowId, [
                    {
                        subject: { subjectKind: "workflow_execution_agent" },
                        targetCandidateId: subagentId,
                    },
                ]),
                batchDecision(subagentId),
            ],
        });

        const subagent = completeItem(result.value.items, subagentId);
        const workflow = completeItem(result.value.items, workflowId);
        expect(subagent.diagnostics).toEqual([diagnostic]);
        expect(workflow.diagnostics).toEqual([diagnostic]);
        const workflowManifest = JSON.parse(
            fs.readFileSync(
                `${assetsRoot}/${workflow.version.assetId}/versions/${workflow.version.versionId}/version.json`,
                "utf-8",
            ),
        ) as {
            typeData: {
                implementation: {
                    execution: {
                        agent: { mode: string; targetAssetVersionId: string };
                    };
                };
            };
        };
        expect(workflowManifest.typeData.implementation.execution.agent).toEqual({
            mode: "bound",
            targetAssetVersionId: subagent.version.versionId,
        });
    });

    it("rejects a callable dependency cycle before publishing any Asset", async () => {
        const subagentRead = await makeSubagentRead([unresolvedExecuteReference("review", false)]);
        const workflowRead = await makeWorkflowRead(false);
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([subagentRead, workflowRead]).value;
        const subagentId = candidateIdForKind(subagentRead, "Subagent");
        const workflowId = candidateIdForKind(workflowRead, "Workflow");

        const result = await service.acceptImportBatch({
            previewSnapshot: preview,
            decisions: [
                batchDecision(
                    subagentId,
                    [
                        {
                            subject: { subjectKind: "file_reference", logicalPath: "agent.json", referenceIndex: 0 },
                            targetCandidateId: workflowId,
                        },
                    ],
                    {
                        promotion: {
                            promotionAction: "grant_current_version_current_target",
                            target: { targetKind: "project", projectId: PROJECT_ID },
                            userActionId: "grant-subagent",
                        },
                    },
                ),
                batchDecision(
                    workflowId,
                    [
                        {
                            subject: { subjectKind: "workflow_execution_agent" },
                            targetCandidateId: subagentId,
                        },
                    ],
                    {
                        promotion: {
                            promotionAction: "grant_asset_all_versions_current_target",
                            target: {
                                targetKind: "global_target",
                                targetAuthorityFingerprint: `sha256:${"7".repeat(64)}`,
                            },
                            userActionId: "grant-workflow",
                        },
                    },
                ),
            ],
        });

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("import.batch_dependency_cycle");
        expect(publishedAssetIds()).toEqual([]);
    });

    it("keeps an independent success while skipping every transitive dependent of a failed item", async () => {
        const subagentRead = await makeSubagentRead();
        const workflowRead = await makeWorkflowRead(true);
        const guidanceRead = await makeGuidanceReadResult({ candidateId: "candidate-independent-guidance" });
        let refreshCalls = 0;
        const service = makeService(async (previous) => {
            refreshCalls += 1;
            return previous;
        });
        const preview = service.previewImport([workflowRead, guidanceRead, subagentRead]).value;
        const subagentId = candidateIdForKind(subagentRead, "Subagent");
        const workflowId = candidateIdForKind(workflowRead, "Workflow");
        const guidanceId = candidateIdForKind(guidanceRead, "Guidance");

        const result = await service.acceptImportBatch({
            previewSnapshot: preview,
            decisions: [
                batchDecision(
                    workflowId,
                    [
                        {
                            subject: { subjectKind: "workflow_execution_agent" },
                            targetCandidateId: subagentId,
                        },
                    ],
                    {
                        freshness: { freshnessAction: "require_current_source" },
                    },
                ),
                batchDecision(subagentId, [], {
                    action: "create_version",
                    assetId: MISSING_ASSET_ID,
                    parentVersionId: MISSING_VERSION_ID,
                }),
                batchDecision(guidanceId),
            ],
        });

        expect(result.status).toBe("complete");
        expect(item(result.value.items, subagentId).status).toBe("failed");
        expect(item(result.value.items, workflowId)).toMatchObject({
            status: "dependency_failed",
            failedDependencyCandidateIds: [subagentId],
        });
        expect(item(result.value.items, guidanceId).status).toBe("complete");
        expect(refreshCalls).toBe(0);
        expect(publishedAssetIds()).toHaveLength(1);
    });

    it("reports every unsuccessful transitive prerequisite in canonical order", async () => {
        const subagentRead = await makeSubagentRead();
        const workflowRead = await makeWorkflowRead(true);
        fs.writeFileSync(sourceFile, "# Guidance\n");
        const guidanceRead = await makeGuidanceReadResult({
            candidateId: "candidate-transitive-guidance",
            files: [
                {
                    logicalPath: "GUIDANCE.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    text: "# Guidance\n",
                    executable: false,
                    references: [unresolvedExecuteReference("review", false)],
                },
            ],
        });
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([guidanceRead, workflowRead, subagentRead]).value;
        const subagentId = candidateIdForKind(subagentRead, "Subagent");
        const workflowId = candidateIdForKind(workflowRead, "Workflow");
        const guidanceId = candidateIdForKind(guidanceRead, "Guidance");

        const result = await service.acceptImportBatch({
            previewSnapshot: preview,
            decisions: [
                batchDecision(subagentId, [], {
                    action: "create_version",
                    assetId: MISSING_ASSET_ID,
                    parentVersionId: MISSING_VERSION_ID,
                }),
                batchDecision(workflowId, [
                    {
                        subject: { subjectKind: "workflow_execution_agent" },
                        targetCandidateId: subagentId,
                    },
                ]),
                batchDecision(guidanceId, [
                    {
                        subject: { subjectKind: "file_reference", logicalPath: "GUIDANCE.md", referenceIndex: 0 },
                        targetCandidateId: workflowId,
                    },
                ]),
            ],
        });

        expect(item(result.value.items, guidanceId)).toMatchObject({
            status: "dependency_failed",
            failedDependencyCandidateIds: [subagentId, workflowId].sort(),
        });
    });

    it("accepts an existing Version binding through the batch-only union", async () => {
        const subagentRead = await makeSubagentRead();
        const service = makeService(async (previous) => previous);
        const subagentPreview = service.previewImport([subagentRead]).value;
        const single = await service.acceptImport({
            previewSnapshot: subagentPreview,
            decision: {
                ...batchDecision(candidateIdForKind(subagentRead, "Subagent")),
                callableBindings: [],
            },
        });
        expect(single.status).toBe("complete");

        const workflowRead = await makeWorkflowRead(true);
        const preview = service.previewImport([workflowRead]).value;
        const workflowId = candidateIdForKind(workflowRead, "Workflow");
        const result = await service.acceptImportBatch({
            previewSnapshot: preview,
            decisions: [
                batchDecision(workflowId, [
                    {
                        subject: { subjectKind: "workflow_execution_agent" },
                        targetAssetVersionId: single.value.versionId,
                    },
                ]),
            ],
        });

        expect(result.status).toBe("complete");
        expect(item(result.value.items, workflowId).status).toBe("complete");
    });

    it("prevalidates the complete decision set before the first publication", async () => {
        const subagentRead = await makeSubagentRead();
        const guidanceRead = await makeGuidanceReadResult({ candidateId: "candidate-guidance-invalid-batch" });
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([subagentRead, guidanceRead]).value;
        const subagentId = candidateIdForKind(subagentRead, "Subagent");
        const guidanceId = candidateIdForKind(guidanceRead, "Guidance");
        const valid = batchDecision(guidanceId);

        const invalidRequests: ImportAcceptBatchRequest[] = [
            null as unknown as ImportAcceptBatchRequest,
            { previewSnapshot: preview, decisions: null as unknown as ImportAcceptBatchDecision[] },
            { previewSnapshot: preview, decisions: [] },
            { previewSnapshot: preview, decisions: [valid, valid] },
            {
                previewSnapshot: preview,
                decisions: [batchDecision("candidate-absent")],
            },
            {
                previewSnapshot: preview,
                decisions: [
                    batchDecision(subagentId, [
                        {
                            subject: { subjectKind: "workflow_execution_agent" },
                            targetCandidateId: guidanceId,
                        },
                    ]),
                    valid,
                ],
            },
        ];

        for (const request of invalidRequests) {
            const result = await service.acceptImportBatch(request);
            expect(result.status).toBe("failed");
            expect(publishedAssetIds()).toEqual([]);
        }
    });

    it("rejects a non-creatable preview item before invoking any selected import", async () => {
        const guidanceRead = await makeGuidanceReadResult({ candidateId: "candidate-duplicate-guidance" });
        const service = makeService(async (previous) => previous);
        const firstPreview = service.previewImport([guidanceRead]).value;
        const guidanceId = candidateIdForKind(guidanceRead, "Guidance");
        const first = await service.acceptImport({
            previewSnapshot: firstPreview,
            decision: batchDecision(guidanceId),
        });
        expect(first.status).toBe("complete");
        const before = publishedAssetIds();
        const duplicatePreview = service.previewImport([guidanceRead]).value;
        expect(duplicatePreview.items[0]?.action).toBe("duplicate");

        const result = await service.acceptImportBatch({
            previewSnapshot: duplicatePreview,
            decisions: [batchDecision(guidanceId)],
        });

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("import.candidate_not_creatable");
        expect(publishedAssetIds()).toEqual(before);
    });

    it("turns an unexpected single-import throw into an item failure and continues the ledger", async () => {
        const guidanceRead = await makeGuidanceReadResult({ candidateId: "candidate-throwing-guidance" });
        const configuration = makeServiceConfiguration(async (previous) => previous);
        const preview = createImportService(configuration).previewImport([guidanceRead]).value;
        const guidanceId = candidateIdForKind(guidanceRead, "Guidance");

        const result = await acceptImportBatch(
            configuration,
            {
                previewSnapshot: preview,
                decisions: [batchDecision(guidanceId)],
            },
            async () => {
                throw new Error("injected single-import failure");
            },
        );

        expect(result.status).toBe("complete");
        expect(item(result.value.items, guidanceId)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "import.internal_error" }],
        });
    });

    it("rejects tampered snapshots and malformed runtime DTO branches without publication", async () => {
        const workflowRead = await makeWorkflowRead(true);
        const subagentRead = await makeSubagentRead();
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([workflowRead, subagentRead]).value;
        const workflowId = candidateIdForKind(workflowRead, "Workflow");
        const subagentId = candidateIdForKind(subagentRead, "Subagent");
        const validBinding = {
            subject: { subjectKind: "workflow_execution_agent" as const },
            targetCandidateId: subagentId,
        };
        const malformedDecisions: unknown[] = [
            null,
            { candidateId: "", action: "create_asset", freshness: {}, promotion: {}, callableBindings: [] },
            { ...batchDecision(workflowId), action: "invalid" },
            {
                ...batchDecision(workflowId),
                action: "create_version",
                assetId: "not-a-uuid",
                parentVersionId: MISSING_VERSION_ID,
            },
            { ...batchDecision(workflowId), freshness: null },
            { ...batchDecision(workflowId), freshness: { freshnessAction: "require_current_source", extra: true } },
            {
                ...batchDecision(workflowId),
                freshness: { freshnessAction: "accept_preview_snapshot", userActionId: "" },
            },
            { ...batchDecision(workflowId), promotion: null },
            { ...batchDecision(workflowId), promotion: { promotionAction: "import_only", userActionId: "" } },
            { ...batchDecision(workflowId), promotion: { promotionAction: "unknown", userActionId: "x" } },
            {
                ...batchDecision(workflowId),
                promotion: {
                    promotionAction: "grant_current_version_current_target",
                    target: { targetKind: "project", projectId: "bad" },
                    userActionId: "grant",
                },
            },
            { ...batchDecision(workflowId), callableBindings: null },
            { ...batchDecision(workflowId), callableBindings: [null] },
            {
                ...batchDecision(workflowId),
                callableBindings: [{ subject: null, targetCandidateId: subagentId }],
            },
            {
                ...batchDecision(workflowId),
                callableBindings: [
                    {
                        subject: { subjectKind: "file_reference", logicalPath: "review.md", referenceIndex: -1 },
                        targetCandidateId: subagentId,
                    },
                ],
            },
            {
                ...batchDecision(workflowId),
                callableBindings: [{ ...validBinding, extra: true }],
            },
            {
                ...batchDecision(workflowId),
                callableBindings: [
                    {
                        subject: { subjectKind: "memory_catalog_member", memberIndex: -1 },
                        targetCandidateId: subagentId,
                    },
                ],
            },
            {
                ...batchDecision(workflowId),
                callableBindings: [{ subject: validBinding.subject, targetCandidateId: "candidate-not-selected" }],
            },
        ];

        for (const malformed of malformedDecisions) {
            const result = await service.acceptImportBatch({
                previewSnapshot: preview,
                decisions: [malformed as ImportAcceptBatchDecision, batchDecision(subagentId)],
            });
            expect(result.status).toBe("failed");
            expect(publishedAssetIds()).toEqual([]);
        }

        const tampered = structuredClone(preview);
        tampered.snapshotFingerprint = `sha256:${"0".repeat(64)}`;
        const tamperedResult = await service.acceptImportBatch({
            previewSnapshot: tampered,
            decisions: [batchDecision(subagentId)],
        });
        expect(tamperedResult.status).toBe("failed");
        expect(tamperedResult.diagnostics[0]?.code).toBe("import.preview_tampered_or_stale");
        expect(publishedAssetIds()).toEqual([]);
    });
});

function batchDecision(
    candidateId: string,
    callableBindings: ImportAcceptBatchCallableBindingV1[] = [],
    overrides: Partial<ImportAcceptBatchDecision> = {},
): ImportAcceptBatchDecision {
    return {
        candidateId,
        action: "create_asset",
        freshness: { freshnessAction: "accept_preview_snapshot", userActionId: "accept-preview" },
        promotion: { promotionAction: "import_only", userActionId: "accept-import" },
        callableBindings,
        ...overrides,
    } as ImportAcceptBatchDecision;
}

async function makeSubagentRead(references: FileReferenceV2[] = []): Promise<AdapterReadResult> {
    fs.writeFileSync(
        sourceFile,
        JSON.stringify({
            schemaVersion: 1,
            sections: [{ title: "Role", content: "Review changes" }],
        }),
    );
    return makeReadResultFromProvider(
        providerForCandidate("Subagent", (observedReadEntryId, text) => ({
            ...candidateBase(observedReadEntryId, "agent.json", text, "fixture-subagent-v1"),
            files: [
                {
                    logicalPath: "agent.json",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "application/json",
                    text,
                    executable: false,
                    references,
                },
            ],
            kind: "Subagent",
            typeData: subagentTypeData(),
        })),
        "Subagent",
    );
}

async function makeWorkflowRead(required: boolean): Promise<AdapterReadResult> {
    fs.writeFileSync(sourceFile, "Review the selected change.\n");
    return makeReadResultFromProvider(
        providerForCandidate("Workflow", (observedReadEntryId, text) => ({
            ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
            kind: "Workflow",
            workflowExecutionAgentBindingInput: {
                bindingInputKind: "raw_selector",
                rawTarget: "reviewer",
                required,
            },
            typeData: workflowTypeData("reviewer"),
        })),
        "Workflow",
    );
}

function unresolvedExecuteReference(rawTarget: string, required: boolean): FileReferenceV2 {
    return {
        kind: "execute",
        rawTarget,
        required,
        resolution: "unresolved",
        diagnostics: [],
    };
}

function candidateIdForKind(read: AdapterReadResult, kind: string): string {
    const candidate = read.candidates.find((item) => item.kind === kind);
    if (candidate === undefined) throw new Error(`missing ${kind} candidate`);
    return candidate.candidateId;
}

function item(
    items: Awaited<ReturnType<ReturnType<typeof makeService>["acceptImportBatch"]>>["value"]["items"],
    candidateId: string,
) {
    const result = items.find((entry) => entry.candidateId === candidateId);
    if (result === undefined) throw new Error(`missing batch item ${candidateId}`);
    return result;
}

function completeItem(
    items: Awaited<ReturnType<ReturnType<typeof makeService>["acceptImportBatch"]>>["value"]["items"],
    candidateId: string,
) {
    const result = item(items, candidateId);
    if (result.status !== "complete") throw new Error(`batch item did not complete: ${candidateId}`);
    return result;
}

function publishedAssetIds(): string[] {
    return fs.existsSync(assetsRoot) ? fs.readdirSync(assetsRoot).filter((entry) => !entry.startsWith(".")) : [];
}

function projectionDiagnostic(): OperationDiagnostic {
    return {
        severity: "error",
        code: "fixture.index_projection_failed",
        message: "injected index projection failure",
        path: "",
        traceId: "",
        operation: "reindex",
        causeKind: "partial",
        retryable: true,
        suggestedActions: ["retry"],
        rawSummary: "injected index projection failure",
    };
}
