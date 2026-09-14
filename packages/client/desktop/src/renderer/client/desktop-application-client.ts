import type {
    ProtocolAcceptedLongOperationName,
    ProtocolEnvironmentSelectorV1,
    ProtocolInvalidationV1,
    ProtocolOperationName,
    ProtocolOperationParams,
    ProtocolOperationProgress,
    ProtocolOperationResult,
    ProtocolOperationTerminal,
} from "@oaam/app-server-protocol";
import type { ClientConnectionApi } from "@oaam/client-framework";

export type DesktopLongOperationUpdate<TName extends ProtocolAcceptedLongOperationName> =
    | {
          readonly status: "accepted";
          readonly operation: TName;
          readonly operationId: string;
      }
    | {
          readonly status: "progress";
          readonly operation: TName;
          readonly operationId: string;
          readonly sequence: number;
          readonly progress: ProtocolOperationProgress<TName>;
      };

export type DesktopLongOperationListener<TName extends ProtocolAcceptedLongOperationName> = (
    update: DesktopLongOperationUpdate<TName>,
) => void;

export interface DesktopApplicationClientApi {
    readonly availableOperations: readonly ProtocolOperationName[];
    supportsOperation(operation: ProtocolOperationName): boolean;
    listProjects(params?: ProtocolOperationParams<"project.list">): Promise<ProtocolOperationResult<"project.list">>;
    getProject(params: ProtocolOperationParams<"project.get">): Promise<ProtocolOperationResult<"project.get">>;
    registerProject(params: ProtocolOperationParams<"project.register">): Promise<ProtocolOperationResult<"project.register">>;
    inspectProjectLifecycle(
        params: ProtocolOperationParams<"project_lifecycle.inspect">,
        listener?: DesktopLongOperationListener<"project_lifecycle.inspect">,
    ): Promise<ProtocolOperationTerminal<"project_lifecycle.inspect">>;
    commitProjectLifecycle(
        params: ProtocolOperationParams<"project_lifecycle.commit">,
        listener?: DesktopLongOperationListener<"project_lifecycle.commit">,
    ): Promise<ProtocolOperationTerminal<"project_lifecycle.commit">>;
    listAssets(params?: ProtocolOperationParams<"asset.list">): Promise<ProtocolOperationResult<"asset.list">>;
    searchCatalog(params: ProtocolOperationParams<"catalog.search">): Promise<ProtocolOperationResult<"catalog.search">>;
    getAsset(params: ProtocolOperationParams<"asset.get">): Promise<ProtocolOperationResult<"asset.get">>;
    getAssetVersion(params: ProtocolOperationParams<"asset_version.get">): Promise<ProtocolOperationResult<"asset_version.get">>;
    listAssetKindCounts(
        params: ProtocolOperationParams<"asset_library.kind_counts">,
    ): Promise<ProtocolOperationResult<"asset_library.kind_counts">>;
    queryAssetLibrary(
        params: ProtocolOperationParams<"asset_library.page">,
    ): Promise<ProtocolOperationResult<"asset_library.page">>;
    listAssetVersions(
        params: ProtocolOperationParams<"asset_version.list">,
    ): Promise<ProtocolOperationResult<"asset_version.list">>;
    listAssetVersionFileChildren(
        params: ProtocolOperationParams<"asset_version.file_children">,
    ): Promise<ProtocolOperationResult<"asset_version.file_children">>;
    readAssetVersionFilePreview(
        params: ProtocolOperationParams<"asset_version.file_preview">,
    ): Promise<ProtocolOperationResult<"asset_version.file_preview">>;
    readAssetVersionTextPage(
        params: ProtocolOperationParams<"asset_version.text_page">,
    ): Promise<ProtocolOperationResult<"asset_version.text_page">>;
    compareAssetVersions(
        params: ProtocolOperationParams<"asset_version.compare">,
        listener?: DesktopLongOperationListener<"asset_version.compare">,
    ): Promise<ProtocolOperationTerminal<"asset_version.compare">>;
    exportAssetVersion(
        params: ProtocolOperationParams<"asset_version.export">,
        listener?: DesktopLongOperationListener<"asset_version.export">,
    ): Promise<ProtocolOperationTerminal<"asset_version.export">>;
    exportAssetVersionNative(
        params: ProtocolOperationParams<"asset_version.export_native">,
        listener?: DesktopLongOperationListener<"asset_version.export_native">,
    ): Promise<ProtocolOperationTerminal<"asset_version.export_native">>;
    updateAssetDisplay(
        params: ProtocolOperationParams<"asset.display.update">,
    ): Promise<ProtocolOperationResult<"asset.display.update">>;
    copyAsset(params: ProtocolOperationParams<"asset.copy">): Promise<ProtocolOperationResult<"asset.copy">>;
    softDeleteAsset(params: ProtocolOperationParams<"asset.soft_delete">): Promise<ProtocolOperationResult<"asset.soft_delete">>;
    restoreAsset(params: ProtocolOperationParams<"asset.restore">): Promise<ProtocolOperationResult<"asset.restore">>;
    inspectAssetPurge(
        params: ProtocolOperationParams<"asset.purge.inspect">,
    ): Promise<ProtocolOperationResult<"asset.purge.inspect">>;
    commitAssetPurge(
        params: ProtocolOperationParams<"asset.purge.commit">,
        listener?: DesktopLongOperationListener<"asset.purge.commit">,
    ): Promise<ProtocolOperationTerminal<"asset.purge.commit">>;
    cancelOperation(params: ProtocolOperationParams<"operation.cancel">): Promise<ProtocolOperationResult<"operation.cancel">>;
    listDeployments(params?: ProtocolOperationParams<"deployment.list">): Promise<ProtocolOperationResult<"deployment.list">>;
    getDeployment(params: ProtocolOperationParams<"deployment.get">): Promise<ProtocolOperationResult<"deployment.get">>;
    createDeployment(params: ProtocolOperationParams<"deployment.create">): Promise<ProtocolOperationResult<"deployment.create">>;
    updateDeploymentInputs(
        params: ProtocolOperationParams<"deployment.update_inputs">,
    ): Promise<ProtocolOperationResult<"deployment.update_inputs">>;
    analyzeAssetUsage(
        params: ProtocolOperationParams<"asset_usage.analyze">,
        listener?: DesktopLongOperationListener<"asset_usage.analyze">,
    ): Promise<ProtocolOperationTerminal<"asset_usage.analyze">>;
    analyzeDeployment(
        params: ProtocolOperationParams<"deployment.render_analyze">,
        listener?: DesktopLongOperationListener<"deployment.render_analyze">,
    ): Promise<ProtocolOperationTerminal<"deployment.render_analyze">>;
    previewDeployment(
        params: ProtocolOperationParams<"deployment.render_preview">,
        listener?: DesktopLongOperationListener<"deployment.render_preview">,
    ): Promise<ProtocolOperationTerminal<"deployment.render_preview">>;
    deploy(
        params: ProtocolOperationParams<"deployment.deploy">,
        listener?: DesktopLongOperationListener<"deployment.deploy">,
    ): Promise<ProtocolOperationTerminal<"deployment.deploy">>;
    scanDeployment(
        params: ProtocolOperationParams<"deployment.scan">,
        listener?: DesktopLongOperationListener<"deployment.scan">,
    ): Promise<ProtocolOperationTerminal<"deployment.scan">>;
    inspectRenderedTarget(
        params: ProtocolOperationParams<"deployment.inspect_rendered_target">,
        listener?: DesktopLongOperationListener<"deployment.inspect_rendered_target">,
    ): Promise<ProtocolOperationTerminal<"deployment.inspect_rendered_target">>;
    getRenderedInspectionDetail(
        params: ProtocolOperationParams<"rendered_inspection.detail">,
    ): Promise<ProtocolOperationResult<"rendered_inspection.detail">>;
    repairDeployment(
        params: ProtocolOperationParams<"deployment.repair">,
        listener?: DesktopLongOperationListener<"deployment.repair">,
    ): Promise<ProtocolOperationTerminal<"deployment.repair">>;
    recoverDeployment(
        params: ProtocolOperationParams<"deployment.recover">,
        listener?: DesktopLongOperationListener<"deployment.recover">,
    ): Promise<ProtocolOperationTerminal<"deployment.recover">>;
    subscribeInvalidation(listener: (invalidation: ProtocolInvalidationV1) => void): () => void;
    listAdapterProviders(): Promise<ProtocolOperationResult<"adapter_provider.list">>;
    getAdapterEnablement(): Promise<ProtocolOperationResult<"adapter_enablement.get">>;
    replaceAdapterEnablement(
        params: ProtocolOperationParams<"adapter_enablement.replace">,
    ): Promise<ProtocolOperationResult<"adapter_enablement.replace">>;
    getWatchedScanIntent(): Promise<ProtocolOperationResult<"watched_scan_intent.get">>;
    listProbeEnvironmentReferences(
        params: ProtocolOperationParams<"probe_environment_reference.list">,
    ): Promise<ProtocolOperationResult<"probe_environment_reference.list">>;
    replaceWatchedScanIntent(
        params: ProtocolOperationParams<"watched_scan_intent.replace">,
    ): Promise<ProtocolOperationResult<"watched_scan_intent.replace">>;
    resetWatchedScanIntent(
        params: ProtocolOperationParams<"watched_scan_intent.reset">,
    ): Promise<ProtocolOperationResult<"watched_scan_intent.reset">>;
    listEnvironments(
        platforms: ProtocolOperationParams<"environment.list">["platforms"],
    ): Promise<ProtocolOperationResult<"environment.list">>;
    probeGlobal(
        adapterIds: ProtocolOperationParams<"adapter.probe">["adapterIds"],
        environments: readonly [ProtocolEnvironmentSelectorV1, ...ProtocolEnvironmentSelectorV1[]],
        installationRootSelectionToken?: string,
        listener?: DesktopLongOperationListener<"adapter.probe">,
    ): Promise<ProtocolOperationTerminal<"adapter.probe">>;
    probeProject(
        adapterIds: ProtocolOperationParams<"adapter.probe">["adapterIds"],
        environments: readonly [ProtocolEnvironmentSelectorV1, ...ProtocolEnvironmentSelectorV1[]],
        localPathSelectionToken: string,
        installationRootSelectionToken?: string,
        listener?: DesktopLongOperationListener<"adapter.probe">,
    ): Promise<ProtocolOperationTerminal<"adapter.probe">>;
    probeDirectory(
        adapterIds: ProtocolOperationParams<"adapter.probe">["adapterIds"],
        environments: readonly [ProtocolEnvironmentSelectorV1, ...ProtocolEnvironmentSelectorV1[]],
        localPathSelectionToken: string,
        installationRootSelectionToken?: string,
        listener?: DesktopLongOperationListener<"adapter.probe">,
    ): Promise<ProtocolOperationTerminal<"adapter.probe">>;
    readSources(params: ProtocolOperationParams<"adapter.read">): Promise<ProtocolOperationTerminal<"adapter.read">>;
    previewImport(params: ProtocolOperationParams<"import.preview">): Promise<ProtocolOperationTerminal<"import.preview">>;
    getImportPreviewDetail(
        params: ProtocolOperationParams<"import_preview.detail">,
    ): Promise<ProtocolOperationResult<"import_preview.detail">>;
    cancelImportPreview(
        params: ProtocolOperationParams<"import_preview.cancel">,
    ): Promise<ProtocolOperationResult<"import_preview.cancel">>;
    acceptImportBatch(
        params: ProtocolOperationParams<"import.accept_batch">,
    ): Promise<ProtocolOperationTerminal<"import.accept_batch">>;
    listPromotionGrants(
        params: ProtocolOperationParams<"promotion_grant.list">,
    ): Promise<ProtocolOperationResult<"promotion_grant.list">>;
    createPromotionGrant(
        params: ProtocolOperationParams<"promotion_grant.create">,
    ): Promise<ProtocolOperationResult<"promotion_grant.create">>;
    revokePromotionGrant(
        params: ProtocolOperationParams<"promotion_grant.revoke">,
    ): Promise<ProtocolOperationResult<"promotion_grant.revoke">>;
    getRestrictedSourceFullAccess(): Promise<ProtocolOperationResult<"restricted_source_full_access.get">>;
    setRestrictedSourceFullAccess(
        params: ProtocolOperationParams<"restricted_source_full_access.set">,
    ): Promise<ProtocolOperationResult<"restricted_source_full_access.set">>;
    prepareReverseAccept(
        params: ProtocolOperationParams<"reverse_accept.prepare">,
        listener?: DesktopLongOperationListener<"reverse_accept.prepare">,
    ): Promise<ProtocolOperationTerminal<"reverse_accept.prepare">>;
    commitReverseAccept(
        params: ProtocolOperationParams<"reverse_accept.commit">,
        listener?: DesktopLongOperationListener<"reverse_accept.commit">,
    ): Promise<ProtocolOperationTerminal<"reverse_accept.commit">>;
    cancelReverseAccept(
        params: ProtocolOperationParams<"reverse_accept.cancel">,
        listener?: DesktopLongOperationListener<"reverse_accept.cancel">,
    ): Promise<ProtocolOperationTerminal<"reverse_accept.cancel">>;
    reindexAssets(
        params: ProtocolOperationParams<"asset.reindex">,
        listener?: DesktopLongOperationListener<"asset.reindex">,
    ): Promise<ProtocolOperationTerminal<"asset.reindex">>;
    listStateBackups(): Promise<ProtocolOperationResult<"state_backup.list">>;
    getStateBackupPromptPolicy(): Promise<ProtocolOperationResult<"state_backup_prompt_policy.get">>;
    replaceStateBackupPromptPolicy(
        params: ProtocolOperationParams<"state_backup_prompt_policy.replace">,
    ): Promise<ProtocolOperationResult<"state_backup_prompt_policy.replace">>;
    getDiagnosticsHealth(): Promise<ProtocolOperationResult<"diagnostics.health.get">>;
    getOrdinaryLogSettings(): Promise<ProtocolOperationResult<"diagnostics.ordinary_log.settings.get">>;
    replaceOrdinaryLogSettings(
        params: ProtocolOperationParams<"diagnostics.ordinary_log.settings.replace">,
    ): Promise<ProtocolOperationResult<"diagnostics.ordinary_log.settings.replace">>;
    clearOrdinaryLog(
        params: ProtocolOperationParams<"diagnostics.ordinary_log.clear">,
    ): Promise<ProtocolOperationResult<"diagnostics.ordinary_log.clear">>;
    inspectSupportBundle(
        params: ProtocolOperationParams<"diagnostics.support_bundle.inspect">,
        listener?: DesktopLongOperationListener<"diagnostics.support_bundle.inspect">,
    ): Promise<ProtocolOperationTerminal<"diagnostics.support_bundle.inspect">>;
    exportSupportBundle(
        params: ProtocolOperationParams<"diagnostics.support_bundle.export">,
        listener?: DesktopLongOperationListener<"diagnostics.support_bundle.export">,
    ): Promise<ProtocolOperationTerminal<"diagnostics.support_bundle.export">>;
    inspectStateBackup(
        params: ProtocolOperationParams<"state_backup.inspect">,
        listener?: DesktopLongOperationListener<"state_backup.inspect">,
    ): Promise<ProtocolOperationTerminal<"state_backup.inspect">>;
    createStateBackup(
        params: ProtocolOperationParams<"state_backup.create">,
        listener?: DesktopLongOperationListener<"state_backup.create">,
    ): Promise<ProtocolOperationTerminal<"state_backup.create">>;
    inspectStateRestore(
        params: ProtocolOperationParams<"state_restore.inspect">,
        listener?: DesktopLongOperationListener<"state_restore.inspect">,
    ): Promise<ProtocolOperationTerminal<"state_restore.inspect">>;
    activateStateRestore(
        params: ProtocolOperationParams<"state_restore.activate">,
        listener?: DesktopLongOperationListener<"state_restore.activate">,
    ): Promise<ProtocolOperationTerminal<"state_restore.activate">>;
}

