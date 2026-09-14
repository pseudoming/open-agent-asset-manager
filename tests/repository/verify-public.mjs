import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    createRootScriptInvocation,
    createWorkspaceScriptInvocations,
    executeInvocations,
    REQUIRED_WORKSPACE_SCRIPTS,
    validateWorkspaceScriptContracts,
} from "./workspace-commands.mjs";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";

/** Public source checks preserve product coverage without requiring private acceptance ledgers. */
export function createPublicVerificationPlan(graph) {
    validateWorkspaceScriptContracts(graph, REQUIRED_WORKSPACE_SCRIPTS);
    return Object.freeze([
        createRootScriptInvocation(graph, "build"),
        createRootScriptInvocation(graph, "check:format"),
        createRootScriptInvocation(graph, "lint"),
        createRootScriptInvocation(graph, "typecheck:conformance"),
        // The successful clean build already runs strict tsc for these exact workspace programs.
        createRootScriptInvocation(graph, "check:ignore"),
        createRootScriptInvocation(graph, "check:desktop-delivery"),
        createRootScriptInvocation(graph, "check:desktop-actual-render"),
        createRootScriptInvocation(graph, "test:arch"),
        ...createWorkspaceScriptInvocations(graph, "test:coverage"),
    ]);
}

export function runPublicVerification(repositoryRoot = process.cwd(), options = {}) {
    const plan = createPublicVerificationPlan(resolveWorkspaceGraph(repositoryRoot));
    executeInvocations(plan, { ...options, reportProgress: true });
    return plan;
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
    try {
        runPublicVerification(process.argv[2] ?? process.cwd());
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
