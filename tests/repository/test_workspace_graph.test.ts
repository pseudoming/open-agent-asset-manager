import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DIRECTORY_SYMLINK_SUPPORTED } from "./filesystem-test-capabilities.mjs";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function createRepository(workspaces: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-workspace-graph-"));
    temporaryRoots.push(root);
    fs.writeFileSync(
        path.join(root, "package.json"),
        `${JSON.stringify({ name: "fixture-root", private: true, workspaces }, null, 2)}\n`,
    );
    return root;
}

function writeWorkspace(
    root: string,
    relativePath: string,
    name: string,
    dependencies: Record<string, string> = {},
    extra: Record<string, unknown> = {},
): void {
    const workspaceRoot = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(
        path.join(workspaceRoot, "package.json"),
        `${JSON.stringify(
            {
                name,
                version: "0.1.0",
                scripts: { build: "tsc" },
                dependencies,
                ...extra,
            },
            null,
            2,
        )}\n`,
    );
}

describe("live workspace graph authority", () => {
    it("derives exact and wildcard workspaces in stable dependency-first order", () => {
        const root = createRepository(["packages/core", "packages/shared/*", "packages/adapter/*"]);
        writeWorkspace(root, "packages/shared/fs", "@oaam/shared-fs");
        writeWorkspace(root, "packages/core", "@oaam/core", {
            "@oaam/shared-fs": "^0.1.0",
        });
        writeWorkspace(root, "packages/adapter/zeta", "@oaam/adapter-zeta", {
            "@oaam/core": "^0.1.0",
        });
        writeWorkspace(root, "packages/adapter/alpha", "@oaam/adapter-alpha", {
            "@oaam/core": "^0.1.0",
        });

        const graph = resolveWorkspaceGraph(root);
        expect(graph.packages.map((entry) => entry.name)).toEqual([
            "@oaam/adapter-alpha",
            "@oaam/adapter-zeta",
            "@oaam/core",
            "@oaam/shared-fs",
        ]);
        expect(graph.topologicalPackages.map((entry) => entry.name)).toEqual([
            "@oaam/shared-fs",
            "@oaam/core",
            "@oaam/adapter-alpha",
            "@oaam/adapter-zeta",
        ]);
        expect(graph.packages.find((entry) => entry.name === "@oaam/core")).toMatchObject({
            internalDependencyNames: ["@oaam/shared-fs"],
            internalDeliveryDependencyNames: ["@oaam/shared-fs"],
            relativePath: "packages/core",
        });
        expect(graph.packages.find((entry) => entry.name === "@oaam/core")?.packageBins).toEqual({});
    });

    it("discovers the current repository without a copied package inventory", () => {
        const graph = resolveWorkspaceGraph(process.cwd());
        expect(graph.workspacePatterns).toEqual(
            JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).workspaces,
        );
        expect(new Set(graph.topologicalPackages.map((entry) => entry.name))).toEqual(
            new Set(graph.packages.map((entry) => entry.name)),
        );
        expect(graph.packages.length).toBeGreaterThan(0);
    });

    it("rejects unsafe or unsupported workspace patterns", () => {
        for (const workspacePattern of [
            "../packages/core",
            "/packages/core",
            "packages\\core",
            "packages/**",
            "packages/*/nested",
            "packages/[ab]",
        ]) {
            const root = createRepository([workspacePattern]);
            expect(() => resolveWorkspaceGraph(root), workspacePattern).toThrow(/workspace pattern/u);
        }
    });

    it("rejects missing exact manifests and wildcard children without manifests", () => {
        const missingExact = createRepository(["packages/core"]);
        fs.mkdirSync(path.join(missingExact, "packages", "core"), { recursive: true });
        expect(() => resolveWorkspaceGraph(missingExact)).toThrow(/missing package\.json/u);

        const missingWildcardManifest = createRepository(["packages/shared/*"]);
        fs.mkdirSync(path.join(missingWildcardManifest, "packages", "shared", "orphan"), {
            recursive: true,
        });
        expect(() => resolveWorkspaceGraph(missingWildcardManifest)).toThrow(/packages\/shared\/orphan: missing package\.json/u);
    });

    it.skipIf(!DIRECTORY_SYMLINK_SUPPORTED)(
        "rejects an intermediate symlink that moves a workspace outside the repository",
        () => {
            const root = createRepository(["packages/example"]);
            const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-workspace-external-"));
            temporaryRoots.push(externalRoot);
            writeWorkspace(externalRoot, "example", "@oaam/example");
            fs.symlinkSync(externalRoot, path.join(root, "packages"), "dir");

            expect(() => resolveWorkspaceGraph(root)).toThrow(
                /workspace pattern packages\/example: symlinked workspace directories are not allowed/u,
            );
        },
    );

    it("rejects a workspace selected by overlapping patterns", () => {
        const root = createRepository(["packages/shared/*", "packages/shared/fs"]);
        writeWorkspace(root, "packages/shared/fs", "@oaam/shared-fs");
        expect(() => resolveWorkspaceGraph(root)).toThrow(/selected more than once/u);
    });

    it("rejects duplicate package identities", () => {
        const root = createRepository(["packages/*"]);
        writeWorkspace(root, "packages/a", "@oaam/duplicate");
        writeWorkspace(root, "packages/b", "@oaam/duplicate");
        expect(() => resolveWorkspaceGraph(root)).toThrow(/duplicate workspace name/u);
    });

    it("rejects unknown internal dependencies instead of resolving them externally", () => {
        const root = createRepository(["packages/core"]);
        writeWorkspace(root, "packages/core", "@oaam/core", {
            "@oaam/not-in-workspaces": "^0.1.0",
        });
        expect(() => resolveWorkspaceGraph(root)).toThrow(/internal dependency @oaam\/not-in-workspaces is not declared/u);
    });

    it("detects an internal dependency cycle and reports the cycle", () => {
        const root = createRepository(["packages/*"]);
        writeWorkspace(root, "packages/a", "@oaam/a", { "@oaam/b": "^0.1.0" });
        writeWorkspace(root, "packages/b", "@oaam/b", { "@oaam/a": "^0.1.0" });
        expect(() => resolveWorkspaceGraph(root)).toThrow("internal workspace dependency cycle: @oaam/a -> @oaam/b -> @oaam/a");
    });

    it("separates build-order edges from published delivery edges", () => {
        const root = createRepository(["packages/*"]);
        writeWorkspace(root, "packages/base", "@oaam/base");
        writeWorkspace(
            root,
            "packages/consumer",
            "@oaam/consumer",
            {},
            {
                peerDependencies: { "@oaam/base": "^0.1.0" },
                optionalDependencies: { "external-optional": "^1.0.0" },
            },
        );
        writeWorkspace(root, "packages/dev-consumer", "@oaam/dev-consumer", {}, { devDependencies: { "@oaam/base": "^0.1.0" } });
        const graph = resolveWorkspaceGraph(root);
        expect(graph.topologicalPackages.map((entry) => entry.name)).toEqual([
            "@oaam/base",
            "@oaam/consumer",
            "@oaam/dev-consumer",
        ]);
        expect(graph.packages.find((entry) => entry.name === "@oaam/consumer")).toMatchObject({
            internalDependencyNames: ["@oaam/base"],
            internalDeliveryDependencyNames: ["@oaam/base"],
        });
        expect(graph.packages.find((entry) => entry.name === "@oaam/dev-consumer")).toMatchObject({
            internalDependencyNames: ["@oaam/base"],
            internalDeliveryDependencyNames: [],
        });
    });

    it("normalizes string and object executable declarations into reviewed package bins", () => {
        const root = createRepository(["packages/*"]);
        writeWorkspace(root, "packages/string-bin", "@oaam/string-bin", {}, { bin: "./dist/cli.js" });
        writeWorkspace(
            root,
            "packages/object-bin",
            "@oaam/object-bin",
            {},
            {
                bin: { beta: "./dist/beta.js", alpha: "./dist/alpha.js" },
            },
        );
        const graph = resolveWorkspaceGraph(root);
        expect(graph.packages.find((entry) => entry.name === "@oaam/string-bin")?.packageBins).toEqual({
            "string-bin": "./dist/cli.js",
        });
        expect(graph.packages.find((entry) => entry.name === "@oaam/object-bin")?.packageBins).toEqual({
            alpha: "./dist/alpha.js",
            beta: "./dist/beta.js",
        });
    });

    it("rejects malformed or unsafe executable declarations", () => {
        for (const bin of [null, [], 1, { "": "./dist/cli.js" }, { "../escape": "./dist/cli.js" }, { command: "" }]) {
            const root = createRepository(["packages/example"]);
            writeWorkspace(root, "packages/example", "@oaam/example", {}, { bin });
            expect(() => resolveWorkspaceGraph(root)).toThrow(/package\.json: bin/u);
        }
    });
});
