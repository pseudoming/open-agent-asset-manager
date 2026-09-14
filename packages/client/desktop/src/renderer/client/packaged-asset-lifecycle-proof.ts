import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import {
    PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL,
    type PackagedAssetLifecycleProofRequest,
    type PackagedAssetLifecycleProofStep,
    parsePackagedAssetLifecycleProofControlReply,
    parsePackagedAssetLifecycleProofRequest,
} from "../../bridge/desktop-bridge";
import { DesktopApplicationClient, type DesktopApplicationClientApi } from "./desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "./message-port-transport";

const COPY_COUNT = 51;
const PAGE_SIZE = 50;
const COPY_KEYWORDS = "Packaged Asset copy";
const STALE_DIGEST = "0".repeat(64);

class PackagedAssetLifecycleProofFailure extends Error {
    public constructor(
        public readonly step: PackagedAssetLifecycleProofStep,
        public readonly diagnosticCodes: readonly string[] = [],
    ) {
        super(`Packaged Asset lifecycle proof failed at ${step}`);
        this.name = "PackagedAssetLifecycleProofFailure";
    }
}

function diagnostics(value: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
    return Object.freeze([...new Set(value.diagnostics.map(({ code }) => code))].sort());
}

function fail(
    step: PackagedAssetLifecycleProofStep,
    value?: { readonly diagnostics: readonly { readonly code: string }[] },
): never {
    throw new PackagedAssetLifecycleProofFailure(step, value === undefined ? [] : diagnostics(value));
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

async function createRequiredBackup(client: DesktopApplicationClientApi, userActionId: string): Promise<void> {
    const inspected = await client.inspectStateBackup({
        destination: { destinationKind: "oaam_default" },
        encryptionMode: "none",
    });
    if (inspected.status !== "complete") fail("backup", inspected);
    const created = await client.createStateBackup({
        backupReviewToken: inspected.value.backupReviewToken,
        userActionId,
    });
    if (created.status !== "complete") fail("backup", created);
}

export async function provePackagedAssetLifecycle(
    client: DesktopApplicationClientApi,
    request: PackagedAssetLifecycleProofRequest,
    requestExistingExportToken: () => Promise<string>,
    createUserActionId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<void> {
    const [initialProjects, initialAssets, initialDeployments] = await Promise.all([
        client.listProjects(),
        client.listAssets(),
        client.listDeployments(),
    ]);
    const project =
        initialProjects.status === "complete"
            ? initialProjects.value.projects.find((entry) => entry.projectId === request.subject.projectId)
            : undefined;
    const sourceAsset =
        initialAssets.status === "complete"
            ? initialAssets.value.assets.find((asset) => asset.assetId === request.subject.assetId)
            : undefined;
    const deployment =
        initialDeployments.status === "complete"
            ? initialDeployments.value.deployments.find((entry) => entry.deploymentId === request.subject.deploymentId)
            : undefined;
    if (
        initialProjects.status !== "complete" ||
        project === undefined ||
        initialAssets.status !== "complete" ||
        sourceAsset === undefined ||
        sourceAsset.projectId !== project.projectId ||
        sourceAsset.currentVersionId !== request.subject.versionId ||
        initialDeployments.status !== "complete" ||
        deployment === undefined ||
        deployment.subject.subjectKind !== "project" ||
        deployment.subject.projectId !== project.projectId
    ) {
        fail("initial_state");
    }

    const versionsResult = await client.listAssetVersions({ assetId: sourceAsset.assetId, pageSize: 50 });
    if (
        versionsResult.status !== "complete" ||
        !versionsResult.value.found ||
        versionsResult.value.value.totalCount < 2 ||
        versionsResult.value.value.versions.length !== versionsResult.value.value.totalCount
    ) {
        fail("versions", versionsResult);
    }
    const versions = [...versionsResult.value.value.versions].sort((left, right) => left.revision - right.revision);
    const firstVersion = versions[0];
    const latestVersion = versions[versions.length - 1];
    if (
        firstVersion === undefined ||
        latestVersion === undefined ||
        firstVersion.revision !== 1 ||
        latestVersion.revision < 2 ||
        latestVersion.versionId !== request.subject.versionId ||
        versions.some((version) => version.assetId !== sourceAsset.assetId) ||
        versions.some((version, index) => version.revision !== index + 1)
    ) {
        fail("versions");
    }

    const staleCopy = await client.copyAsset({
        source: {
            assetId: sourceAsset.assetId,
            versionId: latestVersion.versionId,
            versionFingerprint: STALE_DIGEST,
            originAuthorityFingerprint: latestVersion.originAuthorityFingerprint,
        },
        destination: { scope: "global", scopePath: "" },
        displayName: "Rejected stale copy",
        displayDescription: "",
        userActionId: createUserActionId(),
    });
    if (staleCopy.status !== "failed") fail("stale_copy");

    const copiedAssets = [];
    for (let index = 1; index <= COPY_COUNT; index += 1) {
        const copied = await client.copyAsset({
            source: {
                assetId: sourceAsset.assetId,
                versionId: latestVersion.versionId,
                versionFingerprint: latestVersion.fingerprint,
                originAuthorityFingerprint: latestVersion.originAuthorityFingerprint,
            },
            destination: { scope: "global", scopePath: "" },
            displayName: `Packaged Asset copy ${String(index).padStart(2, "0")}`,
            displayDescription: "Installed Asset lifecycle proof",
            userActionId: createUserActionId(),
        });
        if (copied.status !== "complete") fail("create_copies", copied);
        copiedAssets.push(copied.value.asset);
    }

    const counts = await client.listAssetKindCounts({ subject: { scope: "global" }, keywords: COPY_KEYWORDS });
    const guidanceCount =
        counts.status === "complete" ? counts.value.counts.find(({ kind }) => kind === sourceAsset.kind)?.count : undefined;
    if (counts.status !== "complete" || guidanceCount !== COPY_COUNT) fail("catalog_counts", counts);

    const firstPage = await client.queryAssetLibrary({
        subject: { scope: "global" },
        kind: sourceAsset.kind,
        keywords: COPY_KEYWORDS,
        pageSize: PAGE_SIZE,
    });
    if (
        firstPage.status !== "complete" ||
        firstPage.value.assets.length !== PAGE_SIZE ||
        firstPage.value.totalCount !== COPY_COUNT ||
        !firstPage.value.hasMore
    ) {
        fail("catalog_page_one", firstPage);
    }
    const secondPage = await client.queryAssetLibrary({
        subject: { scope: "global" },
        kind: sourceAsset.kind,
        keywords: COPY_KEYWORDS,
        pageSize: PAGE_SIZE,
        cursor: firstPage.value.nextCursor,
    });
    const pagedIds =
        secondPage.status === "complete"
            ? [...firstPage.value.assets, ...secondPage.value.assets].map(({ assetId }) => assetId)
            : [];
    const copiedAssetIds = new Set(copiedAssets.map((asset) => asset.assetId));
    if (
        secondPage.status !== "complete" ||
        secondPage.value.assets.length !== 1 ||
        secondPage.value.totalCount !== COPY_COUNT ||
        secondPage.value.hasMore ||
        new Set(pagedIds).size !== COPY_COUNT ||
        pagedIds.some((assetId) => !copiedAssetIds.has(assetId))
    ) {
        fail("catalog_page_two", secondPage);
    }

    const filesResult = await client.listAssetVersionFileChildren({
        assetId: sourceAsset.assetId,
        versionId: latestVersion.versionId,
        directoryPath: "",
        pageSize: 50,
    });
    const fileEntry =
        filesResult.status === "complete" && filesResult.value.found
            ? filesResult.value.value.entries.find((entry) => entry.entryKind === "file")
            : undefined;
    if (
        filesResult.status !== "complete" ||
        !filesResult.value.found ||
        filesResult.value.value.totalCount !== 1 ||
        fileEntry === undefined ||
        fileEntry.entryKind !== "file"
    ) {
        fail("file_graph", filesResult);
    }

    const previewResult = await client.readAssetVersionFilePreview({
        assetId: sourceAsset.assetId,
        versionId: latestVersion.versionId,
        logicalPath: fileEntry.file.logicalPath,
    });
    if (
        previewResult.status !== "complete" ||
        !previewResult.value.found ||
        previewResult.value.value.previewKind !== "large_text" ||
        previewResult.value.value.limitReason !== "line_limit" ||
        previewResult.value.value.observedLineCount <= 5_000
    ) {
        fail("large_preview", previewResult);
    }

    let cursor: string | undefined;
    let expectedByteStart = 0;
    let pageCount = 0;
    let totalBytes = -1;
    let finalLineCount = 0;
    do {
        const pageResult = await client.readAssetVersionTextPage({
            assetId: sourceAsset.assetId,
            versionId: latestVersion.versionId,
            logicalPath: fileEntry.file.logicalPath,
            ...(cursor === undefined ? {} : { cursor }),
        });
        if (pageResult.status !== "complete" || !pageResult.value.found) fail("progressive_text", pageResult);
        const page = pageResult.value.value;
        if (page.loadedByteStart !== expectedByteStart || page.loadedByteEnd <= page.loadedByteStart) {
            fail("progressive_text");
        }
        expectedByteStart = page.loadedByteEnd;
        totalBytes = page.totalBytes;
        finalLineCount = page.totalLines;
        pageCount += 1;
        cursor = page.hasMore ? page.nextCursor : undefined;
        if (pageCount > 100) fail("progressive_text");
    } while (cursor !== undefined);
    if (pageCount < 2 || expectedByteStart !== totalBytes || finalLineCount <= 5_000) fail("progressive_text");

    const compared = await client.compareAssetVersions({
        assetId: sourceAsset.assetId,
        left: { versionId: firstVersion.versionId, versionFingerprint: firstVersion.fingerprint },
        right: { versionId: latestVersion.versionId, versionFingerprint: latestVersion.fingerprint },
        logicalPath: fileEntry.file.logicalPath,
    });
    if (
        compared.status !== "complete" ||
        compared.value.files.find(({ logicalPath }) => logicalPath === fileEntry.file.logicalPath)?.changeKind !== "modified" ||
        compared.value.selectedFile.comparisonKind !== "text" ||
        compared.value.selectedFile.leftLineCount <= 5_000 ||
        compared.value.selectedFile.rightLineCount <= 5_000 ||
        compared.value.selectedFile.hunks.length === 0
    ) {
        fail("compare", compared);
    }

    const exportInput = {
        source: {
            assetId: sourceAsset.assetId,
            versionId: latestVersion.versionId,
            versionFingerprint: latestVersion.fingerprint,
            originAuthorityFingerprint: latestVersion.originAuthorityFingerprint,
        },
        userActionId: createUserActionId(),
    };
    const exported = await client.exportAssetVersion({ ...exportInput, localPathSelectionToken: request.exportToken });
    if (exported.status !== "complete" || exported.value.archiveByteLength <= 0) fail("export", exported);
    let existingExportToken: string;
    try {
        existingExportToken = await requestExistingExportToken();
    } catch {
        fail("export_existing");
    }
    const existing = await client.exportAssetVersion({
        ...exportInput,
        localPathSelectionToken: existingExportToken,
        userActionId: createUserActionId(),
    });
    if (existing.status !== "failed") fail("export_existing");

    const lifecycleAsset = copiedAssets[0];
    if (lifecycleAsset === undefined) fail("delete");
    const deleted = await client.softDeleteAsset({ assetId: lifecycleAsset.assetId });
    if (deleted.status !== "complete" || !deleted.value.deleted) fail("delete", deleted);
    const restored = await client.restoreAsset({ assetId: lifecycleAsset.assetId });
    if (restored.status !== "complete" || restored.value.deleted) fail("restore", restored);
    const deletedAgain = await client.softDeleteAsset({ assetId: lifecycleAsset.assetId });
    if (deletedAgain.status !== "complete" || !deletedAgain.value.deleted) fail("delete", deletedAgain);
    await createRequiredBackup(client, createUserActionId());

    const inspected = await client.inspectAssetPurge({ assetId: lifecycleAsset.assetId });
    if (inspected.status !== "complete" || inspected.value.assetId !== lifecycleAsset.assetId) {
        fail("purge_inspect", inspected);
    }
    const stalePurge = await client.commitAssetPurge({
        preparation: { ...inspected.value, assetManifestFingerprint: STALE_DIGEST },
        userActionId: createUserActionId(),
    });
    if (stalePurge.status !== "failed") fail("purge_stale");
    const purged = await client.commitAssetPurge({
        preparation: inspected.value,
        userActionId: createUserActionId(),
    });
    if (purged.status !== "complete" || purged.value.assetId !== lifecycleAsset.assetId || !purged.value.recycled) {
        fail("purge_commit", purged);
    }

    const [finalGlobal, finalProjectAssets, finalDeployments, purgedAsset] = await Promise.all([
        client.queryAssetLibrary({
            subject: { scope: "global" },
            kind: sourceAsset.kind,
            keywords: COPY_KEYWORDS,
            pageSize: PAGE_SIZE,
        }),
        client.listAssets({ projectId: project.projectId }),
        client.listDeployments({ subject: { subjectKind: "project", projectId: project.projectId } }),
        client.getAsset({ assetId: lifecycleAsset.assetId }),
    ]);
    if (
        finalGlobal.status !== "complete" ||
        finalGlobal.value.totalCount !== COPY_COUNT - 1 ||
        finalGlobal.value.assets.length !== PAGE_SIZE ||
        finalGlobal.value.hasMore ||
        finalProjectAssets.status !== "complete" ||
        !finalProjectAssets.value.assets.some(
            (asset) => asset.assetId === sourceAsset.assetId && asset.currentVersionId === request.subject.versionId,
        ) ||
        finalDeployments.status !== "complete" ||
        !finalDeployments.value.deployments.some((entry) => entry.deploymentId === deployment.deploymentId) ||
        purgedAsset.status !== "complete" ||
        purgedAsset.value.found
    ) {
        fail("final_state");
    }
}

export async function runPackagedAssetLifecycleProof(
    port: BrowserProtocolPort,
    request: PackagedAssetLifecycleProofRequest,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
    requestExistingExportToken: () => Promise<string>,
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
        ]);
        await provePackagedAssetLifecycle(
            new DesktopApplicationClient(connection, availableOperations),
            request,
            requestExistingExportToken,
        );
        if (listenerError !== undefined) fail("client_listener");
    } finally {
        connection.close();
    }
}

