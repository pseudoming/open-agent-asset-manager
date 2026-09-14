import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { describe, expect, it } from "vitest";
import {
    discoveryInstallationStatusMessage,
    discoveryInstallationStatusTone,
    discoveryProbeStatusMessage,
    discoveryProbeStatusTone,
    discoverySourceStatusMessage,
    discoverySourceStatusTone,
    discoveryToolOutcomeMessage,
    discoveryToolOutcomeTone,
    presentDiscoveryAgentRuntime,
    presentDiscoveryEnvironment,
    presentDiscoveryPath,
    presentDiscoverySourceRelationship,
    presentDiscoveryTool,
} from "../src/renderer/features/discovery/discovery-presentation";
import { presentProtocolDiagnostic } from "../src/renderer/presentation";
import { PROVIDERS, required } from "./discovery-test-fixtures";

function diagnostic(
    causeKind: ProtocolDiagnosticV1["causeKind"],
    suggestedActions: ProtocolDiagnosticV1["suggestedActions"],
    severity: ProtocolDiagnosticV1["severity"] = "warning",
): ProtocolDiagnosticV1 {
    return {
        severity,
        code: `fixture.${causeKind}`,
        operation: "probe",
        causeKind,
        retryable: true,
        suggestedActions,
        message: `Raw ${causeKind}`,
    };
}

