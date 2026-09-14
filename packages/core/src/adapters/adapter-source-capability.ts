/** Core-owned construction and fingerprinting for adapter source-capability rows. */

import type { AdapterAssetSourceCapability, AdapterProvider, Sha256Digest } from "../types";
import { fingerprintDomain } from "../foundation/fingerprint";

const SOURCE_CAPABILITY_DOMAIN = "oaam.adapter.source-capability.v1";

export type AdapterAssetSourceCapabilityInput = Omit<AdapterAssetSourceCapability, "sourceCapabilityFingerprint">;

type AdapterSourceCapabilityOwner = Pick<AdapterProvider, "adapterId" | "agentRuntimes">;

/**
 * Construct one source-capability row with the only valid Core fingerprint.
 * Adapter families supply runtime facts; they never reproduce the fingerprint
 * domain or canonical preimage locally.
 */
export function createAdapterAssetSourceCapability(
    owner: AdapterSourceCapabilityOwner,
    input: AdapterAssetSourceCapabilityInput,
): AdapterAssetSourceCapability {
    const sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(owner, input);
    if (sourceCapabilityFingerprint === null) {
        throw new Error(`source capability references unknown agentRuntimeId: ${input.agentRuntimeId}`);
    }
    return { ...input, sourceCapabilityFingerprint };
}

/** Recompute the exact frozen source-capability identity for validation. */
export function computeSourceCapabilityFingerprint(
    owner: AdapterSourceCapabilityOwner,
    capability: AdapterAssetSourceCapabilityInput,
): Sha256Digest | null {
    const descriptor = owner.agentRuntimes.find((candidate) => candidate.agentRuntimeId === capability.agentRuntimeId);
    if (descriptor === undefined) return null;
    return fingerprintDomain(SOURCE_CAPABILITY_DOMAIN, {
        adapterId: owner.adapterId,
        entryClass: descriptor.entryClass,
        capability: sourceCapabilityPreimage(capability),
    });
}

export function sourceCapabilityPreimage(
    capability: AdapterAssetSourceCapabilityInput,
): Omit<AdapterAssetSourceCapability, "sourceCapabilityFingerprint" | "diagnostics"> {
    return {
        agentRuntimeId: capability.agentRuntimeId,
        entrySupportStatus: capability.entrySupportStatus,
        rootLocatorKind: capability.rootLocatorKind,
        rootRole: capability.rootRole,
        sourceDomain: capability.sourceDomain,
        assetKind: capability.assetKind,
        sourcePathMechanism: capability.sourcePathMechanism,
        evidenceLevel: capability.evidenceLevel,
        readPolicy: capability.readPolicy,
    };
}
