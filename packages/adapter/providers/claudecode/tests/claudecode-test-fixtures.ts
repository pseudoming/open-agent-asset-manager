import * as fs from "node:fs";
import * as path from "node:path";
import type { AdapterAssetSourceCapability, AdapterProviderReadInput, AssetKind, Sha256Digest, SourceRoot } from "@oaam/core";
import {
    bindFixtureProbeObservation,
    bindFixtureProviderReadInput,
    bindUserSelectedReadInput,
    type AdapterFixtureValue,
} from "../../../test-support";
import { claudecodeProvider } from "../src/claudecode-provider";

export {
    readAccessFailed as failed,
    failingReadAccess as failingRootReadAccess,
    fixtureGlobalProbeContext as globalContext,
    nonDirectoryRootReadAccess,
    fixturePlatformContext as platformContext,
    fixtureProjectProbeContext as projectContext,
    unexpectedReadAccess,
} from "../../../test-support";

export const DIGEST = `sha256:${"a".repeat(64)}` as Sha256Digest;

type FixtureValue = AdapterFixtureValue;

const observation = bindFixtureProbeObservation({
    adapterId: "CLAUDECODE",
    agentRuntimeId: "CLAUDE_CODE_CLI",
    versionText: "fixture",
    installationEvidence: [
        {
            kind: "executable",
            path: "/fixture/bin/claude",
            evidenceLevel: "local_artifact",
            diagnostics: [],
        },
    ],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});

export function readInput(root: SourceRoot, kinds: AssetKind[], files: Record<string, FixtureValue>): AdapterProviderReadInput {
    const capabilities =
        root.sourceDomain === "project_keyed"
            ? memoryCapabilities()
            : root.rootRole === "config"
              ? configCapabilities(kinds)
              : projectCapabilities(
                    kinds,
                    root.locatorEvidence[0]?.locatorKind === "project_registry_entry"
                        ? "project_registry_entry"
                        : "user_provided_path",
                );
    const input = rawReadInput(root, capabilities, files);
    return root.sourceDomain === "project_keyed" ? withProjectAssociation(input) : input;
}

export const rawReadInput = bindFixtureProviderReadInput({
    digest: DIGEST,
    observation,
    resolveEntries: false,
    obligationId: (capability) => `obligation-${capability.assetKind}`,
});

export const userSelectedReadInput = bindUserSelectedReadInput(rawReadInput);

export function projectCapabilities(
    kinds: AssetKind[],
    locatorKind: "user_provided_path" | "project_registry_entry" = "user_provided_path",
): AdapterAssetSourceCapability[] {
    return kinds.map((kind) => {
        const capability = claudecodeProvider.assetSourceCapabilities.find(
            (row) =>
                row.agentRuntimeId === "CLAUDE_CODE_CLI" &&
                row.assetKind === kind &&
                row.entrySupportStatus === "supported" &&
                row.rootLocatorKind === locatorKind &&
                row.rootRole === "project_actual" &&
                row.sourceDomain === "project_root" &&
                row.readPolicy === "auto_read",
        );
        if (capability === undefined) throw new Error(`missing ${kind} project capability`);
        return capability;
    });
}

function memoryCapabilities(): AdapterAssetSourceCapability[] {
    const capability = claudecodeProvider.assetSourceCapabilities.find(
        (row) =>
            row.agentRuntimeId === "CLAUDE_CODE_CLI" &&
            row.assetKind === "Memory" &&
            row.entrySupportStatus === "supported" &&
            row.rootLocatorKind === "runtime_known_rule" &&
            row.sourceDomain === "project_keyed" &&
            row.readPolicy === "auto_read",
    );
    if (capability === undefined) throw new Error("missing Memory capability");
    return [capability];
}

function configCapabilities(kinds: AssetKind[]): AdapterAssetSourceCapability[] {
    return kinds.map((kind) => {
        const capability = claudecodeProvider.assetSourceCapabilities.find(
            (row) =>
                row.agentRuntimeId === "CLAUDE_CODE_CLI" &&
                row.assetKind === kind &&
                row.entrySupportStatus === "supported" &&
                row.rootLocatorKind === "runtime_known_rule" &&
                row.rootRole === "config" &&
                row.sourceDomain === "agent_runtime_private" &&
                row.readPolicy === "auto_read",
        );
        if (capability === undefined) throw new Error(`missing ${kind} config capability`);
        return capability;
    });
}

export function projectRoot(): SourceRoot {
    return {
        sourceRootId: "root-project",
        rootRole: "project_actual",
        sourceDomain: "project_root",
        path: "/fixture/project",
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "user_provided_path",
                locatorKey: "probe_project_root",
                evidenceLevel: "user_provided",
            },
        ],
        diagnostics: [],
    };
}

export function memoryRoot(): SourceRoot {
    return {
        sourceRootId: "root-memory",
        rootRole: "source",
        sourceDomain: "project_keyed",
        path: "/fixture/memory",
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "claude_project_memory_default",
                evidenceLevel: "source_code",
            },
        ],
        diagnostics: [],
    };
}

function withProjectAssociation(input: AdapterProviderReadInput): AdapterProviderReadInput {
    const selector = input.target.sourceSelector;
    if (selector.selectorKind !== "probe_roots") return input;
    const workspace = projectRoot();
    selector.observation.sourceRoots.push(workspace);
    const runtime = selector.observation.observedAgentRuntimes[0];
    runtime?.sourceRootIds.push(workspace.sourceRootId);
    runtime?.observedProjectIds.push("claudecode-project");
    selector.observation.observedProjects.push({
        observedProjectId: "claudecode-project",
        runtimeProjectKey: "/fixture/project",
        displayName: "project",
        workspaces: [{ sourceRootId: workspace.sourceRootId, role: "primary" }],
        evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
        diagnostics: [],
    });
    return input;
}

export function configRoot(): SourceRoot {
    return {
        sourceRootId: "root-config",
        rootRole: "config",
        sourceDomain: "agent_runtime_private",
        path: "/fixture/config",
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "claude_config_default",
                evidenceLevel: "source_code",
            },
        ],
        diagnostics: [],
    };
}

export function createProjectRoot(projectPath: string): void {
    fs.mkdirSync(path.join(projectPath, ".git"), { recursive: true });
}

export function sanitizeForFixture(projectPath: string): string {
    return projectPath
        .split("")
        .map((character) => {
            const code = character.charCodeAt(0);
            return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ? character : "-";
        })
        .join("");
}
