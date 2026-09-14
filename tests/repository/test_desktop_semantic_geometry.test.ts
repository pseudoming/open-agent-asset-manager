import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_VISUAL_MATRIX } from "./desktop-visual-matrix.mjs";
import {
    createReviewedDesktopGeometrySnapshot,
    inspectDesktopProductionGeometry,
    validateDesktopHostActionAvailability,
    validateDesktopProductionGeometrySources,
    validateDesktopSemanticGeometry,
} from "./desktop-semantic-geometry.mjs";

function baseSnapshot() {
    return {
        id: "fixture",
        viewport: { x: 0, y: 0, width: 1000, height: 700 },
        workspace: { rect: { x: 200, y: 40, width: 800, height: 660 }, cornerRadius: 10, clips: true },
        panes: [
            { id: "left", rect: { x: 0, y: 40, width: 200, height: 660 } },
            { id: "main", rect: { x: 200, y: 40, width: 800, height: 660 } },
        ],
        controls: [{ id: "action", paneId: "main", rect: { x: 220, y: 60, width: 120, height: 32 } }],
        scrollOwners: [{ id: "main-scroll", clientHeight: 500, scrollHeight: 900, sentinelTop: 884, sentinelHeight: 16 }],
        separators: [
            {
                id: "left-resize",
                orientation: "vertical",
                ariaOrientation: "vertical",
                cursor: "col-resize",
                hitTargetWidth: 10,
                minimum: 180,
                value: 200,
                maximum: 420,
            },
        ],
        strokes: [{ id: "left-main", role: "separator", axis: "vertical", coordinate: 200, start: 40, end: 700 }],
    };
}

describe("Desktop semantic geometry", () => {
    it("binds the reviewed geometry to production DOM and CSS instead of validating only a hand-built snapshot", () => {
        expect(inspectDesktopProductionGeometry(process.cwd())).toEqual({
            workbenchCount: 2,
            resizeSeparatorCount: 3,
            scrollOwnerCount: 2,
        });
    });

    it("validates every reviewed physical-display and scale case without treating the matrix as installed proof", () => {
        for (const matrixEntry of DESKTOP_VISUAL_MATRIX) {
            expect(validateDesktopSemanticGeometry(createReviewedDesktopGeometrySnapshot(matrixEntry))).toMatchObject({
                controlCount: 1,
                scrollOwnerCount: 1,
            });
        }
    });

    it("rejects a control outside its pane and an unreachable final scroll sentinel", () => {
        const escaped = baseSnapshot();
        escaped.controls = [{ id: "action", paneId: "main", rect: { x: 980, y: 60, width: 80, height: 32 } }];
        expect(() => validateDesktopSemanticGeometry(escaped)).toThrow(/control action escapes pane main/u);

        const unreachable = baseSnapshot();
        unreachable.scrollOwners = [
            { id: "main-scroll", clientHeight: 500, scrollHeight: 900, sentinelTop: 300, sentinelHeight: 16 },
        ];
        expect(() => validateDesktopSemanticGeometry(unreachable)).toThrow(/scroll sentinel main-scroll is unreachable/u);
    });

    it("rejects an unclassified outline, adjacent double separators, and an inaccessible resize handle", () => {
        const unclassified = baseSnapshot();
        unclassified.strokes = [{ id: "mystery", role: "structural", axis: "horizontal", coordinate: 40, start: 0, end: 1000 }];
        expect(() => validateDesktopSemanticGeometry(unclassified)).toThrow(/unclassified role/u);

        const doubled = baseSnapshot();
        doubled.strokes = [
            ...doubled.strokes,
            { id: "left-main-copy", role: "separator", axis: "vertical", coordinate: 201, start: 40, end: 700 },
        ];
        expect(() => validateDesktopSemanticGeometry(doubled)).toThrow(/adjacent double separator/u);

        const inaccessible = baseSnapshot();
        inaccessible.separators = [{ ...inaccessible.separators[0], hitTargetWidth: 4, cursor: "default" }];
        expect(() => validateDesktopSemanticGeometry(inaccessible)).toThrow(/reviewed resize contract/u);
    });

    it("rejects stale business actions during Host loss instead of accepting a ready-only fixture", () => {
        expect(
            validateDesktopHostActionAvailability({
                hostState: "reconnecting",
                actions: [
                    { id: "deploy", requiresFreshHost: true, enabled: false },
                    { id: "open-diagnostics", requiresFreshHost: false, enabled: true },
                ],
            }),
        ).toEqual({ blockedActionCount: 1 });
        expect(() =>
            validateDesktopHostActionAvailability({
                hostState: "failed",
                actions: [{ id: "deploy", requiresFreshHost: true, enabled: true }],
            }),
        ).toThrow(/stale actions remain enabled: deploy/u);
    });

    it("rejects production CSS or DOM that drops clipping, scrolling, or a resize separator", () => {
        const rendererRoot = path.join(process.cwd(), "packages/client/desktop/src/renderer");
        const sources = {
            projectCss: fs.readFileSync(path.join(rendererRoot, "project-library.css"), "utf8"),
            stylesCss: fs.readFileSync(path.join(rendererRoot, "styles.css"), "utf8"),
            primitivesCss: fs.readFileSync(path.join(rendererRoot, "ui/primitives.css"), "utf8"),
            projectTsx: fs.readFileSync(path.join(rendererRoot, "features/project-library/ProjectLibraryWorkspace.tsx"), "utf8"),
            settingsTsx: fs.readFileSync(path.join(rendererRoot, "pages/SettingsPage.tsx"), "utf8"),
        };
        expect(() =>
            validateDesktopProductionGeometrySources({
                ...sources,
                projectCss: sources.projectCss.replace("overflow: hidden;", "overflow: visible;"),
            }),
        ).toThrow(/overflow/u);
        expect(() =>
            validateDesktopProductionGeometrySources({
                ...sources,
                stylesCss: sources.stylesCss.replace(".settings-scroll {", ".removed-settings-scroll {"),
            }),
        ).toThrow(/settings-scroll.*missing production CSS rule/u);
        expect(() =>
            validateDesktopProductionGeometrySources({
                ...sources,
                projectTsx: sources.projectTsx.replace("<WorkbenchResizeSeparator", "<RemovedResizeSeparator"),
            }),
        ).toThrow(/exact left and inspector resize separators/u);
        expect(() =>
            validateDesktopProductionGeometrySources({
                ...sources,
                primitivesCss: sources.primitivesCss.replace("width: 9px;", "width: 1px;"),
            }),
        ).toThrow(/workbench-resize-separator.*width/u);
        expect(() =>
            validateDesktopProductionGeometrySources({
                ...sources,
                primitivesCss: sources.primitivesCss.replace("[hidden] {", "[data-removed-hidden] {"),
            }),
        ).toThrow(/\[hidden\].*missing production CSS rule/u);
    });
});
