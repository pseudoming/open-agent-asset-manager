import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopMaintenanceSnapshot, OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import { DesktopMaintenanceWorkspace } from "../src/renderer/features/desktop-maintenance";
import { createDesktopPresentationTestBridge, renderWithPresentation } from "./desktop-presentation-test-harness";

const SNAPSHOT: DesktopMaintenanceSnapshot = Object.freeze({
    interfaceCache: Object.freeze({ status: "available", byteSize: 2048 }),
    dataLocations: Object.freeze([
        Object.freeze({ locationId: "oaam_data", status: "available", displayPath: "/profile/oaam" }),
        Object.freeze({ locationId: "desktop_profile", status: "available", displayPath: "/profile" }),
        Object.freeze({ locationId: "state_backups", status: "available", displayPath: "/profile/oaam/backups" }),
        Object.freeze({
            locationId: "ordinary_logs",
            status: "available",
            displayPath: "/profile/oaam/logs/ordinary",
        }),
        Object.freeze({ locationId: "interface_cache", status: "unavailable" }),
    ]),
});

afterEach(cleanup);

function maintenanceBridge(overrides: Partial<OaamDesktopBridge> = {}): OaamDesktopBridge {
    return {
        ...createDesktopPresentationTestBridge(),
        getDesktopMaintenance: vi.fn(async () => SNAPSHOT),
        clearDesktopInterfaceCache: vi.fn(async () => ({
            status: "complete",
            interfaceCache: { status: "available", byteSize: 0 },
        })),
        performDesktopDataLocationAction: vi.fn(async () => ({ status: "complete" })),
        restoreDesktopInterfaceDefaults: vi.fn(async () => ({
            status: "complete",
            presentation: "complete",
            windowState: "complete",
        })),
        ...overrides,
    };
}

describe("Desktop maintenance UI", () => {
    it("shows measured cache and exact locations, then runs only finite bridge actions", async () => {
        const bridge = maintenanceBridge();
        const restored = vi.fn();
        renderWithPresentation(
            createElement(DesktopMaintenanceWorkspace, {
                desktopBridge: bridge,
                onInterfaceDefaultsRestored: restored,
            }),
            bridge,
        );

        expect(await screen.findByText("2 KiB")).not.toBeNull();
        expect(screen.getByText("/profile/oaam")).not.toBeNull();
        expect(screen.getAllByText("Unavailable")).toHaveLength(1);
        expect((screen.getAllByRole("button", { name: "Open" }).at(-1) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(screen.getByRole("button", { name: "Clear interface cache" }));
        expect(await screen.findByText("The interface cache was cleared.")).not.toBeNull();
        expect(screen.getByText("0 B")).not.toBeNull();

        fireEvent.click(screen.getAllByRole("button", { name: "Copy path" })[0] as HTMLButtonElement);
        expect(await screen.findByText("The path was copied.")).not.toBeNull();
        expect(bridge.performDesktopDataLocationAction).toHaveBeenCalledWith("oaam_data", "copy_path");

        fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0] as HTMLButtonElement);
        expect(await screen.findByText("The location was opened.")).not.toBeNull();
        expect(bridge.performDesktopDataLocationAction).toHaveBeenCalledWith("oaam_data", "open");

        fireEvent.click(screen.getByRole("button", { name: "Restore interface defaults" }));
        expect(await screen.findByText("Interface defaults were restored.")).not.toBeNull();
        expect(restored).toHaveBeenCalledOnce();
    });

    it("surfaces inspection and operation failures without claiming reset completion", async () => {
        const restored = vi.fn();
        const bridge = maintenanceBridge({
            getDesktopMaintenance: vi.fn(async () => {
                throw new Error("inspection failed");
            }),
            clearDesktopInterfaceCache: vi.fn(async () => {
                throw new Error("clear failed");
            }),
            performDesktopDataLocationAction: vi.fn(async () => ({
                status: "failed",
                code: "open_failed",
            })),
            restoreDesktopInterfaceDefaults: vi.fn(async () => ({
                status: "failed",
                presentation: "failed",
                windowState: "failed",
            })),
        });
        renderWithPresentation(
            createElement(DesktopMaintenanceWorkspace, {
                desktopBridge: bridge,
                onInterfaceDefaultsRestored: restored,
            }),
            bridge,
        );
        expect(await screen.findByText("Local maintenance information could not be inspected.")).not.toBeNull();
        expect(screen.getByText("Size unavailable")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Clear interface cache" }));
        const cacheFailure = await screen.findByText("The interface cache could not be cleared.");
        expect(cacheFailure.closest("section")?.getAttribute("aria-labelledby")).toBe("desktop-interface-cache-title");
        fireEvent.click(screen.getByRole("button", { name: "Restore interface defaults" }));
        const resetFailure = await screen.findByText("Interface defaults could not be restored.");
        expect(resetFailure.closest("section")?.getAttribute("aria-labelledby")).toBe("desktop-reset-title");
        expect(restored).not.toHaveBeenCalled();
    });

    it("reports partial reset and failed finite location actions precisely", async () => {
        const restored = vi.fn();
        const bridge = maintenanceBridge({
            performDesktopDataLocationAction: vi.fn(async () => ({
                status: "failed",
                code: "copy_failed",
            })),
            restoreDesktopInterfaceDefaults: vi.fn(async () => ({
                status: "partial",
                presentation: "complete",
                windowState: "failed",
            })),
        });
        renderWithPresentation(
            createElement(DesktopMaintenanceWorkspace, {
                desktopBridge: bridge,
                onInterfaceDefaultsRestored: restored,
            }),
            bridge,
        );
        await screen.findByText("/profile/oaam");
        fireEvent.click(screen.getAllByRole("button", { name: "Copy path" })[0] as HTMLButtonElement);
        expect(await screen.findByText("The selected data-location action failed.")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Restore interface defaults" }));
        expect(
            await screen.findByText("Some interface defaults were restored. Retry to finish the remaining part."),
        ).not.toBeNull();
        await waitFor(() => expect(restored).toHaveBeenCalledOnce());
    });
});
