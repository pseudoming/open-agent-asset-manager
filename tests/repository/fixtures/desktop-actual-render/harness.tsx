import { publicDemoClient } from "./public-demo";
import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { OaamDesktopBridge } from "../../../../packages/client/desktop/src/bridge/desktop-bridge";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopAssetLayoutPreference,
    type DesktopLanguagePreference,
    type DesktopPresentationPreferenceInput,
    type DesktopPresentationSnapshot,
    type DesktopSurfacePalettePreference,
    type DesktopTextSizePreference,
    type DesktopThemePreference,
} from "../../../../packages/client/desktop/src/presentation/presentation-preferences";
import { DESKTOP_SURFACE_IDS } from "../../../../packages/client/desktop/src/renderer/app/desktop-surface-inventory";
import type {
    DesktopApplicationClientApi,
    DesktopSession,
    DesktopSessionState,
} from "../../../../packages/client/desktop/src/renderer/client";
import { DESKTOP_DIALOG_IDS } from "../../../../packages/client/desktop/src/renderer/ui";
import {
    ACTUAL_RENDER_PROJECT_SOURCE_PATH,
    createActualRenderJourneyProbe,
    withOpenCodeAppEntry,
} from "../desktop-actual-render-journey-probe";
import {
    ACTUAL_RENDER_PROJECT_ROOT,
    authorizeActualRenderRegisteredProjectRoot,
    getActualRenderRegisteredProject,
    revealActualRenderRegisteredProjectRoot,
} from "../desktop-actual-render-registered-project";
import {
    COMPLETE_DIRECTORY_PREVIEW_OPERATIONS,
    createCompleteDirectoryPreviewFixtureClient,
} from "./complete-directory-preview-fixture";
import { createDeploymentCatalogPreviewFixtureClient } from "./deployment-catalog-preview-fixture";
import { createDeploymentOperationFixtureClient, DEPLOYMENT_OPERATION_FIXTURE_OPERATIONS } from "./deployment-operation-fixture";
import { actualRenderOperationMessageTemplates } from "./operation-message-templates";
import { createProjectAssetFixtureClient, PROJECT_ASSET_FIXTURE_OPERATIONS } from "./project-asset-fixture";
import { createProjectGuidanceApplyRehearsalHarnessFixture } from "./project-guidance-apply-rehearsal-fixture";
import { renderActualDesktop } from "./render-actual-desktop";
import { createActualRenderSessionState } from "./session-state-fixture";
import { createSourceImportFeedbackFixtureClient } from "./source-import-feedback-fixture";
import {
    createStateDiagnosticsFixtureBridge,
    createStateDiagnosticsFixtureClient,
    STATE_DIAGNOSTICS_FIXTURE_OPERATIONS,
} from "./state-diagnostics-fixture";
import { createTargetProbeFixtureClient } from "./target-probe-fixture";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_PROJECT_ID = "66666666-6666-4666-8666-666666666666";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKUP_ID = "44444444-4444-4444-8444-444444444444";
const RESTORE_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST = "a".repeat(64);
const ASSET_KINDS = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"] as const;
const WINDOWS_ENVIRONMENT = Object.freeze({ platform: "win32" as const, platformInstanceId: "desktop-local" });
const WSL_ENVIRONMENT = Object.freeze({ platform: "wsl" as const, platformInstanceId: "Ubuntu" });
const WSL_DEBIAN_ENVIRONMENT = Object.freeze({ platform: "wsl" as const, platformInstanceId: "Debian" });
const SHARED_SOURCE_PATH = "C:\\Users\\Example\\.claude";
const COMPATIBLE_ONLY_SOURCE_PATH = "C:\\Users\\Example\\.config\\opencode";
const PROJECT_SOURCE_PATH = ACTUAL_RENDER_PROJECT_SOURCE_PATH;

