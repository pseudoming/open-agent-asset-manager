/** Shared deterministic fixtures for the split Deployment tests. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TargetPlan } from "../../../src/deployment/deployment-target-plan";
import type { ActiveDeploymentBaseline } from "../../../src/deployment/deployment-state-ops";
import { bytesToBase64, sha256Bytes } from "../../../src/foundation/crypto-bytes";

export const SHA_OLD = `sha256:${"a".repeat(64)}`;

export const SHA_NEW = `sha256:${"b".repeat(64)}`;

export function sha(s: string): string {
    return sha256Bytes(Buffer.from(s, "utf-8"));
}

export function b64(s: string): string {
    return bytesToBase64(Buffer.from(s, "utf-8"));
}

export function sha256OfBytes(bytes: Uint8Array): string {
    return sha256Bytes(bytes);
}

export function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "oaam-tio-"));
}

export function baselineRow(rel: string, hash: string, executable = false): ActiveDeploymentBaseline {
    return {
        deploymentFileId: `dfid-${rel}`,
        deploymentId: "d1",
        relativePath: rel,
        managedDirectoryBoundaryPaths: [],
        baselineState: {
            rowState: "active",
            appliedPayload: {
                contentKind: "text",
                contentHash: hash as `sha256:${string}`,
                byteSize: 1,
            },
            appliedExecutable: executable,
            provenance: {
                schemaVersion: 1,
                provenanceFingerprint: SHA_OLD as `sha256:${string}`,
                appliedRenderSnapshotFingerprint: SHA_OLD as `sha256:${string}`,
                outputUnitFingerprint: SHA_OLD as `sha256:${string}`,
                materializationFingerprint: SHA_OLD as `sha256:${string}`,
                semanticRefFingerprints: [],
                sectionBindings: [],
            },
        },
        observedState: "present",
        observedContentHash: hash,
        observedExecutable: executable ? 1 : 0,
        observedAt: 1000,
        deleted: 0,
        createdAt: 900,
        updatedAt: 1000,
    };
}

export function textPlan(rel: string, text: string, executable = false): TargetPlan {
    return {
        schemaVersion: 1,
        managedDirectoryBoundaries: [],
        targetFiles: [
            {
                relativePath: rel,
                content: { contentKind: "text", text },
                executable,
                renderedSectionIds: [],
            },
        ],
    };
}

export function multiPlan(...files: Array<{ rel: string; text: string; executable?: boolean }>): TargetPlan {
    return {
        schemaVersion: 1,
        managedDirectoryBoundaries: [],
        targetFiles: files.map((f) => ({
            relativePath: f.rel,
            content: { contentKind: "text" as const, text: f.text },
            executable: f.executable ?? false,
            renderedSectionIds: [],
        })),
    };
}

export function writeFile(root: string, rel: string, content: string | Buffer): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

export function readFile(root: string, rel: string): string {
    return fs.readFileSync(path.join(root, rel), "utf-8");
}

export function exists(root: string, rel: string): boolean {
    return fs.existsSync(path.join(root, rel));
}
