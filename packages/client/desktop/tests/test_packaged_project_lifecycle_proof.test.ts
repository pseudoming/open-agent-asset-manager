import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL } from "../src/bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "../src/renderer/client";
import {
    installPackagedProjectLifecycleProofListener,
    provePackagedProjectLifecycle,
    runPackagedProjectLifecycleProof,
} from "../src/renderer/client/packaged-project-lifecycle-proof";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ASSET_ID = "00000000-0000-4000-8000-000000000002";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000003";
const VERSION_ID = "00000000-0000-4000-8000-000000000004";
const SUBJECT = Object.freeze({ projectId: PROJECT_ID, assetId: ASSET_ID, versionId: VERSION_ID, deploymentId: DEPLOYMENT_ID });
const INITIAL_ROOT = "C:\\proof\\source-project";
const REBIND_ROOT = "C:\\proof\\rebind-project";
const TARGET_ROOT = "C:\\proof\\target-project";
const AVAILABLE_OPERATIONS = Object.freeze([
    "project.list",
    "asset.list",
    "deployment.list",
    "project_lifecycle.inspect",
    "project_lifecycle.commit",
    "state_backup.inspect",
    "state_backup.create",
] as const satisfies readonly ProtocolOperationName[]);

function complete(value: unknown) {
    return { status: "complete", value, diagnostics: [] } as const;
}

function failed(code: string) {
    return {
        status: "failed",
        error: { code, message: code },
        diagnostics: [{ severity: "error", code, message: code }],
    } as const;
}

type FailurePoint =
    | "initial_state"
    | "rename_inspect"
    | "rename_commit"
    | "rebind_backup_inspect"
    | "rebind_backup_create"
    | "rebind_inspect"
    | "rebind_commit"
    | "stop_backup_inspect"
    | "stop_backup_create"
    | "stop_inspect"
    | "stop_commit"
    | "restore_inspect"
    | "restore_commit"
    | "final_state";

