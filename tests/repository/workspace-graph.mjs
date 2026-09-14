#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const DELIVERY_DEPENDENCY_SECTIONS = new Set(["dependencies", "optionalDependencies", "peerDependencies"]);

export class WorkspaceGraphError extends Error {
    constructor(message) {
        super(message);
        this.name = "WorkspaceGraphError";
    }
}

function fail(message) {
    throw new WorkspaceGraphError(message);
}

function readJsonObject(filePath, label) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        fail(`${label}: cannot read valid JSON: ${detail}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail(`${label}: expected a JSON object`);
    }
    return parsed;
}

function normalizeWorkspacePattern(rawPattern) {
    if (typeof rawPattern !== "string" || rawPattern.length === 0) {
        fail("root package.json: every workspace pattern must be a non-empty string");
    }
    if (rawPattern.includes("\\") || rawPattern.includes("\0") || path.posix.isAbsolute(rawPattern)) {
        fail(`root package.json: unsafe workspace pattern ${JSON.stringify(rawPattern)}`);
    }
    const segments = rawPattern.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        fail(`root package.json: non-canonical workspace pattern ${JSON.stringify(rawPattern)}`);
    }
    const wildcardIndexes = segments.map((segment, index) => (segment === "*" ? index : -1)).filter((index) => index !== -1);
    const containsUnsupportedGlob = segments.some((segment) => segment !== "*" && /[*?[\]{}!]/u.test(segment));
    if (
        containsUnsupportedGlob ||
        wildcardIndexes.length > 1 ||
        (wildcardIndexes.length === 1 && wildcardIndexes[0] !== segments.length - 1)
    ) {
        fail(
            `root package.json: unsupported workspace pattern ${JSON.stringify(rawPattern)}; only exact directories and one trailing /* are supported`,
        );
    }
    const normalized = path.posix.normalize(rawPattern);
    if (normalized !== rawPattern) {
        fail(`root package.json: non-canonical workspace pattern ${JSON.stringify(rawPattern)}`);
    }
    return {
        pattern: normalized,
        wildcard: wildcardIndexes.length === 1,
        base: wildcardIndexes.length === 1 ? segments.slice(0, -1).join("/") : normalized,
    };
}

function assertDirectoryWithoutSymlink(absolutePath, label) {
    let stat;
    try {
        stat = fs.lstatSync(absolutePath);
    } catch {
        fail(`${label}: directory does not exist`);
    }
    if (stat.isSymbolicLink()) fail(`${label}: symlinked workspace directories are not allowed`);
    if (!stat.isDirectory()) fail(`${label}: expected a directory`);
}

function assertRelativeDirectoryTreeWithoutSymlink(repositoryRoot, relativePath, label) {
    let currentPath = repositoryRoot;
    for (const segment of relativePath.split("/")) {
        currentPath = path.join(currentPath, segment);
        assertDirectoryWithoutSymlink(currentPath, label);
    }
}

function assertRegularManifest(manifestPath, label) {
    let stat;
    try {
        stat = fs.lstatSync(manifestPath);
    } catch {
        fail(`${label}: missing package.json`);
    }
    if (stat.isSymbolicLink()) fail(`${label}: symlinked package.json is not allowed`);
    if (!stat.isFile()) fail(`${label}: package.json must be a regular file`);
}

function resolveWorkspacePaths(repositoryRoot, rawPatterns) {
    if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
        fail("root package.json: workspaces must be a non-empty array");
    }
    const resolved = [];
    const owners = new Map();

    for (const rawPattern of rawPatterns) {
        const parsed = normalizeWorkspacePattern(rawPattern);
        const basePath = path.join(repositoryRoot, ...parsed.base.split("/"));
        assertRelativeDirectoryTreeWithoutSymlink(repositoryRoot, parsed.base, `workspace pattern ${parsed.pattern}`);

        const matches = parsed.wildcard
            ? fs
                  .readdirSync(basePath, { withFileTypes: true })
                  .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
                  .sort((left, right) => left.name.localeCompare(right.name, "en"))
                  .map((entry) => {
                      if (entry.isSymbolicLink()) {
                          fail(`workspace pattern ${parsed.pattern}: symlinked child ${entry.name} is not allowed`);
                      }
                      return `${parsed.base}/${entry.name}`;
                  })
            : [parsed.base];

        if (matches.length === 0) {
            fail(`workspace pattern ${parsed.pattern}: matched no workspace directories`);
        }
        for (const relativePath of matches) {
            const previous = owners.get(relativePath);
            if (previous !== undefined) {
                fail(`${relativePath}: workspace is selected more than once by ${previous} and ${parsed.pattern}`);
            }
            owners.set(relativePath, parsed.pattern);
            const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
            assertRelativeDirectoryTreeWithoutSymlink(repositoryRoot, relativePath, `workspace ${relativePath}`);
            assertRegularManifest(path.join(absolutePath, "package.json"), `workspace ${relativePath}`);
            resolved.push(relativePath);
        }
    }
    return resolved.sort((left, right) => left.localeCompare(right, "en"));
}

function readWorkspaceManifest(repositoryRoot, relativePath) {
    const manifestPath = path.join(repositoryRoot, ...relativePath.split("/"), "package.json");
    const manifest = readJsonObject(manifestPath, `${relativePath}/package.json`);
    if (typeof manifest.name !== "string" || manifest.name.trim() !== manifest.name || manifest.name === "") {
        fail(`${relativePath}/package.json: name must be a non-empty trimmed string`);
    }
    if (typeof manifest.version !== "string" || manifest.version.trim() !== manifest.version || manifest.version === "") {
        fail(`${relativePath}/package.json: version must be a non-empty trimmed string`);
    }
    if (
        manifest.scripts !== undefined &&
        (manifest.scripts === null || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts))
    ) {
        fail(`${relativePath}/package.json: scripts must be an object when present`);
    }
    const packageBins = {};
    const rawBins =
        typeof manifest.bin === "string"
            ? { [manifest.name.split("/").at(-1)]: manifest.bin }
            : manifest.bin === undefined
              ? {}
              : manifest.bin;
    if (rawBins === null || typeof rawBins !== "object" || Array.isArray(rawBins)) {
        fail(`${relativePath}/package.json: bin must be a string or object when present`);
    }
    for (const [commandName, entryPath] of Object.entries(rawBins).sort(([left], [right]) => left.localeCompare(right, "en"))) {
        if (
            commandName.length === 0 ||
            commandName.trim() !== commandName ||
            commandName === "." ||
            commandName === ".." ||
            commandName.includes("\0") ||
            commandName.includes("/") ||
            commandName.includes("\\")
        ) {
            fail(`${relativePath}/package.json: bin command ${JSON.stringify(commandName)} is unsafe`);
        }
        if (typeof entryPath !== "string" || entryPath.length === 0) {
            fail(`${relativePath}/package.json: bin.${commandName} must be a non-empty string`);
        }
        packageBins[commandName] = entryPath;
    }

    const dependencySpecs = new Map();
    const dependencySections = new Map();
    for (const section of DEPENDENCY_SECTIONS) {
        const dependencies = manifest[section];
        if (dependencies === undefined) continue;
        if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
            fail(`${relativePath}/package.json: ${section} must be an object when present`);
        }
        for (const [dependencyName, dependencySpec] of Object.entries(dependencies)) {
            if (typeof dependencySpec !== "string" || dependencySpec.length === 0) {
                fail(`${relativePath}/package.json: ${section}.${dependencyName} must be a non-empty string`);
            }
            const previous = dependencySpecs.get(dependencyName);
            if (previous !== undefined && previous !== dependencySpec) {
                fail(
                    `${relativePath}/package.json: ${dependencyName} has conflicting dependency specs ${previous} and ${dependencySpec}`,
                );
            }
            dependencySpecs.set(dependencyName, dependencySpec);
            const sections = dependencySections.get(dependencyName) ?? new Set();
            sections.add(section);
            dependencySections.set(dependencyName, sections);
        }
    }

    return {
        name: manifest.name,
        version: manifest.version,
        relativePath,
        private: manifest.private === true,
        main: typeof manifest.main === "string" ? manifest.main : null,
        types: typeof manifest.types === "string" ? manifest.types : null,
        packageBins: Object.freeze(packageBins),
        packageFiles: Array.isArray(manifest.files) ? Object.freeze([...manifest.files]) : (manifest.files ?? null),
        scripts: Object.freeze({ ...(manifest.scripts ?? {}) }),
        dependencySpecs,
        dependencySections,
    };
}

function findCycle(packagesByName) {
    const state = new Map();
    const stack = [];

    function visit(packageName) {
        state.set(packageName, 1);
        stack.push(packageName);
        const dependencyNames = [...packagesByName.get(packageName).internalDependencyNames].sort((left, right) =>
            left.localeCompare(right, "en"),
        );
        for (const dependencyName of dependencyNames) {
            if (state.get(dependencyName) === 1) {
                const start = stack.indexOf(dependencyName);
                return [...stack.slice(start), dependencyName];
            }
            if (state.get(dependencyName) !== 2) {
                const cycle = visit(dependencyName);
                if (cycle !== null) return cycle;
            }
        }
        stack.pop();
        state.set(packageName, 2);
        return null;
    }

    for (const packageName of [...packagesByName.keys()].sort((left, right) => left.localeCompare(right, "en"))) {
        if (state.has(packageName)) continue;
        const cycle = visit(packageName);
        if (cycle !== null) return cycle;
    }
    return [];
}

function topologicalOrder(packagesByName) {
    const dependencyCounts = new Map();
    const dependents = new Map([...packagesByName.keys()].map((name) => [name, []]));
    for (const [packageName, workspacePackage] of packagesByName) {
        dependencyCounts.set(packageName, workspacePackage.internalDependencyNames.length);
        for (const dependencyName of workspacePackage.internalDependencyNames) {
            dependents.get(dependencyName).push(packageName);
        }
    }
    for (const values of dependents.values()) {
        values.sort((left, right) => left.localeCompare(right, "en"));
    }

    const ready = [...packagesByName.keys()]
        .filter((name) => dependencyCounts.get(name) === 0)
        .sort((left, right) => left.localeCompare(right, "en"));
    const ordered = [];
    while (ready.length > 0) {
        const packageName = ready.shift();
        ordered.push(packagesByName.get(packageName));
        for (const dependentName of dependents.get(packageName)) {
            const remaining = dependencyCounts.get(dependentName) - 1;
            dependencyCounts.set(dependentName, remaining);
            if (remaining === 0) {
                ready.push(dependentName);
                ready.sort((left, right) => left.localeCompare(right, "en"));
            }
        }
    }
    if (ordered.length !== packagesByName.size) {
        const cycle = findCycle(packagesByName);
        fail(`internal workspace dependency cycle: ${cycle.join(" -> ")}`);
    }
    return ordered;
}

export function resolveWorkspaceGraph(repositoryRoot = process.cwd()) {
    let absoluteRoot;
    try {
        absoluteRoot = fs.realpathSync(path.resolve(repositoryRoot));
    } catch {
        fail("repository root: directory does not exist");
    }
    const rootManifestPath = path.join(absoluteRoot, "package.json");
    assertRegularManifest(rootManifestPath, "repository root");
    const rootManifest = readJsonObject(rootManifestPath, "root package.json");
    if (
        rootManifest.scripts !== undefined &&
        (rootManifest.scripts === null || typeof rootManifest.scripts !== "object" || Array.isArray(rootManifest.scripts))
    ) {
        fail("root package.json: scripts must be an object when present");
    }
    const workspacePaths = resolveWorkspacePaths(absoluteRoot, rootManifest.workspaces);
    const mutablePackages = workspacePaths.map((relativePath) => readWorkspaceManifest(absoluteRoot, relativePath));
    const packagesByName = new Map();
    for (const workspacePackage of mutablePackages) {
        const existing = packagesByName.get(workspacePackage.name);
        if (existing !== undefined) {
            fail(
                `${workspacePackage.name}: duplicate workspace name in ${existing.relativePath} and ${workspacePackage.relativePath}`,
            );
        }
        packagesByName.set(workspacePackage.name, workspacePackage);
    }

    for (const workspacePackage of mutablePackages) {
        const internalDependencyNames = [];
        const internalDeliveryDependencyNames = [];
        for (const dependencyName of workspacePackage.dependencySpecs.keys()) {
            if (packagesByName.has(dependencyName)) {
                internalDependencyNames.push(dependencyName);
                const sections = workspacePackage.dependencySections.get(dependencyName);
                if (sections !== undefined && [...sections].some((section) => DELIVERY_DEPENDENCY_SECTIONS.has(section))) {
                    internalDeliveryDependencyNames.push(dependencyName);
                }
            } else if (dependencyName.startsWith("@oaam/")) {
                fail(
                    `${workspacePackage.relativePath}/package.json: internal dependency ${dependencyName} is not declared by root workspaces`,
                );
            }
        }
        internalDependencyNames.sort((left, right) => left.localeCompare(right, "en"));
        internalDeliveryDependencyNames.sort((left, right) => left.localeCompare(right, "en"));
        workspacePackage.internalDependencyNames = Object.freeze(internalDependencyNames);
        workspacePackage.internalDeliveryDependencyNames = Object.freeze(internalDeliveryDependencyNames);
        delete workspacePackage.dependencySpecs;
        delete workspacePackage.dependencySections;
        Object.freeze(workspacePackage);
    }

    const topologicalPackages = Object.freeze(topologicalOrder(packagesByName));
    const packages = Object.freeze([...packagesByName.values()].sort((left, right) => left.name.localeCompare(right.name, "en")));
    return Object.freeze({
        repositoryRoot: absoluteRoot,
        rootPackageName: typeof rootManifest.name === "string" ? rootManifest.name : null,
        rootScripts: Object.freeze({ ...(rootManifest.scripts ?? {}) }),
        workspacePatterns: Object.freeze([...rootManifest.workspaces]),
        packages,
        topologicalPackages,
    });
}

function graphForJson(graph) {
    return {
        repositoryRoot: graph.repositoryRoot,
        rootPackageName: graph.rootPackageName,
        rootScripts: graph.rootScripts,
        workspacePatterns: graph.workspacePatterns,
        packages: graph.packages,
        topologicalPackageNames: graph.topologicalPackages.map((entry) => entry.name),
    };
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
    const repositoryRoot = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    try {
        process.stdout.write(`${JSON.stringify(graphForJson(resolveWorkspaceGraph(repositoryRoot)), null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
