import type { PlatformContext } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findClaudeCodeAppInstallation } from "../src/claudecode-probe-app-installation";
import { findClaudeLinuxAppInstallation } from "../src/claudecode-probe-linux-app-installation";
import { readClaudeLinuxAppVersion } from "../src/claudecode-probe-linux-app-version";
import { claudeLinuxAsar, seedClaudeLinuxApp, seedClaudeLinuxEngine } from "./claudecode-linux-app-fixture";

let root = "",
    home = "",
    app = "";
let context: PlatformContext;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claude-linux-app-"));
    home = path.join(root, "home");
    app = path.join(root, "app");
    fs.mkdirSync(home);
    context = { platform: "linux", platformInstanceId: "fixture", accessRootPath: root };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const find = () => findClaudeLinuxAppInstallation(context, app);

describe("Claude Linux App installation and separate Code cache", () => {
    it.each([
        "linux",
        "wsl",
    ] as const)("observes the exact %s App without borrowing its cache or outer version as the engine version", async (platform) => {
        seedClaudeLinuxApp(app);
        seedClaudeLinuxEngine(path.join(home, ".config", "Claude", "claude-code"));
        const result = await findClaudeCodeAppInstallation({}, home, { ...context, platform }, app);
        expect(result).toEqual({
            status: "available",
            versionText: "",
            appVersionText: "1.49585.0",
            diagnostics: [],
            evidence: [
                { kind: "app_bundle", path: app, evidenceLevel: "local_artifact", diagnostics: [] },
                { kind: "launcher", path: path.join(app, "claude-desktop"), evidenceLevel: "local_artifact", diagnostics: [] },
            ],
        });
    });
    it("keeps checked absence and unselected installation roots distinct", async () => {
        expect(find()).toMatchObject({ status: "not_found", diagnostics: [{ code: "claudecode_app_linux_not_found" }] });
        expect(findClaudeLinuxAppInstallation(context, path.dirname(root))).toMatchObject({
            status: "unknown",
            diagnostics: [{ code: "claudecode_app_linux_root_outside_selection" }],
        });
    });
    it("confirms the App without requiring a first-run engine cache or inferring its active build", () => {
        seedClaudeLinuxApp(app);
        expect(find()).toMatchObject({ status: "available", versionText: "", appVersionText: "1.49585.0" });
        seedClaudeLinuxEngine(path.join(home, ".config", "Claude", "claude-code"), "2.1.999");
        seedClaudeLinuxEngine(path.join(home, ".config", "Claude-3p", "claude-code"), "2.1.998");
        expect(find()).toMatchObject({
            status: "available",
            versionText: "",
            evidence: [expect.objectContaining({ kind: "app_bundle" }), expect.objectContaining({ kind: "launcher" })],
        });
    });
    it("does not treat a standalone CLI and its version directory as a Claude App installation", () => {
        seedClaudeLinuxEngine(app);
        expect(find()).toMatchObject({ status: "unknown", versionText: "" });
    });
    it("retains permission failure and refuses symlink/wrong-kind App roots", () => {
        seedClaudeLinuxApp(app);
        expect(
            findClaudeLinuxAppInstallation(context, app, {
                readVersion: () => {
                    throw Object.assign(new Error("fixture permission"), { code: "EACCES" });
                },
            }),
        ).toMatchObject({ status: "needs_permission" });
        const alias = path.join(root, "alias");
        fs.symlinkSync(app, alias);
        expect(findClaudeLinuxAppInstallation(context, alias)).toMatchObject({
            status: "unknown",
            diagnostics: [{ code: "claudecode_app_linux_bundle_untrusted" }],
        });
        expect(findClaudeLinuxAppInstallation(context, path.join(app, "claude-desktop"))).toMatchObject({ status: "unknown" });
    });
    it("requires an actual executable ELF App and the branded root ASAR metadata", () => {
        seedClaudeLinuxApp(app);
        fs.chmodSync(path.join(app, "claude-desktop"), 0o644);
        expect(find()).toMatchObject({ status: "unknown", diagnostics: [{ code: "claudecode_app_linux_binary_unverified" }] });
        fs.chmodSync(path.join(app, "claude-desktop"), 0o755);
        const archive = path.join(app, "resources", "app.asar");
        fs.writeFileSync(archive, claudeLinuxAsar({ name: "@other/desktop", productName: "Claude", version: "1.49585.0" }));
        expect(find()).toMatchObject({ status: "unknown", diagnostics: [{ code: "claudecode_app_linux_metadata_unverified" }] });
    });
    it("checks ASAR byte ranges, the package integrity hash and strict numeric version", () => {
        seedClaudeLinuxApp(app);
        const archive = path.join(app, "resources", "app.asar");
        expect(readClaudeLinuxAppVersion(archive)).toBe("1.49585.0");
        const bytes = claudeLinuxAsar();
        bytes[bytes.length - 2] ^= 1;
        fs.writeFileSync(archive, bytes);
        expect(readClaudeLinuxAppVersion(archive)).toBeNull();
        fs.writeFileSync(archive, claudeLinuxAsar({ name: "@ant/desktop", productName: "Claude", version: "not-a-version" }));
        expect(readClaudeLinuxAppVersion(archive)).toBeNull();
        fs.writeFileSync(archive, "invalid");
        expect(readClaudeLinuxAppVersion(archive)).toBeNull();
    });
});
