import path from "node:path";
import { SafeFilesystemError, durableReplaceFile, readRegularFileNoFollow } from "@oaam/shared/filesystem";
import { parseDesktopStateResiliencePreferences, type DesktopStateResiliencePreferencesV1 } from "../bridge/desktop-bridge";

export const STATE_RESILIENCE_PREFERENCES_FILE_NAME = "state-resilience-preferences.json";

export const DEFAULT_STATE_RESILIENCE_PREFERENCES: DesktopStateResiliencePreferencesV1 = Object.freeze({
    schemaVersion: 1,
});

function parsePreferences(value: unknown): DesktopStateResiliencePreferencesV1 {
    const parsed = parseDesktopStateResiliencePreferences(value);
    const directoryPath = parsed.lastCustomBackupDirectory;
    if (directoryPath !== undefined && (!path.isAbsolute(directoryPath) || path.normalize(directoryPath) !== directoryPath)) {
        throw new TypeError("invalid Desktop State resilience preference path");
    }
    return parsed;
}

export class DesktopStateResiliencePreferencesStore {
    readonly #filePath: string;
    #preferences: DesktopStateResiliencePreferencesV1;

    public constructor(userDataRoot: string) {
        this.#filePath = path.join(userDataRoot, STATE_RESILIENCE_PREFERENCES_FILE_NAME);
        this.#preferences = this.#load();
    }

    public get current(): DesktopStateResiliencePreferencesV1 {
        return this.#preferences;
    }

    public rememberCustomBackupDirectory(directoryPath: string): DesktopStateResiliencePreferencesV1 {
        const next = parsePreferences({
            schemaVersion: 1,
            lastCustomBackupDirectory: directoryPath,
        });
        durableReplaceFile(this.#filePath, `${JSON.stringify(next, null, 4)}\n`);
        this.#preferences = next;
        return next;
    }

    #load(): DesktopStateResiliencePreferencesV1 {
        try {
            const bytes = readRegularFileNoFollow(this.#filePath, 1024 * 1024).bytes;
            return parsePreferences(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
        } catch (error) {
            if (
                (error instanceof SafeFilesystemError && error.failureKind === "not_found") ||
                error instanceof SyntaxError ||
                error instanceof TypeError
            ) {
                return DEFAULT_STATE_RESILIENCE_PREFERENCES;
            }
            throw error;
        }
    }
}