export class DesktopApplicationClient implements DesktopApplicationClientApi {
    readonly #connection: ClientConnectionApi;
    readonly #availableOperations: readonly ProtocolOperationName[];
    readonly #availableOperationSet: ReadonlySet<ProtocolOperationName>;

    public constructor(
        connection: ClientConnectionApi,
        availableOperations: readonly ProtocolOperationName[] = connection.availableOperations,
    ) {
        this.#connection = connection;
        this.#availableOperations = Object.freeze([...availableOperations]);
        this.#availableOperationSet = new Set(this.#availableOperations);
    }

    public get availableOperations(): readonly ProtocolOperationName[] {
        return this.#availableOperations;
    }

    public supportsOperation(operation: ProtocolOperationName): boolean {
        return this.#availableOperationSet.has(operation);
    }

    public listProjects(params: ProtocolOperationParams<"project.list"> = {}): Promise<ProtocolOperationResult<"project.list">> {
        return this.#connection.request("project.list", params);
    }

    public getProject(params: ProtocolOperationParams<"project.get">): Promise<ProtocolOperationResult<"project.get">> {
        return this.#connection.request("project.get", params);
    }

    public registerProject(
        params: ProtocolOperationParams<"project.register">,
    ): Promise<ProtocolOperationResult<"project.register">> {
        return this.#connection.request("project.register", params);
    }

