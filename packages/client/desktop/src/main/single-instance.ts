export interface DesktopSingleInstanceApp {
    requestSingleInstanceLock(): boolean;
    quit(): void;
    on(event: "second-instance", listener: () => void): void;
}

export interface DesktopSingleInstanceWindow {
    isMinimized(): boolean;
    restore(): void;
    isVisible(): boolean;
    show(): void;
    hide(): void;
    focus(): void;
}

export class DesktopSingleInstanceAuthority {
    readonly #app: DesktopSingleInstanceApp;
    readonly #onPrimaryFocused: () => void;
    #window: DesktopSingleInstanceWindow | undefined;
    #focusPending = false;
    #acquired = false;

    public constructor(app: DesktopSingleInstanceApp, onPrimaryFocused: () => void) {
        this.#app = app;
        this.#onPrimaryFocused = onPrimaryFocused;
    }

    public acquire(): boolean {
        if (this.#acquired) throw new Error("Desktop single-instance authority can be acquired only once");
        this.#acquired = true;
        if (!this.#app.requestSingleInstanceLock()) {
            this.#app.quit();
            return false;
        }
        this.#app.on("second-instance", () => {
            if (this.#window === undefined) {
                this.#focusPending = true;
                return;
            }
            showAndFocusWindow(this.#window);
            this.#onPrimaryFocused();
        });
        return true;
    }

    public attachWindow(window: DesktopSingleInstanceWindow): void {
        this.#window = window;
        if (!this.#focusPending) return;
        this.#focusPending = false;
        showAndFocusWindow(window);
        this.#onPrimaryFocused();
    }

    public detachWindow(window: DesktopSingleInstanceWindow): void {
        if (this.#window === window) this.#window = undefined;
    }

    public showPrimaryWindow(): boolean {
        if (this.#window === undefined) return false;
        showAndFocusWindow(this.#window);
        return true;
    }

    public hidePrimaryWindow(): boolean {
        if (this.#window === undefined || !this.#window.isVisible()) return false;
        this.#window.hide();
        return true;
    }
}

function showAndFocusWindow(window: DesktopSingleInstanceWindow): void {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
}
