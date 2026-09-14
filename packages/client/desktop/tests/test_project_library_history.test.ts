import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import {
    ASSET,
    CrossProjectHistoryRestoreHarness,
    completedBridge,
    fakeClient,
    GLOBAL_ASSET,
    PROJECT,
    ProjectLibraryTestHarness,
    SECOND_ASSET,
    SECOND_ASSET_ID,
    SECOND_PROJECT,
    SECOND_PROJECT_ID,
} from "./project-library-test-fixtures";

afterEach(cleanup);

describe("Project library history and unavailable-operation boundaries", () => {
    it("restores an Asset only after its historical Project route becomes current", async () => {
        const fixture = fakeClient([PROJECT, SECOND_PROJECT], [ASSET, SECOND_ASSET, GLOBAL_ASSET]);
        renderWithPresentation(
            createElement(CrossProjectHistoryRestoreHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 3,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );
        await vi.waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: PROJECT.displayName })).not.toBeNull());

        fireEvent.click(screen.getByRole("button", { name: "Restore second Project Asset" }));
        await vi.waitFor(() =>
            expect(
                document.querySelector(`[data-oaam-route="library"][data-oaam-project-id="${SECOND_PROJECT_ID}"]`),
            ).not.toBeNull(),
        );
        await vi.waitFor(() => expect(fixture.client.getAsset).toHaveBeenCalledWith({ assetId: SECOND_ASSET_ID }));
        expect(fixture.client.listAssetVersions).toHaveBeenCalledWith({ assetId: SECOND_ASSET_ID, pageSize: 50 });
    });

    it("shows a retryable failure instead of an empty library when required operations are unavailable", async () => {
        const fixture = fakeClient();
        (fixture.client.supportsOperation as ReturnType<typeof vi.fn>).mockReturnValue(false);
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 0,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );
        await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
        expect(screen.getByRole("alert").getAttribute("data-oaam-tone")).toBe("danger");
        expect(screen.getByRole("heading", { name: "The library could not be loaded" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
        expect(fixture.client.listAssetKindCounts).not.toHaveBeenCalled();
    });
});
