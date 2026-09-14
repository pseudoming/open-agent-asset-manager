import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import { DesktopPreferencesStore } from "../src/main/desktop-preferences-store";
import { DesktopPresentationAuthority, type DesktopPresentationSystem } from "../src/main/desktop-presentation-authority";
import {
    ENGLISH_DESKTOP_MESSAGES,
    formatDesktopMessage,
    GERMAN_DESKTOP_MESSAGES,
    JAPANESE_DESKTOP_MESSAGES,
    localizedText,
    SIMPLIFIED_CHINESE_DESKTOP_MESSAGES,
    technicalText,
} from "../src/presentation/localization";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopPresentationSnapshot,
    isDesktopAssetLayoutPreference,
    isDesktopLanguagePreference,
    isDesktopSurfacePalettePreference,
    isDesktopTextSizePreference,
    isDesktopThemePreference,
    parseDesktopPresentationPreferenceInput,
    parseDesktopPresentationPreferences,
    parseDesktopPresentationSnapshot,
    parseDesktopProjectId,
    parseStoredDesktopPreferences,
    resolveDesktopLocale,
    resolveDesktopTheme,
} from "../src/presentation/presentation-preferences";
import {
    DesktopPresentationProvider,
    PresentationPreferences,
    useDesktopPaneWidths,
    useDesktopPresentation,
} from "../src/renderer/presentation";
import { WorkbenchResizeSeparator } from "../src/renderer/ui";

const ENGLISH = createDesktopPresentationSnapshot(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, ["en-US"], false);
const CHINESE_DARK = createDesktopPresentationSnapshot(
    { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language: "zh-CN", theme: "dark", onboardingCompleted: true },
    ["en-US"],
    true,
);
const GERMAN = createDesktopPresentationSnapshot(
    { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language: "de", theme: "light", onboardingCompleted: true },
    ["en-US"],
    false,
);
const JAPANESE = createDesktopPresentationSnapshot(
    { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language: "ja", theme: "light", onboardingCompleted: true },
    ["en-US"],
    false,
);
const DEFAULT_PRESENTATION_INPUT = Object.freeze({
    language: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.language,
    theme: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.theme,
    textSize: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.textSize,
    surfacePalette: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.surfacePalette,
    leftPaneWidth: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.leftPaneWidth,
    rightPaneWidth: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.rightPaneWidth,
});

const temporaryRoots: string[] = [];

