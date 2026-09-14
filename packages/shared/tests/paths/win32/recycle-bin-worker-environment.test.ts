import { describe, expect, it } from "vitest";
import { projectWin32RecycleWorkerEnvironment } from "../../../src/paths/win32/recycle-bin-worker-client";

const BASE_ENVIRONMENT = Object.freeze({
    SystemRoot: String.raw`C:\WINDOWS`,
    WINDIR: String.raw`C:\WINDOWS`,
    TEMP: String.raw`C:\OAAM\Temp`,
    TMP: String.raw`C:\OAAM\Temp`,
    LOCALAPPDATA: String.raw`C:\OAAM\Local`,
    USERPROFILE: String.raw`C:\OAAM\Profile`,
});

describe("Win32 Recycle Bin worker environment", () => {
    it("derives the exact SystemDrive required by the Windows Shell worker", () => {
        expect(projectWin32RecycleWorkerEnvironment(BASE_ENVIRONMENT, false)).toEqual([
            { name: "SystemRoot", value: String.raw`C:\WINDOWS` },
            { name: "WINDIR", value: String.raw`C:\WINDOWS` },
            { name: "TEMP", value: String.raw`C:\OAAM\Temp` },
            { name: "TMP", value: String.raw`C:\OAAM\Temp` },
            { name: "LOCALAPPDATA", value: String.raw`C:\OAAM\Local` },
            { name: "USERPROFILE", value: String.raw`C:\OAAM\Profile` },
            { name: "SystemDrive", value: "C:" },
        ]);
    });

    it("accepts a matching observed drive and adds Electron Node mode exactly once", () => {
        expect(
            projectWin32RecycleWorkerEnvironment({ ...BASE_ENVIRONMENT, SystemDrive: "c:" }, true).filter(
                ({ name }) => name === "SystemDrive" || name === "ELECTRON_RUN_AS_NODE",
            ),
        ).toEqual([
            { name: "SystemDrive", value: "C:" },
            { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        ]);
    });

    it("accepts the canonical uppercase alias without losing SystemRoot from the child", () => {
        const { SystemRoot: _systemRoot, ...withoutCanonicalName } = BASE_ENVIRONMENT;
        expect(
            projectWin32RecycleWorkerEnvironment(
                { ...withoutCanonicalName, SYSTEMROOT: String.raw`C:\WINDOWS`, SYSTEMDRIVE: "C:" },
                false,
            ),
        ).toContainEqual({ name: "SystemRoot", value: String.raw`C:\WINDOWS` });
    });

    it.each([
        ["missing SystemRoot", {}],
        ["relative SystemRoot", { SystemRoot: "Windows" }],
        ["non-canonical SystemRoot", { SystemRoot: String.raw`C:\Windows\..\Windows` }],
        ["foreign Windows directory", { SystemRoot: String.raw`C:\System` }],
        ["UNC SystemRoot", { SystemRoot: String.raw`\\server\share\Windows` }],
        ["conflicting SystemRoot alias", { SystemRoot: String.raw`C:\Windows`, SYSTEMROOT: String.raw`D:\Windows` }],
        ["conflicting WINDIR", { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`D:\Windows` }],
        ["conflicting SystemDrive", { SystemRoot: String.raw`C:\Windows`, SystemDrive: "D:" }],
        ["literal SystemDrive", { SystemRoot: String.raw`C:\Windows`, SystemDrive: "%SystemDrive%" }],
        ["conflicting SystemDrive alias", { SystemRoot: String.raw`C:\Windows`, SystemDrive: "C:", SYSTEMDRIVE: "D:" }],
    ])("fails closed for %s", (_name, environment) => {
        expect(() => projectWin32RecycleWorkerEnvironment(environment, false)).toThrow(TypeError);
    });
});
