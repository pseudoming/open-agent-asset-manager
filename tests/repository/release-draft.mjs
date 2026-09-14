import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readDistributionSource } from "./desktop-distribution.mjs";
import { fileSha256 } from "./package-artifact.mjs";
import { runPackageCommand } from "./package-consumer.mjs";

/** Build a reviewable draft request from the exact two already verified desktop artifacts. */
export function releaseDraftPlan(repositoryRoot, artifactDirectory, tag) {
    assert.ok(typeof tag === "string", "Release draft requires an explicit tag");
    const source = readDistributionSource(repositoryRoot, { tag });
    const assets = [];
    for (const [platform, format] of [
        ["linux", "tar.gz"],
        ["win32", "zip"],
    ]) {
        const name = `OAAM-${source.productVersion}-desktop-${platform}-x64.${format}`;
        const archive = path.join(artifactDirectory, name),
            manifestPath = archive + ".manifest.json";
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        for (const [key, expected] of Object.entries({
            schemaVersion: 1,
            component: "desktop",
            platform,
            arch: "x64",
            sourceCommit: source.sourceCommit,
            sourceTree: source.sourceTree,
            productVersion: source.productVersion,
            channel: source.channel,
        }))
            assert.deepEqual(manifest[key], expected, `Release ${platform} ${key} mismatch`);
        assert.equal(manifest.archive.name, name);
        assert.equal(fs.statSync(archive).size, manifest.archive.bytes);
        assert.equal(fileSha256(archive), manifest.archive.sha256, `Release ${platform} archive digest mismatch`);
        if (platform === "win32") assert.equal(manifest.restrictedWsl.sourceCommit, source.sourceCommit);
        assets.push(archive, manifestPath);
    }
    assert.deepEqual(
        fs.readdirSync(artifactDirectory).sort(),
        assets.map((file) => path.basename(file)).sort(),
        "unexpected Release download input",
    );
    const body =
        `OAAM ${source.productVersion}\n\nPortable Windows x64 and Linux x64 Desktop candidates from ${source.sourceCommit}.\n` +
        "The Linux validation environment is Ubuntu WSL/WSLg. The Windows package includes its supporting selected-WSL service.\n" +
        "Each archive includes build-info.json; the accompanying manifest records its checksum and complete file inventory.\n" +
        "This draft requires candidate review before publication.\n";
    return Object.freeze({
        sourceCommit: source.sourceCommit,
        body,
        args: [
            "release",
            "create",
            tag,
            "--verify-tag",
            "--target",
            source.sourceCommit,
            "--draft",
            "--title",
            `OAAM ${source.productVersion}`,
            ...(source.channel === "beta" ? ["--prerelease"] : []),
            ...assets,
        ],
    });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try {
        const { values } = parseArgs({
            options: { artifacts: { type: "string" }, tag: { type: "string" }, execute: { type: "boolean" } },
        });
        const tag = values.tag ?? process.env.GITHUB_REF_NAME;
        const plan = releaseDraftPlan(process.cwd(), values.artifacts, tag);
        if (values.execute) {
            assert.equal(process.env.GITHUB_ACTIONS, "true", "draft execution is restricted to the reviewed tag workflow");
            assert.equal(process.env.GITHUB_EVENT_NAME, "push");
            assert.equal(process.env.GITHUB_REF, `refs/tags/${tag}`);
            assert.equal(process.env.GITHUB_SHA, plan.sourceCommit);
            const notes = path.join(path.dirname(values.artifacts), "oaam-release-notes.md");
            fs.writeFileSync(notes, plan.body, { flag: "wx" });
            runPackageCommand("create reviewed Release draft", "gh", [...plan.args, "--notes-file", notes], { stdio: "inherit" });
        } else process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    } catch (error) {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    }
}
