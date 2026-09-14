import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { ProjectLifecycleController } from "../src/renderer/features/project-library";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);
const PROJECT = {
    projectId: PROJECT_ID,
    displayName: "OAAM",
    rootPath: "/work/oaam-next",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};
const DIAGNOSTIC = {
    severity: "error" as const,
    code: "fixture.failed",
    operation: "project" as const,
    causeKind: "conflict" as const,
    retryable: true,
    suggestedActions: ["retry"] as const,
    message: "fixture failure",
};
const ALL_OPERATIONS: ProtocolOperationName[] = [
    "project_lifecycle.inspect",
    "project_lifecycle.commit",
    "deployment.list",
    "state_backup.list",
    "state_backup_prompt_policy.get",
    "state_backup_prompt_policy.replace",
    "state_backup.inspect",
    "state_backup.create",
];

function renameReview() {
    return {
        schemaVersion: 1 as const,
        action: "rename" as const,
        projectLifecycleReviewToken: "rename-review",
        projectId: PROJECT_ID,
        projectAuthorityFingerprint: DIGEST,
        rootPath: "/work/oaam",
        currentDisplayName: "OAAM",
        nextDisplayName: "OAAM next",
    };
}

function rebindReview() {
    return {
        schemaVersion: 1 as const,
        action: "rebind" as const,
        projectLifecycleReviewToken: "rebind-review",
        projectId: PROJECT_ID,
        projectAuthorityFingerprint: DIGEST,
        displayName: "OAAM",
        currentRootPath: "/work/oaam",
        nextRootPath: "/work/oaam-next",
    };
}

function stopReview() {
    return {
        schemaVersion: 1 as const,
        action: "stop_managing" as const,
        projectLifecycleReviewToken: "stop-review",
        projectId: PROJECT_ID,
        projectAuthorityFingerprint: DIGEST,
        displayName: "OAAM",
        rootPath: "/work/oaam",
    };
}

function fakeClient(overrides: Partial<DesktopApplicationClientApi> = {}) {
    const client = {
        availableOperations: ALL_OPERATIONS,
        supportsOperation: vi.fn((operation: ProtocolOperationName) => ALL_OPERATIONS.includes(operation)),
        inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: renameReview(), diagnostics: [] })),
        commitProjectLifecycle: vi.fn(async () => ({ status: "complete", value: PROJECT, diagnostics: [] })),
        listDeployments: vi.fn(async () => ({
            status: "complete",
            value: {
                deployments: [
                    {
                        deploymentId: "22222222-2222-4222-8222-222222222222",
                        subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
                        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        environment: { platform: "linux" as const, platformInstanceId: "linux" },
                        targetRootPath: "/work/oaam",
                        stage: "in_sync" as const,
                        reason: "applied" as const,
                        actionHints: [],
                        freshness: { state: "complete" as const, attemptedAt: 1, lastCompleteAt: 1 },
                        deleted: false,
                        assets: [],
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            diagnostics: [],
        })),
        getStateBackupPromptPolicy: vi.fn(async () => ({
            status: "complete",
            value: {
                configVersion: 1 as const,
                settingId: "state_backup_prompt_policy_v1" as const,
                revision: 0 as const,
                mode: "ask_every_time" as const,
                updatedAt: 0 as const,
                settingFingerprint: DIGEST,
            },
            diagnostics: [],
        })),
        listStateBackups: vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1 as const,
                entries: [
                    {
                        schemaVersion: 1 as const,
                        backupId: "55555555-5555-4555-8555-555555555555",
                        createdAt: 3,
                        archiveDisplayPath: "/backups/older.zip",
                        archiveByteSize: 90,
                        archiveContentHash: DIGEST,
                        manifestFingerprint: DIGEST,
                        sourceSnapshotFingerprint: DIGEST,
                        encryptionMode: "none" as const,
                        destinationKind: "oaam_default" as const,
                        observation: "available" as const,
                    },
                    {
                        schemaVersion: 1 as const,
                        backupId: "33333333-3333-4333-8333-333333333333",
                        createdAt: 5,
                        archiveDisplayPath: "/backups/latest.zip",
                        archiveByteSize: 100,
                        archiveContentHash: DIGEST,
                        manifestFingerprint: DIGEST,
                        sourceSnapshotFingerprint: DIGEST,
                        encryptionMode: "none" as const,
                        destinationKind: "oaam_default" as const,
                        observation: "available" as const,
                    },
                ],
                totalKnownArchiveBytes: 100,
                totalAvailableArchiveBytes: 100,
            },
            diagnostics: [],
        })),
        inspectStateBackup: vi.fn(async () => ({
            status: "complete",
            value: {
                backupReviewToken: "backup-review",
                backupId: "44444444-4444-4444-8444-444444444444",
                createdAt: 6,
                destinationKind: "oaam_default" as const,
                destinationDisplayPath: "/backups",
                destinationState: "ready" as const,
                outputFileName: "backup.zip",
                encryptionMode: "none" as const,
                sourceFileCount: 3,
                sourceLogicalBytes: 10,
                requiredAvailableBytes: 20,
                availableBytes: 1_000,
                sourceSnapshotFingerprint: DIGEST,
            },
            diagnostics: [],
        })),
        createStateBackup: vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1 as const,
                backupId: "44444444-4444-4444-8444-444444444444",
                createdAt: 6,
                archiveDisplayPath: "/backups/backup.zip",
                archiveByteSize: 80,
                archiveContentHash: DIGEST,
                manifestFingerprint: DIGEST,
                sourceSnapshotFingerprint: DIGEST,
                encryptionMode: "none" as const,
            },
            diagnostics: [],
        })),
        replaceStateBackupPromptPolicy: vi.fn(async () => ({
            status: "complete",
            value: {
                configVersion: 1 as const,
                settingId: "state_backup_prompt_policy_v1" as const,
                revision: 1,
                mode: "back_up_first" as const,
                userActionEvidenceId: "action",
                updatedAt: 1,
                settingFingerprint: DIGEST,
            },
            diagnostics: [],
        })),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
    return client;
}

