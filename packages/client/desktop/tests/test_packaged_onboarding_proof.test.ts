import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL } from "../src/bridge/desktop-bridge";
import { type BrowserProtocolPort, MessagePortClientTransport } from "../src/renderer/client";
import {
    installPackagedOnboardingProofListener,
    provePackagedOnboardingImport,
    runPackagedOnboardingImportProof,
} from "../src/renderer/client/packaged-onboarding-proof";

const ASSET_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_ID = "00000000-0000-4000-8000-000000000002";
const FINGERPRINT = "a".repeat(64);
const AVAILABLE_OPERATIONS = Object.freeze([
    "project.list",
    "asset.list",
    "asset.get",
    "asset_version.get",
    "asset_library.kind_counts",
    "asset_library.page",
    "asset_version.list",
    "asset_version.file_children",
    "watched_scan_intent.get",
] as const satisfies readonly ProtocolOperationName[]);

function assetSummary(kind: "Guidance" | "Skill" = "Guidance") {
    return {
        assetId: ASSET_ID,
        kind,
        scope: "global" as const,
        scopePath: "",
        displayName: "Global guidance",
        displayDescription: "Packaged onboarding fixture",
        currentVersionId: VERSION_ID,
        currentRevision: 1,
        currentFingerprint: FINGERPRINT,
        currentVersionStatus: "complete" as const,
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
    };
}

