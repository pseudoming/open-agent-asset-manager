import { protocolEnvironmentSelectorSchema, protocolUuidV4Schema } from "./primitives";
import {
    optionalProtocolField,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonEmptyArray,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolUnion,
} from "./validation";

export const adapterProbeParamsSchema = protocolObject(
    {
        adapterIds: protocolNonEmptyArray(protocolNonBlankString),
        environments: protocolNonEmptyArray(protocolEnvironmentSelectorSchema),
        installationRootSelectionToken: optionalProtocolField(protocolNonBlankString),
        authorization: protocolUnion(
            [
                protocolObject({ scope: protocolLiteral("global") }, "global probe authorization"),
                protocolObject(
                    { scope: protocolLiteral("project"), localPathSelectionToken: protocolNonBlankString },
                    "project probe authorization",
                ),
                protocolObject(
                    { scope: protocolLiteral("registered_project"), projectId: protocolUuidV4Schema },
                    "registered Project probe authorization",
                ),
                protocolObject(
                    { scope: protocolLiteral("directory"), localPathSelectionToken: protocolNonBlankString },
                    "directory probe authorization",
                ),
            ],
            "probe authorization",
        ),
    },
    "adapter probe params",
);

export const adapterProbeProgressSchema = protocolUnion(
    [
        protocolObject(
            {
                stage: protocolLiteral("provider_probe"),
                completedUnits: protocolLiteral(0),
                totalUnits: protocolNonNegativeInteger,
            },
            "adapter probe start progress",
        ),
        protocolObject(
            {
                stage: protocolLiteral("provider_probe"),
                completedUnits: protocolPositiveInteger,
                totalUnits: protocolPositiveInteger,
                adapterId: protocolNonBlankString,
                environment: protocolEnvironmentSelectorSchema,
                outcome: protocolEnum(["complete", "partial", "failed"] as const),
                elapsedMilliseconds: protocolNonNegativeInteger,
            },
            "adapter probe Provider progress",
        ),
    ],
    "adapter probe progress",
);
