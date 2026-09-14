import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceGraph } from "../repository/workspace-graph.mjs";
import { ROOT_DIR, walkDir } from "./architecture-test-fixtures";

const SHARED_ROOT = path.join(ROOT_DIR, "packages/shared");
const SHARED_SOURCE_ROOT = path.join(SHARED_ROOT, "src");
const LEGACY_SHARED_PACKAGES = ["@oaam/shared-fs-utils", "@oaam/shared-unix-paths", "@oaam/shared-win-paths"] as const;

function readJson(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

describe("target-built Shared boundary", () => {
    it("has one workspace and two explicit public subpaths without a root export", () => {
        const graph = resolveWorkspaceGraph(ROOT_DIR);
        expect(graph.packages.filter((workspacePackage) => workspacePackage.relativePath.startsWith("packages/shared"))).toEqual([
            expect.objectContaining({ name: "@oaam/shared", relativePath: "packages/shared" }),
        ]);

        const manifest = readJson(path.join(SHARED_ROOT, "package.json"));
        expect(manifest.main).toBe("./dist/paths/unix-like/filesystem-target-entry.js");
        expect(manifest.types).toBe("./dist/paths/unix-like/filesystem-target-entry.d.ts");
        expect(manifest.exports).toEqual({
            "./filesystem": {
                types: "./dist/paths/unix-like/filesystem-target-entry.d.ts",
                require: "./dist/paths/unix-like/filesystem-target-entry.js",
                default: "./dist/paths/unix-like/filesystem-target-entry.js",
            },
            "./paths": {
                types: "./dist/paths/unix-like/path-environment.d.ts",
                require: "./dist/paths/unix-like/path-environment.js",
                default: "./dist/paths/unix-like/path-environment.js",
            },
        });
        expect((manifest.exports as Record<string, unknown>)["."]).toBeUndefined();
    });

    it("delivers only the selected Unix-like path implementation", () => {
        const manifest = readJson(path.join(SHARED_ROOT, "package.json"));
        expect(manifest.files).toEqual([
            "dist/filesystem",
            "dist/paths/committed-sqlite-snapshot.js",
            "dist/paths/committed-sqlite-snapshot.js.map",
            "dist/paths/committed-sqlite-snapshot.d.ts",
            "dist/paths/committed-sqlite-snapshot.d.ts.map",
            "dist/paths/directory-member-observation.js",
            "dist/paths/directory-member-observation.js.map",
            "dist/paths/directory-member-observation.d.ts",
            "dist/paths/directory-member-observation.d.ts.map",
            "dist/paths/linux-mutation-framing.js",
            "dist/paths/linux-mutation-framing.js.map",
            "dist/paths/linux-mutation-framing.d.ts",
            "dist/paths/linux-mutation-framing.d.ts.map",
            "dist/paths/packaged-worker-path.js",
            "dist/paths/packaged-worker-path.js.map",
            "dist/paths/packaged-worker-path.d.ts",
            "dist/paths/packaged-worker-path.d.ts.map",
            "dist/paths/path-environment.js",
            "dist/paths/path-environment.js.map",
            "dist/paths/path-environment.d.ts",
            "dist/paths/path-environment.d.ts.map",
            "dist/paths/physical-access-paths.js",
            "dist/paths/physical-access-paths.js.map",
            "dist/paths/physical-access-paths.d.ts",
            "dist/paths/physical-access-paths.d.ts.map",
            "dist/paths/selected-wsl-path-projection.js",
            "dist/paths/selected-wsl-path-projection.js.map",
            "dist/paths/selected-wsl-path-projection.d.ts",
            "dist/paths/selected-wsl-path-projection.d.ts.map",
            "dist/paths/wsl-distro-discovery.js",
            "dist/paths/wsl-distro-discovery.js.map",
            "dist/paths/wsl-distro-discovery.d.ts",
            "dist/paths/wsl-distro-discovery.d.ts.map",
            "dist/paths/unix-like",
        ]);
        const publicPathEntry = fs.readFileSync(path.join(SHARED_SOURCE_ROOT, "paths/unix-like/path-environment.ts"), "utf8");
        expect(publicPathEntry).toContain('from "../path-environment"');
        expect(publicPathEntry).not.toMatch(/OAAM_PLATFORM|from\s+["']\.\.\/win32["']/u);
        expect((manifest.files as string[]).some((filePath) => filePath.includes("win32") || filePath.endsWith(".node"))).toBe(
            false,
        );
    });

    it("binds both public surfaces through compile-time contracts and keeps OS mechanics in private target roots", () => {
        const filesystemEntry = fs.readFileSync(
            path.join(SHARED_SOURCE_ROOT, "paths/unix-like/filesystem-target-entry.ts"),
            "utf8",
        );
        const pathsEntry = fs.readFileSync(path.join(SHARED_SOURCE_ROOT, "paths/unix-like/path-environment.ts"), "utf8");
        expect(filesystemEntry).toContain("PhysicalFilesystemBackend");
        expect(filesystemEntry).toContain("unixLikePhysicalFilesystemBackend");
        expect(pathsEntry).toContain("PathEnvironment");
        expect(pathsEntry).toContain("getHomeDir");
        expect(pathsEntry).toContain("observeLocalProcessBounded");
        const windowsPathsEntry = fs.readFileSync(path.join(SHARED_SOURCE_ROOT, "paths/win32/path-environment.ts"), "utf8");
        for (const entry of [pathsEntry, windowsPathsEntry]) {
            expect(entry).toContain("observeLocalProcessBounded");
            expect(entry).toContain("invokeLocalExecutableTreeBounded");
            expect(entry).toContain("observeSelectedWslProcessLifecycleBounded");
            expect(entry).toContain("observeSelectedWslProcessLifecyclePairBounded");
            for (const retired of [
                "observeSelectedWslExecutableProcessesBounded",
                "invokeSelectedWslExecutableWithProcessProfileBounded",
                "invokeSelectedWslExecutableTreeBounded",
                "observeSelectedWslBatchBounded",
            ]) {
                expect(entry).not.toContain(retired);
            }
        }

        const publicFilesystemFiles = walkDir(path.join(SHARED_SOURCE_ROOT, "filesystem"));
        expect(publicFilesystemFiles.map((filePath) => path.basename(filePath)).sort()).toEqual([
            "filesystem-facts.ts",
            "filesystem-types.ts",
            "physical-filesystem-backend.ts",
            "regular-file-read-batch.ts",
        ]);
        expect(
            publicFilesystemFiles
                .filter((filePath) => /from\s+["']node:(?:fs|path|os|child_process)["']/u.test(fs.readFileSync(filePath, "utf8")))
                .map((filePath) => path.relative(ROOT_DIR, filePath)),
        ).toEqual([]);

        const nativeLoaderOwners = walkDir(SHARED_SOURCE_ROOT)
            .filter((filePath) => fs.readFileSync(filePath, "utf8").includes("oaam_windows_filesystem.node"))
            .map((filePath) => path.relative(ROOT_DIR, filePath).split(path.sep).join("/"));
        expect(nativeLoaderOwners).toEqual(["packages/shared/src/paths/win32/native-addon.ts"]);
        const linuxLockLoaderOwners = walkDir(SHARED_SOURCE_ROOT)
            .filter((filePath) => fs.readFileSync(filePath, "utf8").includes("oaam_file_lock.node"))
            .map((filePath) => path.relative(ROOT_DIR, filePath).split(path.sep).join("/"));
        expect(linuxLockLoaderOwners).toEqual(["packages/shared/src/paths/unix-like/file-lock.ts"]);
        for (const publicEntry of ["paths/unix-like/filesystem-target-entry.ts", "paths/unix-like/path-environment.ts"]) {
            expect(fs.readFileSync(path.join(SHARED_SOURCE_ROOT, publicEntry), "utf8")).not.toMatch(
                /file-lock|acquireLinuxFileLock/u,
            );
        }

        const misplacedTargetFiles = walkDir(SHARED_SOURCE_ROOT)
            .map((filePath) => path.relative(SHARED_SOURCE_ROOT, filePath).split(path.sep).join("/"))
            .filter(
                (filePath) =>
                    /(?:^|\/)(?:win32|unix-like)(?:\/|-)/u.test(filePath) &&
                    !filePath.startsWith("paths/win32/") &&
                    !filePath.startsWith("paths/unix-like/"),
            );
        expect(misplacedTargetFiles).toEqual([]);
    });

    it("removes legacy package identities, runtime capability switches, and Shared authority naming", () => {
        const graph = resolveWorkspaceGraph(ROOT_DIR);
        const governedFiles = graph.packages.flatMap((workspacePackage) => [
            path.join(ROOT_DIR, workspacePackage.relativePath, "package.json"),
            ...walkDir(path.join(ROOT_DIR, workspacePackage.relativePath, "src")),
        ]);
        for (const legacyPackage of LEGACY_SHARED_PACKAGES) {
            const violators = governedFiles.filter((filePath) => fs.readFileSync(filePath, "utf8").includes(legacyPackage));
            expect(
                violators.map((filePath) => path.relative(ROOT_DIR, filePath)),
                legacyPackage,
            ).toEqual([]);
        }

        const sharedSources = walkDir(SHARED_SOURCE_ROOT);
        const retiredSwitches = /\b(?:supportsDescriptorSafeFilesystem|getSupportedPlatforms|detectPlatform)\b/u;
        expect(sharedSources.filter((filePath) => retiredSwitches.test(fs.readFileSync(filePath, "utf8")))).toEqual([]);
        expect(sharedSources.filter((filePath) => /authority/iu.test(path.basename(filePath)))).toEqual([]);
        const exportedAuthority = sharedSources.filter((filePath) =>
            /export\s+(?:(?:declare|abstract)\s+)*(?:class|function|interface|type|const|let|var)\s+\w*authority\w*/iu.test(
                fs.readFileSync(filePath, "utf8"),
            ),
        );
        expect(exportedAuthority.map((filePath) => path.relative(ROOT_DIR, filePath))).toEqual([]);
    });
});
