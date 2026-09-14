import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    productReleaseIdentity,
    readProductRelease,
    windowsProductVersion,
    writeClientProductRelease,
} from "./product-release.mjs";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OAAM release metadata build", () => {
    it.each([
        ["0.1.0", "stable"],
        ["0.1.0-beta.1", "beta"],
        ["0.1.0-dev.1", "dev"],
        ["1000000.0.0-beta.1000000", "beta"],
    ])("preserves %s independently of a client or executable format", (version, channel) => {
        expect(productReleaseIdentity(version)).toEqual({ version, channel });
    });
    it.each([
        "v0.1.0",
        "0.1",
        "01.1.0",
        "0.1.0-alpha.1",
        "0.1.0-beta.0",
        "0.1.0-beta.01",
        "0.1.0+local",
    ])("rejects ambiguous or unsupported product version %s", (version) =>
        expect(() => productReleaseIdentity(version)).toThrow(/OAAM version/u));
    it("derives Desktop and Headless metadata from one product version while preserving internal package versions", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-product-release-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.2.0-beta.3" }));
        for (const component of ["desktop", "headless"]) {
            const packageRoot = path.join(root, "packages", "client", component);
            fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
            const manifest = JSON.stringify({ name: `@oaam/client-${component}`, version: "0.1.0" });
            fs.writeFileSync(path.join(packageRoot, "package.json"), manifest);
            writeClientProductRelease(root, component);
            expect(JSON.parse(fs.readFileSync(path.join(packageRoot, "dist", "product-release.json"), "utf8"))).toEqual({
                component,
                version: "0.2.0-beta.3",
                channel: "beta",
            });
            expect(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).toBe(manifest);
        }
        expect(readProductRelease(root)).toEqual({ version: "0.2.0-beta.3", channel: "beta" });
    });

    it.each([
        ["0.1.0-dev.32767", "0.1.0.32767"],
        ["0.1.0-beta.1", "0.1.0.32768"],
        ["0.1.0-beta.32767", "0.1.0.65534"],
        ["0.1.0", "0.1.0.65535"],
    ])("maps %s into ordered PE fields only at Windows packaging", (version, expected) => {
        expect(windowsProductVersion(version)).toBe(expected);
    });

    it.each([
        "65536.0.0",
        "0.65536.0",
        "0.0.65536",
        "0.1.0-dev.32768",
        "0.1.0-beta.32768",
    ])("rejects an unrepresentable Windows package version %s", (version) =>
        expect(() => windowsProductVersion(version)).toThrow(/Windows version-resource range/u));
});
