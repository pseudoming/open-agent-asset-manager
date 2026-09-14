import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import type { ProtocolOperationName, ProtocolOperationParams, ProtocolOperationResult } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, ClientConnectionCloseReason, ClientMessageTransport } from "@oaam/client-framework";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import {
    type DesktopHostStartupSnapshot,
    PROTOCOL_PORT_SIGNAL,
    parseAssetVersionExportKind,
    parseAssetVersionExportPickerResult,
    parseAssetVersionExportSuggestedFileName,
    parseDesktopHostStartupSnapshot,
    parsePackagedOnboardingProofReply,
    parseProjectRootPickerResult,
    parseProjectRootPickerSuggestedPath,
    parseSourceRootPickerResult,
} from "../src/bridge/desktop-bridge";
import { projectDesktopHostStartup } from "../src/main/host-startup-projection";
import { UtilityHostSupervisor, type UtilityProcessHandle, type UtilityTransferPort } from "../src/main/utility-host-supervisor";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
} from "../src/presentation/presentation-preferences";
import { App } from "../src/renderer/app/App";
import { type BrowserProtocolPort, DesktopSession } from "../src/renderer/client";
import { toggleInteractionDisclosure } from "./desktop-interaction-test-harness";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";

const LIBRARY_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const LIBRARY_ASSET_ID = "22222222-2222-4222-8222-222222222222";
const LIBRARY_VERSION_ID = "33333333-3333-4333-8333-333333333333";

afterEach(cleanup);