const parameters = new URLSearchParams(window.location.search);
const language = (parameters.get("locale") ?? "en") as DesktopLanguagePreference;
const theme = (parameters.get("theme") ?? "light") as DesktopThemePreference;
const textSize = (parameters.get("textSize") ?? "default") as DesktopTextSizePreference;
const surfacePalette = (parameters.get("palette") ?? "neutral") as DesktopSurfacePalettePreference;
const systemUsesDarkColors = parameters.get("systemDark") === "true";
const scenario = parameters.get("scenario") ?? "workbench";
const projectCount = Number(parameters.get("projectCount") ?? "2");
if (projectCount !== 2 && projectCount !== 64) throw new Error("Unsupported Project sidebar fixture size");
const deploymentProviderCount = Number(parameters.get("deploymentProviderCount") ?? "2");
if (deploymentProviderCount !== 2 && deploymentProviderCount !== 6) throw new Error("Unsupported tool-choice fixture size");
const deploymentAssetChoiceCount = Number(parameters.get("deploymentAssetChoiceCount") ?? "1");
if (deploymentAssetChoiceCount !== 1 && deploymentAssetChoiceCount !== 15) {
    throw new Error(`Unsupported deployment Asset choice count ${String(deploymentAssetChoiceCount)}`);
}
const emptyJourneyMode = scenario === "journey_empty";
const journeyMode = scenario === "journey" || emptyJourneyMode;
const sourceLibraryReviewMode = scenario === "import_sources_review";
const sourceImportFeedbackMode = scenario === "source_import_feedback";
const projectLibraryReviewMode = ["asset_library_project_review", "catalog_search_context_review", "public_demo"].includes(
    scenario,
);
const globalLibraryReviewMode = scenario === "asset_library_global_review";
const assetLibraryEmptyReviewMode = scenario === "asset_library_empty_review";
const projectAssetOperationMode = scenario === "project_asset_operations" || scenario === "public_demo";
const stateDiagnosticsOperationMode = scenario === "state_diagnostics_operations";
const deploymentOperationMode = scenario === "deployment_operations";
const completeDirectoryPreviewMode = scenario === "complete_directory_preview";
const deploymentCatalogPreviewMode = scenario === "deployment";
const projectGuidanceApplyRehearsal = createProjectGuidanceApplyRehearsalHarnessFixture(parameters, scenario);

let snapshot = createDesktopPresentationSnapshot(
    Object.freeze({
        ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
        language,
        theme,
        textSize,
        surfacePalette,
        onboardingCompleted: !journeyMode,
        lastSelectedProjectId: PROJECT_ID,
    }),
    [language === "system" ? "en-US" : language],
    systemUsesDarkColors,
);
const presentationListeners = new Set<(value: DesktopPresentationSnapshot) => void>();

function replaceSnapshot(preferences: Partial<DesktopPresentationSnapshot["preferences"]>): DesktopPresentationSnapshot {
    snapshot = createDesktopPresentationSnapshot(
        Object.freeze({ ...snapshot.preferences, ...preferences }),
        [language === "system" ? "en-US" : language],
        systemUsesDarkColors,
    );
    for (const listener of presentationListeners) listener(snapshot);
    return snapshot;
}

const bridge = {
    initialAppIdentity: Object.freeze({ name: "Open Agent Asset Manager", version: "actual-render-test" }),
    initialHostStartup: Object.freeze({ status: "ready", hostInstanceId: "actual-render-host" }),
    initialPresentation: snapshot,
    async completeOnboarding() {
        const count = Number.parseInt(document.documentElement.dataset.oaamOnboardingCompletionCount ?? "0", 10) + 1;
        document.documentElement.dataset.oaamOnboardingCompletionCount = String(count);
        return replaceSnapshot({ onboardingCompleted: true });
    },
    async replacePresentationPreferences(input: DesktopPresentationPreferenceInput) {
        return replaceSnapshot(input);
    },
    async rememberLastProject() {
        return snapshot;
    },
    async replaceAssetLayout(assetLayout: DesktopAssetLayoutPreference) {
        return replaceSnapshot({ assetLayout });
    },
    async performWindowAction(action) {
        document.documentElement.dataset.oaamWindowAction = action;
    },
    async retrySession() {},
    async getDesktopMaintenance() {
        return {
            interfaceCache: { status: "available", byteSize: 0 },
            dataLocations: [
                { locationId: "oaam_data", status: "available", displayPath: "/oaam" },
                { locationId: "desktop_profile", status: "available", displayPath: "/profile" },
                { locationId: "state_backups", status: "available", displayPath: "/oaam/backups" },
                { locationId: "ordinary_logs", status: "available", displayPath: "/oaam/logs/ordinary" },
                { locationId: "interface_cache", status: "available", displayPath: "/profile/cache" },
            ],
        };
    },
    async getDesktopPerformanceRecording() {
        return { state: "idle" };
    },
    async startDesktopPerformanceRecording() {
        return { state: "idle" };
    },
    async stopDesktopPerformanceRecording() {
        return { state: "idle" };
    },
    async saveDesktopPerformanceRecording() {
        return { status: "cancelled" };
    },
    async discardDesktopPerformanceRecording() {
        return { state: "idle" };
    },
    subscribeDesktopPerformanceRecording() {
        return () => undefined;
    },
    async pickProjectRoot() {
        return { status: "cancelled" };
    },
    async authorizeObservedProjectRoot() {
        return {
            status: "authorized",
            displayPath: PROJECT_SOURCE_PATH,
            localPathSelectionToken: "actual-render-observed-project-root",
        };
    },
    async revealObservedProjectRoot() {
        document.documentElement.dataset.oaamObservedProjectRevealCount = String(
            Number.parseInt(document.documentElement.dataset.oaamObservedProjectRevealCount ?? "0", 10) + 1,
        );
        return { status: "complete" };
    },
    authorizeRegisteredProjectRoot: authorizeActualRenderRegisteredProjectRoot,
    revealRegisteredProjectRoot: revealActualRenderRegisteredProjectRoot,
    async revealImportPreviewFile(reference) {
        document.documentElement.dataset.oaamImportPreviewFileReference = JSON.stringify(reference);
        document.documentElement.dataset.oaamImportPreviewFileRevealCount = String(
            Number.parseInt(document.documentElement.dataset.oaamImportPreviewFileRevealCount ?? "0", 10) + 1,
        );
        return { status: "complete" };
    },
    async pickAssetVersionExport() {
        return { status: "cancelled" };
    },
    async getStateResiliencePreferences() {
        return { schemaVersion: 1, lastCustomBackupDirectory: "/oaam/backups" };
    },
    async pickStateRestoreArchive() {
        return { status: "cancelled" };
    },
    ...createStateDiagnosticsFixtureBridge(stateDiagnosticsOperationMode),
    subscribeHostStartup() {
        return () => undefined;
    },
    subscribePresentation(listener: (value: DesktopPresentationSnapshot) => void) {
        presentationListeners.add(listener);
        return () => presentationListeners.delete(listener);
    },
} as unknown as OaamDesktopBridge;

