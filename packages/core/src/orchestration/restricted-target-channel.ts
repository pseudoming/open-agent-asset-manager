import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import * as crypto from "node:crypto";
import {
    RESTRICTED_TARGET_PROTOCOL,
    type RestrictedTargetBinding,
    type RestrictedTargetRootBinding,
    type RestrictedUsageTargetBinding,
    type RestrictedTargetOperation,
    type RestrictedTargetRequest,
    type RestrictedTargetResponse,
    type RestrictedTargetSession,
} from "../deployment/restricted-target-contract";
import {
    bindRestrictedTargetGraphChannel,
    type DeploymentTargetGraphExecution,
} from "../deployment/restricted-target-graph-channel";
import { hasExactKeys, isCanonicalTargetRootPath, isUuidV4 } from "../foundation/validators";
import { bindRestrictedTargetReviewChannel, type DeploymentTargetReview } from "./restricted-target-review-channel";
import { bindRestrictedTargetReadChannel, type AssetUsageTargetReview } from "./restricted-target-read-channel";
import type { SelectedWslTargetRequest, SelectedWslUsageTargetRequest } from "./selected-wsl-target-execution";

export interface DeploymentTargetExecution {
    readonly binding: Readonly<RestrictedTargetBinding>;
    readonly graph: DeploymentTargetGraphExecution;
    readonly review: DeploymentTargetReview;
}

export interface AssetUsageTargetExecution {
    readonly binding: Readonly<RestrictedUsageTargetBinding>;
    readonly review: AssetUsageTargetReview;
}

/** Bind an authorized logical target to the exact selected distribution's physical coordinates. */
export function createRestrictedTargetBinding(request: SelectedWslTargetRequest, bindingId: string): RestrictedTargetBinding {
    if (!isUuidV4(request.deploymentId)) throw new Error("invalid restricted target binding");
    return Object.freeze({ ...createRootBinding(request, bindingId), deploymentId: request.deploymentId });
}

export function createRestrictedUsageTargetBinding(
    request: SelectedWslUsageTargetRequest,
    bindingId: string,
): RestrictedUsageTargetBinding {
    return Object.freeze({ ...createRootBinding(request, bindingId), kind: "asset_usage" });
}

function createRootBinding(request: SelectedWslUsageTargetRequest, bindingId: string): RestrictedTargetRootBinding {
    const context = request.platformContext;
    if (context.platform !== "wsl" || !isUuidV4(bindingId) || !isCanonicalTargetRootPath(request.targetRootPath, "wsl"))
        throw new Error("invalid restricted target binding");
    const projection = createSelectedWslPathProjection(context.platformInstanceId, context.accessRootPath);
    return Object.freeze({
        bindingId,
        platformInstanceId: context.platformInstanceId,
        targetRootPath: request.targetRootPath,
        executionRootPath: projection.toExecution(request.targetRootPath),
    });
}

/** One session-level channel serves all approved roots. Unknown/late responses
 * cannot become commit proof. The transport never retries an exchange. */
export function createRestrictedTargetChannel(
    session: RestrictedTargetSession,
    exchange: (request: RestrictedTargetRequest) => unknown,
) {
    let sequence = 0;
    let usable = true;
    function call(binding: RestrictedTargetRootBinding, operation: RestrictedTargetOperation) {
        if (!usable) throw new Error("restricted target channel is unavailable");
        const request: RestrictedTargetRequest = {
            protocol: RESTRICTED_TARGET_PROTOCOL,
            ...session,
            operationId: crypto.randomUUID(),
            sequence: ++sequence,
            bindingId: binding.bindingId,
            operation,
        };
        try {
            const value = exchange(request);
            if (
                !hasExactKeys(value, [
                    "protocol",
                    "hostInstanceId",
                    "sessionId",
                    "operationId",
                    "sequence",
                    "bindingId",
                    "result",
                ])
            ) {
                throw new Error("invalid restricted target response");
            }
            const response = value as RestrictedTargetResponse;
            for (const field of ["protocol", "hostInstanceId", "sessionId", "operationId", "sequence", "bindingId"] as const) {
                if (response[field] !== request[field]) throw new Error("restricted target response identity mismatch");
            }
            if (response.result?.kind !== operation.kind) throw new Error("restricted target response operation mismatch");
            return response.result;
        } catch (error) {
            // An exchange or identity failure cannot prove whether this sequence was
            // consumed. All consumers, including graph recovery, retire the peer.
            usable = false;
            throw error;
        }
    }
    return Object.freeze({
        get available() {
            return usable;
        },
        bindUsage(source: RestrictedUsageTargetBinding): AssetUsageTargetExecution {
            const binding = Object.freeze(structuredClone(source));
            return Object.freeze({
                binding,
                review: bindRestrictedTargetReadChannel(
                    binding,
                    (operation) => call(binding, operation),
                    () => {
                        usable = false;
                    },
                ),
            });
        },
        bind(source: RestrictedTargetBinding): DeploymentTargetExecution {
            const binding = Object.freeze(structuredClone(source));
            const invalidate = () => {
                usable = false;
            };
            return Object.freeze({
                binding,
                graph: bindRestrictedTargetGraphChannel(binding, call, invalidate),
                review: bindRestrictedTargetReviewChannel(binding, call, invalidate),
            });
        },
    });
}
