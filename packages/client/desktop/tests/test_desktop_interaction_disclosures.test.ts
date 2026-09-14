import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { cleanup } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogInspectionDetail } from "../src/renderer/features/catalog-deployment/CatalogInspectionDetail";
import { CatalogReverseReview } from "../src/renderer/features/catalog-deployment/CatalogReverseReview";
import {
    CatalogActivityTechnicalDetails,
    CatalogDeploymentTechnicalDetails,
    CatalogReasonTechnicalDetails,
    CatalogTargetTechnicalDetails,
} from "../src/renderer/features/catalog-deployment/CatalogDeploymentTechnicalDetails";
import type { CatalogDeploymentController } from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import { ProtocolDiagnostics } from "../src/renderer/presentation";
import { COMMITTED_REVERSE, INSPECTION_DETAIL } from "./catalog-deployment-test-fixtures";
import { ASSET_ID, DEPLOYMENT_ID } from "./catalog-deployment-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { toggleInteractionDisclosure } from "./desktop-interaction-test-harness";

const DIAGNOSTIC = Object.freeze({
    severity: "warning",
    code: "interaction_receipt_warning",
    operation: "probe",
    causeKind: "partial",
    retryable: false,
    suggestedActions: ["review"],
    message: "bounded interaction receipt fixture",
} satisfies ProtocolDiagnosticV1);

afterEach(cleanup);

describe("Desktop interaction disclosure receipts", () => {
    it("opens and closes every catalog identity disclosure on its exact rendered control", () => {
        const view = renderWithPresentation(
            createElement(
                Fragment,
                null,
                createElement(CatalogTargetTechnicalDetails, {
                    adapterId: "CLAUDECODE",
                    environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                    agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                }),
                createElement(CatalogDeploymentTechnicalDetails, {
                    deploymentId: DEPLOYMENT_ID,
                    environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                    agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                }),
                createElement(CatalogActivityTechnicalDetails, { operationId: "operation-1", progressStage: "reading" }),
                createElement(CatalogReasonTechnicalDetails, { reason: "bounded_reason" }),
            ),
        );

        for (const entryId of [
            "features.catalog-deployment.catalog_deployment_technical_details.001",
            "features.catalog-deployment.catalog_deployment_technical_details.002",
            "features.catalog-deployment.catalog_deployment_technical_details.003",
            "features.catalog-deployment.catalog_deployment_technical_details.004",
        ]) {
            toggleInteractionDisclosure(entryId, view.container);
        }
    });

    it("opens and closes semantic-change and file-attribution inspection details", () => {
        const semantic = renderWithPresentation(createElement(CatalogInspectionDetail, { detail: INSPECTION_DETAIL }));
        toggleInteractionDisclosure("features.catalog-deployment.catalog_inspection_detail.002", semantic.container);
        cleanup();

        const attribution = renderWithPresentation(
            createElement(CatalogInspectionDetail, {
                detail: {
                    inspectionToken: "inspection-token",
                    selector: "file-1",
                    detailKind: "file_attribution",
                    relativePath: "AGENTS.md",
                    attributionState: "conflict",
                    reasonCode: "marker_changed",
                    diagnostics: [],
                },
            }),
        );
        toggleInteractionDisclosure("features.catalog-deployment.catalog_inspection_detail.001", attribution.container);
    });

    it("opens and closes committed and recovery-required reverse result details", () => {
        const controller = {} as CatalogDeploymentController;
        const committed = renderWithPresentation(
            createElement(CatalogReverseReview, {
                controller,
                reverse: { status: "result", deploymentId: DEPLOYMENT_ID, value: COMMITTED_REVERSE },
                busy: false,
                stale: false,
                providers: [],
            }),
        );
        toggleInteractionDisclosure("features.catalog-deployment.catalog_reverse_review.001", committed.container);
        cleanup();

        const recovery = renderWithPresentation(
            createElement(CatalogReverseReview, {
                controller,
                reverse: {
                    status: "result",
                    deploymentId: DEPLOYMENT_ID,
                    value: { commitState: "recovery_required", reasonCode: `recovery_for_${ASSET_ID}` },
                },
                busy: false,
                stale: false,
                providers: [],
            }),
        );
        toggleInteractionDisclosure("features.catalog-deployment.catalog_reverse_review.002", recovery.container);
    });

    it("opens and closes grouped and individual protocol diagnostics", () => {
        const grouped = renderWithPresentation(
            createElement(ProtocolDiagnostics, { diagnostics: [DIAGNOSTIC], layout: "grouped" }),
        );
        toggleInteractionDisclosure("presentation.protocol_diagnostics.001", grouped.container);
        cleanup();

        const individual = renderWithPresentation(createElement(ProtocolDiagnostics, { diagnostics: [DIAGNOSTIC] }));
        toggleInteractionDisclosure("presentation.protocol_diagnostics.002", individual.container);
    });

    it("presents duplicate machine diagnostics once while retaining every raw record in technical details", () => {
        const duplicate = {
            ...DIAGNOSTIC,
            message: "second bounded raw receipt",
            traceId: "trace-2",
        } satisfies ProtocolDiagnosticV1;
        const rendered = renderWithPresentation(createElement(ProtocolDiagnostics, { diagnostics: [DIAGNOSTIC, duplicate] }));

        expect(rendered.container.querySelectorAll(".workbench-notice")).toHaveLength(1);
        expect(rendered.container.querySelectorAll(".protocol-technical-record")).toHaveLength(2);
        expect(rendered.container.querySelector(".workbench-notice")?.getAttribute("data-oaam-surface")).toBe("inline");
    });
});
