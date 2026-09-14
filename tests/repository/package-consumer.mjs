import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { WorkspaceGraphError } from "./workspace-graph.mjs";
import { resolveNpmInvocation } from "./workspace-commands.mjs";
import { prepareLockedPackageConsumer, validateInstalledExternalDependencyClosure } from "./package-assembly-lock.mjs";
import { pathIsAtOrBelow, validatePackedInventory, validateInternalTarballClosure } from "./package-build-policy.mjs";
function fail(message) {
    throw new WorkspaceGraphError(message);
}

export function installWorkspaceConsumer(graph, tarballs, consumerRoot, options = {}) {
    const prepared = prepareLockedPackageConsumer(graph, tarballs, consumerRoot, options);
    runPackageCommand(
        "isolated npm ci",
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--install-links=false"],
        { ...options, cwd: consumerRoot, encoding: "utf8", stdio: "pipe" },
    );
    validateInstalledInternalDependencyClosure(graph, consumerRoot);
    return validateInstalledExternalDependencyClosure(graph, consumerRoot, prepared);
}

export function runPackageCommand(label, command, args, options = {}) {
    const spawn = options.spawn ?? spawnSync;
    const invocation = resolveNpmInvocation({ command, args }, options.env ?? process.env);
    const result = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: options.encoding,
        stdio: options.stdio,
        input: options.input,
    });
    if (result.error !== undefined) fail(`${label}: command could not start: ${result.error.message}`);
    if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        fail(`${label}: command failed with ${result.status}${output === "" ? "" : `\n${output}`}`);
    }
    return result;
}

