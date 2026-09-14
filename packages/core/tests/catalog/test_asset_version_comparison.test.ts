import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAssetVersionManifest, resolveAssetVersionRoot } from "../../src/catalog/asset-library-authority";
import { writeAssetManifest } from "../../src/catalog/asset-manifest";
import { resolvePayloadPath } from "../../src/catalog/payload-store";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishAssetVersion,
    publishInitialAssetVersion,
} from "../../src/catalog/version-authority";
import { serializeVersionManifest } from "../../src/catalog/version-manifest";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { compareAssetVersions } from "../../src/orchestration/asset-version-comparison-service";
import type { AssetVersionComparisonObserver, AssetVersionFileContentV2, AssetVersionFileV2, UuidV4 } from "../../src/types";
import {
    ASSET_ID,
    makeAsset,
    makeBinaryFile,
    makeTextFile,
    makeVersionClosure,
    VERSION_ID,
    VERSION_ID_2,
} from "./fixtures/version-v2";

let root = "";
let assetsRoot = "";

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-version-comparison-"));
    assetsRoot = path.join(root, "assets");
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function uuid(index: number): UuidV4 {
    return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function withFile(
    file: AssetVersionFileContentV2,
    index: number,
    overrides: Partial<AssetVersionFileV2> = {},
): AssetVersionFileContentV2 {
    return {
        ...file,
        file: {
            ...file.file,
            fileId: uuid(index),
            ...overrides,
        },
    } as AssetVersionFileContentV2;
}

function publishPair(leftFiles: AssetVersionFileContentV2[], rightFiles: AssetVersionFileContentV2[]) {
    function normalized(files: AssetVersionFileContentV2[]): AssetVersionFileContentV2[] {
        const sorted = [...files].sort((left, right) =>
            left.file.logicalPath < right.file.logicalPath ? -1 : left.file.logicalPath > right.file.logicalPath ? 1 : 0,
        );
        const entryPath = sorted.find((file) => file.contentKind === "text")?.file.logicalPath;
        return sorted.map((file) => ({
            ...file,
            file: {
                ...file.file,
                role: file.file.logicalPath === entryPath ? "entry" : "resource",
            },
        })) as AssetVersionFileContentV2[];
    }
    const left = makeVersionClosure({ files: normalized(leftFiles) });
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "comparison-left",
        asset: makeAsset([VERSION_ID]),
        version: left,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
    const right = makeVersionClosure({
        versionId: VERSION_ID_2,
        revision: 2,
        sourceVersionId: VERSION_ID,
        changeKind: "edit",
        files: normalized(rightFiles),
        createdAt: 200,
    });
    publishAssetVersion({
        assetsRoot,
        transactionId: "comparison-right",
        version: right,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
    return {
        left: readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, VERSION_ID as UuidV4)!,
        right: readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, VERSION_ID_2 as UuidV4)!,
    };
}

function comparisonInput(manifests: ReturnType<typeof publishPair>, logicalPath?: string) {
    return {
        assetId: ASSET_ID as UuidV4,
        left: { versionId: VERSION_ID as UuidV4, versionFingerprint: manifests.left.fingerprint },
        right: { versionId: VERSION_ID_2 as UuidV4, versionFingerprint: manifests.right.fingerprint },
        ...(logicalPath === undefined ? {} : { logicalPath }),
    };
}

function writeRawVersion(
    versionId: UuidV4,
    closure: ReturnType<typeof makeVersionClosure>,
    payloads: readonly Uint8Array[],
): void {
    const versionRoot = resolveAssetVersionRoot(assetsRoot, ASSET_ID as UuidV4, versionId);
    fs.mkdirSync(path.join(versionRoot, "payloads"), { recursive: true });
    fs.writeFileSync(path.join(versionRoot, "version.json"), serializeVersionManifest(closure.manifest));
    closure.manifest.files.forEach((file, index) => {
        fs.writeFileSync(resolvePayloadPath(versionRoot, file.contentHash), payloads[index] as Uint8Array);
    });
}

describe("complete Asset Version comparison", () => {
    it("classifies the complete file graph and uses metadata comparison for binary members", async () => {
        const unchanged = makeTextFile("same\n", "unchanged.md");
        const manifests = publishPair(
            [
                withFile(unchanged, 1),
                withFile(makeTextFile("old\n", "modified.md"), 2),
                withFile(makeTextFile("removed\n", "removed.md"), 3),
                withFile(makeBinaryFile(new Uint8Array([1]), "binary.bin"), 4),
            ],
            [
                withFile(unchanged, 11),
                withFile(makeTextFile("new\n", "modified.md"), 12),
                withFile(makeTextFile("added\n", "added.md"), 13),
                withFile(makeBinaryFile(new Uint8Array([2]), "binary.bin"), 14),
            ],
        );

        const graph = await compareAssetVersions(assetsRoot, comparisonInput(manifests));
        expect(graph.status).toBe("complete");
        expect(Object.fromEntries(graph.value.files.map((file) => [file.logicalPath, file.changeKind]))).toEqual({
            "added.md": "added",
            "binary.bin": "modified",
            "modified.md": "modified",
            "removed.md": "removed",
            "unchanged.md": "unchanged",
        });
        expect(graph.value.selectedFile).toEqual({ comparisonKind: "not_requested" });

        const binary = await compareAssetVersions(assetsRoot, comparisonInput(manifests, "binary.bin"));
        expect(binary.value.selectedFile).toMatchObject({
            comparisonKind: "metadata",
            logicalPath: "binary.bin",
            left: { state: "present" },
            right: { state: "present" },
        });

        await expect(compareAssetVersions(assetsRoot, comparisonInput(manifests, "absent.md"))).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("absent from both") }],
        });
    });

    it("builds exact context hunks, preserves identical text, and falls back to a complete coarse diff", async () => {
        const base = Array.from({ length: 30 }, (_, index) => `line-${index}`);
        const changed = [...base];
        changed.splice(15, 1, "replacement-a", "replacement-b");
        const identicalLeft = withFile(makeTextFile("identical\n", "metadata-only.md"), 21);
        const identicalRight = withFile(makeTextFile("identical\n", "metadata-only.md"), 22, { executable: true });
        const manifests = publishPair(
            [withFile(makeTextFile(base.join("\n"), "entry.md"), 20), identicalLeft],
            [withFile(makeTextFile(changed.join("\n"), "entry.md"), 23), identicalRight],
        );

        const myers = await compareAssetVersions(assetsRoot, comparisonInput(manifests, "entry.md"));
        expect(myers.value.selectedFile).toMatchObject({
            comparisonKind: "text",
            algorithm: "myers",
            hunks: [
                {
                    leftStart: 6,
                    rightStart: 6,
                    lines: expect.arrayContaining([
                        { lineKind: "remove", text: "line-15", leftLine: 16 },
                        { lineKind: "add", text: "replacement-a", rightLine: 16 },
                        { lineKind: "add", text: "replacement-b", rightLine: 17 },
                    ]),
                },
            ],
        });

        const noTextChange = await compareAssetVersions(assetsRoot, comparisonInput(manifests, "metadata-only.md"));
        expect(noTextChange.value.selectedFile).toMatchObject({
            comparisonKind: "text",
            algorithm: "myers",
            hunks: [],
        });

        fs.rmSync(assetsRoot, { recursive: true, force: true });
        const separatedBase = Array.from({ length: 70 }, (_, index) => `separated-${index}`);
        const separatedChanged = [...separatedBase];
        separatedChanged.splice(5, 1, "early-a", "early-b");
        separatedChanged.splice(56, 1, "late");
        const separatedManifests = publishPair(
            [withFile(makeTextFile(separatedBase.join("\n"), "separated.md"), 25)],
            [withFile(makeTextFile(separatedChanged.join("\n"), "separated.md"), 26)],
        );
        const separated = await compareAssetVersions(assetsRoot, comparisonInput(separatedManifests, "separated.md"));
        expect(separated.value.selectedFile).toMatchObject({
            comparisonKind: "text",
            algorithm: "myers",
            hunks: { length: 2 },
        });

        fs.rmSync(assetsRoot, { recursive: true, force: true });
        const coarseLeft = ["shared-prefix", ...Array.from({ length: 1_001 }, (_, index) => `left-${index}`), "shared-suffix"];
        const coarseRight = ["shared-prefix", ...Array.from({ length: 1_001 }, (_, index) => `right-${index}`), "shared-suffix"];
        const coarseManifests = publishPair(
            [withFile(makeTextFile(coarseLeft.join("\n"), "coarse.md"), 31)],
            [withFile(makeTextFile(coarseRight.join("\n"), "coarse.md"), 32)],
        );
        const coarse = await compareAssetVersions(assetsRoot, comparisonInput(coarseManifests, "coarse.md"));
        expect(coarse.value.selectedFile).toMatchObject({
            comparisonKind: "text",
            algorithm: "coarse_complete",
            hunks: [
                {
                    leftStart: 1,
                    rightStart: 1,
                    lines: expect.arrayContaining([
                        { lineKind: "context", text: "shared-prefix", leftLine: 1, rightLine: 1 },
                        { lineKind: "context", text: "shared-suffix", leftLine: 1_003, rightLine: 1_003 },
                    ]),
                },
            ],
        });
    });

    it("supports added and removed text while cancellation remains explicit at later stages", async () => {
        const manifests = publishPair(
            [withFile(makeTextFile("left\n", "removed.md"), 41)],
            [withFile(makeTextFile("right\n", "added.md"), 42)],
        );
        const removed = await compareAssetVersions(assetsRoot, comparisonInput(manifests, "removed.md"));
        expect(removed.value.selectedFile).toMatchObject({
            comparisonKind: "text",
            leftLineCount: 2,
            rightLineCount: 0,
        });
        const added = await compareAssetVersions(assetsRoot, comparisonInput(manifests, "added.md"));
        expect(added.value.selectedFile).toMatchObject({
            comparisonKind: "text",
            leftLineCount: 0,
            rightLineCount: 2,
        });

        let cancel = false;
        const observer: AssetVersionComparisonObserver = {
            report(progress) {
                if (progress.stage === "loading") cancel = true;
            },
            isCancellationRequested() {
                return cancel;
            },
        };
        await expect(compareAssetVersions(assetsRoot, comparisonInput(manifests, "removed.md"), observer)).resolves.toMatchObject(
            {
                status: "failed",
                diagnostics: [{ code: "asset_compare.cancelled", retryable: false, suggestedActions: [] }],
            },
        );
    });

    it("rejects malformed or stale identities, missing members, oversized text, excessive lines, and noncanonical bytes", async () => {
        const manifests = publishPair(
            [withFile(makeTextFile("left\n", "entry.md"), 51)],
            [withFile(makeTextFile("right\n", "entry.md"), 52)],
        );
        for (const input of [
            { ...comparisonInput(manifests), assetId: "bad" },
            { ...comparisonInput(manifests), left: { ...comparisonInput(manifests).left, versionId: "bad" } },
            { ...comparisonInput(manifests), right: { ...comparisonInput(manifests).right, versionId: "bad" } },
            { ...comparisonInput(manifests), left: { ...comparisonInput(manifests).left, versionFingerprint: "bad" } },
            { ...comparisonInput(manifests), right: { ...comparisonInput(manifests).right, versionFingerprint: "bad" } },
            { ...comparisonInput(manifests), logicalPath: "../bad" },
            {
                ...comparisonInput(manifests),
                left: { ...comparisonInput(manifests).left, versionFingerprint: `sha256:${"c".repeat(64)}` },
            },
            {
                ...comparisonInput(manifests),
                right: { ...comparisonInput(manifests).right, versionFingerprint: `sha256:${"c".repeat(64)}` },
            },
        ]) {
            await expect(compareAssetVersions(assetsRoot, input as never)).resolves.toMatchObject({ status: "failed" });
        }

        fs.rmSync(assetsRoot, { recursive: true, force: true });
        const leftOnly = makeVersionClosure({ files: [withFile(makeTextFile("left\n", "entry.md"), 61)] });
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "left-only",
            asset: makeAsset([VERSION_ID]),
            version: leftOnly,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        await expect(
            compareAssetVersions(assetsRoot, {
                assetId: ASSET_ID as UuidV4,
                left: { versionId: VERSION_ID as UuidV4, versionFingerprint: leftOnly.manifest.fingerprint },
                right: { versionId: VERSION_ID_2 as UuidV4, versionFingerprint: leftOnly.manifest.fingerprint },
            }),
        ).resolves.toMatchObject({ status: "failed", diagnostics: [{ message: expect.stringContaining("not a member") }] });

        fs.rmSync(assetsRoot, { recursive: true, force: true });
        const huge = "x".repeat(32 * 1_024 * 1_024 + 1);
        const hugeManifests = publishPair(
            [withFile(makeTextFile(huge, "huge.md"), 71)],
            [withFile(makeTextFile("small", "huge.md"), 72)],
        );
        await expect(compareAssetVersions(assetsRoot, comparisonInput(hugeManifests, "huge.md"))).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("byte") }],
        });

        fs.rmSync(assetsRoot, { recursive: true, force: true });
        const tooManyLines = Array.from({ length: 100_001 }, () => "x").join("\n");
        const lineManifests = publishPair(
            [withFile(makeTextFile(tooManyLines, "lines.md"), 81)],
            [withFile(makeTextFile("small", "lines.md"), 82)],
        );
        await expect(compareAssetVersions(assetsRoot, comparisonInput(lineManifests, "lines.md"))).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("100000 lines") }],
        });

        fs.rmSync(assetsRoot, { recursive: true, force: true });
        fs.mkdirSync(assetsRoot, { recursive: true });
        writeAssetManifest(assetsRoot, makeAsset([VERSION_ID, VERSION_ID_2]));
        const canonical = makeVersionClosure({ files: [withFile(makeTextFile("line\n", "raw.md"), 91)] });
        const rawBytes = Buffer.from("line\r\n", "utf-8");
        const rawFile = withFile(makeTextFile("placeholder", "raw.md"), 92, {
            contentHash: sha256Bytes(rawBytes),
            byteSize: rawBytes.length,
        });
        const raw = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
            files: [rawFile],
        });
        writeRawVersion(VERSION_ID as UuidV4, canonical, [Buffer.from("line\n", "utf-8")]);
        writeRawVersion(VERSION_ID_2 as UuidV4, raw, [rawBytes]);
        await expect(
            compareAssetVersions(assetsRoot, {
                assetId: ASSET_ID as UuidV4,
                left: { versionId: VERSION_ID as UuidV4, versionFingerprint: canonical.manifest.fingerprint },
                right: { versionId: VERSION_ID_2 as UuidV4, versionFingerprint: raw.manifest.fingerprint },
                logicalPath: "raw.md",
            }),
        ).resolves.toMatchObject({ status: "failed", diagnostics: [{ message: expect.stringContaining("not normalized") }] });

        const hostile = new Proxy({} as never, {
            get() {
                throw "non-error comparison failure";
            },
        });
        await expect(compareAssetVersions(assetsRoot, hostile)).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: "non-error comparison failure" }],
        });
    });
});
