import { type CSSProperties, useMemo, useState } from "react";
import type { OaamDesktopBridge } from "../../bridge/desktop-bridge";
import { DESKTOP_PANE_WIDTHS } from "../../presentation/presentation-preferences";
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_PRESENTATION, type SettingsCategory } from "../app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../client";
import { DesktopMaintenanceWorkspace } from "../features/desktop-maintenance";
import { DiagnosticsWorkspace } from "../features/diagnostics";
import { DiscoveryController, DiscoveryWorkspace } from "../features/discovery";
import { RetainedProjectSettings } from "../features/project-library";
import { StateResilienceWorkspace } from "../features/state-resilience";
import { PresentationPreferences, useDesktopPaneWidths, useDesktopPresentation } from "../presentation";
import { TransientWorkbenchSidebar } from "../shell/TransientWorkbenchSidebar";
import { DesktopIcon, WorkbenchPanel, WorkbenchResizeSeparator } from "../ui";

const RECOVERY_REASON_MESSAGES = {
    missing_database: "state_resilience.recovery.reason.missing_database",
    corrupt_database: "state_resilience.recovery.reason.corrupt_database",
    incompatible_database: "state_resilience.recovery.reason.incompatible_database",
    restore_reconciliation: "state_resilience.recovery.reason.restore_reconciliation",
} as const;

export interface SettingsPageProps {
    readonly category: SettingsCategory;
    readonly client: DesktopApplicationClientApi;
    readonly desktopBridge: OaamDesktopBridge;
    readonly sidebarVisible: boolean;
    readonly onCategoryChange: (category: SettingsCategory) => void;
    readonly onClose: () => void;
    readonly onOpenGuidedImport: () => void;
    readonly onInterfaceDefaultsRestored: () => void;
    readonly recoveryReason?: "missing_database" | "corrupt_database" | "incompatible_database" | "restore_reconciliation";
}

interface SettingsCategoryContentsProps {
    readonly category: SettingsCategory;
    readonly client: DesktopApplicationClientApi;
    readonly desktopBridge: OaamDesktopBridge;
    readonly discoveryController: DiscoveryController;
    readonly onOpenGuidedImport: () => void;
    readonly onInterfaceDefaultsRestored: () => void;
}

function SettingsCategoryContents({
    category,
    client,
    desktopBridge,
    discoveryController,
    onOpenGuidedImport,
    onInterfaceDefaultsRestored,
}: SettingsCategoryContentsProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    switch (category) {
        case "general":
            return (
                <>
                    <WorkbenchPanel className="settings-section" aria-label={text("settings.general.title")}>
                        <div className="settings-section-heading">
                            <p>{text("settings.general.copy")}</p>
                        </div>
                        <PresentationPreferences />
                    </WorkbenchPanel>
                    <RetainedProjectSettings client={client} desktopBridge={desktopBridge} />
                    <WorkbenchPanel className="settings-section settings-privacy" aria-labelledby="settings-privacy-title">
                        <div className="settings-section-heading">
                            <h2 id="settings-privacy-title">{text("settings.privacy.title")}</h2>
                        </div>
                        <ul>
                            <li>{text("settings.privacy.read")}</li>
                            <li>{text("settings.privacy.no_session")}</li>
                            <li>{text("settings.privacy.no_write")}</li>
                        </ul>
                    </WorkbenchPanel>
                </>
            );
        case "environments":
            return (
                <WorkbenchPanel className="settings-section settings-section-plain" aria-label={text("settings.runtime.title")}>
                    <div className="settings-section-heading">
                        <p>{text("settings.runtime.copy")}</p>
                        <button
                            type="button"
                            className="library-secondary-button"
                            data-oaam-semantic-action="settings.start_guided_import"
                            data-oaam-semantic-entry="settings.guided_import.runtime"
                            onClick={() => onOpenGuidedImport()}
                        >
                            {text("settings.runtime.guided_setup")}
                        </button>
                    </div>
                    <DiscoveryWorkspace
                        controller={discoveryController}
                        client={client}
                        authorizeObservedProjectRoot={(reference) => desktopBridge.authorizeObservedProjectRoot(reference)}
                        revealObservedProjectRoot={(reference) => desktopBridge.revealObservedProjectRoot(reference)}
                    />
                </WorkbenchPanel>
            );
        case "backup_recovery":
            return (
                <WorkbenchPanel className="settings-section settings-section-plain" id="state-resilience-settings">
                    <StateResilienceWorkspace client={client} desktopBridge={desktopBridge} recoveryOnly={false} />
                </WorkbenchPanel>
            );
        case "diagnostics":
            return (
                <WorkbenchPanel className="settings-section settings-section-plain">
                    <DiagnosticsWorkspace client={client} desktopBridge={desktopBridge} />
                </WorkbenchPanel>
            );
        case "maintenance":
            return (
                <WorkbenchPanel className="settings-section settings-section-plain" id="desktop-maintenance-settings">
                    <DesktopMaintenanceWorkspace
                        desktopBridge={desktopBridge}
                        onInterfaceDefaultsRestored={onInterfaceDefaultsRestored}
                    />
                </WorkbenchPanel>
            );
    }
}

