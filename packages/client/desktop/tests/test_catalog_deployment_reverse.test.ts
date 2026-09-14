import { ClientProtocolFaultError, ClientTransportError } from "@oaam/client-framework";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { CatalogReverseReview } from "../src/renderer/features/catalog-deployment/CatalogReverseReview";
import {
    CatalogDeploymentController,
    type CatalogDeploymentState,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import type { DeploymentView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import {
    CatalogDeploymentReverseController,
    reverseDeploymentId,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-reverse-controller";
import { localizedText, technicalText } from "../src/renderer/presentation";
import {
    COMMITTED_REVERSE,
    DEPLOYMENT_PROVIDERS,
    INSPECTION,
    PREPARED_REVERSE,
    RENDER_ANALYSIS,
    RENDER_PREVIEW,
} from "./catalog-deployment-test-fixtures";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

const DEPLOYMENT_ID = RENDER_PREVIEW.deploymentId;
const SEMANTIC_FINGERPRINT = RENDER_ANALYSIS.renderInputFingerprint;
const OPTION_FINGERPRINT = RENDER_ANALYSIS.options[0]?.optionFingerprint as string;

function deployment(stage: DeploymentView["stage"] = "conflict"): DeploymentView {
    return {
        deploymentId: DEPLOYMENT_ID,
        subject: { subjectKind: "project", projectId: "11111111-1111-4111-8111-111111111111" },
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        environment: { platform: "linux", platformInstanceId: "local" },
        targetRootPath: "/workspace/oaam",
        stage,
        reason: stage,
        actionHints: stage === "conflict" ? ["review_external_changes", "check_now"] : ["check_now"],
        freshness: { state: "complete", attemptedAt: 2, lastCompleteAt: 2 },
        deleted: false,
        assets: [],
        createdAt: 1,
        updatedAt: 2,
    };
}

function reverseClient(overrides: Partial<DesktopApplicationClientApi> = {}): DesktopApplicationClientApi {
    return {
        listProjects: vi.fn(async () => ({ status: "complete", value: { projects: [] }, diagnostics: [] })),
        listAssets: vi.fn(async () => ({ status: "complete", value: { assets: [] }, diagnostics: [] })),
        listDeployments: vi.fn(async () => ({
            status: "complete",
            value: { deployments: [deployment()] },
            diagnostics: [],
        })),
        analyzeDeployment: vi.fn(async () => ({ status: "complete", value: RENDER_ANALYSIS, diagnostics: [] })),
        previewDeployment: vi.fn(async () => ({
            status: "complete",
            value: { ...RENDER_PREVIEW, actionState: "blocked_managed_conflict" },
            diagnostics: [],
        })),
        inspectRenderedTarget: vi.fn(async () => ({ status: "complete", value: INSPECTION, diagnostics: [] })),
        prepareReverseAccept: vi.fn(async () => ({ status: "complete", value: PREPARED_REVERSE, diagnostics: [] })),
        commitReverseAccept: vi.fn(async () => ({ status: "complete", value: COMMITTED_REVERSE, diagnostics: [] })),
        cancelReverseAccept: vi.fn(async () => ({ status: "complete", value: {}, diagnostics: [] })),
        recoverDeployment: vi.fn(async () => ({
            status: "complete",
            value: deployment("in_sync"),
            diagnostics: [],
        })),
        deploy: vi.fn(async () => ({ status: "complete", value: deployment("in_sync"), diagnostics: [] })),
        subscribeInvalidation: vi.fn(() => () => undefined),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
}

function createController(client: DesktopApplicationClientApi): CatalogDeploymentController {
    let action = 0;
    return new CatalogDeploymentController(client, { createUserActionId: () => `user-action-${++action}` });
}

async function inspectConflict(controller: CatalogDeploymentController): Promise<void> {
    await controller.load();
    await controller.inspect(DEPLOYMENT_ID);
    expect(controller.state).toMatchObject({ inspection: { status: "ready", value: INSPECTION } });
}

function directState(
    overrides: Partial<Extract<CatalogDeploymentState, { readonly status: "ready" }>> = {},
): Extract<CatalogDeploymentState, { readonly status: "ready" }> {
    return {
        status: "ready",
        projects: [],
        assets: [],
        deployments: [deployment()],
        assetUsage: { status: "none" },
        assetDetail: { status: "none" },
        analysis: { status: "none" },
        preview: { status: "none" },
        inspection: { status: "ready", value: INSPECTION, detail: { status: "none" } },
        reverse: { status: "none" },
        activity: { status: "idle" },
        stale: false,
        requiresReconciliation: false,
        message: undefined,
        diagnostics: [],
        ...overrides,
    };
}

function directHarness(
    client: DesktopApplicationClientApi,
    initial: Extract<CatalogDeploymentState, { readonly status: "ready" }> = directState(),
): {
    readonly controller: CatalogDeploymentReverseController;
    readonly state: () => Extract<CatalogDeploymentState, { readonly status: "ready" }>;
} {
    let state = initial;
    let generation = 0;
    return {
        controller: new CatalogDeploymentReverseController({
            client,
            current: () => state,
            transition: (next) => {
                if (next.status === "ready") state = next;
            },
            nextGeneration: () => ++generation,
            isCurrentGeneration: (candidate) => candidate === generation,
            createUserActionId: () => "direct-user-action",
        }),
        state: () => state,
    };
}

function warning(message: string) {
    return {
        severity: "warning" as const,
        code: "desktop.reverse.test",
        operation: "reverse_accept" as const,
        causeKind: "conflict" as const,
        retryable: false,
        suggestedActions: [],
        message,
    };
}

function emitReverseProgress(
    operation: "reverse_accept.prepare" | "reverse_accept.commit" | "reverse_accept.cancel",
    listener: ((update: unknown) => void) | undefined,
): void {
    listener?.({ status: "accepted", operation, operationId: `${operation}-1` });
    listener?.({
        status: "progress",
        operation,
        operationId: `${operation}-1`,
        sequence: 1,
        progress: { stage: `${operation}.running`, completedUnits: 1, totalUnits: 2 },
    });
}

afterEach(cleanup);

describe("Desktop reverse acceptance and managed-conflict authority", () => {
    it("refuses outer Deployment actions that do not have current Core authority", async () => {
        const client = reverseClient();
        const controller = createController(client);

        await controller.analyze(DEPLOYMENT_ID);
        await controller.overwritePreview();
        await controller.inspect(DEPLOYMENT_ID);
        await controller.recover(DEPLOYMENT_ID);
        expect(client.analyzeDeployment).not.toHaveBeenCalled();
        expect(client.deploy).not.toHaveBeenCalled();

        await controller.load();
        await controller.analyze(DEPLOYMENT_ID);
        await controller.preview(DEPLOYMENT_ID, [
            {
                semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                optionFingerprint: OPTION_FINGERPRINT,
                approved: false,
            },
        ]);
        await controller.deployPreview("apply");
        expect(client.deploy).not.toHaveBeenCalled();
    });

    it("prepares from the exact inspection and commits only after explicit promotion confirmation", async () => {
        const client = reverseClient({
            listDeployments: vi
                .fn()
                .mockResolvedValueOnce({
                    status: "complete",
                    value: { deployments: [deployment()] },
                    diagnostics: [warning("Prior scan warning.")],
                })
                .mockResolvedValue({ status: "complete", value: { deployments: [deployment("in_sync")] }, diagnostics: [] }),
        });
        const controller = createController(client);
        await controller.load();
        await controller.analyze(DEPLOYMENT_ID);
        await controller.preview(DEPLOYMENT_ID, [
            {
                semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                optionFingerprint: OPTION_FINGERPRINT,
                approved: false,
            },
        ]);
        expect(controller.state).toMatchObject({
            preview: { status: "ready", value: { actionState: "blocked_managed_conflict" } },
        });
        await controller.inspect(DEPLOYMENT_ID);

        await controller.prepareReverse();
        expect(client.prepareReverseAccept).toHaveBeenCalledWith(
            {
                deploymentId: DEPLOYMENT_ID,
                inspectionToken: "inspection-token",
                inspectionResultFingerprint: INSPECTION.inspectionResultFingerprint,
            },
            expect.any(Function),
        );
        expect(controller.state).toMatchObject({
            analysis: { status: "none" },
            inspection: { status: "none" },
            preview: { status: "none" },
            reverse: { status: "prepared", value: PREPARED_REVERSE },
            diagnostics: [],
        });

        const selection = [
            {
                semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                optionFingerprint: OPTION_FINGERPRINT,
                approved: false,
            },
        ];
        await controller.commitReverse(selection, false);
        expect(client.commitReverseAccept).not.toHaveBeenCalled();
        expect(controller.state).toMatchObject({
            reverse: {
                status: "prepared",
                message: localizedText("catalog.reverse.promotion_confirmation_required"),
            },
        });

        await controller.commitReverse(selection, true);
        expect(client.commitReverseAccept).toHaveBeenCalledWith(
            {
                preparationId: PREPARED_REVERSE.preparationId,
                expectedPreparationRevision: PREPARED_REVERSE.preparationRevision,
                userActionId: "user-action-2",
                newVersionPromotion: "grant_staged_version_current_target",
                renderSelection: {
                    schemaVersion: 1,
                    renderInputFingerprint: SEMANTIC_FINGERPRINT,
                    semanticOptions: [{ optionFingerprint: OPTION_FINGERPRINT, approval: { action: "none" } }],
                },
            },
            expect.any(Function),
        );
        expect(controller.state).toMatchObject({
            preview: { status: "none" },
            reverse: { status: "result", value: COMMITTED_REVERSE },
            stale: false,
            requiresReconciliation: false,
            message: undefined,
            diagnostics: [],
        });

        // The normal committed result has already completed its Core retirement.
        await controller.recover(DEPLOYMENT_ID);
        expect(client.recoverDeployment).not.toHaveBeenCalled();
        expect(controller.state).toMatchObject({
            reverse: { status: "result", value: COMMITTED_REVERSE, reviewedFilePaths: ["CLAUDE.md", "bin/helper"] },
            stale: false,
            requiresReconciliation: false,
            deployments: [{ deploymentId: DEPLOYMENT_ID, stage: "in_sync" }],
        });
    });

    it("recovers from the durable Core hint after renderer-local reverse state is lost", async () => {
        const recoverDeployment = vi.fn(async () => ({
            status: "complete" as const,
            value: deployment("in_sync"),
            diagnostics: [],
        }));
        const client = reverseClient({
            listDeployments: vi.fn(async () => ({
                status: "complete",
                value: {
                    deployments: [
                        {
                            ...deployment("blocked"),
                            reason: "blocked_by_recovery_state_unavailable",
                            actionHints: ["recover"],
                        },
                    ],
                },
                diagnostics: [],
            })),
            recoverDeployment,
        });
        const controller = createController(client);

        await controller.load();
        expect(controller.state).toMatchObject({
            reverse: { status: "none" },
            deployments: [{ stage: "blocked", actionHints: ["recover"] }],
        });
        await controller.recover(DEPLOYMENT_ID);

        expect(recoverDeployment).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }, expect.any(Function));
        expect(controller.state).toMatchObject({
            reverse: { status: "none" },
            deployments: [{ stage: "in_sync" }],
            stale: false,
            requiresReconciliation: false,
        });
    });

    it("cancels the exact retained preparation without inventing a new identity", async () => {
        const client = reverseClient();
        const controller = createController(client);
        await inspectConflict(controller);
        await controller.prepareReverse();
        await controller.cancelReverse();

        expect(client.cancelReverseAccept).toHaveBeenCalledWith(
            {
                preparationId: PREPARED_REVERSE.preparationId,
                expectedPreparationRevision: PREPARED_REVERSE.preparationRevision,
            },
            expect.any(Function),
        );
        expect(controller.state).toMatchObject({ reverse: { status: "none" }, stale: false });
    });

    it("marks an uncertain reverse commit for reconciliation and never retries it blindly", async () => {
        const uncertain = new ClientTransportError(
            "uncertain",
            "reverse_accept.commit",
            "request-1",
            "connection lost",
            new Error("closed"),
        );
        const commitReverseAccept = vi.fn(async () => Promise.reject(uncertain));
        const client = reverseClient({ commitReverseAccept });
        const controller = createController(client);
        await inspectConflict(controller);
        await controller.prepareReverse();
        await controller.commitReverse(
            [
                {
                    semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                    optionFingerprint: OPTION_FINGERPRINT,
                    approved: false,
                },
            ],
            true,
        );

        expect(commitReverseAccept).toHaveBeenCalledTimes(1);
        expect(controller.state).toMatchObject({
            reverse: { status: "failed" },
            stale: true,
            requiresReconciliation: true,
        });
    });

    it("binds a one-time managed overwrite to the current preview without requiring an inspection", async () => {
        const client = reverseClient();
        const controller = createController(client);
        await controller.load();
        await controller.analyze(DEPLOYMENT_ID);
        await controller.preview(DEPLOYMENT_ID, [
            {
                semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                optionFingerprint: OPTION_FINGERPRINT,
                approved: false,
            },
        ]);
        await controller.overwritePreview();

        expect(client.inspectRenderedTarget).not.toHaveBeenCalled();
        expect(client.deploy).toHaveBeenCalledWith(
            {
                previewToken: RENDER_PREVIEW.previewToken,
                deploymentAction: "overwrite_runtime",
                userActionId: "user-action-2",
            },
            expect.any(Function),
        );
    });

    it("summarizes passive reverse semantics once and still requires promotion approval and honors stale cancellation", () => {
        const firstSemantic = RENDER_ANALYSIS.semantics[0];
        const firstOption = RENDER_ANALYSIS.options[0];
        if (firstSemantic === undefined || firstOption === undefined) throw new Error("render fixtures are required");
        const secondSemantic = {
            ...firstSemantic,
            semanticRefFingerprint: "d".repeat(64),
            semanticKind: "guidance.base_context" as const,
        };
        const secondOption = {
            ...firstOption,
            semanticRefFingerprint: secondSemantic.semanticRefFingerprint,
            optionFingerprint: "e".repeat(64),
        };
        const controller = {
            commitReverse: vi.fn(async () => undefined),
            cancelReverse: vi.fn(async () => undefined),
        } as unknown as CatalogDeploymentController;
        const props = {
            controller,
            reverse: {
                status: "prepared" as const,
                value: {
                    ...PREPARED_REVERSE,
                    renderAnalysis: {
                        ...RENDER_ANALYSIS,
                        semantics: [firstSemantic, secondSemantic],
                        options: [firstOption, secondOption],
                    },
                },
            },
            busy: false,
            stale: false,
            providers: DEPLOYMENT_PROVIDERS,
        };
        const view = renderWithPresentation(createElement(CatalogReverseReview, props));
        expect(screen.getAllByText("Future edit handling: Future edits can be attributed and reviewed")).toHaveLength(1);
        expect(screen.getByText("Instructions")).toBeTruthy();
        expect(screen.getByText("Project context")).toBeTruthy();
        expect(screen.queryByRole("radio", { name: /Native file/u })).toBeNull();
        const commit = screen.getByRole("button", { name: "Keep as a new library version" }) as HTMLButtonElement;
        expect(commit.disabled).toBe(true);
        fireEvent.click(screen.getByLabelText(/Allow this tool setup to select this exact new Asset Version/u));
        expect(commit.disabled).toBe(false);
        fireEvent.click(commit);
        expect(controller.commitReverse).toHaveBeenCalledWith(
            [
                {
                    semanticRefFingerprint: firstSemantic.semanticRefFingerprint,
                    optionFingerprint: firstOption.optionFingerprint,
                    approved: false,
                },
                {
                    semanticRefFingerprint: secondSemantic.semanticRefFingerprint,
                    optionFingerprint: secondOption.optionFingerprint,
                    approved: false,
                },
            ],
            true,
        );
        view.rerender(createElement(CatalogReverseReview, { ...props, stale: true }));
        expect((screen.getByRole("button", { name: "Keep as a new library version" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Cancel without saving" }));
        expect(controller.cancelReverse).toHaveBeenCalledOnce();
        expect(controller.commitReverse).toHaveBeenCalledOnce();
    });

    it("keeps reverse render selection and promotion confirmation visible in the review UI", () => {
        const controller = {
            commitReverse: vi.fn(async () => undefined),
            cancelReverse: vi.fn(async () => undefined),
        } as unknown as CatalogDeploymentController;
        const view = renderWithPresentation(
            createElement(CatalogReverseReview, {
                controller,
                reverse: { status: "prepared", value: PREPARED_REVERSE },
                busy: false,
                stale: false,
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        expect(screen.getByText("Review changes from the tool")).toBeTruthy();
        expect(screen.getByText("Instructions")).toBeTruthy();
        const commit = screen.getByRole("button", { name: "Keep as a new library version" }) as HTMLButtonElement;
        expect(commit.getAttribute("data-oaam-deployment-action")).toBe("reverse.commit");
        expect(commit.disabled).toBe(true);
        fireEvent.click(screen.getByRole("radio", { name: /Native file/u }));
        expect(commit.disabled).toBe(true);
        fireEvent.click(screen.getByRole("radio", { name: /Inline content/u }));
        fireEvent.click(screen.getByLabelText("Approve this degraded render once"));
        fireEvent.click(screen.getByRole("radio", { name: /Native file/u }));
        fireEvent.click(screen.getByLabelText(/Allow this tool setup to select this exact new Asset Version/u));
        expect(commit.disabled).toBe(false);
        fireEvent.click(commit);
        expect(controller.commitReverse).toHaveBeenCalledWith(
            [
                {
                    semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                    optionFingerprint: OPTION_FINGERPRINT,
                    approved: false,
                },
            ],
            true,
        );
        const cancel = screen.getByRole("button", { name: "Cancel without saving" });
        expect(cancel.getAttribute("data-oaam-deployment-action")).toBe("reverse.cancel");
        fireEvent.click(cancel);
        expect(controller.cancelReverse).toHaveBeenCalled();
        view.unmount();

        renderWithPresentation(
            createElement(CatalogReverseReview, {
                controller,
                reverse: {
                    status: "result",
                    deploymentId: DEPLOYMENT_ID,
                    value: {
                        commitState: "not_committed",
                        versionPublicationState: "published_not_selected",
                        version: {
                            assetId: "22222222-2222-4222-8222-222222222222",
                            versionId: "77777777-7777-4777-8777-777777777777",
                        },
                    },
                },
                busy: false,
                stale: true,
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        expect(screen.getByText(/was published, but this tool setup/u)).toBeTruthy();
    });

    it("keeps prepare outcomes, warnings and transport uncertainty distinct", async () => {
        const notPrepared = directHarness(
            reverseClient({
                prepareReverseAccept: vi.fn(async (_params, listener) => {
                    emitReverseProgress("reverse_accept.prepare", listener);
                    return {
                        status: "failed",
                        value: { preparationState: "not_prepared" },
                        diagnostics: [warning("Preparation warning.")],
                    };
                }),
            }),
        );
        await notPrepared.controller.prepare();
        expect(notPrepared.state()).toMatchObject({
            inspection: { status: "ready" },
            reverse: { status: "not_prepared", message: localizedText("catalog.reverse.not_prepared") },
            activity: { status: "idle" },
            diagnostics: [warning("Preparation warning.")],
        });

        const rejected = directHarness(
            reverseClient({
                prepareReverseAccept: vi.fn(async () => ({ status: "failed", diagnostics: [] })),
            }),
        );
        await rejected.controller.prepare();
        expect(rejected.state()).toMatchObject({
            reverse: { status: "failed", message: localizedText("catalog.reverse.prepare_failed") },
            stale: true,
            requiresReconciliation: true,
        });

        const interrupted = directHarness(
            reverseClient({ prepareReverseAccept: vi.fn(async () => Promise.reject(new Error("closed"))) }),
        );
        await interrupted.controller.prepare();
        expect(interrupted.state()).toMatchObject({
            inspection: { status: "ready" },
            reverse: {
                status: "failed",
                message: localizedText("catalog.operation.interrupted", {
                    operation: localizedText("catalog.activity.reverse_prepare"),
                }),
            },
            stale: false,
            requiresReconciliation: false,
        });

        const uncertain = directHarness(
            reverseClient({
                prepareReverseAccept: vi.fn(async () =>
                    Promise.reject(
                        new ClientTransportError("uncertain", "reverse_accept.prepare", "request-2", "lost", new Error("closed")),
                    ),
                ),
            }),
        );
        await uncertain.controller.prepare();
        expect(uncertain.state()).toMatchObject({
            inspection: { status: "none" },
            reverse: { status: "failed" },
            stale: true,
            requiresReconciliation: true,
        });
    });

    it("projects every definitive reverse commit outcome without calling it generic success", async () => {
        const cases = [
            {
                status: "failed" as const,
                value: { commitState: "not_committed", versionPublicationState: "not_published" } as const,
            },
            {
                status: "partial" as const,
                value: {
                    commitState: "not_committed",
                    versionPublicationState: "published_not_selected",
                    version: {
                        assetId: "22222222-2222-4222-8222-222222222222",
                        versionId: "77777777-7777-4777-8777-777777777777",
                    },
                } as const,
            },
            {
                status: "failed" as const,
                value: { commitState: "recovery_required", reasonCode: "durability_unconfirmed" } as const,
            },
            {
                status: "failed" as const,
                value: { commitState: "outcome_unavailable" } as const,
            },
        ];
        for (const scenario of cases) {
            const commitReverseAccept = vi.fn(async (_params, listener) => {
                emitReverseProgress("reverse_accept.commit", listener);
                return { status: scenario.status, value: scenario.value, diagnostics: [warning("Commit warning.")] };
            });
            const harness = directHarness(
                reverseClient({ commitReverseAccept }),
                directState({
                    inspection: { status: "none" },
                    reverse: {
                        status: "prepared",
                        value: { ...PREPARED_REVERSE, promotionState: "already_authorized" },
                    },
                }),
            );
            await harness.controller.commit(
                [
                    {
                        semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                        optionFingerprint: OPTION_FINGERPRINT,
                        approved: false,
                    },
                ],
                false,
            );
            expect(commitReverseAccept).toHaveBeenCalledWith(
                expect.objectContaining({ newVersionPromotion: "use_existing_authority" }),
                expect.any(Function),
            );
            expect(harness.state()).toMatchObject({
                reverse: { status: "result", value: scenario.value },
                message: undefined,
                stale: true,
                requiresReconciliation: true,
                diagnostics: [warning("Commit warning.")],
            });
        }
    });

    it("preserves exact preparation truth across rejected and interrupted commit or cancel", async () => {
        const invalidSelection = directHarness(
            reverseClient(),
            directState({ inspection: { status: "none" }, reverse: { status: "prepared", value: PREPARED_REVERSE } }),
        );
        await invalidSelection.controller.commit([], true);
        expect(invalidSelection.state()).toMatchObject({
            reverse: { status: "prepared", message: localizedText("catalog.validation.render_missing") },
        });

        const rejectedCommit = directHarness(
            reverseClient({
                commitReverseAccept: vi.fn(async () => ({
                    status: "failed",
                    diagnostics: [{ ...warning("Commit denied."), severity: "error" as const }],
                })),
            }),
            directState({ inspection: { status: "none" }, reverse: { status: "prepared", value: PREPARED_REVERSE } }),
        );
        await rejectedCommit.controller.commit(
            [
                {
                    semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                    optionFingerprint: OPTION_FINGERPRINT,
                    approved: false,
                },
            ],
            true,
        );
        expect(rejectedCommit.state()).toMatchObject({
            reverse: { status: "failed", message: localizedText("catalog.reverse.commit_failed") },
            diagnostics: [{ ...warning("Commit denied."), severity: "error" }],
            stale: true,
            requiresReconciliation: true,
        });

        const rejectedCancel = directHarness(
            reverseClient({
                cancelReverseAccept: vi.fn(async (_params, listener) => {
                    emitReverseProgress("reverse_accept.cancel", listener);
                    return { status: "failed", diagnostics: [] };
                }),
            }),
            directState({ inspection: { status: "none" }, reverse: { status: "prepared", value: PREPARED_REVERSE } }),
        );
        await rejectedCancel.controller.cancel();
        expect(rejectedCancel.state()).toMatchObject({
            reverse: { status: "prepared", message: localizedText("catalog.reverse.cancel_failed") },
            activity: { status: "idle" },
        });

        const interruptedCancel = directHarness(
            reverseClient({ cancelReverseAccept: vi.fn(async () => Promise.reject(new Error("closed"))) }),
            directState({ inspection: { status: "none" }, reverse: { status: "prepared", value: PREPARED_REVERSE } }),
        );
        await interruptedCancel.controller.cancel();
        expect(interruptedCancel.state()).toMatchObject({
            reverse: { status: "failed" },
            stale: false,
            requiresReconciliation: false,
        });

        const uncertainCancel = directHarness(
            reverseClient({
                cancelReverseAccept: vi.fn(async () =>
                    Promise.reject(
                        new ClientProtocolFaultError(
                            "uncertain",
                            "reverse_accept.cancel",
                            "request-3",
                            new Error("invalid response"),
                        ),
                    ),
                ),
            }),
            directState({ inspection: { status: "none" }, reverse: { status: "prepared", value: PREPARED_REVERSE } }),
        );
        await uncertainCancel.controller.cancel();
        expect(uncertainCancel.state()).toMatchObject({
            reverse: { status: "failed" },
            stale: true,
            requiresReconciliation: true,
        });
    });

    it("refuses unreachable reverse actions and identifies every retained reverse state", async () => {
        const noHint = directHarness(reverseClient(), directState({ deployments: [deployment("in_sync")] }));
        await noHint.controller.prepare();
        expect(noHint.state().reverse).toEqual({ status: "none" });
        await noHint.controller.commit([], false);
        await noHint.controller.cancel();

        expect(reverseDeploymentId({ status: "none" })).toBeUndefined();
        expect(reverseDeploymentId({ status: "preparing", deploymentId: DEPLOYMENT_ID })).toBe(DEPLOYMENT_ID);
        expect(reverseDeploymentId({ status: "prepared", value: PREPARED_REVERSE })).toBe(DEPLOYMENT_ID);
        expect(
            reverseDeploymentId({
                status: "not_prepared",
                deploymentId: DEPLOYMENT_ID,
                message: localizedText("catalog.reverse.not_prepared"),
            }),
        ).toBe(DEPLOYMENT_ID);
        expect(reverseDeploymentId({ status: "result", deploymentId: DEPLOYMENT_ID, value: COMMITTED_REVERSE })).toBe(
            DEPLOYMENT_ID,
        );
        expect(
            reverseDeploymentId({
                status: "failed",
                deploymentId: DEPLOYMENT_ID,
                message: localizedText("catalog.reverse.commit_failed"),
            }),
        ).toBe(DEPLOYMENT_ID);
    });

    it("renders non-prepared, failed, recovery and blocked reverse states explicitly", () => {
        const controller = {
            commitReverse: vi.fn(async () => undefined),
            cancelReverse: vi.fn(async () => undefined),
        } as unknown as CatalogDeploymentController;
        const states = [
            {
                reverse: { status: "preparing", deploymentId: DEPLOYMENT_ID } as const,
                text: "Preparing the exact inspected changes for review…",
            },
            {
                reverse: {
                    status: "not_prepared",
                    deploymentId: DEPLOYMENT_ID,
                    message: technicalText("Not attributable."),
                } as const,
                text: "Not attributable.",
            },
            {
                reverse: { status: "failed", deploymentId: DEPLOYMENT_ID, message: technicalText("Reverse failed.") } as const,
                text: "Reverse failed.",
            },
            {
                reverse: {
                    status: "result",
                    deploymentId: DEPLOYMENT_ID,
                    value: { commitState: "recovery_required", reasonCode: "durability_unconfirmed" },
                } as const,
                text: "This save needs recovery before another write can be attempted.",
            },
            {
                reverse: {
                    status: "result",
                    deploymentId: DEPLOYMENT_ID,
                    value: { commitState: "outcome_unavailable" },
                } as const,
                text: "OAAM cannot prove whether the changes were saved. Reload the latest saved state.",
            },
            {
                reverse: {
                    status: "result",
                    deploymentId: DEPLOYMENT_ID,
                    value: COMMITTED_REVERSE,
                } as const,
                text: "The new Asset Version was published and selected by this tool setup.",
            },
            {
                reverse: {
                    status: "result",
                    deploymentId: DEPLOYMENT_ID,
                    value: { commitState: "not_committed", versionPublicationState: "not_published" },
                } as const,
                text: "No new Asset Version was published.",
            },
        ];
        for (const scenario of states) {
            const view = renderWithPresentation(
                createElement(CatalogReverseReview, {
                    controller,
                    reverse: scenario.reverse,
                    busy: false,
                    stale: false,
                    providers: DEPLOYMENT_PROVIDERS,
                }),
            );
            expect(screen.getByText(scenario.text)).toBeTruthy();
            view.unmount();
        }

        const blockedAnalysis = {
            ...RENDER_ANALYSIS,
            options: [],
            outputUnits: [],
            blockedSemantics: [
                {
                    semanticRefFingerprint: SEMANTIC_FINGERPRINT,
                    reasonCode: "target_unsupported",
                    diagnostics: [],
                },
            ],
        };
        renderWithPresentation(
            createElement(CatalogReverseReview, {
                controller,
                reverse: { status: "prepared", value: { ...PREPARED_REVERSE, renderAnalysis: blockedAnalysis } },
                busy: false,
                stale: false,
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        expect(screen.getByText("This part cannot be rendered safely.")).toBeTruthy();
        expect(screen.queryByText("target_unsupported")).toBeNull();
        fireEvent.click(screen.getByText("Technical details"));
        expect(screen.getByText(/target_unsupported/u)).toBeTruthy();
    });
});
