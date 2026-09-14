/** Shared canonical hashing mechanics for OAAM-owned fingerprints. */
import * as crypto from "node:crypto";
import type { Sha256Digest } from "../contracts/primitives";
import { compareCodeUnitText } from "./text-order";

export { compareCodeUnitText } from "./text-order";

/**
 * Fingerprint one exact semantic preimage. The domain and stable JSON are
 * separated by NUL so neither can be confused with a prefix of the other.
 */
export function fingerprintDomain(domain: string, value: unknown): Sha256Digest {
    const hash = crypto.createHash("sha256");
    hash.update(domain, "utf-8");
    hash.update("\0", "utf-8");
    hash.update(stableStringify(value), "utf-8");
    return `sha256:${hash.digest("hex")}`;
}

/** Recursive, locale-independent JSON canonicalization used by every registry fingerprint. */
export function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort(compareCodeUnitText)) {
        const item = input[key];
        if (item !== undefined) output[key] = canonicalize(item);
    }
    return output;
}

// ============================================================
// Deterministic Deployment row IDs (legacy-compatible authority helpers)
// ============================================================

export function computeDeploymentAssetId(deploymentId: string, assetId: string): string {
    return md5Hex(`DeploymentAsset\0${deploymentId}\0${assetId}`);
}

export function computeDeploymentFileId(deploymentId: string, relativePath: string): string {
    return md5Hex(`DeploymentFile\0${deploymentId}\0${relativePath}`);
}

function md5Hex(input: string): string {
    return crypto.createHash("md5").update(input, "utf-8").digest("hex");
}
