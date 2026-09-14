import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopWindowOptions } from "../src/main/window-security";
import {
    applyDesktopWindowPlacement,
    DESKTOP_WINDOW_STATE_FILE_NAME,
    DesktopWindowStateStore,
    parseDesktopWindowState,
    resolveDesktopWindowState,
    restoreDesktopWindowDefaults,
} from "../src/main/window-state-store";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-window-state-"));
    temporaryRoots.push(root);
    return root;
}

describe("Desktop disposable window state", () => {
    it("accepts only strict default or saved state", () => {
        expect(parseDesktopWindowState({ schemaVersion: 1, state: "default" })).toEqual({
            schemaVersion: 1,
            state: "default",
        });
        expect(parseDesktopWindowState({ schemaVersion: 2, state: "default" })).toEqual({
            schemaVersion: 2,
            state: "default",
        });
        const saved = {
            schemaVersion: 1 as const,
            state: "saved" as const,
            bounds: { x: -100, y: 20, width: 1180, height: 760 },
            maximized: true,
        };
        expect(parseDesktopWindowState(saved)).toEqual(saved);
        for (const invalid of [
            null,
            { schemaVersion: 3, state: "default" },
            { ...saved, bounds: { ...saved.bounds, width: 100 } },
            { ...saved, maximized: "yes" },
            { ...saved, extra: true },
        ]) {
            expect(() => parseDesktopWindowState(invalid)).toThrow(TypeError);
        }
    });

    it("uses saved placement only when a meaningful part remains on a current display", () => {
        const state = parseDesktopWindowState({
            schemaVersion: 1,
            state: "saved",
            bounds: { x: 100, y: 100, width: 1180, height: 760 },
            maximized: false,
        });
        expect(resolveDesktopWindowState(state, [{ x: 0, y: 0, width: 1920, height: 1080 }])).toEqual(state);
        expect(resolveDesktopWindowState(state, [{ x: 5000, y: 0, width: 1920, height: 1080 }])).toEqual({
            schemaVersion: 2,
            state: "default",
        });
        expect(resolveDesktopWindowState({ schemaVersion: 1, state: "default" }, [])).toEqual({
            schemaVersion: 2,
            state: "default",
        });
    });

    it("persists one strict state file and replaces it with the default branch", () => {
        const root = temporaryRoot();
        const store = new DesktopWindowStateStore(root);
        expect(store.current).toEqual({ schemaVersion: 2, state: "default" });
        expect(
            store.capture({
                getNormalBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
                getBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
                getContentSize: () => [1190, 780],
                isMaximized: () => true,
            }),
        ).toEqual({
            schemaVersion: 2,
            state: "saved",
            bounds: { x: 10, y: 20, width: 1190, height: 780 },
            maximized: true,
        });
        expect(new DesktopWindowStateStore(root).current).toEqual(store.current);
        expect(store.restoreDefaults()).toEqual({ schemaVersion: 2, state: "default" });
        expect(JSON.parse(fs.readFileSync(path.join(root, DESKTOP_WINDOW_STATE_FILE_NAME), "utf8"))).toEqual({
            schemaVersion: 2,
            state: "default",
        });
    });

    it("falls back from corrupt disposable state but rejects a symlinked state file", () => {
        const root = temporaryRoot();
        fs.writeFileSync(path.join(root, DESKTOP_WINDOW_STATE_FILE_NAME), "{");
        expect(new DesktopWindowStateStore(root).current).toEqual({ schemaVersion: 2, state: "default" });
        fs.rmSync(path.join(root, DESKTOP_WINDOW_STATE_FILE_NAME));
        const outside = path.join(temporaryRoot(), "outside.json");
        fs.writeFileSync(outside, '{"schemaVersion":1,"state":"default"}');
        fs.symlinkSync(outside, path.join(root, DESKTOP_WINDOW_STATE_FILE_NAME));
        expect(() => new DesktopWindowStateStore(root)).toThrow();
    });

    it("restores defaults and migrates outer bounds before applying current content-area placement", () => {
        const unmaximize = vi.fn();
        const setContentSize = vi.fn();
        const center = vi.fn();
        restoreDesktopWindowDefaults({ isMaximized: () => true, unmaximize, setContentSize, center });
        expect(unmaximize).toHaveBeenCalledOnce();
        expect(setContentSize).toHaveBeenCalledWith(1180, 760);
        expect(center).toHaveBeenCalledOnce();
        restoreDesktopWindowDefaults({
            isMaximized: () => false,
            unmaximize,
            setContentSize,
            center,
        });
        expect(unmaximize).toHaveBeenCalledOnce();

        const legacyState = parseDesktopWindowState({
            schemaVersion: 1,
            state: "saved",
            bounds: { x: 10, y: 20, width: 1300, height: 900 },
            maximized: true,
        });
        const setBounds = vi.fn();
        const setPosition = vi.fn();
        const setContentSizeForPlacement = vi.fn();
        const placementTarget = { setBounds, setPosition, setContentSize: setContentSizeForPlacement };
        applyDesktopWindowPlacement(placementTarget, legacyState);
        expect(setBounds).toHaveBeenCalledWith(legacyState.state === "saved" ? legacyState.bounds : undefined);
        const currentState = parseDesktopWindowState({
            schemaVersion: 2,
            state: "saved",
            bounds: { x: 30, y: 40, width: 1280, height: 820 },
            maximized: false,
        });
        applyDesktopWindowPlacement(placementTarget, currentState);
        expect(setPosition).toHaveBeenCalledWith(30, 40);
        expect(setContentSizeForPlacement).toHaveBeenCalledWith(1280, 820);
        applyDesktopWindowPlacement(placementTarget, { schemaVersion: 2, state: "default" });
        expect(setBounds).toHaveBeenCalledOnce();

        const options = createDesktopWindowOptions("/preload.js", "dark", "win32");
        expect(options).toMatchObject({
            width: 1180,
            height: 760,
            minWidth: 860,
            minHeight: 560,
            useContentSize: true,
        });
        expect(options).not.toHaveProperty("x");
        expect(options).not.toHaveProperty("y");
    });
});