afterEach(() => {
    cleanup();
    document.documentElement.lang = "";
    document.documentElement.removeAttribute("data-oaam-theme");
    document.documentElement.removeAttribute("data-oaam-text-size");
    document.documentElement.removeAttribute("data-oaam-surface-palette");
    document.documentElement.style.colorScheme = "";
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-desktop-preferences-"));
    temporaryRoots.push(root);
    return root;
}

function templateFields(template: string): string[] {
    const fields: string[] = [];
    let cursor = 0;
    while (cursor < template.length) {
        const start = template.indexOf("{", cursor);
        if (start < 0) break;
        const end = template.indexOf("}", start + 1);
        if (end < 0) break;
        fields.push(template.slice(start + 1, end));
        cursor = end + 1;
    }
    return fields.sort();
}

function bridge(
    options: {
        initial?: DesktopPresentationSnapshot;
        replace?: OaamDesktopBridge["replacePresentationPreferences"];
        subscribe?: OaamDesktopBridge["subscribePresentation"];
    } = {},
): OaamDesktopBridge {
    return {
        initialAppIdentity: { name: "Open Agent Asset Manager", version: "0.1.0-test" },
        initialHostStartup: { status: "starting" },
        initialPresentation: options.initial ?? ENGLISH,
        async retrySession() {},
        async pickProjectRoot() {
            return { status: "cancelled" };
        },
        async pickSourceRoot() {
            return { status: "cancelled" };
        },
        async completeOnboarding() {
            return options.initial ?? ENGLISH;
        },
        replacePresentationPreferences:
            options.replace ??
            (async (input) =>
                createDesktopPresentationSnapshot(
                    {
                        ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                        ...input,
                        onboardingCompleted: (options.initial ?? ENGLISH).preferences.onboardingCompleted,
                        assetLayout: (options.initial ?? ENGLISH).preferences.assetLayout,
                    },
                    ["en-US"],
                    input.theme === "dark",
                )),
        async rememberLastProject() {
            return options.initial ?? ENGLISH;
        },
        async replaceAssetLayout() {
            return options.initial ?? ENGLISH;
        },
        async getDesktopMaintenance() {
            return {
                interfaceCache: { status: "available", byteSize: 0 },
                dataLocations: [
                    { locationId: "oaam_data", status: "available", displayPath: "/oaam" },
                    { locationId: "desktop_profile", status: "available", displayPath: "/profile" },
                    { locationId: "state_backups", status: "available", displayPath: "/oaam/backups" },
                    { locationId: "ordinary_logs", status: "available", displayPath: "/oaam/logs/ordinary" },
                    { locationId: "interface_cache", status: "available", displayPath: "/cache" },
                ],
            };
        },
        async clearDesktopInterfaceCache() {
            return { status: "complete", interfaceCache: { status: "available", byteSize: 0 } };
        },
        async performDesktopDataLocationAction() {
            return { status: "complete" };
        },
        async restoreDesktopInterfaceDefaults() {
            return { status: "complete", presentation: "complete", windowState: "complete" };
        },
        subscribeHostStartup: () => () => undefined,
        subscribePresentation: options.subscribe ?? (() => () => undefined),
    };
}

describe("Desktop presentation value contract", () => {
    it("accepts only exact versioned preferences, inputs and snapshots", () => {
        expect(isDesktopLanguagePreference("system")).toBe(true);
        expect(isDesktopLanguagePreference("en")).toBe(true);
        expect(isDesktopLanguagePreference("zh-CN")).toBe(true);
        expect(isDesktopLanguagePreference("de")).toBe(true);
        expect(isDesktopLanguagePreference("ja")).toBe(true);
        expect(isDesktopLanguagePreference("fr")).toBe(false);
        expect(isDesktopThemePreference("system")).toBe(true);
        expect(isDesktopThemePreference("light")).toBe(true);
        expect(isDesktopThemePreference("dark")).toBe(true);
        expect(isDesktopThemePreference("contrast")).toBe(false);
        expect(isDesktopTextSizePreference("default")).toBe(true);
        expect(isDesktopTextSizePreference("huge")).toBe(false);
        expect(isDesktopSurfacePalettePreference("cool")).toBe(true);
        expect(isDesktopSurfacePalettePreference("custom")).toBe(false);
        expect(isDesktopAssetLayoutPreference("list")).toBe(true);
        expect(isDesktopAssetLayoutPreference("cards")).toBe(true);
        expect(isDesktopAssetLayoutPreference("grid")).toBe(false);

        const parsed = parseDesktopPresentationPreferences({
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            language: "zh-CN",
            theme: "dark",
            onboardingCompleted: true,
            assetLayout: "cards",
            lastSelectedProjectId: "11111111-1111-4111-8111-111111111111",
        });
        expect(parsed).toEqual({
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            language: "zh-CN",
            theme: "dark",
            onboardingCompleted: true,
            assetLayout: "cards",
            lastSelectedProjectId: "11111111-1111-4111-8111-111111111111",
        });
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(parseStoredDesktopPreferences({ schemaVersion: 1, language: "zh-CN", theme: "dark" })).toEqual({
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            language: "zh-CN",
            theme: "dark",
        });
        expect(
            parseStoredDesktopPreferences({
                schemaVersion: 2,
                language: "en",
                theme: "light",
                onboardingCompleted: true,
            }),
        ).toEqual({
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            language: "en",
            theme: "light",
            onboardingCompleted: true,
        });
        expect(
            parseStoredDesktopPreferences({
                schemaVersion: 3,
                language: "de",
                theme: "dark",
                onboardingCompleted: true,
                assetLayout: "cards",
                lastSelectedProjectId: "11111111-1111-4111-8111-111111111111",
            }),
        ).toEqual({
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            language: "de",
            theme: "dark",
            onboardingCompleted: true,
            assetLayout: "cards",
            lastSelectedProjectId: "11111111-1111-4111-8111-111111111111",
        });
        expect(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES.rightPaneWidth).toBe(560);
        expect(
            parseStoredDesktopPreferences({ ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, rightPaneWidth: 336 }).rightPaneWidth,
        ).toBe(336);
        expect(parseDesktopProjectId("11111111-1111-4111-8111-111111111111")).toBe("11111111-1111-4111-8111-111111111111");
        expect(() => parseDesktopProjectId("not-a-project")).toThrow(TypeError);
        expect(
            parseDesktopPresentationPreferenceInput({
                language: "en",
                theme: "light",
                textSize: "large",
                surfacePalette: "cool",
                leftPaneWidth: 320,
                rightPaneWidth: 384,
            }),
        ).toEqual({
            language: "en",
            theme: "light",
            textSize: "large",
            surfacePalette: "cool",
            leftPaneWidth: 320,
            rightPaneWidth: 384,
        });
        expect(parseDesktopPresentationSnapshot(CHINESE_DARK)).toEqual(CHINESE_DARK);

        const invalidValues: unknown[] = [
            null,
            [],
            { schemaVersion: 4, language: "en", theme: "light", onboardingCompleted: false, assetLayout: "list" },
            { schemaVersion: 2, language: "fr", theme: "light", onboardingCompleted: false },
            { schemaVersion: 3, language: "en", theme: "contrast", onboardingCompleted: false, assetLayout: "list" },
            { schemaVersion: 3, language: "en", theme: "light", onboardingCompleted: false },
            { schemaVersion: 3, language: "en", theme: "light", onboardingCompleted: false, assetLayout: "grid" },
            {
                schemaVersion: 3,
                language: "en",
                theme: "light",
                onboardingCompleted: false,
                assetLayout: "list",
                lastSelectedProjectId: "invalid",
            },
            {
                schemaVersion: 3,
                language: "en",
                theme: "light",
                onboardingCompleted: false,
                assetLayout: "list",
                extra: true,
            },
            {
                ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                leftPaneWidth: 223,
            },
            {
                ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                rightPaneWidth: 961,
            },
        ];
        for (const value of invalidValues) expect(() => parseDesktopPresentationPreferences(value)).toThrow(TypeError);
        expect(() => parseDesktopPresentationPreferenceInput({ language: "en", theme: "light", extra: true })).toThrow(TypeError);
        expect(() => parseDesktopPresentationPreferenceInput({ language: "fr", theme: "light" })).toThrow(TypeError);
        expect(() =>
            parseDesktopPresentationSnapshot({
                preferences: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                resolvedLocale: "fr",
                resolvedTheme: "light",
            }),
        ).toThrow(TypeError);
        expect(() =>
            parseDesktopPresentationSnapshot({
                preferences: DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                resolvedLocale: "en",
                resolvedTheme: "contrast",
            }),
        ).toThrow(TypeError);
    });

    it("resolves system choices deterministically without overriding explicit choices", () => {
        expect(resolveDesktopLocale("system", ["fr-FR", "zh-Hant", "en-US"])).toBe("zh-CN");
        expect(resolveDesktopLocale("system", ["fr-FR", "de-DE", "ja-JP"])).toBe("de");
        expect(resolveDesktopLocale("system", ["fr-FR", "ja-JP", "de-DE"])).toBe("ja");
        expect(resolveDesktopLocale("system", ["fr-FR", "en-GB", "zh-CN"])).toBe("en");
        expect(resolveDesktopLocale("system", ["fr-FR"])).toBe("en");
        expect(resolveDesktopLocale("en", ["zh-CN"])).toBe("en");
        expect(resolveDesktopLocale("zh-CN", ["en-US"])).toBe("zh-CN");
        expect(resolveDesktopLocale("de", ["ja-JP"])).toBe("de");
        expect(resolveDesktopLocale("ja", ["de-DE"])).toBe("ja");
        expect(resolveDesktopTheme("system", true)).toBe("dark");
        expect(resolveDesktopTheme("system", false)).toBe("light");
        expect(resolveDesktopTheme("dark", false)).toBe("dark");
        expect(resolveDesktopTheme("light", true)).toBe("light");
    });

    it("keeps all four catalogs in exact key and placeholder parity without partial-locale fallback", () => {
        const translatedCatalogs = [
            SIMPLIFIED_CHINESE_DESKTOP_MESSAGES,
            GERMAN_DESKTOP_MESSAGES,
            JAPANESE_DESKTOP_MESSAGES,
        ] as const;
        for (const catalog of translatedCatalogs) {
            expect(Object.keys(catalog).sort()).toEqual(Object.keys(ENGLISH_DESKTOP_MESSAGES).sort());
            for (const id of Object.keys(ENGLISH_DESKTOP_MESSAGES) as (keyof typeof ENGLISH_DESKTOP_MESSAGES)[]) {
                expect(templateFields(catalog[id]), id).toEqual(templateFields(ENGLISH_DESKTOP_MESSAGES[id]));
            }
        }
        expect(formatDesktopMessage(ENGLISH, "workspace.catalog.assets.many", { count: 2 })).toBe("2 assets");
        expect(formatDesktopMessage(CHINESE_DARK, "workspace.catalog.assets.many", { count: 2 })).toBe("2 个资产");
        expect(formatDesktopMessage(GERMAN, "common.close")).toBe("Schließen");
        expect(formatDesktopMessage(JAPANESE, "common.close")).toBe("閉じる");
        expect(formatDesktopMessage(JAPANESE, "catalog.ui.preview.missing")).toBe("存在しない");
        expect(formatDesktopMessage(ENGLISH, "library.projects.empty_copy")).toBe(
            "Add your first Project folder, or import Assets from tools you already use.",
        );
        expect(formatDesktopMessage(CHINESE_DARK, "library.projects.empty_copy")).toBe(
            "添加第一个项目文件夹，或从现有工具导入资产。",
        );
        expect(formatDesktopMessage(GERMAN, "library.projects.empty_copy")).toBe(
            "Fügen Sie Ihren ersten Projektordner hinzu oder importieren Sie Assets aus bereits verwendeten Tools.",
        );
        expect(formatDesktopMessage(JAPANESE, "library.projects.empty_copy")).toBe(
            "最初のプロジェクトフォルダーを追加するか、使用中のツールからアセットをインポートします。",
        );
        expect(
            formatDesktopMessage(ENGLISH, "catalog.operation.lost_terminal", {
                operation: localizedText("catalog.activity.deploy"),
            }),
        ).toContain("Deploying");
        expect(
            formatDesktopMessage(ENGLISH, "catalog.operation.lost_terminal", {
                operation: technicalText("runtime write"),
            }),
        ).toContain("runtime write");
        expect(localizedText("common.retry")).toEqual({ kind: "localized", id: "common.retry" });
        expect(technicalText("raw diagnostic")).toEqual({ kind: "technical", text: "raw diagnostic" });
    });

    it("keeps the Chinese Asset-library and Import-sources product chrome independent from English model terms", () => {
        const reviewedPrefixes = [
            "library.assets.",
            "library.global.",
            "library.projects.",
            "library.subject.",
            "library.summary.",
            "library.tree.",
            "project_lifecycle.",
            "sources.",
        ] as const;
        const reviewedExactKeys = new Set(["library.import_sources"]);
        const untranslatedProductTerm =
            /\b(?:Project|Projects|Global|Asset|Assets|Deployment|State|Guidance|Rule|Rules|Workflow|Workflows|Skill|Skills)\b/u;
        for (const [id, value] of Object.entries(SIMPLIFIED_CHINESE_DESKTOP_MESSAGES)) {
            if (!reviewedExactKeys.has(id) && !reviewedPrefixes.some((prefix) => id.startsWith(prefix))) continue;
            expect(value, id).not.toMatch(untranslatedProductTerm);
        }
    });

    it.each([
        ["English", ENGLISH_DESKTOP_MESSAGES, ["AI coding tools"], undefined],
        ["German", GERMAN_DESKTOP_MESSAGES, ["KI-Coding-Tools"], undefined],
        ["Japanese", JAPANESE_DESKTOP_MESSAGES, ["AI コーディングツール"], undefined],
        ["Simplified Chinese", SIMPLIFIED_CHINESE_DESKTOP_MESSAGES, ["项目文件", "工具配置文件"], "AI 编程工具"],
    ] as const)("describes %s backup and Project boundaries without runtime architecture language", (_locale, catalog, concreteTerms, abstractTerm) => {
        const boundaryCopy = [catalog["project_lifecycle.stop.no_external_delete"], catalog["state_resilience.backup.copy"]].join(
            " ",
        );
        for (const term of concreteTerms) expect(boundaryCopy).toContain(term);
        if (abstractTerm !== undefined) expect(boundaryCopy).not.toContain(abstractTerm);
        expect(boundaryCopy).not.toMatch(/\b(?:runtime|agent[- ]runtime|payloads?)\b|Agent-Runtime|ランタイム|运行时/iu);
    });
});

describe("Desktop presentation persistence and authority", () => {
    it("falls back without mutating missing or corrupt files, then atomically persists restart state", () => {
        const root = temporaryRoot();
        const file = path.join(root, "desktop-preferences.json");
        const missing = new DesktopPreferencesStore(root);
        expect(missing.current).toBe(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES);
        expect(fs.existsSync(file)).toBe(false);

        fs.writeFileSync(file, "{broken");
        const corrupt = new DesktopPreferencesStore(root);
        expect(corrupt.current).toBe(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES);
        expect(fs.readFileSync(file, "utf8")).toBe("{broken");

        expect(
            corrupt.replace({
                ...DEFAULT_PRESENTATION_INPUT,
                language: "zh-CN",
                theme: "dark",
                leftPaneWidth: 320,
                rightPaneWidth: 384,
            }),
        ).toEqual({
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            language: "zh-CN",
            theme: "dark",
            leftPaneWidth: 320,
            rightPaneWidth: 384,
        });
        expect(fs.readdirSync(root).sort()).toEqual(["desktop-preferences.json"]);
        expect(new DesktopPreferencesStore(root).current).toEqual({
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            language: "zh-CN",
            theme: "dark",
            leftPaneWidth: 320,
            rightPaneWidth: 384,
        });
    });

    it("migrates legacy presentation choices without mutating the file until an explicit onboarding action", () => {
        const root = temporaryRoot();
        const file = path.join(root, "desktop-preferences.json");
        const legacy = `${JSON.stringify({ schemaVersion: 1, language: "zh-CN", theme: "dark" }, null, 4)}\n`;
        fs.writeFileSync(file, legacy);

        const store = new DesktopPreferencesStore(root);
        expect(store.current).toEqual({
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            language: "zh-CN",
            theme: "dark",
        });
        expect(fs.readFileSync(file, "utf8")).toBe(legacy);

        const completed = store.completeOnboarding();
        expect(completed.onboardingCompleted).toBe(true);
        expect(store.completeOnboarding()).toBe(completed);
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(completed);
    });

    it("does not hide unexpected filesystem failures", () => {
        const root = temporaryRoot();
        const notDirectory = path.join(root, "not-a-directory");
        fs.writeFileSync(notDirectory, "file");
        expect(() => new DesktopPreferencesStore(notDirectory)).toThrow();

        const invalidFileRoot = path.join(root, "invalid-file-root");
        fs.mkdirSync(invalidFileRoot);
        fs.mkdirSync(path.join(invalidFileRoot, "desktop-preferences.json"));
        expect(() => new DesktopPreferencesStore(invalidFileRoot)).toThrow();

        const actual = path.join(root, "actual");
        const linked = path.join(root, "linked");
        fs.mkdirSync(actual);
        fs.symlinkSync(actual, linked);
        expect(() => new DesktopPreferencesStore(linked)).toThrow(/symbolic|symlink/u);
    });

    it("creates one missing user-data child through Shared and treats invalid UTF-8 as corrupt without mutation", () => {
        const parent = temporaryRoot();
        const root = path.join(parent, "user-data");
        const store = new DesktopPreferencesStore(root);
        expect(fs.statSync(root).isDirectory()).toBe(true);
        expect(store.current).toBe(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES);

        const file = path.join(root, "desktop-preferences.json");
        const invalidUtf8 = Buffer.from([0xff]);
        fs.writeFileSync(file, invalidUtf8);
        expect(new DesktopPreferencesStore(root).current).toBe(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES);
        expect(fs.readFileSync(file)).toEqual(invalidUtf8);
    });

    it("publishes validated replacements and live system-theme changes to current subscribers only", () => {
        const store = new DesktopPreferencesStore(temporaryRoot());
        let dark = false;
        const system: DesktopPresentationSystem = {
            getPreferredSystemLanguages: vi.fn(() => ["zh-CN"]),
            shouldUseDarkColors: vi.fn(() => dark),
            setThemeSource: vi.fn(),
        };
        const authority = new DesktopPresentationAuthority(store, system);
        expect(system.setThemeSource).toHaveBeenCalledWith("system");
        expect(authority.snapshot).toMatchObject({ resolvedLocale: "zh-CN", resolvedTheme: "light" });

        const listener = vi.fn();
        const unsubscribe = authority.subscribe(listener);
        expect(authority.replace({ ...DEFAULT_PRESENTATION_INPUT, language: "en", theme: "dark" })).toMatchObject({
            resolvedLocale: "en",
            resolvedTheme: "dark",
        });
        expect(system.setThemeSource).toHaveBeenLastCalledWith("dark");
        expect(listener).toHaveBeenCalledTimes(1);

        expect(authority.completeOnboarding()).toMatchObject({
            preferences: { onboardingCompleted: true },
        });
        expect(listener).toHaveBeenCalledTimes(2);

        expect(authority.rememberProject("11111111-1111-4111-8111-111111111111")).toMatchObject({
            preferences: { lastSelectedProjectId: "11111111-1111-4111-8111-111111111111" },
        });
        expect(authority.replaceAssetLayout("cards")).toMatchObject({ preferences: { assetLayout: "cards" } });
        expect(listener).toHaveBeenCalledTimes(4);
        expect(authority.restoreInterfaceDefaults()).toMatchObject({
            preferences: {
                language: "system",
                theme: "system",
                onboardingCompleted: true,
                assetLayout: "list",
                lastSelectedProjectId: "11111111-1111-4111-8111-111111111111",
            },
        });
        expect(system.setThemeSource).toHaveBeenLastCalledWith("system");
        expect(listener).toHaveBeenCalledTimes(5);

        dark = true;
        authority.systemThemeChanged();
        expect(listener).toHaveBeenCalledTimes(6);
        unsubscribe();
        authority.systemThemeChanged();
        expect(listener).toHaveBeenCalledTimes(6);
        expect(() => authority.replace({ ...DEFAULT_PRESENTATION_INPUT, language: "fr", theme: "dark" } as never)).toThrow(
            TypeError,
        );
        expect(() => authority.rememberProject("bad-project")).toThrow(TypeError);
        expect(() => authority.replaceAssetLayout("grid" as never)).toThrow(TypeError);
    });

    it("exports and restores one exact Desktop preference snapshot while preserving displaced bytes", () => {
        const root = temporaryRoot();
        const store = new DesktopPreferencesStore(root);
        store.replace({ ...DEFAULT_PRESENTATION_INPUT, language: "zh-CN", theme: "dark" });
        const exported = store.exportBytes();
        store.replace({ ...DEFAULT_PRESENTATION_INPUT, language: "en", theme: "light" });
        const displaced = store.exportBytes();
        const restoreTransactionPath = path.join(root, ".oaam.restore-txn-11111111-1111-4111-8111-111111111111");
        fs.mkdirSync(restoreTransactionPath);
        const system: DesktopPresentationSystem = {
            getPreferredSystemLanguages: vi.fn(() => ["en-US"]),
            shouldUseDarkColors: vi.fn(() => false),
            setThemeSource: vi.fn(),
        };
        const authority = new DesktopPresentationAuthority(store, system);
        const listener = vi.fn();
        authority.subscribe(listener);

        expect(authority.exportPreferences()).toEqual(displaced);
        expect(authority.applyRestoredPreferences(exported, restoreTransactionPath)).toMatchObject({
            preferences: { language: "zh-CN", theme: "dark" },
            resolvedTheme: "dark",
        });
        expect(system.setThemeSource).toHaveBeenLastCalledWith("dark");
        expect(listener).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(path.join(root, "desktop-preferences.json"))).toEqual(Buffer.from(exported));
        expect(fs.readFileSync(path.join(restoreTransactionPath, "displaced-desktop-preferences.json"))).toEqual(
            Buffer.from(displaced),
        );
    });

    it("rejects an unowned Desktop restore transaction and permits restore when no displaced file exists", () => {
        const sourceRoot = temporaryRoot();
        const source = new DesktopPreferencesStore(sourceRoot);
        source.replace({ ...DEFAULT_PRESENTATION_INPUT, language: "ja", theme: "system" });
        const exported = source.exportBytes();

        const targetRoot = temporaryRoot();
        const target = new DesktopPreferencesStore(targetRoot);
        expect(() => target.applyRestored(exported, path.join(targetRoot, "restore"))).toThrow(/restore transaction/u);
        expect(() =>
            target.applyRestored(
                new Uint8Array([0xff]),
                path.join(targetRoot, ".oaam.restore-txn-22222222-2222-4222-8222-222222222222"),
            ),
        ).toThrow();

        const restoreTransactionPath = path.join(targetRoot, ".oaam.restore-txn-22222222-2222-4222-8222-222222222222");
        fs.mkdirSync(restoreTransactionPath);
        expect(target.applyRestored(exported, restoreTransactionPath)).toMatchObject({
            language: "ja",
            theme: "system",
        });
        expect(fs.readdirSync(restoreTransactionPath)).toEqual([]);
    });
});

