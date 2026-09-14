import { SHA_A, SHA_B, UUID_A, UUID_C } from "./protocol-fixture-primitives";

export const ASSET_NATIVE_EXPORT_PARAMS = Object.freeze({
    source: {
        assetId: UUID_A,
        versionId: UUID_C,
        versionFingerprint: SHA_B,
        originAuthorityFingerprint: SHA_A,
    },
    localPathSelectionToken: "native-export-path-token",
    userActionId: "user-action",
});

export const ASSET_NATIVE_EXPORT_RESULT = Object.freeze({ operationId: "operation-1" });

export const ASSET_NATIVE_EXPORT_TERMINAL_VALUE = Object.freeze({
    assetId: UUID_A,
    versionId: UUID_C,
    versionFingerprint: SHA_B,
    dialectId: "antigravity-workflow-markdown-v1",
    representationFingerprint: SHA_A,
    fileCount: 1,
    archiveByteLength: 512,
});
