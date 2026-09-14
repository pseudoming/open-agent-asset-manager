import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL } from "../src/bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "../src/renderer/client";
import {
    installPackagedAssetLifecycleProofListener,
    provePackagedAssetLifecycle,
    runPackagedAssetLifecycleProof,
} from "../src/renderer/client/packaged-asset-lifecycle-proof";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ASSET_ID = "00000000-0000-4000-8000-000000000002";
const FIRST_VERSION_ID = "00000000-0000-4000-8000-000000000003";
const SECOND_VERSION_ID = "00000000-0000-4000-8000-000000000004";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000005";
const FILE_ID = "00000000-0000-4000-8000-000000000006";
const LATEST_VERSION_ID = "00000000-0000-4000-8000-000000000007";
const UNRELATED_PROJECT_ID = "00000000-0000-4000-8000-000000000008";
const UNRELATED_ASSET_ID = "00000000-0000-4000-8000-000000000009";
const UNRELATED_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000010";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const AVAILABLE_OPERATIONS = Object.freeze([
    "project.list",
    "asset.list",
    "asset.get",
    "deployment.list",
    "asset_library.kind_counts",
    "asset_library.page",
    "asset_version.list",
    "asset_version.file_children",
    "asset_version.file_preview",
    "asset_version.text_page",
    "asset_version.compare",
    "asset_version.export",
    "asset.copy",
    "asset.soft_delete",
    "asset.restore",
    "asset.purge.inspect",
    "asset.purge.commit",
    "state_backup.inspect",
    "state_backup.create",
] as const satisfies readonly ProtocolOperationName[]);

type FailurePoint =
    | "initial_state"
    | "versions"
    | "stale_copy"
    | "create_copies"
    | "catalog_counts"
    | "catalog_page_one"
    | "catalog_page_two"
    | "file_graph"
    | "large_preview"
    | "progressive_text"
    | "compare"
    | "export"
    | "export_existing"
    | "delete"
    | "restore"
    | "backup"
    | "purge_inspect"
    | "purge_stale"
    | "purge_commit"
    | "final_state";

function complete<T>(value: T) {
    return { status: "complete" as const, value, diagnostics: [] };
}

function failed(code: string) {
    return {
        status: "failed" as const,
        error: { code, message: code },
        diagnostics: [{ severity: "error" as const, code, message: code }],
    };
}

