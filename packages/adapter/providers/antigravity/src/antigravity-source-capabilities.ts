/** Antigravity source capability inventory; target declarations remain with the Provider. */

import { adapterOperationDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type {
    AdapterAssetSourceCapability,
    AgentRuntimeDescriptor,
    AssetKind,
    OperationDiagnostic,
    RootLocatorKind,
    RootRole,
    SourceDomain,
    SourcePathMechanism,
} from "@oaam/core";
import { createAdapterAssetSourceCapability } from "@oaam/core/adapter-spi";

export function makeAntigravitySourceCapabilities(
    agentRuntimes: readonly AgentRuntimeDescriptor[],
): AdapterAssetSourceCapability[] {
    return makeSourceCapabilities();

    function makeSourceCapabilities(): AdapterAssetSourceCapability[] {
        const rows: AdapterAssetSourceCapability[] = [
            supported(
                "Guidance",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supported(
                "Guidance",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            external("Guidance"),

            supported(
                "Rule",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            external("Rule"),

            supported(
                "Workflow",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "local_artifact",
                "auto_read",
            ),
            supported(
                "Workflow",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "local_artifact",
                "auto_read",
            ),
            external("Workflow"),

            supported(
                "Skill",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supported(
                "Skill",
                "runtime_known_rule",
                "source",
                "agent_runtime_private",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supported(
                "Skill",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            external("Skill"),

            supported(
                "Subagent",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "local_artifact",
                "auto_read",
            ),
            supported(
                "Subagent",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "docs_declared",
                "auto_read",
            ),
            external("Subagent"),
            unsupportedMemory("ANTIGRAVITY_CLI"),
        ];
        rows.push(
            supportedFor(
                "ANTIGRAVITY_APP",
                "Guidance",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_APP",
                "Guidance",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_APP",
                "Rule",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_APP",
                "Workflow",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_APP",
                "Workflow",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_APP",
                "Skill",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_APP",
                "Skill",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            reportOnly("ANTIGRAVITY_APP", "Skill", "source", "agent_runtime_private", "recursive_entry"),
            supportedFor(
                "ANTIGRAVITY_APP",
                "Subagent",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_APP",
                "Subagent",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            unsupportedMemory("ANTIGRAVITY_APP"),
            supportedFor(
                "ANTIGRAVITY_IDE",
                "Guidance",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_IDE",
                "Guidance",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_IDE",
                "Rule",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_IDE",
                "Workflow",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_IDE",
                "Workflow",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_IDE",
                "Skill",
                "runtime_known_rule",
                "config",
                "family_shared",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            supportedFor(
                "ANTIGRAVITY_IDE",
                "Skill",
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            reportOnly("ANTIGRAVITY_IDE", "Skill", "source", "agent_runtime_private", "recursive_entry"),
            unsupportedDeclarationSource("ANTIGRAVITY_IDE", "Subagent"),
            unsupportedMemory("ANTIGRAVITY_IDE"),
        );
        return rows.flatMap((row) => {
            if (
                row.entrySupportStatus !== "supported" ||
                row.rootLocatorKind !== "project_registry_entry" ||
                row.rootRole !== "project_actual" ||
                row.sourceDomain !== "project_root" ||
                row.readPolicy !== "auto_read" ||
                row.assetKind === "Memory"
            )
                return [row];
            return [
                row,
                supportedFor(
                    row.agentRuntimeId,
                    row.assetKind,
                    "user_provided_path",
                    row.rootRole,
                    row.sourceDomain,
                    row.sourcePathMechanism,
                    "user_provided",
                    row.readPolicy,
                ),
            ];
        });
    }

    function supported(
        assetKind: Exclude<AssetKind, "Memory">,
        rootLocatorKind: RootLocatorKind,
        rootRole: RootRole,
        sourceDomain: SourceDomain,
        sourcePathMechanism: SourcePathMechanism,
        evidenceLevel: AdapterAssetSourceCapability["evidenceLevel"],
        readPolicy: AdapterAssetSourceCapability["readPolicy"],
    ): AdapterAssetSourceCapability {
        return supportedFor(
            "ANTIGRAVITY_CLI",
            assetKind,
            rootLocatorKind,
            rootRole,
            sourceDomain,
            sourcePathMechanism,
            evidenceLevel,
            readPolicy,
        );
    }

    function supportedFor(
        agentRuntimeId: AgentRuntimeDescriptor["agentRuntimeId"],
        assetKind: Exclude<AssetKind, "Memory">,
        rootLocatorKind: RootLocatorKind,
        rootRole: RootRole,
        sourceDomain: SourceDomain,
        sourcePathMechanism: SourcePathMechanism,
        evidenceLevel: AdapterAssetSourceCapability["evidenceLevel"],
        readPolicy: AdapterAssetSourceCapability["readPolicy"],
    ): AdapterAssetSourceCapability {
        return sourceCapability({
            agentRuntimeId,
            entrySupportStatus: "supported",
            rootLocatorKind,
            rootRole,
            sourceDomain,
            assetKind,
            sourcePathMechanism,
            evidenceLevel,
            readPolicy,
            diagnostics: [],
        });
    }

    function external(assetKind: Exclude<AssetKind, "Memory">): AdapterAssetSourceCapability {
        return supported(
            assetKind,
            "user_provided_path",
            "source",
            "external_managed",
            "recursive_entry",
            "user_provided",
            "user_selected_root_only",
        );
    }

    function reportOnly(
        agentRuntimeId: AgentRuntimeDescriptor["agentRuntimeId"],
        assetKind: Exclude<AssetKind, "Memory">,
        rootRole: RootRole,
        sourceDomain: SourceDomain,
        sourcePathMechanism: SourcePathMechanism,
    ): AdapterAssetSourceCapability {
        return sourceCapability({
            agentRuntimeId,
            entrySupportStatus: "docs_declared_unverified",
            rootLocatorKind: rootRole === "project_actual" ? "project_registry_entry" : "runtime_known_rule",
            rootRole,
            sourceDomain,
            assetKind,
            sourcePathMechanism,
            evidenceLevel: "docs_declared",
            readPolicy: "report_only",
            diagnostics: [
                diagnostic(
                    "read",
                    "antigravity_entry_source_unverified",
                    "This App/IDE source claim is report-only until an entry-specific load fixture is verified",
                    "unsupported",
                    "warning",
                ),
            ],
        });
    }

    function unsupportedDeclarationSource(
        agentRuntimeId: AgentRuntimeDescriptor["agentRuntimeId"],
        assetKind: Exclude<AssetKind, "Memory">,
    ): AdapterAssetSourceCapability {
        return sourceCapability({
            agentRuntimeId,
            entrySupportStatus: "unsupported",
            rootLocatorKind: "unknown",
            rootRole: "unknown",
            sourceDomain: "unknown",
            assetKind,
            sourcePathMechanism: "unknown",
            evidenceLevel: "agent_runtime_verified",
            readPolicy: "report_only",
            diagnostics: [ideSubagentUnsupportedDiagnostic("read")],
        });
    }

    function unsupportedMemory(agentRuntimeId: AgentRuntimeDescriptor["agentRuntimeId"]): AdapterAssetSourceCapability {
        return sourceCapability({
            agentRuntimeId,
            entrySupportStatus: "unsupported",
            rootLocatorKind: "unknown",
            rootRole: "unknown",
            sourceDomain: "unknown",
            assetKind: "Memory",
            sourcePathMechanism: "unknown",
            evidenceLevel: "agent_runtime_verified",
            readPolicy: "report_only",
            diagnostics: [
                diagnostic(
                    "read",
                    "antigravity_memory_unsupported",
                    "Antigravity does not expose a native Memory asset mechanism",
                    "unsupported",
                    "warning",
                ),
            ],
        });
    }

    function sourceCapability(
        input: Omit<AdapterAssetSourceCapability, "sourceCapabilityFingerprint">,
    ): AdapterAssetSourceCapability {
        return createAdapterAssetSourceCapability({ adapterId: "ANTIGRAVITY", agentRuntimes: [...agentRuntimes] }, input);
    }
}

export function ideSubagentUnsupportedDiagnostic(operation: OperationDiagnostic["operation"]): OperationDiagnostic {
    return diagnostic(
        operation,
        "antigravity_ide_subagent_unsupported_current_loader_absent",
        "Antigravity IDE 2.1.1 does not expose Project or Global custom-agent declarations through its exact GetAgentScripts surface",
        "unsupported",
        operation === "read" ? "warning" : "error",
    );
}
