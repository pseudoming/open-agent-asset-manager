import fs from "node:fs";
import path from "node:path";

function sourceFiles(root) {
    const files = [];
    function visit(directory) {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(target);
            else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(target);
        }
    }
    visit(root);
    return files.sort();
}

function styleFiles(root) {
    const files = [];
    function visit(directory) {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(target);
            else if (entry.isFile() && entry.name.endsWith(".css")) files.push(target);
        }
    }
    visit(root);
    return files.sort();
}

function relative(root, filePath) {
    return path.relative(root, filePath).split(path.sep).join("/");
}

function countOccurrences(source, token) {
    return source.split(token).length - 1;
}

const REVIEWED_FEATURE_CONTROL_BASELINE = Object.freeze({
    "aria-pressed=": Object.freeze({
        "packages/client/desktop/src/renderer/features/asset-content-preview/AssetFilePreview.tsx": 2,
        "packages/client/desktop/src/renderer/features/catalog-deployment/CatalogAssetUsageRelationships.tsx": 1,
        "packages/client/desktop/src/renderer/features/catalog-deployment/CatalogAssetVersionInspector.tsx": 3,
        "packages/client/desktop/src/renderer/features/catalog-deployment/CatalogDeploymentFileInspector.tsx": 2,
        "packages/client/desktop/src/renderer/features/catalog-deployment/CatalogDeploymentInspectionReview.tsx": 1,
        "packages/client/desktop/src/renderer/features/import-review/ImportPreviewInspector.tsx": 3,
        "packages/client/desktop/src/renderer/features/import-review/ImportReviewWorkspace.tsx": 1,
        "packages/client/desktop/src/renderer/features/project-library/AssetInspector.tsx": 4,
        "packages/client/desktop/src/renderer/features/project-library/ProjectLibraryWorkspace.tsx": 4,
        "packages/client/desktop/src/renderer/shell/DesktopWindowFrame.tsx": 1,
    }),
});

const REVIEWED_LEGACY_RAW_COLOR_BASELINE = Object.freeze({
    "packages/client/desktop/src/renderer/asset-lifecycle.css": 2,
    "packages/client/desktop/src/renderer/diagnostics.css": 1,
    "packages/client/desktop/src/renderer/project-library.css": 2,
});

const REVIEWED_LEGACY_BOOLEAN_STYLE_BASELINE = Object.freeze({
    "packages/client/desktop/src/renderer/project-library.css": 2,
    "packages/client/desktop/src/renderer/styles.css": 3,
});

