import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDesktopMessage } from "../src/presentation/localization";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
} from "../src/presentation/presentation-preferences";
import { DiscoveryWorkspace } from "../src/renderer/features/discovery/DiscoveryWorkspace";
import { DiscoveryController } from "../src/renderer/features/discovery/discovery-controller";
import type { ProbeReviewView } from "../src/renderer/features/discovery/discovery-model";
import { localizedText, ProtocolDiagnostics, ProtocolFeedbackNotice } from "../src/renderer/presentation";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";
import { diagnostic, fakeDiscoveryClient, PROBE, required } from "./discovery-test-fixtures";

afterEach(() => {
    cleanup();
});

describe("Desktop discovery diagnostic grouping", () => {
    it("shows equivalent translated causes once while retaining each raw code, path and trace", () => {
        const first = {
            ...diagnostic("Original file one"),
            code: "provider.first",
            causeKind: "permission_denied" as const,
            operation: "read" as const,
            path: "/one",
            traceId: "first-trace",
            suggestedActions: ["grant_permission"],
        };
        const second = { ...first, code: "provider.second", message: "Original file two", path: "/two", traceId: "second-trace" };
        const view = renderWithPresentation(createElement(ProtocolDiagnostics, { diagnostics: [first, second] }));
        expect(view.container.querySelectorAll(".protocol-diagnostic-attribution")).toHaveLength(1);
        expect(view.container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        for (const value of [first, second])
            for (const field of [value.code, value.message, value.path, value.traceId]) {
                expect(view.container.textContent).toContain(field);
            }
        view.rerender(createElement(ProtocolDiagnostics, { diagnostics: [first, { ...second, suggestedActions: ["retry"] }] }));
        expect(view.container.querySelectorAll(".protocol-diagnostic-attribution")).toHaveLength(2);
    });
    it.each([
        "same_item",
        "batch",
        "different_path",
        "different_trace",
        "different_app",
        "different_operation",
        "permission",
        "error",
    ] as const)("keeps independent App causes while collapsing only a derived build summary in %s", (context) => {
        const installation: ProtocolDiagnosticV1 = {
            ...diagnostic("Original installation observation"),
            code: "codex_app_install_environment_unobserved",
            operation: "probe",
            severity: "warning",
            causeKind: "partial",
            path: "/selected",
            traceId: "same-trace",
        };
        const build: ProtocolDiagnosticV1 = {
            ...installation,
            code: "codex_app_target_build_evidence_unavailable",
            message: "Original build observation",
            ...(context === "different_path" ? { path: "/another" } : {}),
            ...(context === "different_trace" ? { traceId: "another-trace" } : {}),
            ...(context === "different_app" ? { code: "claudecode_app_target_build_evidence_unavailable" } : {}),
            ...(context === "different_operation" ? { operation: "version" } : {}),
            ...(context === "permission" ? { causeKind: "permission_denied" } : {}),
            ...(context === "error" ? { severity: "error" } : {}),
        };
        const independent: ProtocolDiagnosticV1 = {
            ...installation,
            code: "fixture.permission",
            causeKind: "permission_denied",
            message: "Independent access failure",
        };
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                diagnostics: [installation, build, independent],
                layout: "grouped",
                singleItemContext: context !== "batch",
            }),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).toContain("OAAM could not confirm the App installation in the selected environment.");
        expect(ordinary).toContain("OAAM could not access this location.");
        const buildSummary = "OAAM could not match this tool entry to a verified version in the selected environment.";
        if (context === "same_item") expect(ordinary).not.toContain(buildSummary);
        else expect(ordinary).toContain(buildSummary);
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(3);
        for (const record of [installation, build, independent]) expect(container.textContent).toContain(record.message);
    });

    it("keeps a new source-save failure visible alongside an earlier attributed probe warning", async () => {
        const warning = { ...diagnostic("Retained probe warning"), severity: "warning" as const };
        const sourceFailure = { ...diagnostic("Current source-save failure"), causeKind: "permission_denied" as const };
        const client = fakeDiscoveryClient({
            probeGlobal: vi.fn(async () => ({
                status: "partial",
                value: {
                    ...PROBE,
                    results: PROBE.results.map((result) => ({ ...result, status: "partial" as const, diagnostics: [warning] })),
                },
                diagnostics: [warning],
            })),
            replaceWatchedScanIntent: vi.fn(async () => ({ status: "failed", diagnostics: [sourceFailure] })),
        });
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "source-failure",
            autoProbeWatched: false,
        });
        const view = renderWithPresentation(
            createElement(DiscoveryWorkspace, {
                controller,
                journey: {
                    stage: "sources",
                    readOnly: true,
                    navigationLabel: "Import",
                    onStageChange: vi.fn(),
                    onBackFromLocations: vi.fn(),
                    onNoContentFound: vi.fn(),
                    onReviewAssets: vi.fn(),
                },
            }),
        );
        await waitFor(() => expect(controller.state.status).toBe("ready"));
        await act(async () => {
            await controller.probe();
        });
        if (controller.state.status !== "ready") throw new Error("source review must be ready");
        const source = required(
            controller.state.sources.find((source) => source.displayPath === "/brand-new"),
            "source",
        );
        await act(async () => {
            await controller.saveWatchedSources([{ sourceKey: source.key, binding: { assetScope: "global" } }]);
        });
        expect(client.replaceWatchedScanIntent).toHaveBeenCalledOnce();
        expect(ordinarySurfaceText(view.container)).toContain("OAAM could not access this location.");
        expect(view.container.textContent).toContain(sourceFailure.message);
        expect(view.container.textContent).toContain(warning.message);
        expect(ordinarySurfaceText(view.container)).not.toContain(sourceFailure.message);
        controller.dispose();
    });

    it("keeps repeated path evidence behind one limitation note without suggesting a futile scan", () => {
        const first = {
            ...diagnostic("First WSL detail"),
            code: "codex_wsl_environment_unobserved",
            operation: "probe" as const,
            path: "/one",
            severity: "warning" as const,
        };
        const view = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                diagnostics: [first, { ...first, path: "/two", message: "Second WSL detail" }],
            }),
        );
        expect(view.container.querySelectorAll(".protocol-diagnostic-cause")).toHaveLength(1);
        expect(view.container.querySelector(".workbench-notice")).toBeNull();
        expect(view.container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        expect(view.container.textContent).toContain("/one");
        expect(view.container.textContent).toContain("/two");
        expect(ordinarySurfaceText(view.container)).not.toContain("Try the scan again.");
        view.rerender(
            createElement(ProtocolDiagnostics, {
                diagnostics: [
                    { ...first, code: "fixture.denied", causeKind: "permission_denied", suggestedActions: ["grant_permission"] },
                    { ...first, code: "fixture.denied", causeKind: "permission_denied", suggestedActions: ["retry"] },
                ],
            }),
        );
        expect(view.container.querySelectorAll(".workbench-notice")).toHaveLength(2);
        expect(ordinarySurfaceText(view.container)).toContain("Allow OAAM to access this location.");
        expect(ordinarySurfaceText(view.container)).toContain("Try the scan again.");
    });

    it.each([
        "en",
        "zh-CN",
        "ja",
        "de",
    ] as const)("keeps operation-specific recovery copy and one technical disclosure for unspecified causes in %s", (language) => {
        const snapshot = createDesktopPresentationSnapshot(
            { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language },
            [language],
            false,
        );
        for (const [operation, messageId] of [
            ["project", "project_lifecycle.inspect_failed"],
            ["restore", "state_resilience.restore.activate_failed"],
            ["host", "diagnostics.support.inspect_failed"],
        ] as const) {
            const first = {
                ...diagnostic("First unspecified operation failure."),
                operation,
                code: "fixture.unspecified_failure",
                causeKind: "internal_error" as const,
            };
            const second = { ...first, code: "fixture.other_failure", message: "Second original failure." };
            const view = renderWithPresentation(
                createElement(ProtocolFeedbackNotice, {
                    message: localizedText(messageId),
                    diagnostics: [first, second],
                    tone: "danger",
                }),
                createDesktopPresentationTestBridge(snapshot),
            );
            const alert = screen.getByRole("alert");
            expect(ordinarySurfaceText(alert)).toContain(formatDesktopMessage(snapshot, messageId));
            expect(ordinarySurfaceText(alert)).not.toContain(
                formatDesktopMessage(snapshot, "discovery.product.diagnostic.internal_error"),
            );
            expect(ordinarySurfaceText(alert)).not.toContain(
                formatDesktopMessage(snapshot, "discovery.product.action.review_again"),
            );
            expect(alert.querySelector(".protocol-diagnostic-attribution")).toBeNull();
            expect(alert.querySelector(".protocol-diagnostic-summary-list")).toBeNull();
            expect(alert.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
            expect(alert.querySelectorAll("details")).toHaveLength(1);
            const disclosure = alert.querySelector("details");
            const trigger = alert.querySelector("summary");
            if (disclosure === null || trigger === null) throw new Error("diagnostic disclosure is missing");
            fireEvent.click(trigger);
            expect(disclosure.open).toBe(true);
            expect(disclosure.textContent).toContain(first.message);
            expect(disclosure.textContent).toContain(second.message);
            view.unmount();
        }
    });

    it("retains a specific cause and actionable permission advice beside the operation outcome", () => {
        const failure = {
            ...diagnostic("Original permission failure."),
            operation: "project" as const,
            code: "project.root_permission_denied",
            causeKind: "permission_denied" as const,
            suggestedActions: ["grant_permission"],
        };
        const view = renderWithPresentation(
            createElement(ProtocolFeedbackNotice, {
                message: localizedText("project_lifecycle.inspect_failed"),
                diagnostics: [failure],
                tone: "danger",
            }),
        );
        const ordinary = ordinarySurfaceText(view.container);
        expect(ordinary).toContain("OAAM cannot access this Project folder.");
        expect(view.container.querySelectorAll(".protocol-diagnostic-summary-list li")).toHaveLength(1);
        expect(view.container.querySelector(".protocol-diagnostic-summary-list small")?.textContent).toBe(
            "Allow OAAM to access this location.",
        );
        expect(ordinary).not.toContain("scan again");
        expect(ordinary).not.toContain(failure.message);
        expect(view.container.textContent).toContain(failure.message);
    });

    it.each([
        "en",
        "zh-CN",
        "ja",
        "de",
    ] as const)("keeps one scan-failure sentence with its retry and both raw verification records in %s", (language) => {
        const snapshot = createDesktopPresentationSnapshot(
            { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language },
            [language],
            false,
        );
        const first = {
            ...diagnostic("First original scan failure."),
            operation: "scan" as const,
            causeKind: "verification_failed" as const,
            code: "fixture.scan_failed",
            suggestedActions: ["retry"],
        };
        const view = renderWithPresentation(
            createElement(ProtocolFeedbackNotice, {
                message: localizedText("catalog.operation.failed", { operation: localizedText("catalog.activity.scan") }),
                diagnostics: [first, { ...first, code: "fixture.second_scan_failure", message: "Second scan failure." }],
                tone: "danger",
            }),
            createDesktopPresentationTestBridge(snapshot),
        );
        const alert = screen.getByRole("alert");
        const result = formatDesktopMessage(snapshot, "catalog.operation.failed", {
            operation: formatDesktopMessage(snapshot, "catalog.activity.scan"),
        });
        expect(alert.querySelector(".workbench-technical-fact-owner > p")?.textContent).toBe(
            `${result} ${formatDesktopMessage(snapshot, "discovery.product.action.retry")}`,
        );
        expect(alert.querySelector(".protocol-diagnostic-summary-list")).toBeNull();
        expect(ordinarySurfaceText(alert)).not.toContain(
            formatDesktopMessage(snapshot, "discovery.product.diagnostic.verification_failed"),
        );
        const disclosure = required(alert.querySelector("details"), "scan failure details");
        fireEvent.click(required(disclosure.querySelector("summary"), "scan failure disclosure"));
        expect(disclosure.open).toBe(true);
        expect(disclosure.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        expect(disclosure.textContent).toContain(first.message);
        expect(disclosure.textContent).toContain("Second scan failure.");
        view.unmount();
    });

    it("keeps a concrete cause and shows its shared retry only once", () => {
        const generic = {
            ...diagnostic("Unspecified scan failure."),
            operation: "scan" as const,
            causeKind: "verification_failed" as const,
            suggestedActions: ["retry"],
        };
        const view = renderWithPresentation(
            createElement(ProtocolFeedbackNotice, {
                message: localizedText("catalog.operation.failed", { operation: localizedText("catalog.activity.scan") }),
                diagnostics: [generic, { ...generic, code: "fixture.denied", causeKind: "permission_denied" }],
                tone: "danger",
            }),
        );
        expect(view.container.querySelectorAll(".protocol-diagnostic-summary-list li")).toHaveLength(1);
        expect(ordinarySurfaceText(view.container).split("Try the scan again.")).toHaveLength(2);
        expect(view.container.querySelector(".protocol-diagnostic-summary-list")?.textContent).toContain(
            "OAAM could not access this location.",
        );
    });

    it("keeps standalone diagnostics explanatory when no owning operation message is present", () => {
        const view = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                diagnostics: [{ ...diagnostic("Original failure."), causeKind: "internal_error" }],
                layout: "grouped",
            }),
        );
        expect(ordinarySurfaceText(view.container)).toContain("OAAM could not finish checking this item.");
        expect(view.container.querySelector(".protocol-diagnostic-attribution")).not.toBeNull();
    });

    it("keeps an operation failure and all of its causes in one alert without suggesting an unrelated scan", () => {
        const first = { ...diagnostic("First original Project failure."), operation: "project" as const };
        const second = { ...first, message: "Second original Project failure." };
        const view = renderWithPresentation(
            createElement(ProtocolFeedbackNotice, {
                message: localizedText("project_lifecycle.inspect_failed"),
                diagnostics: [first, second],
                tone: "danger",
            }),
        );
        expect(view.container.querySelectorAll(".workbench-notice")).toHaveLength(1);
        expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
        expect(view.container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        expect(view.container.querySelector(".workbench-notice .workbench-notice")).toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("Try the scan again.");
        expect(ordinarySurfaceText(view.container)).not.toContain(first.message);
        expect(view.container.textContent).toContain(first.message);
        expect(view.container.textContent).toContain(second.message);
    });

    it("renders ordinary successful feedback as local status text without another notice box", () => {
        const view = renderWithPresentation(
            createElement(ProtocolFeedbackNotice, {
                message: localizedText("diagnostics.log.saved"),
                diagnostics: [],
            }),
        );
        expect(view.container.querySelector('[role="status"]')?.textContent).toContain("saved");
        expect(view.container.querySelector(".workbench-notice")).toBeNull();
    });

    it("groups repeated scan diagnostics under their exact tool while retaining every raw technical record", async () => {
        const firstDiagnostic = diagnostic("First raw scan detail.");
        const secondDiagnostic = diagnostic("Second raw scan detail.");
        const partialProbe: ProbeReviewView = {
            ...PROBE,
            results: PROBE.results.map((result) => ({
                ...result,
                status: "partial" as const,
                diagnostics: [firstDiagnostic, secondDiagnostic],
            })),
        };
        const controller = new DiscoveryController(
            fakeDiscoveryClient({
                probeGlobal: vi.fn(async () => ({
                    status: "partial",
                    value: partialProbe,
                    diagnostics: [firstDiagnostic, secondDiagnostic],
                })),
            }),
            { createUserActionId: () => "action", autoProbeWatched: false },
        );
        const { container } = renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: vi.fn() }));
        fireEvent.click(await screen.findByRole("button", { name: "Scan now" }));

        await vi.waitFor(() => expect(container.querySelectorAll(".discovery-probe-issue")).toHaveLength(1));
        const grouped = required(container.querySelector<HTMLElement>(".discovery-probe-issue"), "tool-owned diagnostic group");
        expect(grouped.dataset.oaamEnvironmentIdentity).toBe(JSON.stringify(["linux", "local"]));
        expect(grouped.dataset.oaamAdapterId).toBe("CLAUDECODE");
        expect(grouped.querySelectorAll(".discovery-probe-issue-paths > li")).toHaveLength(1);
        expect(required(grouped.querySelector(".discovery-probe-issue-owner"), "diagnostic owner").textContent).toContain(
            "Claude Code · Local Linux",
        );
        const technicalRecords = grouped.querySelectorAll(".protocol-technical-record");
        expect(technicalRecords).toHaveLength(2);
        expect(technicalRecords[0]?.textContent).toContain(firstDiagnostic.message);
        expect(technicalRecords[1]?.textContent).toContain(secondDiagnostic.message);
        expect(ordinarySurfaceText(container)).not.toContain(firstDiagnostic.message);
        expect(ordinarySurfaceText(container)).not.toContain(secondDiagnostic.message);
    });
});
