import type { TargetFileContent } from "../contracts/common";
import type { RenderedSectionBinding } from "../contracts/deployment-authority";
import type { PosixRelativePath, Sha256Digest } from "../contracts/primitives";

/**
 * Core-internal physical desired set consumed by the deployment executor.
 * Providers never construct or return this type.
 *
 * Every provenance-bearing field is produced by the Core compiler. Providers
 * return materialization receipts but never construct this physical plan.
 */
export interface TargetPlan {
    schemaVersion: 1;
    targetFiles: TargetFilePlan[];
    /** Exact Core-validated leaf directories whose descendant inventory is
     * owned by one complete-directory output unit. Shared parents are never
     * included merely because they contain one of these boundaries. */
    managedDirectoryBoundaries: TargetManagedDirectoryBoundaryPlan[];
}

export interface TargetManagedDirectoryBoundaryPlan {
    relativePath: PosixRelativePath;
    outputUnitFingerprint: Sha256Digest;
    /** Present only when immutable Version authority supplies the complete graph. */
    desiredDirectoryPaths?: PosixRelativePath[];
}

export interface TargetFilePlan {
    relativePath: PosixRelativePath;
    content: TargetFileContent;
    executable: boolean;
    outputUnitFingerprint: Sha256Digest;
    materializationFingerprint: Sha256Digest;
    semanticRefFingerprints: Sha256Digest[];
    sectionBindings: RenderedSectionBinding[];
    /** Core-resolved shared-container patch; never grants whole-file replacement authority. */
    containerPatchPreimageHash?: Sha256Digest | null;
}