const FEATURE_NATIVE_CONTROL_PATTERNS = Object.freeze([
    Object.freeze({
        label: "native boolean control",
        pattern: /type\s*=\s*(?:["'](?:checkbox|radio)["']|\{\s*["'](?:checkbox|radio)["']\s*\})/u,
    }),
    Object.freeze({ label: "native select", pattern: /<select(?:\s|>)/u }),
]);

const RAW_DIAGNOSTIC_FLATTENING_PATTERNS = Object.freeze([
    Object.freeze({
        label: "first diagnostic message",
        pattern: /diagnostics\s*(?:\[\s*0\s*\]|\.at\(\s*0\s*\))\s*\?\.\s*message/u,
    }),
    Object.freeze({
        label: "mapped diagnostic message",
        pattern: /diagnostics[^\n;]*\.(?:map|find)\([^\n;]*\.message/u,
    }),
    Object.freeze({
        label: "raw diagnostic message",
        pattern: /\bdiagnostic\.message\b/u,
    }),
]);

export function inspectDesktopUiConformance(repositoryRoot) {
    const rendererRoot = path.join(repositoryRoot, "packages/client/desktop/src/renderer");
    const iconRegistry = "packages/client/desktop/src/renderer/ui/icons.tsx";
    const primitiveRegistry = "packages/client/desktop/src/renderer/ui/WorkbenchPrimitives.tsx";
    const diagnosticProjection = "packages/client/desktop/src/renderer/presentation/protocol-diagnostics.ts";
    const errors = [];

    for (const filePath of sourceFiles(rendererRoot)) {
        const source = fs.readFileSync(filePath, "utf8");
        const file = relative(repositoryRoot, filePath);
        if (file !== diagnosticProjection) {
            for (const flattening of RAW_DIAGNOSTIC_FLATTENING_PATTERNS) {
                if (flattening.pattern.test(source)) {
                    errors.push(`${file}: ${flattening.label} bypasses the structured Protocol diagnostic presentation boundary`);
                }
            }
        }
        if (source.includes('from "lucide-react"') && file !== iconRegistry) {
            errors.push(`${file}: feature code imports lucide-react outside the OAAM icon registry`);
        }
        if (/<svg(?:\s|>)/u.test(source) && file !== iconRegistry && !file.includes("/illustrations/")) {
            errors.push(`${file}: unreviewed raw SVG bypasses the OAAM icon or illustration boundary`);
        }
        if (
            file !== primitiveRegistry &&
            (source.includes('role="listbox"') || source.includes('role="option"') || source.includes('aria-haspopup="listbox"'))
        ) {
            errors.push(`${file}: feature-local listbox bypasses the OAAM Select/Listbox primitive`);
        }
        if (
            file !== primitiveRegistry &&
            (/\brole\s*=\s*(?:["']dialog["']|\{\s*["']dialog["']\s*\})/u.test(source) || /\baria-modal\s*=/u.test(source))
        ) {
            errors.push(`${file}: feature-local dialog bypasses the OAAM Dialog primitive`);
        }
        if (file !== primitiveRegistry) {
            for (const actionClass of source.matchAll(/className="([^"]*(?:primary|danger)[^"]*)"/gu)) {
                const tagStart = source.lastIndexOf("<", actionClass.index);
                const buttonPrefix = tagStart < 0 ? "" : source.slice(tagStart, actionClass.index);
                if (!buttonPrefix.startsWith("<button")) continue;
                if (!buttonPrefix.includes("data-oaam-journey-action=")) {
                    errors.push(
                        `${file}: primary or dangerous action ${JSON.stringify(actionClass[1])} lacks journey classification`,
                    );
                }
            }
            for (const control of FEATURE_NATIVE_CONTROL_PATTERNS) {
                if (control.pattern.test(source)) {
                    errors.push(`${file}: feature-local ${control.label} bypasses the OAAM semantic-control primitives`);
                }
            }
            for (const [token, baseline] of Object.entries(REVIEWED_FEATURE_CONTROL_BASELINE)) {
                const expected = baseline[file] ?? 0;
                const actual = countOccurrences(source, token);
                if (actual !== expected) {
                    errors.push(
                        `${file}: ${JSON.stringify(token)} count ${actual} does not match the reviewed feature-control baseline ${expected}`,
                    );
                }
            }
        }
    }

    const reviewedStyleAuthorities = new Set([
        "packages/client/desktop/src/renderer/ui/primitives.css",
        "packages/client/desktop/src/renderer/ui/tokens.css",
    ]);
    for (const filePath of styleFiles(rendererRoot)) {
        const source = fs.readFileSync(filePath, "utf8");
        const file = relative(repositoryRoot, filePath);
        if (reviewedStyleAuthorities.has(file)) continue;
        const actual = source.match(/#[0-9a-f]{3,8}\b|(?:rgb|hsl|color-mix)\(/giu)?.length ?? 0;
        const expected = REVIEWED_LEGACY_RAW_COLOR_BASELINE[file] ?? 0;
        if (actual !== expected) {
            errors.push(`${file}: raw color count ${actual} does not match the reviewed legacy-style baseline ${expected}`);
        }
        const booleanStyleActual =
            source.match(/input\[type="(?:checkbox|radio)"\]|\[aria-(?:pressed|checked|selected)=/gu)?.length ?? 0;
        const booleanStyleExpected = REVIEWED_LEGACY_BOOLEAN_STYLE_BASELINE[file] ?? 0;
        if (booleanStyleActual !== booleanStyleExpected) {
            errors.push(
                `${file}: boolean-state selector count ${booleanStyleActual} does not match the reviewed legacy-style baseline ${booleanStyleExpected}`,
            );
        }
    }

    for (const file of [
        "packages/client/desktop/src/bridge/desktop-bridge.ts",
        "packages/client/desktop/src/main/index.ts",
        "packages/client/desktop/src/main/window-actions.ts",
        "packages/client/desktop/src/preload/index.ts",
    ]) {
        const filePath = path.join(repositoryRoot, file);
        if (!fs.existsSync(filePath)) continue;
        const source = fs.readFileSync(filePath, "utf8");
        if (source.includes("show_about")) {
            errors.push(`${file}: informational About escaped the renderer-owned dialog boundary`);
        }
    }

    const mainSourcePath = path.join(repositoryRoot, "packages/client/desktop/src/main/index.ts");
    if (fs.existsSync(mainSourcePath)) {
        const mainSource = fs.readFileSync(mainSourcePath, "utf8");
        if (
            mainSource.includes("dialog.showMessageBox") &&
            (mainSource.includes("window.about.title") || mainSource.includes("window.about.detail"))
        ) {
            errors.push("packages/client/desktop/src/main/index.ts: native informational About message box is not reviewed");
        }
    }

    if (errors.length > 0) throw new Error(`Desktop UI conformance failed:\n${errors.join("\n")}`);
    return Object.freeze({
        rendererSourceCount: sourceFiles(rendererRoot).length,
        diagnosticProjection,
        iconRegistry,
        primitiveRegistry,
    });
}
