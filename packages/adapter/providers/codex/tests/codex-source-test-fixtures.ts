import type { AdapterAssetSourceCapability, AssetKind, Sha256Digest, SourceRoot } from "@oaam/core";
import {
    bindFixtureProbeObservation,
    bindFixtureProviderReadInput,
    bindRequiredAdapterCapability,
    bindUserSelectedReadInput,
    fixtureSourceRoot,
    readAccessFailed,
    type AdapterFixtureValue,
} from "../../../test-support";
import { codexProvider } from "../src/codex-provider";

export const DIGEST = `sha256:${"7".repeat(64)}` as Sha256Digest;
export type FixtureValue = AdapterFixtureValue;

const observation = bindFixtureProbeObservation({
    adapterId: "CODEX",
    agentRuntimeId: "CODEX_CLI",
    versionText: "fixture",
    installationEvidence: [],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});

export const rawReadInput = bindFixtureProviderReadInput({
    digest: DIGEST,
    observation,
    resolveEntries: true,
    obligationId: (capability, index) => `obligation-${capability.assetKind}-${index}`,
});

export const userSelectedReadInput = bindUserSelectedReadInput(rawReadInput);
export const requiredCapability = bindRequiredAdapterCapability(codexProvider, "missing Codex fixture capability");

export function guidanceCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return guidanceCapabilityForRuntime(root, "CODEX_CLI");
}

export function guidanceCapabilityForRuntime(
    root: SourceRoot,
    agentRuntimeId: "CODEX_CLI" | "CODEX_APP",
): AdapterAssetSourceCapability {
    return requiredCapability(
        (row) =>
            row.agentRuntimeId === agentRuntimeId &&
            row.assetKind === "Guidance" &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === root.rootRole &&
            row.sourceDomain === root.sourceDomain &&
            row.rootLocatorKind === root.locatorEvidence[0]?.locatorKind &&
            row.readPolicy === (root.sourceDomain === "external_managed" ? "user_selected_root_only" : "auto_read"),
    );
}

export function skillCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return skillCapabilityForRuntime(root, "CODEX_CLI");
}

export function skillCapabilityForRuntime(
    root: SourceRoot,
    agentRuntimeId: "CODEX_CLI" | "CODEX_APP",
): AdapterAssetSourceCapability {
    return requiredCapability(
        (row) =>
            row.agentRuntimeId === agentRuntimeId &&
            row.assetKind === "Skill" &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === root.rootRole &&
            row.sourceDomain === root.sourceDomain &&
            row.rootLocatorKind === root.locatorEvidence[0]?.locatorKind &&
            row.readPolicy === (root.sourceDomain === "external_managed" ? "user_selected_root_only" : "auto_read"),
    );
}

export function subagentCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return sourceCapability(root, "Subagent");
}

export function workflowCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return sourceCapability(root, "Workflow");
}

export function memoryCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return sourceCapability(root, "Memory");
}

export async function readGuidance(root: SourceRoot, files: Record<string, FixtureValue>) {
    return codexProvider.read(rawReadInput(root, [guidanceCapability(root)], files));
}

export async function readSkill(root: SourceRoot, files: Record<string, FixtureValue>) {
    return codexProvider.read(rawReadInput(root, [skillCapability(root)], files));
}

export async function readSubagent(root: SourceRoot, files: Record<string, FixtureValue>) {
    return codexProvider.read(rawReadInput(root, [subagentCapability(root)], files));
}

export async function readWorkflow(root: SourceRoot, files: Record<string, FixtureValue>) {
    return codexProvider.read(rawReadInput(root, [workflowCapability(root)], files));
}

export async function readMemory(root: SourceRoot, files: Record<string, FixtureValue>) {
    return codexProvider.read(rawReadInput(root, [memoryCapability(root)], files));
}

export async function readWithFailure(
    root: SourceRoot,
    capability: AdapterAssetSourceCapability,
    files: Record<string, FixtureValue>,
    failedPath: string,
) {
    const input = rawReadInput(root, [capability], files);
    const base = input.readAccess;
    const paths = new Map<string, string>();
    input.readAccess = {
        ...base,
        async resolveRootEntry(obligationId, sourceRootId) {
            const outcome = await base.resolveRootEntry(obligationId, sourceRootId);
            if (outcome.state === "succeeded") paths.set(outcome.value.readEntryHandleId, outcome.value.relativePath);
            return outcome;
        },
        async listDirectory(handleId) {
            const outcome = await base.listDirectory(handleId);
            if (outcome.state === "succeeded") {
                for (const child of outcome.value.children) paths.set(child.readEntryHandleId, child.relativePath);
            }
            return outcome;
        },
        async readFile(handleId) {
            return paths.get(handleId) === failedPath
                ? readAccessFailed("fixture-unreadable", "permission_denied")
                : base.readFile(handleId);
        },
    };
    return codexProvider.read(input);
}

export function configRoot(): SourceRoot {
    return sourceRoot("codex-config", "/fixture/.codex", "config", "family_shared", "runtime_known_rule", "codex_home_default");
}

export function projectRoot(): SourceRoot {
    return sourceRoot(
        "codex-project",
        "/fixture/project",
        "project_actual",
        "project_root",
        "user_provided_path",
        "probe_project_root",
    );
}

export function skillRoot(path = "/fixture/.agents/skills"): SourceRoot {
    return sourceRoot("codex-skills", path, "source", "family_shared", "runtime_known_rule", "codex_shared_agent_skills");
}

export function externalRoot(): SourceRoot {
    return sourceRoot(
        "codex-external",
        "/fixture/external",
        "source",
        "external_managed",
        "user_provided_path",
        "user_selected_root",
    );
}

function sourceRoot(
    sourceRootId: string,
    path: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKind: SourceRoot["locatorEvidence"][number]["locatorKind"],
    locatorKey: string,
): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId,
        path,
        rootRole,
        sourceDomain,
        locatorKind,
        locatorKey,
        evidenceLevel: "agent_runtime_verified",
    });
}

export function capabilityFor(kind: AssetKind): AdapterAssetSourceCapability | undefined {
    return codexProvider.assetSourceCapabilities.find(
        (row) => row.agentRuntimeId === "CODEX_CLI" && row.assetKind === kind && row.entrySupportStatus === "supported",
    );
}

function sourceCapability(root: SourceRoot, kind: "Subagent" | "Workflow" | "Memory"): AdapterAssetSourceCapability {
    return requiredCapability(
        (row) =>
            row.agentRuntimeId === "CODEX_CLI" &&
            row.assetKind === kind &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === root.rootRole &&
            row.sourceDomain === root.sourceDomain &&
            row.rootLocatorKind === root.locatorEvidence[0]?.locatorKind &&
            row.readPolicy === (root.sourceDomain === "external_managed" ? "user_selected_root_only" : "auto_read"),
    );
}
