import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { forwardUtilityDeploymentTiming } from "./utility-host-deployment-timing";
import { getRunningWslDistroNames, getWslAccessRootPath, resolveWslHomePath } from "@oaam/shared/paths";
import type { MenuItemConstructorOptions } from "electron";
import {
    app,
    BrowserWindow,
    clipboard,
    contentTracing,
    dialog,
    ipcMain,
    Menu,
    MessageChannelMain,
    nativeTheme,
    screen,
    shell,
    Tray,
    utilityProcess,
} from "electron";
import {
    APP_IDENTITY_GET_CHANNEL,
    ASSET_LAYOUT_REPLACE_CHANNEL,
    type DesktopHostStartupSnapshot,
    HOST_RETRY_CHANNEL,
    HOST_STARTUP_CHANGED_CHANNEL,
    HOST_STARTUP_GET_CHANNEL,
    LAST_PROJECT_REPLACE_CHANNEL,
    ONBOARDING_COMPLETE_CHANNEL,
    PACKAGED_ONBOARDING_PROOF_PORT_CHANNEL,
    PRESENTATION_CHANGED_CHANNEL,
    PRESENTATION_GET_CHANNEL,
    PRESENTATION_REPLACE_CHANNEL,
    PROTOCOL_PORT_CHANNEL,
    parseDesktopBackupId,
    parseDesktopStateBackupFileAction,
    parsePackagedOnboardingProofReply,
    STATE_BACKUP_DESTINATION_PICK_CHANNEL,
    STATE_BACKUP_DESTINATION_REMEMBER_CHANNEL,
    STATE_BACKUP_FILE_ACTION_CHANNEL,
    STATE_BACKUP_REMEMBERED_DESTINATION_CHANNEL,
    STATE_RESILIENCE_PREFERENCES_GET_CHANNEL,
    STATE_RESTORE_ARCHIVE_PICK_CHANNEL,
} from "../bridge/desktop-bridge";
import { formatDesktopMessage } from "../presentation/localization";
import {
    type DesktopPresentationSnapshot,
    isDesktopAssetLayoutPreference,
    parseDesktopPresentationPreferenceInput,
    parseDesktopProjectId,
} from "../presentation/presentation-preferences";
import type { DesktopHostBootOptions } from "../process/control-protocol";
import { registerAssetVersionExportIpc } from "./asset-version-export-ipc";
import { installDesktopDiagnosticsRuntime } from "./desktop-diagnostics-runtime";
import { registerDesktopMaintenanceIpc } from "./desktop-maintenance-ipc";
import { DesktopPreferencesStore } from "./desktop-preferences-store";
import { startDesktopRelease } from "./desktop-release";
import { DesktopPresentationAuthority } from "./desktop-presentation-authority";
import { createDesktopWindowActionDependencies, installDesktopRendererRecovery } from "./desktop-renderer-recovery";
import { registerDesktopWindowRuntimeIpc } from "./desktop-window-runtime-ipc";
import { projectDesktopHostStartup, recoverDesktopSession } from "./host-startup-projection";
import { DesktopQuitCoordinator } from "./desktop-quit-coordinator";
import { registerImportPreviewFileIpc } from "./import-preview-file-ipc";
import { registerNativeDirectoryPickerIpc } from "./native-directory-picker-ipc";
import {
    PACKAGED_ASSET_LIFECYCLE_LINE,
    PACKAGED_ASSET_LIFECYCLE_SMOKE_SWITCH,
    provePackagedAssetLifecycle,
    resolvePackagedAssetLifecycleExportPath,
} from "./packaged-asset-lifecycle-smoke";
import { snapshotPackagedAssetUsageAuthority } from "./packaged-asset-usage-ui-smoke";
import { PackagedDiagnosticsSmokeController } from "./packaged-diagnostics-smoke";
import { PACKAGED_RUNTIME_ENVIRONMENT_LINE, proveWindowsWslEnvironmentChoice } from "./packaged-environment-choice-smoke";
import { proveWindowsPackagedProviderJourney } from "./packaged-onboarding-provider-sweep";
import {
    applyPackagedOnboardingWslProjectPlatformContexts,
    packagedOnboardingWslHomeResolver,
    packagedOnboardingWslProjectRegistrationFixture,
    packagedOnboardingWslProjectSmokeActive,
    packagedOnboardingWslProviderSourceIgnoreFixture,
} from "./packaged-onboarding-wsl-project-smoke";
import {
    applyPackagedOpenCodeProjectProofPlatformContexts,
    PackagedOpenCodeProjectSmokeController,
    packagedOpenCodeProjectMode,
} from "./packaged-opencode-project-smoke";
import * as packagedProjectLifecycleProof from "./packaged-project-lifecycle-smoke";
import {
    authorizePackagedProofLaunch,
    PACKAGED_PROVIDER_DISCOVERY_REVIEW_SMOKE_SWITCH,
    PACKAGED_PROVIDER_PROJECT_REGISTRATION_SMOKE_SWITCH,
    PACKAGED_PROVIDER_SOURCE_IGNORE_SMOKE_SWITCH,
    PACKAGED_PROJECT_ASSET_IMPORT_SMOKE_SWITCH,
    packagedProviderProofLine,
    readPackagedProofFixtureSubjects,
    settlePackagedProof,
} from "./packaged-proof-launch-authority";
import * as retainedProjectProof from "./packaged-retained-project-recovery-ui-smoke";
import {
    DesktopRuntimeSmokeController,
    type DesktopSecondInstanceProbe,
    PACKAGED_RUNTIME_SINGLE_INSTANCE_PROBE_SWITCH,
    PACKAGED_RUNTIME_SMOKE_SWITCH,
    PACKAGED_STARTUP_RECOVERY_LINE,
    PACKAGED_STARTUP_RECOVERY_SMOKE_SWITCH,
} from "./packaged-runtime-smoke";
import {
    packagedStateResilienceMode,
    packagedStateResilienceProofLine,
    provePackagedStateResilience,
    resolvePackagedStateRestoreArchive,
} from "./packaged-state-resilience-smoke";
import * as workbenchProof from "./packaged-workbench-screenshot-proof";
import { packagedZcodeTargetMode, preparePackagedZcodeTargetProof } from "./packaged-zcode-target-smoke";
import { DesktopPerformanceRecordingAuthority } from "./performance-recording";
import { discoverDesktopPlatformContexts } from "./platform-contexts";
import { registerProjectRootIpc } from "./registered-project-root-ipc";
import { DesktopSingleInstanceAuthority } from "./single-instance";
import { desktopStateBackupTrashRoute } from "./state-backup-file-actions";
import { DesktopStateResiliencePreferencesStore } from "./state-resilience-preferences-store";
import { DesktopTrayAuthority, type DesktopTrayMenuItem, desktopTrayLabels, resolveDesktopTrayIconPath } from "./tray-lifecycle";
import { UtilityHostSupervisor, type UtilityHostSupervisorEvent, type UtilityProcessHandle } from "./utility-host-supervisor";
import { desktopWindowActionFromShortcut, performDesktopWindowAction } from "./window-actions";
import {
    applyDesktopWindowAppearance,
    createDesktopWindowOptions,
    lockDesktopNavigation,
    lockDesktopPermissions,
} from "./window-security";
import {
    applyDesktopWindowPlacement,
    DesktopWindowStateStore,
    resolveDesktopWindowState,
    restoreDesktopWindowDefaults,
} from "./window-state-store";