const AVAILABLE_OPERATIONS: readonly ProtocolOperationName[] = Object.freeze([
    "project.get",
    "project.list",
    "project.register",
    "asset.list",
    "asset_library.kind_counts",
    "asset_library.page",
    "deployment.list",
    "project_lifecycle.inspect",
    "project_lifecycle.commit",
    "watched_scan_intent.get",
    "catalog.search",
    "adapter_provider.list",
    "adapter_enablement.get",
    "adapter_enablement.replace",
    "watched_scan_intent.replace",
    "environment.list",
    "adapter.probe",
    "asset_usage.analyze",
    "adapter.read",
    "import.preview",
    ...(sourceImportFeedbackMode ? (["import.accept_batch"] as const) : []),
    "import_preview.cancel",
    "state_backup.list",
    "state_backup_prompt_policy.get",
    "state_restore.inspect",
    "state_restore.activate",
    ...(deploymentCatalogPreviewMode || deploymentOperationMode
        ? ([
              "asset.get",
              "asset_version.get",
              "asset_version.list",
              "asset_version.file_children",
              "asset_version.file_preview",
          ] as const)
        : []),
    ...(projectAssetOperationMode ? PROJECT_ASSET_FIXTURE_OPERATIONS : []),
    ...(stateDiagnosticsOperationMode ? STATE_DIAGNOSTICS_FIXTURE_OPERATIONS : []),
    ...(deploymentOperationMode ? DEPLOYMENT_OPERATION_FIXTURE_OPERATIONS : []),
    ...(completeDirectoryPreviewMode ? COMPLETE_DIRECTORY_PREVIEW_OPERATIONS : []),
    ...projectGuidanceApplyRehearsal.operations,
]);

function supportedTarget(agentRuntimeId: string, assetKind: "Guidance" | "Rule") {
    return Object.freeze({
        agentRuntimeId,
        assetKind,
        entrySupportStatus: "supported" as const,
        renderStrategy: "native_file" as const,
        reverseExtractPolicy: "can_reconcile" as const,
        diagnostics: Object.freeze([]),
    });
}

function targetProvider(
    adapterId: string,
    displayName: string,
    agentRuntimeId: string,
    runtimeDisplayName: string,
    entryClass: "cli" | "app",
    targetCapabilities: readonly ReturnType<typeof supportedTarget>[],
) {
    return Object.freeze({
        adapterId,
        displayName,
        version: "1.0.0",
        enabled: true,
        agentRuntimes: Object.freeze([Object.freeze({ agentRuntimeId, displayName: runtimeDisplayName, entryClass })]),
        sourceCapabilities: Object.freeze([]),
        targetCapabilities: Object.freeze(targetCapabilities),
    });
}

const JOURNEY_PROVIDERS = Object.freeze([
    targetProvider("CLAUDECODE", "Claude Code", "CLAUDE_CODE_CLI", "Claude Code CLI", "cli", [
        supportedTarget("CLAUDE_CODE_CLI", "Guidance"),
    ]),
    withOpenCodeAppEntry(
        targetProvider("OPENCODE", "OpenCode", "OPENCODE_CLI", "OpenCode CLI", "cli", [
            supportedTarget("OPENCODE_CLI", "Guidance"),
        ]),
    ),
]);

