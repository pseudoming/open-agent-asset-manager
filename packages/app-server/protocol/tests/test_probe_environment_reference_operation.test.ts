import { describe, expect, it } from "vitest";
import { parseProtocolOperationParams, parseProtocolOperationResult } from "../src";
import { VALID_PARAMS, VALID_RESULTS } from "./fixtures/protocol-fixtures";

const VALID_REFERENCE = Object.freeze({
    adapterId: "CODEX",
    agentRuntimeId: "CODEX_APP",
    originEnvironment: { platform: "win32", platformInstanceId: "desktop-local" },
    referencedEnvironment: { platform: "wsl", platformInstanceId: "Ubuntu" },
    referenceKind: "project",
    validationState: "not_checked",
});

describe("probe environment-reference Protocol operation", () => {
    it("round-trips the operation fixture", () => {
        const params = VALID_PARAMS["probe_environment_reference.list"];
        const result = VALID_RESULTS["probe_environment_reference.list"];
        expect(parseProtocolOperationParams("probe_environment_reference.list", params)).toEqual(params);
        expect(parseProtocolOperationResult("probe_environment_reference.list", result)).toEqual(result);
    });

    it("rejects blank or authority-bearing params", () => {
        for (const invalidParams of [
            { probeToken: "" },
            { probeToken: "probe-token", path: "\\\\wsl.localhost\\Ubuntu\\project" },
            { probeToken: "probe-token", authorizationToken: "forged" },
        ]) {
            expect(() => parseProtocolOperationParams("probe_environment_reference.list", invalidParams)).toThrow();
        }
    });

    it("rejects paths, tokens, private identities, and unknown reference fields", () => {
        for (const invalidReference of [
            { ...VALID_REFERENCE, path: "\\\\wsl.localhost\\Ubuntu\\project" },
            { ...VALID_REFERENCE, probeToken: "probe-token" },
            { ...VALID_REFERENCE, referenceId: "private-reference-id" },
            { ...VALID_REFERENCE, originEnvironment: { ...VALID_REFERENCE.originEnvironment, path: "C:\\Users\\agent" } },
        ]) {
            expect(() =>
                parseProtocolOperationResult("probe_environment_reference.list", {
                    status: "complete",
                    value: { references: [invalidReference] },
                    diagnostics: [],
                }),
            ).toThrow(/unknown field/u);
        }
    });

    it("rejects non-WSL targets and widened reference states", () => {
        for (const invalidReference of [
            { ...VALID_REFERENCE, referencedEnvironment: { platform: "linux", platformInstanceId: "Ubuntu" } },
            { ...VALID_REFERENCE, referenceKind: "workspace" },
            { ...VALID_REFERENCE, validationState: "checked" },
        ]) {
            expect(() =>
                parseProtocolOperationResult("probe_environment_reference.list", {
                    status: "complete",
                    value: { references: [invalidReference] },
                    diagnostics: [],
                }),
            ).toThrow();
        }
    });

    it("rejects token, path, and unknown fields on the result envelope", () => {
        for (const invalidValue of [
            { references: [VALID_REFERENCE], probeToken: "probe-token" },
            { references: [VALID_REFERENCE], path: "C:\\Users\\agent" },
            { references: [VALID_REFERENCE], unknown: true },
        ]) {
            expect(() =>
                parseProtocolOperationResult("probe_environment_reference.list", {
                    status: "complete",
                    value: invalidValue,
                    diagnostics: [],
                }),
            ).toThrow(/unknown field/u);
        }
    });
});
