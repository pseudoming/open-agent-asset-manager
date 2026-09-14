import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { walkGovernedTypeScriptSources } from "./governed-filesystem.mjs";
import { collectLiteralModuleReferences } from "./typescript-module-references.mjs";
import { WorkspaceGraphError } from "./workspace-graph.mjs";
import { tryClassifyWorkspaceRole } from "./workspace-roles.mjs";

function fail(message) {
    throw new WorkspaceGraphError(message);
}

function findWorkspacePackageForSpecifier(specifier, workspaceNames) {
    return (
        workspaceNames.find((workspaceName) => specifier === workspaceName || specifier.startsWith(`${workspaceName}/`)) ?? null
    );
}

function oaamPackageName(specifier) {
    if (!specifier.startsWith("@oaam/")) return null;
    const segments = specifier.split("/");
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
}

export function validateProductionInternalImportManifests(graph) {
    const workspaceNames = graph.packages
        .map((entry) => entry.name)
        .sort((left, right) => right.length - left.length || left.localeCompare(right, "en"));
    const violations = [];
    for (const workspacePackage of graph.packages) {
        const packageRoot = path.join(graph.repositoryRoot, ...workspacePackage.relativePath.split("/"));
        const sourceRoot = path.join(packageRoot, "src");
        const buildDependencies = new Set(workspacePackage.internalDependencyNames);
        const deliveryDependencies = new Set(workspacePackage.internalDeliveryDependencyNames);
        const seen = new Set();
        for (const filePath of walkGovernedTypeScriptSources(sourceRoot, {
            label: `${workspacePackage.relativePath}/src`,
        })) {
            for (const reference of collectLiteralModuleReferences(filePath)) {
                const dependencyName = findWorkspacePackageForSpecifier(reference.specifier, workspaceNames);
                if (dependencyName === workspacePackage.name) continue;
                const relativeFile = path.relative(graph.repositoryRoot, filePath).split(path.sep).join("/");
                if (dependencyName === null) {
                    const unknownName = oaamPackageName(reference.specifier);
                    if (unknownName !== null) {
                        const message = `${relativeFile}:${reference.line}: ${workspacePackage.name}: production source imports unknown internal package ${unknownName}`;
                        if (!seen.has(message)) {
                            seen.add(message);
                            violations.push(message);
                        }
                    }
                    continue;
                }
                if (deliveryDependencies.has(dependencyName)) continue;
                const reason = buildDependencies.has(dependencyName)
                    ? "it is declared only outside delivery dependency sections"
                    : "package.json has no delivery dependency";
                const message = `${relativeFile}:${reference.line}: ${workspacePackage.name}: production source imports ${dependencyName} but ${reason}`;
                if (!seen.has(message)) {
                    seen.add(message);
                    violations.push(message);
                }
            }
        }
    }
    if (violations.length > 0) {
        fail(`production import/manifest validation failed:\n${violations.join("\n")}`);
    }
}

function normalizePackagePath(rawPath, label, options = {}) {
    if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
        fail(`${label}: expected a non-empty package-relative path`);
    }
    const withoutPrefix = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
    if (
        withoutPrefix.length === 0 ||
        withoutPrefix.includes("\\") ||
        path.posix.isAbsolute(withoutPrefix) ||
        (!options.allowGlob && /[*?[\]{}!]/u.test(withoutPrefix))
    ) {
        fail(`${label}: unsafe package-relative path ${JSON.stringify(rawPath)}`);
    }
    const segments = withoutPrefix.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        fail(`${label}: non-canonical package-relative path ${JSON.stringify(rawPath)}`);
    }
    if (path.posix.normalize(withoutPrefix) !== withoutPrefix) {
        fail(`${label}: non-canonical package-relative path ${JSON.stringify(rawPath)}`);
    }
    return withoutPrefix;
}

function policyCoversPath(policyPath, candidatePath) {
    return candidatePath === policyPath || candidatePath.startsWith(`${policyPath}/`);
}

