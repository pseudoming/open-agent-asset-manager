import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Electron can defer its binary download until its package entry is first required. */
export function resolveDesktopElectronExecutable(repositoryRoot, options = {}) {
    const desktopPackage = path.join(repositoryRoot, "packages/client/desktop/package.json");
    const require = createRequire(desktopPackage);
    const electronRoot = path.dirname(require.resolve("electron/package.json"));
    const pathFile = path.join(electronRoot, "path.txt");
    const installed = () => {
        if (!fs.existsSync(pathFile)) return null;
        const relative = fs.readFileSync(pathFile, "utf8").trim();
        if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
            throw new Error("Electron returned an unsafe executable-relative path");
        }
        const executable = path.join(electronRoot, "dist", relative);
        return fs.existsSync(executable) && fs.statSync(executable).isFile() ? executable : null;
    };
    const existing = installed();
    if (existing) return existing;
    const result = (options.spawn ?? spawnSync)(process.execPath, ["-e", "require(process.argv[1]);", electronRoot], {
        cwd: path.dirname(desktopPackage),
        env: options.env ?? process.env,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Electron binary preparation failed: ${result.error?.message ?? result.stderr}`);
    }
    const executable = installed();
    if (!executable) throw new Error("Electron preparation succeeded without producing the declared executable");
    return executable;
}
