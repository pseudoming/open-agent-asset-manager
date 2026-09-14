import type { ProtocolDiagnosticV1, ProtocolOperationParams } from "@oaam/app-server-protocol";
import { fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { ImportReviewController } from "../src/renderer/features/import-review/import-review-controller";
import type {
    ExistingAssetSummaryView,
    ImportCandidateView,
    ImportPreviewView,
} from "../src/renderer/features/import-review/import-review-model";
import { localizedText } from "../src/renderer/presentation";

export const DIGEST = "a".repeat(64);
export const ASSET_ID = "11111111-1111-4111-8111-111111111111";
export const VERSION_ID = "22222222-2222-4222-8222-222222222222";
export const WORKFLOW_ASSET_ID = "33333333-3333-4333-8333-333333333333";
export const WORKFLOW_VERSION_ID = "44444444-4444-4444-8444-444444444444";

export const READ_PARAMS: ProtocolOperationParams<"adapter.read"> = {
    probeToken: "probe-token",
    selections: [{ probeResultRowId: "probe-row", sourceRootRowIds: ["source-row"] }],
};

export const READ_PREPARATION = {
    request: READ_PARAMS,
    sources: [
        {
            probeResultRowId: "probe-row",
            sourceRootRowId: "source-row",
            sourceRootId: "source-root",
            adapterId: "adapter",
            environmentLabel: localizedText("sources.environment.local"),
            toolLabel: localizedText("sources.tool.unknown"),
            displayPath: "/home/user/.agent",
        },
    ],
} as const;

export function selectWorkbenchOption(label: string, option: string | RegExp): void {
    fireEvent.click(screen.getByRole("combobox", { name: label }));
    fireEvent.click(screen.getByRole("option", { name: option }));
}

export function diagnostic(
    code: string,
    message: string,
    severity: "info" | "warning" | "error" = "error",
): ProtocolDiagnosticV1 {
    return {
        severity,
        code,
        operation: "version",
        causeKind: "conflict",
        retryable: true,
        suggestedActions: ["retry"],
        message,
    };
}

export const INVALID_READ_PREVIEW = {
    status: "failed" as const,
    diagnostics: [diagnostic("import.read_snapshot_invalid", "Preview requires complete validated read-result closures.")],
};

export function candidate(
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

export const WORKFLOW_BINDING = {
    subject: { subjectKind: "workflow_execution_agent" as const },
    rawTarget: "reviewer",
    required: true,
};

export const OPTIONAL_FILE_BINDING = {
    subject: { subjectKind: "file_reference" as const, logicalPath: "nested.md", referenceIndex: 0 },
    rawTarget: "./nested.md",
    required: false,
};

export const PREVIEW: ImportPreviewView = {
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

export const EXISTING_SUBAGENT = existingAsset(ASSET_ID, VERSION_ID, "Subagent", "Existing reviewer");
export const EXISTING_WORKFLOW = existingAsset(WORKFLOW_ASSET_ID, WORKFLOW_VERSION_ID, "Workflow", "Existing workflow");

export function fakeImportClient(overrides: Partial<DesktopApplicationClientApi> = {}): DesktopApplicationClientApi {
    return {
        listAssets: vi.fn(async () => ({ status: "complete", value: { assets: [] }, diagnostics: [] })),
        readSources: vi.fn(async () => ({
            status: "complete",
            value: { readToken: "read-token", reports: [], candidateCount: PREVIEW.candidates.length },
            diagnostics: [],
        })),
        previewImport: vi.fn(async () => ({ status: "complete", value: PREVIEW, diagnostics: [] })),
        getImportPreviewDetail: vi.fn(async (params) => ({
            status: "complete",
            value: {
                candidateId: params.candidateId,
                ...(params.logicalPath === undefined ? {} : { logicalPath: params.logicalPath }),
                mediaType: "text/markdown",
                contentKind: "text",
                text: { text: "# reviewed", byteLength: 10, truncated: false },
                byteLength: 10,
                contentHash: DIGEST,
            },
            diagnostics: [],
        })),
        cancelImportPreview: vi.fn(async () => ({ status: "complete", value: { cancelled: true }, diagnostics: [] })),
        acceptImportBatch: vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                items: [
                    {
                        status: "complete",
                        candidateId: "subagent",
                        version: { assetId: ASSET_ID, versionId: VERSION_ID },
                        diagnostics: [],
                    },
                    {
                        status: "complete",
                        candidateId: "workflow",
                        version: { assetId: ASSET_ID, versionId: VERSION_ID },
                        diagnostics: [],
                    },
                ],
            },
            diagnostics: [],
        })),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
}

export function controller(
    client: DesktopApplicationClientApi,
    createUserActionId: () => string = () => "user-action",
): ImportReviewController {
    return new ImportReviewController(client, { createUserActionId });
}
