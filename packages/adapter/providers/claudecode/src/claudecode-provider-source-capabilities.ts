/** Claude source capability declarations stay independent of target renderer generations. */
import type { AdapterAssetSourceCapability, AgentRuntimeDescriptor, AssetKind, RootLocatorKind, SourceDomain } from "@oaam/core";
import { createAdapterAssetSourceCapability } from "@oaam/core/adapter-spi";

export function makeClaudeCodeSourceCapabilities(
    AGENT_RUNTIMES: readonly AgentRuntimeDescriptor[],
): AdapterAssetSourceCapability[] {
    const NON_MEMORY_KINDS: Array<Exclude<AssetKind, "Memory">> = ["Guidance", "Rule", "Workflow", "Skill", "Subagent"];
    return makeSourceCapabilities();

    function makeSourceCapabilities(): AdapterAssetSourceCapability[] {
        const rows: AdapterAssetSourceCapability[] = [];
        for (const assetKind of NON_MEMORY_KINDS) {
            rows.push(
                supportedSource(assetKind, "runtime_known_rule", "config", "agent_runtime_private", "auto_read"),
                supportedSource(assetKind, "runtime_declared_path", "config", "agent_runtime_private", "auto_read"),
                supportedSource(assetKind, "user_provided_path", "project_actual", "project_root", "auto_read"),
                supportedSource(assetKind, "project_registry_entry", "project_actual", "project_root", "auto_read"),
                supportedSource(assetKind, "user_provided_path", "source", "external_managed", "user_selected_root_only"),
                supportedAppConfigSource(assetKind, "runtime_known_rule"),
                supportedAppConfigSource(assetKind, "runtime_declared_path"),
                supportedAppProjectSource(assetKind, "user_provided_path"),
                supportedAppProjectSource(assetKind, "project_registry_entry"),
            );
        }
        rows.push(
            supportedSource("Memory", "runtime_known_rule", "source", "project_keyed", "auto_read"),
            supportedSource("Memory", "runtime_declared_path", "source", "project_keyed", "auto_read"),
            supportedSource("Memory", "user_provided_path", "source", "external_managed", "user_selected_root_only"),
            supportedAppMemorySource("runtime_known_rule"),
            supportedAppMemorySource("runtime_declared_path"),
        );
        return rows;
    }

    function supportedAppConfigSource(
        assetKind: "Guidance" | "Rule" | "Workflow" | "Skill" | "Subagent",
        rootLocatorKind: "runtime_known_rule" | "runtime_declared_path",
    ): AdapterAssetSourceCapability {
        return sourceCapability({
            agentRuntimeId: "CLAUDE_CODE_APP",
            entrySupportStatus: "supported",
            rootLocatorKind,
            rootRole: "config",
            sourceDomain: "agent_runtime_private",
            assetKind,
            sourcePathMechanism: "recursive_entry",
            evidenceLevel: "agent_runtime_verified",
            readPolicy: "auto_read",
            diagnostics: [],
        });
    }

    function supportedAppProjectSource(
        assetKind: "Guidance" | "Rule" | "Workflow" | "Skill" | "Subagent",
        rootLocatorKind: "user_provided_path" | "project_registry_entry",
    ): AdapterAssetSourceCapability {
        return sourceCapability({
            agentRuntimeId: "CLAUDE_CODE_APP",
            entrySupportStatus: "supported",
            rootLocatorKind,
            rootRole: "project_actual",
            sourceDomain: "project_root",
            assetKind,
            sourcePathMechanism: "recursive_entry",
            evidenceLevel: rootLocatorKind === "project_registry_entry" ? "local_artifact" : "agent_runtime_verified",
            readPolicy: "auto_read",
            diagnostics: [],
        });
    }

    function supportedAppMemorySource(
        rootLocatorKind: "runtime_known_rule" | "runtime_declared_path",
    ): AdapterAssetSourceCapability {
        return sourceCapability({
            agentRuntimeId: "CLAUDE_CODE_APP",
            entrySupportStatus: "supported",
            rootLocatorKind,
            rootRole: "source",
            sourceDomain: "project_keyed",
            assetKind: "Memory",
            sourcePathMechanism: "recursive_entry",
            evidenceLevel: "agent_runtime_verified",
            readPolicy: "auto_read",
            diagnostics: [],
        });
    }

    function supportedSource(
        assetKind: AssetKind,
        rootLocatorKind: RootLocatorKind,
        rootRole: AdapterAssetSourceCapability["rootRole"],
        sourceDomain: SourceDomain,
        readPolicy: AdapterAssetSourceCapability["readPolicy"],
    ): AdapterAssetSourceCapability {
        return sourceCapability({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            entrySupportStatus: "supported",
            rootLocatorKind,
            rootRole,
            sourceDomain,
            assetKind,
            sourcePathMechanism: "recursive_entry",
            evidenceLevel: "source_code",
            readPolicy,
            diagnostics: [],
        });
    }

    function sourceCapability(
        input: Omit<AdapterAssetSourceCapability, "sourceCapabilityFingerprint">,
    ): AdapterAssetSourceCapability {
        return createAdapterAssetSourceCapability({ adapterId: "CLAUDECODE", agentRuntimes: [...AGENT_RUNTIMES] }, input);
    }
}
