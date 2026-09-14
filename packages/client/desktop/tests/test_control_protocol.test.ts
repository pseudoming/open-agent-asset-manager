import { describe, expect, it } from "vitest";
import { parseDesktopHostControlCommand, parseDesktopHostControlEvent } from "../src/process/control-protocol";

const launchOptions = {
    oaamRoot: "/state",
    databasePath: "/state/oaam.sqlite",
    platformContexts: [{ platform: "linux" as const, platformInstanceId: "local", accessRootPath: "/" }],
};

const observedProjectRootReference = {
    probeToken: "probe-token",
    probeResultRowId: "probe-result-row",
    projectRowId: "project-row",
    sourceRootRowId: "source-root-row",
};

const importPreviewFileReference = {
    previewToken: "preview-token",
    candidateId: "candidate-id",
    logicalPath: "nested/SKILL.md",
};

const projectId = "11111111-1111-4111-8111-111111111111";

describe("Desktop utility control protocol", () => {
    it("round-trips every closed command and event branch", () => {
        expect(parseDesktopHostControlCommand({ type: "boot", options: launchOptions })).toEqual({
            type: "boot",
            options: launchOptions,
        });
        expect(parseDesktopHostControlCommand({ type: "connect", connectionKey: "connection-1" })).toEqual({
            type: "connect",
            connectionKey: "connection-1",
        });
        expect(
            parseDesktopHostControlCommand({
                type: "register_local_path",
                requestId: "request-1",
                connectionKey: "connection-1",
                kind: "project_root",
                rootPath: "/project",
            }),
        ).toEqual({
            type: "register_local_path",
            requestId: "request-1",
            connectionKey: "connection-1",
            kind: "project_root",
            rootPath: "/project",
        });
        for (const kind of ["backup_destination", "restore_archive"] as const) {
            expect(
                parseDesktopHostControlCommand({
                    type: "register_local_path",
                    requestId: `request-${kind}`,
                    connectionKey: "connection-1",
                    kind,
                    rootPath: "/selected",
                }),
            ).toMatchObject({ type: "register_local_path", kind, rootPath: "/selected" });
        }
        for (const purpose of ["registration", "reveal"] as const) {
            expect(
                parseDesktopHostControlCommand({
                    type: "resolve_observed_project_root",
                    requestId: `request-${purpose}`,
                    connectionKey: "connection-1",
                    purpose,
                    reference: observedProjectRootReference,
                }),
            ).toEqual({
                type: "resolve_observed_project_root",
                requestId: `request-${purpose}`,
                connectionKey: "connection-1",
                purpose,
                reference: observedProjectRootReference,
            });
        }
        for (const purpose of ["probe", "reveal"] as const) {
            expect(
                parseDesktopHostControlCommand({
                    type: "resolve_registered_project_root",
                    requestId: `registered-${purpose}`,
                    connectionKey: "connection-1",
                    purpose,
                    projectId,
                }),
            ).toEqual({
                type: "resolve_registered_project_root",
                requestId: `registered-${purpose}`,
                connectionKey: "connection-1",
                purpose,
                projectId,
            });
        }
        expect(
            parseDesktopHostControlCommand({
                type: "resolve_import_preview_file_directory",
                requestId: "request-import-file",
                connectionKey: "connection-1",
                reference: importPreviewFileReference,
            }),
        ).toEqual({
            type: "resolve_import_preview_file_directory",
            requestId: "request-import-file",
            connectionKey: "connection-1",
            reference: importPreviewFileReference,
        });
        expect(
            parseDesktopHostControlCommand({
                type: "desktop_preferences_read_result",
                requestId: "read-1",
                status: "complete",
                bytes: new Uint8Array([1, 2]),
            }),
        ).toEqual({
            type: "desktop_preferences_read_result",
            requestId: "read-1",
            status: "complete",
            bytes: new Uint8Array([1, 2]),
        });
        expect(
            parseDesktopHostControlCommand({
                type: "desktop_preferences_read_result",
                requestId: "read-2",
                status: "failed",
                code: "desktop_preferences.read_failed",
            }),
        ).toEqual({
            type: "desktop_preferences_read_result",
            requestId: "read-2",
            status: "failed",
            code: "desktop_preferences.read_failed",
        });
        expect(
            parseDesktopHostControlCommand({
                type: "desktop_preferences_restore_result",
                requestId: "restore-1",
                status: "complete",
            }),
        ).toEqual({
            type: "desktop_preferences_restore_result",
            requestId: "restore-1",
            status: "complete",
        });
        expect(
            parseDesktopHostControlCommand({
                type: "desktop_preferences_restore_result",
                requestId: "restore-2",
                status: "failed",
                code: "desktop_preferences.restore_failed",
            }),
        ).toEqual({
            type: "desktop_preferences_restore_result",
            requestId: "restore-2",
            status: "failed",
            code: "desktop_preferences.restore_failed",
        });
        expect(
            parseDesktopHostControlCommand({
                type: "resolve_state_backup_file",
                requestId: "resolve-1",
                backupId: "00000000-0000-4000-8000-000000000001",
            }),
        ).toEqual({
            type: "resolve_state_backup_file",
            requestId: "resolve-1",
            backupId: "00000000-0000-4000-8000-000000000001",
        });
        for (const action of ["identity_bound_trash", "retire_missing"] as const) {
            expect(
                parseDesktopHostControlCommand({
                    type: "mutate_state_backup_file",
                    requestId: `mutate-${action}`,
                    backupId: "00000000-0000-4000-8000-000000000001",
                    action,
                    userActionId: "user-action-1",
                }),
            ).toEqual({
                type: "mutate_state_backup_file",
                requestId: `mutate-${action}`,
                backupId: "00000000-0000-4000-8000-000000000001",
                action,
                userActionId: "user-action-1",
            });
        }
        expect(
            parseDesktopHostControlCommand({
                type: "record_operational_diagnostic",
                code: "desktop.host.ready",
            }),
        ).toEqual({
            type: "record_operational_diagnostic",
            code: "desktop.host.ready",
        });
        expect(
            parseDesktopHostControlCommand({
                type: "record_operational_diagnostic",
                code: "desktop.renderer.event",
                event: "failure",
                failureKind: "render",
                surface: "library",
                componentTrail: ["AssetVersionPanel"],
            }),
        ).toEqual({
            type: "record_operational_diagnostic",
            code: "desktop.renderer.event",
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        });
        expect(parseDesktopHostControlCommand({ type: "drain" })).toEqual({ type: "drain" });
        expect(parseDesktopHostControlCommand({ type: "shutdown" })).toEqual({ type: "shutdown" });
        expect(
            parseDesktopHostControlEvent({
                type: "ready",
                hostInstanceId: "host-1",
                startupDisposition: { mode: "normal" },
            }),
        ).toEqual({
            type: "ready",
            hostInstanceId: "host-1",
            startupDisposition: { mode: "normal" },
        });
        expect(
            parseDesktopHostControlEvent({
                type: "ready",
                hostInstanceId: "host-recovery",
                startupDisposition: { mode: "state_recovery", reason: "corrupt_database" },
            }),
        ).toEqual({
            type: "ready",
            hostInstanceId: "host-recovery",
            startupDisposition: { mode: "state_recovery", reason: "corrupt_database" },
        });
        expect(parseDesktopHostControlEvent({ type: "drained" })).toEqual({ type: "drained" });
        expect(
            parseDesktopHostControlEvent({
                type: "local_path_registered",
                requestId: "request-1",
                token: "token-1",
            }),
        ).toEqual({ type: "local_path_registered", requestId: "request-1", token: "token-1" });
        expect(
            parseDesktopHostControlEvent({
                type: "local_path_registration_failed",
                requestId: "request-2",
                code: "host.path_registration_failed",
            }),
        ).toEqual({
            type: "local_path_registration_failed",
            requestId: "request-2",
            code: "host.path_registration_failed",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "observed_project_root_resolved",
                requestId: "observed-registration",
                purpose: "registration",
                rootPath: "/project",
                localPathSelectionToken: "project-root-token",
            }),
        ).toEqual({
            type: "observed_project_root_resolved",
            requestId: "observed-registration",
            purpose: "registration",
            rootPath: "/project",
            localPathSelectionToken: "project-root-token",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "observed_project_root_resolved",
                requestId: "observed-reveal",
                purpose: "reveal",
                rootPath: "/project",
            }),
        ).toEqual({
            type: "observed_project_root_resolved",
            requestId: "observed-reveal",
            purpose: "reveal",
            rootPath: "/project",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "observed_project_root_resolution_failed",
                requestId: "observed-failed",
                code: "host.observed_project_root_unavailable",
            }),
        ).toEqual({
            type: "observed_project_root_resolution_failed",
            requestId: "observed-failed",
            code: "host.observed_project_root_unavailable",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "registered_project_root_resolved",
                requestId: "registered-probe",
                purpose: "probe",
                rootPath: "/project",
                localPathSelectionToken: "project-root-token",
            }),
        ).toEqual({
            type: "registered_project_root_resolved",
            requestId: "registered-probe",
            purpose: "probe",
            rootPath: "/project",
            localPathSelectionToken: "project-root-token",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "registered_project_root_resolved",
                requestId: "registered-reveal",
                purpose: "reveal",
                rootPath: "/project",
            }),
        ).toEqual({
            type: "registered_project_root_resolved",
            requestId: "registered-reveal",
            purpose: "reveal",
            rootPath: "/project",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "registered_project_root_resolution_failed",
                requestId: "registered-failed",
                code: "host.registered_project_root_unavailable",
            }),
        ).toEqual({
            type: "registered_project_root_resolution_failed",
            requestId: "registered-failed",
            code: "host.registered_project_root_unavailable",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "import_preview_file_directory_resolved",
                requestId: "import-file-resolved",
                directoryPath: "/source/skill",
            }),
        ).toEqual({
            type: "import_preview_file_directory_resolved",
            requestId: "import-file-resolved",
            directoryPath: "/source/skill",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "import_preview_file_directory_resolution_failed",
                requestId: "import-file-failed",
                code: "host.import_preview_file_unavailable",
            }),
        ).toEqual({
            type: "import_preview_file_directory_resolution_failed",
            requestId: "import-file-failed",
            code: "host.import_preview_file_unavailable",
        });
        expect(parseDesktopHostControlEvent({ type: "desktop_preferences_read_requested", requestId: "read-1" })).toEqual({
            type: "desktop_preferences_read_requested",
            requestId: "read-1",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "desktop_preferences_restore_requested",
                requestId: "restore-1",
                bytes: new Uint8Array([3, 4]),
                restoreTransactionPath: "/state/.oaam.restore-txn",
            }),
        ).toEqual({
            type: "desktop_preferences_restore_requested",
            requestId: "restore-1",
            bytes: new Uint8Array([3, 4]),
            restoreTransactionPath: "/state/.oaam.restore-txn",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "state_backup_file_resolved",
                requestId: "resolve-1",
                archivePath: "/state/backups/backup.zip",
            }),
        ).toEqual({
            type: "state_backup_file_resolved",
            requestId: "resolve-1",
            archivePath: "/state/backups/backup.zip",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "state_backup_file_resolution_failed",
                requestId: "resolve-2",
                code: "backup.not_found",
            }),
        ).toEqual({
            type: "state_backup_file_resolution_failed",
            requestId: "resolve-2",
            code: "backup.not_found",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "state_backup_file_mutation_complete",
                requestId: "mutate-1",
            }),
        ).toEqual({
            type: "state_backup_file_mutation_complete",
            requestId: "mutate-1",
        });
        expect(
            parseDesktopHostControlEvent({
                type: "state_backup_file_mutation_failed",
                requestId: "mutate-2",
                code: "backup.replaced",
            }),
        ).toEqual({
            type: "state_backup_file_mutation_failed",
            requestId: "mutate-2",
            code: "backup.replaced",
        });
        expect(parseDesktopHostControlEvent({ type: "restore_replacement_required" })).toEqual({
            type: "restore_replacement_required",
        });
        expect(parseDesktopHostControlEvent({ type: "stopped" })).toEqual({ type: "stopped" });
        expect(parseDesktopHostControlEvent({ type: "failure", phase: "startup", code: "host.startup_failed" })).toEqual({
            type: "failure",
            phase: "startup",
            code: "host.startup_failed",
        });
    });

    it.each([
        null,
        [],
        {},
        { type: "unknown" },
        { type: "connect" },
        { type: "connect", connectionKey: "", extra: true },
        { type: "register_local_path", requestId: "request", connectionKey: "connection", kind: "foreign", rootPath: "/" },
        { type: "register_local_path", requestId: "", connectionKey: "connection", kind: "project_root", rootPath: "/" },
        {
            type: "resolve_observed_project_root",
            requestId: "request",
            connectionKey: "connection",
            purpose: "foreign",
            reference: observedProjectRootReference,
        },
        {
            type: "resolve_observed_project_root",
            requestId: "request",
            connectionKey: "connection",
            purpose: "registration",
            reference: { ...observedProjectRootReference, projectRowId: "" },
        },
        {
            type: "resolve_observed_project_root",
            requestId: "request",
            connectionKey: "connection",
            purpose: "reveal",
            reference: { ...observedProjectRootReference, extra: true },
        },
        {
            type: "resolve_registered_project_root",
            requestId: "request",
            connectionKey: "connection",
            purpose: "probe",
            projectId: "11111111-1111-1111-8111-111111111111",
        },
        {
            type: "resolve_registered_project_root",
            requestId: "request",
            connectionKey: "connection",
            purpose: "foreign",
            projectId,
        },
        {
            type: "resolve_registered_project_root",
            requestId: "request",
            connectionKey: "connection",
            purpose: "reveal",
            projectId,
            rootPath: "/foreign",
        },
        {
            type: "resolve_import_preview_file_directory",
            requestId: "request",
            connectionKey: "connection",
            reference: { ...importPreviewFileReference, logicalPath: "" },
        },
        {
            type: "resolve_import_preview_file_directory",
            requestId: "request",
            connectionKey: "connection",
            reference: { ...importPreviewFileReference, extra: true },
        },
        { type: "boot" },
        { type: "boot", options: { ...launchOptions, oaamRoot: "" } },
        { type: "boot", options: { ...launchOptions, databasePath: "" } },
        { type: "boot", options: { ...launchOptions, platformContexts: [] } },
        {
            type: "boot",
            options: {
                ...launchOptions,
                platformContexts: [{ platform: "foreign", platformInstanceId: "local", accessRootPath: "/" }],
            },
        },
        {
            type: "boot",
            options: {
                ...launchOptions,
                platformContexts: [{ platform: "linux", platformInstanceId: "", accessRootPath: "/" }],
            },
        },
        {
            type: "boot",
            options: {
                ...launchOptions,
                platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "" }],
            },
        },
        {
            type: "desktop_preferences_read_result",
            requestId: "request",
            status: "complete",
            bytes: new Uint8Array(1024 * 1024 + 1),
        },
        { type: "desktop_preferences_read_result", requestId: "", status: "failed", code: "failed" },
        { type: "desktop_preferences_restore_result", requestId: "", status: "complete" },
        { type: "desktop_preferences_restore_result", requestId: "request", status: "failed", code: "" },
        {
            type: "resolve_state_backup_file",
            requestId: "request",
            backupId: "00000000-0000-1000-8000-000000000001",
        },
        {
            type: "resolve_state_backup_file",
            requestId: "",
            backupId: "00000000-0000-4000-8000-000000000001",
        },
        {
            type: "mutate_state_backup_file",
            requestId: "request",
            backupId: "00000000-0000-4000-8000-000000000001",
            action: "permanent_delete",
            userActionId: "user-action",
        },
        {
            type: "mutate_state_backup_file",
            requestId: "request",
            backupId: "00000000-0000-1000-8000-000000000001",
            action: "identity_bound_trash",
            userActionId: "user-action",
        },
        {
            type: "mutate_state_backup_file",
            requestId: "request",
            backupId: "00000000-0000-4000-8000-000000000001",
            action: "identity_bound_trash",
            userActionId: "",
        },
        { type: "record_operational_diagnostic", code: "desktop.free_text" },
        { type: "record_operational_diagnostic", code: "desktop.renderer.event" },
        {
            type: "record_operational_diagnostic",
            code: "desktop.renderer.event",
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["user/path"],
        },
        { type: "record_operational_diagnostic", code: "desktop.host.ready", path: "/secret" },
    ])("rejects malformed or non-exact command %#", (value) => {
        expect(() => parseDesktopHostControlCommand(value)).toThrow(/Desktop Host|invalid|bounded/u);
    });

    it.each([
        null,
        [],
        {},
        { type: "unknown" },
        { type: "ready", hostInstanceId: "" },
        { type: "ready", hostInstanceId: "host", startupDisposition: { mode: "normal", extra: true } },
        { type: "ready", hostInstanceId: "host", startupDisposition: { mode: "state_recovery", reason: "foreign" } },
        { type: "drained", extra: true },
        { type: "failure", phase: "foreign", code: "failed" },
        { type: "failure", phase: "startup", code: "" },
        { type: "failure", phase: "startup", code: "host.free_text" },
        { type: "local_path_registered", requestId: "", token: "token" },
        { type: "local_path_registration_failed", requestId: "request", code: "", extra: true },
        {
            type: "observed_project_root_resolved",
            requestId: "request",
            purpose: "registration",
            rootPath: "/project",
        },
        {
            type: "observed_project_root_resolved",
            requestId: "request",
            purpose: "reveal",
            rootPath: "/project",
            localPathSelectionToken: "unexpected",
        },
        {
            type: "observed_project_root_resolution_failed",
            requestId: "request",
            code: "",
        },
        {
            type: "registered_project_root_resolved",
            requestId: "request",
            purpose: "probe",
            rootPath: "/project",
        },
        {
            type: "registered_project_root_resolved",
            requestId: "request",
            purpose: "reveal",
            rootPath: "/project",
            localPathSelectionToken: "unexpected",
        },
        {
            type: "registered_project_root_resolution_failed",
            requestId: "request",
            code: "",
        },
        { type: "import_preview_file_directory_resolved", requestId: "request", directoryPath: "" },
        {
            type: "import_preview_file_directory_resolution_failed",
            requestId: "request",
            code: "",
        },
        { type: "desktop_preferences_read_requested", requestId: "" },
        {
            type: "desktop_preferences_restore_requested",
            requestId: "request",
            bytes: new Uint8Array(1024 * 1024 + 1),
            restoreTransactionPath: "/state/restore",
        },
        {
            type: "desktop_preferences_restore_requested",
            requestId: "request",
            bytes: new Uint8Array(),
            restoreTransactionPath: "",
        },
        { type: "state_backup_file_resolved", requestId: "", archivePath: "/backup.zip" },
        { type: "state_backup_file_resolution_failed", requestId: "request", code: "" },
        { type: "state_backup_file_mutation_complete", requestId: "", extra: true },
        { type: "state_backup_file_mutation_failed", requestId: "request", code: "" },
        { type: "restore_replacement_required", extra: true },
    ])("rejects malformed or non-exact event %#", (value) => {
        expect(() => parseDesktopHostControlEvent(value)).toThrow(/Desktop Host|invalid/u);
    });
});
