#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkspaceGraph, WorkspaceGraphError } from "./workspace-graph.mjs";
import { tryClassifyWorkspaceRole } from "./workspace-roles.mjs";

export const REQUIRED_WORKSPACE_SCRIPT_COMMANDS = Object.freeze({
    build: "tsc",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    "test:coverage": "vitest run --coverage",
});

export const REQUIRED_WORKSPACE_SCRIPTS = Object.freeze(Object.keys(REQUIRED_WORKSPACE_SCRIPT_COMMANDS));

export function expectedWorkspaceScriptCommand(workspacePackage, scriptName) {
    if (scriptName === "build" && tryClassifyWorkspaceRole(workspacePackage) === "client_desktop") {
        return "tsc && vite build && vite build --config vite.preload.config.ts && node ../../../tests/repository/product-release.mjs desktop";
    }
    return REQUIRED_WORKSPACE_SCRIPT_COMMANDS[scriptName];
}

function assertScriptName(scriptName) {
    if (typeof scriptName !== "string" || !/^[a-z0-9][a-z0-9:_-]*$/u.test(scriptName)) {
        throw new WorkspaceGraphError(`invalid npm script name ${JSON.stringify(scriptName)}`);
    }
}

export function validateWorkspaceScriptContracts(graph, requiredScripts = REQUIRED_WORKSPACE_SCRIPTS) {
    const errors = [];
    for (const scriptName of requiredScripts) assertScriptName(scriptName);
    for (const workspacePackage of graph.packages) {
        for (const scriptName of requiredScripts) {
            const actual = workspacePackage.scripts[scriptName];
            if (typeof actual !== "string" || actual.trim() === "") {
                errors.push(`${workspacePackage.relativePath}: missing required script ${scriptName}`);
                continue;
            }
            const expected = expectedWorkspaceScriptCommand(workspacePackage, scriptName);
            if (expected !== undefined && actual !== expected) {
                errors.push(
                    `${workspacePackage.relativePath}: script ${scriptName} must be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
                );
            }
        }
    }
    if (errors.length > 0) {
        throw new WorkspaceGraphError(`workspace script contract failed:\n${errors.join("\n")}`);
    }
}

export function validateRootScriptContracts(graph, requiredScripts, expectedCommands = {}) {
    const errors = [];
    for (const scriptName of requiredScripts) {
        assertScriptName(scriptName);
        const actual = graph.rootScripts[scriptName];
        if (typeof actual !== "string" || actual.trim() === "") {
            errors.push(`root package.json: missing required script ${scriptName}`);
            continue;
        }
        const expected = expectedCommands[scriptName];
        if (expected !== undefined && actual !== expected) {
            errors.push(
                `root package.json: script ${scriptName} must be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
            );
        }
    }
    if (errors.length > 0) {
        throw new WorkspaceGraphError(`root script contract failed:\n${errors.join("\n")}`);
    }
}

function npmCommand(platform = process.platform) {
    return platform === "win32" ? "npm.cmd" : "npm";
}

export function createWorkspaceScriptInvocations(graph, scriptName) {
    assertScriptName(scriptName);
    validateWorkspaceScriptContracts(graph, [scriptName]);
    return Object.freeze(
        graph.topologicalPackages.map((workspacePackage) =>
            Object.freeze({
                kind: "workspace",
                label: `${scriptName} ${workspacePackage.name}`,
                command: npmCommand(),
                args: Object.freeze(["run", scriptName, "--workspace", workspacePackage.relativePath]),
                cwd: graph.repositoryRoot,
                packageName: workspacePackage.name,
                relativePath: workspacePackage.relativePath,
                scriptName,
            }),
        ),
    );
}

export function createRootScriptInvocation(graph, scriptName) {
    assertScriptName(scriptName);
    validateRootScriptContracts(graph, [scriptName]);
    return Object.freeze({
        kind: "root",
        label: `${scriptName} repository root`,
        command: npmCommand(),
        args: Object.freeze(["run", scriptName]),
        cwd: graph.repositoryRoot,
        packageName: graph.rootPackageName,
        relativePath: ".",
        scriptName,
    });
}

export function resolveNpmInvocation(invocation, env = process.env) {
    let command = invocation.command;
    const args = [...invocation.args];
    if (command === "npm.cmd") {
        // npm run supplies its CLI path. Execute it with Node so Windows does not need a shell.
        const npmCli = env.npm_execpath;
        if (
            typeof npmCli !== "string" ||
            !path.isAbsolute(npmCli) ||
            path.basename(npmCli) !== "npm-cli.js" ||
            !fs.existsSync(npmCli) ||
            !fs.statSync(npmCli).isFile()
        ) {
            throw new WorkspaceGraphError("Windows workspace commands require npm run with an absolute npm-cli.js path");
        }
        command = process.execPath;
        args.unshift(npmCli);
    }
    return { command, args };
}

export function executeInvocations(invocations, options = {}) {
    const spawn = options.spawn ?? spawnSync;
    const env = options.env ?? process.env;
    const reportProgress = options.reportProgress === true && env.GITHUB_ACTIONS === "true";
    const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
    if (reportProgress) {
        log(
            `[verification] host ${JSON.stringify({
                availableParallelism: availableParallelism(),
                vitestMaxForks: env.VITEST_MAX_FORKS ?? "default",
                vitestMinForks: env.VITEST_MIN_FORKS ?? "default",
            })}`,
        );
    }
    for (const invocation of invocations) {
        const startedAt = performance.now();
        let outcome = "failed";
        if (reportProgress) log(`::group::${invocation.label}`);
        try {
            const { command, args } = resolveNpmInvocation(invocation, env);
            const result = spawn(command, args, {
                cwd: invocation.cwd,
                env,
                stdio: options.stdio ?? "inherit",
            });
            if (result.error !== undefined) {
                throw new WorkspaceGraphError(`${invocation.label}: command could not start: ${result.error.message}`);
            }
            if (result.status !== 0) {
                const status = result.status === null ? `signal ${result.signal ?? "unknown"}` : result.status;
                throw new WorkspaceGraphError(`${invocation.label}: command failed with ${status}`);
            }
            outcome = "passed";
        } finally {
            if (reportProgress) {
                log(`[verification] ${invocation.label}: ${outcome} (${((performance.now() - startedAt) / 1000).toFixed(3)}s)`);
                log("::endgroup::");
            }
        }
    }
}

export function runWorkspaceScript(repositoryRoot, scriptName, options = {}) {
    const graph = resolveWorkspaceGraph(repositoryRoot);
    validateWorkspaceScriptContracts(graph);
    const invocations = createWorkspaceScriptInvocations(graph, scriptName);
    executeInvocations(invocations, options);
    return invocations;
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
    const scriptName = process.argv[2];
    try {
        if (scriptName === undefined) {
            throw new WorkspaceGraphError("usage: workspace-commands.mjs <script-name> [repository-root]");
        }
        runWorkspaceScript(process.argv[3] ?? process.cwd(), scriptName);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
