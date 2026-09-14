import type { SettingValue, StateBackupPromptMode, StateBackupPromptPolicyV1 } from "../types";
import { fingerprintDomain } from "../foundation/fingerprint";
import { hasExactKeys, isNonNegativeInteger, isSha256Digest, isStrictObject } from "../foundation/validators";

export const STATE_BACKUP_PROMPT_POLICY_KEY = "core.state_backup_prompt_policy_v1";
export const STATE_BACKUP_PROMPT_POLICY_SETTING_ID: "state_backup_prompt_policy_v1" = "state_backup_prompt_policy_v1";

export function virginStateBackupPromptPolicy(): StateBackupPromptPolicyV1 {
    const preimage = {
        configVersion: 1 as const,
        settingId: STATE_BACKUP_PROMPT_POLICY_SETTING_ID,
        revision: 0 as const,
        mode: "ask_every_time" as const,
        updatedAt: 0 as const,
    };
    return {
        ...preimage,
        settingFingerprint: fingerprintDomain("oaam.setting.state-backup-prompt-policy.v1", preimage),
    };
}

export function buildStateBackupPromptPolicy(input: {
    currentRevision: number;
    mode: StateBackupPromptMode;
    userActionEvidenceId: string;
    updatedAt: number;
}): StateBackupPromptPolicyV1 {
    if (!Number.isInteger(input.currentRevision) || input.currentRevision < 0) {
        throw new Error("current State backup prompt-policy revision must be a non-negative integer");
    }
    requireMode(input.mode);
    requireEvidence(input.userActionEvidenceId);
    if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt <= 0) {
        throw new Error("State backup prompt-policy updatedAt must be a positive epoch-ms integer");
    }
    const preimage = {
        configVersion: 1 as const,
        settingId: STATE_BACKUP_PROMPT_POLICY_SETTING_ID,
        revision: input.currentRevision + 1,
        mode: input.mode,
        userActionEvidenceId: input.userActionEvidenceId,
        updatedAt: input.updatedAt,
    };
    return {
        ...preimage,
        settingFingerprint: fingerprintDomain("oaam.setting.state-backup-prompt-policy.v1", preimage),
    };
}

export function validateStoredStateBackupPromptPolicy(
    value: SettingValue,
): asserts value is StateBackupPromptPolicyV1 & SettingValue {
    if (!isStrictObject(value)) throw new Error("State backup prompt policy must be an object");
    if (
        !hasExactKeys(value, [
            "configVersion",
            "settingId",
            "revision",
            "mode",
            "userActionEvidenceId",
            "updatedAt",
            "settingFingerprint",
        ])
    ) {
        throw new Error("stored State backup prompt policy has missing or undeclared fields");
    }
    if (
        value.configVersion !== 1 ||
        value.settingId !== STATE_BACKUP_PROMPT_POLICY_SETTING_ID ||
        !Number.isInteger(value.revision) ||
        (value.revision as number) < 1 ||
        !isNonNegativeInteger(value.updatedAt) ||
        value.updatedAt === 0 ||
        !isSha256Digest(value.settingFingerprint)
    ) {
        throw new Error("stored State backup prompt policy identity is invalid");
    }
    requireMode(value.mode);
    requireEvidence(value.userActionEvidenceId);
    const preimage = {
        configVersion: 1 as const,
        settingId: STATE_BACKUP_PROMPT_POLICY_SETTING_ID,
        revision: value.revision as number,
        mode: value.mode,
        userActionEvidenceId: value.userActionEvidenceId as string,
        updatedAt: value.updatedAt as number,
    };
    if (fingerprintDomain("oaam.setting.state-backup-prompt-policy.v1", preimage) !== value.settingFingerprint) {
        throw new Error("stored State backup prompt policy fingerprint mismatch");
    }
}

function requireMode(value: unknown): asserts value is StateBackupPromptMode {
    if (!["ask_every_time", "back_up_first", "continue_without_prompt"].includes(String(value))) {
        throw new Error("State backup prompt mode is invalid");
    }
}

function requireEvidence(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
        throw new Error("userActionEvidenceId must be non-blank");
    }
}
