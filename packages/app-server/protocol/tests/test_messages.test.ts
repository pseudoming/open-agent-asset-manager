import { describe, expect, it } from "vitest";
import {
    PROTOCOL_OPERATION_NAMES,
    ProtocolValidationError,
    assertProtocolSchemaRoundTrip,
    createProtocolErrorResponse,
    createProtocolNotification,
    createProtocolRequest,
    createProtocolResultResponse,
    isProtocolResponseCandidate,
    parseProtocolJsonText,
    parseProtocolNotification,
    parseProtocolRequest,
    parseProtocolResponse,
    parseProtocolResponseEnvelope,
    protocolDiagnosticSchema,
    protocolRejectionSchema,
    protocolString,
    stringifyProtocolJson,
} from "../src";
import { VALID_PARAMS, VALID_RESULTS, completeTerminalValue } from "./fixtures/protocol-fixtures";

describe("JSON-RPC-lite Protocol messages", () => {
    it("round-trips one strict request and result response for every operation", () => {
        let sequence = 0;
        for (const method of PROTOCOL_OPERATION_NAMES) {
            sequence += 1;
            const id = `request-${sequence}`;
            const request = { id, method, params: VALID_PARAMS[method] };
            const response = { id, result: VALID_RESULTS[method] };
            expect(parseProtocolRequest(request), `${method} request`).toEqual(request);
            expect(parseProtocolResponse(response, method), `${method} response`).toEqual(response);
            expect(createProtocolRequest(id, method, VALID_PARAMS[method] as never)).toEqual(request);
            expect(createProtocolResultResponse(id, method, VALID_RESULTS[method] as never)).toEqual(response);
        }
    });

    it("keeps Protocol rejection separate from operation outcomes", () => {
        const error = { code: "protocol.invalid_params", message: "invalid params" } as const;
        const response = { id: "request-1", error };
        expect(parseProtocolResponseEnvelope(response)).toEqual(response);
        expect(parseProtocolResponse(response, "asset.get")).toEqual(response);
        expect(createProtocolErrorResponse("request-1", error)).toEqual(response);
        expect(protocolRejectionSchema.parse(error)).toEqual(error);
    });

    it("rejects invalid outer envelopes before operation parsing", () => {
        for (const invalid of [
            null,
            [],
            {},
            { id: "request-1" },
            { id: "request-1", result: {}, error: { code: "protocol.invalid_params", message: "bad" } },
        ]) {
            expect(() => parseProtocolResponseEnvelope(invalid), JSON.stringify(invalid)).toThrow();
        }
        for (const invalid of [
            { id: null, method: "asset.get", params: {} },
            { id: "request-1", method: "asset.get" },
            { id: "request-1", method: "asset.get", params: {}, jsonrpc: "2.0" },
            [{ id: "request-1", method: "asset.get", params: {} }],
        ]) {
            expect(() => parseProtocolRequest(invalid), JSON.stringify(invalid)).toThrow();
        }
    });

    it("strictly validates all three notifications and operation-specific payloads", () => {
        const progress = {
            method: "operation.progress",
            params: {
                operationId: "operation-1",
                sequence: 1,
                operation: "asset.reindex",
                progress: { stage: "indexing", completedUnits: 1, totalUnits: 2 },
            },
        } as const;
        const terminal = {
            method: "operation.terminal",
            params: {
                operationId: "operation-1",
                sequence: 2,
                operation: "asset.reindex",
                outcome: completeTerminalValue("asset.reindex"),
            },
        } as const;
        const invalidation = {
            method: "resource.invalidated",
            params: { resourceKind: "asset", assetId: "00000000-0000-4000-8000-000000000001" },
        } as const;
        expect(parseProtocolNotification(progress)).toEqual(progress);
        expect(parseProtocolNotification(terminal)).toEqual(terminal);
        expect(parseProtocolNotification(invalidation)).toEqual(invalidation);
        expect(createProtocolNotification(progress)).toEqual(progress);

        expect(() => parseProtocolNotification(null)).toThrow(/notification object/u);
        expect(() => parseProtocolNotification({ method: "unknown", params: {} })).toThrow(/unknown notification/u);
        expect(() =>
            parseProtocolNotification({
                ...progress,
                params: { ...progress.params, progress: { stage: "indexing" } },
            }),
        ).toThrow();
        expect(() =>
            parseProtocolNotification({
                ...terminal,
                params: { ...terminal.params, outcome: { status: "complete" } },
            }),
        ).toThrow();
        expect(
            parseProtocolNotification({
                method: "resource.invalidated",
                params: {
                    resourceKind: "host_review_record",
                    recordKind: "project_lifecycle",
                    token: "project-review",
                    reason: "accepted",
                },
            }),
        ).toEqual({
            method: "resource.invalidated",
            params: {
                resourceKind: "host_review_record",
                recordKind: "project_lifecycle",
                token: "project-review",
                reason: "accepted",
            },
        });
    });

    it("parses and emits finite JSON without accepting non-JSON values", () => {
        expect(parseProtocolJsonText('{"a":[1,true,null]}')).toEqual({ a: [1, true, null] });
        expect(stringifyProtocolJson({ a: [1, true, null] })).toBe('{"a":[1,true,null]}');
        expect(() => parseProtocolJsonText("{")).toThrow(/invalid JSON/u);
        expect(() => stringifyProtocolJson({ value: undefined })).toThrow(/JSON value/u);
        expect(assertProtocolSchemaRoundTrip(protocolString, "value")).toBe("value");
    });

    it("classifies only object envelopes carrying an id as response candidates", () => {
        expect(isProtocolResponseCandidate({ id: "request-1" })).toBe(true);
        for (const value of [null, [], {}, { method: "asset.list" }]) {
            expect(isProtocolResponseCandidate(value), JSON.stringify(value)).toBe(false);
        }
    });

    it("preserves trustworthy validation errors", () => {
        expect(() => parseProtocolRequest({ id: "request-1", method: "unknown", params: {} })).toThrow(ProtocolValidationError);
    });

    it("carries the Core backup diagnostic operation without widening to foreign values", () => {
        const diagnostic = {
            severity: "error",
            code: "backup.destination_changed",
            operation: "backup",
            causeKind: "conflict",
            retryable: true,
            suggestedActions: ["retry"],
            message: "destination changed",
        } as const;
        expect(protocolDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
        expect(() => protocolDiagnosticSchema.parse({ ...diagnostic, operation: "foreign" })).toThrow(ProtocolValidationError);
    });
});