function browserPort(): BrowserProtocolPort {
    return {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

class LifecycleProcess implements UtilityProcessHandle {
    readonly #messageListeners: Array<(message: unknown) => void> = [];
    readonly #exitListeners: Array<(code: number) => void> = [];

    public onMessage(listener: (message: unknown) => void): () => void {
        this.#messageListeners.push(listener);
        return () => undefined;
    }

    public onExit(listener: (code: number) => void): () => void {
        this.#exitListeners.push(listener);
        return () => undefined;
    }

    public postMessage(): void {}

    public kill(): boolean {
        return true;
    }

    public ready(hostInstanceId: string): void {
        for (const listener of this.#messageListeners) {
            listener({ type: "ready", hostInstanceId, startupDisposition: { mode: "normal" } });
        }
    }

    public exit(code: number): void {
        for (const listener of this.#exitListeners) listener(code);
    }
}

function lifecyclePort(): UtilityTransferPort {
    return { close: vi.fn() };
}

function fakeClient(options: {
    initialize?: () => Promise<ProtocolOperationResult<"initialize">>;
    list?: () => Promise<ProtocolOperationResult<"asset.list">>;
    withLibraryFixture?: boolean;
}) {
    const digest = "a".repeat(64);
    const project = {
        projectId: LIBRARY_PROJECT_ID,
        displayName: "Navigation project",
        rootPath: "/work/navigation-project",
        deleted: false,
        createdAt: 1,
        updatedAt: 2,
    };
    const asset = {
        assetId: LIBRARY_ASSET_ID,
        kind: "Guidance" as const,
        scope: "project" as const,
        projectId: LIBRARY_PROJECT_ID,
        scopePath: "",
        displayName: "Navigation guidance",
        displayDescription: "Navigation fixture",
        currentVersionId: LIBRARY_VERSION_ID,
        currentRevision: 1,
        currentFingerprint: digest,
        currentVersionStatus: "complete" as const,
        deleted: false,
        createdAt: 1,
        updatedAt: 2,
    };
    let closeListener: ((reason: ClientConnectionCloseReason) => void) | undefined;
    const client: ClientConnectionApi = {
        state: "created",
        availableOperations: [],
        initialize:
            options.initialize ??
            (async () => ({
                protocolVersion: 1,
                hostInstanceId: "host-1",
                availableOperations: [
                    "adapter_provider.list",
                    "project.list",
                    "project.register",
                    "asset.list",
                    "catalog.search",
                    "asset.get",
                    "asset_version.get",
                    "asset_library.kind_counts",
                    "asset_library.page",
                    "asset_version.list",
                    "asset_version.file_children",
                    "watched_scan_intent.get",
                    "adapter.probe",
                    "deployment.list",
                ],
            })),
        request: (async (method: ProtocolOperationName, _params: ProtocolOperationParams<ProtocolOperationName>) => {
            if (method === "asset.list") {
                return (
                    options.list?.() ?? {
                        status: "complete",
                        value: { assets: options.withLibraryFixture === true ? [asset] : [] },
                        diagnostics: [],
                    }
                );
            }
            const values: Partial<Record<ProtocolOperationName, unknown>> = {
                "adapter_provider.list": { status: "complete", value: { providers: [] }, diagnostics: [] },
                "adapter_enablement.get": {
                    status: "complete",
                    value: {
                        configVersion: 1,
                        settingId: "adapter_enablement_v1",
                        revision: 0,
                        enabledAdapterIds: [],
                        updatedAt: 0,
                        settingFingerprint: digest,
                    },
                    diagnostics: [],
                },
                "watched_scan_intent.get": {
                    status: "complete",
                    value: {
                        configVersion: 1,
                        settingId: "watched_scan_intent_v1",
                        revision: 0,
                        environments: [],
                        updatedAt: 0,
                        settingFingerprint: digest,
                    },
                    diagnostics: [],
                },
                "environment.list": { status: "complete", value: { environments: [] }, diagnostics: [] },
                "project.list": {
                    status: "complete",
                    value: { projects: options.withLibraryFixture === true ? [project] : [] },
                    diagnostics: [],
                },
                "asset.get": {
                    status: "complete",
                    value: {
                        found: true,
                        value: { ...asset, versionIds: [LIBRARY_VERSION_ID] },
                    },
                    diagnostics: [],
                },
                "asset_library.kind_counts": {
                    status: "complete",
                    value: {
                        counts: [
                            { kind: "Guidance", count: options.withLibraryFixture === true ? 1 : 0 },
                            { kind: "Rule", count: 0 },
                            { kind: "Workflow", count: 0 },
                            { kind: "Skill", count: 0 },
                            { kind: "Subagent", count: 0 },
                            { kind: "Memory", count: 0 },
                        ],
                    },
                    diagnostics: [],
                },
                "asset_library.page": {
                    status: "complete",
                    value: {
                        assets: options.withLibraryFixture === true ? [asset] : [],
                        totalCount: options.withLibraryFixture === true ? 1 : 0,
                        hasMore: false,
                    },
                    diagnostics: [],
                },
                "asset_version.list": {
                    status: "complete",
                    value: {
                        found: true,
                        value: {
                            versions: [
                                {
                                    assetId: LIBRARY_ASSET_ID,
                                    versionId: LIBRARY_VERSION_ID,
                                    revision: 1,
                                    status: "complete",
                                    fingerprint: digest,
                                    originAuthorityFingerprint: digest,
                                    versionCanonicalContentFingerprint: digest,
                                    changeKind: "create",
                                    sourceVersionId: "",
                                    sourceDeploymentId: "",
                                    changeNote: "",
                                    fileCount: 0,
                                    createdAt: 2,
                                },
                            ],
                            totalCount: 1,
                            hasMore: false,
                        },
                    },
                    diagnostics: [],
                },
                "asset_version.file_children": {
                    status: "complete",
                    value: { found: true, value: { entries: [], totalCount: 0, hasMore: false } },
                    diagnostics: [],
                },
                "asset_version.get": {
                    status: "complete",
                    value: {
                        found: true,
                        value: {
                            assetId: LIBRARY_ASSET_ID,
                            versionId: LIBRARY_VERSION_ID,
                            revision: 1,
                            status: "complete",
                            versionCanonicalContentFingerprint: digest,
                            files: [],
                            createdAt: 2,
                        },
                    },
                    diagnostics: [],
                },
                "deployment.list": { status: "complete", value: { deployments: [] }, diagnostics: [] },
            };
            const value = values[method];
            if (value === undefined) throw new Error(`unexpected method ${method}`);
            return value;
        }) as ClientConnectionApi["request"],
        start: vi.fn() as ClientConnectionApi["start"],
        subscribeInvalidation: vi.fn(() => () => undefined),
        subscribeClose(listener) {
            closeListener = listener;
            return () => {
                closeListener = undefined;
            };
        },
        close: vi.fn(),
    };
    return {
        client,
        close(reason: ClientConnectionCloseReason = { kind: "transport", cause: "closed" }) {
            closeListener?.(reason);
        },
    };
}

function fakeBridge(): OaamDesktopBridge {
    return {
        ...createDesktopPresentationTestBridge(),
        retrySession: vi.fn(async () => undefined),
        pickProjectRoot: vi.fn(async () => ({ status: "cancelled" as const })),
        pickInstallationRoot: vi.fn(async () => ({ status: "cancelled" as const })),
        authorizeObservedProjectRoot: vi.fn(async () => ({ status: "failed" as const, code: "unavailable" as const })),
        revealObservedProjectRoot: vi.fn(async () => ({ status: "failed" as const, code: "unavailable" as const })),
        authorizeRegisteredProjectRoot: vi.fn(async () => ({ status: "failed" as const, code: "unavailable" as const })),
        revealRegisteredProjectRoot: vi.fn(async () => ({ status: "failed" as const, code: "unavailable" as const })),
        revealImportPreviewFile: vi.fn(async () => ({ status: "failed" as const, code: "unavailable" as const })),
        pickAssetVersionExport: vi.fn(async () => ({ status: "cancelled" as const })),
    };
}

function createSession(client: ClientConnectionApi, bridge: OaamDesktopBridge): DesktopSession {
    return new DesktopSession(bridge, {
        createRequestId: () => "request-1",
        createConnection: vi.fn((_transport: ClientMessageTransport) => client) as never,
    });
}

function expandAssetKind(kind: string): void {
    const tree = screen.getByRole("navigation", { name: "Asset library" });
    const button = within(tree).getAllByRole("button", { name: new RegExp(`^${kind}`, "u") })[0];
    if (button === undefined) throw new Error(`expected ${kind} tree route`);
    fireEvent.click(button);
}

describe("Desktop startup session and App", () => {
    it("initializes the real Client boundary and projects an empty ready catalog", async () => {
        const bridge = fakeBridge();
        const { client } = fakeClient({});
        const session = createSession(client, bridge);
        const states: unknown[] = [];
        session.subscribe((state) => states.push(state));
        session.attach(browserPort());
        await vi.waitFor(() => expect(session.state.status).toBe("ready"));
        expect(session.state).toEqual({
            status: "ready",
            mode: "normal",
            hostInstanceId: "host-1",
            assetCount: 0,
            catalogWarningCount: 0,
        });
        expect(states.at(1)).toEqual({ status: "starting", phase: "connecting", message: "session.connecting" });
        await expect(session.pickProjectRoot("/workspace/project")).resolves.toEqual({ status: "cancelled" });
        expect(bridge.pickProjectRoot).toHaveBeenCalledWith("/workspace/project");
        await expect(session.pickInstallationRoot()).resolves.toEqual({ status: "cancelled" });
        expect(bridge.pickInstallationRoot).toHaveBeenCalledOnce();
        const observedReference = {
            probeToken: "probe-token",
            probeResultRowId: "probe-result-row",
            projectRowId: "project-row",
            sourceRootRowId: "source-root-row",
        };
        await expect(session.authorizeObservedProjectRoot(observedReference)).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        await expect(session.revealObservedProjectRoot(observedReference)).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        await expect(session.authorizeRegisteredProjectRoot("11111111-1111-4111-8111-111111111111")).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        await expect(session.revealRegisteredProjectRoot("11111111-1111-4111-8111-111111111111")).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        const importPreviewReference = {
            previewToken: "preview-token",
            candidateId: "candidate-id",
            logicalPath: "SKILL.md",
        };
        await expect(session.revealImportPreviewFile(importPreviewReference)).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        expect(bridge.authorizeObservedProjectRoot).toHaveBeenCalledWith(observedReference);
        expect(bridge.revealObservedProjectRoot).toHaveBeenCalledWith(observedReference);
        expect(bridge.authorizeRegisteredProjectRoot).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
        expect(bridge.revealRegisteredProjectRoot).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
        expect(bridge.revealImportPreviewFile).toHaveBeenCalledWith(importPreviewReference);
        await expect(session.pickSourceRoot()).resolves.toEqual({ status: "cancelled" });
        await expect(session.pickAssetVersionExport("native_files", "Guidance.zip")).resolves.toEqual({ status: "cancelled" });
        expect(bridge.pickAssetVersionExport).toHaveBeenCalledWith("native_files", "Guidance.zip");
        expect(session.applicationClient?.availableOperations).toContain("asset.list");
        expect(session.applicationClient?.availableOperations).toContain("project.list");
        expect(session.applicationClient?.supportsOperation("asset.list")).toBe(true);
        expect(session.applicationClient?.supportsOperation("deployment.deploy")).toBe(false);
        session.close();
        expect(client.close).toHaveBeenCalledOnce();
    });

    it("routes an uncompleted Desktop profile into onboarding without exposing deployment actions", async () => {
        const incomplete = createDesktopPresentationSnapshot(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, ["en-US"], false);
        const bridge: OaamDesktopBridge = {
            ...fakeBridge(),
            initialPresentation: incomplete,
            completeOnboarding: vi.fn(async () =>
                createDesktopPresentationSnapshot(
                    { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, onboardingCompleted: true },
                    ["en-US"],
                    false,
                ),
            ),
        };
        const session = createSession(fakeClient({}).client, bridge);
        session.attach(browserPort());
        await vi.waitFor(() => expect(session.state.status).toBe("ready"));

        renderWithPresentation(createElement(App, { session }), bridge);
        await vi.waitFor(
            () =>
                expect(
                    screen.queryByRole("heading", {
                        name: "Set up OAAM without changing files used by your AI coding tools",
                    }),
                ).not.toBeNull(),
            { timeout: 5_000 },
        );
        expect(screen.queryByRole("heading", { name: "Catalog & deploy" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "File" }));
        const addProject = screen.getByRole("menuitem", { name: "Add Project…" }) as HTMLButtonElement;
        expect(addProject.disabled).toBe(true);
        fireEvent.click(addProject);
        expect(bridge.pickProjectRoot).not.toHaveBeenCalled();
    });

    it("enters the restricted recovery workspace without requesting ordinary catalog authority", async () => {
        const list = vi.fn(async () => {
            throw new Error("recovery-only session must not request asset.list");
        });
        const fixture = fakeClient({
            initialize: async () => ({
                protocolVersion: 1,
                hostInstanceId: "host-recovery",
                availableOperations: [
                    "initialize",
                    "operation.observe",
                    "operation.cancel",
                    "state_restore.inspect",
                    "state_restore.activate",
                ],
            }),
            list,
        });
        const bridge: OaamDesktopBridge = {
            ...fakeBridge(),
            initialHostStartup: { status: "ready", recoveryReason: "corrupt_database" },
        };
        const session = createSession(fixture.client, bridge);
        session.attach(browserPort());
        await vi.waitFor(() => expect(session.state.status).toBe("ready"));
        expect(session.state).toEqual({
            status: "ready",
            mode: "state_recovery",
            hostInstanceId: "host-recovery",
            assetCount: 0,
            catalogWarningCount: 1,
            recoveryReason: "corrupt_database",
        });
        expect(list).not.toHaveBeenCalled();

        const { unmount } = renderWithPresentation(createElement(App, { session }), bridge);
        expect(await screen.findAllByRole("heading", { name: "Restore OAAM state" }, { timeout: 5_000 })).toHaveLength(2);
        expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
        expect(screen.queryByRole("heading", { name: "Locations and AI coding tools" })).toBeNull();
        expect(screen.queryByRole("heading", { name: "Back up OAAM state" })).toBeNull();
        unmount();
    }, 10_000);

    it("rejects native selection before readiness and parses only exact bounded picker results", async () => {
        const session = createSession(fakeClient({}).client, fakeBridge());
        await expect(session.pickProjectRoot()).rejects.toThrow(/not ready/u);
        await expect(
            session.authorizeObservedProjectRoot({
                probeToken: "probe-token",
                probeResultRowId: "probe-result-row",
                projectRowId: "project-row",
                sourceRootRowId: "source-root-row",
            }),
        ).rejects.toThrow(/not ready/u);
        await expect(session.authorizeRegisteredProjectRoot("11111111-1111-4111-8111-111111111111")).rejects.toThrow(
            /not ready/u,
        );
        await expect(session.revealRegisteredProjectRoot("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/not ready/u);
        await expect(session.pickSourceRoot()).rejects.toThrow(/not ready/u);
        await expect(session.pickInstallationRoot()).rejects.toThrow(/not ready/u);
        await expect(session.pickAssetVersionExport("native_files", "Guidance.zip")).rejects.toThrow(/not ready/u);

        expect(parseProjectRootPickerResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
        expect(parseProjectRootPickerSuggestedPath(undefined)).toBeUndefined();
        expect(parseProjectRootPickerSuggestedPath("/workspace/project")).toBe("/workspace/project");
        for (const malformed of [null, 1, "", " /project", "/project ", "bad\0path", "x".repeat(32_768)]) {
            expect(() => parseProjectRootPickerSuggestedPath(malformed)).toThrow(
                "invalid Desktop project-root picker suggestion",
            );
        }
        expect(
            parseProjectRootPickerResult({
                status: "selected",
                displayPath: "/workspace/project",
                localPathSelectionToken: "token",
            }),
        ).toEqual({
            status: "selected",
            displayPath: "/workspace/project",
            localPathSelectionToken: "token",
        });
        for (const malformed of [
            null,
            [],
            { status: "cancelled", extra: true },
            { status: "selected", displayPath: "", localPathSelectionToken: "token" },
            { status: "selected", displayPath: " /project", localPathSelectionToken: "token" },
            { status: "selected", displayPath: "/project", localPathSelectionToken: "bad\0token" },
            { status: "selected", displayPath: "/project", localPathSelectionToken: 1 },
        ]) {
            expect(() => parseProjectRootPickerResult(malformed)).toThrow("invalid Desktop project-root picker result");
        }
        expect(
            parseSourceRootPickerResult({
                status: "selected",
                displayPath: "/workspace/sources",
                localPathSelectionToken: "source-token",
            }),
        ).toEqual({
            status: "selected",
            displayPath: "/workspace/sources",
            localPathSelectionToken: "source-token",
        });
        expect(() =>
            parseSourceRootPickerResult({ status: "selected", displayPath: "", localPathSelectionToken: "token" }),
        ).toThrow("invalid Desktop source-root picker result");
        expect(parseAssetVersionExportPickerResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
        expect(
            parseAssetVersionExportPickerResult({
                status: "selected",
                displayPath: "/exports/Guidance.zip",
                localPathSelectionToken: "export-token",
            }),
        ).toEqual({
            status: "selected",
            displayPath: "/exports/Guidance.zip",
            localPathSelectionToken: "export-token",
        });
        expect(parseAssetVersionExportSuggestedFileName("Guidance-v1.zip")).toBe("Guidance-v1.zip");
        expect(parseAssetVersionExportKind("native_files")).toBe("native_files");
        expect(parseAssetVersionExportKind("oaam_version_package")).toBe("oaam_version_package");
        expect(() => parseAssetVersionExportKind("other")).toThrow("invalid Desktop Asset Version export kind");
        for (const malformed of [
            "",
            " Guidance.zip",
            "Guidance.zip ",
            "Guidance",
            "Guidance.tar",
            "../Guidance.zip",
            "folder/Guidance.zip",
            "folder\\Guidance.zip",
            `Guidance${"\0"}.zip`,
            `${"a".repeat(237)}.zip`,
        ]) {
            expect(() => parseAssetVersionExportSuggestedFileName(malformed)).toThrow(
                "invalid Desktop Asset Version export filename",
            );
        }
        expect(() =>
            parseAssetVersionExportPickerResult({
                status: "selected",
                displayPath: "",
                localPathSelectionToken: "export-token",
            }),
        ).toThrow("invalid Desktop Asset Version export picker result");

        expect(parseDesktopHostStartupSnapshot({ status: "starting" })).toEqual({ status: "starting" });
        expect(parseDesktopHostStartupSnapshot({ status: "recovering", reasonCode: "host.startup_recovering" })).toEqual({
            status: "recovering",
            reasonCode: "host.startup_recovering",
        });
        expect(parseDesktopHostStartupSnapshot({ status: "ready" })).toEqual({ status: "ready" });
        expect(parseDesktopHostStartupSnapshot({ status: "ready", recoveryReason: "restore_reconciliation" })).toEqual({
            status: "ready",
            recoveryReason: "restore_reconciliation",
        });
        expect(parseDesktopHostStartupSnapshot({ status: "failed", reasonCode: "host.startup_timeout" })).toEqual({
            status: "failed",
            reasonCode: "host.startup_timeout",
        });
        for (const malformed of [
            { status: "failed" },
            { status: "failed", reasonCode: "other" },
            { status: "ready", reasonCode: "host.startup_timeout" },
            { status: "recovering" },
            { status: "ready", recoveryReason: "foreign" },
            { status: "starting", extra: true },
        ]) {
            expect(() => parseDesktopHostStartupSnapshot(malformed)).toThrow("invalid Desktop Host startup snapshot");
        }
        expect(parsePackagedOnboardingProofReply({ status: "complete" })).toEqual({ status: "complete" });
        expect(
            parsePackagedOnboardingProofReply({
                status: "failed",
                step: "config_source",
                diagnosticCodes: ["adapter.probe_partial", "source.not_found"],
            }),
        ).toEqual({
            status: "failed",
            step: "config_source",
            diagnosticCodes: ["adapter.probe_partial", "source.not_found"],
        });
        expect(parsePackagedOnboardingProofReply({ status: "failed", step: "unexpected", diagnosticCodes: [] })).toEqual({
            status: "failed",
            step: "unexpected",
            diagnosticCodes: [],
        });
        for (const malformed of [
            null,
            {},
            { status: "other" },
            { status: "complete", extra: true },
            { status: "failed" },
            { status: "failed", step: "other" },
            { status: "failed", step: "probe", diagnosticCodes: ["source.not_found", "adapter.probe_partial"] },
            { status: "failed", step: "probe", diagnosticCodes: ["duplicate", "duplicate"] },
            { status: "failed", step: "probe", diagnosticCodes: ["bad code"] },
            { status: "failed", step: "probe", diagnosticCodes: [], extra: true },
        ]) {
            expect(() => parsePackagedOnboardingProofReply(malformed)).toThrow("invalid packaged onboarding proof reply");
        }
    });

    it("projects pre-ready recovery and the bounded terminal timeout before a Protocol port exists", () => {
        let listener: ((snapshot: DesktopHostStartupSnapshot) => void) | undefined;
        const bridge: OaamDesktopBridge = {
            ...fakeBridge(),
            subscribeHostStartup(next) {
                listener = next;
                return () => {
                    listener = undefined;
                };
            },
        };
        const session = createSession(fakeClient({}).client, bridge);

        listener?.({ status: "recovering", reasonCode: "host.startup_recovering" });
        expect(session.state).toEqual({
            status: "starting",
            phase: "reconnecting",
            message: "session.host_recovering",
            reasonCode: "host.startup_recovering",
        });
        listener?.({ status: "failed", reasonCode: "host.startup_timeout" });
        expect(session.state).toEqual({
            status: "failed",
            message: "session.host_startup_timeout",
            reasonCode: "host.startup_timeout",
            canRetry: true,
        });
        listener?.({ status: "failed", reasonCode: "host.process_spawn_failed" });
        expect(session.state).toEqual({
            status: "failed",
            message: "session.host_startup_failed",
            reasonCode: "host.process_spawn_failed",
            canRetry: true,
        });
    });

    it("keeps failed and partial catalog outcomes truthful", async () => {
        const bridge = fakeBridge();
        const failed = fakeClient({
            list: async () => ({ status: "failed", diagnostics: [] }),
        });
        const failedSession = createSession(failed.client, bridge);
        failedSession.attach(browserPort());
        await vi.waitFor(() => expect(failedSession.state.status).toBe("failed"));
        expect(failedSession.state).toMatchObject({ message: "session.catalog_unavailable", canRetry: true });

        const partial = fakeClient({
            list: async () => ({
                status: "partial",
                value: { assets: [] },
                diagnostics: [
                    {
                        severity: "warning",
                        code: "catalog.partial",
                        operation: "asset",
                        causeKind: "partial",
                        retryable: true,
                        suggestedActions: ["retry"],
                        message: "partial",
                    },
                ],
            }),
        });
        const partialSession = createSession(partial.client, bridge);
        partialSession.attach(browserPort());
        await vi.waitFor(() => expect(partialSession.state.status).toBe("ready"));
        expect(partialSession.state).toMatchObject({ catalogWarningCount: 1 });
    });

    it("ignores stale initialization and exposes explicit retry after connection or initialization failure", async () => {
        const bridge = fakeBridge();
        let resolveFirst: ((value: ProtocolOperationResult<"initialize">) => void) | undefined;
        const first = fakeClient({
            initialize: () =>
                new Promise((resolve) => {
                    resolveFirst = resolve;
                }),
        });
        const second = fakeClient({
            initialize: async () => {
                throw new Error("failed");
            },
        });
        let current = first.client;
        const session = new DesktopSession(bridge, {
            createRequestId: () => "request",
            createConnection: vi.fn(() => current) as never,
        });
        session.attach(browserPort());
        current = second.client;
        session.attach(browserPort());
        resolveFirst?.({ protocolVersion: 1, hostInstanceId: "stale", availableOperations: ["asset.list"] });
        await vi.waitFor(() => expect(session.state.status).toBe("failed"));
        first.close();
        expect(session.state.status).toBe("failed");
        await session.retry();
        expect(bridge.retrySession).toHaveBeenCalledOnce();
        expect(session.state).toEqual({ status: "starting", phase: "manual_retry", message: "session.restarting" });
    });

    it("returns an unavailable native retry to a truthful failed state", async () => {
        const bridge = fakeBridge();
        (bridge.retrySession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("old Host is still active"));
        const session = createSession(fakeClient({}).client, bridge);

        await session.retry();

        expect(session.state).toEqual({
            status: "failed",
            message: "session.restart_failed",
            reasonCode: "session.restart_failed",
            canRetry: true,
        });
    });

    it("renders loading, accepts only the exact transferred port signal, renders failure and retries", async () => {
        const bridge = fakeBridge();
        const fake = fakeClient({});
        const session = createSession(fake.client, bridge);
        const { unmount } = renderWithPresentation(createElement(App, { session }), bridge);
        expect(screen.getByRole("status").textContent).toContain("Starting OAAM");

        window.dispatchEvent(
            new MessageEvent("message", { data: "foreign", source: window, ports: [browserPort() as MessagePort] }),
        );
        expect(session.state.status).toBe("starting");
        await act(async () => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: PROTOCOL_PORT_SIGNAL,
                    source: window,
                    ports: [browserPort() as MessagePort],
                }),
            );
        });
        await vi.waitFor(() => expect(screen.queryByRole("heading", { level: 2, name: "Start with a Project" })).not.toBeNull(), {
            timeout: 5_000,
        });
        const assetTree = screen.getByRole("navigation", { name: "Asset library" });
        expect(within(assetTree).getAllByRole("button")).toHaveLength(1);
        expect(within(assetTree).getByRole("button", { name: "Add Project" })).not.toBeNull();
        expect(screen.queryByRole("navigation", { name: "Workspace view" })).toBeNull();
        expect(screen.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe("true");
        expect(screen.getByRole("tab", { name: "Global" }).getAttribute("aria-selected")).toBe("false");
        expect(screen.queryByRole("button", { name: /deploy|run discovery|review selected sources/iu })).toBeNull();
        expect(screen.getByRole("status").textContent).toContain("Running");
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        expect(await screen.findByRole("dialog", { name: "Search OAAM" })).not.toBeNull();
        const catalogSearchInput = screen.getByRole("searchbox", { name: "Search OAAM" });
        await vi.waitFor(() => expect(document.activeElement).toBe(catalogSearchInput));
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        fireEvent.click(screen.getByRole("button", { name: "Search OAAM" }));
        fireEvent.click(screen.getByRole("button", { name: /^General/u }));
        expect(await screen.findByRole("heading", { level: 1, name: "General" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
        fireEvent.click(screen.getByRole("button", { name: "File" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Add Project…" }));
        await vi.waitFor(() => expect(bridge.pickProjectRoot).toHaveBeenCalledOnce());

        fireEvent.click(screen.getByRole("tab", { name: "Global" }));
        await vi.waitFor(() => expect(screen.getByRole("tab", { name: "Global" }).getAttribute("aria-selected")).toBe("true"));
        fireEvent.click(await screen.findByRole("button", { name: "Import from existing tools" }));
        expect(
            await screen.findByRole("heading", {
                name: "Find and import Assets from your AI coding tools",
            }),
        ).not.toBeNull();
        expect(
            screen.queryByRole("heading", {
                name: "Set up OAAM without changing files used by your AI coding tools",
            }),
        ).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Skip guided import" }));
        expect(await screen.findByRole("tab", { name: "Global" })).not.toBeNull();
        expect(screen.getByRole("tab", { name: "Global" }).getAttribute("aria-selected")).toBe("true");
        expect(screen.queryByRole("navigation", { name: "Import source navigation" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        expect(await screen.findByRole("heading", { level: 1, name: "General" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /^Diagnostics/u }));
        expect(await screen.findByRole("heading", { level: 1, name: "Diagnostics and support" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
        expect(await screen.findByRole("tab", { name: "Global" })).not.toBeNull();
        fireEvent.click(screen.getByLabelText("Forward"));
        expect(await screen.findByRole("heading", { level: 1, name: "General" })).not.toBeNull();
        fireEvent.click(screen.getByLabelText("Forward"));
        expect(await screen.findByRole("heading", { level: 1, name: "Diagnostics and support" })).not.toBeNull();
        fireEvent.click(screen.getByLabelText("Back"));
        expect(await screen.findByRole("heading", { level: 1, name: "General" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
        expect(await screen.findByRole("tab", { name: "Global" })).not.toBeNull();
        fireEvent.click(screen.getByLabelText("Forward"));
        expect(await screen.findByRole("heading", { level: 1, name: "General" })).not.toBeNull();
        fireEvent.click(screen.getByLabelText("Back"));
        expect(await screen.findByRole("tab", { name: "Global" })).not.toBeNull();
        fireEvent.click(screen.getByLabelText("Toggle sidebar"));
        expect(screen.queryByRole("navigation", { name: "Asset library" })).toBeNull();
        fireEvent.click(screen.getByLabelText("Toggle sidebar"));
        expect(screen.getByRole("navigation", { name: "Asset library" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        fireEvent.click(await screen.findByRole("button", { name: /^Locations and AI coding tools/u }));
        fireEvent.click(await screen.findByRole("button", { name: "Start an import" }));
        expect(
            screen.getByRole("heading", {
                name: "Find and import Assets from your AI coding tools",
            }),
        ).not.toBeNull();
        expect(screen.queryByText("First run")).toBeNull();
        fireEvent.click(screen.getByLabelText("Back"));
        expect(await screen.findByRole("heading", { level: 1, name: "Locations and AI coding tools" })).not.toBeNull();
        fireEvent.click(screen.getByLabelText("Forward"));
        expect(
            await screen.findByRole("heading", {
                name: "Find and import Assets from your AI coding tools",
            }),
        ).not.toBeNull();
        act(() => fake.close());
        expect(screen.queryByRole("heading", { name: "OAAM could not finish starting." })).not.toBeNull();
        toggleInteractionDisclosure("app.app.001");
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(bridge.retrySession).toHaveBeenCalledOnce();
        unmount();
    }, 20_000);

    it("blocks stale work after a real supervisor loss, bounds replacement, and recovers only after explicit retry", async () => {
        const processes = [new LifecycleProcess(), new LifecycleProcess(), new LifecycleProcess()];
        let processIndex = 0;
        const launchOptions: ProductionHostLaunchOptions = {
            oaamRoot: "/state",
            platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
        };
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    const process = processes[processIndex++];
                    if (process === undefined) throw new Error("unexpected extra Host process");
                    return process;
                },
                createChannel: () => ({ hostPort: lifecyclePort(), clientPort: lifecyclePort() }),
            },
            launchOptions,
        );
        let hostListener: ((snapshot: DesktopHostStartupSnapshot) => void) | undefined;
        const openDiagnostics = vi.fn(async () => ({ status: "complete" as const }));
        const bridge: OaamDesktopBridge = {
            ...fakeBridge(),
            retrySession: vi.fn(async () => supervisor.retry()),
            performDesktopDataLocationAction: openDiagnostics,
            subscribeHostStartup(listener) {
                hostListener = listener;
                return () => {
                    hostListener = undefined;
                };
            },
        };
        const fixture = fakeClient({});
        const session = createSession(fixture.client, bridge);
        supervisor.subscribe((event) => {
            const snapshot = projectDesktopHostStartup(event);
            if (snapshot !== undefined) hostListener?.(snapshot);
        });
        const { container, unmount } = renderWithPresentation(createElement(App, { session }), bridge);

        supervisor.start();
        processes[0]?.ready("host-1");
        session.attach(browserPort());
        await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("Running"));

        processes[0]?.exit(7);
        expect(processIndex).toBe(2);
        expect(await screen.findByRole("heading", { name: "Reconnecting OAAM" })).not.toBeNull();
        toggleInteractionDisclosure("app.app.004", container);
        expect(screen.queryByRole("tab", { name: "Projects" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Search OAAM" })).toBeNull();

        processes[1]?.exit(7);
        expect(await screen.findByText("host.process_failed")).not.toBeNull();
        expect(ordinarySurfaceText(container)).not.toContain("host.process_failed");
        expect(processIndex).toBe(2);
        fireEvent.click(screen.getByRole("button", { name: "Ordinary logs" }));
        await vi.waitFor(() => expect(openDiagnostics).toHaveBeenCalledWith("ordinary_logs", "open"));

        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(processIndex).toBe(3);
        expect(screen.getByRole("status").textContent).toContain("Restarting OAAM");
        processes[2]?.ready("host-3");
        session.attach(browserPort());
        await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("Running"));
        expect(processIndex).toBe(3);

        unmount();
        supervisor.shutdown();
        processes[2]?.exit(0);
    });

    it("keeps a selected Project and Asset in history while inspector visibility remains presentation-only", async () => {
        const bridge = fakeBridge();
        const fixture = fakeClient({ withLibraryFixture: true });
        const session = createSession(fixture.client, bridge);
        const { unmount } = renderWithPresentation(createElement(App, { session }), bridge);

        await act(async () => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: PROTOCOL_PORT_SIGNAL,
                    source: window,
                    ports: [browserPort() as MessagePort],
                }),
            );
        });
        expect(await screen.findByRole("heading", { level: 1, name: "Navigation project" })).not.toBeNull();
        expect(
            document.querySelector(`[data-oaam-route="library"][data-oaam-project-id="${LIBRARY_PROJECT_ID}"]`),
        ).not.toBeNull();

        await vi.waitFor(() =>
            expect(
                within(screen.getByRole("navigation", { name: "Asset library" })).queryAllByRole("button", {
                    name: /^Guidance/u,
                }).length,
            ).toBeGreaterThan(0),
        );
        expandAssetKind("Guidance");
        await vi.waitFor(() => expect(screen.queryByText("Navigation guidance")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: /Navigation guidance/u }));
        expect(await screen.findByRole("heading", { name: "Files" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        expect(screen.queryByRole("heading", { name: "Files" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "View" }));
        fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Toggle Inspector" }));
        expect(await screen.findByRole("heading", { name: "Files" })).not.toBeNull();

        const assetActions = document.querySelector(".asset-action-section");
        expect(assetActions).not.toBeNull();
        fireEvent.click(await within(assetActions as HTMLElement).findByRole("button", { name: "Choose where to use" }));
        expect(await screen.findByRole("heading", { level: 1, name: "Apply Navigation guidance to a tool" })).not.toBeNull();
        expect(document.querySelector("[data-oaam-deployment-mode='create']")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
        expect(await screen.findByRole("heading", { level: 1, name: "Navigation project" }, { timeout: 3_000 })).not.toBeNull();
        expect(await screen.findByRole("heading", { name: "Files" }, { timeout: 3_000 })).not.toBeNull();
        fireEvent.mouseUp(window, { button: 3 });
        expect(await screen.findByRole("heading", { level: 1, name: "Apply Navigation guidance to a tool" })).not.toBeNull();
        fireEvent.mouseUp(window, { button: 4 });
        expect(await screen.findByRole("heading", { level: 1, name: "Navigation project" }, { timeout: 3_000 })).not.toBeNull();
        expect(await screen.findByRole("heading", { name: "Files" }, { timeout: 3_000 })).not.toBeNull();
        unmount();
    });

    it("fails closed when a ready session has no usable Desktop application client", () => {
        const bridge = fakeBridge();
        const state = {
            status: "ready" as const,
            mode: "normal" as const,
            hostInstanceId: "host-1",
            assetCount: 1,
            catalogWarningCount: 1,
        };
        const session = {
            state,
            applicationClient: undefined,
            subscribe(listener: (next: typeof state) => void) {
                listener(state);
                return () => undefined;
            },
            close: vi.fn(),
            retry: vi.fn(),
            openDiagnostics: vi.fn(async () => ({ status: "complete" as const })),
            attach: vi.fn(),
        } as unknown as DesktopSession;
        const { unmount } = renderWithPresentation(createElement(App, { session }), bridge);
        expect(screen.queryByRole("heading", { name: "OAAM could not open the local workspace." })).not.toBeNull();
        unmount();
    });
});
