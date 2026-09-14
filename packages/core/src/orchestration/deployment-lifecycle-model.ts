/** Deployment lifecycle configuration and internal projection shapes. */

import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type {
    VersionDialectRestorationPayloadRefV1,
    VersionNativeRepresentation,
    VersionPortableDialectContractRefV1,
} from "../contracts/persistence";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type { CoreResult, DeploymentView, Sha256Digest, UuidV4 } from "../types";
import type { PreparedAssetManifestAuthority } from "../reverse/reverse-accept-marker";
import type { ReverseAcceptService } from "../reverse/reverse-accept-service";
import type { NativePayloadClosureV1, RestorationPayloadClosureV1 } from "../catalog/version-authority";
import type { DeploymentInspectionAuthorityV1 } from "./deployment-inspection-service";
import type { DeploymentRenderServiceConfiguration } from "./deployment-render-service";
import type { RenderBaseAuthority, RenderOperationAuthority } from "./deployment-render-authority";
import type { recoverDeployment as recoverDeploymentJournal } from "../deployment/deployment-recovery";
import type { scanJournals } from "../deployment/deployment-journal";
import type { scanReverseAcceptReservations } from "../reverse/reverse-accept-marker";
import type { reconcileReverseAcceptPreparation } from "../reverse/reverse-accept-reconcile";

export interface DeploymentLifecycleConfiguration {
    render: DeploymentRenderServiceConfiguration;
    databasePath: string;
    renderAnalysisValidator: import("../reverse/reverse-accept-marker").ReverseAcceptRenderAnalysisValidator;
    newUuid?: () => UuidV4;
}

export interface DeploymentLifecycleService extends ReverseAcceptService {
    recoverDeployment(deploymentId: UuidV4): Promise<CoreResult<DeploymentView>>;
}

export interface StagedReverseVersionContentV1 {
    assetId: UuidV4;
    versionId: UuidV4;
    revision: number;
    parentVersionId: UuidV4;
    parentOriginAuthorityFingerprint: Sha256Digest;
    promotionRequirement: import("../contracts/persistence").VersionPromotionRequirement;
    canonical: Extract<AssetKindTypeDataV2, { kind: "Guidance" | "Rule" | "Workflow" | "Skill" | "Subagent" | "Memory" }>;
    files: AssetVersionFileContentV2[];
    portableDialectContracts: VersionPortableDialectContractRefV1[];
    nativeRepresentations: VersionNativeRepresentation[];
    dialectRestorationPayloads: VersionDialectRestorationPayloadRefV1[];
    nativePayloads: NativePayloadClosureV1[];
    restorationPayloads: RestorationPayloadClosureV1[];
    /** Operation-local proof that this reverse creates the Version's first validated target-native representation. */
    allowFirstNativeDialectProjection?: true;
    versionCanonicalContentFingerprint: Sha256Digest;
    versionFingerprint: Sha256Digest;
}

export interface FreshReverseProjection {
    inspected: DeploymentInspectionAuthorityV1;
    content: StagedReverseVersionContentV1;
    base: RenderBaseAuthority;
    operation: RenderOperationAuthority;
    analysis: import("../contracts/render").RenderAnalysisView;
    deploymentAuthorityFingerprint: Sha256Digest;
    assetManifestAuthorities: PreparedAssetManifestAuthority[];
}

export interface DeploymentLifecycleRecoveryDependencies {
    scanDeploymentJournals: typeof scanJournals;
    recoverDeploymentJournal: typeof recoverDeploymentJournal;
    scanReservations: typeof scanReverseAcceptReservations;
    reconcilePreparation: typeof reconcileReverseAcceptPreparation;
}
