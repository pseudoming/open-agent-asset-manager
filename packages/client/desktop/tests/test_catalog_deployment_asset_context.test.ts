import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CatalogDeploymentAssetStep,
    type CatalogDeploymentAssetStepProps,
} from "../src/renderer/features/catalog-deployment/CatalogDeploymentAssetStep";
import { ASSET } from "./catalog-deployment-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

function assetStep(overrides: Partial<CatalogDeploymentAssetStepProps> = {}) {
    return createElement(CatalogDeploymentAssetStep, {
        asset: ASSET,
        allowIncomplete: false,
        disabled: false,
        providers: [],
        onAllowIncompleteChange: vi.fn(),
        onPreview: vi.fn(),
        ...overrides,
    });
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("selected Asset context", () => {
    it("keeps the exact revision and preview while source evidence and incomplete consent retain their own actions", () => {
        const onPreview = vi.fn();
        const onAllowIncompleteChange = vi.fn();
        const { container } = renderWithPresentation(
            assetStep({
                asset: { ...ASSET, currentRevision: 7, currentVersionStatus: "incomplete" },
                onPreview,
                onAllowIncompleteChange,
                importSource: {
                    adapterId: "CLAUDECODE",
                    sourceSnapshotFingerprint: "a".repeat(64),
                    roots: [
                        {
                            sourceRootId: "source",
                            rootRole: "project_actual",
                            sourceDomain: "project_root",
                            canonicalPath: "/exact/import/source",
                        },
                    ],
                    files: [],
                },
            }),
        );
        const row = container.querySelector(".deployment-selected-asset-row");
        expect(row?.textContent).toContain(ASSET.displayName);
        expect(row?.textContent).toContain("Version 7");
        fireEvent.click(screen.getByRole("button", { name: "View current Version" }));
        expect(onPreview).toHaveBeenCalledTimes(1);
        const consent = screen.getByRole("checkbox");
        expect(row?.contains(consent)).toBe(false);
        expect((consent as HTMLInputElement).checked).toBe(false);
        fireEvent.click(consent);
        expect(onAllowIncompleteChange).toHaveBeenCalledWith(true);
        const details = container.querySelector<HTMLDetailsElement>(".deployment-selected-asset-source details");
        expect(row?.contains(details)).toBe(true);
        fireEvent.click(details?.querySelector("summary") as HTMLElement);
        expect(details?.open).toBe(true);
        expect(details?.textContent).toContain("/exact/import/source");
    });

    it("keeps disabled preview and incomplete consent unavailable", () => {
        const onPreview = vi.fn();
        const onAllowIncompleteChange = vi.fn();
        renderWithPresentation(
            assetStep({
                asset: { ...ASSET, currentVersionStatus: "incomplete" },
                disabled: true,
                onPreview,
                onAllowIncompleteChange,
            }),
        );
        const preview = screen.getByRole("button", { name: "View current Version" }) as HTMLButtonElement;
        const consent = screen.getByRole("checkbox") as HTMLInputElement;
        expect(preview.disabled).toBe(true);
        expect(consent.disabled).toBe(true);
        preview.click();
        consent.click();
        expect(onPreview).not.toHaveBeenCalled();
        expect(onAllowIncompleteChange).not.toHaveBeenCalled();
    });

    it("releases its page-local height when the context changes size, becomes hidden, or unmounts", () => {
        let resize: () => void = () => undefined;
        const observe = vi.fn();
        const disconnect = vi.fn();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(callback: () => void) {
                    resize = callback;
                }
                observe = observe;
                disconnect = disconnect;
            },
        );
        const { container, unmount } = renderWithPresentation(
            createElement(
                "div",
                null,
                createElement("div", { className: "deployment-page" }, assetStep()),
                createElement("div", { className: "deployment-page" }),
            ),
        );
        const [page, otherPage] = container.querySelectorAll<HTMLElement>(".deployment-page");
        const row = page.querySelector<HTMLElement>(".deployment-selected-asset-row");
        expect(observe).toHaveBeenCalledWith(row);
        // Controlled geometry checks observer ownership and cleanup; Electron proves visible layout.
        const bounds = vi.spyOn(row as HTMLElement, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 94));
        resize();
        expect(page.style.getPropertyValue("--oaam-deployment-context-height")).toBe("94px");
        expect(otherPage.style.getPropertyValue("--oaam-deployment-context-height")).toBe("");
        bounds.mockReturnValue(new DOMRect());
        resize();
        expect(page.style.getPropertyValue("--oaam-deployment-context-height")).toBe("0px");
        unmount();
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(page.style.getPropertyValue("--oaam-deployment-context-height")).toBe("");
    });

    it("reveals the visible label after native focus, without moving an already visible control or stale focus", () => {
        const frames: FrameRequestCallback[] = [];
        const cancelFrame = vi.fn();
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal("cancelAnimationFrame", cancelFrame);
        vi.stubGlobal("ResizeObserver", undefined);
        const { container, unmount } = renderWithPresentation(
            createElement(
                "div",
                { className: "deployment-page" },
                assetStep(),
                createElement(
                    "label",
                    null,
                    createElement("input", { className: "workbench-semantic-input", type: "checkbox" }),
                    "Selected tool",
                ),
                createElement("button", { type: "button" }, "Result action"),
            ),
        );
        const page = container.querySelector<HTMLElement>(".deployment-page") as HTMLElement;
        const row = page.querySelector<HTMLElement>(".deployment-selected-asset-row") as HTMLElement;
        const label = screen.getByText("Selected tool");
        const input = screen.getByRole("checkbox");
        const action = screen.getByRole("button", { name: "Result action" });
        vi.spyOn(page, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 42, 800, 600));
        const rowBounds = vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 42, 800, 60));
        vi.spyOn(label, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 200, 32));
        vi.spyOn(action, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 160, 200, 32));
        const labelScroll = vi.fn();
        const actionScroll = vi.fn();
        label.scrollIntoView = labelScroll;
        action.scrollIntoView = actionScroll;
        input.focus();
        frames.at(-1)?.(0);
        expect(labelScroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest", behavior: "instant" });
        action.focus();
        frames.at(-1)?.(0);
        expect(actionScroll).not.toHaveBeenCalled();
        input.focus();
        const stale = frames.at(-1);
        action.focus();
        stale?.(0);
        expect(labelScroll).toHaveBeenCalledTimes(1);
        rowBounds.mockReturnValue(new DOMRect(0, 200, 800, 60));
        input.focus();
        frames.at(-1)?.(0);
        expect(labelScroll).toHaveBeenCalledTimes(1);
        fireEvent(window, new Event("resize"));
        expect(page.style.getPropertyValue("--oaam-deployment-context-height")).toBe("60px");
        unmount();
        expect(cancelFrame).toHaveBeenCalled();
        expect(page.style.getPropertyValue("--oaam-deployment-context-height")).toBe("");
    });
});
