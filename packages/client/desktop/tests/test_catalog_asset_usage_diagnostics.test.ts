import type { ProtocolOperationParams } from "@oaam/app-server-protocol";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDesktopMessage } from "../src/presentation/localization";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
} from "../src/presentation/presentation-preferences";
import { CatalogAssetUsageRelationships } from "../src/renderer/features/catalog-deployment/CatalogAssetUsageRelationships";
import type {
    DeploymentTargetView,
    DeploymentToolObservationView,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { DEPLOYMENT_PROVIDERS, PROBE_REVIEW } from "./catalog-deployment-test-fixtures";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";

import { analyzeOneAssetUsageTarget } from "../src/renderer/features/catalog-deployment/catalog-asset-usage-analysis";
import { collectDeploymentTargets } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import type { AssetUsageAnalysisState } from "../src/renderer/features/catalog-deployment/catalog-deployment-state";
import { ASSET_ID, VERSION_ID, PROJECT_ID, completeAssetUsage, readyObservations } from "./catalog-deployment-test-support";

afterEach(cleanup);

describe("Desktop exact tool observation diagnostics", () => {
    it("keeps compatibility warnings and unconfirmed build reads distinct from actual executable-mode failure", async () => {
        const params: ProtocolOperationParams<"asset_usage.analyze"> = {
            probeToken: "probe",
            probeResultRowId: "row",
            targetRowId: "target",
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        };
        for (const [code, severity, failureKind] of [
            ["cursor_target_build_compatible_unverified", "warning", "verification_failed"],
            ["native_guidance_project_binding_missing", "error", "verification_failed"],
            ["native_guidance_build_recheck_failed", "error", "verification_failed"],
            ["native_guidance_build_mode_invalid", "error", "tool_changed"],
        ] as const) {
            const diagnostics = [
                {
                    code,
                    severity,
                    message: code,
                    operation: "render",
                    causeKind: "verification_failed",
                    path: "/owned/project",
                    traceId: "",
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: code,
                },
            ] as const;
            const outcome = await analyzeOneAssetUsageTarget(
                { analyzeAssetUsage: vi.fn(async () => ({ status: "failed" as const, diagnostics })) },
                { targetKey: "target", params },
            );
            expect(outcome).toMatchObject({ status: "failed", failureKind, diagnostics });
        }
    });

    it("keeps same-code diagnostics on their exact sibling rows and clears a recovered row", () => {
        const target = {
            ...collectDeploymentTargets(PROBE_REVIEW)[0]!,
            readyAgentRuntimeIds: ["CLAUDE_CODE_CLI", "CLAUDE_CODE_APP"],
            unavailableAgentRuntimeIds: [],
        };
        const params: ProtocolOperationParams<"asset_usage.analyze"> = {
            probeToken: "probe",
            probeResultRowId: "row",
            targetRowId: "target",
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: target.readyAgentRuntimeIds,
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        };
        const result = completeAssetUsage(params);
        const messages = ["CLI graph cannot be materialized", "App graph has a different problem"];
        const diagnostics = messages.map((message) => ({
            code: "render.materialization_blocked",
            message,
            severity: "error" as const,
            operation: "render",
            causeKind: "verification_failed" as const,
            retryable: false,
            suggestedActions: [],
        }));
        result.value.relationships.forEach((row, index) => {
            row.observedTargetState = "unknown";
            row.reasonCodes = [];
            row.diagnostics = [diagnostics[index]!];
        });
        const props = {
            observations: readyObservations([target]),
            providers: DEPLOYMENT_PROVIDERS,
            interactionLocked: false,
            onPrepare: vi.fn(),
            onOpenUsage: vi.fn(),
        };
        const usage: AssetUsageAnalysisState = {
            status: "ready",
            requestKey: "row-local",
            targets: [{ targetKey: target.key, status: "ready", usage: result.value, diagnostics }],
        };
        const view = renderWithPresentation(createElement(CatalogAssetUsageRelationships, { ...props, usage }));
        const row = (label: string) =>
            [...view.container.querySelectorAll<HTMLElement>(".asset-usage-row")].find((candidate) =>
                candidate.textContent?.includes(label),
            )!;
        for (const [label, own, other] of [
            ["Claude Code CLI", messages[0], messages[1]],
            ["Claude Code App", messages[1], messages[0]],
        ]) {
            const current = row(label!);
            const details = current.querySelector<HTMLDetailsElement>(".protocol-technical-disclosure")!;
            fireEvent.click(details.querySelector("summary")!);
            expect(details.open).toBe(true);
            expect(within(details).getByText(new RegExp(own!))).toBeTruthy();
            expect(current.textContent).not.toContain(other);
        }
        const recovered = structuredClone(usage);
        if (recovered.targets[0]?.status !== "ready") throw new Error("ready target missing");
        const app = recovered.targets[0].usage.relationships.find((candidate) => candidate.agentRuntimeId === "CLAUDE_CODE_APP")!;
        app.observedTargetState = "absent";
        app.diagnostics = [];
        view.rerender(createElement(CatalogAssetUsageRelationships, { ...props, usage: recovered }));
        expect(row("Claude Code App").textContent).not.toContain(messages[0]);
        expect(row("Claude Code App").textContent).not.toContain(messages[1]);
        expect(row("Claude Code CLI").textContent).toContain(messages[0]);
    });

    it("keeps an unavailable App diagnostic out of a successful CLI relationship while retaining its own reason", () => {
        const target = collectDeploymentTargets(PROBE_REVIEW)[0]!;
        const observation = readyObservations([target])[0]!;
        const params: ProtocolOperationParams<"asset_usage.analyze"> = {
            probeToken: "probe",
            probeResultRowId: "row",
            targetRowId: "target",
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: [observation.agentRuntimeId],
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        };
        const result = completeAssetUsage(params);
        const diagnostic = (code: string, message: string) => ({
            code,
            message,
            severity: "warning" as const,
            operation: "render",
            causeKind: "partial" as const,
            path: "",
            traceId: "",
            retryable: false,
            suggestedActions: [],
            rawSummary: message,
        });
        result.value.relationships[0]!.diagnostics = [diagnostic("test_direct", "Own checked contract")];
        const view = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: [observation],
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                usage: {
                    status: "ready",
                    requestKey: "partial",
                    targets: [
                        {
                            targetKey: target.key,
                            status: "ready",
                            usage: result.value,
                            diagnostics: [
                                diagnostic("claudecode_app_linux_not_found", "Sibling App is absent"),
                                diagnostic("test_direct", "Own checked contract"),
                            ],
                        },
                    ],
                },
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );
        const row = view.container.querySelector<HTMLElement>(".asset-usage-row")!;
        const details = row.querySelector<HTMLDetailsElement>(".protocol-technical-disclosure")!;
        fireEvent.click(details.querySelector("summary")!);
        expect(details.open).toBe(true);
        expect(within(details).getByText(/Own checked contract/)).toBeTruthy();
        expect(within(details).getByText(/test_direct/)).toBeTruthy();
        expect(row.textContent).not.toContain("claudecode_app_linux_not_found");
        expect(row.textContent).not.toContain("Sibling App is absent");
    });

    it("shows the exact CLI reason and advice without repeating its generic partial-check summary", () => {
        const checkedPath = "\\\\wsl.localhost\\Ubuntu\\home\\example\\.local\\bin\\codex";
        const target: DeploymentTargetView = {
            key: "codex-target-diagnostic",
            probeToken: "probe",
            probeResultRowId: "codex-result",
            targetRowId: "codex-target-row",
            targetCandidateId: "codex-target",
            adapterId: "CODEX",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [],
            readyAgentRuntimeIds: [],
            unavailableAgentRuntimeIds: ["CODEX_CLI"],
        };
        const provider = {
            ...DEPLOYMENT_PROVIDERS[0],
            adapterId: "CODEX",
            displayName: "Codex",
            agentRuntimes: [{ agentRuntimeId: "CODEX_CLI", displayName: "Codex CLI", entryClass: "cli" as const }],
        };
        const observation: DeploymentToolObservationView = {
            key: "codex-observation",
            adapterId: "CODEX",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            agentRuntimeId: "CODEX_CLI",
            versionText: "",
            state: "current_observation_failed",
            reasonCodes: ["codex_cli_version_not_observed", "codex_cli_install_discovery_incomplete"],
            checkedPaths: [checkedPath],
            diagnostics: [
                {
                    severity: "warning",
                    code: "codex_cli_install_discovery_incomplete",
                    operation: "probe",
                    causeKind: "partial",
                    retryable: false,
                    suggestedActions: [],
                    message: "original incomplete installation detail",
                    path: checkedPath,
                },
                {
                    severity: "warning",
                    code: "codex_cli_version_not_observed",
                    operation: "probe",
                    causeKind: "partial",
                    retryable: true,
                    suggestedActions: ["retry"],
                    message: "bounded fixture diagnostic",
                    path: checkedPath,
                },
            ],
            target,
        };

        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: [observation],
                usage: { status: "ready", requestKey: "codex-diagnostic", targets: [] },
                providers: [provider],
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        expect(container.querySelector('[data-oaam-agent-runtime-id="CODEX_CLI"]')).toBeTruthy();
        expect(screen.getByText("Codex CLI")).toBeTruthy();
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).not.toContain(checkedPath);
        expect(ordinary).not.toContain("Failure stage: probe");
        expect(ordinary).not.toContain("bounded fixture diagnostic");
        expect(screen.getByText(`Checked location: ${checkedPath}`)).toBeTruthy();
        expect(screen.getByText("Failure stage: probe")).toBeTruthy();
        expect(
            screen.getByText("The CLI executable was found, but OAAM could not read a stable version from that exact command."),
        ).toBeTruthy();
        expect(
            screen.getByText(
                "Run the checked command once in the selected environment and confirm that it prints a version, then check again.",
            ),
        ).toBeTruthy();
        expect(screen.queryByText("OAAM could not confirm every detail. Available files are still shown.")).toBeNull();
        expect(ordinary).not.toContain("This tool remains in the list");
        expect(container.querySelector(".protocol-diagnostic-attribution")).toBeNull();
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        const disclosure = container.querySelector<HTMLDetailsElement>(".protocol-technical-disclosure");
        const trigger = disclosure?.querySelector("summary");
        if (disclosure === null || trigger === undefined || trigger === null) throw new Error("missing diagnostic evidence");
        expect(disclosure.open).toBe(false);
        fireEvent.click(trigger);
        expect(disclosure.open).toBe(true);
        expect(disclosure.textContent).toContain("original incomplete installation detail");
        expect(disclosure.textContent).toContain("bounded fixture diagnostic");
    });

    it.each([
        ["en", "CODEX", "CODEX_APP", "codex_app_target_installation_not_found"],
        ["zh-CN", "CODEX", "CODEX_CLI", "codex_cli_target_installation_not_found"],
        ["de", "CODEX", "CODEX_APP", "codex_app_global_target_installation_not_found"],
        ["ja", "CODEX", "CODEX_CLI", "codex_cli_global_target_installation_not_found"],
        ["zh-CN", "CLAUDECODE", "CLAUDE_CODE_APP", "claudecode_app_target_installation_not_found"],
        ["en", "CLAUDECODE", "CLAUDE_CODE_CLI", "claudecode_cli_target_installation_not_found"],
        ["de", "CLAUDECODE", "CLAUDE_CODE_APP", "claudecode_app_global_target_installation_not_found"],
        ["ja", "CLAUDECODE", "CLAUDE_CODE_CLI", "claudecode_cli_global_target_installation_not_found"],
    ] as const)("explains installation absence once in %s for %s/%s (%s)", (language, adapterId, agentRuntimeId, code) => {
        const snapshot = createDesktopPresentationSnapshot(
            { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language },
            [language],
            false,
        );
        const observation: DeploymentToolObservationView = {
            key: "not-installed-observation",
            target: undefined,
            adapterId,
            platform: "win32",
            platformInstanceId: "desktop-local",
            agentRuntimeId,
            versionText: "",
            state: "not_installed",
            reasonCodes: [code],
            checkedPaths: [],
            diagnostics: [
                {
                    severity: "warning",
                    code,
                    operation: "probe",
                    causeKind: "not_found",
                    retryable: false,
                    suggestedActions: [],
                    message: "The exact target requires an installed entry.",
                },
            ],
        };
        const chooseInstallationRoot = vi.fn();
        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: [observation],
                usage: { status: "ready", requestKey: "not-installed", targets: [] },
                providers: [
                    {
                        ...DEPLOYMENT_PROVIDERS[0],
                        adapterId,
                        displayName: adapterId === "CODEX" ? "Codex" : "Claude Code",
                        agentRuntimes: [
                            {
                                agentRuntimeId,
                                displayName: `${adapterId === "CODEX" ? "Codex" : "Claude Code"} ${agentRuntimeId.endsWith("_APP") ? "App" : "CLI"}`,
                                entryClass: agentRuntimeId.endsWith("_APP") ? "app" : "cli",
                            },
                        ],
                    },
                ],
                interactionLocked: false,
                onChooseInstallationRoot: chooseInstallationRoot,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
            createDesktopPresentationTestBridge(snapshot),
        );
        expect(screen.getAllByText(formatDesktopMessage(snapshot, "catalog.ui.usage.detail.not_installed"))).toHaveLength(1);
        expect(ordinarySurfaceText(container)).not.toContain(
            formatDesktopMessage(snapshot, "discovery.product.diagnostic.not_found"),
        );
        expect(container.querySelector(".protocol-diagnostic-attribution")).toBeNull();
        expect(container.querySelector(".protocol-diagnostic-summary-list")).toBeNull();
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(1);
        expect(container.textContent).toContain(code);
        fireEvent.click(
            screen.getByRole("button", { name: formatDesktopMessage(snapshot, "catalog.ui.target.choose_installation") }),
        );
        expect(chooseInstallationRoot).toHaveBeenCalledOnce();
        expect(chooseInstallationRoot).toHaveBeenCalledWith(adapterId, observation);
    });

    it("explains the exact App environment and build observations without generic retry copy", () => {
        const projectPath = "\\\\wsl.localhost\\Ubuntu\\workspace\\project";
        const target: DeploymentTargetView = {
            key: "codex-app-target-diagnostic",
            probeToken: "probe",
            probeResultRowId: "codex-app-result",
            targetRowId: "codex-app-target-row",
            targetCandidateId: "codex-app-target",
            adapterId: "CODEX",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [],
            readyAgentRuntimeIds: [],
            unavailableAgentRuntimeIds: ["CODEX_APP"],
        };
        const provider = {
            ...DEPLOYMENT_PROVIDERS[0],
            adapterId: "CODEX",
            displayName: "Codex",
            agentRuntimes: [{ agentRuntimeId: "CODEX_APP", displayName: "Codex App", entryClass: "app" as const }],
        };
        const observation: DeploymentToolObservationView = {
            key: "codex-app-observation",
            adapterId: "CODEX",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            agentRuntimeId: "CODEX_APP",
            versionText: "",
            state: "current_observation_failed",
            reasonCodes: ["codex_app_install_environment_unobserved", "codex_app_target_build_evidence_unavailable"],
            checkedPaths: [projectPath],
            diagnostics: [
                {
                    severity: "warning",
                    code: "codex_app_install_environment_unobserved",
                    operation: "probe",
                    causeKind: "partial",
                    retryable: true,
                    suggestedActions: ["retry"],
                    message: "bounded fixture diagnostic",
                    path: projectPath,
                },
                {
                    severity: "warning",
                    code: "codex_app_target_build_evidence_unavailable",
                    operation: "probe",
                    causeKind: "partial",
                    retryable: true,
                    suggestedActions: ["retry"],
                    message: "bounded build diagnostic",
                    path: projectPath,
                },
            ],
            target,
        };

        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: [observation],
                usage: { status: "ready", requestKey: "codex-app-diagnostic", targets: [] },
                providers: [provider],
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).not.toContain(projectPath);
        expect(ordinary).not.toContain("bounded fixture diagnostic");
        expect(ordinary).not.toContain("bounded build diagnostic");
        expect(screen.getByText(`Checked location: ${projectPath}`)).toBeTruthy();
        expect(screen.getByText("OAAM could not confirm the App installation in the selected environment.")).toBeTruthy();
        expect(ordinary).not.toContain("OAAM could not match this tool entry to a verified version in the selected environment.");
        expect(container.textContent).toContain("bounded build diagnostic");
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        expect(
            screen.queryByText("Choose an entry with confirmed installation evidence. Other entries have their own results."),
        ).toBeNull();
        expect(screen.queryByText("Try the scan again.")).toBeNull();
    });
});
