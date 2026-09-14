import * as path from "node:path";
import {
    durableEnsureDirectory,
    durableReplaceFile,
    readRegularFileNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import type { RestrictedSourcePromotionFullAccessSettingV1 } from "../contracts/persistence";
import { computeRestrictedSourceFullAccessSettingFingerprint, stableStringify } from "../foundation/fingerprint";
import { hasExactKeys, isNonNegativeInteger, isSha256Digest, isStrictObject } from "../foundation/validators";
import type {
    AdapterEnablementSettingV1,
    AdapterId,
    EpochMillis,
    SettingValue,
    Sha256Digest,
    StateBackupPromptMode,
    StateBackupPromptPolicyV1,
    WatchedEnvironmentIntentV1,
    WatchedScanIntentV1,
} from "../types";
import {
    ADAPTER_ENABLEMENT_KEY,
    buildAdapterEnablementAuthority,
    validateStoredAdapterEnablement,
    virginAdapterEnablementAuthority,
} from "./adapter-enablement-setting";
import {
    buildWatchedScanIntentAuthority,
    validateStoredWatchedScanIntent,
    virginWatchedScanIntentAuthority,
    WATCHED_SCAN_INTENT_KEY,
} from "./watched-scan-intent-setting";
import {
    buildStateBackupPromptPolicy,
    STATE_BACKUP_PROMPT_POLICY_KEY,
    validateStoredStateBackupPromptPolicy,
    virginStateBackupPromptPolicy,
} from "./state-backup-policy-setting";

export const RESTRICTED_SOURCE_FULL_ACCESS_KEY = "core.restricted_source_promotion_full_access";
export const RESTRICTED_SOURCE_FULL_ACCESS_SETTING_ID = "restricted_source_promotion_full_access_v1";

interface SettingsDocumentV1 {
    formatVersion: 1;
    settings: Record<string, SettingValue>;
}

type FullAccessPreimage = Parameters<typeof computeRestrictedSourceFullAccessSettingFingerprint>[0];

export interface SetRestrictedSourceFullAccessAuthorityInput {
    oaamRoot: string;
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    nextState: "enabled" | "disabled";
    userActionEvidenceId: string;
    changedAt: EpochMillis;
}

export interface SetAdapterEnablementAuthorityInput {
    oaamRoot: string;
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    enabledAdapterIds: readonly AdapterId[];
    userActionEvidenceId: string;
    changedAt: EpochMillis;
}

export interface SetWatchedScanIntentAuthorityInput {
    oaamRoot: string;
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    environments: readonly WatchedEnvironmentIntentV1[];
    userActionEvidenceId: string;
    changedAt: EpochMillis;
}

export interface SetStateBackupPromptPolicyAuthorityInput {
    oaamRoot: string;
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    mode: StateBackupPromptMode;
    userActionEvidenceId: string;
    changedAt: EpochMillis;
}

export function getRestrictedSourceFullAccessAuthority(oaamRoot: string): RestrictedSourcePromotionFullAccessSettingV1 {
    const document = readSettingsDocument(oaamRoot).document;
    const raw = document.settings[RESTRICTED_SOURCE_FULL_ACCESS_KEY];
    if (raw === undefined) return virginRestrictedSourceFullAccessAuthority();
    validateStoredFullAccess(raw);
    return raw;
}

export function getAdapterEnablementAuthority(oaamRoot: string): AdapterEnablementSettingV1 {
    return getAdapterEnablementFromDocument(readSettingsDocument(oaamRoot).document);
}

export function getWatchedScanIntentAuthority(oaamRoot: string): WatchedScanIntentV1 {
    return getWatchedScanIntentFromDocument(readSettingsDocument(oaamRoot).document);
}

export function getStateBackupPromptPolicyAuthority(oaamRoot: string): StateBackupPromptPolicyV1 {
    return getStateBackupPromptPolicyFromDocument(readSettingsDocument(oaamRoot).document);
}

/** Caller must hold the settings authority lock for the whole-file read/CAS/replace sequence. */
export function setRestrictedSourceFullAccessAuthority(
    input: SetRestrictedSourceFullAccessAuthorityInput,
): RestrictedSourcePromotionFullAccessSettingV1 {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Error("expectedRevision must be a non-negative integer");
    }
    if (!isSha256Digest(input.expectedSettingFingerprint)) {
        throw new Error("expectedSettingFingerprint must be a SHA-256 digest");
    }
    if (input.nextState !== "enabled" && input.nextState !== "disabled") {
        throw new Error("nextState must be enabled|disabled");
    }
    requireEvidence(input.userActionEvidenceId);
    requireEpoch(input.changedAt, "changedAt");
    const { document } = readSettingsDocument(input.oaamRoot);
    const current = getFullAccessFromDocument(document);
    if (current.revision !== input.expectedRevision || current.settingFingerprint !== input.expectedSettingFingerprint) {
        throw new Error("restricted-source Full Access CAS mismatch");
    }

    const revision = current.revision + 1;
    const preimage: FullAccessPreimage =
        input.nextState === "enabled"
            ? {
                  configVersion: 1,
                  settingId: RESTRICTED_SOURCE_FULL_ACCESS_SETTING_ID,
                  state: "enabled",
                  revision,
                  userActionEvidenceId: input.userActionEvidenceId,
                  enabledAt: input.changedAt,
              }
            : {
                  configVersion: 1,
                  settingId: RESTRICTED_SOURCE_FULL_ACCESS_SETTING_ID,
                  state: "disabled",
                  revision,
                  updatedAt: input.changedAt,
              };
    const next: RestrictedSourcePromotionFullAccessSettingV1 = {
        ...preimage,
        settingFingerprint: computeRestrictedSourceFullAccessSettingFingerprint(preimage),
    } as RestrictedSourcePromotionFullAccessSettingV1;
    document.settings[RESTRICTED_SOURCE_FULL_ACCESS_KEY] = next;
    writeSettingsDocument(input.oaamRoot, document);
    return next;
}

