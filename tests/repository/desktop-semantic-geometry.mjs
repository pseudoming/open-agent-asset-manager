import fs from "node:fs";
import path from "node:path";

const STROKE_ROLES = Object.freeze(["control", "data_group", "focus", "safety", "separator"]);

function finiteNonNegative(value) {
    return Number.isFinite(value) && value >= 0;
}

function validateRect(rect, label, errors) {
    if (
        rect === undefined ||
        !finiteNonNegative(rect.x) ||
        !finiteNonNegative(rect.y) ||
        !finiteNonNegative(rect.width) ||
        !finiteNonNegative(rect.height)
    ) {
        errors.push(`${label}: invalid rectangle`);
    }
}

function contains(outer, inner) {
    return (
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height
    );
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
    return Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd);
}

function normalizeCss(value) {
    return value.trim().replace(/\s+/gu, " ");
}

function cssRuleDeclarations(source, selector) {
    const expected = normalizeCss(selector);
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        if (normalizeCss(match[1]) !== expected) continue;
        return Object.fromEntries(
            [...match[2].matchAll(/(?:^|\n)\s*([a-z-]+)\s*:\s*([^;]+);/gu)].map((declaration) => [
                declaration[1],
                normalizeCss(declaration[2]),
            ]),
        );
    }
    return undefined;
}

function requireDeclaration(source, selector, property, expected, errors) {
    const declarations = cssRuleDeclarations(source, selector);
    if (declarations === undefined) {
        errors.push(`${selector}: missing production CSS rule`);
        return;
    }
    const actual = declarations[property];
    if (typeof expected === "string" ? actual !== expected : !expected(actual)) {
        errors.push(`${selector}: ${property} ${JSON.stringify(actual)} does not satisfy the reviewed geometry contract`);
    }
}

function count(source, token) {
    return source.split(token).length - 1;
}

