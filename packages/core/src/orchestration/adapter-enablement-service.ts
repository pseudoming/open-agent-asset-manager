/** Core-owned adapter enablement authority and live registry projection. */

import type {
    AdapterEnablementApi,
    AdapterEnablementSettingV1,
    AdapterId,
    AdapterProviderQueryApi,
    CoreResult,
    EpochMillis,
    OperationDiagnostic,
    ReplaceAdapterEnablementRequestV1,
} from "../types";
import { getAdapterEnablementAuthority, setAdapterEnablementAuthority } from "../catalog/settings-authority";
import { canonicalAdapterIds } from "../catalog/adapter-enablement-setting";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";
import { CoreMutationScopeError } from "./core-mutation-scope";
import { listAdapterProviders, replaceEnabledAdapters } from "./adapter-registry";

export interface AdapterEnablementServiceConfiguration {
    oaamRoot: string;
    authorityLocksRoot: string;
    assertMutationScope(scope: { assetIds: []; settingsAuthority: true }): void;
    now: () => EpochMillis;
}

export interface AdapterEnablementService {
    api: AdapterProviderQueryApi & AdapterEnablementApi;
    initializeProjection(): CoreResult<AdapterEnablementSettingV1>;
}

export function createAdapterEnablementService(configuration: AdapterEnablementServiceConfiguration): AdapterEnablementService {
    const api = Object.freeze({
        listAdapterProviders,
        getAdapterEnablement(): CoreResult<AdapterEnablementSettingV1> {
            return readLocked(configuration, false);
        },
        replaceAdapterEnablement(input: ReplaceAdapterEnablementRequestV1): CoreResult<AdapterEnablementSettingV1> {
            try {
                configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                const enabledAdapterIds = canonicalAdapterIds(input.enabledAdapterIds);
                const registered = registeredAdapterIds();
                const unknown = enabledAdapterIds.filter((adapterId) => !registered.has(adapterId));
                if (unknown.length > 0) {
                    throw new AdapterEnablementFailure(
                        "settings.adapter_enablement_unknown",
                        `enabled adapters are not registered: ${unknown.join(", ")}`,
                    );
                }
                const release = acquireSettingsLock(configuration.authorityLocksRoot);
                try {
                    configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                    const next = setAdapterEnablementAuthority({
                        oaamRoot: configuration.oaamRoot,
                        expectedRevision: input.expectedRevision,
                        expectedSettingFingerprint: input.expectedSettingFingerprint,
                        enabledAdapterIds,
                        userActionEvidenceId: input.userActionId,
                        changedAt: configuration.now(),
                    });
                    requireProjection(replaceEnabledAdapters(next.enabledAdapterIds));
                    return completeResult(next);
                } finally {
                    release();
                }
            } catch (error) {
                return failed(error);
            }
        },
    });

    return Object.freeze({
        api,
        initializeProjection(): CoreResult<AdapterEnablementSettingV1> {
            return readLocked(configuration, true);
        },
    });
}

function readLocked(
    configuration: AdapterEnablementServiceConfiguration,
    applyProjection: boolean,
): CoreResult<AdapterEnablementSettingV1> {
    try {
        const release = acquireSettingsLock(configuration.authorityLocksRoot);
        try {
            const current = getAdapterEnablementAuthority(configuration.oaamRoot);
            const registered = registeredAdapterIds();
            const knownEnabled = current.enabledAdapterIds.filter((adapterId) => registered.has(adapterId));
            if (applyProjection) requireProjection(replaceEnabledAdapters(knownEnabled));
            const unknown = current.enabledAdapterIds.filter((adapterId) => !registered.has(adapterId));
            if (unknown.length === 0) return completeResult(current);
            return {
                status: "partial",
                value: current,
                diagnostics: [
                    diagnostic(
                        "warning",
                        "settings.adapter_enablement_unregistered_preserved",
                        `persisted adapter IDs are not currently registered and remain disabled: ${unknown.join(", ")}`,
                        "unsupported",
                        false,
                    ),
                ],
            };
        } finally {
            release();
        }
    } catch (error) {
        requireProjection(replaceEnabledAdapters([]));
        return failed(error);
    }
}

function registeredAdapterIds(): Set<AdapterId> {
    return new Set(listAdapterProviders().value.map((provider) => provider.adapterId));
}

function acquireSettingsLock(authorityLocksRoot: string): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "settings", ["settings"]);
    if (release === null) {
        throw new AdapterEnablementFailure(
            "settings.adapter_enablement_locked",
            "settings authority is locked",
            "unavailable",
            true,
        );
    }
    return release;
}

function requireProjection(result: CoreResult<void>): void {
    if (result.status === "failed") {
        throw new AdapterEnablementFailure(
            result.diagnostics[0]?.code ?? "settings.adapter_enablement_projection_failed",
            result.diagnostics[0]?.message ?? "adapter enablement projection failed",
            "internal_error",
        );
    }
}

function failed<T>(error: unknown): CoreResult<T> {
    if (error instanceof CoreMutationScopeError) {
        return {
            status: "failed",
            value: undefined as T,
            diagnostics: [diagnostic("error", error.code, error.message, "unavailable", true)],
        };
    }
    if (error instanceof AdapterEnablementFailure) {
        return {
            status: "failed",
            value: undefined as T,
            diagnostics: [diagnostic("error", error.code, error.message, error.causeKind, error.retryable)],
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            diagnostic(
                "error",
                "settings.adapter_enablement_invalid",
                message,
                message.includes("fingerprint") || message.includes("fields") ? "invalid_schema" : "internal_error",
                false,
            ),
        ],
    };
}

function diagnostic(
    severity: OperationDiagnostic["severity"],
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    retryable: boolean,
): OperationDiagnostic {
    return {
        severity,
        code,
        message,
        path: "",
        traceId: "",
        operation: "settings",
        causeKind,
        retryable,
        suggestedActions: retryable ? ["retry"] : [],
        rawSummary: message,
    };
}

class AdapterEnablementFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
        readonly retryable = false,
    ) {
        super(message);
    }
}

/** @internal Test-only coverage of impossible-after-bootstrap projection failures and error envelopes. */
export const adapterEnablementServiceInternalsForTest = Object.freeze({
    requireProjection,
    failed,
});
