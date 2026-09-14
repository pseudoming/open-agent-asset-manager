import { SHA_A, SHA_B, UUID_A, UUID_B, UUID_C } from "./protocol-fixture-primitives";

export const RENDER_ANALYSIS = Object.freeze({
    deploymentId: UUID_B,
    renderInputFingerprint: SHA_A,
    semantics: [
        {
            semanticRefFingerprint: SHA_A,
            consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
            semanticKind: "guidance.content",
            subject: { subjectKind: "file", assetId: UUID_A, versionId: UUID_B, fileId: UUID_C },
        },
    ],
    outputUnits: [
        {
            outputUnitFingerprint: SHA_B,
            claims: [{ relativePath: "CLAUDE.md", contentKind: "text", executable: false }],
            managedDirectoryPaths: [],
        },
    ],
    options: [
        {
            optionFingerprint: SHA_B,
            semanticRefFingerprint: SHA_A,
            renderStrategy: "native_file",
            actualReverseExtractPolicy: "can_reconcile",
            requiredOutputUnitFingerprints: [SHA_B],
            outcome: "preserved",
            approvalState: "not_required",
            reasonCode: "native",
            diagnostics: [],
        },
    ],
    promotionAuthorizationInspections: [
        {
            promotionAuthorizationState: "required",
            assetId: UUID_A,
            versionId: UUID_B,
            target: { targetKind: "project", projectId: UUID_C },
            versionOriginAuthorityFingerprint: SHA_A,
        },
    ],
    blockedSemantics: [],
    diagnostics: [],
});