/** Caller must hold the settings authority lock for the whole-file read/CAS/replace sequence. */
export function setAdapterEnablementAuthority(input: SetAdapterEnablementAuthorityInput): AdapterEnablementSettingV1 {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Error("expectedRevision must be a non-negative integer");
    }
    if (!isSha256Digest(input.expectedSettingFingerprint)) {
        throw new Error("expectedSettingFingerprint must be a SHA-256 digest");
    }
    const { document } = readSettingsDocument(input.oaamRoot);
    const current = getAdapterEnablementFromDocument(document);
    if (current.revision !== input.expectedRevision || current.settingFingerprint !== input.expectedSettingFingerprint) {
        throw new Error("adapter-enablement CAS mismatch");
    }
    const next = buildAdapterEnablementAuthority({
        currentRevision: current.revision,
        enabledAdapterIds: input.enabledAdapterIds,
        userActionEvidenceId: input.userActionEvidenceId,
        updatedAt: input.changedAt,
    });
    document.settings[ADAPTER_ENABLEMENT_KEY] = next;
    writeSettingsDocument(input.oaamRoot, document);
    return next;
}

/** Caller must hold the settings authority lock for the whole-file read/CAS/replace sequence. */
export function setWatchedScanIntentAuthority(input: SetWatchedScanIntentAuthorityInput): WatchedScanIntentV1 {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Error("expectedRevision must be a non-negative integer");
    }
    if (!isSha256Digest(input.expectedSettingFingerprint)) {
        throw new Error("expectedSettingFingerprint must be a SHA-256 digest");
    }
    const { document } = readSettingsDocument(input.oaamRoot);
    const current = getWatchedScanIntentFromDocument(document);
    if (current.revision !== input.expectedRevision || current.settingFingerprint !== input.expectedSettingFingerprint) {
        throw new Error("watched-scan intent CAS mismatch");
    }
    const next = buildWatchedScanIntentAuthority({
        currentRevision: current.revision,
        environments: input.environments,
        userActionEvidenceId: input.userActionEvidenceId,
        updatedAt: input.changedAt,
    });
    document.settings[WATCHED_SCAN_INTENT_KEY] = next;
    writeSettingsDocument(input.oaamRoot, document);
    return next;
}