export function pathIsAtOrBelow(rootPath, candidatePath) {
    const relative = path.relative(rootPath, candidatePath);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readTypeScriptBuildPolicy(graph, workspacePackage) {
    const packageRoot = path.join(graph.repositoryRoot, ...workspacePackage.relativePath.split("/"));
    const configPath = path.join(packageRoot, "tsconfig.json");
    let configStat;
    try {
        configStat = fs.lstatSync(configPath);
    } catch {
        fail(`${workspacePackage.relativePath}/tsconfig.json: required for clean build authority`);
    }
    if (configStat.isSymbolicLink() || !configStat.isFile()) {
        fail(`${workspacePackage.relativePath}/tsconfig.json: must be a regular non-symlink file`);
    }
    const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
    if (readResult.error !== undefined) {
        fail(
            `${workspacePackage.relativePath}/tsconfig.json: ${ts.flattenDiagnosticMessageText(readResult.error.messageText, "\n")}`,
        );
    }
    const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, packageRoot, undefined, configPath);
    if (parsed.errors.length > 0) {
        fail(
            `${workspacePackage.relativePath}/tsconfig.json: ${parsed.errors
                .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
                .join("; ")}`,
        );
    }
    if (parsed.options.outDir === undefined) {
        fail(`${workspacePackage.relativePath}/tsconfig.json: compilerOptions.outDir is required`);
    }
    if (parsed.options.rootDir === undefined) {
        fail(`${workspacePackage.relativePath}/tsconfig.json: compilerOptions.rootDir is required`);
    }
    if (parsed.options.strict !== true) {
        fail(`${workspacePackage.relativePath}/tsconfig.json: compilerOptions.strict must be true`);
    }
    if (parsed.options.noCheck === true) {
        fail(`${workspacePackage.relativePath}/tsconfig.json: compilerOptions.noCheck is forbidden`);
    }
    if (parsed.options.allowJs === true) {
        fail(`${workspacePackage.relativePath}/tsconfig.json: compilerOptions.allowJs is forbidden`);
    }
    const governedSourceRoot = path.join(packageRoot, "src");
    if (path.resolve(parsed.options.rootDir) !== governedSourceRoot) {
        const relativeRootDir = path.relative(packageRoot, parsed.options.rootDir).split(path.sep).join("/");
        fail(
            `${workspacePackage.relativePath}/tsconfig.json: compiler rootDir ${relativeRootDir} must be the governed source root src`,
        );
    }
    const relativeRootDir = path.relative(packageRoot, parsed.options.rootDir).split(path.sep).join("/");
    const normalizedRootDir = normalizePackagePath(relativeRootDir, `${workspacePackage.relativePath}/tsconfig.json rootDir`);
    if (
        pathIsAtOrBelow(parsed.options.rootDir, parsed.options.outDir) ||
        pathIsAtOrBelow(parsed.options.outDir, parsed.options.rootDir)
    ) {
        const relativeOutDir = path.relative(packageRoot, parsed.options.outDir).split(path.sep).join("/");
        fail(
            `${workspacePackage.relativePath}/tsconfig.json: outDir ${relativeOutDir} overlaps compiler rootDir ${normalizedRootDir}; refusing destructive clean`,
        );
    }
    if (parsed.fileNames.length === 0) {
        fail(`${workspacePackage.relativePath}/tsconfig.json: no TypeScript input files were found`);
    }
    const compilerInputs = parsed.fileNames.map((fileName) => path.resolve(fileName));
    const outsideSourceRoot = compilerInputs
        .filter((fileName) => !pathIsAtOrBelow(governedSourceRoot, fileName))
        .map((fileName) => path.relative(packageRoot, fileName).split(path.sep).join("/"))
        .sort();
    if (outsideSourceRoot.length > 0) {
        fail(
            `${workspacePackage.relativePath}/tsconfig.json: compiler input ${outsideSourceRoot[0]} is outside governed source root src`,
        );
    }
    const compilerInputSet = new Set(compilerInputs);
    const omittedGovernedSources = walkGovernedTypeScriptSources(governedSourceRoot, {
        label: `${workspacePackage.relativePath}/src`,
    })
        .filter((fileName) => !compilerInputSet.has(path.resolve(fileName)))
        .map((fileName) => path.relative(packageRoot, fileName).split(path.sep).join("/"));
    if (omittedGovernedSources.length > 0) {
        fail(`${workspacePackage.relativePath}/tsconfig.json: compiler inputs omit governed source ${omittedGovernedSources[0]}`);
    }
    const overlappingInputs = parsed.fileNames
        .filter((fileName) => pathIsAtOrBelow(parsed.options.outDir, fileName))
        .map((fileName) => path.relative(packageRoot, fileName).split(path.sep).join("/"))
        .sort();
    if (overlappingInputs.length > 0) {
        fail(
            `${workspacePackage.relativePath}/tsconfig.json: outDir overlaps compiler input ${overlappingInputs[0]}; refusing destructive clean`,
        );
    }
    const relativeOutputRoot = path.relative(packageRoot, parsed.options.outDir).split(path.sep).join("/");
    return Object.freeze({
        outputRoot: normalizePackagePath(relativeOutputRoot, `${workspacePackage.relativePath}/tsconfig.json outDir`),
    });
}

