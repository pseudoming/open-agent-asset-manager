import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { cleanup } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
} from "../src/presentation/presentation-preferences";
import { CatalogDeploymentOperationNotices } from "../src/renderer/features/catalog-deployment/CatalogDeploymentOperationNotices";
import { localizedText, ProtocolDiagnostics } from "../src/renderer/presentation";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";

function diagnostic(message: string): ProtocolDiagnosticV1 {
    return {
        severity: "warning",
        code: "fixture.diagnostic",
        operation: "probe",
        causeKind: "partial",
        retryable: true,
        suggestedActions: [],
        message,
    };
}

afterEach(cleanup);

describe("Desktop scoped diagnostic outcomes", () => {
    it.each([
        "cursor",
        "opencode",
        "zcode",
    ])("explains %s model-invocation refusal without suggesting retries or metadata edits", (family) => {
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                diagnostics: [
                    {
                        ...diagnostic("Exact unsupported invocation cause"),
                        operation: "render",
                        causeKind: "unsupported",
                        retryable: false,
                        code: family + "_workflow_model_invocation_unsupported",
                        suggestedActions: ["retry", "edit_asset"],
                    },
                ],
            }),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).toContain("cannot preserve model-initiated Workflow invocation");
        expect(ordinary).not.toMatch(/Try again|Edit the asset|Install this tool/);
        expect(container.textContent).toContain("Exact unsupported invocation cause");
    });

    it.each([
        "same",
        "error",
        "other_tool",
        "other_path",
        "other_operation",
        "other_trace",
    ] as const)("keeps the CLI build cause unless the same exact entry already explains the missing version (%s)", (variant) => {
        const build: ProtocolDiagnosticV1 = {
            ...diagnostic("Build observation retained in technical details."),
            code: "codex_cli_target_build_evidence_unavailable",
            path: "/fixture/command",
            traceId: "current",
            severity: variant === "error" ? "error" : "warning",
        };
        const version: ProtocolDiagnosticV1 = {
            ...diagnostic("CLI version observation retained in technical details."),
            code: variant === "other_tool" ? "cursor_cli_version_not_observed" : "codex_cli_version_not_observed",
            path: variant === "other_path" ? "/fixture/other-command" : build.path,
            operation: variant === "other_operation" ? "read" : build.operation,
            traceId: variant === "other_trace" ? "other" : build.traceId,
        };
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                diagnostics: [build, version],
            }),
        );
        const ordinary = ordinarySurfaceText(container);
        const buildSummary = "OAAM could not match this tool entry to a verified version in the selected environment.";
        if (variant === "same") expect(ordinary).not.toContain(buildSummary);
        else expect(ordinary).toContain(buildSummary);
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        expect(container.textContent).toContain(build.message);
        expect(container.textContent).toContain(version.message);
    });

    it.each([
        "en",
        "de",
        "ja",
        "zh-CN",
    ] as const)("separates routine managed omissions from the actual Guidance limitation in %s", (language) => {
        const managed: ProtocolDiagnosticV1 = {
            ...diagnostic("Already managed entry detail."),
            code: "read.managed_source_entry_ignored",
            operation: "read",
            severity: "info",
            causeKind: "conflict",
            retryable: false,
            path: ".agents/skills/managed",
        };
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                diagnostics: [
                    managed,
                    { ...managed, path: ".agents/skills/managed-workflow/SKILL.md" },
                    {
                        ...diagnostic("Custom Guidance filenames are not bound."),
                        code: "codex.guidance_fallback_configuration_unknown",
                        operation: "read",
                    },
                ],
            }),
            createDesktopPresentationTestBridge(
                createDesktopPresentationSnapshot({ ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language }, [language], false),
            ),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).toContain("AGENTS.override.md");
        expect(ordinary).toContain("AGENTS.md");
        expect(ordinary).not.toMatch(/saved choice|gespeicherte Auswahl|保存済みの選択|保存的选择/u);
        expect(ordinary).not.toContain(managed.message);
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(3);
        expect(container.textContent).toContain(managed.path);
        expect(container.textContent).toContain(managed.message);
    });

    it.each([false, true])("preserves unrelated partial feedback beside a routine omission (partial=%s)", (partial) => {
        const managed: ProtocolDiagnosticV1 = {
            ...diagnostic("Managed source retained in details."),
            code: "read.managed_source_entry_ignored",
            operation: "read",
            severity: "info",
            causeKind: "conflict",
            retryable: false,
        };
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                diagnostics: [
                    managed,
                    ...(partial ? [{ ...diagnostic("An independent read is incomplete."), operation: "read" as const }] : []),
                ],
            }),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).not.toContain("OAAM already manages this entry.");
        expect(ordinary).not.toContain("A saved choice changed elsewhere.");
        expect(ordinary.includes("OAAM could not confirm every detail.")).toBe(partial);
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(partial ? 2 : 1);
        expect(container.textContent).toContain(managed.message);
    });

    it.each([
        ["antigravity_target_build_compatibility_inferred", "兼容版本规则", "partial", "render"],
        ["opencode_target_build_compatibility_inferred", "兼容版本规则", "partial", "render"],
        ["reverse_accept.exact_graph_native_input_stale", "格式对应关系", "conflict", "reverse_accept"],
        ["reverse_accept.source_native_rebase_unavailable", "原始资产格式", "unsupported", "reverse_accept"],
    ] as const)("explains %s without attributing it to a changed saved choice or partial file scan", (code, expected, causeKind, operation) => {
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                diagnostics: [
                    { ...diagnostic("Retained exact cause"), code, causeKind, operation, suggestedActions: ["retry", "skip"] },
                ],
            }),
            createDesktopPresentationTestBridge(
                createDesktopPresentationSnapshot(
                    { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language: "zh-CN" },
                    ["zh-CN"],
                    false,
                ),
            ),
        );
        expect(ordinarySurfaceText(container)).toContain(expected);
        expect(ordinarySurfaceText(container)).not.toMatch(/保存的选择|已经找到的文件|扫描|可不处理/);
        expect(container.textContent).toContain("Retained exact cause");
    });

    it.each([
        ["permission_denied", "访问权限"],
        ["blocked_managed_target", "受管理内容"],
        ["blocked_symlink_or_reparse", "符号链接"],
        ["resource_limit_exceeded", "数量上限"],
        ["busy", "正在被占用"],
        ["stale", "检查过程中发生了变化"],
        ["io_error", "确认该位置可访问"],
    ])("explains the specific target read failure %s in the ordinary result", (status, expected) => {
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                diagnostics: [
                    {
                        ...diagnostic("Retained original target failure"),
                        code: `render.target_observation_${status}`,
                        operation: "render",
                        severity: "error",
                        causeKind: "unavailable",
                    },
                ],
            }),
            createDesktopPresentationTestBridge(
                createDesktopPresentationSnapshot(
                    { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language: "zh-CN" },
                    ["zh-CN"],
                    false,
                ),
            ),
        );
        expect(ordinarySurfaceText(container)).toContain(expected);
        expect(ordinarySurfaceText(container)).not.toMatch(/保存的选择|扫描|不支持此工具/);
        expect(container.textContent).toContain("Retained original target failure");
    });

    it.each([
        ["en", false],
        ["en", true],
        ["zh-CN", false],
        ["zh-CN", true],
    ] as const)("distinguishes conversion review from verification failure in %s (failed=%s)", (language, failed) => {
        const review: ProtocolDiagnosticV1 = {
            ...diagnostic("Provider-specific conversion losses remain available for review."),
            code: "render.canonical_conversion_review_required",
            operation: "render",
            causeKind: "partial",
        };
        const failure: ProtocolDiagnosticV1 = {
            ...diagnostic("The generated graph failed the exact asset-content consistency check."),
            code: "render.native_consistency_failed",
            operation: "render",
            causeKind: "verification_failed",
            severity: "error",
        };
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                diagnostics: failed ? [review, failure] : [review],
            }),
            createDesktopPresentationTestBridge(
                createDesktopPresentationSnapshot(
                    {
                        ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                        language,
                    },
                    ["en-US"],
                    false,
                ),
            ),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary.includes(language === "en" ? "Review the conversion" : "请先审查转换内容")).toBe(!failed);
        expect(ordinary.includes(language === "en" ? "could not verify that the generated files" : "未能确认生成的文件")).toBe(
            failed,
        );
        expect(ordinary).not.toMatch(/saved choice|保存的选择|not supported by this OAAM build|尚不支持/u);
        expect(container.textContent).toContain(review.message);
        if (failed) expect(container.textContent).toContain(failure.message);
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(failed ? 2 : 1);
    });

    it("keeps a real saved-choice conflict and avoids repeating a row's explained conversion", () => {
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                operationMessage: localizedText("catalog.ui.usage.detail.transformed_absent"),
                diagnostics: [
                    {
                        ...diagnostic("Actual conversion detail"),
                        code: "render.canonical_conversion_review_required",
                        operation: "render",
                    },
                    {
                        ...diagnostic("Actual saved-choice conflict"),
                        code: "settings.changed",
                        operation: "settings",
                        causeKind: "conflict",
                    },
                ],
            }),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).not.toContain("Review the conversion and its changes before applying it.");
        expect(ordinary).toContain("A saved choice changed elsewhere.");
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
    });

    it.each([
        {
            name: "ready CLI plan",
            consumers: ["CLAUDE_CODE_CLI"],
            code: "claudecode_app_linux_not_found",
            severity: "warning",
            visible: false,
        },
        {
            name: "App consumer plan",
            consumers: ["CLAUDE_CODE_APP"],
            code: "claudecode_app_linux_not_found",
            severity: "warning",
            visible: true,
        },
        {
            name: "unprepared plan",
            consumers: undefined,
            code: "claudecode_app_linux_not_found",
            severity: "warning",
            visible: true,
        },
        {
            name: "actual error",
            consumers: ["CLAUDE_CODE_CLI"],
            code: "claudecode_app_linux_not_found",
            severity: "error",
            visible: true,
        },
        {
            name: "missing target file",
            consumers: ["CLAUDE_CODE_CLI"],
            code: "deployment.target_missing",
            severity: "warning",
            visible: true,
        },
    ] as const)("keeps unrelated optional App absence in details only for $name", ({ consumers, code, severity, visible }) => {
        const entry: ProtocolDiagnosticV1 = {
            ...diagnostic("No Claude Linux App was found in the checked installation folder"),
            code,
            severity,
            causeKind: "not_found",
            retryable: false,
            path: "/usr/lib/claude-desktop",
        };
        const { container } = renderWithPresentation(
            createElement(CatalogDeploymentOperationNotices, {
                activity: { status: "idle" },
                creation: false,
                message: localizedText("catalog.preview.ready"),
                needsSupport: false,
                requiresReconciliation: false,
                reverse: { status: "none" },
                diagnostics: [entry],
                preparedPlanConsumerAgentRuntimeIds: consumers,
            }),
        );
        const expected =
            code === "claudecode_app_linux_not_found"
                ? "Claude Code App was not found in this environment."
                : "This optional check did not find any importable Assets.";
        expect(ordinarySurfaceText(container).includes(expected)).toBe(visible);
        expect(container.textContent).toContain(entry.code);
        expect(container.textContent).toContain(entry.path);
        expect(container.textContent).toContain(entry.message);
    });

    it.each([
        ["en", "Recovery stopped to protect existing content.", "Back up and review the current files."],
        ["zh-CN", "为保护现有内容，恢复已停止。", "先备份并核对当前文件"],
        [
            "de",
            "Zum Schutz vorhandener Inhalte wurde die Wiederherstellung angehalten.",
            "Sichern und prüfen Sie die aktuellen Dateien.",
        ],
        ["ja", "既存の内容を保護するため、復旧を停止しました。", "現在のファイルをバックアップして変更を確認"],
    ] as const)("explains a third-value recovery refusal in %s without suggesting a blind retry", (language, cause, action) => {
        const entry: ProtocolDiagnosticV1 = {
            ...diagnostic("Deployment journal recovery did not reach a verified terminal state"),
            code: "blocked_by_recovery_target_changed",
            operation: "deploy",
            causeKind: "unavailable",
            suggestedActions: ["retry"],
        };
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                diagnostics: [entry],
            }),
            createDesktopPresentationTestBridge(
                createDesktopPresentationSnapshot({ ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language }, ["en-US"], false),
            ),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).toContain(cause);
        expect(ordinary).toContain(action);
        expect(ordinary).not.toContain(entry.message);
        expect(ordinary).not.toContain("Review the latest result before continuing.");
        expect(container.textContent).toContain(entry.message);
        expect(container.textContent).toContain(entry.code);
    });

    it.each([
        {
            name: "standalone partial feedback",
            owningMessage: false,
            singleItem: false,
            specificOperation: "probe",
            visible: true,
        },
        {
            name: "partial outcome without a concrete cause",
            owningMessage: true,
            singleItem: true,
            specificOperation: null,
            visible: true,
        },
        {
            name: "one-item partial with a same-operation cause",
            owningMessage: false,
            singleItem: true,
            specificOperation: "probe",
            visible: false,
        },
        {
            name: "batch partial with a same-operation cause",
            owningMessage: true,
            singleItem: false,
            specificOperation: "probe",
            visible: true,
        },
        {
            name: "partial feedback from a different operation",
            owningMessage: true,
            singleItem: true,
            specificOperation: "restore",
            visible: true,
        },
    ] as const)("retains the right explanation and raw records for $name", ({
        owningMessage,
        singleItem,
        specificOperation,
        visible,
    }) => {
        const partial = {
            ...diagnostic("Original partial probe record."),
            code: "fixture.probe_partial",
            operation: "probe" as const,
            causeKind: "partial" as const,
            suggestedActions: ["retry" as const],
        };
        const specific = {
            ...diagnostic("Original permission record."),
            code: "fixture.location_denied",
            operation: specificOperation ?? "probe",
            causeKind: "permission_denied" as const,
            suggestedActions: ["grant_permission" as const],
        };
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                operationMessage: owningMessage ? localizedText("catalog.ui.usage.detail.current_observation_failed") : undefined,
                singleItemContext: singleItem,
                diagnostics: specificOperation === null ? [partial] : [partial, specific],
            }),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary.includes("OAAM could not confirm every detail. Available files are still shown.")).toBe(visible);
        expect(ordinary).toContain("Try the scan again.");
        if (specificOperation !== null) expect(ordinary).toContain("Allow OAAM to access this location.");
        expect(ordinary).not.toContain(partial.message);
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(specificOperation === null ? 1 : 2);
        expect(container.textContent).toContain(partial.message);
        if (specificOperation !== null) expect(container.textContent).toContain(specific.message);
    });

    it.each(["path", "traceId"] as const)("preserves partial feedback when explicit %s identities conflict", (field) => {
        const partial = {
            ...diagnostic("Original first-location partial record."),
            code: "fixture.location_partial",
            operation: "read" as const,
            causeKind: "partial" as const,
            [field]: "first-location",
        };
        const specific = {
            ...partial,
            code: "fixture.location_denied",
            causeKind: "permission_denied" as const,
            [field]: "second-location",
            suggestedActions: ["grant_permission" as const],
            message: "Original other-location permission record.",
        };
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, {
                layout: "grouped",
                singleItemContext: true,
                diagnostics: [partial, specific],
            }),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).toContain("OAAM could not confirm every detail. Available files are still shown.");
        expect(ordinary).toContain("Allow OAAM to access this location.");
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
    });
});