const LIBRARY_TARGET_PROVIDERS = Object.freeze([
    targetProvider("CLAUDECODE", "Claude Code", "CLAUDE_CODE_CLI", "Claude Code CLI", "cli", [
        supportedTarget("CLAUDE_CODE_CLI", "Guidance"),
        supportedTarget("CLAUDE_CODE_CLI", "Rule"),
    ]),
    targetProvider("CODEX", "Codex", "CODEX_CLI", "Codex CLI", "cli", [supportedTarget("CODEX_CLI", "Guidance")]),
    targetProvider("ZCODE", "ZCode", "ZCODE_APP", "ZCode App", "app", [supportedTarget("ZCODE_APP", "Guidance")]),
    targetProvider("ANTIGRAVITY", "Antigravity", "ANTIGRAVITY_CLI", "Antigravity CLI", "cli", [
        supportedTarget("ANTIGRAVITY_CLI", "Guidance"),
    ]),
    targetProvider("OPENCODE", "OpenCode", "OPENCODE_CLI", "OpenCode CLI", "cli", [supportedTarget("OPENCODE_CLI", "Guidance")]),
]);

const DENSE_TARGET_PROVIDERS = Object.freeze([
    ...LIBRARY_TARGET_PROVIDERS,
    targetProvider("CURSOR", "Cursor", "CURSOR_AGENT_CLI", "Cursor CLI", "cli", []),
]);

const JOURNEY_ENABLEMENT = Object.freeze({
    configVersion: 1 as const,
    settingId: "adapter_enablement_v1" as const,
    revision: 1,
    enabledAdapterIds: Object.freeze(["CLAUDECODE", "OPENCODE"]),
    userActionEvidenceId: "actual-render-enablement",
    updatedAt: 1,
    settingFingerprint: DIGEST,
});

const JOURNEY_WATCHED = Object.freeze({
    configVersion: 1 as const,
    settingId: "watched_scan_intent_v1" as const,
    revision: 0,
    environments: Object.freeze([]),
    updatedAt: 0,
    settingFingerprint: DIGEST,
});

function sourceLibrarySelector(
    adapterId: "CLAUDECODE" | "OPENCODE",
    agentRuntimeId: "CLAUDE_CODE_CLI" | "OPENCODE_CLI",
    canonicalPath: string,
    selectorFingerprint: string,
    binding: { readonly assetScope: "global" } | { readonly assetScope: "project"; readonly projectId: typeof PROJECT_ID },
) {
    return Object.freeze({
        disposition: "included" as const,
        source: Object.freeze({
            adapterId,
            rootRole: "source" as const,
            sourceDomain: "family_shared" as const,
            canonicalPath,
            locatorIdentities: Object.freeze([
                Object.freeze({
                    locatorKind: "runtime_known_rule" as const,
                    locatorKey: `${adapterId.toLocaleLowerCase("en-US")}-source`,
                }),
            ]),
        }),
        agentRuntimeIds: Object.freeze([agentRuntimeId]),
        binding: Object.freeze(binding),
        selectorFingerprint,
    });
}

const SOURCE_LIBRARY_WATCHED = Object.freeze({
    ...JOURNEY_WATCHED,
    revision: 1,
    environments: Object.freeze([
        Object.freeze({
            environment: WINDOWS_ENVIRONMENT,
            sourceSelectors: Object.freeze([
                sourceLibrarySelector(
                    "CLAUDECODE",
                    "CLAUDE_CODE_CLI",
                    SHARED_SOURCE_PATH,
                    "b".repeat(64),
                    Object.freeze({ assetScope: "global" as const }),
                ),
                sourceLibrarySelector(
                    "OPENCODE",
                    "OPENCODE_CLI",
                    SHARED_SOURCE_PATH,
                    "c".repeat(64),
                    Object.freeze({ assetScope: "project" as const, projectId: PROJECT_ID }),
                ),
                sourceLibrarySelector(
                    "OPENCODE",
                    "OPENCODE_CLI",
                    COMPATIBLE_ONLY_SOURCE_PATH,
                    "d".repeat(64),
                    Object.freeze({ assetScope: "global" as const }),
                ),
            ]),
        }),
        Object.freeze({
            environment: WSL_ENVIRONMENT,
            sourceSelectors: Object.freeze([
                sourceLibrarySelector(
                    "CLAUDECODE",
                    "CLAUDE_CODE_CLI",
                    "/home/example/.claude",
                    "e".repeat(64),
                    Object.freeze({ assetScope: "global" as const }),
                ),
            ]),
        }),
        Object.freeze({
            environment: WSL_DEBIAN_ENVIRONMENT,
            sourceSelectors: Object.freeze([
                sourceLibrarySelector(
                    "CLAUDECODE",
                    "CLAUDE_CODE_CLI",
                    "/home/example-debian/.claude",
                    "1".repeat(64),
                    Object.freeze({ assetScope: "global" as const }),
                ),
            ]),
        }),
    ]),
    userActionEvidenceId: "actual-render-source-library",
    updatedAt: 2,
    settingFingerprint: "f".repeat(64),
});

