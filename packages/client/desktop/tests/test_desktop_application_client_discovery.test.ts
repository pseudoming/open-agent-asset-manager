import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { DesktopApplicationClient } from "../src/renderer/client/desktop-application-client";
import { DIGEST, ENABLEMENT, ENVIRONMENT, PROBE, PROVIDERS, WATCHED } from "./discovery-test-fixtures";

describe("Desktop discovery Client operation routing", () => {
    it("uses only the reviewed operation methods and awaits an accepted probe terminal", async () => {
        const request = vi.fn(async (method: ProtocolOperationName) => {
            const values: Partial<Record<ProtocolOperationName, unknown>> = {
                "adapter_provider.list": { status: "complete", value: { providers: PROVIDERS }, diagnostics: [] },
                "adapter_enablement.get": { status: "complete", value: ENABLEMENT, diagnostics: [] },
                "adapter_enablement.replace": { status: "complete", value: ENABLEMENT, diagnostics: [] },
                "watched_scan_intent.get": { status: "complete", value: WATCHED, diagnostics: [] },
                "watched_scan_intent.replace": { status: "complete", value: WATCHED, diagnostics: [] },
                "environment.list": {
                    status: "complete",
                    value: { environments: [{ environment: ENVIRONMENT, displayName: "Local Linux" }] },
                    diagnostics: [],
                },
                "import_preview.detail": {
                    status: "complete",
                    value: {
                        candidateId: "candidate-1",
                        mediaType: "text/markdown",
                        contentKind: "text",
                        text: { text: "body", byteLength: 4, truncated: false },
                        byteLength: 4,
                        contentHash: DIGEST,
                    },
                    diagnostics: [],
                },
                "import_preview.cancel": { status: "complete", value: { cancelled: true }, diagnostics: [] },
            };
            return values[method];
        }) as ClientConnectionApi["request"];
        const terminal = Promise.resolve({ status: "complete", value: PROBE, diagnostics: [] }) as never;
        const start = vi.fn(async () => ({
            operationId: "operation-1",
            operation: "adapter.probe" as const,
            terminal,
            terminalSequence: null,
            subscribeProgress: (listener: (progress: unknown, sequence: number) => void) => {
                listener(
                    {
                        stage: "provider_probe",
                        completedUnits: 1,
                        totalUnits: 1,
                        adapterId: "CLAUDECODE",
                        environment: ENVIRONMENT,
                        outcome: "complete",
                        elapsedMilliseconds: 125,
                    },
                    1,
                );
                return () => undefined;
            },
        })) as ClientConnectionApi["start"];
        const connection = { request, start } as ClientConnectionApi;
        const client = new DesktopApplicationClient(connection, [
            "adapter_provider.list",
            "adapter_enablement.get",
            "adapter_enablement.replace",
            "watched_scan_intent.get",
            "watched_scan_intent.replace",
            "watched_scan_intent.reset",
            "environment.list",
            "adapter.probe",
            "adapter.read",
            "import.preview",
            "import_preview.detail",
            "import_preview.cancel",
            "import.accept_batch",
        ]);

        await client.listAdapterProviders();
        await client.getAdapterEnablement();
        await client.replaceAdapterEnablement({
            expectedRevision: 1,
            expectedSettingFingerprint: DIGEST,
            enabledAdapterIds: ["CLAUDECODE"],
            userActionId: "action",
        });
        await client.getWatchedScanIntent();
        await client.replaceWatchedScanIntent({
            expectedRevision: 1,
            expectedSettingFingerprint: DIGEST,
            decisions: [{ action: "retain_existing", selectorFingerprint: DIGEST }],
            userActionId: "action",
        });
        await client.resetWatchedScanIntent({
            expectedRevision: 1,
            expectedSettingFingerprint: DIGEST,
            userActionId: "action",
        });
        await client.listEnvironments(["linux"]);
        const probeUpdates: unknown[] = [];
        await client.probeGlobal(["CLAUDECODE"], [ENVIRONMENT], "global-installation-token", (update) =>
            probeUpdates.push(update),
        );
        await client.probeProject(["CLAUDECODE"], [ENVIRONMENT], "project-token", "project-installation-token");
        await client.probeDirectory(["CLAUDECODE"], [ENVIRONMENT], "source-token", "directory-installation-token");
        await client.readSources({
            probeToken: "probe-token",
            selections: [{ probeResultRowId: "result-1", sourceRootRowIds: ["source-new"] }],
        });
        await client.previewImport({ readToken: "read-token" });
        await client.getImportPreviewDetail({ previewToken: "preview-token", candidateId: "candidate-1" });
        await client.cancelImportPreview({ previewToken: "preview-token" });
        await client.acceptImportBatch({
            previewToken: "preview-token",
            expectedSnapshotFingerprint: DIGEST,
            decisions: [
                {
                    candidateId: "candidate-1",
                    action: "create_asset",
                    freshness: { freshnessAction: "require_current_source" },
                    promotion: { promotionAction: "import_only", userActionId: "action" },
                    callableBindings: [],
                },
            ],
        });

        expect(request.mock.calls.map(([method]) => method)).toEqual([
            "adapter_provider.list",
            "adapter_enablement.get",
            "adapter_enablement.replace",
            "watched_scan_intent.get",
            "watched_scan_intent.replace",
            "watched_scan_intent.reset",
            "environment.list",
            "import_preview.detail",
            "import_preview.cancel",
        ]);
        expect(start.mock.calls.map(([method]) => method)).toEqual([
            "adapter.probe",
            "adapter.probe",
            "adapter.probe",
            "adapter.read",
            "import.preview",
            "import.accept_batch",
        ]);
        expect(probeUpdates).toEqual([
            { status: "accepted", operation: "adapter.probe", operationId: "operation-1" },
            {
                status: "progress",
                operation: "adapter.probe",
                operationId: "operation-1",
                sequence: 1,
                progress: {
                    stage: "provider_probe",
                    completedUnits: 1,
                    totalUnits: 1,
                    adapterId: "CLAUDECODE",
                    environment: ENVIRONMENT,
                    outcome: "complete",
                    elapsedMilliseconds: 125,
                },
            },
        ]);
        expect(start.mock.calls[0]).toEqual([
            "adapter.probe",
            {
                adapterIds: ["CLAUDECODE"],
                environments: [ENVIRONMENT],
                authorization: { scope: "global" },
                installationRootSelectionToken: "global-installation-token",
            },
        ]);
        expect(start.mock.calls[1]).toEqual([
            "adapter.probe",
            {
                adapterIds: ["CLAUDECODE"],
                environments: [ENVIRONMENT],
                authorization: { scope: "project", localPathSelectionToken: "project-token" },
                installationRootSelectionToken: "project-installation-token",
            },
        ]);
        expect(start.mock.calls[2]).toEqual([
            "adapter.probe",
            {
                adapterIds: ["CLAUDECODE"],
                environments: [ENVIRONMENT],
                authorization: { scope: "directory", localPathSelectionToken: "source-token" },
                installationRootSelectionToken: "directory-installation-token",
            },
        ]);
    });
});
