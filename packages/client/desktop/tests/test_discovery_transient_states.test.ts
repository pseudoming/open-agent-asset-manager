import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { DiscoveryWorkspace } from "../src/renderer/features/discovery/DiscoveryWorkspace";
import { DiscoveryController } from "../src/renderer/features/discovery/discovery-controller";
import type { ProbeReviewView } from "../src/renderer/features/discovery/discovery-model";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { diagnostic, DIGEST, ENABLEMENT, fakeDiscoveryClient, PROVIDERS } from "./discovery-test-fixtures";

afterEach(cleanup);

describe("Desktop discovery transient states", () => {
    it("renders a failed initial load and retries the same controller instead of inventing empty provider data", async () => {
        const listAdapterProviders = vi
            .fn()
            .mockRejectedValueOnce(new Error("transport closed"))
            .mockResolvedValueOnce({ status: "complete", value: { providers: PROVIDERS }, diagnostics: [] });
        const controller = new DiscoveryController(fakeDiscoveryClient({ listAdapterProviders }), {
            createUserActionId: () => "action",
        });
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: vi.fn() }));
        await vi.waitFor(() => expect(screen.queryByText("OAAM could not load your scan choices.")).not.toBeNull());
        expect(screen.getByRole("alert").getAttribute("data-oaam-tone")).toBe("danger");
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await vi.waitFor(() => expect(screen.queryByText("Claude Code")).not.toBeNull());
        expect(listAdapterProviders).toHaveBeenCalledTimes(2);
    });

    it("shows real saving and probing states, empty snapshots, and retry after a failed scan", async () => {
        let resolveSave:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["replaceAdapterEnablement"]>>) => void)
            | undefined;
        let resolveProbe: ((value: Awaited<ReturnType<DesktopApplicationClientApi["probeGlobal"]>>) => void) | undefined;
        const emptyWatched = {
            configVersion: 1 as const,
            settingId: "watched_scan_intent_v1" as const,
            revision: 0 as const,
            environments: [] as const,
            updatedAt: 0 as const,
            settingFingerprint: DIGEST,
        };
        const emptyProbe: ProbeReviewView = { probeToken: "empty-probe", results: [] };
        const client = fakeDiscoveryClient({
            getWatchedScanIntent: vi.fn(async () => ({ status: "complete", value: emptyWatched, diagnostics: [] })),
            replaceAdapterEnablement: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveSave = resolve;
                    }),
            ),
            probeGlobal: vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            resolveProbe = resolve;
                        }),
                )
                .mockResolvedValueOnce({ status: "failed", diagnostics: [diagnostic("Scan failed after retry.")] }),
        });
        const controller = new DiscoveryController(client, { createUserActionId: () => "action" });
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: vi.fn() }));
        await vi.waitFor(() => expect(screen.queryByText("OpenCode")).not.toBeNull());
        fireEvent.click(screen.getByRole("checkbox", { name: /OpenCode/u }));
        fireEvent.click(screen.getByRole("button", { name: "Save choices" }));
        expect(screen.queryByRole("button", { name: "Saving choices…" })).not.toBeNull();
        resolveSave?.({
            status: "complete",
            value: { ...ENABLEMENT, revision: 2, enabledAdapterIds: ["CLAUDECODE", "OPENCODE"] },
            diagnostics: [],
        });
        await vi.waitFor(() => expect(screen.queryByText(/tool choices were saved/u)).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
        await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Scanning…" })).not.toBeNull());
        resolveProbe?.({ status: "complete", value: emptyProbe, diagnostics: [] });
        await vi.waitFor(() =>
            expect(screen.queryByText("No local asset locations were found for the selected tools.")).not.toBeNull(),
        );
        expect(
            screen.getByText("No local asset locations were found for the selected tools.").getAttribute("data-oaam-tone"),
        ).toBe("empty");
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
        await vi.waitFor(() => expect(screen.queryByText("The scan did not finish with trustworthy results.")).not.toBeNull());
        expect(screen.queryByText("Scan failed after retry.")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Try scan again" }));
        expect(client.probeGlobal).toHaveBeenCalledTimes(3);
    });
});
