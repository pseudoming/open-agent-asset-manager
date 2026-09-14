const SUPPORTED_DEVICE_SCALE_FACTORS = Object.freeze([1, 1.25, 1.5, 2]);
const REQUIRED_PHYSICAL_CLASSES = Object.freeze(["minimum", "1080p", "2k", "4k"]);
const REQUIRED_LOCALES = Object.freeze(["en", "zh-CN", "de", "ja"]);
const REQUIRED_THEMES = Object.freeze(["light", "dark"]);
const REQUIRED_TEXT_SIZES = Object.freeze(["small", "default", "large"]);
const REQUIRED_PALETTES = Object.freeze(["warm", "neutral", "cool"]);

export const DESKTOP_VISUAL_MATRIX = Object.freeze([
    Object.freeze({
        id: "minimum-de-light-large-neutral-125",
        physicalClass: "minimum",
        displayPhysical: Object.freeze({ width: 1920, height: 1080 }),
        deviceScaleFactor: 1.25,
        windowCssViewport: Object.freeze({ width: 860, height: 560 }),
        locale: "de",
        theme: "light",
        textSize: "large",
        palette: "neutral",
        seededData: false,
    }),
    Object.freeze({
        id: "1080p-en-dark-default-warm-100",
        physicalClass: "1080p",
        displayPhysical: Object.freeze({ width: 1920, height: 1080 }),
        deviceScaleFactor: 1,
        windowCssViewport: Object.freeze({ width: 1920, height: 1080 }),
        locale: "en",
        theme: "dark",
        textSize: "default",
        palette: "warm",
        seededData: true,
    }),
    Object.freeze({
        id: "1080p-zh-light-small-cool-150",
        physicalClass: "1080p",
        displayPhysical: Object.freeze({ width: 1920, height: 1080 }),
        deviceScaleFactor: 1.5,
        windowCssViewport: Object.freeze({ width: 1280, height: 720 }),
        locale: "zh-CN",
        theme: "light",
        textSize: "small",
        palette: "cool",
        seededData: true,
    }),
    Object.freeze({
        id: "2k-ja-dark-large-warm-125",
        physicalClass: "2k",
        displayPhysical: Object.freeze({ width: 2560, height: 1440 }),
        deviceScaleFactor: 1.25,
        windowCssViewport: Object.freeze({ width: 2048, height: 1152 }),
        locale: "ja",
        theme: "dark",
        textSize: "large",
        palette: "warm",
        seededData: true,
    }),
    Object.freeze({
        id: "2k-de-light-default-cool-200",
        physicalClass: "2k",
        displayPhysical: Object.freeze({ width: 2560, height: 1440 }),
        deviceScaleFactor: 2,
        windowCssViewport: Object.freeze({ width: 1280, height: 720 }),
        locale: "de",
        theme: "light",
        textSize: "default",
        palette: "cool",
        seededData: false,
    }),
    Object.freeze({
        id: "4k-en-light-large-neutral-150",
        physicalClass: "4k",
        displayPhysical: Object.freeze({ width: 3840, height: 2160 }),
        deviceScaleFactor: 1.5,
        windowCssViewport: Object.freeze({ width: 2560, height: 1440 }),
        locale: "en",
        theme: "light",
        textSize: "large",
        palette: "neutral",
        seededData: true,
    }),
    Object.freeze({
        id: "4k-zh-dark-small-warm-200",
        physicalClass: "4k",
        displayPhysical: Object.freeze({ width: 3840, height: 2160 }),
        deviceScaleFactor: 2,
        windowCssViewport: Object.freeze({ width: 1920, height: 1080 }),
        locale: "zh-CN",
        theme: "dark",
        textSize: "small",
        palette: "warm",
        seededData: false,
    }),
    Object.freeze({
        id: "4k-ja-dark-default-cool-100",
        physicalClass: "4k",
        displayPhysical: Object.freeze({ width: 3840, height: 2160 }),
        deviceScaleFactor: 1,
        windowCssViewport: Object.freeze({ width: 3840, height: 2160 }),
        locale: "ja",
        theme: "dark",
        textSize: "default",
        palette: "cool",
        seededData: true,
    }),
]);

function assertExactCoverage(actual, expected, label) {
    const actualValues = [...new Set(actual)].sort();
    const expectedValues = [...expected].sort();
    if (actualValues.length !== expectedValues.length || actualValues.some((value, index) => value !== expectedValues[index])) {
        throw new Error(`${label} coverage ${JSON.stringify(actualValues)} does not equal ${JSON.stringify(expectedValues)}`);
    }
}

export function validateDesktopVisualMatrix(matrix = DESKTOP_VISUAL_MATRIX) {
    const ids = new Set();
    for (const entry of matrix) {
        if (ids.has(entry.id)) throw new Error(`duplicate Desktop visual matrix id ${entry.id}`);
        ids.add(entry.id);
        if (!SUPPORTED_DEVICE_SCALE_FACTORS.includes(entry.deviceScaleFactor)) {
            throw new Error(`unsupported Desktop visual matrix scale ${entry.deviceScaleFactor}`);
        }
        if (
            !Number.isInteger(entry.displayPhysical.width) ||
            !Number.isInteger(entry.displayPhysical.height) ||
            !Number.isInteger(entry.windowCssViewport.width) ||
            !Number.isInteger(entry.windowCssViewport.height) ||
            entry.windowCssViewport.width < 860 ||
            entry.windowCssViewport.height < 560
        ) {
            throw new Error(`invalid Desktop visual matrix dimensions for ${entry.id}`);
        }
    }
    assertExactCoverage(
        matrix.map((entry) => entry.physicalClass),
        REQUIRED_PHYSICAL_CLASSES,
        "physical class",
    );
    assertExactCoverage(
        matrix.map((entry) => entry.deviceScaleFactor),
        SUPPORTED_DEVICE_SCALE_FACTORS,
        "device scale",
    );
    assertExactCoverage(
        matrix.map((entry) => entry.locale),
        REQUIRED_LOCALES,
        "locale",
    );
    assertExactCoverage(
        matrix.map((entry) => entry.theme),
        REQUIRED_THEMES,
        "theme",
    );
    assertExactCoverage(
        matrix.map((entry) => entry.textSize),
        REQUIRED_TEXT_SIZES,
        "text size",
    );
    assertExactCoverage(
        matrix.map((entry) => entry.palette),
        REQUIRED_PALETTES,
        "palette",
    );
    if (!matrix.some((entry) => entry.seededData) || !matrix.some((entry) => !entry.seededData)) {
        throw new Error("Desktop visual matrix must cover both seeded and empty data");
    }
    return Object.freeze({
        cases: matrix.length,
        ids: Object.freeze([...ids]),
    });
}
