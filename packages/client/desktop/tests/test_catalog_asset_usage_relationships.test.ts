import type { ProtocolOperationParams, ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogAssetUsageRelationships } from "../src/renderer/features/catalog-deployment/CatalogAssetUsageRelationships";
import type {
    DeploymentTargetView,
    DeploymentToolObservationView,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import type { AssetUsageAnalysisState } from "../src/renderer/features/catalog-deployment/catalog-deployment-state";
import { DEPLOYMENT_PROVIDERS, PROBE_REVIEW } from "./catalog-deployment-test-fixtures";
import { collectDeploymentTargets } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import {
    ASSET_ID,
    completeAssetUsage,
    createController,
    readyObservations,
    fakeCatalogClient,
    PROJECT_ID,
    VERSION_ID,
} from "./catalog-deployment-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value) {
            if (resolvePromise === undefined) throw new Error("deferred Asset-usage outcome has no resolver");
            resolvePromise(value);
        },
    };
}

afterEach(cleanup);

describe("Desktop Asset usage relationships", () => {
    it("retains a manual group choice as a checking row becomes passively usable", () => {
        const target = collectDeploymentTargets(PROBE_REVIEW)[0]!;
        const observation = readyObservations([target])[0]!;
        const props = {
            observations: [observation],
            providers: DEPLOYMENT_PROVIDERS,
            interactionLocked: false,
            onPrepare: vi.fn(),
            onOpenUsage: vi.fn(),
        };
        const pending: AssetUsageAnalysisState = {
            status: "loading",
            requestKey: "same-check",
            completedCount: 0,
            totalCount: 1,
            targets: [],
        };
        const ready: AssetUsageAnalysisState = {
            status: "ready",
            requestKey: "same-check",
            targets: [
                {
                    targetKey: target.key,
                    status: "ready",
                    usage: {
                        schemaVersion: 2,
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        relationships: [
                            {
                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                capability: "direct",
                                observedTargetState: "already_usable",
                                managedState: "none",
                                substitute: null,
                                deploymentIds: [],
                                appliedDeploymentIds: [],
                                degradationKinds: [],
                                reasonCodes: [],
                                diagnostics: [],
                                requiresReview: false,
                            },
                        ],
                    },
                },
            ],
        };
        const view = renderWithPresentation(createElement(CatalogAssetUsageRelationships, { ...props, usage: pending }));
        const group = () => view.container.querySelector<HTMLElement>(".asset-usage-group");
        const toggle = () => fireEvent.click(view.container.querySelector<HTMLButtonElement>(".asset-usage-group-summary")!);
        expect(group()?.dataset.oaamGroupOpen).toBe("true");
        toggle();
        view.rerender(createElement(CatalogAssetUsageRelationships, { ...props, usage: ready }));
        expect(group()?.dataset.oaamGroupOpen).toBe("false");
        toggle();
        view.rerender(createElement(CatalogAssetUsageRelationships, { ...props, usage: pending }));
        expect(group()?.dataset.oaamGroupOpen).toBe("true");
        view.rerender(createElement(CatalogAssetUsageRelationships, { ...props, usage: ready }));
        expect(group()?.dataset.oaamGroupOpen).toBe("true");
    });

    it("loads exact-target relationships without creating a Deployment intent", async () => {
        const fake = fakeCatalogClient();
        const controller = createController(fake.client);
        await controller.load();
        const params: ProtocolOperationParams<"asset_usage.analyze"> = {
            probeToken: "probe-token",
            probeResultRowId: "probe-row",
            targetRowId: "target-row",
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        };

        await controller.analyzeAssetUsage("usage-1", [{ targetKey: "target-key", params }]);

        expect(fake.client.analyzeAssetUsage).toHaveBeenCalledWith(params);
        expect(fake.client.createDeployment).not.toHaveBeenCalled();
        expect(controller.state).toMatchObject({
            status: "ready",
            assetUsage: {
                status: "ready",
                requestKey: "usage-1",
                targets: [
                    {
                        targetKey: "target-key",
                        status: "ready",
                        usage: {
                            relationships: [
                                {
                                    agentRuntimeId: "CLAUDE_CODE_CLI",
                                    capability: "direct",
                                    observedTargetState: "absent",
                                    managedState: "none",
                                },
                            ],
                        },
                    },
                ],
            },
            activity: { status: "idle" },
        });
        await controller.analyzeAssetUsage("reset", []);
        expect(controller.state).toMatchObject({ assetUsage: { status: "none" } });
    });

    it("keeps the whole section loading while publishing each completed target and retains per-target failures", async () => {
        const first = deferred<ProtocolOperationTerminal<"asset_usage.analyze">>();
        const second = deferred<ProtocolOperationTerminal<"asset_usage.analyze">>();
        const fake = fakeCatalogClient({
            analyzeAssetUsage: vi.fn((params) =>
                params.consumerAgentRuntimeIds.includes("CLAUDE_CODE_CLI") ? first.promise : second.promise,
            ),
        });
        const controller = createController(fake.client);
        await controller.load();
        const request = (
            targetKey: string,
            agentRuntimeId: "CLAUDE_CODE_CLI" | "OPENCODE_CLI",
        ): { readonly targetKey: string; readonly params: ProtocolOperationParams<"asset_usage.analyze"> } => ({
            targetKey,
            params: {
                probeToken: "probe-token",
                probeResultRowId: `${targetKey}-result`,
                targetRowId: `${targetKey}-row`,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                consumerAgentRuntimeIds: [agentRuntimeId],
                asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
            },
        });
        const running = controller.analyzeAssetUsage("usage-progress", [
            request("claude-target", "CLAUDE_CODE_CLI"),
            request("opencode-target", "OPENCODE_CLI"),
        ]);

        expect(controller.state).toMatchObject({
            status: "ready",
            assetUsage: { status: "loading", completedCount: 0, totalCount: 2, targets: [] },
        });

        second.resolve(completeAssetUsage(request("opencode-target", "OPENCODE_CLI").params));
        await vi.waitFor(() => {
            expect(controller.state).toMatchObject({
                status: "ready",
                assetUsage: {
                    status: "loading",
                    completedCount: 1,
                    totalCount: 2,
                    targets: [{ targetKey: "opencode-target", status: "ready" }],
                },
            });
        });

        first.resolve({
            status: "failed",
            diagnostics: [
                {
                    severity: "error",
                    code: "native_guidance_build_mode_invalid",
                    message: "fixture executable mode changed",
                    path: "/fixture/bin/claude",
                    traceId: "",
                    operation: "render",
                    causeKind: "verification_failed",
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: "fixture executable mode changed",
                },
            ],
        });
        await running;

        expect(controller.state).toMatchObject({
            status: "ready",
            assetUsage: {
                status: "ready",
                targets: [
                    { targetKey: "claude-target", status: "failed", failureKind: "tool_changed" },
                    { targetKey: "opencode-target", status: "ready" },
                ],
            },
        });
    });

    it("does not project one ready runtime failure onto an unavailable sibling runtime", () => {
        const target: DeploymentTargetView = {
            key: "opencode-target",
            probeToken: "probe",
            probeResultRowId: "opencode-result",
            targetRowId: "opencode-target-row",
            targetCandidateId: "opencode-target",
            adapterId: "OPENCODE",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [{ agentRuntimeId: "OPENCODE_CLI", runtimeRowId: "opencode-cli", versionText: "2.1.220" }],
            readyAgentRuntimeIds: ["OPENCODE_CLI"],
            unavailableAgentRuntimeIds: ["OPENCODE_APP"],
        };
        const opencodeProvider = {
            adapterId: "OPENCODE",
            displayName: "OpenCode",
            version: "1.0.0",
            enabled: true,
            agentRuntimes: [
                { agentRuntimeId: "OPENCODE_CLI", displayName: "OpenCode CLI", entryClass: "cli" as const },
                { agentRuntimeId: "OPENCODE_APP", displayName: "OpenCode App", entryClass: "app" as const },
            ],
            sourceCapabilities: [],
            targetCapabilities: [],
        };

        renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: readyObservations([target]),
                usage: {
                    status: "ready",
                    requestKey: "usage-mixed-applicability",
                    targets: [{ targetKey: target.key, status: "failed", failureKind: "tool_changed" }],
                },
                providers: [...DEPLOYMENT_PROVIDERS, opencodeProvider],
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        const cliRow = screen.getByText("OpenCode CLI 2.1.220").closest("li");
        const appRow = screen.getByText("OpenCode App").closest("li");
        if (cliRow === null || appRow === null) throw new Error("mixed OpenCode relationship rows are required");
        expect(within(cliRow).getByText("Could not verify")).toBeTruthy();
        expect(within(cliRow).getByText(/moved or changed/u)).toBeTruthy();
        expect(within(appRow).getByText("Not supported here")).toBeTruthy();
        expect(within(appRow).getByText("This tool does not support this Asset at the selected location.")).toBeTruthy();
        expect(appRow.getAttribute("data-oaam-asset-usage-analysis")).toBe("complete");
    });

    it("keeps one ready runtime primary while disclosing an unavailable sibling as another exact check", () => {
        const target: DeploymentTargetView = {
            key: "opencode-target",
            probeToken: "probe",
            probeResultRowId: "opencode-result",
            targetRowId: "opencode-target-row",
            targetCandidateId: "opencode-target",
            adapterId: "OPENCODE",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [{ agentRuntimeId: "OPENCODE_CLI", runtimeRowId: "opencode-cli", versionText: "1.18.15" }],
            readyAgentRuntimeIds: ["OPENCODE_CLI"],
            unavailableAgentRuntimeIds: ["OPENCODE_APP"],
        };
        const params: ProtocolOperationParams<"asset_usage.analyze"> = {
            probeToken: target.probeToken,
            probeResultRowId: target.probeResultRowId,
            targetRowId: target.targetRowId,
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["OPENCODE_CLI"],
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        };

        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: readyObservations([target]),
                usage: {
                    status: "ready",
                    requestKey: "usage-ready-with-unavailable-sibling",
                    targets: [{ targetKey: target.key, status: "ready", usage: completeAssetUsage(params).value }],
                },
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        const rows = container.querySelectorAll<HTMLElement>(".asset-usage-row");
        expect(rows).toHaveLength(2);
        expect(rows[0]?.dataset.oaamAgentRuntimeId).toBe("OPENCODE_CLI");
        expect(rows[1]?.dataset.oaamAgentRuntimeId).toBe("OPENCODE_APP");
        expect(rows[1]?.dataset.oaamSecondaryObservation).toBe("true");
        expect(rows[1]?.hidden).toBe(true);
        const disclosure = screen.getByRole("button", { name: /Unavailable or unconfirmed entries \(1\)/u });
        if (disclosure === null) {
            throw new Error("the unavailable sibling disclosure is required");
        }
        fireEvent.click(disclosure);
        expect(disclosure.getAttribute("aria-expanded")).toBe("true");
        expect(rows[1]?.hidden).toBe(false);
        expect(within(rows[1] as HTMLElement).getByText("Not supported here")).toBeTruthy();
        expect(container.querySelector(".asset-usage-relationships")?.getAttribute("data-oaam-surface")).toBe("section");
    });

    it("shows direct product language for conversions and keeps review/open actions attributable", () => {
        const codexTarget: DeploymentTargetView = {
            key: "codex-target",
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
            readyAgentRuntimeIds: ["CODEX_CLI"],
            unavailableAgentRuntimeIds: [],
        };
        const claudeTarget: DeploymentTargetView = {
            ...codexTarget,
            key: "claude-target",
            probeResultRowId: "claude-result",
            targetRowId: "claude-target-row",
            targetCandidateId: "claude-target",
            adapterId: "CLAUDECODE",
            readyAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        };
        const usage: AssetUsageAnalysisState = {
            status: "ready",
            requestKey: "usage",
            targets: [
                {
                    targetKey: codexTarget.key,
                    status: "ready",
                    usage: {
                        schemaVersion: 2,
                        assetId: "22222222-2222-4222-8222-222222222222",
                        versionId: "33333333-3333-4333-8333-333333333333",
                        relationships: [
                            {
                                agentRuntimeId: "CODEX_CLI",
                                capability: "substitute",
                                observedTargetState: "absent",
                                managedState: "none",
                                substitute: { assetKind: "Skill" },
                                deploymentIds: [],
                                appliedDeploymentIds: [],
                                degradationKinds: ["target_runtime_missing_asset_kind"],
                                reasonCodes: ["codex_workflow_converted_to_skill"],
                                diagnostics: [],
                                requiresReview: true,
                            },
                        ],
                    },
                },
                {
                    targetKey: claudeTarget.key,
                    status: "ready",
                    usage: {
                        schemaVersion: 2,
                        assetId: "22222222-2222-4222-8222-222222222222",
                        versionId: "33333333-3333-4333-8333-333333333333",
                        relationships: [
                            {
                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                capability: "direct",
                                observedTargetState: "already_usable",
                                managedState: "applied",
                                substitute: null,
                                deploymentIds: [DEPLOYMENT_ID],
                                appliedDeploymentIds: [DEPLOYMENT_ID],
                                degradationKinds: [],
                                reasonCodes: ["project_guidance_preserved_native_file"],
                                diagnostics: [],
                                requiresReview: false,
                            },
                        ],
                    },
                },
            ],
        };
        const onPrepare = vi.fn();
        const onOpenUsage = vi.fn();
        const codexProvider = {
            ...DEPLOYMENT_PROVIDERS[0],
            adapterId: "CODEX",
            displayName: "Codex",
            agentRuntimes: [{ agentRuntimeId: "CODEX_CLI", displayName: "Codex CLI", entryClass: "cli" as const }],
        };

        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: readyObservations([codexTarget, claudeTarget]),
                usage,
                providers: [codexProvider, ...DEPLOYMENT_PROVIDERS],
                interactionLocked: false,
                onPrepare,
                onOpenUsage,
            }),
        );

        const collapsedSummaries = container.querySelectorAll<HTMLButtonElement>(
            '[data-oaam-group-collapsed-summary="true"] .asset-usage-group-summary',
        );
        expect(collapsedSummaries).toHaveLength(1);
        for (const summary of collapsedSummaries) {
            expect(summary.querySelector('[data-oaam-icon="chevron_right"]')).toBeTruthy();
            fireEvent.click(summary);
            expect(summary.querySelector('[data-oaam-icon="chevron_down"]')).toBeTruthy();
        }

        expect(screen.getByText("Not added yet")).toBeTruthy();
        expect(screen.getByText(/no native support.*Skill.*Review the conversion/u)).toBeTruthy();
        expect(screen.getByText("Applied")).toBeTruthy();
        expect(document.querySelector('[data-oaam-agent-runtime-id="CLAUDE_CODE_CLI"]')).toMatchObject({
            dataset: expect.objectContaining({
                oaamAdapterId: "CLAUDECODE",
                oaamPlatform: "wsl",
                oaamPlatformInstanceId: "Ubuntu",
                oaamTargetCandidateId: "claude-target",
                oaamObservationKey: expect.any(String),
            }),
        });
        fireEvent.click(screen.getByRole("button", { name: "Review converted result" }));
        expect(onPrepare).toHaveBeenCalledWith(codexTarget, "CODEX_CLI");
        fireEvent.click(screen.getByRole("button", { name: "View usage" }));
        expect(onOpenUsage).toHaveBeenCalledWith(claudeTarget, DEPLOYMENT_ID);
    });

    it("derives actions from observed target and managed state without treating capability as a write request", () => {
        const target: DeploymentTargetView = {
            key: "state-target",
            probeToken: "probe",
            probeResultRowId: "state-result",
            targetRowId: "state-row",
            targetCandidateId: "state-target",
            adapterId: "CLAUDECODE",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [],
            readyAgentRuntimeIds: ["CLAUDE_CODE_CLI", "OPENCODE_CLI", "CODEX_CLI", "ZCODE_APP"],
            unavailableAgentRuntimeIds: [],
        };
        const relationship = (
            agentRuntimeId: string,
            observedTargetState: "already_usable" | "different" | "unknown",
            managedState: "none" | "applied" = "none",
        ) => ({
            agentRuntimeId,
            capability: "direct" as const,
            observedTargetState,
            managedState,
            substitute: null,
            deploymentIds: managedState === "applied" ? [DEPLOYMENT_ID] : [],
            appliedDeploymentIds: managedState === "applied" ? [DEPLOYMENT_ID] : [],
            degradationKinds: [],
            reasonCodes: ["test_direct"],
            diagnostics: [],
            requiresReview: false,
        });
        const onPrepare = vi.fn();
        const onOpenUsage = vi.fn();

        renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: readyObservations([target]),
                usage: {
                    status: "ready",
                    requestKey: "state-usage",
                    targets: [
                        {
                            targetKey: target.key,
                            status: "ready",
                            usage: {
                                schemaVersion: 2,
                                assetId: ASSET_ID,
                                versionId: VERSION_ID,
                                relationships: [
                                    relationship("CLAUDE_CODE_CLI", "already_usable"),
                                    relationship("OPENCODE_CLI", "different"),
                                    relationship("CODEX_CLI", "unknown"),
                                    relationship("ZCODE_APP", "different", "applied"),
                                ],
                            },
                        },
                    ],
                },
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                onPrepare,
                onOpenUsage,
            }),
        );

        expect(screen.getByText("Already available").closest("li")?.hidden).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Already usable (1)" }));
        expect(screen.getByText("Already available").closest("li")?.hidden).toBe(false);
        expect(screen.getByText("Could not confirm")).toBeTruthy();
        expect(screen.getByText("Managed files changed")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Preview files to add" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Review existing content and differences" }));
        expect(onPrepare).toHaveBeenCalledOnce();
        expect(onPrepare).toHaveBeenCalledWith(target, "OPENCODE_CLI");
        fireEvent.click(screen.getByRole("button", { name: "View usage" }));
        expect(onOpenUsage).toHaveBeenCalledWith(target, DEPLOYMENT_ID);
    });

    it("groups exact relationships by tool or location and discloses each compact group", () => {
        const firstTarget: DeploymentTargetView = {
            key: "claude-target",
            probeToken: "probe",
            probeResultRowId: "claude-result",
            targetRowId: "claude-target-row",
            targetCandidateId: "claude-target",
            adapterId: "CLAUDECODE",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [],
            readyAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            unavailableAgentRuntimeIds: [],
        };
        const secondTarget: DeploymentTargetView = {
            ...firstTarget,
            key: "opencode-target",
            probeResultRowId: "opencode-result",
            targetRowId: "opencode-target-row",
            targetCandidateId: "opencode-target",
            adapterId: "OPENCODE",
            readyAgentRuntimeIds: ["OPENCODE_CLI"],
        };
        const usage: AssetUsageAnalysisState = {
            status: "ready",
            requestKey: "grouped-usage",
            targets: [
                {
                    targetKey: firstTarget.key,
                    status: "ready",
                    usage: completeAssetUsage({
                        probeToken: "probe",
                        probeResultRowId: "claude-result",
                        targetRowId: "claude-target-row",
                        subject: { subjectKind: "project", projectId: PROJECT_ID },
                        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
                    }).value,
                },
                {
                    targetKey: secondTarget.key,
                    status: "ready",
                    usage: completeAssetUsage({
                        probeToken: "probe",
                        probeResultRowId: "opencode-result",
                        targetRowId: "opencode-target-row",
                        subject: { subjectKind: "project", projectId: PROJECT_ID },
                        consumerAgentRuntimeIds: ["OPENCODE_CLI"],
                        asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
                    }).value,
                },
            ],
        };

        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: readyObservations([firstTarget, secondTarget]),
                usage,
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        const panel = container.querySelector<HTMLElement>("[data-oaam-asset-usage-view]");
        expect(panel?.dataset.oaamAssetUsageView).toBe("adapter");
        expect(container.querySelectorAll(".asset-usage-group")).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: "By location" }));
        expect(panel?.dataset.oaamAssetUsageView).toBe("project");
        expect(container.querySelectorAll(".asset-usage-group")).toHaveLength(1);
        expect(container.querySelectorAll(".asset-usage-row")).toHaveLength(2);
        const group = container.querySelector<HTMLElement>(".asset-usage-group");
        const summary = group?.querySelector<HTMLButtonElement>(".asset-usage-group-summary");
        expect(group?.dataset.oaamGroupCollapsedSummary).toBe("false");
        expect(group?.dataset.oaamGroupOpen).toBe("true");
        if (summary === null || summary === undefined) throw new Error("group summary is required");
        expect(screen.getByText("2 tool entries checked · 2 available")).toBeTruthy();
        fireEvent.click(summary);
        expect(group?.dataset.oaamGroupOpen).toBe("false");
        expect(container.querySelectorAll(".asset-usage-row")).toHaveLength(0);
        fireEvent.click(summary);
        expect(group?.dataset.oaamGroupOpen).toBe("true");
        expect(container.querySelectorAll(".asset-usage-row")).toHaveLength(2);
    });

    it("keeps an anomalous exact-runtime group expanded with its checked path, failure stage, reason, and action", () => {
        const target: DeploymentTargetView = {
            key: "claude-target",
            probeToken: "probe",
            probeResultRowId: "claude-result",
            targetRowId: "claude-target-row",
            targetCandidateId: "claude-target",
            adapterId: "CLAUDECODE",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [],
            readyAgentRuntimeIds: [],
            unavailableAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        };
        const base = readyObservations([target])[0];
        if (base === undefined) throw new Error("exact Claude observation is required");
        const checkedPath = "\\\\wsl.localhost\\Ubuntu\\usr\\local\\bin\\claude";
        const observation: DeploymentToolObservationView = {
            ...base,
            state: "current_observation_failed",
            reasonCodes: ["claudecode_cli_executable_discovery_incomplete"],
            checkedPaths: [checkedPath],
            diagnostics: [
                {
                    severity: "warning",
                    code: "claudecode_cli_executable_discovery_incomplete",
                    operation: "probe",
                    causeKind: "not_found",
                    retryable: false,
                    suggestedActions: ["install_runtime"],
                    message: "bounded fixture diagnostic",
                    path: checkedPath,
                },
            ],
        };

        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: [observation],
                usage: { status: "ready", requestKey: "usage-diagnostic", targets: [] },
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        const group = container.querySelector<HTMLElement>(".asset-usage-group");
        const summary = group?.querySelector(".asset-usage-group-summary");
        expect(group?.dataset.oaamAdapterId).toBe("CLAUDECODE");
        expect(group?.dataset.oaamGroupCollapsedSummary).toBe("false");
        expect(group?.dataset.oaamGroupOpen).toBe("true");
        if (summary === null || summary === undefined) throw new Error("anomalous group summary is required");
        expect(summary.tagName).toBe("BUTTON");
        expect(screen.getByText(`Checked location: ${checkedPath}`)).toBeTruthy();
        expect(screen.getByText("Failure stage: probe")).toBeTruthy();
        expect(
            screen.getByText("The command-line version of this tool was not detected. Assets already found are unaffected."),
        ).toBeTruthy();
        expect(screen.getByText("If you expected this tool here, install it or choose another tool.")).toBeTruthy();
        expect(container.querySelector('[data-oaam-diagnostic-layout="grouped"]')).toBeTruthy();
    });

    it("keeps an otherwise ready group expanded when the current observation carries a diagnostic", () => {
        const target: DeploymentTargetView = {
            key: "claude-target-ready",
            probeToken: "probe",
            probeResultRowId: "claude-result",
            targetRowId: "claude-target-row",
            targetCandidateId: "claude-target",
            adapterId: "CLAUDECODE",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [{ agentRuntimeId: "CLAUDE_CODE_CLI", runtimeRowId: "claude-runtime", versionText: "2.1.220" }],
            readyAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            unavailableAgentRuntimeIds: [],
        };
        const observation = readyObservations([target])[0];
        if (observation === undefined) throw new Error("ready observation is required");

        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: [
                    {
                        ...observation,
                        diagnostics: [
                            {
                                severity: "warning",
                                code: "claudecode_cli_executable_discovery_incomplete",
                                operation: "adapter.probe",
                                causeKind: "partial",
                                retryable: false,
                                suggestedActions: [],
                                message: "newer compatible build",
                            },
                        ],
                    },
                ],
                usage: { status: "ready", requestKey: "ready-with-warning", targets: [] },
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        const group = container.querySelector<HTMLElement>(".asset-usage-group");
        expect(group?.dataset.oaamGroupCollapsedSummary).toBe("false");
        expect(group?.dataset.oaamGroupOpen).toBe("true");
        expect(screen.getByText("Failure stage: adapter.probe")).toBeTruthy();
        expect(container.querySelector('[data-oaam-diagnostic-layout="grouped"]')).toBeTruthy();
    });

    it("keeps a missing exact-runtime result distinct from an unsupported relationship", () => {
        const target: DeploymentTargetView = {
            key: "claude-target",
            probeToken: "probe",
            probeResultRowId: "claude-result",
            targetRowId: "claude-target-row",
            targetCandidateId: "claude-target",
            adapterId: "CLAUDECODE",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [],
            readyAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            unavailableAgentRuntimeIds: [],
        };

        renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: readyObservations([target]),
                usage: {
                    status: "ready",
                    requestKey: "usage-missing-runtime",
                    targets: [
                        {
                            targetKey: target.key,
                            status: "ready",
                            usage: {
                                schemaVersion: 2,
                                assetId: "22222222-2222-4222-8222-222222222222",
                                versionId: "33333333-3333-4333-8333-333333333333",
                                relationships: [],
                            },
                        },
                    ],
                },
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        expect(screen.getByText("Could not verify")).toBeTruthy();
        expect(
            screen.getByText(
                "OAAM could not verify how this Asset can be used here. Review the check details before retrying or choosing another location.",
            ),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Preview files to add" })).toBeNull();
    });

    it("shows an honest in-progress row beside a completed target", () => {
        const completedTarget: DeploymentTargetView = {
            key: "claude-target",
            probeToken: "probe",
            probeResultRowId: "claude-result",
            targetRowId: "claude-target-row",
            targetCandidateId: "claude-target",
            adapterId: "CLAUDECODE",
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetKind: "project",
            displayName: "Current project",
            displayPath: "/workspace/project",
            runtimeIdentities: [],
            readyAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            unavailableAgentRuntimeIds: [],
        };
        const pendingTarget: DeploymentTargetView = {
            ...completedTarget,
            key: "opencode-target",
            probeResultRowId: "opencode-result",
            targetRowId: "opencode-target-row",
            targetCandidateId: "opencode-target",
            adapterId: "OPENCODE",
            readyAgentRuntimeIds: ["OPENCODE_CLI"],
        };
        const params: ProtocolOperationParams<"asset_usage.analyze"> = {
            probeToken: "probe-token",
            probeResultRowId: "claude-result",
            targetRowId: "claude-target-row",
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        };

        const { container } = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: readyObservations([completedTarget, pendingTarget]),
                usage: {
                    status: "loading",
                    requestKey: "usage-progress",
                    completedCount: 1,
                    totalCount: 2,
                    targets: [{ targetKey: completedTarget.key, status: "ready", usage: completeAssetUsage(params).value }],
                },
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
        );

        expect(container.querySelector('[data-oaam-group-collapsed-summary="true"]')).toBeNull();

        expect(screen.getByText("Checking found tools (1/2)…")).toBeTruthy();
        expect(screen.getByText("Not added yet")).toBeTruthy();
        expect(screen.getByText("Checking")).toBeTruthy();
        expect(screen.getByText("OAAM is checking this exact tool location.")).toBeTruthy();
        expect(screen.getByRole("status").querySelector("[data-oaam-loading-indicator]")).toBeTruthy();
    });
});
