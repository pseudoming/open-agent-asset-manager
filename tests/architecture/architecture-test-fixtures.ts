import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { walkGovernedRegularFiles, walkGovernedTypeScriptSources } from "../repository/governed-filesystem.mjs";
import { collectLiteralModuleReferences } from "../repository/typescript-module-references.mjs";
import { resolveWorkspaceGraph } from "../repository/workspace-graph.mjs";
import { classifyWorkspaceRole } from "../repository/workspace-roles.mjs";

export const ROOT_DIR = path.resolve(__dirname, "../..");

export const CORE_SRC_DIR = path.resolve(ROOT_DIR, "packages/core/src");

export function walkDir(dir: string): string[] {
    return [...walkGovernedTypeScriptSources(dir, { label: path.relative(ROOT_DIR, dir) })];
}

export function walkAllFiles(dir: string): string[] {
    return [...walkGovernedRegularFiles(dir, { label: path.relative(ROOT_DIR, dir) })];
}

export type ArchitectureLayer =
    | "adapter"
    | "adapter_framework"
    | "app_server_bootstrap"
    | "app_server_host"
    | "app_server_protocol"
    | "client_framework"
    | "client_headless"
    | "client_desktop"
    | "core"
    | "shared";

interface WorkspaceIdentity {
    name: string;
    relativePath: string;
}

export interface ArchitectureSourceRoot extends WorkspaceIdentity {
    layer: ArchitectureLayer;
    sourceRoot: string;
}

export function classifyArchitectureWorkspace(workspace: WorkspaceIdentity): ArchitectureLayer {
    return classifyWorkspaceRole(workspace) as ArchitectureLayer;
}

export function resolveArchitectureSourceRoots(repositoryRoot = ROOT_DIR): ArchitectureSourceRoot[] {
    const graph = resolveWorkspaceGraph(repositoryRoot) as {
        packages: readonly WorkspaceIdentity[];
    };
    return graph.packages.map((workspace) => {
        const sourceRoot = path.join(repositoryRoot, ...workspace.relativePath.split("/"), "src");
        if (!fs.existsSync(sourceRoot)) {
            throw new Error(`${workspace.relativePath}: live workspace is missing its src directory`);
        }
        return {
            ...workspace,
            layer: classifyArchitectureWorkspace(workspace),
            sourceRoot,
        };
    });
}

export function readFileContent(file: string): string {
    return fs.readFileSync(file, "utf-8");
}

export const FORBIDDEN_CORE_IMPORTS = [
    /@oaam\/adapter-/,
    /@oaam\/app-server-/,
    /@oaam\/client/,
    /adapter-antigravity/,
    /adapter-opencode/,
    /adapter-claudecode/,
    /adapter-codex/,
    /adapter-cursor/,
    /adapter-zcode/,
    /electron/,
    /react/,
    /vue/,
    /@angular/,
    /svelte/,
];

export const FORBIDDEN_CLIENT_FRAMEWORK_IMPORTS = [
    /^@oaam\/(?!app-server-protocol(?:$|\/))/,
    /^(?:node:)?(?:assert|buffer|child_process|crypto|events|fs|http|https|module|net|os|path|perf_hooks|process|stream|tls|url|util|worker_threads)$/,
    /electron/,
    /react/,
    /vue/,
    /@angular/,
    /svelte/,
];

export const FORBIDDEN_CLIENT_HEADLESS_IMPORTS = [
    /^@oaam\/(?!app-server-bootstrap(?:$|\/)|app-server-host(?:$|\/)|app-server-protocol(?:$|\/)|client-framework(?:$|\/))/,
    /electron/,
    /react/,
    /vue/,
    /@angular/,
    /svelte/,
];

export const FORBIDDEN_CLIENT_DESKTOP_BROWSER_IMPORTS = [
    /^@oaam\/(?!app-server-protocol(?:$|\/)|client-framework(?:$|\/))/,
    /^(?:node:)?(?:assert|buffer|child_process|crypto|events|fs|http|https|module|net|os|path|perf_hooks|process|stream|tls|url|util|worker_threads)$/,
    /electron/,
];

