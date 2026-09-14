import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProtocolRequest, type ProtocolOperationOutcomeV1 } from "@oaam/app-server-protocol";
import type {
    AdapterReadResult,
    ConfirmOneTimeRenderApprovalInput,
    CoreResult,
    CoreService,
    ImportAcceptBatchResultV1,
    PlatformContext,
    ProbeResult,
    ProjectManifestV1,
    RenderedTargetAcceptPreparationView,
    WatchedScanIntentV1,
} from "@oaam/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    dispatchH2Immediate,
    dispatchH2Long,
    type HostH2DispatchContext,
    type ImmediateH2Request,
    type LongH2Request,
} from "../src/dispatch-h2";
import { HostPathSelectionStore } from "../src/path-selection-store";
import { HostReviewRecordStore } from "../src/review-record-store";
import { HostReviewRecords, HostReviewRecordUnavailableError } from "../src/review-records";
import { createHostRenderApprovalAuthority } from "../src/render-approval-authority";
import {
    H2_DIGEST,
    h2Deployment,
    h2Inspection,
    h2PreviewSnapshot,
    h2ProbeResult,
    h2ReadResult,
    h2RenderPreview,
} from "./support/h2-review-fixtures";
import { ASSET_ID, complete, fakeCoreWith, PROJECT_ID, required, VERSION_ID } from "./support/host-test-fixtures";

const temporaryRoots: string[] = [];

function failed<T>(): CoreResult<T> {
    return { status: "failed", diagnostics: [] };
}

function context(options: { maximumBytes?: number } = {}): {
    readonly context: HostH2DispatchContext;
    readonly store: HostReviewRecordStore;
} {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-h2-dispatch-"));
    temporaryRoots.push(rootPath);
    let pathNumber = 0;
    let recordNumber = 0;
    let memberNumber = 0;
    const store = new HostReviewRecordStore({
        rootPath,
        createToken: () => `review-${++recordNumber}`,
        ...(options.maximumBytes === undefined ? {} : { maximumBytes: options.maximumBytes }),
    });
    return {
        store,
        context: {
            connectionId: "connection",
            pathSelections: new HostPathSelectionStore({ createToken: () => `path-${++pathNumber}` }),
            reviews: new HostReviewRecords(store, () => `member-${++memberNumber}`),
            renderApprovals: createHostRenderApprovalAuthority(() => 1_234),
        },
    };
}

function immediate(
    core: CoreService,
    request: ReturnType<typeof createProtocolRequest>,
    dispatchContext: HostH2DispatchContext,
): ProtocolOperationOutcomeV1<unknown> {
    const response = dispatchH2Immediate(core, request as ImmediateH2Request, dispatchContext);
    if (!("result" in response)) throw new TypeError("expected an immediate result");
    return response.result as ProtocolOperationOutcomeV1<unknown>;
}

async function long(
    core: CoreService,
    request: ReturnType<typeof createProtocolRequest>,
    dispatchContext: HostH2DispatchContext,
): Promise<ProtocolOperationOutcomeV1<unknown>> {
    return (await dispatchH2Long(core, request as LongH2Request, dispatchContext)) as ProtocolOperationOutcomeV1<unknown>;
}

function project(): ProjectManifestV1 {
    return {
        schemaVersion: 1,
        projectId: PROJECT_ID as ProjectManifestV1["projectId"],
        rootPath: "/project",
        displayName: "Project",
        deleted: false,
        createdAt: 1 as ProjectManifestV1["createdAt"],
        updatedAt: 2 as ProjectManifestV1["updatedAt"],
    };
}

function watched(): WatchedScanIntentV1 {
    return {
        configVersion: 1,
        settingId: "watched_scan_intent_v1",
        revision: 0,
        environments: [],
        updatedAt: 0,
        settingFingerprint: H2_DIGEST,
    };
}

function availableContexts(): CoreResult<PlatformContext[]> {
    return complete([{ platform: "linux", platformInstanceId: "local", accessRootPath: "/trusted" }]);
}

