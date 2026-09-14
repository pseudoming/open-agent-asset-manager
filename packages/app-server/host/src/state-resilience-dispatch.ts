import {
    createProtocolResultResponse,
    parseProtocolOperationResult,
    type ProtocolAcceptedLongOperationName,
    type ProtocolOperationName,
    type ProtocolRequestV1,
    type ProtocolResponseEnvelopeV1,
} from "@oaam/app-server-protocol";
import type { CoreService, OperationDiagnostic, StateBackupInventoryEntryV1, StateRestorePreparationV1 } from "@oaam/core";
import {
    hostInvocationFailure,
    hostPathSelectionFailure,
    hostReviewCapacityFailure,
    hostReviewFailure,
    projectCoreOutcome,
    projectDiagnostic,
    toCoreSha256,
} from "./core-outcome";
import type { OperationRunContext } from "./operation-manager";
import type { HostPathSelectionStore } from "./path-selection-store";
import { HostReviewRecordCapacityError } from "./review-record-store";
import { HostReviewRecordUnavailableError, type HostReviewRecords } from "./review-records";
import {
    projectStateBackupArtifact,
    projectStateBackupInventory,
    projectStateBackupPreparation,
    projectStateBackupPromptPolicy,
    projectStateRestoreActivation,
    projectStateRestorePreparation,
} from "./state-resilience-projection";
import type { HostStateResilienceIntegration } from "./types";

export const HOST_STATE_RESILIENCE_IMMEDIATE_OPERATIONS = Object.freeze([
    "state_backup.list",
    "state_backup_prompt_policy.get",
    "state_backup_prompt_policy.replace",
] as const satisfies readonly ProtocolOperationName[]);

export const HOST_STATE_RESILIENCE_LONG_OPERATIONS = Object.freeze([
    "state_backup.inspect",
    "state_backup.create",
    "state_restore.inspect",
    "state_restore.activate",
] as const satisfies readonly ProtocolAcceptedLongOperationName[]);

type ImmediateStateResilienceOperation = (typeof HOST_STATE_RESILIENCE_IMMEDIATE_OPERATIONS)[number];
type LongStateResilienceOperation = (typeof HOST_STATE_RESILIENCE_LONG_OPERATIONS)[number];
export type ImmediateStateResilienceRequest = Extract<ProtocolRequestV1, { readonly method: ImmediateStateResilienceOperation }>;
export type LongStateResilienceRequest = Extract<ProtocolRequestV1, { readonly method: LongStateResilienceOperation }>;

export interface HostStateResilienceDispatchContext {
    readonly connectionId: string;
    readonly pathSelections: HostPathSelectionStore;
    readonly reviews: HostReviewRecords;
    readonly integration: HostStateResilienceIntegration;
    readonly operation: OperationRunContext;
    beginExclusiveRestore(operationId: string): Promise<void>;
}

function immediateOutcome(
    id: string,
    operation: ImmediateStateResilienceOperation,
    outcome: unknown,
): ProtocolResponseEnvelopeV1 {
    return createProtocolResultResponse(id, operation, parseProtocolOperationResult(operation, outcome));
}

export function isStateResilienceImmediateOperation(
    operation: ProtocolOperationName,
): operation is ImmediateStateResilienceOperation {
    return HOST_STATE_RESILIENCE_IMMEDIATE_OPERATIONS.includes(operation as ImmediateStateResilienceOperation);
}

export function isStateResilienceLongOperation(operation: ProtocolOperationName): operation is LongStateResilienceOperation {
    return HOST_STATE_RESILIENCE_LONG_OPERATIONS.includes(operation as LongStateResilienceOperation);
}

export function dispatchStateResilienceImmediate(
    core: CoreService,
    request: ImmediateStateResilienceRequest,
): ProtocolResponseEnvelopeV1 {
    try {
        switch (request.method) {
            case "state_backup.list":
                return immediateOutcome(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.listStateBackups(), projectStateBackupInventory),
                );
            case "state_backup_prompt_policy.get":
                return immediateOutcome(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.getStateBackupPromptPolicy(), projectStateBackupPromptPolicy),
                );
            case "state_backup_prompt_policy.replace":
                return immediateOutcome(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.replaceStateBackupPromptPolicy({
                            expectedRevision: request.params.expectedRevision,
                            expectedSettingFingerprint: toCoreSha256(request.params.expectedSettingFingerprint),
                            mode: request.params.mode,
                            userActionId: request.params.userActionId,
                        }),
                        projectStateBackupPromptPolicy,
                    ),
                );
        }
    } catch {
        return immediateOutcome(request.id, request.method, hostInvocationFailure());
    }
}

