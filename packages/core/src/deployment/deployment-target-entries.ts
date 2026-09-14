/**
 * Build + populate deployment journal entries from a TargetPlan + baseline.
 *
 * Pure construction (buildDeployEntries / buildRemovalEntries) plus the
 * runtime-bytes snapshot step (populateOldBytes). No CAS, no verify, no
 * rollback — those live in deployment-target-cas.ts / -verify.ts / -io.ts.
 *
 * CAS anchor convention: `oldHash` = baseline durable payload hash (the last
 * success hash). First-deploy / new-path targets with no baseline row get
 * oldHash="" (the CAS then accepts an absent runtime file as matching old).
 *
 * `oldBytesBase64` is left "" by the build functions. The executor reopens the
 * durable active baseline payload and fills it before calling populateOldBytes.
 * Live runtime bytes are never promoted into recovery authority: they may be a
 * user-created third value. populateOldBytes keeps its historical name but now
 * only validates durable old material and confirms a present target is readable.
 */

import type { TargetFilePlan, TargetPlan } from "./deployment-target-plan";
import type { JournalEntry } from "./deployment-journal";
import type { DeploymentFileBaselineStateV1 } from "../contracts/deployment-authority";
import { base64ToBytes, bytesToBase64, sha256Bytes } from "../foundation/crypto-bytes";
import type { TargetIoContext } from "./deployment-target-io";
import { absPath, ioReadStableIfPresent } from "./deployment-target-io";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "./deployment-target-replacement";

// ============================================================
// Build journal entries (pure)
// ============================================================

/** Minimal pure input boundary; the SQL facade may return a richer row. */
export interface DeployBaselineFile {
    relativePath: string;
    baselineState: Extract<DeploymentFileBaselineStateV1, { rowState: "active" }>;
}

/**
 * Build journal entries for the plan's target files. Pure: no FS access.
 *
 * PRECONDITION: the caller must pass only strict active (deleted=0,
 * baselineState.rowState="active") rows. Both build functions trust that
 * already-projected input: a stale active payload hash would
 * become a stale CAS anchor. The executor builds baselineByRel from active rows
 * only (state-db listDeploymentFiles(deploymentId, includeDeleted=false)).
 */
export function buildDeployEntries(plan: TargetPlan, baselineByRel: Map<string, DeployBaselineFile>): JournalEntry[] {
    return plan.targetFiles.map((tf) => buildOneDeployEntry(tf, baselineByRel));
}

function buildOneDeployEntry(tf: TargetFilePlan, baselineByRel: Map<string, DeployBaselineFile>): JournalEntry {
    const newBytes = targetContentToBytes(tf);
    const newHash = sha256Bytes(newBytes);
    const baseline = baselineByRel.get(tf.relativePath);
    const oldHash = baseline ? baseline.baselineState.appliedPayload.contentHash : "";
    const oldExecutable = baseline ? baseline.baselineState.appliedExecutable : false;
    const oldProvenance = baseline?.baselineState.provenance;
    return {
        relativePath: tf.relativePath,
        oldHash,
        oldBytesBase64: "", // filled from durable baseline payload by executor
        oldExecutable,
        oldProvenanceFingerprint: oldProvenance?.provenanceFingerprint ?? "",
        oldMaterializationFingerprint: oldProvenance?.materializationFingerprint ?? "",
        newHash,
        newBytesBase64: bytesToBase64(newBytes),
        newExecutable: tf.executable,
        newProvenanceFingerprint: "", // finalized by executor before journal publish
        newMaterializationFingerprint: "", // finalized by executor before journal publish
        isRemoval: false,
    };
}

/**
 * Build journal entries for removal candidates: baseline paths NOT in the new
 * plan. Pure: no FS access. oldHash comes from the baseline row (a removal
 * candidate always has a baseline by construction). newHash = "" (removal).
 */
