import { protocolNonBlankString, protocolNonNegativeInteger, protocolObject } from "./validation";

export const protocolAcceptedLongAcknowledgementSchema = protocolObject(
    { operationId: protocolNonBlankString },
    "accepted-long acknowledgement",
);

export const protocolProgressProjectionSchema = protocolObject(
    {
        stage: protocolNonBlankString,
        completedUnits: protocolNonNegativeInteger,
        totalUnits: protocolNonNegativeInteger,
    },
    "operation progress projection",
);
