import type { ProtocolOperationParams, ProtocolOperationResult, ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import { localizedText, type DesktopDisplayText } from "../../presentation";

type TerminalValue<TName extends "import.preview" | "import.accept_batch"> = Extract<
    ProtocolOperationTerminal<TName>,
    { readonly value: unknown }
>["value"];
type OutcomeValue<TName extends "import_preview.detail"> = Extract<
    ProtocolOperationResult<TName>,
    { readonly value: unknown }
>["value"];

export type ImportPreviewView = TerminalValue<"import.preview">;
export type ImportCandidateView = ImportPreviewView["candidates"][number];
export type ImportBatchResultView = TerminalValue<"import.accept_batch">;
export type ImportPreviewDetailView = OutcomeValue<"import_preview.detail">;
export type CallableBindingRequestView = ImportCandidateView["callableBindingRequests"][number];
export type ExistingAssetSummaryView = Extract<
    ProtocolOperationResult<"asset.list">,
    { readonly value: unknown }
>["value"]["assets"][number];

export type ImportDestinationSelection =
    | {
          readonly candidateId: string;
          readonly action: "create_asset";
      }
    | {
          readonly candidateId: string;
          readonly action: "create_version";
          readonly assetId: string;
          readonly parentVersionId: string;
      };

interface ImportBindingSelectionBase {
    readonly candidateId: string;
    readonly subjectKey: string;
}

export type ImportBindingSelection =
    | (ImportBindingSelectionBase & {
          readonly targetKind: "candidate";
          readonly targetCandidateId: string;
      })
    | (ImportBindingSelectionBase & {
          readonly targetKind: "asset_version";
          readonly targetAssetVersionId: string;
      });

export type ImportBatchBuildResult =
    | { readonly status: "ready"; readonly params: ProtocolOperationParams<"import.accept_batch"> }
    | { readonly status: "invalid"; readonly message: DesktopDisplayText };

export function callableBindingSubjectKey(subject: CallableBindingRequestView["subject"]): string {
    if (subject.subjectKind === "workflow_execution_agent") return "workflow_execution_agent";
    if (subject.subjectKind === "memory_catalog_member") return `memory_catalog_member\0${subject.memberIndex}`;
    return `file_reference\0${subject.logicalPath}\0${subject.referenceIndex}`;
}

export function canTargetBinding(request: CallableBindingRequestView, candidate: ImportCandidateView): boolean {
    if (request.subject.subjectKind === "workflow_execution_agent") return candidate.kind === "Subagent";
    if (request.subject.subjectKind === "memory_catalog_member") {
        return candidate.kind === "Memory" && candidate.memoryEntityRole === "unit";
    }
    return candidate.kind === "Workflow" || candidate.kind === "Subagent";
}

export function canTargetExistingAsset(request: CallableBindingRequestView, asset: ExistingAssetSummaryView): boolean {
    if (request.subject.subjectKind === "memory_catalog_member") {
        // asset.list deliberately does not duplicate Version typeData. Until an
        // exact role projection exists, do not offer an unverified Catalog as a
        // Unit dependency; same-batch Unit candidates remain fully reviewable.
        return false;
    }
    return (
        !asset.deleted &&
        (request.subject.subjectKind === "workflow_execution_agent"
            ? asset.kind === "Subagent"
            : asset.kind === "Workflow" || asset.kind === "Subagent")
    );
}

export function buildImportBatchRequest(
    preview: ImportPreviewView,
    selectedCandidateIds: readonly string[],
    destinationSelections: readonly ImportDestinationSelection[],
    bindingSelections: readonly ImportBindingSelection[],
    existingAssets: readonly ExistingAssetSummaryView[],
    userActionId: string,
): ImportBatchBuildResult {
    if (userActionId.trim() === "") {
        return { status: "invalid", message: localizedText("import.validation.user_action") };
    }
    const selected = new Set(selectedCandidateIds);
    const selectedCandidates = preview.candidates.filter((candidate) => selected.has(candidate.candidateId));
    if (selectedCandidates.length === 0) {
        return { status: "invalid", message: localizedText("import.validation.no_selection") };
    }
    if (selectedCandidates.length !== selected.size) {
        return { status: "invalid", message: localizedText("import.validation.preview_membership") };
    }
    const candidateById = new Map(preview.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const assetById = new Map(existingAssets.map((asset) => [asset.assetId, asset]));
    const assetByCurrentVersionId = new Map(existingAssets.map((asset) => [asset.currentVersionId, asset]));
    const destinationsByCandidate = new Map<string, ImportDestinationSelection>();
    for (const destination of destinationSelections) {
        if (destinationsByCandidate.has(destination.candidateId)) {
            return { status: "invalid", message: localizedText("import.validation.destination_duplicate") };
        }
        if (!selected.has(destination.candidateId)) {
            return { status: "invalid", message: localizedText("import.validation.destination_stale") };
        }
        const candidate = candidateById.get(destination.candidateId);
        if (candidate === undefined) {
            return { status: "invalid", message: localizedText("import.validation.destination_missing") };
        }
        if (destination.action === "create_version") {
            const asset = assetById.get(destination.assetId);
            if (
                asset === undefined ||
                asset.deleted ||
                asset.kind !== candidate.kind ||
                asset.currentVersionId !== destination.parentVersionId
            ) {
                return {
                    status: "invalid",
                    message: localizedText("import.validation.destination_incompatible", {
                        candidate: candidate.displayName,
                    }),
                };
            }
        }
        destinationsByCandidate.set(destination.candidateId, destination);
    }
    const bindingsBySubject = new Map<string, ImportBindingSelection>();
    for (const binding of bindingSelections) {
        const key = `${binding.candidateId}\0${binding.subjectKey}`;
        if (bindingsBySubject.has(key)) {
            return { status: "invalid", message: localizedText("import.validation.binding_duplicate") };
        }
        const owner = candidateById.get(binding.candidateId);
        const request = owner?.callableBindingRequests.find(
            (candidateRequest) => callableBindingSubjectKey(candidateRequest.subject) === binding.subjectKey,
        );
        if (owner === undefined || request === undefined || !selected.has(owner.candidateId)) {
            return { status: "invalid", message: localizedText("import.validation.binding_stale") };
        }
        if (binding.targetKind === "candidate") {
            const target = candidateById.get(binding.targetCandidateId);
            if (
                target === undefined ||
                !selected.has(target.candidateId) ||
                target.candidateId === owner.candidateId ||
                !canTargetBinding(request, target)
            ) {
                return { status: "invalid", message: localizedText("import.validation.binding_stale") };
            }
        } else {
            const asset = assetByCurrentVersionId.get(binding.targetAssetVersionId);
            if (asset === undefined || !canTargetExistingAsset(request, asset)) {
                return { status: "invalid", message: localizedText("import.validation.binding_existing_stale") };
            }
        }
        bindingsBySubject.set(key, binding);
    }

    const decisions: ProtocolOperationParams<"import.accept_batch">["decisions"][number][] = [];
    for (const candidate of selectedCandidates) {
        if (candidate.callableBindingRequestsTruncated) {
            return {
                status: "invalid",
                message: localizedText("import.validation.candidate_dependencies_truncated", {
                    candidate: candidate.displayName,
                }),
            };
        }
        if (candidate.status !== "importable") {
            return {
                status: "invalid",
                message: localizedText("import.validation.candidate_not_importable", {
                    candidate: candidate.displayName,
                }),
            };
        }
        if (candidate.freshness !== "fresh") {
            return {
                status: "invalid",
                message: localizedText("import.validation.candidate_refresh", {
                    candidate: candidate.displayName,
                }),
            };
        }
        const destination = destinationsByCandidate.get(candidate.candidateId);
        if (destination === undefined) {
            return {
                status: "invalid",
                message: localizedText("import.validation.destination_choose", {
                    candidate: candidate.displayName,
                }),
            };
        }
        const callableBindings: ProtocolOperationParams<"import.accept_batch">["decisions"][number]["callableBindings"][number][] =
            [];
        for (const request of candidate.callableBindingRequests) {
            const selection = bindingsBySubject.get(`${candidate.candidateId}\0${callableBindingSubjectKey(request.subject)}`);
            if (selection === undefined) {
                if (request.required) {
                    return {
                        status: "invalid",
                        message: localizedText("import.validation.missing_binding", {
                            candidate: candidate.displayName,
                            target: request.rawTarget,
                        }),
                    };
                }
                continue;
            }
            callableBindings.push(
                selection.targetKind === "candidate"
                    ? {
                          subject: { ...request.subject },
                          targetCandidateId: selection.targetCandidateId,
                      }
                    : {
                          subject: { ...request.subject },
                          targetAssetVersionId: selection.targetAssetVersionId,
                      },
            );
        }
        decisions.push({
            candidateId: candidate.candidateId,
            ...(destination.action === "create_asset"
                ? { action: "create_asset" as const }
                : {
                      action: "create_version" as const,
                      assetId: destination.assetId,
                      parentVersionId: destination.parentVersionId,
                  }),
            freshness: { freshnessAction: "require_current_source" },
            promotion: { promotionAction: "import_only", userActionId },
            callableBindings,
        });
    }

    const first = decisions[0];
    if (first === undefined) {
        return { status: "invalid", message: localizedText("import.validation.no_selection") };
    }
    return {
        status: "ready",
        params: {
            previewToken: preview.previewToken,
            expectedSnapshotFingerprint: preview.snapshotFingerprint,
            decisions: [first, ...decisions.slice(1)],
        },
    };
}
