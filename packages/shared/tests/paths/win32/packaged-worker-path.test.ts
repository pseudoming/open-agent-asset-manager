import { describe, expect, it } from "vitest";
import { resolveWin32PackagedWorkerPath } from "../../../src/paths/win32/packaged-worker-path";

describe("Win32 packaged worker path", () => {
    it("maps one exact Electron archive boundary to the physical unpacked worker", () => {
        expect(
            resolveWin32PackagedWorkerPath(
                "C:\\OAAM\\resources\\app.asar\\node_modules\\@oaam\\shared\\dist\\paths\\win32\\worker.js",
            ),
        ).toBe("C:\\OAAM\\resources\\app.asar.unpacked\\node_modules\\@oaam\\shared\\dist\\paths\\win32\\worker.js");
        expect(
            resolveWin32PackagedWorkerPath(
                "C:\\OAAM\\resources\\APP.ASAR\\node_modules\\@oaam\\shared\\dist\\paths\\win32\\worker.js",
            ),
        ).toBe("C:\\OAAM\\resources\\app.asar.unpacked\\node_modules\\@oaam\\shared\\dist\\paths\\win32\\worker.js");
    });

    it("preserves one canonical non-archive path and rejects ambiguous or non-canonical input", () => {
        expect(resolveWin32PackagedWorkerPath("C:\\OAAM\\worker.js")).toBe("C:\\OAAM\\worker.js");
        for (const candidate of [
            "worker.js",
            "C:\\OAAM\\folder\\..\\worker.js",
            "C:\\OAAM\\app.asar\\nested\\app.asar\\worker.js",
            `C:\\OAAM\\${"x".repeat(32_768)}`,
            "C:\\OAAM\\bad\0worker.js",
        ]) {
            expect(() => resolveWin32PackagedWorkerPath(candidate)).toThrow(TypeError);
        }
    });
});
