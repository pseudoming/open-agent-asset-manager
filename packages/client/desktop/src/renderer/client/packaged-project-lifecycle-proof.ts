import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import {
    PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL,
    type PackagedProjectLifecycleProofRequest,
    type PackagedProjectLifecycleProofStep,
    parsePackagedProjectLifecycleProofRequest,
} from "../../bridge/desktop-bridge";
import { DesktopApplicationClient, type DesktopApplicationClientApi } from "./desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "./message-port-transport";

const RENAME_LABEL = "OAAM packaged Project lifecycle";

class PackagedProjectLifecycleProofFailure extends Error {
    public readonly step: PackagedProjectLifecycleProofStep;
    public readonly diagnosticCodes: readonly string[];

    public constructor(step: PackagedProjectLifecycleProofStep, diagnosticCodes: readonly string[] = []) {
        super(`Packaged Project lifecycle proof failed at ${step}`);
        this.name = "PackagedProjectLifecycleProofFailure";
        this.step = step;
        this.diagnosticCodes = diagnosticCodes;
    }
}

function diagnosticCodes(value: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
    return Object.freeze(
        [...new Set(value.diagnostics.map((diagnostic) => diagnostic.code).filter((code) => /^[a-z0-9_.-]{1,128}$/u.test(code)))]
            .sort()
            .slice(0, 8),
    );
}

function fail(
    step: PackagedProjectLifecycleProofStep,
    value?: { readonly diagnostics: readonly { readonly code: string }[] },
): never {
    throw new PackagedProjectLifecycleProofFailure(step, value === undefined ? [] : diagnosticCodes(value));
}

async function initialize(connection: ClientConnectionApi): Promise<readonly ProtocolOperationName[]> {
    const initialized = await connection.initialize({ protocolVersion: 1, clientKind: "desktop", clientVersion: "0.1.0" });
    if (initialized.protocolVersion !== 1) fail("initialize");
    return initialized.availableOperations;
}

function requireOperations(
    availableOperations: readonly ProtocolOperationName[],
    required: readonly ProtocolOperationName[],
): void {
    const available = new Set<ProtocolOperationName>(availableOperations);
    if (required.some((operation) => !available.has(operation))) fail("available_operations");
}

async function createRequiredBackup(
    client: DesktopApplicationClientApi,
    userActionId: string,
    step: "rebind_backup" | "stop_backup",
): Promise<void> {
    const inspected = await client.inspectStateBackup({
        destination: { destinationKind: "oaam_default" },
        encryptionMode: "none",
    });
    if (inspected.status !== "complete") fail(step, inspected);
    const created = await client.createStateBackup({
        backupReviewToken: inspected.value.backupReviewToken,
        userActionId,
    });
    if (created.status !== "complete") fail(step, created);
}

async function inspectAndCommit(
    client: DesktopApplicationClientApi,
    input: Parameters<DesktopApplicationClientApi["inspectProjectLifecycle"]>[0],
    inspectStep: PackagedProjectLifecycleProofStep,
    commitStep: PackagedProjectLifecycleProofStep,
    createUserActionId: () => string,
) {
    const inspected = await client.inspectProjectLifecycle(input);
    if (inspected.status !== "complete" || inspected.value.action !== input.action) fail(inspectStep, inspected);
    const committed = await client.commitProjectLifecycle({
        projectLifecycleReviewToken: inspected.value.projectLifecycleReviewToken,
        userActionId: createUserActionId(),
    });
    if (committed.status !== "complete") fail(commitStep, committed);
    return Object.freeze({ review: inspected.value, project: committed.value });
}

