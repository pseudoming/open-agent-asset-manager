import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { cleanup } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDesktopMessage } from "../src/presentation/localization";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
} from "../src/presentation/presentation-preferences";
import { CatalogAssetUsageRelationships } from "../src/renderer/features/catalog-deployment/CatalogAssetUsageRelationships";
import { CatalogDeploymentOutcomeSummary } from "../src/renderer/features/catalog-deployment/CatalogDeploymentOutcomeSummary";
import { inspectionDetailLabel } from "../src/renderer/features/catalog-deployment/CatalogInspectionDetail";
import type { DeploymentToolObservationView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { ProtocolDiagnostics } from "../src/renderer/presentation/ProtocolDiagnostics";
import { DEPLOYMENT_PROVIDERS } from "./catalog-deployment-test-fixtures";
import { ASSET, ASSET_ID, deployment, readyState } from "./catalog-deployment-test-support";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";

afterEach(cleanup);

describe("Ordinary catalog review labels", () => {
    it.each([
        "en",
        "zh-CN",
        "ja",
        "de",
    ] as const)("keeps failed Global checks context-neutral and deduplicates only identical actions in %s", (language) => {
        const snapshot = createDesktopPresentationSnapshot(
            { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language },
            [language],
            false,
        );
        const diagnostics: readonly ProtocolDiagnosticV1[] = [
            "codex_app_install_environment_unobserved",
            "codex_app_target_build_evidence_unavailable",
            "native_guidance_runtime_unavailable",
        ].map((code, index) => ({
            code,
            severity: "warning",
            operation: "render",
            causeKind: code === "native_guidance_runtime_unavailable" ? "unavailable" : "partial",
            retryable: true,
            suggestedActions: ["retry"],
            message: `Exact raw detail ${index}`,
            path: `/exact/location/${index}`,
        }));
        const { container } = renderWithPresentation(
            createElement(ProtocolDiagnostics, { diagnostics, layout: "grouped" }),
            createDesktopPresentationTestBridge(snapshot),
        );
        const summaries = container.querySelectorAll(".protocol-diagnostic-summary-list > li");
        expect(summaries).toHaveLength(3);
        expect(container.querySelectorAll(".protocol-diagnostic-summary-list small")).toHaveLength(1);
        expect(summaries[0]?.querySelector("small")).toBeNull();
        expect(summaries[1]?.querySelector("small")).toBeNull();
        expect(summaries[2]?.textContent).toContain(
            formatDesktopMessage(snapshot, "discovery.product.diagnostic.runtime_context_unavailable"),
        );
        const ordinary = ordinarySurfaceText(container);
        expect(ordinary).not.toMatch(/Project|Projekt|项目|プロジェクト/);
        expect(ordinary).not.toContain("Exact raw detail");
        expect(ordinary).not.toContain("/exact/location");
        expect(container.querySelectorAll(".protocol-technical-record")).toHaveLength(3);
        for (const diagnostic of diagnostics) {
            expect(container.textContent).toContain(diagnostic.code);
            expect(container.textContent).toContain(diagnostic.message);
            expect(container.textContent).toContain(diagnostic.path);
        }
        expect(formatDesktopMessage(snapshot, "catalog.ui.usage.detail.unsupported")).not.toMatch(
            /Project|Projekt|项目|プロジェクト/,
        );
        expect(formatDesktopMessage(snapshot, "discovery.product.diagnostic.verification_failed")).not.toMatch(
            /import|导入|インポート/i,
        );
    });

    it.each([
        "en",
        "zh-CN",
        "ja",
        "de",
    ] as const)("keeps selected Version IDs technical and names every grouped Environment in %s", (language) => {
        const snapshot = createDesktopPresentationSnapshot(
            { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language },
            [language],
            false,
        );
        const bridge = createDesktopPresentationTestBridge(snapshot);
        const selectedVersion = "99999999-9999-4999-8999-999999999999";
        const fileNamedAsset = { ...ASSET, displayName: "CLAUDE.md" };
        const selectedDeployment = {
            ...deployment(),
            assets: [{ assetId: ASSET_ID, versionId: selectedVersion, allowIncomplete: false }],
        };
        const state = readyState({
            assets: [fileNamedAsset],
            deployments: [selectedDeployment],
            completedMutation: {
                kind: "deploy",
                deploymentId: selectedDeployment.deploymentId,
                reviewedFilePaths: ["CLAUDE.md"],
            },
        });
        const result = renderWithPresentation(
            createElement(CatalogDeploymentOutcomeSummary, {
                state,
                providers: DEPLOYMENT_PROVIDERS,
                selectedDeployment,
                selectedDeploymentTarget: undefined,
                selectedCreationAsset: fileNamedAsset,
                selectedReverse: { status: "none" },
                completedMutationIsCurrent: true,
                canRecover: false,
                canCheckNow: true,
                canInspect: false,
            }),
            bridge,
        );
        const ordinaryResult = ordinarySurfaceText(result.container);
        expect(ordinaryResult).toContain(
            formatDesktopMessage(snapshot, "catalog.ui.outcome.asset_version", {
                version: formatDesktopMessage(snapshot, "catalog.ui.outcome.selected_version"),
            }),
        );
        expect(ordinaryResult).not.toContain(selectedVersion);
        expect(ordinaryResult.match(/CLAUDE\.md/gu)).toHaveLength(1);
        expect(result.container.querySelector("#deployment-outcome-title")?.textContent).toBe(
            formatDesktopMessage(snapshot, "catalog.ui.create.applied_title"),
        );
        expect(result.container.querySelector("[data-oaam-result-next-action]")).toBeNull();
        expect(ordinaryResult).not.toContain(
            formatDesktopMessage(snapshot, "catalog.ui.create.asset_revision", {
                asset: ASSET.displayName,
                revision: ASSET.currentRevision,
            }),
        );
        expect(
            result.container.querySelector("[data-oaam-result-version-ids]")?.getAttribute("data-oaam-result-version-ids"),
        ).toBe(JSON.stringify([selectedVersion]));
        result.unmount();

        const observation: DeploymentToolObservationView = {
            key: "windows",
            adapterId: "CLAUDECODE",
            agentRuntimeId: "CLAUDE_CODE_CLI",
            versionText: "",
            platform: "win32",
            platformInstanceId: "desktop-local",
            state: "not_installed",
            reasonCodes: [],
            diagnostics: [],
            checkedPaths: [],
            target: undefined,
        };
        const relationships = renderWithPresentation(
            createElement(CatalogAssetUsageRelationships, {
                observations: [observation, { ...observation, key: "ubuntu", platform: "wsl", platformInstanceId: "Ubuntu" }],
                usage: { status: "none" },
                providers: DEPLOYMENT_PROVIDERS,
                interactionLocked: false,
                onPrepare: vi.fn(),
                onOpenUsage: vi.fn(),
            }),
            bridge,
        );
        const heading = relationships.container.querySelector(".asset-usage-group-summary");
        expect(heading?.textContent).toContain("Windows");
        expect(heading?.textContent).toContain("Ubuntu");
        expect(relationships.container.querySelectorAll(".asset-usage-group")).toHaveLength(1);
        expect(relationships.container.querySelectorAll(".asset-usage-row")).toHaveLength(2);

        expect(
            inspectionDetailLabel(
                { selector: "content", detailKind: "semantic_change", displayName: "file_content_replacement" },
                (id) => formatDesktopMessage(snapshot, id),
            ),
        ).toBe(formatDesktopMessage(snapshot, "catalog.product.inspection.change.content"));
        expect(
            inspectionDetailLabel(
                { selector: "file", detailKind: "file_attribution", displayName: "file_content_replacement" },
                (id) => formatDesktopMessage(snapshot, id),
            ),
        ).toBe("file_content_replacement");
    });
});
