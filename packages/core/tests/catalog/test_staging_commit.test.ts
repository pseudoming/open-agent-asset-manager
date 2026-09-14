import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    resolveStagingRoot,
    resolveStagingDir,
    createStagingDir,
    createStagingVersionDir,
    commitNewAsset,
    commitNewVersion,
    discardStaging,
    listResidualStaging,
    newTxnId,
    makeDirectoryTreeDurable,
} from "../../src/catalog/staging-commit";

let tmpAssetsRoot: string;

beforeEach(() => {
    tmpAssetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-stage-"));
});

afterEach(() => {
    fs.rmSync(tmpAssetsRoot, { recursive: true, force: true });
});

const ASSET_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_ID = "00000000-0000-4000-8000-000000000002";

describe("makeDirectoryTreeDurable", () => {
    it("flushes a nested regular tree and rejects symlink entries", () => {
        const root = path.join(tmpAssetsRoot, "tree");
        fs.mkdirSync(path.join(root, "nested"), { recursive: true });
        fs.writeFileSync(path.join(root, "nested", "file"), "x");
        expect(() => makeDirectoryTreeDurable(root)).not.toThrow();
        fs.symlinkSync(path.join(root, "nested", "file"), path.join(root, "link"));
        expect(() => makeDirectoryTreeDurable(root)).toThrow(/symbolic[- ]link/u);
    });
});

describe("resolveStagingRoot + resolveStagingDir", () => {
    it("resolveStagingRoot is <assetsRoot>/.staging", () => {
        expect(resolveStagingRoot(tmpAssetsRoot)).toBe(path.join(tmpAssetsRoot, ".staging"));
    });

    it("resolveStagingDir is <assetsRoot>/.staging/<txnId>", () => {
        expect(resolveStagingDir(tmpAssetsRoot, "txn1")).toBe(path.join(tmpAssetsRoot, ".staging", "txn1"));
    });
});

describe("createStagingDir", () => {
    it("creates the staging root + txn dir", () => {
        const dir = createStagingDir(tmpAssetsRoot, "txn1");
        expect(fs.existsSync(dir)).toBe(true);
        expect(fs.existsSync(resolveStagingRoot(tmpAssetsRoot))).toBe(true);
    });

    it("throws if staging dir already exists", () => {
        createStagingDir(tmpAssetsRoot, "txn1");
        expect(() => createStagingDir(tmpAssetsRoot, "txn1")).toThrow(/already exists/);
    });

    it("rejects a symlinked staging root without creating transaction data outside assets", () => {
        const external = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-stage-external-"));
        try {
            fs.symlinkSync(external, resolveStagingRoot(tmpAssetsRoot));
            expect(() => createStagingDir(tmpAssetsRoot, "txn1")).toThrow(/symbolic|link/i);
            expect(fs.readdirSync(external)).toEqual([]);
        } finally {
            fs.rmSync(external, { recursive: true, force: true });
        }
    });

    it("creates one fresh staged Version directory and refuses to reuse it", () => {
        createStagingDir(tmpAssetsRoot, "txn1");
        const versionDir = createStagingVersionDir(tmpAssetsRoot, "txn1", VERSION_ID);
        expect(fs.statSync(versionDir).isDirectory()).toBe(true);
        expect(() => createStagingVersionDir(tmpAssetsRoot, "txn1", VERSION_ID)).toThrow(/already exists/);
    });
});

describe("commitNewAsset", () => {
    it("renames staging dir to <assetsRoot>/<assetId>", () => {
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        // plant a fake asset.json to simulate a built tree
        fs.writeFileSync(path.join(stagingDir, "asset.json"), "{}");
        commitNewAsset(tmpAssetsRoot, "txn1", ASSET_ID);
        expect(fs.existsSync(path.join(tmpAssetsRoot, ASSET_ID, "asset.json"))).toBe(true);
        expect(fs.existsSync(stagingDir)).toBe(false); // staging gone
    });

    it("refuses if target asset dir already exists", () => {
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        fs.mkdirSync(path.join(tmpAssetsRoot, ASSET_ID), { recursive: true });
        expect(() => commitNewAsset(tmpAssetsRoot, "txn1", ASSET_ID)).toThrow(/already exists/);
        // staging should still exist (commit refused, not consumed)
        expect(fs.existsSync(stagingDir)).toBe(true);
    });

    it("throws if staging dir is missing", () => {
        expect(() => commitNewAsset(tmpAssetsRoot, "nope", ASSET_ID)).toThrow(/staging dir missing/);
    });

    it("rejects a symlink inside the staged Asset tree without publishing it", () => {
        const outside = path.join(tmpAssetsRoot, "outside.txt");
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        fs.writeFileSync(outside, "outside");
        fs.symlinkSync(outside, path.join(stagingDir, "linked.txt"));

        expect(() => commitNewAsset(tmpAssetsRoot, "txn1", ASSET_ID)).toThrow(/symbolic[- ]link/u);
        expect(fs.existsSync(path.join(tmpAssetsRoot, ASSET_ID))).toBe(false);
        expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    });
});

