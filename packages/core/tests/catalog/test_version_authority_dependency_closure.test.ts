import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";
import { binaryPayloadStats, resolvePayloadPath, writePayload } from "../../src/catalog/payload-store";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishAssetVersion,
    publishInitialAssetVersion,
    readVersionAuthority,
} from "../../src/catalog/version-authority";
import { serializeVersionManifest } from "../../src/catalog/version-manifest";
import type { AssetKindTypeDataV2 } from "../../src/contracts/specs";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../src/foundation/fingerprint";
import { ASSET_ID, makeAsset, makeTextFile, makeVersionClosure, VERSION_ID, VERSION_ID_2 } from "./fixtures/version-v2";
import { assetsRoot, root } from "./fixtures/version-authority-test-fixtures";

describe("AssetVersion V2 dependency closure authority", () => {
    it("rejects closure descriptors, active-Asset identity, lineage, and revision contradictions", () => {
        const mismatched = makeVersionClosure();
        mismatched.files[0] = {
            ...mismatched.files[0],
            file: { ...mismatched.files[0].file, byteSize: mismatched.files[0].file.byteSize + 1 },
        };
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-bad",
                asset: makeAsset(),
                version: mismatched,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/does not exactly match/);

        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: path.join(root, "bad-initial"),
                transactionId: "txn-bad-initial",
                asset: makeAsset([VERSION_ID], { deleted: true }),
                version: makeVersionClosure(),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/inconsistent/);

        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-1",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const wrongRevision = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 9,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
        });
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-wrong-revision",
                version: wrongRevision,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/revision 2/);
        const wrongParent = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            changeKind: "edit",
        });
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-wrong-parent",
                version: wrongParent,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/sourceVersionId/);
    });

    it("accepts incomplete fragments without applying complete-only reference rules", () => {
        const file = makeTextFile("fragment", "fragment.md", [
            {
                kind: "include",
                rawTarget: "missing",
                required: true,
                resolution: "unresolved",
                diagnostics: [],
            },
        ]);
        file.file.role = "resource";
        const version = makeVersionClosure({ files: [file] });
        version.manifest.status = "incomplete";
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-incomplete",
            asset: makeAsset(),
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)?.manifest.status).toBe(
            "incomplete",
        );
    });

    it("rejects complete versions whose cross-Version dependency is not authoritative", () => {
        fs.mkdirSync(assetsRoot, { recursive: true });
        const file = makeTextFile("# Guidance\n", "AGENTS.md", [
            {
                kind: "include",
                rawTarget: "missing asset",
                required: true,
                resolution: "resolved_asset_version",
                targetAssetVersionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                diagnostics: [],
            },
        ]);
        const version = makeVersionClosure({ files: [file] });
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-dependency",
                asset: makeAsset(),
                version,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/missing_dependency/);
    });

    it("reports both absent and unsafe dependency inventories as non-authoritative", () => {
        const file = makeTextFile("# Root\n", "AGENTS.md", [
            {
                kind: "include",
                rawTarget: "missing",
                required: true,
                resolution: "resolved_asset_version",
                targetAssetVersionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                diagnostics: [],
            },
        ]);
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: path.join(root, "absent-assets"),
                transactionId: "txn-absent-inventory",
                asset: makeAsset(),
                version: makeVersionClosure({ files: [file] }),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/missing_dependency/);

        const unsafeRoot = path.join(root, "unsafe-assets");
        fs.mkdirSync(unsafeRoot);
        fs.symlinkSync(root, path.join(unsafeRoot, "unsafe-link"));
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: unsafeRoot,
                transactionId: "txn-unsafe-inventory",
                asset: makeAsset(),
                version: makeVersionClosure({ files: [file] }),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/symbolic|link/i);
    });

    it("resolves an authoritative cross-Asset dependency while ignoring unrelated root entries", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-target",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        fs.writeFileSync(path.join(assetsRoot, "unrelated.txt"), "x");
        fs.mkdirSync(path.join(assetsRoot, "not-an-asset"));
        fs.mkdirSync(path.join(assetsRoot, "99999999-9999-4999-8999-999999999999"));

        const rootAssetId = "11111111-1111-4111-8111-111111111111";
        const rootVersionId = "22222222-2222-4222-8222-222222222222";
        const file = makeTextFile("# Root\n", "AGENTS.md", [
            {
                kind: "include",
                rawTarget: "dependency",
                required: true,
                resolution: "resolved_asset_version",
                targetAssetVersionId: VERSION_ID,
                diagnostics: [],
            },
            {
                kind: "link",
                rawTarget: "optional",
                required: false,
                resolution: "unresolved",
                diagnostics: [],
            },
        ]);
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-root",
            asset: makeAsset([rootVersionId], { assetId: rootAssetId }),
            version: makeVersionClosure({
                assetId: rootAssetId,
                versionId: rootVersionId,
                files: [file],
            }),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(readVersionAuthority(assetsRoot, rootAssetId, rootVersionId, EMPTY_VERSION_DIALECT_REGISTRY)).not.toBeNull();
    });

    it("resolves a handler-owned Memory Catalog dependency", () => {
        const unitAssetId = "66666666-6666-4666-8666-666666666666";
        const unitVersionId = "77777777-7777-4777-8777-777777777777";
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-memory-unit",
            asset: makeAsset([unitVersionId], { assetId: unitAssetId, kind: "Memory" }),
            version: makeVersionClosure({
                assetId: unitAssetId,
                versionId: unitVersionId,
                canonical: {
                    kind: "Memory",
                    typeData: {
                        schemaVersion: 2,
                        entityRole: "unit",
                        card: { name: "topic", description: "" },
                        loading: { card: "high", body: "low" },
                        applicabilityRule: "",
                    },
                },
                files: [makeTextFile("memory", "topic.md")],
            }),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const catalogAssetId = "88888888-8888-4888-8888-888888888888";
        const catalogVersionId = "99999999-9999-4999-8999-999999999999";
        const catalog = makeVersionClosure({
            assetId: catalogAssetId,
            versionId: catalogVersionId,
            canonical: {
                kind: "Memory",
                typeData: {
                    schemaVersion: 2,
                    entityRole: "catalog",
                    members: [
                        {
                            targetAssetVersionId: unitVersionId,
                            routingTitle: "Topic",
                            routingHint: "",
                        },
                    ],
                },
            },
            files: [],
        });
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-memory-catalog",
            asset: makeAsset([catalogVersionId], { assetId: catalogAssetId, kind: "Memory" }),
            version: catalog,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(readVersionAuthority(assetsRoot, catalogAssetId, catalogVersionId, EMPTY_VERSION_DIALECT_REGISTRY)).not.toBeNull();
    });

    it("detects a dependency cycle in otherwise strict on-disk Version closures", () => {
        const assetA = "12121212-1212-4212-8212-121212121212";
        const versionA = "13131313-1313-4313-8313-131313131313";
        const assetB = "14141414-1414-4414-8414-141414141414";
        const versionB = "15151515-1515-4515-8515-151515151515";
        const makeCycle = (assetId: string, versionId: string, targetVersionId: string) =>
            makeVersionClosure({
                assetId,
                versionId,
                files: [
                    makeTextFile("cycle", "AGENTS.md", [
                        {
                            kind: "include",
                            rawTarget: "cycle",
                            required: true,
                            resolution: "resolved_asset_version",
                            targetAssetVersionId: targetVersionId,
                            diagnostics: [],
                        },
                    ]),
                ],
            });
        const fixtures = [
            {
                asset: makeAsset([versionA], { assetId: assetA }),
                closure: makeCycle(assetA, versionA, versionB),
            },
            {
                asset: makeAsset([versionB], { assetId: assetB }),
                closure: makeCycle(assetB, versionB, versionA),
            },
        ];
        for (const fixture of fixtures) {
            const versionRoot = path.join(assetsRoot, fixture.asset.assetId, "versions", fixture.closure.manifest.versionId);
            fs.mkdirSync(versionRoot, { recursive: true });
            writeAssetManifest(assetsRoot, fixture.asset);
            const file = fixture.closure.files[0];
            if (file.contentKind !== "text") throw new Error("cycle fixture must be text");
            writePayload(versionRoot, file.text, "text");
            fs.writeFileSync(path.join(versionRoot, "version.json"), serializeVersionManifest(fixture.closure.manifest));
        }
        expect(() => readVersionAuthority(assetsRoot, assetA, versionA, EMPTY_VERSION_DIALECT_REGISTRY)).toThrow(
            /dependency_cycle/,
        );
    });

    it("fails closed when two Asset manifests claim the same dependency Version", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-target",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const duplicateAssetId = "33333333-3333-4333-8333-333333333333";
        fs.mkdirSync(path.join(assetsRoot, duplicateAssetId), { recursive: true });
        writeAssetManifest(assetsRoot, makeAsset([VERSION_ID], { assetId: duplicateAssetId }));
        const rootAssetId = "44444444-4444-4444-8444-444444444444";
        const rootVersionId = "55555555-5555-4555-8555-555555555555";
        const file = makeTextFile("# Root\n", "AGENTS.md", [
            {
                kind: "include",
                rawTarget: "ambiguous",
                required: true,
                resolution: "resolved_asset_version",
                targetAssetVersionId: VERSION_ID,
                diagnostics: [],
            },
        ]);
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-root",
                asset: makeAsset([rootVersionId], { assetId: rootAssetId }),
                version: makeVersionClosure({
                    assetId: rootAssetId,
                    versionId: rootVersionId,
                    files: [file],
                }),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/multiple Assets/);
    });

    it("rejects an enclosing Asset kind mismatch and a parent manifest crossing Asset identity", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-first",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const asset = readAssetManifest(assetsRoot, ASSET_ID);
        if (asset === null) throw new Error("fixture Asset missing");
        writeAssetManifest(assetsRoot, { ...asset, kind: "Rule" });
        expect(() => readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)).toThrow(
            /identity does not match/,
        );
        writeAssetManifest(assetsRoot, asset);

        const manifestPath = path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID, "version.json");
        const altered = structuredClone(makeVersionClosure().manifest);
        altered.assetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        altered.originAuthority.assetId = altered.assetId;
        const { authorityFingerprint: _old, ...originPreimage } = altered.originAuthority;
        altered.originAuthority.authorityFingerprint = computeVersionOriginAuthorityFingerprint(originPreimage);
        fs.writeFileSync(manifestPath, serializeVersionManifest(altered));
        const second = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
        });
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-second",
                version: second,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/crosses Asset authority/);
    });

    it("refuses to allocate a new revision over duplicate revision authority", () => {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-first",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const second = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
        });
        publishAssetVersion({
            assetsRoot,
            transactionId: "txn-second",
            version: second,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        second.manifest.revision = 1;
        fs.writeFileSync(
            path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID_2, "version.json"),
            serializeVersionManifest(second.manifest),
        );
        const thirdVersionId = "abababab-abab-4bab-8bab-abababababab";
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-third",
                version: makeVersionClosure({
                    versionId: thirdVersionId,
                    revision: 3,
                    sourceVersionId: VERSION_ID_2,
                    changeKind: "edit",
                }),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/duplicate revision/);
    });

    it("rejects a text payload whose stored bytes are validly hashed but not canonical-normalized", () => {
        const version = makeVersionClosure();
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-first",
            asset: makeAsset(),
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const raw = Buffer.from("a\r\n");
        const rawStats = binaryPayloadStats(raw);
        const manifest = structuredClone(version.manifest);
        manifest.files[0].contentHash = rawStats.contentHash;
        manifest.files[0].byteSize = rawStats.byteSize;
        manifest.versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
            { kind: manifest.kind, typeData: manifest.typeData } as AssetKindTypeDataV2,
            manifest.files,
        );
        manifest.fingerprint = computeVersionFingerprint(
            manifest.versionCanonicalContentFingerprint,
            [],
            [],
            manifest.portableDialectContracts,
        );
        const versionRoot = path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID);
        fs.writeFileSync(path.join(versionRoot, "version.json"), serializeVersionManifest(manifest));
        fs.writeFileSync(resolvePayloadPath(versionRoot, rawStats.contentHash), raw);
        expect(() => readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)).toThrow(
            /not normalized/,
        );
    });
});
