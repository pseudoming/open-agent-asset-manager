import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import {
    PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL,
    type PackagedZcodeTargetFixtureSubjects,
    type PackagedZcodeTargetProofRequest,
    type PackagedZcodeTargetProofStep,
    packagedZcodeTargetProtocolPortCount,
    packagedZcodeTargetTransferPortCount,
    parsePackagedZcodeTargetProofRequest,
} from "../../bridge/desktop-bridge";
import { CatalogDeploymentController, deploymentsForSubject } from "../features/catalog-deployment";
import { DesktopApplicationClient } from "./desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "./message-port-transport";

const STALE_INSPECTION_FINGERPRINT = "0".repeat(64);

class PackagedZcodeTargetProofFailure extends Error {
    public readonly step: PackagedZcodeTargetProofStep;
    public readonly diagnosticCodes: readonly string[];

    public constructor(step: PackagedZcodeTargetProofStep, diagnosticCodes: readonly string[] = []) {
        super(`Packaged ZCode target proof failed at ${step}`);
        this.name = "PackagedZcodeTargetProofFailure";
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

function fail(step: PackagedZcodeTargetProofStep, value?: { readonly diagnostics: readonly { readonly code: string }[] }): never {
    throw new PackagedZcodeTargetProofFailure(step, value === undefined ? [] : proofDiagnosticCodes(value));
}

async function initialize(connection: ClientConnectionApi): Promise<readonly ProtocolOperationName[]> {
    const initialized = await connection.initialize({ protocolVersion: 1, clientKind: "desktop", clientVersion: "0.1.0" });
    if (initialized.protocolVersion !== 1) fail("initialize");
    return initialized.availableOperations;
}

async function proveProjectLibraryAndDeploymentProjection(
    connection: ClientConnectionApi,
    availableOperations: readonly ProtocolOperationName[],
    expected: { readonly projectId: string; readonly assetId: string; readonly versionId: string; readonly deploymentId: string },
    assetKind: "Guidance" | "Workflow" | "Skill" | "Subagent" | "Memory",
    createUserActionId: () => string,
): Promise<void> {
    const { ProjectLibraryController, AssetBrowserController, AssetInspectorController } = await import(
        "../features/project-library/proof"
    );
    const applicationClient = new DesktopApplicationClient(connection, availableOperations);
    const library = new ProjectLibraryController(applicationClient, expected.projectId);
    const browser = new AssetBrowserController(applicationClient);
    const inspector = new AssetInspectorController(applicationClient);
    try {
        await library.load();
        const libraryState = library.state;
        if (libraryState.status !== "ready" || libraryState.selectedProjectId !== expected.projectId) {
            fail("library_projection");
        }
        await browser.load("projects", expected.projectId, "", false);
        await browser.loadKind("project", assetKind);
        const browserState = browser.state;
        const assetKindProjection =
            browserState.status === "ready"
                ? browserState.collections
                      .find((collection) => collection.collectionId === "project")
                      ?.kinds.find((kind) => kind.kind === assetKind)
                : undefined;
        if (
            assetKindProjection?.status !== "ready" ||
            assetKindProjection.assets.length !== 1 ||
            assetKindProjection.assets[0]?.assetId !== expected.assetId
        ) {
            fail("library_projection");
        }
        await inspector.load(expected.assetId);
        const projected = inspector.state;
        if (
            projected.status !== "ready" ||
            projected.asset.assetId !== expected.assetId ||
            projected.selectedVersion.versionId !== expected.versionId
        ) {
            fail("library_projection");
        }
    } finally {
        inspector.dispose();
        browser.dispose();
        library.dispose();
    }

    const catalog = new CatalogDeploymentController(applicationClient, { createUserActionId });
    try {
        await catalog.load();
        const state = catalog.state;
        const deployments =
            state.status === "ready"
                ? deploymentsForSubject(state.deployments, {
                      subjectKind: "project",
                      projectId: expected.projectId,
                  })
                : [];
        if (state.status !== "ready" || deployments.length !== 1 || deployments[0]?.deploymentId !== expected.deploymentId) {
            fail("deployment_projection");
        }
    } finally {
        catalog.dispose();
    }
}

async function ensureZcodeEnabled(connection: ClientConnectionApi, createUserActionId: () => string): Promise<void> {
    const providers = await connection.request("adapter_provider.list", {});
    if (providers.status !== "complete" || !providers.value.providers.some((provider) => provider.adapterId === "ZCODE")) {
        fail("provider_inventory", providers);
    }
    const current = await connection.request("adapter_enablement.get", {});
    if (current.status !== "complete") fail("enablement", current);
    const enabledAdapterIds = new Set<string>(current.value.enabledAdapterIds);
    if (enabledAdapterIds.has("ZCODE")) return;
    const replaced = await connection.request("adapter_enablement.replace", {
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [...enabledAdapterIds, "ZCODE"].sort(),
        userActionId: createUserActionId(),
    });
    if (replaced.status !== "complete" || !new Set<string>(replaced.value.enabledAdapterIds).has("ZCODE")) {
        fail("enablement", replaced);
    }
}

async function windowsEnvironment(connection: ClientConnectionApi) {
    const environments = await connection.request("environment.list", { platforms: ["win32"] });
    if (environments.status !== "complete") fail("environment", environments);
    const matches = environments.value.environments.filter(
        (entry) => entry.environment.platform === "win32" && entry.environment.platformInstanceId === "desktop-local",
    );
    const selected = matches[0];
    if (matches.length !== 1 || selected === undefined) fail("environment");
    return selected.environment;
}

function exactSelection(analysis: {
    readonly renderInputFingerprint: string;
    readonly options: readonly {
        readonly optionFingerprint: string;
        readonly semanticRefFingerprint: string;
        readonly approvalState: "not_required" | "required";
    }[];
}) {
    const semanticRefs = [...new Set(analysis.options.map((option) => option.semanticRefFingerprint))].sort();
    return {
        schemaVersion: 1 as const,
        renderInputFingerprint: analysis.renderInputFingerprint,
        semanticOptions: semanticRefs.map((semanticRefFingerprint) => {
            const options = analysis.options.filter((option) => option.semanticRefFingerprint === semanticRefFingerprint);
            const option = options[0];
            if (options.length !== 1 || option === undefined || option.approvalState !== "not_required") fail("render_analyze");
            return { optionFingerprint: option.optionFingerprint, approval: { action: "none" as const } };
        }),
    };
}

export function isPackagedZcodeCompleteDirectoryPreview(value: {
    readonly schemaVersion: number;
    readonly files: readonly unknown[];
    readonly directories: readonly { readonly managedBoundaryRelativePath: string }[];
}): boolean {
    return (
        value.schemaVersion === 2 &&
        value.files.length === 4 &&
        value.directories.length === 5 &&
        value.directories.every((entry) => entry.managedBoundaryRelativePath === ".zcode/skills/oaam-phase56-skill")
    );
}

export async function provePackagedZcodeDeploy(
    connections: {
        readonly sourceProjectRegistration: ClientConnectionApi;
        readonly source: ClientConnectionApi;
        readonly targetProjectRegistration: ClientConnectionApi;
        readonly target: ClientConnectionApi;
    },
    request: Extract<PackagedZcodeTargetProofRequest, { readonly mode: "deploy" }>,
    createUserActionId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<PackagedZcodeTargetFixtureSubjects> {
    const [, , , targetAvailableOperations] = await Promise.all([
        initialize(connections.sourceProjectRegistration),
        initialize(connections.source),
        initialize(connections.targetProjectRegistration),
        initialize(connections.target),
    ]);
    const [initialAssets, initialDeployments] = await Promise.all([
        connections.target.request("asset.list", {}),
        connections.target.request("deployment.list", {}),
    ]);
    if (
        initialAssets.status !== "complete" ||
        initialAssets.value.assets.length !== 0 ||
        initialDeployments.status !== "complete" ||
        initialDeployments.value.deployments.length !== 0
    ) {
        fail("empty_state");
    }
    await ensureZcodeEnabled(connections.target, createUserActionId);
    const environment = await windowsEnvironment(connections.target);
    const sourceProject = await connections.sourceProjectRegistration.request("project.register", {
        localPathSelectionToken: request.sourceProjectRegistrationToken,
    });
    if (sourceProject.status !== "complete") fail("source_project", sourceProject);
    const targetProject = await connections.targetProjectRegistration.request("project.register", {
        localPathSelectionToken: request.targetProjectRegistrationToken,
    });
    if (targetProject.status !== "complete") fail("target_project", targetProject);

    const sourceProbeOperation = await connections.source.start("adapter.probe", {
        adapterIds: ["ZCODE"],
        environments: [environment],
        authorization: { scope: "project", localPathSelectionToken: request.sourceProjectToken },
    });
    const sourceProbe = await sourceProbeOperation.terminal;
    if (sourceProbe.status === "failed") fail("source_probe", sourceProbe);
    const sourceResult = sourceProbe.value.results.find(
        (result) =>
            result.adapterId === "ZCODE" &&
            result.environment.platform === "win32" &&
            result.environment.platformInstanceId === "desktop-local",
    );
    const sourceRows =
        sourceResult?.sources.filter(
            (source) =>
                source.accessStatus === "available" &&
                (request.assetKind === "Skill"
                    ? source.sourceDomain === "project_root" &&
                      source.rootRole === "source" &&
                      source.locatorIdentities.some(
                          (identity) =>
                              identity.locatorKind === "runtime_known_rule" && identity.locatorKey === "zcode_project_skill_root",
                      )
                    : request.assetKind === "Memory"
                      ? source.rootRole === "source" && source.sourceDomain === "project_keyed"
                      : source.sourceDomain === "project_root" && source.rootRole === "project_actual"),
        ) ?? [];
    const sourceRow = sourceRows[0];
    if (sourceResult === undefined || sourceRows.length !== 1 || sourceRow === undefined) fail("source_probe", sourceProbe);

    const readOperation = await connections.source.start("adapter.read", {
        probeToken: sourceProbe.value.probeToken,
        selections: [
            {
                probeResultRowId: sourceResult.rowId,
                sourceRootRowIds: [sourceRow.rowId],
                allowedKinds: [request.assetKind],
            },
        ],
    });
    const read = await readOperation.terminal;
    if (read.status !== "complete" || read.value.candidateCount !== 1) fail("source_read", read);
    const previewOperation = await connections.source.start("import.preview", { readToken: read.value.readToken });
    const preview = await previewOperation.terminal;
    const candidate = preview.status === "complete" ? preview.value.candidates[0] : undefined;
    if (
        preview.status !== "complete" ||
        preview.value.candidates.length !== 1 ||
        candidate === undefined ||
        candidate.kind !== request.assetKind ||
        candidate.status !== "importable" ||
        candidate.freshness !== "fresh" ||
        candidate.callableBindingRequestCount !== 0 ||
        candidate.callableBindingRequestsTruncated
    ) {
        fail("source_read", preview);
    }
    const acceptOperation = await connections.source.start("import.accept_batch", {
        previewToken: preview.value.previewToken,
        expectedSnapshotFingerprint: preview.value.snapshotFingerprint,
        decisions: [
            {
                candidateId: candidate.candidateId,
                action: "create_asset",
                freshness: { freshnessAction: "require_current_source" },
                promotion: {
                    promotionAction: "grant_current_version_current_target",
                    target: { targetKind: "project", projectId: sourceProject.value.projectId },
                    userActionId: createUserActionId(),
                },
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
        fail("import_accept", accepted);
    }

    const sourceVersions = await connections.target.request("asset_version.list", {
        assetId: imported.version.assetId,
        pageSize: 50,
    });
    const sourceVersion =
        sourceVersions.status === "complete" && sourceVersions.value.found
            ? sourceVersions.value.value.versions.find((version) => version.versionId === imported.version.versionId)
            : undefined;
    if (
        sourceVersions.status !== "complete" ||
        !sourceVersions.value.found ||
        sourceVersions.value.value.totalCount !== 1 ||
        sourceVersions.value.value.hasMore ||
        sourceVersion === undefined
    ) {
        fail("source_version", sourceVersions);
    }
    const copied = await connections.target.request("asset.copy", {
        source: {
            assetId: sourceVersion.assetId,
            versionId: sourceVersion.versionId,
            versionFingerprint: sourceVersion.fingerprint,
            originAuthorityFingerprint: sourceVersion.originAuthorityFingerprint,
        },
        destination: { scope: "project", projectId: targetProject.value.projectId, scopePath: "" },
        displayName: `Packaged ZCode target ${request.assetKind}`,
        displayDescription: "Copied from the isolated source Project for reviewed deployment",
        userActionId: createUserActionId(),
    });
    if (copied.status !== "complete") fail("asset_copy", copied);
    const promotionGrant = await connections.target.request("promotion_grant.create", {
        promotionAction: "grant_current_version_current_target",
        assetId: copied.value.asset.assetId,
        versionId: copied.value.version.versionId,
        target: { targetKind: "project", projectId: targetProject.value.projectId },
        userActionId: createUserActionId(),
    });
    if (promotionGrant.status !== "complete") fail("promotion_grant", promotionGrant);

    const targetProbeOperation = await connections.target.start("adapter.probe", {
        adapterIds: ["ZCODE"],
        environments: [environment],
        authorization: { scope: "project", localPathSelectionToken: request.targetProjectToken },
    });
    const targetProbe = await targetProbeOperation.terminal;
    if (targetProbe.status === "failed") fail("target_probe", targetProbe);
    const targetResult = targetProbe.value.results.find((result) => result.adapterId === "ZCODE");
    const targets =
        targetResult?.targets.filter(
            (target) =>
                (request.assetKind === "Memory"
                    ? target.targetKind === "directory" && target.displayName.startsWith("ZCode project Memory")
                    : target.targetKind === "project") &&
                target.entryApplicabilities.some(
                    (applicability) => applicability.agentRuntimeId === "ZCODE_APP" && applicability.status === "ready_for_plan",
                ),
        ) ?? [];
    const target = targets[0];
    if (targetResult === undefined || targets.length !== 1 || target === undefined) fail("target_probe", targetProbe);
    const created = await connections.target.request("deployment.create", {
        probeToken: targetProbe.value.probeToken,
        probeResultRowId: targetResult.rowId,
        targetRowId: target.rowId,
        subject: { subjectKind: "project", projectId: targetProject.value.projectId },
        consumerAgentRuntimeIds: ["ZCODE_APP"],
        assets: [{ assetId: copied.value.asset.assetId, versionId: copied.value.version.versionId, allowIncomplete: false }],
    });
    if (created.status !== "complete") fail("deployment_create", created);
    const analysisOperation = await connections.target.start("deployment.render_analyze", {
        deploymentId: created.value.deploymentId,
    });
    const analysis = await analysisOperation.terminal;
    if (analysis.status !== "complete") fail("render_analyze", analysis);
    const renderPreviewOperation = await connections.target.start("deployment.render_preview", {
        deploymentId: created.value.deploymentId,
        selection: exactSelection(analysis.value),
    });
    const renderPreview = await renderPreviewOperation.terminal;
    if (
        renderPreview.status !== "complete" ||
        renderPreview.value.actionState !== "requires_unmanaged_replacement" ||
        !renderPreview.value.files.some(
            (file) => file.baselineState === "unmanaged" && file.changeKind === "replace_unmanaged",
        ) ||
        (request.assetKind === "Skill" && !isPackagedZcodeCompleteDirectoryPreview(renderPreview.value))
    ) {
        fail("render_preview", renderPreview);
    }
    const deployOperation = await connections.target.start("deployment.deploy", {
        previewToken: renderPreview.value.previewToken,
        deploymentAction: "replace_unmanaged",
        userActionId: createUserActionId(),
    });
    const deployed = await deployOperation.terminal;
    if (deployed.status !== "complete" || deployed.value.stage !== "in_sync") fail("deploy", deployed);
    const inspectionOperation = await connections.target.start("deployment.inspect_rendered_target", {
        deploymentId: created.value.deploymentId,
    });
    const inspection = await inspectionOperation.terminal;
    if (inspection.status !== "complete" || inspection.value.changeCount !== 0 || inspection.value.conflictCount !== 0) {
        fail("inspection", inspection);
    }
    const [finalAssets, finalDeployments] = await Promise.all([
        connections.target.request("asset.list", { projectId: targetProject.value.projectId }),
        connections.target.request("deployment.list", {}),
    ]);
    const finalAsset =
        finalAssets.status === "complete"
            ? finalAssets.value.assets.find((asset) => asset.assetId === copied.value.asset.assetId)
            : undefined;
    const finalDeployment =
        finalDeployments.status === "complete"
            ? finalDeployments.value.deployments.find((deployment) => deployment.deploymentId === created.value.deploymentId)
            : undefined;
    if (
        finalAssets.status !== "complete" ||
        finalAsset?.currentVersionId !== copied.value.version.versionId ||
        finalDeployments.status !== "complete" ||
        finalDeployment?.subject.subjectKind !== "project" ||
        finalDeployment.subject.projectId !== targetProject.value.projectId
    ) {
        fail("final_state");
    }
    await proveProjectLibraryAndDeploymentProjection(
        connections.target,
        targetAvailableOperations,
        {
            projectId: targetProject.value.projectId,
            assetId: copied.value.asset.assetId,
            versionId: copied.value.version.versionId,
            deploymentId: created.value.deploymentId,
        },
        request.assetKind,
        createUserActionId,
    );
    return Object.freeze({
        assetKind: request.assetKind,
        source: Object.freeze({
            projectId: sourceProject.value.projectId,
            assetId: imported.version.assetId,
            versionId: imported.version.versionId,
        }),
        target: Object.freeze({
            projectId: targetProject.value.projectId,
            assetId: copied.value.asset.assetId,
            versionId: copied.value.version.versionId,
            deploymentId: created.value.deploymentId,
        }),
    });
}

export async function provePackagedZcodeReverse(
    connection: ClientConnectionApi,
    request: Extract<PackagedZcodeTargetProofRequest, { readonly mode: "reverse" }>,
    createUserActionId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<Extract<PackagedZcodeTargetProofRequest, { readonly mode: "reverse" }>["subject"]> {
    await initialize(connection);
    const deployments = await connection.request("deployment.list", {});
    const deployment =
        deployments.status === "complete"
            ? deployments.value.deployments.find((entry) => entry.deploymentId === request.subject.deploymentId)
            : undefined;
    if (
        deployments.status !== "complete" ||
        deployment === undefined ||
        deployment.subject.subjectKind !== "project" ||
        deployment.subject.projectId !== request.subject.projectId
    ) {
        fail("final_state");
    }
    const assetsBefore = await connection.request("asset.list", { projectId: deployment.subject.projectId });
    const asset =
        assetsBefore.status === "complete"
            ? assetsBefore.value.assets.find((entry) => entry.assetId === request.subject.assetId)
            : undefined;
    if (assetsBefore.status !== "complete" || asset === undefined || asset.currentVersionId !== request.subject.versionId) {
        fail("final_state");
    }
    const inspectionOperation = await connection.start("deployment.inspect_rendered_target", {
        deploymentId: deployment.deploymentId,
    });
    const inspection = await inspectionOperation.terminal;
    const expectedChangeCount = request.assetKind === "Skill" ? 2 : 1;
    if (
        inspection.status !== "complete" ||
        inspection.value.changeCount !== expectedChangeCount ||
        inspection.value.conflictCount !== 0
    ) {
        fail("inspection", inspection);
    }
    const staleOperation = await connection.start("reverse_accept.prepare", {
        deploymentId: deployment.deploymentId,
        inspectionToken: inspection.value.inspectionToken,
        inspectionResultFingerprint: STALE_INSPECTION_FINGERPRINT,
    });
    const stale = await staleOperation.terminal;
    if (stale.status !== "failed") fail("stale_reverse", stale);
    const afterStale = await connection.request("asset.list", { projectId: deployment.subject.projectId });
    if (
        afterStale.status !== "complete" ||
        afterStale.value.assets.find((entry) => entry.assetId === asset.assetId)?.currentVersionId !== asset.currentVersionId
    ) {
        fail("stale_reverse");
    }
    const freshInspectionOperation = await connection.start("deployment.inspect_rendered_target", {
        deploymentId: deployment.deploymentId,
    });
    const freshInspection = await freshInspectionOperation.terminal;
    if (freshInspection.status !== "complete" || freshInspection.value.changeCount !== expectedChangeCount) {
        fail("inspection", freshInspection);
    }
    const prepareOperation = await connection.start("reverse_accept.prepare", {
        deploymentId: deployment.deploymentId,
        inspectionToken: freshInspection.value.inspectionToken,
        inspectionResultFingerprint: freshInspection.value.inspectionResultFingerprint,
    });
    const prepared = await prepareOperation.terminal;
    if (prepared.status !== "complete" || prepared.value.preparationState !== "prepared") fail("reverse_prepare", prepared);
    const commitOperation = await connection.start("reverse_accept.commit", {
        preparationId: prepared.value.preparationId,
        expectedPreparationRevision: prepared.value.preparationRevision,
        userActionId: createUserActionId(),
        newVersionPromotion: "grant_staged_version_current_target",
        renderSelection: exactSelection(prepared.value.renderAnalysis),
    });
    const committed = await commitOperation.terminal;
    if (
        committed.status !== "complete" ||
        committed.value.commitState !== "committed" ||
        committed.value.version.assetId !== asset.assetId ||
        committed.value.version.versionId === asset.currentVersionId
    ) {
        fail("reverse_commit", committed);
    }
    const recoverOperation = await connection.start("deployment.recover", {
        deploymentId: deployment.deploymentId,
    });
    const recovered = await recoverOperation.terminal;
    if (
        recovered.status !== "complete" ||
        recovered.value.assets.length !== 1 ||
        recovered.value.assets[0]?.versionId !== committed.value.version.versionId
    ) {
        fail("reverse_recover", recovered);
    }
    const [assetsAfter, oldVersion, newVersion] = await Promise.all([
        connection.request("asset.list", { projectId: deployment.subject.projectId }),
        connection.request("asset_version.get", { assetId: asset.assetId, versionId: asset.currentVersionId }),
        connection.request("asset_version.get", {
            assetId: committed.value.version.assetId,
            versionId: committed.value.version.versionId,
        }),
    ]);
    if (
        assetsAfter.status !== "complete" ||
        assetsAfter.value.assets.find((entry) => entry.assetId === asset.assetId)?.currentVersionId !==
            committed.value.version.versionId ||
        oldVersion.status !== "complete" ||
        !oldVersion.value.found ||
        newVersion.status !== "complete" ||
        !newVersion.value.found ||
        newVersion.value.value.revision !== oldVersion.value.value.revision + 1
    ) {
        fail("final_state");
    }
    const finalInspectionOperation = await connection.start("deployment.inspect_rendered_target", {
        deploymentId: deployment.deploymentId,
    });
    const finalInspection = await finalInspectionOperation.terminal;
    if (finalInspection.status !== "complete" || finalInspection.value.changeCount !== 0) fail("final_state", finalInspection);
    return Object.freeze({
        ...request.subject,
        versionId: committed.value.version.versionId,
    });
}

export async function runPackagedZcodeTargetProof(
    ports: readonly BrowserProtocolPort[],
    request: PackagedZcodeTargetProofRequest,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): Promise<
    | { readonly mode: "deploy"; readonly subjects: PackagedZcodeTargetFixtureSubjects }
    | {
          readonly mode: "reverse";
          readonly subject: Extract<PackagedZcodeTargetProofRequest, { readonly mode: "reverse" }>["subject"];
      }
> {
    const expectedCount = packagedZcodeTargetProtocolPortCount(request.mode);
    if (ports.length !== expectedCount) throw new Error("Packaged ZCode target proof received an invalid Protocol port count");
    let listenerError: unknown;
    const connections = ports.map((port) =>
        createConnection(new MessagePortClientTransport(port), {
            createRequestId,
            reportListenerError: (error) => {
                listenerError ??= error;
            },
        }),
    );
    try {
        if (request.mode === "deploy") {
            const [sourceProjectRegistration, source, targetProjectRegistration, target] = connections;
            if (
                sourceProjectRegistration === undefined ||
                source === undefined ||
                targetProjectRegistration === undefined ||
                target === undefined
            ) {
                throw new Error("Packaged ZCode deploy proof Protocol ports are unavailable");
            }
            const subjects = await provePackagedZcodeDeploy(
                { sourceProjectRegistration, source, targetProjectRegistration, target },
                request,
            );
            if (listenerError !== undefined) fail("client_listener");
            return Object.freeze({ mode: "deploy", subjects });
        } else {
            const [connection] = connections;
            if (connection === undefined) throw new Error("Packaged ZCode reverse proof Protocol port is unavailable");
            const subject = await provePackagedZcodeReverse(connection, request);
            if (listenerError !== undefined) fail("client_listener");
            return Object.freeze({ mode: "reverse", subject });
        }
    } finally {
        for (const connection of connections) connection.close();
    }
}

export function installPackagedZcodeTargetProofListener(
    browserWindow: Window,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): () => void {
    const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== browserWindow || event.data === null || typeof event.data !== "object") return;
        const signal = (event.data as { readonly signal?: unknown }).signal;
        if (signal !== PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL) return;
        const mode =
            "request" in event.data &&
            typeof event.data.request === "object" &&
            event.data.request !== null &&
            "mode" in event.data.request &&
            event.data.request.mode === "deploy"
                ? "deploy"
                : "reverse";
        if (event.ports.length !== packagedZcodeTargetTransferPortCount(mode)) {
            for (const port of event.ports) port.close();
            return;
        }
        const resultPort = event.ports.at(-1);
        const protocolPorts = event.ports.slice(0, -1);
        if (resultPort === undefined) return;
        void (async () => {
            try {
                const request = parsePackagedZcodeTargetProofRequest((event.data as { readonly request?: unknown }).request);
                const result = await runPackagedZcodeTargetProof(
                    protocolPorts as BrowserProtocolPort[],
                    request,
                    createConnection,
                    createRequestId,
                );
                resultPort.postMessage(
                    result.mode === "deploy"
                        ? Object.freeze({ status: "complete", subjects: result.subjects })
                        : Object.freeze({ status: "complete", subject: result.subject }),
                );
            } catch (error) {
                resultPort.postMessage(
                    Object.freeze({
                        status: "failed",
                        step: error instanceof PackagedZcodeTargetProofFailure ? error.step : "unexpected",
                        diagnosticCodes: error instanceof PackagedZcodeTargetProofFailure ? error.diagnosticCodes : [],
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