/** Caller must hold the settings authority lock for the whole-file read/CAS/replace sequence. */
export function setStateBackupPromptPolicyAuthority(input: SetStateBackupPromptPolicyAuthorityInput): StateBackupPromptPolicyV1 {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Error("expectedRevision must be a non-negative integer");
    }
    if (!isSha256Digest(input.expectedSettingFingerprint)) {
        throw new Error("expectedSettingFingerprint must be a SHA-256 digest");
    }
    const { document } = readSettingsDocument(input.oaamRoot);
    const current = getStateBackupPromptPolicyFromDocument(document);
    if (current.revision !== input.expectedRevision || current.settingFingerprint !== input.expectedSettingFingerprint) {
        throw new Error("State backup prompt-policy CAS mismatch");
    }
    const next = buildStateBackupPromptPolicy({
        currentRevision: current.revision,
        mode: input.mode,
        userActionEvidenceId: input.userActionEvidenceId,
        updatedAt: input.changedAt,
    });
    document.settings[STATE_BACKUP_PROMPT_POLICY_KEY] = next;
    writeSettingsDocument(input.oaamRoot, document);
    return next;
}

export function virginRestrictedSourceFullAccessAuthority(): RestrictedSourcePromotionFullAccessSettingV1 {
    const preimage: FullAccessPreimage = {
        configVersion: 1 as const,
        settingId: RESTRICTED_SOURCE_FULL_ACCESS_SETTING_ID,
        state: "disabled" as const,
        revision: 0,
        updatedAt: 0,
    };
    return {
        ...preimage,
        settingFingerprint: computeRestrictedSourceFullAccessSettingFingerprint(preimage),
    };
}

export function listSettingsAuthorities(oaamRoot: string): Record<string, SettingValue> {
    return structuredClone(readSettingsDocument(oaamRoot).document.settings);
}

/** Caller must hold the settings authority lock. Reserved security keys are always rejected here. */
export function setGenericSettingAuthority(oaamRoot: string, key: string, value: SettingValue): void {
    requireGenericKey(key);
    validateSettingValue(value, `settings.${key}`);
    const { document } = readSettingsDocument(oaamRoot);
    document.settings[key] = structuredClone(value);
    writeSettingsDocument(oaamRoot, document);
}

/** Caller must hold the settings authority lock. Reserved security keys are always rejected here. */
export function unsetGenericSettingAuthority(oaamRoot: string, key: string): boolean {
    requireGenericKey(key);
    const loaded = readSettingsDocument(oaamRoot);
    if (!loaded.exists || !Object.hasOwn(loaded.document.settings, key)) return false;
    delete loaded.document.settings[key];
    writeSettingsDocument(oaamRoot, loaded.document);
    return true;
}

export function readSettingsAuthorityDocument(oaamRoot: string): {
    formatVersion: 1;
    settings: Record<string, SettingValue>;
} {
    return structuredClone(readSettingsDocument(oaamRoot).document);
}

function getFullAccessFromDocument(document: SettingsDocumentV1): RestrictedSourcePromotionFullAccessSettingV1 {
    const raw = document.settings[RESTRICTED_SOURCE_FULL_ACCESS_KEY];
    if (raw === undefined) return virginRestrictedSourceFullAccessAuthority();
    validateStoredFullAccess(raw);
    return raw;
}

