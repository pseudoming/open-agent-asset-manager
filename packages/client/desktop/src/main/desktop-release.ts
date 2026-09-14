import fs from "node:fs";
import path from "node:path";
import { type DesktopProfileApp, type DesktopReleaseIdentity, startProfiledDesktop } from "./desktop-profile";

interface DesktopReleaseApp extends DesktopProfileApp {
    readonly isPackaged: boolean;
    getVersion(): string;
    exit(code: number): void;
}

export function startDesktopRelease(
    app: DesktopReleaseApp,
    singleInstance: { acquire(): boolean },
    startPrimary: (productVersion: string) => void,
    options: { readonly metadataPath?: string; readonly writeError?: (message: string) => void } = {},
): void {
    try {
        const metadata: unknown = JSON.parse(
            fs.readFileSync(options.metadataPath ?? path.join(__dirname, "../product-release.json"), "utf8"),
        );
        if (
            typeof metadata !== "object" ||
            metadata === null ||
            Array.isArray(metadata) ||
            Object.keys(metadata).sort().join(",") !== "channel,component,version" ||
            !("component" in metadata) ||
            metadata.component !== "desktop" ||
            !("version" in metadata) ||
            typeof metadata.version !== "string" ||
            metadata.version.length === 0 ||
            metadata.version.trim() !== metadata.version ||
            !("channel" in metadata) ||
            (metadata.channel !== "dev" && metadata.channel !== "beta" && metadata.channel !== "stable")
        )
            throw new Error("OAAM Desktop product release metadata is invalid; rebuild the client");
        const release: DesktopReleaseIdentity = { version: metadata.version, channel: metadata.channel };
        if (app.isPackaged && app.getVersion() !== release.version) {
            throw new Error("OAAM packaged application and product release versions do not match");
        }
        startProfiledDesktop(app, release, singleInstance, () => startPrimary(release.version));
    } catch (error) {
        (options.writeError ?? ((message) => process.stderr.write(message)))(
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
        app.exit(1);
    }
}
