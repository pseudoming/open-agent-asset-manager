import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { walkDir } from "./architecture-test-fixtures";

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const CORE_SOURCE_ROOT = path.join(REPOSITORY_ROOT, "packages/core/src");

interface CoreTopologyConfiguration {
    schemaVersion: 1;
    allowedRootFiles: string[];
    rootDomains: Record<string, string>;
    domains: Record<string, string[]>;
}

interface InternalEdge {
    source: string;
    target: string;
    edgeKind: "runtime" | "type";
}

const topology = readJson<CoreTopologyConfiguration>(path.join(__dirname, "core-topology.json"));

function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function repositoryPath(absolute: string): string {
    return path.relative(CORE_SOURCE_ROOT, absolute).split(path.sep).join("/");
}

function domainFor(relativePath: string): string | null {
    const separator = relativePath.indexOf("/");
    if (separator >= 0) {
        const directory = relativePath.slice(0, separator);
        return directory in topology.domains ? directory : null;
    }
    if (topology.allowedRootFiles.includes(relativePath)) return topology.rootDomains[relativePath] ?? "entrypoint";
    return null;
}

function resolveRelativeImport(sourceFile: string, specifier: string, existingFiles: Set<string>): string | null {
    if (!specifier.startsWith(".")) return null;
    const base = path.resolve(path.dirname(sourceFile), specifier);
    const candidates = [base];
    for (const extension of [".cts", ".mts", ".ts", ".tsx"]) {
        candidates.push(`${base}${extension}`, path.join(base, `index${extension}`));
    }
    for (const candidate of candidates) {
        if (existingFiles.has(candidate)) return candidate;
    }
    return `UNRESOLVED:${repositoryPath(sourceFile)}:${specifier}`;
}

function importEdgeKind(node: ts.ImportDeclaration): "runtime" | "type" {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return "type";
    if (
        clause !== undefined &&
        clause.name === undefined &&
        clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)
    ) {
        return "type";
    }
    return "runtime";
}

function exportEdgeKind(node: ts.ExportDeclaration): "runtime" | "type" {
    if (node.isTypeOnly) return "type";
    if (
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly)
    ) {
        return "type";
    }
    return "runtime";
}

function collectInternalEdges(files: string[]): { edges: InternalEdge[]; unresolved: string[] } {
    const existingFiles = new Set(files);
    const edges: InternalEdge[] = [];
    const unresolved: string[] = [];
    for (const file of files) {
        const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        const record = (specifier: string, edgeKind: "runtime" | "type"): void => {
            const target = resolveRelativeImport(file, specifier, existingFiles);
            if (target === null) return;
            if (target.startsWith("UNRESOLVED:")) unresolved.push(target);
            else {
                edges.push({
                    source: repositoryPath(file),
                    target: repositoryPath(target),
                    edgeKind,
                });
            }
        };
        const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                record(node.moduleSpecifier.text, importEdgeKind(node));
            } else if (
                ts.isExportDeclaration(node) &&
                node.moduleSpecifier !== undefined &&
                ts.isStringLiteral(node.moduleSpecifier)
            ) {
                record(node.moduleSpecifier.text, exportEdgeKind(node));
            } else if (
                ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                node.arguments.length === 1 &&
                ts.isStringLiteral(node.arguments[0])
            ) {
                record(node.arguments[0].text, "runtime");
            } else if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "require" &&
                node.arguments.length === 1 &&
                ts.isStringLiteral(node.arguments[0])
            ) {
                record(node.arguments[0].text, "runtime");
            } else if (
                ts.isImportEqualsDeclaration(node) &&
                ts.isExternalModuleReference(node.moduleReference) &&
                node.moduleReference.expression !== undefined &&
                ts.isStringLiteral(node.moduleReference.expression)
            ) {
                record(node.moduleReference.expression.text, node.isTypeOnly ? "type" : "runtime");
            } else if (
                ts.isImportTypeNode(node) &&
                ts.isLiteralTypeNode(node.argument) &&
                ts.isStringLiteral(node.argument.literal)
            ) {
                record(node.argument.literal.text, "type");
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    return { edges, unresolved };
}

function findCycles(graph: Map<string, Set<string>>): string[][] {
    const states = new Map<string, "active" | "done">();
    const stack: string[] = [];
    const cycles: string[][] = [];
    const visit = (node: string): void => {
        if (states.get(node) === "done") return;
        if (states.get(node) === "active") {
            const start = stack.indexOf(node);
            cycles.push([...stack.slice(start), node]);
            return;
        }
        states.set(node, "active");
        stack.push(node);
        for (const target of graph.get(node) ?? []) visit(target);
        stack.pop();
        states.set(node, "done");
    };
    for (const node of graph.keys()) visit(node);
    return cycles;
}