const proofAuthorization = authorizePackagedProofLaunch({ argv: process.argv, environment: process.env });
const startupRecoverySmoke = process.argv.includes(PACKAGED_STARTUP_RECOVERY_SMOKE_SWITCH);
const packagedRuntimeSmoke = process.argv.includes(PACKAGED_RUNTIME_SMOKE_SWITCH);
const providerDiscovery = process.argv.includes(PACKAGED_PROVIDER_DISCOVERY_REVIEW_SMOKE_SWITCH);
const providerRegistration = process.argv.includes(PACKAGED_PROVIDER_PROJECT_REGISTRATION_SMOKE_SWITCH);
const providerIgnore = process.argv.includes(PACKAGED_PROVIDER_SOURCE_IGNORE_SMOKE_SWITCH);
const projectImport = process.argv.includes(PACKAGED_PROJECT_ASSET_IMPORT_SMOKE_SWITCH);
const providerJourneySmoke = providerDiscovery || providerRegistration || providerIgnore || projectImport;
const packagedOnboardingWslProjectSmoke = packagedOnboardingWslProjectSmokeActive(
    packagedRuntimeSmoke || providerJourneySmoke,
    process.platform,
);
const openCodeProjectSmokeMode = packagedOpenCodeProjectMode(process.argv);
const packagedWorkbenchMode = workbenchProof.packagedWorkbenchProofMode(process.argv);
const packagedWorkbenchUiSmoke = packagedWorkbenchMode === "journey";
const zcodeTargetSmokeMode = packagedZcodeTargetMode(process.argv);
const stateResilienceSmokeMode = packagedStateResilienceMode(process.argv);
const projectLifecycleSmoke = process.argv.includes(packagedProjectLifecycleProof.PACKAGED_PROJECT_LIFECYCLE_SMOKE_SWITCH);
const retainedProjectSmokeMode = retainedProjectProof.packagedRetainedProjectProofMode(process.argv);
const assetLifecycleSmoke = process.argv.includes(PACKAGED_ASSET_LIFECYCLE_SMOKE_SWITCH);
let provePackagedOnboardingImport: (() => Promise<void>) | undefined;
const runtimeSmoke = new DesktopRuntimeSmokeController(
    packagedRuntimeSmoke || startupRecoverySmoke,
    {
        writeOutput: (text) => process.stdout.write(text),
        writeError: (text) => process.stderr.write(text),
        requestQuit(failed) {
            if (failed) process.exitCode = 1;
            app.quit();
        },
        proveOnboardingImport() {
            const prove = provePackagedOnboardingImport;
            if (prove === undefined) return Promise.reject(new Error("Packaged onboarding proof connection is unavailable"));
            return prove();
        },
        startSecondInstanceProbe,
    },
    startupRecoverySmoke || process.platform === "win32" ? { timeoutMs: packagedRuntimeSmoke ? 180_000 : 60_000 } : {},
);
const singleInstance = new DesktopSingleInstanceAuthority(app, () => runtimeSmoke.secondInstanceObserved());
let utilityHostSpawnCount = 0;
const platform = () => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");

