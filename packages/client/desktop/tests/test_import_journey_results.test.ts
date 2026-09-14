import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { OnboardingPage } from "../src/renderer/pages/OnboardingPage";
import { ordinarySurfaceText, renderWithPresentation } from "./desktop-presentation-test-harness";
import { fakeImportableDiscoveryClient } from "./discovery-test-fixtures";

afterEach(cleanup);

describe("visible import outcomes in both user journeys", () => {
    it.each([
        "guided_import",
        "onboarding",
    ] as const)("%s keeps mixed batch outcomes visible after entering completion and never claims all selected Assets imported", async (route) => {
        const base = fakeImportableDiscoveryClient();
        const previewImport = vi.fn<DesktopApplicationClientApi["previewImport"]>(async (input) => {
            const original = await base.previewImport(input);
            if (original.status === "failed") throw new Error("expected importable fixture");
            const first = original.value.candidates[0];
            if (first === undefined) throw new Error("expected fixture candidate");
            return {
                ...original,
                value: {
                    ...original.value,
                    candidates: [first, { ...first, candidateId: "second", displayName: "Second guidance" }],
                },
            };
        });
        const failure: ProtocolDiagnosticV1 = {
            severity: "error",
            code: "test.import.attempt_failed",
            operation: "version",
            causeKind: "internal_error",
            retryable: true,
            suggestedActions: ["retry"],
            message: "First batch attempt failed.",
        };
        let releaseImport: (() => void) | undefined;
        const release = new Promise<void>((resolve) => {
            releaseImport = resolve;
        });
        const acceptImportBatch = vi
            .fn<DesktopApplicationClientApi["acceptImportBatch"]>()
            .mockResolvedValueOnce({ status: "failed", diagnostics: [failure] })
            .mockImplementationOnce(async () => {
                await release;
                return {
                    status: "partial",
                    value: {
                        schemaVersion: 1,
                        items: [
                            {
                                status: "complete",
                                candidateId: "guidance",
                                version: {
                                    assetId: "11111111-1111-4111-8111-111111111111",
                                    versionId: "22222222-2222-4222-8222-222222222222",
                                },
                                diagnostics: [],
                            },
                            {
                                status: "failed",
                                candidateId: "second",
                                diagnostics: [{ ...failure, code: "test.import.item_failed", message: "Second item failed." }],
                            },
                        ],
                    },
                    diagnostics: [{ ...failure, code: "test.import.batch_note", message: "Distinct batch-only evidence." }],
                };
            });
        const client = { ...base, previewImport, acceptImportBatch };
        const leave = vi.fn();
        const openImportedAsset = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("Asset lookup failed"));
        const catalogChanged = vi.fn(async () => undefined);
        const { container } = renderWithPresentation(
            route === "guided_import"
                ? createElement(GuidedImportPage, {
                      client,
                      assetCount: 0,
                      onClose: leave,
                      onCatalogChanged: catalogChanged,
                      onOpenImportedAsset: openImportedAsset,
                  })
                : createElement(OnboardingPage, {
                      client,
                      assetCount: 0,
                      onComplete: leave,
                      onCatalogChanged: catalogChanged,
                      onOpenImportedAsset: openImportedAsset,
                  }),
        );
        if (route === "onboarding") fireEvent.click(await screen.findByRole("button", { name: "Start guided setup" }));
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await screen.findByRole("heading", { name: "Review found locations" });
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await screen.findByRole("checkbox", { name: "Select Portable guidance" });
        fireEvent.click(screen.getByRole("button", { name: "Import selected Assets" }));
        await screen.findByText("The selected Assets were not imported.");
        expect(ordinarySurfaceText(container)).not.toContain("Review the latest result before continuing.");
        expect(ordinarySurfaceText(container)).not.toContain("OAAM could not finish checking this item.");
        expect(container.querySelectorAll(".import-review-main > .workbench-notice")).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "Import selected Assets" }));
        await screen.findByRole("button", { name: "Importing…" });
        expect(container.querySelector(".import-review-activity [data-oaam-loading-indicator]")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Importing…" }).hasAttribute("disabled")).toBe(true);
        await act(async () => releaseImport?.());
        await vi.waitFor(() => expect(container.querySelector("main")?.getAttribute("data-oaam-step")).toBe("complete"));

        expect(screen.queryByRole("heading", { name: "Import results" })).not.toBeNull();
        const items = [...container.querySelectorAll<HTMLElement>("[data-oaam-import-result-status]")];
        expect(items.map((item) => item.dataset.oaamImportResultStatus)).toEqual(["complete", "failed"]);
        expect(items.every((item) => item.closest("[hidden]") === null)).toBe(true);
        expect(ordinarySurfaceText(items[0] as HTMLElement)).toContain("New Asset saved in the OAAM library");
        expect(ordinarySurfaceText(items[0] as HTMLElement)).not.toMatch(/\bImported\b/u);
        expect(screen.getByText("Portable guidance")).not.toBeNull();
        expect(screen.getByText("Second guidance")).not.toBeNull();
        expect(screen.getByText(/Some Assets were imported and some were not/u)).not.toBeNull();
        expect(ordinarySurfaceText(container)).not.toContain("Review the latest result before continuing.");
        expect(ordinarySurfaceText(container)).not.toContain("OAAM could not finish checking this item.");
        expect(screen.getByText("To retry failed Assets, return to sources and select only those Assets.")).not.toBeNull();
        for (const raw of ["First batch attempt failed.", "Second item failed.", "Distinct batch-only evidence."]) {
            expect(container.textContent).toContain(raw);
            expect(ordinarySurfaceText(container)).not.toContain(raw);
        }
        expect(screen.queryByRole("heading", { name: /Selected Assets were imported|Safe import complete/u })).toBeNull();
        expect(acceptImportBatch).toHaveBeenCalledTimes(2);
        expect(acceptImportBatch.mock.calls[0]?.[0].decisions.map((decision) => decision.candidateId)).toEqual([
            "guidance",
            "second",
        ]);
        expect(catalogChanged).not.toHaveBeenCalled();
        expect(leave).not.toHaveBeenCalled();
        expect(base.cancelImportPreview).not.toHaveBeenCalled();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Asset" })));
        expect(
            await screen.findByText("The Asset was saved, but could not be opened. Try again or find it in the library."),
        ).toBeTruthy();
        expect(leave).not.toHaveBeenCalled();
        expect(acceptImportBatch).toHaveBeenCalledTimes(2);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Asset" })));
        await vi.waitFor(() =>
            expect(openImportedAsset).toHaveBeenCalledWith(
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
            ),
        );
        expect(openImportedAsset).toHaveBeenCalledTimes(2);
        expect(catalogChanged).toHaveBeenCalledTimes(2);
        expect(leave).not.toHaveBeenCalled();
    });
});