describe("Desktop presentation renderer", () => {
    it("applies live system presentation and saves explicit language and theme choices", async () => {
        let listener: ((snapshot: DesktopPresentationSnapshot) => void) | undefined;
        const replace = vi.fn(async (input) =>
            createDesktopPresentationSnapshot(
                { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, ...input },
                ["en-US"],
                input.theme === "dark",
            ),
        );
        const desktopBridge = bridge({
            replace,
            subscribe(next) {
                listener = next;
                return () => {
                    listener = undefined;
                };
            },
        });
        render(createElement(DesktopPresentationProvider, { bridge: desktopBridge }, createElement(PresentationPreferences)));
        await waitFor(() => expect(document.documentElement.lang).toBe("en"));
        expect(document.documentElement.dataset.oaamTheme).toBe("light");
        fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
        expect(screen.getByRole("option", { name: "Deutsch" })).not.toBeNull();
        expect(screen.getByRole("option", { name: "日本語" })).not.toBeNull();
        fireEvent.click(screen.getByRole("option", { name: "简体中文" }));
        await waitFor(() =>
            expect(replace).toHaveBeenCalledWith({
                ...DEFAULT_PRESENTATION_INPUT,
                language: "zh-CN",
            }),
        );
        await screen.findByLabelText("语言");

        act(() => listener?.(CHINESE_DARK));
        expect(document.documentElement.lang).toBe("zh-CN");
        expect(document.documentElement.dataset.oaamTheme).toBe("dark");
        expect(document.documentElement.style.colorScheme).toBe("dark");
    });

    it("keeps the previous presentation and reports a failed preference write", async () => {
        render(
            createElement(
                DesktopPresentationProvider,
                {
                    bridge: bridge({
                        replace: vi.fn(async () => Promise.reject(new Error("disk full"))),
                    }),
                },
                createElement(PresentationPreferences),
            ),
        );
        fireEvent.click(screen.getByRole("combobox", { name: "Appearance" }));
        fireEvent.click(screen.getByRole("option", { name: "Dark" }));
        expect((await screen.findByRole("alert")).textContent).toContain("could not be saved");
        expect(screen.getByRole("combobox", { name: "Appearance" }).textContent).toContain("System");
    });

    it("persists text, palette, and both pane-width choices without dropping earlier choices", async () => {
        const replace = vi.fn(async (input) =>
            createDesktopPresentationSnapshot({ ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, ...input }, ["en-US"], false),
        );
        render(
            createElement(DesktopPresentationProvider, { bridge: bridge({ replace }) }, createElement(PresentationPreferences)),
        );

        fireEvent.click(screen.getByLabelText("Text size"));
        fireEvent.click(screen.getByRole("option", { name: "Large" }));
        await waitFor(() => expect(document.documentElement.dataset.oaamTextSize).toBe("large"));

        fireEvent.click(screen.getByLabelText("Surface palette"));
        fireEvent.click(screen.getByRole("option", { name: "Cool" }));
        await waitFor(() => expect(document.documentElement.dataset.oaamSurfacePalette).toBe("cool"));

        fireEvent.change(screen.getByLabelText("Left pane width"), { target: { value: "320" } });
        await waitFor(() =>
            expect(replace).toHaveBeenLastCalledWith({
                ...DEFAULT_PRESENTATION_INPUT,
                textSize: "large",
                surfacePalette: "cool",
                leftPaneWidth: 320,
            }),
        );

        fireEvent.change(screen.getByLabelText("Right pane width"), { target: { value: "384" } });
        await waitFor(() =>
            expect(replace).toHaveBeenLastCalledWith({
                ...DEFAULT_PRESENTATION_INPUT,
                textSize: "large",
                surfacePalette: "cool",
                leftPaneWidth: 320,
                rightPaneWidth: 384,
            }),
        );
    });

    it("persists a keyboard-resized pane through the complete presentation preference authority", async () => {
        const replace = vi.fn(async (input) =>
            createDesktopPresentationSnapshot({ ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, ...input }, ["en-US"], false),
        );

        function PaneProbe(): React.JSX.Element {
            const paneWidths = useDesktopPaneWidths();
            return createElement(WorkbenchResizeSeparator, {
                label: "Left pane width",
                value: paneWidths.widths.left,
                minimum: 224,
                maximum: 400,
                onPreview: paneWidths.previewLeft,
                onCommit: paneWidths.commitLeft,
            });
        }

        render(createElement(DesktopPresentationProvider, { bridge: bridge({ replace }) }, createElement(PaneProbe)));

        fireEvent.keyDown(screen.getByRole("separator", { name: "Left pane width" }), { key: "End" });
        await waitFor(() =>
            expect(replace).toHaveBeenCalledWith({
                ...DEFAULT_PRESENTATION_INPUT,
                leftPaneWidth: 400,
            }),
        );
        await waitFor(() =>
            expect(screen.getByRole("separator", { name: "Left pane width" }).getAttribute("aria-valuenow")).toBe("400"),
        );
    });

    it("keeps a failed pane-width persistence visible", async () => {
        function PaneProbe(): React.JSX.Element {
            const paneWidths = useDesktopPaneWidths();
            return createElement(
                "div",
                null,
                createElement(WorkbenchResizeSeparator, {
                    label: "Left pane width",
                    value: paneWidths.widths.left,
                    minimum: 224,
                    maximum: 400,
                    onPreview: paneWidths.previewLeft,
                    onCommit: paneWidths.commitLeft,
                }),
                paneWidths.saveFailed ? createElement("span", { role: "alert" }, "Width was not saved") : null,
            );
        }

        render(
            createElement(
                DesktopPresentationProvider,
                {
                    bridge: bridge({
                        replace: vi.fn(async () => Promise.reject(new Error("disk full"))),
                    }),
                },
                createElement(PaneProbe),
            ),
        );

        fireEvent.keyDown(screen.getByRole("separator", { name: "Left pane width" }), { key: "End" });
        expect((await screen.findByRole("alert")).textContent).toBe("Width was not saved");
    });

    it("renders structured display text through the active locale", () => {
        function Probe(): React.JSX.Element {
            const { displayText } = useDesktopPresentation();
            return createElement(
                "div",
                null,
                createElement("span", null, displayText(localizedText("common.retry"))),
                createElement("span", null, displayText(technicalText("RAW"))),
            );
        }
        render(createElement(DesktopPresentationProvider, { bridge: bridge({ initial: CHINESE_DARK }) }, createElement(Probe)));
        expect(screen.getByText("重试")).toBeTruthy();
        expect(screen.getByText("RAW")).toBeTruthy();
    });
});