function getAdapterEnablementFromDocument(document: SettingsDocumentV1): AdapterEnablementSettingV1 {
    const raw = document.settings[ADAPTER_ENABLEMENT_KEY];
    if (raw === undefined) return virginAdapterEnablementAuthority();
    validateStoredAdapterEnablement(raw);
    return raw;
}

function getWatchedScanIntentFromDocument(document: SettingsDocumentV1): WatchedScanIntentV1 {
    const raw = document.settings[WATCHED_SCAN_INTENT_KEY];
    if (raw === undefined) return virginWatchedScanIntentAuthority();
    validateStoredWatchedScanIntent(raw);
    return raw;
}

function getStateBackupPromptPolicyFromDocument(document: SettingsDocumentV1): StateBackupPromptPolicyV1 {
    const raw = document.settings[STATE_BACKUP_PROMPT_POLICY_KEY];
    if (raw === undefined) return virginStateBackupPromptPolicy();
    validateStoredStateBackupPromptPolicy(raw);
    return raw;
}

function readSettingsDocument(oaamRoot: string): {
    document: SettingsDocumentV1;
    exists: boolean;
} {
    const file = path.join(oaamRoot, "settings.json");
    try {
        const parsed: unknown = JSON.parse(Buffer.from(readRegularFileNoFollow(file).bytes).toString("utf-8"));
        validateSettingsDocument(parsed);
        return { document: parsed, exists: true };
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
            return { document: { formatVersion: 1, settings: {} }, exists: false };
        }
        throw error;
    }
}

function writeSettingsDocument(oaamRoot: string, document: SettingsDocumentV1): void {
    validateSettingsDocument(document);
    durableEnsureDirectory(path.dirname(oaamRoot), path.basename(oaamRoot));
    const bytes = `${JSON.stringify(JSON.parse(stableStringify(document)), null, 2)}\n`;
    durableReplaceFile(path.join(oaamRoot, "settings.json"), bytes);
}

function validateSettingsDocument(value: unknown): asserts value is SettingsDocumentV1 {
    if (!isStrictObject(value)) throw new Error("settings document must be an object");
    requireExactKeys(value, ["formatVersion", "settings"]);
    if (value.formatVersion !== 1) throw new Error("settings formatVersion must be 1");
    if (!isStrictObject(value.settings)) throw new Error("settings map must be an object");
    for (const [key, setting] of Object.entries(value.settings)) {
        if (key.trim().length === 0 || key.includes("\0")) throw new Error("settings key is invalid");
        validateSettingValue(setting, `settings.${key}`);
    }
    const reserved = (value.settings as Record<string, SettingValue>)[RESTRICTED_SOURCE_FULL_ACCESS_KEY];
    if (reserved !== undefined) validateStoredFullAccess(reserved);
    const adapterEnablement = (value.settings as Record<string, SettingValue>)[ADAPTER_ENABLEMENT_KEY];
    if (adapterEnablement !== undefined) validateStoredAdapterEnablement(adapterEnablement);
    const watchedScanIntent = (value.settings as Record<string, SettingValue>)[WATCHED_SCAN_INTENT_KEY];
    if (watchedScanIntent !== undefined) validateStoredWatchedScanIntent(watchedScanIntent);
    const stateBackupPromptPolicy = (value.settings as Record<string, SettingValue>)[STATE_BACKUP_PROMPT_POLICY_KEY];
    if (stateBackupPromptPolicy !== undefined) validateStoredStateBackupPromptPolicy(stateBackupPromptPolicy);
}

function validateSettingValue(value: unknown, pathLabel: string): asserts value is SettingValue {
    if (!isStrictObject(value)) throw new Error(`${pathLabel} must be a non-null JSON object`);
    if (!Number.isInteger(value.configVersion) || (value.configVersion as number) < 1) {
        throw new Error(`${pathLabel}.configVersion must be a positive integer`);
    }
    assertJsonWithoutNull(value, pathLabel);
}