export function validateDesktopProductionGeometrySources(sources) {
    const errors = [];
    for (const [source, selector] of [
        [sources.projectCss, ".project-library-shell"],
        [sources.stylesCss, ".settings-workbench-shell"],
    ]) {
        requireDeclaration(source, selector, "height", "100%", errors);
        requireDeclaration(source, selector, "min-height", "0", errors);
        requireDeclaration(
            source,
            selector,
            "grid-template-columns",
            (value) =>
                typeof value === "string" &&
                value.includes("var(--oaam-left-pane-width") &&
                value.includes("1px") &&
                value.includes("minmax(0, 1fr)"),
            errors,
        );
    }
    for (const [source, selector] of [
        [sources.projectCss, ".library-workbench"],
        [sources.stylesCss, ".settings-workbench"],
    ]) {
        requireDeclaration(
            source,
            selector,
            "border-radius",
            (value) => typeof value === "string" && value !== "0" && value !== "0px",
            errors,
        );
        requireDeclaration(source, selector, "overflow", "hidden", errors);
    }
    requireDeclaration(
        sources.projectCss,
        ".library-sidebar-scroll, .library-main-scroll, .asset-inspector-scroll",
        "min-height",
        "0",
        errors,
    );
    requireDeclaration(
        sources.projectCss,
        ".library-sidebar-scroll, .library-main-scroll, .asset-inspector-scroll",
        "overflow-x",
        "hidden",
        errors,
    );
    requireDeclaration(
        sources.projectCss,
        ".library-sidebar-scroll, .library-main-scroll, .asset-inspector-scroll",
        "overflow-y",
        "auto",
        errors,
    );
    requireDeclaration(sources.stylesCss, ".settings-scroll", "min-height", "0", errors);
    requireDeclaration(sources.stylesCss, ".settings-scroll", "overflow-x", "hidden", errors);
    requireDeclaration(sources.stylesCss, ".settings-scroll", "overflow-y", "auto", errors);
    requireDeclaration(sources.primitivesCss, "[hidden]", "display", "none", errors);
    requireDeclaration(sources.projectCss, ".library-toolbar", "display", "flex", errors);
    requireDeclaration(sources.projectCss, ".library-toolbar", "align-items", "center", errors);
    requireDeclaration(sources.projectCss, ".library-toolbar-actions", "display", "flex", errors);
    requireDeclaration(sources.projectCss, ".library-toolbar-actions", "align-items", "center", errors);
    requireDeclaration(sources.primitivesCss, ".workbench-resize-separator", "cursor", "col-resize", errors);
    requireDeclaration(sources.primitivesCss, ".workbench-resize-separator", "width", "9px", errors);
    requireDeclaration(sources.primitivesCss, ".workbench-resize-separator", "min-width", "9px", errors);
    requireDeclaration(sources.primitivesCss, ".workbench-resize-separator", "touch-action", "none", errors);
    requireDeclaration(
        sources.stylesCss,
        ".workbench-file-inspector > .workbench-resize-separator",
        "width",
        (value) => Number.parseInt(value, 10) >= 8,
        errors,
    );
    requireDeclaration(
        sources.stylesCss,
        ".workbench-file-inspector > .workbench-resize-separator",
        "inset",
        "0 auto 0 0",
        errors,
    );
    requireDeclaration(sources.primitivesCss, ".workbench-resize-separator::before", "inset", "0 auto 0 4px", errors);
    requireDeclaration(sources.primitivesCss, ".workbench-resize-separator::before", "width", "1px", errors);

    if (!sources.projectTsx.includes('data-oaam-route="library"')) {
        errors.push("ProjectLibraryWorkspace: missing production route identity");
    }
    if (count(sources.projectTsx, "<WorkbenchResizeSeparator") !== 2) {
        errors.push("ProjectLibraryWorkspace: expected exact left and inspector resize separators");
    }
    for (const variable of ["--oaam-left-pane-width", "--oaam-right-pane-width"]) {
        if (!sources.projectTsx.includes(`"${variable}"`)) {
            errors.push(`ProjectLibraryWorkspace: missing ${variable} production geometry binding`);
        }
    }
    if (!sources.settingsTsx.includes('data-oaam-route="settings"')) {
        errors.push("SettingsPage: missing ordinary Settings route identity");
    }
    if (count(sources.settingsTsx, "<WorkbenchResizeSeparator") !== 1) {
        errors.push("SettingsPage: expected exact Settings sidebar resize separator");
    }
    if (count(sources.settingsTsx, "data-oaam-settings-scroll-owner=") !== 2) {
        errors.push("SettingsPage: expected recovery and ordinary scroll owners");
    }
    if (count(sources.settingsTsx, "data-oaam-settings-scroll-sentinel=") !== 2) {
        errors.push("SettingsPage: expected recovery and ordinary final scroll sentinels");
    }

    if (errors.length > 0) throw new Error(`Desktop production geometry contract failed:\n${errors.join("\n")}`);
    return Object.freeze({
        workbenchCount: 2,
        resizeSeparatorCount: 3,
        scrollOwnerCount: 2,
    });
}

export function inspectDesktopProductionGeometry(repositoryRoot) {
    const rendererRoot = path.join(repositoryRoot, "packages/client/desktop/src/renderer");
    return validateDesktopProductionGeometrySources({
        projectCss: fs.readFileSync(path.join(rendererRoot, "project-library.css"), "utf8"),
        stylesCss: fs.readFileSync(path.join(rendererRoot, "styles.css"), "utf8"),
        primitivesCss: fs.readFileSync(path.join(rendererRoot, "ui/primitives.css"), "utf8"),
        projectTsx: fs.readFileSync(path.join(rendererRoot, "features/project-library/ProjectLibraryWorkspace.tsx"), "utf8"),
        settingsTsx: fs.readFileSync(path.join(rendererRoot, "pages/SettingsPage.tsx"), "utf8"),
    });
}

