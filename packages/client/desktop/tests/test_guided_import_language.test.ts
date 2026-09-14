import { cleanup } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopResolvedLocale,
} from "../src/presentation/presentation-preferences";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { createDesktopPresentationTestBridge, renderWithPresentation } from "./desktop-presentation-test-harness";
import { fakeDiscoveryClient } from "./discovery-test-fixtures";

afterEach(cleanup);

describe("Desktop guided-import language", () => {
    it.each([
        "en",
        "zh-CN",
        "de",
        "ja",
    ] as const)("keeps the %s journey shell free of internal architecture language", async (locale: DesktopResolvedLocale) => {
        const snapshot = createDesktopPresentationSnapshot(
            {
                ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                language: locale,
                onboardingCompleted: true,
            },
            [locale],
            false,
        );
        const { container } = renderWithPresentation(
            createElement(GuidedImportPage, {
                client: fakeDiscoveryClient(),
                assetCount: 0,
                onClose: vi.fn(),
            }),
            createDesktopPresentationTestBridge(snapshot),
        );

        await vi.waitFor(() => expect(container.querySelector("[data-oaam-provider-id]")).not.toBeNull());
        expect(container.querySelectorAll(".import-journey-steps > li")).toHaveLength(6);
        expect(container.textContent).not.toMatch(
            /\b(?:CLAUDECODE|OPENCODE|CLAUDE_CODE_CLI|agent_runtime_private|family_shared|rootRole|accessStatus)\b/u,
        );
        expect(container.textContent).not.toMatch(
            /\b(?:provider|adapter|runtime entr(?:y|ies)|source roots?|probe|rendered target)\b/iu,
        );
    });
});
