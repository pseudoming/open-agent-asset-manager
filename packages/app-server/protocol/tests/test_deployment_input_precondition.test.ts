import { describe, expect, it } from "vitest";
import { parseProtocolOperationParams } from "../src";
import { UUID_A, UUID_B, UUID_C } from "./fixtures/protocol-fixtures";

const assets = [
    { assetId: UUID_A, versionId: UUID_B, allowIncomplete: false },
    { assetId: UUID_C, versionId: UUID_A, allowIncomplete: true },
];
const params = {
    deploymentId: UUID_C,
    assets: [{ ...assets[0]!, versionId: UUID_C }, assets[1]!],
    expectedInputs: { consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI", "CODEX_CLI"], assets },
};

describe("Conditional Deployment input replacement", () => {
    it("retains both ordered Version selections and consent without accepting extra authority fields", () => {
        expect(parseProtocolOperationParams("deployment.update_inputs", params)).toEqual(params);
        expect(
            parseProtocolOperationParams("deployment.update_inputs", {
                deploymentId: UUID_C,
                expectedInputs: { consumerAgentRuntimeIds: ["CODEX_CLI"], assets: [] },
            }),
        ).toEqual({ deploymentId: UUID_C, expectedInputs: { consumerAgentRuntimeIds: ["CODEX_CLI"], assets: [] } });
        expect(parseProtocolOperationParams("deployment.update_inputs", { deploymentId: UUID_C, assets })).toEqual({
            deploymentId: UUID_C,
            assets,
        });
    });

    it.each([
        null,
        { assets },
        { ...params.expectedInputs, consumerAgentRuntimeIds: [] },
        { ...params.expectedInputs, targetRootPath: "/unreviewed" },
        { ...params.expectedInputs, assets: [{ ...assets[0], versionId: "not-a-version" }] },
        { ...params.expectedInputs, assets: [{ ...assets[0], allowIncomplete: "true" }] },
    ])("rejects malformed expected inputs %j", (expectedInputs) => {
        expect(() => parseProtocolOperationParams("deployment.update_inputs", { ...params, expectedInputs })).toThrow();
    });
});