export async function dispatchStateResilienceLong(
    core: CoreService | undefined,
    request: LongStateResilienceRequest,
    context: HostStateResilienceDispatchContext,
): Promise<unknown> {
    try {
        switch (request.method) {
            case "state_backup.inspect": {
                if (core === undefined) return unavailableBackup();
                const destination =
                    request.params.destination.destinationKind === "oaam_default"
                        ? ({ destinationKind: "oaam_default" } as const)
                        : resolveCustomBackupDestination(
                              context.pathSelections,
                              request.params.destination.localPathSelectionToken,
                          );
                if ("status" in destination) return destination;
                const desktopPreferences = await context.integration.readDesktopPreferences();
                const result = core.inspectStateBackup(
                    {
                        destination,
                        encryptionMode: request.params.encryptionMode,
                        ...(desktopPreferences === undefined ? {} : { desktopPreferences }),
                    },
                    { report: context.operation.reportProgress },
                );
                return projectCoreOutcome(result, (preparation) => {
                    const token = context.reviews.recordStateBackup(context.connectionId, preparation);
                    return projectStateBackupPreparation(token, preparation);
                });
            }
            case "state_backup.create": {
                if (core === undefined) return unavailableBackup();
                const preparation = context.reviews.resolveStateBackup(request.params.backupReviewToken);
                const desktopPreferences = await context.integration.readDesktopPreferences();
                const result = await core.createStateBackup(
                    {
                        preparation,
                        ...(desktopPreferences === undefined ? {} : { desktopPreferences }),
                        ...(request.params.password === undefined ? {} : { password: request.params.password }),
                        userActionId: request.params.userActionId,
                    },
                    { report: context.operation.reportProgress },
                );
                if (result.status !== "failed") context.reviews.acceptStateBackup(request.params.backupReviewToken);
                return projectCoreOutcome(result, projectStateBackupArtifact);
            }
            case "state_restore.inspect": {
                context.operation.reportProgress({ stage: "inspection", completedUnits: 0, totalUnits: 1 });
                const source = resolveRestoreArchive(core, request, context);
                if ("status" in source) return source;
                const result = await context.integration.inspectStateRestore({
                    archivePath: source.archivePath,
                    ...(request.params.password === undefined ? {} : { password: request.params.password }),
                });
                context.operation.reportProgress({ stage: "inspection", completedUnits: 1, totalUnits: 1 });
                if (
                    result.status !== "failed" &&
                    source.inventoryEntry !== undefined &&
                    !restorePreparationMatchesInventory(result.value, source.inventoryEntry)
                ) {
                    return unavailableBackup();
                }
                return projectCoreOutcome(result, (preparation) => {
                    const token = context.reviews.recordStateRestore(context.connectionId, preparation);
                    return projectStateRestorePreparation(token, preparation);
                });
            }
            case "state_restore.activate":
                return activateStateRestore(request, context);
        }
    } catch (error) {
        if (error instanceof HostReviewRecordUnavailableError) return hostReviewFailure(error.failureKind);
        if (error instanceof HostReviewRecordCapacityError) return hostReviewCapacityFailure();
        return hostInvocationFailure();
    }
}

interface ResolvedRestoreArchive {
    readonly archivePath: string;
    readonly inventoryEntry?: StateBackupInventoryEntryV1;
}

function resolveRestoreArchive(
    core: CoreService | undefined,
    request: Extract<LongStateResilienceRequest, { readonly method: "state_restore.inspect" }>,
    context: HostStateResilienceDispatchContext,
) {
    const source = request.params.source;
    if (source.sourceKind === "selected_archive") {
        const archivePath = context.pathSelections.consume(source.localPathSelectionToken, "restore_archive");
        return archivePath === null ? hostPathSelectionFailure() : ({ archivePath } satisfies ResolvedRestoreArchive);
    }
    if (core === undefined) return unavailableBackup();
    const inventory = core.listStateBackups();
    if (inventory.status === "failed") {
        return {
            status: "failed",
            diagnostics: inventory.diagnostics.map(projectDiagnostic),
        };
    }
    const selected = inventory.value.entries.find((entry) => entry.backupId === source.backupId);
    return selected?.observation === "available"
        ? ({ archivePath: selected.archivePath, inventoryEntry: selected } satisfies ResolvedRestoreArchive)
        : unavailableBackup();
}

