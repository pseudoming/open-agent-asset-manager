import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeploymentReviewFocus } from "../src/renderer/features/catalog-deployment/use-deployment-review-focus";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function Review({
    backgroundResult = "initial",
    versionUpdate = false,
    previewDeploymentId,
}: {
    backgroundResult?: string;
    versionUpdate?: boolean;
    previewDeploymentId?: string;
} = {}) {
    const { workspaceRef, requestReviewFocus, requestPreviewFocus } = useDeploymentReviewFocus();
    return createElement(
        "div",
        { ref: workspaceRef },
        createElement("button", { type: "button", onClick: requestReviewFocus }, "View selected usage"),
        createElement("button", { type: "button", onClick: () => requestPreviewFocus("selected") }, "Complete requested preview"),
        previewDeploymentId === undefined
            ? null
            : createElement("div", { "data-oaam-preview-result": previewDeploymentId }, "Preview completed"),
        createElement(
            "section",
            versionUpdate ? { "data-oaam-version-update": true } : { "data-oaam-deployment-step": "review" },
            backgroundResult,
        ),
    );
}

describe("selected managed review visibility", () => {
    it.each([false, true])("focuses and scrolls the user-selected review once (Version update: %s)", (versionUpdate) => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal(
            "requestAnimationFrame",
            vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
        );
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        const scroll = vi.fn();
        vi.stubGlobal("innerHeight", 1080);
        const view = render(createElement(Review, { versionUpdate }));
        const section = view.container.querySelector("section")!;
        section.scrollIntoView = scroll;
        vi.spyOn(section, "getBoundingClientRect").mockReturnValue({ top: 1622, bottom: 1830 } as DOMRect);
        expect(frames).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "View selected usage" }));
        act(() => frames.shift()?.(1));
        expect(document.activeElement).toBe(section);
        expect(scroll).toHaveBeenCalledWith({ block: "start" });
        view.rerender(createElement(Review, { versionUpdate, backgroundResult: "Background check completed" }));
        expect(frames).toHaveLength(0);
        expect(scroll).toHaveBeenCalledOnce();
    });

    it("focuses an already visible result without scrolling", () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal(
            "requestAnimationFrame",
            vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
        );
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        const view = render(createElement(Review));
        const section = view.container.querySelector("section")!;
        const scroll = vi.fn();
        section.scrollIntoView = scroll;
        vi.spyOn(section, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 200 } as DOMRect);
        fireEvent.click(screen.getByRole("button", { name: "View selected usage" }));
        act(() => frames.shift()?.(1));
        expect(document.activeElement).toBe(section);
        expect(scroll).not.toHaveBeenCalled();
    });
    it.each([
        "selected",
        "other",
    ])("only focuses the completed preview for the requested Deployment (%s)", (previewDeploymentId) => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal(
            "requestAnimationFrame",
            vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
        );
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        vi.stubGlobal("innerHeight", 1080);
        const view = render(createElement(Review, { previewDeploymentId }));
        const result = view.container.querySelector<HTMLElement>("[data-oaam-preview-result]")!;
        const scroll = vi.fn();
        result.scrollIntoView = scroll;
        vi.spyOn(result, "getBoundingClientRect").mockReturnValue({ top: 1643, bottom: 1715 } as DOMRect);
        const priorFocus = document.activeElement;
        expect(frames).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "Complete requested preview" }));
        act(() => frames.shift()?.(1));
        if (previewDeploymentId === "selected") {
            expect(document.activeElement).toBe(result);
            expect(scroll).toHaveBeenCalledWith({ block: "start" });
        } else {
            expect(document.activeElement).toBe(priorFocus);
            expect(scroll).not.toHaveBeenCalled();
        }
        view.rerender(createElement(Review, { previewDeploymentId, backgroundResult: "Background refresh" }));
        expect(frames).toHaveLength(0);
    });
});