function proofConnection(candidateStatus: "importable" | "blocked" = "importable", platform: "linux" | "win32" = "win32") {
    let imported = false;
    let enabled = false;
    const calls: string[] = [];
    const initialize = vi.fn(async () => ({
        protocolVersion: 1 as const,
        hostInstanceId: "host",
        availableOperations: AVAILABLE_OPERATIONS,
    }));
    const request = vi.fn(async (method: string, params: unknown) => {
        calls.push(method);
        switch (method) {
            case "asset.list":
                return {
                    status: "complete",
                    value: {
                        assets: imported ? [assetSummary()] : [],
                    },
                    diagnostics: [],
                };
            case "adapter_provider.list":
                return {
                    status: "complete",
                    value: { providers: [{ adapterId: "CLAUDECODE" }] },
                    diagnostics: [],
                };
            case "adapter_enablement.get":
                return {
                    status: "complete",
                    value: {
                        revision: 0,
                        settingFingerprint: FINGERPRINT,
                        enabledAdapterIds: enabled ? ["CLAUDECODE"] : [],
                    },
                    diagnostics: [],
                };
            case "adapter_enablement.replace":
                enabled = true;
                expect(params).toMatchObject({
                    expectedRevision: 0,
                    expectedSettingFingerprint: FINGERPRINT,
                    enabledAdapterIds: ["CLAUDECODE"],
                });
                return {
                    status: "complete",
                    value: { revision: 1, settingFingerprint: FINGERPRINT, enabledAdapterIds: ["CLAUDECODE"] },
                    diagnostics: [],
                };
            case "environment.list":
                expect(params).toEqual({ platforms: ["win32", "darwin", "linux", "wsl"] });
                return {
                    status: "complete",
                    value: {
                        environments: [
                            {
                                environment: {
                                    platform,
                                    platformInstanceId: "desktop-local",
                                },
                                displayName: `Local ${platform}`,
                            },
                        ],
                    },
                    diagnostics: [],
                };
            case "project.list":
                return { status: "complete", value: { projects: [] }, diagnostics: [] };
            case "watched_scan_intent.get":
                return {
                    status: "complete",
                    value: {
                        configVersion: 1,
                        settingId: "watched_scan_intent_v1",
                        revision: 0,
                        environments: [],
                        updatedAt: 0,
                        settingFingerprint: FINGERPRINT,
                    },
                    diagnostics: [],
                };
            case "asset.get":
                return {
                    status: "complete",
                    value: { found: true, value: { ...assetSummary(), versionIds: [VERSION_ID] } },
                    diagnostics: [],
                };
            case "asset_library.kind_counts":
                return {
                    status: "complete",
                    value: {
                        counts: [
                            { kind: "Guidance", count: imported ? 1 : 0 },
                            { kind: "Rule", count: 0 },
                            { kind: "Workflow", count: 0 },
                            { kind: "Skill", count: 0 },
                            { kind: "Subagent", count: 0 },
                            { kind: "Memory", count: 0 },
                        ],
                    },
                    diagnostics: [],
                };
            case "asset_library.page":
                return {
                    status: "complete",
                    value: { assets: imported ? [assetSummary()] : [], totalCount: imported ? 1 : 0, hasMore: false },
                    diagnostics: [],
                };
            case "asset_version.list":
                return {
                    status: "complete",
                    value: {
                        found: true,
                        value: {
                            versions: [
                                {
                                    assetId: ASSET_ID,
                                    versionId: VERSION_ID,
                                    revision: 1,
                                    status: "complete",
                                    fingerprint: FINGERPRINT,
                                    originAuthorityFingerprint: FINGERPRINT,
                                    versionCanonicalContentFingerprint: FINGERPRINT,
                                    changeKind: "create",
                                    sourceVersionId: "",
                                    sourceDeploymentId: "",
                                    changeNote: "",
                                    fileCount: 0,
                                    createdAt: 1,
                                },
                            ],
                            totalCount: 1,
                            hasMore: false,
                        },
                    },
                    diagnostics: [],
                };
            case "asset_version.file_children":
                return {
                    status: "complete",
                    value: { found: true, value: { entries: [], totalCount: 0, hasMore: false } },
                    diagnostics: [],
                };
            case "asset_version.get":
                return {
                    status: "complete",
                    value: {
                        found: true,
                        value: {
                            assetId: ASSET_ID,
                            versionId: VERSION_ID,
                            revision: 1,
                            status: "complete",
                            versionCanonicalContentFingerprint: FINGERPRINT,
                            files: [],
                            createdAt: 1,
                        },
                    },
                    diagnostics: [],
                };
            default:
                throw new Error(`unexpected immediate operation ${method}`);
        }
    });
    const start = vi.fn(async (method: string, params: unknown) => {
        calls.push(method);
        const terminal =
            method === "adapter.probe"
                ? {
                      status: "partial",
                      value: {
                          probeToken: "probe",
                          results: [
                              {
                                  rowId: "probe-row",
                                  adapterId: "CLAUDECODE",
                                  environment: { platform, platformInstanceId: "desktop-local" },
                                  sources: [
                                      {
                                          rowId: "source-row",
                                          rootRole: "config",
                                          sourceDomain: "agent_runtime_private",
                                          accessStatus: "available",
                                      },
                                  ],
                              },
                          ],
                      },
                      diagnostics: [],
                  }
                : method === "adapter.read"
                  ? {
                        status: "complete",
                        value: { readToken: "read", candidateCount: 1, reports: [] },
                        diagnostics: [],
                    }
                  : method === "import.preview"
                    ? {
                          status: "complete",
                          value: {
                              previewToken: "preview",
                              snapshotFingerprint: FINGERPRINT,
                              candidates: [
                                  {
                                      candidateId: "candidate",
                                      kind: "Guidance",
                                      status: candidateStatus,
                                      freshness: "fresh",
                                      callableBindingRequestCount: 0,
                                      callableBindingRequestsTruncated: false,
                                  },
                              ],
                          },
                          diagnostics: [],
                      }
                    : method === "import.accept_batch"
                      ? (() => {
                            imported = true;
                            expect(params).toMatchObject({
                                previewToken: "preview",
                                expectedSnapshotFingerprint: FINGERPRINT,
                                decisions: [
                                    {
                                        candidateId: "candidate",
                                        action: "create_asset",
                                        freshness: { freshnessAction: "require_current_source" },
                                        promotion: { promotionAction: "import_only" },
                                        callableBindings: [],
                                    },
                                ],
                            });
                            return {
                                status: "complete",
                                value: {
                                    items: [
                                        {
                                            status: "complete",
                                            candidateId: "candidate",
                                            version: { assetId: ASSET_ID, versionId: VERSION_ID },
                                        },
                                    ],
                                },
                                diagnostics: [],
                            };
                        })()
                      : (() => {
                            throw new Error(`unexpected long operation ${method}`);
                        })();
        return {
            operationId: `operation-${method}`,
            operation: method,
            terminal: Promise.resolve(terminal),
            terminalSequence: null,
            subscribeProgress: () => () => undefined,
        };
    });
    const connection = {
        state: "created",
        availableOperations: AVAILABLE_OPERATIONS,
        initialize,
        request,
        start,
        subscribeInvalidation: () => () => undefined,
        subscribeClose: () => () => undefined,
        close: vi.fn(),
    } as unknown as ClientConnectionApi;
    return { connection, calls, initialize, request, start };
}

