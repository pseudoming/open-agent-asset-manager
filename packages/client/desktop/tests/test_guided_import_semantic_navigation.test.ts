import { cleanup, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, it, vi } from "vitest";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { fakeDiscoveryClient } from "./discovery-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";

afterEach(cleanup);

describe("Guided-import semantic navigation", () => {
    it("closes from the page header through the exact guarded route", async () => {
        const close = vi.fn();
        renderWithPresentation(createElement(GuidedImportPage, { client: fakeDiscoveryClient(), assetCount: 0, onClose: close }));
        await clickSemanticAction("guided_import.previous.header", "guided_import.open_previous", {
            expected: close,
            expectedArgs: [],
            unrelated: [],
        });
    });

    it("maps the first journey Back control to the same guarded owner route", async () => {
        const close = vi.fn();
        const client = fakeDiscoveryClient({
            listEnvironments: vi.fn(async () => ({
                status: "complete",
                value: {
                    environments: [
                        { environment: { platform: "linux", platformInstanceId: "local" }, displayName: "Local Linux" },
                        { environment: { platform: "wsl", platformInstanceId: "Ubuntu" }, displayName: "WSL — Ubuntu" },
                    ],
                },
                diagnostics: [],
            })),
        });
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: close }));
        await screen.findByRole("button", { name: "Back" });
        await clickSemanticAction("journey.locations.back", "journey.go_back", {
            expected: close,
            expectedArgs: [],
            unrelated: [],
        });
    });
});
