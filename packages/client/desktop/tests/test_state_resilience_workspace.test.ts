import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { StateResilienceWorkspace } from "../src/renderer/features/state-resilience";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";
import { DIGEST, fakeDiscoveryClient } from "./discovery-test-fixtures";

const BACKUP_ID = "00000000-0000-4000-8000-000000000001";
const RESTORE_ID = "00000000-0000-4000-8000-000000000002";

function failedResult(message: string, operation: ProtocolDiagnosticV1["operation"] = "backup") {
    return {
        status: "failed" as const,
        diagnostics: [
            {
                severity: "error" as const,
                code: "state.failed",
                operation,
                causeKind: "unavailable" as const,
                retryable: true,
                suggestedActions: ["retry"],
                message,
            },
        ],
    };
}

function stateClient(): DesktopApplicationClientApi {
    const inventory = {
        schemaVersion: 1 as const,
        entries: [
            {
                schemaVersion: 1 as const,
                backupId: BACKUP_ID,
                createdAt: 10,
                archiveDisplayPath: "/profile/backups/backup.zip",
                archiveByteSize: 1_024,
                archiveContentHash: DIGEST,
                manifestFingerprint: "b".repeat(64),
                sourceSnapshotFingerprint: DIGEST,
                encryptionMode: "none" as const,
                destinationKind: "oaam_default" as const,
                observation: "available" as const,
            },
            {
                schemaVersion: 1 as const,
                backupId: "00000000-0000-4000-8000-000000000003",
                createdAt: 9,
                archiveDisplayPath: "/profile/backups/missing.zip",
                archiveByteSize: 2_048,
                archiveContentHash: DIGEST,
                manifestFingerprint: DIGEST,
                sourceSnapshotFingerprint: DIGEST,
                encryptionMode: "compatible_password" as const,
                destinationKind: "oaam_default" as const,
                observation: "missing" as const,
            },
            {
                schemaVersion: 1 as const,
                backupId: "00000000-0000-4000-8000-000000000004",
                createdAt: 8,
                archiveDisplayPath: "/profile/backups/replaced.zip",
                archiveByteSize: 3_072,
                archiveContentHash: DIGEST,
                manifestFingerprint: DIGEST,
                sourceSnapshotFingerprint: DIGEST,
                encryptionMode: "strong_password" as const,
                destinationKind: "custom_directory" as const,
                observation: "replaced" as const,
            },
        ],
        totalKnownArchiveBytes: 6_144,
        totalAvailableArchiveBytes: 1_024,
    };
    const policy = {
        configVersion: 1 as const,
        settingId: "state_backup_prompt_policy_v1" as const,
        revision: 0 as const,
        mode: "ask_every_time" as const,
        updatedAt: 0 as const,
        settingFingerprint: DIGEST,
    };
    return fakeDiscoveryClient({
        supportsOperation: vi.fn(() => true),
        listStateBackups: vi.fn(async () => ({ status: "complete", value: inventory, diagnostics: [] })),
        getStateBackupPromptPolicy: vi.fn(async () => ({ status: "complete", value: policy, diagnostics: [] })),
        replaceStateBackupPromptPolicy: vi.fn(async (params) => ({
            status: "complete",
            value: {
                ...policy,
                revision: 1,
                mode: params.mode,
                userActionEvidenceId: params.userActionId,
                updatedAt: 20,
                settingFingerprint: "c".repeat(64),
            },
            diagnostics: [],
        })),
        inspectStateBackup: vi.fn(async (_params, listener) => {
            listener?.({
                status: "progress",
                operation: "state_backup.inspect",
                operationId: "backup-inspect",
                sequence: 1,
                progress: { stage: "inventory", completedUnits: 1, totalUnits: 2 },
            });
            return {
                status: "complete",
                value: {
                    backupReviewToken: "backup-review",
                    backupId: BACKUP_ID,
                    createdAt: 10,
                    destinationKind: "custom_directory",
                    destinationDisplayPath: "/custom/backups",
                    destinationState: "ready",
                    outputFileName: "backup.zip",
                    encryptionMode: "compatible_password",
                    sourceFileCount: 3,
                    sourceLogicalBytes: 2_048,
                    requiredAvailableBytes: 4_096,
                    availableBytes: 8_192,
                    sourceSnapshotFingerprint: DIGEST,
                },
                diagnostics: [],
            };
        }),
        createStateBackup: vi.fn(async (_params, listener) => {
            listener?.({
                status: "progress",
                operation: "state_backup.create",
                operationId: "backup-create",
                sequence: 1,
                progress: { stage: "verification", completedUnits: 1, totalUnits: 1 },
            });
            return {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    backupId: BACKUP_ID,
                    createdAt: 10,
                    archiveDisplayPath: "/custom/backups/backup.zip",
                    archiveByteSize: 1_024,
                    archiveContentHash: DIGEST,
                    manifestFingerprint: DIGEST,
                    sourceSnapshotFingerprint: DIGEST,
                    encryptionMode: "compatible_password",
                },
                diagnostics: [],
            };
        }),
        inspectStateRestore: vi.fn(async (_params, listener) => {
            listener?.({
                status: "progress",
                operation: "state_restore.inspect",
                operationId: "restore-inspect",
                sequence: 1,
                progress: { stage: "inspection", completedUnits: 1, totalUnits: 1 },
            });
            return {
                status: "complete",
                value: {
                    restoreReviewToken: "restore-review",
                    backupId: BACKUP_ID,
                    backupCreatedAt: 10,
                    archiveDisplayPath: "/profile/backups/backup.zip",
                    archiveByteSize: 1_024,
                    archiveContentHash: DIGEST,
                    encryptionMode: "none",
                    sourceFileCount: 3,
                    sourceLogicalBytes: 2_048,
                    sourceSnapshotFingerprint: DIGEST,
                    manifestFingerprint: DIGEST,
                    includesDesktopPreferences: true,
                },
                diagnostics: [],
            };
        }),
        activateStateRestore: vi.fn(async (_params, listener) => {
            listener?.({
                status: "progress",
                operation: "state_restore.activate",
                operationId: "restore-activate",
                sequence: 1,
                progress: { stage: "restart_required", completedUnits: 1, totalUnits: 1 },
            });
            return {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    restoreId: RESTORE_ID,
                    backupId: BACKUP_ID,
                    activatedAt: 20,
                    restoredSourceSnapshotFingerprint: DIGEST,
                    displacedState: { state: "preserved", displayPath: "/profile.displaced" },
                    requiresRestart: true,
                    restoredDesktopPreferences: true,
                },
                diagnostics: [],
            };
        }),
    });
}

