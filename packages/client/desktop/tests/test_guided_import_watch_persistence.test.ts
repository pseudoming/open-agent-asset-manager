import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { EMPTY_WATCHED, fakeDiscoveryClient, PROBE } from "./discovery-test-fixtures";

afterEach(cleanup);

function sourceCard(path: string): HTMLElement {
    const card = [...document.querySelectorAll<HTMLElement>("[data-oaam-source-path]")].find(
        (candidate) => candidate.dataset.oaamSourcePath === path,
    );
    if (card === undefined) throw new Error(`Source card ${path} is required`);
    return card;
}

async function reachSourceReview(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    await screen.findByRole("heading", { name: "Review found locations" });
}

async function ignoreSource(path: string, client: DesktopApplicationClientApi): Promise<void> {
    const replaceWatchedScanIntent = client.replaceWatchedScanIntent as ReturnType<typeof vi.fn>;
    const callCount = replaceWatchedScanIntent.mock.calls.length;
    fireEvent.click(within(sourceCard(path)).getByRole("button", { name: "Ignore this location" }));
    fireEvent.click(within(sourceCard(path)).getByRole("button", { name: "Ignore" }));
    await vi.waitFor(() => expect(replaceWatchedScanIntent).toHaveBeenCalledTimes(callCount + 1));
}

describe("Desktop guided-import watch persistence", () => {
    it("saves a confirmed ignore immediately and starts a later scan with the same compact ignored card", async () => {
        let watched = EMPTY_WATCHED;
        const replaceWatchedScanIntent = vi.fn(async (params) => {
            watched = {
                configVersion: 1 as const,
                settingId: "watched_scan_intent_v1" as const,
                revision: 1,
                environments: [
                    {
                        environment: PROBE.results[0]?.environment ?? { platform: "linux", platformInstanceId: "local" },
                        sourceSelectors: [
                            {
                                disposition: "included" as const,
                                source: {
                                    adapterId: "CLAUDECODE",
                                    rootRole: "source" as const,
                                    sourceDomain: "project_root" as const,
                                    canonicalPath: "/new",
                                    locatorIdentities: [{ locatorKind: "runtime_known_rule" as const, locatorKey: "moved" }],
                                },
                                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                                binding: { assetScope: "global" as const },
                                selectorFingerprint: "b".repeat(64),
                            },
                            {
                                disposition: "excluded" as const,
                                source: {
                                    adapterId: "CLAUDECODE",
                                    rootRole: "source" as const,
                                    sourceDomain: "project_root" as const,
                                    canonicalPath: "/brand-new",
                                    locatorIdentities: [{ locatorKind: "runtime_known_rule" as const, locatorKey: "new" }],
                                },
                                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                                selectorFingerprint: "c".repeat(64),
                            },
                        ],
                    },
                ],
                userActionEvidenceId: params.userActionId,
                updatedAt: 2,
                settingFingerprint: "d".repeat(64),
            };
            return { status: "complete" as const, value: watched, diagnostics: [] };
        });
        const client = fakeDiscoveryClient({
            getWatchedScanIntent: vi.fn(async () => ({ status: "complete" as const, value: watched, diagnostics: [] })),
            replaceWatchedScanIntent,
        });
        const first = renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));

        await reachSourceReview();
        await ignoreSource("/brand-new", client);
        expect(replaceWatchedScanIntent).toHaveBeenCalledOnce();
        expect(sourceCard("/brand-new").dataset.oaamSourceState).toBe("ignored");
        first.unmount();

        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));
        await reachSourceReview();
        const ignoredCard = sourceCard("/brand-new");
        expect(ignoredCard.dataset.oaamSourceState).toBe("ignored");
        expect(within(ignoredCard).getByText("Not included in scans")).not.toBeNull();
        expect(within(ignoredCard).queryByText("Technical details")).toBeNull();
        expect(within(ignoredCard).getByRole("button", { name: "Include again" })).not.toBeNull();
    });
});
