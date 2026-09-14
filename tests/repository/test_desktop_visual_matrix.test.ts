import { describe, expect, it } from "vitest";
import { DESKTOP_VISUAL_MATRIX, validateDesktopVisualMatrix } from "./desktop-visual-matrix.mjs";

describe("Desktop visual proof matrix", () => {
    it("keeps physical display, device scale and effective CSS viewport as separate evidence", () => {
        expect(validateDesktopVisualMatrix()).toMatchObject({ cases: 8 });
        expect(DESKTOP_VISUAL_MATRIX).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    physicalClass: "minimum",
                    deviceScaleFactor: 1.25,
                    windowCssViewport: { width: 860, height: 560 },
                }),
                expect.objectContaining({
                    physicalClass: "2k",
                    displayPhysical: { width: 2560, height: 1440 },
                }),
                expect.objectContaining({
                    physicalClass: "4k",
                    displayPhysical: { width: 3840, height: 2160 },
                }),
            ]),
        );
    });

    it("rejects a matrix that silently drops a required display or scale class", () => {
        expect(() => validateDesktopVisualMatrix(DESKTOP_VISUAL_MATRIX.filter((entry) => entry.physicalClass !== "2k"))).toThrow(
            /physical class coverage/u,
        );
        expect(() => validateDesktopVisualMatrix(DESKTOP_VISUAL_MATRIX.filter((entry) => entry.deviceScaleFactor !== 2))).toThrow(
            /device scale coverage/u,
        );
    });
});