export function validateDesktopSemanticGeometry(snapshot) {
    const errors = [];
    validateRect(snapshot.viewport, `${snapshot.id}: viewport`, errors);
    validateRect(snapshot.workspace?.rect, `${snapshot.id}: workspace`, errors);
    if (snapshot.workspace?.cornerRadius <= 0 || snapshot.workspace?.clips !== true) {
        errors.push(`${snapshot.id}: workspace must expose a positive reviewed corner radius and clipping`);
    }
    if (snapshot.workspace?.rect !== undefined && !contains(snapshot.viewport, snapshot.workspace.rect)) {
        errors.push(`${snapshot.id}: workspace escapes the CSS viewport`);
    }

    const panes = new Map();
    for (const pane of snapshot.panes ?? []) {
        validateRect(pane.rect, `${snapshot.id}: pane ${pane.id}`, errors);
        if (panes.has(pane.id)) errors.push(`${snapshot.id}: duplicate pane ${pane.id}`);
        panes.set(pane.id, pane.rect);
        if (pane.rect !== undefined && !contains(snapshot.viewport, pane.rect)) {
            errors.push(`${snapshot.id}: pane ${pane.id} escapes the CSS viewport`);
        }
    }
    for (const control of snapshot.controls ?? []) {
        validateRect(control.rect, `${snapshot.id}: control ${control.id}`, errors);
        const pane = panes.get(control.paneId);
        if (pane === undefined) errors.push(`${snapshot.id}: control ${control.id} refers to missing pane ${control.paneId}`);
        else if (control.rect !== undefined && !contains(pane, control.rect)) {
            errors.push(`${snapshot.id}: control ${control.id} escapes pane ${control.paneId}`);
        }
    }
    for (const scroll of snapshot.scrollOwners ?? []) {
        if (
            !finiteNonNegative(scroll.clientHeight) ||
            !finiteNonNegative(scroll.scrollHeight) ||
            !finiteNonNegative(scroll.sentinelTop) ||
            !finiteNonNegative(scroll.sentinelHeight) ||
            scroll.clientHeight === 0 ||
            scroll.scrollHeight < scroll.clientHeight
        ) {
            errors.push(`${snapshot.id}: scroll owner ${scroll.id} has invalid dimensions`);
            continue;
        }
        const sentinelBottom = scroll.sentinelTop + scroll.sentinelHeight;
        const maximumScrollTop = scroll.scrollHeight - scroll.clientHeight;
        if (
            sentinelBottom > scroll.scrollHeight ||
            sentinelBottom <= maximumScrollTop ||
            scroll.sentinelTop >= maximumScrollTop + scroll.clientHeight
        ) {
            errors.push(`${snapshot.id}: scroll sentinel ${scroll.id} is unreachable at the maximum scroll position`);
        }
    }
    for (const separator of snapshot.separators ?? []) {
        if (
            separator.orientation !== "vertical" ||
            separator.ariaOrientation !== "vertical" ||
            separator.cursor !== "col-resize" ||
            separator.hitTargetWidth < 8 ||
            separator.minimum > separator.value ||
            separator.value > separator.maximum
        ) {
            errors.push(`${snapshot.id}: separator ${separator.id} does not expose the reviewed resize contract`);
        }
    }
    const strokes = snapshot.strokes ?? [];
    for (const stroke of strokes) {
        if (!STROKE_ROLES.includes(stroke.role)) errors.push(`${snapshot.id}: stroke ${stroke.id} has unclassified role`);
        if (
            !["horizontal", "vertical"].includes(stroke.axis) ||
            !Number.isFinite(stroke.coordinate) ||
            !finiteNonNegative(stroke.start) ||
            !finiteNonNegative(stroke.end) ||
            stroke.end <= stroke.start
        ) {
            errors.push(`${snapshot.id}: stroke ${stroke.id} has invalid geometry`);
        }
    }
    for (let leftIndex = 0; leftIndex < strokes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < strokes.length; rightIndex += 1) {
            const left = strokes[leftIndex];
            const right = strokes[rightIndex];
            if (
                left.role === "separator" &&
                right.role === "separator" &&
                left.axis === right.axis &&
                Math.abs(left.coordinate - right.coordinate) <= 1 &&
                rangesOverlap(left.start, left.end, right.start, right.end)
            ) {
                errors.push(`${snapshot.id}: adjacent double separator strokes ${left.id} and ${right.id}`);
            }
        }
    }
    if (errors.length > 0) throw new Error(`Desktop semantic geometry failed:\n${errors.join("\n")}`);
    return Object.freeze({
        paneCount: panes.size,
        controlCount: snapshot.controls?.length ?? 0,
        scrollOwnerCount: snapshot.scrollOwners?.length ?? 0,
        separatorCount: snapshot.separators?.length ?? 0,
        strokeCount: strokes.length,
    });
}

