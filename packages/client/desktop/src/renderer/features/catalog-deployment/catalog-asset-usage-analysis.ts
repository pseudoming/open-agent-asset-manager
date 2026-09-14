import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import type { AssetUsageAnalysisRequest, AssetUsageTargetView } from "./catalog-deployment-model";

export type AssetUsageTargetOutcome = AssetUsageTargetView & {
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
};

export async function analyzeOneAssetUsageTarget(
    client: Pick<DesktopApplicationClientApi, "analyzeAssetUsage">,
    request: AssetUsageAnalysisRequest,
): Promise<AssetUsageTargetOutcome> {
    try {
        const result = await client.analyzeAssetUsage(request.params);
        return result.status === "failed"
            ? {
                  targetKey: request.targetKey,
                  status: "failed",
                  failureKind: assetUsageTargetFailureKind(result.diagnostics),
                  diagnostics: result.diagnostics,
              }
            : {
                  targetKey: request.targetKey,
                  status: "ready",
                  usage: result.value,
                  diagnostics: result.diagnostics,
              };
    } catch {
        return {
            targetKey: request.targetKey,
            status: "failed",
            failureKind: "interrupted",
            diagnostics: [],
        };
    }
}

function assetUsageTargetFailureKind(
    diagnostics: readonly ProtocolDiagnosticV1[],
): Extract<AssetUsageTargetView, { readonly status: "failed" }>["failureKind"] {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.some((diagnostic) => diagnostic.causeKind === "permission_denied")) return "permission_denied";
    if (errors.some((diagnostic) => diagnostic.code === "native_guidance_build_mode_invalid")) {
        return "tool_changed";
    }
    return "verification_failed";
}
