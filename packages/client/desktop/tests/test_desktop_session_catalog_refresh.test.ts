import type { ProtocolOperationName, ProtocolOperationParams, ProtocolOperationResult } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, ClientMessageTransport } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import { type BrowserProtocolPort, DesktopSession } from "../src/renderer/client";
import { createDesktopPresentationTestBridge } from "./desktop-presentation-test-harness";

function browserPort(): BrowserProtocolPort {
    return {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

function bridge(): OaamDesktopBridge {
    return {
        ...createDesktopPresentationTestBridge(),
        retrySession: vi.fn(async () => undefined),
        pickProjectRoot: vi.fn(async () => ({ status: "cancelled" as const })),
        pickAssetVersionExport: vi.fn(async () => ({ status: "cancelled" as const })),
    };
}

describe("Desktop catalog summary refresh", () => {
    it("publishes an imported Asset and preserves the last good summary when the next refresh fails", async () => {
        const asset = {
            assetId: "11111111-1111-4111-8111-111111111111",
            kind: "Guidance" as const,
            scope: "global" as const,
            scopePath: "",
            displayName: "Imported guidance",
            displayDescription: "Imported during onboarding",
            currentVersionId: "22222222-2222-4222-8222-222222222222",
            currentRevision: 1,
            currentFingerprint: "a".repeat(64),
            currentVersionStatus: "complete" as const,
            deleted: false,
            createdAt: 1,
            updatedAt: 2,
        };
        let listCall = 0;
        const list = vi.fn(async (): Promise<ProtocolOperationResult<"asset.list">> => {
            listCall += 1;
            if (listCall === 1) {
                return { status: "complete", value: { assets: [] }, diagnostics: [] };
            }
            if (listCall === 2) {
                return {
                    status: "complete",
                    value: { assets: [asset] },
                    diagnostics: [
                        {
                            severity: "warning",
                            code: "catalog.partial",
                            operation: "asset",
                            causeKind: "runtime",
                            retryable: true,
                            suggestedActions: ["retry"],
                            message: "One catalog source needs attention.",
                        },
                    ],
                };
            }
            return {
                status: "failed",
                diagnostics: [
                    {
                        severity: "error",
                        code: "catalog.failed",
                        operation: "asset",
                        causeKind: "runtime",
                        retryable: true,
                        suggestedActions: ["retry"],
                        message: "Catalog refresh failed.",
                    },
                ],
            };
        });
        const client: ClientConnectionApi = {
            state: "created",
            availableOperations: [],
            initialize: vi.fn(async () => ({
                protocolVersion: 1,
                hostInstanceId: "host-1",
                availableOperations: ["asset.list"],
            })),
            request: (async (method: ProtocolOperationName, _params: ProtocolOperationParams<ProtocolOperationName>) => {
                if (method !== "asset.list") throw new Error(`unexpected operation ${method}`);
                return list();
            }) as ClientConnectionApi["request"],
            start: vi.fn() as ClientConnectionApi["start"],
            subscribeInvalidation: vi.fn(() => () => undefined),
            subscribeClose: vi.fn(() => () => undefined),
            close: vi.fn(),
        };
        const session = new DesktopSession(bridge(), {
            createRequestId: () => "request-1",
            createConnection: vi.fn((_transport: ClientMessageTransport) => client) as never,
        });
        session.attach(browserPort());
        await vi.waitFor(() => expect(session.state.status).toBe("ready"));

        await session.refreshCatalogSummary();
        expect(session.state).toMatchObject({ status: "ready", assetCount: 1, catalogWarningCount: 1 });
        await expect(session.refreshCatalogSummary()).rejects.toThrow(/refresh failed/u);
        expect(session.state).toMatchObject({ status: "ready", assetCount: 1, catalogWarningCount: 1 });
        expect(list).toHaveBeenCalledTimes(3);
    });
});