    public inspectProjectLifecycle(
        params: ProtocolOperationParams<"project_lifecycle.inspect">,
        listener?: DesktopLongOperationListener<"project_lifecycle.inspect">,
    ): Promise<ProtocolOperationTerminal<"project_lifecycle.inspect">> {
        return this.#runLong("project_lifecycle.inspect", params, listener);
    }

    public commitProjectLifecycle(
        params: ProtocolOperationParams<"project_lifecycle.commit">,
        listener?: DesktopLongOperationListener<"project_lifecycle.commit">,
    ): Promise<ProtocolOperationTerminal<"project_lifecycle.commit">> {
        return this.#runLong("project_lifecycle.commit", params, listener);
    }

    public listAssets(params: ProtocolOperationParams<"asset.list"> = {}): Promise<ProtocolOperationResult<"asset.list">> {
        return this.#connection.request("asset.list", params);
    }

    public searchCatalog(params: ProtocolOperationParams<"catalog.search">): Promise<ProtocolOperationResult<"catalog.search">> {
        return this.#connection.request("catalog.search", params);
    }

    public getAsset(params: ProtocolOperationParams<"asset.get">): Promise<ProtocolOperationResult<"asset.get">> {
        return this.#connection.request("asset.get", params);
    }

    public getAssetVersion(
        params: ProtocolOperationParams<"asset_version.get">,
    ): Promise<ProtocolOperationResult<"asset_version.get">> {
        return this.#connection.request("asset_version.get", params);
    }

