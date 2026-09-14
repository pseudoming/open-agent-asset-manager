import fs from "node:fs";
import path from "node:path";
export interface DesktopReleaseIdentity {
    readonly version: string;
    readonly channel: "dev" | "beta" | "stable";
}

export interface DesktopProfileApp {
    getPath(name: "appData"): string;
    setName(name: string): void;
    setPath(name: "userData" | "sessionData", value: string): void;
    readonly commandLine: {
        hasSwitch(name: string): boolean;
        getSwitchValue(name: string): string;
    };
}

export function configureDesktopProfile(app: DesktopProfileApp, release: DesktopReleaseIdentity): string {
    const productName = release.channel === "stable" ? "OAAM" : release.channel === "beta" ? "OAAM Preview" : "OAAM Development";
    const explicit = app.commandLine.hasSwitch("user-data-dir");
    if (!explicit && release.channel === "dev") {
        throw new Error("OAAM development builds require --user-data-dir with an explicit isolated absolute directory");
    }
    const userData = explicit ? app.commandLine.getSwitchValue("user-data-dir") : path.join(app.getPath("appData"), productName);
    if (userData.includes("\0") || !path.isAbsolute(userData)) {
        throw new Error("OAAM --user-data-dir must name an absolute directory");
    }
    fs.mkdirSync(userData, { recursive: true });
    app.setName(productName);
    app.setPath("userData", userData);
    app.setPath("sessionData", userData);
    return userData;
}

export function startProfiledDesktop(
    app: DesktopProfileApp,
    release: DesktopReleaseIdentity,
    singleInstance: { acquire(): boolean },
    startPrimary: () => void,
): void {
    configureDesktopProfile(app, release);
    if (singleInstance.acquire()) startPrimary();
}
