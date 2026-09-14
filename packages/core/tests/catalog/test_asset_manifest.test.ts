import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    validateAssetManifest,
    serializeAssetManifest,
    parseAssetManifest,
    resolveAssetRoot,
    readAssetManifest,
    writeAssetManifest,
    appendVersionId,
    detectOrphanVersions,
} from "../../src/catalog/asset-manifest";
import type { AssetManifestV1 } from "../../src/types";

let tmpAssetsRoot: string;

beforeEach(() => {
    tmpAssetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-asset-"));
});

afterEach(() => {
    fs.rmSync(tmpAssetsRoot, { recursive: true, force: true });
});

const UUID = "00000000-0000-4000-8000-000000000001";
const UUID2 = "00000000-0000-4000-8000-000000000002";
const PROJECT_UUID = "11111111-1111-4111-8111-111111111111";

function mkValid(overrides: Partial<AssetManifestV1> = {}): AssetManifestV1 {
    return {
        schemaVersion: 1,
        assetId: UUID,
        kind: "Skill",
        scope: "project",
        projectId: PROJECT_UUID,
        scopePath: "packages/core",
        displayName: "my-skill",
        displayDescription: "",
        versionIds: [UUID2],
        deleted: false,
        createdAt: 1000,
        updatedAt: 1000,
        ...overrides,
    };
}

describe("validateAssetManifest: valid cases", () => {
    it("accepts a project-scoped asset", () => {
        expect(validateAssetManifest(mkValid()).ok).toBe(true);
    });

    it("accepts a global-scoped asset with empty projectId/scopePath", () => {
        const m = mkValid({ scope: "global", projectId: "", scopePath: "" });
        expect(validateAssetManifest(m).ok).toBe(true);
    });

    it("accepts project asset at project root (scopePath empty)", () => {
        const m = mkValid({ scopePath: "" });
        expect(validateAssetManifest(m).ok).toBe(true);
    });

    it("accepts empty displayDescription", () => {
        const m = mkValid({ displayDescription: "" });
        expect(validateAssetManifest(m).ok).toBe(true);
    });

    it("accepts multiple versionIds", () => {
        const m = mkValid({ versionIds: [UUID2, "22222222-2222-4222-8222-222222222222"] });
        expect(validateAssetManifest(m).ok).toBe(true);
    });
});

describe("validateAssetManifest: structural errors", () => {
    it("rejects wrong schemaVersion", () => {
        expect(validateAssetManifest(mkValid({ schemaVersion: 2 as 1 })).ok).toBe(false);
    });

    it("rejects non-UUID assetId", () => {
        expect(validateAssetManifest(mkValid({ assetId: "x" })).ok).toBe(false);
    });

    it("rejects invalid kind", () => {
        expect(validateAssetManifest(mkValid({ kind: "AgentRule" as never })).ok).toBe(false);
    });

    it("rejects invalid scope", () => {
        expect(validateAssetManifest(mkValid({ scope: "system" as never })).ok).toBe(false);
    });
});

describe("validateAssetManifest: scope combos", () => {
    it("rejects global with non-empty projectId", () => {
        expect(validateAssetManifest(mkValid({ scope: "global", projectId: PROJECT_UUID, scopePath: "" })).ok).toBe(false);
    });

    it("rejects global with non-empty scopePath", () => {
        expect(validateAssetManifest(mkValid({ scope: "global", projectId: "", scopePath: "x" })).ok).toBe(false);
    });

    it("rejects project with non-UUID projectId", () => {
        expect(validateAssetManifest(mkValid({ scope: "project", projectId: "not-uuid" })).ok).toBe(false);
    });

    it("rejects project with empty projectId", () => {
        expect(validateAssetManifest(mkValid({ scope: "project", projectId: "" })).ok).toBe(false);
    });

    it("rejects scopePath with '..'", () => {
        expect(validateAssetManifest(mkValid({ scopePath: "../escape" })).ok).toBe(false);
    });

    it("rejects scopePath with '.'", () => {
        expect(validateAssetManifest(mkValid({ scopePath: "./x" })).ok).toBe(false);
    });

    it("rejects absolute scopePath", () => {
        expect(validateAssetManifest(mkValid({ scopePath: "/abs" })).ok).toBe(false);
    });

    it("rejects backslash scopePath", () => {
        expect(validateAssetManifest(mkValid({ scopePath: "a\\b" })).ok).toBe(false);
    });

    it("rejects trailing-slash scopePath", () => {
        expect(validateAssetManifest(mkValid({ scopePath: "dir/" })).ok).toBe(false);
    });
});

