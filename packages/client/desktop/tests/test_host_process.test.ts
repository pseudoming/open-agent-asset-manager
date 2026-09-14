import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import type { HostConnection, HostStartupDisposition, ProductionHost } from "@oaam/app-server-host";
import { describe, expect, it, vi } from "vitest";
import { bindHostConnection, type HostMessagePort } from "../src/host/host-connection";
import { type HostParentPort, HostProcessRuntime } from "../src/host/host-process-runtime";
import type { DesktopHostControlEvent } from "../src/process/control-protocol";

class FakePort implements HostMessagePort {
    readonly posted: unknown[] = [];
    readonly listeners = {
        message: [] as Array<(event: { readonly data: unknown }) => void>,
        close: [] as Array<() => void>,
    };
    started = false;
    closed = false;

    public on(event: "message" | "close", listener: ((event: { readonly data: unknown }) => void) | (() => void)): this {
        if (event === "message") this.listeners.message.push(listener as (event: { readonly data: unknown }) => void);
        else this.listeners.close.push(listener as () => void);
        return this;
    }

    public postMessage(message: unknown): void {
        this.posted.push(message);
    }

    public start(): void {
        this.started = true;
    }

    public close(): void {
        this.closed = true;
    }

    public emitMessage(data: unknown): void {
        for (const listener of this.listeners.message) listener({ data });
    }

    public emitClose(): void {
        for (const listener of this.listeners.close) listener();
    }
}

function fakeHost(startupDisposition: HostStartupDisposition = { mode: "normal" }): ProductionHost & {
    readonly received: unknown[];
    readonly connection: HostConnection;
    readonly drain: ReturnType<typeof vi.fn>;
    readonly shutdown: ReturnType<typeof vi.fn>;
    readonly resolveStateBackupFileAction: ReturnType<typeof vi.fn>;
    readonly recycleStateBackupFileAction: ReturnType<typeof vi.fn>;
    readonly retireMissingStateBackupFileAction: ReturnType<typeof vi.fn>;
    readonly recordDesktopOperationalDiagnostic: ReturnType<typeof vi.fn>;
    readonly recordDesktopRendererOperationalDiagnostic: ReturnType<typeof vi.fn>;
} {
    const received: unknown[] = [];
    const connection = {
        connectionId: "connection-1",
        registerLocalPathSelection: vi.fn(() => "token"),
        resolveObservedProjectRoot: vi.fn(() => "/observed-project"),
        authorizeObservedProjectRootRegistration: vi.fn(() => ({
            rootPath: "/observed-project",
            localPathSelectionToken: "observed-project-token",
        })),
        resolveRegisteredProjectRoot: vi.fn(() => "/registered-project"),
        authorizeRegisteredProjectRootProbe: vi.fn(() => ({
            rootPath: "/registered-project",
            localPathSelectionToken: "registered-project-token",
        })),
        resolveImportPreviewFileDirectory: vi.fn(() => "/observed-project/.agent"),
        receive: vi.fn((message: unknown) => received.push(message)),
        close: vi.fn(),
    };
    const host = {
        hostInstanceId: "host-1",
        state: "ready" as const,
        startupDisposition,
        availableOperations: [],
        openConnection: vi.fn((sink: { send(message: unknown): void; close(reason: unknown): void }) => {
            sink.send({ id: "response" });
            sink.close("closed");
            return connection;
        }),
        drain: vi.fn(async () => undefined),
        shutdown: vi.fn(async () => undefined),
        resolveStateBackupFileAction: vi.fn(() => "/state/backups/backup.zip"),
        recycleStateBackupFileAction: vi.fn(),
        retireMissingStateBackupFileAction: vi.fn(),
        operationalHealth: vi.fn(() => ({
            schemaVersion: 1,
            overallStatus: "healthy",
            host: { lifecycleState: "ready", startupMode: "normal" },
            ordinaryLog: {
                state: "active",
                suspensionReason: "none",
                retainedBytes: 0,
                maximumBytes: 50 * 1024 * 1024,
                segmentCount: 0,
            },
        })),
        recordDesktopOperationalDiagnostic: vi.fn(),
        recordDesktopRendererOperationalDiagnostic: vi.fn(),
        received,
        connection,
    };
    return host;
}

