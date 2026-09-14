#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    cleanWorkspaceBuildOutputs,
    validateBuiltPackageEntries,
    validatePackageDeliveryPolicies,
} from "./package-build-policy.mjs";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";
import { createWorkspaceScriptInvocations, executeInvocations, validateWorkspaceScriptContracts } from "./workspace-commands.mjs";
import { buildLinuxPhysicalHelper } from "./build-linux-physical-helper.mjs";
import { buildLinuxFileLock } from "./linux-file-lock-build.mjs";

export function runCleanWorkspaceBuild(repositoryRoot = process.cwd(), options = {}) {
    const graph = resolveWorkspaceGraph(repositoryRoot);
    validateWorkspaceScriptContracts(graph);
    const policies = validatePackageDeliveryPolicies(graph);
    cleanWorkspaceBuildOutputs(graph, policies);
    executeInvocations(createWorkspaceScriptInvocations(graph, "build"), options);
    if (process.platform === "linux" && graph.packages.some((entry) => entry.name === "@oaam/shared")) {
        (options.buildLinuxPhysicalHelper ?? buildLinuxPhysicalHelper)(repositoryRoot);
        (options.buildLinuxFileLock ?? buildLinuxFileLock)(repositoryRoot);
    }
    validateBuiltPackageEntries(graph, policies);
    return Object.freeze({ graph, policies });
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
    try {
        runCleanWorkspaceBuild(process.argv[2] ?? process.cwd());
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
