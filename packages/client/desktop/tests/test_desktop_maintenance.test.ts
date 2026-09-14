import { describe, expect, it, vi } from "vitest";
import {
    DESKTOP_DATA_LOCATION_ACTION_CHANNEL,
    DESKTOP_INTERFACE_CACHE_CLEAR_CHANNEL,
    DESKTOP_INTERFACE_DEFAULTS_RESTORE_CHANNEL,
    DESKTOP_MAINTENANCE_GET_CHANNEL,
    parseDesktopDataLocationAction,
    parseDesktopDataLocationActionResult,
    parseDesktopDataLocationId,
    parseDesktopInterfaceCacheClearResult,
    parseDesktopInterfaceDefaultsRestoreResult,
    parseDesktopMaintenanceSnapshot,
} from "../src/bridge/desktop-bridge";
import {
    clearDesktopInterfaceCache,
    desktopDataLocations,
    inspectDesktopMaintenance,
    performDesktopDataLocationAction,
    restoreDesktopInterfaceDefaults,
    type DesktopInterfaceCache,
} from "../src/main/desktop-maintenance";
import { registerDesktopMaintenanceIpc } from "../src/main/desktop-maintenance-ipc";

const ROOTS = Object.freeze({
    oaamDataRoot: "/profile/oaam",
    desktopProfileRoot: "/profile",
    interfaceCacheRoot: "/profile/cache",
});

