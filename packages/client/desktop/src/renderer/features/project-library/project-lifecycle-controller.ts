import type { ProtocolDiagnosticV1, ProtocolOperationName } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import {
    localizedText,
    nonInformationalProtocolDiagnostics,
    protocolFeedback,
    type DesktopDisplayText,
    type ProtocolFeedback,
} from "../../presentation";
import {
    latestAvailableLifecycleBackup,
    type ProjectLifecycleBackupChoice,
    type ProjectLifecycleFlowState,
    type ProjectLifecycleInspectParams,
    type ProjectLifecycleReviewContext,
    requiresPreDestructiveBackup,
} from "./project-lifecycle-model";

function outcomeFeedback(diagnostics: readonly ProtocolDiagnosticV1[], fallback: DesktopDisplayText): ProtocolFeedback {
    return protocolFeedback(fallback, diagnostics);
}

export class ProjectLifecycleController {
    readonly #client: DesktopApplicationClientApi;
    readonly #listeners = new Set<(state: ProjectLifecycleFlowState) => void>();
    #state: ProjectLifecycleFlowState = Object.freeze({ status: "idle" });
    #generation = 0;

    public constructor(client: DesktopApplicationClientApi) {
        this.#client = client;
    }

    public get state(): ProjectLifecycleFlowState {
        return this.#state;
    }

    public subscribe(listener: (state: ProjectLifecycleFlowState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => this.#listeners.delete(listener);
    }

    public dispose(): void {
        this.#generation += 1;
        this.#listeners.clear();
    }

    public close(): void {
        if (this.#state.status === "review" && this.#state.busyStage !== undefined) return;
        this.#generation += 1;
        this.#transition(Object.freeze({ status: "idle" }));
    }

    public async inspect(params: ProjectLifecycleInspectParams): Promise<void> {
        const generation = ++this.#generation;
        if (!this.#supports(["project_lifecycle.inspect", "project_lifecycle.commit"])) {
            this.#fail(localizedText("project_lifecycle.unavailable"));
            return;
        }
        this.#transition(Object.freeze({ status: "inspecting", action: params.action }));
        try {
            const inspected = await this.#client.inspectProjectLifecycle(params);
            if (generation !== this.#generation) return;
            if (inspected.status === "failed") {
                this.#fail(localizedText("project_lifecycle.inspect_failed"), inspected.diagnostics);
                return;
            }
            const review = inspected.value;
            const reviewDiagnostics: ProtocolDiagnosticV1[] = [...inspected.diagnostics];
            let deployments: ProjectLifecycleReviewContext["deployments"] = Object.freeze([]);
            if (review.action === "rebind") {
                if (!this.#supports(["deployment.list"])) {
                    this.#fail(localizedText("project_lifecycle.deployment_attention_unavailable"));
                    return;
                }
                const listed = await this.#client.listDeployments({
                    subject: { subjectKind: "project", projectId: review.projectId },
                });
                if (generation !== this.#generation) return;
                if (listed.status === "failed") {
                    this.#fail(localizedText("project_lifecycle.deployment_attention_unavailable"), listed.diagnostics);
                    return;
                }
                reviewDiagnostics.push(...listed.diagnostics);
                deployments = Object.freeze(listed.value.deployments.filter((deployment) => !deployment.deleted));
            }
            let backupPolicy: ProjectLifecycleReviewContext["backupPolicy"];
            let latestBackup: ProjectLifecycleReviewContext["latestBackup"];
            if (requiresPreDestructiveBackup(review.action)) {
                if (
                    !this.#supports([
                        "state_backup.list",
                        "state_backup_prompt_policy.get",
                        "state_backup_prompt_policy.replace",
                        "state_backup.inspect",
                        "state_backup.create",
                    ])
                ) {
                    this.#fail(localizedText("project_lifecycle.backup_gate_unavailable"));
                    return;
                }
                const [policy, inventory] = await Promise.all([
                    this.#client.getStateBackupPromptPolicy(),
                    this.#client.listStateBackups(),
                ]);
                if (generation !== this.#generation) return;
                if (policy.status === "failed") {
                    this.#fail(localizedText("project_lifecycle.backup_gate_unavailable"), policy.diagnostics);
                    return;
                }
                if (inventory.status === "failed") {
                    this.#fail(localizedText("project_lifecycle.backup_gate_unavailable"), inventory.diagnostics);
                    return;
                }
                reviewDiagnostics.push(...policy.diagnostics, ...inventory.diagnostics);
                backupPolicy = policy.value;
                latestBackup = latestAvailableLifecycleBackup(inventory.value.entries);
            }
            this.#transition(
                Object.freeze({
                    status: "review",
                    context: Object.freeze({ review, deployments, backupPolicy, latestBackup }),
                    busyStage: undefined,
                    message: undefined,
                    diagnostics: nonInformationalProtocolDiagnostics(reviewDiagnostics),
                }),
            );
        } catch {
            if (generation === this.#generation) {
                this.#fail(localizedText("project_lifecycle.inspect_interrupted"));
            }
        }
    }

