export const DESKTOP_PREFERENCES_SCHEMA_VERSION = 4 as const;

export type DesktopLanguagePreference = "system" | "en" | "zh-CN" | "de" | "ja";
export type DesktopThemePreference = "system" | "light" | "dark";
export type DesktopTextSizePreference = "small" | "default" | "large";
export type DesktopSurfacePalettePreference = "warm" | "neutral" | "cool";
export type DesktopAssetLayoutPreference = "list" | "cards";
export type DesktopResolvedLocale = Exclude<DesktopLanguagePreference, "system">;
export type DesktopResolvedTheme = "light" | "dark";

export const DESKTOP_PANE_WIDTHS = Object.freeze({
    left: Object.freeze({ minimum: 224, default: 288, maximum: 400 }),
    right: Object.freeze({ minimum: 304, default: 560, maximum: 960 }),
});

export interface DesktopPreferencesV4 {
    readonly schemaVersion: typeof DESKTOP_PREFERENCES_SCHEMA_VERSION;
    readonly language: DesktopLanguagePreference;
    readonly theme: DesktopThemePreference;
    readonly textSize: DesktopTextSizePreference;
    readonly surfacePalette: DesktopSurfacePalettePreference;
    readonly leftPaneWidth: number;
    readonly rightPaneWidth: number;
    readonly onboardingCompleted: boolean;
    readonly assetLayout: DesktopAssetLayoutPreference;
    readonly lastSelectedProjectId?: string;
}

export interface DesktopPresentationPreferenceInput {
    readonly language: DesktopLanguagePreference;
    readonly theme: DesktopThemePreference;
    readonly textSize: DesktopTextSizePreference;
    readonly surfacePalette: DesktopSurfacePalettePreference;
    readonly leftPaneWidth: number;
    readonly rightPaneWidth: number;
}

export interface DesktopPresentationSnapshot {
    readonly preferences: DesktopPreferencesV4;
    readonly resolvedLocale: DesktopResolvedLocale;
    readonly resolvedTheme: DesktopResolvedTheme;
}

export const DEFAULT_DESKTOP_PRESENTATION_PREFERENCES: DesktopPreferencesV4 = Object.freeze({
    schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
    language: "system",
    theme: "system",
    textSize: "default",
    surfacePalette: "warm",
    leftPaneWidth: DESKTOP_PANE_WIDTHS.left.default,
    rightPaneWidth: DESKTOP_PANE_WIDTHS.right.default,
    onboardingCompleted: false,
    assetLayout: "list",
});

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isDesktopLanguagePreference(value: unknown): value is DesktopLanguagePreference {
    return value === "system" || value === "en" || value === "zh-CN" || value === "de" || value === "ja";
}

export function isDesktopThemePreference(value: unknown): value is DesktopThemePreference {
    return value === "system" || value === "light" || value === "dark";
}

export function isDesktopTextSizePreference(value: unknown): value is DesktopTextSizePreference {
    return value === "small" || value === "default" || value === "large";
}

export function isDesktopSurfacePalettePreference(value: unknown): value is DesktopSurfacePalettePreference {
    return value === "warm" || value === "neutral" || value === "cool";
}

function isPaneWidth(value: unknown, pane: "left" | "right"): value is number {
    const bounds = DESKTOP_PANE_WIDTHS[pane];
    return typeof value === "number" && Number.isInteger(value) && value >= bounds.minimum && value <= bounds.maximum;
}

export function isDesktopAssetLayoutPreference(value: unknown): value is DesktopAssetLayoutPreference {
    return value === "list" || value === "cards";
}

export function parseDesktopProjectId(value: unknown): string {
    if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
        throw new TypeError("invalid Desktop Project preference identity");
    }
    return value;
}

