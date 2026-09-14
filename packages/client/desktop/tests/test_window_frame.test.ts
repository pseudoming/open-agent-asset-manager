import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWindowFrame } from "../src/renderer/shell/DesktopWindowFrame";
import { createDesktopPresentationTestBridge, renderWithPresentation } from "./desktop-presentation-test-harness";
import { clickSemanticAction } from "./semantic-action-test-harness";

afterEach(cleanup);

describe("Desktop window frame", () => {
    it("renders one compact non-placeholder menu row and delegates finite native actions", async () => {
        const performWindowAction = vi.fn(async () => undefined);
        const requestProjectRegistration = vi.fn();
        const bridge = { ...createDesktopPresentationTestBridge(), performWindowAction };
        renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                {
                    canOpenSettings: false,
                    onOpenSettings: vi.fn(),
                    projectRegistration: { available: true, request: requestProjectRegistration },
                },
                createElement("main", null, "workspace"),
            ),
            bridge,
        );

        expect((screen.getByLabelText("Toggle sidebar") as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(true);
        expect([...document.querySelectorAll("[data-oaam-icon]")].map((icon) => icon.getAttribute("data-oaam-icon"))).toEqual([
            "sidebar",
            "back",
            "forward",
        ]);

        fireEvent.click(screen.getByRole("button", { name: "File" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Add Project…" }));
        expect(requestProjectRegistration).toHaveBeenCalledOnce();
        expect(performWindowAction).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "File" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Hide to Tray" }));
        await vi.waitFor(() => expect(performWindowAction).toHaveBeenCalledWith("hide_to_tray"));

        fireEvent.click(screen.getByRole("button", { name: "File" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Exit" }));
        await vi.waitFor(() => expect(performWindowAction).toHaveBeenCalledWith("quit"));

        fireEvent.click(screen.getByRole("button", { name: "View" }));
        fireEvent.click(screen.getByRole("menuitem", { name: /Toggle Full Screen/u }));
        await vi.waitFor(() => expect(performWindowAction).toHaveBeenCalledWith("toggle_full_screen"));
    });

    it("keeps Settings renderer-owned and truthful about its current availability", async () => {
        const disabledSettings = vi.fn();
        const { unmount } = renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                { canOpenSettings: false, onOpenSettings: disabledSettings },
                createElement("main", null, "starting"),
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        expect((screen.getByRole("menuitem", { name: /Settings/u }) as HTMLButtonElement).disabled).toBe(true);
        unmount();

        const openSettings = vi.fn();
        renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                { canOpenSettings: true, onOpenSettings: openSettings },
                createElement("main", null, "ready"),
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        await clickSemanticAction("shell.menu.settings", "shell.open_settings", {
            expected: openSettings,
            expectedArgs: [],
            unrelated: [],
        });
    });

    it("keeps Add Project renderer-owned and disables it when registration is unavailable", () => {
        const request = vi.fn();
        const { unmount } = renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                {
                    canOpenSettings: false,
                    onOpenSettings: vi.fn(),
                    projectRegistration: { available: false, request },
                },
                createElement("main", null, "unavailable"),
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "File" }));
        expect((screen.getByRole("menuitem", { name: "Add Project…" }) as HTMLButtonElement).disabled).toBe(true);
        unmount();

        renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                {
                    canOpenSettings: false,
                    onOpenSettings: vi.fn(),
                    projectRegistration: { available: true, request },
                },
                createElement("main", null, "available"),
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "File" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Add Project…" }));
        expect(request).toHaveBeenCalledOnce();
    });

    it("closes menus on Escape and reports a rejected native action without inventing success", async () => {
        const bridge = {
            ...createDesktopPresentationTestBridge(),
            performWindowAction: vi.fn(async () => Promise.reject(new Error("main unavailable"))),
        };
        renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                { canOpenSettings: false, onOpenSettings: vi.fn() },
                createElement("main", null, "workspace"),
            ),
            bridge,
        );

        fireEvent.click(screen.getByRole("button", { name: "Help" }));
        expect(screen.getByRole("menu")).not.toBeNull();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("menu")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "File" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Hide to Tray" }));
        await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("could not be completed"));
    });

    it("opens a silent renderer-owned About dialog with exact app identity and trapped keyboard focus", () => {
        const performWindowAction = vi.fn(async () => undefined);
        renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                { canOpenSettings: false, onOpenSettings: vi.fn() },
                createElement("main", null, "workspace"),
            ),
            { ...createDesktopPresentationTestBridge(), performWindowAction },
        );

        const help = screen.getByRole("button", { name: "Help" });
        fireEvent.click(help);
        fireEvent.click(screen.getByRole("menuitem", { name: "About OAAM" }));
        const dialog = screen.getByRole("dialog", { name: "About OAAM" });
        expect(dialog.textContent).toContain("Open Agent Asset Manager");
        expect(dialog.textContent).toContain("0.1.0-test");
        const close = screen.getByRole("button", { name: "Close" });
        expect(document.activeElement).toBe(close);
        fireEvent.keyDown(dialog, { key: "Tab" });
        expect(document.activeElement).toBe(close);
        fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
        expect(document.activeElement).toBe(close);
        fireEvent.click(close);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(help);
        expect(performWindowAction).not.toHaveBeenCalled();
    });

    it("closes an open menu on an outside pointer press or a second trigger press", () => {
        renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                { canOpenSettings: false, onOpenSettings: vi.fn() },
                createElement("main", null, "workspace"),
            ),
        );

        const help = screen.getByRole("button", { name: "Help" });
        fireEvent.click(help);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("menu")).toBeNull();

        fireEvent.click(help);
        expect(screen.getByRole("menu")).not.toBeNull();
        fireEvent.click(help);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("supports keyboard menu entry, cyclic item focus, adjacent menus and focus restoration", () => {
        renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                { canOpenSettings: false, onOpenSettings: vi.fn() },
                createElement("main", null, "workspace"),
            ),
        );

        const file = screen.getByRole("button", { name: "File" });
        file.focus();
        fireEvent.keyDown(file, { key: "ArrowDown" });
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Hide to Tray" }));
        expect((document.activeElement as HTMLButtonElement).tabIndex).toBe(-1);

        fireEvent.keyDown(file, { key: "ArrowUp" });
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Exit" }));
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Home" });
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Hide to Tray" }));
        fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Exit" }));
        fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Hide to Tray" }));

        fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowRight" });
        expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-expanded")).toBe("true");
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Undo/u }));

        fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowLeft" });
        expect(screen.getByRole("button", { name: "File" }).getAttribute("aria-expanded")).toBe("true");
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Hide to Tray" }));
        fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowRight" });
        fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Select All/u }));
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
        expect(screen.queryByRole("menu")).toBeNull();

        const edit = screen.getByRole("button", { name: "Edit" });
        edit.focus();
        fireEvent.keyDown(edit, { key: "ArrowDown" });
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        expect(screen.queryByRole("menu")).toBeNull();
        expect(document.activeElement).toBe(edit);
    });

    it("delegates renderer-owned history and pane controls without invoking a native window action", async () => {
        const performWindowAction = vi.fn(async () => undefined);
        const onBack = vi.fn();
        const onForward = vi.fn();
        const onToggleSidebar = vi.fn();
        const onToggleInspector = vi.fn();
        renderWithPresentation(
            createElement(
                DesktopWindowFrame,
                {
                    canOpenSettings: true,
                    onOpenSettings: vi.fn(),
                    navigation: { canGoBack: true, canGoForward: true, onBack, onForward },
                    sidebar: { visible: true, onToggle: onToggleSidebar },
                    inspector: { available: true, visible: false, onToggle: onToggleInspector },
                },
                createElement("main", null, "workspace"),
            ),
            { ...createDesktopPresentationTestBridge(), performWindowAction },
        );

        fireEvent.click(screen.getByLabelText("Toggle sidebar"));
        await clickSemanticAction("shell.history.back", "workbench.navigate_history", {
            expected: onBack,
            expectedArgs: [],
            unrelated: [onForward, onToggleInspector],
        });
        await clickSemanticAction("shell.history.forward", "workbench.navigate_history", {
            expected: onForward,
            expectedArgs: [],
            unrelated: [onBack, onToggleInspector],
        });
        expect(onToggleSidebar).toHaveBeenCalledOnce();
        expect(onBack).toHaveBeenCalledOnce();
        expect(onForward).toHaveBeenCalledOnce();

        fireEvent.click(screen.getByRole("button", { name: "View" }));
        fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Toggle Sidebar" }));
        fireEvent.click(screen.getByRole("button", { name: "View" }));
        await clickSemanticAction("shell.menu.history.back", "workbench.navigate_history", {
            expected: onBack,
            expectedArgs: [],
            unrelated: [onForward, onToggleInspector],
        });
        fireEvent.click(screen.getByRole("button", { name: "View" }));
        await clickSemanticAction("shell.menu.history.forward", "workbench.navigate_history", {
            expected: onForward,
            expectedArgs: [],
            unrelated: [onBack, onToggleInspector],
        });
        fireEvent.click(screen.getByRole("button", { name: "View" }));
        fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Toggle Inspector" }));
        expect(onToggleSidebar).toHaveBeenCalledTimes(2);
        expect(onBack).toHaveBeenCalledTimes(2);
        expect(onForward).toHaveBeenCalledTimes(2);
        expect(onToggleInspector).toHaveBeenCalledOnce();
        expect(performWindowAction).not.toHaveBeenCalled();
    });
});
