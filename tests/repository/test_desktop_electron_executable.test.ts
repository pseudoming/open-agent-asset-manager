import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDesktopElectronExecutable } from "./desktop-electron-executable.mjs";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-electron-resolution-"));
    roots.push(root);
    const electron = path.join(root, "node_modules/electron");
    fs.mkdirSync(electron, { recursive: true });
    fs.writeFileSync(path.join(electron, "package.json"), '{"name":"electron","main":"index.cjs"}\n');
    fs.mkdirSync(path.join(root, "packages/client/desktop"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/client/desktop/package.json"), '{"name":"fixture-desktop"}\n');
    return { root, electron };
}

describe("Desktop Electron executable preparation", () => {
    it("resolves a hoisted package and prepares a missing deferred executable before returning it", () => {
        const { root, electron } = fixture();
        const spawn = vi.fn(() => {
            fs.mkdirSync(path.join(electron, "dist"));
            fs.writeFileSync(path.join(electron, "dist/electron"), "synthetic executable");
            fs.writeFileSync(path.join(electron, "path.txt"), "electron");
            return { status: 0 };
        });
        expect(resolveDesktopElectronExecutable(root, { spawn })).toBe(path.join(electron, "dist/electron"));
        expect(spawn).toHaveBeenCalledOnce();
        expect(spawn.mock.calls[0]).toEqual([
            process.execPath,
            ["-e", "require(process.argv[1]);", electron],
            expect.objectContaining({ timeout: 120_000 }),
        ]);
        expect(resolveDesktopElectronExecutable(root, { spawn })).toBe(path.join(electron, "dist/electron"));
        expect(spawn).toHaveBeenCalledOnce();
    });

    it("rejects nominal preparation success when the executable is still absent", () => {
        const { root } = fixture();
        expect(() => resolveDesktopElectronExecutable(root, { spawn: () => ({ status: 0 }) })).toThrow(/without producing/u);
    });

    it("rejects a path file that escapes the Electron distribution", () => {
        const { root, electron } = fixture();
        fs.writeFileSync(path.join(electron, "path.txt"), "../../foreign");
        const spawn = vi.fn();
        expect(() => resolveDesktopElectronExecutable(root, { spawn })).toThrow(/unsafe executable-relative path/u);
        expect(spawn).not.toHaveBeenCalled();
    });
});
