import path from "node:path";
import {
    SafeFilesystemError,
    durableCreateFile,
    durableEnsureDirectory,
    durableReplaceFile,
    readRegularFileNoFollow,
} from "@oaam/shared/filesystem";
import {
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    DESKTOP_PREFERENCES_SCHEMA_VERSION,
    parseStoredDesktopPreferences,
    parseDesktopProjectId,
    isDesktopAssetLayoutPreference,
    type DesktopAssetLayoutPreference,
    type DesktopPresentationPreferenceInput,
    type DesktopPreferencesV4,
} from "../presentation/presentation-preferences";

export const DESKTOP_PREFERENCES_FILE_NAME = "desktop-preferences.json";
const DISPLACED_DESKTOP_PREFERENCES_FILE_NAME = "displaced-desktop-preferences.json";
const RESTORE_TRANSACTION_NAME_PATTERN =
    /^\.oaam\.restore-txn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function ensurePreferenceRoot(userDataRoot: string): void {
    durableEnsureDirectory(path.dirname(userDataRoot), path.basename(userDataRoot));
}

function parseDesktopPreferenceFile(filePath: string): DesktopPreferencesV4 {
    const { bytes } = readRegularFileNoFollow(filePath);
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseStoredDesktopPreferences(JSON.parse(contents) as unknown);
}

export class DesktopPreferencesStore {
    readonly #userDataRoot: string;
    readonly #filePath: string;
    #preferences: DesktopPreferencesV4;

    public constructor(userDataRoot: string) {
        ensurePreferenceRoot(userDataRoot);
        this.#userDataRoot = userDataRoot;
        this.#filePath = path.join(userDataRoot, DESKTOP_PREFERENCES_FILE_NAME);
        this.#preferences = this.#load();
    }

    public get current(): DesktopPreferencesV4 {
        return this.#preferences;
    }

    public replace(input: DesktopPresentationPreferenceInput): DesktopPreferencesV4 {
        const next = Object.freeze({
            schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
            language: input.language,
            theme: input.theme,
            textSize: input.textSize,
            surfacePalette: input.surfacePalette,
            leftPaneWidth: input.leftPaneWidth,
            rightPaneWidth: input.rightPaneWidth,
            onboardingCompleted: this.#preferences.onboardingCompleted,
            assetLayout: this.#preferences.assetLayout,
            ...(this.#preferences.lastSelectedProjectId === undefined
                ? {}
                : { lastSelectedProjectId: this.#preferences.lastSelectedProjectId }),
        });
        this.#publish(next);
        return next;
    }

    public completeOnboarding(): DesktopPreferencesV4 {
        if (this.#preferences.onboardingCompleted) return this.#preferences;
        const next = Object.freeze({
            ...this.#preferences,
            onboardingCompleted: true,
        });
        this.#publish(next);
        return next;
    }

    public rememberProject(projectId: string): DesktopPreferencesV4 {
        const next = Object.freeze({
            ...this.#preferences,
            lastSelectedProjectId: parseDesktopProjectId(projectId),
        });
        this.#publish(next);
        return next;
    }

    public replaceAssetLayout(assetLayout: DesktopAssetLayoutPreference): DesktopPreferencesV4 {
        if (!isDesktopAssetLayoutPreference(assetLayout)) throw new TypeError("invalid Desktop Asset layout preference");
        const next = Object.freeze({ ...this.#preferences, assetLayout });
        this.#publish(next);
        return next;
    }

    public restoreInterfaceDefaults(): DesktopPreferencesV4 {
        const next = Object.freeze({
            schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
            language: "system" as const,
            theme: "system" as const,
            textSize: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.textSize,
            surfacePalette: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.surfacePalette,
            leftPaneWidth: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.leftPaneWidth,
            rightPaneWidth: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.rightPaneWidth,
            onboardingCompleted: this.#preferences.onboardingCompleted,
            assetLayout: "list" as const,
            ...(this.#preferences.lastSelectedProjectId === undefined
                ? {}
                : { lastSelectedProjectId: this.#preferences.lastSelectedProjectId }),
        });
        this.#publish(next);
        return next;
    }

    public exportBytes(): Uint8Array {
        return new TextEncoder().encode(`${JSON.stringify(this.#preferences, null, 4)}\n`);
    }

    public applyRestored(bytes: Uint8Array, restoreTransactionPath: string): DesktopPreferencesV4 {
        const next = parseStoredDesktopPreferences(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
        );
        if (
            path.dirname(restoreTransactionPath) !== this.#userDataRoot ||
            !RESTORE_TRANSACTION_NAME_PATTERN.test(path.basename(restoreTransactionPath))
        ) {
            throw new TypeError("Desktop preference restore transaction is outside the owned profile boundary");
        }
        try {
            const current = readRegularFileNoFollow(this.#filePath);
            durableCreateFile(path.join(restoreTransactionPath, DISPLACED_DESKTOP_PREFERENCES_FILE_NAME), current.bytes);
        } catch (error) {
            if (!(error instanceof SafeFilesystemError && error.failureKind === "not_found")) throw error;
        }
        durableReplaceFile(this.#filePath, bytes);
        this.#preferences = next;
        return next;
    }

    #publish(next: DesktopPreferencesV4): void {
        durableReplaceFile(this.#filePath, `${JSON.stringify(next, null, 4)}\n`);
        this.#preferences = next;
    }

    #load(): DesktopPreferencesV4 {
        try {
            return parseDesktopPreferenceFile(this.#filePath);
        } catch (error) {
            if (
                (error instanceof SafeFilesystemError && error.failureKind === "not_found") ||
                error instanceof SyntaxError ||
                error instanceof TypeError
            ) {
                return DEFAULT_DESKTOP_PRESENTATION_PREFERENCES;
            }
            throw error;
        }
    }
}