describe("architecture: Core internal topology", () => {
    const files = walkDir(CORE_SOURCE_ROOT).sort();

    it("classifies every Core source file and restricts the flat root to reviewed entry files", () => {
        expect(topology.schemaVersion).toBe(1);
        const unexpectedRootFiles = files
            .map(repositoryPath)
            .filter((file) => !file.includes("/") && !topology.allowedRootFiles.includes(file))
            .sort();
        expect(unexpectedRootFiles).toEqual([]);
        expect(topology.allowedRootFiles.filter((file) => !files.some((absolute) => repositoryPath(absolute) === file))).toEqual(
            [],
        );
        expect(files.map(repositoryPath).filter((file) => file.startsWith("entrypoint/"))).toEqual([]);
        expect(files.map(repositoryPath).filter((file) => domainFor(file) === null)).toEqual([]);
    });

    it("keeps the declared runtime domain dependency graph acyclic", () => {
        expect(topology.rootDomains).toEqual({ "restricted-operations.ts": "restricted_entrypoint" });
        expect(topology.domains.restricted_entrypoint).toEqual(["deployment", "orchestration", "source-import"]);
        const declaredDomains = new Set(Object.keys(topology.domains));
        const unknownDependencies = Object.entries(topology.domains).flatMap(([domain, dependencies]) =>
            dependencies
                .filter((dependency) => !declaredDomains.has(dependency))
                .map((dependency) => `${domain} -> ${dependency}`),
        );
        expect(unknownDependencies).toEqual([]);
        const graph = new Map(Object.entries(topology.domains).map(([domain, dependencies]) => [domain, new Set(dependencies)]));
        expect(findCycles(graph)).toEqual([]);
    });

    it("resolves every relative import and rejects runtime dependencies outside the domain DAG", () => {
        const { edges, unresolved } = collectInternalEdges(files);
        expect(unresolved).toEqual([]);
        const violations = edges
            .filter((edge) => edge.edgeKind === "runtime")
            .flatMap((edge) => {
                const sourceDomain = domainFor(edge.source);
                const targetDomain = domainFor(edge.target);
                if (sourceDomain === null || targetDomain === null || sourceDomain === targetDomain) {
                    return [];
                }
                const allowed = topology.domains[sourceDomain]?.includes(targetDomain) ?? false;
                return allowed ? [] : [`${edge.source} (${sourceDomain}) -> ${edge.target} (${targetDomain})`];
            });
        expect(violations).toEqual([]);
    });

    it("keeps the concrete runtime import graph cycle-free", () => {
        const runtimeEdges = collectInternalEdges(files).edges.filter((edge) => edge.edgeKind === "runtime");
        const graph = new Map(files.map((file) => [repositoryPath(file), new Set<string>()]));
        for (const edge of runtimeEdges) graph.get(edge.source)?.add(edge.target);
        expect(findCycles(graph)).toEqual([]);
    });

    it("distinguishes type-only imports and exports from runtime-bearing edges", () => {
        const source = ts.createSourceFile(
            "classification.ts",
            [
                'import type { A } from "./a";',
                'import { type B } from "./b";',
                'import { c } from "./c";',
                'export type { D } from "./d";',
                'export { type E } from "./e";',
                'export { f } from "./f";',
                'const g = require("./g");',
                'import h = require("./h");',
                'type I = import("./i").I;',
                'const j = import("./j");',
                'import type K = require("./k");',
            ].join("\n"),
            ts.ScriptTarget.Latest,
            true,
        );
        const kinds = source.statements.flatMap((statement) => {
            if (ts.isImportDeclaration(statement)) return [importEdgeKind(statement)];
            if (ts.isExportDeclaration(statement)) return [exportEdgeKind(statement)];
            return [];
        });
        const dynamicKinds: Array<"runtime" | "type"> = [];
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
                dynamicKinds.push("runtime");
            } else if (ts.isImportEqualsDeclaration(node)) {
                dynamicKinds.push(node.isTypeOnly ? "type" : "runtime");
            } else if (ts.isImportTypeNode(node)) {
                dynamicKinds.push("type");
            } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                dynamicKinds.push("runtime");
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        expect([...kinds, ...dynamicKinds]).toEqual([
            "type",
            "type",
            "runtime",
            "type",
            "type",
            "runtime",
            "runtime",
            "runtime",
            "type",
            "runtime",
            "type",
        ]);
    });
});