function launchOptions(): DesktopHostBootOptions {
    const oaamRoot = desktopOaamRoot();
    const platformContexts = applyPackagedOpenCodeProjectProofPlatformContexts(
        openCodeProjectSmokeMode,
        process.env,
        discoverDesktopPlatformContexts({
            hostPlatform: platform(),
            homePath: app.getPath("home"),
            getRunningWslDistroNames,
            getWslAccessRootPath,
        }),
    );
    return Object.freeze({
        oaamRoot,
        databasePath: path.join(oaamRoot, "oaam.sqlite"),
        platformContexts: applyPackagedOnboardingWslProjectPlatformContexts(
            packagedOnboardingWslProjectSmoke,
            process.env,
            platformContexts,
        ),
    });
}

function desktopOaamRoot(): string {
    return path.join(app.getPath("userData"), "oaam");
}

function spawnUtilityHost(): UtilityProcessHandle {
    utilityHostSpawnCount += 1;
    const suppressFirstBoot =
        (startupRecoverySmoke && utilityHostSpawnCount === 1) || (packagedWorkbenchUiSmoke && utilityHostSpawnCount <= 2);
    const child = utilityProcess.fork(path.join(__dirname, "../host/index.js"), [], {
        serviceName: "OAAM Production Host",
        stdio: "pipe",
    });
    const detachDeploymentTiming = forwardUtilityDeploymentTiming(child.stderr);
    child.once("exit", detachDeploymentTiming);
    return {
        onMessage(listener) {
            child.on("message", listener);
            return () => child.off("message", listener);
        },
        onExit(listener) {
            child.on("exit", listener);
            return () => child.off("exit", listener);
        },
        postMessage(message, transfer = []) {
            if (suppressFirstBoot && message.type === "boot") return;
            child.postMessage(message, [...transfer] as Electron.MessagePortMain[]);
        },
        kill() {
            return child.kill();
        },
    };
}

function startSecondInstanceProbe(): DesktopSecondInstanceProbe {
    const child = spawn(
        process.execPath,
        [
            ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []),
            `--user-data-dir=${app.getPath("userData")}`,
            PACKAGED_RUNTIME_SINGLE_INSTANCE_PROBE_SWITCH,
        ],
        {
            env: process.env,
            stdio: "ignore",
        },
    );
    let settled = false;
    const completed = new Promise<number | null>((resolve, reject) => {
        child.once("error", (error) => {
            settled = true;
            reject(error);
        });
        child.once("exit", (exitCode) => {
            settled = true;
            resolve(exitCode);
        });
    });
    return {
        completed,
        terminate() {
            if (!settled) child.kill();
        },
    };
}

function desktopTrayMenu(items: readonly DesktopTrayMenuItem[]): ReturnType<typeof Menu.buildFromTemplate> {
    return Menu.buildFromTemplate(
        items.map(
            (item): MenuItemConstructorOptions =>
                item.kind === "separator"
                    ? { type: "separator" }
                    : { id: item.id, label: item.label, enabled: item.enabled, click: item.run },
        ),
    );
}

