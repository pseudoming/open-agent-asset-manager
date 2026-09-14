import type {
    AdapterEnablementSettingV1,
    AdapterProviderSummary,
    AssetManifestV1,
    AssetPurgePreparationV1,
    AssetVersionBundle,
    AssetVersionManifestV2,
    CoreResult,
    CoreService,
    CurrentAssetSummary,
    DeploymentView,
    ProjectManifestV1,
    PromotionGrantV1,
    RestrictedSourcePromotionFullAccessSettingV1,
    Sha256Digest,
    WatchedScanIntentV1,
} from "@oaam/core";
import type { HostConnectionSink, HostOutboundMessage, HostStateResilienceIntegration, ProductionHost } from "../../src/types";
import { createHostForCoreForTest } from "../../src/production-host";

export const ASSET_ID = "00000000-0000-4000-8000-000000000001";
export const VERSION_ID = "00000000-0000-4000-8000-000000000002";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000003";
export const SHA = `sha256:${"a".repeat(64)}`;
export const DIGEST = SHA as Sha256Digest;

export function complete<T>(value: T): CoreResult<T> {
    return { status: "complete", value, diagnostics: [] };
}

export const project = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    rootPath: "/project",
    displayName: "Project",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
} as ProjectManifestV1;

export const asset = {
    schemaVersion: 1,
    assetId: ASSET_ID,
    kind: "Guidance",
    scope: "global",
    projectId: "",
    scopePath: "",
    displayName: "Guidance",
    displayDescription: "",
    versionIds: [VERSION_ID],
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
} as AssetManifestV1;

export const purgePreparation = {
    schemaVersion: 1,
    action: "purge",
    assetId: ASSET_ID,
    assetManifestFingerprint: DIGEST,
    assetDirectoryIdentityFingerprint: DIGEST,
    kind: "Guidance",
    scope: "global",
    projectId: "",
    scopePath: "",
    displayName: "Guidance",
    versionCount: 1,
    promotionGrantCount: 0,
} as AssetPurgePreparationV1;

export const version = {
    manifest: {
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        revision: 1,
        status: "complete",
        versionCanonicalContentFingerprint: DIGEST,
        files: [],
        originAuthority: { originKind: "user_created" },
        createdAt: 1,
    },
    files: [],
} as unknown as AssetVersionBundle;

export const versionManifest = {
    ...version.manifest,
    schemaVersion: 2,
    kind: "Guidance",
    typeDataVersion: 1,
    typeData: { contentFormat: "markdown", loadingMode: "always" },
    fingerprint: DIGEST,
    diagnostics: [],
    changeKind: "create",
    sourceVersionId: "",
    sourceDeploymentId: "",
    changeNote: "",
    persistedAuthority: {
        versionCanonicalContentFingerprint: DIGEST,
        nativeRepresentationFingerprint: DIGEST,
        restorationRepresentationFingerprint: DIGEST,
    },
    sourceAuthority: { originKind: "user_created" },
} as unknown as AssetVersionManifestV2;

export const deployment = {
    deploymentId: VERSION_ID,
    projectId: PROJECT_ID,
    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
    platform: "linux",
    platformInstanceId: "local",
    targetRootPath: "/target",
    observationState: "complete",
    observationAttemptedAt: 2,
    lastCompleteObservationAt: 2,
    deleted: false,
    derivedStatus: { stage: "in_sync", reason: "ok", actionHints: ["check_now"] },
    assets: [],
    createdAt: 1,
    updatedAt: 2,
} as unknown as DeploymentView;

export const enablement = {
    configVersion: 1,
    settingId: "adapter_enablement_v1",
    revision: 0,
    enabledAdapterIds: [],
    updatedAt: 0,
    settingFingerprint: DIGEST,
} as AdapterEnablementSettingV1;

export const watched = {
    configVersion: 1,
    settingId: "watched_scan_intent_v1",
    revision: 0,
    environments: [],
    updatedAt: 0,
    settingFingerprint: DIGEST,
} as WatchedScanIntentV1;