export function parseDesktopPresentationPreferences(value: unknown): DesktopPreferencesV4 {
    const keys =
        typeof value === "object" && value !== null && !Array.isArray(value) && "lastSelectedProjectId" in value
            ? [
                  "assetLayout",
                  "language",
                  "lastSelectedProjectId",
                  "leftPaneWidth",
                  "onboardingCompleted",
                  "rightPaneWidth",
                  "schemaVersion",
                  "surfacePalette",
                  "textSize",
                  "theme",
              ]
            : [
                  "assetLayout",
                  "language",
                  "leftPaneWidth",
                  "onboardingCompleted",
                  "rightPaneWidth",
                  "schemaVersion",
                  "surfacePalette",
                  "textSize",
                  "theme",
              ];
    if (
        !isExactRecord(value, keys) ||
        value.schemaVersion !== DESKTOP_PREFERENCES_SCHEMA_VERSION ||
        !isDesktopLanguagePreference(value.language) ||
        !isDesktopThemePreference(value.theme) ||
        !isDesktopTextSizePreference(value.textSize) ||
        !isDesktopSurfacePalettePreference(value.surfacePalette) ||
        !isPaneWidth(value.leftPaneWidth, "left") ||
        !isPaneWidth(value.rightPaneWidth, "right") ||
        typeof value.onboardingCompleted !== "boolean" ||
        !isDesktopAssetLayoutPreference(value.assetLayout) ||
        ("lastSelectedProjectId" in value &&
            (typeof value.lastSelectedProjectId !== "string" || !UUID_V4_PATTERN.test(value.lastSelectedProjectId)))
    ) {
        throw new TypeError("invalid Desktop presentation preferences");
    }
    return Object.freeze({
        schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
        language: value.language,
        theme: value.theme,
        textSize: value.textSize,
        surfacePalette: value.surfacePalette,
        leftPaneWidth: value.leftPaneWidth,
        rightPaneWidth: value.rightPaneWidth,
        onboardingCompleted: value.onboardingCompleted,
        assetLayout: value.assetLayout,
        ...(typeof value.lastSelectedProjectId === "string" ? { lastSelectedProjectId: value.lastSelectedProjectId } : {}),
    });
}

export function parseStoredDesktopPreferences(value: unknown): DesktopPreferencesV4 {
    if (
        isExactRecord(value, ["language", "schemaVersion", "theme"]) &&
        value.schemaVersion === 1 &&
        isDesktopLanguagePreference(value.language) &&
        isDesktopThemePreference(value.theme)
    ) {
        return Object.freeze({
            schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
            language: value.language,
            theme: value.theme,
            textSize: "default",
            surfacePalette: "warm",
            leftPaneWidth: DESKTOP_PANE_WIDTHS.left.default,
            rightPaneWidth: DESKTOP_PANE_WIDTHS.right.default,
            onboardingCompleted: false,
            assetLayout: "list",
        });
    }
    if (
        isExactRecord(value, ["language", "onboardingCompleted", "schemaVersion", "theme"]) &&
        value.schemaVersion === 2 &&
        isDesktopLanguagePreference(value.language) &&
        isDesktopThemePreference(value.theme) &&
        typeof value.onboardingCompleted === "boolean"
    ) {
        return Object.freeze({
            schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
            language: value.language,
            theme: value.theme,
            textSize: "default",
            surfacePalette: "warm",
            leftPaneWidth: DESKTOP_PANE_WIDTHS.left.default,
            rightPaneWidth: DESKTOP_PANE_WIDTHS.right.default,
            onboardingCompleted: value.onboardingCompleted,
            assetLayout: "list",
        });
    }
    if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "schemaVersion" in value &&
        value.schemaVersion === 3
    ) {
        const record: Record<string, unknown> = value;
        const keys =
            "lastSelectedProjectId" in record
                ? ["assetLayout", "language", "lastSelectedProjectId", "onboardingCompleted", "schemaVersion", "theme"]
                : ["assetLayout", "language", "onboardingCompleted", "schemaVersion", "theme"];
        if (
            !isExactRecord(record, keys) ||
            !isDesktopLanguagePreference(record.language) ||
            !isDesktopThemePreference(record.theme) ||
            typeof record.onboardingCompleted !== "boolean" ||
            !isDesktopAssetLayoutPreference(record.assetLayout) ||
            ("lastSelectedProjectId" in record &&
                (typeof record.lastSelectedProjectId !== "string" || !UUID_V4_PATTERN.test(record.lastSelectedProjectId)))
        ) {
            throw new TypeError("invalid Desktop presentation preferences");
        }
        return Object.freeze({
            schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
            language: record.language,
            theme: record.theme,
            textSize: "default",
            surfacePalette: "warm",
            leftPaneWidth: DESKTOP_PANE_WIDTHS.left.default,
            rightPaneWidth: DESKTOP_PANE_WIDTHS.right.default,
            onboardingCompleted: record.onboardingCompleted,
            assetLayout: record.assetLayout,
            ...(typeof record.lastSelectedProjectId === "string" ? { lastSelectedProjectId: record.lastSelectedProjectId } : {}),
        });
    }
    return parseDesktopPresentationPreferences(value);
}

