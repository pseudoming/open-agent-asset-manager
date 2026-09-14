import path from "node:path";
import type { DesktopHostStartupSnapshot } from "../bridge/desktop-bridge";
import { formatDesktopMessage } from "../presentation/localization";
import type { DesktopPresentationSnapshot } from "../presentation/presentation-preferences";

export type DesktopTrayHostStatus = DesktopHostStartupSnapshot["status"];

export interface DesktopTrayLabels {
    readonly tooltip: string;
    readonly show: string;
    readonly quit: string;
    readonly host: Readonly<Record<DesktopTrayHostStatus, string>>;
}

export type DesktopTrayMenuItem =
    | {
          readonly kind: "command";
          readonly id: "show" | "host-status" | "quit";
          readonly label: string;
          readonly enabled: boolean;
          readonly run: () => void;
      }
    | { readonly kind: "separator" };

export interface DesktopTrayTarget {
    setToolTip(tooltip: string): void;
    setContextMenu(menu: unknown): void;
    onClick(listener: () => void): void;
    destroy(): void;
}

export interface DesktopTrayBackend {
    createTray(iconPath: string): DesktopTrayTarget;
    buildMenu(items: readonly DesktopTrayMenuItem[]): unknown;
}

export interface DesktopTrayDependencies {
    showPrimaryWindow(): boolean;
    requestQuit(): void;
}

export function desktopTrayLabels(snapshot: DesktopPresentationSnapshot): DesktopTrayLabels {
    return Object.freeze({
        tooltip: formatDesktopMessage(snapshot, "tray.tooltip"),
        show: formatDesktopMessage(snapshot, "tray.show"),
        quit: formatDesktopMessage(snapshot, "tray.quit"),
        host: Object.freeze({
            starting: formatDesktopMessage(snapshot, "tray.host.starting"),
            recovering: formatDesktopMessage(snapshot, "tray.host.recovering"),
            ready: formatDesktopMessage(snapshot, "tray.host.ready"),
            failed: formatDesktopMessage(snapshot, "tray.host.failed"),
        }),
    });
}

export function resolveDesktopTrayIconPath(compiledMainDirectory: string, platform: "win32" | "darwin" | "linux"): string {
    return path.resolve(compiledMainDirectory, "..", "..", "resources", platform === "win32" ? "oaam-tray.ico" : "oaam-tray.png");
}

export class DesktopTrayAuthority {
    readonly #backend: DesktopTrayBackend;
    readonly #dependencies: DesktopTrayDependencies;
    #initialized = false;
    #tray: DesktopTrayTarget | undefined;
    #labels: DesktopTrayLabels | undefined;
    #hostStatus: DesktopTrayHostStatus = "starting";

    public constructor(backend: DesktopTrayBackend, dependencies: DesktopTrayDependencies) {
        this.#backend = backend;
        this.#dependencies = dependencies;
    }

    public initialize(iconPath: string, labels: DesktopTrayLabels, hostStatus: DesktopTrayHostStatus): void {
        if (this.#initialized) throw new Error("Desktop Tray authority can be initialized only once");
        this.#initialized = true;
        this.#labels = labels;
        this.#hostStatus = hostStatus;
        const tray = this.#backend.createTray(iconPath);
        this.#tray = tray;
        try {
            tray.onClick(() => {
                this.#dependencies.showPrimaryWindow();
            });
            this.#render();
        } catch (error) {
            tray.destroy();
            this.#tray = undefined;
            throw error;
        }
    }

    public updateLabels(labels: DesktopTrayLabels): void {
        this.#labels = labels;
        if (this.#tray !== undefined) this.#render();
    }

    public updateHostStatus(hostStatus: DesktopTrayHostStatus): void {
        this.#hostStatus = hostStatus;
        if (this.#tray !== undefined) this.#render();
    }

    public dispose(): void {
        this.#tray?.destroy();
        this.#tray = undefined;
    }

    #render(): void {
        const tray = this.#tray;
        const labels = this.#labels;
        if (tray === undefined || labels === undefined) return;
        tray.setToolTip(labels.tooltip);
        tray.setContextMenu(
            this.#backend.buildMenu([
                {
                    kind: "command",
                    id: "show",
                    label: labels.show,
                    enabled: true,
                    run: () => {
                        this.#dependencies.showPrimaryWindow();
                    },
                },
                {
                    kind: "command",
                    id: "host-status",
                    label: labels.host[this.#hostStatus],
                    enabled: false,
                    run: () => undefined,
                },
                { kind: "separator" },
                {
                    kind: "command",
                    id: "quit",
                    label: labels.quit,
                    enabled: true,
                    run: () => {
                        this.#dependencies.requestQuit();
                    },
                },
            ]),
        );
    }
}
