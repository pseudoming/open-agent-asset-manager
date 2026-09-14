import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    desktopTrayLabels,
    DesktopTrayAuthority,
    type DesktopTrayLabels,
    type DesktopTrayMenuItem,
    resolveDesktopTrayIconPath,
} from "../src/main/tray-lifecycle";
import {
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopResolvedLocale,
} from "../src/presentation/presentation-preferences";

const labels: DesktopTrayLabels = Object.freeze({
    tooltip: "Open Agent Asset Manager",
    show: "Show OAAM",
    quit: "Quit OAAM",
    host: Object.freeze({
        starting: "OAAM: Starting",
        recovering: "OAAM: Recovering",
        ready: "OAAM: Running",
        failed: "OAAM: Unavailable",
    }),
});

function command(items: readonly DesktopTrayMenuItem[], id: "show" | "host-status" | "quit") {
    const item = items.find((candidate) => candidate.kind === "command" && candidate.id === id);
    if (item === undefined || item.kind !== "command") throw new Error(`missing Tray command ${id}`);
    return item;
}

function trayFixture() {
    let click: (() => void) | undefined;
    const menus: (readonly DesktopTrayMenuItem[])[] = [];
    const target = {
        setToolTip: vi.fn(),
        setContextMenu: vi.fn(),
        onClick: vi.fn((listener: () => void) => {
            click = listener;
        }),
        destroy: vi.fn(),
    };
    const backend = {
        createTray: vi.fn(() => target),
        buildMenu: vi.fn((items: readonly DesktopTrayMenuItem[]) => {
            menus.push(items);
            return items;
        }),
    };
    return {
        backend,
        target,
        menus,
        clickTray: () => click?.(),
    };
}

describe("Desktop Tray lifecycle", () => {
    it("resolves only the packaged target-platform icon", () => {
        const compiledMain = path.join("/application", "dist", "main");
        expect(resolveDesktopTrayIconPath(compiledMain, "win32")).toBe(path.join("/application", "resources", "oaam-tray.ico"));
        expect(resolveDesktopTrayIconPath(compiledMain, "linux")).toBe(path.join("/application", "resources", "oaam-tray.png"));
        expect(resolveDesktopTrayIconPath(compiledMain, "darwin")).toBe(path.join("/application", "resources", "oaam-tray.png"));
    });

    it("publishes one truthful menu and reuses the existing primary-window authority", () => {
        const fixture = trayFixture();
        const showPrimaryWindow = vi.fn(() => true);
        const requestQuit = vi.fn();
        const authority = new DesktopTrayAuthority(fixture.backend, { showPrimaryWindow, requestQuit });

        authority.initialize("/application/resources/oaam-tray.ico", labels, "starting");

        expect(fixture.backend.createTray).toHaveBeenCalledWith("/application/resources/oaam-tray.ico");
        expect(fixture.target.setToolTip).toHaveBeenLastCalledWith(labels.tooltip);
        const initialMenu = fixture.menus.at(-1) ?? [];
        expect(initialMenu.map((item) => (item.kind === "command" ? item.id : "separator"))).toEqual([
            "show",
            "host-status",
            "separator",
            "quit",
        ]);
        expect(command(initialMenu, "host-status")).toMatchObject({
            label: "OAAM: Starting",
            enabled: false,
        });
        command(initialMenu, "host-status").run();

        fixture.clickTray();
        command(initialMenu, "show").run();
        command(initialMenu, "quit").run();
        expect(showPrimaryWindow).toHaveBeenCalledTimes(2);
        expect(requestQuit).toHaveBeenCalledOnce();

        authority.updateHostStatus("ready");
        expect(command(fixture.menus.at(-1) ?? [], "host-status").label).toBe("OAAM: Running");
        const translated = Object.freeze({ ...labels, tooltip: "OAAM öffnen", show: "OAAM anzeigen" });
        authority.updateLabels(translated);
        expect(fixture.target.setToolTip).toHaveBeenLastCalledWith("OAAM öffnen");
        expect(command(fixture.menus.at(-1) ?? [], "show").label).toBe("OAAM anzeigen");

        authority.dispose();
        authority.dispose();
        expect(fixture.target.destroy).toHaveBeenCalledOnce();
        expect(() => authority.initialize("/other/icon.ico", labels, "failed")).toThrow(/only once/u);
    });

    it("accepts presentation updates before initialization and destroys a partially initialized Tray on failure", () => {
        const fixture = trayFixture();
        const authority = new DesktopTrayAuthority(fixture.backend, {
            showPrimaryWindow: vi.fn(() => false),
            requestQuit: vi.fn(),
        });
        authority.updateLabels(labels);
        authority.updateHostStatus("recovering");
        fixture.backend.buildMenu.mockImplementationOnce(() => {
            throw new Error("menu failed");
        });

        expect(() => authority.initialize("/application/resources/oaam-tray.png", labels, "recovering")).toThrow(/menu failed/u);
        expect(fixture.target.destroy).toHaveBeenCalledOnce();
    });

    it.each([
        ["en", "OAAM: Running"],
        ["zh-CN", "OAAM：运行中"],
        ["de", "OAAM: Wird ausgeführt"],
        ["ja", "OAAM：実行中"],
    ] as const)("projects the %s Tray status without exposing the private process boundary", (resolvedLocale, expected) => {
        const snapshot = Object.freeze({
            preferences: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            resolvedLocale: resolvedLocale satisfies DesktopResolvedLocale,
            resolvedTheme: "light" as const,
        });

        expect(desktopTrayLabels(snapshot).host.ready).toBe(expected);
        expect(Object.values(desktopTrayLabels(snapshot).host).join(" ")).not.toMatch(/\bhost\b|ホスト/iu);
    });
});
