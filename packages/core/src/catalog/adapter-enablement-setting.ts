/** Strict codec and canonical construction for the adapter-enablement reserved setting. */

import type { AdapterEnablementSettingV1, AdapterId, SettingValue, Sha256Digest } from "../types";
import { compareCodeUnitText } from "../foundation/fingerprint-base";
import { computeAdapterEnablementSettingFingerprint } from "../foundation/fingerprint";
import { hasExactKeys, isNonNegativeInteger, isSha256Digest, isStrictObject } from "../foundation/validators";

export const ADAPTER_ENABLEMENT_KEY = "core.adapter_enablement_v1";
export const ADAPTER_ENABLEMENT_SETTING_ID = "adapter_enablement_v1";

type AdapterEnablementPreimage = AdapterEnablementSettingV1 extends infer T
    ? T extends { settingFingerprint: Sha256Digest }
        ? Omit<T, "settingFingerprint">
        : never
    : never;

export function virginAdapterEnablementAuthority(): AdapterEnablementSettingV1 {
    const preimage: AdapterEnablementPreimage = {
        configVersion: 1,
        settingId: ADAPTER_ENABLEMENT_SETTING_ID,
        revision: 0,
        enabledAdapterIds: [],
        updatedAt: 0,
    };
    return {
        ...preimage,
        settingFingerprint: computeAdapterEnablementSettingFingerprint(preimage),
    };
}

export function buildAdapterEnablementAuthority(input: {
    currentRevision: number;
    enabledAdapterIds: readonly AdapterId[];
    userActionEvidenceId: string;
    updatedAt: number;
}): AdapterEnablementSettingV1 {
    requireEvidence(input.userActionEvidenceId);
    if (!Number.isInteger(input.currentRevision) || input.currentRevision < 0) {
        throw new Error("current adapter-enablement revision must be a non-negative integer");
    }
    if (!Number.isInteger(input.updatedAt) || input.updatedAt <= 0) {
        throw new Error("adapter-enablement updatedAt must be a positive epoch-ms integer");
    }
    const enabledAdapterIds = canonicalAdapterIds(input.enabledAdapterIds);
    const preimage: AdapterEnablementPreimage = {
        configVersion: 1,
        settingId: ADAPTER_ENABLEMENT_SETTING_ID,
        revision: input.currentRevision + 1,
        enabledAdapterIds,
        userActionEvidenceId: input.userActionEvidenceId,
        updatedAt: input.updatedAt,
    };
    return {
        ...preimage,
        settingFingerprint: computeAdapterEnablementSettingFingerprint(preimage),
    };
}

export function validateStoredAdapterEnablement(value: SettingValue): asserts value is AdapterEnablementSettingV1 & SettingValue {
    if (!isStrictObject(value)) throw new Error("adapter enablement must be an object");
    if (
        !hasExactKeys(value, [
            "configVersion",
            "settingId",
            "revision",
            "enabledAdapterIds",
            "userActionEvidenceId",
            "updatedAt",
            "settingFingerprint",
        ])
    ) {
        throw new Error("stored adapter enablement has missing or undeclared fields");
    }
    if (value.configVersion !== 1 || value.settingId !== ADAPTER_ENABLEMENT_SETTING_ID) {
        throw new Error("stored adapter enablement identity is invalid");
    }
    if (!Number.isInteger(value.revision) || (value.revision as number) < 1) {
        throw new Error("stored adapter enablement revision must be a positive integer");
    }
    const enabledAdapterIds = canonicalAdapterIds(value.enabledAdapterIds);
    if (!arraysEqual(enabledAdapterIds, value.enabledAdapterIds)) {
        throw new Error("stored adapter enablement IDs must be canonical sorted and unique");
    }
    requireEvidence(value.userActionEvidenceId);
    if (!isNonNegativeInteger(value.updatedAt) || value.updatedAt === 0) {
        throw new Error("stored adapter enablement updatedAt must be positive");
    }
    if (!isSha256Digest(value.settingFingerprint)) {
        throw new Error("stored adapter enablement fingerprint is invalid");
    }
    const preimage: AdapterEnablementPreimage = {
        configVersion: 1,
        settingId: ADAPTER_ENABLEMENT_SETTING_ID,
        revision: value.revision as number,
        enabledAdapterIds,
        userActionEvidenceId: value.userActionEvidenceId as string,
        updatedAt: value.updatedAt as number,
    };
    if (computeAdapterEnablementSettingFingerprint(preimage) !== value.settingFingerprint) {
        throw new Error("stored adapter enablement fingerprint mismatch");
    }
}

export function canonicalAdapterIds(value: unknown): AdapterId[] {
    if (!Array.isArray(value)) throw new Error("enabledAdapterIds must be an array");
    const ids = value.map((item) => {
        if (typeof item !== "string" || item.trim().length === 0 || item.includes("\0")) {
            throw new Error("enabledAdapterIds must contain non-blank adapter IDs");
        }
        return item as AdapterId;
    });
    const sorted = [...ids].sort(compareCodeUnitText);
    if (new Set(sorted).size !== sorted.length) {
        throw new Error("enabledAdapterIds must be unique");
    }
    return sorted;
}

function arraysEqual(left: readonly AdapterId[], right: unknown): boolean {
    return Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireEvidence(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("userActionEvidenceId must be non-blank");
    }
}