    public listAssetKindCounts(
        params: ProtocolOperationParams<"asset_library.kind_counts">,
    ): Promise<ProtocolOperationResult<"asset_library.kind_counts">> {
        return this.#connection.request("asset_library.kind_counts", params);
    }

    public queryAssetLibrary(
        params: ProtocolOperationParams<"asset_library.page">,
    ): Promise<ProtocolOperationResult<"asset_library.page">> {
        return this.#connection.request("asset_library.page", params);
    }

    public listAssetVersions(
        params: ProtocolOperationParams<"asset_version.list">,
    ): Promise<ProtocolOperationResult<"asset_version.list">> {
        return this.#connection.request("asset_version.list", params);
    }

    public listAssetVersionFileChildren(
        params: ProtocolOperationParams<"asset_version.file_children">,
    ): Promise<ProtocolOperationResult<"asset_version.file_children">> {
        return this.#connection.request("asset_version.file_children", params);
    }

    public readAssetVersionFilePreview(
        params: ProtocolOperationParams<"asset_version.file_preview">,
    ): Promise<ProtocolOperationResult<"asset_version.file_preview">> {
        return this.#connection.request("asset_version.file_preview", params);
    }

    public readAssetVersionTextPage(
        params: ProtocolOperationParams<"asset_version.text_page">,
    ): Promise<ProtocolOperationResult<"asset_version.text_page">> {
        return this.#connection.request("asset_version.text_page", params);
    }

