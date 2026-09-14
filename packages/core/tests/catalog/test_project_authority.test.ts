import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    acquireProjectAuthorityLocks,
    acquireProjectCatalogLock,
    inventoryProjectAuthorityIds,
    parseProjectManifest,
    projectManifestAuthorityFingerprint,
    readProjectManifest,
    resolveProjectRoot,
    serializeProjectManifest,
    validateProjectManifest,
    writeProjectManifest,
} from "../../src/catalog/project-authority";
import { resolveActiveProjectIdByRoot } from "../../src/orchestration/core-project-service";
import type { ProjectManifestV1, UuidV4 } from "../../src/types";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001" as UuidV4;
const OTHER_ID = "00000000-0000-4000-8000-000000000002" as UuidV4;

let sandbox = "";
let oaamRoot = "";
let projectsRoot = "";
let locksRoot = "";
let projectPath = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-project-authority-"));
    oaamRoot = path.join(sandbox, "oaam");
    projectsRoot = path.join(oaamRoot, "projects");
    locksRoot = path.join(oaamRoot, "transactions", "authority-locks");
    projectPath = path.join(sandbox, "workspace");
    fs.mkdirSync(oaamRoot, { recursive: true });
    fs.mkdirSync(path.join(oaamRoot, "transactions"));
    fs.mkdirSync(projectPath);
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function manifest(overrides: Partial<ProjectManifestV1> = {}): ProjectManifestV1 {
    return {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        rootPath: projectPath,
        displayName: "Project",
        deleted: false,
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

describe("Project manifest authority", () => {
    it("round-trips a strict deterministic manifest and inventories UTF-8 identities", () => {
        const value = manifest();
        const json = serializeProjectManifest(value);
        expect(json.endsWith("\n")).toBe(true);
        expect(parseProjectManifest(json)).toEqual(value);
        expect(projectManifestAuthorityFingerprint(value)).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(projectManifestAuthorityFingerprint(value)).toBe(projectManifestAuthorityFingerprint(parseProjectManifest(json)));
        expect(projectManifestAuthorityFingerprint({ ...value, displayName: "Changed" })).not.toBe(
            projectManifestAuthorityFingerprint(value),
        );
        writeProjectManifest(projectsRoot, value);
        writeProjectManifest(projectsRoot, manifest({ projectId: OTHER_ID }));
        expect(readProjectManifest(projectsRoot, PROJECT_ID)).toEqual(value);
        expect(inventoryProjectAuthorityIds(projectsRoot)).toEqual([PROJECT_ID, OTHER_ID]);
        expect(resolveProjectRoot(projectsRoot, PROJECT_ID)).toBe(path.join(projectsRoot, PROJECT_ID));
    });

    it("reports missing roots and rejects an enclosing-directory identity mismatch", () => {
        expect(readProjectManifest(projectsRoot, PROJECT_ID)).toBeNull();
        expect(inventoryProjectAuthorityIds(projectsRoot)).toEqual([]);
        writeProjectManifest(projectsRoot, manifest());
        const source = path.join(projectsRoot, PROJECT_ID, "project.json");
        const targetRoot = path.join(projectsRoot, OTHER_ID);
        fs.mkdirSync(targetRoot);
        fs.copyFileSync(source, path.join(targetRoot, "project.json"));
        expect(() => readProjectManifest(projectsRoot, OTHER_ID)).toThrow(/directory identity/);
        expect(() => resolveProjectRoot(projectsRoot, "bad" as UuidV4)).toThrow(/UUID v4/);
    });

    it("rejects every strict field family instead of normalizing corrupt authority", () => {
        expect(validateProjectManifest(null).ok).toBe(false);
        const cases: unknown[] = [
            { ...manifest(), extra: true },
            (() => {
                const value = { ...manifest() } as Record<string, unknown>;
                delete value.displayName;
                return value;
            })(),
            { ...manifest(), schemaVersion: 2 },
            { ...manifest(), projectId: "bad" },
            { ...manifest(), rootPath: "relative" },
            { ...manifest(), rootPath: path.parse(projectPath).root },
            { ...manifest(), rootPath: `${projectPath}${path.sep}` },
            { ...manifest(), rootPath: `${projectPath}\0bad` },
            { ...manifest(), displayName: " " },
            { ...manifest(), displayName: 1 },
            { ...manifest(), deleted: 0 },
            { ...manifest(), createdAt: -1 },
            { ...manifest(), updatedAt: -1 },
            { ...manifest(), createdAt: 3, updatedAt: 2 },
        ];
        for (const value of cases) {
            expect(validateProjectManifest(value).ok, JSON.stringify(value)).toBe(false);
        }
        expect(() => parseProjectManifest("{bad")).toThrow();
        expect(() => parseProjectManifest(JSON.stringify({ ...manifest(), deleted: 0 }))).toThrow(/deleted/);
        expect(() => serializeProjectManifest(cases[2] as ProjectManifestV1)).toThrow();

        fs.rmSync(projectsRoot, { recursive: true, force: true });
        fs.writeFileSync(projectsRoot, "not-a-directory");
        expect(() => inventoryProjectAuthorityIds(projectsRoot)).toThrow();
    });

    it("serializes Project and catalog locks and releases them deterministically", () => {
        const releaseProject = acquireProjectAuthorityLocks(locksRoot, [OTHER_ID, PROJECT_ID]);
        expect(() => acquireProjectAuthorityLocks(locksRoot, [PROJECT_ID])).toThrow(/locked/);
        releaseProject();
        expect(() => acquireProjectAuthorityLocks(locksRoot, ["bad" as UuidV4])).toThrow(/UUID v4/);

        const releaseCatalog = acquireProjectCatalogLock(locksRoot);
        expect(() => acquireProjectCatalogLock(locksRoot)).toThrow(/locked/);
        releaseCatalog();
        const releaseAgain = acquireProjectCatalogLock(locksRoot);
        releaseAgain();
    });

    it("resolves one active Project root and rejects duplicate active ownership", () => {
        expect(resolveActiveProjectIdByRoot(projectsRoot, projectPath)).toBeNull();
        writeProjectManifest(projectsRoot, manifest());
        expect(resolveActiveProjectIdByRoot(projectsRoot, projectPath)).toBe(PROJECT_ID);
        writeProjectManifest(projectsRoot, manifest({ projectId: OTHER_ID, displayName: "Duplicate" }));
        expect(() => resolveActiveProjectIdByRoot(projectsRoot, projectPath)).toThrow(/multiple active Projects/);
        writeProjectManifest(projectsRoot, manifest({ projectId: OTHER_ID, deleted: true }));
        expect(resolveActiveProjectIdByRoot(projectsRoot, projectPath)).toBe(PROJECT_ID);
    });
});
