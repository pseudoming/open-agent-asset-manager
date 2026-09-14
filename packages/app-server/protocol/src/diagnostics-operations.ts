import { protocolEmptyObjectSchema } from "./models";
import { protocolOperationOutcome } from "./models";
import { protocolAcceptedLongAcknowledgementSchema, protocolProgressProjectionSchema } from "./long-operation-models";
import { acceptedLong, immediate } from "./operation-definition";
import {
    protocolDiagnosticsHealthSchema,
    protocolOrdinaryLogClearParamsSchema,
    protocolOrdinaryLogClearResultSchema,
    protocolOrdinaryLogSettingsReplaceParamsSchema,
    protocolOrdinaryLogSettingsSchema,
    protocolSupportBundleArtifactSchema,
    protocolSupportBundleExportParamsSchema,
    protocolSupportBundleInspectParamsSchema,
    protocolSupportBundleReviewSchema,
} from "./operational-diagnostics";

export const DIAGNOSTICS_OPERATION_DEFINITIONS = Object.freeze({
    "diagnostics.health.get": immediate("immediate_query", protocolEmptyObjectSchema, protocolDiagnosticsHealthSchema),
    "diagnostics.ordinary_log.settings.get": immediate(
        "immediate_query",
        protocolEmptyObjectSchema,
        protocolOrdinaryLogSettingsSchema,
    ),
    "diagnostics.ordinary_log.settings.replace": immediate(
        "immediate_mutation",
        protocolOrdinaryLogSettingsReplaceParamsSchema,
        protocolOrdinaryLogSettingsSchema,
    ),
    "diagnostics.ordinary_log.clear": immediate(
        "immediate_mutation",
        protocolOrdinaryLogClearParamsSchema,
        protocolOrdinaryLogClearResultSchema,
    ),
});

export const DIAGNOSTICS_ACCEPTED_LONG_DEFINITIONS = Object.freeze({
    "diagnostics.support_bundle.inspect": acceptedLong(
        protocolSupportBundleInspectParamsSchema,
        protocolAcceptedLongAcknowledgementSchema,
        protocolOperationOutcome(protocolSupportBundleReviewSchema),
        protocolProgressProjectionSchema,
    ),
    "diagnostics.support_bundle.export": acceptedLong(
        protocolSupportBundleExportParamsSchema,
        protocolAcceptedLongAcknowledgementSchema,
        protocolOperationOutcome(protocolSupportBundleArtifactSchema),
        protocolProgressProjectionSchema,
    ),
});
