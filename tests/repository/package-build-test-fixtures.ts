import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";
export const temporaryRoots: string[] = [];
afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
export function createFixture(
    options: {
        allowJs?: boolean;
        bin?: string | Record<string, string>;
        files?: string[];
        exports?: Record<string, unknown>;
        include?: string[];
        main?: string;
        noCheck?: boolean;
        outDir?: string;
        rootDir?: string;
        strict?: boolean;
        types?: string;
    } = {},
): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-package-delivery-fixture-"));
    temporaryRoots.push(root);
    fs.writeFileSync(
        path.join(root, "package.json"),
        `${JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] })}\n`,
    );
    const packageRoot = path.join(root, "packages", "example");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "schema"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(packageRoot, "dist", "index.d.ts"), "export {};\n");
    fs.writeFileSync(path.join(packageRoot, "schema", "schema.sql"), "SELECT 1;\n");
    fs.writeFileSync(path.join(packageRoot, "src", "index.ts"), "export {};\n");
    fs.writeFileSync(
        path.join(packageRoot, "tsconfig.json"),
        `${JSON.stringify(
            {
                compilerOptions: {
                    allowJs: options.allowJs ?? false,
                    noCheck: options.noCheck ?? false,
                    outDir: options.outDir ?? "./dist",
                    rootDir: options.rootDir ?? "./src",
                    strict: options.strict ?? true,
                },
                include: options.include ?? ["src/**/*"],
            },
            null,
            2,
        )}\n`,
    );
    fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify(
            {
                name: "@oaam/example",
                version: "0.1.0",
                ...(options.bin === undefined ? {} : { bin: options.bin }),
                ...(options.exports === undefined ? {} : { exports: options.exports }),
                main: options.main ?? "./dist/index.js",
                types: options.types ?? "./dist/index.d.ts",
                files: options.files ?? ["dist", "schema/schema.sql"],
                scripts: {
                    build: "tsc",
                    typecheck: "tsc --noEmit",
                    test: "vitest run",
                    "test:coverage": "vitest run --coverage",
                },
            },
            null,
            2,
        )}\n`,
    );
    return root;
}

export function createHeadlessFixture(bin: string | Record<string, string>): string {
    const root = createFixture({ bin });
    const clientRoot = path.join(root, "packages", "client");
    fs.mkdirSync(clientRoot);
    fs.renameSync(path.join(root, "packages", "example"), path.join(clientRoot, "headless"));
    fs.writeFileSync(
        path.join(root, "package.json"),
        `${JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/client/*"] })}\n`,
    );
    const manifestPath = path.join(clientRoot, "headless", "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: "@oaam/client-headless" }, null, 2)}\n`);
    return root;
}

export function createProductionImportFixture(
    source: string,
    dependencySections: Record<string, Record<string, string>> = {},
): ReturnType<typeof resolveWorkspaceGraph> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-production-import-fixture-"));
    temporaryRoots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture", workspaces: ["packages/*"] })}\n`);
    for (const [directory, name, extra] of [
        ["base", "@oaam/base", {}],
        ["consumer", "@oaam/consumer", dependencySections],
    ] as const) {
        const packageRoot = path.join(root, "packages", directory);
        fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name, version: "0.1.0", ...extra })}\n`);
        fs.writeFileSync(
            path.join(packageRoot, "src", "index.ts"),
            directory === "consumer" ? source : "export interface Base {}\n",
        );
    }
    return resolveWorkspaceGraph(root);
}