function stateBridge(): OaamDesktopBridge {
    return {
        ...createDesktopPresentationTestBridge(),
        pickStateBackupDestination: vi.fn(async () => ({
            status: "selected",
            displayPath: "/custom/backups",
            localPathSelectionToken: "destination-token",
        })),
        selectRememberedStateBackupDestination: vi.fn(async () => ({
            status: "selected",
            displayPath: "/remembered/backups",
            localPathSelectionToken: "remembered-token",
        })),
        pickStateRestoreArchive: vi.fn(async () => ({
            status: "selected",
            displayPath: "/external/backup.zip",
            localPathSelectionToken: "archive-token",
        })),
        getStateResiliencePreferences: vi.fn(async () => ({
            schemaVersion: 1,
            lastCustomBackupDirectory: "/remembered/backups",
        })),
        rememberStateBackupDestination: vi.fn(async () => ({
            schemaVersion: 1,
            lastCustomBackupDirectory: "/custom/backups",
        })),
        performStateBackupFileAction: vi.fn(async () => ({ status: "complete" })),
    };
}

afterEach(cleanup);

function selectOption(label: string, option: string): void {
    fireEvent.click(screen.getByRole("combobox", { name: label }));
    fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("Desktop State resilience workspace", () => {
    it.each(["source_changed", "preparation_expired"])("requires a fresh review token after backup %s", async (code) => {
        const client = stateClient();
        const inspect = client.inspectStateBackup;
        const create = client.createStateBackup;
        let reviewCount = 0;
        client.inspectStateBackup = vi.fn(async (params, listener) => {
            const result = await inspect(params, listener);
            if (result.status === "failed") return result;
            reviewCount += 1;
            return {
                ...result,
                value: {
                    ...result.value,
                    backupReviewToken: `review-${reviewCount}`,
                    encryptionMode: "none",
                    destinationKind: "oaam_default",
                },
            };
        });
        const failure = failedResult("The reviewed state is no longer current");
        client.createStateBackup = vi
            .fn()
            .mockResolvedValueOnce({
                ...failure,
                diagnostics: failure.diagnostics.map((entry) => ({ ...entry, code, causeKind: "conflict" })),
            })
            .mockImplementation(create);
        const bridge = stateBridge();
        renderWithPresentation(createElement(StateResilienceWorkspace, { client, desktopBridge: bridge }), bridge);
        await screen.findByText("/profile/backups/backup.zip");
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        await screen.findByRole("heading", { name: "Backup review" });
        expect(screen.queryByRole("button", { name: "Review backup" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Create verified backup" }));
        await screen.findByText("The backup was not created.");
        expect(screen.queryByRole("button", { name: "Create verified backup" })).toBeNull();
        expect(client.inspectStateBackup).toHaveBeenCalledTimes(1);
        expect(client.createStateBackup).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        await screen.findByRole("heading", { name: "Backup review" });
        fireEvent.click(screen.getByRole("button", { name: "Create verified backup" }));
        await screen.findByText("Created at /custom/backups/backup.zip");
        expect(client.inspectStateBackup).toHaveBeenCalledTimes(2);
        expect(client.createStateBackup).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ backupReviewToken: "review-1" }),
            expect.any(Function),
        );
        expect(client.createStateBackup).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ backupReviewToken: "review-2" }),
            expect.any(Function),
        );
    });

    it("places pending backup progress and completed review feedback in their own operation section", async () => {
        const client = stateClient();
        const inspect = client.inspectStateBackup;
        let finish: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        client.inspectStateBackup = vi.fn(async (params, listener) => {
            const result = await inspect(params, listener);
            await pending;
            return result;
        });
        const bridge = stateBridge();
        const view = renderWithPresentation(createElement(StateResilienceWorkspace, { client, desktopBridge: bridge }), bridge);
        await screen.findByText("/profile/backups/backup.zip");
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        const progress = await screen.findByRole("progressbar");
        expect(progress.closest("section")?.getAttribute("aria-labelledby")).toBe("state-backup-create-title");
        expect(view.container.querySelectorAll('[id="state-resilience-progress"]')).toHaveLength(1);
        await act(async () => finish?.());
        await screen.findByRole("heading", { name: "Backup review" });
        expect(screen.queryByRole("progressbar")).toBeNull();
        expect(view.container.querySelector(".state-resilience-review [role='status']")).not.toBeNull();
        expect(screen.queryByRole("button", { name: "Review backup" })).toBeNull();
    });

    it("drives backup, inventory file actions, whole-unit restore, and prompt policy through exact authorities", async () => {
        const client = stateClient();
        const bridge = stateBridge();
        renderWithPresentation(createElement(StateResilienceWorkspace, { client, desktopBridge: bridge }), bridge);

        await screen.findByRole("heading", { name: "Back up OAAM state" });
        await screen.findByText("/profile/backups/backup.zip");
        expect(screen.getByText("Missing")).not.toBeNull();
        expect(screen.getByText("Replaced")).not.toBeNull();
        expect(screen.getByText(/Last successful custom folder/u)).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await vi.waitFor(() => expect(client.listStateBackups).toHaveBeenCalledTimes(2));
        await vi.waitFor(() =>
            expect((screen.getByRole("button", { name: "Choose another folder…" }) as HTMLButtonElement).disabled).toBe(false),
        );

        fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }));
        await vi.waitFor(() => expect(bridge.pickStateBackupDestination).toHaveBeenCalledOnce());
        selectOption("Archive encryption", "Compatible password (weak ZipCrypto)");
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        await screen.findByRole("heading", { name: "Backup review" });
        expect(client.inspectStateBackup).toHaveBeenCalledWith(
            {
                destination: { destinationKind: "custom_directory", localPathSelectionToken: "destination-token" },
                encryptionMode: "compatible_password",
            },
            expect.any(Function),
        );

        expect(screen.getByRole("button", { name: "Create verified backup" }).hasAttribute("disabled")).toBe(true);
        expect(client.createStateBackup).not.toHaveBeenCalled();
        expect(screen.getByText("Enter the same non-empty password twice.")).not.toBeNull();
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "weak-but-compatible" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "weak-but-compatible" } });
        fireEvent.click(screen.getByRole("button", { name: "Create verified backup" }));
        await screen.findByText("Created at /custom/backups/backup.zip");
        expect(screen.queryByText("The verified backup was created.")).toBeNull();
        expect(client.createStateBackup).toHaveBeenCalledWith(
            expect.objectContaining({ backupReviewToken: "backup-review", password: "weak-but-compatible" }),
            expect.any(Function),
        );
        expect(bridge.rememberStateBackupDestination).toHaveBeenCalledWith(BACKUP_ID);

        fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
        await vi.waitFor(() => expect(bridge.performStateBackupFileAction).toHaveBeenCalledWith(BACKUP_ID, "reveal"));
        fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
        await vi.waitFor(() => expect(bridge.performStateBackupFileAction).toHaveBeenCalledWith(BACKUP_ID, "copy_path"));
        fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
        fireEvent.click(screen.getByRole("button", { name: "Move this backup to Trash" }));
        await vi.waitFor(() => expect(bridge.performStateBackupFileAction).toHaveBeenCalledWith(BACKUP_ID, "trash"));
        await vi.waitFor(() => expect(client.listStateBackups).toHaveBeenCalledTimes(4));
        await vi.waitFor(() => expect(screen.getByRole("button", { name: "Restore…" }).hasAttribute("disabled")).toBe(false));

        selectOption("Pre-destructive backup prompt", "Back up first");
        fireEvent.click(screen.getByRole("button", { name: "Save prompt preference" }));
        await screen.findByText("The backup prompt preference was saved.");
        expect(client.replaceStateBackupPromptPolicy).toHaveBeenCalledWith(
            expect.objectContaining({ expectedRevision: 0, mode: "back_up_first" }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Restore…" }));
        expect(screen.queryByLabelText("Archive password, if required")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Inspect backup" }));
        await vi.waitFor(() => expect(client.inspectStateRestore).toHaveBeenCalledOnce());
        await screen.findByRole("heading", { name: "Restore review" });
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(screen.getByRole("button", { name: "Restore this complete backup" }));
        await screen.findByText("Restored. Previous state: /profile.displaced. OAAM is restarting.");
        expect(client.activateStateRestore).toHaveBeenCalledWith(
            expect.objectContaining({ restoreReviewToken: "restore-review" }),
            expect.any(Function),
        );
        expect(vi.mocked(client.activateStateRestore).mock.calls[0]?.[0]).not.toHaveProperty("password");
    });

    it.each([
        false,
        true,
    ])("retains one restore terminal without allowing new requests before Host replacement (recoveryOnly=%s)", async (recoveryOnly) => {
        const client = stateClient();
        if (recoveryOnly) {
            client.supportsOperation = vi.fn(
                (operation) => operation === "state_restore.inspect" || operation === "state_restore.activate",
            );
        }
        const bridge = stateBridge();
        const view = renderWithPresentation(
            createElement(StateResilienceWorkspace, { client, desktopBridge: bridge, recoveryOnly }),
            bridge,
        );
        if (!recoveryOnly) await screen.findByText("/profile/backups/backup.zip");
        const choose = screen.getByRole("button", { name: "Choose another ZIP…" });
        fireEvent.click(choose);
        await screen.findByText("/external/backup.zip");
        fireEvent.change(screen.getByLabelText("Archive password, if required"), {
            target: { value: "restore-password" },
        });
        const inspect = screen.getByRole("button", { name: "Inspect backup" });
        fireEvent.click(inspect);
        await screen.findByRole("heading", { name: "Restore review" });
        fireEvent.click(screen.getByRole("checkbox"));
        const activate = screen.getByRole("button", { name: "Restore this complete backup" });
        fireEvent.click(activate);

        const restored = await screen.findByText("Restored. Previous state: /profile.displaced. OAAM is restarting.");
        expect(screen.queryByText("The backup was activated. OAAM is reopening with the restored data.")).toBeNull();
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.queryByRole("combobox")).toBeNull();
        expect(screen.queryByLabelText("Archive password, if required")).toBeNull();
        expect(screen.getAllByRole("status")).toHaveLength(1);
        expect(restored.closest("section")?.getAttribute("aria-labelledby")).toBe("state-restore-title");
        for (const previousControl of [choose, inspect, activate]) {
            expect(previousControl.isConnected).toBe(false);
            fireEvent.click(previousControl);
        }
        expect(restored.isConnected).toBe(true);
        expect(bridge.pickStateRestoreArchive).toHaveBeenCalledOnce();
        expect(client.inspectStateRestore).toHaveBeenCalledOnce();
        expect(client.inspectStateRestore).toHaveBeenCalledWith(
            {
                source: { sourceKind: "selected_archive", localPathSelectionToken: "archive-token" },
                password: "restore-password",
            },
            expect.any(Function),
        );
        expect(client.activateStateRestore).toHaveBeenCalledOnce();
        expect(client.activateStateRestore).toHaveBeenCalledWith(
            expect.objectContaining({ restoreReviewToken: "restore-review", password: "restore-password" }),
            expect.any(Function),
        );
        expect(client.listStateBackups).toHaveBeenCalledTimes(recoveryOnly ? 0 : 1);
        expect(client.inspectStateBackup).not.toHaveBeenCalled();
        expect(client.createStateBackup).not.toHaveBeenCalled();
        expect(client.replaceStateBackupPromptPolicy).not.toHaveBeenCalled();
        expect(bridge.performStateBackupFileAction).not.toHaveBeenCalled();
        expect(ordinarySurfaceText(view.container)).toContain("/profile.displaced");
    });

    it("retains partial restore evidence when an earlier archive picker resolves after activation", async () => {
        const client = stateClient();
        const activateStateRestore = client.activateStateRestore;
        const diagnostic: ProtocolDiagnosticV1 = {
            severity: "warning",
            code: "restore.desktop_preferences_not_applied",
            operation: "restore",
            causeKind: "internal_error",
            retryable: true,
            suggestedActions: ["retry", "contact_support"],
            message: "State authority was restored, but Desktop preferences could not be applied.",
        };
        client.activateStateRestore = vi.fn(async (...args: Parameters<typeof activateStateRestore>) => {
            const result = await activateStateRestore(...args);
            if (result.status !== "complete") throw new Error("activation fixture is incomplete");
            return {
                ...result,
                status: "partial" as const,
                value: { ...result.value, restoredDesktopPreferences: false },
                diagnostics: [diagnostic],
            };
        });
        const bridge = stateBridge();
        const pickStateRestoreArchive = bridge.pickStateRestoreArchive;
        type PickerResult = Awaited<ReturnType<OaamDesktopBridge["pickStateRestoreArchive"]>>;
        let releasePicker: ((result: PickerResult) => void) | undefined;
        const pendingPicker = new Promise<PickerResult>((resolve) => {
            releasePicker = resolve;
        });
        bridge.pickStateRestoreArchive = vi
            .fn()
            .mockImplementationOnce(pickStateRestoreArchive)
            .mockImplementationOnce(() => pendingPicker);
        const view = renderWithPresentation(createElement(StateResilienceWorkspace, { client, desktopBridge: bridge }), bridge);
        await screen.findByText("/profile/backups/backup.zip");
        fireEvent.click(screen.getByRole("button", { name: "Choose another ZIP…" }));
        await screen.findByText("/external/backup.zip");
        fireEvent.click(screen.getByRole("button", { name: "Inspect backup" }));
        await screen.findByRole("heading", { name: "Restore review" });
        fireEvent.click(screen.getByRole("button", { name: "Choose another ZIP…" }));
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(screen.getByRole("button", { name: "Restore this complete backup" }));
        await screen.findByText("Original detail: State authority was restored, but Desktop preferences could not be applied.");
        expect(view.container.querySelector(".state-resilience-workspace")?.getAttribute("data-oaam-restore-result")).toBe(
            "partial",
        );
        expect(view.container.querySelectorAll(".workbench-notice-warning")).toHaveLength(1);
        await act(async () => {
            if (releasePicker === undefined) throw new Error("held archive picker was not registered");
            releasePicker({ status: "selected", displayPath: "/later/backup.zip", localPathSelectionToken: "later-token" });
            await pendingPicker;
        });
        expect(ordinarySurfaceText(view.container)).toContain(
            "Restored. Previous state: /profile.displaced. OAAM is restarting.",
        );
        expect(screen.getByText(`Original detail: ${diagnostic.message}`)).not.toBeNull();
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.queryByText("/later/backup.zip")).toBeNull();
        expect(client.inspectStateRestore).toHaveBeenCalledOnce();
        expect(client.activateStateRestore).toHaveBeenCalledOnce();
        expect(bridge.pickStateRestoreArchive).toHaveBeenCalledTimes(2);
    });

    it("retains a successful load warning as technical evidence without replacing ordinary product copy", async () => {
        const client = stateClient();
        const listStateBackups = client.listStateBackups;
        client.listStateBackups = vi.fn(async () => {
            const result = await listStateBackups();
            if (result.status !== "complete") return result;
            return {
                ...result,
                diagnostics: [
                    {
                        severity: "warning" as const,
                        code: "backup.inventory.partial_fixture",
                        operation: "backup" as const,
                        causeKind: "partial" as const,
                        retryable: true,
                        suggestedActions: ["retry" as const],
                        message: "One backup metadata row was incomplete.",
                    },
                ],
            };
        });
        const bridge = stateBridge();
        const view = renderWithPresentation(createElement(StateResilienceWorkspace, { client, desktopBridge: bridge }), bridge);

        expect(await screen.findByText("Backup information loaded with details that may need attention.")).not.toBeNull();
        expect(screen.getByText("Original detail: One backup metadata row was incomplete.")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("One backup metadata row was incomplete.");
    });

    it("does not call a partial old Host and reports load or finite bridge failures visibly", async () => {
        const unsupported = stateClient();
        unsupported.supportsOperation = vi.fn(() => false);
        const bridge = stateBridge();
        const first = renderWithPresentation(
            createElement(StateResilienceWorkspace, { client: unsupported, desktopBridge: bridge }),
            bridge,
        );
        expect(screen.getByText("Backup and restore are unavailable in the current OAAM session.")).not.toBeNull();
        expect(unsupported.listStateBackups).not.toHaveBeenCalled();
        first.unmount();

        const failedLoad = stateClient();
        failedLoad.listStateBackups = vi.fn(async () => ({
            status: "failed",
            diagnostics: [
                {
                    severity: "error",
                    code: "backup.failed",
                    operation: "backup",
                    causeKind: "unavailable",
                    retryable: true,
                    suggestedActions: ["retry"],
                    message: "Inventory unavailable",
                },
            ],
        }));
        const failingBridge: OaamDesktopBridge = {
            ...bridge,
            pickStateBackupDestination: vi.fn(async () => {
                throw new Error("picker failure");
            }),
        };
        const view = renderWithPresentation(
            createElement(StateResilienceWorkspace, { client: failedLoad, desktopBridge: failingBridge }),
            failingBridge,
        );
        await screen.findByText("Backup and restore state could not be loaded.");
        expect(screen.getByText("Original detail: Inventory unavailable")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("Inventory unavailable");
        fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }));
        await screen.findByText("The backup folder could not be selected.");
    });

    it("invalidates one-shot backup authority and surfaces review, creation, and policy failures", async () => {
        const client = stateClient();
        const successfulInspect = client.inspectStateBackup;
        client.inspectStateBackup = vi
            .fn()
            .mockResolvedValueOnce(failedResult("Custom destination was rejected"))
            .mockRejectedValueOnce(new Error("connection lost"))
            .mockImplementation(successfulInspect);
        client.createStateBackup = vi
            .fn()
            .mockResolvedValueOnce(failedResult("Archive commit failed"))
            .mockRejectedValueOnce(new Error("connection lost"));
        client.replaceStateBackupPromptPolicy = vi
            .fn()
            .mockResolvedValueOnce(failedResult("Policy revision changed", "settings"))
            .mockRejectedValueOnce(new Error("connection lost"));
        const bridge = stateBridge();
        bridge.selectRememberedStateBackupDestination = vi.fn(async () => ({ status: "unavailable" }));
        const view = renderWithPresentation(createElement(StateResilienceWorkspace, { client, desktopBridge: bridge }), bridge);

        await screen.findByText("/profile/backups/backup.zip");
        fireEvent.click(screen.getByRole("button", { name: "Use last custom folder" }));
        await screen.findByText("The remembered folder is unavailable. Choose another folder or use the OAAM default.");

        fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }));
        await vi.waitFor(() => expect(bridge.pickStateBackupDestination).toHaveBeenCalledTimes(1));
        selectOption("Destination", "OAAM default backup folder");
        fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }));
        await vi.waitFor(() =>
            expect(screen.getByRole("combobox", { name: "Destination" }).textContent).toContain("/custom/backups"),
        );
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        await screen.findByText("The backup could not be reviewed.");
        expect(screen.getByText("Original detail: Custom destination was rejected")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("Custom destination was rejected");
        expect(screen.getByRole("combobox", { name: "Destination" }).textContent).toContain("OAAM default");

        fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }));
        await vi.waitFor(() =>
            expect(screen.getByRole("combobox", { name: "Destination" }).textContent).toContain("/custom/backups"),
        );
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        await screen.findByText("Backup review was interrupted.");
        expect(screen.getByRole("combobox", { name: "Destination" }).textContent).toContain("OAAM default");

        fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }));
        await vi.waitFor(() =>
            expect(screen.getByRole("combobox", { name: "Destination" }).textContent).toContain("/custom/backups"),
        );
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        await screen.findByRole("heading", { name: "Backup review" });
        selectOption("Archive encryption", "Strong password (AES-256)");
        expect(screen.queryByRole("heading", { name: "Backup review" })).toBeNull();
        expect(screen.getByRole("combobox", { name: "Destination" }).textContent).toContain("OAAM default");

        fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }));
        await vi.waitFor(() =>
            expect(screen.getByRole("combobox", { name: "Destination" }).textContent).toContain("/custom/backups"),
        );
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        await screen.findByRole("heading", { name: "Backup review" });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "secret" } });
        fireEvent.click(screen.getByRole("button", { name: "Create verified backup" }));
        await screen.findByText("The backup was not created.");
        expect(screen.getByText("Original detail: Archive commit failed")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("Archive commit failed");
        expect(screen.queryByRole("heading", { name: "Backup review" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Create verified backup" })).toBeNull();
        expect(client.createStateBackup).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
        await screen.findByRole("heading", { name: "Backup review" });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "secret" } });
        fireEvent.click(screen.getByRole("button", { name: "Create verified backup" }));
        await screen.findByText("The backup operation was interrupted.");
        expect(screen.queryByRole("button", { name: "Create verified backup" })).toBeNull();
        expect(screen.getByRole("button", { name: "Review backup" })).not.toBeNull();
        expect(client.createStateBackup).toHaveBeenCalledTimes(2);

        selectOption("Pre-destructive backup prompt", "Continue without the backup prompt");
        fireEvent.click(screen.getByRole("button", { name: "Save prompt preference" }));
        await screen.findByText("The prompt preference was not saved. Refresh before retrying.");
        expect(screen.getByText("Original detail: Policy revision changed")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("Policy revision changed");
        fireEvent.click(screen.getByRole("button", { name: "Save prompt preference" }));
        await screen.findByText("The prompt preference was not saved. Refresh before retrying.");
    });

    it("handles external restore inspection and activation failures without reusing consumed path authority", async () => {
        const client = stateClient();
        const successfulInspect = client.inspectStateRestore;
        let reviewSequence = 0;
        client.inspectStateRestore = vi
            .fn()
            .mockResolvedValueOnce(failedResult("Archive password was rejected", "restore"))
            .mockRejectedValueOnce(new Error("inspection transport failed"))
            .mockImplementation(async (...args: Parameters<typeof successfulInspect>) => {
                const result = await successfulInspect(...args);
                if (result.status !== "complete") throw new Error("inspection fixture is incomplete");
                return { ...result, value: { ...result.value, restoreReviewToken: `restore-review-${++reviewSequence}` } };
            });
        const successfulActivation = await stateClient().activateStateRestore(
            {
                restoreReviewToken: "fixture",
                userActionId: "00000000-0000-4000-8000-000000000009",
            },
            undefined,
        );
        if (successfulActivation.status !== "complete") throw new Error("activation fixture is incomplete");
        client.activateStateRestore = vi
            .fn()
            .mockResolvedValueOnce(failedResult("State activation was rejected", "restore"))
            .mockRejectedValueOnce(new Error("activation transport failed"))
            .mockResolvedValueOnce({
                ...successfulActivation,
                value: {
                    ...successfulActivation.value,
                    displacedState: { state: "none" },
                    restoredDesktopPreferences: false,
                },
            });
        const bridge = stateBridge();
        let archiveSequence = 0;
        bridge.pickStateRestoreArchive = vi.fn(async () => ({
            status: "selected",
            displayPath: "/external/backup.zip",
            localPathSelectionToken: `archive-token-${++archiveSequence}`,
        }));
        const view = renderWithPresentation(createElement(StateResilienceWorkspace, { client, desktopBridge: bridge }), bridge);

        await screen.findByText("/profile/backups/backup.zip");
        fireEvent.click(screen.getByRole("button", { name: "Choose another ZIP…" }));
        await screen.findByText("/external/backup.zip");
        fireEvent.change(screen.getByLabelText("Archive password, if required"), { target: { value: "password" } });
        fireEvent.click(screen.getByRole("button", { name: "Inspect backup" }));
        const restoreFailure = await screen.findByText("The selected archive is not a valid complete OAAM backup.");
        expect(restoreFailure.closest("section")?.getAttribute("aria-labelledby")).toBe("state-restore-title");
        expect(restoreFailure.closest(".workbench-notice")?.querySelectorAll(".workbench-notice")).toHaveLength(0);
        expect(screen.getByText("Original detail: Archive password was rejected")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("Archive password was rejected");
        expect(screen.queryByText("/external/backup.zip")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Choose another ZIP…" }));
        await screen.findByText("/external/backup.zip");
        expect((screen.getByLabelText("Archive password, if required") as HTMLInputElement).value).toBe("");
        fireEvent.click(screen.getByRole("button", { name: "Inspect backup" }));
        await screen.findByText("Backup inspection was interrupted.");
        expect(screen.queryByText("/external/backup.zip")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Choose another ZIP…" }));
        await screen.findByText("/external/backup.zip");
        expect((screen.getByLabelText("Archive password, if required") as HTMLInputElement).value).toBe("");
        fireEvent.change(screen.getByLabelText("Archive password, if required"), {
            target: { value: "first-activation-password" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Inspect backup" }));
        await screen.findByRole("heading", { name: "Restore review" });
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(screen.getByRole("button", { name: "Restore this complete backup" }));
        await screen.findByText("The backup was not activated. Select and inspect it again before restoring.");
        expect(screen.getByText("Original detail: State activation was rejected")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("State activation was rejected");
        expect(screen.queryByRole("heading", { name: "Restore review" })).toBeNull();
        expect(screen.queryByText("/external/backup.zip")).toBeNull();
        expect(screen.queryByText(/OAAM is restarting\./u)).toBeNull();
        expect((screen.getByRole("button", { name: "Choose another ZIP…" }) as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(screen.getByRole("button", { name: "Choose another ZIP…" }));
        await screen.findByText("/external/backup.zip");
        expect((screen.getByLabelText("Archive password, if required") as HTMLInputElement).value).toBe("");
        fireEvent.change(screen.getByLabelText("Archive password, if required"), {
            target: { value: "second-activation-password" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Inspect backup" }));
        await screen.findByRole("heading", { name: "Restore review" });
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(screen.getByRole("button", { name: "Restore this complete backup" }));
        await screen.findByText(
            "The restore connection ended before a confirmed result. Reopen OAAM and inspect recovery state.",
        );
        expect(screen.queryByRole("heading", { name: "Restore review" })).toBeNull();
        expect(screen.queryByText("/external/backup.zip")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Choose another ZIP…" }));
        await screen.findByText("/external/backup.zip");
        expect((screen.getByLabelText("Archive password, if required") as HTMLInputElement).value).toBe("");
        fireEvent.click(screen.getByRole("button", { name: "Inspect backup" }));
        await screen.findByRole("heading", { name: "Restore review" });
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(screen.getByRole("button", { name: "Restore this complete backup" }));
        await screen.findByText("Restored. Previous state: No prior OAAM state existed. OAAM is restarting.");
        expect(vi.mocked(client.inspectStateRestore).mock.calls.map(([params]) => params.source)).toEqual(
            [1, 2, 3, 4, 5].map((sequence) => ({
                sourceKind: "selected_archive",
                localPathSelectionToken: `archive-token-${sequence}`,
            })),
        );
        expect(vi.mocked(client.activateStateRestore).mock.calls.map(([params]) => params.restoreReviewToken)).toEqual([
            "restore-review-1",
            "restore-review-2",
            "restore-review-3",
        ]);
        expect(bridge.pickStateRestoreArchive).toHaveBeenCalledTimes(5);
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders selected-archive restore without touching backup inventory in recovery-only mode", () => {
        const client = stateClient();
        client.supportsOperation = vi.fn(
            (operation) => operation === "state_restore.inspect" || operation === "state_restore.activate",
        );
        const bridge = stateBridge();
        renderWithPresentation(
            createElement(StateResilienceWorkspace, { client, desktopBridge: bridge, recoveryOnly: true }),
            bridge,
        );

        expect(screen.getByText(/In recovery mode, OAAM can only inspect and restore/u)).not.toBeNull();
        expect(screen.getByRole("heading", { name: "Restore OAAM state" })).not.toBeNull();
        expect(screen.queryByRole("heading", { name: "Back up OAAM state" })).toBeNull();
        expect(screen.queryByRole("heading", { name: "Known backup files" })).toBeNull();
        expect(client.listStateBackups).not.toHaveBeenCalled();
        expect(client.getStateBackupPromptPolicy).not.toHaveBeenCalled();
    });

    it("reports finite file-manager failures and a failed policy load without claiming completion", async () => {
        const client = stateClient();
        const bridge = stateBridge();
        bridge.performStateBackupFileAction = vi
            .fn()
            .mockResolvedValueOnce({ status: "failed", code: "reveal_failed" })
            .mockRejectedValueOnce(new Error("clipboard unavailable"))
            .mockResolvedValueOnce({ status: "failed", code: "trash_failed" });
        const first = renderWithPresentation(createElement(StateResilienceWorkspace, { client, desktopBridge: bridge }), bridge);

        await screen.findByText("/profile/backups/backup.zip");
        fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
        await screen.findByText("The file manager could not reveal this backup. You can copy its path instead.");
        fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
        await screen.findByText("The file-manager action failed.");
        fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
        fireEvent.click(screen.getByRole("button", { name: "Move this backup to Trash" }));
        await screen.findByText(
            "OAAM could not confirm the final Trash state. Refresh the inventory; no permanent-delete fallback was used.",
        );
        first.unmount();

        const failedPolicy = stateClient();
        failedPolicy.getStateBackupPromptPolicy = vi.fn(async () => failedResult("Prompt policy unavailable", "settings"));
        const view = renderWithPresentation(
            createElement(StateResilienceWorkspace, { client: failedPolicy, desktopBridge: bridge }),
            bridge,
        );
        await screen.findByText("Backup and restore state could not be loaded.");
        expect(screen.getByText("Original detail: Prompt policy unavailable")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("Prompt policy unavailable");
    });
});
