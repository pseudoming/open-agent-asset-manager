import { createProtocolRequest } from "@oaam/app-server-protocol";
import type { CoreService } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { dispatchH1Immediate } from "../src/dispatch-registry";
import { ASSET_ID, VERSION_ID, PROJECT_ID, complete, deployment, fakeCoreWith } from "./support/host-test-fixtures";

describe("Deployment input precondition dispatch", () => {
    it("forwards the entire expectation to Core and leaves a rejected update failed", () => {
        const expectedInputs = {
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI", "CODEX_CLI"],
            assets: [
                { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: true },
                { assetId: PROJECT_ID, versionId: ASSET_ID, allowIncomplete: false },
            ],
        };
        const updateDeploymentInputs = vi.fn<CoreService["updateDeploymentInputs"]>(() => complete(deployment));
        const core = fakeCoreWith({ updateDeploymentInputs });
        const request = createProtocolRequest("guarded", "deployment.update_inputs", {
            deploymentId: VERSION_ID,
            assets: [{ ...expectedInputs.assets[0]!, versionId: PROJECT_ID }, expectedInputs.assets[1]!],
            expectedInputs,
        });
        expect(dispatchH1Immediate(core, request)).not.toBeNull();
        expect(updateDeploymentInputs).toHaveBeenCalledWith(VERSION_ID, {
            assets: request.params.assets,
            expectedInputs,
        });
        updateDeploymentInputs.mockReturnValueOnce({
            status: "failed",
            value: undefined as never,
            diagnostics: [
                {
                    severity: "error",
                    code: "deploy.inputs_changed",
                    message: "Selection changed",
                    path: "",
                    traceId: "",
                    operation: "deploy",
                    causeKind: "conflict",
                    retryable: true,
                    suggestedActions: [],
                    rawSummary: "Selection changed",
                },
            ],
        });
        expect(dispatchH1Immediate(core, request)).toMatchObject({
            result: { status: "failed", diagnostics: [{ code: "deploy.inputs_changed" }] },
        });
        expect(updateDeploymentInputs).toHaveBeenCalledTimes(2);
    });
});