    public compareAssetVersions(
        params: ProtocolOperationParams<"asset_version.compare">,
        listener?: DesktopLongOperationListener<"asset_version.compare">,
    ): Promise<ProtocolOperationTerminal<"asset_version.compare">> {
        return this.#runLong("asset_version.compare", params, listener);
    }

    public exportAssetVersion(
        params: ProtocolOperationParams<"asset_version.export">,
        listener?: DesktopLongOperationListener<"asset_version.export">,
    ): Promise<ProtocolOperationTerminal<"asset_version.export">> {
        return this.#runLong("asset_version.export", params, listener);
    }

    public exportAssetVersionNative(
        params: ProtocolOperationParams<"asset_version.export_native">,
        listener?: DesktopLongOperationListener<"asset_version.export_native">,
    ): Promise<ProtocolOperationTerminal<"asset_version.export_native">> {
        return this.#runLong("asset_version.export_native", params, listener);
    }

    public updateAssetDisplay(
        params: ProtocolOperationParams<"asset.display.update">,
    ): Promise<ProtocolOperationResult<"asset.display.update">> {
        return this.#connection.request("asset.display.update", params);
    }

    public copyAsset(params: ProtocolOperationParams<"asset.copy">): Promise<ProtocolOperationResult<"asset.copy">> {
        return this.#connection.request("asset.copy", params);
    }

    public softDeleteAsset(
        params: ProtocolOperationParams<"asset.soft_delete">,
    ): Promise<ProtocolOperationResult<"asset.soft_delete">> {
        return this.#connection.request("asset.soft_delete", params);
    }

    public restoreAsset(params: ProtocolOperationParams<"asset.restore">): Promise<ProtocolOperationResult<"asset.restore">> {
        return this.#connection.request("asset.restore", params);
    }

    public inspectAssetPurge(
        params: ProtocolOperationParams<"asset.purge.inspect">,
    ): Promise<ProtocolOperationResult<"asset.purge.inspect">> {
        return this.#connection.request("asset.purge.inspect", params);
    }

    public commitAssetPurge(
        params: ProtocolOperationParams<"asset.purge.commit">,
        listener?: DesktopLongOperationListener<"asset.purge.commit">,
    ): Promise<ProtocolOperationTerminal<"asset.purge.commit">> {
        return this.#runLong("asset.purge.commit", params, listener);
    }

    public cancelOperation(
        params: ProtocolOperationParams<"operation.cancel">,
    ): Promise<ProtocolOperationResult<"operation.cancel">> {
        return this.#connection.request("operation.cancel", params);
    }

    public listDeployments(
        params: ProtocolOperationParams<"deployment.list"> = {},
    ): Promise<ProtocolOperationResult<"deployment.list">> {
        return this.#connection.request("deployment.list", params);
    }

    public getDeployment(params: ProtocolOperationParams<"deployment.get">): Promise<ProtocolOperationResult<"deployment.get">> {
        return this.#connection.request("deployment.get", params);
    }

    public createDeployment(
        params: ProtocolOperationParams<"deployment.create">,
    ): Promise<ProtocolOperationResult<"deployment.create">> {
        return this.#connection.request("deployment.create", params);
    }

    public updateDeploymentInputs(
        params: ProtocolOperationParams<"deployment.update_inputs">,
    ): Promise<ProtocolOperationResult<"deployment.update_inputs">> {
        return this.#connection.request("deployment.update_inputs", params);
    }

    public analyzeAssetUsage(
        params: ProtocolOperationParams<"asset_usage.analyze">,
        listener?: DesktopLongOperationListener<"asset_usage.analyze">,
    ): Promise<ProtocolOperationTerminal<"asset_usage.analyze">> {
        return this.#runLong("asset_usage.analyze", params, listener);
    }

    public analyzeDeployment(
        params: ProtocolOperationParams<"deployment.render_analyze">,
        listener?: DesktopLongOperationListener<"deployment.render_analyze">,
    ): Promise<ProtocolOperationTerminal<"deployment.render_analyze">> {
        return this.#runLong("deployment.render_analyze", params, listener);
    }

