import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { type DesktopDisplayText, type DesktopMessageId, localizedText } from "../../presentation/localization";
import type { WorkbenchNoticeTone } from "../ui";

export interface ProtocolDiagnosticPresentation {
    readonly attribution: DesktopDisplayText;
    readonly subject: DesktopDisplayText | undefined;
    readonly summary: DesktopDisplayText;
    readonly nextAction: DesktopDisplayText | undefined;
    readonly tone: WorkbenchNoticeTone;
    readonly technicalIdentity: string;
    readonly rawMessage: string;
}

export interface ProtocolFeedback {
    readonly message: DesktopDisplayText;
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
}

function diagnosticAttribution(operation: ProtocolDiagnosticV1["operation"]): DesktopDisplayText {
    switch (operation) {
        case "project":
        case "asset":
        case "version":
        case "search":
        case "reindex":
            return localizedText("discovery.product.diagnostic_attribution.library");
        case "probe":
        case "scan":
            return localizedText("discovery.product.diagnostic_attribution.scan");
        case "read":
            return localizedText("discovery.product.diagnostic_attribution.source_review");
        case "render":
        case "deploy":
        case "reverse_accept":
            return localizedText("discovery.product.diagnostic_attribution.deployment");
        case "settings":
            return localizedText("discovery.product.diagnostic_attribution.choices");
        case "backup":
        case "restore":
            return localizedText("discovery.product.diagnostic_attribution.recovery");
        case "internal":
        case "host":
        case "protocol":
            return localizedText("discovery.product.diagnostic_attribution.oaam");
    }
}

