import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    requireRestrictedCodePackage,
    verifyRestrictedCodePackage,
    type RestrictedCodePackage,
} from "../src/restricted-code-package";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): RestrictedCodePackage {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-code-package-control-"));
    roots.push(rootPath);
    const files = ["node", "restricted-wsl.cjs", "node_modules/private/reader.js"].map((relativePath) => {
        const bytes = Buffer.from(`owned code ${relativePath}`);
        fs.mkdirSync(path.dirname(path.join(rootPath, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(rootPath, relativePath), bytes, { mode: relativePath === "node" ? 0o700 : 0o600 });
        return {
            relativePath,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            executable: relativePath === "node",
        };
    });
    return {
        rootPath,
        manifest: {
            schemaVersion: 1,
            platform: "linux",
            architecture: process.arch as "x64",
            nodeVersion: process.versions.node,
            nodeModulesVersion: process.versions.modules,
            files,
        },
    };
}

describe("restricted unpacked Linux code package", () => {
    it("verifies every file and directory without using the root prefix as package authority", () => {
        const code = fixture();
        expect(() => verifyRestrictedCodePackage(code)).not.toThrow();
        expect(() =>
            requireRestrictedCodePackage({ ...code, rootPath: "/mnt/c/Program Files/OAAM/exact-resources" }),
        ).not.toThrow();
    });
    it.each([
        "missing",
        "changed",
        "extra",
        "symlink",
        "nonexecutable",
        "wrong_abi",
    ] as const)("rejects %s before service readiness", (failure) => {
        const code = fixture(),
            reader = path.join(code.rootPath, "node_modules/private/reader.js");
        if (failure === "missing") fs.unlinkSync(reader);
        if (failure === "changed") fs.writeFileSync(reader, "changed dependency");
        if (failure === "extra") fs.writeFileSync(path.join(code.rootPath, "foreign.txt"), "unowned");
        if (failure === "symlink") {
            fs.unlinkSync(reader);
            fs.symlinkSync(path.join(code.rootPath, "node"), reader);
        }
        if (failure === "nonexecutable") fs.chmodSync(path.join(code.rootPath, "node"), 0o600);
        if (failure === "wrong_abi") Object.assign(code.manifest, { nodeModulesVersion: "999" });
        expect(() => verifyRestrictedCodePackage(code)).toThrow();
    });
    it.each([
        "/",
        "/tmp/../foreign",
        "relative",
        "/tmp/code/",
        "/tmp/code\0",
    ])("rejects noncanonical code root %s", (rootPath) => {
        expect(() => requireRestrictedCodePackage({ ...fixture(), rootPath })).toThrow();
    });
});
