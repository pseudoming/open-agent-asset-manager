/** Cursor source operations with current targets and retained Applied inspection. */
import { defineAdapterProvider } from "@oaam/adapter-framework";
import type { AdapterAssetSourceCapability, AssetKind } from "@oaam/core";
import { createAdapterAssetSourceCapability } from "@oaam/core/adapter-spi";
import { CURSOR_DIALECT_CONTRACTS } from "./cursor-dialects";
import { probeCursor } from "./cursor-probe";
import { CURSOR_SOURCE_READ } from "./cursor-source-read";
import { ASSET_KINDS, AGENT_RUNTIMES, capabilityDiagnostic } from "./cursor-capabilities";
import { createCursorTargetDefinition, createCursorHistoricalInspectionBinding } from "./cursor-target-definition";

export const cursorProvider = defineAdapterProvider({
    adapterId: "CURSOR",
    displayName: "Cursor",
    version: "0.2.0",
    ...createCursorTargetDefinition("0.2.0"),
    assetSourceCapabilities: makeSourceCapabilities(),
    retainedInspectionBindings: [createCursorHistoricalInspectionBinding()],
    dialectContracts: CURSOR_DIALECT_CONTRACTS,
    sourceRead: CURSOR_SOURCE_READ,
    probe: probeCursor,
});

function makeSourceCapabilities(): AdapterAssetSourceCapability[] {
    return AGENT_RUNTIMES.flatMap((runtime) =>
        ASSET_KINDS.flatMap((assetKind): AdapterAssetSourceCapability[] => {
            if (assetKind === "Guidance" || assetKind === "Rule") {
                return [
                    sourceCapability({
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "supported",
                        rootLocatorKind: "user_provided_path",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        assetKind,
                        sourcePathMechanism: "recursive_entry",
                        evidenceLevel: "agent_runtime_verified",
                        readPolicy: "auto_read",
                        diagnostics: [],
                    }),
                ];
            }
            if (assetKind === "Workflow") {
                return [
                    sourceCapability({
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "supported",
                        rootLocatorKind: "user_provided_path",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        assetKind,
                        sourcePathMechanism: "recursive_entry",
                        evidenceLevel: "agent_runtime_verified",
                        readPolicy: "auto_read",
                        diagnostics: [],
                    }),
                    sourceCapability({
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "supported",
                        rootLocatorKind: "runtime_known_rule",
                        rootRole: "config",
                        sourceDomain: "agent_runtime_private",
                        assetKind,
                        sourcePathMechanism: "recursive_entry",
                        evidenceLevel: "agent_runtime_verified",
                        readPolicy: "auto_read",
                        diagnostics: [],
                    }),
                ];
            }
            if (assetKind === "Skill") {
                const evidenceLevel = "agent_runtime_verified" as const;
                return [
                    sourceCapability({
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "supported",
                        rootLocatorKind: "user_provided_path",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        assetKind,
                        sourcePathMechanism: "recursive_entry",
                        evidenceLevel,
                        readPolicy: "auto_read",
                        diagnostics: [],
                    }),
                    sourceCapability({
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "supported",
                        rootLocatorKind: "runtime_known_rule",
                        rootRole: "config",
                        sourceDomain: "agent_runtime_private",
                        assetKind,
                        sourcePathMechanism: "recursive_entry",
                        evidenceLevel,
                        readPolicy: "auto_read",
                        diagnostics: [],
                    }),
                    sourceCapability({
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "supported",
                        rootLocatorKind: "runtime_known_rule",
                        rootRole: "source",
                        sourceDomain: "family_shared",
                        assetKind,
                        sourcePathMechanism: "recursive_entry",
                        evidenceLevel,
                        readPolicy: "auto_read",
                        diagnostics: [],
                    }),
                ];
            }
            if (assetKind === "Subagent") {
                return [
                    sourceCapability({
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "supported",
                        rootLocatorKind: "user_provided_path",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        assetKind,
                        sourcePathMechanism: "recursive_entry",
                        evidenceLevel: "agent_runtime_verified",
                        readPolicy: "auto_read",
                        diagnostics: [],
                    }),
                ];
            }
            if (assetKind === "Memory" && runtime.agentRuntimeId === "CURSOR_APP") {
                return [
                    sourceCapability({
                        agentRuntimeId: "CURSOR_APP",
                        entrySupportStatus: "supported",
                        rootLocatorKind: "user_provided_path",
                        rootRole: "source",
                        sourceDomain: "external_managed",
                        assetKind: "Memory",
                        sourcePathMechanism: "fixed_file",
                        evidenceLevel: "agent_runtime_verified",
                        readPolicy: "user_selected_root_only",
                        diagnostics: [],
                    }),
                ];
            }
            return [
                sourceCapability({
                    agentRuntimeId: runtime.agentRuntimeId,
                    entrySupportStatus: "deferred",
                    rootLocatorKind: "unknown",
                    rootRole: "unknown",
                    sourceDomain: "unknown",
                    assetKind,
                    sourcePathMechanism: "unknown",
                    evidenceLevel: "local_artifact",
                    readPolicy: "report_only",
                    diagnostics: [capabilityDiagnostic("read", runtime.displayName, assetKind)],
                }),
            ];
        }),
    );
}

function sourceCapability(
    input: Omit<AdapterAssetSourceCapability, "sourceCapabilityFingerprint">,
): AdapterAssetSourceCapability {
    return createAdapterAssetSourceCapability({ adapterId: "CURSOR", agentRuntimes: AGENT_RUNTIMES }, input);
}