    public previewDeployment(
        params: ProtocolOperationParams<"deployment.render_preview">,
        listener?: DesktopLongOperationListener<"deployment.render_preview">,
    ): Promise<ProtocolOperationTerminal<"deployment.render_preview">> {
        return this.#runLong("deployment.render_preview", params, listener);
    }

    public deploy(
        params: ProtocolOperationParams<"deployment.deploy">,
        listener?: DesktopLongOperationListener<"deployment.deploy">,
    ): Promise<ProtocolOperationTerminal<"deployment.deploy">> {
        return this.#runLong("deployment.deploy", params, listener);
    }

    public scanDeployment(
        params: ProtocolOperationParams<"deployment.scan">,
        listener?: DesktopLongOperationListener<"deployment.scan">,
    ): Promise<ProtocolOperationTerminal<"deployment.scan">> {
        return this.#runLong("deployment.scan", params, listener);
    }

    public inspectRenderedTarget(
        params: ProtocolOperationParams<"deployment.inspect_rendered_target">,
        listener?: DesktopLongOperationListener<"deployment.inspect_rendered_target">,
    ): Promise<ProtocolOperationTerminal<"deployment.inspect_rendered_target">> {
        return this.#runLong("deployment.inspect_rendered_target", params, listener);
    }

    public getRenderedInspectionDetail(
        params: ProtocolOperationParams<"rendered_inspection.detail">,
    ): Promise<ProtocolOperationResult<"rendered_inspection.detail">> {
        return this.#connection.request("rendered_inspection.detail", params);
    }

    public repairDeployment(
        params: ProtocolOperationParams<"deployment.repair">,
        listener?: DesktopLongOperationListener<"deployment.repair">,
    ): Promise<ProtocolOperationTerminal<"deployment.repair">> {
        return this.#runLong("deployment.repair", params, listener);
    }

    public recoverDeployment(
        params: ProtocolOperationParams<"deployment.recover">,
        listener?: DesktopLongOperationListener<"deployment.recover">,
    ): Promise<ProtocolOperationTerminal<"deployment.recover">> {
        return this.#runLong("deployment.recover", params, listener);
    }

    public subscribeInvalidation(listener: (invalidation: ProtocolInvalidationV1) => void): () => void {
        return this.#connection.subscribeInvalidation(listener);
    }

    public listAdapterProviders(): Promise<ProtocolOperationResult<"adapter_provider.list">> {
        return this.#connection.request("adapter_provider.list", {});
    }

    public getAdapterEnablement(): Promise<ProtocolOperationResult<"adapter_enablement.get">> {
        return this.#connection.request("adapter_enablement.get", {});
    }

    public replaceAdapterEnablement(
        params: ProtocolOperationParams<"adapter_enablement.replace">,
    ): Promise<ProtocolOperationResult<"adapter_enablement.replace">> {
        return this.#connection.request("adapter_enablement.replace", params);
    }

    public getWatchedScanIntent(): Promise<ProtocolOperationResult<"watched_scan_intent.get">> {
        return this.#connection.request("watched_scan_intent.get", {});
    }

    public listProbeEnvironmentReferences(
        params: ProtocolOperationParams<"probe_environment_reference.list">,
    ): Promise<ProtocolOperationResult<"probe_environment_reference.list">> {
        return this.#connection.request("probe_environment_reference.list", params);
    }

    public replaceWatchedScanIntent(
        params: ProtocolOperationParams<"watched_scan_intent.replace">,
    ): Promise<ProtocolOperationResult<"watched_scan_intent.replace">> {
        return this.#connection.request("watched_scan_intent.replace", params);
    }

    public resetWatchedScanIntent(
        params: ProtocolOperationParams<"watched_scan_intent.reset">,
    ): Promise<ProtocolOperationResult<"watched_scan_intent.reset">> {
        return this.#connection.request("watched_scan_intent.reset", params);
    }

    public listEnvironments(
        platforms: ProtocolOperationParams<"environment.list">["platforms"],
    ): Promise<ProtocolOperationResult<"environment.list">> {
        return this.#connection.request("environment.list", { platforms });
    }

    public async probeGlobal(
        adapterIds: ProtocolOperationParams<"adapter.probe">["adapterIds"],
        environments: readonly [ProtocolEnvironmentSelectorV1, ...ProtocolEnvironmentSelectorV1[]],
        installationRootSelectionToken?: string,
        listener?: DesktopLongOperationListener<"adapter.probe">,
    ): Promise<ProtocolOperationTerminal<"adapter.probe">> {
        return this.#probe(adapterIds, environments, { scope: "global" }, installationRootSelectionToken, listener);
    }