export function createReviewedDesktopGeometrySnapshot(matrixEntry) {
    const viewport = Object.freeze({
        x: 0,
        y: 0,
        width: matrixEntry.windowCssViewport.width,
        height: matrixEntry.windowCssViewport.height,
    });
    const titlebarHeight = 38;
    const compact = viewport.width <= 900;
    const leftWidth = compact ? 0 : Math.min(288, Math.floor(viewport.width * 0.24));
    const inspectorWidth =
        !compact && matrixEntry.seededData && viewport.width >= 1280 ? Math.min(360, viewport.width * 0.25) : 0;
    const workspace = Object.freeze({
        x: leftWidth,
        y: titlebarHeight,
        width: viewport.width - leftWidth,
        height: viewport.height - titlebarHeight,
    });
    const mainWidth = workspace.width - inspectorWidth;
    const panes = [
        ...(leftWidth === 0
            ? []
            : [
                  Object.freeze({
                      id: "left",
                      rect: Object.freeze({ x: 0, y: titlebarHeight, width: leftWidth, height: workspace.height }),
                  }),
              ]),
        Object.freeze({
            id: "main",
            rect: Object.freeze({ x: workspace.x, y: workspace.y, width: mainWidth, height: workspace.height }),
        }),
        ...(inspectorWidth === 0
            ? []
            : [
                  Object.freeze({
                      id: "inspector",
                      rect: Object.freeze({
                          x: workspace.x + mainWidth,
                          y: workspace.y,
                          width: inspectorWidth,
                          height: workspace.height,
                      }),
                  }),
              ]),
    ];
    const controls = [
        Object.freeze({
            id: "toolbar-actions",
            paneId: "main",
            rect: Object.freeze({ x: workspace.x + 16, y: workspace.y + 12, width: Math.min(240, mainWidth - 32), height: 32 }),
        }),
    ];
    const separators = [
        ...(leftWidth === 0
            ? []
            : [
                  Object.freeze({
                      id: "left-resize",
                      orientation: "vertical",
                      ariaOrientation: "vertical",
                      cursor: "col-resize",
                      hitTargetWidth: 10,
                      minimum: 224,
                      value: leftWidth,
                      maximum: 420,
                  }),
              ]),
        ...(inspectorWidth === 0
            ? []
            : [
                  Object.freeze({
                      id: "inspector-resize",
                      orientation: "vertical",
                      ariaOrientation: "vertical",
                      cursor: "col-resize",
                      hitTargetWidth: 10,
                      minimum: 280,
                      value: inspectorWidth,
                      maximum: 520,
                  }),
              ]),
    ];
    const strokes = [
        ...(leftWidth === 0
            ? []
            : [
                  Object.freeze({
                      id: "left-main",
                      role: "separator",
                      axis: "vertical",
                      coordinate: leftWidth,
                      start: titlebarHeight,
                      end: viewport.height,
                  }),
              ]),
        ...(inspectorWidth === 0
            ? []
            : [
                  Object.freeze({
                      id: "main-inspector",
                      role: "separator",
                      axis: "vertical",
                      coordinate: workspace.x + mainWidth,
                      start: titlebarHeight,
                      end: viewport.height,
                  }),
              ]),
    ];
    return Object.freeze({
        id: matrixEntry.id,
        viewport,
        workspace: Object.freeze({ rect: workspace, cornerRadius: 10, clips: true }),
        panes: Object.freeze(panes),
        controls: Object.freeze(controls),
        scrollOwners: Object.freeze([
            Object.freeze({
                id: "main-scroll",
                clientHeight: workspace.height - 64,
                scrollHeight: workspace.height + 320,
                sentinelTop: workspace.height + 304,
                sentinelHeight: 16,
            }),
        ]),
        separators: Object.freeze(separators),
        strokes: Object.freeze(strokes),
    });
}

export function validateDesktopHostActionAvailability(snapshot) {
    const blockedStates = new Set(["starting", "reconnecting", "failed", "client_unavailable"]);
    if (!blockedStates.has(snapshot.hostState)) return Object.freeze({ blockedActionCount: 0 });
    const staleActions = (snapshot.actions ?? []).filter(
        (action) => action.requiresFreshHost === true && action.enabled === true,
    );
    if (staleActions.length > 0) {
        throw new Error(
            `Desktop Host-loss conformance failed: stale actions remain enabled: ${staleActions
                .map((action) => action.id)
                .join(", ")}`,
        );
    }
    return Object.freeze({
        blockedActionCount: (snapshot.actions ?? []).filter((action) => action.requiresFreshHost === true).length,
    });
}
