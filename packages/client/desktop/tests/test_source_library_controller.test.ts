import type { ProtocolInvalidationV1, ProtocolOperationName } from "@oaam/app-server-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { SourceLibraryController, type SourceLibraryState } from "../src/renderer/features/source-library";

const OPERATIONS: readonly ProtocolOperationName[] = ["adapter_provider.list", "watched_scan_intent.get", "project.list"];

function ready(controller: SourceLibraryController): Extract<SourceLibraryState, { readonly status: "ready" }> {
    expect(controller.state.status).toBe("ready");
    return controller.state as Extract<SourceLibraryState, { readonly status: "ready" }>;
}

function clientFixture() {
    let invalidate: ((value: ProtocolInvalidationV1) => void) | undefined;
    const unsubscribeInvalidation = vi.fn();
    const client = {
        availableOperations: OPERATIONS,
        supportsOperation: vi.fn((operation: ProtocolOperationName) => OPERATIONS.includes(operation)),
        listAdapterProviders: vi.fn(async () => ({
            status: "complete",
            value: {
                providers: [{ adapterId: "CLAUDECODE", displayName: "Claude Code", agentRuntimes: [], capabilities: [] }],
            },
            diagnostics: [],
        })),
        getWatchedScanIntent: vi.fn(async () => ({
            status: "complete",
            value: {
                configVersion: 1,
                settingId: "watched_scan_intent_v1",
                revision: 0,
                environments: [],
                updatedAt: 0,
                settingFingerprint: "a".repeat(64),
            },
            diagnostics: [],
        })),
        listProjects: vi.fn(async () => ({ status: "complete", value: { projects: [] }, diagnostics: [] })),
        subscribeInvalidation: vi.fn((listener: (value: ProtocolInvalidationV1) => void) => {
            invalidate = listener;
            return unsubscribeInvalidation;
        }),
    } as unknown as DesktopApplicationClientApi;
    return { client, invalidate: (value: ProtocolInvalidationV1) => invalidate?.(value), unsubscribeInvalidation };
}

describe("Import source library controller", () => {
    it("loads only source authorities and marks source/project changes stale", async () => {
        const fixture = clientFixture();
        const controller = new SourceLibraryController(fixture.client);
        controller.subscribe(() => undefined);
        await controller.load();

        expect(ready(controller).environments).toEqual([]);
        expect(fixture.client.listAdapterProviders).toHaveBeenCalledOnce();
        expect(fixture.client.getWatchedScanIntent).toHaveBeenCalledOnce();
        expect(fixture.client.listProjects).toHaveBeenCalledWith({ includeDeleted: false });

        fixture.invalidate({ resourceKind: "asset", assetId: "11111111-1111-4111-8111-111111111111" });
        expect(ready(controller).stale).toBe(false);
        fixture.invalidate({ resourceKind: "project", projectId: "11111111-1111-4111-8111-111111111111" });
        expect(ready(controller).stale).toBe(true);
        fixture.invalidate({ resourceKind: "collection", collection: "projects" });
        fixture.invalidate({ resourceKind: "watched_scan_intent" });
        expect(ready(controller).stale).toBe(true);

        controller.dispose();
        expect(fixture.unsubscribeInvalidation).toHaveBeenCalledOnce();
    });

    it("fails closed when any required source authority is unavailable", async () => {
        const fixture = clientFixture();
        fixture.client.supportsOperation = vi.fn(() => false);
        const controller = new SourceLibraryController(fixture.client);
        controller.subscribe(() => undefined);
        await controller.load();
        expect(controller.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "sources.operation_unavailable" },
        });
        expect(fixture.client.listAdapterProviders).not.toHaveBeenCalled();
    });

    it("surfaces an exact failed authority result and a rejected transport without publishing partial state", async () => {
        const failedFixture = clientFixture();
        failedFixture.client.listAdapterProviders = vi.fn(async () => ({ status: "failed", diagnostics: [] }));
        const failedController = new SourceLibraryController(failedFixture.client);
        await failedController.load();
        expect(failedController.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "sources.load_failed" },
        });

        const rejectedFixture = clientFixture();
        rejectedFixture.client.getWatchedScanIntent = vi.fn(async () => {
            throw new Error("transport interrupted");
        });
        const rejectedController = new SourceLibraryController(rejectedFixture.client);
        await rejectedController.load();
        expect(rejectedController.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "sources.load_interrupted" },
        });
    });

    it("does not publish a late authority completion after disposal", async () => {
        const fixture = clientFixture();
        let resolveProviders:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["listAdapterProviders"]>>) => void)
            | undefined;
        fixture.client.listAdapterProviders = vi.fn(
            async () =>
                new Promise<Awaited<ReturnType<DesktopApplicationClientApi["listAdapterProviders"]>>>((resolve) => {
                    resolveProviders = resolve;
                }),
        );
        const controller = new SourceLibraryController(fixture.client);
        const loading = controller.load();
        controller.dispose();
        resolveProviders?.({
            status: "complete",
            value: { providers: [] },
            diagnostics: [],
        });
        await loading;

        expect(controller.state.status).toBe("loading");
        expect(fixture.unsubscribeInvalidation).toHaveBeenCalledOnce();
    });
});
