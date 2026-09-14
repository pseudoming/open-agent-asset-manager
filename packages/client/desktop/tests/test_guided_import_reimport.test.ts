import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { OnboardingPage } from "../src/renderer/pages/OnboardingPage";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { fakeImportableDiscoveryClient } from "./discovery-test-fixtures";
import { controller, diagnostic, DIGEST, EXISTING_WORKFLOW, fakeImportClient, READ_PARAMS } from "./import-review-test-fixtures";

afterEach(cleanup);

const guidance = {
    ...EXISTING_WORKFLOW,
    assetId: "88888888-8888-4888-8888-888888888888",
    currentVersionId: "99999999-9999-4999-8999-999999999999",
    kind: "Guidance" as const,
    displayName: "Existing guidance",
    currentRevision: 2,
};

describe("Import an explicit new Version through the product journey", () => {
    it.each([
        "guided_import",
        "onboarding",
    ] as const)("loads destinations in %s and preserves the chosen parent", async (route) => {
        const base = fakeImportableDiscoveryClient();
        const client = {
            ...base,
            listAssets: vi.fn<DesktopApplicationClientApi["listAssets"]>(async () => ({
                status: "complete",
                value: { assets: [guidance, EXISTING_WORKFLOW, { ...guidance, assetId: "deleted", deleted: true }] },
                diagnostics: [],
            })),
        };
        renderWithPresentation(
            route === "guided_import"
                ? createElement(GuidedImportPage, { client, assetCount: 2, onClose: vi.fn() })
                : createElement(OnboardingPage, { client, assetCount: 2 }),
        );
        if (route === "onboarding") fireEvent.click(await screen.findByRole("button", { name: "Start guided setup" }));
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await screen.findByRole("heading", { name: "Review found locations" });
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        fireEvent.click(await screen.findByRole("combobox", { name: "How to save Portable guidance" }));
        expect(client.listAssets).toHaveBeenCalledOnce();
        expect(screen.getAllByRole("option")).toHaveLength(2);
        expect(client.acceptImportBatch).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("option", { name: "Add Version after Existing guidance revision 2" }));
        fireEvent.click(screen.getByRole("button", { name: "Import selected Assets" }));
        await screen.findByRole("heading", { name: "Import results" });
        expect(client.acceptImportBatch).toHaveBeenCalledWith({
            previewToken: "preview-token",
            expectedSnapshotFingerprint: DIGEST,
            decisions: [
                expect.objectContaining({
                    candidateId: "guidance",
                    action: "create_version",
                    assetId: guidance.assetId,
                    parentVersionId: guidance.currentVersionId,
                }),
            ],
        });
    });

    it("does not hide a failed library lookup behind a new-Asset-only review", async () => {
        const client = fakeImportClient({
            listAssets: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("catalog.unavailable", "Unavailable")],
            })),
        });
        const review = controller(client);
        await review.prepare(READ_PARAMS);
        await review.accept();
        expect(review.state).toMatchObject({ status: "failed", diagnostics: [{ code: "catalog.unavailable" }] });
        expect(client.previewImport).not.toHaveBeenCalled();
        expect(client.acceptImportBatch).not.toHaveBeenCalled();
    });

    it("ignores an older library lookup after a new source review begins", async () => {
        let release: ((value: Awaited<ReturnType<DesktopApplicationClientApi["listAssets"]>>) => void) | undefined;
        const delayed = new Promise<Awaited<ReturnType<DesktopApplicationClientApi["listAssets"]>>>((resolve) => {
            release = resolve;
        });
        const listAssets = vi
            .fn<DesktopApplicationClientApi["listAssets"]>()
            .mockReturnValueOnce(delayed)
            .mockResolvedValue({ status: "complete", value: { assets: [guidance] }, diagnostics: [] });
        const client = fakeImportClient({ listAssets });
        const review = controller(client);
        const first = review.prepare(READ_PARAMS);
        await vi.waitFor(() => expect(listAssets).toHaveBeenCalledOnce());
        await review.prepare(READ_PARAMS);
        await act(async () => {
            release?.({ status: "complete", value: { assets: [] }, diagnostics: [] });
            await first;
        });
        expect(client.previewImport).toHaveBeenCalledOnce();
        expect(review.state).toMatchObject({ status: "review", existingAssets: [guidance] });
    });
});