function startPrimaryDesktop(productVersion: string): void {
    let mainWindow: BrowserWindow | null = null;
    let quitting = false;
    let hostStartup: DesktopHostStartupSnapshot = Object.freeze({ status: "starting" });
    let trayInitialized = false;
    let startupRecoveryProofWritten = false;
    let zcodeTargetProofStarted = false;
    let stateResilienceProofStarted = false;
    let projectLifecycleProofStarted = false;
    let assetLifecycleProofStarted = false;
    let providerProjectProofStarted = false;
    let workbenchUiProofStarted = false;
    let diagnosticsIpcDisposed = false;
    const userDataRoot = app.getPath("userData");
    const oaamRoot = desktopOaamRoot();
    const desktopPreferences = new DesktopPreferencesStore(userDataRoot);
    const windowState = new DesktopWindowStateStore(userDataRoot);
    const stateResiliencePreferences = new DesktopStateResiliencePreferencesStore(userDataRoot);
    const performanceRecording = new DesktopPerformanceRecordingAuthority({
        contentTracing,
        temporaryRootPath: app.getPath("temp"),
    });
    const presentation = new DesktopPresentationAuthority(desktopPreferences, {
        getPreferredSystemLanguages: () => app.getPreferredSystemLanguages(),
        shouldUseDarkColors: () => nativeTheme.shouldUseDarkColors,
        setThemeSource: (theme) => {
            nativeTheme.themeSource = theme;
        },
    });
    const tray = new DesktopTrayAuthority(
        {
            createTray(iconPath) {
                const electronTray = new Tray(iconPath);
                return {
                    setToolTip: (tooltip) => electronTray.setToolTip(tooltip),
                    setContextMenu: (menu) => electronTray.setContextMenu(menu as ReturnType<typeof Menu.buildFromTemplate>),
                    onClick: (listener) => {
                        electronTray.on("click", listener);
                    },
                    destroy: () => electronTray.destroy(),
                };
            },
            buildMenu: desktopTrayMenu,
        },
        {
            showPrimaryWindow: () => singleInstance.showPrimaryWindow(),
            requestQuit: () => app.quit(),
        },
    );
    let boot: DesktopHostBootOptions | undefined;
    const supervisor = new UtilityHostSupervisor(
        {
            spawn: spawnUtilityHost,
            createChannel() {
                const channel = new MessageChannelMain();
                return { hostPort: channel.port1, clientPort: channel.port2 };
            },
            async readDesktopPreferences() {
                return presentation.exportPreferences();
            },
            async applyRestoredDesktopPreferences(bytes, restoreTransactionPath) {
                publishPresentation(presentation.applyRestoredPreferences(bytes, restoreTransactionPath));
            },
        },
        () => (boot = launchOptions()),
    );
    const packagedProofChannels = {
        createChannel() {
            const channel = new MessageChannelMain();
            return { hostPort: channel.port1, clientPort: channel.port2 };
        },
    };
    const packagedProofIo = {
        writeOutput: (text: string) => process.stdout.write(text),
        writeError: (text: string) => process.stderr.write(text),
        requestShutdown(failed: boolean) {
            if (failed) process.exitCode = 1;
            quitting = true;
            supervisor.shutdown();
        },
    };
    const packagedOpenCodeProjectProof = new PackagedOpenCodeProjectSmokeController({
        mode: openCodeProjectSmokeMode,
        environment: process.env,
        connect: () => supervisor.connect({ claimPathSelectionAuthority: false }),
        resultChannels: packagedProofChannels,
        ...packagedProofIo,
    });
    const packagedDiagnostics = new PackagedDiagnosticsSmokeController(process.argv, {
        homePath: () => app.getPath("home"),
        channels: packagedProofChannels,
        ...packagedProofIo,
    });
    provePackagedOnboardingImport = async () => {
        const window = mainWindow;
        if (window === null || supervisor.state !== "ready") {
            return Promise.reject(new Error("Packaged onboarding proof renderer is unavailable"));
        }
        if (process.platform === "win32") {
            try {
                if (packagedRuntimeSmoke || providerJourneySmoke) {
                    const proofWslHome = packagedOnboardingWslHomeResolver(
                        packagedOnboardingWslProjectSmoke,
                        process.env,
                        resolveWslHomePath,
                    );
                    await proveWindowsPackagedProviderJourney(
                        window.webContents,
                        proofWslHome,
                        app.getPath("temp"),
                        () => snapshotPackagedAssetUsageAuthority(oaamRoot, desktopPreferences.exportBytes()),
                        projectImport
                            ? { projectAssetImportProfileRootPath: proofAuthorization?.profileRootPath }
                            : providerIgnore
                              ? (packagedOnboardingWslProviderSourceIgnoreFixture(true, process.env) ?? false)
                              : providerRegistration
                                ? (packagedOnboardingWslProjectRegistrationFixture(true, process.env) ?? false)
                                : providerDiscovery,
                    );
                } else {
                    await proveWindowsWslEnvironmentChoice(window.webContents, resolveWslHomePath);
                }
                process.stdout.write(`${PACKAGED_RUNTIME_ENVIRONMENT_LINE}\n`);
            } catch (error) {
                process.stderr.write(
                    `OAAM_DESKTOP_RUNTIME_DIAGNOSTIC environment-choice=${
                        error instanceof Error ? error.message : String(error)
                    }\n`,
                );
                throw error;
            }
            if (packagedRuntimeSmoke || providerJourneySmoke) return;
        }
        const protocolPort = supervisor.connect({ claimPathSelectionAuthority: false }) as Electron.MessagePortMain;
        const resultChannel = new MessageChannelMain();
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            resultChannel.port1.once("message", (event) => {
                if (settled) return;
                settled = true;
                resultChannel.port1.close();
                try {
                    const result = parsePackagedOnboardingProofReply(event.data);
                    if (result.status === "complete") resolve();
                    else {
                        const codes = result.diagnosticCodes.length === 0 ? "none" : result.diagnosticCodes.join(",");
                        process.stderr.write(
                            `OAAM_DESKTOP_RUNTIME_DIAGNOSTIC onboarding-step=${result.step} diagnostic-codes=${codes}\n`,
                        );
                        reject(new Error(`Packaged onboarding proof failed in the renderer at ${result.step}`));
                    }
                } catch (error) {
                    reject(error);
                }
            });
            resultChannel.port1.once("close", () => {
                if (settled) return;
                settled = true;
                reject(new Error("Packaged onboarding proof result port closed before a result"));
            });
            resultChannel.port1.start();
            try {
                window.webContents.postMessage(PACKAGED_ONBOARDING_PROOF_PORT_CHANNEL, null, [protocolPort, resultChannel.port2]);
            } catch (error) {
                settled = true;
                protocolPort.close();
                resultChannel.port1.close();
                resultChannel.port2.close();
                reject(error);
            }
        });
    };

    function publishPresentation(snapshot: DesktopPresentationSnapshot): void {
        tray.updateLabels(desktopTrayLabels(snapshot));
        if (mainWindow === null) return;
        applyDesktopWindowAppearance(mainWindow, snapshot.resolvedTheme, platform());
        mainWindow.webContents.send(PRESENTATION_CHANGED_CHANNEL, snapshot);
    }

    function publishHostStartup(snapshot: DesktopHostStartupSnapshot): void {
        hostStartup = snapshot;
        tray.updateHostStatus(snapshot.status);
        mainWindow?.webContents.send(HOST_STARTUP_CHANGED_CHANNEL, snapshot);
    }
    function attachRendererConnection(): void {
        if (mainWindow === null || supervisor.state !== "ready") return;
        const port = supervisor.connect() as Electron.MessagePortMain;
        mainWindow.webContents.postMessage(PROTOCOL_PORT_CHANNEL, null, [port]);
    }
    function windowActionDependencies(): Parameters<typeof performDesktopWindowAction>[2] {
        return createDesktopWindowActionDependencies(
            () => mainWindow,
            () => singleInstance.hidePrimaryWindow(),
            () => app.quit(),
        );
    }
    function startPackagedZcodeTargetProof(): void {
        const mode = zcodeTargetSmokeMode;
        const window = mainWindow;
        if (mode === null || zcodeTargetProofStarted || window === null || supervisor.state !== "ready") return;
        zcodeTargetProofStarted = true;
        try {
            if (proofAuthorization === undefined) throw new Error("Packaged proof launch is unauthorized");
            const prepared = preparePackagedZcodeTargetProof({
                mode,
                homePath: app.getPath("home"),
                supervisor,
                webContents: window.webContents,
                resultChannels: packagedProofChannels,
                authorization: proofAuthorization,
            });
            settlePackagedProof(prepared.proof, prepared.successLine, "OAAM_DESKTOP_ZCODE_TARGET_SMOKE", packagedProofIo);
        } catch (error) {
            process.stderr.write(
                `OAAM_DESKTOP_ZCODE_TARGET_SMOKE failed=preparation detail=${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
            quitting = true;
            supervisor.shutdown();
        }
    }

    function startPackagedStateResilienceProof(event: Extract<UtilityHostSupervisorEvent, { readonly state: "ready" }>): void {
        const mode = stateResilienceSmokeMode;
        const window = mainWindow;
        if (mode === null || stateResilienceProofStarted || window === null || supervisor.state !== "ready") return;
        stateResilienceProofStarted = true;
        const expectedDisposition = mode === "restore" ? "state_recovery" : "normal";
        if (event.startupDisposition.mode !== expectedDisposition) {
            process.stderr.write(
                `OAAM_DESKTOP_STATE_RESILIENCE_SMOKE failed=startup-disposition expected=${expectedDisposition} actual=${event.startupDisposition.mode}\n`,
            );
            process.exitCode = 1;
            quitting = true;
            supervisor.shutdown();
            return;
        }
        let restoreArchivePath: string | undefined;
        try {
            if (mode === "restore") restoreArchivePath = resolvePackagedStateRestoreArchive(app.getPath("home"));
        } catch (error) {
            process.stderr.write(
                `OAAM_DESKTOP_STATE_RESILIENCE_SMOKE failed=restore-archive detail=${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
            quitting = true;
            supervisor.shutdown();
            return;
        }
        const subject =
            mode === "restore"
                ? undefined
                : proofAuthorization === undefined
                  ? undefined
                  : readPackagedProofFixtureSubjects(proofAuthorization).target;
        settlePackagedProof(
            provePackagedStateResilience(
                mode,
                supervisor,
                window.webContents,
                packagedProofChannels,
                restoreArchivePath,
                subject,
            ),
            packagedStateResilienceProofLine(mode),
            "OAAM_DESKTOP_STATE_RESILIENCE_SMOKE",
            packagedProofIo,
        );
    }

    function startPackagedProjectProof(): void {
        const window = mainWindow;
        if ((!projectLifecycleSmoke && retainedProjectSmokeMode === undefined) || projectLifecycleProofStarted || window === null)
            return;
        projectLifecycleProofStarted = true;
        if (proofAuthorization === undefined) throw new Error("Packaged Project proof has no launch authorization");
        settlePackagedProof(
            Promise.resolve().then<unknown>(() =>
                projectLifecycleSmoke
                    ? packagedProjectLifecycleProof.provePackagedProjectLifecycle(
                          supervisor,
                          window.webContents,
                          packagedProofChannels,
                          packagedProjectLifecycleProof.resolvePackagedProjectRebindRoot(app.getPath("home")),
                          readPackagedProofFixtureSubjects(proofAuthorization).target,
                      )
                    : retainedProjectProof.proveWindowsPackagedRetainedProjectStage(
                          retainedProjectSmokeMode as "stop" | "restore",
                          window.webContents,
                          app.getPath("temp"),
                          () => snapshotPackagedAssetUsageAuthority(oaamRoot, desktopPreferences.exportBytes()),
                          proofAuthorization.profileRootPath,
                      ),
            ),
            projectLifecycleSmoke
                ? packagedProjectLifecycleProof.PACKAGED_PROJECT_LIFECYCLE_LINE
                : retainedProjectProof.packagedRetainedProjectProofText(retainedProjectSmokeMode as "stop" | "restore", "line"),
            projectLifecycleSmoke
                ? "OAAM_DESKTOP_PROJECT_LIFECYCLE_SMOKE"
                : retainedProjectProof.packagedRetainedProjectProofText(retainedProjectSmokeMode as "stop" | "restore", "label"),
            packagedProofIo,
        );
    }

    function startPackagedAssetLifecycleProof(): void {
        const window = mainWindow;
        if (!assetLifecycleSmoke || assetLifecycleProofStarted || window === null || supervisor.state !== "ready") return;
        assetLifecycleProofStarted = true;
        let exportFilePath: string;
        try {
            exportFilePath = resolvePackagedAssetLifecycleExportPath(app.getPath("home"));
        } catch (error) {
            process.stderr.write(
                `OAAM_DESKTOP_ASSET_LIFECYCLE_SMOKE failed=export-file detail=${
                    error instanceof Error ? error.message : String(error)
                }\n`,
            );
            process.exitCode = 1;
            quitting = true;
            supervisor.shutdown();
            return;
        }
        if (proofAuthorization === undefined) {
            throw new Error("Packaged Asset lifecycle proof has no launch authorization");
        }
        const subject = readPackagedProofFixtureSubjects(proofAuthorization).target;
        settlePackagedProof(
            provePackagedAssetLifecycle(supervisor, window.webContents, packagedProofChannels, exportFilePath, subject),
            PACKAGED_ASSET_LIFECYCLE_LINE,
            "OAAM_DESKTOP_ASSET_LIFECYCLE_SMOKE",
            packagedProofIo,
        );
    }

    async function createWindow(): Promise<void> {
        const preloadPath = path.join(__dirname, "../preload/index.js");
        const entryPath = path.join(__dirname, "../webview/index.html");
        const restoredWindowState = resolveDesktopWindowState(
            windowState.current,
            screen.getAllDisplays().map((display) => display.workArea),
        );
        const window = new BrowserWindow(
            createDesktopWindowOptions(preloadPath, presentation.snapshot.resolvedTheme, platform()),
        );
        applyDesktopWindowPlacement(window, restoredWindowState);
        mainWindow = window;
        window.setMenu(null);
        window.webContents.on("before-input-event", (event, input) => {
            const action = desktopWindowActionFromShortcut(input, platform());
            if (action === undefined) return;
            event.preventDefault();
            void performDesktopWindowAction(window, action, windowActionDependencies()).catch(() => {
                process.stderr.write("OAAM_DESKTOP_WINDOW_ACTION shortcut=failed\n");
            });
        });
        lockDesktopNavigation(window.webContents, pathToFileURL(entryPath).href);
        lockDesktopPermissions(window.webContents.session);
        installDesktopRendererRecovery(window, dialog, {
            isCurrentWindow: () => mainWindow === window && !quitting,
            recordRendererDiagnostic: (input) => supervisor.recordRendererDiagnostic(input),
            requestQuit: () => app.quit(),
            text: (messageId) => formatDesktopMessage(presentation.snapshot, messageId),
        });
        window.webContents.on("did-finish-load", attachRendererConnection);
        window.once("ready-to-show", () => {
            if (restoredWindowState.state === "saved" && restoredWindowState.maximized) window.maximize();
            singleInstance.attachWindow(window);
            if (!trayInitialized) {
                tray.initialize(
                    resolveDesktopTrayIconPath(__dirname, platform()),
                    desktopTrayLabels(presentation.snapshot),
                    hostStartup.status,
                );
                trayInitialized = true;
            }
            window.show();
        });
        window.on("closed", () => {
            singleInstance.detachWindow(window);
            if (mainWindow === window) mainWindow = null;
        });
        window.on("close", () => {
            try {
                windowState.capture(window);
            } catch {
                process.stderr.write("OAAM_DESKTOP_WINDOW_STATE persist=failed\n");
            }
        });
        await window.loadFile(entryPath);
        if (!workbenchUiProofStarted) {
            workbenchUiProofStarted = workbenchProof.startPackagedWorkbenchProof({
                mode: packagedWorkbenchMode,
                platform: process.platform,
                temporaryRootPath: app.getPath("temp"),
                webContents: window.webContents,
                librarySubject: workbenchProof.packagedLibraryProofSubject(packagedWorkbenchMode, proofAuthorization),
                ...packagedProofIo,
            });
        }
        runtimeSmoke.observe(window.webContents);
    }

    supervisor.subscribe((event) => {
        runtimeSmoke.observeHostState(event.state);
        const projected = projectDesktopHostStartup(event);
        if (projected !== undefined) publishHostStartup(projected);
        if (startupRecoverySmoke && !startupRecoveryProofWritten && event.state === "ready" && utilityHostSpawnCount === 2) {
            startupRecoveryProofWritten = true;
            process.stdout.write(`${PACKAGED_STARTUP_RECOVERY_LINE}\n`);
        }
        if (event.state === "ready") {
            attachRendererConnection();
            if (providerJourneySmoke && !providerProjectProofStarted && provePackagedOnboardingImport !== undefined) {
                providerProjectProofStarted = true;
                settlePackagedProof(
                    provePackagedOnboardingImport(),
                    packagedProviderProofLine(proofAuthorization?.proofSwitch) ?? PACKAGED_RUNTIME_ENVIRONMENT_LINE,
                    "OAAM_DESKTOP_PROVIDER_PROOF",
                    packagedProofIo,
                );
            }
            if (mainWindow !== null) packagedOpenCodeProjectProof.start(boot?.platformContexts ?? [], mainWindow.webContents);
            startPackagedZcodeTargetProof();
            startPackagedStateResilienceProof(event);
            startPackagedProjectProof();
            startPackagedAssetLifecycleProof();
            packagedDiagnostics.start(supervisor, mainWindow?.webContents);
        }
        if (event.state === "failed") void performanceRecording.discard();
        if (event.state === "stopped" && quitting) {
            runtimeSmoke.hostStopped();
            app.quit();
        }
    });

    presentation.subscribe(publishPresentation);
    nativeTheme.on("updated", () => presentation.systemThemeChanged());

    ipcMain.on(PRESENTATION_GET_CHANNEL, (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents) {
            event.returnValue = undefined;
            return;
        }
        event.returnValue = presentation.snapshot;
    });

    ipcMain.on(HOST_STARTUP_GET_CHANNEL, (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents) {
            event.returnValue = undefined;
            return;
        }
        event.returnValue = hostStartup;
    });

    ipcMain.on(APP_IDENTITY_GET_CHANNEL, (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents) {
            event.returnValue = undefined;
            return;
        }
        event.returnValue = Object.freeze({ name: "Open Agent Asset Manager", version: productVersion });
    });

    ipcMain.handle(PRESENTATION_REPLACE_CHANNEL, (event, input: unknown) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents) {
            throw new Error("OAAM Desktop presentation preference update is unavailable");
        }
        return presentation.replace(parseDesktopPresentationPreferenceInput(input));
    });

    ipcMain.handle(ONBOARDING_COMPLETE_CHANNEL, (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents || supervisor.state !== "ready") {
            throw new Error("OAAM Desktop onboarding completion is unavailable");
        }
        return presentation.completeOnboarding();
    });

    ipcMain.handle(LAST_PROJECT_REPLACE_CHANNEL, (event, projectId: unknown) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents) {
            throw new Error("OAAM Desktop Project preference update is unavailable");
        }
        return presentation.rememberProject(parseDesktopProjectId(projectId));
    });

    ipcMain.handle(ASSET_LAYOUT_REPLACE_CHANNEL, (event, assetLayout: unknown) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents) {
            throw new Error("OAAM Desktop Asset layout preference update is unavailable");
        }
        if (!isDesktopAssetLayoutPreference(assetLayout)) throw new TypeError("invalid Desktop Asset layout preference");
        return presentation.replaceAssetLayout(assetLayout);
    });

    registerDesktopWindowRuntimeIpc({
        ipcMain,
        getPrimaryWindow: () => mainWindow,
        windowActionDependencies,
        supervisor,
    });

    registerDesktopMaintenanceIpc({
        ipcMain,
        getPrimaryWindow: () => mainWindow,
        oaamDataRoot: oaamRoot,
        desktopProfileRoot: userDataRoot,
        dataLocationActions: {
            openPath: (targetPath) => shell.openPath(targetPath),
            copyPath: (targetPath) => clipboard.writeText(targetPath),
        },
        restorePresentationDefaults: () => presentation.restoreInterfaceDefaults(),
        restoreWindowDefaults(window) {
            windowState.restoreDefaults();
            restoreDesktopWindowDefaults(window);
        },
    });
    const disposeDiagnosticsIpc = installDesktopDiagnosticsRuntime({
        ipcMain,
        dialog,
        getPrimaryWindow: () => mainWindow,
        hostIsReady: () => supervisor.state === "ready",
        performanceRecording,
        registerSupportBundleExportPath: (filePath) => supervisor.registerLocalPathSelection("support_bundle_file", filePath),
        text: (messageId) => formatDesktopMessage(presentation.snapshot, messageId),
    });

    app.whenReady().then(async () => {
        await createWindow();
        supervisor.start();
        app.on("activate", () => {
            if (!singleInstance.showPrimaryWindow() && BrowserWindow.getAllWindows().length === 0) void createWindow();
        });
    });

    ipcMain.handle(HOST_RETRY_CHANNEL, async (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents) {
            throw new Error("OAAM Desktop session retry is unavailable");
        }
        recoverDesktopSession(supervisor, attachRendererConnection);
    });

    const authorizedMainWindow = () => mainWindow?.webContents;
    const openPath = (selectedPath: string) => shell.openPath(selectedPath);
    registerProjectRootIpc({ ipcMain, supervisor, authorizedSender: authorizedMainWindow, openPath });
    registerImportPreviewFileIpc({ ipcMain, supervisor, authorizedSender: authorizedMainWindow, openPath });
    registerNativeDirectoryPickerIpc({
        ipcMain,
        dialog,
        supervisor,
        getPrimaryWindow: () => mainWindow,
        text: (messageId) => formatDesktopMessage(presentation.snapshot, messageId),
    });

    registerAssetVersionExportIpc({
        ipcMain,
        dialog,
        supervisor,
        getPrimaryWindow: () => mainWindow,
        text: (messageId) => formatDesktopMessage(presentation.snapshot, messageId),
    });

    ipcMain.handle(STATE_RESILIENCE_PREFERENCES_GET_CHANNEL, (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents) {
            throw new Error("OAAM Desktop State resilience preferences are unavailable");
        }
        return stateResiliencePreferences.current;
    });

    ipcMain.handle(STATE_BACKUP_DESTINATION_PICK_CHANNEL, async (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents || supervisor.state !== "ready") {
            throw new Error("OAAM State backup destination selection is unavailable");
        }
        const remembered = stateResiliencePreferences.current.lastCustomBackupDirectory;
        const result = await dialog.showOpenDialog(mainWindow, {
            title: formatDesktopMessage(presentation.snapshot, "state_resilience.destination.choose_title"),
            buttonLabel: formatDesktopMessage(presentation.snapshot, "state_resilience.destination.choose_button"),
            ...(remembered === undefined ? {} : { defaultPath: remembered }),
            properties: ["openDirectory", "createDirectory"],
        });
        const directoryPath = result.filePaths.length === 1 ? result.filePaths[0] : undefined;
        if (result.canceled || directoryPath === undefined) return Object.freeze({ status: "cancelled" as const });
        const localPathSelectionToken = await supervisor.registerLocalPathSelection("backup_destination", directoryPath);
        return Object.freeze({
            status: "selected" as const,
            displayPath: directoryPath,
            localPathSelectionToken,
        });
    });

    ipcMain.handle(STATE_BACKUP_REMEMBERED_DESTINATION_CHANNEL, async (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents || supervisor.state !== "ready") {
            throw new Error("OAAM remembered State backup destination is unavailable");
        }
        const directoryPath = stateResiliencePreferences.current.lastCustomBackupDirectory;
        if (directoryPath === undefined) return Object.freeze({ status: "unavailable" as const });
        try {
            const localPathSelectionToken = await supervisor.registerLocalPathSelection("backup_destination", directoryPath);
            return Object.freeze({
                status: "selected" as const,
                displayPath: directoryPath,
                localPathSelectionToken,
            });
        } catch {
            return Object.freeze({ status: "unavailable" as const });
        }
    });

    ipcMain.handle(STATE_RESTORE_ARCHIVE_PICK_CHANNEL, async (event) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents || supervisor.state !== "ready") {
            throw new Error("OAAM State restore archive selection is unavailable");
        }
        const result = await dialog.showOpenDialog(mainWindow, {
            title: formatDesktopMessage(presentation.snapshot, "state_resilience.restore.choose_title"),
            buttonLabel: formatDesktopMessage(presentation.snapshot, "state_resilience.restore.choose_button"),
            filters: [{ name: "ZIP", extensions: ["zip"] }],
            properties: ["openFile"],
        });
        const archivePath = result.filePaths.length === 1 ? result.filePaths[0] : undefined;
        if (result.canceled || archivePath === undefined) return Object.freeze({ status: "cancelled" as const });
        const localPathSelectionToken = await supervisor.registerLocalPathSelection("restore_archive", archivePath);
        return Object.freeze({
            status: "selected" as const,
            displayPath: archivePath,
            localPathSelectionToken,
        });
    });

    ipcMain.handle(STATE_BACKUP_DESTINATION_REMEMBER_CHANNEL, async (event, value: unknown) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents || supervisor.state !== "ready") {
            throw new Error("OAAM State backup destination preference is unavailable");
        }
        const archivePath = await supervisor.resolveStateBackupFile(parseDesktopBackupId(value));
        const directoryPath = path.dirname(archivePath);
        if (directoryPath === path.join(userDataRoot, "oaam", "backups")) {
            throw new Error("The OAAM default backup directory is not a custom destination");
        }
        return stateResiliencePreferences.rememberCustomBackupDirectory(directoryPath);
    });

    ipcMain.handle(STATE_BACKUP_FILE_ACTION_CHANNEL, async (event, backupId: unknown, requestedAction: unknown) => {
        if (mainWindow === null || event.sender !== mainWindow.webContents || supervisor.state !== "ready") {
            return Object.freeze({ status: "failed" as const, code: "unavailable" as const });
        }
        const action = parseDesktopStateBackupFileAction(requestedAction);
        const parsedBackupId = parseDesktopBackupId(backupId);
        const userActionId = crypto.randomUUID();
        try {
            if (action === "trash" && desktopStateBackupTrashRoute(process.platform) === "host_identity_bound") {
                await supervisor.mutateStateBackupFile(parsedBackupId, "identity_bound_trash", userActionId);
                return Object.freeze({ status: "complete" as const });
            }
            const archivePath = await supervisor.resolveStateBackupFile(parsedBackupId);
            if (action === "trash") {
                await shell.trashItem(archivePath);
                await supervisor.mutateStateBackupFile(parsedBackupId, "retire_missing", userActionId);
            } else if (action === "copy_path") clipboard.writeText(archivePath);
            else shell.showItemInFolder(archivePath);
            return Object.freeze({ status: "complete" as const });
        } catch {
            return Object.freeze({
                status: "failed" as const,
                code:
                    action === "trash"
                        ? ("trash_failed" as const)
                        : action === "copy_path"
                          ? ("copy_failed" as const)
                          : ("reveal_failed" as const),
            });
        }
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });

    const quitCoordinator = new DesktopQuitCoordinator({
        finishPerformance: () => performanceRecording.shutdown(),
        hostState: () => supervisor.state,
        subscribeHost: (listener) => supervisor.subscribe(listener),
        shutdownHost: () => supervisor.shutdown(),
        onStart: () => {
            quitting = true;
        },
        onStopped: () => app.quit(),
        onPerformanceFailure: () => {
            process.stderr.write("OAAM_DESKTOP_PERFORMANCE_SHUTDOWN_FAILED\n");
        },
        onFailure: () => {
            quitting = false;
            publishHostStartup({ status: "failed", reasonCode: "host.shutdown_failed" });
            process.stderr.write("OAAM_DESKTOP_SHUTDOWN_FAILED\n");
            if (!singleInstance.showPrimaryWindow() && BrowserWindow.getAllWindows().length === 0) void createWindow();
        },
    });
    app.on("before-quit", (event) => quitCoordinator.beforeQuit(event));

    app.on("will-quit", () => {
        if (!diagnosticsIpcDisposed) {
            diagnosticsIpcDisposed = true;
            disposeDiagnosticsIpc();
        }
        tray.dispose();
        runtimeSmoke.dispose();
    });
}
startDesktopRelease(app, singleInstance, startPrimaryDesktop);
