import type { OperationDiagnostic, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { projectAssetVersionManifest } from "../src/catalog-projection";
import { projectCoreOutcome, projectedOutcomeOperationalDiagnosticCodes } from "../src/core-outcome";
import { ASSET_ID, PROJECT_ID, SHA, VERSION_ID } from "./support/host-test-fixtures";

const DIGEST = SHA as Sha256Digest;

function importedManifest(overrides: Record<string, unknown> = {}) {
    return {
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        revision: 1,
        status: "complete",
        versionCanonicalContentFingerprint: DIGEST,
        files: [
            {
                fileId: PROJECT_ID,
                logicalPath: "AGENTS.md",
                role: "entry",
                mediaType: "text/markdown",
                contentKind: "text",
                contentHash: DIGEST,
                byteSize: 7,
                executable: false,
            },
        ],
        originAuthority: { originKind: "import" },
        importProvenanceAuthority: {
            schemaVersion: 2,
            sourceSnapshot: {
                adapterId: "ANTIGRAVITY",
                snapshotFingerprint: DIGEST,
                roots: [
                    {
                        sourceRootId: "root-1",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        path: "/workspace/demo-plugin",
                    },
                ],
                entries: [
                    {
                        entryKind: "file",
                        sourceRootId: "root-1",
                        relativePath: "AGENTS.md",
                        contentHash: DIGEST,
                    },
                ],
            },
        },
        createdAt: 3,
        ...overrides,
    } as never;
}

function diagnostic(rawSummary: string): OperationDiagnostic {
    return {
        severity: "warning",
        code: "claudecode_cli_version_observation_failed",
        message: "The exact executable observation failed",
        path: "",
        traceId: "",
        operation: "probe",
        causeKind: "partial",
        retryable: true,
        suggestedActions: ["retry"],
        rawSummary,
    };
}

describe("Host probe-diagnostic and import-provenance projections", () => {
    it("retains only the bounded executable-observation owner for ordinary diagnostics", () => {
        const projected = projectCoreOutcome(
            {
                status: "partial" as const,
                value: 2,
                diagnostics: [
                    diagnostic(
                        JSON.stringify({
                            schemaVersion: 2,
                            stage: "runtime_observation",
                            failure: "cleanup_incomplete",
                            ownerCode: "runtime_observation_wsl_process_transition_selected_wsl_invocation_exceeded_its_deadline",
                            exitKind: "zero",
                            identity: "stable",
                            timeout: "within_bound",
                            cleanup: "incomplete",
                        }),
                    ),
                ],
            },
            String,
        );

        expect(projectedOutcomeOperationalDiagnosticCodes(projected)).toEqual([
            "provider.executable_observation.v2:stage=runtime_observation:owner=runtime_observation_wsl_process_transition_selected_wsl_invocation_exceeded_its_deadline:failure=cleanup_incomplete:exit=zero:identity=stable:timeout=within_bound:cleanup=incomplete",
        ]);
        const rejected = projectCoreOutcome(
            {
                status: "partial" as const,
                value: 2,
                diagnostics: [
                    diagnostic(
                        JSON.stringify({
                            schemaVersion: 2,
                            stage: "runtime_observation",
                            failure: "other",
                            ownerCode: "private/path/secret",
                            exitKind: "zero",
                            identity: "stable",
                            timeout: "within_bound",
                            cleanup: "complete",
                        }),
                    ),
                ],
            },
            String,
        );
        expect(projectedOutcomeOperationalDiagnosticCodes(rejected)).toEqual([]);
    });

    it("rejects malformed executable-observation receipts without retaining private facts", () => {
        const valid = {
            schemaVersion: 2,
            stage: "runtime_observation",
            failure: "other",
            ownerCode: "unclassified",
            exitKind: "unavailable",
            identity: "unverified",
            timeout: "unverified",
            cleanup: "unverified",
        };
        const malformed = [
            "",
            "x".repeat(2_049),
            "{",
            "null",
            JSON.stringify({ ...valid, extra: true }),
            JSON.stringify({ ...valid, schemaVersion: 1 }),
            ...(["stage", "failure", "ownerCode", "exitKind", "identity", "timeout", "cleanup"] as const).map((key) =>
                JSON.stringify({ ...valid, [key]: "private-invalid-value" }),
            ),
        ];

        expect(projectedOutcomeOperationalDiagnosticCodes(null)).toEqual([]);
        expect(projectedOutcomeOperationalDiagnosticCodes({ diagnostics: null })).toEqual([]);
        expect(projectedOutcomeOperationalDiagnosticCodes({ diagnostics: [null] })).toEqual([]);
        for (const rawSummary of malformed) {
            const projected = projectCoreOutcome(
                { status: "partial" as const, value: 2, diagnostics: [diagnostic(rawSummary)] },
                String,
            );
            expect(projectedOutcomeOperationalDiagnosticCodes(projected)).toEqual([]);
        }
    });

    it("retains only a bounded selected-WSL worker owner for ordinary diagnostics", () => {
        const rawSummary = JSON.stringify({
            schemaVersion: 1,
            stage: "host_projection",
            failure: "worker_protocol_failed",
            itemIndex: null,
        });
        const projected = projectCoreOutcome(
            { status: "partial" as const, value: 2, diagnostics: [diagnostic(rawSummary)] },
            String,
        );
        expect(projectedOutcomeOperationalDiagnosticCodes(projected)).toEqual([
            "provider.selected_wsl_observation.v1:stage=host_projection:failure=worker_protocol_failed:item=none",
        ]);
        expect(JSON.stringify(projected)).not.toContain(rawSummary);

        const indexedRawSummary = JSON.stringify({
            schemaVersion: 1,
            stage: "item_observation",
            failure: "identity_changed",
            itemIndex: 2,
        });
        const indexed = projectCoreOutcome(
            { status: "partial" as const, value: 2, diagnostics: [diagnostic(indexedRawSummary)] },
            String,
        );
        expect(projectedOutcomeOperationalDiagnosticCodes(indexed)).toEqual([
            "provider.selected_wsl_observation.v1:stage=item_observation:failure=identity_changed:item=2",
        ]);
        expect(JSON.stringify(indexed)).not.toContain(indexedRawSummary);

        for (const malformed of [
            JSON.stringify({ schemaVersion: 1, stage: "private", failure: "worker_protocol_failed", itemIndex: null }),
            JSON.stringify({ schemaVersion: 1, stage: "host_projection", failure: "private", itemIndex: null }),
            JSON.stringify({
                schemaVersion: 1,
                stage: "host_projection",
                failure: "worker_protocol_failed",
                itemIndex: 256,
            }),
            JSON.stringify({
                schemaVersion: 1,
                stage: "host_projection",
                failure: "worker_protocol_failed",
                itemIndex: null,
                privatePath: "C:\\secret",
            }),
        ]) {
            const rejected = projectCoreOutcome(
                { status: "partial" as const, value: 2, diagnostics: [diagnostic(malformed)] },
                String,
            );
            expect(projectedOutcomeOperationalDiagnosticCodes(rejected)).toEqual([]);
        }
    });

    it("projects the exact imported source without exposing Asset bytes", () => {
        const projected = projectAssetVersionManifest(importedManifest());

        expect(projected).toMatchObject({
            importSource: {
                adapterId: "ANTIGRAVITY",
                sourceSnapshotFingerprint: "a".repeat(64),
                roots: [
                    {
                        sourceRootId: "root-1",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        canonicalPath: "/workspace/demo-plugin",
                    },
                ],
                files: [
                    {
                        sourceRootId: "root-1",
                        relativePath: "AGENTS.md",
                        contentHash: "a".repeat(64),
                    },
                ],
            },
        });
    });

    it("omits import provenance unless the exact schema contains both a root and file", () => {
        const directoryEntry = {
            entryKind: "directory",
            sourceRootId: "root-1",
            relativePath: "nested",
        };
        const cases = [
            importedManifest({ originAuthority: { originKind: "native" } }),
            importedManifest({
                importProvenanceAuthority: {
                    schemaVersion: 1,
                    sourceSnapshot: { roots: [], entries: [] },
                },
            }),
            importedManifest({
                importProvenanceAuthority: {
                    schemaVersion: 2,
                    sourceSnapshot: { adapterId: "ANTIGRAVITY", snapshotFingerprint: DIGEST, roots: [], entries: [] },
                },
            }),
            importedManifest({
                importProvenanceAuthority: {
                    schemaVersion: 2,
                    sourceSnapshot: {
                        adapterId: "ANTIGRAVITY",
                        snapshotFingerprint: DIGEST,
                        roots: [
                            {
                                sourceRootId: "root-1",
                                rootRole: "project_actual",
                                sourceDomain: "project_root",
                                path: "/workspace/demo-plugin",
                            },
                        ],
                        entries: [directoryEntry],
                    },
                },
            }),
        ];

        for (const manifest of cases) {
            expect(projectAssetVersionManifest(manifest)).not.toHaveProperty("importSource");
        }
    });
});
