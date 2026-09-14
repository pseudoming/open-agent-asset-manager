import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const DESKTOP_ELECTRON_LOCALES = Object.freeze(["de", "en-US", "ja", "zh-CN"]);

function directTree(root) {
    const stat = fs.lstatSync(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `package content must be a direct directory: ${root}`);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()), `unexpected package entry: ${entry.name}`);
        if (entry.isDirectory()) directTree(path.join(root, entry.name));
    }
}

/** Native compilation is complete; only remove its known inputs from the packager-owned copy. */
export function removePackagedSqliteBuildInputs(buildPath) {
    const sqliteRoot = path.join(buildPath, "node_modules", "better-sqlite3");
    directTree(sqliteRoot);
    const nativeFile = path.join(sqliteRoot, "build", "Release", "better_sqlite3.node");
    assert.ok(fs.lstatSync(nativeFile).isFile(), "Electron-ABI SQLite binary must exist before pruning build inputs");
    const removed = [];
    for (const relativePath of ["src", "deps", "binding.gyp"]) {
        const candidate = path.join(sqliteRoot, relativePath);
        if (!fs.existsSync(candidate)) continue;
        fs.rmSync(candidate, { recursive: true, force: false });
        removed.push(relativePath);
    }
    return Object.freeze(removed);
}

/** Chromium UI resources follow the four shipped Desktop languages, with en-US as fallback. */
export function removeUnusedDesktopLocales(electronRoot, platform) {
    if (platform !== "win32") return Object.freeze([]);
    const localeRoot = path.join(electronRoot, "locales");
    directTree(localeRoot);
    const retained = new Set(DESKTOP_ELECTRON_LOCALES.map((locale) => `${locale}.pak`));
    for (const name of retained)
        assert.ok(fs.lstatSync(path.join(localeRoot, name)).isFile(), `required locale missing: ${name}`);
    const removed = [];
    for (const entry of fs.readdirSync(localeRoot, { withFileTypes: true })) {
        assert.ok(entry.isFile() && /^[A-Za-z0-9-]+\.pak$/u.test(entry.name), `unexpected locale entry: ${entry.name}`);
        if (retained.has(entry.name)) continue;
        fs.rmSync(path.join(localeRoot, entry.name));
        removed.push(entry.name);
    }
    return Object.freeze(removed);
}
