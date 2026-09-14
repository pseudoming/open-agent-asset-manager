import { describe, expect, it } from "vitest";
import { parseProtocolOperationParams } from "../src";
import { SHA_B, VALID_PARAMS } from "./fixtures/protocol-fixtures";

describe("deployment preview and inspection authority", () => {
    it("accepts preview-bound overwrite while preserving inspection requirements for repair and reverse", () => {
        const params = {
            previewToken: "current-preview",
            deploymentAction: "overwrite_runtime",
            userActionId: "confirmed-preview",
        };
        expect(parseProtocolOperationParams("deployment.deploy", params)).toEqual(params);
        expect(() =>
            parseProtocolOperationParams("deployment.deploy", {
                ...params,
                inspectionToken: "old-inspection",
                expectedInspectionResultFingerprint: SHA_B,
            }),
        ).toThrow();
        expect(() => parseProtocolOperationParams("deployment.deploy", { ...params, userActionId: " " })).toThrow();
        for (const operation of ["deployment.repair", "reverse_accept.prepare"] as const) {
            const missingInspection = { ...VALID_PARAMS[operation] } as Record<string, unknown>;
            delete missingInspection.inspectionToken;
            expect(() => parseProtocolOperationParams(operation, missingInspection)).toThrow();
        }
    });
});
