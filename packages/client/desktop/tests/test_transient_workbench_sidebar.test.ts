import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransientWorkbenchSidebar } from "../src/renderer/shell/TransientWorkbenchSidebar";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function sidebar(persistentVisible: boolean): React.JSX.Element {
    return createElement(
        "div",
        undefined,
        createElement("button", { id: "sidebar-toggle", type: "button" }, "Toggle sidebar"),
        createElement(
            TransientWorkbenchSidebar,
            {
                "aria-label": "Current route",
                className: "test-sidebar",
                persistentVisible,
                restoreFocusElementId: "sidebar-toggle",
            },
            createElement("button", { type: "button" }, "First action"),
            createElement("button", { type: "button" }, "Second action"),
        ),
    );
}

describe("transient workbench sidebar", () => {
    it("reuses one route sidebar across persistent, edge-overlay, focus, and Escape states", () => {
        vi.useFakeTimers();
        const view = render(sidebar(false));
        const aside = screen.getByRole("complementary", { hidden: true });
        const edge = document.querySelector("[data-oaam-transient-sidebar-edge]");

        expect(edge).toBeInstanceOf(HTMLElement);
        expect(aside.hidden).toBe(true);
        expect(aside.dataset.oaamSidebarMode).toBe("transient");
        expect(screen.getAllByRole("button", { name: "First action", hidden: true })).toHaveLength(1);

        fireEvent.pointerEnter(edge as HTMLElement);
        expect(aside.hidden).toBe(false);
        expect(aside.dataset.oaamTransientPhase).toBe("open");

        fireEvent.pointerLeave(edge as HTMLElement);
        expect(aside.dataset.oaamTransientPhase).toBe("closing");
        fireEvent.pointerEnter(aside);
        act(() => vi.advanceTimersByTime(300));
        expect(aside.dataset.oaamTransientPhase).toBe("open");

        const firstAction = screen.getByRole("button", { name: "First action" });
        firstAction.focus();
        fireEvent.pointerLeave(aside);
        act(() => vi.advanceTimersByTime(300));
        expect(aside.dataset.oaamTransientPhase).toBe("open");

        fireEvent.keyDown(aside, { key: "Escape" });
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Toggle sidebar" }));
        expect(aside.dataset.oaamTransientPhase).toBe("closing");
        act(() => vi.advanceTimersByTime(221));
        expect(aside.hidden).toBe(true);

        view.rerender(sidebar(true));
        expect(document.querySelector("[data-oaam-transient-sidebar-edge]")).toBeNull();
        expect(aside.hidden).toBe(false);
        expect(aside.dataset.oaamSidebarMode).toBe("persistent");
        fireEvent.keyDown(aside, { key: "Escape" });
        expect(aside.hidden).toBe(false);
    });

    it("dismisses an unfocused overlay after the bounded delay and keeps internal focus movement open", () => {
        vi.useFakeTimers();
        render(sidebar(false));
        const aside = screen.getByRole("complementary", { hidden: true });
        const edge = document.querySelector("[data-oaam-transient-sidebar-edge]");
        if (!(edge instanceof HTMLElement)) throw new Error("transient edge is missing");

        fireEvent.pointerEnter(edge);
        fireEvent.pointerLeave(edge);
        fireEvent.pointerEnter(aside);
        const firstAction = screen.getByRole("button", { name: "First action" });
        const secondAction = screen.getByRole("button", { name: "Second action" });
        firstAction.focus();
        fireEvent.blur(firstAction, { relatedTarget: secondAction });
        secondAction.focus();
        expect(aside.dataset.oaamTransientPhase).toBe("open");

        fireEvent.pointerLeave(aside);
        const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
        fireEvent.blur(secondAction, { relatedTarget: toggle });
        toggle.focus();
        expect(aside.dataset.oaamTransientPhase).toBe("closing");
        act(() => vi.advanceTimersByTime(221));
        expect(aside.hidden).toBe(true);
    });

    it("clears an in-flight dismissal when the persistent preference becomes visible", () => {
        vi.useFakeTimers();
        const view = render(sidebar(false));
        const aside = screen.getByRole("complementary", { hidden: true });
        const edge = document.querySelector("[data-oaam-transient-sidebar-edge]");
        if (!(edge instanceof HTMLElement)) throw new Error("transient edge is missing");

        fireEvent.pointerEnter(edge);
        fireEvent.pointerLeave(edge);
        expect(aside.dataset.oaamTransientPhase).toBe("closing");
        view.rerender(sidebar(true));
        act(() => vi.runAllTimers());
        expect(aside.hidden).toBe(false);
        expect(aside.dataset.oaamSidebarMode).toBe("persistent");
    });
});
