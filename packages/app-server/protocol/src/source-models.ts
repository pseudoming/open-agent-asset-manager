import { protocolSha256Schema } from "./primitives";
import { protocolEnum, protocolNonBlankString, protocolNonEmptyArray, protocolObject, protocolString } from "./validation";

export const protocolSourceDomainSchema = protocolEnum([
    "family_shared",
    "agent_runtime_private",
    "project_root",
    "project_keyed",
    "external_managed",
    "unknown",
] as const);

export const protocolSourceLocatorIdentitySchema = protocolObject(
    {
        locatorKind: protocolEnum([
            "runtime_known_rule",
            "runtime_declared_path",
            "project_registry_entry",
            "user_provided_path",
            "unknown",
        ] as const),
        locatorKey: protocolNonBlankString,
    },
    "source locator identity",
);

export const protocolAssetVersionImportSourceSchema = protocolObject(
    {
        adapterId: protocolNonBlankString,
        sourceSnapshotFingerprint: protocolSha256Schema,
        roots: protocolNonEmptyArray(
            protocolObject(
                {
                    sourceRootId: protocolNonBlankString,
                    rootRole: protocolEnum(["config", "source", "project_actual", "unknown"] as const),
                    sourceDomain: protocolSourceDomainSchema,
                    canonicalPath: protocolNonBlankString,
                },
                "asset version import source root",
            ),
        ),
        files: protocolNonEmptyArray(
            protocolObject(
                {
                    sourceRootId: protocolNonBlankString,
                    relativePath: protocolString,
                    contentHash: protocolSha256Schema,
                },
                "asset version import source file",
            ),
        ),
    },
    "asset version import source",
);
