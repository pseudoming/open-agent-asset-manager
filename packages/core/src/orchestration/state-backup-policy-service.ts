import { getStateBackupPromptPolicyAuthority, setStateBackupPromptPolicyAuthority } from "../catalog/settings-authority";
import type { CoreResult, OperationDiagnostic, ReplaceStateBackupPromptPolicyInputV1, StateBackupPromptPolicyV1 } from "../types";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";

interface StateBackupPolicyServiceConfiguration {
    oaamRoot: string;
    authorityLocksRoot: string;
    assertMutationScope(scope: { assetIds: []; settingsAuthority: boolean }): void;
    now: () => number;
}

export interface StateBackupPolicyService {
    getStateBackupPromptPolicy(): CoreResult<StateBackupPromptPolicyV1>;
    replaceStateBackupPromptPolicy(input: ReplaceStateBackupPromptPolicyInputV1): CoreResult<StateBackupPromptPolicyV1>;
}

export function createStateBackupPolicyService(configuration: StateBackupPolicyServiceConfiguration): StateBackupPolicyService {
    return Object.freeze({
        getStateBackupPromptPolicy(): CoreResult<StateBackupPromptPolicyV1> {
            try {
                return completeResult(getStateBackupPromptPolicyAuthority(configuration.oaamRoot));
            } catch (error) {
                return failedPolicyResult(error);
            }
        },
        replaceStateBackupPromptPolicy(input: ReplaceStateBackupPromptPolicyInputV1): CoreResult<StateBackupPromptPolicyV1> {
            let release: (() => void) | null = null;
            try {
                configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                release = tryAcquireAuthorityLocks(configuration.authorityLocksRoot, "settings", ["settings"]);
                if (release === null) throw new Error("settings authority is locked");
                configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                return completeResult(
                    setStateBackupPromptPolicyAuthority({
                        oaamRoot: configuration.oaamRoot,
                        expectedRevision: input.expectedRevision,
                        expectedSettingFingerprint: input.expectedSettingFingerprint,
                        mode: input.mode,
                        userActionEvidenceId: input.userActionId,
                        changedAt: configuration.now(),
                    }),
                );
            } catch (error) {
                return failedPolicyResult(error);
            } finally {
                release?.();
            }
        },
    });
}

function failedPolicyResult<T>(error: unknown): CoreResult<T> {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: "backup.policy_operation_failed",
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

/** @internal Exact failure projection seam exposed only to Core tests. */
export const stateBackupPolicyInternalsForTest = Object.freeze({ failedPolicyResult });