export function SettingsPage({
    category,
    client,
    desktopBridge,
    sidebarVisible,
    onCategoryChange,
    onClose,
    onOpenGuidedImport,
    onInterfaceDefaultsRestored,
    recoveryReason,
}: SettingsPageProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const discoveryController = useMemo(
        () =>
            new DiscoveryController(client, {
                createUserActionId: () => globalThis.crypto.randomUUID(),
            }),
        [client],
    );
    const paneWidths = useDesktopPaneWidths();
    const [settingsSearch, setSettingsSearch] = useState("");
    const normalizedSettingsSearch = settingsSearch.trim().toLocaleLowerCase();
    const visibleCategories =
        normalizedSettingsSearch === ""
            ? SETTINGS_CATEGORIES
            : SETTINGS_CATEGORIES.filter((candidate) => {
                  const presentation = SETTINGS_CATEGORY_PRESENTATION[candidate];
                  return `${text(presentation.title)} ${text(presentation.copy)}`
                      .toLocaleLowerCase()
                      .includes(normalizedSettingsSearch);
              });

    if (recoveryReason !== undefined) {
        return (
            <main className="settings-shell settings-recovery-shell" data-oaam-route="recovery_settings" data-oaam-state="ready">
                <header className="settings-toolbar">
                    <div>
                        <p className="eyebrow">{text("state_resilience.recovery.eyebrow")}</p>
                        <h1>{text("state_resilience.recovery.title")}</h1>
                    </div>
                </header>
                <div className="settings-scroll" data-oaam-settings-scroll-owner="backup_recovery">
                    <div className="settings-scroll-content">
                        <WorkbenchPanel className="settings-section" id="state-resilience-settings">
                            <StateResilienceWorkspace
                                client={client}
                                desktopBridge={desktopBridge}
                                recoveryOnly
                                recoveryMessage={text(RECOVERY_REASON_MESSAGES[recoveryReason])}
                            />
                        </WorkbenchPanel>
                        <span data-oaam-settings-scroll-sentinel="backup_recovery" />
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main
            className="settings-workbench-shell"
            data-oaam-route="settings"
            data-oaam-state="ready"
            data-sidebar-open={sidebarVisible}
            data-settings-category={category}
            style={{ "--oaam-left-pane-width": `${paneWidths.widths.left}px` } as CSSProperties}
        >
            <TransientWorkbenchSidebar
                data-oaam-interaction-entry="pages.settings_page.002"
                className="settings-sidebar"
                persistentVisible={sidebarVisible}
                restoreFocusElementId="oaam-workbench-sidebar-toggle"
            >
                <div className="settings-sidebar-tools">
                    <button
                        type="button"
                        className="workbench-sidebar-return settings-return-button"
                        data-oaam-semantic-action="settings.open_application"
                        data-oaam-semantic-entry="settings.application.sidebar"
                        onClick={() => onClose()}
                    >
                        <DesktopIcon name="back" size={15} />
                        {text("settings.back_to_app")}
                    </button>
                    <label className="settings-search">
                        <span className="sr-only">{text("settings.search")}</span>
                        <input
                            data-oaam-interaction-entry="pages.settings_page.004"
                            type="search"
                            value={settingsSearch}
                            placeholder={text("settings.search")}
                            onChange={(event) => setSettingsSearch(event.currentTarget.value)}
                        />
                    </label>
                </div>
                <nav aria-label={text("settings.title")}>
                    {visibleCategories.map((candidate) => (
                        <button
                            data-oaam-interaction-entry="pages.settings_page.005"
                            type="button"
                            aria-current={candidate === category ? "page" : undefined}
                            className="settings-category-button"
                            data-oaam-settings-category={candidate}
                            key={candidate}
                            onClick={() => onCategoryChange(candidate)}
                        >
                            {text(SETTINGS_CATEGORY_PRESENTATION[candidate].title)}
                        </button>
                    ))}
                    {visibleCategories.length === 0 ? (
                        <p className="settings-search-empty">{text("settings.search_no_results")}</p>
                    ) : null}
                </nav>
            </TransientWorkbenchSidebar>
            {sidebarVisible ? (
                <WorkbenchResizeSeparator
                    data-oaam-interaction-entry="pages.settings_page.006"
                    label={text("preferences.left_pane.label")}
                    value={paneWidths.widths.left}
                    minimum={DESKTOP_PANE_WIDTHS.left.minimum}
                    maximum={DESKTOP_PANE_WIDTHS.left.maximum}
                    onPreview={paneWidths.previewLeft}
                    onCommit={paneWidths.commitLeft}
                />
            ) : null}
            <section className="settings-workbench">
                <header className="settings-toolbar">
                    <h1>{text(SETTINGS_CATEGORY_PRESENTATION[category].title)}</h1>
                </header>
                <div className="settings-scroll" data-oaam-settings-scroll-owner={category}>
                    <div className="settings-scroll-content">
                        {paneWidths.saveFailed ? (
                            <small className="presentation-preferences-error" role="alert">
                                {text("preferences.save_failed")}
                            </small>
                        ) : null}
                        <SettingsCategoryContents
                            category={category}
                            client={client}
                            desktopBridge={desktopBridge}
                            discoveryController={discoveryController}
                            onOpenGuidedImport={onOpenGuidedImport}
                            onInterfaceDefaultsRestored={onInterfaceDefaultsRestored}
                        />
                        <span data-oaam-settings-scroll-sentinel={category} />
                    </div>
                </div>
            </section>
        </main>
    );
}