function assertJsonWithoutNull(value: unknown, pathLabel: string): void {
    if (value === null) throw new Error(`${pathLabel} must not contain null`);
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`${pathLabel} must contain finite JSON numbers`);
    }
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
            throw new Error(`${pathLabel} must use the canonical Array prototype`);
        }
        if (Object.keys(value).length !== value.length) {
            throw new Error(`${pathLabel} must be a dense JSON array without extra properties`);
        }
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) {
                throw new Error(`${pathLabel} must not contain sparse array holes`);
            }
            assertJsonWithoutNull(value[index], `${pathLabel}[${index}]`);
        }
        return;
    }
    if (typeof value === "object") {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(`${pathLabel} must be a plain JSON object`);
        }
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") throw new Error(`${pathLabel} must not contain symbol keys`);
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
                throw new Error(`${pathLabel}.${key} must be an enumerable data property`);
            }
            if (descriptor.value === undefined) {
                throw new Error(`${pathLabel}.${key} must not be undefined`);
            }
            assertJsonWithoutNull(descriptor.value, `${pathLabel}.${key}`);
        }
        return;
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new Error(`${pathLabel} contains a non-JSON value`);
    }
}

function validateStoredFullAccess(value: SettingValue): asserts value is RestrictedSourcePromotionFullAccessSettingV1 {
    if (value.state === "disabled") {
        requireExactKeys(value, ["configVersion", "settingId", "state", "revision", "updatedAt", "settingFingerprint"]);
        requireCommonStoredFullAccess(value);
        requireEpoch(value.updatedAt, "updatedAt");
    } else if (value.state === "enabled") {
        requireExactKeys(value, [
            "configVersion",
            "settingId",
            "state",
            "revision",
            "userActionEvidenceId",
            "enabledAt",
            "settingFingerprint",
        ]);
        requireCommonStoredFullAccess(value);
        requireEvidence(value.userActionEvidenceId);
        requireEpoch(value.enabledAt, "enabledAt");
    } else {
        throw new Error("restricted-source Full Access state must be enabled|disabled");
    }
    const { settingFingerprint: _stored, ...preimage } = value as unknown as RestrictedSourcePromotionFullAccessSettingV1;
    if (computeRestrictedSourceFullAccessSettingFingerprint(preimage) !== value.settingFingerprint) {
        throw new Error("restricted-source Full Access fingerprint mismatch");
    }
}

function requireCommonStoredFullAccess(value: Record<string, unknown>): void {
    if (value.configVersion !== 1) throw new Error("Full Access configVersion must be 1");
    if (value.settingId !== RESTRICTED_SOURCE_FULL_ACCESS_SETTING_ID) {
        throw new Error("Full Access settingId is invalid");
    }
    if (!Number.isInteger(value.revision) || (value.revision as number) < 1) {
        throw new Error("stored Full Access revision must be a positive integer");
    }
    if (!isSha256Digest(value.settingFingerprint)) throw new Error("invalid Full Access fingerprint");
}

function requireGenericKey(key: string): void {
    if (
        key === RESTRICTED_SOURCE_FULL_ACCESS_KEY ||
        key === ADAPTER_ENABLEMENT_KEY ||
        key === WATCHED_SCAN_INTENT_KEY ||
        key === STATE_BACKUP_PROMPT_POLICY_KEY
    ) {
        throw new Error("reserved setting key requires its dedicated CAS authority");
    }
    if (key.trim().length === 0 || key.includes("\0") || key === "__proto__") {
        throw new Error("settings key is invalid");
    }
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    if (!hasExactKeys(value, allowed)) {
        throw new Error("authority object has missing or undeclared fields");
    }
}

function requireEvidence(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("userActionEvidenceId must be non-blank");
    }
}

function requireEpoch(value: unknown, label: string): asserts value is EpochMillis {
    if (!isNonNegativeInteger(value)) throw new Error(`${label} must be a non-negative epoch-ms integer`);
}