function failedProbeResult(context: PlatformContext): ProbeResult {
    return {
        status: "failed",
        observation: {
            adapterId: "CLAUDECODE" as ProbeResult["observation"]["adapterId"],
            platformContext: context,
            observedAgentRuntimes: [],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics: [warningDiagnostic("probe.context_failed")],
    };
}

function expectLastProbeAdapterRequest(probeAdapters: ReturnType<typeof vi.fn>, input: object): void {
    expect(probeAdapters).toHaveBeenLastCalledWith(input, expect.any(Function));
}

function warningDiagnostic(code: string) {
    return {
        severity: "warning" as const,
        code,
        message: "partial fixture",
        path: "",
        traceId: "",
        operation: "probe" as const,
        causeKind: "partial" as const,
        retryable: true,
        suggestedActions: ["retry" as const],
        rawSummary: "",
    };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("H2 dispatch edge and failure semantics", () => {
    it("replays one stable one-time render approval from preview into deploy", async () => {
        const harness = context();
        const selection = {
            schemaVersion: 1 as const,
            renderInputFingerprint: "a".repeat(64),
            semanticOptions: [
                {
                    optionFingerprint: "b".repeat(64),
                    approval: { action: "approve_once" as const, userActionId: "approve-migration" },
                },
            ],
        };
        const observed: Array<number | null> = [];
        const observeAuthority = (renderInputFingerprint: typeof H2_DIGEST) => {
            observed.push(
                harness.context.renderApprovals.confirmOneTimeApproval({
                    userActionId: "approve-migration",
                    approvalFingerprint: H2_DIGEST,
                    deployment: { renderInputFingerprint } as ConfirmOneTimeRenderApprovalInput["deployment"],
                    semantic: {} as ConfirmOneTimeRenderApprovalInput["semantic"],
                    option: {
                        optionFingerprint: `sha256:${"b".repeat(64)}`,
                    } as ConfirmOneTimeRenderApprovalInput["option"],
                }),
            );
        };
        const previewDeploymentRender = vi.fn(async (input) => {
            observeAuthority(input.selectionRequest.renderInputFingerprint);
            return complete(h2RenderPreview());
        });
        const deployDeployment = vi.fn(async (input) => {
            observeAuthority(input.selectionRequest.renderInputFingerprint);
            return complete(h2Deployment());
        });
        const core = fakeCoreWith({ previewDeploymentRender, deployDeployment });
        const preview = await long(
            core,
            createProtocolRequest("approval-preview", "deployment.render_preview", {
                deploymentId: VERSION_ID,
                selection,
            }),
            harness.context,
        );
        expect(preview.status).toBe("complete");
        expect(harness.context.renderApprovals.confirmOneTimeApproval({} as ConfirmOneTimeRenderApprovalInput)).toBeNull();

        const previewToken = (preview as { value: { previewToken: string } }).value.previewToken;
        expect(
            await long(
                core,
                createProtocolRequest("approval-deploy", "deployment.deploy", {
                    previewToken,
                    deploymentAction: "apply",
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete" });
        expect(observed).toEqual([1_234, 1_234]);
        harness.store.close();
    });

    it("binds deploy to one retained render preview and consumes authority only after success", async () => {
        const harness = context();
        const selection = {
            schemaVersion: 1 as const,
            renderInputFingerprint: "a".repeat(64),
            semanticOptions: [],
        };
        const previewDeploymentRender = vi.fn(async () => complete(h2RenderPreview("requires_unmanaged_replacement")));
        const deployDeployment = vi.fn(async () => complete(h2Deployment()));
        const core = fakeCoreWith({ previewDeploymentRender, deployDeployment });
        const previewOutcome = await long(
            core,
            createProtocolRequest("preview", "deployment.render_preview", {
                deploymentId: VERSION_ID,
                selection,
            }),
            harness.context,
        );
        expect(previewOutcome.status).toBe("complete");
        const previewToken = (previewOutcome as { value: { previewToken: string } }).value.previewToken;
        expect(previewDeploymentRender).toHaveBeenCalledWith({
            deploymentId: VERSION_ID,
            selectionRequest: {
                ...selection,
                renderInputFingerprint: H2_DIGEST,
            },
        });

        const deployed = await long(
            core,
            createProtocolRequest("deploy", "deployment.deploy", {
                previewToken,
                deploymentAction: "replace_unmanaged",
                userActionId: "replace-reviewed-target",
            }),
            harness.context,
        );
        expect(deployed.status).toBe("complete");
        expect(deployDeployment).toHaveBeenCalledWith({
            deploymentId: VERSION_ID,
            selectionRequest: {
                ...selection,
                renderInputFingerprint: H2_DIGEST,
            },
            expectedPreviewFingerprint: H2_DIGEST,
            deploymentAction: "replace_unmanaged",
            userActionId: "replace-reviewed-target",
        });
        expect(() => harness.context.reviews.resolveRenderPreview(previewToken)).toThrow(HostReviewRecordUnavailableError);
        expect(
            await long(
                core,
                createProtocolRequest("replay", "deployment.deploy", {
                    previewToken,
                    deploymentAction: "replace_unmanaged",
                    userActionId: "replay",
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_unavailable" }] });

        const retryPreview = harness.context.reviews.recordRenderPreview(
            "connection",
            VERSION_ID,
            {
                ...selection,
                renderInputFingerprint: H2_DIGEST,
            },
            h2RenderPreview(),
        );
        const failedCore = fakeCoreWith({ deployDeployment: async () => failed() });
        expect(
            await long(
                failedCore,
                createProtocolRequest("failed-deploy", "deployment.deploy", {
                    previewToken: retryPreview.previewToken,
                    deploymentAction: "apply",
                }),
                harness.context,
            ),
        ).toEqual({ status: "failed", diagnostics: [] });
        expect(harness.context.reviews.resolveRenderPreview(retryPreview.previewToken).preview.previewFingerprint).toBe(
            H2_DIGEST,
        );
        harness.store.close();
    });

    it("executes apply and overwrite from their current preview without consuming an unrelated inspection", async () => {
        const harness = context();
        const selection = {
            schemaVersion: 1 as const,
            renderInputFingerprint: H2_DIGEST,
            semanticOptions: [],
        };
        const deployDeployment = vi.fn(async () => complete(h2Deployment()));
        const core = fakeCoreWith({ deployDeployment });

        const applyPreview = harness.context.reviews.recordRenderPreview("connection", VERSION_ID, selection, h2RenderPreview());
        expect(
            await long(
                core,
                createProtocolRequest("apply", "deployment.deploy", {
                    previewToken: applyPreview.previewToken,
                    deploymentAction: "apply",
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete" });
        expect(deployDeployment).toHaveBeenLastCalledWith({
            deploymentId: VERSION_ID,
            selectionRequest: selection,
            expectedPreviewFingerprint: H2_DIGEST,
            deploymentAction: "apply",
        });
        expect(() => harness.context.reviews.resolveRenderPreview(applyPreview.previewToken)).toThrow(
            HostReviewRecordUnavailableError,
        );

        const overwritePreview = harness.context.reviews.recordRenderPreview(
            "connection",
            VERSION_ID,
            selection,
            h2RenderPreview("blocked_managed_conflict"),
        );
        const inspection = harness.context.reviews.recordInspection("connection", VERSION_ID, h2Inspection());
        expect(
            await long(
                core,
                createProtocolRequest("overwrite", "deployment.deploy", {
                    previewToken: overwritePreview.previewToken,
                    deploymentAction: "overwrite_runtime",
                    userActionId: "overwrite-reviewed-runtime",
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete" });
        expect(deployDeployment).toHaveBeenLastCalledWith({
            deploymentId: VERSION_ID,
            selectionRequest: selection,
            expectedPreviewFingerprint: H2_DIGEST,
            deploymentAction: "overwrite_runtime",
            userActionId: "overwrite-reviewed-runtime",
        });
        expect(() => harness.context.reviews.resolveRenderPreview(overwritePreview.previewToken)).toThrow(
            HostReviewRecordUnavailableError,
        );
        expect(() =>
            harness.context.reviews.resolveInspection(
                inspection.inspectionToken,
                VERSION_ID,
                inspection.inspectionResultFingerprint,
            ),
        ).not.toThrow();
        harness.store.close();
    });

    it("covers immediate projection branches, one-shot path failures, exact members, and cancel semantics", () => {
        const harness = context();
        const probeReview = harness.context.reviews.recordProbe("connection", [h2ProbeResult()]);
        const probeRow = required(probeReview.results[0], "probe result row");
        const sourceRow = required(probeRow.sources[0], "source root row");
        const readReview = harness.context.reviews.recordRead("connection", probeReview.probeToken, [h2ReadResult()]);
        const previewReview = harness.context.reviews.recordPreview("connection", readReview.readToken, h2PreviewSnapshot());

        const registerProject = vi.fn(() => complete(project()));
        const replaceWatchedScanIntent = vi.fn(() => complete(watched()));
        const core = fakeCoreWith({ registerProject, replaceWatchedScanIntent });
        const projectPath = harness.context.pathSelections.register("project_root", "/project");
        expect(
            immediate(
                core,
                createProtocolRequest("project", "project.register", {
                    localPathSelectionToken: projectPath,
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete" });
        expect(registerProject).toHaveBeenCalledWith({ rootPath: "/project" });

        const unnamedPath = harness.context.pathSelections.register("project_root", "/unnamed-project");
        registerProject.mockReturnValueOnce(complete({ ...project(), rootPath: "/unnamed-project", displayName: "" }));
        expect(
            immediate(
                core,
                createProtocolRequest("unnamed-project", "project.register", {
                    localPathSelectionToken: unnamedPath,
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete", value: { displayName: "" } });

        expect(
            immediate(
                core,
                createProtocolRequest("watched", "watched_scan_intent.replace", {
                    expectedRevision: 0,
                    expectedSettingFingerprint: "a".repeat(64),
                    decisions: [
                        { action: "retain_existing", selectorFingerprint: "a".repeat(64) },
                        {
                            action: "exclude_observed",
                            probeToken: probeReview.probeToken,
                            probeResultRowId: probeRow.rowId,
                            sourceRootRowId: sourceRow.rowId,
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        },
                    ],
                    userActionId: "user",
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete" });
        expect(replaceWatchedScanIntent).toHaveBeenCalledWith(
            expect.objectContaining({
                decisions: [
                    { action: "retain_existing", selectorFingerprint: H2_DIGEST },
                    expect.objectContaining({ action: "exclude_observed" }),
                ],
            }),
        );

        expect(
            immediate(
                core,
                createProtocolRequest("bad-path", "watched_scan_intent.replace", {
                    expectedRevision: 0,
                    expectedSettingFingerprint: "a".repeat(64),
                    decisions: [
                        {
                            action: "include_user_selected_root",
                            localPathSelectionToken: "missing",
                            environment: { platform: "linux", platformInstanceId: "local" },
                            adapterId: "CLAUDECODE",
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            binding: { assetScope: "global" },
                        },
                    ],
                    userActionId: "user",
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });
        expect(
            immediate(
                core,
                createProtocolRequest("bad-member", "import_preview.detail", {
                    previewToken: previewReview.previewToken,
                    candidateId: "missing",
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_member_unavailable" }] });
        expect(
            immediate(
                core,
                createProtocolRequest("cancel", "import_preview.cancel", {
                    previewToken: previewReview.previewToken,
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete", value: { cancelled: true } });
        expect(
            immediate(
                core,
                createProtocolRequest("cancel-again", "import_preview.cancel", {
                    previewToken: previewReview.previewToken,
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_unavailable" }] });

        const throwingCore = fakeCoreWith({
            registerProject: () => {
                throw new Error("core failed");
            },
        });
        const secondPath = harness.context.pathSelections.register("project_root", "/project");
        expect(
            immediate(
                throwingCore,
                createProtocolRequest("throw", "project.register", {
                    localPathSelectionToken: secondPath,
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.core_invocation_failed" }] });
        harness.store.close();
    });

    it("handles failed platform discovery and all three probe authorization scopes without trusting Client roots", async () => {
        const harness = context();
        const probeAdapters = vi.fn(async () => complete([h2ProbeResult()]));
        const core = fakeCoreWith({ getAvailablePlatformContexts: availableContexts, probeAdapters });

        expect(
            await long(
                fakeCoreWith({ getAvailablePlatformContexts: () => failed() }),
                createProtocolRequest("failed", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "global" },
                }),
                harness.context,
            ),
        ).toEqual({ status: "failed", diagnostics: [] });
        expect(
            await long(
                fakeCoreWith({ getAvailablePlatformContexts: () => complete([]) }),
                createProtocolRequest("missing", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "global" },
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });

        expect(
            await long(
                fakeCoreWith({
                    getAvailablePlatformContexts: () => ({
                        status: "partial",
                        value: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/trusted" }],
                        diagnostics: [warningDiagnostic("environment.partial")],
                    }),
                    probeAdapters,
                }),
                createProtocolRequest("partial-environment", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "global" },
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "partial", diagnostics: [{ code: "environment.partial" }] });
        expect(
            await long(
                fakeCoreWith({
                    getAvailablePlatformContexts: availableContexts,
                    probeAdapters: async () => ({
                        status: "partial",
                        value: [h2ProbeResult()],
                        diagnostics: [warningDiagnostic("probe.partial")],
                    }),
                }),
                createProtocolRequest("partial-probe", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "global" },
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "partial", diagnostics: [{ code: "probe.partial" }] });
        expect(
            await long(
                fakeCoreWith({ getAvailablePlatformContexts: availableContexts, probeAdapters: async () => failed() }),
                createProtocolRequest("failed-probe", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "global" },
                }),
                harness.context,
            ),
        ).toEqual({ status: "failed", diagnostics: [] });

        const projectPath = harness.context.pathSelections.register("project_root", "/project");
        expect(
            await long(
                core,
                createProtocolRequest("project", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "project", localPathSelectionToken: projectPath },
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete" });
        expectLastProbeAdapterRequest(
            probeAdapters,
            expect.objectContaining({ target: { authorizationScope: "project", projectRootPath: "/project" } }),
        );
        expect(
            await long(
                core,
                createProtocolRequest("missing-project", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "project", localPathSelectionToken: "missing" },
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });

        const sourcePath = harness.context.pathSelections.register("source_root", "/source");
        expect(
            await long(
                core,
                createProtocolRequest("directory", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "directory", localPathSelectionToken: sourcePath },
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "complete" });
        expectLastProbeAdapterRequest(
            probeAdapters,
            expect.objectContaining({ target: { authorizationScope: "directory", directoryRootPath: "/source" } }),
        );
        expect(
            await long(
                core,
                createProtocolRequest("missing-directory", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "directory", localPathSelectionToken: "missing" },
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });
        harness.store.close();
    });

    it("dispatches the exact requested environment order and projects a failed context beside a successful one", async () => {
        const harness = context();
        const windows: PlatformContext = {
            platform: "win32",
            platformInstanceId: "desktop-local",
            accessRootPath: "C:\\",
        };
        const wsl: PlatformContext = {
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
        };
        const completeProbe = h2ProbeResult();
        completeProbe.observation.platformContext = windows;
        const probeAdapters = vi.fn(async () => ({
            status: "partial" as const,
            value: [completeProbe, failedProbeResult(wsl)],
            diagnostics: [warningDiagnostic("probe.partial")],
        }));

        const outcome = await long(
            fakeCoreWith({ getAvailablePlatformContexts: () => complete([windows, wsl]), probeAdapters }),
            createProtocolRequest("multi-environment", "adapter.probe", {
                adapterIds: ["CLAUDECODE"],
                environments: [
                    { platform: "wsl", platformInstanceId: "Ubuntu" },
                    { platform: "win32", platformInstanceId: "desktop-local" },
                ],
                authorization: { scope: "global" },
            }),
            harness.context,
        );

        expectLastProbeAdapterRequest(probeAdapters, {
            adapterIds: ["CLAUDECODE"],
            contexts: [wsl, windows],
            target: { authorizationScope: "global" },
        });
        expect(outcome).toMatchObject({
            status: "partial",
            value: {
                results: [
                    { environment: { platform: "win32", platformInstanceId: "desktop-local" }, status: "complete" },
                    { environment: { platform: "wsl", platformInstanceId: "Ubuntu" }, status: "failed" },
                ],
            },
        });

        probeAdapters.mockResolvedValueOnce(complete([completeProbe]));
        const windowsOnly = await long(
            fakeCoreWith({ getAvailablePlatformContexts: () => complete([windows, wsl]), probeAdapters }),
            createProtocolRequest("windows-only", "adapter.probe", {
                adapterIds: ["CLAUDECODE"],
                environments: [{ platform: "win32", platformInstanceId: "desktop-local" }],
                authorization: { scope: "global" },
            }),
            harness.context,
        );
        expectLastProbeAdapterRequest(probeAdapters, {
            adapterIds: ["CLAUDECODE"],
            contexts: [windows],
            target: { authorizationScope: "global" },
        });
        expect(windowsOnly).toMatchObject({
            status: "complete",
            value: { results: [{ environment: { platform: "win32", platformInstanceId: "desktop-local" } }] },
        });
        harness.store.close();
    });

    it("combines complete, partial, and failed reads while keeping optional kind filters honest", async () => {
        const harness = context();
        const probeReview = harness.context.reviews.recordProbe("connection", [h2ProbeResult(), h2ProbeResult()]);
        const firstProbeRow = required(probeReview.results[0], "first probe result row");
        const firstSourceRow = required(firstProbeRow.sources[0], "first source root row");
        const secondProbeRow = required(probeReview.results[1], "second probe result row");
        const secondSourceRow = required(secondProbeRow.sources[0], "second source root row");
        const read = h2ReadResult();
        const partialRead: AdapterReadResult = { ...h2ReadResult(), status: "partial" };
        const readAssetsFromAdapter = vi
            .fn()
            .mockResolvedValueOnce(complete(read))
            .mockResolvedValueOnce({ status: "partial", value: partialRead, diagnostics: [] });
        const core = fakeCoreWith({ readAssetsFromAdapter });
        const outcome = await long(
            core,
            createProtocolRequest("read", "adapter.read", {
                probeToken: probeReview.probeToken,
                selections: [
                    {
                        probeResultRowId: firstProbeRow.rowId,
                        sourceRootRowIds: [firstSourceRow.rowId],
                    },
                    {
                        probeResultRowId: secondProbeRow.rowId,
                        sourceRootRowIds: [secondSourceRow.rowId],
                        allowedKinds: ["Guidance"],
                    },
                ],
            }),
            harness.context,
        );
        expect(outcome).toMatchObject({ status: "partial", value: { candidateCount: 2 } });
        expect(required(readAssetsFromAdapter.mock.calls[0], "first adapter read call")[0]).not.toHaveProperty("allowedKinds");
        expect(required(readAssetsFromAdapter.mock.calls[1], "second adapter read call")[0]).toMatchObject({
            allowedKinds: ["Guidance"],
        });

        const failedHarness = context();
        const failedProbe = failedHarness.context.reviews.recordProbe("connection", [h2ProbeResult()]);
        const failedProbeRow = required(failedProbe.results[0], "failed probe result row");
        const failedSourceRow = required(failedProbeRow.sources[0], "failed source root row");
        expect(
            await long(
                fakeCoreWith({ readAssetsFromAdapter: async () => failed() }),
                createProtocolRequest("failed-read", "adapter.read", {
                    probeToken: failedProbe.probeToken,
                    selections: [
                        {
                            probeResultRowId: failedProbeRow.rowId,
                            sourceRootRowIds: [failedSourceRow.rowId],
                        },
                    ],
                }),
                failedHarness.context,
            ),
        ).toEqual({ status: "failed", diagnostics: [] });
        failedHarness.store.close();
        harness.store.close();
    });

    it("keeps failed import and inspection evidence, maps every batch item, and consumes only successful evidence", async () => {
        const harness = context();
        const probeReview = harness.context.reviews.recordProbe("connection", [h2ProbeResult()]);
        const readReview = harness.context.reviews.recordRead("connection", probeReview.probeToken, [h2ReadResult()]);
        const preview = harness.context.reviews.recordPreview("connection", readReview.readToken, h2PreviewSnapshot());
        const acceptImportBatch = vi.fn(
            async (): Promise<CoreResult<ImportAcceptBatchResultV1>> =>
                complete({
                    schemaVersion: 1,
                    items: [
                        {
                            status: "complete",
                            candidateId: "candidate-1",
                            version: { assetId: ASSET_ID as never, versionId: VERSION_ID as never },
                            diagnostics: [],
                        },
                        { status: "failed", candidateId: "failed", diagnostics: [] },
                        {
                            status: "dependency_failed",
                            candidateId: "skipped",
                            failedDependencyCandidateIds: ["failed"],
                            diagnostics: [],
                        },
                    ],
                }),
        );
        const core = fakeCoreWith({ acceptImportBatch });
        expect(
            await long(
                core,
                createProtocolRequest("bad-fingerprint", "import.accept_batch", {
                    previewToken: preview.previewToken,
                    expectedSnapshotFingerprint: "b".repeat(64),
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
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_member_unavailable" }] });

        const outcome = await long(
            core,
            createProtocolRequest("accept", "import.accept_batch", {
                previewToken: preview.previewToken,
                expectedSnapshotFingerprint: preview.snapshotFingerprint,
                decisions: [
                    {
                        candidateId: "candidate-1",
                        action: "create_version",
                        assetId: ASSET_ID,
                        parentVersionId: VERSION_ID,
                        freshness: { freshnessAction: "accept_preview_snapshot", userActionId: "fresh" },
                        promotion: {
                            promotionAction: "grant_current_version_current_target",
                            target: { targetKind: "project", projectId: PROJECT_ID },
                            userActionId: "promote",
                        },
                        callableBindings: [
                            {
                                subject: { subjectKind: "workflow_execution_agent" },
                                targetAssetVersionId: VERSION_ID,
                            },
                            {
                                subject: { subjectKind: "file_reference", logicalPath: "AGENTS.md", referenceIndex: 0 },
                                targetCandidateId: "candidate-2",
                            },
                        ],
                    },
                ],
            }),
            harness.context,
        );
        expect(outcome).toMatchObject({
            status: "complete",
            value: {
                items: [
                    { status: "complete" },
                    { status: "failed" },
                    { status: "dependency_failed", failedDependencyCandidateIds: ["failed"] },
                ],
            },
        });
        expect(required(acceptImportBatch.mock.calls[0], "batch accept call")[0]).toMatchObject({
            decisions: [
                {
                    action: "create_version",
                    freshness: { freshnessAction: "accept_preview_snapshot", userActionId: "fresh" },
                    promotion: { promotionAction: "grant_current_version_current_target" },
                    callableBindings: [{ targetAssetVersionId: VERSION_ID }, { targetCandidateId: "candidate-2" }],
                },
            ],
        });
        expect(() => harness.context.reviews.resolvePreview(preview.previewToken)).toThrow(HostReviewRecordUnavailableError);

        const preview2 = harness.context.reviews.recordPreview("connection", readReview.readToken, h2PreviewSnapshot());
        expect(
            await long(
                fakeCoreWith({ acceptImportBatch: async () => failed() }),
                createProtocolRequest("failed-accept", "import.accept_batch", {
                    previewToken: preview2.previewToken,
                    expectedSnapshotFingerprint: preview2.snapshotFingerprint,
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
                harness.context,
            ),
        ).toEqual({ status: "failed", diagnostics: [] });
        expect(harness.context.reviews.resolvePreview(preview2.previewToken)).toEqual(h2PreviewSnapshot());

        expect(
            await long(
                fakeCoreWith({ previewImport: () => failed() }),
                createProtocolRequest("failed-preview", "import.preview", { readToken: readReview.readToken }),
                harness.context,
            ),
        ).toEqual({ status: "failed", diagnostics: [] });
        expect(
            await long(
                fakeCoreWith({ inspectDeploymentRenderedTarget: async () => failed() }),
                createProtocolRequest("failed-inspect", "deployment.inspect_rendered_target", {
                    deploymentId: VERSION_ID,
                }),
                harness.context,
            ),
        ).toEqual({ status: "failed", diagnostics: [] });
        harness.store.close();
    });

    it("retains inspection evidence after failed repair or prepare and maps not-prepared without render analysis", async () => {
        const harness = context();
        const inspection = harness.context.reviews.recordInspection("connection", VERSION_ID, h2Inspection());
        expect(
            await long(
                fakeCoreWith({ repairDeployment: async () => failed() }),
                createProtocolRequest("repair", "deployment.repair", {
                    deploymentId: VERSION_ID,
                    inspectionToken: inspection.inspectionToken,
                    expectedInspectionResultFingerprint: inspection.inspectionResultFingerprint,
                    userActionId: "user",
                }),
                harness.context,
            ),
        ).toEqual({ status: "failed", diagnostics: [] });
        expect(
            harness.context.reviews.resolveInspection(
                inspection.inspectionToken,
                VERSION_ID,
                inspection.inspectionResultFingerprint,
            ),
        ).toEqual(h2Inspection());

        const notPrepared: RenderedTargetAcceptPreparationView = { preparationState: "not_prepared" };
        expect(
            await long(
                fakeCoreWith({
                    prepareRenderedTargetAccept: async () => ({ status: "failed", value: notPrepared, diagnostics: [] }),
                }),
                createProtocolRequest("failed-prepare", "reverse_accept.prepare", {
                    deploymentId: VERSION_ID,
                    inspectionToken: inspection.inspectionToken,
                    inspectionResultFingerprint: inspection.inspectionResultFingerprint,
                }),
                harness.context,
            ),
        ).toEqual({ status: "failed", value: notPrepared, diagnostics: [] });
        expect(
            harness.context.reviews.resolveInspection(
                inspection.inspectionToken,
                VERSION_ID,
                inspection.inspectionResultFingerprint,
            ),
        ).toEqual(h2Inspection());

        const throwingCore = fakeCoreWith({
            inspectDeploymentRenderedTarget: async () => {
                throw new Error("unexpected");
            },
        });
        expect(
            await long(
                throwingCore,
                createProtocolRequest("throw", "deployment.inspect_rendered_target", {
                    deploymentId: VERSION_ID,
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.core_invocation_failed" }] });
        harness.store.close();
    });

    it("returns typed capacity failure when a valid Core closure cannot fit the bounded spool", async () => {
        const harness = context({ maximumBytes: 128 });
        expect(
            await long(
                fakeCoreWith({
                    getAvailablePlatformContexts: availableContexts,
                    probeAdapters: async () => complete([h2ProbeResult()]),
                }),
                createProtocolRequest("probe", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "global" },
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_capacity_exceeded" }] });
        harness.store.close();
    });
});
