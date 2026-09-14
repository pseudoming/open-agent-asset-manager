import type { AdapterAssetSourceCapability, Sha256Digest, SourceRoot } from "@oaam/core";
import {
    bindFixtureProbeObservation,
    bindFixtureProviderReadInput,
    bindRequiredAdapterCapability,
    bindUserSelectedReadInput,
    fixtureSourceRoot,
    type AdapterFixtureValue,
} from "../../../test-support";
import { zcodeProvider } from "../src/zcode-provider";

export const DIGEST = `sha256:${"8".repeat(64)}` as Sha256Digest;
export type FixtureValue = AdapterFixtureValue;

const observation = bindFixtureProbeObservation({
    adapterId: "ZCODE",
    agentRuntimeId: "ZCODE_APP",
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
const requiredCapability = bindRequiredAdapterCapability(zcodeProvider, "missing ZCode fixture capability");

export function guidanceCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return requiredCapability(
        (row) =>
            row.agentRuntimeId === "ZCODE_APP" &&
            row.assetKind === "Guidance" &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === root.rootRole &&
            row.sourceDomain === root.sourceDomain &&
            row.rootLocatorKind === root.locatorEvidence[0]?.locatorKind &&
            row.readPolicy === (root.sourceDomain === "external_managed" ? "user_selected_root_only" : "auto_read"),
    );
}

export function skillCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return requiredCapability(
        (row) =>
            row.agentRuntimeId === "ZCODE_APP" &&
            row.assetKind === "Skill" &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === root.rootRole &&
            row.sourceDomain === root.sourceDomain &&
            row.rootLocatorKind === root.locatorEvidence[0]?.locatorKind &&
            row.readPolicy === (root.sourceDomain === "external_managed" ? "user_selected_root_only" : "auto_read"),
    );
}

export function workflowCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return sourceCapability(root, "Workflow");
}

export function subagentCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return sourceCapability(root, "Subagent");
}

export function memoryCapability(root: SourceRoot): AdapterAssetSourceCapability {
    return sourceCapability(root, "Memory");
}

export function readGuidance(root: SourceRoot, files: Record<string, FixtureValue>) {
    return zcodeProvider.read(rawReadInput(root, [guidanceCapability(root)], files));
}

export function readSkill(root: SourceRoot, files: Record<string, FixtureValue>) {
    return zcodeProvider.read(withProjectAssociation(rawReadInput(root, [skillCapability(root)], files), root));
}

export function readWorkflow(root: SourceRoot, files: Record<string, FixtureValue>) {
    return zcodeProvider.read(rawReadInput(root, [workflowCapability(root)], files));
}

export function readSubagent(root: SourceRoot, files: Record<string, FixtureValue>) {
    return zcodeProvider.read(withProjectAssociation(rawReadInput(root, [subagentCapability(root)], files), root));
}

export function readMemory(root: SourceRoot, files: Record<string, FixtureValue>) {
    const input = rawReadInput(root, [memoryCapability(root)], files);
    const selector = input.target.sourceSelector;
    if (selector.selectorKind !== "probe_roots") throw new Error("Memory fixture requires probe roots");
    const workspace = projectRoot();
    selector.observation.sourceRoots.push(workspace);
    const runtime = selector.observation.observedAgentRuntimes[0];
    runtime?.sourceRootIds.push(workspace.sourceRootId);
    runtime?.observedProjectIds.push("zcode-project");
    selector.observation.observedProjects.push({
        observedProjectId: "zcode-project",
        runtimeProjectKey: "/fixture/project",
        displayName: "project",
        workspaces: [{ sourceRootId: workspace.sourceRootId, role: "primary" }],
        evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
        diagnostics: [],
    });
    return zcodeProvider.read(input);
}

export function configRoot(): SourceRoot {
    return sourceRoot(
        "zcode-config",
        "/fixture/.zcode",
        "config",
        "agent_runtime_private",
        "runtime_known_rule",
        "zcode_user_data_root",
    );
}

export function projectRoot(): SourceRoot {
    return sourceRoot(
        "zcode-project",
        "/fixture/project",
        "project_actual",
        "project_root",
        "project_registry_entry",
        "registry-entry",
    );
}

