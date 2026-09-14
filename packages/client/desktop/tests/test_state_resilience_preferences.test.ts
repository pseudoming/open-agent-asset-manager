import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_STATE_RESILIENCE_PREFERENCES,
    DesktopStateResiliencePreferencesStore,
    STATE_RESILIENCE_PREFERENCES_FILE_NAME,
} from "../src/main/state-resilience-preferences-store";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-state-resilience-preferences-"));
    temporaryRoots.push(root);
    return root;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Desktop State resilience preferences", () => {
    it("keeps a missing or malformed preference file non-authoritative and unmodified", () => {
        const root = temporaryRoot();
        const filePath = path.join(root, STATE_RESILIENCE_PREFERENCES_FILE_NAME);
        expect(new DesktopStateResiliencePreferencesStore(root).current).toBe(DEFAULT_STATE_RESILIENCE_PREFERENCES);
        expect(fs.existsSync(filePath)).toBe(false);

        fs.writeFileSync(filePath, "{broken");
        expect(new DesktopStateResiliencePreferencesStore(root).current).toBe(DEFAULT_STATE_RESILIENCE_PREFERENCES);
        expect(fs.readFileSync(filePath, "utf8")).toBe("{broken");

        fs.writeFileSync(filePath, Buffer.from([0xff]));
        expect(new DesktopStateResiliencePreferencesStore(root).current).toBe(DEFAULT_STATE_RESILIENCE_PREFERENCES);

        fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, lastCustomBackupDirectory: "relative" }));
        expect(new DesktopStateResiliencePreferencesStore(root).current).toBe(DEFAULT_STATE_RESILIENCE_PREFERENCES);
    });

    it("loads and durably replaces one canonical absolute custom destination", () => {
        const root = temporaryRoot();
        const filePath = path.join(root, STATE_RESILIENCE_PREFERENCES_FILE_NAME);
        fs.writeFileSync(
            filePath,
            `${JSON.stringify({ schemaVersion: 1, lastCustomBackupDirectory: "/existing/backups" }, null, 4)}\n`,
        );

        const store = new DesktopStateResiliencePreferencesStore(root);
        expect(store.current).toEqual({
            schemaVersion: 1,
            lastCustomBackupDirectory: "/existing/backups",
        });
        const saved = store.rememberCustomBackupDirectory("/new/backups");
        expect(saved).toEqual({ schemaVersion: 1, lastCustomBackupDirectory: "/new/backups" });
        expect(store.current).toBe(saved);
        expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(saved);
        expect(fs.readdirSync(root)).toEqual([STATE_RESILIENCE_PREFERENCES_FILE_NAME]);
    });

    it("rejects non-canonical writes and propagates unexpected filesystem failures", () => {
        const root = temporaryRoot();
        const store = new DesktopStateResiliencePreferencesStore(root);
        expect(() => store.rememberCustomBackupDirectory("relative/backups")).toThrow(/preference path/u);
        expect(() => store.rememberCustomBackupDirectory("/backup/../backups")).toThrow(/preference path/u);
        expect(fs.readdirSync(root)).toEqual([]);

        const fileRoot = path.join(root, "not-a-directory");
        fs.writeFileSync(fileRoot, "file");
        expect(() => new DesktopStateResiliencePreferencesStore(fileRoot)).toThrow();

        const invalidFileRoot = path.join(root, "invalid-file-root");
        fs.mkdirSync(invalidFileRoot);
        fs.mkdirSync(path.join(invalidFileRoot, STATE_RESILIENCE_PREFERENCES_FILE_NAME));
        expect(() => new DesktopStateResiliencePreferencesStore(invalidFileRoot)).toThrow();
    });
});
