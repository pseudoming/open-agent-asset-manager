import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("loads the ordinary build when installed acceptance modules and internal documents are absent", () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-public-build-boundary-"));
    roots.push(root);
    const excluded = new Set([
        "desktop-package-smoke.mjs",
        "restricted-wsl-package.mjs",
        "installed-headless-project-target-check.mjs",
        "windows-installed-headless-project-target-check.mjs",
    ]);
    const copied = new Set<string>();
    function copy(relativePath: string) {
        if (copied.has(relativePath) || excluded.has(path.basename(relativePath))) return;
        const content = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
        copied.add(relativePath);
        const destination = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
        const syntax = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        for (const statement of syntax.statements) {
            if (
                (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
                statement.moduleSpecifier !== undefined &&
                ts.isStringLiteral(statement.moduleSpecifier) &&
                statement.moduleSpecifier.text.startsWith(".")
            ) {
                copy(path.normalize(path.join(path.dirname(relativePath), statement.moduleSpecifier.text)));
            }
        }
    }
    copy("tests/repository/build-workspaces.mjs");
    fs.symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"), "junction");
    expect(fs.existsSync(path.join(root, "docs"))).toBe(false);
    expect(copied.has("tests/repository/package-build-policy.mjs")).toBe(true);
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `const loaded = await import(${JSON.stringify(pathToFileURL(path.join(root, "tests/repository/build-workspaces.mjs")).href)}); if (typeof loaded.runCleanWorkspaceBuild !== 'function') process.exit(2);`,
        ],
        { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
});
