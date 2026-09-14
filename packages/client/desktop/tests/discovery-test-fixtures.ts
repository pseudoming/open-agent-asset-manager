import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import type { ProbeReviewView, WatchedScanIntentView } from "../src/renderer/features/discovery/discovery-model";

export const DIGEST = "a".repeat(64);
export const ENVIRONMENT = { platform: "linux" as const, platformInstanceId: "local" };

export function required<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`${label} is required`);
    return value;
}

export function diagnostic(message: string): ProtocolDiagnosticV1 {
    return {
        severity: "warning",
        code: "settings.stale",
        operation: "settings",
        causeKind: "conflict",
        retryable: true,
        suggestedActions: ["retry"],
        message,
    };
}

export const PROVIDERS = [
    {
        adapterId: "CLAUDECODE",
        displayName: "Claude Code",
        version: "1.0.0",
        enabled: true,
        agentRuntimes: [
            { agentRuntimeId: "CLAUDE_CODE_CLI", displayName: "Claude Code CLI", entryClass: "cli" as const },
            { agentRuntimeId: "CLAUDE_CODE_APP", displayName: "Claude Code App", entryClass: "app" as const },
        ],
        sourceCapabilities: [],
        targetCapabilities: [],
    },
    {
        adapterId: "OPENCODE",
        displayName: "OpenCode",
        version: "1.0.0",
        enabled: false,
        agentRuntimes: [{ agentRuntimeId: "OPENCODE_CLI", displayName: "OpenCode CLI", entryClass: "cli" as const }],
        sourceCapabilities: [],
        targetCapabilities: [],
    },
];

export const ENABLEMENT = {
    configVersion: 1 as const,
    settingId: "adapter_enablement_v1" as const,
    revision: 1,
    enabledAdapterIds: ["CLAUDECODE"],
    userActionEvidenceId: "user-1",
    updatedAt: 1,
    settingFingerprint: DIGEST,
};

export function watchedSelector(
    identity: string,
    canonicalPath: string,
    selectorFingerprint = DIGEST,
): WatchedScanIntentView["environments"][number]["sourceSelectors"][number] {
    return {
        disposition: "included",
        source: {
            adapterId: "CLAUDECODE",
            rootRole: "source",
            sourceDomain: "project_root",
            canonicalPath,
            locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: identity }],
        },
        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
        binding: { assetScope: "global" },
        selectorFingerprint,
    };
}

export const WATCHED: WatchedScanIntentView = {
    configVersion: 1,
    settingId: "watched_scan_intent_v1",
    revision: 1,
    environments: [
        {
            environment: ENVIRONMENT,
            sourceSelectors: [watchedSelector("moved", "/old")],
        },
    ],
    userActionEvidenceId: "user-1",
    updatedAt: 1,
    settingFingerprint: DIGEST,
};

export const EMPTY_WATCHED: WatchedScanIntentView = {
    configVersion: 1,
    settingId: "watched_scan_intent_v1",
    revision: 0,
    environments: [],
    updatedAt: 0,
    settingFingerprint: DIGEST,
};

export function probeSource(rowId: string, identity: string, displayPath: string, accessStatus = "available") {
    return {
        rowId,
        sourceRootId: `root-${rowId}`,
        rootRole: "source" as const,
        sourceDomain: "project_root" as const,
        displayPath,
        accessStatus,
        locatorIdentities: [{ locatorKind: "runtime_known_rule" as const, locatorKey: identity }],
        diagnostics: [],
    };
}

export const PROBE: ProbeReviewView = {
    probeToken: "probe-token",
    results: [
        {
            rowId: "result-1",
            adapterId: "CLAUDECODE",
            environment: ENVIRONMENT,
            status: "complete",
            runtimes: [
                {
                    rowId: "runtime-1",
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    versionText: "2.1",
                    installationStatus: "available",
                    projectDiscoveryStatus: "complete",
                    sourceRootRowIds: ["source-moved", "source-new"],
                    diagnostics: [],
                },
            ],
            sources: [probeSource("source-moved", "moved", "/new"), probeSource("source-new", "new", "/brand-new")],
            projects: [],
            targets: [],
            diagnostics: [],
        },
    ],
};