function cache(overrides: Partial<DesktopInterfaceCache> = {}): DesktopInterfaceCache {
    return {
        storagePath: "/profile/cache",
        getCacheSize: vi.fn(async () => 2048),
        clearCache: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe("Desktop finite maintenance contract", () => {
    it("registers four finite IPC handlers and rejects every non-primary sender", async () => {
        const handlers = new Map<string, (...args: never[]) => unknown>();
        const exactCache = cache();
        const webContents = { session: exactCache };
        const window = { webContents };
        const openPath = vi.fn(async () => "");
        const copyPath = vi.fn();
        const restorePresentationDefaults = vi.fn();
        const restoreWindowDefaults = vi.fn();
        registerDesktopMaintenanceIpc({
            ipcMain: {
                handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
                    handlers.set(channel, handler);
                }),
            } as never,
            getPrimaryWindow: () => window as never,
            oaamDataRoot: ROOTS.oaamDataRoot,
            desktopProfileRoot: ROOTS.desktopProfileRoot,
            dataLocationActions: { openPath, copyPath },
            restorePresentationDefaults,
            restoreWindowDefaults,
        });

        expect([...handlers.keys()]).toEqual([
            DESKTOP_MAINTENANCE_GET_CHANNEL,
            DESKTOP_INTERFACE_CACHE_CLEAR_CHANNEL,
            DESKTOP_DATA_LOCATION_ACTION_CHANNEL,
            DESKTOP_INTERFACE_DEFAULTS_RESTORE_CHANNEL,
        ]);
        const exactEvent = { sender: webContents };
        await expect(handlers.get(DESKTOP_MAINTENANCE_GET_CHANNEL)?.(exactEvent as never)).resolves.toMatchObject({
            interfaceCache: { status: "available", byteSize: 2048 },
        });
        await expect(handlers.get(DESKTOP_INTERFACE_CACHE_CLEAR_CHANNEL)?.(exactEvent as never)).resolves.toMatchObject({
            status: "complete",
        });
        await expect(
            handlers.get(DESKTOP_DATA_LOCATION_ACTION_CHANNEL)?.(
                exactEvent as never,
                "ordinary_logs" as never,
                "copy_path" as never,
            ),
        ).resolves.toEqual({ status: "complete" });
        expect(copyPath).toHaveBeenCalledWith("/profile/oaam/logs/ordinary");
        expect(handlers.get(DESKTOP_INTERFACE_DEFAULTS_RESTORE_CHANNEL)?.(exactEvent as never)).toEqual({
            status: "complete",
            presentation: "complete",
            windowState: "complete",
        });
        expect(restorePresentationDefaults).toHaveBeenCalledOnce();
        expect(restoreWindowDefaults).toHaveBeenCalledWith(window);

        for (const handler of handlers.values()) {
            await expect(Promise.resolve().then(() => handler({ sender: {} } as never))).rejects.toThrow(
                /OAAM Desktop .* is unavailable/,
            );
        }

        const missingWindowHandlers = new Map<string, (...args: never[]) => unknown>();
        registerDesktopMaintenanceIpc({
            ipcMain: {
                handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
                    missingWindowHandlers.set(channel, handler);
                }),
            } as never,
            getPrimaryWindow: () => null,
            oaamDataRoot: ROOTS.oaamDataRoot,
            desktopProfileRoot: ROOTS.desktopProfileRoot,
            dataLocationActions: { openPath, copyPath },
            restorePresentationDefaults,
            restoreWindowDefaults,
        });
        await expect(
            Promise.resolve().then(() =>
                missingWindowHandlers.get(DESKTOP_MAINTENANCE_GET_CHANNEL)?.({ sender: webContents } as never),
            ),
        ).rejects.toThrow("OAAM Desktop maintenance snapshot is unavailable");
    });

    it("parses only the closed data-location and action values", () => {
        for (const locationId of ["oaam_data", "desktop_profile", "state_backups", "ordinary_logs", "interface_cache"] as const) {
            expect(parseDesktopDataLocationId(locationId)).toBe(locationId);
        }
        expect(parseDesktopDataLocationAction("open")).toBe("open");
        expect(parseDesktopDataLocationAction("copy_path")).toBe("copy_path");
        expect(() => parseDesktopDataLocationId("arbitrary")).toThrow(TypeError);
        expect(() => parseDesktopDataLocationAction("delete")).toThrow(TypeError);
    });

    it("parses exact maintenance, cache, location-action and reset results", () => {
        const snapshot = {
            interfaceCache: { status: "available", byteSize: 2048 },
            dataLocations: [
                { locationId: "oaam_data", status: "available", displayPath: "/profile/oaam" },
                { locationId: "desktop_profile", status: "available", displayPath: "/profile" },
                { locationId: "state_backups", status: "available", displayPath: "/profile/oaam/backups" },
                { locationId: "ordinary_logs", status: "available", displayPath: "/profile/oaam/logs/ordinary" },
                { locationId: "interface_cache", status: "unavailable" },
            ],
        };
        expect(parseDesktopMaintenanceSnapshot(snapshot)).toEqual(snapshot);
        expect(
            parseDesktopInterfaceCacheClearResult({
                status: "complete",
                interfaceCache: { status: "unavailable" },
            }),
        ).toEqual({ status: "complete", interfaceCache: { status: "unavailable" } });
        expect(
            parseDesktopInterfaceCacheClearResult({
                status: "failed",
                code: "clear_failed",
                interfaceCache: { status: "available", byteSize: 1 },
            }),
        ).toEqual({
            status: "failed",
            code: "clear_failed",
            interfaceCache: { status: "available", byteSize: 1 },
        });
        expect(parseDesktopDataLocationActionResult({ status: "complete" })).toEqual({ status: "complete" });
        for (const code of ["unavailable", "open_failed", "copy_failed"] as const) {
            expect(parseDesktopDataLocationActionResult({ status: "failed", code })).toEqual({ status: "failed", code });
        }
        expect(
            parseDesktopInterfaceDefaultsRestoreResult({
                status: "partial",
                presentation: "complete",
                windowState: "failed",
            }),
        ).toEqual({ status: "partial", presentation: "complete", windowState: "failed" });

        const invalid: unknown[] = [
            { ...snapshot, dataLocations: [...snapshot.dataLocations].reverse() },
            { ...snapshot, interfaceCache: { status: "available", byteSize: -1 } },
            { ...snapshot, extra: true },
            { status: "failed", code: "delete_failed" },
            { status: "complete", presentation: "complete", windowState: "failed" },
        ];
        expect(() => parseDesktopMaintenanceSnapshot(invalid[0])).toThrow(TypeError);
        expect(() => parseDesktopMaintenanceSnapshot(invalid[1])).toThrow(TypeError);
        expect(() => parseDesktopMaintenanceSnapshot(invalid[2])).toThrow(TypeError);
        expect(() => parseDesktopDataLocationActionResult(invalid[3])).toThrow(TypeError);
        expect(() => parseDesktopInterfaceDefaultsRestoreResult(invalid[4])).toThrow(TypeError);
    });

    it("measures and clears only the supplied Electron interface cache", async () => {
        const getCacheSize = vi.fn().mockResolvedValueOnce(4096).mockResolvedValueOnce(0);
        const clearCache = vi.fn(async () => undefined);
        const exactCache = cache({ getCacheSize, clearCache });
        const snapshot = await inspectDesktopMaintenance(exactCache, ROOTS);
        expect(snapshot.interfaceCache).toEqual({ status: "available", byteSize: 4096 });
        expect(snapshot.dataLocations.at(-1)).toEqual({
            locationId: "interface_cache",
            status: "available",
            displayPath: "/profile/cache",
        });
        expect(await clearDesktopInterfaceCache(exactCache)).toEqual({
            status: "complete",
            interfaceCache: { status: "available", byteSize: 0 },
        });
        expect(clearCache).toHaveBeenCalledTimes(1);
        expect(getCacheSize).toHaveBeenCalledTimes(2);
    });

    it("reports unavailable measurements and exact clear failure without widening the cache API", async () => {
        const getCacheSize = vi.fn().mockRejectedValue(new Error("unavailable"));
        const clearCache = vi.fn().mockRejectedValue(new Error("denied"));
        const exactCache = cache({ storagePath: null, getCacheSize, clearCache });
        const snapshot = await inspectDesktopMaintenance(exactCache, ROOTS);
        expect(snapshot.interfaceCache).toEqual({ status: "unavailable" });
        expect(snapshot.dataLocations[0]).toMatchObject({ locationId: "oaam_data" });
        expect(snapshot.dataLocations.at(-1)).toEqual({ locationId: "interface_cache", status: "unavailable" });
        expect(await clearDesktopInterfaceCache(exactCache)).toEqual({
            status: "failed",
            code: "clear_failed",
            interfaceCache: { status: "unavailable" },
        });
        expect(await inspectDesktopMaintenance(cache({ getCacheSize: vi.fn(async () => Number.NaN) }), ROOTS)).toMatchObject({
            interfaceCache: { status: "unavailable" },
        });
    });

    it("derives every path in main and accepts only finite open/copy actions", async () => {
        expect(desktopDataLocations(ROOTS)).toEqual([
            { locationId: "oaam_data", status: "available", displayPath: "/profile/oaam" },
            { locationId: "desktop_profile", status: "available", displayPath: "/profile" },
            { locationId: "state_backups", status: "available", displayPath: "/profile/oaam/backups" },
            { locationId: "ordinary_logs", status: "available", displayPath: "/profile/oaam/logs/ordinary" },
            { locationId: "interface_cache", status: "available", displayPath: "/profile/cache" },
        ]);
        const openPath = vi.fn(async () => "");
        const copyPath = vi.fn();
        expect(await performDesktopDataLocationAction(ROOTS, "ordinary_logs", "open", { openPath, copyPath })).toEqual({
            status: "complete",
        });
        expect(openPath).toHaveBeenCalledWith("/profile/oaam/logs/ordinary");
        expect(await performDesktopDataLocationAction(ROOTS, "state_backups", "copy_path", { openPath, copyPath })).toEqual({
            status: "complete",
        });
        expect(copyPath).toHaveBeenCalledWith("/profile/oaam/backups");

        expect(
            await performDesktopDataLocationAction(ROOTS, "oaam_data", "open", {
                openPath: vi.fn(async () => "not found"),
                copyPath,
            }),
        ).toEqual({ status: "failed", code: "open_failed" });
        expect(
            await performDesktopDataLocationAction(ROOTS, "oaam_data", "copy_path", {
                openPath,
                copyPath: vi.fn(() => {
                    throw new Error("clipboard unavailable");
                }),
            }),
        ).toEqual({ status: "failed", code: "copy_failed" });
        expect(
            await performDesktopDataLocationAction({ ...ROOTS, interfaceCacheRoot: null }, "interface_cache", "open", {
                openPath,
                copyPath,
            }),
        ).toEqual({ status: "failed", code: "unavailable" });
    });

    it("runs both idempotent reset owners and reports complete, partial and failed results exactly", () => {
        const completePresentation = vi.fn();
        const completeWindow = vi.fn();
        expect(
            restoreDesktopInterfaceDefaults({
                restorePresentation: completePresentation,
                restoreWindowState: completeWindow,
            }),
        ).toEqual({ status: "complete", presentation: "complete", windowState: "complete" });
        expect(completePresentation).toHaveBeenCalledOnce();
        expect(completeWindow).toHaveBeenCalledOnce();

        expect(
            restoreDesktopInterfaceDefaults({
                restorePresentation: () => undefined,
                restoreWindowState: () => {
                    throw new Error("window state unavailable");
                },
            }),
        ).toEqual({ status: "partial", presentation: "complete", windowState: "failed" });
        expect(
            restoreDesktopInterfaceDefaults({
                restorePresentation: () => {
                    throw new Error("preference unavailable");
                },
                restoreWindowState: () => undefined,
            }),
        ).toEqual({ status: "partial", presentation: "failed", windowState: "complete" });
        expect(
            restoreDesktopInterfaceDefaults({
                restorePresentation: () => {
                    throw new Error("preference unavailable");
                },
                restoreWindowState: () => {
                    throw new Error("window state unavailable");
                },
            }),
        ).toEqual({ status: "failed", presentation: "failed", windowState: "failed" });
    });
});
