import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { installRestrictedWslResourceArchive, readDistributionSource } from "./desktop-distribution.mjs";
import { releaseDraftPlan } from "./release-draft.mjs";
import { createPackageArtifact, fileSha256 } from "./package-artifact.mjs";
import { createRestrictedWslPackageFixture } from "./fixtures/restricted-wsl-package-fixture";
import { prepareRestrictedWslPackageForDelivery, RESTRICTED_WSL_PACKAGE_PATH } from "./restricted-wsl-package.mjs";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-distribution-source-"));
    roots.push(root);
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=Package Test", "-c", "user.email=test@example.invalid", ...args], {
            cwd: root,
            encoding: "utf8",
            stdio: "pipe",
            timeout: 10000,
        }).trim();
    fs.mkdirSync(path.join(root, "tests/repository/package-assembly"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"0.1.0-beta.1"}');
    for (const file of ["package-lock.json", "tests/repository/package-assembly/package-lock.json"])
        fs.writeFileSync(path.join(root, file), "{}");
    git("init", "--quiet");
    git("add", "--", "package.json", "package-lock.json", "tests");
    git("commit", "--quiet", "-m", "Fixture source");
    return { root, git };
}
it("binds the actual clean revision, tag, version and explicit build inputs without host paths", () => {
    const f = fixture();
    f.git("tag", "v0.1.0-beta.1");
    const result = readDistributionSource(f.root, {
        tag: "v0.1.0-beta.1",
        buildNumber: "42",
        buildTime: "2026-09-15T00:00:00.000Z",
    });
    expect(result).toMatchObject({
        productVersion: "0.1.0-beta.1",
        channel: "beta",
        sourceCommit: f.git("rev-parse", "HEAD"),
        buildNumber: "42",
    });
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(() => readDistributionSource(f.root, { tag: "v0.1.0" })).toThrow(/exactly match/);
});
it("refuses dirty input and a matching-version tag pointing at an older commit", () => {
    const f = fixture();
    f.git("tag", "v0.1.0-beta.1");
    fs.writeFileSync(path.join(f.root, "new.txt"), "changed source");
    expect(() => readDistributionSource(f.root)).toThrow(/clean source/);
    f.git("add", "--", "new.txt");
    f.git("commit", "--quiet", "-m", "Changed fixture");
    expect(() => readDistributionSource(f.root, { tag: "v0.1.0-beta.1" })).toThrow(/does not identify/);
});

it("previews a beta draft from both real archives and refuses changed versions or missing downloads", async () => {
    const f = fixture();
    f.git("tag", "v0.1.0-beta.1");
    const source = readDistributionSource(f.root, { tag: "v0.1.0-beta.1" });
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-release-artifacts-"));
    roots.push(output);
    const product = path.join(output, "OAAM-fixture");
    fs.mkdirSync(product);
    fs.writeFileSync(path.join(product, "data.txt"), "nonempty draft fixture");
    const artifacts = path.join(output, "artifacts");
    for (const [platform, format] of [
        ["linux", "tar.gz"],
        ["win32", "zip"],
    ]) {
        await createPackageArtifact(product, artifacts, `OAAM-${source.productVersion}-desktop-${platform}-x64.${format}`, {
            ...source,
            component: "desktop",
            platform,
            arch: "x64",
            restrictedWsl: { sourceCommit: source.sourceCommit },
        });
    }
    const plan = releaseDraftPlan(f.root, artifacts, "v0.1.0-beta.1");
    expect(plan.args).toContain("--draft");
    expect(plan.args).toContain("--prerelease");
    expect(plan.args.filter((arg: string) => arg.endsWith(".manifest.json"))).toHaveLength(2);
    const manifestPath = path.join(artifacts, "OAAM-0.1.0-beta.1-desktop-win32-x64.zip.manifest.json");
    const original = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(original), productVersion: "9.9.9" }));
    expect(() => releaseDraftPlan(f.root, artifacts, "v0.1.0-beta.1")).toThrow(/productVersion mismatch/);
    fs.writeFileSync(manifestPath, original);
    fs.unlinkSync(manifestPath.slice(0, -".manifest.json".length));
    expect(() => releaseDraftPlan(f.root, artifacts, "v0.1.0-beta.1")).toThrow(/ENOENT/);
});

it.each([
    "valid",
    "wrong_source",
    "wrong_manifest_binding",
    "corrupt_payload",
] as const)("consumes the installed Linux resource archive through the Windows distribution entry (%s)", async (condition) => {
    const f = fixture();
    const source = readDistributionSource(f.root);
    const raw = path.join(f.root, "raw-resource");
    createRestrictedWslPackageFixture(raw, false);
    const prepared = await prepareRestrictedWslPackageForDelivery(resolveWorkspaceGraph(process.cwd()), {
        consumerRoot: path.join(f.root, "linux-consumer"),
        architecture: "x64",
        artifact: { rootPath: raw, manifestSha256: fileSha256(path.join(raw, "manifest.json")) },
    });
    if (condition === "corrupt_payload")
        fs.writeFileSync(path.join(prepared.rootPath, "code", "restricted-wsl.cjs"), "altered after manifest creation");
    // The Linux producer archives this installed layout: manifest.json plus code/native and code/node_modules.
    const artifact = await createPackageArtifact(prepared.rootPath, path.join(f.root, "artifacts"), "restricted-wsl.tar.gz", {
        ...source,
        component: "restricted-wsl-support",
        platform: "linux",
        arch: "x64",
        resourceManifestSha256: condition === "wrong_manifest_binding" ? "0".repeat(64) : prepared.manifestSha256,
    });
    const consumerRoot = path.join(f.root, "windows-consumer");
    const operation = installRestrictedWslResourceArchive({
        archive: artifact.archive,
        manifestPath: artifact.manifestPath,
        extractionRoot: path.join(f.root, "windows-extracted"),
        consumerRoot,
        architecture: "x64",
        sourceCommit: condition === "wrong_source" ? "0".repeat(40) : source.sourceCommit,
        productVersion: source.productVersion,
    });
    if (condition !== "valid") {
        const failure = {
            wrong_source: /artifact sourceCommit mismatch/,
            wrong_manifest_binding: /restricted manifest binding changed/,
            corrupt_payload: /invalid package file/,
        }[condition];
        await expect(operation).rejects.toThrow(failure);
        expect(fs.existsSync(path.join(consumerRoot, RESTRICTED_WSL_PACKAGE_PATH))).toBe(false);
        return;
    }
    const installed = await operation;
    expect(installed.manifestSha256).toBe(prepared.manifestSha256);
    expect(installed.fileCount).toBe(prepared.fileCount);
    const manifest = JSON.parse(fs.readFileSync(path.join(prepared.rootPath, "manifest.json"), "utf8"));
    for (const file of manifest.files)
        expect(fileSha256(path.join(installed.rootPath, "code", file.relativePath))).toBe(file.sha256);
    expect(fs.existsSync(path.join(installed.rootPath, "code/native/oaam_file_lock.node"))).toBe(true);
    expect(fs.existsSync(path.join(installed.rootPath, "native"))).toBe(false);
});
