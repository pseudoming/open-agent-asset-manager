import { useEffect, useState } from "react";
import type {
    DesktopDataLocationAction,
    DesktopDataLocationId,
    DesktopMaintenanceSnapshot,
    OaamDesktopBridge,
} from "../../../bridge/desktop-bridge";
import type { DesktopMessageId } from "../../presentation";
import { useDesktopPresentation } from "../../presentation";
import { formatBytes, WorkbenchNotice } from "../../ui";

const LOCATION_LABELS = {
    oaam_data: "settings.maintenance.location.oaam_data",
    desktop_profile: "settings.maintenance.location.desktop_profile",
    state_backups: "settings.maintenance.location.state_backups",
    ordinary_logs: "settings.maintenance.location.ordinary_logs",
    interface_cache: "settings.maintenance.location.interface_cache",
} as const satisfies Readonly<Record<DesktopDataLocationId, DesktopMessageId>>;

export interface DesktopMaintenanceWorkspaceProps {
    readonly desktopBridge: OaamDesktopBridge;
    readonly onInterfaceDefaultsRestored: () => void;
}

export function DesktopMaintenanceWorkspace({
    desktopBridge,
    onInterfaceDefaultsRestored,
}: DesktopMaintenanceWorkspaceProps): React.JSX.Element {
    const { snapshot: presentation, text } = useDesktopPresentation();
    const [snapshot, setSnapshot] = useState<DesktopMaintenanceSnapshot>();
    const [loadingFailed, setLoadingFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<DesktopMessageId>();

    useEffect(() => {
        let active = true;
        void desktopBridge.getDesktopMaintenance().then(
            (value) => {
                if (!active) return;
                setSnapshot(value);
                setLoadingFailed(false);
            },
            () => {
                if (active) setLoadingFailed(true);
            },
        );
        return () => {
            active = false;
        };
    }, [desktopBridge]);

    async function clearCache(): Promise<void> {
        setBusy(true);
        setOutcome(undefined);
        try {
            const result = await desktopBridge.clearDesktopInterfaceCache();
            setSnapshot((current) =>
                current === undefined ? current : Object.freeze({ ...current, interfaceCache: result.interfaceCache }),
            );
            setOutcome(
                result.status === "complete" ? "settings.maintenance.cache.complete" : "settings.maintenance.cache.failed",
            );
        } catch {
            setOutcome("settings.maintenance.cache.failed");
        } finally {
            setBusy(false);
        }
    }

    async function runLocationAction(locationId: DesktopDataLocationId, action: DesktopDataLocationAction): Promise<void> {
        setBusy(true);
        setOutcome(undefined);
        try {
            const result = await desktopBridge.performDesktopDataLocationAction(locationId, action);
            setOutcome(
                result.status === "complete"
                    ? action === "copy_path"
                        ? "settings.maintenance.location.copy_complete"
                        : "settings.maintenance.location.open_complete"
                    : "settings.maintenance.location.action_failed",
            );
        } catch {
            setOutcome("settings.maintenance.location.action_failed");
        } finally {
            setBusy(false);
        }
    }

    async function restoreDefaults(): Promise<void> {
        setBusy(true);
        setOutcome(undefined);
        try {
            const result = await desktopBridge.restoreDesktopInterfaceDefaults();
            if (result.presentation === "complete") onInterfaceDefaultsRestored();
            setOutcome(
                result.status === "complete"
                    ? "settings.maintenance.reset.complete"
                    : result.status === "partial"
                      ? "settings.maintenance.reset.partial"
                      : "settings.maintenance.reset.failed",
            );
        } catch {
            setOutcome("settings.maintenance.reset.failed");
        } finally {
            setBusy(false);
        }
    }

    function outcomeFor(section: "cache" | "location" | "reset"): React.JSX.Element | null {
        if (!outcome?.startsWith(`settings.maintenance.${section}.`)) return null;
        const tone = outcome.endsWith("failed") ? "danger" : outcome.endsWith("partial") ? "warning" : "note";
        return tone === "note" ? (
            <p className="workbench-status-copy" role="status">
                {text(outcome)}
            </p>
        ) : (
            <WorkbenchNotice tone={tone} role="alert">
                {text(outcome)}
            </WorkbenchNotice>
        );
    }

    return (
        <div
            className="desktop-maintenance"
            data-oaam-maintenance-state={loadingFailed ? "failed" : snapshot === undefined ? "loading" : "ready"}
            data-oaam-maintenance-location-count={snapshot?.dataLocations.length ?? 0}
        >
            <div className="settings-section-heading">
                <p>{text("settings.maintenance.copy")}</p>
            </div>

            {loadingFailed ? <WorkbenchNotice tone="danger">{text("settings.maintenance.load_failed")}</WorkbenchNotice> : null}

            <section className="desktop-maintenance-group" aria-labelledby="desktop-interface-cache-title">
                <div>
                    <h3 id="desktop-interface-cache-title">{text("settings.maintenance.cache.title")}</h3>
                    <p>{text("settings.maintenance.cache.copy")}</p>
                    <strong>
                        {snapshot?.interfaceCache.status === "available"
                            ? formatBytes(snapshot.interfaceCache.byteSize, presentation.resolvedLocale)
                            : text("settings.maintenance.cache.unavailable")}
                    </strong>
                    {outcomeFor("cache")}
                </div>
                <button
                    data-oaam-interaction-entry="features.desktop-maintenance.desktop_maintenance_workspace.001"
                    type="button"
                    className="library-secondary-button"
                    disabled={busy}
                    onClick={() => void clearCache()}
                >
                    {text("settings.maintenance.cache.clear")}
                </button>
            </section>

            <section
                className="desktop-maintenance-group desktop-maintenance-locations"
                aria-labelledby="desktop-locations-title"
            >
                <div>
                    <h3 id="desktop-locations-title">{text("settings.maintenance.locations.title")}</h3>
                    <p>{text("settings.maintenance.locations.copy")}</p>
                </div>
                <ul>
                    {snapshot?.dataLocations.map((location) => (
                        <li key={location.locationId}>
                            <div>
                                <strong>{text(LOCATION_LABELS[location.locationId])}</strong>
                                <code>
                                    {location.status === "available"
                                        ? location.displayPath
                                        : text("settings.maintenance.location.unavailable")}
                                </code>
                            </div>
                            <div className="desktop-maintenance-actions">
                                <button
                                    data-oaam-interaction-entry="features.desktop-maintenance.desktop_maintenance_workspace.002"
                                    type="button"
                                    className="library-secondary-button"
                                    disabled={busy || location.status !== "available"}
                                    onClick={() => void runLocationAction(location.locationId, "copy_path")}
                                >
                                    {text("settings.maintenance.location.copy_path")}
                                </button>
                                <button
                                    data-oaam-interaction-entry="features.desktop-maintenance.desktop_maintenance_workspace.003"
                                    type="button"
                                    className="library-secondary-button"
                                    disabled={busy || location.status !== "available"}
                                    onClick={() => void runLocationAction(location.locationId, "open")}
                                >
                                    {text("settings.maintenance.location.open")}
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
                {outcomeFor("location")}
            </section>

            <section className="desktop-maintenance-group" aria-labelledby="desktop-reset-title">
                <div>
                    <h3 id="desktop-reset-title">{text("settings.maintenance.reset.title")}</h3>
                    <p>{text("settings.maintenance.reset.copy")}</p>
                    <p>{text("settings.maintenance.reset.preserved")}</p>
                    {outcomeFor("reset")}
                </div>
                <button
                    data-oaam-interaction-entry="features.desktop-maintenance.desktop_maintenance_workspace.004"
                    type="button"
                    className="library-secondary-button"
                    disabled={busy}
                    onClick={() => void restoreDefaults()}
                >
                    {text("settings.maintenance.reset.action")}
                </button>
            </section>
        </div>
    );
}