export async function provePackagedProjectLifecycle(
    client: DesktopApplicationClientApi,
    request: PackagedProjectLifecycleProofRequest,
    createUserActionId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<void> {
    const [initialProjects, initialAssets, initialDeployments] = await Promise.all([
        client.listProjects({ includeDeleted: true }),
        client.listAssets(),
        client.listDeployments(),
    ]);
    const initialProject =
        initialProjects.status === "complete"
            ? initialProjects.value.projects.find((project) => project.projectId === request.subject.projectId)
            : undefined;
    const initialAsset =
        initialAssets.status === "complete"
            ? initialAssets.value.assets.find((asset) => asset.assetId === request.subject.assetId)
            : undefined;
    const initialDeployment =
        initialDeployments.status === "complete"
            ? initialDeployments.value.deployments.find((deployment) => deployment.deploymentId === request.subject.deploymentId)
            : undefined;
    if (
        initialProjects.status !== "complete" ||
        initialProject === undefined ||
        initialProject.deleted ||
        initialAssets.status !== "complete" ||
        initialAsset === undefined ||
        initialAsset.projectId !== initialProject.projectId ||
        initialAsset.currentVersionId !== request.subject.versionId ||
        initialDeployments.status !== "complete" ||
        initialDeployment === undefined ||
        initialDeployment.subject.subjectKind !== "project" ||
        initialDeployment.subject.projectId !== initialProject.projectId
    ) {
        fail("initial_state");
    }
    const identity = Object.freeze({
        projectId: initialProject.projectId,
        assetId: initialAsset.assetId,
        deploymentId: initialDeployment.deploymentId,
        initialRootPath: initialProject.rootPath,
        deploymentTargetRootPath: initialDeployment.targetRootPath,
    });

    const renamed = await inspectAndCommit(
        client,
        { action: "rename", projectId: identity.projectId, nextDisplayName: RENAME_LABEL },
        "rename_inspect",
        "rename_commit",
        createUserActionId,
    );
    if (
        renamed.review.action !== "rename" ||
        renamed.project.projectId !== identity.projectId ||
        renamed.project.rootPath !== identity.initialRootPath ||
        renamed.project.displayName !== RENAME_LABEL ||
        renamed.project.deleted
    ) {
        fail("rename_commit");
    }

    await createRequiredBackup(client, createUserActionId(), "rebind_backup");
    const rebound = await inspectAndCommit(
        client,
        { action: "rebind", projectId: identity.projectId, localPathSelectionToken: request.rebindRootToken },
        "rebind_inspect",
        "rebind_commit",
        createUserActionId,
    );
    if (
        rebound.review.action !== "rebind" ||
        rebound.review.currentRootPath !== identity.initialRootPath ||
        rebound.review.nextRootPath === identity.initialRootPath ||
        rebound.project.projectId !== identity.projectId ||
        rebound.project.rootPath !== rebound.review.nextRootPath ||
        rebound.project.displayName !== RENAME_LABEL ||
        rebound.project.deleted
    ) {
        fail("rebind_commit");
    }
    const reboundRootPath = rebound.project.rootPath;

    await createRequiredBackup(client, createUserActionId(), "stop_backup");
    const stopped = await inspectAndCommit(
        client,
        { action: "stop_managing", projectId: identity.projectId },
        "stop_inspect",
        "stop_commit",
        createUserActionId,
    );
    if (
        stopped.review.action !== "stop_managing" ||
        stopped.project.projectId !== identity.projectId ||
        stopped.project.rootPath !== reboundRootPath ||
        !stopped.project.deleted
    ) {
        fail("stop_commit");
    }

    const [activeAfterStop, retainedAfterStop, assetsAfterStop, deploymentsAfterStop] = await Promise.all([
        client.listProjects(),
        client.listProjects({ includeDeleted: true }),
        client.listAssets({ projectId: identity.projectId }),
        client.listDeployments({ subject: { subjectKind: "project", projectId: identity.projectId } }),
    ]);
    if (
        activeAfterStop.status !== "complete" ||
        activeAfterStop.value.projects.some((project) => project.projectId === identity.projectId) ||
        retainedAfterStop.status !== "complete" ||
        !retainedAfterStop.value.projects.some((project) => project.projectId === identity.projectId && project.deleted) ||
        assetsAfterStop.status !== "complete" ||
        !assetsAfterStop.value.assets.some(
            (asset) => asset.assetId === identity.assetId && asset.currentVersionId === request.subject.versionId,
        ) ||
        deploymentsAfterStop.status !== "complete" ||
        !deploymentsAfterStop.value.deployments.some(
            (deployment) =>
                deployment.deploymentId === identity.deploymentId &&
                deployment.targetRootPath === identity.deploymentTargetRootPath,
        )
    ) {
        fail("retained_state");
    }

    const restored = await inspectAndCommit(
        client,
        { action: "restore", projectId: identity.projectId },
        "restore_inspect",
        "restore_commit",
        createUserActionId,
    );
    if (
        restored.review.action !== "restore" ||
        restored.review.rootAccessState !== "available" ||
        restored.project.projectId !== identity.projectId ||
        restored.project.rootPath !== reboundRootPath ||
        restored.project.displayName !== RENAME_LABEL ||
        restored.project.deleted
    ) {
        fail("restore_commit");
    }

    const [finalProjects, finalAssets, finalDeployments] = await Promise.all([
        client.listProjects({ includeDeleted: true }),
        client.listAssets({ projectId: identity.projectId }),
        client.listDeployments({ subject: { subjectKind: "project", projectId: identity.projectId } }),
    ]);
    if (
        finalProjects.status !== "complete" ||
        !finalProjects.value.projects.some((project) => project.projectId === identity.projectId && !project.deleted) ||
        finalAssets.status !== "complete" ||
        !finalAssets.value.assets.some(
            (asset) => asset.assetId === identity.assetId && asset.currentVersionId === request.subject.versionId,
        ) ||
        finalDeployments.status !== "complete" ||
        !finalDeployments.value.deployments.some(
            (deployment) =>
                deployment.deploymentId === identity.deploymentId &&
                deployment.targetRootPath === identity.deploymentTargetRootPath,
        )
    ) {
        fail("final_state");
    }
}

export async function runPackagedProjectLifecycleProof(
    port: BrowserProtocolPort,
    request: PackagedProjectLifecycleProofRequest,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): Promise<void> {
    let listenerError: unknown;
    const connection = createConnection(new MessagePortClientTransport(port), {
        createRequestId,
        reportListenerError: (error) => {
            listenerError ??= error;
        },
    });
    try {
        const availableOperations = await initialize(connection);
        requireOperations(availableOperations, [
            "project.list",
            "asset.list",
            "deployment.list",
            "project_lifecycle.inspect",
            "project_lifecycle.commit",
            "state_backup.inspect",
            "state_backup.create",
        ]);
        await provePackagedProjectLifecycle(new DesktopApplicationClient(connection, availableOperations), request);
        if (listenerError !== undefined) fail("client_listener");
    } finally {
        connection.close();
    }
}

export function installPackagedProjectLifecycleProofListener(
    browserWindow: Window,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): () => void {
    const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== browserWindow || event.data === null || typeof event.data !== "object") return;
        const signal = (event.data as { readonly signal?: unknown }).signal;
        if (signal !== PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL) return;
        if (event.ports.length !== 2) {
            for (const port of event.ports) port.close();
            return;
        }
        const [protocolPort, resultPort] = event.ports;
        if (protocolPort === undefined || resultPort === undefined) return;
        void (async () => {
            try {
                const request = parsePackagedProjectLifecycleProofRequest((event.data as { readonly request?: unknown }).request);
                await runPackagedProjectLifecycleProof(
                    protocolPort as BrowserProtocolPort,
                    request,
                    createConnection,
                    createRequestId,
                );
                resultPort.postMessage(Object.freeze({ status: "complete" }));
            } catch (error) {
                resultPort.postMessage(
                    Object.freeze({
                        status: "failed",
                        step: error instanceof PackagedProjectLifecycleProofFailure ? error.step : "unexpected",
                        diagnosticCodes: error instanceof PackagedProjectLifecycleProofFailure ? error.diagnosticCodes : [],
                    }),
                );
            } finally {
                resultPort.close();
            }
        })();
    };
    browserWindow.addEventListener("message", receive);
    return () => browserWindow.removeEventListener("message", receive);
}