const JOURNEY_PROBE = createActualRenderJourneyProbe({
    environment: WINDOWS_ENVIRONMENT,
    sharedSourcePath: SHARED_SOURCE_PATH,
    compatibleOnlySourcePath: COMPATIBLE_ONLY_SOURCE_PATH,
    projectSourcePath: PROJECT_SOURCE_PATH,
    includeEntryChoice: journeyMode,
});

const EMPTY_JOURNEY_PROBE = Object.freeze({
    probeToken: "actual-render-empty-probe-token",
    results: Object.freeze([]),
});

const client = {
    availableOperations: AVAILABLE_OPERATIONS,
    supportsOperation(operation: ProtocolOperationName) {
        return AVAILABLE_OPERATIONS.includes(operation);
    },
    async listProjects() {
        const projects = projectLibraryReviewMode
            ? [
                  {
                      projectId: PROJECT_ID,
                      displayName: "Open Agent Asset Manager",
                      rootPath: "/a/very/long/project/root/used/to/prove/the/sidebar/never/creates/a/horizontal/scrollbar",
                      deleted: false,
                      createdAt: 1,
                      updatedAt: 2,
                  },
                  {
                      projectId: SECOND_PROJECT_ID,
                      displayName: "Documentation playground",
                      rootPath: "/work/documentation-playground",
                      deleted: false,
                      createdAt: 3,
                      updatedAt: 4,
                  },
                  ...Array.from({ length: projectCount - 2 }, (_, index) => ({
                      projectId: `00000000-0000-4000-8000-${String(index + 3).padStart(12, "0")}`,
                      displayName: `Review Project ${String(index + 3)}`,
                      rootPath: `/work/review-project-${String(index + 3)}`,
                      deleted: false,
                      createdAt: 3,
                      updatedAt: 4,
                  })),
              ]
            : assetLibraryEmptyReviewMode || journeyMode
              ? []
              : [
                    {
                        projectId: PROJECT_ID,
                        displayName: "Open Agent Asset Manager",
                        rootPath: "/a/very/long/project/root/used/to/prove/the/sidebar/never/creates/a/horizontal/scrollbar",
                        deleted: false,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                ];
        return {
            status: "complete",
            value: { projects },
            diagnostics: [],
        };
    },
    getProject: getActualRenderRegisteredProject,
    async registerProject() {
        return {
            status: "complete",
            value: {
                projectId: PROJECT_ID,
                displayName: "Open Agent Asset Manager",
                rootPath: "/work/open-agent-asset-manager",
                deleted: false,
                createdAt: 1,
                updatedAt: 1,
            },
            diagnostics: [],
        };
    },
    async listAdapterProviders() {
        return {
            status: "complete",
            value: {
                providers:
                    deploymentProviderCount === 6
                        ? DENSE_TARGET_PROVIDERS
                        : projectLibraryReviewMode || globalLibraryReviewMode
                          ? LIBRARY_TARGET_PROVIDERS
                          : JOURNEY_PROVIDERS,
            },
            diagnostics: [],
        };
    },
    async getAdapterEnablement() {
        return {
            status: "complete",
            value: deploymentCatalogPreviewMode
                ? { ...JOURNEY_ENABLEMENT, enabledAdapterIds: Object.freeze(["CLAUDECODE"]) }
                : JOURNEY_ENABLEMENT,
            diagnostics: [],
        };
    },
    async replaceAdapterEnablement(input: { readonly enabledAdapterIds: readonly string[]; readonly userActionId: string }) {
        document.documentElement.dataset.oaamTargetEnablementIds = JSON.stringify(input.enabledAdapterIds);
        if (deploymentCatalogPreviewMode) {
            await new Promise<void>((resolve) => {
                document.documentElement.dataset.oaamTargetEnablementWaiting = "true";
                document.addEventListener(
                    "oaam-actual-render-release-enablement",
                    () => {
                        delete document.documentElement.dataset.oaamTargetEnablementWaiting;
                        resolve();
                    },
                    { once: true },
                );
            });
        }
        return {
            status: "complete",
            value: {
                ...JOURNEY_ENABLEMENT,
                revision: 2,
                enabledAdapterIds: [...input.enabledAdapterIds],
                userActionEvidenceId: input.userActionId,
                updatedAt: 2,
                settingFingerprint: "b".repeat(64),
            },
            diagnostics: [],
        };
    },
    async getWatchedScanIntent() {
        return {
            status: "complete",
            value: sourceLibraryReviewMode ? SOURCE_LIBRARY_WATCHED : JOURNEY_WATCHED,
            diagnostics: [],
        };
    },
    async replaceWatchedScanIntent(input: { readonly userActionId: string; readonly decisions: readonly unknown[] }) {
        document.documentElement.dataset.oaamWatchedDecisionCount = String(input.decisions.length);
        return {
            status: "complete",
            value: {
                ...JOURNEY_WATCHED,
                revision: 1,
                userActionEvidenceId: input.userActionId,
                updatedAt: 2,
                settingFingerprint: "c".repeat(64),
            },
            diagnostics: [],
        };
    },
    async listEnvironments() {
        return {
            status: "complete",
            value: {
                environments: [
                    { environment: WINDOWS_ENVIRONMENT, displayName: "Local Windows" },
                    { environment: WSL_ENVIRONMENT, displayName: "WSL — Ubuntu" },
                ],
            },
            diagnostics: [],
        };
    },
    ...createTargetProbeFixtureClient({
        emptyJourneyMode,
        deploymentCatalogPreviewMode,
        deploymentAssetChoiceCount,
        projectPath: deploymentCatalogPreviewMode ? ACTUAL_RENDER_PROJECT_ROOT : PROJECT_SOURCE_PATH,
        emptyGlobalProbe: EMPTY_JOURNEY_PROBE,
        globalProbe: JOURNEY_PROBE,
    }),
    async readSources(input: unknown) {
        if (emptyJourneyMode) throw new Error("empty actual-render journey must not read a source");
        document.documentElement.dataset.oaamReadRequest = JSON.stringify(input);
        return {
            status: "complete",
            value: { readToken: "actual-render-read-token", reports: [], candidateCount: 2 },
            diagnostics: [],
        };
    },
    async previewImport() {
        if (emptyJourneyMode) throw new Error("empty actual-render journey must not create an import preview");
        return {
            status: "complete",
            value: {
                previewToken: "actual-render-preview-token",
                snapshotFingerprint: DIGEST,
                candidates: [
                    {
                        candidateId: "actual-render-existing-guidance",
                        kind: "Guidance" as const,
                        scope: "global" as const,
                        displayName: "Existing portable instructions",
                        displayDescription: "Already available in OAAM.",
                        status: "duplicate" as const,
                        freshness: "fresh" as const,
                        fileCount: 1,
                        logicalPaths: ["EXISTING.md"],
                        logicalPathsTruncated: false,
                        callableBindingRequestCount: 0,
                        callableBindingRequests: [],
                        callableBindingRequestsTruncated: false,
                    },
                    {
                        candidateId: "actual-render-guidance",
                        kind: "Guidance" as const,
                        scope: "global" as const,
                        displayName: "Portable instructions",
                        displayDescription: "One source-backed Asset ready for review.",
                        status: "importable" as const,
                        freshness: "fresh" as const,
                        fileCount: 1,
                        logicalPaths: ["AGENTS.md"],
                        logicalPathsTruncated: false,
                        callableBindingRequestCount: 0,
                        callableBindingRequests: [],
                        callableBindingRequestsTruncated: false,
                    },
                ],
            },
            diagnostics: [],
        };
    },
    async getImportPreviewDetail(input: { readonly candidateId: string; readonly logicalPath?: string }) {
        return {
            status: "complete",
            value: {
                candidateId: input.candidateId,
                ...(input.logicalPath === undefined ? {} : { logicalPath: input.logicalPath }),
                mediaType: "text/markdown",
                contentKind: "text" as const,
                text: { text: "# Portable instructions\n\nActual-render preview receipt.", byteLength: 55, truncated: false },
                byteLength: 55,
                contentHash: DIGEST,
            },
            diagnostics: [],
        };
    },
    async cancelImportPreview() {
        const count = Number.parseInt(document.documentElement.dataset.oaamPreviewCancellationCount ?? "0", 10) + 1;
        document.documentElement.dataset.oaamPreviewCancellationCount = String(count);
        return { status: "complete", value: { cancelled: true }, diagnostics: [] };
    },
    async listAssetKindCounts(input: {
        readonly subject: { readonly scope: "global" } | { readonly scope: "project"; readonly projectId: string };
        readonly keywords?: string;
    }) {
        const keywords = input.keywords?.trim().toLocaleLowerCase("en-US") ?? "";
        const counts =
            journeyMode || assetLibraryEmptyReviewMode
                ? new Map()
                : projectLibraryReviewMode && input.subject.scope === "project" && input.subject.projectId === PROJECT_ID
                  ? new Map([
                        ["Guidance", keywords === "" ? 5 : keywords === "guide" ? 2 : 0],
                        ["Skill", keywords === "" ? 4 : 0],
                    ])
                  : globalLibraryReviewMode && input.subject.scope === "global"
                    ? new Map([
                          ["Guidance", 2],
                          ["Workflow", 2],
                      ])
                    : new Map([["Guidance", 1]]);
        return {
            status: "complete",
            value: {
                counts: ASSET_KINDS.map((kind) => ({ kind, count: counts.get(kind) ?? 0 })),
            },
            diagnostics: [],
        };
    },
    async queryAssetLibrary(input: {
        readonly subject: { readonly scope: "global" } | { readonly scope: "project"; readonly projectId: string };
        readonly kind: (typeof ASSET_KINDS)[number];
        readonly keywords?: string;
    }) {
        if (journeyMode || assetLibraryEmptyReviewMode) {
            return {
                status: "complete",
                value: { assets: [], totalCount: 0, hasMore: false },
                diagnostics: [],
            };
        }
        const global = input.subject.scope === "global";
        const exactAssets =
            projectLibraryReviewMode && !global && input.subject.scope === "project" && input.subject.projectId === PROJECT_ID
                ? input.kind === "Guidance"
                    ? [
                          ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "Project guide map 1"],
                          ["77777777-7777-4777-8777-777777777771", "77777777-7777-4777-8777-777777777772", "Project guide map 2"],
                          ["77777777-7777-4777-8777-777777777773", "77777777-7777-4777-8777-777777777774", "Review conventions"],
                          ["77777777-7777-4777-8777-777777777775", "77777777-7777-4777-8777-777777777776", "Deployment review"],
                          ["77777777-7777-4777-8777-777777777777", "77777777-7777-4777-8777-777777777778", "Project onboarding"],
                      ]
                    : input.kind === "Skill"
                      ? [
                            ["88888888-8888-4888-8888-888888888881", "88888888-8888-4888-8888-888888888882", "Release helper"],
                            ["88888888-8888-4888-8888-888888888883", "88888888-8888-4888-8888-888888888884", "Fixture inspector"],
                            ["88888888-8888-4888-8888-888888888885", "88888888-8888-4888-8888-888888888886", "Asset exporter"],
                            ["88888888-8888-4888-8888-888888888887", "88888888-8888-4888-8888-888888888888", "Source validator"],
                        ]
                      : []
                : globalLibraryReviewMode && global
                  ? input.kind === "Guidance"
                      ? [
                            [
                                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
                                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
                                "Shared guide map 1",
                            ],
                            [
                                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
                                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
                                "Shared guide map 2",
                            ],
                        ]
                      : input.kind === "Workflow"
                        ? [
                              ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "Release review"],
                              [
                                  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
                                  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
                                  "Dependency update",
                              ],
                          ]
                        : []
                  : [[ASSET_ID, VERSION_ID, global ? "Shared guide map 1" : "Project guide map 1"]];
        const keywords = input.keywords?.trim().toLocaleLowerCase("en-US") ?? "";
        const assets = exactAssets
            .map(([assetId, versionId, displayName], index) => ({
                assetId,
                kind: input.kind,
                scope: global ? ("global" as const) : ("project" as const),
                ...(global ? {} : { projectId: input.subject.scope === "project" ? input.subject.projectId : PROJECT_ID }),
                scopePath: "",
                displayName,
                displayDescription: global
                    ? "Portable content available across projects"
                    : "Portable content owned by this project",
                currentVersionId: versionId,
                currentRevision: 1,
                currentFingerprint: DIGEST,
                currentVersionStatus: "complete" as const,
                deleted: false,
                createdAt: index + 1,
                updatedAt: index + 2,
            }))
            .filter(
                (asset) =>
                    keywords === "" ||
                    asset.displayName.toLocaleLowerCase("en-US").includes(keywords) ||
                    asset.displayDescription.toLocaleLowerCase("en-US").includes(keywords),
            );
        return {
            status: "complete",
            value: {
                assets,
                totalCount: assets.length,
                hasMore: false,
            },
            diagnostics: [],
        };
    },
    ...createDeploymentCatalogPreviewFixtureClient({
        journeyMode,
        deploymentMode: scenario === "deployment",
        assetChoiceCount: deploymentAssetChoiceCount as 1 | 15,
        projectId: PROJECT_ID,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        digest: DIGEST,
        projectRootPath: ACTUAL_RENDER_PROJECT_ROOT,
    }),
    async listDeployments() {
        return {
            status: "complete",
            value: { deployments: [] },
            diagnostics: [],
        };
    },
    async searchCatalog() {
        if (journeyMode) {
            return {
                status: "complete",
                value: {
                    projects: { items: [], totalCount: 0 },
                    assets: { items: [], totalCount: 0 },
                },
                diagnostics: [],
            };
        }
        if (scenario === "catalog_search_context_review") {
            return {
                status: "complete",
                value: {
                    projects: {
                        items: [
                            {
                                projectId: SECOND_PROJECT_ID,
                                displayName: "Guide research",
                                rootPath: "/work/guide-research",
                                deleted: false,
                                matchedField: "display_name",
                                snippet: "Guide research",
                            },
                        ],
                        totalCount: 1,
                    },
                    assets: {
                        items: [
                            {
                                assetId: ASSET_ID,
                                kind: "Guidance",
                                scope: "project",
                                projectId: PROJECT_ID,
                                scopePath: "",
                                displayName: "Project guide map 1",
                                matchedField: "text_content",
                                logicalPath: "AGENTS.md",
                                snippet: "Portable guide content",
                            },
                            {
                                assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
                                kind: "Guidance",
                                scope: "global",
                                scopePath: "",
                                displayName: "Shared guide map 1",
                                matchedField: "text_content",
                                logicalPath: "AGENTS.md",
                                snippet: "Shared guide content",
                            },
                        ],
                        totalCount: 2,
                    },
                },
                diagnostics: [],
            };
        }
        return {
            status: "complete",
            value: {
                projects: { items: [], totalCount: 0 },
                assets: {
                    items: [
                        {
                            assetId: ASSET_ID,
                            kind: "Guidance",
                            scope: "project",
                            projectId: PROJECT_ID,
                            scopePath: "",
                            displayName: "Guide map",
                            matchedField: "text_content",
                            logicalPath: "AGENTS.md",
                            snippet: "Portable guide content",
                        },
                    ],
                    totalCount: 1,
                },
            },
            diagnostics: [],
        };
    },
    async listStateBackups() {
        return {
            status: "complete",
            value: {
                entries: [],
                totalKnownArchiveBytes: 0,
                totalAvailableArchiveBytes: 0,
            },
            diagnostics: [],
        };
    },
    async getStateBackupPromptPolicy() {
        return {
            status: "complete",
            value: {
                configVersion: 1,
                settingId: "state_backup_prompt_policy_v1",
                revision: 0,
                mode: "ask_every_time",
                updatedAt: 0,
                settingFingerprint: DIGEST,
            },
            diagnostics: [],
        };
    },
    async inspectStateRestore() {
        return {
            status: "complete",
            value: {
                restoreReviewToken: "actual-render-restore-review",
                backupId: BACKUP_ID,
                backupCreatedAt: 1,
                archiveDisplayPath: "/oaam/backups/backup.zip",
                archiveByteSize: 1_024,
                archiveContentHash: DIGEST,
                encryptionMode: "none",
                sourceFileCount: 1,
                sourceLogicalBytes: 512,
                sourceSnapshotFingerprint: DIGEST,
                manifestFingerprint: DIGEST,
                includesDesktopPreferences: true,
            },
            diagnostics: [],
        };
    },
    async activateStateRestore() {
        return {
            status: "complete",
            value: {
                schemaVersion: 1,
                restoreId: RESTORE_ID,
                backupId: BACKUP_ID,
                activatedAt: 2,
                restoredSourceSnapshotFingerprint: DIGEST,
                displacedState: { state: "preserved", displayPath: "/oaam/displaced" },
                requiresRestart: true,
                restoredDesktopPreferences: true,
            },
            diagnostics: [],
        };
    },
    ...createStateDiagnosticsFixtureClient(stateDiagnosticsOperationMode),
    ...createProjectAssetFixtureClient(projectAssetOperationMode),
    ...createDeploymentOperationFixtureClient(deploymentOperationMode),
    ...createCompleteDirectoryPreviewFixtureClient(completeDirectoryPreviewMode),
    ...createSourceImportFeedbackFixtureClient(sourceImportFeedbackMode, SOURCE_LIBRARY_WATCHED),
    subscribeInvalidation() {
        return () => undefined;
    },
    ...projectGuidanceApplyRehearsal.client,
} as unknown as DesktopApplicationClientApi;

