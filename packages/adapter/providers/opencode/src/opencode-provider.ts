/** OpenCode source entry points with current target and retained inspection composition. */
import { defineAdapterProvider, adapterOperationDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type {
    AdapterAssetSourceCapability,
    AssetKind,
    RootLocatorKind,
    RootRole,
    SourceDomain,
    SourcePathMechanism,
} from "@oaam/core";
import { createAdapterAssetSourceCapability } from "@oaam/core/adapter-spi";
import { OPENCODE_DIALECT_CONTRACTS } from "./opencode-dialects";
import { probeOpencode } from "./opencode-probe";
import { OPENCODE_SOURCE_READ } from "./opencode-source-read";
import {
    createOpencodeTargetDefinition,
    createOpencodeHistoricalInspectionBinding,
    OPENCODE_AGENT_RUNTIMES as AGENT_RUNTIMES,
    OPENCODE_ASSET_KINDS as ASSET_KINDS,
} from "./opencode-target-definition";

type OpenCodeAgentRuntimeId = "OPENCODE_CLI" | "OPENCODE_APP";
const PROVIDER_VERSION = "0.11.0";
const SOURCE_CAPABILITIES = makeSourceCapabilities();

export const opencodeProvider = defineAdapterProvider({
    adapterId: "OPENCODE",
    displayName: "OpenCode",
    version: PROVIDER_VERSION,
    ...createOpencodeTargetDefinition(PROVIDER_VERSION, 2),
    assetSourceCapabilities: SOURCE_CAPABILITIES,
    retainedInspectionBindings: [
        createOpencodeHistoricalInspectionBinding(),
        createOpencodeHistoricalInspectionBinding("0.10.0"),
    ],
    dialectContracts: OPENCODE_DIALECT_CONTRACTS,
    sourceRead: OPENCODE_SOURCE_READ,
    probe: probeOpencode,
});

function makeSourceCapabilities(): AdapterAssetSourceCapability[] {
    const rows: AdapterAssetSourceCapability[] = [];
    for (const runtime of AGENT_RUNTIMES) rows.push(...sourceCapabilitiesFor(runtime.agentRuntimeId));
    return rows;
}

function sourceCapabilitiesFor(agentRuntimeId: OpenCodeAgentRuntimeId): AdapterAssetSourceCapability[] {
    const rows: AdapterAssetSourceCapability[] = [];
    const standaloneConfigKinds = ["Guidance", "Workflow", "Skill", "Subagent"] as const;
    for (const assetKind of standaloneConfigKinds) {
        rows.push(
            supported(
                agentRuntimeId,
                assetKind,
                "runtime_known_rule",
                "config",
                "agent_runtime_private",
                "recursive_entry",
                "source_code",
                "auto_read",
            ),
            supported(
                agentRuntimeId,
                assetKind,
                "runtime_declared_path",
                "config",
                "agent_runtime_private",
                "recursive_entry",
                "source_code",
                "auto_read",
            ),
            supported(
                agentRuntimeId,
                assetKind,
                "user_provided_path",
                "project_actual",
                "project_root",
                "recursive_entry",
                "source_code",
                "auto_read",
            ),
            supported(
                agentRuntimeId,
                assetKind,
                "project_registry_entry",
                "project_actual",
                "project_root",
                "recursive_entry",
                "agent_runtime_verified",
                "auto_read",
            ),
            external(agentRuntimeId, assetKind),
        );
    }
    rows.push(
        supported(
            agentRuntimeId,
            "Skill",
            "runtime_known_rule",
            "source",
            "family_shared",
            "recursive_entry",
            "source_code",
            "auto_read",
        ),
    );
    rows.push(
        supported(
            agentRuntimeId,
            "Guidance",
            "runtime_known_rule",
            "config",
            "family_shared",
            "recursive_entry",
            "source_code",
            "auto_read",
        ),
    );
    rows.push(
        sourceCapability({
            agentRuntimeId,
            entrySupportStatus: "unsupported",
            rootLocatorKind: "unknown",
            rootRole: "unknown",
            sourceDomain: "unknown",
            assetKind: "Rule",
            sourcePathMechanism: "unknown",
            evidenceLevel: "source_code",
            readPolicy: "report_only",
            diagnostics: [
                diagnostic(
                    "read",
                    "opencode_rule_unsupported",
                    "OpenCode instructions are Guidance references and permissions are execution policy; neither is a native Rule asset",
                    "unsupported",
                    "warning",
                ),
            ],
        }),
    );
    rows.push(
        sourceCapability({
            agentRuntimeId,
            entrySupportStatus: "unsupported",
            rootLocatorKind: "unknown",
            rootRole: "unknown",
            sourceDomain: "unknown",
            assetKind: "Memory",
            sourcePathMechanism: "unknown",
            evidenceLevel: "source_code",
            readPolicy: "report_only",
            diagnostics: [
                diagnostic(
                    "read",
                    "opencode_memory_unsupported",
                    "OpenCode does not expose an independent native Memory asset mechanism",
                    "unsupported",
                    "warning",
                ),
            ],
        }),
    );
    return rows;
}

function supported(
    agentRuntimeId: OpenCodeAgentRuntimeId,
    assetKind: Exclude<AssetKind, "Rule" | "Memory">,
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

function external(
    agentRuntimeId: OpenCodeAgentRuntimeId,
    assetKind: Exclude<AssetKind, "Rule" | "Memory">,
): AdapterAssetSourceCapability {
    return supported(
        agentRuntimeId,
        assetKind,
        "user_provided_path",
        "source",
        "external_managed",
        "recursive_entry",
        "user_provided",
        "user_selected_root_only",
    );
}

function sourceCapability(
    input: Omit<AdapterAssetSourceCapability, "sourceCapabilityFingerprint">,
): AdapterAssetSourceCapability {
    return createAdapterAssetSourceCapability({ adapterId: "OPENCODE", agentRuntimes: AGENT_RUNTIMES }, input);
}