export const grant = {
    schemaVersion: 1,
    promotionGrantId: PROJECT_ID,
    subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
    target: { targetKind: "project", projectId: PROJECT_ID },
    grantState: "active",
    revision: 1,
    userActionEvidenceId: "user",
    updatedAt: 2,
    grantFingerprint: DIGEST,
} as PromotionGrantV1;

export const fullAccess = {
    configVersion: 1,
    settingId: "restricted_source_promotion_full_access_v1",
    state: "disabled",
    revision: 0,
    updatedAt: 0,
    settingFingerprint: DIGEST,
} as RestrictedSourcePromotionFullAccessSettingV1;

export const provider = {
    adapterId: "CLAUDECODE",
    displayName: "Claude Code",
    version: "1",
    enabled: true,
    agentRuntimes: [],
    targetContextSchemas: [],
    assetSourceCapabilities: [],
    assetTargetCapabilities: [],
    materializerCapabilities: [],
    renderContractDeclarations: [],
} as AdapterProviderSummary;

export function assetSummary(overrides: Partial<CurrentAssetSummary> = {}): CurrentAssetSummary {
    return {
        assetId: ASSET_ID as CurrentAssetSummary["assetId"],
        kind: "Guidance",
        scope: "global",
        projectId: "",
        scopePath: "",
        displayName: "Guidance",
        displayDescription: "",
        currentVersionId: VERSION_ID as CurrentAssetSummary["currentVersionId"],
        currentRevision: 1,
        currentFingerprint: SHA as CurrentAssetSummary["currentFingerprint"],
        currentVersionStatus: "complete",
        assetCreatedAt: 1,
        assetUpdatedAt: 2,
        deleted: false,
        ...overrides,
    };
}

export function completeAssets(value: CurrentAssetSummary[] = []): CoreResult<CurrentAssetSummary[]> {
    return { status: "complete", value, diagnostics: [] };
}

export function fakeCore(listAssets: CoreService["listAssets"] = () => completeAssets()): CoreService {
    return { listAssets } as CoreService;
}

export function fakeCoreWith(overrides: Partial<CoreService>): CoreService {
    return {
        listAssets: () => completeAssets(),
        ...overrides,
    } as CoreService;
}

export function required<T>(value: T | null | undefined, label = "required test fixture"): T {
    if (value === null || value === undefined) {
        throw new TypeError(`${label} is unavailable`);
    }
    return value;
}

export interface RecordingSink extends HostConnectionSink {
    readonly messages: HostOutboundMessage[];
    readonly closeReasons: unknown[];
}

export function recordingSink(options: { throwSend?: boolean; throwClose?: boolean } = {}): RecordingSink {
    const messages: HostOutboundMessage[] = [];
    const closeReasons: unknown[] = [];
    return {
        messages,
        closeReasons,
        send(message) {
            if (options.throwSend === true) throw new Error("send failed");
            messages.push(message);
        },
        close(reason) {
            closeReasons.push(reason);
            if (options.throwClose === true) throw new Error("close failed");
        },
    };
}

export function testStateResilienceIntegration(
    overrides: Partial<HostStateResilienceIntegration> = {},
): HostStateResilienceIntegration {
    return {
        async readDesktopPreferences() {
            return undefined;
        },
        async inspectStateRestore() {
            throw new Error("State restore integration is unavailable");
        },
        async activateStateRestore() {
            throw new Error("State restore integration is unavailable");
        },
        async applyRestoredDesktopPreferences() {
            throw new Error("Desktop preference restoration is unavailable");
        },
        restoreRequiresHostReplacement() {},
        ...overrides,
    };
}

export function host(
    core = fakeCore(),
    hostInstanceId = "host-1",
    stateResilience: HostStateResilienceIntegration = testStateResilienceIntegration(),
): ProductionHost {
    let connectionNumber = 0;
    let operationNumber = 0;
    return createHostForCoreForTest(
        hostInstanceId,
        core,
        stateResilience,
        () => `connection-${++connectionNumber}`,
        () => `operation-${++operationNumber}`,
    );
}

export async function flushHost(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

export function initializeRequest(id = "request-1") {
    return {
        id,
        method: "initialize",
        params: {
            protocolVersion: 1,
            clientKind: "headless",
            clientVersion: "0.1.0",
        },
    };
}
