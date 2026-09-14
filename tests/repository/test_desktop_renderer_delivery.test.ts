import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_RENDERER_CHUNK_LIMIT_BYTES, inspectDesktopRendererDelivery } from "./desktop-renderer-delivery.mjs";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-renderer-delivery-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "assets"));
    fs.writeFileSync(
        path.join(root, "index.html"),
        '<!doctype html><script type="module" crossorigin src="./assets/index-abc.js"></script>',
    );
    for (const fileName of [
        "index-abc.js",
        "OnboardingPage-abc.js",
        "SettingsPage-abc.js",
        "WorkspacePage-abc.js",
        "locale-de-abc.js",
        "locale-ja-abc.js",
        "locale-zh-cn-abc.js",
        "ui-icons-abc.js",
    ]) {
        fs.writeFileSync(path.join(root, "assets", fileName), `export const value = ${JSON.stringify(fileName)};\n`);
    }
    return root;
}

describe("Desktop renderer delivery gate", () => {
    it("accepts one bounded entry, natural lazy pages and explicit complete-locale chunks", () => {
        expect(inspectDesktopRendererDelivery(fixture())).toMatchObject({
            entryRelativePath: "assets/index-abc.js",
            javascriptChunkCount: 8,
            sourceMapCount: 0,
        });
    });

    it("rejects source maps, missing lazy pages and oversized chunks", () => {
        const sourceMapRoot = fixture();
        fs.writeFileSync(path.join(sourceMapRoot, "assets", "index-abc.js.map"), "{}");
        expect(() => inspectDesktopRendererDelivery(sourceMapRoot)).toThrow(/contains source maps/u);

        const missingPageRoot = fixture();
        fs.rmSync(path.join(missingPageRoot, "assets", "SettingsPage-abc.js"));
        expect(() => inspectDesktopRendererDelivery(missingPageRoot)).toThrow(/SettingsPage-/u);

        const missingLocaleRoot = fixture();
        fs.rmSync(path.join(missingLocaleRoot, "assets", "locale-ja-abc.js"));
        expect(() => inspectDesktopRendererDelivery(missingLocaleRoot)).toThrow(/locale-ja-/u);

        const oversizedRoot = fixture();
        fs.writeFileSync(
            path.join(oversizedRoot, "assets", "WorkspacePage-abc.js"),
            Buffer.alloc(DESKTOP_RENDERER_CHUNK_LIMIT_BYTES + 1),
        );
        expect(() => inspectDesktopRendererDelivery(oversizedRoot)).toThrow(/above/u);
    });

    it("rejects ambiguous or escaping module entry paths", () => {
        const ambiguousRoot = fixture();
        fs.appendFileSync(
            path.join(ambiguousRoot, "index.html"),
            '<script type="module" src="./assets/WorkspacePage-abc.js"></script>',
        );
        expect(() => inspectDesktopRendererDelivery(ambiguousRoot)).toThrow(/exactly one/u);

        const escapingRoot = fixture();
        fs.writeFileSync(path.join(escapingRoot, "index.html"), '<script type="module" src="../outside.js"></script>');
        expect(() => inspectDesktopRendererDelivery(escapingRoot)).toThrow(/unsafe/u);
    });
});