    public probeProject(
        adapterIds: ProtocolOperationParams<"adapter.probe">["adapterIds"],
        environments: readonly [ProtocolEnvironmentSelectorV1, ...ProtocolEnvironmentSelectorV1[]],
        localPathSelectionToken: string,
        installationRootSelectionToken?: string,
        listener?: DesktopLongOperationListener<"adapter.probe">,
    ): Promise<ProtocolOperationTerminal<"adapter.probe">> {
        return this.#probe(
            adapterIds,
            environments,
            { scope: "project", localPathSelectionToken },
            installationRootSelectionToken,
            listener,
        );
    }

    public probeDirectory(
        adapterIds: ProtocolOperationParams<"adapter.probe">["adapterIds"],
        environments: readonly [ProtocolEnvironmentSelectorV1, ...ProtocolEnvironmentSelectorV1[]],
        localPathSelectionToken: string,
        installationRootSelectionToken?: string,
        listener?: DesktopLongOperationListener<"adapter.probe">,
    ): Promise<ProtocolOperationTerminal<"adapter.probe">> {
        return this.#probe(
            adapterIds,
            environments,
            { scope: "directory", localPathSelectionToken },
            installationRootSelectionToken,
            listener,
        );
    }

    public async readSources(
        params: ProtocolOperationParams<"adapter.read">,
    ): Promise<ProtocolOperationTerminal<"adapter.read">> {
        const operation = await this.#connection.start("adapter.read", params);
        return operation.terminal;
    }

    public async previewImport(
        params: ProtocolOperationParams<"import.preview">,
    ): Promise<ProtocolOperationTerminal<"import.preview">> {
        const operation = await this.#connection.start("import.preview", params);
        return operation.terminal;
    }

    public getImportPreviewDetail(
        params: ProtocolOperationParams<"import_preview.detail">,
    ): Promise<ProtocolOperationResult<"import_preview.detail">> {
        return this.#connection.request("import_preview.detail", params);
    }

    public cancelImportPreview(
        params: ProtocolOperationParams<"import_preview.cancel">,
    ): Promise<ProtocolOperationResult<"import_preview.cancel">> {
        return this.#connection.request("import_preview.cancel", params);
    }

    public async acceptImportBatch(
        params: ProtocolOperationParams<"import.accept_batch">,
    ): Promise<ProtocolOperationTerminal<"import.accept_batch">> {
        const operation = await this.#connection.start("import.accept_batch", params);
        return operation.terminal;
    }

    public listPromotionGrants(
        params: ProtocolOperationParams<"promotion_grant.list">,
    ): Promise<ProtocolOperationResult<"promotion_grant.list">> {
        return this.#connection.request("promotion_grant.list", params);
    }

    public createPromotionGrant(
        params: ProtocolOperationParams<"promotion_grant.create">,
    ): Promise<ProtocolOperationResult<"promotion_grant.create">> {
        return this.#connection.request("promotion_grant.create", params);
    }

    public revokePromotionGrant(
        params: ProtocolOperationParams<"promotion_grant.revoke">,
    ): Promise<ProtocolOperationResult<"promotion_grant.revoke">> {
        return this.#connection.request("promotion_grant.revoke", params);
    }

    public getRestrictedSourceFullAccess(): Promise<ProtocolOperationResult<"restricted_source_full_access.get">> {
        return this.#connection.request("restricted_source_full_access.get", {});
    }

    public setRestrictedSourceFullAccess(
        params: ProtocolOperationParams<"restricted_source_full_access.set">,
    ): Promise<ProtocolOperationResult<"restricted_source_full_access.set">> {
        return this.#connection.request("restricted_source_full_access.set", params);
    }

    public prepareReverseAccept(
        params: ProtocolOperationParams<"reverse_accept.prepare">,
        listener?: DesktopLongOperationListener<"reverse_accept.prepare">,
    ): Promise<ProtocolOperationTerminal<"reverse_accept.prepare">> {
        return this.#runLong("reverse_accept.prepare", params, listener);
    }

    public commitReverseAccept(
        params: ProtocolOperationParams<"reverse_accept.commit">,
        listener?: DesktopLongOperationListener<"reverse_accept.commit">,
    ): Promise<ProtocolOperationTerminal<"reverse_accept.commit">> {
        return this.#runLong("reverse_accept.commit", params, listener);
    }

    public cancelReverseAccept(
        params: ProtocolOperationParams<"reverse_accept.cancel">,
        listener?: DesktopLongOperationListener<"reverse_accept.cancel">,
    ): Promise<ProtocolOperationTerminal<"reverse_accept.cancel">> {
        return this.#runLong("reverse_accept.cancel", params, listener);
    }

    public reindexAssets(
        params: ProtocolOperationParams<"asset.reindex">,
        listener?: DesktopLongOperationListener<"asset.reindex">,
    ): Promise<ProtocolOperationTerminal<"asset.reindex">> {
        return this.#runLong("asset.reindex", params, listener);
    }

    public listStateBackups(): Promise<ProtocolOperationResult<"state_backup.list">> {
        return this.#connection.request("state_backup.list", {});
    }

    public getStateBackupPromptPolicy(): Promise<ProtocolOperationResult<"state_backup_prompt_policy.get">> {
        return this.#connection.request("state_backup_prompt_policy.get", {});
    }

    public replaceStateBackupPromptPolicy(
        params: ProtocolOperationParams<"state_backup_prompt_policy.replace">,
    ): Promise<ProtocolOperationResult<"state_backup_prompt_policy.replace">> {
        return this.#connection.request("state_backup_prompt_policy.replace", params);
    }

    public getDiagnosticsHealth(): Promise<ProtocolOperationResult<"diagnostics.health.get">> {
        return this.#connection.request("diagnostics.health.get", {});
    }

    public getOrdinaryLogSettings(): Promise<ProtocolOperationResult<"diagnostics.ordinary_log.settings.get">> {
        return this.#connection.request("diagnostics.ordinary_log.settings.get", {});
    }

    public replaceOrdinaryLogSettings(
        params: ProtocolOperationParams<"diagnostics.ordinary_log.settings.replace">,
    ): Promise<ProtocolOperationResult<"diagnostics.ordinary_log.settings.replace">> {
        return this.#connection.request("diagnostics.ordinary_log.settings.replace", params);
    }

    public clearOrdinaryLog(
        params: ProtocolOperationParams<"diagnostics.ordinary_log.clear">,
    ): Promise<ProtocolOperationResult<"diagnostics.ordinary_log.clear">> {
        return this.#connection.request("diagnostics.ordinary_log.clear", params);
    }

    public inspectSupportBundle(
        params: ProtocolOperationParams<"diagnostics.support_bundle.inspect">,
        listener?: DesktopLongOperationListener<"diagnostics.support_bundle.inspect">,
    ): Promise<ProtocolOperationTerminal<"diagnostics.support_bundle.inspect">> {
        return this.#runLong("diagnostics.support_bundle.inspect", params, listener);
    }

    public exportSupportBundle(
        params: ProtocolOperationParams<"diagnostics.support_bundle.export">,
        listener?: DesktopLongOperationListener<"diagnostics.support_bundle.export">,
    ): Promise<ProtocolOperationTerminal<"diagnostics.support_bundle.export">> {
        return this.#runLong("diagnostics.support_bundle.export", params, listener);
    }

    public inspectStateBackup(
        params: ProtocolOperationParams<"state_backup.inspect">,
        listener?: DesktopLongOperationListener<"state_backup.inspect">,
    ): Promise<ProtocolOperationTerminal<"state_backup.inspect">> {
        return this.#runLong("state_backup.inspect", params, listener);
    }

    public createStateBackup(
        params: ProtocolOperationParams<"state_backup.create">,
        listener?: DesktopLongOperationListener<"state_backup.create">,
    ): Promise<ProtocolOperationTerminal<"state_backup.create">> {
        return this.#runLong("state_backup.create", params, listener);
    }

    public inspectStateRestore(
        params: ProtocolOperationParams<"state_restore.inspect">,
        listener?: DesktopLongOperationListener<"state_restore.inspect">,
    ): Promise<ProtocolOperationTerminal<"state_restore.inspect">> {
        return this.#runLong("state_restore.inspect", params, listener);
    }

    public activateStateRestore(
        params: ProtocolOperationParams<"state_restore.activate">,
        listener?: DesktopLongOperationListener<"state_restore.activate">,
    ): Promise<ProtocolOperationTerminal<"state_restore.activate">> {
        return this.#runLong("state_restore.activate", params, listener);
    }

    async #probe(
        adapterIds: ProtocolOperationParams<"adapter.probe">["adapterIds"],
        environments: readonly [ProtocolEnvironmentSelectorV1, ...ProtocolEnvironmentSelectorV1[]],
        authorization: ProtocolOperationParams<"adapter.probe">["authorization"],
        installationRootSelectionToken?: string,
        listener?: DesktopLongOperationListener<"adapter.probe">,
    ): Promise<ProtocolOperationTerminal<"adapter.probe">> {
        return this.#runLong(
            "adapter.probe",
            {
                adapterIds,
                environments,
                authorization,
                ...(installationRootSelectionToken === undefined ? {} : { installationRootSelectionToken }),
            },
            listener,
        );
    }

    async #runLong<TName extends ProtocolAcceptedLongOperationName>(
        operationName: TName,
        params: ProtocolOperationParams<TName>,
        listener?: DesktopLongOperationListener<TName>,
    ): Promise<ProtocolOperationTerminal<TName>> {
        const operation = await this.#connection.start(operationName, params);
        listener?.(
            Object.freeze({
                status: "accepted",
                operation: operationName,
                operationId: operation.operationId,
            }),
        );
        const unsubscribe = operation.subscribeProgress((progress, sequence) => {
            listener?.(
                Object.freeze({
                    status: "progress",
                    operation: operationName,
                    operationId: operation.operationId,
                    sequence,
                    progress,
                }),
            );
        });
        try {
            return await operation.terminal;
        } finally {
            unsubscribe();
        }
    }
}
