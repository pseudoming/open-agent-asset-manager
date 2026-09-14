import { describe, expect, it } from "vitest";
import {
    collectDeploymentTargets,
    type DeploymentView,
    deploymentTargetForDeployment,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { PROBE_REVIEW } from "./catalog-deployment-test-fixtures";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";

describe("Desktop catalog Deployment target binding", () => {
    it("binds a managed Deployment only to one exact environment, root, and runtime target", () => {
        const target = collectDeploymentTargets(PROBE_REVIEW)[0];
        if (target === undefined) throw new Error("exact Project target is required");
        const deployment: DeploymentView = {
            deploymentId: DEPLOYMENT_ID,
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            environment: { platform: target.platform, platformInstanceId: target.platformInstanceId },
            targetRootPath: target.displayPath,
            stage: "in_sync",
            reason: "ready",
            actionHints: [],
            freshness: { state: "complete", attemptedAt: 2, lastCompleteAt: 2 },
            deleted: false,
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
            createdAt: 1,
            updatedAt: 2,
        };

        expect(deploymentTargetForDeployment([target], deployment)).toBe(target);
        expect(deploymentTargetForDeployment([{ ...target, displayPath: "/other" }], deployment)).toBeUndefined();
        expect(
            deploymentTargetForDeployment([target, { ...target, key: "duplicate", targetCandidateId: "duplicate" }], deployment),
        ).toBeUndefined();
        expect(
            deploymentTargetForDeployment([target], {
                ...deployment,
                consumerAgentRuntimeIds: ["CLAUDE_CODE_APP"],
            }),
        ).toBeUndefined();
    });
});
