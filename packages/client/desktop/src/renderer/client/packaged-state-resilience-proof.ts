import type { ProtocolOperationName, ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import {
    type OaamDesktopBridge,
    PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL,
    type PackagedProofSubjectIdentity,
    type PackagedStateResilienceProofRequest,
    type PackagedStateResilienceProofStep,
    parsePackagedStateResilienceProofRequest,
} from "../../bridge/desktop-bridge";
import { DesktopApplicationClient } from "./desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "./message-port-transport";

export const PACKAGED_COMPATIBLE_BACKUP_PASSWORD = "oaam-compatible-proof";
export const PACKAGED_STRONG_BACKUP_PASSWORD = "oaam-strong-proof";
export const PACKAGED_WRONG_BACKUP_PASSWORD = "oaam-wrong-proof";

class PackagedStateResilienceProofFailure extends Error {
    public readonly step: PackagedStateResilienceProofStep;
    public readonly diagnosticCodes: readonly string[];

    public constructor(step: PackagedStateResilienceProofStep, diagnosticCodes: readonly string[] = []) {
        super(`Packaged State resilience proof failed at ${step}`);
        this.name = "PackagedStateResilienceProofFailure";
        this.step = step;
        this.diagnosticCodes = diagnosticCodes;
    }
}

function proofDiagnosticCodes(value: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
    return Object.freeze(
        [...new Set(value.diagnostics.map((diagnostic) => diagnostic.code).filter((code) => /^[a-z0-9_.-]{1,128}$/u.test(code)))]
            .sort()
            .slice(0, 8),
    );
}

function fail(
    step: PackagedStateResilienceProofStep,
    value?: { readonly diagnostics: readonly { readonly code: string }[] },
): never {
    throw new PackagedStateResilienceProofFailure(step, value === undefined ? [] : proofDiagnosticCodes(value));
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

async function requireNonemptyState(connection: ClientConnectionApi, subject: PackagedProofSubjectIdentity): Promise<void> {
    const [assets, projects, deployments] = await Promise.all([
        connection.request("asset.list", {}),
        connection.request("project.list", {}),
        connection.request("deployment.list", {}),
    ]);
    if (
        assets.status !== "complete" ||
        !assets.value.assets.some(
            (asset) =>
                asset.assetId === subject.assetId &&
                asset.projectId === subject.projectId &&
                asset.currentVersionId === subject.versionId,
        ) ||
        projects.status !== "complete" ||
        !projects.value.projects.some((project) => project.projectId === subject.projectId && !project.deleted) ||
        deployments.status !== "complete" ||
        !deployments.value.deployments.some(
            (deployment) =>
                deployment.deploymentId === subject.deploymentId &&
                deployment.subject.subjectKind === "project" &&
                deployment.subject.projectId === subject.projectId,
        )
    ) {
        fail("nonempty_state");
    }
}

type BackupEncryptionMode = "none" | "compatible_password" | "strong_password";

async function createBackup(
    client: DesktopApplicationClient,
    encryptionMode: BackupEncryptionMode,
    password: string | undefined,
    userActionId: string,
    failureStep: "backup_inspect" | "backup_create" | "trash_backup_create" = "backup_create",
) {
    const inspected = await client.inspectStateBackup({
        destination: { destinationKind: "oaam_default" },
        encryptionMode,
    });
    if (inspected.status !== "complete" || inspected.value.encryptionMode !== encryptionMode) {
        fail(failureStep === "trash_backup_create" ? failureStep : "backup_inspect", inspected);
    }
    const created = await client.createStateBackup({
        backupReviewToken: inspected.value.backupReviewToken,
        ...(password === undefined ? {} : { password }),
        userActionId,
    });
    if (created.status !== "complete" || created.value.encryptionMode !== encryptionMode) fail(failureStep, created);
    return created.value;
}

async function proveBackup(
    connection: ClientConnectionApi,
    client: DesktopApplicationClient,
    subject: PackagedProofSubjectIdentity,
    createUserActionId: () => string,
): Promise<void> {
    await requireNonemptyState(connection, subject);
    const artifacts = [
        await createBackup(client, "none", undefined, createUserActionId()),
        await createBackup(client, "compatible_password", PACKAGED_COMPATIBLE_BACKUP_PASSWORD, createUserActionId()),
        await createBackup(client, "strong_password", PACKAGED_STRONG_BACKUP_PASSWORD, createUserActionId()),
    ];
    if (new Set(artifacts.map((artifact) => artifact.backupId)).size !== artifacts.length) fail("backup_create");
    const inventory = await client.listStateBackups();
    if (
        inventory.status !== "complete" ||
        artifacts.some(
            (artifact) =>
                !inventory.value.entries.some(
                    (entry) =>
                        entry.backupId === artifact.backupId &&
                        entry.encryptionMode === artifact.encryptionMode &&
                        entry.observation === "available",
                ),
        )
    ) {
        fail("backup_inventory", inventory);
    }
}

async function proveWrongPassword(client: DesktopApplicationClient, wrongPasswordArchiveToken: string): Promise<void> {
    const wrong = await client.inspectStateRestore({
        source: {
            sourceKind: "selected_archive",
            localPathSelectionToken: wrongPasswordArchiveToken,
        },
        password: PACKAGED_WRONG_BACKUP_PASSWORD,
    });
    if (
        wrong.status !== "failed" ||
        !wrong.diagnostics.some((diagnostic) => diagnostic.code === "restore.archive_password_invalid")
    ) {
        fail("restore_wrong_password", wrong);
    }
}

async function proveRestore(
    client: DesktopApplicationClient,
    request: Extract<PackagedStateResilienceProofRequest, { readonly mode: "restore" }>,
    createUserActionId: () => string,
): Promise<void> {
    const inspected = await client.inspectStateRestore({
        source: { sourceKind: "selected_archive", localPathSelectionToken: request.archiveToken },
        password: PACKAGED_STRONG_BACKUP_PASSWORD,
    });
    if (inspected.status !== "complete" || inspected.value.encryptionMode !== "strong_password") {
        fail("restore_inspect", inspected);
    }
    const activated = await client.activateStateRestore({
        restoreReviewToken: inspected.value.restoreReviewToken,
        password: PACKAGED_STRONG_BACKUP_PASSWORD,
        userActionId: createUserActionId(),
    });
    if (
        activated.status !== "complete" ||
        !activated.value.requiresRestart ||
        activated.value.backupId !== inspected.value.backupId
    ) {
        fail("restore_activate", activated);
    }
}

async function proveReopen(
    connection: ClientConnectionApi,
    client: DesktopApplicationClient,
    subject: PackagedProofSubjectIdentity,
): Promise<void> {
    await requireNonemptyState(connection, subject);
    const inventory = await client.listStateBackups();
    if (
        inventory.status !== "complete" ||
        inventory.value.entries.filter((entry) => entry.observation === "available").length < 3
    ) {
        fail("reopen_state", inventory);
    }
}

async function proveTrash(
    client: DesktopApplicationClient,
    bridge: Pick<OaamDesktopBridge, "performStateBackupFileAction">,
    createUserActionId: () => string,
): Promise<void> {
    const artifact = await createBackup(client, "none", undefined, createUserActionId(), "trash_backup_create");
    const trashed = await bridge.performStateBackupFileAction(artifact.backupId, "trash");
    if (trashed.status !== "complete") fail("trash_action");
    const inventory = await client.listStateBackups();
    if (inventory.status !== "complete" || inventory.value.entries.some((entry) => entry.backupId === artifact.backupId)) {
        fail("trash_inventory", inventory);
    }
}

export async function provePackagedStateResilience(
    connection: ClientConnectionApi,
    request: PackagedStateResilienceProofRequest,
    bridge: Pick<OaamDesktopBridge, "performStateBackupFileAction">,
    createUserActionId: () => string = () => globalThis.crypto.randomUUID(),
    wrongPasswordConnection?: ClientConnectionApi,
): Promise<void> {
    if (request.mode === "restore") {
        if (wrongPasswordConnection === undefined) {
            throw new PackagedStateResilienceProofFailure("restore_wrong_password");
        }
        const wrongPasswordOperations = await initialize(wrongPasswordConnection);
        requireOperations(wrongPasswordOperations, ["state_restore.inspect"]);
        await proveWrongPassword(
            new DesktopApplicationClient(wrongPasswordConnection, wrongPasswordOperations),
            request.wrongPasswordArchiveToken,
        );
    }
    const availableOperations = await initialize(connection);
    const required =
        request.mode === "restore"
            ? (["state_restore.inspect", "state_restore.activate"] as const)
            : ([
                  "asset.list",
                  "project.list",
                  "deployment.list",
                  "state_backup.list",
                  "state_backup.inspect",
                  "state_backup.create",
              ] as const);
    requireOperations(availableOperations, required);
    const client = new DesktopApplicationClient(connection, availableOperations);
    switch (request.mode) {
        case "backup":
            return proveBackup(connection, client, request.subject, createUserActionId);
        case "restore":
            return proveRestore(client, request, createUserActionId);
        case "reopen":
            return proveReopen(connection, client, request.subject);
        case "trash":
            return proveTrash(client, bridge, createUserActionId);
    }
}

export async function runPackagedStateResilienceProof(
    ports: readonly BrowserProtocolPort[],
    request: PackagedStateResilienceProofRequest,
    bridge: Pick<OaamDesktopBridge, "performStateBackupFileAction">,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): Promise<void> {
    let listenerError: unknown;
    const expectedConnectionCount = request.mode === "restore" ? 2 : 1;
    if (ports.length !== expectedConnectionCount) fail("unexpected");
    const connections = ports.map((port) =>
        createConnection(new MessagePortClientTransport(port), {
            createRequestId,
            reportListenerError: (error) => {
                listenerError ??= error;
            },
        }),
    );
    const connection = request.mode === "restore" ? connections[1] : connections[0];
    const wrongPasswordConnection = request.mode === "restore" ? connections[0] : undefined;
    if (connection === undefined) fail("unexpected");
    try {
        await provePackagedStateResilience(connection, request, bridge, undefined, wrongPasswordConnection);
        if (listenerError !== undefined) fail("client_listener");
    } finally {
        for (const ownedConnection of connections) ownedConnection.close();
    }
}

export function installPackagedStateResilienceProofListener(
    browserWindow: Window,
    bridge: Pick<OaamDesktopBridge, "performStateBackupFileAction">,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): () => void {
    const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== browserWindow || event.data === null || typeof event.data !== "object") return;
        const signal = (event.data as { readonly signal?: unknown }).signal;
        if (signal !== PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL) return;
        if (event.ports.length < 2 || event.ports.length > 3) {
            for (const port of event.ports) port.close();
            return;
        }
        const resultPort = event.ports.at(-1);
        if (resultPort === undefined) return;
        void (async () => {
            try {
                const request = parsePackagedStateResilienceProofRequest((event.data as { readonly request?: unknown }).request);
                const expectedPortCount = request.mode === "restore" ? 3 : 2;
                if (event.ports.length !== expectedPortCount) throw new PackagedStateResilienceProofFailure("unexpected");
                await runPackagedStateResilienceProof(
                    event.ports.slice(0, -1) as BrowserProtocolPort[],
                    request,
                    bridge,
                    createConnection,
                    createRequestId,
                );
                resultPort.postMessage(Object.freeze({ status: "complete" }));
            } catch (error) {
                resultPort.postMessage(
                    Object.freeze({
                        status: "failed",
                        step: error instanceof PackagedStateResilienceProofFailure ? error.step : "unexpected",
                        diagnosticCodes: error instanceof PackagedStateResilienceProofFailure ? error.diagnosticCodes : [],
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

/** @internal Exact terminal aliases used by compile-time proof tests. */
export type PackagedStateBackupTerminal = ProtocolOperationTerminal<"state_backup.create">;
