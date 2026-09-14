/** Shared deterministic fixtures for the split Deployment tests. */

import type { AttributedSemanticChange } from "../../../src/contracts/reverse";
import type { deploymentLifecycleInternalsForTest } from "../../../src/orchestration/deployment-lifecycle-service";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeImportProvenanceAuthorityFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../../src/foundation/fingerprint";
import type { UuidV4 } from "../../../src/types";
import {
    ASSET_ID,
    FILE_ID,
    PROJECT_ID,
    VERSION_ID,
    VERSION_ID_2,
    makeTextFile,
    makeVersionClosure,
} from "../../catalog/fixtures/version-v2";

export const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111" as UuidV4;

export const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222" as UuidV4;

export const SHA_A = `sha256:${"a".repeat(64)}` as const;

export const SHA_B = `sha256:${"b".repeat(64)}` as const;

export type Inspected = Parameters<typeof deploymentLifecycleInternalsForTest.requireOneWholeFileContentChange>[0];

export function contentChange(): Extract<AttributedSemanticChange, { changeKind: "file_content_replacement" }> {
    return {
        changeKind: "file_content_replacement",
        changeFingerprint: SHA_A,
        semanticRefFingerprints: [SHA_B],
        replacementContent: { contentKind: "text", text: "# changed\n" },
    };
}

export function inspectedFor(change = contentChange()): Inspected {
    return {
        input: { files: [{}], inventoryDeltas: [] },
        result: {
            status: "complete",
            changes: [change],
            files: [
                {
                    relativePath: "GUIDANCE.md",
                    attributionState: "uniquely_attributable",
                    changeFingerprints: [change.changeFingerprint],
                    hunkAttributions: [],
                    diagnostics: [],
                },
            ],
        },
    } as unknown as Inspected;
}

export function stagedContent() {
    const file = makeTextFile("# changed\n", "GUIDANCE.md");
    const canonical = { kind: "Guidance" as const, typeData: { schemaVersion: 1 as const } };
    const canonicalFingerprint = computeVersionCanonicalContentFingerprint(canonical, [file.file]);
    return {
        assetId: ASSET_ID as UuidV4,
        versionId: VERSION_ID_2 as UuidV4,
        revision: 2,
        parentVersionId: VERSION_ID as UuidV4,
        parentOriginAuthorityFingerprint: SHA_A,
        promotionRequirement: "not_required" as const,
        canonical,
        files: [file],
        portableDialectContracts: [],
        nativeRepresentations: [],
        dialectRestorationPayloads: [],
        nativePayloads: [],
        restorationPayloads: [],
        versionCanonicalContentFingerprint: canonicalFingerprint,
        versionFingerprint: computeVersionFingerprint(canonicalFingerprint, [], [], []),
    };
}

export function reverseOrigin(content = stagedContent()) {
    const preimage = {
        schemaVersion: 1 as const,
        assetId: content.assetId,
        versionId: content.versionId,
        originKind: "reverse_accept" as const,
        previousVersionId: content.parentVersionId,
        previousVersionOriginAuthorityFingerprint: content.parentOriginAuthorityFingerprint,
        reversePreparationIdentityFingerprint: SHA_B,
        userActionEvidenceId: "reverse-user-action",
        promotionRequirement: content.promotionRequirement,
        createdAt: 20,
    };
    return {
        ...preimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(preimage),
    };
}

export function importedClosure(promotionSafety: "default_promotable" | "requires_user_confirmation") {
    const closure = makeVersionClosure();
    const provenancePreimage = {
        schemaVersion: 1 as const,
        importProvenanceId: "import-provenance-lifecycle-fixture",
        assetId: closure.manifest.assetId,
        versionId: closure.manifest.versionId,
        previewSnapshotFingerprint: SHA_A,
        candidateFingerprint: SHA_B,
        acceptedFreshness: "current_source_verified" as const,
        acceptedPromotion: {
            promotionAction: "import_only" as const,
            userActionEvidenceId: "import-lifecycle-action",
        },
        promotionSafety,
        importedAt: 100,
    };
    const importProvenanceAuthority = {
        ...provenancePreimage,
        authorityFingerprint: computeImportProvenanceAuthorityFingerprint(provenancePreimage),
    };
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: closure.manifest.assetId,
        versionId: closure.manifest.versionId,
        originKind: "import" as const,
        importProvenanceId: importProvenanceAuthority.importProvenanceId,
        importProvenanceAuthorityFingerprint: importProvenanceAuthority.authorityFingerprint,
        promotionRequirement: "requires_current_authorization" as const,
        createdAt: 100,
    };
    closure.manifest.originAuthority = {
        ...originPreimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
    };
    Object.assign(closure.manifest, { importProvenanceAuthority });
    return closure as typeof closure & {
        manifest: typeof closure.manifest & {
            importProvenanceAuthority: typeof importProvenanceAuthority;
        };
    };
}

export function reverseClosure(parent = makeVersionClosure()) {
    const closure = makeVersionClosure({
        versionId: VERSION_ID_2,
        revision: 2,
        sourceVersionId: parent.manifest.versionId,
        changeKind: "extract",
        createdAt: 200,
    });
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: closure.manifest.assetId,
        versionId: closure.manifest.versionId,
        originKind: "reverse_accept" as const,
        previousVersionId: parent.manifest.versionId,
        previousVersionOriginAuthorityFingerprint: parent.manifest.originAuthority.authorityFingerprint,
        reversePreparationIdentityFingerprint: SHA_A,
        userActionEvidenceId: "reverse-lifecycle-action",
        promotionRequirement: "requires_current_authorization" as const,
        createdAt: 200,
    };
    closure.manifest.originAuthority = {
        ...originPreimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
    };
    return closure;
}

export function renderBase() {
    const parent = makeVersionClosure();
    return {
        deploymentId: DEPLOYMENT_ID,
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        platform: "linux",
        platformInstanceId: "local-linux",
        targetRootPath: "/tmp/project",
        projectId: PROJECT_ID,
        assets: [
            {
                assetKind: "Guidance",
                scope: "project",
                projectId: PROJECT_ID,
                scopePath: "",
                allowIncomplete: false,
                version: {
                    ref: { assetId: ASSET_ID, versionId: VERSION_ID },
                    versionFingerprint: parent.manifest.fingerprint,
                    versionCanonicalContentFingerprint: parent.manifest.versionCanonicalContentFingerprint,
                    status: "complete",
                    canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
                    files: parent.files,
                },
                sectionHandles: { [FILE_ID]: `version:${VERSION_ID}:file:${FILE_ID}` },
            },
        ],
        dialectInputs: [],
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.projectStagedRenderBase>[0];
}
