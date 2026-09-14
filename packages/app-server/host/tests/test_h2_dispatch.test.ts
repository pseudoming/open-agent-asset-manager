import { createProtocolRequest, type ProtocolNotificationV1 } from "@oaam/app-server-protocol";
import type { CoreResult, CoreService, ProjectManifestV1, WatchedScanIntentV1 } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import {
    H2_DIGEST as DIGEST,
    h2Deployment as deployment,
    h2Inspection as inspection,
    h2PreviewSnapshot as previewSnapshot,
    h2ProbeResult as probeResult,
    h2ReadResult as readResult,
    H2_SOURCE_ROOT_ID as SOURCE_ROOT_ID,
} from "./support/h2-review-fixtures";
import {
    ASSET_ID,
    fakeCoreWith,
    flushHost,
    host,
    initializeRequest,
    PROJECT_ID,
    recordingSink,
    required,
    VERSION_ID,
} from "./support/host-test-fixtures";

function complete<T>(value: T): CoreResult<T> {
    return { status: "complete", value, diagnostics: [] };
}

async function settle(): Promise<void> {
    await flushHost();
    await flushHost();
}

function terminal(sink: ReturnType<typeof recordingSink>, operation: string) {
    const notification = [...sink.messages]
        .reverse()
        .find(
            (message): message is ProtocolNotificationV1 =>
                "method" in message && message.method === "operation.terminal" && message.params.operation === operation,
        );
    expect(notification).toBeDefined();
    return (notification as Extract<ProtocolNotificationV1, { method: "operation.terminal" }>).params.outcome;
}