class FakeParent implements HostParentPort {
    listener: ((event: { readonly data: unknown; readonly ports: readonly HostMessagePort[] }) => void) | undefined;
    readonly events: DesktopHostControlEvent[] = [];

    public on(
        _event: "message",
        listener: (event: { readonly data: unknown; readonly ports: readonly HostMessagePort[] }) => void,
    ): this {
        this.listener = listener;
        return this;
    }

    public postMessage(message: DesktopHostControlEvent): void {
        this.events.push(message);
    }

    public async emit(data: unknown, ports: readonly HostMessagePort[] = []): Promise<void> {
        this.listener?.({ data, ports });
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

const launchOptions: ProductionHostLaunchOptions = {
    oaamRoot: "/state",
    platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
};

describe("Desktop utility Host process", () => {
    it("binds one renderer port to one exact Host connection", () => {
        const host = fakeHost();
        const port = new FakePort();
        const connection = bindHostConnection(host, port);
        expect(connection).toBe(host.connection);
        expect(port.started).toBe(true);
        expect(port.posted).toEqual([{ id: "response" }]);
        expect(port.closed).toBe(true);
        port.emitMessage({ id: "request" });
        port.emitClose();
        expect(host.received).toEqual([{ id: "request" }]);
        expect(host.connection.close).toHaveBeenCalledOnce();
    });

    it("boots, connects, drains and shuts down the real Host interface in order", async () => {
        const parent = new FakeParent();
        const host = fakeHost();
        const stopProcess = vi.fn();
        const runtime = new HostProcessRuntime(parent, {
            launchHost: vi.fn(() => host),
            stopProcess,
        });
        runtime.start();
        await parent.emit({ type: "boot", options: launchOptions });
        expect(parent.events).toEqual([{ type: "ready", hostInstanceId: "host-1", startupDisposition: { mode: "normal" } }]);
        await parent.emit({ type: "record_operational_diagnostic", code: "desktop.host.ready" });
        expect(host.recordDesktopOperationalDiagnostic).toHaveBeenCalledWith("desktop.host.ready");
        await parent.emit({
            type: "record_operational_diagnostic",
            code: "desktop.renderer.event",
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        });
        expect(host.recordDesktopRendererOperationalDiagnostic).toHaveBeenCalledWith({
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        });

        const port = new FakePort();
        await parent.emit({ type: "connect", connectionKey: "renderer-1" }, [port]);
        expect(port.started).toBe(true);
        await parent.emit({
            type: "register_local_path",
            requestId: "path-1",
            connectionKey: "renderer-1",
            kind: "project_root",
            rootPath: "/project",
        });
        expect(host.connection.registerLocalPathSelection).toHaveBeenCalledWith("project_root", "/project");
        expect(parent.events.at(-1)).toEqual({
            type: "local_path_registered",
            requestId: "path-1",
            token: "token",
        });
        const reference = {
            probeToken: "probe-token",
            probeResultRowId: "result-row",
            projectRowId: "project-row",
            sourceRootRowId: "source-row",
        };
        await parent.emit({
            type: "resolve_observed_project_root",
            requestId: "observed-register",
            connectionKey: "renderer-1",
            purpose: "registration",
            reference,
        });
        expect(host.connection.authorizeObservedProjectRootRegistration).toHaveBeenCalledWith(reference);
        expect(parent.events.at(-1)).toEqual({
            type: "observed_project_root_resolved",
            requestId: "observed-register",
            purpose: "registration",
            rootPath: "/observed-project",
            localPathSelectionToken: "observed-project-token",
        });
        await parent.emit({
            type: "resolve_observed_project_root",
            requestId: "observed-reveal",
            connectionKey: "renderer-1",
            purpose: "reveal",
            reference,
        });
        expect(host.connection.resolveObservedProjectRoot).toHaveBeenCalledWith(reference);
        expect(parent.events.at(-1)).toEqual({
            type: "observed_project_root_resolved",
            requestId: "observed-reveal",
            purpose: "reveal",
            rootPath: "/observed-project",
        });
        const projectId = "11111111-1111-4111-8111-111111111111";
        await parent.emit({
            type: "resolve_registered_project_root",
            requestId: "registered-probe",
            connectionKey: "renderer-1",
            purpose: "probe",
            projectId,
        });
        expect(host.connection.authorizeRegisteredProjectRootProbe).toHaveBeenCalledWith(projectId);
        expect(parent.events.at(-1)).toEqual({
            type: "registered_project_root_resolved",
            requestId: "registered-probe",
            purpose: "probe",
            rootPath: "/registered-project",
            localPathSelectionToken: "registered-project-token",
        });
        await parent.emit({
            type: "resolve_registered_project_root",
            requestId: "registered-reveal",
            connectionKey: "renderer-1",
            purpose: "reveal",
            projectId,
        });
        expect(host.connection.resolveRegisteredProjectRoot).toHaveBeenCalledWith(projectId);
        expect(parent.events.at(-1)).toEqual({
            type: "registered_project_root_resolved",
            requestId: "registered-reveal",
            purpose: "reveal",
            rootPath: "/registered-project",
        });
        host.connection.resolveRegisteredProjectRoot.mockImplementationOnce(() => {
            throw new Error("deleted Project");
        });
        await parent.emit({
            type: "resolve_registered_project_root",
            requestId: "registered-stale",
            connectionKey: "renderer-1",
            purpose: "reveal",
            projectId,
        });
        expect(parent.events.at(-1)).toEqual({
            type: "registered_project_root_resolution_failed",
            requestId: "registered-stale",
            code: "host.registered_project_root_resolution_failed",
        });
        const invalidRegisteredProjectPort = new FakePort();
        await parent.emit(
            {
                type: "resolve_registered_project_root",
                requestId: "port-bearing-registered-project",
                connectionKey: "renderer-1",
                purpose: "reveal",
                projectId,
            },
            [invalidRegisteredProjectPort],
        );
        expect(invalidRegisteredProjectPort.closed).toBe(true);
        expect(parent.events.at(-1)).toEqual({
            type: "registered_project_root_resolution_failed",
            requestId: "port-bearing-registered-project",
            code: "host.registered_project_root_unavailable",
        });
        const importPreviewReference = {
            previewToken: "preview-token",
            candidateId: "candidate-id",
            logicalPath: "nested/SKILL.md",
        };
        await parent.emit({
            type: "resolve_import_preview_file_directory",
            requestId: "import-preview-file",
            connectionKey: "renderer-1",
            reference: importPreviewReference,
        });
        expect(host.connection.resolveImportPreviewFileDirectory).toHaveBeenCalledWith(importPreviewReference);
        expect(parent.events.at(-1)).toEqual({
            type: "import_preview_file_directory_resolved",
            requestId: "import-preview-file",
            directoryPath: "/observed-project/.agent",
        });
        host.connection.resolveImportPreviewFileDirectory.mockImplementationOnce(() => {
            throw new Error("stale preview");
        });
        await parent.emit({
            type: "resolve_import_preview_file_directory",
            requestId: "stale-import-preview-file",
            connectionKey: "renderer-1",
            reference: importPreviewReference,
        });
        expect(parent.events.at(-1)).toEqual({
            type: "import_preview_file_directory_resolution_failed",
            requestId: "stale-import-preview-file",
            code: "host.import_preview_file_resolution_failed",
        });
        const invalidImportPreviewPort = new FakePort();
        await parent.emit(
            {
                type: "resolve_import_preview_file_directory",
                requestId: "port-bearing-import-preview-file",
                connectionKey: "renderer-1",
                reference: importPreviewReference,
            },
            [invalidImportPreviewPort],
        );
        expect(invalidImportPreviewPort.closed).toBe(true);
        expect(parent.events.at(-1)).toEqual({
            type: "import_preview_file_directory_resolution_failed",
            requestId: "port-bearing-import-preview-file",
            code: "host.import_preview_file_unavailable",
        });
        port.emitClose();
        await parent.emit({
            type: "register_local_path",
            requestId: "path-after-close",
            connectionKey: "renderer-1",
            kind: "project_root",
            rootPath: "/project",
        });
        expect(parent.events.at(-1)).toEqual({
            type: "local_path_registration_failed",
            requestId: "path-after-close",
            code: "host.path_connection_unavailable",
        });
        await parent.emit({
            type: "resolve_observed_project_root",
            requestId: "observed-after-close",
            connectionKey: "renderer-1",
            purpose: "reveal",
            reference,
        });
        expect(parent.events.at(-1)).toEqual({
            type: "observed_project_root_resolution_failed",
            requestId: "observed-after-close",
            code: "host.observed_project_root_connection_unavailable",
        });
        await parent.emit({
            type: "resolve_registered_project_root",
            requestId: "registered-after-close",
            connectionKey: "renderer-1",
            purpose: "reveal",
            projectId,
        });
        expect(parent.events.at(-1)).toEqual({
            type: "registered_project_root_resolution_failed",
            requestId: "registered-after-close",
            code: "host.registered_project_root_connection_unavailable",
        });
        await parent.emit({
            type: "resolve_import_preview_file_directory",
            requestId: "import-file-after-close",
            connectionKey: "renderer-1",
            reference: importPreviewReference,
        });
        expect(parent.events.at(-1)).toEqual({
            type: "import_preview_file_directory_resolution_failed",
            requestId: "import-file-after-close",
            code: "host.import_preview_file_connection_unavailable",
        });
        await parent.emit({ type: "drain" });
        expect(host.drain).toHaveBeenCalledOnce();
        await parent.emit({ type: "shutdown" });
        expect(host.shutdown).toHaveBeenCalledOnce();
        expect(stopProcess).toHaveBeenCalledOnce();
        expect(parent.events.at(-2)).toEqual({ type: "drained" });
        expect(parent.events.at(-1)).toEqual({ type: "stopped" });
    });

    it("drops unavailable, port-bearing, or failed diagnostic delivery without exposing a general logging channel", async () => {
        const parent = new FakeParent();
        const host = fakeHost();
        const runtime = new HostProcessRuntime(parent, { launchHost: () => host, stopProcess: vi.fn() });
        runtime.start();
        const beforeBootPort = new FakePort();
        await parent.emit({ type: "record_operational_diagnostic", code: "desktop.host.starting" }, [beforeBootPort]);
        expect(beforeBootPort.closed).toBe(true);
        expect(parent.events).toEqual([]);

        await parent.emit({ type: "boot", options: launchOptions });
        host.recordDesktopOperationalDiagnostic.mockImplementationOnce(() => {
            throw new Error("diagnostic storage failed");
        });
        await parent.emit({ type: "record_operational_diagnostic", code: "desktop.host.failed" });
        expect(parent.events).toEqual([{ type: "ready", hostInstanceId: "host-1", startupDisposition: { mode: "normal" } }]);
    });

    it("reports the exact recovery-only startup disposition to the parent process", async () => {
        const parent = new FakeParent();
        const host = fakeHost({ mode: "state_recovery", reason: "restore_reconciliation" });
        const runtime = new HostProcessRuntime(parent, {
            launchHost: () => host,
            stopProcess: vi.fn(),
        });
        runtime.start();
        await parent.emit({ type: "boot", options: launchOptions });
        expect(parent.events).toEqual([
            {
                type: "ready",
                hostInstanceId: "host-1",
                startupDisposition: { mode: "state_recovery", reason: "restore_reconciliation" },
            },
        ]);
    });

    it("fails closed for malformed control, duplicate boot, unavailable connections and invalid state", async () => {
        const parent = new FakeParent();
        const host = fakeHost();
        const runtime = new HostProcessRuntime(parent, {
            launchHost: () => host,
            stopProcess: vi.fn(),
        });
        runtime.start();
        const malformedPort = new FakePort();
        await parent.emit({ type: "bogus" }, [malformedPort]);
        expect(malformedPort.closed).toBe(true);
        const registrationPort = new FakePort();
        await parent.emit(
            {
                type: "register_local_path",
                requestId: "not-ready",
                connectionKey: "renderer-1",
                kind: "project_root",
                rootPath: "/project",
            },
            [registrationPort],
        );
        expect(registrationPort.closed).toBe(true);
        await parent.emit({ type: "connect", connectionKey: "renderer-1" }, [new FakePort(), new FakePort()]);
        await parent.emit({ type: "boot", options: launchOptions });
        const duplicateBootPort = new FakePort();
        await parent.emit({ type: "boot", options: launchOptions }, [duplicateBootPort]);
        expect(duplicateBootPort.closed).toBe(true);
        const stray = new FakePort();
        await parent.emit({ type: "drain" }, [stray]);
        expect(stray.closed).toBe(true);
        expect(parent.events.map((event) => (event.type === "failure" ? event.code : event.type))).toEqual([
            "host.invalid_control_message",
            "local_path_registration_failed",
            "host.connection_unavailable",
            "ready",
            "host.duplicate_boot",
            "host.control_state_invalid",
        ]);
    });

    it("reports bounded failure codes for startup, connection and shutdown exceptions", async () => {
        const startupParent = new FakeParent();
        new HostProcessRuntime(startupParent, {
            launchHost: () => {
                throw new Error("sensitive startup");
            },
            stopProcess: vi.fn(),
        }).start();
        await startupParent.emit({ type: "boot", options: launchOptions });
        expect(startupParent.events).toEqual([{ type: "failure", phase: "startup", code: "host.startup_failed" }]);

        const host = fakeHost();
        host.openConnection = vi.fn(() => {
            throw new Error("connection");
        });
        host.shutdown.mockRejectedValueOnce(new Error("shutdown"));
        const parent = new FakeParent();
        new HostProcessRuntime(parent, { launchHost: () => host, stopProcess: vi.fn() }).start();
        await parent.emit({ type: "boot", options: launchOptions });
        const port = new FakePort();
        await parent.emit({ type: "connect", connectionKey: "renderer-1" }, [port]);
        await parent.emit({ type: "shutdown" });
        expect(port.closed).toBe(true);
        expect(parent.events.slice(1)).toEqual([
            { type: "failure", phase: "connection", code: "host.connection_failed" },
            { type: "failure", phase: "shutdown", code: "host.shutdown_failed" },
        ]);
    });

    it("rejects unknown connection keys and path-registration exceptions without exposing paths", async () => {
        const parent = new FakeParent();
        const host = fakeHost();
        const runtime = new HostProcessRuntime(parent, { launchHost: () => host, stopProcess: vi.fn() });
        runtime.start();
        await parent.emit({ type: "boot", options: launchOptions });
        await parent.emit({
            type: "register_local_path",
            requestId: "missing",
            connectionKey: "unknown",
            kind: "project_root",
            rootPath: "/secret-project",
        });
        expect(parent.events.at(-1)).toEqual({
            type: "local_path_registration_failed",
            requestId: "missing",
            code: "host.path_connection_unavailable",
        });

        const port = new FakePort();
        await parent.emit({ type: "connect", connectionKey: "renderer-1" }, [port]);
        (host.connection.registerLocalPathSelection as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
            throw new Error("/secret-project");
        });
        await parent.emit({
            type: "register_local_path",
            requestId: "failed",
            connectionKey: "renderer-1",
            kind: "project_root",
            rootPath: "/secret-project",
        });
        expect(parent.events.at(-1)).toEqual({
            type: "local_path_registration_failed",
            requestId: "failed",
            code: "host.path_registration_failed",
        });
        expect(JSON.stringify(parent.events)).not.toContain("/secret-project");
    });

    it("bridges Desktop preference bytes and restored preferences through bounded request identities", async () => {
        const parent = new FakeParent();
        const host = fakeHost();
        const createControlId = vi
            .fn()
            .mockReturnValueOnce("read-complete")
            .mockReturnValueOnce("read-failed")
            .mockReturnValueOnce("restore-complete")
            .mockReturnValueOnce("restore-failed");
        let launched: ProductionHostLaunchOptions | undefined;
        const runtime = new HostProcessRuntime(parent, {
            launchHost: (options) => {
                launched = options;
                return host;
            },
            stopProcess: vi.fn(),
            createControlId,
        });
        runtime.start();
        await parent.emit({ type: "boot", options: launchOptions });
        if (launched?.desktopPreferences === undefined || launched.restoreRequiresHostReplacement === undefined) {
            throw new Error("Desktop preference integration was not installed");
        }

        const read = launched.desktopPreferences.read();
        expect(parent.events.at(-1)).toEqual({
            type: "desktop_preferences_read_requested",
            requestId: "read-complete",
        });
        const responseBytes = new Uint8Array([1, 2, 3]);
        await parent.emit({
            type: "desktop_preferences_read_result",
            requestId: "read-complete",
            status: "complete",
            bytes: responseBytes,
        });
        const readBytes = await read;
        expect(readBytes).toEqual(responseBytes);
        expect(readBytes).not.toBe(responseBytes);

        const failedRead = launched.desktopPreferences.read();
        const failedReadExpectation = expect(failedRead).rejects.toThrow("desktop_preferences.read_failed");
        await parent.emit({
            type: "desktop_preferences_read_result",
            requestId: "read-failed",
            status: "failed",
            code: "desktop_preferences.read_failed",
        });
        await failedReadExpectation;

        const restoredBytes = new Uint8Array([4, 5]);
        const restored = launched.desktopPreferences.applyRestored(restoredBytes, "/state/.oaam.restore-txn");
        expect(parent.events.at(-1)).toEqual({
            type: "desktop_preferences_restore_requested",
            requestId: "restore-complete",
            bytes: restoredBytes,
            restoreTransactionPath: "/state/.oaam.restore-txn",
        });
        expect((parent.events.at(-1) as { readonly bytes: Uint8Array }).bytes).not.toBe(restoredBytes);
        await parent.emit({
            type: "desktop_preferences_restore_result",
            requestId: "restore-complete",
            status: "complete",
        });
        await expect(restored).resolves.toBeUndefined();

        const failedRestore = launched.desktopPreferences.applyRestored(new Uint8Array(), "/state/.oaam.restore-txn-failed");
        const failedRestoreExpectation = expect(failedRestore).rejects.toThrow("desktop_preferences.restore_failed");
        await parent.emit({
            type: "desktop_preferences_restore_result",
            requestId: "restore-failed",
            status: "failed",
            code: "desktop_preferences.restore_failed",
        });
        await failedRestoreExpectation;

        launched.restoreRequiresHostReplacement();
        expect(parent.events.at(-1)).toEqual({ type: "restore_replacement_required" });
    });

    it("resolves one registered backup identity without exposing arbitrary renderer paths", async () => {
        const unavailableParent = new FakeParent();
        new HostProcessRuntime(unavailableParent, { launchHost: () => fakeHost(), stopProcess: vi.fn() }).start();
        const stray = new FakePort();
        await unavailableParent.emit(
            {
                type: "resolve_state_backup_file",
                requestId: "unavailable",
                backupId: "00000000-0000-4000-8000-000000000001",
            },
            [stray],
        );
        expect(stray.closed).toBe(true);
        expect(unavailableParent.events).toEqual([
            {
                type: "state_backup_file_resolution_failed",
                requestId: "unavailable",
                code: "host.state_backup_file_unavailable",
            },
        ]);

        const parent = new FakeParent();
        const host = fakeHost();
        new HostProcessRuntime(parent, { launchHost: () => host, stopProcess: vi.fn() }).start();
        await parent.emit({ type: "boot", options: launchOptions });
        await parent.emit({
            type: "resolve_state_backup_file",
            requestId: "resolved",
            backupId: "00000000-0000-4000-8000-000000000001",
        });
        expect(host.resolveStateBackupFileAction).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
        expect(parent.events.at(-1)).toEqual({
            type: "state_backup_file_resolved",
            requestId: "resolved",
            archivePath: "/state/backups/backup.zip",
        });

        host.resolveStateBackupFileAction.mockImplementationOnce(() => {
            throw new Error("/secret/archive.zip");
        });
        await parent.emit({
            type: "resolve_state_backup_file",
            requestId: "failed",
            backupId: "00000000-0000-4000-8000-000000000001",
        });
        expect(parent.events.at(-1)).toEqual({
            type: "state_backup_file_resolution_failed",
            requestId: "failed",
            code: "host.state_backup_file_resolution_failed",
        });
        expect(JSON.stringify(parent.events)).not.toContain("/secret/archive.zip");
    });

    it("routes only finite identity-bound backup mutations and redacts Host failures", async () => {
        const backupId = "00000000-0000-4000-8000-000000000001";
        const unavailableParent = new FakeParent();
        new HostProcessRuntime(unavailableParent, { launchHost: () => fakeHost(), stopProcess: vi.fn() }).start();
        const stray = new FakePort();
        await unavailableParent.emit(
            {
                type: "mutate_state_backup_file",
                requestId: "unavailable",
                backupId,
                action: "identity_bound_trash",
                userActionId: "user-action-1",
            },
            [stray],
        );
        expect(stray.closed).toBe(true);
        expect(unavailableParent.events).toEqual([
            {
                type: "state_backup_file_mutation_failed",
                requestId: "unavailable",
                code: "host.state_backup_file_unavailable",
            },
        ]);

        const parent = new FakeParent();
        const host = fakeHost();
        new HostProcessRuntime(parent, { launchHost: () => host, stopProcess: vi.fn() }).start();
        await parent.emit({ type: "boot", options: launchOptions });
        await parent.emit({
            type: "mutate_state_backup_file",
            requestId: "trash",
            backupId,
            action: "identity_bound_trash",
            userActionId: "user-action-trash",
        });
        expect(host.recycleStateBackupFileAction).toHaveBeenCalledWith(backupId, "user-action-trash");
        expect(parent.events.at(-1)).toEqual({
            type: "state_backup_file_mutation_complete",
            requestId: "trash",
        });

        await parent.emit({
            type: "mutate_state_backup_file",
            requestId: "retire",
            backupId,
            action: "retire_missing",
            userActionId: "user-action-retire",
        });
        expect(host.retireMissingStateBackupFileAction).toHaveBeenCalledWith(backupId, "user-action-retire");
        expect(parent.events.at(-1)).toEqual({
            type: "state_backup_file_mutation_complete",
            requestId: "retire",
        });

        host.recycleStateBackupFileAction.mockImplementationOnce(() => {
            throw new Error("C:\\secret\\backup.zip");
        });
        await parent.emit({
            type: "mutate_state_backup_file",
            requestId: "failed",
            backupId,
            action: "identity_bound_trash",
            userActionId: "user-action-failed",
        });
        expect(parent.events.at(-1)).toEqual({
            type: "state_backup_file_mutation_failed",
            requestId: "failed",
            code: "host.state_backup_file_mutation_failed",
        });
        expect(JSON.stringify(parent.events)).not.toContain("C:\\secret");
    });

    it("rejects unexpected or port-bearing Desktop preference replies and pending work on shutdown", async () => {
        const parent = new FakeParent();
        const host = fakeHost();
        let launched: ProductionHostLaunchOptions | undefined;
        const createControlId = vi.fn().mockReturnValueOnce("pending-read").mockReturnValueOnce("pending-restore");
        new HostProcessRuntime(parent, {
            launchHost: (options) => {
                launched = options;
                return host;
            },
            stopProcess: vi.fn(),
            createControlId,
        }).start();
        await parent.emit({ type: "boot", options: launchOptions });
        if (launched?.desktopPreferences === undefined) throw new Error("Desktop preference integration was not installed");

        const stray = new FakePort();
        await parent.emit(
            {
                type: "desktop_preferences_read_result",
                requestId: "unknown",
                status: "complete",
                bytes: new Uint8Array(),
            },
            [stray],
        );
        expect(stray.closed).toBe(true);
        expect(parent.events.at(-1)).toEqual({
            type: "failure",
            phase: "control",
            code: "host.preference_read_result_invalid",
        });
        await parent.emit({
            type: "desktop_preferences_restore_result",
            requestId: "unknown",
            status: "complete",
        });
        expect(parent.events.at(-1)).toEqual({
            type: "failure",
            phase: "control",
            code: "host.preference_restore_result_unexpected",
        });

        const pendingRead = launched.desktopPreferences.read();
        const pendingRestore = launched.desktopPreferences.applyRestored(new Uint8Array(), "/state/.oaam.restore-txn");
        const pendingReadExpectation = expect(pendingRead).rejects.toThrow(/stopped before preference request completed/u);
        const pendingRestoreExpectation = expect(pendingRestore).rejects.toThrow(/stopped before preference request completed/u);
        await parent.emit({ type: "shutdown" });
        await pendingReadExpectation;
        await pendingRestoreExpectation;
    });
});