function fixture(failAt?: FailurePoint) {
    let displayName = "Source Project";
    let rootPath = INITIAL_ROOT;
    let deleted = false;
    let backupNumber = 0;
    let reviewNumber = 0;
    let assetListNumber = 0;
    const reviews = new Map<string, string>();
    const project = () => ({
        schemaVersion: 1,
        projectId: PROJECT_ID,
        rootPath,
        displayName,
        deleted,
        createdAt: 1,
        updatedAt: 2,
    });
    const asset = {
        assetId: ASSET_ID,
        kind: "Guidance",
        scope: "project",
        projectId: PROJECT_ID,
        currentVersionId: VERSION_ID,
    };
    const deployment = {
        deploymentId: DEPLOYMENT_ID,
        subject: { subjectKind: "project", projectId: PROJECT_ID },
        targetRootPath: TARGET_ROOT,
        deleted: false,
    };
    const listProjects = vi.fn(async (params: { readonly includeDeleted?: boolean } = {}) => {
        if (failAt === "initial_state") return complete({ projects: [] });
        const owned = deleted && params.includeDeleted !== true ? [] : [project()];
        return complete({
            projects: [
                {
                    ...project(),
                    projectId: "00000000-0000-4000-8000-000000000101",
                    rootPath: "C:\\proof\\unrelated-project",
                    displayName: "Unrelated Project",
                    deleted: false,
                },
                ...owned,
            ],
        });
    });
    const listAssets = vi.fn(async () => {
        assetListNumber += 1;
        const unrelated = { ...asset, assetId: "00000000-0000-4000-8000-000000000102", projectId: "unrelated" };
        return failAt === "final_state" && assetListNumber === 3
            ? complete({ assets: [unrelated] })
            : complete({ assets: [unrelated, asset] });
    });
    const listDeployments = vi.fn(async () =>
        complete({
            deployments: [
                {
                    ...deployment,
                    deploymentId: "00000000-0000-4000-8000-000000000103",
                    subject: { subjectKind: "project", projectId: "unrelated" },
                },
                deployment,
            ],
        }),
    );
    const inspectStateBackup = vi.fn(async () => {
        backupNumber += 1;
        const point = backupNumber === 1 ? "rebind_backup_inspect" : "stop_backup_inspect";
        return failAt === point ? failed(`proof.${point}`) : complete({ backupReviewToken: `backup:${String(backupNumber)}` });
    });
    const createStateBackup = vi.fn(async () => {
        const point = backupNumber === 1 ? "rebind_backup_create" : "stop_backup_create";
        return failAt === point ? failed(`proof.${point}`) : complete({ backupId: `backup:${String(backupNumber)}` });
    });
    const inspectProjectLifecycle = vi.fn(async (input: { readonly action: string }) => {
        const failure = `${input.action === "stop_managing" ? "stop" : input.action}_inspect` as FailurePoint;
        if (failAt === failure) return failed(`proof.${failure}`);
        reviewNumber += 1;
        const token = `review:${String(reviewNumber)}:${input.action}`;
        reviews.set(token, input.action);
        if (input.action === "rename") {
            return complete({
                schemaVersion: 1,
                action: "rename",
                projectLifecycleReviewToken: token,
                projectId: PROJECT_ID,
                projectAuthorityFingerprint: `sha256:${"0".repeat(64)}`,
                rootPath,
                currentDisplayName: displayName,
                nextDisplayName: "OAAM packaged Project lifecycle",
            });
        }
        if (input.action === "rebind") {
            return complete({
                schemaVersion: 1,
                action: "rebind",
                projectLifecycleReviewToken: token,
                projectId: PROJECT_ID,
                projectAuthorityFingerprint: `sha256:${"1".repeat(64)}`,
                displayName,
                currentRootPath: rootPath,
                nextRootPath: REBIND_ROOT,
            });
        }
        if (input.action === "restore") {
            return complete({
                schemaVersion: 1,
                action: "restore",
                projectLifecycleReviewToken: token,
                projectId: PROJECT_ID,
                projectAuthorityFingerprint: `sha256:${"2".repeat(64)}`,
                displayName,
                rootPath,
                rootAccessState: "available",
            });
        }
        return complete({
            schemaVersion: 1,
            action: "stop_managing",
            projectLifecycleReviewToken: token,
            projectId: PROJECT_ID,
            projectAuthorityFingerprint: `sha256:${"3".repeat(64)}`,
            displayName,
            rootPath,
        });
    });
    const commitProjectLifecycle = vi.fn(async (input: { readonly projectLifecycleReviewToken: string }) => {
        const action = reviews.get(input.projectLifecycleReviewToken);
        const point = `${action === "stop_managing" ? "stop" : action}_commit` as FailurePoint;
        if (failAt === point) return failed(`proof.${point}`);
        if (action === "rename") displayName = "OAAM packaged Project lifecycle";
        else if (action === "rebind") rootPath = REBIND_ROOT;
        else if (action === "stop_managing") deleted = true;
        else if (action === "restore") deleted = false;
        else return failed("proof.review_missing");
        return complete(project());
    });
    const client = {
        availableOperations: AVAILABLE_OPERATIONS,
        supportsOperation: (operation: ProtocolOperationName) => AVAILABLE_OPERATIONS.includes(operation as never),
        listProjects,
        listAssets,
        listDeployments,
        inspectStateBackup,
        createStateBackup,
        inspectProjectLifecycle,
        commitProjectLifecycle,
    } as unknown as DesktopApplicationClientApi;
    return {
        client,
        listProjects,
        listAssets,
        listDeployments,
        inspectStateBackup,
        createStateBackup,
        inspectProjectLifecycle,
        commitProjectLifecycle,
    };
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

function connectionFrom(client: DesktopApplicationClientApi, options: { readonly protocolVersion?: number } = {}) {
    const request = vi.fn(async (method: string, params: unknown) => {
        if (method === "project.list") return client.listProjects(params as never);
        if (method === "asset.list") return client.listAssets(params as never);
        if (method === "deployment.list") return client.listDeployments(params as never);
        throw new Error(`unexpected request ${method}`);
    });
    const start = vi.fn(async (method: string, params: unknown) => {
        if (method === "project_lifecycle.inspect") return operation(await client.inspectProjectLifecycle(params as never));
        if (method === "project_lifecycle.commit") return operation(await client.commitProjectLifecycle(params as never));
        if (method === "state_backup.inspect") return operation(await client.inspectStateBackup(params as never));
        if (method === "state_backup.create") return operation(await client.createStateBackup(params as never));
        throw new Error(`unexpected operation ${method}`);
    });
    return {
        availableOperations: AVAILABLE_OPERATIONS,
        initialize: vi.fn(async () => ({
            protocolVersion: options.protocolVersion ?? 1,
            availableOperations: AVAILABLE_OPERATIONS,
        })),
        request,
        start,
        close: vi.fn(),
    } as unknown as ClientConnectionApi;
}

function browserPort(): BrowserProtocolPort {
    return {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

describe("packaged Project lifecycle renderer proof", () => {
    it("preserves one Project, Asset and Deployment through all four lifecycle branches", async () => {
        const value = fixture();
        await expect(
            provePackagedProjectLifecycle(
                value.client,
                { rebindRootToken: "rebind-token", subject: SUBJECT },
                () => "user-action",
            ),
        ).resolves.toBeUndefined();
        expect(value.inspectProjectLifecycle.mock.calls.map(([input]) => input.action)).toEqual([
            "rename",
            "rebind",
            "stop_managing",
            "restore",
        ]);
        expect(value.inspectStateBackup).toHaveBeenCalledTimes(2);
        expect(value.createStateBackup).toHaveBeenCalledTimes(2);
        expect(value.listProjects).toHaveBeenCalledWith({ includeDeleted: true });
        expect(value.listDeployments).toHaveBeenCalledWith({
            subject: { subjectKind: "project", projectId: PROJECT_ID },
        });
    });

    it.each([
        ["initial_state", "initial_state"],
        ["rename_inspect", "rename_inspect"],
        ["rename_commit", "rename_commit"],
        ["rebind_backup_inspect", "rebind_backup"],
        ["rebind_backup_create", "rebind_backup"],
        ["rebind_inspect", "rebind_inspect"],
        ["rebind_commit", "rebind_commit"],
        ["stop_backup_inspect", "stop_backup"],
        ["stop_backup_create", "stop_backup"],
        ["stop_inspect", "stop_inspect"],
        ["stop_commit", "stop_commit"],
        ["restore_inspect", "restore_inspect"],
        ["restore_commit", "restore_commit"],
        ["final_state", "final_state"],
    ] as const)("fails closed at %s", async (failurePoint, expectedStep) => {
        await expect(
            provePackagedProjectLifecycle(
                fixture(failurePoint).client,
                { rebindRootToken: "rebind-token", subject: SUBJECT },
                () => "action",
            ),
        ).rejects.toThrow(new RegExp(expectedStep, "u"));
    });

    it("requires the exact operation set, valid initialization and clean listener delivery", async () => {
        const successful = fixture();
        const connection = connectionFrom(successful.client);
        let request = 0;
        const factory = vi.fn((transport, options) => {
            expect(transport).toBeInstanceOf(MessagePortClientTransport);
            expect(options.createRequestId()).toBe(`request-${String(++request)}`);
            return connection;
        }) as unknown as typeof createClientConnection;
        await expect(
            runPackagedProjectLifecycleProof(
                browserPort(),
                { rebindRootToken: "rebind-token", subject: SUBJECT },
                factory,
                () => `request-${String(request + 1)}`,
            ),
        ).resolves.toBeUndefined();
        expect(connection.close).toHaveBeenCalledOnce();

        const wrongVersion = connectionFrom(fixture().client, { protocolVersion: 2 });
        await expect(
            runPackagedProjectLifecycleProof(
                browserPort(),
                { rebindRootToken: "token", subject: SUBJECT },
                vi.fn(() => wrongVersion) as unknown as typeof createClientConnection,
                () => "request",
            ),
        ).rejects.toThrow(/initialize/u);

        const missingOperation = connectionFrom(fixture().client);
        missingOperation.initialize = vi.fn(async () => ({
            protocolVersion: 1,
            availableOperations: ["project.list"] as ProtocolOperationName[],
        }));
        await expect(
            runPackagedProjectLifecycleProof(
                browserPort(),
                { rebindRootToken: "token", subject: SUBJECT },
                vi.fn(() => missingOperation) as unknown as typeof createClientConnection,
                () => "request",
            ),
        ).rejects.toThrow(/available_operations/u);

        const listenerConnection = connectionFrom(fixture().client);
        const listenerFactory = vi.fn((_transport, options) => {
            options.reportListenerError(new Error("listener failed"));
            options.reportListenerError(new Error("ignored second failure"));
            return listenerConnection;
        }) as unknown as typeof createClientConnection;
        await expect(
            runPackagedProjectLifecycleProof(
                browserPort(),
                { rebindRootToken: "token", subject: SUBJECT },
                listenerFactory,
                () => "request",
            ),
        ).rejects.toThrow(/client_listener/u);
    });

    it("routes only the exact signal and returns bounded typed renderer evidence", async () => {
        const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
        const browserWindow = {
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) =>
                listeners.push(listener),
            ),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        const successConnection = connectionFrom(fixture().client);
        const failedConnection = connectionFrom(fixture("rebind_commit").client);
        const factory = vi
            .fn()
            .mockReturnValueOnce(successConnection)
            .mockReturnValueOnce(failedConnection) as unknown as typeof createClientConnection;
        const dispose = installPackagedProjectLifecycleProofListener(browserWindow, factory, () => "request");
        const receive = listeners[0];
        if (receive === undefined) throw new Error("listener was not installed");

        receive({
            source: {},
            data: { signal: PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL },
            ports: [],
        } as unknown as MessageEvent);
        receive({ source: browserWindow, data: null, ports: [] } as unknown as MessageEvent);
        receive({ source: browserWindow, data: { signal: "other" }, ports: [] } as unknown as MessageEvent);

        const tooFew = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL },
            ports: [tooFew as MessagePort],
        } as unknown as MessageEvent);
        expect(tooFew.close).toHaveBeenCalledOnce();

        const tooMany = [browserPort(), browserPort(), browserPort()];
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL },
            ports: tooMany as unknown as MessagePort[],
        } as unknown as MessageEvent);
        for (const port of tooMany) expect(port.close).toHaveBeenCalledOnce();

        const malformedProtocol = browserPort();
        const malformedResult = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL, request: { rebindRootToken: "" } },
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
        const successResult = browserPort();
        receive({
            source: browserWindow,
            data: {
                signal: PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL,
                request: { rebindRootToken: "token", subject: SUBJECT },
            },
            ports: [successProtocol as MessagePort, successResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() => expect(successResult.postMessage).toHaveBeenCalledWith({ status: "complete" }));
        expect(successResult.close).toHaveBeenCalledOnce();

        const failedProtocol = browserPort();
        const failedResult = browserPort();
        receive({
            source: browserWindow,
            data: {
                signal: PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL,
                request: { rebindRootToken: "token", subject: SUBJECT },
            },
            ports: [failedProtocol as MessagePort, failedResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(failedResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "rebind_commit",
                diagnosticCodes: ["proof.rebind_commit"],
            }),
        );

        dispose();
        expect(browserWindow.removeEventListener).toHaveBeenCalledOnce();
    });
});
