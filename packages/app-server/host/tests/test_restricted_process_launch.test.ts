import { describe, expect, it } from "vitest";
import { requireRestrictedWslExecutable } from "../src/restricted-process-launch";
import { resolveRestrictedProcessWorkerPath } from "../src/restricted-process-client";

describe("restricted Windows system executable admission", () => {
    it("uses the physical unpacked Host worker while preserving native Node entries", () => {
        const packed = "C:\\OAAM\\resources\\app.asar\\node_modules\\@oaam\\app-server-host\\dist\\restricted-process-worker.js";
        expect(resolveRestrictedProcessWorkerPath("win32", packed)).toBe(packed.replace("app.asar", "app.asar.unpacked"));
        const native = "/installed/host/dist/restricted-process-worker.js";
        expect(resolveRestrictedProcessWorkerPath("linux", native)).toBe(native);
    });
    it("accepts observed uppercase Windows environment and returns its derived system path", () => {
        expect(
            requireRestrictedWslExecutable("C:\\Windows\\System32\\wsl.exe", {
                SystemRoot: "C:\\WINDOWS",
                WINDIR: "C:\\WINDOWS",
            }),
        ).toBe("C:\\WINDOWS\\System32\\wsl.exe");
    });

    it("resolves Windows environment names case insensitively inside a Worker", () => {
        expect(
            requireRestrictedWslExecutable("d:\\WINDOWS\\system32\\WSL.EXE", {
                systemroot: "D:\\Windows",
                windir: "d:\\windows",
            }),
        ).toBe("D:\\Windows\\System32\\wsl.exe");
    });

    it.each([
        "wsl.exe",
        "C:Windows\\System32\\wsl.exe",
        "C:\\Users\\user\\wsl.exe",
        "D:\\Windows\\System32\\wsl.exe",
        "C:\\Windows\\System32\\cmd.exe",
        "\\\\server\\Windows\\System32\\wsl.exe",
        "\\\\?\\C:\\Windows\\System32\\wsl.exe",
        "C:\\Windows\\System32\\wsl.exe\0",
    ])("rejects a candidate outside the derived system executable: %s", (candidate) => {
        expect(() => requireRestrictedWslExecutable(candidate, { SystemRoot: "C:\\Windows" })).toThrow(
            "untrusted WSL executable path",
        );
    });

    it.each([
        {},
        { SystemRoot: "Windows" },
        { SystemRoot: "C:\\Users\\user\\Windows" },
        { SystemRoot: "\\\\server\\Windows" },
        { SystemRoot: "C:\\Windows", WINDIR: "D:\\Windows" },
        { SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\another" },
    ])("rejects absent, ambiguous or noncanonical system directories: %j", (environment) => {
        expect(() => requireRestrictedWslExecutable("C:\\Windows\\System32\\wsl.exe", environment)).toThrow();
    });
});
