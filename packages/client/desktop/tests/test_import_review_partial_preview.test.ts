import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import {
    candidate,
    controller,
    diagnostic,
    fakeImportClient,
    INVALID_READ_PREVIEW,
    PREVIEW,
    READ_PREPARATION,
} from "./import-review-test-fixtures";

const preparation = {
    request: {
        probeToken: "probe-token",
        selections: [
            ...READ_PREPARATION.request.selections,
            { probeResultRowId: "failed-probe-row", sourceRootRowIds: ["failed-source-row"] },
        ],
    },
    sources: [
        ...READ_PREPARATION.sources,
        {
            ...READ_PREPARATION.sources[0],
            adapterId: "failed-adapter",
            probeResultRowId: "failed-probe-row",
            sourceRootRowId: "failed-source-row",
            sourceRootId: "failed-source-root",
        },
    ],
} as const;

const readFailure = diagnostic("read.source_capability_unavailable", "Another source could not be read.");
const parseWarning = diagnostic("source.parse_warning", "Retained source note.", "warning");
const mixedRead = {
    status: "partial" as const,
    value: {
        readToken: "complete-batches-from-mixed-request",
        candidateCount: 1,
        reports: [
            {
                adapterId: "adapter",
                agentRuntimeId: "AGENT_CLI",
                sourceRootId: "source-root",
                status: "complete" as const,
                candidateCount: 1,
                diagnostics: [parseWarning],
            },
        ],
    },
    diagnostics: [readFailure],
};
const preview = { ...PREVIEW, candidates: [candidate("skill", "Skill")] };

function mixedClient(overrides: Partial<DesktopApplicationClientApi> = {}): DesktopApplicationClientApi {
    return fakeImportClient({
        readSources: vi.fn(async () => mixedRead),
        previewImport: vi.fn(async () => ({ status: "complete", value: preview, diagnostics: [] })),
        ...overrides,
    });
}