const readyState = createActualRenderSessionState(scenario);
const session = {
    state: readyState,
    applicationClient:
        scenario === "startup_client_unavailable" ? undefined : scenario === "public_demo" ? publicDemoClient(client) : client,
    desktopBridge: bridge,
    subscribe(listener: (value: DesktopSessionState) => void) {
        listener(readyState);
        return () => undefined;
    },
    close() {},
    async pickProjectRoot() {
        return { status: "cancelled" };
    },
    async authorizeObservedProjectRoot(reference) {
        return bridge.authorizeObservedProjectRoot(reference);
    },
    async revealObservedProjectRoot(reference) {
        return bridge.revealObservedProjectRoot(reference);
    },
    authorizeRegisteredProjectRoot: bridge.authorizeRegisteredProjectRoot,
    revealRegisteredProjectRoot: bridge.revealRegisteredProjectRoot,
    async revealImportPreviewFile(reference) {
        return bridge.revealImportPreviewFile(reference);
    },
    async pickAssetVersionExport() {
        return { status: "cancelled" };
    },
    async openDiagnostics() {
        return { status: "complete" };
    },
} as unknown as DesktopSession;

const root = document.getElementById("root");
if (root === null) throw new Error("actual-render root is missing");
document.documentElement.dataset.oaamSurfaceInventory = JSON.stringify(DESKTOP_SURFACE_IDS);
document.documentElement.dataset.oaamDialogInventory = JSON.stringify(DESKTOP_DIALOG_IDS);
document.documentElement.dataset.oaamOperationMessageTemplates = JSON.stringify(actualRenderOperationMessageTemplates(snapshot));
projectGuidanceApplyRehearsal.installScriptBridge();
renderActualDesktop(root, bridge, session);