describe("Desktop discovery product-language projection", () => {
    it("projects known tools and all supported environments without exposing their identities as labels", () => {
        expect(presentDiscoveryTool("CLAUDECODE", PROVIDERS)).toMatchObject({
            label: { kind: "technical", text: "Claude Code" },
            technicalIdentity: "CLAUDECODE",
            known: true,
        });
        expect(presentDiscoveryTool("UNKNOWN", PROVIDERS)).toMatchObject({
            label: { kind: "localized", id: "discovery.product.tool.unavailable" },
            technicalIdentity: "UNKNOWN",
            known: false,
        });
        expect(presentDiscoveryAgentRuntime("CLAUDE_CODE_CLI", PROVIDERS)).toMatchObject({
            label: { kind: "technical", text: "Claude Code CLI" },
            technicalIdentity: "CLAUDE_CODE_CLI",
            known: true,
        });
        expect(presentDiscoveryAgentRuntime("UNKNOWN_RUNTIME", PROVIDERS)).toMatchObject({
            label: { kind: "localized", id: "discovery.product.tool.unavailable" },
            technicalIdentity: "UNKNOWN_RUNTIME",
            known: false,
        });
        expect(
            presentDiscoveryTool("BLANK", [
                {
                    ...required(PROVIDERS[0], "provider fixture"),
                    adapterId: "BLANK",
                    displayName: " ",
                },
            ]),
        ).toMatchObject({
            label: { kind: "localized", id: "discovery.product.tool.unavailable" },
            known: true,
        });

        expect(presentDiscoveryEnvironment({ platform: "win32", platformInstanceId: "desktop-local" })).toMatchObject({
            id: "discovery.product.environment.windows",
        });
        expect(presentDiscoveryEnvironment({ platform: "wsl", platformInstanceId: "Ubuntu" })).toMatchObject({
            id: "discovery.product.environment.wsl",
            values: { distribution: { kind: "technical", text: "Ubuntu" } },
        });
        expect(presentDiscoveryEnvironment({ platform: "darwin", platformInstanceId: "local" })).toMatchObject({
            id: "discovery.product.environment.mac",
        });
        expect(presentDiscoveryEnvironment({ platform: "linux", platformInstanceId: "local" })).toMatchObject({
            id: "discovery.product.environment.linux",
        });
        expect(
            presentDiscoveryPath("\\\\wsl.localhost\\Ubuntu\\home\\example\\.gemini", {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
            }),
        ).toBe("/home/example/.gemini");
        expect(
            presentDiscoveryPath("\\\\wsl$\\Ubuntu\\home\\example\\.gemini", {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
            }),
        ).toBe("/home/example/.gemini");
        expect(
            presentDiscoveryPath("\\\\wsl.localhost\\Debian\\home\\example", {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
            }),
        ).toBe("\\\\wsl.localhost\\Debian\\home\\example");
        expect(presentDiscoveryPath("C:\\Users\\owner", { platform: "win32", platformInstanceId: "desktop-local" })).toBe(
            "C:\\Users\\owner",
        );
    });

    it("maps every source, scan, installation and relationship state to an explicit product presentation", () => {
        expect(
            (["current", "new", "moved", "missing", "not_checked"] as const).map((status) => [
                discoverySourceStatusMessage(status),
                discoverySourceStatusTone(status),
            ]),
        ).toEqual([
            ["discovery.ui.status.current", "success"],
            ["discovery.ui.status.new", "accent"],
            ["discovery.ui.status.moved", "warning"],
            ["discovery.ui.status.missing", "danger"],
            ["discovery.ui.status.not_checked", "neutral"],
        ]);
        expect(
            (["complete", "partial", "failed"] as const).map((status) => [
                discoveryProbeStatusMessage(status),
                discoveryProbeStatusTone(status),
            ]),
        ).toEqual([
            ["discovery.product.scan.complete", "success"],
            ["discovery.product.scan.partial", "neutral"],
            ["discovery.product.scan.failed", "warning"],
        ]);
        expect(
            (["available", "not_found", "needs_permission", "version_incompatible", "unknown"] as const).map((status) => [
                discoveryInstallationStatusMessage(status),
                discoveryInstallationStatusTone(status),
            ]),
        ).toEqual([
            ["discovery.product.installation.available", "success"],
            ["discovery.product.installation.no_content", "neutral"],
            ["discovery.product.installation.permission", "warning"],
            ["discovery.product.installation.incompatible", "warning"],
            ["discovery.product.installation.not_checked", "neutral"],
        ]);
        expect(
            (["native", "compatible_shared", "ambiguous_private", "observed"] as const).map((kind) =>
                presentDiscoverySourceRelationship(kind),
            ),
        ).toMatchObject([
            { labelId: "discovery.product.relationship.native", icon: "reveal", tone: "neutral" },
            { labelId: "discovery.product.relationship.compatible", icon: "copy", tone: "accent" },
            { labelId: "discovery.product.relationship.ambiguous", icon: "warning", tone: "warning" },
            { labelId: "discovery.product.relationship.additional", icon: "info", tone: "neutral" },
        ]);
        expect(discoveryToolOutcomeMessage("complete", "available")).toBe("discovery.product.installation.available");
        expect(discoveryToolOutcomeTone("complete", "needs_permission")).toBe("warning");
        expect(discoveryToolOutcomeMessage("partial", "available")).toBe("discovery.product.scan.partial");
        expect(discoveryToolOutcomeTone("failed", "available")).toBe("warning");
    });

    it("localizes every diagnostic cause and action while retaining raw evidence only as technical data", () => {
        const causes = [
            "not_found",
            "unavailable",
            "permission_denied",
            "version_incompatible",
            "partial",
            "invalid_schema",
            "unsupported",
            "conflict",
            "verification_failed",
            "internal_error",
        ] as const;
        const actions = [
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
        for (const [index, causeKind] of causes.entries()) {
            const action = required(actions[index % actions.length], "diagnostic action");
            const projected = presentProtocolDiagnostic(diagnostic(causeKind, [action]));
            expect(projected.summary).toMatchObject({ kind: "localized" });
            expect(projected.nextAction).toMatchObject({ kind: "localized" });
            expect(projected.technicalIdentity).toBe(`probe:fixture.${causeKind}`);
            expect(projected.rawMessage).toBe(`Raw ${causeKind}`);
        }

        expect(presentProtocolDiagnostic(diagnostic("not_found", [], "error"))).toMatchObject({
            tone: "note",
            nextAction: undefined,
        });
        expect(presentProtocolDiagnostic(diagnostic("conflict", [], "info"))).toMatchObject({ tone: "note" });
        expect(presentProtocolDiagnostic(diagnostic("conflict", [], "error"))).toMatchObject({ tone: "warning" });
        expect(
            presentProtocolDiagnostic({
                ...diagnostic("internal_error", []),
                causeKind: "future_cause",
            } as unknown as ProtocolDiagnosticV1),
        ).toMatchObject({
            summary: { kind: "localized", id: "discovery.product.diagnostic.unknown" },
        });
        expect(
            presentProtocolDiagnostic({
                ...diagnostic("invalid_schema", []),
                code: "antigravity_project_registry_entry_incomplete",
            }),
        ).toMatchObject({
            subject: { kind: "localized", id: "discovery.product.scan.subject.project_list" },
            summary: { kind: "localized", id: "discovery.product.diagnostic.project_record_incomplete" },
        });
        expect(
            presentProtocolDiagnostic({
                ...diagnostic("partial", []),
                code: "antigravity_wsl_environment_unobserved",
            }),
        ).toMatchObject({
            subject: { kind: "localized", id: "discovery.product.scan.subject.wsl" },
            summary: { kind: "localized", id: "discovery.product.diagnostic.wsl_environment_partial" },
        });
        for (const code of ["antigravity_managed_project_workspace_excluded", "codex_managed_project_path_excluded"]) {
            expect(
                presentProtocolDiagnostic({
                    ...diagnostic("unsupported", []),
                    code,
                }),
            ).toMatchObject({
                summary: { kind: "localized", id: "discovery.product.diagnostic.managed_content_excluded" },
            });
        }
        expect(
            presentProtocolDiagnostic({
                ...diagnostic("unavailable", []),
                code: "cursor_app_home_path_invalid",
            }),
        ).toMatchObject({
            subject: { kind: "localized", id: "discovery.product.scan.subject.app_configuration" },
            summary: { kind: "localized", id: "discovery.product.diagnostic.configuration_location_unavailable" },
        });
        expect(
            presentProtocolDiagnostic({
                ...diagnostic("partial", []),
                code: "opencode_cli_executable_discovery_incomplete",
            }),
        ).toMatchObject({
            subject: { kind: "localized", id: "discovery.product.scan.subject.cli_installation" },
            summary: { kind: "localized", id: "discovery.product.diagnostic.executable_location_unavailable" },
        });
        expect(
            presentProtocolDiagnostic({
                ...diagnostic("partial", ["retry"]),
                code: "codex_cli_version_not_observed",
            }),
        ).toMatchObject({
            summary: { kind: "localized", id: "discovery.product.diagnostic.cli_version_unobserved" },
            nextAction: { kind: "localized", id: "discovery.product.action.verify_cli_version" },
        });
        for (const [code, summary] of [
            ["codex_app_install_environment_unobserved", "discovery.product.diagnostic.app_environment_unobserved"],
            ["codex_app_target_build_evidence_unavailable", "discovery.product.diagnostic.target_build_unavailable"],
        ] as const) {
            expect(
                presentProtocolDiagnostic({
                    ...diagnostic("partial", ["retry"]),
                    code,
                }),
            ).toMatchObject({
                summary: { kind: "localized", id: summary },
                nextAction: undefined,
            });
        }
        for (const code of [
            "project.root_not_found",
            "project.root_permission_denied",
            "project.root_not_directory",
            "project.root_changed",
            "project.root_invalid",
            "project.root_unavailable",
        ] as const) {
            expect(
                presentProtocolDiagnostic({
                    ...diagnostic("unavailable", []),
                    code,
                    operation: "project",
                }),
            ).toMatchObject({
                summary: {
                    kind: "localized",
                    id: `discovery.product.diagnostic.${code.replace("project.root_", "project_root_")}`,
                },
            });
        }
    });

    it("attributes every diagnostic operation in product language instead of exposing the operation enum", () => {
        const expected = {
            project: "discovery.product.diagnostic_attribution.library",
            asset: "discovery.product.diagnostic_attribution.library",
            version: "discovery.product.diagnostic_attribution.library",
            probe: "discovery.product.diagnostic_attribution.scan",
            read: "discovery.product.diagnostic_attribution.source_review",
            render: "discovery.product.diagnostic_attribution.deployment",
            deploy: "discovery.product.diagnostic_attribution.deployment",
            scan: "discovery.product.diagnostic_attribution.scan",
            search: "discovery.product.diagnostic_attribution.library",
            reindex: "discovery.product.diagnostic_attribution.library",
            settings: "discovery.product.diagnostic_attribution.choices",
            backup: "discovery.product.diagnostic_attribution.recovery",
            restore: "discovery.product.diagnostic_attribution.recovery",
            reverse_accept: "discovery.product.diagnostic_attribution.deployment",
            internal: "discovery.product.diagnostic_attribution.oaam",
            host: "discovery.product.diagnostic_attribution.oaam",
            protocol: "discovery.product.diagnostic_attribution.oaam",
        } as const;
        for (const [operation, messageId] of Object.entries(expected)) {
            expect(
                presentProtocolDiagnostic({
                    ...diagnostic("conflict", []),
                    operation,
                } as ProtocolDiagnosticV1).attribution,
            ).toMatchObject({ kind: "localized", id: messageId });
        }
    });
});