describe("validateAssetManifest: display + versionIds + time", () => {
    it("rejects empty displayName", () => {
        expect(validateAssetManifest(mkValid({ displayName: "" })).ok).toBe(false);
    });

    it("rejects whitespace-only displayName", () => {
        expect(validateAssetManifest(mkValid({ displayName: "   " })).ok).toBe(false);
    });

    it("rejects empty versionIds", () => {
        expect(validateAssetManifest(mkValid({ versionIds: [] })).ok).toBe(false);
    });

    it("rejects versionIds containing non-UUID", () => {
        expect(validateAssetManifest(mkValid({ versionIds: ["x"] })).ok).toBe(false);
    });

    it("rejects duplicate versionIds", () => {
        expect(validateAssetManifest(mkValid({ versionIds: [UUID2, UUID2] })).ok).toBe(false);
    });

    it("rejects non-boolean deleted", () => {
        expect(validateAssetManifest(mkValid({ deleted: "true" as unknown as boolean })).ok).toBe(false);
    });

    it("rejects negative createdAt", () => {
        expect(validateAssetManifest(mkValid({ createdAt: -1 })).ok).toBe(false);
    });

    it("rejects non-integer createdAt", () => {
        expect(validateAssetManifest(mkValid({ createdAt: 1.5 })).ok).toBe(false);
    });

    it("rejects updatedAt < createdAt", () => {
        expect(validateAssetManifest(mkValid({ createdAt: 1000, updatedAt: 500 })).ok).toBe(false);
    });

    it("rejects non-string displayDescription", () => {
        expect(validateAssetManifest(mkValid({ displayDescription: 5 as unknown as string })).ok).toBe(false);
    });

    it("rejects non-string scopePath", () => {
        expect(validateAssetManifest(mkValid({ scopePath: 5 as unknown as string })).ok).toBe(false);
    });

    it("rejects updatedAt non-integer", () => {
        expect(validateAssetManifest(mkValid({ updatedAt: 1.5 })).ok).toBe(false);
    });

    it("rejects updatedAt negative", () => {
        expect(validateAssetManifest(mkValid({ updatedAt: -1 })).ok).toBe(false);
    });

    it("rejects non-array versionIds", () => {
        expect(validateAssetManifest(mkValid({ versionIds: "x" as unknown as string[] })).ok).toBe(false);
    });
});

describe("serializeAssetManifest + parseAssetManifest", () => {
    it("roundtrips a valid manifest", () => {
        const m = mkValid();
        const json = serializeAssetManifest(m);
        expect(parseAssetManifest(json)).toEqual(m);
    });

    it("serialize throws on undefined field", () => {
        const m = mkValid();
        (m as unknown as { changeNote: undefined }).displayName = undefined;
        expect(() => serializeAssetManifest(m)).toThrow(/undefined/);
    });

    it("serialize rejects a semantically invalid authority manifest", () => {
        expect(() => serializeAssetManifest(mkValid({ updatedAt: -1 }))).toThrow(/non-negative/);
    });

    it("parse throws on non-object", () => {
        expect(() => parseAssetManifest("[]")).toThrow(/must be an object/);
        expect(() => parseAssetManifest("null")).toThrow(/must be an object/);
    });

    it("parse throws on missing field", () => {
        const m = mkValid();
        const obj = JSON.parse(serializeAssetManifest(m));
        delete obj.displayName;
        expect(() => parseAssetManifest(JSON.stringify(obj))).toThrow(/missing required field: displayName/);
    });

    it("parse throws on invalid JSON", () => {
        expect(() => parseAssetManifest("{bad")).toThrow();
    });

    it("parse rejects a strict-shaped but semantically invalid authority manifest", () => {
        const invalid = { ...mkValid(), scope: "elsewhere" };
        expect(() => parseAssetManifest(JSON.stringify(invalid))).toThrow(/global\|project/);
    });
});