export function validatePackageDeliveryPolicies(graph) {
    return Object.freeze(
        graph.packages.map((workspacePackage) => {
            if (workspacePackage.main === null || workspacePackage.types === null) {
                fail(`${workspacePackage.relativePath}/package.json: main and types are required for package delivery`);
            }
            const mainPath = normalizePackagePath(workspacePackage.main, `${workspacePackage.relativePath}/package.json main`);
            const typesPath = normalizePackagePath(workspacePackage.types, `${workspacePackage.relativePath}/package.json types`);
            const binEntries = Object.entries(workspacePackage.packageBins).map(([commandName, rawPath]) =>
                Object.freeze({
                    commandName,
                    entryPath: normalizePackagePath(rawPath, `${workspacePackage.relativePath}/package.json bin.${commandName}`),
                }),
            );
            if (!Array.isArray(workspacePackage.packageFiles) || workspacePackage.packageFiles.length === 0) {
                fail(`${workspacePackage.relativePath}/package.json: files must explicitly declare package contents`);
            }
            const declaredPaths = [];
            const seen = new Set();
            for (const rawPath of workspacePackage.packageFiles) {
                const declaredPath = normalizePackagePath(rawPath, `${workspacePackage.relativePath}/package.json files`);
                if (seen.has(declaredPath)) {
                    fail(`${workspacePackage.relativePath}/package.json: duplicate files entry ${declaredPath}`);
                }
                seen.add(declaredPath);
                declaredPaths.push(declaredPath);
            }
            for (const [fieldName, entryPath] of [
                ["main", mainPath],
                ["types", typesPath],
                ...binEntries.map(({ commandName, entryPath }) => [`bin.${commandName}`, entryPath]),
            ]) {
                if (!declaredPaths.some((declaredPath) => policyCoversPath(declaredPath, entryPath))) {
                    fail(`${workspacePackage.relativePath}/package.json: ${fieldName} ${entryPath} is outside files policy`);
                }
            }
            const { outputRoot } = readTypeScriptBuildPolicy(graph, workspacePackage);
            for (const [fieldName, entryPath] of [
                ["main", mainPath],
                ["types", typesPath],
                ...binEntries.map(({ commandName, entryPath }) => [`bin.${commandName}`, entryPath]),
            ]) {
                if (!entryPath.startsWith(`${outputRoot}/`)) {
                    fail(
                        `${workspacePackage.relativePath}/package.json: ${fieldName} ${entryPath} is outside TypeScript outDir ${outputRoot}`,
                    );
                }
            }
            const role = tryClassifyWorkspaceRole(workspacePackage);
            if (
                role === "client_headless" &&
                (binEntries.length !== 1 ||
                    binEntries[0].commandName !== "oaam-headless" ||
                    binEntries[0].entryPath !== "dist/index.js")
            ) {
                fail(
                    `${workspacePackage.relativePath}/package.json: client_headless must expose exactly oaam-headless -> dist/index.js`,
                );
            }
            if (
                role === "client_desktop" &&
                (binEntries.length !== 0 ||
                    mainPath !== "dist/main/index.js" ||
                    typesPath !== "dist/index.d.ts" ||
                    !declaredPaths.includes("dist"))
            ) {
                fail(
                    `${workspacePackage.relativePath}/package.json: client_desktop must expose dist/main/index.js, dist/index.d.ts, no bin and the complete dist inventory`,
                );
            }
            return Object.freeze({
                workspacePackage,
                mainPath,
                typesPath,
                binEntries: Object.freeze(binEntries),
                declaredPaths: Object.freeze(declaredPaths.sort()),
                outputRoots: Object.freeze([outputRoot]),
                role,
            });
        }),
    );
}