function copiedId(index: number): string {
    return `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
}

function fixture(failAt?: FailurePoint) {
    const sourceAsset = {
        assetId: SOURCE_ASSET_ID,
        kind: "Guidance" as const,
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        displayName: "Source guidance",
        displayDescription: "",
        currentVersionId: LATEST_VERSION_ID,
        currentRevision: 3,
        currentFingerprint: DIGEST_C,
        currentVersionStatus: "complete" as const,
        createdAt: 1,
        updatedAt: 2,
        deleted: false,
    };
    const versions = [
        {
            assetId: SOURCE_ASSET_ID,
            versionId: LATEST_VERSION_ID,
            revision: 3,
            status: "complete" as const,
            fingerprint: DIGEST_C,
            originAuthorityFingerprint: DIGEST_A,
            versionCanonicalContentFingerprint: DIGEST_C,
            changeKind: "edit" as const,
            sourceVersionId: SECOND_VERSION_ID,
            sourceDeploymentId: DEPLOYMENT_ID,
            changeNote: "",
            fileCount: 1,
            createdAt: 3,
        },
        {
            assetId: SOURCE_ASSET_ID,
            versionId: SECOND_VERSION_ID,
            revision: 2,
            status: "complete" as const,
            fingerprint: DIGEST_B,
            originAuthorityFingerprint: DIGEST_A,
            versionCanonicalContentFingerprint: DIGEST_B,
            changeKind: "edit" as const,
            sourceVersionId: FIRST_VERSION_ID,
            sourceDeploymentId: DEPLOYMENT_ID,
            changeNote: "",
            fileCount: 1,
            createdAt: 2,
        },
        {
            assetId: SOURCE_ASSET_ID,
            versionId: FIRST_VERSION_ID,
            revision: 1,
            status: "complete" as const,
            fingerprint: DIGEST_A,
            originAuthorityFingerprint: DIGEST_A,
            versionCanonicalContentFingerprint: DIGEST_A,
            changeKind: "extract" as const,
            sourceVersionId: "",
            sourceDeploymentId: "",
            changeNote: "",
            fileCount: 1,
            createdAt: 1,
        },
    ];
    const file = {
        fileId: FILE_ID,
        logicalPath: "AGENTS.md",
        role: "entry" as const,
        mediaType: "text/markdown",
        contentKind: "text" as const,
        contentHash: DIGEST_C,
        byteLength: 120_000,
        executable: false,
    };
    const deployment = {
        deploymentId: DEPLOYMENT_ID,
        subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
        targetRootPath: "C:\\proof\\target",
        deleted: false,
    };
    const unrelatedProject = {
        schemaVersion: 1,
        projectId: UNRELATED_PROJECT_ID,
        rootPath: "C:\\proof\\unrelated-project",
        displayName: "Unrelated Project",
        deleted: false,
        createdAt: 1,
        updatedAt: 2,
    };
    const unrelatedAsset = {
        ...sourceAsset,
        assetId: UNRELATED_ASSET_ID,
        projectId: UNRELATED_PROJECT_ID,
        displayName: "Unrelated guidance",
    };
    const unrelatedDeployment = {
        deploymentId: UNRELATED_DEPLOYMENT_ID,
        subject: { subjectKind: "project" as const, projectId: UNRELATED_PROJECT_ID },
        targetRootPath: "C:\\proof\\unrelated-target",
        deleted: false,
    };
    const copies: Array<typeof sourceAsset> = [];
    let lifecycleDeleted = false;
    let purged = false;
    let exportCalls = 0;
    const listProjects = vi.fn(async () =>
        complete({
            projects:
                failAt === "initial_state"
                    ? []
                    : [
                          unrelatedProject,
                          {
                              schemaVersion: 1,
                              projectId: PROJECT_ID,
                              rootPath: "C:\\proof\\project",
                              displayName: "Project",
                              deleted: false,
                              createdAt: 1,
                              updatedAt: 2,
                          },
                      ],
        }),
    );
    const listAssets = vi.fn(async (params: { readonly projectId?: string } = {}) =>
        complete({
            assets:
                params.projectId === undefined
                    ? [unrelatedAsset, sourceAsset]
                    : params.projectId === PROJECT_ID
                      ? [sourceAsset]
                      : params.projectId === UNRELATED_PROJECT_ID
                        ? [unrelatedAsset]
                        : [],
        }),
    );
    const listDeployments = vi.fn(async () => complete({ deployments: [unrelatedDeployment, deployment] }));
    const listAssetVersions = vi.fn(async () =>
        complete({
            found: true as const,
            value:
                failAt === "versions"
                    ? { versions: [], totalCount: 0, hasMore: false as const }
                    : { versions, totalCount: 3, hasMore: false as const },
        }),
    );
    const copyAsset = vi.fn(async (input: { readonly source: { readonly versionFingerprint: string } }) => {
        if (input.source.versionFingerprint === "0".repeat(64)) {
            return failAt === "stale_copy"
                ? complete({ asset: sourceAsset, version: versions[0], source: {} })
                : failed("asset.copy_stale");
        }
        if (failAt === "create_copies" && copies.length === 0) return failed("asset.copy_failed");
        const asset = {
            ...sourceAsset,
            assetId: copiedId(copies.length),
            scope: "global" as const,
            projectId: "",
            displayName: `Copy ${String(copies.length + 1)}`,
        };
        copies.push(asset);
        return complete({ source: { assetId: SOURCE_ASSET_ID, versionId: LATEST_VERSION_ID }, asset, version: versions[0] });
    });
    const listAssetKindCounts = vi.fn(async () =>
        complete({
            counts: [
                {
                    kind: "Guidance" as const,
                    count: failAt === "catalog_counts" ? copies.length - 1 : copies.length,
                },
            ],
        }),
    );
    const queryAssetLibrary = vi.fn(async (input: { readonly cursor?: string }) => {
        if (purged) {
            return complete({
                assets: copies.filter(({ assetId }) => assetId !== copiedId(0)).slice(0, 50),
                totalCount: failAt === "final_state" ? 49 : 50,
                hasMore: false as const,
            });
        }
        if (input.cursor === undefined) {
            return complete({
                assets: failAt === "catalog_page_one" ? copies.slice(0, 49) : copies.slice(0, 50),
                totalCount: copies.length,
                hasMore: true as const,
                nextCursor: "page-two",
            });
        }
        return complete({
            assets: failAt === "catalog_page_two" ? [] : copies.slice(50),
            totalCount: copies.length,
            hasMore: false as const,
        });
    });
    const listAssetVersionFileChildren = vi.fn(async () =>
        complete({
            found: true as const,
            value: {
                entries: failAt === "file_graph" ? [] : [{ entryKind: "file" as const, relativeName: "AGENTS.md", file }],
                totalCount: failAt === "file_graph" ? 0 : 1,
                hasMore: false as const,
            },
        }),
    );
    const readAssetVersionFilePreview = vi.fn(async () =>
        complete({
            found: true as const,
            value:
                failAt === "large_preview"
                    ? { previewKind: "text" as const, file, text: "small", lineCount: 1 }
                    : {
                          previewKind: "large_text" as const,
                          file,
                          limitReason: "line_limit" as const,
                          observedLineCount: 6_004,
                      },
        }),
    );
    const readAssetVersionTextPage = vi.fn(async (input: { readonly cursor?: string }) =>
        complete({
            found: true as const,
            value:
                input.cursor === undefined
                    ? {
                          file,
                          text: "first",
                          loadedByteStart: failAt === "progressive_text" ? 1 : 0,
                          loadedByteEnd: 60_000,
                          totalBytes: 120_000,
                          firstLine: 1,
                          lastLine: 3_000,
                          totalLines: 6_004,
                          hasMore: true as const,
                          nextCursor: "second",
                      }
                    : {
                          file,
                          text: "second",
                          loadedByteStart: 60_000,
                          loadedByteEnd: 120_000,
                          totalBytes: 120_000,
                          firstLine: 3_001,
                          lastLine: 6_004,
                          totalLines: 6_004,
                          hasMore: false as const,
                      },
        }),
    );
    const compareAssetVersions = vi.fn(async () =>
        failAt === "compare"
            ? failed("asset.compare_failed")
            : complete({
                  schemaVersion: 1 as const,
                  assetId: SOURCE_ASSET_ID,
                  left: { versionId: FIRST_VERSION_ID, versionFingerprint: DIGEST_A },
                  right: { versionId: LATEST_VERSION_ID, versionFingerprint: DIGEST_C },
                  files: [
                      {
                          logicalPath: "AGENTS.md",
                          changeKind: "modified" as const,
                          left: { state: "present" as const, file: { ...file, contentHash: DIGEST_A } },
                          right: { state: "present" as const, file },
                      },
                  ],
                  selectedFile: {
                      comparisonKind: "text" as const,
                      logicalPath: "AGENTS.md",
                      left: { state: "present" as const, file: { ...file, contentHash: DIGEST_A } },
                      right: { state: "present" as const, file },
                      algorithm: "myers" as const,
                      leftLineCount: 6_004,
                      rightLineCount: 6_004,
                      hunks: [
                          {
                              leftStart: 1,
                              leftLineCount: 1,
                              rightStart: 1,
                              rightLineCount: 1,
                              lines: [],
                          },
                      ],
                  },
              }),
    );
    const exportAssetVersion = vi.fn(async () => {
        exportCalls += 1;
        if (exportCalls === 1) {
            return failAt === "export"
                ? failed("asset.export_failed")
                : complete({
                      assetId: SOURCE_ASSET_ID,
                      versionId: LATEST_VERSION_ID,
                      versionFingerprint: DIGEST_C,
                      archiveIndexFingerprint: DIGEST_A,
                      archiveByteLength: 100,
                  });
        }
        return failAt === "export_existing"
            ? complete({
                  assetId: SOURCE_ASSET_ID,
                  versionId: LATEST_VERSION_ID,
                  versionFingerprint: DIGEST_C,
                  archiveIndexFingerprint: DIGEST_A,
                  archiveByteLength: 100,
              })
            : failed("asset.export_exists");
    });
    const softDeleteAsset = vi.fn(async () => {
        if (failAt === "delete") return failed("asset.delete_failed");
        lifecycleDeleted = true;
        return complete({ ...copies[0], deleted: true });
    });
    const restoreAsset = vi.fn(async () => {
        if (failAt === "restore") return failed("asset.restore_failed");
        lifecycleDeleted = false;
        return complete({ ...copies[0], deleted: false });
    });
    const inspectStateBackup = vi.fn(async () =>
        failAt === "backup" ? failed("state.backup_failed") : complete({ backupReviewToken: "backup-review" }),
    );
    const createStateBackup = vi.fn(async () => complete({ backupId: "backup" }));
    const inspectAssetPurge = vi.fn(async () =>
        failAt === "purge_inspect"
            ? failed("asset.purge_inspect_failed")
            : complete({
                  schemaVersion: 1 as const,
                  action: "purge" as const,
                  assetId: copiedId(0),
                  assetManifestFingerprint: DIGEST_A,
                  assetDirectoryIdentityFingerprint: DIGEST_B,
                  kind: "Guidance" as const,
                  scope: "global" as const,
                  projectId: "",
                  scopePath: "",
                  displayName: "Copy 1",
                  versionCount: 1,
                  promotionGrantCount: 0,
              }),
    );
    const commitAssetPurge = vi.fn(async (input: { readonly preparation: { readonly assetManifestFingerprint: string } }) => {
        if (input.preparation.assetManifestFingerprint === "0".repeat(64)) {
            return failAt === "purge_stale"
                ? complete({ assetId: copiedId(0), recycled: true as const })
                : failed("asset.purge_stale");
        }
        if (failAt === "purge_commit") return failed("asset.purge_failed");
        if (!lifecycleDeleted) return failed("asset.not_deleted");
        purged = true;
        return complete({ assetId: copiedId(0), recycled: true as const });
    });
    const getAsset = vi.fn(async ({ assetId }: { readonly assetId: string }) =>
        complete({ found: assetId === copiedId(0) && purged ? (false as const) : (true as const), value: sourceAsset }),
    );
    const client = {
        availableOperations: AVAILABLE_OPERATIONS,
        supportsOperation: (operation: ProtocolOperationName) => AVAILABLE_OPERATIONS.includes(operation as never),
        listProjects,
        listAssets,
        listDeployments,
        listAssetVersions,
        copyAsset,
        listAssetKindCounts,
        queryAssetLibrary,
        listAssetVersionFileChildren,
        readAssetVersionFilePreview,
        readAssetVersionTextPage,
        compareAssetVersions,
        exportAssetVersion,
        softDeleteAsset,
        restoreAsset,
        inspectStateBackup,
        createStateBackup,
        inspectAssetPurge,
        commitAssetPurge,
        getAsset,
    } as unknown as DesktopApplicationClientApi;
    return { client, copies, copyAsset, queryAssetLibrary, exportAssetVersion, commitAssetPurge };
}

function operation(terminal: unknown) {
    return {
        operationId: "operation",
        operation: "fixture",
        terminal: Promise.resolve(terminal),
        terminalSequence: null,
        subscribeProgress: () => () => undefined,
    };
}

function connectionFrom(client: DesktopApplicationClientApi, protocolVersion = 1): ClientConnectionApi {
    const immediate = new Set([
        "project.list",
        "asset.list",
        "asset.get",
        "deployment.list",
        "asset_library.kind_counts",
        "asset_library.page",
        "asset_version.list",
        "asset_version.file_children",
        "asset_version.file_preview",
        "asset_version.text_page",
        "asset.copy",
        "asset.soft_delete",
        "asset.restore",
        "asset.purge.inspect",
    ]);
    const request = vi.fn(async (method: string, params: unknown) => {
        if (!immediate.has(method)) throw new Error(`unexpected request ${method}`);
        const names: Record<string, keyof DesktopApplicationClientApi> = {
            "project.list": "listProjects",
            "asset.list": "listAssets",
            "asset.get": "getAsset",
            "deployment.list": "listDeployments",
            "asset_library.kind_counts": "listAssetKindCounts",
            "asset_library.page": "queryAssetLibrary",
            "asset_version.list": "listAssetVersions",
            "asset_version.file_children": "listAssetVersionFileChildren",
            "asset_version.file_preview": "readAssetVersionFilePreview",
            "asset_version.text_page": "readAssetVersionTextPage",
            "asset.copy": "copyAsset",
            "asset.soft_delete": "softDeleteAsset",
            "asset.restore": "restoreAsset",
            "asset.purge.inspect": "inspectAssetPurge",
        };
        const member = client[names[method] as keyof DesktopApplicationClientApi] as (input: unknown) => unknown;
        return member.call(client, params);
    });
    const start = vi.fn(async (method: string, params: unknown) => {
        const names: Record<string, keyof DesktopApplicationClientApi> = {
            "asset_version.compare": "compareAssetVersions",
            "asset_version.export": "exportAssetVersion",
            "asset.purge.commit": "commitAssetPurge",
            "state_backup.inspect": "inspectStateBackup",
            "state_backup.create": "createStateBackup",
        };
        const member = client[names[method] as keyof DesktopApplicationClientApi] as (input: unknown) => unknown;
        return operation(await member.call(client, params));
    });
    return {
        availableOperations: AVAILABLE_OPERATIONS,
        initialize: vi.fn(async () => ({ protocolVersion, availableOperations: AVAILABLE_OPERATIONS })),
        request,
        start,
        close: vi.fn(),
    } as unknown as ClientConnectionApi;
}

function browserPort(
    existingExportToken?: string,
    controlFailure?: "malformed_reply" | "closed_before_reply" | "post_failed",
): BrowserProtocolPort {
    const listeners = new Map<string, Set<(event: Event | MessageEvent<unknown>) => void>>();
    const postMessage = vi.fn((message: unknown) => {
        if (
            message !== null &&
            typeof message === "object" &&
            "control" in message &&
            message.control === "request_existing_export_token"
        ) {
            if (controlFailure === "post_failed") throw new Error("control post failed");
            if (controlFailure === "closed_before_reply") {
                queueMicrotask(() => {
                    for (const listener of listeners.get("close") ?? []) listener(new Event("close"));
                });
            } else if (controlFailure === "malformed_reply") {
                queueMicrotask(() => {
                    for (const listener of listeners.get("message") ?? []) {
                        listener({ data: { control: "unexpected" } } as MessageEvent<unknown>);
                    }
                });
            } else if (existingExportToken !== undefined) {
                queueMicrotask(() => {
                    for (const listener of listeners.get("message") ?? []) {
                        listener({
                            data: { control: "existing_export_token", existingExportToken },
                        } as MessageEvent<unknown>);
                    }
                });
            }
        }
    });
    return {
        postMessage,
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn((type: string, listener: (event: Event | MessageEvent<unknown>) => void) => {
            const registered = listeners.get(type) ?? new Set();
            registered.add(listener);
            listeners.set(type, registered);
        }) as BrowserProtocolPort["addEventListener"],
        removeEventListener: vi.fn((type: string, listener: (event: Event | MessageEvent<unknown>) => void) => {
            listeners.get(type)?.delete(listener);
        }) as BrowserProtocolPort["removeEventListener"],
    };
}

const REQUEST = Object.freeze({
    exportToken: "export-token",
    subject: {
        projectId: PROJECT_ID,
        assetId: SOURCE_ASSET_ID,
        versionId: LATEST_VERSION_ID,
        deploymentId: DEPLOYMENT_ID,
    },
});

describe("packaged Asset lifecycle renderer proof", () => {
    it("proves the large catalog, large text, copy, export and backup-gated purge journey", async () => {
        const value = fixture();
        await expect(
            provePackagedAssetLifecycle(
                value.client,
                REQUEST,
                async () => "existing-token",
                () => "user-action",
            ),
        ).resolves.toBeUndefined();
        expect(value.copyAsset).toHaveBeenCalledTimes(52);
        expect(value.copies).toHaveLength(51);
        expect(value.queryAssetLibrary).toHaveBeenCalledTimes(3);
        expect(value.exportAssetVersion).toHaveBeenCalledTimes(2);
        expect(value.commitAssetPurge).toHaveBeenCalledTimes(2);
    });

    it.each([
        "initial_state",
        "versions",
        "stale_copy",
        "create_copies",
        "catalog_counts",
        "catalog_page_one",
        "catalog_page_two",
        "file_graph",
        "large_preview",
        "progressive_text",
        "compare",
        "export",
        "export_existing",
        "delete",
        "restore",
        "backup",
        "purge_inspect",
        "purge_stale",
        "purge_commit",
        "final_state",
    ] as const)("fails closed at %s", async (failurePoint) => {
        await expect(
            provePackagedAssetLifecycle(
                fixture(failurePoint).client,
                REQUEST,
                async () => "existing-token",
                () => "action",
            ),
        ).rejects.toThrow(new RegExp(failurePoint, "u"));
    });

    it("requires the exact operation set, protocol version and clean listener delivery", async () => {
        const connection = connectionFrom(fixture().client);
        const factory = vi.fn((transport) => {
            expect(transport).toBeInstanceOf(MessagePortClientTransport);
            return connection;
        }) as unknown as typeof createClientConnection;
        await expect(
            runPackagedAssetLifecycleProof(
                browserPort(),
                REQUEST,
                factory,
                () => "request",
                async () => "existing-token",
            ),
        ).resolves.toBeUndefined();
        expect(connection.close).toHaveBeenCalledOnce();

        const wrongVersion = connectionFrom(fixture().client, 2);
        await expect(
            runPackagedAssetLifecycleProof(
                browserPort(),
                REQUEST,
                vi.fn(() => wrongVersion) as unknown as typeof createClientConnection,
                () => "request",
                async () => "existing-token",
            ),
        ).rejects.toThrow(/initialize/u);

        const missingOperation = connectionFrom(fixture().client);
        missingOperation.initialize = vi.fn(async () => ({
            protocolVersion: 1,
            availableOperations: ["project.list"] as ProtocolOperationName[],
        }));
        await expect(
            runPackagedAssetLifecycleProof(
                browserPort(),
                REQUEST,
                vi.fn(() => missingOperation) as unknown as typeof createClientConnection,
                () => "request",
                async () => "existing-token",
            ),
        ).rejects.toThrow(/available_operations/u);

        const listenerConnection = connectionFrom(fixture().client);
        const listenerFactory = vi.fn((_transport, options) => {
            options.reportListenerError(new Error("listener failed"));
            return listenerConnection;
        }) as unknown as typeof createClientConnection;
        await expect(
            runPackagedAssetLifecycleProof(
                browserPort(),
                REQUEST,
                listenerFactory,
                () => "request",
                async () => "existing-token",
            ),
        ).rejects.toThrow(/client_listener/u);
    });

    it("routes only the exact signal and returns typed renderer evidence", async () => {
        const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
        const browserWindow = {
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) =>
                listeners.push(listener),
            ),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        const factory = vi
            .fn()
            .mockReturnValueOnce(connectionFrom(fixture().client))
            .mockReturnValueOnce(connectionFrom(fixture("export").client)) as unknown as typeof createClientConnection;
        const dispose = installPackagedAssetLifecycleProofListener(browserWindow, factory, () => "request");
        const receive = listeners[0];
        if (receive === undefined) throw new Error("listener was not installed");

        receive({
            source: {},
            data: { signal: PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL },
            ports: [],
        } as unknown as MessageEvent);
        receive({ source: browserWindow, data: null, ports: [] } as unknown as MessageEvent);
        receive({ source: browserWindow, data: { signal: "other" }, ports: [] } as unknown as MessageEvent);

        const invalidPorts = [browserPort(), browserPort(), browserPort()];
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL },
            ports: invalidPorts as unknown as MessagePort[],
        } as unknown as MessageEvent);
        for (const port of invalidPorts) expect(port.close).toHaveBeenCalledOnce();

        const malformedProtocol = browserPort();
        const malformedResult = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL, request: { exportToken: "" } },
            ports: [malformedProtocol as MessagePort, malformedResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(malformedResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "unexpected",
                diagnosticCodes: [],
            }),
        );

        const successProtocol = browserPort();
        const successResult = browserPort("existing-token");
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL, request: REQUEST },
            ports: [successProtocol as MessagePort, successResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() => expect(successResult.postMessage).toHaveBeenCalledWith({ status: "complete" }));

        const failedProtocol = browserPort();
        const failedResult = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL, request: REQUEST },
            ports: [failedProtocol as MessagePort, failedResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(failedResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "export",
                diagnosticCodes: ["asset.export_failed"],
            }),
        );

        dispose();
        expect(browserWindow.removeEventListener).toHaveBeenCalledOnce();
    });

    it.each([
        "malformed_reply",
        "closed_before_reply",
        "post_failed",
    ] as const)("fails closed when the one-shot export-token control channel reports %s", async (controlFailure) => {
        const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
        const browserWindow = {
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) =>
                listeners.push(listener),
            ),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        const resultPort = browserPort(undefined, controlFailure);
        const dispose = installPackagedAssetLifecycleProofListener(
            browserWindow,
            vi.fn(() => connectionFrom(fixture().client)) as unknown as typeof createClientConnection,
            () => "request",
        );
        const receive = listeners[0];
        if (receive === undefined) throw new Error("listener was not installed");

        receive({
            source: browserWindow,
            data: { signal: PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL, request: REQUEST },
            ports: [browserPort() as MessagePort, resultPort as MessagePort],
        } as unknown as MessageEvent);

        await vi.waitFor(() =>
            expect(resultPort.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "export_existing",
                diagnosticCodes: [],
            }),
        );
        expect(resultPort.close).toHaveBeenCalledOnce();
        dispose();
    });
});
