import { decodeRestrictedUsageExpectations, restrictedUsageExpectationFingerprint } from "./restricted-target-usage-codec";
import { observeAssetUsageExpectedTargets } from "./asset-usage-target-observation";
import { confirmDurableDirectoryNoFollow, samePhysicalPathIdentity } from "@oaam/shared/filesystem";
import { isSelectedWslPhysicalRootMapping } from "@oaam/shared/paths";
import { captureDeploymentContainerPatchTargets } from "../deployment/deployment-container-patch";
import { isValidJournal } from "../deployment/deployment-journal";
import { captureDeploymentPreWritePreview, DeploymentPreWritePreviewError } from "../deployment/deployment-prewrite-preview";
import {
    decodeRestrictedContainerPatches,
    encodeRestrictedContainerCapture,
} from "../deployment/restricted-target-container-codec";
import {
    RESTRICTED_TARGET_PROTOCOL,
    type RestrictedTargetBinding,
    type RestrictedUsageTargetBinding,
    type RestrictedTargetRequest,
    type RestrictedTargetResponse,
    type RestrictedTargetResult,
    type RestrictedTargetSession,
} from "../deployment/restricted-target-contract";
import {
    decodeRestrictedGraphPreparation,
    encodeRestrictedReplacementAuthority,
} from "../deployment/restricted-target-graph-codec";
import { createRestrictedTargetGraphOperation } from "../deployment/restricted-target-graph-operation";
import { decodeRestrictedPreview } from "../deployment/restricted-target-preview-codec";
import { hasExactKeys, isCanonicalTargetRootPath, isUuidV4 } from "../foundation/validators";
import { captureDeploymentInspectionTarget } from "./deployment-inspection-capture";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";
import { captureMemoryCatalogTargets, isMemoryCatalogTargetPaths } from "./deployment-render-target-snapshot";
import { decodeRestrictedInspectionPlan, encodeRestrictedInspectionFailure } from "./restricted-target-inspection-codec";

export interface RestrictedTargetServiceConfiguration extends RestrictedTargetSession {
    bindings: readonly (RestrictedTargetBinding | RestrictedUsageTargetBinding)[];
    deadlineAt: number;
}

/** No State, Provider construction, transaction allocation or journal writes.
 * Bootstrap supplies exact approved roots; Host owns process and framing. */
