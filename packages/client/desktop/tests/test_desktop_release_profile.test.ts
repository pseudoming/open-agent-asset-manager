import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureDesktopProfile, type DesktopProfileApp, startProfiledDesktop } from "../src/main/desktop-profile";
import { productReleaseIdentity } from "../../../../tests/repository/product-release.mjs";
import { startDesktopRelease } from "../src/main/desktop-release";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function profileFixture(version: string, explicitPath?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-release-profile-"));
    roots.push(root);
    const appData = path.join(root, "config");
    const selected = new Map<string, string>();
    const app: DesktopProfileApp = {
        getPath: () => appData,
        setName: vi.fn(),
        setPath(name, value) {
            expect(fs.statSync(value).isDirectory()).toBe(true);
            selected.set(name, value);
        },
        commandLine: {
            hasSwitch: () => explicitPath !== undefined,
            getSwitchValue: () => explicitPath ?? "",
        },
    };
    return { root, appData, app, selected, release: productReleaseIdentity(version) };
}

describe("Desktop product version and channel profiles", () => {
    it.each([false, true])("starts with the shared product stamp when isPackaged=%s", (isPackaged) => {
        const fixture = profileFixture("0.1.0-beta.1");
        const metadataPath = path.join(fixture.root, "product-release.json");
        fs.writeFileSync(metadataPath, JSON.stringify({ component: "desktop", ...fixture.release }));
        const exit = vi.fn();
        const start = vi.fn();
        const errors = vi.fn();
        startDesktopRelease(
            { ...fixture.app, isPackaged, getVersion: () => (isPackaged ? fixture.release.version : "0.1.0"), exit },
            { acquire: () => true },
            start,
            { metadataPath, writeError: errors },
        );
        expect(start).toHaveBeenCalledWith("0.1.0-beta.1");
        expect(fixture.selected.get("userData")).toBe(path.join(fixture.appData, "OAAM Preview"));
        expect(exit).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
    });

    it.each([
        null,
        [],
        {},
        { component: "headless", version: "0.1.0-beta.1", channel: "beta" },
        { component: "desktop", version: 1, channel: "beta" },
        { component: "desktop", version: "", channel: "beta" },
        { component: "desktop", version: " 0.1.0-beta.1", channel: "beta" },
        { component: "desktop", version: "0.1.0-beta.1", channel: "beta", extra: true },
        { component: "desktop", version: "0.1.0-beta.1" },
        { component: "desktop", version: "0.1.0-beta.1", channel: "unknown" },
    ])("rejects invalid component metadata %j before touching profile data", (metadata) => {
        const fixture = profileFixture("0.1.0-beta.1");
        const metadataPath = path.join(fixture.root, "product-release.json");
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
        const exit = vi.fn();
        const acquire = vi.fn();
        const start = vi.fn();
        startDesktopRelease(
            { ...fixture.app, isPackaged: true, getVersion: () => fixture.release.version, exit },
            { acquire },
            start,
            { metadataPath, writeError: vi.fn() },
        );
        expect(exit).toHaveBeenCalledWith(1);
        expect(acquire).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(fs.existsSync(fixture.appData)).toBe(false);
    });

    it("rejects a package/stamp version mismatch before taking its lock or opening a library", () => {
        const fixture = profileFixture("0.1.0-beta.1");
        const metadataPath = path.join(fixture.root, "product-release.json");
        fs.writeFileSync(metadataPath, JSON.stringify({ component: "desktop", ...fixture.release }));
        const exit = vi.fn();
        const acquire = vi.fn();
        const start = vi.fn();
        const errors = vi.fn();
        startDesktopRelease({ ...fixture.app, isPackaged: true, getVersion: () => "0.1.0", exit }, { acquire }, start, {
            metadataPath,
            writeError: errors,
        });
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("versions do not match"));
        expect(exit).toHaveBeenCalledWith(1);
        expect(acquire).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(fs.existsSync(fixture.appData)).toBe(false);
    });

    it("retains the existing regular library and reopens the same preview library across upgrades", () => {
        const fixture = profileFixture("0.1.0-beta.1");
        const regular = path.join(fixture.appData, "OAAM", "oaam");
        fs.mkdirSync(regular, { recursive: true });
        fs.writeFileSync(path.join(regular, "retained.txt"), "regular library");
        const first = configureDesktopProfile(fixture.app, fixture.release);
        const preview = path.join(fixture.appData, "OAAM Preview");
        expect(first).toBe(preview);
        fs.mkdirSync(path.join(first, "oaam"));
        fs.writeFileSync(path.join(first, "oaam", "retained.txt"), "preview library");

        expect(configureDesktopProfile(fixture.app, productReleaseIdentity("0.2.0-beta.2"))).toBe(first);
        expect(fs.readFileSync(path.join(first, "oaam", "retained.txt"), "utf8")).toBe("preview library");
        expect(fs.readFileSync(path.join(regular, "retained.txt"), "utf8")).toBe("regular library");
        expect(fixture.selected.get("sessionData")).toBe(preview);
        expect(configureDesktopProfile(fixture.app, productReleaseIdentity("0.2.0"))).toBe(path.dirname(regular));
    });

    it("sets both stores before taking the single-instance lock or starting data consumers", () => {
        const fixture = profileFixture("0.1.0-beta.1");
        const expected = path.join(fixture.appData, "OAAM Preview");
        const events: string[] = [];
        const primary = vi.fn(() => {
            expect(fixture.selected.get("userData")).toBe(expected);
            expect(fixture.selected.get("sessionData")).toBe(expected);
            events.push("data consumer");
        });
        startProfiledDesktop(
            fixture.app,
            fixture.release,
            {
                acquire() {
                    expect(fixture.selected.get("userData")).toBe(expected);
                    expect(fixture.selected.get("sessionData")).toBe(expected);
                    events.push("lock");
                    return true;
                },
            },
            primary,
        );
        expect(events).toEqual(["lock", "data consumer"]);
        startProfiledDesktop(fixture.app, fixture.release, { acquire: () => false }, primary);
        expect(primary).toHaveBeenCalledOnce();
    });

    it.each([
        "0.1.0",
        "0.1.0-beta.1",
        "0.1.0-dev.1",
    ])("preserves the explicit isolated profile for %s without creating a default profile", (version) => {
        const fixture = profileFixture(version);
        const isolated = path.join(fixture.root, "selected profile");
        fixture.app.commandLine.hasSwitch = () => true;
        fixture.app.commandLine.getSwitchValue = () => isolated;
        expect(configureDesktopProfile(fixture.app, fixture.release)).toBe(isolated);
        expect(fixture.selected.get("userData")).toBe(isolated);
        expect(fixture.selected.get("sessionData")).toBe(isolated);
        expect(fs.existsSync(fixture.appData)).toBe(false);
    });

    it("refuses development startup without an explicit profile before taking a lock or writing data", () => {
        const fixture = profileFixture("0.1.0-dev.1");
        const acquire = vi.fn();
        const start = vi.fn();
        expect(() => startProfiledDesktop(fixture.app, fixture.release, { acquire }, start)).toThrow(
            /explicit isolated absolute/u,
        );
        expect(acquire).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(fs.existsSync(fixture.appData)).toBe(false);
    });

    it.each([
        "",
        "relative-profile",
        "/profile\0invalid",
    ])("does not fall back to a default library for invalid explicit path %j", (explicit) => {
        const fixture = profileFixture("0.1.0-beta.1", explicit);
        expect(() => configureDesktopProfile(fixture.app, fixture.release)).toThrow(/absolute directory/u);
        expect(fs.existsSync(fixture.appData)).toBe(false);
    });
});