export function packWorkspaceTarballs(graph, policies, tarballRoot, options = {}) {
    fs.mkdirSync(tarballRoot, { recursive: true });
    const policiesByName = new Map(policies.map((policy) => [policy.workspacePackage.name, policy]));
    const overrides = prevalidatedWorkspaceTarballOverrides(graph, options.prevalidatedWorkspaceTarballOverrides);
    const tarballs = [];
    for (const workspacePackage of graph.topologicalPackages) {
        const override = overrides.get(workspacePackage.name);
        if (override !== undefined) {
            tarballs.push(override);
            continue;
        }
        const result = runPackageCommand(
            `npm pack ${workspacePackage.name}`,
            process.platform === "win32" ? "npm.cmd" : "npm",
            ["pack", "--json", "--pack-destination", tarballRoot, `--workspace=${workspacePackage.relativePath}`],
            {
                ...options,
                cwd: graph.repositoryRoot,
                encoding: "utf8",
                stdio: "pipe",
            },
        );
        let packResult;
        try {
            const parsed = JSON.parse(result.stdout);
            if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("expected one result");
            [packResult] = parsed;
        } catch (error) {
            fail(
                `npm pack ${workspacePackage.name}: invalid JSON result: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (packResult.name !== workspacePackage.name || packResult.version !== workspacePackage.version) {
            fail(`${workspacePackage.name}: npm pack identity/version mismatch`);
        }
        const filename = path.basename(packResult.filename ?? "");
        if (filename === "" || filename !== packResult.filename) {
            fail(`${workspacePackage.name}: npm pack returned unsafe filename`);
        }
        const tarballPath = path.join(tarballRoot, filename);
        if (!fs.existsSync(tarballPath) || !fs.lstatSync(tarballPath).isFile()) {
            fail(`${workspacePackage.name}: npm pack tarball is missing`);
        }
        validatePackedInventory(policiesByName.get(workspacePackage.name), packResult.files, graph.repositoryRoot);
        tarballs.push(
            Object.freeze({
                name: workspacePackage.name,
                version: workspacePackage.version,
                path: tarballPath,
            }),
        );
    }
    validateInternalTarballClosure(graph, tarballs);
    return Object.freeze(tarballs);
}

function prevalidatedWorkspaceTarballOverrides(graph, input) {
    if (input === undefined) return new Map();
    if (!Array.isArray(input)) fail("prevalidated workspace tarball overrides must be an array");
    const packagesByName = new Map(graph.packages.map((entry) => [entry.name, entry]));
    const overrides = new Map();
    for (const [index, entry] of input.entries()) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            fail(`prevalidated workspace tarball override ${String(index)} must be an object`);
        }
        const workspacePackage = packagesByName.get(entry.name);
        if (workspacePackage === undefined) {
            fail(`prevalidated workspace tarball override names foreign workspace ${String(entry.name)}`);
        }
        if (overrides.has(workspacePackage.name)) {
            fail(`duplicate prevalidated workspace tarball override ${workspacePackage.name}`);
        }
        if (entry.version !== workspacePackage.version) {
            fail(
                `${workspacePackage.name}: prevalidated workspace tarball version ${String(entry.version)} does not match ${workspacePackage.version}`,
            );
        }
        if (typeof entry.path !== "string" || path.resolve(entry.path) !== entry.path || entry.path.includes("\0")) {
            fail(`${workspacePackage.name}: prevalidated workspace tarball path must be canonical absolute`);
        }
        let stat;
        try {
            stat = fs.lstatSync(entry.path);
        } catch {
            fail(`${workspacePackage.name}: prevalidated workspace tarball is missing`);
        }
        if (stat.isSymbolicLink() || !stat.isFile()) {
            fail(`${workspacePackage.name}: prevalidated workspace tarball must be a regular non-symlink file`);
        }
        overrides.set(
            workspacePackage.name,
            Object.freeze({
                name: workspacePackage.name,
                version: workspacePackage.version,
                path: entry.path,
            }),
        );
    }
    return overrides;
}

function publicExportKeys(manifest) {
    const exportsField = manifest.exports;
    if (
        exportsField === null ||
        typeof exportsField !== "object" ||
        Array.isArray(exportsField) ||
        !Object.keys(exportsField).every((key) => key === "." || key.startsWith("./"))
    ) {
        return Object.freeze(["."]);
    }
    const keys = Object.keys(exportsField).sort((left, right) => left.localeCompare(right, "en"));
    return Object.freeze(keys.length === 0 ? ["."] : keys);
}

function packageSpecifiersForExportKeys(packageName, exportKeys) {
    return Object.freeze(exportKeys.map((key) => (key === "." ? packageName : `${packageName}${key.slice(1)}`)));
}

export function workspacePublicSpecifiers(graph, workspacePackage) {
    const manifestPath = path.join(graph.repositoryRoot, ...workspacePackage.relativePath.split("/"), "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return packageSpecifiersForExportKeys(workspacePackage.name, publicExportKeys(manifest));
}

export function installedPackageRoot(consumerRoot, packageName) {
    return path.join(consumerRoot, "node_modules", ...packageName.split("/"));
}

export function validateInstalledInternalDependencyClosure(graph, consumerRoot) {
    const packagesByName = new Map(graph.packages.map((entry) => [entry.name, entry]));
    for (const workspacePackage of graph.packages) {
        const packageRoot = installedPackageRoot(consumerRoot, workspacePackage.name);
        let packageStat;
        try {
            packageStat = fs.lstatSync(packageRoot);
        } catch {
            fail(`${workspacePackage.name}: installed package root is missing`);
        }
        if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
            fail(`${workspacePackage.name}: installed package root must be a real directory`);
        }
        const manifestPath = path.join(packageRoot, "package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (manifest.name !== workspacePackage.name || manifest.version !== workspacePackage.version) {
            fail(`${workspacePackage.name}: installed package identity/version mismatch`);
        }
        const packageRequire = createRequire(manifestPath);
        for (const dependencyName of workspacePackage.internalDeliveryDependencyNames) {
            const dependency = packagesByName.get(dependencyName);
            if (dependency === undefined) fail(`${workspacePackage.name}: unknown internal dependency ${dependencyName}`);
            const dependencyRoot = installedPackageRoot(consumerRoot, dependencyName);
            const dependencyManifest = JSON.parse(fs.readFileSync(path.join(dependencyRoot, "package.json"), "utf8"));
            const publicSpecifiers = packageSpecifiersForExportKeys(dependencyName, publicExportKeys(dependencyManifest));
            for (const publicSpecifier of publicSpecifiers) {
                let actualEntry;
                try {
                    actualEntry = fs.realpathSync(packageRequire.resolve(publicSpecifier));
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    fail(`${workspacePackage.name}: cannot resolve installed internal dependency ${publicSpecifier}: ${detail}`);
                }
                if (!pathIsAtOrBelow(dependencyRoot, actualEntry)) {
                    fail(
                        `${workspacePackage.name}: internal dependency ${publicSpecifier} resolved outside the installed local tarball closure`,
                    );
                }
            }
        }
    }
}