describe("commitNewVersion", () => {
    it("renames staging version dir into existing asset's versions/", () => {
        // existing asset
        fs.mkdirSync(path.join(tmpAssetsRoot, ASSET_ID), { recursive: true });
        // staging with versions/<vId>/
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        const stagingVersionDir = path.join(stagingDir, "versions", VERSION_ID);
        fs.mkdirSync(stagingVersionDir, { recursive: true });
        fs.writeFileSync(path.join(stagingVersionDir, "version.json"), "{}");
        commitNewVersion(tmpAssetsRoot, "txn1", ASSET_ID, VERSION_ID);
        expect(fs.existsSync(path.join(tmpAssetsRoot, ASSET_ID, "versions", VERSION_ID, "version.json"))).toBe(true);
    });

    it("creates versions/ parent on the asset if missing", () => {
        fs.mkdirSync(path.join(tmpAssetsRoot, ASSET_ID), { recursive: true });
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        fs.mkdirSync(path.join(stagingDir, "versions", VERSION_ID), { recursive: true });
        // versions/ does not exist on the asset yet
        expect(() => commitNewVersion(tmpAssetsRoot, "txn1", ASSET_ID, VERSION_ID)).not.toThrow();
        expect(fs.existsSync(path.join(tmpAssetsRoot, ASSET_ID, "versions", VERSION_ID))).toBe(true);
    });

    it("skips mkdir when versions/ parent already exists", () => {
        fs.mkdirSync(path.join(tmpAssetsRoot, ASSET_ID, "versions"), { recursive: true });
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        fs.mkdirSync(path.join(stagingDir, "versions", VERSION_ID), { recursive: true });
        expect(() => commitNewVersion(tmpAssetsRoot, "txn1", ASSET_ID, VERSION_ID)).not.toThrow();
        expect(fs.existsSync(path.join(tmpAssetsRoot, ASSET_ID, "versions", VERSION_ID))).toBe(true);
    });

    it("leaves the staging dir in place after version commit (no auto-cleanup)", () => {
        // Per §8.4: residual staging dirs may be discarded outright at any time;
        // commitNewVersion does NOT auto-clean the staging dir. Explicit cleanup
        // is the caller's job (discardStaging / listResidualStaging).
        fs.mkdirSync(path.join(tmpAssetsRoot, ASSET_ID), { recursive: true });
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        fs.mkdirSync(path.join(stagingDir, "versions", VERSION_ID), { recursive: true });
        commitNewVersion(tmpAssetsRoot, "txn1", ASSET_ID, VERSION_ID);
        expect(fs.existsSync(stagingDir)).toBe(true); // left for explicit cleanup
        // version dir DID land
        expect(fs.existsSync(path.join(tmpAssetsRoot, ASSET_ID, "versions", VERSION_ID))).toBe(true);
    });

    it("refuses if target version dir already exists", () => {
        fs.mkdirSync(path.join(tmpAssetsRoot, ASSET_ID, "versions", VERSION_ID), { recursive: true });
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        fs.mkdirSync(path.join(stagingDir, "versions", VERSION_ID), { recursive: true });
        expect(() => commitNewVersion(tmpAssetsRoot, "txn1", ASSET_ID, VERSION_ID)).toThrow(/already exists/);
    });

    it("throws if staging version dir is missing", () => {
        fs.mkdirSync(path.join(tmpAssetsRoot, ASSET_ID), { recursive: true });
        createStagingDir(tmpAssetsRoot, "txn1");
        // no versions/<vId>/ planted
        expect(() => commitNewVersion(tmpAssetsRoot, "txn1", ASSET_ID, VERSION_ID)).toThrow(/staging version dir missing/);
    });

    it("rejects a symlinked versions parent without publishing outside the Asset", () => {
        const external = path.join(tmpAssetsRoot, "external");
        const assetRoot = path.join(tmpAssetsRoot, ASSET_ID);
        fs.mkdirSync(external);
        fs.mkdirSync(assetRoot);
        fs.symlinkSync(external, path.join(assetRoot, "versions"));
        const stagingDir = createStagingDir(tmpAssetsRoot, "txn1");
        const stagedVersion = path.join(stagingDir, "versions", VERSION_ID);
        fs.mkdirSync(stagedVersion, { recursive: true });
        fs.writeFileSync(path.join(stagedVersion, "version.json"), "{}");

        expect(() => commitNewVersion(tmpAssetsRoot, "txn1", ASSET_ID, VERSION_ID)).toThrow(/symbolic|link/i);
        expect(fs.existsSync(path.join(external, VERSION_ID))).toBe(false);
        expect(fs.existsSync(stagedVersion)).toBe(true);
    });
});

