import type { Database } from "better-sqlite3";
import type {
    ProjectApi,
    PromotionApi,
    PromotionGrantQueryApi,
    PromotionGrantTargetDescriptionV1,
} from "../contracts/core-service";
import type { Platform, Sha256Digest } from "../contracts/primitives";
import { parseConsumerAgentRuntimeIds } from "../deployment/deployment-state-authority-projection";
import { computeGlobalPromotionTargetAuthorityFingerprint } from "../foundation/fingerprint-render";
import { listDeployments, type DeploymentRow } from "../persistence/state-db";

export function createPromotionGrantQuery(
    db: Database,
    grants: Pick<PromotionApi, "listPromotionGrants">,
    projects: Pick<ProjectApi, "getProject">,
): PromotionGrantQueryApi {
    return {
        listPromotionGrantViews(assetId) {
            const result = grants.listPromotionGrants(assetId);
            if (result.status === "failed") return { ...result, value: [] };
            const globalTargets = new Map<Sha256Digest, PromotionGrantTargetDescriptionV1>();
            if (result.value.some((grant) => grant.target.targetKind === "global_target")) {
                let rows: DeploymentRow[] = [];
                try {
                    rows = listDeployments(db, true);
                } catch {
                    // Saved grants remain readable when the auxiliary State description cannot be read.
                }
                for (const row of rows) {
                    if (row.projectId !== "") continue;
                    try {
                        if (!["win32", "darwin", "linux", "wsl"].includes(row.platform)) continue;
                        if (row.platformInstanceId.trim().length === 0 || row.targetRootPath.trim().length === 0) continue;
                        const consumerAgentRuntimeIds = parseConsumerAgentRuntimeIds(row.consumerAgentRuntimeIds);
                        if (consumerAgentRuntimeIds.length === 0 || consumerAgentRuntimeIds.some((id) => id.trim().length === 0))
                            continue;
                        const description = {
                            status: "available" as const,
                            targetKind: "global_target" as const,
                            platform: row.platform as Platform,
                            platformInstanceId: row.platformInstanceId,
                            targetRootPath: row.targetRootPath,
                            consumerAgentRuntimeIds,
                        };
                        globalTargets.set(computeGlobalPromotionTargetAuthorityFingerprint(description), description);
                    } catch {
                        // A damaged historical description must not hide a valid revocable grant.
                    }
                }
            }
            return {
                ...result,
                value: result.value.map((grant) => {
                    let targetDescription: PromotionGrantTargetDescriptionV1 = { status: "unavailable" };
                    if (grant.target.targetKind === "global_target") {
                        targetDescription = globalTargets.get(grant.target.targetAuthorityFingerprint) ?? targetDescription;
                    } else {
                        const project = projects.getProject(grant.target.projectId);
                        if (project.status !== "failed" && project.value.found && project.value.value !== undefined) {
                            targetDescription = {
                                status: "available",
                                targetKind: "project",
                                displayName: project.value.value.displayName,
                                rootPath: project.value.value.rootPath,
                            };
                        }
                    }
                    return { ...grant, targetDescription };
                }),
            };
        },
    };
}
