/** Delivery refusal controls; fixture bytes never stand in for actual native loading. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINUX_LOCK_SOURCE, validateLinuxFileLockBoundary } from "./linux-file-lock-build.mjs";
import { validateInstalledRestrictedWslPackage } from "./restricted-wsl-package.mjs";
import { createRestrictedWslPackageFixture } from "./fixtures/restricted-wsl-package-fixture";

const roots: string[] = [];
function ownedRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-linux-lock-delivery-"));
    roots.push(root);
    return root;
}
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("exact Linux native lock boundary", () => {
    it("accepts only the reviewed source inventory and refuses extra source or new physical authority", () => {
        const root = ownedRoot(),
            source = path.join(root, LINUX_LOCK_SOURCE);
        fs.mkdirSync(path.dirname(source), { recursive: true });
        const original = fs.readFileSync(path.resolve(LINUX_LOCK_SOURCE));
        fs.writeFileSync(source, original);
        expect(validateLinuxFileLockBoundary(root)).toEqual([]);
        const extra = path.join(path.dirname(source), "extra.cc");
        fs.writeFileSync(extra, "// additional native source\n");
        expect(validateLinuxFileLockBoundary(root)).toContain(
            "Linux native lock source inventory must contain only file-lock.cc",
        );
        fs.unlinkSync(extra);
        fs.appendFileSync(source, "\nvoid expanded_authority() { unlink(0); }\n");
        expect(validateLinuxFileLockBoundary(root)).toContain(
            "Linux lock bridge must not acquire process, file mutation or arbitrary FFI authority",
        );
    });

    it("does not impose the boundary on a partial fixture, but fails when its declared build lacks the source", () => {
        const root = ownedRoot();
        expect(validateLinuxFileLockBoundary(root)).toEqual([]);
        const declared = path.join(root, "tests/repository/linux-file-lock-build.mjs");
        fs.mkdirSync(path.dirname(declared), { recursive: true });
        fs.writeFileSync(declared, "// declared build\n");
        expect(validateLinuxFileLockBoundary(root)).toEqual([expect.stringContaining("Linux lock source boundary unavailable")]);
    });

    it("refuses a restricted package that consistently omits the required lock module", () => {
        const root = ownedRoot();
        createRestrictedWslPackageFixture(root);
        expect(validateInstalledRestrictedWslPackage(root, "x64")).toMatchObject({ architecture: "x64" });
        const manifestPath = path.join(root, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.files = manifest.files.filter(
            (entry: { relativePath: string }) => entry.relativePath !== "native/oaam_file_lock.node",
        );
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        fs.unlinkSync(path.join(root, "code/native/oaam_file_lock.node"));
        fs.rmdirSync(path.join(root, "code/native"));
        expect(() => validateInstalledRestrictedWslPackage(root, "x64")).toThrow(
            "requires its Linux process-lifetime lock module",
        );
    });
});
