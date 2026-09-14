import type {
    ProtocolAcceptedLongOperationName,
    ProtocolOperationName,
    ProtocolOperationOutcomeV1,
    ProtocolRequestV1,
    ProtocolSupportBundleArtifactV1,
    ProtocolSupportBundleMode,
} from "@oaam/app-server-protocol";
import { hostInvocationFailure, hostPathSelectionFailure, hostReviewCapacityFailure, hostReviewFailure } from "./core-outcome";
import type { HostPathSelectionStore } from "./path-selection-store";
import { HostReviewRecordCapacityError } from "./review-record-store";
import { HostReviewRecordUnavailableError, type HostReviewRecords } from "./review-records";
import { type PreparedSupportBundle, projectPreparedSupportBundle } from "./support-bundle";

export const HOST_SUPPORT_BUNDLE_LONG_OPERATIONS = Object.freeze([
    "diagnostics.support_bundle.inspect",
    "diagnostics.support_bundle.export",
] as const satisfies readonly ProtocolAcceptedLongOperationName[]);

type SupportBundleOperation = (typeof HOST_SUPPORT_BUNDLE_LONG_OPERATIONS)[number];
export type SupportBundleRequest = Extract<ProtocolRequestV1, { readonly method: SupportBundleOperation }>;

export interface HostSupportBundleIntegration {
    prepareSupportBundle(mode: ProtocolSupportBundleMode): Promise<PreparedSupportBundle>;
    publishSupportBundle(
        prepared: PreparedSupportBundle,
        destinationPath: string,
        userActionId: string,
    ): ProtocolSupportBundleArtifactV1;
}

export interface HostSupportBundleDispatchContext {
    readonly connectionId: string;
    readonly pathSelections: HostPathSelectionStore;
    readonly reviews: HostReviewRecords;
    readonly integration: HostSupportBundleIntegration;
}

export function isSupportBundleLongOperation(operation: ProtocolOperationName): operation is SupportBundleOperation {
    return HOST_SUPPORT_BUNDLE_LONG_OPERATIONS.includes(operation as SupportBundleOperation);
}

export async function dispatchSupportBundleLong(
    request: SupportBundleRequest,
    context: HostSupportBundleDispatchContext,
): Promise<unknown> {
    try {
        if (request.method === "diagnostics.support_bundle.inspect") {
            const prepared = await context.integration.prepareSupportBundle(request.params.mode);
            const token = context.reviews.recordSupportBundle(context.connectionId, prepared);
            return complete(projectPreparedSupportBundle(token, prepared));
        }
        const prepared = context.reviews.resolveSupportBundle(request.params.supportBundleReviewToken);
        const destinationPath = context.pathSelections.consume(request.params.localPathSelectionToken, "support_bundle_file");
        if (destinationPath === null) return hostPathSelectionFailure();
        const artifact = context.integration.publishSupportBundle(prepared, destinationPath, request.params.userActionId);
        context.reviews.acceptSupportBundle(request.params.supportBundleReviewToken);
        return complete(artifact);
    } catch (error) {
        if (error instanceof HostReviewRecordUnavailableError) return hostReviewFailure(error.failureKind);
        if (error instanceof HostReviewRecordCapacityError) return hostReviewCapacityFailure();
        return hostInvocationFailure();
    }
}

function complete<T>(value: T): ProtocolOperationOutcomeV1<T> {
    return { status: "complete", value, diagnostics: [] };
}
