#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DESKTOP_RENDERER_CHUNK_LIMIT_BYTES = 500 * 1024;
export const DESKTOP_RENDERER_REQUIRED_CHUNK_PREFIXES = Object.freeze([
    "OnboardingPage-",
    "SettingsPage-",
    "WorkspacePage-",
    "locale-de-",
    "locale-ja-",
    "locale-zh-cn-",
    "ui-icons-",
]);

function fail(message) {
    throw new Error(message);
}

function walkRegularFiles(rootPath) {
    const files = [];
    const visit = (directoryPath) => {
        for (const entry of fs
            .readdirSync(directoryPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))) {
            const entryPath = path.join(directoryPath, entry.name);
            const stat = fs.lstatSync(entryPath);
            if (stat.isSymbolicLink()) fail(`Desktop renderer output contains a symbolic link: ${entryPath}`);
            if (stat.isDirectory()) {
                visit(entryPath);
            } else if (stat.isFile()) {
                files.push(entryPath);
            } else {
                fail(`Desktop renderer output contains a non-regular entry: ${entryPath}`);
            }
        }
    };
    visit(rootPath);
    return files;
}

function entryScriptFromHtml(htmlText) {
    const matches = [...htmlText.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/giu)];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
        fail(`Desktop renderer index must contain exactly one module entry script, received ${String(matches.length)}`);
    }
    const rawPath = matches[0][1].replace(/^\.\//u, "");
    if (
        rawPath === "" ||
        rawPath.includes("\\") ||
        path.posix.isAbsolute(rawPath) ||
        rawPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
        fail(`Desktop renderer index contains an unsafe entry script path: ${JSON.stringify(matches[0][1])}`);
    }
    return rawPath;
}

export function inspectDesktopRendererDelivery(rendererRoot) {
    const resolvedRoot = path.resolve(rendererRoot);
    const rootStat = fs.lstatSync(resolvedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        fail("Desktop renderer output root must be a direct directory");
    }
    const indexPath = path.join(resolvedRoot, "index.html");
    const indexStat = fs.lstatSync(indexPath);
    if (indexStat.isSymbolicLink() || !indexStat.isFile()) fail("Desktop renderer index.html must be a regular file");

    const files = walkRegularFiles(resolvedRoot);
    const relativeFiles = files.map((filePath) => path.relative(resolvedRoot, filePath).split(path.sep).join("/"));
    const sourceMaps = relativeFiles.filter((relativePath) => relativePath.endsWith(".map"));
    if (sourceMaps.length > 0) {
        fail(`Desktop renderer product output contains source maps:\n${sourceMaps.join("\n")}`);
    }

    const entryRelativePath = entryScriptFromHtml(fs.readFileSync(indexPath, "utf8"));
    const entryPath = path.join(resolvedRoot, ...entryRelativePath.split("/"));
    const entryStat = fs.lstatSync(entryPath);
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
        fail(`Desktop renderer entry script is missing: ${entryRelativePath}`);
    }
    if (entryStat.size > DESKTOP_RENDERER_CHUNK_LIMIT_BYTES) {
        fail(
            `Desktop renderer entry ${entryRelativePath} is ${String(entryStat.size)} bytes, above ${String(DESKTOP_RENDERER_CHUNK_LIMIT_BYTES)}`,
        );
    }

    const javascriptFiles = relativeFiles.filter((relativePath) => relativePath.endsWith(".js"));
    for (const relativePath of javascriptFiles) {
        const size = fs.lstatSync(path.join(resolvedRoot, ...relativePath.split("/"))).size;
        if (size > DESKTOP_RENDERER_CHUNK_LIMIT_BYTES) {
            fail(
                `Desktop renderer chunk ${relativePath} is ${String(size)} bytes, above ${String(DESKTOP_RENDERER_CHUNK_LIMIT_BYTES)}`,
            );
        }
    }
    for (const prefix of DESKTOP_RENDERER_REQUIRED_CHUNK_PREFIXES) {
        if (!javascriptFiles.some((relativePath) => path.posix.basename(relativePath).startsWith(prefix))) {
            fail(`Desktop renderer output is missing the required chunk ${prefix}*.js`);
        }
    }

    return Object.freeze({
        entryRelativePath,
        entryBytes: entryStat.size,
        javascriptChunkCount: javascriptFiles.length,
        sourceMapCount: sourceMaps.length,
    });
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
    try {
        const result = inspectDesktopRendererDelivery(
            process.argv[2] ?? path.join(process.cwd(), "packages", "client", "desktop", "dist", "webview"),
        );
        process.stdout.write(
            `Desktop renderer delivery verified (${result.entryRelativePath}, ${String(result.entryBytes)} bytes, ${String(result.javascriptChunkCount)} chunks).\n`,
        );
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