export function fakeDiscoveryClient(overrides: Partial<DesktopApplicationClientApi> = {}): DesktopApplicationClientApi {
    const availableOperations = [
        "project.list",
        "project.register",
        "asset.list",
        "asset.get",
        "asset_version.get",
        "watched_scan_intent.get",
    ] as const;
    return {
        availableOperations,
        supportsOperation: vi.fn((operation) => availableOperations.includes(operation as (typeof availableOperations)[number])),
        listAdapterProviders: vi.fn(async () => ({
            status: "complete",
            value: { providers: PROVIDERS },
            diagnostics: [],
        })),
        getAdapterEnablement: vi.fn(async () => ({ status: "complete", value: ENABLEMENT, diagnostics: [] })),
        replaceAdapterEnablement: vi.fn(async (params) => ({
            status: "complete",
            value: {
                ...ENABLEMENT,
                revision: 2,
                enabledAdapterIds: [...params.enabledAdapterIds],
                userActionEvidenceId: params.userActionId,
                updatedAt: 2,
                settingFingerprint: "b".repeat(64),
            },
            diagnostics: [],
        })),
        getWatchedScanIntent: vi.fn(async () => ({ status: "complete", value: EMPTY_WATCHED, diagnostics: [] })),
        listProbeEnvironmentReferences: vi.fn(async () => ({
            status: "complete",
            value: { references: [] },
            diagnostics: [],
        })),
        replaceWatchedScanIntent: vi.fn(async (params) => ({
            status: "complete",
            value: {
                ...EMPTY_WATCHED,
                revision: 1,
                userActionEvidenceId: params.userActionId,
                updatedAt: 2,
                settingFingerprint: "c".repeat(64),
            },
            diagnostics: [],
        })),
        listEnvironments: vi.fn(async () => ({
            status: "complete",
            value: { environments: [{ environment: ENVIRONMENT, displayName: "Local Linux" }] },
            diagnostics: [],
        })),
        probeGlobal: vi.fn(async () => ({ status: "complete", value: PROBE, diagnostics: [] })),
        probeProject: vi.fn(async () => ({ status: "complete", value: PROBE, diagnostics: [] })),
        readSources: vi.fn(async () => ({
            status: "complete",
            value: { readToken: "read-token", reports: [], candidateCount: 0 },
            diagnostics: [],
        })),
        previewImport: vi.fn(async () => ({
            status: "complete",
            value: { previewToken: "preview-token", snapshotFingerprint: DIGEST, candidates: [] },
            diagnostics: [],
        })),
        getImportPreviewDetail: vi.fn(async () => ({
            status: "complete",
            value: {
                candidateId: "candidate-1",
                mediaType: "text/markdown",
                contentKind: "text",
                text: { text: "body", byteLength: 4, truncated: false },
                byteLength: 4,
                contentHash: DIGEST,
            },
            diagnostics: [],
        })),
        cancelImportPreview: vi.fn(async () => ({ status: "complete", value: { cancelled: true }, diagnostics: [] })),
        acceptImportBatch: vi.fn(async () => ({
            status: "complete",
            value: { schemaVersion: 1, items: [] },
            diagnostics: [],
        })),
        listProjects: vi.fn(async () => ({ status: "complete", value: { projects: [] }, diagnostics: [] })),
        listAssets: vi.fn(async () => ({ status: "complete", value: { assets: [] }, diagnostics: [] })),
        listDeployments: vi.fn(async () => ({ status: "complete", value: { deployments: [] }, diagnostics: [] })),
        subscribeInvalidation: vi.fn(() => () => undefined),
        ...overrides,
    };
}

export function fakeImportableDiscoveryClient(): DesktopApplicationClientApi {
    return fakeDiscoveryClient({
        previewImport: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                previewToken: "preview-token",
                snapshotFingerprint: DIGEST,
                candidates: [
                    {
                        candidateId: "guidance",
                        kind: "Guidance" as const,
                        scope: "project" as const,
                        displayName: "Portable guidance",
                        displayDescription: "One reviewed candidate",
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
        })),
        acceptImportBatch: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                schemaVersion: 1 as const,
                items: [
                    {
                        status: "complete" as const,
                        candidateId: "guidance",
                        version: {
                            assetId: "11111111-1111-4111-8111-111111111111",
                            versionId: "22222222-2222-4222-8222-222222222222",
                        },
                        diagnostics: [],
                    },
                ],
            },
            diagnostics: [],
        })),
    });
}