function restorePreparationMatchesInventory(
    preparation: StateRestorePreparationV1,
    inventoryEntry: StateBackupInventoryEntryV1,
): boolean {
    return (
        preparation.archivePath === inventoryEntry.archivePath &&
        preparation.archiveByteSize === inventoryEntry.archiveByteSize &&
        preparation.archiveContentHash === inventoryEntry.archiveContentHash &&
        preparation.backupId === inventoryEntry.backupId &&
        preparation.backupCreatedAt === inventoryEntry.createdAt &&
        preparation.encryptionMode === inventoryEntry.encryptionMode &&
        preparation.sourceSnapshotFingerprint === inventoryEntry.sourceSnapshotFingerprint &&
        preparation.manifestFingerprint === inventoryEntry.manifestFingerprint
    );
}

function resolveCustomBackupDestination(pathSelections: HostPathSelectionStore, token: string) {
    const directoryPath = pathSelections.consume(token, "backup_destination");
    return directoryPath === null
        ? hostPathSelectionFailure()
        : ({ destinationKind: "custom_directory", directoryPath } as const);
}

function unavailableBackup() {
    return {
        status: "failed" as const,
        diagnostics: [
            {
                severity: "error" as const,
                code: "host.state_backup_unavailable",
                operation: "restore" as const,
                causeKind: "not_found" as const,
                retryable: true,
                suggestedActions: ["choose_target"],
                message: "The selected backup is missing, replaced, or no longer belongs to the current inventory.",
            },
        ],
    };
}

async function activateStateRestore(
    request: Extract<LongStateResilienceRequest, { readonly method: "state_restore.activate" }>,
    context: HostStateResilienceDispatchContext,
): Promise<unknown> {
    const preparation = context.reviews.resolveStateRestore(request.params.restoreReviewToken);
    context.operation.reportProgress({ stage: "activation", completedUnits: 0, totalUnits: 1 });
    const result = await context.integration.activateStateRestore(
        {
            preparation,
            ...(request.params.password === undefined ? {} : { password: request.params.password }),
            userActionId: request.params.userActionId,
        },
        {
            async quiesceMutations() {
                context.operation.reportProgress({ stage: "quiescence", completedUnits: 0, totalUnits: 1 });
                await context.beginExclusiveRestore(context.operation.operationId);
                context.operation.afterTerminal(() => context.integration.restoreRequiresHostReplacement());
                context.operation.reportProgress({ stage: "quiescence", completedUnits: 1, totalUnits: 1 });
            },
        },
    );
    if (result.status === "failed") {
        return { status: "failed", diagnostics: result.diagnostics.map(projectDiagnostic) };
    }

    let restoredDesktopPreferences = false;
    let preferenceFailure: OperationDiagnostic | undefined;
    if (result.value.desktopPreferences !== undefined) {
        try {
            await context.integration.applyRestoredDesktopPreferences(
                result.value.desktopPreferences,
                result.value.restoreTransactionPath,
            );
            restoredDesktopPreferences = true;
        } catch {
            preferenceFailure = {
                severity: "warning",
                code: "restore.desktop_preferences_not_applied",
                operation: "restore",
                causeKind: "internal_error",
                retryable: true,
                suggestedActions: ["retry", "contact_support"],
                message: "State authority was restored, but Desktop preferences could not be applied.",
                traceId: "",
                path: "",
                rawSummary: "",
            };
        }
    }
    context.reviews.acceptStateRestore(request.params.restoreReviewToken);
    context.operation.reportProgress({ stage: "activation", completedUnits: 1, totalUnits: 1 });
    context.operation.reportProgress({ stage: "restart_required", completedUnits: 1, totalUnits: 1 });
    const diagnostics = [...result.diagnostics, ...(preferenceFailure === undefined ? [] : [preferenceFailure])].map(
        projectDiagnostic,
    );
    return {
        status: result.status === "partial" || preferenceFailure !== undefined ? "partial" : "complete",
        value: projectStateRestoreActivation(result.value, restoredDesktopPreferences),
        diagnostics,
    };
}
