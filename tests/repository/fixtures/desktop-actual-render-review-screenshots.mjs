import fs from "node:fs";
import path from "node:path";

const REVIEW_SCENARIOS = new Set([
    "asset_library_project_review",
    "asset_library_global_review",
    "asset_library_empty_review",
    "import_sources_review",
    "catalog_search_context_review",
]);

function isPng(bytes) {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export function createReviewScreenshotRecorder(outputRoot, fail) {
    const enabled = outputRoot !== undefined && outputRoot !== "";
    const screenshots = [];
    if (enabled) fs.mkdirSync(outputRoot, { recursive: true });

    return Object.freeze({
        async capture(window, entry) {
            if (!enabled || (!REVIEW_SCENARIOS.has(entry.scenario) && entry.reviewScreenshot !== true)) return;
            await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: entry.windowCssViewport.width - 2,
                y: entry.windowCssViewport.height - 2,
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            const fileName = `${entry.id}.png`;
            const png = (await window.webContents.capturePage()).toPNG();
            if (!isPng(png)) fail(`${entry.id}: captured review artifact is not a PNG`);
            fs.writeFileSync(path.join(outputRoot, fileName), png, { flag: "wx" });
            screenshots.push({
                id: entry.id,
                scenario: entry.scenario,
                locale: entry.locale,
                physicalClass: entry.physicalClass,
                cssViewport: entry.windowCssViewport,
                deviceScaleFactor: entry.deviceScaleFactor,
                theme: entry.theme,
                palette: entry.palette,
                textSize: entry.textSize,
                fileName,
            });
        },
        writeManifest() {
            if (!enabled) return;
            fs.writeFileSync(path.join(outputRoot, "manifest.json"), `${JSON.stringify({ screenshots }, null, 2)}\n`, {
                flag: "wx",
            });
        },
    });
}