describe("H2 review-record Protocol dispatch", () => {
    it("runs probe → read → preview → bounded detail → batch accept with exact retained closures", async () => {
        const probe = probeResult();
        const read = readResult(probe);
        const snapshot = previewSnapshot(read);
        const getAvailablePlatformContexts = vi.fn(() =>
            complete([{ platform: "linux" as const, platformInstanceId: "local", accessRootPath: "/trusted" }]),
        );
        const probeAdapters = vi.fn(
            async (
                _input: Parameters<CoreService["probeAdapters"]>[0],
                observer?: Parameters<CoreService["probeAdapters"]>[1],
            ) => {
                observer?.({ stage: "provider_probe", completedUnits: 0, totalUnits: 1 });
                observer?.({
                    stage: "provider_probe",
                    completedUnits: 1,
                    totalUnits: 1,
                    adapterId: "CLAUDECODE",
                    platformContext: { platform: "linux", platformInstanceId: "local", accessRootPath: "/trusted" },
                    outcome: "complete",
                    elapsedMilliseconds: 125,
                });
                return complete([probe]);
            },
        );
        const readAssetsFromAdapter = vi.fn(async () => complete(read));
        const previewImport = vi.fn(() => complete(snapshot));
        const acceptImportBatch = vi.fn(async () =>
            complete({
                schemaVersion: 1 as const,
                items: [
                    {
                        status: "complete" as const,
                        candidateId: "candidate-1",
                        version: {
                            assetId: ASSET_ID as never,
                            versionId: VERSION_ID as never,
                        },
                        diagnostics: [],
                    },
                ],
            }),
        );
        const runtime = host(
            fakeCoreWith({
                getAvailablePlatformContexts,
                probeAdapters,
                readAssetsFromAdapter,
                previewImport,
                acceptImportBatch,
            }),
        );
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());

        connection.receive(
            createProtocolRequest("probe", "adapter.probe", {
                adapterIds: ["CLAUDECODE"],
                environments: [{ platform: "linux", platformInstanceId: "local" }],
                authorization: { scope: "global" },
            }),
        );
        await settle();
        expect(
            sink.messages
                .filter(
                    (message): message is Extract<ProtocolNotificationV1, { method: "operation.progress" }> =>
                        "method" in message && message.method === "operation.progress",
                )
                .map((message) => message.params.progress),
        ).toEqual([
            { stage: "provider_probe", completedUnits: 0, totalUnits: 1 },
            {
                stage: "provider_probe",
                completedUnits: 1,
                totalUnits: 1,
                adapterId: "CLAUDECODE",
                environment: { platform: "linux", platformInstanceId: "local" },
                outcome: "complete",
                elapsedMilliseconds: 125,
            },
        ]);
        const probeOutcome = terminal(sink, "adapter.probe");
        expect(probeOutcome).toMatchObject({ status: "complete" });
        const probeReview = (probeOutcome as { value: ReturnType<typeof Object> }).value as {
            probeToken: string;
            results: { rowId: string; sources: { rowId: string }[] }[];
        };
        expect(getAvailablePlatformContexts).toHaveBeenCalledWith(["linux"]);
        expect(probeAdapters).toHaveBeenCalledWith(
            {
                adapterIds: ["CLAUDECODE"],
                contexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/trusted" }],
                target: { authorizationScope: "global" },
            },
            expect.any(Function),
        );
        const probeRow = required(probeReview.results[0], "probe result row");
        const sourceRow = required(probeRow.sources[0], "source root row");

        connection.receive(
            createProtocolRequest("read", "adapter.read", {
                probeToken: probeReview.probeToken,
                selections: [
                    {
                        probeResultRowId: probeRow.rowId,
                        sourceRootRowIds: [sourceRow.rowId],
                        allowedKinds: ["Guidance"],
                        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    },
                ],
            }),
        );
        await settle();
        const readOutcome = terminal(sink, "adapter.read") as { status: string; value: { readToken: string } };
        expect(readOutcome.status).toBe("complete");
        expect(readAssetsFromAdapter).toHaveBeenCalledWith({
            adapterId: "CLAUDECODE",
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: probe.observation,
                sourceRootIds: [SOURCE_ROOT_ID],
            },
            allowedKinds: ["Guidance"],
            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
        });

        connection.receive(createProtocolRequest("preview", "import.preview", { readToken: readOutcome.value.readToken }));
        await settle();
        const previewOutcome = terminal(sink, "import.preview") as {
            status: string;
            value: {
                previewToken: string;
                snapshotFingerprint: string;
                candidates: { logicalPaths: string[]; logicalPathsTruncated: boolean }[];
            };
        };
        expect(previewOutcome.value.candidates[0]).toMatchObject({
            logicalPaths: ["AGENTS.md", "assets/data.bin"],
            logicalPathsTruncated: false,
        });
        const retainedReadResults = required(previewImport.mock.calls[0], "preview import call")[0];
        expect(retainedReadResults[0]?.candidates[0]?.files[1]).toMatchObject({
            bytes: new Uint8Array([1, 2, 3]),
        });

        connection.receive(
            createProtocolRequest("detail", "import_preview.detail", {
                previewToken: previewOutcome.value.previewToken,
                candidateId: "candidate-1",
                logicalPath: "AGENTS.md",
            }),
        );
        await settle();
        expect(sink.messages.at(-1)).toMatchObject({
            result: {
                status: "complete",
                value: {
                    logicalPath: "AGENTS.md",
                    text: { text: "# Guidance", truncated: false },
                },
            },
        });

        connection.receive(
            createProtocolRequest("accept", "import.accept_batch", {
                previewToken: previewOutcome.value.previewToken,
                expectedSnapshotFingerprint: previewOutcome.value.snapshotFingerprint,
                decisions: [
                    {
                        candidateId: "candidate-1",
                        action: "create_asset",
                        freshness: { freshnessAction: "require_current_source" },
                        promotion: { promotionAction: "import_only", userActionId: "user" },
                        callableBindings: [],
                    },
                ],
            }),
        );
        await settle();
        expect(terminal(sink, "import.accept_batch")).toMatchObject({
            status: "complete",
            value: { items: [{ candidateId: "candidate-1", status: "complete" }] },
        });
        const accepted = required(acceptImportBatch.mock.calls[0], "batch accept call")[0];
        expect(accepted.previewSnapshot.readResults[0]?.candidates[0]?.files[1]).toMatchObject({
            bytes: new Uint8Array([1, 2, 3]),
        });
        expect(
            sink.messages.some(
                (message) =>
                    "method" in message &&
                    message.method === "resource.invalidated" &&
                    message.params.resourceKind === "host_review_record" &&
                    message.params.reason === "accepted",
            ),
        ).toBe(true);
        await runtime.shutdown();
    });

    it("resolves launcher paths, probe targets, and watched decisions without accepting raw Protocol paths", async () => {
        const probe = probeResult();
        const project: ProjectManifestV1 = {
            schemaVersion: 1,
            projectId: PROJECT_ID as ProjectManifestV1["projectId"],
            rootPath: "/selected-project",
            displayName: "Selected",
            deleted: false,
            createdAt: 1 as ProjectManifestV1["createdAt"],
            updatedAt: 2 as ProjectManifestV1["updatedAt"],
        };
        const watched: WatchedScanIntentV1 = {
            configVersion: 1,
            settingId: "watched_scan_intent_v1",
            revision: 0,
            environments: [],
            updatedAt: 0,
            settingFingerprint: DIGEST,
        };
        const getAvailablePlatformContexts = vi.fn(() =>
            complete([{ platform: "linux" as const, platformInstanceId: "local", accessRootPath: "/trusted" }]),
        );
        const probeAdapters = vi.fn(async () => complete([probe]));
        const registerProject = vi.fn(() => complete(project));
        const createDeployment = vi.fn(() => complete(deployment()));
        const replaceWatchedScanIntent = vi.fn(() => complete(watched));
        const runtime = host(
            fakeCoreWith({
                getAvailablePlatformContexts,
                probeAdapters,
                registerProject,
                createDeployment,
                replaceWatchedScanIntent,
            }),
        );
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        const projectToken = connection.registerLocalPathSelection("project_root", "/selected-project");
        connection.receive(
            createProtocolRequest("register", "project.register", {
                localPathSelectionToken: projectToken,
                displayName: "Selected",
            }),
        );
        await settle();
        expect(registerProject).toHaveBeenCalledWith({ rootPath: "/selected-project", displayName: "Selected" });

        connection.receive(
            createProtocolRequest("probe", "adapter.probe", {
                adapterIds: ["CLAUDECODE"],
                environments: [{ platform: "linux", platformInstanceId: "local" }],
                authorization: { scope: "global" },
            }),
        );
        await settle();
        const probeReview = (terminal(sink, "adapter.probe") as { value: unknown }).value as {
            probeToken: string;
            results: { rowId: string; sources: { rowId: string }[]; targets: { rowId: string }[] }[];
        };
        const probeRow = required(probeReview.results[0], "probe result row");
        const sourceRow = required(probeRow.sources[0], "source root row");
        const targetRow = required(probeRow.targets[0], "target row");
        connection.receive(
            createProtocolRequest("deployment", "deployment.create", {
                probeToken: probeReview.probeToken,
                probeResultRowId: probeRow.rowId,
                targetRowId: targetRow.rowId,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
            }),
        );
        await settle();
        expect(createDeployment).toHaveBeenCalledWith({
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: "/project",
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        });

        const sourceToken = connection.registerLocalPathSelection("source_root", "/external");
        connection.receive(
            createProtocolRequest("watched", "watched_scan_intent.replace", {
                expectedRevision: 0,
                expectedSettingFingerprint: "a".repeat(64),
                decisions: [
                    {
                        action: "include_observed",
                        probeToken: probeReview.probeToken,
                        probeResultRowId: probeRow.rowId,
                        sourceRootRowId: sourceRow.rowId,
                        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        binding: { assetScope: "project", projectId: PROJECT_ID },
                    },
                    {
                        action: "include_user_selected_root",
                        localPathSelectionToken: sourceToken,
                        environment: { platform: "linux", platformInstanceId: "local" },
                        adapterId: "CLAUDECODE",
                        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        binding: { assetScope: "global" },
                    },
                ],
                userActionId: "user",
            }),
        );
        await settle();
        expect(replaceWatchedScanIntent).toHaveBeenCalledWith({
            expectedRevision: 0,
            expectedSettingFingerprint: DIGEST,
            userActionId: "user",
            currentProbeResults: [expect.objectContaining({ observation: probe.observation })],
            decisions: [
                {
                    action: "include_observed",
                    sourceRef: {
                        adapterId: "CLAUDECODE",
                        platformContext: probe.observation.platformContext,
                        sourceRootId: SOURCE_ROOT_ID,
                    },
                    agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    binding: { assetScope: "project", projectId: PROJECT_ID },
                },
                {
                    action: "include_user_selected_root",
                    environment: { platform: "linux", platformInstanceId: "local" },
                    adapterId: "CLAUDECODE",
                    agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    directoryRootPath: "/external",
                    binding: { assetScope: "global" },
                },
            ],
        });
        await runtime.shutdown();
    });

    it("maps a Global target to Core global identity and rejects subject/target mismatches", async () => {
        const probe = probeResult();
        const target = required(probe.observation.targetCandidates[0], "global target candidate");
        target.targetKind = "global";
        target.targetRootPath = "/global";
        const getAvailablePlatformContexts = vi.fn(() =>
            complete([{ platform: "linux" as const, platformInstanceId: "local", accessRootPath: "/trusted" }]),
        );
        const probeAdapters = vi.fn(async () => complete([probe]));
        const createDeployment = vi.fn(() => complete({ ...deployment(), projectId: "", targetRootPath: "/global" }));
        const runtime = host(fakeCoreWith({ getAvailablePlatformContexts, probeAdapters, createDeployment }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive(
            createProtocolRequest("probe-global", "adapter.probe", {
                adapterIds: ["CLAUDECODE"],
                environments: [{ platform: "linux", platformInstanceId: "local" }],
                authorization: { scope: "global" },
            }),
        );
        await settle();
        const review = (terminal(sink, "adapter.probe") as { value: unknown }).value as {
            probeToken: string;
            results: { rowId: string; targets: { rowId: string }[] }[];
        };
        const resultRow = required(review.results[0], "global probe result row");
        const targetRow = required(resultRow.targets[0], "global target row");
        const base = {
            probeToken: review.probeToken,
            probeResultRowId: resultRow.rowId,
            targetRowId: targetRow.rowId,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        };

        connection.receive(
            createProtocolRequest("deployment-global", "deployment.create", {
                ...base,
                subject: { subjectKind: "global" },
            }),
        );
        await settle();
        expect(createDeployment).toHaveBeenCalledWith({
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: "/global",
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        });
        expect(sink.messages).toContainEqual(
            expect.objectContaining({
                id: "deployment-global",
                result: expect.objectContaining({ value: expect.objectContaining({ subject: { subjectKind: "global" } }) }),
            }),
        );

        connection.receive(
            createProtocolRequest("deployment-mismatch", "deployment.create", {
                ...base,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
            }),
        );
        await settle();
        expect(createDeployment).toHaveBeenCalledTimes(1);
        expect(sink.messages).toContainEqual(
            expect.objectContaining({
                id: "deployment-mismatch",
                result: expect.objectContaining({ status: "failed" }),
            }),
        );
        await runtime.shutdown();
    });

    it("replaces stale Project rename reviews and consumes the accepted review exactly once", async () => {
        const inspectProjectLifecycle = vi.fn(
            (input: { readonly action: "rename"; readonly projectId: string; readonly nextDisplayName: string }) =>
                complete({
                    schemaVersion: 1 as const,
                    action: "rename" as const,
                    projectId: input.projectId as ProjectManifestV1["projectId"],
                    projectAuthorityFingerprint: DIGEST,
                    rootPath: "/project",
                    currentDisplayName: "Before",
                    nextDisplayName: input.nextDisplayName,
                }),
        );
        let failNextCommit = true;
        const commitProjectLifecycle = vi.fn((input: { readonly preparation: { readonly nextDisplayName: string } }) => {
            if (failNextCommit) {
                failNextCommit = false;
                return { status: "failed" as const, diagnostics: [] };
            }
            return complete({
                schemaVersion: 1 as const,
                projectId: PROJECT_ID as ProjectManifestV1["projectId"],
                rootPath: "/project",
                displayName: input.preparation.nextDisplayName,
                deleted: false,
                createdAt: 1 as ProjectManifestV1["createdAt"],
                updatedAt: 2 as ProjectManifestV1["updatedAt"],
            });
        });
        const runtime = host(fakeCoreWith({ inspectProjectLifecycle, commitProjectLifecycle }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());

        connection.receive(
            createProtocolRequest("inspect-rename-1", "project_lifecycle.inspect", {
                action: "rename",
                projectId: PROJECT_ID,
                nextDisplayName: "First review",
            }),
        );
        await settle();
        const first = (terminal(sink, "project_lifecycle.inspect") as { value: unknown }).value as {
            projectLifecycleReviewToken: string;
        };

        connection.receive(
            createProtocolRequest("inspect-rename-2", "project_lifecycle.inspect", {
                action: "rename",
                projectId: PROJECT_ID,
                nextDisplayName: "Final name",
            }),
        );
        await settle();
        const second = (terminal(sink, "project_lifecycle.inspect") as { value: unknown }).value as {
            projectLifecycleReviewToken: string;
            projectAuthorityFingerprint: string;
            currentDisplayName: string;
            nextDisplayName: string;
        };
        expect(second).toMatchObject({
            projectAuthorityFingerprint: DIGEST.slice("sha256:".length),
            currentDisplayName: "Before",
            nextDisplayName: "Final name",
        });
        expect(sink.messages).toContainEqual(
            expect.objectContaining({
                method: "resource.invalidated",
                params: expect.objectContaining({
                    resourceKind: "host_review_record",
                    recordKind: "project_lifecycle",
                    token: first.projectLifecycleReviewToken,
                    reason: "replaced",
                }),
            }),
        );

        connection.receive(
            createProtocolRequest("commit-stale-rename", "project_lifecycle.commit", {
                projectLifecycleReviewToken: first.projectLifecycleReviewToken,
                userActionId: "stale-action",
            }),
        );
        await settle();
        expect(terminal(sink, "project_lifecycle.commit")).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.review_record_unavailable" }],
        });
        expect(commitProjectLifecycle).not.toHaveBeenCalled();

        connection.receive(
            createProtocolRequest("commit-rename-fails", "project_lifecycle.commit", {
                projectLifecycleReviewToken: second.projectLifecycleReviewToken,
                userActionId: "rename-project",
            }),
        );
        await settle();
        expect(terminal(sink, "project_lifecycle.commit")).toEqual({ status: "failed", diagnostics: [] });

        connection.receive(
            createProtocolRequest("commit-rename", "project_lifecycle.commit", {
                projectLifecycleReviewToken: second.projectLifecycleReviewToken,
                userActionId: "rename-project-retry",
            }),
        );
        await settle();
        expect(terminal(sink, "project_lifecycle.commit")).toMatchObject({
            status: "complete",
            value: { projectId: PROJECT_ID, rootPath: "/project", displayName: "Final name" },
        });
        expect(commitProjectLifecycle).toHaveBeenCalledWith({
            preparation: expect.objectContaining({
                action: "rename",
                projectId: PROJECT_ID,
                projectAuthorityFingerprint: DIGEST,
                nextDisplayName: "Final name",
            }),
            userActionId: "rename-project-retry",
        });
        expect(sink.messages).toContainEqual(
            expect.objectContaining({
                method: "resource.invalidated",
                params: expect.objectContaining({
                    resourceKind: "host_review_record",
                    recordKind: "project_lifecycle",
                    token: second.projectLifecycleReviewToken,
                    reason: "accepted",
                }),
            }),
        );

        connection.receive(
            createProtocolRequest("commit-rename-replay", "project_lifecycle.commit", {
                projectLifecycleReviewToken: second.projectLifecycleReviewToken,
                userActionId: "replay",
            }),
        );
        await settle();
        expect(terminal(sink, "project_lifecycle.commit")).toMatchObject({ status: "failed" });
        expect(commitProjectLifecycle).toHaveBeenCalledTimes(2);
        await runtime.shutdown();
    });

    it("consumes one launcher-selected root and binds the exact Project rebind review", async () => {
        const inspectProjectLifecycle = vi.fn(
            (input: { readonly action: "rebind"; readonly projectId: string; readonly nextRootPath: string }) =>
                complete({
                    schemaVersion: 1 as const,
                    action: "rebind" as const,
                    projectId: input.projectId as ProjectManifestV1["projectId"],
                    projectAuthorityFingerprint: DIGEST,
                    displayName: "Project",
                    currentRootPath: "/old-project",
                    nextRootPath: input.nextRootPath,
                }),
        );
        const commitProjectLifecycle = vi.fn((input: { readonly preparation: { readonly nextRootPath: string } }) =>
            complete({
                schemaVersion: 1 as const,
                projectId: PROJECT_ID as ProjectManifestV1["projectId"],
                rootPath: input.preparation.nextRootPath,
                displayName: "Project",
                deleted: false,
                createdAt: 1 as ProjectManifestV1["createdAt"],
                updatedAt: 2 as ProjectManifestV1["updatedAt"],
            }),
        );
        const runtime = host(fakeCoreWith({ inspectProjectLifecycle, commitProjectLifecycle }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        const selectedRootToken = connection.registerLocalPathSelection("project_root", "/new-project");

        connection.receive(
            createProtocolRequest("inspect-rebind", "project_lifecycle.inspect", {
                action: "rebind",
                projectId: PROJECT_ID,
                localPathSelectionToken: selectedRootToken,
            }),
        );
        await settle();
        const review = (terminal(sink, "project_lifecycle.inspect") as { value: unknown }).value as {
            projectLifecycleReviewToken: string;
        };
        expect(inspectProjectLifecycle).toHaveBeenCalledWith({
            action: "rebind",
            projectId: PROJECT_ID,
            nextRootPath: "/new-project",
        });
        expect(review).toMatchObject({
            action: "rebind",
            projectId: PROJECT_ID,
            projectAuthorityFingerprint: DIGEST.slice("sha256:".length),
            currentRootPath: "/old-project",
            nextRootPath: "/new-project",
        });

        connection.receive(
            createProtocolRequest("inspect-rebind-replay", "project_lifecycle.inspect", {
                action: "rebind",
                projectId: PROJECT_ID,
                localPathSelectionToken: selectedRootToken,
            }),
        );
        await settle();
        expect(terminal(sink, "project_lifecycle.inspect")).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.path_selection_unavailable" }],
        });
        expect(inspectProjectLifecycle).toHaveBeenCalledTimes(1);

        connection.receive(
            createProtocolRequest("commit-rebind", "project_lifecycle.commit", {
                projectLifecycleReviewToken: review.projectLifecycleReviewToken,
                userActionId: "rebind-project",
            }),
        );
        await settle();
        expect(terminal(sink, "project_lifecycle.commit")).toMatchObject({
            status: "complete",
            value: { projectId: PROJECT_ID, rootPath: "/new-project" },
        });
        expect(commitProjectLifecycle).toHaveBeenCalledWith({
            preparation: expect.objectContaining({
                action: "rebind",
                currentRootPath: "/old-project",
                nextRootPath: "/new-project",
            }),
            userActionId: "rebind-project",
        });
        await runtime.shutdown();
    });

    it("binds same-UUID Project restore without requiring a path selection", async () => {
        const inspectProjectLifecycle = vi.fn((input: { readonly action: "restore"; readonly projectId: string }) =>
            complete({
                schemaVersion: 1 as const,
                action: "restore" as const,
                projectId: input.projectId as ProjectManifestV1["projectId"],
                projectAuthorityFingerprint: DIGEST,
                displayName: "Retained Project",
                rootPath: "/missing-project",
                rootAccessState: "unavailable" as const,
            }),
        );
        const commitProjectLifecycle = vi.fn(() =>
            complete({
                schemaVersion: 1 as const,
                projectId: PROJECT_ID as ProjectManifestV1["projectId"],
                rootPath: "/missing-project",
                displayName: "Retained Project",
                deleted: false,
                createdAt: 1 as ProjectManifestV1["createdAt"],
                updatedAt: 2 as ProjectManifestV1["updatedAt"],
            }),
        );
        const runtime = host(fakeCoreWith({ inspectProjectLifecycle, commitProjectLifecycle }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());

        connection.receive(
            createProtocolRequest("inspect-restore", "project_lifecycle.inspect", {
                action: "restore",
                projectId: PROJECT_ID,
            }),
        );
        await settle();
        const review = (terminal(sink, "project_lifecycle.inspect") as { value: unknown }).value as {
            projectLifecycleReviewToken: string;
        };
        expect(inspectProjectLifecycle).toHaveBeenCalledWith({ action: "restore", projectId: PROJECT_ID });
        expect(review).toMatchObject({
            action: "restore",
            projectId: PROJECT_ID,
            projectAuthorityFingerprint: DIGEST.slice("sha256:".length),
            rootPath: "/missing-project",
            rootAccessState: "unavailable",
        });

        connection.receive(
            createProtocolRequest("commit-restore", "project_lifecycle.commit", {
                projectLifecycleReviewToken: review.projectLifecycleReviewToken,
                userActionId: "restore-project",
            }),
        );
        await settle();
        expect(terminal(sink, "project_lifecycle.commit")).toMatchObject({
            status: "complete",
            value: { projectId: PROJECT_ID, rootPath: "/missing-project", deleted: false },
        });
        expect(commitProjectLifecycle).toHaveBeenCalledWith({
            preparation: expect.objectContaining({
                action: "restore",
                rootPath: "/missing-project",
                rootAccessState: "unavailable",
            }),
            userActionId: "restore-project",
        });
        await runtime.shutdown();
    });

    it("binds stop managing to one exact Project review without requiring a path selection", async () => {
        const inspectProjectLifecycle = vi.fn((input: { readonly action: "stop_managing"; readonly projectId: string }) =>
            complete({
                schemaVersion: 1 as const,
                action: "stop_managing" as const,
                projectId: input.projectId as ProjectManifestV1["projectId"],
                projectAuthorityFingerprint: DIGEST,
                displayName: "Managed Project",
                rootPath: "/project",
            }),
        );
        const commitProjectLifecycle = vi.fn(() =>
            complete({
                schemaVersion: 1 as const,
                projectId: PROJECT_ID as ProjectManifestV1["projectId"],
                rootPath: "/project",
                displayName: "Managed Project",
                deleted: true,
                createdAt: 1 as ProjectManifestV1["createdAt"],
                updatedAt: 2 as ProjectManifestV1["updatedAt"],
            }),
        );
        const runtime = host(fakeCoreWith({ inspectProjectLifecycle, commitProjectLifecycle }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());

        connection.receive(
            createProtocolRequest("inspect-stop-managing", "project_lifecycle.inspect", {
                action: "stop_managing",
                projectId: PROJECT_ID,
            }),
        );
        await settle();
        const review = (terminal(sink, "project_lifecycle.inspect") as { value: unknown }).value as {
            projectLifecycleReviewToken: string;
        };
        expect(inspectProjectLifecycle).toHaveBeenCalledWith({ action: "stop_managing", projectId: PROJECT_ID });
        expect(review).toMatchObject({
            action: "stop_managing",
            projectId: PROJECT_ID,
            projectAuthorityFingerprint: DIGEST.slice("sha256:".length),
            displayName: "Managed Project",
            rootPath: "/project",
        });

        connection.receive(
            createProtocolRequest("commit-stop-managing", "project_lifecycle.commit", {
                projectLifecycleReviewToken: review.projectLifecycleReviewToken,
                userActionId: "stop-managing-project",
            }),
        );
        await settle();
        expect(terminal(sink, "project_lifecycle.commit")).toMatchObject({
            status: "complete",
            value: { projectId: PROJECT_ID, rootPath: "/project", deleted: true },
        });
        expect(commitProjectLifecycle).toHaveBeenCalledWith({
            preparation: expect.objectContaining({
                action: "stop_managing",
                displayName: "Managed Project",
                rootPath: "/project",
            }),
            userActionId: "stop-managing-project",
        });
        await runtime.shutdown();
    });

    it("retains inspection evidence for detail and consumes it only after repair or reverse prepare", async () => {
        const inspectDeploymentRenderedTarget = vi.fn(async () => complete(inspection()));
        const repairDeployment = vi.fn(async () => complete(deployment()));
        const prepareRenderedTargetAccept = vi.fn(async () =>
            complete({
                preparationState: "prepared" as const,
                preparationId: ASSET_ID as never,
                preparationRevision: 1,
                expiresAt: 10 as never,
                promotionState: "already_authorized" as const,
                renderAnalysis: { renderInputFingerprint: DIGEST, requiredSemantics: [], analyses: [] },
            }),
        );
        const runtime = host(
            fakeCoreWith({
                inspectDeploymentRenderedTarget,
                repairDeployment,
                prepareRenderedTargetAccept,
            }),
        );
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());

        connection.receive(createProtocolRequest("inspect", "deployment.inspect_rendered_target", { deploymentId: VERSION_ID }));
        await settle();
        const review = (terminal(sink, "deployment.inspect_rendered_target") as { value: unknown }).value as {
            inspectionToken: string;
            inspectionResultFingerprint: string;
            details: { selector: string; detailKind: string }[];
        };
        expect(review.details).toHaveLength(2);
        const conflict = required(
            review.details.find((detail) => detail.detailKind === "file_attribution"),
            "file attribution detail",
        );
        const semantic = required(
            review.details.find((detail) => detail.detailKind === "semantic_change"),
            "semantic change detail",
        );

        connection.receive(
            createProtocolRequest("conflict-detail", "rendered_inspection.detail", {
                inspectionToken: review.inspectionToken,
                selector: conflict.selector,
            }),
        );
        connection.receive(
            createProtocolRequest("semantic-detail", "rendered_inspection.detail", {
                inspectionToken: review.inspectionToken,
                selector: semantic.selector,
            }),
        );
        await settle();
        expect(sink.messages.at(-2)).toMatchObject({
            result: { value: { detailKind: "file_attribution", attributionState: "conflict", reasonCode: "ambiguous" } },
        });
        expect(sink.messages.at(-1)).toMatchObject({
            result: {
                value: {
                    detailKind: "semantic_change",
                    changeKind: "file_content_replacement",
                    content: { contentKind: "text", text: { text: "changed" } },
                },
            },
        });

        connection.receive(
            createProtocolRequest("repair", "deployment.repair", {
                deploymentId: VERSION_ID,
                inspectionToken: review.inspectionToken,
                expectedInspectionResultFingerprint: review.inspectionResultFingerprint,
                userActionId: "user",
            }),
        );
        await settle();
        expect(repairDeployment).toHaveBeenCalledWith({
            deploymentId: VERSION_ID,
            expectedInspectionResultFingerprint: DIGEST,
            userActionId: "user",
        });

        connection.receive(
            createProtocolRequest("inspect-2", "deployment.inspect_rendered_target", { deploymentId: VERSION_ID }),
        );
        await settle();
        const review2 = (terminal(sink, "deployment.inspect_rendered_target") as { value: unknown }).value as typeof review;
        connection.receive(
            createProtocolRequest("prepare", "reverse_accept.prepare", {
                deploymentId: VERSION_ID,
                inspectionToken: review2.inspectionToken,
                inspectionResultFingerprint: review2.inspectionResultFingerprint,
            }),
        );
        await settle();
        expect(prepareRenderedTargetAccept).toHaveBeenCalledWith({
            deploymentId: VERSION_ID,
            inspectionResultFingerprint: DIGEST,
        });
        expect(terminal(sink, "reverse_accept.prepare")).toMatchObject({
            status: "complete",
            value: {
                preparationState: "prepared",
                renderAnalysis: {
                    deploymentId: VERSION_ID,
                    semantics: [],
                    outputUnits: [],
                    options: [],
                    blockedSemantics: [],
                    diagnostics: [],
                },
            },
        });
        await runtime.shutdown();
    });

    it("rejects forged review members and stale one-shot paths before protected Core calls", async () => {
        const registerProject = vi.fn();
        const createDeployment = vi.fn();
        const repairDeployment = vi.fn();
        const runtime = host(fakeCoreWith({ registerProject, createDeployment, repairDeployment }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive(
            createProtocolRequest("register", "project.register", {
                localPathSelectionToken: "forged",
            }),
        );
        connection.receive(
            createProtocolRequest("deployment", "deployment.create", {
                probeToken: "forged",
                probeResultRowId: "row",
                targetRowId: "target",
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
            }),
        );
        connection.receive(
            createProtocolRequest("repair", "deployment.repair", {
                deploymentId: VERSION_ID,
                inspectionToken: "forged",
                expectedInspectionResultFingerprint: "a".repeat(64),
                userActionId: "user",
            }),
        );
        await settle();
        expect(registerProject).not.toHaveBeenCalled();
        expect(createDeployment).not.toHaveBeenCalled();
        expect(repairDeployment).not.toHaveBeenCalled();
        expect(sink.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: "register", result: expect.objectContaining({ status: "failed" }) }),
                expect.objectContaining({ id: "deployment", result: expect.objectContaining({ status: "failed" }) }),
            ]),
        );
        expect(terminal(sink, "deployment.repair")).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.review_record_unavailable" }],
        });
        await runtime.shutdown();
    });
});
