import { readProviderRegularFileRangeNoFollow } from "@oaam/adapter-framework";
import type { PlatformContext } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCodexAppInstallation } from "../src/codex-probe-installation";
import { findCodexLinuxAppInstallation } from "../src/codex-probe-linux-app-installation";

let sandbox = "";
let appRoot = "";
let context: PlatformContext;
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
const METADATA = { codexAppBrand: "chatgpt", codexBuildFlavor: "prod", version: "26.803.81509" };

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-linux-app-"));
    appRoot = path.join(sandbox, "chatgpt");
    context = { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox };
});
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function seedBundle(): void {
    fs.mkdirSync(path.join(appRoot, "resources"), { recursive: true });
    fs.writeFileSync(path.join(appRoot, "resources/linux-package-metadata.json"), JSON.stringify(METADATA));
    fs.writeFileSync(path.join(appRoot, "ChatGPT"), ELF, { mode: 0o755 });
    fs.writeFileSync(path.join(appRoot, "resources/codex"), ELF, { mode: 0o755 });
    fs.writeFileSync(path.join(appRoot, "codex-launcher"), '#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/ChatGPT" "$@"\n', {
        mode: 0o755,
    });
}

describe("native Linux ChatGPT/Codex App installation", () => {
    it.each(["linux", "wsl"] as const)("observes the App-owned engine in the exact selected %s bundle", (platform) => {
        seedBundle();
        const result = findCodexAppInstallation({}, sandbox, { ...context, platform }, appRoot);
        expect(result).toEqual({
            status: "available",
            evidence: [
                { kind: "app_bundle", path: appRoot, evidenceLevel: "local_artifact", diagnostics: [] },
                {
                    kind: "executable",
                    path: path.join(appRoot, "resources/codex"),
                    evidenceLevel: "local_artifact",
                    diagnostics: [],
                },
            ],
            diagnostics: [],
            versionText: "",
        });
    });

    it("distinguishes checked absence and a default root outside the selected boundary", () => {
        expect(findCodexLinuxAppInstallation(context, appRoot).status).toBe("not_found");
        expect(findCodexLinuxAppInstallation(context)).toMatchObject({
            status: "unknown",
            diagnostics: [{ code: "codex_app_linux_root_outside_selection" }],
        });
        expect(findCodexLinuxAppInstallation(context, "relative").status).toBe("unknown");
    });

    it("does not use a standalone CLI or an incomplete App directory as App evidence", () => {
        fs.mkdirSync(appRoot);
        fs.writeFileSync(path.join(appRoot, "codex"), ELF, { mode: 0o755 });
        expect(findCodexLinuxAppInstallation(context, appRoot)).toMatchObject({
            status: "unknown",
            evidence: [],
            diagnostics: [{ code: "codex_app_linux_bundle_incomplete" }],
        });
    });

    it.each([
        null,
        [],
        {},
        { ...METADATA, codexAppBrand: "other" },
        { ...METADATA, version: "" },
    ])("rejects unverified package metadata %#", (metadata) => {
        seedBundle();
        fs.writeFileSync(path.join(appRoot, "resources/linux-package-metadata.json"), JSON.stringify(metadata));
        expect(findCodexLinuxAppInstallation(context, appRoot)).toMatchObject({
            status: "unknown",
            diagnostics: [{ code: "codex_app_linux_metadata_unverified" }],
        });
    });

    it.each(["{broken", " ".repeat(65_537)])("rejects malformed or oversized metadata %#", (content) => {
        seedBundle();
        fs.writeFileSync(path.join(appRoot, "resources/linux-package-metadata.json"), content);
        expect(findCodexLinuxAppInstallation(context, appRoot).status).toBe("unknown");
    });

    it("accepts additional package metadata and ignores unexecuted launcher text while checking the native engine", () => {
        seedBundle();
        fs.writeFileSync(path.join(appRoot, "codex-launcher"), "#!/bin/sh\n# a future launcher implementation\n");
        fs.writeFileSync(
            path.join(appRoot, "resources/linux-package-metadata.json"),
            JSON.stringify({
                ...METADATA,
                codexBuildFlavor: "preview",
                packageRevision: 2,
            }),
        );
        expect(findCodexLinuxAppInstallation(context, appRoot).status).toBe("available");
        fs.writeFileSync(path.join(appRoot, "resources/codex"), "#!/bin/sh\n");
        expect(findCodexLinuxAppInstallation(context, appRoot)).toMatchObject({
            status: "unknown",
            diagnostics: [{ code: "codex_app_linux_binary_unverified" }],
        });
    });

    it.each(["ChatGPT", "resources/codex"])("rejects %s without Unix executable permission", (relativePath) => {
        seedBundle();
        fs.chmodSync(path.join(appRoot, relativePath), 0o644);
        expect(findCodexLinuxAppInstallation(context, appRoot)).toMatchObject({
            status: "unknown",
            diagnostics: [{ code: "codex_app_linux_binary_unverified" }],
        });
    });

    it("retains permission failure and refuses symlink or wrong-kind bundle roots", () => {
        seedBundle();
        expect(
            findCodexLinuxAppInstallation(context, appRoot, {
                readFile() {
                    throw Object.assign(new Error("fixture permission"), { code: "EACCES" });
                },
            }).status,
        ).toBe("needs_permission");
        const link = path.join(sandbox, "linked-app");
        fs.symlinkSync(appRoot, link, "junction");
        expect(findCodexLinuxAppInstallation(context, link).status).toBe("unknown");
        expect(findCodexLinuxAppInstallation(context, path.join(appRoot, "ChatGPT")).status).toBe("unknown");
    });

    it("refuses a bundled engine replaced between its paired physical observations", () => {
        seedBundle();
        let changed = false;
        const engine = path.join(appRoot, "resources/codex");
        const result = findCodexLinuxAppInstallation(context, appRoot, {
            readRange(filePath, offset, maximumBytes) {
                const read = readProviderRegularFileRangeNoFollow(filePath, offset, maximumBytes);
                if (filePath === engine && !changed) {
                    changed = true;
                    fs.renameSync(engine, `${engine}.previous`);
                    fs.writeFileSync(engine, ELF, { mode: 0o755 });
                }
                return read;
            },
        });
        expect(result).toMatchObject({ status: "unknown", diagnostics: [{ code: "codex_app_linux_binary_unverified" }] });
    });

    it("refuses package metadata changed while the App binaries are observed", () => {
        seedBundle();
        let changed = false;
        const result = findCodexLinuxAppInstallation(context, appRoot, {
            readRange(filePath, offset, maximumBytes) {
                if (!changed) {
                    changed = true;
                    fs.writeFileSync(
                        path.join(appRoot, "resources/linux-package-metadata.json"),
                        JSON.stringify({ ...METADATA, version: "26.804.1" }),
                    );
                }
                return readProviderRegularFileRangeNoFollow(filePath, offset, maximumBytes);
            },
        });
        expect(result).toMatchObject({ status: "unknown", diagnostics: [{ code: "codex_app_linux_bundle_changed" }] });
    });
});
