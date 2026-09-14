import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryProbeIssues, DiscoveryResults } from "../src/renderer/features/discovery/DiscoveryResults";
import { toggleFirstInteractionDisclosure, toggleInteractionDisclosure } from "./desktop-interaction-test-harness";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { ENVIRONMENT, PROVIDERS, required } from "./discovery-test-fixtures";

afterEach(() => {
    cleanup();
});

describe("Desktop discovery result summary", () => {
    it("groups a repeated cause across paths without merging distinct recovery actions or leaving stale keyed rows", () => {
        const issue: ProtocolDiagnosticV1 = {
            severity: "warning",
            code: "fixture.location",
            operation: "probe",
            causeKind: "permission_denied",
            retryable: true,
            suggestedActions: ["retry"],
            message: "First original detail",
            path: "/project/one",
        };
        const second = { ...issue, path: "/project/two", message: "Second original detail" };
        const permission = { ...issue, suggestedActions: ["grant_permission"], message: "Permission original detail" };
        const props = (diagnostics: readonly ProtocolDiagnosticV1[]) => ({
            providers: PROVIDERS,
            outcomes: [
                {
                    environment: ENVIRONMENT,
                    tools: [
                        {
                            adapterId: "CLAUDECODE",
                            status: "partial" as const,
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            versionTexts: [],
                            installationStatus: "available" as const,
                            diagnostics,
                            unscopedDiagnostics: diagnostics,
                            runtimeOutcomes: [],
                        },
                    ],
                },
            ],
        });
        const view = renderWithPresentation(createElement(DiscoveryProbeIssues, props([issue, issue, second, permission])));
        const paths = () => view.container.querySelector(".discovery-probe-issue-paths");
        expect(paths()?.querySelectorAll("li")).toHaveLength(3);
        expect(paths()?.textContent?.split("Try the scan again.")).toHaveLength(2);
        expect(paths()?.textContent).toContain("Allow OAAM to access this location.");
        expect(paths()?.querySelectorAll("code")).toHaveLength(3);
        expect(view.container.querySelectorAll(".protocol-technical-record")).toHaveLength(3);
        view.rerender(
            createElement(
                DiscoveryProbeIssues,
                props([
                    issue,
                    { ...issue, code: "codex_cli_executable_denied", message: "Same visible cause, different technical subject" },
                ]),
            ),
        );
        expect(paths()?.querySelectorAll("li")).toHaveLength(1);
        expect(view.container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        view.rerender(createElement(DiscoveryProbeIssues, props([issue, issue, second, permission])));
        const ordinaryIssue = paths()?.querySelector("li");
        const technicalDetails = view.container.querySelector(".discovery-technical-disclosure");
        expect(
            ordinaryIssue === null || ordinaryIssue === undefined || technicalDetails === null
                ? 0
                : ordinaryIssue.compareDocumentPosition(technicalDetails) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).not.toBe(0);
        view.rerender(createElement(DiscoveryProbeIssues, props([permission, second, issue])));
        expect(paths()?.querySelectorAll("li")).toHaveLength(3);
        view.rerender(createElement(DiscoveryProbeIssues, props([issue, second])));
        expect(paths()?.querySelectorAll("li")).toHaveLength(2);
        expect(paths()?.textContent).not.toContain("Allow OAAM to access this location.");
        expect(paths()?.textContent?.split("OAAM could not access this location.")).toHaveLength(2);
        expect(view.container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
    });

    it("keeps an App-only warning under its sibling tool entry instead of attributing it to a successful CLI", () => {
        const appWarning: ProtocolDiagnosticV1 = {
            severity: "warning",
            code: "claudecode_app_install_environment_unobserved",
            operation: "probe",
            causeKind: "partial",
            retryable: true,
            suggestedActions: ["retry"],
            message: "Raw App-only observation warning",
        };
        const view = renderWithPresentation(
            createElement(DiscoveryResults, {
                completedAt: undefined,
                outcomes: [
                    {
                        environment: ENVIRONMENT,
                        status: "partial",
                        tools: [
                            {
                                adapterId: "CLAUDECODE",
                                status: "partial",
                                agentRuntimeIds: ["CLAUDE_CODE_CLI", "CLAUDE_CODE_APP"],
                                versionTexts: ["2.1"],
                                installationStatus: "available",
                                diagnostics: [appWarning],
                                unscopedDiagnostics: [],
                                runtimeOutcomes: [
                                    {
                                        agentRuntimeId: "CLAUDE_CODE_CLI",
                                        versionText: "2.1",
                                        installationStatus: "available",
                                        diagnostics: [],
                                    },
                                    {
                                        agentRuntimeId: "CLAUDE_CODE_APP",
                                        versionText: "",
                                        installationStatus: "unknown",
                                        diagnostics: [appWarning],
                                    },
                                ],
                            },
                        ],
                    },
                ],
                providers: PROVIDERS,
                sourceCount: 0,
            }),
        );
        toggleFirstInteractionDisclosure("features.discovery.discovery_results.004", view.container);

        const appScope = view.container.querySelector('[data-oaam-agent-runtime-id="CLAUDE_CODE_APP"]');
        expect(appScope?.textContent).toContain("Claude Code App");
        expect(appScope?.textContent).toContain("Tool entry");
        expect(appScope?.textContent).toContain("Could not confirm installation");
        const cliScope = view.container.querySelector('[data-oaam-agent-runtime-id="CLAUDE_CODE_CLI"]');
        expect(cliScope?.textContent).toContain("Claude Code CLI");
        expect(cliScope?.textContent).toContain("Ready to scan");
        expect(cliScope?.textContent).not.toContain("Raw App-only observation warning");
        expect(appScope?.textContent).not.toContain("Claude Code CLI");
    });

    it("counts each tool once when the same tools are checked in several selected locations", () => {
        const claudeCode = {
            adapterId: "CLAUDECODE",
            status: "complete" as const,
            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
            versionTexts: ["2.1"],
            installationStatus: "available" as const,
            diagnostics: [],
            unscopedDiagnostics: [],
            runtimeOutcomes: [],
        };
        const openCode = {
            adapterId: "OPENCODE",
            status: "partial" as const,
            agentRuntimeIds: ["OPENCODE_CLI"],
            versionTexts: ["1.0"],
            installationStatus: "unknown" as const,
            diagnostics: [],
            unscopedDiagnostics: [],
            runtimeOutcomes: [],
        };
        const view = renderWithPresentation(
            createElement(DiscoveryResults, {
                completedAt: undefined,
                outcomes: [
                    {
                        environment: ENVIRONMENT,
                        status: "complete",
                        tools: [claudeCode, openCode],
                    },
                    {
                        environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                        status: "partial",
                        tools: [{ ...claudeCode, status: "partial" as const }, openCode],
                    },
                ],
                providers: PROVIDERS,
                sourceCount: 5,
            }),
        );

        expect(screen.getByText("2 tools checked · 5 source locations · 2 locations")).not.toBeNull();
        expect(
            screen.getByRole("region", { name: "Scan results by location" }).querySelector(".discovery-snapshot-summary"),
        ).toMatchObject({
            dataset: expect.objectContaining({
                oaamDiscoveryLocationCount: "2",
                oaamDiscoveryToolCount: "2",
            }),
        });
        toggleFirstInteractionDisclosure("features.discovery.discovery_results.004", view.container);
        toggleFirstInteractionDisclosure("features.discovery.discovery_results.005", view.container);

        view.rerender(
            createElement(DiscoveryResults, {
                completedAt: undefined,
                outcomes: [
                    {
                        environment: ENVIRONMENT,
                        status: "partial",
                        tools: [claudeCode, openCode],
                    },
                ],
                providers: PROVIDERS,
                showEnvironmentDetails: false,
                sourceCount: 5,
            }),
        );
        expect(screen.getByText("2 tools checked · 5 source locations · 1 locations")).not.toBeNull();
        expect(view.container.querySelector(".environment-result-list")).toBeNull();
        expect(screen.getByText("Partially checked").getAttribute("data-oaam-scan-notes")).toBe("true");
    });

    it("de-emphasizes scan notes, projects WSL file paths natively, and keeps environment checks pathless", async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
        const view = renderWithPresentation(
            createElement(DiscoveryProbeIssues, {
                outcomes: [
                    {
                        environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                        status: "partial",
                        tools: [
                            {
                                adapterId: "CLAUDECODE",
                                status: "partial",
                                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                                versionTexts: ["2.1"],
                                installationStatus: "available",
                                diagnostics: [
                                    {
                                        severity: "warning",
                                        code: "first_internal_invalid_project_record",
                                        operation: "probe",
                                        causeKind: "invalid_schema",
                                        retryable: false,
                                        suggestedActions: ["skip"],
                                        message: "raw incomplete registry evidence",
                                        path: "\\\\wsl.localhost\\Ubuntu\\home\\user\\.gemini\\config\\projects\\incomplete.json",
                                    },
                                    {
                                        severity: "warning",
                                        code: "antigravity_wsl_environment_unobserved",
                                        operation: "probe",
                                        causeKind: "partial",
                                        retryable: false,
                                        suggestedActions: [],
                                        message: "raw WSL environment evidence",
                                        path: "\\\\wsl.localhost\\Ubuntu\\",
                                    },
                                    {
                                        severity: "warning",
                                        code: "different_internal_code_same_public_result",
                                        operation: "probe",
                                        causeKind: "invalid_schema",
                                        retryable: false,
                                        suggestedActions: ["skip"],
                                        message: "a second internal record for the same visible issue",
                                        path: "\\\\wsl.localhost\\Ubuntu\\home\\user\\.gemini\\config\\projects\\incomplete.json",
                                    },
                                ],
                                unscopedDiagnostics: [
                                    {
                                        severity: "warning",
                                        code: "first_internal_invalid_project_record",
                                        operation: "probe",
                                        causeKind: "invalid_schema",
                                        retryable: false,
                                        suggestedActions: ["skip"],
                                        message: "raw incomplete registry evidence",
                                        path: "\\\\wsl.localhost\\Ubuntu\\home\\user\\.gemini\\config\\projects\\incomplete.json",
                                    },
                                    {
                                        severity: "warning",
                                        code: "antigravity_wsl_environment_unobserved",
                                        operation: "probe",
                                        causeKind: "partial",
                                        retryable: false,
                                        suggestedActions: [],
                                        message: "raw WSL environment evidence",
                                        path: "\\\\wsl.localhost\\Ubuntu\\",
                                    },
                                    {
                                        severity: "warning",
                                        code: "different_internal_code_same_public_result",
                                        operation: "probe",
                                        causeKind: "invalid_schema",
                                        retryable: false,
                                        suggestedActions: ["skip"],
                                        message: "a second internal record for the same visible issue",
                                        path: "\\\\wsl.localhost\\Ubuntu\\home\\user\\.gemini\\config\\projects\\incomplete.json",
                                    },
                                ],
                                runtimeOutcomes: [],
                            },
                        ],
                    },
                ],
                providers: PROVIDERS,
            }),
        );

        const issues = screen.getByRole("region", { name: "Scan notes" });
        expect(issues.getAttribute("data-oaam-probe-issue-count")).toBe("2");
        expect(issues.hasAttribute("open")).toBe(false);
        expect(within(issues).getByText("Scan notes · 2")).not.toBeNull();
        expect(within(issues).getByText("This file is incomplete or not yet importable, so it was skipped.")).not.toBeNull();
        expect(within(issues).getAllByText("You can leave this item out.")).toHaveLength(1);
        expect(within(issues).queryByText("Overall scan")).toBeNull();
        expect(
            within(issues).getByText(
                "Custom command and configuration locations set inside WSL were not observed from Windows. Results from checked locations remain available.",
            ),
        ).not.toBeNull();
        expect(within(issues).getByText("WSL environment")).not.toBeNull();
        expect(within(issues).queryByText("Selected location")).toBeNull();
        expect(issues.querySelector('[data-oaam-diagnostic-path="overall"] code')).toBeNull();
        const path = "/home/user/.gemini/config/projects/incomplete.json";
        expect(within(issues).getByTitle(path)).not.toBeNull();
        fireEvent.click(within(issues).getByRole("button", { name: "Copy path" }));
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
        const copiedButton = await within(issues).findByRole("button", { name: "Path copied" });
        writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
        fireEvent.click(copiedButton);
        expect(await within(issues).findByRole("button", { name: "Path could not be copied" })).not.toBeNull();
        expect(issues.querySelectorAll(".protocol-technical-record")).toHaveLength(3);
        expect(issues.querySelector(".protocol-technical-record code + code")?.textContent).toContain("\\\\wsl.localhost");
        const technical = required(within(issues).getByText("Technical details").closest("details"), "technical details");
        expect(technical.closest(".workbench-technical-fact")?.classList.contains("discovery-probe-issue-owner")).toBe(true);
        toggleInteractionDisclosure("features.discovery.discovery_results.001", view.container);
        toggleInteractionDisclosure("features.discovery.discovery_results.003", view.container);
    });
});
