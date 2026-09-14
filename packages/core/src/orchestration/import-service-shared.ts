/** Shared Import service configuration, failures, and deterministic result helpers. */

import type {
    RestorationPayloadClosureV1,
    VersionAuthorityClosureV1,
    VersionDialectRegistryV1,
} from "../catalog/version-authority";
import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type { AssetManifestV1, CoreResult, ImportApi, PromotionApi, ReindexReport } from "../contracts/core-service";
import type {
    VersionDialectRestorationPayloadRefV1,
    VersionNativeRepresentation,
    VersionPortableDialectContractRefV1,
} from "../contracts/persistence";
import type { AdapterId, AgentRuntimeId, EpochMillis, Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { AdapterReadResult } from "../contracts/source-import";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import { isUuidV4 } from "../foundation/validators";
import type { OperationDiagnostic } from "../types";
import { type CoreMutationScope, CoreMutationScopeError } from "./core-mutation-scope";

export { compareUtf8Bytes } from "../foundation/text-order";

export const ZERO_FILE_ID = "00000000-0000-4000-8000-000000000000" as UuidV4;

export interface ImportServiceConfiguration {
    assetsRoot: string;
    oaamRoot: string;
    authorityLocksRoot: string;
    dialectRegistry: VersionDialectRegistryV1;
    resolveSourceCapabilityAgentRuntimeId(adapterId: AdapterId, sourceCapabilityFingerprint: Sha256Digest): AgentRuntimeId | null;
    resolveProjectId(projectRootPath: string): UuidV4 | null;
    acquireProjectAuthority(projectId: UuidV4): () => void;
    refreshReadResult(previous: AdapterReadResult): Promise<CoreResult<AdapterReadResult>>;
    validateReadAuthority(previous: AdapterReadResult): boolean;
    reindexImportedAsset(assetId: UuidV4): CoreResult<ReindexReport>;
    assertMutationScope(scope: CoreMutationScope): void;
    now?: () => EpochMillis;
    newUuid?: () => UuidV4;
}

export type ImportService = ImportApi & PromotionApi;

export interface AssetAuthorityRecord {
    asset: AssetManifestV1;
    versions: VersionAuthorityClosureV1[];
}

export interface CandidateMaterial {
    canonical: AssetKindTypeDataV2;
    files: AssetVersionFileContentV2[];
    nativePayloads: VersionAuthorityClosureV1["nativePayloads"];
    nativeRepresentations: VersionNativeRepresentation[];
    portableDialectContracts: VersionPortableDialectContractRefV1[];
    restorationPayloads: RestorationPayloadClosureV1[];
    restorationRefs: VersionDialectRestorationPayloadRefV1[];
}

export class ImportServiceFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"] = "conflict",
        readonly retryable = false,
    ) {
        super(message);
    }
}
export function createIdentityAllocator(newUuid: () => UuidV4): { next(label: string): UuidV4 } {
    const used = new Set<UuidV4>();
    return {
        next(label: string): UuidV4 {
            const value = newIdentity(newUuid, label);
            if (used.has(value)) {
                throw new ImportServiceFailure(
                    "import.identity_duplicate",
                    `identity factory repeated ${label}`,
                    "internal_error",
                );
            }
            used.add(value);
            return value;
        },
    };
}

export function newIdentity(factory: () => UuidV4, label: string): UuidV4 {
    const value = factory();
    if (!isUuidV4(value)) {
        throw new ImportServiceFailure("import.identity_invalid", `${label} factory did not return UUID v4`, "internal_error");
    }
    return value;
}

export function requireUserAction(value: string, label: string): string {
    if (value.trim().length === 0) {
        throw new ImportServiceFailure("import.user_action_missing", `${label} must be non-blank`);
    }
    return value;
}

export function failed<T>(error: unknown, operation: OperationDiagnostic["operation"]): CoreResult<T> {
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [diagnosticFromError(error, operation)],
    };
}

export function diagnosticFromError(error: unknown, operation: OperationDiagnostic["operation"]): OperationDiagnostic {
    if (error instanceof CoreMutationScopeError) {
        return importDiagnostic(error.code, error.message, "unavailable", operation, true);
    }
    if (error instanceof ImportServiceFailure) {
        return importDiagnostic(error.code, error.message, error.causeKind, operation, error.retryable);
    }
    return importDiagnostic(
        "import.internal_error",
        error instanceof Error ? error.message : String(error),
        "internal_error",
        operation,
        false,
    );
}

export function importDiagnostic(
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    operation: OperationDiagnostic["operation"],
    retryable: boolean,
): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message,
        path: "",
        traceId: "",
        operation,
        causeKind,
        retryable,
        suggestedActions: retryable ? ["retry"] : [],
        rawSummary: message,
    };
}
