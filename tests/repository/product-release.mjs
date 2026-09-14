import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Build-time product policy; clients receive data and do not depend on another client package. */
export function productReleaseIdentity(version) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(dev|beta)\.([1-9]\d*))?$/u.exec(version);
    if (match === null) throw new Error("OAAM version must be major.minor.patch, optionally followed by -dev.N or -beta.N");
    return Object.freeze({ version, channel: match[4] === "dev" ? "dev" : match[4] === "beta" ? "beta" : "stable" });
}

export function readProductRelease(repositoryRoot) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.equal(typeof manifest.version, "string", "root package.json must provide the OAAM product version");
    return productReleaseIdentity(manifest.version);
}

export function writeClientProductRelease(repositoryRoot, component) {
    assert.ok(component === "desktop" || component === "headless", "unknown OAAM client component");
    const packageRoot = path.join(repositoryRoot, "packages", "client", component);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, `@oaam/client-${component}`, "product release component/package mismatch");
    const output = path.join(packageRoot, "dist");
    const directory = fs.lstatSync(output);
    assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), "client output must be a built direct directory");
    const { version, channel } = readProductRelease(repositoryRoot);
    const metadata = Object.freeze({ component, version, channel });
    const file = path.join(output, "product-release.json");
    if (fs.existsSync(file)) {
        const entry = fs.lstatSync(file);
        assert.ok(entry.isFile() && !entry.isSymbolicLink(), "product release output must be a regular file");
    }
    fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
}

export function windowsProductVersion(version) {
    const release = productReleaseIdentity(version);
    const [base, suffix] = version.split("-");
    const components = base.split(".").map(Number);
    const sequence = suffix === undefined ? undefined : Number(suffix.split(".")[1]);
    assert.ok(
        components.every((value) => Number.isSafeInteger(value) && value <= 65_535) &&
            (sequence === undefined || (Number.isSafeInteger(sequence) && sequence <= 32_767)),
        "OAAM version exceeds the Windows version-resource range",
    );
    const revision = sequence === undefined ? 65_535 : release.channel === "beta" ? sequence + 32_767 : sequence;
    return [...components, revision].join(".");
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const [component, extra] = process.argv.slice(2);
    assert.equal(extra, undefined, "product release build received unexpected arguments");
    const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
    process.stdout.write(`${JSON.stringify(writeClientProductRelease(repositoryRoot, component))}\n`);
}