describe("discardStaging", () => {
    it("removes the staging dir", () => {
        createStagingDir(tmpAssetsRoot, "txn1");
        discardStaging(tmpAssetsRoot, "txn1");
        expect(fs.existsSync(resolveStagingDir(tmpAssetsRoot, "txn1"))).toBe(false);
    });

    it("is a no-op when staging dir missing", () => {
        expect(() => discardStaging(tmpAssetsRoot, "nope")).not.toThrow();
    });

    it("does not follow a symlinked staging root while discarding a transaction", () => {
        const external = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-staging-discard-outside-"));
        try {
            fs.mkdirSync(path.join(external, "txn1"));
            fs.writeFileSync(path.join(external, "txn1", "keep.txt"), "keep");
            fs.symlinkSync(external, resolveStagingRoot(tmpAssetsRoot));

            expect(() => discardStaging(tmpAssetsRoot, "txn1")).not.toThrow();
            expect(fs.readFileSync(path.join(external, "txn1", "keep.txt"), "utf-8")).toBe("keep");
        } finally {
            fs.rmSync(external, { recursive: true, force: true });
        }
    });
});

describe("listResidualStaging", () => {
    it("returns [] when staging root does not exist", () => {
        expect(listResidualStaging(tmpAssetsRoot)).toEqual([]);
    });

    it("lists staging txn dir names", () => {
        createStagingDir(tmpAssetsRoot, "txn1");
        createStagingDir(tmpAssetsRoot, "txn2");
        expect(listResidualStaging(tmpAssetsRoot).sort()).toEqual(["txn1", "txn2"]);
    });

    it("ignores non-directory entries in staging root", () => {
        fs.mkdirSync(resolveStagingRoot(tmpAssetsRoot), { recursive: true });
        fs.writeFileSync(path.join(resolveStagingRoot(tmpAssetsRoot), "stray.txt"), "x");
        expect(listResidualStaging(tmpAssetsRoot)).toEqual([]);
    });

    it("rejects a symlinked staging root instead of inventorying an outside directory", () => {
        const external = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-staging-list-outside-"));
        try {
            fs.mkdirSync(path.join(external, "foreign-txn"));
            fs.symlinkSync(external, resolveStagingRoot(tmpAssetsRoot));
            expect(() => listResidualStaging(tmpAssetsRoot)).toThrow(/symbolic|link/i);
        } finally {
            fs.rmSync(external, { recursive: true, force: true });
        }
    });
});

describe("newTxnId", () => {
    it("returns a UUID v4 string", () => {
        const id = newTxnId();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it("returns distinct ids on successive calls", () => {
        expect(newTxnId()).not.toBe(newTxnId());
    });
});

// ============================================================
// Path traversal tests (audit #7): unsafe txnId/assetId/versionId rejected
// ============================================================

describe("staging-commit: path traversal defense (audit #7)", () => {
    it("resolveStagingDir rejects unsafe txnId", () => {
        expect(() => resolveStagingDir(tmpAssetsRoot, "../escape")).toThrow(/safe single-segment/);
    });
    it("createStagingDir rejects unsafe txnId", () => {
        expect(() => createStagingDir(tmpAssetsRoot, "../escape")).toThrow(/safe single-segment/);
    });
    it("commitNewAsset rejects unsafe txnId", () => {
        expect(() => commitNewAsset(tmpAssetsRoot, "../escape", ASSET_ID)).toThrow(/txnId must be a safe single-segment/);
    });
    it("commitNewAsset rejects unsafe assetId", () => {
        // create a valid staging first so we get past the txnId check
        createStagingDir(tmpAssetsRoot, "txn-ok");
        expect(() => commitNewAsset(tmpAssetsRoot, "txn-ok", "../escape")).toThrow(/assetId must be a safe single-segment/);
    });
    it("commitNewVersion rejects unsafe versionId", () => {
        createStagingDir(tmpAssetsRoot, "txn-ok2");
        expect(() => commitNewVersion(tmpAssetsRoot, "txn-ok2", ASSET_ID, "../escape")).toThrow(
            /versionId must be a safe single-segment/,
        );
    });
    it("commitNewVersion rejects unsafe assetId", () => {
        createStagingDir(tmpAssetsRoot, "txn-ok3");
        expect(() => commitNewVersion(tmpAssetsRoot, "txn-ok3", "../escape", VERSION_ID)).toThrow(
            /assetId must be a safe single-segment/,
        );
    });
    it("commitNewVersion rejects unsafe txnId", () => {
        expect(() => commitNewVersion(tmpAssetsRoot, "../escape", ASSET_ID, VERSION_ID)).toThrow(
            /txnId must be a safe single-segment/,
        );
    });
    it("commits a staged Asset when transaction and Asset IDs are valid UUIDs", () => {
        const txnId = newTxnId();
        const stagingDir = createStagingDir(tmpAssetsRoot, txnId);
        fs.writeFileSync(path.join(stagingDir, "asset.json"), "{}\n");

        commitNewAsset(tmpAssetsRoot, txnId, ASSET_ID);

        expect(fs.readFileSync(path.join(tmpAssetsRoot, ASSET_ID, "asset.json"), "utf8")).toBe("{}\n");
        expect(fs.existsSync(stagingDir)).toBe(false);
    });
});
