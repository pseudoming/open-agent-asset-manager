import { describe, expect, it, vi } from "vitest";
import {
    parseDesktopAppIdentity,
    parseDesktopBackupId,
    parseDesktopStateBackupFileAction,
    parseDesktopStateBackupFileActionResult,
    parseDesktopStateResiliencePreferences,
    parseDesktopWindowAction,
    parseStateBackupDestinationPickerResult,
    parseStateRestoreArchivePickerResult,
} from "../src/bridge/desktop-bridge";
import { parseDesktopRendererDiagnosticInput } from "../src/bridge/desktop-renderer-diagnostics";
import { desktopStateBackupTrashRoute } from "../src/main/state-backup-file-actions";
import {
    type DesktopWindowActionTarget,
    desktopWindowActionFromShortcut,
    performDesktopWindowAction,
} from "../src/main/window-actions";

function targetFixture(options: { readonly zoom?: number; readonly fullScreen?: boolean } = {}) {
    let zoom = options.zoom ?? 1;
    let fullScreen = options.fullScreen ?? false;
    const target: DesktopWindowActionTarget = {
        webContents: {
            undo: vi.fn(),
            redo: vi.fn(),
            cut: vi.fn(),
            copy: vi.fn(),
            paste: vi.fn(),
            delete: vi.fn(),
            selectAll: vi.fn(),
            getZoomFactor: vi.fn(() => zoom),
            setZoomFactor: vi.fn((value) => {
                zoom = value;
            }),
        },
        isFullScreen: vi.fn(() => fullScreen),
        setFullScreen: vi.fn((value) => {
            fullScreen = value;
        }),
    };
    return {
        target,
        get zoom() {
            return zoom;
        },
        get fullScreen() {
            return fullScreen;
        },
    };
}

