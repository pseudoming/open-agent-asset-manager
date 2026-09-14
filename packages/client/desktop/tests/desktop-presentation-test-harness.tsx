import { type RenderResult, render } from "@testing-library/react";
import type { PropsWithChildren, ReactElement } from "react";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopPresentationSnapshot,
} from "../src/presentation/presentation-preferences";
import { DesktopPresentationProvider } from "../src/renderer/presentation";

export const ENGLISH_PRESENTATION_SNAPSHOT: DesktopPresentationSnapshot = createDesktopPresentationSnapshot(
    Object.freeze({
        ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
        onboardingCompleted: true,
    }),
    ["en-US"],
    false,
);

export function createDesktopPresentationTestBridge(
    snapshot: DesktopPresentationSnapshot = ENGLISH_PRESENTATION_SNAPSHOT,
): OaamDesktopBridge {
    return {
        initialAppIdentity: Object.freeze({ name: "Open Agent Asset Manager", version: "0.1.0-test" }),
        initialHostStartup: Object.freeze({ status: "starting" }),
        initialPresentation: snapshot,
        async retrySession() {},
        async pickProjectRoot() {
            return { status: "cancelled" };
        },
        async pickInstallationRoot() {
            return { status: "cancelled" };
        },
        async authorizeObservedProjectRoot() {
            return { status: "failed", code: "unavailable" };
        },
        async revealObservedProjectRoot() {
            return { status: "failed", code: "unavailable" };
        },
        async authorizeRegisteredProjectRoot() {
            return { status: "failed", code: "unavailable" };
        },
        async revealRegisteredProjectRoot() {
            return { status: "failed", code: "unavailable" };
        },
        async revealImportPreviewFile() {
            return { status: "failed", code: "unavailable" };
        },
        async pickSourceRoot() {
            return { status: "cancelled" };
        },
        async pickStateBackupDestination() {
            return { status: "cancelled" };
        },
        async selectRememberedStateBackupDestination() {
            return { status: "unavailable" };
        },
        async pickStateRestoreArchive() {
            return { status: "cancelled" };
        },
        async pickAssetVersionExport() {
            return { status: "cancelled" };
        },
        async pickSupportBundleExport() {
            return { status: "cancelled" };
        },
        async getStateResiliencePreferences() {
            return { schemaVersion: 1 };
        },
        async rememberStateBackupDestination() {
            return { schemaVersion: 1 };
        },
        async performStateBackupFileAction() {
            return { status: "complete" };
        },
        async completeOnboarding() {
            return snapshot;
        },
        async replacePresentationPreferences() {
            return snapshot;
        },
        async rememberLastProject() {
            return snapshot;
        },
        async replaceAssetLayout() {
            return snapshot;
        },
        async performWindowAction() {},
        async getDesktopMaintenance() {
            return {
                interfaceCache: { status: "available", byteSize: 0 },
                dataLocations: [
                    { locationId: "oaam_data", status: "available", displayPath: "/oaam" },
                    { locationId: "desktop_profile", status: "available", displayPath: "/profile" },
                    { locationId: "state_backups", status: "available", displayPath: "/oaam/backups" },
                    { locationId: "ordinary_logs", status: "available", displayPath: "/oaam/logs/ordinary" },
                    { locationId: "interface_cache", status: "available", displayPath: "/profile/cache" },
                ],
            };
        },
        async clearDesktopInterfaceCache() {
            return { status: "complete", interfaceCache: { status: "available", byteSize: 0 } };
        },
        async performDesktopDataLocationAction() {
            return { status: "complete" };
        },
        async restoreDesktopInterfaceDefaults() {
            return { status: "complete", presentation: "complete", windowState: "complete" };
        },
        async getDesktopPerformanceRecording() {
            return { state: "idle" };
        },
        async startDesktopPerformanceRecording() {
            return { state: "idle" };
        },
        async stopDesktopPerformanceRecording() {
            return { state: "idle" };
        },
        async saveDesktopPerformanceRecording() {
            return { status: "cancelled" };
        },
        async discardDesktopPerformanceRecording() {
            return { state: "idle" };
        },
        subscribeHostStartup() {
            return () => undefined;
        },
        subscribePresentation() {
            return () => undefined;
        },
        subscribeDesktopPerformanceRecording() {
            return () => undefined;
        },
    };
}

export function renderWithPresentation(
    element: ReactElement,
    bridge: OaamDesktopBridge = createDesktopPresentationTestBridge(),
): RenderResult {
    function PresentationWrapper({ children }: PropsWithChildren) {
        return <DesktopPresentationProvider bridge={bridge}>{children}</DesktopPresentationProvider>;
    }
    return render(element, { wrapper: PresentationWrapper });
}

export function ordinarySurfaceText(container: HTMLElement): string {
    const clone = container.cloneNode(true) as HTMLElement;
    for (const technicalDetail of clone.querySelectorAll("[data-oaam-technical-detail]")) technicalDetail.remove();
    return clone.textContent ?? "";
}
