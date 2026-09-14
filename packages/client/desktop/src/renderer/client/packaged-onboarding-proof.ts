import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import { PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL, type PackagedOnboardingProofStep } from "../../bridge/desktop-bridge";
import { DesktopApplicationClient } from "./desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "./message-port-transport";

export interface PackagedOnboardingProofResult {
    readonly assetId: string;
    readonly versionId: string;
}

class PackagedOnboardingProofFailure extends Error {
    public readonly step: PackagedOnboardingProofStep;
    public readonly diagnosticCodes: readonly string[];

    public constructor(step: PackagedOnboardingProofStep, diagnosticCodes: readonly string[]) {
        super(`Packaged onboarding proof failed at ${step}`);
        this.name = "PackagedOnboardingProofFailure";
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

function proofFailure(step: PackagedOnboardingProofStep, diagnosticCodes: readonly string[] = []): never {
    throw new PackagedOnboardingProofFailure(step, diagnosticCodes);
}

export async function provePackagedOnboardingImport(
    connection: ClientConnectionApi,
    createUserActionId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<PackagedOnboardingProofResult> {
    const initialized = await connection.initialize({
        protocolVersion: 1,
        clientKind: "desktop",
        clientVersion: "0.1.0",
    });
    if (initialized.protocolVersion !== 1) proofFailure("initialize");

    const initialAssets = await connection.request("asset.list", {});
    if (initialAssets.status !== "complete" || initialAssets.value.assets.length !== 0) {
        proofFailure("empty_catalog");
    }

    const providers = await connection.request("adapter_provider.list", {});
    if (providers.status !== "complete" || !providers.value.providers.some((provider) => provider.adapterId === "CLAUDECODE")) {
        proofFailure("provider_inventory");
    }

    const enablement = await connection.request("adapter_enablement.get", {});
    if (enablement.status !== "complete") proofFailure("enablement_read");
    const enabledAdapterIds = new Set<string>(enablement.value.enabledAdapterIds);
    if (!enabledAdapterIds.has("CLAUDECODE")) {
        const replaced = await connection.request("adapter_enablement.replace", {
            expectedRevision: enablement.value.revision,
            expectedSettingFingerprint: enablement.value.settingFingerprint,
            enabledAdapterIds: [...enabledAdapterIds, "CLAUDECODE"].sort(),
            userActionId: createUserActionId(),
        });
        if (replaced.status !== "complete" || !new Set<string>(replaced.value.enabledAdapterIds).has("CLAUDECODE")) {
            proofFailure("enablement_replace");
        }
    }

    const environments = await connection.request("environment.list", {
        platforms: ["win32", "darwin", "linux", "wsl"],
    });
    if (environments.status !== "complete") proofFailure("environment_list");
    const desktopEnvironments = environments.value.environments.filter(
        (entry) => entry.environment.platformInstanceId === "desktop-local",
    );
    if (desktopEnvironments.length !== 1) proofFailure("desktop_environment");
    const environment = desktopEnvironments[0];
    if (environment === undefined) proofFailure("desktop_environment");

    const probeOperation = await connection.start("adapter.probe", {
        adapterIds: ["CLAUDECODE"],
        environments: [environment.environment],
        authorization: { scope: "global" },
    });
    const probe = await probeOperation.terminal;
    if (probe.status === "failed") proofFailure("probe", proofDiagnosticCodes(probe));
    const probeResult = probe.value.results.find(
        (entry) =>
            entry.adapterId === "CLAUDECODE" &&
            entry.environment.platform === environment.environment.platform &&
            entry.environment.platformInstanceId === environment.environment.platformInstanceId,
    );
    const source = probeResult?.sources.find(
        (entry) =>
            entry.rootRole === "config" && entry.sourceDomain === "agent_runtime_private" && entry.accessStatus === "available",
    );
    if (probeResult === undefined || source === undefined) proofFailure("config_source", proofDiagnosticCodes(probe));

    const readOperation = await connection.start("adapter.read", {
        probeToken: probe.value.probeToken,
        selections: [
            {
                probeResultRowId: probeResult.rowId,
                sourceRootRowIds: [source.rowId],
                allowedKinds: ["Guidance"],
            },
        ],
    });
    const read = await readOperation.terminal;
    if (read.status !== "complete" || read.value.candidateCount !== 1) proofFailure("source_read");

    const previewOperation = await connection.start("import.preview", { readToken: read.value.readToken });
    const preview = await previewOperation.terminal;
    if (preview.status !== "complete" || preview.value.candidates.length !== 1) proofFailure("import_preview");
    const candidate = preview.value.candidates[0];
    if (
        candidate === undefined ||
        candidate.kind !== "Guidance" ||
        candidate.status !== "importable" ||
        candidate.freshness !== "fresh" ||
        candidate.callableBindingRequestCount !== 0 ||
        candidate.callableBindingRequestsTruncated
    ) {
        proofFailure("import_candidate");
    }

    const acceptOperation = await connection.start("import.accept_batch", {
        previewToken: preview.value.previewToken,
        expectedSnapshotFingerprint: preview.value.snapshotFingerprint,
        decisions: [
            {
                candidateId: candidate.candidateId,
                action: "create_asset",
                freshness: { freshnessAction: "require_current_source" },
                promotion: { promotionAction: "import_only", userActionId: createUserActionId() },
                callableBindings: [],
            },
        ],
    });
    const accepted = await acceptOperation.terminal;
    const imported = accepted.status === "complete" ? accepted.value.items[0] : undefined;
    if (
        accepted.status !== "complete" ||
        accepted.value.items.length !== 1 ||
        imported === undefined ||
        imported.status !== "complete"
    ) {
        proofFailure("import_accept");
    }

    const finalAssets = await connection.request("asset.list", {});
    const finalAsset = finalAssets.status === "complete" ? finalAssets.value.assets[0] : undefined;
    if (
        finalAssets.status !== "complete" ||
        finalAssets.value.assets.length !== 1 ||
        finalAsset === undefined ||
        finalAsset.kind !== "Guidance" ||
        finalAsset.assetId !== imported.version.assetId ||
        finalAsset.currentVersionId !== imported.version.versionId
    ) {
        proofFailure("final_catalog");
    }
    const { ProjectLibraryController, AssetBrowserController, AssetInspectorController } = await import(
        "../features/project-library/proof"
    );
    const applicationClient = new DesktopApplicationClient(connection, initialized.availableOperations);
    const library = new ProjectLibraryController(applicationClient);
    const browser = new AssetBrowserController(applicationClient);
    const inspector = new AssetInspectorController(applicationClient);
    try {
        await library.load();
        const libraryState = library.state;
        if (libraryState.status !== "ready" || libraryState.selectedProjectId !== undefined) {
            proofFailure("library_projection");
        }
        await browser.load("global", undefined, "", false);
        await browser.loadKind("global", "Guidance");
        const browserState = browser.state;
        const guidance =
            browserState.status === "ready"
                ? browserState.collections
                      .find((collection) => collection.collectionId === "global")
                      ?.kinds.find((kind) => kind.kind === "Guidance")
                : undefined;
        if (
            guidance?.status !== "ready" ||
            guidance.assets.length !== 1 ||
            guidance.assets[0]?.assetId !== imported.version.assetId
        ) {
            proofFailure("library_projection");
        }
        await inspector.load(imported.version.assetId);
        const projected = inspector.state;
        if (
            projected.status !== "ready" ||
            projected.asset.assetId !== imported.version.assetId ||
            projected.selectedVersion.versionId !== imported.version.versionId
        ) {
            proofFailure("library_projection");
        }
    } finally {
        inspector.dispose();
        browser.dispose();
        library.dispose();
    }
    return Object.freeze({
        assetId: imported.version.assetId,
        versionId: imported.version.versionId,
    });
}

export async function runPackagedOnboardingImportProof(
    port: BrowserProtocolPort,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): Promise<PackagedOnboardingProofResult> {
    const transport = new MessagePortClientTransport(port);
    let listenerError: unknown;
    const connection = createConnection(transport, {
        createRequestId,
        reportListenerError: (error) => {
            listenerError ??= error;
        },
    });
    try {
        const result = await provePackagedOnboardingImport(connection);
        if (listenerError !== undefined) proofFailure("client_listener");
        return result;
    } finally {
        connection.close();
    }
}

export function installPackagedOnboardingProofListener(
    browserWindow: Window,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): () => void {
    const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== browserWindow || event.data !== PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL) return;
        if (event.ports.length !== 2) {
            for (const port of event.ports) port.close();
            return;
        }
        const [protocolPort, resultPort] = event.ports;
        if (protocolPort === undefined || resultPort === undefined) return;
        void (async () => {
            try {
                await runPackagedOnboardingImportProof(protocolPort as BrowserProtocolPort, createConnection, createRequestId);
                resultPort.postMessage(Object.freeze({ status: "complete" }));
            } catch (error) {
                resultPort.postMessage(
                    Object.freeze({
                        status: "failed",
                        step: error instanceof PackagedOnboardingProofFailure ? error.step : "unexpected",
                        diagnosticCodes: error instanceof PackagedOnboardingProofFailure ? error.diagnosticCodes : [],
                    }),
                );
            } finally {
                resultPort.close();
            }
        })();
    };
    browserWindow.addEventListener("message", receive);
    return () => {
        browserWindow.removeEventListener("message", receive);
    };
}