describe("Desktop window actions", () => {
    it("keeps Windows backup recycling inside the identity-bound Host route", () => {
        expect(desktopStateBackupTrashRoute("win32")).toBe("host_identity_bound");
        for (const platform of ["darwin", "linux", "aix", "freebsd"] as const) {
            expect(desktopStateBackupTrashRoute(platform)).toBe("electron_shell");
        }
    });

    it("accepts only the finite preload-to-main action vocabulary", () => {
        expect(parseDesktopWindowAction("toggle_full_screen")).toBe("toggle_full_screen");
        expect(parseDesktopWindowAction("hide_to_tray")).toBe("hide_to_tray");
        expect(parseDesktopWindowAction("reload_interface")).toBe("reload_interface");
        for (const malformed of [null, "", "open_devtools", "show_about", { action: "quit" }]) {
            expect(() => parseDesktopWindowAction(malformed)).toThrow(/invalid Desktop window action/u);
        }
        expect(parseDesktopAppIdentity({ name: "Open Agent Asset Manager", version: "0.1.0" })).toEqual({
            name: "Open Agent Asset Manager",
            version: "0.1.0",
        });
        for (const malformed of [
            null,
            { name: "", version: "0.1.0" },
            { name: "OAAM", version: "" },
            { name: "OAAM", version: "0.1.0", extra: true },
        ]) {
            expect(() => parseDesktopAppIdentity(malformed)).toThrow(/invalid Desktop app identity/u);
        }
    });

    it("accepts only privacy-bounded Renderer diagnostic receipts", () => {
        const receipt = {
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        } as const;
        expect(parseDesktopRendererDiagnosticInput(receipt)).toEqual(receipt);
        for (const malformed of [
            { ...receipt, error: "private body" },
            { ...receipt, surface: "/private/project" },
            { ...receipt, componentTrail: ["user/path"] },
            { ...receipt, componentTrail: Array.from({ length: 9 }, (_, index) => `Component${index}`) },
        ]) {
            expect(() => parseDesktopRendererDiagnosticInput(malformed)).toThrow();
        }
    });

    it("validates every finite State resilience preload result without accepting arbitrary paths or actions", () => {
        const selected = {
            status: "selected",
            displayPath: "C:\\Backups",
            localPathSelectionToken: "selection-token",
        } as const;
        expect(parseStateBackupDestinationPickerResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
        expect(parseStateBackupDestinationPickerResult({ status: "unavailable" })).toEqual({ status: "unavailable" });
        expect(parseStateBackupDestinationPickerResult(selected)).toEqual(selected);
        expect(parseStateRestoreArchivePickerResult(selected)).toEqual(selected);
        expect(parseStateRestoreArchivePickerResult({ status: "cancelled" })).toEqual({ status: "cancelled" });

        expect(parseDesktopStateResiliencePreferences({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
        expect(
            parseDesktopStateResiliencePreferences({
                schemaVersion: 1,
                lastCustomBackupDirectory: "C:\\Backups",
            }),
        ).toEqual({ schemaVersion: 1, lastCustomBackupDirectory: "C:\\Backups" });

        for (const action of ["reveal", "trash", "copy_path"] as const) {
            expect(parseDesktopStateBackupFileAction(action)).toBe(action);
        }
        expect(parseDesktopStateBackupFileActionResult({ status: "complete" })).toEqual({ status: "complete" });
        for (const code of ["unavailable", "reveal_failed", "trash_failed", "copy_failed"] as const) {
            expect(parseDesktopStateBackupFileActionResult({ status: "failed", code })).toEqual({
                status: "failed",
                code,
            });
        }
        expect(parseDesktopBackupId("00000000-0000-4000-8000-000000000001")).toBe("00000000-0000-4000-8000-000000000001");

        for (const malformed of [
            { status: "selected", displayPath: "", localPathSelectionToken: "token" },
            { status: "unavailable", extra: true },
        ]) {
            expect(() => parseStateBackupDestinationPickerResult(malformed)).toThrow(/invalid Desktop State backup destination/u);
        }
        expect(() => parseStateRestoreArchivePickerResult({ status: "unavailable" })).toThrow(
            /invalid Desktop State restore archive/u,
        );
        for (const malformed of [
            null,
            { schemaVersion: 2 },
            { schemaVersion: 1, lastCustomBackupDirectory: "" },
            { schemaVersion: 1, extra: true },
        ]) {
            expect(() => parseDesktopStateResiliencePreferences(malformed)).toThrow(
                /invalid Desktop State resilience preferences/u,
            );
        }
        expect(() => parseDesktopStateBackupFileAction("delete")).toThrow(/invalid Desktop State backup file action/u);
        expect(() => parseDesktopStateBackupFileActionResult({ status: "failed", code: "delete_failed" })).toThrow(
            /invalid Desktop State backup file action result/u,
        );
        for (const malformed of ["", "00000000-0000-1000-8000-000000000001", { backupId: "id" }]) {
            expect(() => parseDesktopBackupId(malformed)).toThrow(/invalid Desktop State backup identity/u);
        }
    });

    it("maps only truthful main-owned Windows and macOS shortcuts", () => {
        const input = (key: string, overrides: Partial<Parameters<typeof desktopWindowActionFromShortcut>[0]> = {}) => ({
            type: "keyDown",
            key,
            control: true,
            meta: false,
            alt: false,
            shift: false,
            ...overrides,
        });
        expect(desktopWindowActionFromShortcut(input("z"), "win32")).toBe("undo");
        expect(desktopWindowActionFromShortcut(input("z", { shift: true }), "win32")).toBe("redo");
        expect(desktopWindowActionFromShortcut(input("y"), "linux")).toBe("redo");
        expect(desktopWindowActionFromShortcut(input("x"), "win32")).toBe("cut");
        expect(desktopWindowActionFromShortcut(input("v"), "win32")).toBe("paste");
        expect(desktopWindowActionFromShortcut(input("a"), "win32")).toBe("select_all");
        expect(desktopWindowActionFromShortcut(input("="), "win32")).toBe("zoom_in");
        expect(desktopWindowActionFromShortcut(input("-"), "win32")).toBe("zoom_out");
        expect(desktopWindowActionFromShortcut(input("0"), "win32")).toBe("zoom_reset");
        expect(desktopWindowActionFromShortcut(input("F11", { control: false }), "win32")).toBe("toggle_full_screen");
        expect(desktopWindowActionFromShortcut(input("c", { control: false, meta: true }), "darwin")).toBe("copy");
        expect(desktopWindowActionFromShortcut(input("c"), "darwin")).toBeUndefined();
        expect(desktopWindowActionFromShortcut(input("c", { alt: true }), "win32")).toBeUndefined();
        expect(desktopWindowActionFromShortcut(input("x", { type: "keyUp" }), "win32")).toBeUndefined();
        expect(desktopWindowActionFromShortcut(input("x", { shift: true }), "win32")).toBeUndefined();
        expect(desktopWindowActionFromShortcut(input("q"), "win32")).toBeUndefined();
    });

    it.each([
        ["undo", "undo"],
        ["redo", "redo"],
        ["cut", "cut"],
        ["copy", "copy"],
        ["paste", "paste"],
        ["delete", "delete"],
        ["select_all", "selectAll"],
    ] as const)("delegates %s to the focused renderer edit command", async (action, method) => {
        const fixture = targetFixture();
        await performDesktopWindowAction(fixture.target, action, {
            requestQuit: vi.fn(),
            hideToTray: vi.fn(),
            reloadInterface: vi.fn(),
        });
        expect(fixture.target.webContents[method]).toHaveBeenCalledOnce();
    });

    it("bounds zoom, restores actual size and toggles the current full-screen state", async () => {
        const upper = targetFixture({ zoom: 2 });
        const lower = targetFixture({ zoom: 0.5, fullScreen: true });
        const dependencies = { requestQuit: vi.fn(), hideToTray: vi.fn(), reloadInterface: vi.fn() };

        await performDesktopWindowAction(upper.target, "zoom_in", dependencies);
        await performDesktopWindowAction(lower.target, "zoom_out", dependencies);
        expect(upper.zoom).toBe(2);
        expect(lower.zoom).toBe(0.5);

        await performDesktopWindowAction(lower.target, "zoom_reset", dependencies);
        expect(lower.zoom).toBe(1);
        await performDesktopWindowAction(lower.target, "toggle_full_screen", dependencies);
        expect(lower.fullScreen).toBe(false);
    });

    it("keeps hide, interface reload and quit behind explicit main-owned dependencies", async () => {
        const fixture = targetFixture();
        const dependencies = { requestQuit: vi.fn(), hideToTray: vi.fn(), reloadInterface: vi.fn() };

        await performDesktopWindowAction(fixture.target, "hide_to_tray", dependencies);
        await performDesktopWindowAction(fixture.target, "reload_interface", dependencies);
        await performDesktopWindowAction(fixture.target, "quit", dependencies);

        expect(dependencies.hideToTray).toHaveBeenCalledOnce();
        expect(dependencies.reloadInterface).toHaveBeenCalledOnce();
        expect(dependencies.requestQuit).toHaveBeenCalledOnce();
    });

    it("rejects a non-finite current zoom instead of passing it to Electron", async () => {
        const fixture = targetFixture({ zoom: Number.NaN });
        await expect(
            performDesktopWindowAction(fixture.target, "zoom_in", {
                requestQuit: vi.fn(),
                hideToTray: vi.fn(),
                reloadInterface: vi.fn(),
            }),
        ).rejects.toThrow(/non-finite zoom/u);
        expect(fixture.target.webContents.setZoomFactor).not.toHaveBeenCalled();
    });
});
