import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    getAdapterEnablementAuthority,
    listSettingsAuthorities,
    setAdapterEnablementAuthority,
    setGenericSettingAuthority,
    unsetGenericSettingAuthority,
} from "../../src/catalog/settings-authority";
import {
    ADAPTER_ENABLEMENT_KEY,
    buildAdapterEnablementAuthority,
    canonicalAdapterIds,
    validateStoredAdapterEnablement,
    virginAdapterEnablementAuthority,
} from "../../src/catalog/adapter-enablement-setting";
import type { AdapterId } from "../../src/types";

describe("adapter enablement settings authority", () => {
    let parent = "";
    let oaamRoot = "";

    beforeEach(() => {
        parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-adapter-enablement-"));
        oaamRoot = path.join(parent, ".oaam");
    });

    afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

    it("derives one canonical empty revision-zero authority without materializing settings", () => {
        expect(getAdapterEnablementAuthority(oaamRoot)).toEqual(virginAdapterEnablementAuthority());
        expect(getAdapterEnablementAuthority(oaamRoot)).toEqual(virginAdapterEnablementAuthority());
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);
    });

    it("commits a sorted revision and preserves unrelated opaque settings", () => {
        setGenericSettingAuthority(oaamRoot, "client.future", { configVersion: 3, opaque: ["kept"] });
        const virgin = getAdapterEnablementAuthority(oaamRoot);
        const stored = setAdapterEnablementAuthority({
            oaamRoot,
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            enabledAdapterIds: ["ZETA", "ALPHA"] as AdapterId[],
            userActionEvidenceId: "enable-two",
            changedAt: 10,
        });
        expect(stored).toMatchObject({
            revision: 1,
            enabledAdapterIds: ["ALPHA", "ZETA"],
            userActionEvidenceId: "enable-two",
            updatedAt: 10,
        });
        expect(getAdapterEnablementAuthority(oaamRoot)).toEqual(stored);
        expect(listSettingsAuthorities(oaamRoot)["client.future"]).toEqual({ configVersion: 3, opaque: ["kept"] });

        const disabled = setAdapterEnablementAuthority({
            oaamRoot,
            expectedRevision: stored.revision,
            expectedSettingFingerprint: stored.settingFingerprint,
            enabledAdapterIds: [],
            userActionEvidenceId: "disable-all",
            changedAt: 11,
        });
        expect(disabled).toMatchObject({ revision: 2, enabledAdapterIds: [], userActionEvidenceId: "disable-all" });
    });

    it("rejects stale CAS and malformed mutation inputs without writing a new authority", () => {
        const virgin = getAdapterEnablementAuthority(oaamRoot);
        const attempts = [
            () =>
                setAdapterEnablementAuthority({
                    oaamRoot,
                    expectedRevision: -1,
                    expectedSettingFingerprint: virgin.settingFingerprint,
                    enabledAdapterIds: [],
                    userActionEvidenceId: "bad",
                    changedAt: 1,
                }),
            () =>
                setAdapterEnablementAuthority({
                    oaamRoot,
                    expectedRevision: 0,
                    expectedSettingFingerprint: "bad" as never,
                    enabledAdapterIds: [],
                    userActionEvidenceId: "bad",
                    changedAt: 1,
                }),
            () =>
                setAdapterEnablementAuthority({
                    oaamRoot,
                    expectedRevision: 1,
                    expectedSettingFingerprint: virgin.settingFingerprint,
                    enabledAdapterIds: [],
                    userActionEvidenceId: "stale",
                    changedAt: 1,
                }),
            () =>
                setAdapterEnablementAuthority({
                    oaamRoot,
                    expectedRevision: 0,
                    expectedSettingFingerprint: virgin.settingFingerprint,
                    enabledAdapterIds: ["A", "A"] as AdapterId[],
                    userActionEvidenceId: "duplicate",
                    changedAt: 1,
                }),
            () =>
                setAdapterEnablementAuthority({
                    oaamRoot,
                    expectedRevision: 0,
                    expectedSettingFingerprint: virgin.settingFingerprint,
                    enabledAdapterIds: [],
                    userActionEvidenceId: " ",
                    changedAt: 1,
                }),
            () =>
                setAdapterEnablementAuthority({
                    oaamRoot,
                    expectedRevision: 0,
                    expectedSettingFingerprint: virgin.settingFingerprint,
                    enabledAdapterIds: [],
                    userActionEvidenceId: "zero-time",
                    changedAt: 0,
                }),
        ];
        for (const attempt of attempts) expect(attempt).toThrow();
        expect(() =>
            buildAdapterEnablementAuthority({
                currentRevision: Number.NaN,
                enabledAdapterIds: [],
                userActionEvidenceId: "invalid-revision",
                updatedAt: 1,
            }),
        ).toThrow(/current adapter-enablement revision/);
        expect(() =>
            buildAdapterEnablementAuthority({
                currentRevision: 0,
                enabledAdapterIds: [],
                userActionEvidenceId: "invalid-time",
                updatedAt: 1.5,
            }),
        ).toThrow(/updatedAt/);
        expect(() => canonicalAdapterIds("not-an-array")).toThrow(/array/);
        expect(() => validateStoredAdapterEnablement([] as never)).toThrow(/object/);
        expect(getAdapterEnablementAuthority(oaamRoot)).toEqual(virgin);
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);
    });

    it("keeps generic settings APIs away from the reserved authority", () => {
        expect(() => setGenericSettingAuthority(oaamRoot, ADAPTER_ENABLEMENT_KEY, { configVersion: 1 })).toThrow(/reserved/);
        expect(() => unsetGenericSettingAuthority(oaamRoot, ADAPTER_ENABLEMENT_KEY)).toThrow(/reserved/);
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);
    });

    it("fails closed on non-canonical, tampered and wrong-branch stored values", () => {
        const virgin = getAdapterEnablementAuthority(oaamRoot);
        const valid = setAdapterEnablementAuthority({
            oaamRoot,
            expectedRevision: 0,
            expectedSettingFingerprint: virgin.settingFingerprint,
            enabledAdapterIds: ["A", "B"] as AdapterId[],
            userActionEvidenceId: "valid",
            changedAt: 1,
        });
        const settingsPath = path.join(oaamRoot, "settings.json");
        const base = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
            formatVersion: 1;
            settings: Record<string, Record<string, unknown>>;
        };
        const malformed = [
            { ...valid, extra: true },
            { ...valid, settingId: "wrong" },
            { ...valid, revision: 0 },
            { ...valid, enabledAdapterIds: ["B", "A"] },
            { ...valid, enabledAdapterIds: ["A", "A"] },
            { ...valid, enabledAdapterIds: [""] },
            { ...valid, userActionEvidenceId: " " },
            { ...valid, updatedAt: 0 },
            { ...valid, settingFingerprint: "bad" },
            { ...valid, settingFingerprint: `sha256:${"f".repeat(64)}` },
        ];
        for (const value of malformed) {
            base.settings[ADAPTER_ENABLEMENT_KEY] = value;
            fs.writeFileSync(settingsPath, JSON.stringify(base));
            expect(() => getAdapterEnablementAuthority(oaamRoot)).toThrow();
        }
    });
});
