import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    RESTRICTED_SOURCE_FULL_ACCESS_KEY,
    getStateBackupPromptPolicyAuthority,
    getRestrictedSourceFullAccessAuthority,
    listSettingsAuthorities,
    readSettingsAuthorityDocument,
    setGenericSettingAuthority,
    setRestrictedSourceFullAccessAuthority,
    setStateBackupPromptPolicyAuthority,
    unsetGenericSettingAuthority,
    virginRestrictedSourceFullAccessAuthority,
} from "../../src/catalog/settings-authority";
import {
    buildStateBackupPromptPolicy,
    STATE_BACKUP_PROMPT_POLICY_KEY,
    validateStoredStateBackupPromptPolicy,
    virginStateBackupPromptPolicy,
} from "../../src/catalog/state-backup-policy-setting";

describe("settings.json authority and restricted-source Full Access", () => {
    let parent: string;
    let oaamRoot: string;

    beforeEach(() => {
        parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-p4-settings-"));
        oaamRoot = path.join(parent, ".oaam");
    });

    afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

    it("derives the canonical disabled revision-0 virgin state without materializing defaults", () => {
        const virgin = virginRestrictedSourceFullAccessAuthority();
        expect(getRestrictedSourceFullAccessAuthority(oaamRoot)).toEqual(virgin);
        expect(getRestrictedSourceFullAccessAuthority(oaamRoot)).toEqual(virgin);
        expect(virgin).toMatchObject({ state: "disabled", revision: 0, updatedAt: 0 });
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);
    });

    it("enables from the virgin CAS, preserves unknown settings, and reopens exact bytes", () => {
        setGenericSettingAuthority(oaamRoot, "adapter.future", {
            configVersion: 7,
            enabled: true,
            nested: { opaque: [1, "two", false] },
        });
        const virgin = getRestrictedSourceFullAccessAuthority(oaamRoot);
        const enabled = setRestrictedSourceFullAccessAuthority({
            oaamRoot,
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            nextState: "enabled",
            userActionEvidenceId: "ua-enable",
            changedAt: 100,
        });

        expect(enabled).toMatchObject({
            state: "enabled",
            revision: 1,
            userActionEvidenceId: "ua-enable",
            enabledAt: 100,
        });
        expect(listSettingsAuthorities(oaamRoot)["adapter.future"]).toEqual({
            configVersion: 7,
            enabled: true,
            nested: { opaque: [1, "two", false] },
        });
        expect(readSettingsAuthorityDocument(oaamRoot).formatVersion).toBe(1);
        expect(getRestrictedSourceFullAccessAuthority(oaamRoot)).toEqual(enabled);
    });

    it("disables by CAS without ever returning to virgin revision zero", () => {
        const virgin = getRestrictedSourceFullAccessAuthority(oaamRoot);
        const enabled = setRestrictedSourceFullAccessAuthority({
            oaamRoot,
            expectedRevision: 0,
            expectedSettingFingerprint: virgin.settingFingerprint,
            nextState: "enabled",
            userActionEvidenceId: "ua-enable",
            changedAt: 1,
        });
        const disabled = setRestrictedSourceFullAccessAuthority({
            oaamRoot,
            expectedRevision: enabled.revision,
            expectedSettingFingerprint: enabled.settingFingerprint,
            nextState: "disabled",
            userActionEvidenceId: "ua-disable",
            changedAt: 2,
        });
        expect(disabled).toMatchObject({ state: "disabled", revision: 2, updatedAt: 2 });
        expect("userActionEvidenceId" in disabled).toBe(false);
        expect(getRestrictedSourceFullAccessAuthority(oaamRoot)).toEqual(disabled);
    });

    it("rejects stale revision/fingerprint CAS and leaves the current authority unchanged", () => {
        const virgin = getRestrictedSourceFullAccessAuthority(oaamRoot);
        expect(() =>
            setRestrictedSourceFullAccessAuthority({
                oaamRoot,
                expectedRevision: 1,
                expectedSettingFingerprint: virgin.settingFingerprint,
                nextState: "enabled",
                userActionEvidenceId: "ua-stale",
                changedAt: 1,
            }),
        ).toThrow(/CAS mismatch/);
        expect(() =>
            setRestrictedSourceFullAccessAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: `sha256:${"f".repeat(64)}`,
                nextState: "enabled",
                userActionEvidenceId: "ua-stale",
                changedAt: 1,
            }),
        ).toThrow(/CAS mismatch/);
        expect(getRestrictedSourceFullAccessAuthority(oaamRoot)).toEqual(virgin);
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);
    });

    it("blocks generic set/unset for the reserved key and supports ordinary reset by deletion", () => {
        expect(() =>
            setGenericSettingAuthority(oaamRoot, RESTRICTED_SOURCE_FULL_ACCESS_KEY, {
                configVersion: 1,
            }),
        ).toThrow(/reserved/);
        expect(() => unsetGenericSettingAuthority(oaamRoot, RESTRICTED_SOURCE_FULL_ACCESS_KEY)).toThrow(/reserved/);
        expect(() => setGenericSettingAuthority(oaamRoot, STATE_BACKUP_PROMPT_POLICY_KEY, { configVersion: 1 })).toThrow(
            /reserved/,
        );
        expect(() => unsetGenericSettingAuthority(oaamRoot, STATE_BACKUP_PROMPT_POLICY_KEY)).toThrow(/reserved/);
        expect(unsetGenericSettingAuthority(oaamRoot, "adapter.missing")).toBe(false);
        expect(unsetGenericSettingAuthority(oaamRoot, "toString")).toBe(false);
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);
        setGenericSettingAuthority(oaamRoot, "adapter.test", { configVersion: 1, enabled: true });
        expect(unsetGenericSettingAuthority(oaamRoot, "adapter.test")).toBe(true);
        expect(listSettingsAuthorities(oaamRoot)).toEqual({});
        expect(unsetGenericSettingAuthority(oaamRoot, "adapter.test")).toBe(false);
    });

    it("stores the dedicated State backup prompt policy with exact CAS and evidence", () => {
        const virgin = getStateBackupPromptPolicyAuthority(oaamRoot);
        expect(virgin).toEqual(virginStateBackupPromptPolicy());
        expect(virgin).toMatchObject({ revision: 0, mode: "ask_every_time", updatedAt: 0 });
        const next = setStateBackupPromptPolicyAuthority({
            oaamRoot,
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            mode: "back_up_first",
            userActionEvidenceId: "remember-choice",
            changedAt: 50,
        });
        expect(next).toMatchObject({
            revision: 1,
            mode: "back_up_first",
            userActionEvidenceId: "remember-choice",
            updatedAt: 50,
        });
        expect(getStateBackupPromptPolicyAuthority(oaamRoot)).toEqual(next);
        expect(() =>
            setStateBackupPromptPolicyAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: virgin.settingFingerprint,
                mode: "continue_without_prompt",
                userActionEvidenceId: "stale",
                changedAt: 51,
            }),
        ).toThrow(/CAS mismatch/);
        expect(() =>
            setStateBackupPromptPolicyAuthority({
                oaamRoot,
                expectedRevision: -1,
                expectedSettingFingerprint: virgin.settingFingerprint,
                mode: "ask_every_time",
                userActionEvidenceId: "invalid",
                changedAt: 1,
            }),
        ).toThrow(/expectedRevision/);
        expect(() =>
            setStateBackupPromptPolicyAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: "bad" as never,
                mode: "ask_every_time",
                userActionEvidenceId: "invalid",
                changedAt: 1,
            }),
        ).toThrow(/expectedSettingFingerprint/);
    });

    it("rejects malformed State backup prompt policy construction and storage", () => {
        expect(() =>
            buildStateBackupPromptPolicy({
                currentRevision: -1,
                mode: "ask_every_time",
                userActionEvidenceId: "action",
                updatedAt: 1,
            }),
        ).toThrow(/revision/);
        expect(() =>
            buildStateBackupPromptPolicy({
                currentRevision: 0,
                mode: "future" as never,
                userActionEvidenceId: "action",
                updatedAt: 1,
            }),
        ).toThrow(/mode/);
        expect(() =>
            buildStateBackupPromptPolicy({
                currentRevision: 0,
                mode: "ask_every_time",
                userActionEvidenceId: " ",
                updatedAt: 1,
            }),
        ).toThrow(/userActionEvidenceId/);
        expect(() =>
            buildStateBackupPromptPolicy({
                currentRevision: 0,
                mode: "ask_every_time",
                userActionEvidenceId: "action",
                updatedAt: 0,
            }),
        ).toThrow(/updatedAt/);

        const valid = buildStateBackupPromptPolicy({
            currentRevision: 0,
            mode: "continue_without_prompt",
            userActionEvidenceId: "action",
            updatedAt: 1,
        });
        for (const candidate of [
            null,
            { ...valid, extra: true },
            { ...valid, configVersion: 2 },
            { ...valid, settingId: "wrong" },
            { ...valid, revision: 0 },
            { ...valid, updatedAt: 0 },
            { ...valid, settingFingerprint: "bad" },
            { ...valid, mode: "future" },
            { ...valid, userActionEvidenceId: " " },
            { ...valid, updatedAt: 2 },
        ]) {
            expect(() => validateStoredStateBackupPromptPolicy(candidate as never)).toThrow();
        }
    });

    it("fails closed on same-revision body tampering, null, unknown top-level keys, and symlinks", () => {
        const virgin = getRestrictedSourceFullAccessAuthority(oaamRoot);
        setRestrictedSourceFullAccessAuthority({
            oaamRoot,
            expectedRevision: 0,
            expectedSettingFingerprint: virgin.settingFingerprint,
            nextState: "enabled",
            userActionEvidenceId: "ua-enable",
            changedAt: 1,
        });
        const settingsPath = path.join(oaamRoot, "settings.json");
        const document = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        document.settings[RESTRICTED_SOURCE_FULL_ACCESS_KEY].enabledAt = 99;
        fs.writeFileSync(settingsPath, JSON.stringify(document));
        expect(() => getRestrictedSourceFullAccessAuthority(oaamRoot)).toThrow(/fingerprint mismatch/);

        document.settings[RESTRICTED_SOURCE_FULL_ACCESS_KEY].enabledAt = 1;
        document.settings["adapter.null"] = { configVersion: 1, nested: null };
        fs.writeFileSync(settingsPath, JSON.stringify(document));
        expect(() => listSettingsAuthorities(oaamRoot)).toThrow(/must not contain null/);

        delete document.settings["adapter.null"];
        document.extra = true;
        fs.writeFileSync(settingsPath, JSON.stringify(document));
        expect(() => readSettingsAuthorityDocument(oaamRoot)).toThrow(/fields/);

        fs.rmSync(settingsPath);
        const outside = path.join(parent, "outside.json");
        fs.writeFileSync(outside, JSON.stringify({ formatVersion: 1, settings: {} }));
        fs.symlinkSync(outside, settingsPath);
        expect(() => readSettingsAuthorityDocument(oaamRoot)).toThrow(/symbolic|link/i);
        expect(fs.readFileSync(outside, "utf-8")).toContain("settings");
    });

    it("rejects every malformed settings container and dedicated setting branch", () => {
        const writeRaw = (value: unknown): void => {
            fs.mkdirSync(oaamRoot, { recursive: true });
            fs.writeFileSync(path.join(oaamRoot, "settings.json"), JSON.stringify(value));
        };
        const virgin = getRestrictedSourceFullAccessAuthority(oaamRoot);
        const enabled = setRestrictedSourceFullAccessAuthority({
            oaamRoot,
            expectedRevision: 0,
            expectedSettingFingerprint: virgin.settingFingerprint,
            nextState: "enabled",
            userActionEvidenceId: "ua-enable",
            changedAt: 1,
        });
        const disabled = setRestrictedSourceFullAccessAuthority({
            oaamRoot,
            expectedRevision: enabled.revision,
            expectedSettingFingerprint: enabled.settingFingerprint,
            nextState: "disabled",
            userActionEvidenceId: "ua-disable",
            changedAt: 2,
        });
        const documents: unknown[] = [
            null,
            { formatVersion: 1, settings: {}, extra: true },
            { formatVersion: 2, settings: {} },
            { formatVersion: 1, settings: [] },
            { formatVersion: 1, settings: { "bad\0key": { configVersion: 1 } } },
            { formatVersion: 1, settings: { "adapter.scalar": "bad" } },
            { formatVersion: 1, settings: { "adapter.fraction": { configVersion: 1.5 } } },
            {
                formatVersion: 1,
                settings: { [RESTRICTED_SOURCE_FULL_ACCESS_KEY]: { ...enabled, state: "other" } },
            },
            {
                formatVersion: 1,
                settings: { [RESTRICTED_SOURCE_FULL_ACCESS_KEY]: { ...disabled, configVersion: 2 } },
            },
            {
                formatVersion: 1,
                settings: { [RESTRICTED_SOURCE_FULL_ACCESS_KEY]: { ...disabled, settingId: "wrong" } },
            },
            {
                formatVersion: 1,
                settings: { [RESTRICTED_SOURCE_FULL_ACCESS_KEY]: { ...disabled, revision: 0 } },
            },
            {
                formatVersion: 1,
                settings: { [RESTRICTED_SOURCE_FULL_ACCESS_KEY]: { ...disabled, updatedAt: -1 } },
            },
            {
                formatVersion: 1,
                settings: { [RESTRICTED_SOURCE_FULL_ACCESS_KEY]: { ...disabled, settingFingerprint: "bad" } },
            },
            {
                formatVersion: 1,
                settings: { [RESTRICTED_SOURCE_FULL_ACCESS_KEY]: { ...enabled, userActionEvidenceId: " " } },
            },
            {
                formatVersion: 1,
                settings: { [RESTRICTED_SOURCE_FULL_ACCESS_KEY]: { ...enabled, enabledAt: -1 } },
            },
        ];
        for (const document of documents) {
            writeRaw(document);
            expect(() => readSettingsAuthorityDocument(oaamRoot)).toThrow();
        }
    });

    it("rejects invalid generic JSON and malformed dedicated requests before writing", () => {
        for (const [key, value] of [
            ["", { configVersion: 1 }],
            ["bad\0key", { configVersion: 1 }],
            ["__proto__", { configVersion: 1 }],
            ["adapter.null", { configVersion: 1, value: null }],
            ["adapter.zero", { configVersion: 0 }],
            ["adapter.nan", { configVersion: 1, value: Number.NaN }],
            ["adapter.undefined", { configVersion: 1, value: undefined }],
            ["adapter.fn", { configVersion: 1, value: () => undefined }],
            ["adapter.date", { configVersion: 1, value: new Date(0) }],
        ] as const) {
            expect(() => setGenericSettingAuthority(oaamRoot, key, value as never)).toThrow();
        }
        const virgin = getRestrictedSourceFullAccessAuthority(oaamRoot);
        expect(() =>
            setRestrictedSourceFullAccessAuthority({
                oaamRoot,
                expectedRevision: -1,
                expectedSettingFingerprint: virgin.settingFingerprint,
                nextState: "enabled",
                userActionEvidenceId: " ",
                changedAt: -1,
            }),
        ).toThrow();
        expect(() =>
            setRestrictedSourceFullAccessAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: "bad" as never,
                nextState: "enabled",
                userActionEvidenceId: "ua",
                changedAt: 1,
            }),
        ).toThrow(/SHA-256/);
        expect(() =>
            setRestrictedSourceFullAccessAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: virgin.settingFingerprint,
                nextState: "other" as never,
                userActionEvidenceId: "ua",
                changedAt: 1,
            }),
        ).toThrow(/enabled\|disabled/);
        expect(() =>
            setRestrictedSourceFullAccessAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: virgin.settingFingerprint,
                nextState: "enabled",
                userActionEvidenceId: " ",
                changedAt: 1,
            }),
        ).toThrow(/non-blank/);
        expect(() =>
            setRestrictedSourceFullAccessAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: virgin.settingFingerprint,
                nextState: "enabled",
                userActionEvidenceId: "ua",
                changedAt: -1,
            }),
        ).toThrow(/non-negative/);
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);

        const sparse: unknown[] = [];
        sparse.length = 1;
        expect(() =>
            setGenericSettingAuthority(oaamRoot, "adapter.sparse", {
                configVersion: 1,
                value: sparse,
            }),
        ).toThrow(/dense|sparse/);
        const disguisedSparse: unknown[] = [];
        disguisedSparse.length = 1;
        Object.assign(disguisedSparse, { extra: true });
        expect(() =>
            setGenericSettingAuthority(oaamRoot, "adapter.disguised-sparse", {
                configVersion: 1,
                value: disguisedSparse,
            }),
        ).toThrow(/sparse array holes/);
        const noncanonicalArray: unknown[] = [];
        Object.setPrototypeOf(noncanonicalArray, null);
        expect(() =>
            setGenericSettingAuthority(oaamRoot, "adapter.array-prototype", {
                configVersion: 1,
                value: noncanonicalArray,
            }),
        ).toThrow(/Array prototype/);
        const symbolValue = { configVersion: 1 } as Record<PropertyKey, unknown>;
        symbolValue[Symbol("hidden")] = true;
        expect(() => setGenericSettingAuthority(oaamRoot, "adapter.symbol", symbolValue as never)).toThrow(/symbol/);
        const accessor = { configVersion: 1 } as Record<string, unknown>;
        Object.defineProperty(accessor, "hidden", { enumerable: true, get: () => true });
        expect(() => setGenericSettingAuthority(oaamRoot, "adapter.accessor", accessor as never)).toThrow(/data property/);
    });
});