export function parseDesktopPresentationPreferenceInput(value: unknown): DesktopPresentationPreferenceInput {
    if (
        !isExactRecord(value, ["language", "leftPaneWidth", "rightPaneWidth", "surfacePalette", "textSize", "theme"]) ||
        !isDesktopLanguagePreference(value.language) ||
        !isDesktopThemePreference(value.theme) ||
        !isDesktopTextSizePreference(value.textSize) ||
        !isDesktopSurfacePalettePreference(value.surfacePalette) ||
        !isPaneWidth(value.leftPaneWidth, "left") ||
        !isPaneWidth(value.rightPaneWidth, "right")
    ) {
        throw new TypeError("invalid Desktop presentation preference input");
    }
    return Object.freeze({
        language: value.language,
        theme: value.theme,
        textSize: value.textSize,
        surfacePalette: value.surfacePalette,
        leftPaneWidth: value.leftPaneWidth,
        rightPaneWidth: value.rightPaneWidth,
    });
}

export function resolveDesktopLocale(
    preference: DesktopLanguagePreference,
    preferredSystemLanguages: readonly string[],
): DesktopResolvedLocale {
    if (preference !== "system") return preference;
    for (const language of preferredSystemLanguages) {
        const normalized = language.toLowerCase();
        if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
        if (normalized === "de" || normalized.startsWith("de-")) return "de";
        if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
        if (normalized === "en" || normalized.startsWith("en-")) return "en";
    }
    return "en";
}

export function resolveDesktopTheme(preference: DesktopThemePreference, systemUsesDarkColors: boolean): DesktopResolvedTheme {
    return preference === "system" ? (systemUsesDarkColors ? "dark" : "light") : preference;
}

export function createDesktopPresentationSnapshot(
    preferences: DesktopPreferencesV4,
    preferredSystemLanguages: readonly string[],
    systemUsesDarkColors: boolean,
): DesktopPresentationSnapshot {
    return Object.freeze({
        preferences,
        resolvedLocale: resolveDesktopLocale(preferences.language, preferredSystemLanguages),
        resolvedTheme: resolveDesktopTheme(preferences.theme, systemUsesDarkColors),
    });
}

export function parseDesktopPresentationSnapshot(value: unknown): DesktopPresentationSnapshot {
    if (
        !isExactRecord(value, ["preferences", "resolvedLocale", "resolvedTheme"]) ||
        (value.resolvedLocale !== "en" &&
            value.resolvedLocale !== "zh-CN" &&
            value.resolvedLocale !== "de" &&
            value.resolvedLocale !== "ja") ||
        (value.resolvedTheme !== "light" && value.resolvedTheme !== "dark")
    ) {
        throw new TypeError("invalid Desktop presentation snapshot");
    }
    return Object.freeze({
        preferences: parseDesktopPresentationPreferences(value.preferences),
        resolvedLocale: value.resolvedLocale,
        resolvedTheme: value.resolvedTheme,
    });
}
