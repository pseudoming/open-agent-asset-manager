import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { ClientProtocolFaultError, ClientTransportError } from "@oaam/client-framework";
import { type DesktopDisplayText, localizedText } from "../../presentation";
import type { AssetFilePreviewState } from "../asset-content-preview";
import type {
    AssetSummaryView,
    AssetUsageTargetView,
    AssetVersionView,
    AssetView,
    DeploymentView,
    InspectionDetailView,
    InspectionSummaryView,
    PreparedReverseView,
    ProjectView,
    RenderAnalysisView,
    RenderPreviewView,
    ReverseCommitView,
} from "./catalog-deployment-model";

export type AssetUsageAnalysisState =
    | { readonly status: "none" }
    | {
          readonly status: "loading";
          readonly requestKey: string;
          readonly completedCount: number;
          readonly totalCount: number;
          readonly targets: readonly AssetUsageTargetView[];
      }
    | { readonly status: "ready"; readonly requestKey: string; readonly targets: readonly AssetUsageTargetView[] }
    | { readonly status: "failed"; readonly requestKey: string; readonly message: DesktopDisplayText };

export const CATALOG_DEPLOYMENT_FAILURE_OUTCOMES = {
    "analysis.operation_failed": "analysis_failed",
    "analysis.interrupted": "analysis_failed",
    "analysis.outcome_unavailable": "analysis_outcome_unavailable",
    "preview.selection_invalid": "preview_failed",
    "preview.operation_failed": "preview_failed",
    "preview.interrupted": "preview_failed",
    "preview.outcome_unavailable": "preview_outcome_unavailable",
    "inspection.operation_failed": "inspection_failed",
    "inspection.interrupted": "inspection_failed",
    "inspection.outcome_unavailable": "inspection_outcome_unavailable",
    "inspection_detail.operation_failed": "inspection_detail_failed",
    "inspection_detail.interrupted": "inspection_detail_failed",
} as const;

export type CatalogDeploymentFailureKind = keyof typeof CATALOG_DEPLOYMENT_FAILURE_OUTCOMES;
export type CatalogDeploymentFailurePresentationState =
    (typeof CATALOG_DEPLOYMENT_FAILURE_OUTCOMES)[CatalogDeploymentFailureKind];
export type DeploymentAnalysisFailureKind = Extract<CatalogDeploymentFailureKind, `analysis.${string}`>;
export type DeploymentPreviewFailureKind = Extract<CatalogDeploymentFailureKind, `preview.${string}`>;
export type DeploymentInspectionFailureKind = Extract<CatalogDeploymentFailureKind, `inspection.${string}`>;
export type DeploymentInspectionDetailFailureKind = Extract<CatalogDeploymentFailureKind, `inspection_detail.${string}`>;

export function catalogDeploymentFailurePresentationState(
    failureKind: CatalogDeploymentFailureKind,
): CatalogDeploymentFailurePresentationState {
    return CATALOG_DEPLOYMENT_FAILURE_OUTCOMES[failureKind];
}

export function catalogDeploymentDeliveryIsUncertain(error: unknown): boolean {
    return (
        (error instanceof ClientTransportError && error.delivery === "uncertain") ||
        (error instanceof ClientProtocolFaultError && error.delivery === "uncertain")
    );
}

export type CatalogAssetDetailState =
    | { readonly status: "none" }
    | { readonly status: "loading"; readonly assetId: string }
    | {
          readonly status: "ready";
          readonly asset: AssetView;
          readonly version: AssetVersionView;
          readonly preview: AssetFilePreviewState;
      }
    | { readonly status: "failed"; readonly assetId: string; readonly message: DesktopDisplayText };

export type DeploymentAnalysisState =
    | { readonly status: "none" }
    | { readonly status: "loading"; readonly deploymentId: string }
    | { readonly status: "ready"; readonly value: RenderAnalysisView }
    | {
          readonly status: "failed";
          readonly deploymentId: string;
          readonly failureKind: DeploymentAnalysisFailureKind;
          readonly message: DesktopDisplayText;
      };

export type DeploymentPreviewState =
    | { readonly status: "none" }
    | { readonly status: "loading"; readonly deploymentId: string }
    | { readonly status: "ready"; readonly value: RenderPreviewView }
    | {
          readonly status: "failed";
          readonly deploymentId: string;
          readonly failureKind: DeploymentPreviewFailureKind;
          readonly message: DesktopDisplayText;
      };

