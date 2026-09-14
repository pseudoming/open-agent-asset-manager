#!/usr/bin/env node

/**
 * CI static scan: validate every Istanbul ignore annotation in production TypeScript source.
 *
 * The only allowed form is the exact block directive immediately before an
 * INSERT/UPDATE-then-SELECT defensive fallback. Source discovery is derived from the live workspace graph,
 * follows the repository-wide no-symlink traversal rule, and includes every governed TypeScript
 * source extension. TypeScript's parsed comment ranges identify real block comments so strings
 * cannot imitate an annotation and multiline annotations cannot escape a line-oriented scan.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { walkGovernedTypeScriptSources } from "../repository/governed-filesystem.mjs";
import { resolveWorkspaceGraph } from "../repository/workspace-graph.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const VALID_ANNOTATION = "/* istanbul ignore next -- @preserve: defensive-unreachable */";
const IGNORE_COMMENT_PATTERN = /\bistanbul\s+ignore\b/iu;
const MUTATION_CALLEE_PATTERN = /^(?:insert|replace|update|upsert)/iu;
const SQL_MUTATION_PATTERN = /\b(?:INSERT|REPLACE|UPDATE)\b/iu;

function lineIndexAt(content, offset) {
    return content.slice(0, offset).match(/\n/gu)?.length ?? 0;
}

function parsedCommentRanges(content, sourceFile) {
    const ranges = new Map();
    const add = (candidates) => {
        for (const range of candidates ?? []) ranges.set(`${range.pos}:${range.end}`, range);
    };
    const visit = (node) => {
        add(ts.getLeadingCommentRanges(content, node.getFullStart()));
        add(ts.getTrailingCommentRanges(content, node.end));
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...ranges.values()].sort((left, right) => left.pos - right.pos);
}

function calledName(expression) {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (
        ts.isElementAccessExpression(expression) &&
        expression.argumentExpression !== undefined &&
        ts.isStringLiteralLike(expression.argumentExpression)
    ) {
        return expression.argumentExpression.text;
    }
    return null;
}

function hasMutationSqlArgument(call) {
    return call.arguments.some(
        (argument) => ts.isStringLiteralLike(argument) && SQL_MUTATION_PATTERN.test(argument.text),
    );
}

function executesPreparedMutation(call) {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "run") {
        return false;
    }
    const prepared = call.expression.expression;
    return (
        ts.isCallExpression(prepared) &&
        calledName(prepared.expression) === "prepare" &&
        hasMutationSqlArgument(prepared)
    );
}

function containsMutationCall(node) {
    let found = false;
    const visit = (candidate) => {
        if (found) return;
        if (ts.isCallExpression(candidate)) {
            const name = calledName(candidate.expression);
            if (name !== null && MUTATION_CALLEE_PATTERN.test(name)) {
                found = true;
                return;
            }
            if (
                name !== null &&
                /^(?:exec|run)$/u.test(name) &&
                hasMutationSqlArgument(candidate)
            ) {
                found = true;
                return;
            }
            if (executesPreparedMutation(candidate)) {
                found = true;
                return;
            }
        }
        ts.forEachChild(candidate, visit);
    };
    visit(node);
    return found;
}