export const FORBIDDEN_CLIENT_DESKTOP_PRELOAD_IMPORTS = [
    /@oaam\//,
    /^(?:node:)?(?:assert|buffer|child_process|crypto|events|fs|http|https|module|net|os|path|perf_hooks|process|stream|tls|url|util|worker_threads)$/,
    /react/,
    /react-dom/,
];

export const FORBIDDEN_CLIENT_DESKTOP_MAIN_IMPORTS = [
    /^@oaam\/(?!app-server-bootstrap(?:$|\/)|app-server-host(?:$|\/)|app-server-protocol(?:$|\/)|shared\/(?:filesystem|paths)$)/,
    /@oaam\/core/,
    /@oaam\/adapter-/,
    /@oaam\/client-framework/,
    /react/,
    /react-dom/,
];

export const FORBIDDEN_PROTOCOL_IMPORTS = [
    /@oaam\//,
    /^(?:node:)?(?:assert|buffer|child_process|crypto|events|fs|http|https|module|net|os|path|perf_hooks|process|stream|tls|url|util|worker_threads)$/,
    /electron/,
    /react/,
    /vue/,
    /@angular/,
    /svelte/,
];

export const FORBIDDEN_APP_SERVER_HOST_IMPORTS = [
    /@oaam\/adapter-framework/,
    /@oaam\/adapter-(?:antigravity|claudecode|codex|opencode|zcode)/,
    /@oaam\/app-server-bootstrap/,
    /@oaam\/client/,
    /electron/,
    /react/,
    /vue/,
    /@angular/,
    /svelte/,
];

export const FORBIDDEN_APP_SERVER_BOOTSTRAP_IMPORTS = [
    /^@oaam\/(?!adapter-(?:antigravity|claudecode|codex|cursor|opencode|zcode)(?:$|\/)|app-server-host(?:$|\/)|core(?:$|\/))/,
    /electron/,
    /react/,
    /vue/,
    /@angular/,
    /svelte/,
];

export const CONCRETE_PROVIDER_IMPORTS = [
    "@oaam/adapter-antigravity",
    "@oaam/adapter-claudecode",
    "@oaam/adapter-codex",
    "@oaam/adapter-cursor",
    "@oaam/adapter-opencode",
    "@oaam/adapter-zcode",
] as const;

export const FORBIDDEN_ADAPTER_IMPORTS = [
    /@oaam\/app-server-/,
    /@oaam\/client/,
    /@oaam\/adapter-antigravity/,
    /@oaam\/adapter-opencode/,
    /@oaam\/adapter-claudecode/,
    /@oaam\/adapter-codex/,
    /@oaam\/adapter-cursor/,
    /@oaam\/adapter-zcode/,
];

export const FORBIDDEN_SHARED_IMPORTS = [
    /@oaam\/adapter-/,
    /@oaam\/app-server-/,
    /@oaam\/client/,
    /@oaam\/core/,
    /^@oaam\/shared(?:$|\/)/,
    /^@oaam\/shared-/,
];

export function collectModuleSpecifiers(file: string, content = readFileContent(file)): string[] {
    return collectLiteralModuleReferences(file, content).map((reference) => reference.specifier);
}

const FILESYSTEM_MODULES = new Set(["fs", "fs/promises", "node:fs", "node:fs/promises", "@oaam/shared/filesystem"]);

const NODE_FS_READ_VALUES = new Set([
    "accessSync",
    "closeSync",
    "constants",
    "lstatSync",
    "openSync",
    "readSync",
    "realpathSync",
    "statSync",
]);

const NO_REVIEWED_DIRECT_VALUES = new Set<string>();

const SHARED_FS_READ_VALUES = new Set([
    "SafeFilesystemError",
    "CommittedSqliteSnapshotError",
    "inspectFilesystemFailure",
    "readCommittedSqliteSnapshot",
    "readDirectoryEntriesBounded",
    "readRegularFileBounded",
]);

