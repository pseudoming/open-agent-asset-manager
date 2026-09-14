import type { Sha256Digest } from "./primitives";

/**
 * Provider-owned, per-declaration policy for routing a current target build to
 * one exact conformance anchor. Core owns only the bounded comparison and deny
 * enforcement; runtime-specific evidence and policy remain with the Provider.
 */
export interface AdapterTargetBuildCompatibilityPolicyV1 {
    schemaVersion: 1;
    versionOrdering: "numeric_dotted_core_v1";
    unknownVersionPolicy: "allow_with_warning" | "block";
    deniedBuilds: {
        versionText: string;
        buildIdentity: Sha256Digest;
        reasonCode: string;
    }[];
}