export function createRestrictedTargetService(configuration: RestrictedTargetServiceConfiguration) {
    if (!isUuidV4(configuration.hostInstanceId) || !isUuidV4(configuration.sessionId)) {
        throw new Error("invalid restricted target session identity");
    }
    if (
        !Number.isSafeInteger(configuration.deadlineAt) ||
        configuration.deadlineAt <= Date.now() ||
        configuration.deadlineAt > Date.now() + 600_000 ||
        configuration.bindings.length < 1 ||
        configuration.bindings.length > 8
    ) {
        throw new Error("invalid restricted target lifetime or binding count");
    }
    const bindings = new Map(
        configuration.bindings.map((source) => {
            const binding = structuredClone(source);
            if (
                !isUuidV4(binding.bindingId) ||
                ("kind" in binding
                    ? binding.kind !== "asset_usage" ||
                      !hasExactKeys(binding, ["kind", "bindingId", "platformInstanceId", "targetRootPath", "executionRootPath"])
                    : !isUuidV4(binding.deploymentId)) ||
                !isCanonicalTargetRootPath(binding.targetRootPath, "wsl")
            ) {
                throw new Error("invalid restricted target root binding");
            }
            if (
                !isSelectedWslPhysicalRootMapping(binding.targetRootPath, binding.executionRootPath, binding.platformInstanceId)
            ) {
                throw new Error("restricted target Windows/WSL root mapping mismatch");
            }
            const identity = confirmDurableDirectoryNoFollow(binding.executionRootPath);
            return [binding.bindingId, { binding, identity }] as const;
        }),
    );
    if (bindings.size !== configuration.bindings.length) throw new Error("duplicate restricted target binding");
    let lastSequence = 0;
    let businessOperations = 0;
    const operations = new Set<string>();
    const graphOperations = new Map<string, ReturnType<typeof createRestrictedTargetGraphOperation>>();

    return Object.freeze({
        handle(value: unknown): RestrictedTargetResponse {
            if (
                !isRestrictedTargetRequest(value) ||
                value.hostInstanceId !== configuration.hostInstanceId ||
                value.sessionId !== configuration.sessionId ||
                value.sequence !== lastSequence + 1 ||
                operations.has(value.operationId) ||
                (value.operation.kind !== "continue_graph" && businessOperations >= 128) ||
                lastSequence >= 128 * 4_097 ||
                Date.now() >= configuration.deadlineAt
            ) {
                throw new Error("restricted target request rejected");
            }
            const approved = bindings.get(value.bindingId);
            if (approved === undefined) throw new Error("unapproved restricted target binding");
            const { binding, identity } = approved;
            const operation = value.operation;
            if (
                "kind" in binding &&
                operation.kind !== "asset_usage" &&
                operation.kind !== "container_patches" &&
                operation.kind !== "memory_catalog_snapshots"
            ) {
                throw new Error("read-only usage binding refuses Deployment operations");
            }
            // The service-side usage guard above excludes every Deployment/graph branch before target I/O.
            const deploymentBinding = binding as RestrictedTargetBinding;
            if ("journal" in operation && operation.journal.deploymentId !== deploymentBinding.deploymentId) {
                throw new Error("restricted target transaction belongs to another Deployment");
            }
            if (!samePhysicalPathIdentity(identity, confirmDurableDirectoryNoFollow(binding.executionRootPath))) {
                throw new Error("restricted target root identity changed");
            }
            lastSequence = value.sequence;
            if (operation.kind !== "continue_graph") businessOperations++;
            operations.add(value.operationId);
            let result: RestrictedTargetResult;
            // Request admission already validated these JSON payloads with the same
            // codecs; dispatch is synchronous and does not change the admitted payload.
            if (operation.kind === "asset_usage") {
                const expectations = decodeRestrictedUsageExpectations(operation.expectations)!;
                result = {
                    kind: "asset_usage",
                    observations: observeAssetUsageExpectedTargets({
                        expectations,
                        targetRootPath: binding.executionRootPath,
                        platformContext: {
                            platform: "wsl",
                            platformInstanceId: binding.platformInstanceId,
                            accessRootPath: binding.executionRootPath,
                        },
                    }).map((observation, index) => ({
                        expectationFingerprint: restrictedUsageExpectationFingerprint(expectations[index]!),
                        observation,
                    })),
                };
            } else if (operation.kind === "preview") {
                const input = decodeRestrictedPreview(operation.input)!;
                if (input.deploymentId !== deploymentBinding.deploymentId)
                    throw new Error("restricted preview Deployment mismatch");
                try {
                    const captured = captureDeploymentPreWritePreview({ ...input, targetRootPath: binding.executionRootPath });
                    result = {
                        kind: "preview",
                        outcome: "captured",
                        authority: encodeRestrictedReplacementAuthority(captured.runtimeReplacementAuthority),
                    };
                } catch (error) {
                    if (!(error instanceof DeploymentPreWritePreviewError)) throw error;
                    result = { kind: "preview", outcome: "failed", code: error.code, message: error.message };
                }
            } else if (operation.kind === "memory_catalog_snapshots") {
                try {
                    result = {
                        kind: "memory_catalog_snapshots",
                        outcome: "captured",
                        snapshots: captureMemoryCatalogTargets(operation.paths, binding.executionRootPath),
                    };
                } catch (error) {
                    if (!(error instanceof DeploymentRenderFailure)) throw error;
                    result = {
                        kind: "memory_catalog_snapshots",
                        outcome: "failed",
                        code: error.code,
                        message: error.message,
                        retryable: error.retryable,
                    };
                }
            } else if (operation.kind === "inspection_capture") {
                const plan = decodeRestrictedInspectionPlan(operation.plan)!;
                try {
                    const authority = captureDeploymentInspectionTarget(plan, binding.executionRootPath);
                    result = {
                        kind: "inspection_capture",
                        outcome: "captured",
                        authority: encodeRestrictedReplacementAuthority(authority),
                    };
                } catch (error) {
                    result = {
                        kind: "inspection_capture",
                        outcome: "failed",
                        failure: encodeRestrictedInspectionFailure(error, binding.executionRootPath),
                    };
                }
            } else if (operation.kind === "container_patches") {
                const intents = decodeRestrictedContainerPatches(operation.intents)!;
                const captured = captureDeploymentContainerPatchTargets(intents, binding.executionRootPath);
                if (captured.status === "complete") {
                    result = {
                        kind: "container_patches",
                        outcome: "captured",
                        targets: encodeRestrictedContainerCapture(captured.value),
                    };
                } else {
                    const diagnostic = captured.diagnostics[0];
                    if (diagnostic === undefined) throw new Error("restricted container capture failed without a diagnostic");
                    const { code, message, causeKind, retryable } = diagnostic;
                    result = { kind: "container_patches", outcome: "failed", failure: { code, message, causeKind, retryable } };
                }
            } else {
                let graph = graphOperations.get(binding.bindingId);
                if (graph === undefined) {
                    graph = createRestrictedTargetGraphOperation(deploymentBinding);
                    graphOperations.set(binding.bindingId, graph);
                }
                if (operation.kind === "prepare_graph") {
                    const input = decodeRestrictedGraphPreparation(operation.input)!;
                    result = { kind: "prepare_graph", result: graph.prepare(input) };
                } else {
                    result = {
                        kind: operation.kind,
                        step:
                            operation.kind === "execute_graph"
                                ? graph.execute(operation.preparationId, operation.journal)
                                : operation.kind === "continue_graph"
                                  ? graph.continue(operation.journal)
                                  : graph.recover(operation.journal, operation.side),
                    };
                }
            }
            if (
                Date.now() >= configuration.deadlineAt ||
                !samePhysicalPathIdentity(identity, confirmDurableDirectoryNoFollow(binding.executionRootPath))
            ) {
                throw new Error("restricted target root identity or deadline changed during execution");
            }
            return {
                protocol: RESTRICTED_TARGET_PROTOCOL,
                hostInstanceId: configuration.hostInstanceId,
                sessionId: configuration.sessionId,
                operationId: value.operationId,
                sequence: value.sequence,
                bindingId: value.bindingId,
                result,
            };
        },
    });
}

