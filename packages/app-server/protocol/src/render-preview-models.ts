import { protocolSha256Schema, protocolUuidV4Schema } from "./primitives";
import {
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonNegativeInteger,
    protocolObject,
    protocolString,
    protocolUnion,
} from "./validation";

const missingStateSchema = protocolObject({ state: protocolLiteral("missing") }, "missing preview file state");
const presentStateSchema = protocolUnion(
    [
        protocolObject(
            {
                state: protocolLiteral("present"),
                contentKind: protocolLiteral("text"),
                contentHash: protocolSha256Schema,
                byteSize: protocolNonNegativeInteger,
                executable: protocolBoolean,
                text: protocolString,
            },
            "text preview file state",
        ),
        protocolObject(
            {
                state: protocolLiteral("present"),
                contentKind: protocolLiteral("binary"),
                contentHash: protocolSha256Schema,
                byteSize: protocolNonNegativeInteger,
                executable: protocolBoolean,
            },
            "binary preview file state",
        ),
    ],
    "present preview file state",
);

const previewFileStateSchema = protocolUnion([missingStateSchema, presentStateSchema], "preview file state");

export const protocolDeploymentRenderPreviewSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(3),
        previewToken: protocolNonBlankString,
        deploymentId: protocolUuidV4Schema,
        renderInputFingerprint: protocolSha256Schema,
        selectionFingerprint: protocolSha256Schema,
        compilationFingerprint: protocolSha256Schema,
        previewFingerprint: protocolSha256Schema,
        replacementScope: protocolObject(
            {
                filePaths: protocolArray(protocolNonBlankString),
                directoryPaths: protocolArray(protocolNonBlankString),
            },
            "complete deployment replacement scope",
        ),
        actionState: protocolEnum(["ready_apply", "requires_unmanaged_replacement", "blocked_managed_conflict"] as const),
        files: protocolArray(
            protocolObject(
                {
                    relativePath: protocolNonBlankString,
                    baselineState: protocolEnum(["unmanaged", "managed"] as const),
                    changeKind: protocolEnum([
                        "create",
                        "unchanged",
                        "update_managed",
                        "remove_managed",
                        "establish_baseline",
                        "replace_unmanaged",
                        "managed_conflict",
                    ] as const),
                    current: previewFileStateSchema,
                    desired: previewFileStateSchema,
                },
                "deployment render preview file",
            ),
        ),
        directories: protocolArray(
            protocolObject(
                {
                    managedBoundaryRelativePath: protocolNonBlankString,
                    relativePath: protocolNonBlankString,
                    baselineState: protocolEnum(["unmanaged", "managed"] as const),
                    changeKind: protocolEnum(["create", "unchanged", "remove_managed", "remove_unmanaged"] as const),
                    currentState: protocolEnum(["missing", "present"] as const),
                    desiredState: protocolEnum(["missing", "present"] as const),
                },
                "deployment render preview directory",
            ),
        ),
    },
    "deployment render preview",
);