function inspectPackagePath(graph, policy, relativePath) {
    const packageRoot = path.join(graph.repositoryRoot, ...policy.workspacePackage.relativePath.split("/"));
    let absolutePath = packageRoot;
    const segments = relativePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
        absolutePath = path.join(absolutePath, segments[index]);
        let stat;
        try {
            stat = fs.lstatSync(absolutePath);
        } catch (error) {
            if (error?.code === "ENOENT") return Object.freeze({ kind: "missing" });
            throw error;
        }
        if (stat.isSymbolicLink()) {
            return Object.freeze({
                kind: "symlink",
                segmentPath: segments.slice(0, index + 1).join("/"),
            });
        }
        if (index < segments.length - 1 && !stat.isDirectory()) {
            return Object.freeze({
                kind: "invalid_parent",
                segmentPath: segments.slice(0, index + 1).join("/"),
            });
        }
        if (index === segments.length - 1) {
            return Object.freeze({ kind: "present", absolutePath, stat });
        }
    }
    return Object.freeze({ kind: "missing" });
}

export function cleanWorkspaceBuildOutputs(graph, policies) {
    const removed = [];
    for (const policy of policies) {
        for (const outputRoot of policy.outputRoots) {
            let absolutePath = path.join(graph.repositoryRoot, ...policy.workspacePackage.relativePath.split("/"));
            let outputExists = true;
            for (const segment of outputRoot.split("/")) {
                absolutePath = path.join(absolutePath, segment);
                let stat;
                try {
                    stat = fs.lstatSync(absolutePath);
                } catch (error) {
                    if (error?.code === "ENOENT") {
                        outputExists = false;
                        break;
                    }
                    throw error;
                }
                if (stat.isSymbolicLink()) {
                    fail(
                        `${policy.workspacePackage.relativePath}/${outputRoot}: refusing to clean a symlinked build output path`,
                    );
                }
                if (!stat.isDirectory()) {
                    fail(
                        `${policy.workspacePackage.relativePath}/${outputRoot}: build output path must contain directories only`,
                    );
                }
            }
            if (!outputExists) continue;
            fs.rmSync(absolutePath, { recursive: true, force: false });
            removed.push(`${policy.workspacePackage.relativePath}/${outputRoot}`);
        }
    }
    return Object.freeze(removed.sort());
}

function collectDeclaredRegularFiles(absolutePath, relativePath, result) {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
        fail(`declared package path ${relativePath} must not be a symlink`);
    }
    if (stat.isFile()) {
        result.push(relativePath);
        return;
    }
    if (!stat.isDirectory()) {
        fail(`declared package path ${relativePath} must be a regular file or directory`);
    }
    for (const entry of fs
        .readdirSync(absolutePath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        collectDeclaredRegularFiles(path.join(absolutePath, entry.name), `${relativePath}/${entry.name}`, result);
    }
}

export function validateBuiltPackageEntries(graph, policies) {
    const errors = [];
    for (const policy of policies) {
        for (const [fieldName, entryPath] of [
            ["main", policy.mainPath],
            ["types", policy.typesPath],
            ...policy.binEntries.map(({ commandName, entryPath }) => [`bin.${commandName}`, entryPath]),
        ]) {
            const inspected = inspectPackagePath(graph, policy, entryPath);
            if (inspected.kind === "missing") {
                errors.push(`${policy.workspacePackage.relativePath}: built ${fieldName} entry ${entryPath} is missing`);
                continue;
            }
            if (inspected.kind === "symlink") {
                errors.push(
                    `${policy.workspacePackage.relativePath}: built ${fieldName} entry ${entryPath} crosses symlink ${inspected.segmentPath}`,
                );
                continue;
            }
            if (inspected.kind === "invalid_parent" || !inspected.stat.isFile()) {
                errors.push(
                    `${policy.workspacePackage.relativePath}: built ${fieldName} entry ${entryPath} must be a regular non-symlink file`,
                );
            }
        }
    }
    if (errors.length > 0) fail(`built package entry validation failed:\n${errors.join("\n")}`);
}