function inertBrowserProtocolPort(): BrowserProtocolPort {
    const port = {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
    return port;
}

describe("packaged onboarding product proof", () => {
    it("uses the real Client operation sequence to import one Guidance asset and never dispatches deployment", async () => {
        const fixture = proofConnection();
        let action = 0;
        await expect(provePackagedOnboardingImport(fixture.connection, () => `user-action-${String(++action)}`)).resolves.toEqual(
            {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
            },
        );
        expect(fixture.calls).toEqual([
            "asset.list",
            "adapter_provider.list",
            "adapter_enablement.get",
            "adapter_enablement.replace",
            "environment.list",
            "adapter.probe",
            "adapter.read",
            "import.preview",
            "import.accept_batch",
            "asset.list",
            "project.list",
            "asset_library.kind_counts",
            "asset_library.page",
            "asset.get",
            "asset_version.list",
            "asset_version.file_children",
        ]);
        expect(fixture.calls.some((operation) => operation.startsWith("deployment."))).toBe(false);
    });

    it("uses the Host-declared local Desktop platform instead of assuming Windows", async () => {
        const fixture = proofConnection("importable", "linux");
        await expect(provePackagedOnboardingImport(fixture.connection, () => "user-action")).resolves.toEqual({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
        });
        expect(fixture.start).toHaveBeenCalledWith(
            "adapter.probe",
            expect.objectContaining({
                environments: [{ platform: "linux", platformInstanceId: "desktop-local" }],
            }),
        );
    });

    it("refuses a blocked candidate before import acceptance", async () => {
        const fixture = proofConnection("blocked");
        await expect(provePackagedOnboardingImport(fixture.connection, () => "user-action")).rejects.toThrow(/import_candidate/u);
        expect(fixture.calls).not.toContain("import.accept_batch");
    });

    it("owns the packaged MessagePort connection lifecycle around the exact proof", async () => {
        const fixture = proofConnection();
        const port = inertBrowserProtocolPort();
        const createConnection = vi.fn((transport, options) => {
            expect(transport).toBeInstanceOf(MessagePortClientTransport);
            expect(options.createRequestId()).toBe("packaged-onboarding-1");
            expect(options.createRequestId()).toBe("packaged-onboarding-2");
            return fixture.connection;
        });
        let requestNumber = 0;

        await expect(
            runPackagedOnboardingImportProof(port, createConnection, () => `packaged-onboarding-${String(++requestNumber)}`),
        ).resolves.toEqual({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
        });
        expect(fixture.connection.close).toHaveBeenCalledOnce();
    });

    it("fails the packaged proof when the real Client reports an asynchronous listener error", async () => {
        const fixture = proofConnection();
        const port = inertBrowserProtocolPort();
        const createConnection = vi.fn((_transport, options) => {
            options.reportListenerError(new Error("listener failed"));
            options.reportListenerError(new Error("second listener failure"));
            return fixture.connection;
        });

        await expect(runPackagedOnboardingImportProof(port, createConnection, () => "packaged-onboarding")).rejects.toThrow(
            /client_listener/u,
        );
        expect(fixture.connection.close).toHaveBeenCalledOnce();
    });

    it("runs one renderer-owned proof per exact transferred two-port signal", async () => {
        const success = proofConnection();
        const blocked = proofConnection("blocked");
        const createConnection = vi.fn().mockReturnValueOnce(success.connection).mockReturnValueOnce(blocked.connection);
        const uninstall = installPackagedOnboardingProofListener(window, createConnection, () => "packaged-onboarding");
        const protocolPort = inertBrowserProtocolPort();
        const successResult = inertBrowserProtocolPort();

        window.dispatchEvent(
            new MessageEvent("message", {
                data: PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL,
                source: window,
                ports: [protocolPort as MessagePort, successResult as MessagePort],
            }),
        );
        await vi.waitFor(() => expect(successResult.postMessage).toHaveBeenCalledWith({ status: "complete" }));
        expect(successResult.close).toHaveBeenCalledOnce();

        const failedResult = inertBrowserProtocolPort();
        window.dispatchEvent(
            new MessageEvent("message", {
                data: PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL,
                source: window,
                ports: [protocolPort as MessagePort, failedResult as MessagePort],
            }),
        );
        await vi.waitFor(() =>
            expect(failedResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "import_candidate",
                diagnosticCodes: [],
            }),
        );
        expect(failedResult.close).toHaveBeenCalledOnce();

        const malformedPort = inertBrowserProtocolPort();
        window.dispatchEvent(
            new MessageEvent("message", {
                data: PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL,
                source: window,
                ports: [malformedPort as MessagePort],
            }),
        );
        expect(malformedPort.close).toHaveBeenCalledOnce();
        expect(createConnection).toHaveBeenCalledTimes(2);

        uninstall();
        window.dispatchEvent(
            new MessageEvent("message", {
                data: PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL,
                source: window,
                ports: [protocolPort as MessagePort, inertBrowserProtocolPort() as MessagePort],
            }),
        );
        expect(createConnection).toHaveBeenCalledTimes(2);
    });
});