export type DeploymentInspectionState =
    | { readonly status: "none" }
    | { readonly status: "loading"; readonly deploymentId: string }
    | {
          readonly status: "ready";
          readonly value: InspectionSummaryView;
          readonly detail:
              | { readonly status: "none" }
              | { readonly status: "loading"; readonly selector: string }
              | { readonly status: "ready"; readonly value: InspectionDetailView }
              | {
                    readonly status: "failed";
                    readonly selector: string;
                    readonly failureKind: DeploymentInspectionDetailFailureKind;
                    readonly message: DesktopDisplayText;
                };
      }
    | {
          readonly status: "failed";
          readonly deploymentId: string;
          readonly failureKind: DeploymentInspectionFailureKind;
          readonly message: DesktopDisplayText;
      };

export type DeploymentReverseState =
    | { readonly status: "none" }
    | { readonly status: "preparing"; readonly deploymentId: string }
    | { readonly status: "prepared"; readonly value: PreparedReverseView; readonly message?: DesktopDisplayText }
    | { readonly status: "not_prepared"; readonly deploymentId: string; readonly message: DesktopDisplayText }
    | {
          readonly status: "result";
          readonly deploymentId: string;
          readonly value: ReverseCommitView;
          readonly reviewedFilePaths?: readonly string[];
      }
    | { readonly status: "failed"; readonly deploymentId: string; readonly message: DesktopDisplayText };

export type CatalogDeploymentActivity =
    | { readonly status: "idle" }
    | {
          readonly status: "starting" | "accepted" | "progress";
          readonly kind:
              | "register_project"
              | "create_deployment"
              | "update_version"
              | "authorize"
              | "analyze"
              | "preview"
              | "deploy"
              | "scan"
              | "inspect"
              | "repair"
              | "recover"
              | "reverse_prepare"
              | "reverse_commit"
              | "reverse_cancel";
          readonly message: DesktopDisplayText;
          readonly operationId?: string;
          readonly completedUnits?: number;
          readonly totalUnits?: number;
          readonly technicalStage?: string;
      };

export type CatalogDeploymentActivityKind = Exclude<CatalogDeploymentActivity, { readonly status: "idle" }>["kind"];

export type OrdinaryCatalogDeploymentActivityKind = Exclude<
    CatalogDeploymentActivityKind,
    "reverse_prepare" | "reverse_commit" | "reverse_cancel"
>;

export interface CatalogDeploymentCompletedMutation {
    readonly kind: "deploy" | "repair" | "recover";
    readonly deploymentId: string;
    readonly reviewedFilePaths: readonly string[];
}

export function catalogDeploymentOperationLabel(kind: OrdinaryCatalogDeploymentActivityKind): DesktopDisplayText {
    switch (kind) {
        case "register_project":
            return localizedText("catalog.activity.register");
        case "create_deployment":
            return localizedText("catalog.activity.create");
        case "update_version":
            return localizedText("catalog.version_update.action");
        case "authorize":
            return localizedText("catalog.authorization.allow_current_project");
        case "analyze":
            return localizedText("catalog.activity.analyze");
        case "preview":
            return localizedText("catalog.activity.preview");
        case "deploy":
            return localizedText("catalog.activity.deploy");
        case "scan":
            return localizedText("catalog.activity.scan");
        case "inspect":
            return localizedText("catalog.activity.inspect");
        case "repair":
            return localizedText("catalog.activity.repair");
        case "recover":
            return localizedText("catalog.activity.recover");
    }
}

export type CatalogDeploymentState =
    | { readonly status: "loading"; readonly message: DesktopDisplayText }
    | {
          readonly status: "failed";
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "ready";
          readonly projects: readonly ProjectView[];
          readonly assets: readonly AssetSummaryView[];
          readonly deployments: readonly DeploymentView[];
          readonly assetUsage: AssetUsageAnalysisState;
          readonly assetDetail: CatalogAssetDetailState;
          readonly analysis: DeploymentAnalysisState;
          readonly preview: DeploymentPreviewState;
          readonly inspection: DeploymentInspectionState;
          readonly reverse: DeploymentReverseState;
          readonly activity: CatalogDeploymentActivity;
          readonly completedMutation?: CatalogDeploymentCompletedMutation;
          readonly stale: boolean;
          readonly requiresReconciliation: boolean;
          readonly pendingRecoveryDeploymentId?: string;
          readonly message: DesktopDisplayText | undefined;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };
