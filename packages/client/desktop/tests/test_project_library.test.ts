import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ordinarySurfaceText, renderWithPresentation } from "./desktop-presentation-test-harness";
import {
    ASSET,
    ASSET_ID,
    completedBridge,
    DIGEST,
    expandProjectLibraryKind as expandKind,
    fakeClient,
    GLOBAL_ASSET,
    PROJECT,
    PROJECT_ID,
    ProjectLibraryTestHarness,
    SECOND_ASSET,
    SECOND_PROJECT,
    SECOND_PROJECT_ID,
    VERSION_ID,
} from "./project-library-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";
import { exercisePersistentInteractionSidebar } from "./desktop-interaction-test-harness";

afterEach(cleanup);

describe("Project-first Desktop library", () => {
    it("keeps retained Projects out of the active Project workspace", async () => {
        const retained = { ...SECOND_PROJECT, deleted: true, rootPath: "/work/missing-project" };
        const fixture = fakeClient([PROJECT, retained], [ASSET, SECOND_ASSET, GLOBAL_ASSET]);
        const operations = fixture.client.availableOperations as ProtocolOperationName[];
        operations.push("project_lifecycle.inspect", "project_lifecycle.commit");
        fixture.client.inspectProjectLifecycle = vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                action: "restore",
                projectLifecycleReviewToken: "restore-review",
                projectId: SECOND_PROJECT_ID,
                projectAuthorityFingerprint: DIGEST,
                displayName: SECOND_PROJECT.displayName,
                rootPath: retained.rootPath,
                rootAccessState: "unavailable",
            },
            diagnostics: [],
        }));
        fixture.client.commitProjectLifecycle = vi.fn(async () => ({
            status: "complete",
            value: { ...retained, deleted: false, updatedAt: 3 },
            diagnostics: [],
        }));
        const view = renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 3,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );

        await screen.findByRole("button", { name: /^OAAM/u });
        exercisePersistentInteractionSidebar("features.project-library.project_library_workspace.001", view.container);
        expect(screen.queryByText("Stopped Projects (1)")).toBeNull();
        expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
        expect(fixture.client.inspectProjectLifecycle).not.toHaveBeenCalled();
    }, 10_000);

    it("reviews retained Deployment targets and applies the Phase 47 backup choice before rebind", async () => {
        const fixture = fakeClient();
        const operations = fixture.client.availableOperations as ProtocolOperationName[];
        operations.push(
            "project_lifecycle.inspect",
            "project_lifecycle.commit",
            "state_backup.list",
            "state_backup_prompt_policy.get",
            "state_backup_prompt_policy.replace",
            "state_backup.inspect",
            "state_backup.create",
        );
        fixture.client.inspectProjectLifecycle = vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                action: "rebind",
                projectLifecycleReviewToken: "rebind-review",
                projectId: PROJECT_ID,
                projectAuthorityFingerprint: DIGEST,
                displayName: PROJECT.displayName,
                currentRootPath: PROJECT.rootPath,
                nextRootPath: "/work/rebound",
            },
            diagnostics: [],
        }));
        fixture.client.listDeployments = vi.fn(async () => ({
            status: "complete",
            value: {
                deployments: [
                    {
                        deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        subject: { subjectKind: "project", projectId: PROJECT_ID },
                        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        environment: { platform: "linux", platformInstanceId: "linux" },
                        targetRootPath: PROJECT.rootPath,
                        stage: "in_sync",
                        reason: "applied",
                        actionHints: [],
                        freshness: { state: "complete", attemptedAt: 1, lastCompleteAt: 1 },
                        deleted: false,
                        assets: [],
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            diagnostics: [],
        }));
        fixture.client.getStateBackupPromptPolicy = vi.fn(async () => ({
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
        }));
        fixture.client.listStateBackups = vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                entries: [
                    {
                        schemaVersion: 1,
                        backupId: "33333333-3333-4333-8333-333333333333",
                        createdAt: 5,
                        archiveDisplayPath: "/backups/latest.zip",
                        archiveByteSize: 100,
                        archiveContentHash: DIGEST,
                        manifestFingerprint: DIGEST,
                        sourceSnapshotFingerprint: DIGEST,
                        encryptionMode: "none",
                        destinationKind: "oaam_default",
                        observation: "available",
                    },
                ],
                totalKnownArchiveBytes: 100,
                totalAvailableArchiveBytes: 100,
            },
            diagnostics: [],
        }));
        fixture.client.inspectStateBackup = vi.fn(async () => ({
            status: "complete",
            value: {
                backupReviewToken: "backup-review",
                backupId: "44444444-4444-4444-8444-444444444444",
                createdAt: 6,
                destinationKind: "oaam_default",
                destinationDisplayPath: "/backups",
                destinationState: "ready",
                outputFileName: "backup.zip",
                encryptionMode: "none",
                sourceFileCount: 3,
                sourceLogicalBytes: 10,
                requiredAvailableBytes: 20,
                availableBytes: 1_000,
                sourceSnapshotFingerprint: DIGEST,
            },
            diagnostics: [],
        }));
        fixture.client.createStateBackup = vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                backupId: "44444444-4444-4444-8444-444444444444",
                createdAt: 6,
                archiveDisplayPath: "/backups/backup.zip",
                archiveByteSize: 80,
                archiveContentHash: DIGEST,
                manifestFingerprint: DIGEST,
                sourceSnapshotFingerprint: DIGEST,
                encryptionMode: "none",
            },
            diagnostics: [],
        }));
        fixture.client.replaceStateBackupPromptPolicy = vi.fn(async () => ({
            status: "complete",
            value: {
                configVersion: 1,
                settingId: "state_backup_prompt_policy_v1",
                revision: 1,
                mode: "back_up_first",
                userActionEvidenceId: "action",
                updatedAt: 1,
                settingFingerprint: DIGEST,
            },
            diagnostics: [],
        }));
        fixture.client.commitProjectLifecycle = vi.fn(async () => ({
            status: "complete",
            value: { ...PROJECT, rootPath: "/work/rebound", updatedAt: 3 },
            diagnostics: [],
        }));
        const pickProjectRoot = vi
            .fn()
            .mockResolvedValueOnce({ status: "selected", localPathSelectionToken: "rebind-selection" })
            .mockResolvedValueOnce({ status: "cancelled" })
            .mockRejectedValueOnce(new Error("picker interrupted"))
            .mockResolvedValueOnce({ status: "selected", localPathSelectionToken: "retry-selection" });
        const onOpenDeployments = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot,
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments,
            }),
            completedBridge(),
        );

        await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Manage OAAM" })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Manage OAAM" }));
        fireEvent.click(screen.getByRole("button", { name: "Choose new root and review" }));
        await vi.waitFor(() => expect(screen.queryByText("/work/rebound")).not.toBeNull());
        expect(screen.getByText("1 retained Deployment target(s)")).not.toBeNull();
        expect(screen.getByText(/\/backups\/latest\.zip/u)).not.toBeNull();
        const rememberChoice = screen.getByRole("switch", { name: "Remember this choice and do not ask next time" });
        fireEvent.click(rememberChoice);
        fireEvent.click(rememberChoice);
        fireEvent.click(screen.getByRole("button", { name: "Back up, then continue" }));
        await vi.waitFor(() => expect(screen.queryByText(/existing Deployment target\(s\) were retained/u)).not.toBeNull());
        expect(fixture.client.inspectStateBackup).toHaveBeenCalledWith({
            destination: { destinationKind: "oaam_default" },
            encryptionMode: "none",
        });
        expect(fixture.client.createStateBackup).toHaveBeenCalledWith({
            backupReviewToken: "backup-review",
            userActionId: expect.any(String),
        });
        expect(fixture.client.replaceStateBackupPromptPolicy).toHaveBeenCalledWith({
            expectedRevision: 0,
            expectedSettingFingerprint: DIGEST,
            mode: "back_up_first",
            userActionId: expect.any(String),
        });
        expect(fixture.client.commitProjectLifecycle).toHaveBeenCalledWith({
            projectLifecycleReviewToken: "rebind-review",
            userActionId: expect.any(String),
        });
        await clickSemanticAction("library.deployments.retained_notice", "library.open_deployments", {
            expected: onOpenDeployments,
            expectedArgs: [{ subjectKind: "project", projectId: PROJECT_ID }],
            unrelated: [],
            root: screen.getAllByRole("button", { name: "Manage tool locations" }).at(-1) as HTMLButtonElement,
        });

        fireEvent.click(screen.getByRole("button", { name: "Manage OAAM" }));
        fireEvent.click(screen.getByRole("button", { name: "Choose new root and review" }));
        await vi.waitFor(() => expect(pickProjectRoot).toHaveBeenCalledTimes(2));
        fireEvent.click(screen.getByRole("button", { name: "Choose new root and review" }));
        await vi.waitFor(() => expect(screen.queryByText("The Project-root picker was interrupted.")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Choose new root and review" }));
        await vi.waitFor(() => expect(screen.queryByText("1 retained Deployment target(s)")).not.toBeNull());
        fireEvent.click(screen.getByRole("switch", { name: "Remember this choice and do not ask next time" }));
        fireEvent.click(screen.getByRole("button", { name: "Continue without backup" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(fixture.client.commitProjectLifecycle).toHaveBeenCalledTimes(2);
        expect(fixture.client.replaceStateBackupPromptPolicy).toHaveBeenCalledTimes(1);
    });

    it("renames and stops managing through exact reviews without deleting retained catalog relations", async () => {
        const fixture = fakeClient();
        const operations = fixture.client.availableOperations as ProtocolOperationName[];
        operations.push(
            "project_lifecycle.inspect",
            "project_lifecycle.commit",
            "state_backup.list",
            "state_backup_prompt_policy.get",
            "state_backup_prompt_policy.replace",
            "state_backup.inspect",
            "state_backup.create",
        );
        let requestedAction: "rename" | "stop_managing" = "rename";
        fixture.client.inspectProjectLifecycle = vi.fn(async (params) => {
            requestedAction = params.action as "rename" | "stop_managing";
            return requestedAction === "rename"
                ? {
                      status: "complete" as const,
                      value: {
                          schemaVersion: 1 as const,
                          action: "rename" as const,
                          projectLifecycleReviewToken: "rename-review",
                          projectId: PROJECT_ID,
                          projectAuthorityFingerprint: DIGEST,
                          rootPath: PROJECT.rootPath,
                          currentDisplayName: PROJECT.displayName,
                          nextDisplayName: "Portable OAAM",
                      },
                      diagnostics: [],
                  }
                : {
                      status: "complete" as const,
                      value: {
                          schemaVersion: 1 as const,
                          action: "stop_managing" as const,
                          projectLifecycleReviewToken: "stop-review",
                          projectId: PROJECT_ID,
                          projectAuthorityFingerprint: DIGEST,
                          displayName: "Portable OAAM",
                          rootPath: PROJECT.rootPath,
                      },
                      diagnostics: [],
                  };
        });
        fixture.client.getStateBackupPromptPolicy = vi.fn(async () => ({
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
        }));
        fixture.client.listStateBackups = vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                entries: [],
                totalKnownArchiveBytes: 0,
                totalAvailableArchiveBytes: 0,
            },
            diagnostics: [],
        }));
        fixture.client.commitProjectLifecycle = vi.fn(async () => ({
            status: "complete",
            value:
                requestedAction === "rename"
                    ? { ...PROJECT, displayName: "Portable OAAM", updatedAt: 3 }
                    : { ...PROJECT, displayName: "Portable OAAM", deleted: true, updatedAt: 4 },
            diagnostics: [],
        }));
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );

        await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Manage OAAM" })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Manage OAAM" }));
        fireEvent.click(screen.getByRole("button", { name: "Close Project management" }));
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Manage OAAM" }));
        fireEvent.change(screen.getByLabelText("Project display name"), { target: { value: "Portable OAAM" } });
        fireEvent.click(screen.getByRole("button", { name: "Review rename" }));
        await vi.waitFor(() => expect(screen.queryByText("Review: Rename Project")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Confirm exact Project change" }));
        await vi.waitFor(() => expect(screen.queryByRole("button", { name: /^Portable OAAM/u })).not.toBeNull());

        const manageProject = screen.getByRole("button", { name: "Manage Portable OAAM" });
        expect(manageProject.getAttribute("data-tooltip")).toBe("More actions");
        fireEvent.click(manageProject);
        fireEvent.click(screen.getByRole("button", { name: "Review stop managing" }));
        await vi.waitFor(() => expect(screen.queryByText(/does not delete the Project folder/u)).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Confirm exact Project change" }));
        await screen.findByRole("heading", { name: "Start with a Project" });
        expect(screen.queryByText("Stopped Projects (1)")).toBeNull();
        expect(screen.queryByText("Portable OAAM")).toBeNull();
        expect(fixture.client.inspectStateBackup).not.toHaveBeenCalled();
        expect(fixture.client.commitProjectLifecycle).toHaveBeenLastCalledWith({
            projectLifecycleReviewToken: "stop-review",
            userActionId: expect.any(String),
        });
    });

    it("browses Project and Global metadata and opens Deployment for the exact visible subject", async () => {
        const fixture = fakeClient();
        fixture.client.updateAssetDisplay = vi.fn(async ({ displayName, displayDescription }) => ({
            status: "complete",
            value: {
                ...ASSET,
                versionIds: [VERSION_ID],
                displayName,
                displayDescription,
                updatedAt: 3,
            },
            diagnostics: [],
        }));
        const bridge = completedBridge();
        const onOpenDeployments = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments,
            }),
            bridge,
        );
        await vi.waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: PROJECT.displayName })).not.toBeNull());
        await vi.waitFor(() =>
            expect(document.querySelector(".asset-tree-project-label")?.textContent).toBe(`${PROJECT.displayName}1`),
        );
        expect(screen.queryByRole("button", { name: "Choose where to use" })).toBeNull();
        expect(screen.queryByRole("button", { name: /^All assets/iu })).toBeNull();
        expect(screen.queryByRole("searchbox", { name: "Search loaded Assets" })).toBeNull();
        await vi.waitFor(() => expect(screen.queryAllByRole("button", { name: /^Guidance/u }).length).toBeGreaterThan(0));
        expect(screen.queryByText("Global guidance")).toBeNull();
        expandKind("Guidance", 0);
        await vi.waitFor(() => expect(screen.queryByText("Project guidance")).not.toBeNull());
        const projectAssetRow = document.querySelector(`[data-oaam-asset-id="${ASSET_ID}"]`);
        expect(projectAssetRow).not.toBeNull();
        await clickSemanticAction("library.asset_deployment.row", "library.open_asset_deployment", {
            expected: onOpenDeployments,
            expectedArgs: [{ subjectKind: "project", projectId: PROJECT_ID }, ASSET_ID],
            unrelated: [],
            root: within(projectAssetRow as HTMLElement).getByRole("button", { name: "Choose where to use" }),
        });
        fireEvent.click(within(projectAssetRow as HTMLElement).getByRole("button", { name: "Edit name and description" }));
        await screen.findByLabelText("Display name");
        expect(document.querySelector(".asset-action-form")?.getAttribute("data-oaam-action-attention")).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        fireEvent.click(
            within(document.querySelector(`[data-oaam-asset-id="${ASSET_ID}"]`) as HTMLElement).getByRole("button", {
                name: /Project guidance/u,
            }),
        );
        await vi.waitFor(() =>
            expect(document.querySelector('[data-oaam-semantic-entry="library.asset_deployment.inspector"]')).not.toBeNull(),
        );
        await clickSemanticAction("library.asset_deployment.inspector", "library.open_asset_deployment", {
            expected: onOpenDeployments,
            expectedArgs: [{ subjectKind: "project", projectId: PROJECT_ID }, ASSET_ID],
            unrelated: [],
        });
        await vi.waitFor(() => expect(screen.queryByRole("heading", { name: "Files" })).not.toBeNull());
        expect(screen.getByText("AGENTS.md")).not.toBeNull();
        expect(fixture.client.getAsset).toHaveBeenCalledWith({ assetId: ASSET_ID });
        expect(fixture.client.listAssetVersions).toHaveBeenCalledWith({ assetId: ASSET_ID, pageSize: 50 });
        expect(fixture.client.listAssetVersionFileChildren).toHaveBeenCalledWith({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            directoryPath: "",
            pageSize: 50,
        });
        const countsBeforeMetadataChange = (fixture.client.listAssetKindCounts as ReturnType<typeof vi.fn>).mock.calls.length;
        const assetActions = document.querySelector(".asset-action-section");
        expect(assetActions).not.toBeNull();
        fireEvent.click(within(assetActions as HTMLElement).getByRole("button", { name: "Edit name and description" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(fixture.client.updateAssetDisplay).toHaveBeenCalled());
        await vi.waitFor(() =>
            expect((fixture.client.listAssetKindCounts as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
                countsBeforeMetadataChange,
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: /Show Assets in the OAAM Recycle Bin/u }));

        fireEvent.click(screen.getByRole("tab", { name: "Global" }));
        expect(screen.getByRole("heading", { level: 1, name: "Global assets" })).not.toBeNull();
        expect(screen.queryByRole("searchbox", { name: "Search loaded Assets" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Choose where to use" })).toBeNull();
        expect(screen.queryByText("Project guidance")).toBeNull();
        await vi.waitFor(() =>
            expect(
                within(screen.getByRole("navigation", { name: "Asset library" })).queryAllByRole("button", {
                    name: /^Guidance/u,
                }).length,
            ).toBeGreaterThan(0),
        );
        expandKind("Guidance");
        await vi.waitFor(() => expect(screen.queryByText("Global guidance")).not.toBeNull());
        expect(screen.getByText("Global guidance")).not.toBeNull();
        expect(await screen.findByText("Claude Code")).not.toBeNull();
        expect(screen.getByText("Can write to")).not.toBeNull();
        (fixture.client.listAssetVersionFileChildren as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            status: "complete",
            value: {
                found: true,
                value: { entries: [], totalCount: 0, hasMore: false },
            },
            diagnostics: [],
        });
        fireEvent.click(screen.getByRole("button", { name: /Global guidance/u }));
        fireEvent.click(await screen.findByRole("button", { name: "Choose where to use" }));
        expect(onOpenDeployments).toHaveBeenLastCalledWith({ subjectKind: "global" }, "44444444-4444-4444-8444-444444444444");
        await vi.waitFor(() => expect(screen.queryByText("This Version contains no files.")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        expect(fixture.client.listAssets).not.toHaveBeenCalled();
        expect(fixture.client.listAssetKindCounts).toHaveBeenCalled();
    });

    it("uses the same bounded empty-state structure for an empty Global library without inventing an add action", async () => {
        const fixture = fakeClient([], []);
        const startGuidedImport = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 0,
                catalogWarningCount: 0,
                onOpenGuidedImport: startGuidedImport,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );
        await screen.findByRole("heading", { level: 2, name: "Start with a Project" });

        fireEvent.click(screen.getByRole("tab", { name: "Global" }));

        expect(await screen.findByRole("heading", { level: 2, name: "The Global asset library is empty" })).not.toBeNull();
        expect(screen.getByRole("heading", { level: 1, name: "Global assets" })).not.toBeNull();
        expect(document.querySelectorAll(".library-empty-state")).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Add Project" })).toBeNull();
        expect(screen.getAllByRole("button", { name: "Import from existing tools" })).toHaveLength(1);
        expect(screen.getByRole("button", { name: /Show Assets in the OAAM Recycle Bin/u })).not.toBeNull();
        const globalLabel = document.querySelector(".asset-tree-global-label");
        expect(globalLabel?.textContent).toBe("Global assets0");

        fireEvent.click(screen.getByRole("button", { name: "Import from existing tools" }));
        expect(startGuidedImport).toHaveBeenCalledOnce();
    });

    it("marks the loaded projection stale after an Asset invalidation instead of silently re-querying", async () => {
        const fixture = fakeClient();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );
        await vi.waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: PROJECT.displayName })).not.toBeNull());
        await vi.waitFor(() => expect(screen.queryAllByRole("button", { name: /^Guidance/u }).length).toBeGreaterThanOrEqual(1));
        expandKind("Guidance", 0);
        await vi.waitFor(() => expect(screen.queryByText("Project guidance")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: /Project guidance/u }));
        await vi.waitFor(() => expect(fixture.client.getAsset).toHaveBeenCalledOnce());
        act(() => fixture.invalidate({ resourceKind: "asset", assetId: ASSET_ID }));
        await vi.waitFor(() =>
            expect(screen.queryByText("The catalog changed. Refresh before relying on this view.")).not.toBeNull(),
        );
        expect(fixture.client.listAssets).not.toHaveBeenCalled();
        expect(fixture.client.getAsset).toHaveBeenCalledOnce();
    });

    it("surfaces Project diagnostics and clears the exact Asset route after a reviewed purge", async () => {
        const deletedAsset = { ...ASSET, displayName: "Retired guidance", deleted: true };
        const fixture = fakeClient([PROJECT], [deletedAsset, GLOBAL_ASSET]);
        const projectWarning = {
            severity: "warning" as const,
            code: "project.registry_partial",
            operation: "project",
            causeKind: "partial" as const,
            retryable: true,
            suggestedActions: ["retry"],
            message: "One Project registry source was unavailable.",
        };
        (fixture.client.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue({
            status: "complete",
            value: { projects: [PROJECT] },
            diagnostics: [projectWarning],
        });
        fixture.client.inspectAssetPurge = vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                action: "purge",
                assetId: ASSET_ID,
                assetManifestFingerprint: DIGEST,
                assetDirectoryIdentityFingerprint: "b".repeat(64),
                kind: deletedAsset.kind,
                scope: deletedAsset.scope,
                projectId: PROJECT_ID,
                scopePath: "",
                displayName: deletedAsset.displayName,
                versionCount: 3,
                promotionGrantCount: 0,
            },
            diagnostics: [],
        }));
        fixture.client.getStateBackupPromptPolicy = vi.fn(async () => ({
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
        }));
        fixture.client.listStateBackups = vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                entries: [],
                totalKnownArchiveBytes: 0,
                totalAvailableArchiveBytes: 0,
            },
            diagnostics: [],
        }));
        fixture.client.commitAssetPurge = vi.fn(async () => ({
            status: "complete",
            value: { assetId: ASSET_ID, recycled: true },
            diagnostics: [],
        }));
        const { container } = renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );

        await vi.waitFor(() =>
            expect(screen.queryByText("OAAM could not confirm every detail. Available files are still shown.")).not.toBeNull(),
        );
        expect(ordinarySurfaceText(container)).not.toContain(projectWarning.message);
        expect(screen.queryByText(`Original detail: ${projectWarning.message}`)).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /Show Assets in the OAAM Recycle Bin/u }));
        await vi.waitFor(() => expect(screen.queryAllByRole("button", { name: /^Guidance/u }).length).toBeGreaterThanOrEqual(1));
        expandKind("Guidance", 0);
        await vi.waitFor(() => expect(screen.queryByText(deletedAsset.displayName)).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: new RegExp(deletedAsset.displayName, "u") }));
        await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Permanent purge" })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.queryByText("Exact inventory: 3 Versions and 0 Promotion Grants.")).not.toBeNull());
        fireEvent.change(screen.getByLabelText(/Type the exact Asset display name/u), {
            target: { value: deletedAsset.displayName },
        });
        const countCallsBeforePurge = (fixture.client.listAssetKindCounts as ReturnType<typeof vi.fn>).mock.calls.length;
        fireEvent.click(screen.getByRole("button", { name: "Permanently purge from OAAM" }));

        await vi.waitFor(() => expect(fixture.client.commitAssetPurge).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
            expect((fixture.client.listAssetKindCounts as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
                countCallsBeforePurge,
            ),
        );
        await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Close Asset inspector" })).toBeNull());
    });

    it("uses one catalog search entry while preserving Asset pagination, Project registration, and rich inspector metadata", async () => {
        const fixture = fakeClient();
        const skills = Array.from({ length: 52 }, (_, index) => ({
            ...ASSET,
            assetId: `${String(index + 10).padStart(8, "0")}-0000-4000-8000-000000000000`,
            currentVersionId: `${String(index + 10).padStart(8, "0")}-0000-4000-9000-000000000000`,
            kind: "Skill" as const,
            displayName: `Skill ${String(index + 1).padStart(2, "0")}`,
            displayDescription: index === 0 ? "" : `Skill description ${index + 1}`,
            currentVersionStatus: index === 0 ? ("incomplete" as const) : ("complete" as const),
        }));
        const partialWarning = {
            severity: "warning" as const,
            code: "asset.partial",
            operation: "asset",
            causeKind: "partial" as const,
            retryable: true,
            suggestedActions: ["retry"],
            message: "One Asset source was unavailable.",
        };
        (fixture.client.listAssetKindCounts as ReturnType<typeof vi.fn>).mockImplementation(
            async ({
                subject,
                keywords,
            }: {
                subject: { scope: "global" } | { scope: "project"; projectId: string };
                keywords: string;
            }) => {
                const query = keywords.trim().toLocaleLowerCase("en-US");
                const source = subject.scope === "global" ? [GLOBAL_ASSET] : skills;
                const visible = source.filter(
                    (asset) =>
                        query === "" ||
                        asset.displayName.toLocaleLowerCase("en-US").includes(query) ||
                        asset.displayDescription.toLocaleLowerCase("en-US").includes(query),
                );
                return {
                    status: subject.scope === "project" ? "partial" : "complete",
                    value: {
                        counts: ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"].map((kind) => ({
                            kind,
                            count: visible.filter((asset) => asset.kind === kind).length,
                        })),
                    },
                    diagnostics: subject.scope === "project" ? [partialWarning] : [],
                };
            },
        );
        (fixture.client.queryAssetLibrary as ReturnType<typeof vi.fn>).mockImplementation(
            async ({
                subject,
                kind,
                keywords,
                pageSize = 50,
                cursor,
            }: {
                subject: { scope: "global" } | { scope: "project"; projectId: string };
                kind: string;
                keywords: string;
                pageSize?: number;
                cursor?: string;
            }) => {
                const query = keywords.trim().toLocaleLowerCase("en-US");
                const source = subject.scope === "global" ? [GLOBAL_ASSET] : skills;
                const matching = source.filter(
                    (asset) =>
                        asset.kind === kind &&
                        (query === "" ||
                            asset.displayName.toLocaleLowerCase("en-US").includes(query) ||
                            asset.displayDescription.toLocaleLowerCase("en-US").includes(query)),
                );
                const offset = cursor === undefined ? 0 : Number(cursor);
                const page = matching.slice(offset, offset + pageSize);
                const nextOffset = offset + page.length;
                return {
                    status: "complete",
                    value:
                        nextOffset < matching.length
                            ? { assets: page, totalCount: matching.length, hasMore: true, nextCursor: String(nextOffset) }
                            : { assets: page, totalCount: matching.length, hasMore: false },
                    diagnostics: [],
                };
            },
        );
        (fixture.client.getAsset as ReturnType<typeof vi.fn>).mockResolvedValue({
            status: "complete",
            value: { found: true, value: { ...skills[0], versionIds: [VERSION_ID, skills[0]?.currentVersionId] } },
            diagnostics: [],
        });
        (fixture.client.listAssetVersions as ReturnType<typeof vi.fn>).mockResolvedValue({
            status: "complete",
            value: {
                found: true,
                value: {
                    versions: [
                        {
                            assetId: skills[0]?.assetId,
                            versionId: skills[0]?.currentVersionId,
                            revision: 2,
                            status: "incomplete",
                            fingerprint: DIGEST,
                            originAuthorityFingerprint: DIGEST,
                            versionCanonicalContentFingerprint: DIGEST,
                            changeKind: "edit",
                            sourceVersionId: VERSION_ID,
                            sourceDeploymentId: "",
                            changeNote: "",
                            fileCount: 1,
                            createdAt: 2,
                        },
                        {
                            assetId: skills[0]?.assetId,
                            versionId: VERSION_ID,
                            revision: 1,
                            status: "complete",
                            fingerprint: DIGEST,
                            originAuthorityFingerprint: DIGEST,
                            versionCanonicalContentFingerprint: DIGEST,
                            changeKind: "create",
                            sourceVersionId: "",
                            sourceDeploymentId: "",
                            changeNote: "",
                            fileCount: 1,
                            createdAt: 1,
                        },
                    ],
                    totalCount: 2,
                    hasMore: false,
                },
            },
            diagnostics: [],
        });
        (fixture.client.listAssetVersionFileChildren as ReturnType<typeof vi.fn>).mockResolvedValue({
            status: "complete",
            value: {
                found: true,
                value: {
                    entries: [
                        {
                            entryKind: "file",
                            relativeName: "check.ts",
                            file: {
                                fileId: "66666666-6666-4666-8666-666666666666",
                                logicalPath: "scripts/check.ts",
                                role: "resource",
                                mediaType: "text/typescript",
                                contentKind: "text",
                                contentHash: DIGEST,
                                byteLength: 14,
                                executable: true,
                            },
                        },
                    ],
                    totalCount: 1,
                    hasMore: false,
                },
            },
            diagnostics: [],
        });
        (fixture.client.getWatchedScanIntent as ReturnType<typeof vi.fn>).mockResolvedValue({
            status: "complete",
            value: {
                configVersion: 1,
                settingId: "watched_scan_intent_v1",
                revision: 1,
                environments: [
                    {
                        environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                        sourceSelectors: [
                            {
                                disposition: "included",
                                source: {
                                    adapterId: "CLAUDECODE",
                                    rootRole: "source",
                                    sourceDomain: "project_root",
                                    canonicalPath: "/work/oaam/.claude",
                                    locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "project" }],
                                },
                                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                                binding: { assetScope: "project", projectId: PROJECT_ID },
                                selectorFingerprint: DIGEST,
                            },
                        ],
                    },
                ],
                userActionEvidenceId: "action-1",
                updatedAt: 1,
                settingFingerprint: DIGEST,
            },
            diagnostics: [],
        });
        (fixture.client.registerProject as ReturnType<typeof vi.fn>).mockResolvedValue({
            status: "complete",
            value: {
                ...PROJECT,
                projectId: "77777777-7777-4777-8777-777777777777",
                displayName: "Added Project",
                rootPath: "/work/added",
            },
            diagnostics: [],
        });
        const bridge = {
            ...completedBridge(),
            rememberLastProject: vi.fn(async () => {
                throw new Error("preferences unavailable");
            }),
            replaceAssetLayout: vi.fn(async () => {
                throw new Error("preferences unavailable");
            }),
        } satisfies OaamDesktopBridge;
        const onOpenSearch = vi.fn();
        const { container } = renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "selected", localPathSelectionToken: "token" }),
                assetCount: 53,
                catalogWarningCount: 1,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenSearch,
                onOpenDeployments: vi.fn(),
            }),
            bridge,
        );
        await vi.waitFor(() => expect(screen.queryAllByRole("button", { name: /^Skill/u }).length).toBeGreaterThan(0));
        expandKind("Skill");
        await vi.waitFor(() => expect(screen.queryByText("Skill 01")).not.toBeNull());
        expect(
            screen.getAllByText("OAAM could not confirm every detail. Available files are still shown.").length,
        ).toBeGreaterThan(0);
        expect(ordinarySurfaceText(container)).not.toContain(partialWarning.message);
        expect(screen.getAllByText(`Original detail: ${partialWarning.message}`).length).toBeGreaterThan(0);

        expect(screen.queryByRole("searchbox", { name: "Search loaded Projects" })).toBeNull();
        await clickSemanticAction("library.search.toolbar", "library.open_search", {
            expected: onOpenSearch,
            expectedArgs: [],
            unrelated: [],
        });
        fireEvent.click(screen.getByRole("button", { name: /^OAAM/u }));

        expect(screen.queryByRole("checkbox", { name: /WSL — Ubuntu/u })).toBeNull();
        expect(container.textContent).not.toContain("wsl:Ubuntu");
        expect(fixture.client.getWatchedScanIntent).not.toHaveBeenCalled();

        expect(screen.queryByRole("searchbox", { name: "Search loaded Assets" })).toBeNull();
        expandKind("Skill");
        await vi.waitFor(() => expect(screen.queryByText("Skill 01")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: /Show 2 more Skills? Assets/u }));
        await vi.waitFor(() => expect(screen.queryByText("Skill 52")).not.toBeNull());

        fireEvent.click(screen.getByRole("button", { name: "Cards" }));
        await vi.waitFor(() => expect(screen.queryByText(/Desktop preference was not saved/u)).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "List" }));
        await vi.waitFor(() => expect(bridge.replaceAssetLayout).toHaveBeenCalledWith("list"));
        fireEvent.click(screen.getByRole("button", { name: /Skill 01/u }));
        await vi.waitFor(() => expect(screen.queryByText("check.ts")).not.toBeNull());
        expect(screen.getByText(/Executable/u)).not.toBeNull();
        expect(screen.getByText(/current Version is incomplete/u)).not.toBeNull();
        const leftPane = screen.getByRole("separator", { name: "Left pane width" });
        const rightPane = screen.getByRole("separator", { name: "Right pane width" });
        fireEvent.keyDown(leftPane, { key: "Home" });
        fireEvent.keyDown(rightPane, { key: "End" });
        await vi.waitFor(() =>
            expect(bridge.replacePresentationPreferences).toHaveBeenLastCalledWith(
                expect.objectContaining({ leftPaneWidth: 224, rightPaneWidth: 440 }),
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        expect(screen.queryByText("check.ts")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Toggle Asset inspector" }));
        await vi.waitFor(() => expect(screen.queryByText("check.ts")).not.toBeNull());
        expect(screen.getByRole("separator", { name: "Right pane width" }).getAttribute("aria-valuenow")).toBe("440");
        expect(fixture.client.getAsset).toHaveBeenCalledTimes(2);

        const addProject = screen.getByRole("button", { name: "Add Project" });
        expect(addProject.querySelector("[data-oaam-icon='add']")).not.toBeNull();
        fireEvent.click(addProject);
        await vi.waitFor(() => expect(fixture.client.registerProject).toHaveBeenCalledWith({ localPathSelectionToken: "token" }));

        fireEvent.click(screen.getByRole("tab", { name: "Global" }));
        fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
        const selectedProject = screen.getByRole("button", { name: /^Added Project/u });
        expect(selectedProject.getAttribute("aria-current")).not.toBeNull();
        expect(selectedProject.querySelector("[data-oaam-icon='folder_open']")).not.toBeNull();
        const refresh = screen.getByRole("button", { name: "Refresh" });
        expect(refresh.querySelector("[data-oaam-icon='refresh']")).not.toBeNull();
        fireEvent.click(refresh);
        await vi.waitFor(() => expect(fixture.client.listProjects).toHaveBeenCalledTimes(2));
    }, 10_000);
});
