import { protocolSha256Schema, protocolUuidV4Schema } from "./primitives";
import {
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolObject,
    type ProtocolSchema,
    protocolString,
    protocolUnion,
} from "./validation";

export type ProtocolProjectLifecycleInspectParamsV1 =
    | {
          readonly action: "rename";
          readonly projectId: string;
          readonly nextDisplayName: string;
      }
    | {
          readonly action: "rebind";
          readonly projectId: string;
          readonly localPathSelectionToken: string;
      }
    | {
          readonly action: "restore";
          readonly projectId: string;
      }
    | {
          readonly action: "stop_managing";
          readonly projectId: string;
      };

export type ProtocolProjectLifecycleReviewV1 =
    | {
          readonly schemaVersion: 1;
          readonly action: "rename";
          readonly projectLifecycleReviewToken: string;
          readonly projectId: string;
          readonly projectAuthorityFingerprint: string;
          readonly rootPath: string;
          readonly currentDisplayName: string;
          readonly nextDisplayName: string;
      }
    | {
          readonly schemaVersion: 1;
          readonly action: "rebind";
          readonly projectLifecycleReviewToken: string;
          readonly projectId: string;
          readonly projectAuthorityFingerprint: string;
          readonly displayName: string;
          readonly currentRootPath: string;
          readonly nextRootPath: string;
      }
    | {
          readonly schemaVersion: 1;
          readonly action: "restore";
          readonly projectLifecycleReviewToken: string;
          readonly projectId: string;
          readonly projectAuthorityFingerprint: string;
          readonly displayName: string;
          readonly rootPath: string;
          readonly rootAccessState: "available" | "unavailable";
      }
    | {
          readonly schemaVersion: 1;
          readonly action: "stop_managing";
          readonly projectLifecycleReviewToken: string;
          readonly projectId: string;
          readonly projectAuthorityFingerprint: string;
          readonly displayName: string;
          readonly rootPath: string;
      };

const protocolProjectRenameInspectParamsSchema = protocolObject(
    {
        action: protocolLiteral("rename"),
        projectId: protocolUuidV4Schema,
        nextDisplayName: protocolString,
    },
    "Project rename inspection params",
);

const protocolProjectRebindInspectParamsSchema = protocolObject(
    {
        action: protocolLiteral("rebind"),
        projectId: protocolUuidV4Schema,
        localPathSelectionToken: protocolNonBlankString,
    },
    "Project rebind inspection params",
);

const protocolProjectRestoreInspectParamsSchema = protocolObject(
    {
        action: protocolLiteral("restore"),
        projectId: protocolUuidV4Schema,
    },
    "Project restore inspection params",
);

const protocolProjectStopManagingInspectParamsSchema = protocolObject(
    {
        action: protocolLiteral("stop_managing"),
        projectId: protocolUuidV4Schema,
    },
    "Project stop-managing inspection params",
);

export const protocolProjectLifecycleInspectParamsSchema: ProtocolSchema<ProtocolProjectLifecycleInspectParamsV1> = protocolUnion(
    [
        protocolProjectRenameInspectParamsSchema,
        protocolProjectRebindInspectParamsSchema,
        protocolProjectRestoreInspectParamsSchema,
        protocolProjectStopManagingInspectParamsSchema,
    ],
    "Project lifecycle inspection params",
);

export const protocolProjectLifecycleCommitParamsSchema = protocolObject(
    {
        projectLifecycleReviewToken: protocolNonBlankString,
        userActionId: protocolNonBlankString,
    },
    "Project lifecycle commit params",
);

const protocolProjectRenameReviewSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        action: protocolLiteral("rename"),
        projectLifecycleReviewToken: protocolNonBlankString,
        projectId: protocolUuidV4Schema,
        projectAuthorityFingerprint: protocolSha256Schema,
        rootPath: protocolNonBlankString,
        currentDisplayName: protocolString,
        nextDisplayName: protocolString,
    },
    "Project rename review",
);

const protocolProjectRebindReviewSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        action: protocolLiteral("rebind"),
        projectLifecycleReviewToken: protocolNonBlankString,
        projectId: protocolUuidV4Schema,
        projectAuthorityFingerprint: protocolSha256Schema,
        displayName: protocolString,
        currentRootPath: protocolNonBlankString,
        nextRootPath: protocolNonBlankString,
    },
    "Project rebind review",
);

const protocolProjectRestoreReviewSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        action: protocolLiteral("restore"),
        projectLifecycleReviewToken: protocolNonBlankString,
        projectId: protocolUuidV4Schema,
        projectAuthorityFingerprint: protocolSha256Schema,
        displayName: protocolString,
        rootPath: protocolNonBlankString,
        rootAccessState: protocolEnum(["available", "unavailable"] as const),
    },
    "Project restore review",
);

const protocolProjectStopManagingReviewSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        action: protocolLiteral("stop_managing"),
        projectLifecycleReviewToken: protocolNonBlankString,
        projectId: protocolUuidV4Schema,
        projectAuthorityFingerprint: protocolSha256Schema,
        displayName: protocolString,
        rootPath: protocolNonBlankString,
    },
    "Project stop-managing review",
);

export const protocolProjectLifecycleReviewSchema: ProtocolSchema<ProtocolProjectLifecycleReviewV1> = protocolUnion(
    [
        protocolProjectRenameReviewSchema,
        protocolProjectRebindReviewSchema,
        protocolProjectRestoreReviewSchema,
        protocolProjectStopManagingReviewSchema,
    ],
    "Project lifecycle review",
);
