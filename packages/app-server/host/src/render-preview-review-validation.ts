import { protocolDeploymentRenderPreviewSchema } from "@oaam/app-server-protocol";
import type { DeploymentRenderPreviewView } from "@oaam/core";
import { projectDeploymentRenderPreview } from "./render-projection";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDeploymentRenderPreviewView(value: unknown): value is DeploymentRenderPreviewView {
    if (!isRecord(value)) return false;
    try {
        protocolDeploymentRenderPreviewSchema.parse(
            projectDeploymentRenderPreview("review-record-validation", value as unknown as DeploymentRenderPreviewView),
        );
        return true;
    } catch {
        return false;
    }
}