function isRestrictedTargetRequest(value: unknown): value is RestrictedTargetRequest {
    if (!hasExactKeys(value, ["protocol", "hostInstanceId", "sessionId", "operationId", "sequence", "bindingId", "operation"])) {
        return false;
    }
    const request = value as RestrictedTargetRequest;
    if (
        request.protocol !== RESTRICTED_TARGET_PROTOCOL ||
        !isUuidV4(request.hostInstanceId) ||
        !isUuidV4(request.sessionId) ||
        !isUuidV4(request.operationId) ||
        !isUuidV4(request.bindingId) ||
        !Number.isSafeInteger(request.sequence) ||
        request.sequence < 1
    )
        return false;
    const operation = request.operation;
    if (operation?.kind === "asset_usage") {
        return (
            hasExactKeys(operation, ["kind", "expectations"]) &&
            decodeRestrictedUsageExpectations(operation.expectations) !== null
        );
    }
    if (operation?.kind === "memory_catalog_snapshots") {
        return hasExactKeys(operation, ["kind", "paths"]) && isMemoryCatalogTargetPaths(operation.paths);
    }
    if (operation?.kind === "inspection_capture") {
        return hasExactKeys(operation, ["kind", "plan"]) && decodeRestrictedInspectionPlan(operation.plan) !== null;
    }
    if (operation?.kind === "preview") {
        return hasExactKeys(operation, ["kind", "input"]) && decodeRestrictedPreview(operation.input) !== null;
    }
    if (operation?.kind === "container_patches") {
        return hasExactKeys(operation, ["kind", "intents"]) && decodeRestrictedContainerPatches(operation.intents) !== null;
    }
    if (operation?.kind === "prepare_graph") {
        return hasExactKeys(operation, ["kind", "input"]) && decodeRestrictedGraphPreparation(operation.input) !== null;
    }
    if (operation?.kind === "execute_graph" || operation?.kind === "continue_graph" || operation?.kind === "recover_graph") {
        const fields =
            operation.kind === "execute_graph" ? ["preparationId"] : operation.kind === "recover_graph" ? ["side"] : [];
        return (
            hasExactKeys(operation, ["kind", "journal", ...fields]) &&
            isValidJournal(operation.journal) &&
            (operation.journal.schemaVersion === 3 ||
                (operation.journal.schemaVersion === 4 && operation.journal.targetExecution.kind === "selected_wsl")) &&
            (operation.kind !== "execute_graph" || isUuidV4(operation.preparationId)) &&
            (operation.kind !== "recover_graph" || operation.side === "old" || operation.side === "new")
        );
    }
    return false;
}
