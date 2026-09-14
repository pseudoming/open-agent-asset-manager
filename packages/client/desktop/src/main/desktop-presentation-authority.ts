import {
    createDesktopPresentationSnapshot,
    isDesktopAssetLayoutPreference,
    parseDesktopProjectId,
    type DesktopAssetLayoutPreference,
    parseDesktopPresentationPreferenceInput,
    type DesktopPresentationPreferenceInput,
    type DesktopPresentationSnapshot,
    type DesktopThemePreference,
} from "../presentation/presentation-preferences";
import type { DesktopPreferencesStore } from "./desktop-preferences-store";

export interface DesktopPresentationSystem {
    getPreferredSystemLanguages(): readonly string[];
    shouldUseDarkColors(): boolean;
    setThemeSource(theme: DesktopThemePreference): void;
}

export class DesktopPresentationAuthority {
    readonly #store: DesktopPreferencesStore;
    readonly #system: DesktopPresentationSystem;
    readonly #listeners = new Set<(snapshot: DesktopPresentationSnapshot) => void>();

    public constructor(store: DesktopPreferencesStore, system: DesktopPresentationSystem) {
        this.#store = store;
        this.#system = system;
        this.#system.setThemeSource(store.current.theme);
    }

    public get snapshot(): DesktopPresentationSnapshot {
        return createDesktopPresentationSnapshot(
            this.#store.current,
            this.#system.getPreferredSystemLanguages(),
            this.#system.shouldUseDarkColors(),
        );
    }

    public subscribe(listener: (snapshot: DesktopPresentationSnapshot) => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    public replace(input: DesktopPresentationPreferenceInput): DesktopPresentationSnapshot {
        const preferences = this.#store.replace(parseDesktopPresentationPreferenceInput(input));
        this.#system.setThemeSource(preferences.theme);
        return this.#publish();
    }

    public completeOnboarding(): DesktopPresentationSnapshot {
        this.#store.completeOnboarding();
        return this.#publish();
    }

    public rememberProject(projectId: string): DesktopPresentationSnapshot {
        this.#store.rememberProject(parseDesktopProjectId(projectId));
        return this.#publish();
    }

    public replaceAssetLayout(assetLayout: DesktopAssetLayoutPreference): DesktopPresentationSnapshot {
        if (!isDesktopAssetLayoutPreference(assetLayout)) throw new TypeError("invalid Desktop Asset layout preference");
        this.#store.replaceAssetLayout(assetLayout);
        return this.#publish();
    }

    public restoreInterfaceDefaults(): DesktopPresentationSnapshot {
        const preferences = this.#store.restoreInterfaceDefaults();
        this.#system.setThemeSource(preferences.theme);
        return this.#publish();
    }

    public exportPreferences(): Uint8Array {
        return this.#store.exportBytes();
    }

    public applyRestoredPreferences(bytes: Uint8Array, restoreTransactionPath: string): DesktopPresentationSnapshot {
        const preferences = this.#store.applyRestored(bytes, restoreTransactionPath);
        this.#system.setThemeSource(preferences.theme);
        return this.#publish();
    }

    public systemThemeChanged(): DesktopPresentationSnapshot {
        return this.#publish();
    }

    #publish(): DesktopPresentationSnapshot {
        const snapshot = this.snapshot;
        for (const listener of this.#listeners) listener(snapshot);
        return snapshot;
    }
}