    public async commit(choice?: ProjectLifecycleBackupChoice, rememberChoice = false): Promise<void> {
        if (this.#state.status !== "review" || this.#state.busyStage !== undefined) return;
        const generation = ++this.#generation;
        const { context } = this.#state;
        const policy = context.backupPolicy;
        const effectiveChoice =
            policy === undefined
                ? "continue_without_backup"
                : policy.mode === "back_up_first"
                  ? "back_up_then_continue"
                  : policy.mode === "continue_without_prompt"
                    ? "continue_without_backup"
                    : choice;
        if (effectiveChoice === undefined) return;
        try {
            if (effectiveChoice === "back_up_then_continue") {
                this.#setBusy(context, "backup");
                const inspected = await this.#client.inspectStateBackup({
                    destination: { destinationKind: "oaam_default" },
                    encryptionMode: "none",
                });
                if (generation !== this.#generation) return;
                if (inspected.status === "failed") {
                    this.#setReviewFailure(
                        context,
                        outcomeFeedback(inspected.diagnostics, localizedText("project_lifecycle.backup_failed")),
                    );
                    return;
                }
                const created = await this.#client.createStateBackup({
                    backupReviewToken: inspected.value.backupReviewToken,
                    userActionId: globalThis.crypto.randomUUID(),
                });
                if (generation !== this.#generation) return;
                if (created.status === "failed") {
                    this.#setReviewFailure(
                        context,
                        outcomeFeedback(created.diagnostics, localizedText("project_lifecycle.backup_failed")),
                    );
                    return;
                }
            }
            if (policy?.mode === "ask_every_time" && rememberChoice) {
                this.#setBusy(context, "policy");
                const replaced = await this.#client.replaceStateBackupPromptPolicy({
                    expectedRevision: policy.revision,
                    expectedSettingFingerprint: policy.settingFingerprint,
                    mode: effectiveChoice === "back_up_then_continue" ? "back_up_first" : "continue_without_prompt",
                    userActionId: globalThis.crypto.randomUUID(),
                });
                if (generation !== this.#generation) return;
                if (replaced.status === "failed") {
                    this.#setReviewFailure(
                        context,
                        outcomeFeedback(replaced.diagnostics, localizedText("project_lifecycle.policy_failed")),
                    );
                    return;
                }
            }
            this.#setBusy(context, "commit");
            const committed = await this.#client.commitProjectLifecycle({
                projectLifecycleReviewToken: context.review.projectLifecycleReviewToken,
                userActionId: globalThis.crypto.randomUUID(),
            });
            if (generation !== this.#generation) return;
            if (committed.status === "failed") {
                this.#setReviewFailure(
                    context,
                    outcomeFeedback(committed.diagnostics, localizedText("project_lifecycle.commit_failed")),
                );
                return;
            }
            this.#transition(Object.freeze({ status: "succeeded", context, project: committed.value }));
        } catch {
            if (generation === this.#generation) {
                this.#setReviewFailure(context, protocolFeedback(localizedText("project_lifecycle.commit_interrupted")));
            }
        }
    }

    #supports(operations: readonly ProtocolOperationName[]): boolean {
        return operations.every((operation) => this.#client.supportsOperation(operation));
    }

    #setBusy(context: ProjectLifecycleReviewContext, busyStage: "backup" | "policy" | "commit"): void {
        const diagnostics = this.#state.status === "review" ? this.#state.diagnostics : Object.freeze([]);
        this.#transition(Object.freeze({ status: "review", context, busyStage, message: undefined, diagnostics }));
    }

    #setReviewFailure(context: ProjectLifecycleReviewContext, feedback: ProtocolFeedback): void {
        const currentDiagnostics = this.#state.status === "review" ? this.#state.diagnostics : Object.freeze([]);
        this.#transition(
            Object.freeze({
                status: "review",
                context,
                busyStage: undefined,
                message: feedback.message,
                diagnostics: nonInformationalProtocolDiagnostics([...currentDiagnostics, ...feedback.diagnostics]),
            }),
        );
    }

    #fail(message: DesktopDisplayText, diagnostics: readonly ProtocolDiagnosticV1[] = []): void {
        this.#transition(
            Object.freeze({
                status: "failed",
                message,
                diagnostics: nonInformationalProtocolDiagnostics(diagnostics),
            }),
        );
    }

    #transition(state: ProjectLifecycleFlowState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
