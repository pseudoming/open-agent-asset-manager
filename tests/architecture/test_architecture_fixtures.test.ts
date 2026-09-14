import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DIRECTORY_SYMLINK_SUPPORTED } from "../repository/filesystem-test-capabilities.mjs";
import {
    checkForbiddenImports,
    classifyArchitectureWorkspace,
    collectAdapterFilesystemAuthorityViolations,
    collectAdapterProcessObservationAuthorityViolations,
    collectModuleSpecifiers,
    ROOT_DIR,
    resolveArchitectureSourceRoots,
    walkAllFiles,
    walkDir,
} from "./architecture-test-fixtures";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe("architecture fixture truthfulness", () => {
    it("enumerates every TypeScript source extension and JavaScript before rejection", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-architecture-walk-"));
        temporaryRoots.push(root);
        fs.mkdirSync(path.join(root, "nested"));
        fs.writeFileSync(path.join(root, "valid.cts"), "export {};\n");
        fs.writeFileSync(path.join(root, "valid.mts"), "export {};\n");
        fs.writeFileSync(path.join(root, "valid.ts"), "export {};\n");
        fs.writeFileSync(path.join(root, "valid.tsx"), "export {};\n");
        fs.writeFileSync(path.join(root, "types.d.ts"), "export {};\n");
        fs.writeFileSync(path.join(root, "nested", "hidden.js"), "module.exports = {};\n");

        expect(walkDir(root).map((file) => path.basename(file))).toEqual(["valid.cts", "valid.mts", "valid.ts", "valid.tsx"]);
        expect(
            walkAllFiles(root)
                .map((file) => path.basename(file))
                .sort(),
        ).toEqual(["hidden.js", "types.d.ts", "valid.cts", "valid.mts", "valid.ts", "valid.tsx"]);
    });

    it("rejects a new live workspace until its architecture layer is reviewed", () => {
        expect(
            classifyArchitectureWorkspace({
                name: "@oaam/shared",
                relativePath: "packages/shared",
            }),
        ).toBe("shared");
        expect(
            classifyArchitectureWorkspace({
                name: "@oaam/client-framework",
                relativePath: "packages/client/framework",
            }),
        ).toBe("client_framework");
        expect(
            classifyArchitectureWorkspace({
                name: "@oaam/client-headless",
                relativePath: "packages/client/headless",
            }),
        ).toBe("client_headless");
        expect(
            classifyArchitectureWorkspace({
                name: "@oaam/client-desktop",
                relativePath: "packages/client/desktop",
            }),
        ).toBe("client_desktop");
        expect(
            classifyArchitectureWorkspace({
                name: "@oaam/app-server-bootstrap",
                relativePath: "packages/app-server/bootstrap",
            }),
        ).toBe("app_server_bootstrap");
        expect(
            classifyArchitectureWorkspace({
                name: "@oaam/app-server-host",
                relativePath: "packages/app-server/host",
            }),
        ).toBe("app_server_host");
        expect(() =>
            classifyArchitectureWorkspace({
                name: "@oaam/client-not-reviewed",
                relativePath: "packages/client/not-reviewed",
            }),
        ).toThrow(/no reviewed architecture layer/u);

        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-architecture-workspace-"));
        temporaryRoots.push(root);
        fs.mkdirSync(path.join(root, "packages", "mystery", "src"), { recursive: true });
        fs.writeFileSync(
            path.join(root, "package.json"),
            `${JSON.stringify({ name: "fixture", workspaces: ["packages/mystery"] })}\n`,
        );
        fs.writeFileSync(
            path.join(root, "packages", "mystery", "package.json"),
            `${JSON.stringify({ name: "@oaam/mystery", version: "0.1.0" })}\n`,
        );

        expect(() => resolveArchitectureSourceRoots(root)).toThrow(/live workspace has no reviewed architecture layer/u);
    });

    it.skipIf(!DIRECTORY_SYMLINK_SUPPORTED)("rejects a symlinked subtree instead of omitting it from architecture scans", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-architecture-symlink-"));
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-architecture-external-"));
        temporaryRoots.push(root, externalRoot);
        fs.writeFileSync(path.join(externalRoot, "hidden.ts"), "export {};\n");
        fs.symlinkSync(externalRoot, path.join(root, "linked"), "dir");

        expect(() => walkAllFiles(root)).toThrow(/symlinks are not allowed in governed filesystem trees/u);
    });

    it("parses every governed module form without matching comments or inert strings", () => {
        const source = `
/// <reference types="@oaam/adapter-reference" />
import "@oaam/adapter-claudecode";
export * from "@oaam/adapter-opencode";
const loaded = require("@oaam/adapter-antigravity");
const resolved = require.resolve("@oaam/adapter-resolved");
void import("@oaam/adapter-zcode");
import legacy = require("@oaam/adapter-legacy");
type Query = import("@oaam/adapter-query").Query;
const inert = 'import "@oaam/adapter-inert"';
// export * from "@oaam/adapter-comment";
`;
        expect(collectModuleSpecifiers("fixture.ts", source)).toEqual([
            "@oaam/adapter-reference",
            "@oaam/adapter-claudecode",
            "@oaam/adapter-opencode",
            "@oaam/adapter-antigravity",
            "@oaam/adapter-resolved",
            "@oaam/adapter-zcode",
            "@oaam/adapter-legacy",
            "@oaam/adapter-query",
        ]);

        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-architecture-import-"));
        temporaryRoots.push(root);
        const file = path.join(root, "fixture.ts");
        fs.writeFileSync(file, source);
        expect(checkForbiddenImports([file], [/@oaam\/adapter-/u])).toHaveLength(8);
    });

    it("rejects computed runtime module references instead of bypassing layer checks", () => {
        for (const expression of ["require(moduleName)", "require.resolve(moduleName)", "import(moduleName)"]) {
            const source = `const moduleName = "@oaam/adapter-hidden";\nvoid ${expression};\n`;
            expect(() => collectModuleSpecifiers("fixture.ts", source), expression).toThrow(
                /direct runtime module references must use a string literal/u,
            );
        }
    });

    it("accepts only reviewed static read imports and literal read-only openSync calls", () => {
        const source = `
import { accessSync, closeSync, constants, openSync } from "node:fs";
import type { Stats } from "node:fs";
import { readRegularFileBounded, SafeFilesystemError } from "@oaam/shared/filesystem";
const descriptor = openSync("asset", "r");
closeSync(descriptor);
accessSync("asset", constants.R_OK);
void readRegularFileBounded;
void SafeFilesystemError;
type Sample = Stats;
`;
        expect(collectAdapterFilesystemAuthorityViolations("fixture.ts", source)).toEqual([]);
    });

    it("allows Shared physical identity only through the exact Adapter Framework probe owner", () => {
        const source = `
import {
    inspectDirectoryNoFollow,
    inspectRegularFileNoFollow,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
    readRegularFileRangeNoFollow,
    samePhysicalPathIdentity,
} from "@oaam/shared/filesystem";
void inspectRegularFileNoFollow;
void inspectDirectoryNoFollow;
void inventoryDirectoryNoFollow;
void readRegularFileNoFollow;
void readRegularFileRangeNoFollow;
void samePhysicalPathIdentity;
`;
        const owner = path.join(ROOT_DIR, "packages/adapter/framework/src/provider-probe-filesystem.ts");
        expect(collectAdapterFilesystemAuthorityViolations(owner, source)).toEqual([]);
        const denied = [
            expect.stringContaining("inspectDirectoryNoFollow is not in the reviewed read-only surface"),
            expect.stringContaining("inspectRegularFileNoFollow is not in the reviewed read-only surface"),
            expect.stringContaining("inventoryDirectoryNoFollow is not in the reviewed read-only surface"),
            expect.stringContaining("readRegularFileNoFollow is not in the reviewed read-only surface"),
            expect.stringContaining("readRegularFileRangeNoFollow is not in the reviewed read-only surface"),
            expect.stringContaining("samePhysicalPathIdentity is not in the reviewed read-only surface"),
        ];
        for (const relativePath of [
            "packages/adapter/providers/claudecode/src/claudecode-probe-app-projects.ts",
            "packages/adapter/providers/opencode/src/opencode-probe-project-registry.ts",
            "packages/adapter/framework/src/source-read-coordinator.ts",
            "packages/adapter/framework/src/provider-probe-filesystem-bypass.ts",
        ]) {
            expect(collectAdapterFilesystemAuthorityViolations(path.join(ROOT_DIR, relativePath), source), relativePath).toEqual(
                denied,
            );
        }
    });

    it("restricts shallow directory observations to the exact Framework physical owner", () => {
        const source = 'import { observeDirectoryMembersBounded } from "@oaam/shared/filesystem";';
        const owner = "packages/adapter/framework/src/provider-probe-filesystem.ts";
        expect(collectAdapterFilesystemAuthorityViolations(path.join(ROOT_DIR, owner), source)).toEqual([]);
        for (const file of [
            "packages/adapter/providers/opencode/src/opencode-probe-cli-version.ts",
            "packages/adapter/framework/src/source-read-coordinator.ts",
            "packages/adapter/framework/src/provider-probe-filesystem-bypass.ts",
        ]) {
            expect(collectAdapterFilesystemAuthorityViolations(path.join(ROOT_DIR, file), source)).toEqual([
                expect.stringContaining("observeDirectoryMembersBounded is not in the reviewed read-only surface"),
            ]);
            expect(
                collectAdapterFilesystemAuthorityViolations(path.join(ROOT_DIR, file), 'import { opendirSync } from "node:fs";'),
            ).toEqual([expect.stringContaining("opendirSync is not in the reviewed read-only surface")]);
        }
    });

    it("allows local process observation only through the exact Adapter Framework probe owner", () => {
        const source = `
import {
    invokeLocalExecutableTreeBounded,
    listLocalProcessExecutableCandidateIdsBounded,
    listLocalProcessIdsBounded,
    observeLocalProcessBounded,
    observeLocalProcessExecutableBounded,
} from "@oaam/shared/paths";
void invokeLocalExecutableTreeBounded;
void listLocalProcessExecutableCandidateIdsBounded;
void listLocalProcessIdsBounded;
void observeLocalProcessBounded;
void observeLocalProcessExecutableBounded;
`;
        const owner = path.join(ROOT_DIR, "packages/adapter/framework/src/provider-probe-process.ts");
        expect(collectAdapterProcessObservationAuthorityViolations(owner, source)).toEqual([]);
        expect(
            collectAdapterProcessObservationAuthorityViolations(
                path.join(ROOT_DIR, "packages/adapter/providers/opencode/src/opencode-probe-projects.ts"),
                source,
            ),
        ).toEqual([
            expect.stringContaining("invokeLocalExecutableTreeBounded is restricted"),
            expect.stringContaining("listLocalProcessExecutableCandidateIdsBounded is restricted"),
            expect.stringContaining("listLocalProcessIdsBounded is restricted"),
            expect.stringContaining("observeLocalProcessBounded is restricted"),
            expect.stringContaining("observeLocalProcessExecutableBounded is restricted"),
        ]);

        const bypass = `
import * as paths from "@oaam/shared/paths";
export { listLocalProcessIdsBounded, observeLocalProcessBounded } from "@oaam/shared/paths";
void import("@oaam/shared/paths");
void paths;
`;
        expect(collectAdapterProcessObservationAuthorityViolations("fixture.ts", bypass)).toEqual([
            expect.stringContaining("requires static named imports"),
            expect.stringContaining("must not be re-exported"),
            expect.stringContaining("must not be loaded dynamically"),
        ]);
        expect(
            collectAdapterProcessObservationAuthorityViolations(
                "fixture.ts",
                'const processPath = "/proc/123";\nvoid processPath;\n',
            ),
        ).toEqual([expect.stringContaining("raw Unix process-table paths")]);
    });

    it("rejects namespace, mutation, unbounded read, durability, re-export, and non-static access", () => {
        const source = `
import * as disk from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteFile, confirmDurableRegularFileNoFollow } from "@oaam/shared/filesystem";
export { readFileSync } from "node:fs";
void import("node:fs/promises");
void require("fs");
void process.getBuiltinModule("fs");
`;
        const violations = collectAdapterFilesystemAuthorityViolations("fixture.ts", source);
        expect(violations).toHaveLength(8);
        expect(violations.join("\n")).toMatch(/static named imports only/u);
        expect(violations.join("\n")).toMatch(/readFile.*not in the reviewed read-only surface/u);
        expect(violations.join("\n")).toMatch(/atomicWriteFile.*not in the reviewed read-only surface/u);
        expect(violations.join("\n")).toMatch(/confirmDurableRegularFileNoFollow.*not in the reviewed read-only surface/u);
        expect(violations.join("\n")).toMatch(/must not be re-exported/u);
        expect(violations.join("\n")).toMatch(/must not be loaded through/u);
    });

    it("rejects writable flags and forwarding of the narrowly approved openSync escape hatch", () => {
        const source = `
import { openSync } from "node:fs";
const descriptor = openSync("asset", "w");
const forwarded = openSync;
void descriptor;
void forwarded;
`;
        const violations = collectAdapterFilesystemAuthorityViolations("fixture.ts", source);
        expect(violations).toHaveLength(2);
        expect(violations.join("\n")).toMatch(/literal read-only flag/u);
        expect(violations.join("\n")).toMatch(/must not be forwarded or stored/u);
    });
});
