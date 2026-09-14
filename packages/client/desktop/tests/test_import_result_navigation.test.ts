import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportReviewWorkspace } from "../src/renderer/features/import-review/ImportReviewWorkspace";
import { renderWithPresentation, ordinarySurfaceText } from "./desktop-presentation-test-harness";
import {
    candidate,
    controller,
    fakeImportClient,
    PREVIEW,
    READ_PARAMS,
    EXISTING_SUBAGENT,
    ASSET_ID,
    VERSION_ID,
} from "./import-review-test-fixtures";

afterEach(cleanup);

describe("exact import result navigation", () => {
    it("identifies a newly saved Version and opens only that returned Asset and Version", async () => {
        const client = fakeImportClient({
            listAssets: vi.fn(async () => ({ status: "complete", value: { assets: [EXISTING_SUBAGENT] }, diagnostics: [] })),
            previewImport: vi.fn(async () => ({
                status: "complete",
                value: { ...PREVIEW, candidates: [candidate("subagent", "Subagent")] },
                diagnostics: [],
            })),
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
                    ],
                },
                diagnostics: [],
            })),
        });
        const review = controller(client);
        const open = vi.fn().mockRejectedValueOnce(new Error("navigation unavailable")).mockResolvedValueOnce(undefined);
        const view = renderWithPresentation(
            createElement(ImportReviewWorkspace, { controller: review, onOpenImportedAsset: open }),
        );
        await act(async () => review.prepare(READ_PARAMS));
        act(() => review.setDestination("subagent", EXISTING_SUBAGENT));
        await act(async () => review.accept());
        expect(client.acceptImportBatch).toHaveBeenCalledWith(
            expect.objectContaining({ decisions: [expect.objectContaining({ action: "create_version" })] }),
        );
        expect(screen.getByText("New Version saved to the existing Asset")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("New Asset saved");
        expect(ordinarySurfaceText(view.container)).not.toContain("does not undo");
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Asset" })));
        expect(open).toHaveBeenCalledWith(ASSET_ID, VERSION_ID);
        expect(
            screen.getByText("The Asset was saved, but could not be opened. Try again or find it in the library."),
        ).not.toBeNull();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Asset" })));
        expect(open).toHaveBeenCalledTimes(2);
        expect(client.acceptImportBatch).toHaveBeenCalledOnce();
    });
});