function diagnosticSummaryId(diagnostic: ProtocolDiagnosticV1): DesktopMessageId {
    if (diagnostic.code.endsWith("_workflow_model_invocation_unsupported"))
        return "discovery.product.diagnostic.workflow_model_invocation_unsupported";
    if (diagnostic.code.endsWith("_target_build_compatibility_inferred"))
        return "discovery.product.diagnostic.compatible_build_inferred";
    if (diagnostic.code.endsWith("_cli_version_not_observed")) {
        return "discovery.product.diagnostic.cli_version_unobserved";
    }
    if (diagnostic.code.endsWith("_app_install_environment_unobserved")) {
        return "discovery.product.diagnostic.app_environment_unobserved";
    }
    if (diagnostic.code.endsWith("_target_build_evidence_unavailable")) {
        return "discovery.product.diagnostic.target_build_unavailable";
    }
    if (diagnostic.code.includes("managed") && diagnostic.code.endsWith("excluded")) {
        return "discovery.product.diagnostic.managed_content_excluded";
    }
    if (diagnostic.code.endsWith("_wsl_environment_unobserved")) {
        return "discovery.product.diagnostic.wsl_environment_partial";
    }
    if (diagnostic.code.endsWith("_install_environment_unobserved")) {
        return "discovery.product.diagnostic.install_environment_partial";
    }
    if (diagnostic.code.endsWith("_home_path_invalid")) {
        return "discovery.product.diagnostic.configuration_location_unavailable";
    }
    if (
        diagnostic.code.endsWith("_executable_discovery_incomplete") ||
        diagnostic.code.endsWith("_install_discovery_incomplete")
    ) {
        return "discovery.product.diagnostic.executable_location_unavailable";
    }
    switch (diagnostic.code) {
        case "import.same_source_interpretation_conflict":
            return "discovery.product.diagnostic.source_interpretation_conflict";
        case "read.managed_source_entry_ignored":
            return "discovery.product.diagnostic.managed_source_entry_ignored";
        case "codex.guidance_fallback_configuration_unknown":
            return "discovery.product.diagnostic.codex_guidance_fallback_unknown";
        case "reverse_accept.exact_graph_native_input_stale":
            return "discovery.product.diagnostic.reverse_format_binding_unavailable";
        case "reverse_accept.source_native_rebase_unavailable":
            return "discovery.product.diagnostic.source_native_rebase_unavailable";
        case "render.target_observation_permission_denied":
            return "discovery.product.diagnostic.target_observation_permission_denied";
        case "render.target_observation_blocked_managed_target":
            return "discovery.product.diagnostic.target_observation_blocked_managed_target";
        case "render.target_observation_blocked_symlink_or_reparse":
            return "discovery.product.diagnostic.target_observation_blocked_symlink_or_reparse";
        case "render.target_observation_resource_limit_exceeded":
            return "discovery.product.diagnostic.target_observation_resource_limit_exceeded";
        case "render.target_observation_busy":
            return "discovery.product.diagnostic.target_observation_busy";
        case "render.target_observation_stale":
            return "discovery.product.diagnostic.target_observation_stale";
        case "render.target_observation_io_error":
            return "discovery.product.diagnostic.target_observation_io_error";
        case "render.canonical_conversion_review_required":
            return "discovery.product.diagnostic.conversion_review_required";
        case "render.native_consistency_failed":
            return "discovery.product.diagnostic.generated_content_not_verified";
        case "blocked_by_recovery_target_changed":
            return "discovery.product.diagnostic.recovery_target_changed";
        case "codex_app_target_installation_not_found":
        case "codex_cli_target_installation_not_found":
        case "codex_app_global_target_installation_not_found":
        case "codex_cli_global_target_installation_not_found":
        case "claudecode_app_target_installation_not_found":
        case "claudecode_cli_target_installation_not_found":
        case "claudecode_app_global_target_installation_not_found":
        case "claudecode_cli_global_target_installation_not_found":
            return "catalog.ui.usage.detail.not_installed";
        case "claudecode_app_linux_not_found":
            return "discovery.product.diagnostic.claude_app_not_installed";
        case "native_guidance_runtime_unavailable":
            return "discovery.product.diagnostic.runtime_context_unavailable";
        case "antigravity_managed_project_workspace_excluded":
        case "codex_managed_project_path_excluded":
            return "discovery.product.diagnostic.managed_content_excluded";
        case "antigravity_project_registry_entry_incomplete":
            return "discovery.product.diagnostic.project_record_incomplete";
        case "antigravity_wsl_environment_unobserved":
            return "discovery.product.diagnostic.wsl_environment_partial";
        case "project.root_not_found":
            return "discovery.product.diagnostic.project_root_not_found";
        case "project.root_permission_denied":
            return "discovery.product.diagnostic.project_root_permission_denied";
        case "project.root_is_link":
            return "discovery.product.diagnostic.project_root_is_link";
        case "project.root_not_directory":
            return "discovery.product.diagnostic.project_root_not_directory";
        case "project.root_changed":
            return "discovery.product.diagnostic.project_root_changed";
        case "project.root_invalid":
            return "discovery.product.diagnostic.project_root_invalid";
        case "project.root_unavailable":
            return "discovery.product.diagnostic.project_root_unavailable";
    }
    switch (diagnostic.causeKind) {
        case "not_found":
            return "discovery.product.diagnostic.not_found";
        case "unavailable":
            return "discovery.product.diagnostic.unavailable";
        case "permission_denied":
            return "discovery.product.diagnostic.permission_denied";
        case "version_incompatible":
            return "discovery.product.diagnostic.version_incompatible";
        case "partial":
            return "discovery.product.diagnostic.partial";
        case "invalid_schema":
            return "discovery.product.diagnostic.invalid_data";
        case "unsupported":
            return "discovery.product.diagnostic.unsupported";
        case "conflict":
            return diagnostic.operation === "settings"
                ? "discovery.product.diagnostic.conflict"
                : "discovery.product.diagnostic.state_conflict";
        case "verification_failed":
            return "discovery.product.diagnostic.verification_failed";
        case "internal_error":
            return "discovery.product.diagnostic.internal_error";
        default:
            return "discovery.product.diagnostic.unknown";
    }
}

function diagnosticSubjectId(diagnostic: ProtocolDiagnosticV1): DesktopMessageId | undefined {
    if (diagnostic.code.endsWith("_wsl_environment_unobserved")) return "discovery.product.scan.subject.wsl";
    if (diagnostic.code.includes("_app_home_path_")) return "discovery.product.scan.subject.app_configuration";
    if (diagnostic.code.includes("_ide_home_path_")) return "discovery.product.scan.subject.ide_configuration";
    if (diagnostic.code.includes("_cli_executable_")) return "discovery.product.scan.subject.cli_installation";
    if (diagnostic.code.endsWith("_install_discovery_incomplete")) return "discovery.product.scan.subject.tool_installation";
    if (diagnostic.code.endsWith("_install_environment_unobserved")) {
        return "discovery.product.scan.subject.tool_installation";
    }
    if (diagnostic.code.includes("_project_registry_")) return "discovery.product.scan.subject.project_list";
    return undefined;
}

