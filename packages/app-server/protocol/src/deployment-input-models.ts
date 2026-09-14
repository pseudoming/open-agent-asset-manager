import { protocolDeploymentAssetSchema } from "./models";
import { protocolUuidV4Schema } from "./primitives";
import {
    optionalProtocolField,
    protocolArray,
    protocolNonBlankString,
    protocolNonEmptyArray,
    protocolObject,
} from "./validation";

export const deploymentUpdateParamsSchema = protocolObject(
    {
        deploymentId: protocolUuidV4Schema,
        consumerAgentRuntimeIds: optionalProtocolField(protocolNonEmptyArray(protocolNonBlankString)),
        assets: optionalProtocolField(protocolNonEmptyArray(protocolDeploymentAssetSchema)),
        expectedInputs: optionalProtocolField(
            protocolObject(
                {
                    consumerAgentRuntimeIds: protocolNonEmptyArray(protocolNonBlankString),
                    assets: protocolArray(protocolDeploymentAssetSchema),
                },
                "expected Deployment inputs",
            ),
        ),
    },
    "deployment update params",
);