export function validatePackedInventory(policy, packedFiles, repositoryRoot) {
    if (!Array.isArray(packedFiles)) {
        fail(`${policy.workspacePackage.name}: npm pack result has no files array`);
    }
    const normalizedFiles = [];
    const seen = new Set();
    for (const entry of packedFiles) {
        const packedPath = normalizePackagePath(
            typeof entry === "string" ? entry : entry?.path,
            `${policy.workspacePackage.name} packed file`,
        );
        if (seen.has(packedPath)) fail(`${policy.workspacePackage.name}: duplicate packed file ${packedPath}`);
        seen.add(packedPath);
        normalizedFiles.push(packedPath);
        if (
            packedPath !== "package.json" &&
            !policy.declaredPaths.some((declaredPath) => policyCoversPath(declaredPath, packedPath))
        ) {
            fail(`${policy.workspacePackage.name}: packed undeclared file ${packedPath}; update files policy or remove it`);
        }
    }
    for (const requiredPath of [
        "package.json",
        policy.mainPath,
        policy.typesPath,
        ...policy.binEntries.map(({ entryPath }) => entryPath),
    ]) {
        if (!seen.has(requiredPath)) {
            fail(`${policy.workspacePackage.name}: packed file ${requiredPath} is missing`);
        }
    }
    const declaredRegularFiles = [];
    for (const declaredPath of policy.declaredPaths) {
        const inspected = inspectPackagePath({ repositoryRoot }, policy, declaredPath);
        if (inspected.kind === "missing") {
            fail(`${policy.workspacePackage.name}: declared package path ${declaredPath} is missing`);
        }
        if (inspected.kind === "symlink") {
            fail(
                `${policy.workspacePackage.name}: declared package path ${declaredPath} crosses symlink ${inspected.segmentPath}`,
            );
        }
        if (inspected.kind === "invalid_parent") {
            fail(
                `${policy.workspacePackage.name}: declared package path ${declaredPath} crosses non-directory ${inspected.segmentPath}`,
            );
        }
        const previousCount = declaredRegularFiles.length;
        collectDeclaredRegularFiles(inspected.absolutePath, declaredPath, declaredRegularFiles);
        if (declaredRegularFiles.length === previousCount) {
            fail(`${policy.workspacePackage.name}: declared package path ${declaredPath} is empty`);
        }
    }
    for (const declaredFile of declaredRegularFiles) {
        if (!seen.has(declaredFile)) {
            fail(`${policy.workspacePackage.name}: declared package file ${declaredFile} was not packed`);
        }
    }
    if (policy.workspacePackage.name === "@oaam/shared") {
        const forbiddenTargetFile = normalizedFiles.find(
            (filePath) =>
                (filePath.endsWith(".node") && filePath !== "dist/paths/unix-like/native/oaam_file_lock.node") ||
                filePath.includes("/win32/") ||
                filePath.includes("win32-target-entry") ||
                filePath.includes("native-addon"),
        );
        if (forbiddenTargetFile !== undefined) {
            fail(`@oaam/shared: default Unix-like package contains a Windows target artifact ${forbiddenTargetFile}`);
        }
        if (!normalizedFiles.some((filePath) => filePath.includes("/unix-like/"))) {
            fail("@oaam/shared: default Unix-like package omits its selected implementation");
        }
    }
    return Object.freeze(normalizedFiles.sort());
}

export function validateInternalTarballClosure(graph, tarballs) {
    const expected = new Set(graph.packages.map((entry) => entry.name));
    const seen = new Set();
    for (const tarball of tarballs) {
        if (!expected.has(tarball.name)) fail(`foreign workspace tarball ${tarball.name}`);
        if (seen.has(tarball.name)) fail(`duplicate workspace tarball ${tarball.name}`);
        seen.add(tarball.name);
    }
    const missing = [...expected].filter((name) => !seen.has(name)).sort();
    if (missing.length > 0) fail(`missing workspace tarballs: ${missing.join(", ")}`);
}
