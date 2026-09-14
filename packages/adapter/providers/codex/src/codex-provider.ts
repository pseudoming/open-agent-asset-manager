/** Codex source entry points with current target and retained inspection composition. */
import { defineAdapterProvider, adapterOperationDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type {
    AdapterProvider,
    AdapterAssetSourceCapability,
    AssetKind,
    ReadPolicy,
    RootLocatorKind,
    RootRole,
    SourceDomain,
    SourceEvidenceLevel,
} from "@oaam/core";
import { createAdapterAssetSourceCapability } from "@oaam/core/adapter-spi";
import { CODEX_DIALECT_CONTRACTS } from "./codex-dialects";
import { probeCodex } from "./codex-probe";
import { CODEX_CURRENT_SOURCE_EVIDENCE_BUILDS } from "./codex-runtime-builds";
import { CODEX_SOURCE_READ } from "./codex-source-read";
import {
    createCodexTargetDefinition,
    createCodexHistoricalInspectionBinding,
    CODEX_AGENT_RUNTIMES as AGENT_RUNTIMES,
    CODEX_ASSET_KINDS as ASSET_KINDS,
    type CodexAgentRuntimeId,
} from "./codex-target-definition";

const PROVIDER_VERSION = "0.19.0";
/** Private constructor shared by ordinary and restricted Bootstrap instances. */
export function createCodexProvider(probe: AdapterProvider["probe"] = probeCodex): AdapterProvider {
    return defineAdapterProvider({
        adapterId: "CODEX",
        displayName: "Codex",
        version: PROVIDER_VERSION,
        ...createCodexTargetDefinition(PROVIDER_VERSION),
        assetSourceCapabilities: makeSourceCapabilities(),
        retainedInspectionBindings: [createCodexHistoricalInspectionBinding(), createCodexHistoricalInspectionBinding("0.18.0")],
        dialectContracts: CODEX_DIALECT_CONTRACTS,
        sourceRead: CODEX_SOURCE_READ,
        probe,
    });
}

export const codexProvider = createCodexProvider();

function makeSourceCapabilities(): AdapterAssetSourceCapability[] {
    return AGENT_RUNTIMES.flatMap((runtime) =>
        ASSET_KINDS.flatMap((assetKind) => {
            if (assetKind === "Guidance") {
                return guidanceSourceRows(runtime.agentRuntimeId);
            }
            if (assetKind === "Skill" && runtime.agentRuntimeId === "CODEX_CLI") {
                return skillSourceRows(runtime.agentRuntimeId);
            }
            if (assetKind === "Skill" && runtime.agentRuntimeId === "CODEX_APP") {
                return skillSourceRows(runtime.agentRuntimeId);
            }
            if (assetKind === "Subagent") {
                return subagentSourceRows(runtime.agentRuntimeId);
            }
            if (assetKind === "Workflow" && runtime.agentRuntimeId === "CODEX_CLI") {
                return workflowSourceRows();
            }
            if (assetKind === "Rule") {
                return [unavailableSource(runtime.agentRuntimeId, assetKind, "unsupported")];
            }
            if (assetKind === "Memory") {
                return memorySourceRows(runtime.agentRuntimeId);
            }
            return sourceRowsFor(runtime.agentRuntimeId);
        }),
    );
}

function memorySourceRows(agentRuntimeId: CodexAgentRuntimeId): AdapterAssetSourceCapability[] {
    return (["runtime_known_rule", "runtime_declared_path"] satisfies RootLocatorKind[]).map((rootLocatorKind) =>
        sourceCapability({
            agentRuntimeId,
            entrySupportStatus: "supported",
            rootLocatorKind,
            rootRole: "config",
            sourceDomain: "family_shared",
            assetKind: "Memory",
            sourcePathMechanism: "recursive_entry",
            evidenceLevel: "agent_runtime_verified",
            readPolicy: "auto_read",
            diagnostics: [],
        }),
    );
}

function workflowSourceRows(): AdapterAssetSourceCapability[] {
    return [
        supportedDeclaration(
            "CODEX_CLI",
            "Workflow",
            "runtime_known_rule",
            "config",
            "family_shared",
            "auto_read",
            "docs_declared",
        ),
        supportedDeclaration(
            "CODEX_CLI",
            "Workflow",
            "runtime_declared_path",
            "config",
            "family_shared",
            "auto_read",
            "docs_declared",
        ),
    ];
}

function subagentSourceRows(agentRuntimeId: CodexAgentRuntimeId): AdapterAssetSourceCapability[] {
    return [
        supportedDeclaration(
            agentRuntimeId,
            "Subagent",
            "runtime_known_rule",
            "config",
            "family_shared",
            "auto_read",
            "agent_runtime_verified",
        ),
        supportedDeclaration(
            agentRuntimeId,
            "Subagent",
            "runtime_declared_path",
            "config",
            "family_shared",
            "auto_read",
            "agent_runtime_verified",
        ),
        supportedDeclaration(
            agentRuntimeId,
            "Subagent",
            "project_registry_entry",
            "project_actual",
            "project_root",
            "auto_read",
            "local_artifact",
        ),
        supportedDeclaration(
            agentRuntimeId,
            "Subagent",
            "user_provided_path",
            "project_actual",
            "project_root",
            "auto_read",
            "agent_runtime_verified",
        ),
        supportedDeclaration(
            agentRuntimeId,
            "Subagent",
            "user_provided_path",
            "source",
            "external_managed",
            "user_selected_root_only",
            "user_provided",
        ),
    ];
}

function supportedDeclaration(
    agentRuntimeId: CodexAgentRuntimeId,
    assetKind: "Subagent" | "Workflow",
    locator: RootLocatorKind,
    role: RootRole,
    domain: SourceDomain,
    policy: Exclude<ReadPolicy, "report_only">,
    evidence: SourceEvidenceLevel,
): AdapterAssetSourceCapability {
    return sourceCapability({
        agentRuntimeId,
        entrySupportStatus: "supported",
        rootLocatorKind: locator,
        rootRole: role,
        sourceDomain: domain,
        assetKind,
        sourcePathMechanism: "recursive_entry",
        evidenceLevel: evidence,
        readPolicy: policy,
        diagnostics: [],
    });
}

function skillSourceRows(agentRuntimeId: CodexAgentRuntimeId): AdapterAssetSourceCapability[] {
    return [
        supportedSkill(agentRuntimeId, "runtime_known_rule", "source", "family_shared", "auto_read", "source_code"),
        supportedSkill(agentRuntimeId, "project_registry_entry", "project_actual", "project_root", "auto_read", "local_artifact"),
        supportedSkill(
            agentRuntimeId,
            "user_provided_path",
            "project_actual",
            "project_root",
            "auto_read",
            "agent_runtime_verified",
        ),
        supportedSkill(
            agentRuntimeId,
            "user_provided_path",
            "source",
            "external_managed",
            "user_selected_root_only",
            "user_provided",
        ),
    ];
}

function supportedSkill(
    agentRuntimeId: "CODEX_CLI" | "CODEX_APP",
    locator: RootLocatorKind,
    role: RootRole,
    domain: SourceDomain,
    policy: Exclude<ReadPolicy, "report_only">,
    evidence: SourceEvidenceLevel,
): AdapterAssetSourceCapability {
    return sourceCapability({
        agentRuntimeId,
        entrySupportStatus: "supported",
        rootLocatorKind: locator,
        rootRole: role,
        sourceDomain: domain,
        assetKind: "Skill",
        sourcePathMechanism: "recursive_entry",
        evidenceLevel: evidence,
        readPolicy: policy,
        diagnostics: [],
    });
}

function guidanceSourceRows(agentRuntimeId: CodexAgentRuntimeId): AdapterAssetSourceCapability[] {
    return [
        supportedGuidance(agentRuntimeId, "runtime_known_rule", "config", "family_shared", "auto_read", "agent_runtime_verified"),
        supportedGuidance(
            agentRuntimeId,
            "runtime_declared_path",
            "config",
            "family_shared",
            "auto_read",
            "agent_runtime_verified",
        ),
        supportedGuidance(
            agentRuntimeId,
            "project_registry_entry",
            "project_actual",
            "project_root",
            "auto_read",
            "local_artifact",
        ),
        supportedGuidance(
            agentRuntimeId,
            "user_provided_path",
            "project_actual",
            "project_root",
            "auto_read",
            "agent_runtime_verified",
        ),
        supportedGuidance(
            agentRuntimeId,
            "user_provided_path",
            "source",
            "external_managed",
            "user_selected_root_only",
            "user_provided",
        ),
    ];
}

function supportedGuidance(
    agentRuntimeId: CodexAgentRuntimeId,
    locator: RootLocatorKind,
    role: RootRole,
    domain: SourceDomain,
    policy: Exclude<ReadPolicy, "report_only">,
    evidence: SourceEvidenceLevel,
): AdapterAssetSourceCapability {
    return sourceCapability({
        agentRuntimeId,
        entrySupportStatus: "supported",
        rootLocatorKind: locator,
        rootRole: role,
        sourceDomain: domain,
        assetKind: "Guidance",
        sourcePathMechanism: "recursive_entry",
        evidenceLevel: evidence,
        readPolicy: policy,
        diagnostics: [],
    });
}

function sourceRowsFor(agentRuntimeId: CodexAgentRuntimeId): AdapterAssetSourceCapability[] {
    const retained = retainedSourceDisposition(agentRuntimeId, "Workflow");
    return [
        sourceCapability({
            agentRuntimeId,
            entrySupportStatus: "unsupported",
            rootLocatorKind: "unknown",
            rootRole: "unknown",
            sourceDomain: "unknown",
            assetKind: "Workflow",
            sourcePathMechanism: "unknown",
            evidenceLevel: "agent_runtime_verified",
            readPolicy: "report_only",
            diagnostics: [diagnostic("read", retained.code, retained.message, "unsupported", "warning")],
        }),
    ];
}

function unavailableSource(
    agentRuntimeId: CodexAgentRuntimeId,
    assetKind: "Rule",
    status: "unsupported" | "deferred",
): AdapterAssetSourceCapability {
    const retained = retainedSourceDisposition(agentRuntimeId, assetKind);
    return sourceCapability({
        agentRuntimeId,
        entrySupportStatus: status,
        rootLocatorKind: "unknown",
        rootRole: "unknown",
        sourceDomain: "unknown",
        assetKind,
        sourcePathMechanism: "unknown",
        evidenceLevel: "docs_declared",
        readPolicy: "report_only",
        diagnostics: [diagnostic("read", retained.code, retained.message, "unsupported", "warning")],
    });
}

function sourceCapability(
    input: Omit<AdapterAssetSourceCapability, "sourceCapabilityFingerprint">,
): AdapterAssetSourceCapability {
    return createAdapterAssetSourceCapability({ adapterId: "CODEX", agentRuntimes: AGENT_RUNTIMES }, input);
}

function retainedSourceDisposition(agentRuntimeId: CodexAgentRuntimeId, assetKind: AssetKind): { code: string; message: string } {
    const runtimeName = agentRuntimeId === "CODEX_CLI" ? "Codex CLI" : "Codex App";
    const runtimeCode = agentRuntimeId === "CODEX_CLI" ? "codex_cli" : "codex_app";
    if (assetKind === "Rule") {
        return {
            code: `${runtimeCode}_rule_source_unsupported`,
            message:
                `${runtimeName} .rules files are command-execution approval policy, not OAAM knowledge Rule assets; ` +
                "importing them would misclassify executable policy. Reopen only if Codex exposes a distinct declarative " +
                "knowledge-rule surface.",
        };
    }
    if (agentRuntimeId === "CODEX_APP" && assetKind === "Workflow") {
        return {
            code: "codex_app_workflow_source_unsupported",
            message:
                `Codex App embedded ${CODEX_CURRENT_SOURCE_EVIDENCE_BUILDS.CODEX_APP.versionText} exposes no independent native Workflow declaration surface; ` +
                "its reviewed Workflow-to-Skill conversion remains available, while borrowing CLI legacy prompts would " +
                "assign the wrong runtime. Reopen only if a future exact App build adds a native Workflow loader.",
        };
    }
    throw new Error(`no retained Codex source disposition for ${agentRuntimeId}/${assetKind}`);
}
