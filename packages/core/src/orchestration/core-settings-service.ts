/** Public generic Settings API over settings.json authority. */

import type { CoreResult, OperationDiagnostic, SettingsApi, SettingValue } from "../types";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";
import { listSettingsAuthorities, setGenericSettingAuthority, unsetGenericSettingAuthority } from "../catalog/settings-authority";

export interface CoreSettingsServiceConfiguration {
    oaamRoot: string;
    authorityLocksRoot: string;
    assertMutationScope(scope: { assetIds: []; settingsAuthority: boolean }): void;
}

export function createCoreSettingsService(configuration: CoreSettingsServiceConfiguration): SettingsApi {
    const service: SettingsApi = {
        getSetting<T extends SettingValue>(key: string): CoreResult<{ found: boolean; value?: T }> {
            return run(() => {
                requireKey(key);
                const value = listSettingsAuthorities(configuration.oaamRoot)[key] as T | undefined;
                return { found: value !== undefined, ...(value === undefined ? {} : { value }) };
            });
        },
        setSetting<T extends SettingValue>(key: string, value: T): CoreResult<void> {
            return mutate(configuration, () => {
                requireKey(key);
                setGenericSettingAuthority(configuration.oaamRoot, key, structuredClone(value));
            });
        },
        unsetSetting(key: string): CoreResult<void> {
            return mutate(configuration, () => {
                requireKey(key);
                unsetGenericSettingAuthority(configuration.oaamRoot, key);
            });
        },
        listSettings(): CoreResult<Record<string, SettingValue>> {
            return run(() => listSettingsAuthorities(configuration.oaamRoot));
        },
    };
    return Object.freeze(service);
}

function mutate(configuration: CoreSettingsServiceConfiguration, action: () => void): CoreResult<void> {
    try {
        configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
        const release = tryAcquireAuthorityLocks(configuration.authorityLocksRoot, "settings", ["settings"]);
        if (release === null) throw new Error("settings authority is locked");
        try {
            configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
            action();
            return completeResult(undefined);
        } finally {
            release();
        }
    } catch (error) {
        return failed(error);
    }
}

function run<T>(action: () => T): CoreResult<T> {
    try {
        return completeResult(action());
    } catch (error) {
        return failed(error);
    }
}

function failed<T>(error: unknown): CoreResult<T> {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: "settings.operation_failed",
        message,
        path: "",
        traceId: "",
        operation: "settings",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: [],
        rawSummary: message,
    };
    return { status: "failed", value: undefined as T, diagnostics: [diagnostic] };
}

function requireKey(key: string): void {
    if (key.trim().length === 0 || key.includes("\0")) throw new Error("settings key is invalid");
}