describe("resolveAssetRoot + read/write", () => {
    it("resolveAssetRoot joins assetsRoot + assetId", () => {
        expect(resolveAssetRoot(tmpAssetsRoot, UUID)).toBe(path.join(tmpAssetsRoot, UUID));
    });

    it("write then read roundtrip", () => {
        const m = mkValid();
        writeAssetManifest(tmpAssetsRoot, m);
        const read = readAssetManifest(tmpAssetsRoot, UUID);
        expect(read).toEqual(m);
    });

    it("write creates asset dir if missing", () => {
        const m = mkValid();
        writeAssetManifest(tmpAssetsRoot, m);
        expect(fs.existsSync(path.join(tmpAssetsRoot, UUID, "asset.json"))).toBe(true);
    });

    it("write works when asset dir already exists (no mkdir needed)", () => {
        fs.mkdirSync(path.join(tmpAssetsRoot, UUID), { recursive: true });
        const m = mkValid();
        writeAssetManifest(tmpAssetsRoot, m);
        expect(fs.existsSync(path.join(tmpAssetsRoot, UUID, "asset.json"))).toBe(true);
    });

    it("write rejects a symlinked Asset directory without touching its target", () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-asset-outside-"));
        try {
            fs.symlinkSync(outside, path.join(tmpAssetsRoot, UUID));
            expect(() => writeAssetManifest(tmpAssetsRoot, mkValid())).toThrow(/symbolic|link/i);
            expect(fs.readdirSync(outside)).toEqual([]);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it("read returns null when missing", () => {
        expect(readAssetManifest(tmpAssetsRoot, UUID)).toBeNull();
    });
});

describe("appendVersionId", () => {
    it("appends a new versionId and bumps updatedAt", () => {
        const m = mkValid({ versionIds: [UUID2], updatedAt: 1000 });
        const newVid = "33333333-3333-4333-8333-333333333333";
        const result = appendVersionId(m, newVid, 2000);
        expect(result.versionIds).toEqual([UUID2, newVid]);
        expect(result.updatedAt).toBe(2000);
    });

    it("is idempotent when versionId is already last", () => {
        const m = mkValid({ versionIds: [UUID2], updatedAt: 1000 });
        const result = appendVersionId(m, UUID2, 2000);
        expect(result).toBe(m); // unchanged reference, no updatedAt bump
    });

    it("moves an existing mid-list versionId to end (becomes current)", () => {
        const v1 = UUID2;
        const v2 = "33333333-3333-4333-8333-333333333333";
        const m = mkValid({ versionIds: [v1, v2], updatedAt: 1000 });
        const result = appendVersionId(m, v1, 2000);
        expect(result.versionIds).toEqual([v2, v1]);
        expect(result.updatedAt).toBe(2000);
    });
});

describe("detectOrphanVersions", () => {
    it("returns [] when versions dir does not exist", () => {
        const m = mkValid();
        expect(detectOrphanVersions(tmpAssetsRoot, m)).toEqual([]);
    });

    it("returns version dirs not in manifest versionIds", () => {
        const m = mkValid({ versionIds: [UUID2] });
        const assetRoot = resolveAssetRoot(tmpAssetsRoot, UUID);
        const versionsDir = path.join(assetRoot, "versions");
        fs.mkdirSync(path.join(versionsDir, UUID2), { recursive: true });
        fs.mkdirSync(path.join(versionsDir, "orphan-uuid-not-in-list"), { recursive: true });
        expect(detectOrphanVersions(tmpAssetsRoot, m)).toEqual(["orphan-uuid-not-in-list"]);
    });

    it("ignores non-directory entries in versions/", () => {
        const m = mkValid({ versionIds: [UUID2] });
        const assetRoot = resolveAssetRoot(tmpAssetsRoot, UUID);
        const versionsDir = path.join(assetRoot, "versions");
        fs.mkdirSync(versionsDir, { recursive: true });
        fs.writeFileSync(path.join(versionsDir, "stray-file.txt"), "x");
        expect(detectOrphanVersions(tmpAssetsRoot, m)).toEqual(["stray-file.txt"].filter(() => false));
        // stray-file is not a directory, should be filtered out → []
    });

    it("fails closed when the versions authority path is a symlink", () => {
        const m = mkValid({ versionIds: [UUID2] });
        const assetRoot = resolveAssetRoot(tmpAssetsRoot, UUID);
        fs.mkdirSync(assetRoot, { recursive: true });
        fs.symlinkSync(tmpAssetsRoot, path.join(assetRoot, "versions"));
        expect(() => detectOrphanVersions(tmpAssetsRoot, m)).toThrow(/symbolic|link/i);
    });
});

// ============================================================
// Strict-behavior tests (audit #3/#4/#7): extra keys, null, malformed,
// never-throws, path-traversal on read/write
// ============================================================

describe("validateAssetManifest: strict + defensive (audit #3/#4)", () => {
    it("rejects extra top-level key", () => {
        const m = mkValid();
        (m as unknown as { extra: string }).extra = "x";
        const r = validateAssetManifest(m);
        expect(r.ok).toBe(false);
        expect(r.diagnostics.some((d) => d.code === "asset.strict")).toBe(true);
    });

    it("returns diagnostics (does NOT throw) when manifest is null", () => {
        const r = validateAssetManifest(null);
        expect(r.ok).toBe(false);
        expect(r.diagnostics.some((d) => d.code === "asset.shape")).toBe(true);
    });

    it("returns diagnostics (does NOT throw) when manifest is an array", () => {
        const r = validateAssetManifest([] as unknown);
        expect(r.ok).toBe(false);
        expect(r.diagnostics.some((d) => d.code === "asset.shape")).toBe(true);
    });
});

describe("parseAssetManifest: strict extra-key rejection (audit #3)", () => {
    it("throws on extra key", () => {
        const m = mkValid();
        const obj = JSON.parse(serializeAssetManifest(m));
        obj.extra = "x";
        expect(() => parseAssetManifest(JSON.stringify(obj))).toThrow(/undeclared field: extra/);
    });
});

describe("readAssetManifest / writeAssetManifest / resolveAssetRoot: path traversal (audit #7)", () => {
    it("resolveAssetRoot rejects unsafe assetId", () => {
        expect(() => resolveAssetRoot(tmpAssetsRoot, "../escape")).toThrow(/safe single-segment/);
    });
    it("readAssetManifest rejects unsafe assetId", () => {
        expect(() => readAssetManifest(tmpAssetsRoot, "../escape")).toThrow(/safe single-segment/);
    });
    it("writeAssetManifest rejects unsafe assetId", () => {
        const m = mkValid();
        m.assetId = "../escape" as never;
        expect(() => writeAssetManifest(tmpAssetsRoot, m)).toThrow(/safe single-segment/);
    });
    it("detectOrphanVersions rejects unsafe assetId", () => {
        const m = mkValid();
        m.assetId = "../escape" as never;
        expect(() => detectOrphanVersions(tmpAssetsRoot, m)).toThrow(/safe single-segment/);
    });
});

describe("validateAssetManifest: scopePath NUL (audit round 2)", () => {
    it("rejects scopePath with embedded NUL", () => {
        expect(validateAssetManifest(mkValid({ scopePath: "a\0b" })).ok).toBe(false);
    });
});