describe("Desktop preview of complete batches from a partial source request", () => {
    it("previews the same token once and retains missing-source issues and parse diagnostics", async () => {
        const client = mixedClient();
        const review = controller(client);

        await review.prepare(preparation);

        expect(client.readSources).toHaveBeenCalledOnce();
        expect(client.readSources).toHaveBeenCalledWith(preparation.request);
        expect(client.listAssets).toHaveBeenCalledOnce();
        expect(client.previewImport).toHaveBeenCalledOnce();
        expect(client.previewImport).toHaveBeenCalledWith({ readToken: mixedRead.value.readToken });
        expect(review.state).toMatchObject({
            status: "review",
            preview,
            selectedCandidateIds: ["skill"],
            readIssues: [{ sourceRootId: "failed-source-root", status: "unreported" }],
            diagnostics: [readFailure, parseWarning],
        });
    });

    it.each([
        { name: "empty diagnostics", codes: [], refreshRequired: false },
        { name: "expired token", codes: ["host.review_record_unavailable"], refreshRequired: true },
        { name: "changed source", codes: ["import.source_changed"], refreshRequired: true },
        { name: "catalog failure", codes: ["import.catalog_unavailable"], refreshRequired: false },
        {
            name: "mixed invalid-snapshot and stale diagnostics",
            codes: ["import.read_snapshot_invalid", "import.preview_tampered_or_stale"],
            refreshRequired: true,
        },
    ])("does not reread on $name", async ({ codes, refreshRequired }) => {
        const diagnostics = codes.map((code) => diagnostic(code, code));
        const client = mixedClient({ previewImport: vi.fn(async () => ({ status: "failed", diagnostics })) });
        const review = controller(client);

        await review.prepare(preparation);

        expect(client.readSources).toHaveBeenCalledOnce();
        expect(client.previewImport).toHaveBeenCalledOnce();
        expect(review.state).toMatchObject({
            status: "failed",
            preparation,
            diagnostics: [readFailure, parseWarning, ...diagnostics],
            refreshRequired,
        });
    });

    it("does not reinterpret a rejected complete read as permission to reread", async () => {
        const client = mixedClient({
            readSources: vi.fn(async () => ({ ...mixedRead, status: "complete" })),
            previewImport: vi.fn(async () => INVALID_READ_PREVIEW),
        });
        const review = controller(client);

        await review.prepare(preparation);

        expect(client.readSources).toHaveBeenCalledOnce();
        expect(review.state).toMatchObject({ status: "failed", preparation });
    });

    it("does not retry a thrown preview transport failure", async () => {
        const client = mixedClient({
            previewImport: vi.fn(async () => {
                throw new Error("connection ended");
            }),
        });
        const review = controller(client);

        await review.prepare(preparation);

        expect(client.readSources).toHaveBeenCalledOnce();
        expect(review.state).toMatchObject({ status: "failed", preparation });
    });

    it("keeps the original selection when the permitted readable-location retry fails", async () => {
        const client = mixedClient({
            readSources: vi
                .fn<DesktopApplicationClientApi["readSources"]>()
                .mockResolvedValueOnce(mixedRead)
                .mockResolvedValueOnce({ status: "failed", diagnostics: [readFailure] }),
            previewImport: vi.fn(async () => INVALID_READ_PREVIEW),
        });
        const review = controller(client);

        await review.prepare(preparation);

        expect(client.readSources).toHaveBeenCalledTimes(2);
        expect(client.readSources).toHaveBeenLastCalledWith(READ_PREPARATION.request);
        expect(client.previewImport).toHaveBeenCalledOnce();
        expect(review.state).toMatchObject({ status: "failed", preparation });
    });

    it("ignores an old preview failure after a newer preparation completes", async () => {
        let finishOldPreview: (value: Awaited<ReturnType<DesktopApplicationClientApi["previewImport"]>>) => void = () => {
            throw new Error("old preview has not started");
        };
        const currentPreview = { ...preview, previewToken: "new-preview" };
        const client = mixedClient({
            previewImport: vi
                .fn<DesktopApplicationClientApi["previewImport"]>()
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            finishOldPreview = resolve;
                        }),
                )
                .mockResolvedValue({ status: "complete", value: currentPreview, diagnostics: [] }),
        });
        const review = controller(client);
        const old = review.prepare(preparation);
        await vi.waitFor(() => expect(client.previewImport).toHaveBeenCalledOnce());
        await review.prepare(preparation);
        finishOldPreview(INVALID_READ_PREVIEW);
        await old;

        expect(client.readSources).toHaveBeenCalledTimes(2);
        expect(client.previewImport).toHaveBeenCalledTimes(2);
        expect(review.state).toMatchObject({ status: "review", preview: currentPreview });
    });

    it("cancels the retained preview and performs a new read on the next user preparation", async () => {
        const client = mixedClient();
        const review = controller(client);
        await review.prepare(preparation);

        await review.cancel();

        expect(client.cancelImportPreview).toHaveBeenCalledWith({ previewToken: preview.previewToken });
        expect(review.state).toMatchObject({ status: "idle" });
        await review.prepare(preparation);
        expect(client.readSources).toHaveBeenCalledTimes(2);
        expect(client.previewImport).toHaveBeenCalledTimes(2);
    });

    it("requests fresh source verification at acceptance and retains the changed-source failure", async () => {
        const changed = diagnostic("import.source_changed", "Source bytes changed after preview.");
        const client = mixedClient({
            acceptImportBatch: vi.fn(async () => ({ status: "failed", diagnostics: [changed] })),
        });
        const review = controller(client);
        await review.prepare(preparation);

        await review.accept();

        expect(client.acceptImportBatch).toHaveBeenCalledOnce();
        expect(client.acceptImportBatch).toHaveBeenCalledWith(
            expect.objectContaining({
                previewToken: preview.previewToken,
                decisions: [expect.objectContaining({ freshness: { freshnessAction: "require_current_source" } })],
            }),
        );
        expect(review.state).toMatchObject({ status: "review", activity: "accept_failed", refreshRequired: true });
        expect(client.readSources).toHaveBeenCalledOnce();
    });
});