export function externalRoot(): SourceRoot {
    return sourceRoot(
        "zcode-external",
        "/fixture/external",
        "source",
        "external_managed",
        "user_provided_path",
        "user_selected_root",
    );
}

export function skillRoot(): SourceRoot {
    return sourceRoot(
        "zcode-shared-skills",
        "/fixture/.agents/skills",
        "source",
        "family_shared",
        "runtime_known_rule",
        "zcode_shared_skill_root",
    );
}

export function privateSkillRoot(): SourceRoot {
    return sourceRoot(
        "zcode-private-skills",
        "/fixture/.zcode/skills",
        "source",
        "agent_runtime_private",
        "runtime_known_rule",
        "zcode_user_skill_root",
    );
}

export function projectSkillRoot(path = "/fixture/project/.zcode/skills"): SourceRoot {
    const root = sourceRoot(
        `zcode-project-skills:${path}`,
        path,
        "source",
        "project_root",
        "runtime_known_rule",
        "zcode_project_skill_root",
    );
    root.locatorEvidence.push({
        locatorKind: "user_provided_path",
        locatorKey: "user_selection",
        evidenceLevel: "user_provided",
    });
    return root;
}

export function agentRoot(): SourceRoot {
    return sourceRoot(
        "zcode-global-agents",
        "/fixture/.zcode/agents",
        "source",
        "agent_runtime_private",
        "runtime_known_rule",
        "zcode_default_storage_root",
    );
}

export function projectAgentRoot(): SourceRoot {
    const root = sourceRoot(
        "zcode-project-agent-root",
        "/fixture/project/storage/agents",
        "source",
        "agent_runtime_private",
        "runtime_declared_path",
        "storage.dir",
    );
    root.locatorEvidence.push({
        locatorKind: "user_provided_path",
        locatorKey: "user_selection",
        evidenceLevel: "user_provided",
    });
    return root;
}

export function commandRoot(): SourceRoot {
    return sourceRoot(
        "zcode-shared-commands",
        "/fixture/.agents/commands",
        "source",
        "family_shared",
        "runtime_known_rule",
        "zcode_shared_command_root",
    );
}

export function memoryRoot(): SourceRoot {
    const root = sourceRoot(
        "zcode-project-memory",
        "/fixture/.zcode/cli/memories/projects/project-1234",
        "source",
        "project_keyed",
        "runtime_known_rule",
        "zcode_default_storage_root",
    );
    root.locatorEvidence.push({
        locatorKind: "user_provided_path",
        locatorKey: "user_selection",
        evidenceLevel: "user_provided",
    });
    return root;
}

function sourceCapability(root: SourceRoot, assetKind: "Workflow" | "Subagent" | "Memory"): AdapterAssetSourceCapability {
    return requiredCapability(
        (row) =>
            row.agentRuntimeId === "ZCODE_APP" &&
            row.assetKind === assetKind &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === root.rootRole &&
            row.sourceDomain === root.sourceDomain &&
            row.rootLocatorKind === root.locatorEvidence[0]?.locatorKind &&
            row.readPolicy === (root.sourceDomain === "external_managed" ? "user_selected_root_only" : "auto_read"),
    );
}

function withProjectAssociation(input: ReturnType<typeof rawReadInput>, root: SourceRoot): ReturnType<typeof rawReadInput> {
    const selector = input.target.sourceSelector;
    if (
        selector.selectorKind !== "probe_roots" ||
        !root.locatorEvidence.some(
            (evidence) => evidence.locatorKind === "project_registry_entry" || evidence.locatorKind === "user_provided_path",
        )
    ) {
        return input;
    }
    const workspace = projectRoot();
    selector.observation.sourceRoots.push(workspace);
    const runtime = selector.observation.observedAgentRuntimes[0];
    runtime?.sourceRootIds.push(workspace.sourceRootId);
    runtime?.observedProjectIds.push("zcode-project");
    selector.observation.observedProjects.push({
        observedProjectId: "zcode-project",
        runtimeProjectKey: "/fixture/project",
        displayName: "project",
        workspaces: [{ sourceRootId: workspace.sourceRootId, role: "primary" }],
        evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
        diagnostics: [],
    });
    return input;
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
        evidenceLevel: locatorKind === "user_provided_path" ? "user_provided" : "local_artifact",
    });
}
