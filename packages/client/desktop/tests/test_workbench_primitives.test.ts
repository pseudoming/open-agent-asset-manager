import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    resolveWorkbenchTooltipPosition,
    StatusPanel,
    WorkbenchBadge,
    WorkbenchConfirmation,
    WorkbenchDialog,
    WorkbenchIconButton,
    WorkbenchNotice,
    WorkbenchPanel,
    WorkbenchPressedFilter,
    WorkbenchRadioButton,
    WorkbenchResizeSeparator,
    WorkbenchSelect,
    WorkbenchSelectableCard,
    WorkbenchSwitch,
    WorkbenchTechnicalFact,
    WorkbenchTooltipButton,
} from "../src/renderer/ui";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("Desktop workbench presentation primitives", () => {
    it("keeps technical evidence accessible behind one compact information control", () => {
        vi.useFakeTimers();
        class TestResizeObserver {
            public observe = vi.fn();
            public disconnect = vi.fn();
            public unobserve = vi.fn();
        }
        vi.stubGlobal("ResizeObserver", TestResizeObserver);
        const { container } = render(
            createElement(
                WorkbenchTechnicalFact,
                { fact: createElement("span", null, "Updated today"), summary: "Technical details" },
                createElement("code", null, "Exact internal identity"),
            ),
        );

        const details = container.querySelector("details");
        const summary = screen.getByText("Technical details").closest("summary");
        expect(details?.getAttribute("data-oaam-technical-detail")).toBe("true");
        expect(screen.getByText("Updated today")).toBeTruthy();
        expect(summary?.querySelector("[data-oaam-icon='info']")).not.toBeNull();
        fireEvent.pointerEnter(summary as HTMLElement);
        expect(screen.getByRole("tooltip", { name: "Technical details" })).toBeTruthy();
        act(() => vi.advanceTimersByTime(3_000));
        expect(screen.queryByRole("tooltip")).toBeNull();
        fireEvent.pointerLeave(summary as HTMLElement);
        fireEvent.focus(summary as HTMLElement);
        expect(screen.getByRole("tooltip", { name: "Technical details" })).toBeTruthy();
        fireEvent.blur(summary as HTMLElement);
        expect(screen.queryByRole("tooltip")).toBeNull();
        fireEvent.pointerEnter(summary as HTMLElement);
        fireEvent.click(summary as HTMLElement);
        expect(details?.open).toBe(true);
        expect(screen.queryByRole("tooltip")).toBeNull();
        expect(screen.getByText("Exact internal identity")).toBeTruthy();
    });

    it("keeps panel hierarchy and badges presentation-only while exposing their selected appearance", () => {
        render(
            createElement(
                "div",
                null,
                createElement(
                    WorkbenchPanel,
                    { "aria-label": "Exact Project facts", className: "project-facts" },
                    createElement(WorkbenchBadge, { tone: "warning" }, "Partial"),
                    createElement(WorkbenchBadge, null, "Unknown"),
                ),
                createElement(WorkbenchPanel, { "aria-label": "Passive metadata", surface: "section" }, "Bounded-column section"),
            ),
        );

        const panel = screen.getByRole("region", { name: "Exact Project facts" });
        expect(panel.classList.contains("workbench-panel")).toBe(true);
        expect(panel.getAttribute("data-oaam-surface")).toBe("bounded");
        expect(panel.classList.contains("project-facts")).toBe(true);
        const section = screen.getByRole("region", { name: "Passive metadata" });
        expect(section.classList.contains("workbench-panel-section")).toBe(true);
        expect(section.getAttribute("data-oaam-surface")).toBe("section");
        expect(screen.getByText("Partial").getAttribute("data-oaam-tone")).toBe("warning");
        expect(screen.getByText("Unknown").getAttribute("data-oaam-tone")).toBe("neutral");
    });

    it("does not infer alert or status semantics from a notice tone", () => {
        const { rerender } = render(createElement(WorkbenchNotice, { tone: "danger" }, "Not yet an alert"));
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByText("Not yet an alert").getAttribute("data-oaam-tone")).toBe("danger");

        rerender(createElement(WorkbenchNotice, { tone: "danger", role: "alert" }, "Explicit alert"));
        expect(screen.getByRole("alert").textContent).toBe("Explicit alert");
    });

    it("distinguishes subordinate inline status from bounded safety notices without changing semantics", () => {
        render(
            createElement(
                "div",
                null,
                createElement(WorkbenchNotice, { surface: "inline", role: "status" }, "Current operation detail"),
                createElement(WorkbenchNotice, { tone: "danger", role: "alert" }, "Authorization failed"),
            ),
        );

        const status = screen.getByRole("status");
        expect(status.classList.contains("workbench-notice-inline")).toBe(true);
        expect(status.getAttribute("data-oaam-surface")).toBe("inline");
        const alert = screen.getByRole("alert");
        expect(alert.classList.contains("workbench-notice-bounded")).toBe(true);
        expect(alert.getAttribute("data-oaam-surface")).toBe("bounded");
    });

    it("makes busy and failed state semantics explicit without changing their content contract", () => {
        const { rerender } = render(
            createElement(StatusPanel, {
                eyebrow: "Library",
                title: "Loading",
                message: "Reading bounded metadata",
                busy: true,
            }),
        );
        expect(screen.getByRole("status").textContent).toBe("Reading bounded metadata");
        expect(screen.queryByRole("alert")).toBeNull();

        rerender(
            createElement(StatusPanel, {
                eyebrow: "Library",
                title: "Unavailable",
                message: "The exact query failed",
                compact: true,
                tone: "danger",
            }),
        );
        const alert = screen.getByRole("alert");
        expect(alert.classList.contains("status-card-compact")).toBe(true);
        expect(alert.getAttribute("data-oaam-tone")).toBe("danger");
    });

    it("lets an owned feedback child supply the only status explanation", () => {
        const { container } = render(
            createElement(StatusPanel, { title: "Unavailable", tone: "danger" }, createElement("p", null, "Retry this query")),
        );
        expect(screen.getByRole("alert").textContent).toBe("UnavailableRetry this query");
        expect(container.querySelectorAll(".status-card > p")).toHaveLength(1);
    });

    it("keeps compact icon actions labeled and separates pressed, selected, switched, and confirmation semantics", () => {
        const onSwitch = vi.fn();
        const onConfirm = vi.fn();
        const onRadio = vi.fn();
        render(
            createElement(
                "div",
                null,
                createElement(WorkbenchIconButton, { icon: "refresh", label: "Refresh assets" }),
                createElement(WorkbenchPressedFilter, { pressed: true }, "Deleted assets"),
                createElement(WorkbenchSelectableCard, { selected: false, onSelectedChange: vi.fn() }, "Windows"),
                createElement(
                    WorkbenchSelectableCard,
                    {
                        selected: true,
                        selectionMode: "single",
                        selectionName: "project-environment",
                        onSelectedChange: vi.fn(),
                    },
                    "WSL Ubuntu",
                ),
                createElement(
                    WorkbenchRadioButton,
                    {
                        checked: false,
                        name: "file-format",
                        value: "native",
                        onCheckedChange: onRadio,
                    },
                    "Native file",
                ),
                createElement(WorkbenchSwitch, {
                    checked: true,
                    label: "Follow system theme",
                    description: "Use the current operating-system appearance.",
                    onCheckedChange: onSwitch,
                }),
                createElement(
                    WorkbenchConfirmation,
                    { checked: false, onCheckedChange: onConfirm },
                    "I understand this removes the backup.",
                ),
            ),
        );

        const refresh = screen.getByRole("button", { name: "Refresh assets" });
        expect(refresh.querySelector("[data-oaam-icon='refresh']")).not.toBeNull();
        expect(refresh.getAttribute("data-tooltip")).toBe("Refresh assets");
        expect(screen.getByRole("button", { name: "Deleted assets" }).getAttribute("aria-pressed")).toBe("true");
        expect((screen.getByRole("checkbox", { name: "Windows" }) as HTMLInputElement).checked).toBe(false);
        expect(screen.getByRole<HTMLInputElement>("radio", { name: "WSL Ubuntu" })).toMatchObject({
            checked: true,
            name: "project-environment",
        });
        const radio = screen.getByRole("radio", { name: "Native file" });
        expect((radio as HTMLInputElement).checked).toBe(false);
        fireEvent.click(radio);
        expect(onRadio).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("switch", { name: /Follow system theme/u }));
        expect(onSwitch).toHaveBeenCalledWith(false);
        fireEvent.click(screen.getByRole("checkbox", { name: "I understand this removes the backup." }));
        expect(onConfirm).toHaveBeenCalledWith(true);
    });

    it("keeps tooltip geometry inside every viewport edge and exposes it through hover, focus, and Escape", () => {
        let resizeTooltip: (() => void) | undefined;
        const observe = vi.fn();
        const disconnect = vi.fn();
        class TestResizeObserver {
            public constructor(callback: () => void) {
                resizeTooltip = callback;
            }

            public observe = observe;
            public disconnect = disconnect;
            public unobserve = vi.fn();
        }
        vi.stubGlobal("ResizeObserver", TestResizeObserver);
        const viewport = { width: 200, height: 120 };
        const tooltip = { width: 80, height: 20 };
        expect(resolveWorkbenchTooltipPosition({ left: 0, right: 30, top: 0, bottom: 30 }, tooltip, viewport)).toEqual({
            left: 8,
            placement: "below",
            top: 36,
        });
        expect(resolveWorkbenchTooltipPosition({ left: 168, right: 198, top: 0, bottom: 30 }, tooltip, viewport)).toEqual({
            left: 112,
            placement: "below",
            top: 36,
        });
        expect(resolveWorkbenchTooltipPosition({ left: 80, right: 110, top: 2, bottom: 32 }, tooltip, viewport)).toEqual({
            left: 55,
            placement: "below",
            top: 38,
        });
        expect(resolveWorkbenchTooltipPosition({ left: 80, right: 110, top: 88, bottom: 118 }, tooltip, viewport)).toEqual({
            left: 55,
            placement: "above",
            top: 62,
        });

        render(createElement(WorkbenchIconButton, { icon: "sidebar", label: "Toggle sidebar" }));
        const button = screen.getByRole("button", { name: "Toggle sidebar" });
        vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
            bottom: 30,
            height: 30,
            left: 0,
            right: 30,
            top: 0,
            width: 30,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        fireEvent.pointerEnter(button);
        const pointerTooltip = screen.getByRole("tooltip", { name: "Toggle sidebar" });
        expect(button.getAttribute("aria-describedby")).toBe(pointerTooltip.id);
        expect(pointerTooltip.parentElement).toBe(document.body);
        vi.spyOn(pointerTooltip, "getBoundingClientRect").mockReturnValue({
            bottom: 20,
            height: 20,
            left: 0,
            right: 80,
            top: 0,
            width: 80,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        fireEvent(window, new Event("resize"));
        resizeTooltip?.();
        resizeTooltip?.();
        expect(pointerTooltip.getAttribute("data-ready")).toBe("true");
        expect(pointerTooltip.style.left).toBe("8px");
        expect(observe).toHaveBeenCalledTimes(2);

        fireEvent.keyDown(button, { key: "Escape" });
        expect(screen.queryByRole("tooltip")).toBeNull();
        expect(disconnect).toHaveBeenCalledOnce();
        fireEvent.pointerLeave(button);
        fireEvent.focus(button);
        expect(screen.getByRole("tooltip", { name: "Toggle sidebar" })).not.toBeNull();
        fireEvent.blur(button);
        expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("dismisses focused tooltips after pointer exit, action, and a bounded failsafe", () => {
        vi.useFakeTimers();
        const onIconAction = vi.fn();
        const onTextAction = vi.fn();
        render(
            createElement(
                "div",
                null,
                createElement(WorkbenchIconButton, {
                    icon: "back",
                    label: "Go back",
                    onClick: onIconAction,
                }),
                createElement(WorkbenchTooltipButton, { tooltip: "More actions", onClick: onTextAction }, "Open menu"),
            ),
        );

        const icon = screen.getByRole("button", { name: "Go back" });
        act(() => icon.focus());
        fireEvent.pointerEnter(icon);
        expect(screen.getByRole("tooltip", { name: "Go back" })).not.toBeNull();
        fireEvent.pointerLeave(icon);
        expect(document.activeElement).toBe(icon);
        expect(screen.queryByRole("tooltip", { name: "Go back" })).toBeNull();

        fireEvent.pointerEnter(icon);
        fireEvent.click(icon);
        expect(onIconAction).toHaveBeenCalledOnce();
        expect(screen.queryByRole("tooltip", { name: "Go back" })).toBeNull();

        const text = screen.getByRole("button", { name: "Open menu" });
        fireEvent.pointerEnter(text);
        expect(screen.getByRole("tooltip", { name: "More actions" })).not.toBeNull();
        act(() => vi.advanceTimersByTime(3_000));
        expect(screen.queryByRole("tooltip", { name: "More actions" })).toBeNull();
        fireEvent.pointerLeave(text);
        fireEvent.pointerEnter(text);
        fireEvent.click(text);
        expect(onTextAction).toHaveBeenCalledOnce();
        expect(screen.queryByRole("tooltip", { name: "More actions" })).toBeNull();
    });

    it("opens one accessible listbox, moves keyboard focus, and commits only an enabled option", async () => {
        const onChange = vi.fn();
        render(
            createElement(WorkbenchSelect, {
                value: "system",
                label: "Theme",
                onChange,
                options: [
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark", disabled: true },
                ],
            }),
        );

        const trigger = screen.getByRole("combobox", { name: "Theme" });
        fireEvent.click(trigger);
        const listbox = screen.getByRole("listbox", { name: "Theme" });
        expect(screen.getByRole("option", { name: "System" }).getAttribute("aria-selected")).toBe("true");
        fireEvent.keyDown(listbox, { key: "ArrowDown" });
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Light" })));
        fireEvent.click(screen.getByRole("option", { name: "Light" }));
        expect(onChange).toHaveBeenCalledWith("light");
        expect(screen.queryByRole("listbox")).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it("keeps disabled settings inert and preserves explicit control attributes", () => {
        const onSwitch = vi.fn();
        const onConfirm = vi.fn();
        render(
            createElement(
                "form",
                null,
                createElement(WorkbenchIconButton, {
                    className: "toolbar-refresh",
                    icon: "refresh",
                    label: "Refresh",
                    tooltip: "Refresh the current view",
                    type: "submit",
                }),
                createElement(WorkbenchPressedFilter, { pressed: false, type: "submit" }, "Available"),
                createElement(WorkbenchSelectableCard, { selected: true, onSelectedChange: vi.fn() }, "WSL"),
                createElement(WorkbenchSwitch, {
                    checked: false,
                    disabled: true,
                    label: "Automatic scan",
                    onCheckedChange: onSwitch,
                }),
                createElement(
                    WorkbenchConfirmation,
                    {
                        checked: true,
                        className: "danger-confirmation",
                        disabled: true,
                        onCheckedChange: onConfirm,
                    },
                    "Delete the reviewed backup",
                ),
            ),
        );

        const refresh = screen.getByRole("button", { name: "Refresh" });
        expect(refresh.getAttribute("type")).toBe("submit");
        expect(refresh.getAttribute("data-tooltip")).toBe("Refresh the current view");
        expect(refresh.classList.contains("toolbar-refresh")).toBe(true);
        expect(screen.getByRole("button", { name: "Available" }).getAttribute("type")).toBe("submit");
        expect((screen.getByRole("checkbox", { name: "WSL" }) as HTMLInputElement).checked).toBe(true);
        expect(screen.queryByText("Use the current operating-system appearance.")).toBeNull();

        fireEvent.click(screen.getByRole("switch", { name: "Automatic scan" }));
        expect(screen.getByRole("checkbox", { name: "Delete the reviewed backup" }).hasAttribute("disabled")).toBe(true);
        expect(onSwitch).not.toHaveBeenCalled();
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.getByText("Delete the reviewed backup").parentElement?.classList.contains("danger-confirmation")).toBe(
            true,
        );
    });

    it("resizes one pane through bounded pointer and keyboard interaction", () => {
        function pointerEvent(
            type: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
            properties: { readonly button?: number; readonly clientX: number; readonly pointerId: number },
        ): Event {
            const event = new Event(type, { bubbles: true, cancelable: true });
            for (const [key, value] of Object.entries(properties)) {
                Object.defineProperty(event, key, { configurable: true, value });
            }
            return event;
        }

        const onPreview = vi.fn();
        const onCommit = vi.fn();
        const { rerender } = render(
            createElement(WorkbenchResizeSeparator, {
                label: "Left pane width",
                value: 288,
                minimum: 224,
                maximum: 400,
                onPreview,
                onCommit,
            }),
        );
        const separator = screen.getByRole("separator", { name: "Left pane width" });
        expect(separator.getAttribute("aria-valuenow")).toBe("288");

        fireEvent(separator, pointerEvent("pointerdown", { button: 0, pointerId: 7, clientX: 100 }));
        fireEvent(separator, pointerEvent("pointermove", { pointerId: 7, clientX: 137 }));
        fireEvent(separator, pointerEvent("pointerup", { pointerId: 7, clientX: 137 }));
        expect(onPreview).toHaveBeenLastCalledWith(325);
        expect(onCommit).toHaveBeenLastCalledWith(325);

        fireEvent.keyDown(separator, { key: "ArrowLeft" });
        expect(onPreview).toHaveBeenLastCalledWith(280);
        expect(onCommit).toHaveBeenLastCalledWith(280);
        fireEvent.keyDown(separator, { key: "ArrowRight" });
        expect(onPreview).toHaveBeenLastCalledWith(296);
        expect(onCommit).toHaveBeenLastCalledWith(296);
        fireEvent.keyDown(separator, { key: "Home" });
        expect(onCommit).toHaveBeenLastCalledWith(224);
        fireEvent.keyDown(separator, { key: "End" });
        expect(onCommit).toHaveBeenLastCalledWith(400);

        rerender(
            createElement(WorkbenchResizeSeparator, {
                label: "Right pane width",
                value: 336,
                minimum: 304,
                maximum: 448,
                direction: -1,
                onPreview,
                onCommit,
            }),
        );
        const rightSeparator = screen.getByRole("separator", { name: "Right pane width" });
        fireEvent(rightSeparator, pointerEvent("pointerdown", { button: 0, pointerId: 8, clientX: 200 }));
        fireEvent(rightSeparator, pointerEvent("pointermove", { pointerId: 8, clientX: 176 }));
        fireEvent(rightSeparator, pointerEvent("pointerup", { pointerId: 8, clientX: 176 }));
        expect(onPreview).toHaveBeenLastCalledWith(360);
        expect(onCommit).toHaveBeenLastCalledWith(360);

        onPreview.mockClear();
        onCommit.mockClear();
        fireEvent(rightSeparator, pointerEvent("pointerdown", { button: 0, pointerId: 9, clientX: 200 }));
        fireEvent(rightSeparator, pointerEvent("pointermove", { pointerId: 9, clientX: 160 }));
        fireEvent(rightSeparator, pointerEvent("pointercancel", { pointerId: 9, clientX: 160 }));
        expect(onPreview).toHaveBeenLastCalledWith(336);
        expect(onCommit).not.toHaveBeenCalled();
    });

    it("supports complete listbox keyboard closure, disabled-option, and outside-click behavior", async () => {
        const onChange = vi.fn();
        render(
            createElement(WorkbenchSelect, {
                value: "missing",
                label: "Language",
                onChange,
                options: [
                    { value: "system", label: "System", description: "Follow the operating system" },
                    { value: "blocked", label: "Unavailable", disabled: true },
                    { value: "ja", label: "日本語" },
                ],
            }),
        );

        const trigger = screen.getByRole("combobox", { name: "Language" });
        expect(trigger.textContent).toContain("missing");
        fireEvent.keyDown(trigger, { key: "ArrowUp" });
        const listbox = screen.getByRole("listbox", { name: "Language" });
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: /System/u })));
        expect(screen.getByText("Follow the operating system")).not.toBeNull();

        fireEvent.keyDown(listbox, { key: "End" });
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "日本語" })));
        fireEvent.keyDown(listbox, { key: "ArrowUp" });
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: /System/u })));
        fireEvent.click(screen.getByRole("option", { name: "Unavailable" }));
        expect(onChange).not.toHaveBeenCalled();

        fireEvent.keyDown(listbox, { key: "Home" });
        fireEvent.keyDown(listbox, { key: "Escape" });
        expect(screen.queryByRole("listbox")).toBeNull();
        expect(document.activeElement).toBe(trigger);

        fireEvent.click(trigger);
        fireEvent.keyDown(screen.getByRole("listbox"), { key: "Tab" });
        expect(screen.queryByRole("listbox")).toBeNull();

        fireEvent.click(trigger);
        const typeaheadListbox = screen.getByRole("listbox");
        fireEvent.keyDown(typeaheadListbox, { key: "s" });
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: /System/u })));
        fireEvent.keyDown(typeaheadListbox, { key: " " });
        expect(onChange).toHaveBeenCalledWith("system");
        expect(screen.queryByRole("listbox")).toBeNull();

        fireEvent.click(trigger);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("keeps an empty or disabled listbox bounded without inventing a selection", () => {
        const onChange = vi.fn();
        const { rerender } = render(
            createElement(WorkbenchSelect, {
                value: "unknown",
                label: "Empty",
                onChange,
                options: [],
            }),
        );

        fireEvent.click(screen.getByRole("combobox", { name: "Empty" }));
        const emptyListbox = screen.getByRole("listbox", { name: "Empty" });
        fireEvent.keyDown(emptyListbox, { key: "ArrowDown" });
        fireEvent.keyDown(emptyListbox, { key: "Home" });
        expect(onChange).not.toHaveBeenCalled();

        rerender(
            createElement(WorkbenchSelect, {
                value: "unknown",
                label: "Disabled choices",
                onChange,
                options: [
                    { value: "one", label: "One", disabled: true },
                    { value: "two", label: "Two", disabled: true },
                ],
            }),
        );
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Disabled choices" }), { key: "ArrowDown" });
        const disabledListbox = screen.getByRole("listbox", { name: "Disabled choices" });
        fireEvent.keyDown(disabledListbox, { key: "ArrowDown" });
        fireEvent.keyDown(disabledListbox, { key: "End" });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("supports locale text typeahead and opens above a trigger near the viewport edge", async () => {
        const onChange = vi.fn();
        render(
            createElement(WorkbenchSelect, {
                value: "system",
                label: "Language",
                onChange,
                options: [
                    { value: "system", label: "System" },
                    { value: "de", label: "Deutsch" },
                    { value: "ja", label: "日本語" },
                ],
            }),
        );
        const trigger = screen.getByRole("combobox", { name: "Language" });
        vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
            bottom: window.innerHeight - 4,
            height: 32,
            left: 0,
            right: 240,
            top: window.innerHeight - 36,
            width: 240,
            x: 0,
            y: window.innerHeight - 36,
            toJSON: () => ({}),
        });

        fireEvent.keyDown(trigger, { key: "d" });
        const listbox = screen.getByRole("listbox", { name: "Language" });
        expect(listbox.getAttribute("data-placement")).toBe("above");
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Deutsch" })));
        fireEvent.keyDown(listbox, { key: "Enter" });
        expect(onChange).toHaveBeenCalledWith("de");
    });

    it("traps dialog focus, closes through explicit paths, and restores the previous focus owner", async () => {
        const onClose = vi.fn();
        const prior = document.createElement("button");
        prior.textContent = "Prior";
        document.body.append(prior);
        prior.focus();
        const focus = vi.spyOn(HTMLElement.prototype, "focus");

        const { container, unmount } = render(
            createElement(
                "div",
                { style: { overflow: "auto", transform: "translateY(5px)" } },
                createElement(
                    WorkbenchDialog,
                    { closeLabel: "Close dialog", dialogId: "about", onClose, title: "About OAAM" },
                    createElement("button", { type: "button" }, "Secondary action"),
                ),
            ),
        );

        const dialog = screen.getByRole("dialog", { name: "About OAAM" });
        const backdrop = dialog.parentElement;
        const close = screen.getByRole("button", { name: "Close dialog" });
        const secondary = screen.getByRole("button", { name: "Secondary action" });
        expect(backdrop?.parentElement).toBe(document.body);
        expect(container.contains(dialog)).toBe(false);
        await vi.waitFor(() => expect(document.activeElement).toBe(close));

        fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
        expect(document.activeElement).toBe(secondary);
        fireEvent.keyDown(dialog, { key: "Tab" });
        expect(document.activeElement).toBe(close);
        fireEvent.pointerDown(dialog);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.keyDown(dialog, { key: "Escape" });
        fireEvent.pointerDown(dialog.parentElement as HTMLElement);
        fireEvent.click(close);
        expect(onClose).toHaveBeenCalledTimes(3);

        unmount();
        expect(document.activeElement).toBe(prior);
        expect(focus.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(focus.mock.calls.every(([options]) => options?.preventScroll === true)).toBe(true);
        prior.remove();
    });

    it("honors a requested initial focus owner and composes a feature dialog class", async () => {
        const requestedFocus = createRef<HTMLInputElement>();
        const { unmount } = render(
            createElement(
                WorkbenchDialog,
                {
                    className: "search-dialog",
                    closeLabel: "Close search",
                    dialogId: "catalog_search",
                    initialFocusRef: requestedFocus,
                    onClose: vi.fn(),
                    title: "Search OAAM",
                },
                createElement("input", { ref: requestedFocus, "aria-label": "Search input" }),
            ),
        );

        const dialog = screen.getByRole("dialog", { name: "Search OAAM" });
        expect(dialog.classList.contains("search-dialog")).toBe(true);
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search input" })));
        unmount();
    });

    it("keeps a busy Project dialog open until its operation can be dismissed safely", async () => {
        const onClose = vi.fn();
        render(
            createElement(
                WorkbenchDialog,
                {
                    closeLabel: "Close Project management",
                    dialogId: "project_lifecycle",
                    dismissible: false,
                    onClose,
                    title: "Manage this Project",
                },
                createElement("button", { type: "button" }, "Operation in progress"),
            ),
        );

        const dialog = screen.getByRole("dialog", { name: "Manage this Project" });
        expect(dialog.getAttribute("data-oaam-dialog")).toBe("project_lifecycle");
        expect((screen.getByRole("button", { name: "Close Project management" }) as HTMLButtonElement).disabled).toBe(true);
        await vi.waitFor(() =>
            expect(document.activeElement).toBe(screen.getByRole("button", { name: "Operation in progress" })),
        );
        fireEvent.keyDown(dialog, { key: "Escape" });
        fireEvent.pointerDown(dialog.parentElement as HTMLElement);
        expect(onClose).not.toHaveBeenCalled();
    });
});