function diagnosticActionId(diagnostic: ProtocolDiagnosticV1): DesktopMessageId | undefined {
    if (diagnostic.code.endsWith("_workflow_model_invocation_unsupported")) return undefined;
    if (
        diagnostic.code.endsWith("_target_build_compatibility_inferred") ||
        diagnostic.code === "reverse_accept.exact_graph_native_input_stale" ||
        diagnostic.code === "reverse_accept.source_native_rebase_unavailable"
    )
        return undefined;
    if (
        diagnostic.code === "render.canonical_conversion_review_required" ||
        diagnostic.code === "render.native_consistency_failed" ||
        diagnostic.code.startsWith("render.target_observation_")
    ) {
        return undefined;
    }
    if (diagnostic.code === "blocked_by_recovery_target_changed") {
        return "discovery.product.action.review_recovery_changes";
    }
    // Repeating a scan cannot itself observe another environment's process-local configuration.
    if (diagnostic.code.endsWith("_wsl_environment_unobserved")) return undefined;
    if (diagnostic.code.endsWith("_cli_version_not_observed")) {
        return "discovery.product.action.verify_cli_version";
    }
    if (
        diagnostic.code.endsWith("_app_install_environment_unobserved") ||
        diagnostic.code.endsWith("_target_build_evidence_unavailable")
    ) {
        return undefined;
    }
    const actions = diagnostic.suggestedActions;
    const preferred = [
        "retry",
        "grant_permission",
        "upgrade_runtime",
        "upgrade_adapter",
        "choose_target",
        "rebuild_deployment",
        "install_runtime",
        "contact_support",
        "skip",
    ] as const;
    const action = preferred.find((candidate) => actions.includes(candidate));
    switch (action) {
        case "retry":
            return diagnostic.operation === "probe" || diagnostic.operation === "scan"
                ? "discovery.product.action.retry"
                : "discovery.product.action.review_again";
        case "grant_permission":
            return "discovery.product.action.permission";
        case "upgrade_runtime":
            return "discovery.product.action.upgrade_tool";
        case "upgrade_adapter":
            return "discovery.product.action.upgrade_oaam";
        case "choose_target":
            return "discovery.product.action.choose_location";
        case "rebuild_deployment":
            return "discovery.product.action.review_again";
        case "install_runtime":
            return "discovery.product.action.install_optional";
        case "contact_support":
            return "discovery.product.action.support";
        case "skip":
            return "discovery.product.action.skip";
        case undefined:
            return undefined;
    }
}

export function protocolDiagnosticIdentity(diagnostic: ProtocolDiagnosticV1): string {
    return JSON.stringify([
        diagnostic.severity,
        diagnostic.code,
        diagnostic.operation,
        diagnostic.causeKind,
        diagnostic.retryable,
        diagnostic.suggestedActions,
        diagnostic.message,
        diagnostic.path ?? "",
        diagnostic.traceId ?? "",
    ]);
}

export function uniqueProtocolDiagnostics(diagnostics: readonly ProtocolDiagnosticV1[]): readonly ProtocolDiagnosticV1[] {
    const seen = new Set<string>();
    return Object.freeze(
        diagnostics.filter((diagnostic) => {
            const key = protocolDiagnosticIdentity(diagnostic);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }),
    );
}

export function protocolFeedback(
    message: DesktopDisplayText,
    diagnostics: readonly ProtocolDiagnosticV1[] = [],
): ProtocolFeedback {
    return Object.freeze({
        message,
        diagnostics: uniqueProtocolDiagnostics(diagnostics),
    });
}

export function nonInformationalProtocolDiagnostics(
    diagnostics: readonly ProtocolDiagnosticV1[],
): readonly ProtocolDiagnosticV1[] {
    return uniqueProtocolDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity !== "info"));
}

export function mergeNonInformationalProtocolDiagnostics(
    ...groups: readonly (readonly ProtocolDiagnosticV1[])[]
): readonly ProtocolDiagnosticV1[] {
    return nonInformationalProtocolDiagnostics(groups.flat());
}

export function presentProtocolDiagnostic(diagnostic: ProtocolDiagnosticV1): ProtocolDiagnosticPresentation {
    const actionId = diagnosticActionId(diagnostic);
    const subjectId = diagnosticSubjectId(diagnostic);
    return Object.freeze({
        attribution: diagnosticAttribution(diagnostic.operation),
        subject: subjectId === undefined ? undefined : localizedText(subjectId),
        summary: localizedText(diagnosticSummaryId(diagnostic)),
        nextAction: actionId === undefined ? undefined : localizedText(actionId),
        tone:
            diagnostic.severity === "info" ||
            diagnostic.causeKind === "not_found" ||
            diagnostic.causeKind === "unsupported" ||
            diagnostic.code.endsWith("_wsl_environment_unobserved") ||
            diagnostic.code.endsWith("_app_install_environment_unobserved")
                ? "note"
                : "warning",
        technicalIdentity: `${diagnostic.operation}:${diagnostic.code}`,
        rawMessage: diagnostic.message,
    });
}
