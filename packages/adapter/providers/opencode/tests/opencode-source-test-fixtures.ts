import type { AdapterAssetSourceCapability, AdapterProviderReadInput, AssetKind, Sha256Digest, SourceRoot } from "@oaam/core";
import {
    bindFixtureProbeObservation,
    bindFixtureProviderReadInput,
    bindRequiredAdapterCapability,
    bindUserSelectedReadInput,
    fixtureSourceRoot,
    type AdapterFixtureValue,
} from "../../../test-support";
import { opencodeProvider } from "../src/opencode-provider";

export {
    readAccessFailed as failed,
    failingReadAccess,
    fixtureFrontmatter as fm,
    fixturePlatformContext as platformContext,
    readAccessSucceeded as succeeded,
} from "../../../test-support";

export const DIGEST = `sha256:${"1".repeat(64)}` as Sha256Digest;

export type FixtureValue = AdapterFixtureValue;

const observation = bindFixtureProbeObservation({
    adapterId: "OPENCODE",
    agentRuntimeId: "OPENCODE_CLI",
    versionText: "fixture",
    installationEvidence: [],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});
const appObservation = bindFixtureProbeObservation({
    adapterId: "OPENCODE",
    agentRuntimeId: "OPENCODE_APP",
    versionText: "1.18.15",
    installationEvidence: [],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});

export function permissionRule(selector: string, action: "preapproved" | "ask" | "deny") {
    return {
        selector: {
            mode: "agent_runtime_tool",
            selector: { dialectId: "opencode-permission-selector-v1", selector },
        },
        action,
    };
}

export async function readProject(kinds: AssetKind[], files: Record<string, FixtureValue>) {
    return opencodeProvider.read(readInput(projectRoot(), kinds, files));
}

export function readInput(root: SourceRoot, kinds: AssetKind[], files: Record<string, FixtureValue>): AdapterProviderReadInput {
    const capabilities =
        root.rootRole === "config"
            ? configCapabilities(kinds)
            : root.rootRole === "source" && root.sourceDomain === "family_shared"
              ? sharedCapabilities(kinds)
              : projectCapabilities(kinds);
    return rawReadInput(root, capabilities, files);
}

export const rawReadInput = bindFixtureProviderReadInput({
    digest: DIGEST,
    observation,
    resolveEntries: true,
    obligationId: (capability, index) => `obligation-${capability.assetKind}-${index}`,
});
export const appRawReadInput = bindFixtureProviderReadInput({
    digest: DIGEST,
    observation: appObservation,
    resolveEntries: true,
    obligationId: (capability, index) => `app-obligation-${capability.assetKind}-${index}`,
});

export const userSelectedReadInput = bindUserSelectedReadInput(rawReadInput);

export function projectCapabilities(
    kinds: AssetKind[],
    agentRuntimeId: "OPENCODE_CLI" | "OPENCODE_APP" = "OPENCODE_CLI",
): AdapterAssetSourceCapability[] {
    return kinds.map((kind) =>
        requiredCapability(
            (row) =>
                row.agentRuntimeId === agentRuntimeId &&
                row.assetKind === kind &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "project_actual" &&
                row.sourceDomain === "project_root" &&
                row.rootLocatorKind === "user_provided_path" &&
                row.readPolicy === "auto_read",
        ),
    );
}

export function configCapabilities(kinds: AssetKind[]): AdapterAssetSourceCapability[] {
    return kinds.map((kind) =>
        requiredCapability(
            (row) =>
                row.agentRuntimeId === "OPENCODE_CLI" &&
                row.assetKind === kind &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "config" &&
                row.sourceDomain === "agent_runtime_private" &&
                row.rootLocatorKind === "runtime_known_rule" &&
                row.readPolicy === "auto_read",
        ),
    );
}

export function sharedCapabilities(kinds: AssetKind[]): AdapterAssetSourceCapability[] {
    return kinds.map((kind) =>
        requiredCapability(
            (row) =>
                row.agentRuntimeId === "OPENCODE_CLI" &&
                row.assetKind === kind &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "source" &&
                row.sourceDomain === "family_shared" &&
                row.readPolicy === "auto_read",
        ),
    );
}

export function externalCapability(kind: Exclude<AssetKind, "Rule" | "Memory">): AdapterAssetSourceCapability {
    return requiredCapability(
        (row) =>
            row.agentRuntimeId === "OPENCODE_CLI" &&
            row.assetKind === kind &&
            row.entrySupportStatus === "supported" &&
            row.rootLocatorKind === "user_provided_path" &&
            row.sourceDomain === "external_managed" &&
            row.readPolicy === "user_selected_root_only",
    );
}

export const requiredCapability = bindRequiredAdapterCapability(opencodeProvider, "missing OpenCode fixture capability");
export function projectRoot(): SourceRoot {
    return sourceRoot(
        "root-project",
        "/fixture/project",
        "project_actual",
        "project_root",
        "user_provided_path",
        "probe_project_root:project_config_on:external_skills_on:claude_prompt_on:claude_skills_on",
    );
}

export function configRoot(): SourceRoot {
    return sourceRoot(
        "root-config",
        "/fixture/config",
        "config",
        "agent_runtime_private",
        "runtime_known_rule",
        "opencode_global_config:opencode_config_default",
    );
}

export function externalRoot(): SourceRoot {
    return sourceRoot(
        "root-external",
        "/fixture/external",
        "source",
        "external_managed",
        "user_provided_path",
        "user_selected_root",
    );
}

export function sourceRoot(
    sourceRootId: string,
    rootPath: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKind: SourceRoot["locatorEvidence"][number]["locatorKind"],
    locatorKey: string,
): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId,
        path: rootPath,
        rootRole,
        sourceDomain,
        locatorKind,
        locatorKey,
        evidenceLevel: "source_code",
    });
}