export function installPackagedAssetLifecycleProofListener(
    browserWindow: Window,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): () => void {
    const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== browserWindow || event.data === null || typeof event.data !== "object") return;
        const signal = (event.data as { readonly signal?: unknown }).signal;
        if (signal !== PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL) return;
        if (event.ports.length !== 2) {
            for (const port of event.ports) port.close();
            return;
        }
        const [protocolPort, resultPort] = event.ports;
        if (protocolPort === undefined || resultPort === undefined) return;
        void (async () => {
            try {
                const request = parsePackagedAssetLifecycleProofRequest((event.data as { readonly request?: unknown }).request);
                await runPackagedAssetLifecycleProof(
                    protocolPort as BrowserProtocolPort,
                    request,
                    createConnection,
                    createRequestId,
                    () => requestPackagedExistingExportToken(resultPort as BrowserProtocolPort),
                );
                resultPort.postMessage(Object.freeze({ status: "complete" }));
            } catch (error) {
                resultPort.postMessage(
                    Object.freeze({
                        status: "failed",
                        step: error instanceof PackagedAssetLifecycleProofFailure ? error.step : "unexpected",
                        diagnosticCodes: error instanceof PackagedAssetLifecycleProofFailure ? error.diagnosticCodes : [],
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

function requestPackagedExistingExportToken(port: BrowserProtocolPort): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const cleanup = (): void => {
            port.removeEventListener("message", receive);
            port.removeEventListener("messageerror", close);
            port.removeEventListener("close", close);
        };
        const receive = (event: MessageEvent<unknown>): void => {
            try {
                const reply = parsePackagedAssetLifecycleProofControlReply(event.data);
                cleanup();
                resolve(reply.existingExportToken);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        const close = (): void => {
            cleanup();
            reject(new Error("Packaged Asset lifecycle proof control port closed before export-token delivery"));
        };
        port.addEventListener("message", receive);
        port.addEventListener("messageerror", close);
        port.addEventListener("close", close);
        port.start();
        try {
            port.postMessage(Object.freeze({ control: "request_existing_export_token" }));
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}