export function buildRemovalEntries(planRelativePaths: Set<string>, baseline: DeployBaselineFile[]): JournalEntry[] {
    return baseline
        .filter((f) => !planRelativePaths.has(f.relativePath))
        .map((f) => ({
            relativePath: f.relativePath,
            oldHash: f.baselineState.appliedPayload.contentHash,
            oldBytesBase64: "", // filled from durable baseline payload by executor
            oldExecutable: f.baselineState.appliedExecutable,
            oldProvenanceFingerprint: f.baselineState.provenance.provenanceFingerprint,
            oldMaterializationFingerprint: f.baselineState.provenance.materializationFingerprint,
            newHash: "",
            newBytesBase64: "",
            newExecutable: false,
            newProvenanceFingerprint: "",
            newMaterializationFingerprint: "",
            isRemoval: true,
        }));
}

/** Build explicitly reviewed removals for unmanaged files inside a complete
 * managed leaf boundary. They never become DeploymentFile baseline rows. */
export function buildUnmanagedRemovalEntries(
    authority: DeploymentRuntimeReplacementAuthorityV1 | undefined,
    planRelativePaths: ReadonlySet<string>,
    baselineRelativePaths: ReadonlySet<string>,
): JournalEntry[] {
    if (authority === undefined) return [];
    const files = new Map(authority.files.map((file) => [file.relativePath, file]));
    return (authority.unmanagedRemovalPaths ?? []).map((relativePath) => {
        if (planRelativePaths.has(relativePath) || baselineRelativePaths.has(relativePath)) {
            throw new Error("unmanaged removal overlaps one compiled or managed baseline path");
        }
        const file = files.get(relativePath);
        if (file?.expectedState !== "present") {
            throw new Error("unmanaged removal has no reviewed present-file authority");
        }
        return {
            relativePath,
            oldHash: "",
            oldBytesBase64: "",
            oldExecutable: false,
            oldProvenanceFingerprint: "",
            oldMaterializationFingerprint: "",
            runtimeRollbackOverride: {
                state: "present" as const,
                contentHash: sha256Bytes(file.expectedBytes),
                bytesBase64: bytesToBase64(file.expectedBytes),
                executable: file.expectedExecutable,
            },
            newHash: "",
            newBytesBase64: "",
            newExecutable: false,
            newProvenanceFingerprint: "",
            newMaterializationFingerprint: "",
            isRemoval: true,
            entryAuthority: "explicit_unmanaged_replacement" as const,
        };
    });
}

// ============================================================
// populateOldBytes: snapshot live runtime bytes (called pre-publish)
// ============================================================

/** Outcome of populating old bytes. */
export type PopulateOutcome = { kind: "ok" } | { kind: "read_failed"; relativePath: string };

/**
 * Validate each entry's already-populated durable old recovery bytes and probe
 * present runtime targets for readability. The live bytes are deliberately not
 * copied into the journal: if they differ from the successful baseline they are
 * a third value owned by the user, not a new recovery authority.
 *
 * NOTE on zero-byte files: durable oldBytesBase64 === "" is AMBIGUOUS with the
 * absent case at the byte level, but rollback distinguishes via `oldHash`
 * (absent → oldHash === ""; zero-byte present → oldHash = sha256 of empty
 * bytes, non-empty). So oldBytesBase64 alone must never be read as an absence
 * signal.
 *
 * Absence is NOT a failure — CAS decides whether it is old/new/third. Invalid
 * durable recovery bytes or an unreadable present file are failures.
 */
export function populateOldBytes(entries: JournalEntry[], ctx: TargetIoContext): PopulateOutcome {
    for (const entry of entries) {
        if (
            (entry.oldHash === "" && entry.oldBytesBase64 !== "") ||
            (entry.oldHash !== "" && sha256Bytes(base64ToBytes(entry.oldBytesBase64)) !== entry.oldHash)
        ) {
            return { kind: "read_failed", relativePath: entry.relativePath };
        }
        const abs = absPath(ctx, entry.relativePath);
        try {
            ioReadStableIfPresent(ctx, abs);
        } catch {
            return { kind: "read_failed", relativePath: entry.relativePath };
        }
    }
    return { kind: "ok" };
}

// ============================================================
// Internal
// ============================================================

function targetContentToBytes(tf: TargetFilePlan): Uint8Array {
    if (tf.content.contentKind === "text") {
        return new Uint8Array(Buffer.from(tf.content.text, "utf-8"));
    }
    return tf.content.bytes;
}
