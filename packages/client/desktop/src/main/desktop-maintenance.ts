import path from "node:path";
import {
    DESKTOP_DATA_LOCATION_IDS,
    type DesktopDataLocation,
    type DesktopDataLocationAction,
    type DesktopDataLocationActionResult,
    type DesktopDataLocationId,
    type DesktopInterfaceCacheClearResult,
    type DesktopInterfaceCacheMeasurement,
    type DesktopInterfaceDefaultsRestoreResult,
    type DesktopMaintenanceSnapshot,
} from "../bridge/desktop-bridge";

export interface DesktopInterfaceCache {
    readonly storagePath: string | null;
    getCacheSize(): Promise<number>;
    clearCache(): Promise<void>;
}

export interface DesktopDataLocationRoots {
    readonly oaamDataRoot: string;
    readonly desktopProfileRoot: string;
    readonly interfaceCacheRoot: string | null;
}

export interface DesktopDataLocationActions {
    openPath(targetPath: string): Promise<string>;
    copyPath(targetPath: string): void;
}

function availableLocation(locationId: DesktopDataLocationId, displayPath: string): DesktopDataLocation {
    return Object.freeze({ locationId, status: "available", displayPath });
}

export function desktopDataLocations(roots: DesktopDataLocationRoots): readonly DesktopDataLocation[] {
    const byId = new Map<DesktopDataLocationId, DesktopDataLocation>([
        ["oaam_data", availableLocation("oaam_data", roots.oaamDataRoot)],
        ["desktop_profile", availableLocation("desktop_profile", roots.desktopProfileRoot)],
        ["state_backups", availableLocation("state_backups", path.join(roots.oaamDataRoot, "backups"))],
        ["ordinary_logs", availableLocation("ordinary_logs", path.join(roots.oaamDataRoot, "logs", "ordinary"))],
        [
            "interface_cache",
            roots.interfaceCacheRoot === null
                ? Object.freeze({ locationId: "interface_cache", status: "unavailable" })
                : availableLocation("interface_cache", roots.interfaceCacheRoot),
        ],
    ]);
    return Object.freeze(
        DESKTOP_DATA_LOCATION_IDS.map((locationId) => {
            const location = byId.get(locationId);
            if (location === undefined) throw new Error(`missing Desktop data location ${locationId}`);
            return location;
        }),
    );
}

async function measureInterfaceCache(cache: DesktopInterfaceCache): Promise<DesktopInterfaceCacheMeasurement> {
    try {
        const byteSize = await cache.getCacheSize();
        if (!Number.isSafeInteger(byteSize) || byteSize < 0) return Object.freeze({ status: "unavailable" });
        return Object.freeze({ status: "available", byteSize });
    } catch {
        return Object.freeze({ status: "unavailable" });
    }
}

export async function inspectDesktopMaintenance(
    cache: DesktopInterfaceCache,
    roots: Omit<DesktopDataLocationRoots, "interfaceCacheRoot">,
): Promise<DesktopMaintenanceSnapshot> {
    return Object.freeze({
        interfaceCache: await measureInterfaceCache(cache),
        dataLocations: desktopDataLocations({ ...roots, interfaceCacheRoot: cache.storagePath }),
    });
}

export async function clearDesktopInterfaceCache(cache: DesktopInterfaceCache): Promise<DesktopInterfaceCacheClearResult> {
    try {
        await cache.clearCache();
    } catch {
        return Object.freeze({
            status: "failed",
            code: "clear_failed",
            interfaceCache: await measureInterfaceCache(cache),
        });
    }
    return Object.freeze({
        status: "complete",
        interfaceCache: await measureInterfaceCache(cache),
    });
}

export async function performDesktopDataLocationAction(
    roots: DesktopDataLocationRoots,
    locationId: DesktopDataLocationId,
    action: DesktopDataLocationAction,
    actions: DesktopDataLocationActions,
): Promise<DesktopDataLocationActionResult> {
    const location = desktopDataLocations(roots).find((candidate) => candidate.locationId === locationId);
    if (location?.status !== "available") return Object.freeze({ status: "failed", code: "unavailable" });
    try {
        if (action === "copy_path") actions.copyPath(location.displayPath);
        else if ((await actions.openPath(location.displayPath)).length > 0) {
            return Object.freeze({ status: "failed", code: "open_failed" });
        }
        return Object.freeze({ status: "complete" });
    } catch {
        return Object.freeze({
            status: "failed",
            code: action === "copy_path" ? "copy_failed" : "open_failed",
        });
    }
}

export function restoreDesktopInterfaceDefaults(actions: {
    readonly restorePresentation: () => void;
    readonly restoreWindowState: () => void;
}): DesktopInterfaceDefaultsRestoreResult {
    let presentation: "complete" | "failed" = "complete";
    let windowState: "complete" | "failed" = "complete";
    try {
        actions.restoreWindowState();
    } catch {
        windowState = "failed";
    }
    try {
        actions.restorePresentation();
    } catch {
        presentation = "failed";
    }
    return Object.freeze({
        status:
            presentation === "complete" && windowState === "complete"
                ? "complete"
                : presentation === "failed" && windowState === "failed"
                  ? "failed"
                  : "partial",
        presentation,
        windowState,
    });
}
