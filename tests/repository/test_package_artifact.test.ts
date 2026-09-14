import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPackageArtifact, fileSha256, verifyPackageArtifact } from "./package-artifact.mjs";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-package-artifact-"));
    roots.push(root);
    const product = path.join(root, "OAAM-test");
    fs.mkdirSync(path.join(product, "resources/empty"), { recursive: true });
    fs.writeFileSync(path.join(product, "oaam-desktop"), "executable fixture\n", { mode: 0o751 });
    fs.writeFileSync(path.join(product, "resources/data.json"), '{"nonempty":true}');
    return { root, product };
}
it.each(["zip", "tar.gz"])("verifies real %s archive bytes, its full graph and extracted content", async (format) => {
    const f = fixture();
    const platform = format === "zip" ? "win32" : "linux";
    const artifact = await createPackageArtifact(f.product, path.join(f.root, "artifacts"), `OAAM-test.${format}`, {
        component: "desktop",
        platform,
        sourceCommit: "a".repeat(40),
    });
    const verified = await verifyPackageArtifact(artifact.archive, artifact.manifestPath, path.join(f.root, "extracted"), {
        component: "desktop",
        sourceCommit: "a".repeat(40),
    });
    expect(fs.readFileSync(path.join(verified.root, "resources/data.json"), "utf8")).toBe('{"nonempty":true}');
    expect(fs.statSync(path.join(verified.root, "resources/empty")).isDirectory()).toBe(true);
    if (format === "tar.gz" && process.platform !== "win32")
        expect(fs.statSync(path.join(verified.root, "oaam-desktop")).mode & 0o777).toBe(0o751);
    fs.appendFileSync(artifact.archive, "corruption");
    await expect(verifyPackageArtifact(artifact.archive, artifact.manifestPath, path.join(f.root, "corrupt"))).rejects.toThrow(
        /size changed/,
    );
    expect(fs.existsSync(path.join(f.root, "corrupt"))).toBe(false);
});
it.each(["wrong-source", "path-traversal", "missing-file", "digest"])("rejects %s in a downloaded artifact", async (failure) => {
    const f = fixture();
    const artifact = await createPackageArtifact(f.product, path.join(f.root, "artifacts"), "OAAM-test.zip", {
        component: "desktop",
        platform: "win32",
        sourceCommit: "a".repeat(40),
    });
    const manifest = JSON.parse(fs.readFileSync(artifact.manifestPath, "utf8"));
    if (failure === "path-traversal") manifest.files[0].relativePath = "../outside";
    if (failure === "missing-file") manifest.files.pop();
    if (failure === "digest") manifest.archive.sha256 = "b".repeat(64);
    fs.writeFileSync(artifact.manifestPath, JSON.stringify(manifest));
    const expected = failure === "wrong-source" ? { sourceCommit: "c".repeat(40) } : {};
    const extraction = path.join(f.root, "invalid");
    await expect(verifyPackageArtifact(artifact.archive, artifact.manifestPath, extraction, expected)).rejects.toThrow();
    expect(fs.existsSync(extraction)).toBe(false);
    expect(fileSha256(artifact.archive)).toBe(artifact.manifest.archive.sha256);
});
it.skipIf(process.platform === "win32")("rejects a symbolic link in a candidate before writing its archive", async () => {
    const f = fixture();
    fs.symlinkSync("oaam-desktop", path.join(f.product, "alias"));
    await expect(createPackageArtifact(f.product, path.join(f.root, "artifacts"), "OAAM-test.tar.gz", {})).rejects.toThrow(
        /symbolic links/,
    );
    expect(fs.existsSync(path.join(f.root, "artifacts"))).toBe(false);
});