const PROVIDER_PROBE_IDENTITY_OWNER = path.join(ROOT_DIR, "packages/adapter/framework/src/provider-probe-filesystem.ts");
const PROVIDER_PROBE_PROCESS_OWNER = path.join(ROOT_DIR, "packages/adapter/framework/src/provider-probe-process.ts");
const SHARED_PROCESS_OBSERVATION_VALUES = new Set([
    "invokeLocalExecutableTreeBounded",
    "listLocalProcessExecutableCandidateIdsBounded",
    "listLocalProcessIdsBounded",
    "observeLocalProcessBounded",
    "observeLocalProcessExecutableBounded",
]);
const PROVIDER_PROBE_IDENTITY_VALUES = new Set([
    "observeDirectoryMembersBounded",
    ...SHARED_FS_READ_VALUES,
    "inspectDirectoryNoFollow",
    "inspectRegularFileNoFollow",
    "inventoryDirectoryNoFollow",
    "readRegularFileRangeNoFollow",
    "readRegularFileNoFollow",
    "readVolatileDirectoryEntriesBounded",
    "samePhysicalPathIdentity",
]);

function literalModuleName(node: ts.Expression | undefined): string | null {
    return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

function propertyName(node: ts.Expression): string | null {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return literalModuleName(node.argumentExpression);
    return null;
}

function allowedFilesystemValues(moduleName: string, file: string): ReadonlySet<string> | null {
    if (moduleName === "node:fs") return NODE_FS_READ_VALUES;
    if (moduleName === "node:fs/promises") return NO_REVIEWED_DIRECT_VALUES;
    if (moduleName === "@oaam/shared/filesystem") {
        return path.resolve(file) === PROVIDER_PROBE_IDENTITY_OWNER ? PROVIDER_PROBE_IDENTITY_VALUES : SHARED_FS_READ_VALUES;
    }
    return null;
}

export function collectAdapterFilesystemAuthorityViolations(file: string, content = readFileContent(file)): string[] {
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const label = path.relative(ROOT_DIR, file);
    const violations: string[] = [];
    const openAliases = new Set<string>();
    const addViolation = (message: string): void => {
        violations.push(`${label}: ${message}`);
    };

    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
            const moduleName = literalModuleName(statement.moduleSpecifier);
            if (moduleName === null || !FILESYSTEM_MODULES.has(moduleName)) continue;
            if (moduleName === "fs" || moduleName === "fs/promises") {
                addViolation(`filesystem imports must use the canonical node: specifier, not ${moduleName}`);
                continue;
            }
            const clause = statement.importClause;
            if (
                clause === undefined ||
                clause.name !== undefined ||
                clause.namedBindings === undefined ||
                !ts.isNamedImports(clause.namedBindings)
            ) {
                addViolation(`${moduleName} must use static named imports only`);
                continue;
            }
            const allowedValues = allowedFilesystemValues(moduleName, file);
            for (const element of clause.namedBindings.elements) {
                const importedName = (element.propertyName ?? element.name).text;
                if (clause.isTypeOnly || element.isTypeOnly) continue;
                if (allowedValues === null || !allowedValues.has(importedName)) {
                    addViolation(`${moduleName} value import ${importedName} is not in the reviewed read-only surface`);
                    continue;
                }
                if (moduleName === "node:fs" && importedName === "openSync") {
                    openAliases.add(element.name.text);
                }
            }
        } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
            const moduleName = literalModuleName(statement.moduleReference.expression);
            if (moduleName !== null && FILESYSTEM_MODULES.has(moduleName)) {
                addViolation(`${moduleName} import-equals bypasses the static named read-only surface`);
            }
        } else if (ts.isExportDeclaration(statement)) {
            const moduleName = literalModuleName(statement.moduleSpecifier);
            if (moduleName !== null && FILESYSTEM_MODULES.has(moduleName)) {
                addViolation(`${moduleName} filesystem bindings must not be re-exported by an adapter`);
            }
        }
    }

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const moduleName = literalModuleName(node.arguments[0]);
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const calledName = propertyName(node.expression) ?? (ts.isIdentifier(node.expression) ? node.expression.text : null);
            if (
                moduleName !== null &&
                FILESYSTEM_MODULES.has(moduleName) &&
                (isRequire || isDynamicImport || calledName === "getBuiltinModule")
            ) {
                addViolation(`${moduleName} must not be loaded through require/import()/getBuiltinModule`);
            }
            if (ts.isIdentifier(node.expression) && openAliases.has(node.expression.text)) {
                const flag = node.arguments[1];
                if (!ts.isStringLiteralLike(flag) || (flag.text !== "r" && flag.text !== "rs")) {
                    addViolation(`openSync must be called directly with the literal read-only flag "r" or "rs"`);
                }
            }
        }
        if (ts.isIdentifier(node) && openAliases.has(node.text)) {
            const parent = node.parent;
            const isImportName = ts.isImportSpecifier(parent);
            const isDirectCall = ts.isCallExpression(parent) && parent.expression === node;
            if (!isImportName && !isDirectCall) {
                addViolation(`openSync binding ${node.text} must not be forwarded or stored`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return violations;
}

export function collectAdapterProcessObservationAuthorityViolations(file: string, content = readFileContent(file)): string[] {
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const label = path.relative(ROOT_DIR, file);
    const violations: string[] = [];
    const resolvedFile = path.resolve(file);
    const addViolation = (message: string): void => {
        violations.push(`${label}: ${message}`);
    };

    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && literalModuleName(statement.moduleSpecifier) === "@oaam/shared/paths") {
            const clause = statement.importClause;
            if (
                clause === undefined ||
                clause.name !== undefined ||
                clause.namedBindings === undefined ||
                !ts.isNamedImports(clause.namedBindings)
            ) {
                addViolation("@oaam/shared/paths process observation requires static named imports");
                continue;
            }
            for (const element of clause.namedBindings.elements) {
                if (clause.isTypeOnly || element.isTypeOnly) continue;
                const importedName = (element.propertyName ?? element.name).text;
                const owner = resolvedFile === PROVIDER_PROBE_PROCESS_OWNER;
                if (SHARED_PROCESS_OBSERVATION_VALUES.has(importedName) && !owner) {
                    addViolation(`${importedName} is restricted to the exact Adapter Framework process-probe owner`);
                }
            }
        }
        if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
            if (literalModuleName(statement.moduleReference.expression) === "@oaam/shared/paths") {
                addViolation("@oaam/shared/paths import-equals bypasses the static process-observation surface");
            }
        }
        if (ts.isExportDeclaration(statement) && literalModuleName(statement.moduleSpecifier) === "@oaam/shared/paths") {
            if (
                statement.exportClause === undefined ||
                (ts.isNamedExports(statement.exportClause) &&
                    statement.exportClause.elements.some((element) =>
                        SHARED_PROCESS_OBSERVATION_VALUES.has((element.propertyName ?? element.name).text),
                    ))
            ) {
                addViolation("local process observation must not be re-exported by an adapter");
            }
        }
    }

    const visit = (node: ts.Node): void => {
        if (
            (ts.isStringLiteralLike(node) && /^\/proc(?:\/|$)/u.test(node.text)) ||
            (ts.isTemplateExpression(node) && /^\/proc(?:\/|$)/u.test(node.head.text))
        ) {
            addViolation("raw Unix process-table paths are restricted to the build-selected Shared target");
        }
        if (ts.isCallExpression(node) && literalModuleName(node.arguments[0]) === "@oaam/shared/paths") {
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const calledName = propertyName(node.expression);
            if (isRequire || isDynamicImport || calledName === "getBuiltinModule") {
                addViolation("@oaam/shared/paths must not be loaded dynamically by an adapter");
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return violations;
}

export function checkForbiddenImports(files: string[], patterns: RegExp[]): string[] {
    const violations: string[] = [];
    for (const file of files) {
        for (const importPath of collectModuleSpecifiers(file)) {
            for (const pattern of patterns) {
                pattern.lastIndex = 0;
                if (pattern.test(importPath)) {
                    violations.push(`${path.relative(ROOT_DIR, file)}: imports "${importPath}" (matches ${pattern})`);
                }
            }
        }
    }
    return violations;
}