function findImmediatelyFollowingIf(sourceFile, content, commentEnd) {
    let following = null;
    const visit = (node) => {
        if (ts.isIfStatement(node)) {
            const start = node.getStart(sourceFile);
            if (
                start >= commentEnd &&
                content.slice(commentEnd, start).trim() === "" &&
                (following === null || start < following.getStart(sourceFile))
            ) {
                following = node;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return following;
}

function defensiveThrowStatement(statement) {
    if (ts.isThrowStatement(statement)) return statement;
    if (ts.isBlock(statement) && statement.statements.length === 1) {
        const [onlyStatement] = statement.statements;
        return ts.isThrowStatement(onlyStatement) ? onlyStatement : null;
    }
    return null;
}

function isDefensiveNotFoundThrow(statement) {
    if (statement === null) return false;
    const condition = statement.expression;
    if (
        !ts.isPrefixUnaryExpression(condition) ||
        condition.operator !== ts.SyntaxKind.ExclamationToken ||
        !ts.isIdentifier(condition.operand)
    ) {
        return false;
    }
    const throwStatement = defensiveThrowStatement(statement.thenStatement);
    const thrown = throwStatement?.expression;
    if (thrown === undefined || !ts.isNewExpression(thrown)) return false;
    const message = thrown.arguments?.[0];
    return (
        message !== undefined &&
        ts.isStringLiteralLike(message) &&
        /not found after (?:insert|update)/iu.test(message.text)
    );
}

function hasMutationBefore(sourceFile, statement, annotationLine) {
    const parent = statement.parent;
    if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return false;
    const index = parent.statements.findIndex((candidate) => candidate === statement);
    if (index < 1) return false;
    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const candidate = parent.statements[candidateIndex];
        const candidateEndLine = sourceFile.getLineAndCharacterOfPosition(candidate.end).line;
        if (candidateEndLine < annotationLine - 30) break;
        if (containsMutationCall(candidate)) return true;
    }
    return false;
}

export function scanIgnoreAnnotationsInContent(
    content,
    file = "<inline>",
    repositoryRoot = ROOT,
) {
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const entries = [];

    for (const range of parsedCommentRanges(content, sourceFile)) {
        const annotation = content.slice(range.pos, range.end);
        if (!IGNORE_COMMENT_PATTERN.test(annotation)) continue;

        const startLineIndex = lineIndexAt(content, range.pos);
        const following = findImmediatelyFollowingIf(sourceFile, content, range.end);

        entries.push({
            file: path.relative(repositoryRoot, file),
            line: startLineIndex + 1,
            annotation,
            isExactAnnotation: annotation === VALID_ANNOTATION,
            isDefensiveThrow: isDefensiveNotFoundThrow(following),
            hasMutationBefore:
                following !== null && hasMutationBefore(sourceFile, following, startLineIndex),
        });
    }
    return entries;
}

export function scanIgnoreAnnotationFile(file, repositoryRoot = ROOT) {
    return scanIgnoreAnnotationsInContent(fs.readFileSync(file, "utf8"), file, repositoryRoot);
}

export function collectWorkspaceIgnoreAnnotations(repositoryRoot = ROOT) {
    const graph = resolveWorkspaceGraph(repositoryRoot);
    return graph.packages.flatMap((workspacePackage) => {
        const sourceRoot = path.join(
            repositoryRoot,
            ...workspacePackage.relativePath.split("/"),
            "src",
        );
        return walkGovernedTypeScriptSources(sourceRoot, {
            label: `${workspacePackage.relativePath}/src: Istanbul ignore source tree`,
        }).flatMap((file) => scanIgnoreAnnotationFile(file, repositoryRoot));
    });
}

export function validateIgnoreAnnotations(entries) {
    const errors = [];
    for (const entry of entries) {
        if (!entry.isExactAnnotation) {
            errors.push(
                `${entry.file}:${entry.line}: Istanbul ignore must be exactly ${JSON.stringify(VALID_ANNOTATION)}`,
            );
        }
        if (!entry.isDefensiveThrow) {
            errors.push(
                `${entry.file}:${entry.line}: next line is not the defensive not-found-after-insert/update throw`,
            );
        }
        if (!entry.hasMutationBefore) {
            errors.push(
                `${entry.file}:${entry.line}: no real insert/replace/update/upsert call occurs in the preceding 30 lines`,
            );
        }
    }
    return errors;
}

export function runIgnoreAnnotationCheck(repositoryRoot = ROOT) {
    const entries = collectWorkspaceIgnoreAnnotations(repositoryRoot);
    return Object.freeze({
        entries: Object.freeze(entries),
        errors: Object.freeze(validateIgnoreAnnotations(entries)),
    });
}

function main() {
    const result = runIgnoreAnnotationCheck();
    process.stdout.write(
        `istanbul ignore count: ${result.entries.length} (no hard limit, pattern check enforces validity)\n`,
    );
    for (const error of result.errors) process.stderr.write(`ERROR: ${error}\n`);
    if (result.entries.length > 0) {
        process.stdout.write("\nAll istanbul ignore annotations:\n");
        for (const entry of result.entries) {
            process.stdout.write(`  ${entry.file}:${entry.line}\n`);
        }
    }
    if (result.errors.length > 0) {
        process.stderr.write("\nistanbul ignore check FAILED.\n");
        process.exitCode = 1;
    } else {
        process.stdout.write("\nistanbul ignore check PASSED.\n");
    }
}

const invokedPath =
    process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) main();
