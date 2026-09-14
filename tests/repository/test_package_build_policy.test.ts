import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIRECTORY_SYMLINK_SUPPORTED } from "./filesystem-test-capabilities.mjs";
import {
    cleanWorkspaceBuildOutputs,
    validateBuiltPackageEntries,
    validateInternalTarballClosure,
    validatePackageDeliveryPolicies,
    validatePackedInventory,
    validateProductionInternalImportManifests,
} from "./package-build-policy.mjs";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";
import { createFixture, createHeadlessFixture, createProductionImportFixture } from "./package-build-test-fixtures";

describe("package build policy", () => {
    it("accepts explicit entries and removes the whole stale build output root", () => {
        const root = createFixture();
        const graph = resolveWorkspaceGraph(root);
        const policies = validatePackageDeliveryPolicies(graph);
        fs.writeFileSync(path.join(root, "packages", "example", "dist", "stale.js"), "stale\n");

        expect(cleanWorkspaceBuildOutputs(graph, policies)).toEqual(["packages/example/dist"]);
        expect(fs.existsSync(path.join(root, "packages", "example", "dist", "stale.js"))).toBe(false);
        expect(fs.existsSync(path.join(root, "packages", "example", "schema", "schema.sql"))).toBe(true);
    });

    it("governs executable entries through the same files, outDir, built, and packed authorities", () => {
        const root = createFixture({ bin: { "oaam-example": "./dist/cli.js" } });
        const commandPath = path.join(root, "packages", "example", "dist", "cli.js");
        fs.writeFileSync(commandPath, "#!/usr/bin/env node\n");
        const graph = resolveWorkspaceGraph(root);
        const [policy] = validatePackageDeliveryPolicies(graph);
        expect(policy.binEntries).toEqual([{ commandName: "oaam-example", entryPath: "dist/cli.js" }]);
        expect(() => validateBuiltPackageEntries(graph, [policy])).not.toThrow();
        expect(() =>
            validatePackedInventory(
                policy,
                ["package.json", "dist/index.js", "dist/index.d.ts", "dist/cli.js", "schema/schema.sql"],
                root,
            ),
        ).not.toThrow();

        fs.rmSync(commandPath);
        expect(() => validateBuiltPackageEntries(graph, [policy])).toThrow(
            /built bin\.oaam-example entry dist\/cli\.js is missing/u,
        );
        fs.writeFileSync(commandPath, "#!/usr/bin/env node\n");
        expect(() =>
            validatePackedInventory(policy, ["package.json", "dist/index.js", "dist/index.d.ts", "schema/schema.sql"], root),
        ).toThrow(/packed file dist\/cli\.js is missing/u);
    });

    it("rejects an executable outside package files or TypeScript output policy", () => {
        expect(() =>
            validatePackageDeliveryPolicies(
                resolveWorkspaceGraph(createFixture({ bin: { "oaam-example": "./schema/cli.js" }, files: ["dist", "schema"] })),
            ),
        ).toThrow(/bin\.oaam-example schema\/cli\.js is outside TypeScript outDir dist/u);
        expect(() =>
            validatePackageDeliveryPolicies(
                resolveWorkspaceGraph(createFixture({ bin: { "oaam-example": "./other/cli.js" }, files: ["dist"] })),
            ),
        ).toThrow(/bin\.oaam-example other\/cli\.js is outside files policy/u);
    });

    it("requires the reviewed Headless role to expose its exact installed command", () => {
        expect(() =>
            validatePackageDeliveryPolicies(resolveWorkspaceGraph(createHeadlessFixture({ wrong: "./dist/index.js" }))),
        ).toThrow(/client_headless must expose exactly oaam-headless -> dist\/index\.js/u);
        expect(() =>
            validatePackageDeliveryPolicies(resolveWorkspaceGraph(createHeadlessFixture({ "oaam-headless": "./dist/index.js" }))),
        ).not.toThrow();
    });

    it.skipIf(!DIRECTORY_SYMLINK_SUPPORTED)("refuses to clean through a symlinked output parent", () => {
        const root = createFixture({
            files: ["build/dist"],
            main: "./build/dist/index.js",
            types: "./build/dist/index.d.ts",
            outDir: "./build/dist",
        });
        const externalRoot = path.join(root, "external-output");
        fs.mkdirSync(path.join(externalRoot, "dist"), { recursive: true });
        fs.symlinkSync(externalRoot, path.join(root, "packages", "example", "build"), "dir");
        const graph = resolveWorkspaceGraph(root);
        const policies = validatePackageDeliveryPolicies(graph);

        expect(() => cleanWorkspaceBuildOutputs(graph, policies)).toThrow(/refusing to clean a symlinked build output path/u);
    });

    it.skipIf(!DIRECTORY_SYMLINK_SUPPORTED)("rejects a symlink introduced into a built public entry after clean", () => {
        const root = createFixture();
        const packageRoot = path.join(root, "packages", "example");
        const externalRoot = path.join(root, "external-built-output");
        fs.mkdirSync(externalRoot);
        fs.writeFileSync(path.join(externalRoot, "index.js"), "module.exports = {};\n");
        fs.writeFileSync(path.join(externalRoot, "index.d.ts"), "export {};\n");
        fs.rmSync(path.join(packageRoot, "dist"), { recursive: true });
        fs.symlinkSync(externalRoot, path.join(packageRoot, "dist"), "dir");
        const graph = resolveWorkspaceGraph(root);
        const policies = validatePackageDeliveryPolicies(graph);

        expect(() => validateBuiltPackageEntries(graph, policies)).toThrow(
            /built main entry dist\/index\.js crosses symlink dist/u,
        );
    });

    it.skipIf(!DIRECTORY_SYMLINK_SUPPORTED)("rejects a declared package file reached through an intermediate symlink", () => {
        const root = createFixture();
        const packageRoot = path.join(root, "packages", "example");
        const externalRoot = path.join(root, "external-schema");
        fs.mkdirSync(externalRoot);
        fs.writeFileSync(path.join(externalRoot, "schema.sql"), "SELECT 2;\n");
        fs.rmSync(path.join(packageRoot, "schema"), { recursive: true });
        fs.symlinkSync(externalRoot, path.join(packageRoot, "schema"), "dir");
        const graph = resolveWorkspaceGraph(root);
        const [policy] = validatePackageDeliveryPolicies(graph);

        expect(() =>
            validatePackedInventory(policy, ["package.json", "dist/index.js", "dist/index.d.ts", "schema/schema.sql"], root),
        ).toThrow(/declared package path schema\/schema\.sql crosses symlink schema/u);
    });

    it("rejects a missing clean-build entry instead of accepting stale output", () => {
        const root = createFixture();
        const graph = resolveWorkspaceGraph(root);
        const policies = validatePackageDeliveryPolicies(graph);
        fs.rmSync(path.join(root, "packages", "example", "dist", "index.d.ts"));
        expect(() => validateBuiltPackageEntries(graph, policies)).toThrow(/built types entry dist\/index\.d\.ts is missing/u);
    });

    it("rejects a package policy that omits its public entry", () => {
        const graph = resolveWorkspaceGraph(createFixture({ files: ["schema/schema.sql"] }));
        expect(() => validatePackageDeliveryPolicies(graph)).toThrow(/main dist\/index\.js is outside files policy/u);
    });

    it("refuses a public entry outside the compiler output root", () => {
        const graph = resolveWorkspaceGraph(
            createFixture({
                files: ["src"],
                main: "./src/index.js",
                types: "./src/index.d.ts",
            }),
        );
        expect(() => validatePackageDeliveryPolicies(graph)).toThrow(/main src\/index\.js is outside TypeScript outDir dist/u);
    });

    it("refuses to clean an outDir that contains a compiler input", () => {
        const graph = resolveWorkspaceGraph(
            createFixture({
                files: ["src/generated"],
                main: "./src/generated/index.js",
                types: "./src/generated/index.d.ts",
                outDir: "./src/generated",
            }),
        );
        expect(() => validatePackageDeliveryPolicies(graph)).toThrow(
            /outDir src\/generated overlaps compiler rootDir src; refusing destructive clean/u,
        );
    });

    it("rejects a compiler root outside the governed source tree", () => {
        const root = createFixture({ include: ["lib/**/*"], rootDir: "./lib" });
        const packageRoot = path.join(root, "packages", "example");
        fs.mkdirSync(path.join(packageRoot, "lib"));
        fs.writeFileSync(path.join(packageRoot, "lib", "index.ts"), "export {};\n");

        expect(() => validatePackageDeliveryPolicies(resolveWorkspaceGraph(root))).toThrow(
            /compiler rootDir lib must be the governed source root src/u,
        );
    });

    it("rejects a narrowed compiler include that omits a governed source", () => {
        const root = createFixture({ include: ["src/index.ts"] });
        fs.writeFileSync(path.join(root, "packages", "example", "src", "omitted.ts"), "export {};\n");

        expect(() => validatePackageDeliveryPolicies(resolveWorkspaceGraph(root))).toThrow(
            /compiler inputs omit governed source src\/omitted\.ts/u,
        );
    });

    it("rejects a compiler input outside the governed source tree", () => {
        const root = createFixture({ include: ["src/**/*", "outside.ts"] });
        fs.writeFileSync(path.join(root, "packages", "example", "outside.ts"), "export {};\n");

        expect(() => validatePackageDeliveryPolicies(resolveWorkspaceGraph(root))).toThrow(
            /compiler input outside\.ts is outside governed source root src/u,
        );
    });

    it.each([
        ["strict", { strict: false }, /compilerOptions\.strict must be true/u],
        ["noCheck", { noCheck: true }, /compilerOptions\.noCheck is forbidden/u],
        ["allowJs", { allowJs: true }, /compilerOptions\.allowJs is forbidden/u],
    ] as const)("rejects a compiler config that weakens %s", (_name, options, expected) => {
        expect(() => validatePackageDeliveryPolicies(resolveWorkspaceGraph(createFixture(options)))).toThrow(expected);
    });

    it("rejects undeclared tarball files and a missing declared file", () => {
        const root = createFixture();
        const graph = resolveWorkspaceGraph(root);
        const [policy] = validatePackageDeliveryPolicies(graph);
        expect(() =>
            validatePackedInventory(
                policy,
                ["package.json", "dist/index.js", "dist/index.d.ts", "schema/schema.sql", "src/index.ts"],
                root,
            ),
        ).toThrow(/packed undeclared file src\/index\.ts/u);
        expect(() => validatePackedInventory(policy, ["package.json", "dist/index.js", "dist/index.d.ts"], root)).toThrow(
            /declared package file schema\/schema\.sql was not packed/u,
        );
        fs.writeFileSync(path.join(root, "packages", "example", "dist", "secondary.d.ts"), "export {};\n");
        expect(() =>
            validatePackedInventory(policy, ["package.json", "dist/index.js", "dist/index.d.ts", "schema/schema.sql"], root),
        ).toThrow(/declared package file dist\/secondary\.d\.ts was not packed/u);
    });

    it("rejects a Windows loader or addon from the default Unix-like Shared tarball", () => {
        const root = createFixture();
        const manifestPath = path.join(root, "packages", "example", "package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: "@oaam/shared" }, null, 2)}\n`);
        const win32Loader = path.join(root, "packages", "example", "dist", "paths", "win32", "native-addon.js");
        fs.mkdirSync(path.dirname(win32Loader), { recursive: true });
        fs.writeFileSync(win32Loader, "module.exports = {};\n");
        const graph = resolveWorkspaceGraph(root);
        const [policy] = validatePackageDeliveryPolicies(graph);

        expect(() =>
            validatePackedInventory(
                policy,
                ["package.json", "dist/index.js", "dist/index.d.ts", "dist/paths/win32/native-addon.js", "schema/schema.sql"],
                root,
            ),
        ).toThrow(/default Unix-like package contains a Windows target artifact/u);
    });

    it("rejects a declared package path that is absent from the built package", () => {
        const root = createFixture();
        const graph = resolveWorkspaceGraph(root);
        const [policy] = validatePackageDeliveryPolicies(graph);
        fs.rmSync(path.join(root, "packages", "example", "schema", "schema.sql"));

        expect(() => validatePackedInventory(policy, ["package.json", "dist/index.js", "dist/index.d.ts"], root)).toThrow(
            /declared package path schema\/schema\.sql is missing/u,
        );
    });

    it("rejects a missing, duplicate, or foreign internal tarball", () => {
        const graph = resolveWorkspaceGraph(createFixture());
        expect(() => validateInternalTarballClosure(graph, [])).toThrow(/missing workspace tarballs: @oaam\/example/u);
        const tarball = { name: "@oaam/example" };
        expect(() => validateInternalTarballClosure(graph, [tarball, tarball])).toThrow(/duplicate workspace tarball/u);
        expect(() => validateInternalTarballClosure(graph, [{ name: "@oaam/foreign" }])).toThrow(/foreign workspace tarball/u);
    });

    it("rejects a production internal import omitted from the consuming manifest", () => {
        const graph = createProductionImportFixture('import type { Base } from "@oaam/base";\nexport type Consumer = Base;\n');

        expect(() => validateProductionInternalImportManifests(graph)).toThrow(
            /@oaam\/consumer: production source imports @oaam\/base but package\.json has no delivery dependency/u,
        );
    });

    it("rejects devDependencies as authority for a production internal import", () => {
        const graph = createProductionImportFixture('export { Base } from "@oaam/base/subpath";\n', {
            devDependencies: { "@oaam/base": "^0.1.0" },
        });

        expect(() => validateProductionInternalImportManifests(graph)).toThrow(
            /@oaam\/consumer: production source imports @oaam\/base but it is declared only outside delivery dependency sections/u,
        );
    });

    it("accepts all static TypeScript import forms through reviewed delivery sections", () => {
        const source = [
            '/// <reference types="@oaam/base" />',
            'import type { Base } from "@oaam/base";',
            'export type { Base as ExportedBase } from "@oaam/base/subpath";',
            'import base = require("@oaam/base");',
            'type Imported = import("@oaam/base").Base;',
            'const required = require("@oaam/base");',
            'const resolved = require.resolve("@oaam/base");',
            'const dynamic = import("@oaam/base/subpath");',
            "void [base, required, resolved, dynamic];",
            "export type Consumer = Base | Imported;",
            "",
        ].join("\n");
        for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
            const graph = createProductionImportFixture(source, {
                [section]: { "@oaam/base": "^0.1.0" },
            });
            expect(() => validateProductionInternalImportManifests(graph), section).not.toThrow();
        }
    });

    it("ignores inert text and self imports but rejects an unknown OAAM package", () => {
        const inert = createProductionImportFixture(
            [
                '// import "@oaam/base";',
                'const example = "require(\\"@oaam/base\\")";',
                'export type Self = import("@oaam/consumer").Self;',
                "void example;",
                "",
            ].join("\n"),
        );
        expect(() => validateProductionInternalImportManifests(inert)).not.toThrow();

        const foreign = createProductionImportFixture('import "@oaam/not-a-workspace";\n');
        expect(() => validateProductionInternalImportManifests(foreign)).toThrow(
            /@oaam\/consumer: production source imports unknown internal package @oaam\/not-a-workspace/u,
        );
    });

    it("rejects computed runtime loading that cannot be checked against a manifest", () => {
        const graph = createProductionImportFixture('const packageName = "@oaam/base";\nvoid import(packageName);\n', {
            dependencies: { "@oaam/base": "^0.1.0" },
        });

        expect(() => validateProductionInternalImportManifests(graph)).toThrow(
            /direct runtime module references must use a string literal/u,
        );
    });
});