describe("Project lifecycle Desktop controller", () => {
    it("commits rename without invoking the destructive backup gate", async () => {
        const client = fakeClient();
        const controller = new ProjectLifecycleController(client);
        controller.subscribe(() => undefined);
        await controller.inspect({ action: "rename", projectId: PROJECT_ID, nextDisplayName: "OAAM next" });
        expect(controller.state).toMatchObject({ status: "review", context: { review: { action: "rename" } } });
        await controller.commit();
        expect(controller.state).toMatchObject({ status: "succeeded", project: PROJECT });
        expect(client.listStateBackups).not.toHaveBeenCalled();
        expect(client.commitProjectLifecycle).toHaveBeenCalledWith({
            projectLifecycleReviewToken: "rename-review",
            userActionId: expect.any(String),
        });
    });

    it("shows retained Deployment roots and backs up before rebind while remembering the choice", async () => {
        const client = fakeClient({
            inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: rebindReview(), diagnostics: [] })),
        });
        const controller = new ProjectLifecycleController(client);
        controller.subscribe(() => undefined);
        await controller.inspect({
            action: "rebind",
            projectId: PROJECT_ID,
            localPathSelectionToken: "selection",
        });
        expect(controller.state).toMatchObject({
            status: "review",
            context: {
                review: { action: "rebind" },
                deployments: [{ targetRootPath: "/work/oaam" }],
                latestBackup: { archiveDisplayPath: "/backups/latest.zip" },
            },
        });
        expect(client.listDeployments).toHaveBeenCalledWith({
            subject: { subjectKind: "project", projectId: PROJECT_ID },
        });
        await controller.commit("back_up_then_continue", true);
        expect(client.inspectStateBackup).toHaveBeenCalledWith({
            destination: { destinationKind: "oaam_default" },
            encryptionMode: "none",
        });
        expect(client.createStateBackup).toHaveBeenCalledWith({
            backupReviewToken: "backup-review",
            userActionId: expect.any(String),
        });
        expect(client.replaceStateBackupPromptPolicy).toHaveBeenCalledWith({
            expectedRevision: 0,
            expectedSettingFingerprint: DIGEST,
            mode: "back_up_first",
            userActionId: expect.any(String),
        });
        expect(controller.state.status).toBe("succeeded");
    });

    it("honors a saved continue policy for stop-managing without silently creating a backup", async () => {
        const client = fakeClient({
            inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: stopReview(), diagnostics: [] })),
            getStateBackupPromptPolicy: vi.fn(async () => ({
                status: "complete",
                value: {
                    configVersion: 1,
                    settingId: "state_backup_prompt_policy_v1",
                    revision: 1,
                    mode: "continue_without_prompt",
                    userActionEvidenceId: "action",
                    updatedAt: 1,
                    settingFingerprint: DIGEST,
                },
                diagnostics: [],
            })),
        });
        const controller = new ProjectLifecycleController(client);
        controller.subscribe(() => undefined);
        await controller.inspect({ action: "stop_managing", projectId: PROJECT_ID });
        await controller.commit();
        expect(controller.state.status).toBe("succeeded");
        expect(client.inspectStateBackup).not.toHaveBeenCalled();
        expect(client.replaceStateBackupPromptPolicy).not.toHaveBeenCalled();
    });

    it("fails closed for missing operations and every pre-commit gate failure", async () => {
        const unsupported = fakeClient();
        unsupported.supportsOperation = vi.fn(() => false);
        const unsupportedController = new ProjectLifecycleController(unsupported);
        await unsupportedController.inspect({ action: "rename", projectId: PROJECT_ID, nextDisplayName: "Next" });
        expect(unsupportedController.state.status).toBe("failed");

        const noDeploymentRead = fakeClient({
            supportsOperation: vi.fn((operation) => operation !== "deployment.list"),
            inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: rebindReview(), diagnostics: [] })),
        });
        const noDeploymentReadController = new ProjectLifecycleController(noDeploymentRead);
        await noDeploymentReadController.inspect({
            action: "rebind",
            projectId: PROJECT_ID,
            localPathSelectionToken: "selection",
        });
        expect(noDeploymentReadController.state.status).toBe("failed");
        expect(noDeploymentRead.listDeployments).not.toHaveBeenCalled();

        const noBackupGate = fakeClient({
            supportsOperation: vi.fn((operation) => operation !== "state_backup.create"),
            inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: stopReview(), diagnostics: [] })),
        });
        const noBackupGateController = new ProjectLifecycleController(noBackupGate);
        await noBackupGateController.inspect({ action: "stop_managing", projectId: PROJECT_ID });
        expect(noBackupGateController.state.status).toBe("failed");
        expect(noBackupGate.getStateBackupPromptPolicy).not.toHaveBeenCalled();

        for (const overrides of [
            { inspectProjectLifecycle: vi.fn(async () => ({ status: "failed", diagnostics: [DIAGNOSTIC] })) },
            {
                inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: rebindReview(), diagnostics: [] })),
                listDeployments: vi.fn(async () => ({ status: "failed", diagnostics: [DIAGNOSTIC] })),
            },
            {
                inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: stopReview(), diagnostics: [] })),
                getStateBackupPromptPolicy: vi.fn(async () => ({ status: "failed", diagnostics: [DIAGNOSTIC] })),
            },
            {
                inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: stopReview(), diagnostics: [] })),
                listStateBackups: vi.fn(async () => ({ status: "failed", diagnostics: [DIAGNOSTIC] })),
            },
        ] satisfies Partial<DesktopApplicationClientApi>[]) {
            const controller = new ProjectLifecycleController(fakeClient(overrides));
            await controller.inspect(
                "listDeployments" in overrides
                    ? { action: "rebind", projectId: PROJECT_ID, localPathSelectionToken: "selection" }
                    : "inspectProjectLifecycle" in overrides &&
                        overrides.inspectProjectLifecycle !== undefined &&
                        overrides.inspectProjectLifecycle ===
                            (overrides as { inspectProjectLifecycle?: unknown }).inspectProjectLifecycle
                      ? { action: "stop_managing", projectId: PROJECT_ID }
                      : { action: "rename", projectId: PROJECT_ID, nextDisplayName: "Next" },
            );
            expect(controller.state.status).toBe("failed");
        }
    });

    it("keeps the exact lifecycle review retryable when backup, policy, or commit fails", async () => {
        const failureOverrides: Partial<DesktopApplicationClientApi>[] = [
            { inspectStateBackup: vi.fn(async () => ({ status: "failed", diagnostics: [DIAGNOSTIC] })) },
            { createStateBackup: vi.fn(async () => ({ status: "failed", diagnostics: [DIAGNOSTIC] })) },
            { replaceStateBackupPromptPolicy: vi.fn(async () => ({ status: "failed", diagnostics: [DIAGNOSTIC] })) },
            { commitProjectLifecycle: vi.fn(async () => ({ status: "failed", diagnostics: [DIAGNOSTIC] })) },
            {
                commitProjectLifecycle: vi.fn(async () => {
                    throw new Error("offline");
                }),
            },
        ];
        for (const overrides of failureOverrides) {
            const client = fakeClient({
                inspectProjectLifecycle: vi.fn(async () => ({ status: "complete", value: stopReview(), diagnostics: [] })),
                ...overrides,
            });
            const controller = new ProjectLifecycleController(client);
            await controller.inspect({ action: "stop_managing", projectId: PROJECT_ID });
            await controller.commit("back_up_then_continue", true);
            expect(controller.state).toMatchObject({
                status: "review",
                context: { review: { projectLifecycleReviewToken: "stop-review" } },
                busyStage: undefined,
            });
        }
    });

    it("invalidates interrupted or closed work and refuses to close a busy review", async () => {
        let releaseInspect: (() => void) | undefined;
        const client = fakeClient({
            inspectProjectLifecycle: vi.fn(
                () =>
                    new Promise((resolve) => {
                        releaseInspect = () => resolve({ status: "complete", value: renameReview(), diagnostics: [] });
                    }),
            ),
        });
        const controller = new ProjectLifecycleController(client);
        const inspection = controller.inspect({ action: "rename", projectId: PROJECT_ID, nextDisplayName: "Next" });
        controller.close();
        releaseInspect?.();
        await inspection;
        expect(controller.state.status).toBe("idle");

        const retry = new ProjectLifecycleController(
            fakeClient({
                inspectProjectLifecycle: vi.fn(async () => {
                    throw new Error("offline");
                }),
            }),
        );
        await retry.inspect({ action: "rename", projectId: PROJECT_ID, nextDisplayName: "Next" });
        expect(retry.state.status).toBe("failed");
        retry.close();
        expect(retry.state.status).toBe("idle");
        retry.dispose();
    });
});
