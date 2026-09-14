import { cleanup } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, it, vi } from "vitest";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { completedBridge, fakeClient, ProjectLibraryTestHarness } from "./project-library-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";

afterEach(cleanup);

describe("Project library semantic navigation", () => {
    it("keeps both catalog-warning and footer Settings entries on the same exact route", async () => {
        const openSettings = vi.fn();
        const openSearch = vi.fn();
        const openSources = vi.fn();
        const openGuidedImport = vi.fn();
        const openDeployments = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fakeClient().client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 1,
                catalogWarningCount: 1,
                onOpenSettings: openSettings,
                onOpenSearch: openSearch,
                onOpenSources: openSources,
                onOpenGuidedImport: openGuidedImport,
                onOpenDeployments: openDeployments,
            }),
            completedBridge(),
        );
        const unrelated = [openSearch, openSources, openGuidedImport, openDeployments];
        await clickSemanticAction("library.settings.warning", "library.open_settings", {
            expected: openSettings,
            expectedArgs: [],
            unrelated,
        });
        await clickSemanticAction("library.settings.footer", "library.open_settings", {
            expected: openSettings,
            expectedArgs: [],
            unrelated,
        });
    });
});
