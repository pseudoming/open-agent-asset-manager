import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
    AdapterReadResult,
    AttributedSemanticChange,
    ImportPreviewSnapshotV1,
    ProbeResult,
    RenderedFileAttributionResult,
    RenderedTargetInspectionResult,
    SourceReadStatus,
} from "@oaam/core";
import { afterEach, describe, expect, it } from "vitest";
import { createHostRenderApprovalAuthority } from "../src/render-approval-authority";
import { HostReviewRecordStore } from "../src/review-record-store";
import { HostReviewRecords, HostReviewRecordUnavailableError } from "../src/review-records";
import {
    H2_DIGEST,
    H2_SOURCE_ROOT_ID,
    h2Inspection,
    h2PreviewSnapshot,
    h2ProbeResult,
    h2ReadResult,
    h2RenderPreview,
} from "./support/h2-review-fixtures";
import { ASSET_ID, required } from "./support/host-test-fixtures";

const temporaryRoots: string[] = [];

function reviewHarness() {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-review-projection-"));
    temporaryRoots.push(rootPath);
    let recordNumber = 0;
    let memberNumber = 0;
    const store = new HostReviewRecordStore({
        rootPath,
        createToken: () => `review-${++recordNumber}`,
    });
    return {
        rootPath,
        store,
        records: new HostReviewRecords(store, () => `member-${++memberNumber}`),
    };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Host review projection and exact member resolution", () => {
    it("round-trips both reviewed Project root-access states", () => {
        const { records, store } = reviewHarness();
        for (const rootAccessState of ["available", "unavailable"] as const) {
            const token = records.recordProjectLifecycle("connection", {
                schemaVersion: 1,
                action: "restore",
                projectId: "00000000-0000-4000-8000-000000000001" as never,
                projectAuthorityFingerprint: H2_DIGEST,
                displayName: "Project",
                rootPath: "/project",
                rootAccessState,
            });
            expect(records.resolveProjectLifecycle(token)).toMatchObject({
                action: "restore",
                rootAccessState,
            });
        }
        store.close();
    });

    it("round-trips an exact stop-managing Project review", () => {
        const { records, store } = reviewHarness();
        const token = records.recordProjectLifecycle("connection", {
            schemaVersion: 1,
            action: "stop_managing",
            projectId: "00000000-0000-4000-8000-000000000001" as never,
            projectAuthorityFingerprint: H2_DIGEST,
            displayName: "Project",
            rootPath: "/project",
        });
        expect(records.resolveProjectLifecycle(token)).toEqual({
            schemaVersion: 1,
            action: "stop_managing",
            projectId: "00000000-0000-4000-8000-000000000001",
            projectAuthorityFingerprint: H2_DIGEST,
            displayName: "Project",
            rootPath: "/project",
        });
        store.close();
    });

    it("rejects a render preview that does not belong to its exact Deployment selection", () => {
        const { records, store } = reviewHarness();
        const selection = { schemaVersion: 1 as const, renderInputFingerprint: H2_DIGEST, semanticOptions: [] };
        expect(() => records.recordRenderPreview("connection", "other", selection, h2RenderPreview())).toThrow(
            /exact Deployment selection/u,
        );
        expect(() =>
            records.recordRenderPreview(
                "connection",
                h2RenderPreview().deploymentId,
                { ...selection, renderInputFingerprint: `sha256:${"b".repeat(64)}` as typeof H2_DIGEST },
                h2RenderPreview(),
            ),
        ).toThrow(/exact Deployment selection/u);
        store.close();
    });

    it("persists only exact operation-local render approval resolutions", () => {
        const { records, store } = reviewHarness();
        const selection = {
            schemaVersion: 1 as const,
            renderInputFingerprint: H2_DIGEST,
            semanticOptions: [
                {
                    optionFingerprint: H2_DIGEST,
                    approvalRequest: { approvalAction: "approve_once" as const, userActionId: "approve-migration" },
                },
            ],
        };
        const resolutions = createHostRenderApprovalAuthority(() => 55).createResolutions(selection);
        const review = records.recordRenderPreview(
            "connection",
            h2RenderPreview().deploymentId,
            selection,
            h2RenderPreview(),
            resolutions,
        );
        expect(records.resolveRenderPreview(review.previewToken).approvalResolutions).toEqual(resolutions);

        expect(() =>
            records.recordRenderPreview("connection", h2RenderPreview().deploymentId, selection, h2RenderPreview(), []),
        ).toThrow(/approvals do not belong/u);
        expect(() =>
            records.recordRenderPreview("connection", h2RenderPreview().deploymentId, selection, h2RenderPreview(), [
                {
                    ...required(resolutions[0], "render approval resolution is missing"),
                    optionFingerprint: `sha256:${"b".repeat(64)}`,
                },
            ]),
        ).toThrow(/approvals do not belong/u);
        store.close();
    });

    it("rejects repeated or unusable member identifiers before publishing a review record", () => {
        const { rootPath, store } = reviewHarness();
        const records = new HostReviewRecords(store, () => "same");
        expect(() => records.recordProbe("connection", [h2ProbeResult()])).toThrow(/member id/u);
        expect(() => new HostReviewRecords(store, () => " member ").recordProbe("connection", [h2ProbeResult()])).toThrow(
            /member id/u,
        );
        expect(fs.readdirSync(rootPath).filter((entry) => entry.endsWith(".record"))).toHaveLength(0);
        store.close();
    });

    it("projects probe relations and rejects unknown, duplicate, or cross-record member rows", () => {
        const { records, rootPath, store } = reviewHarness();
        const probe = h2ProbeResult();
        required(probe.observation.sourceRoots[0], "source root").locatorEvidence.push(
            {
                locatorKind: "runtime_declared_path",
                locatorKey: "settings_source",
                evidenceLevel: "docs_declared",
            },
            {
                locatorKind: "project_registry_entry",
                locatorKey: "workspace_registry",
                evidenceLevel: "local_artifact",
            },
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "project_claude",
                evidenceLevel: "filesystem_observed",
            },
        );
        const review = records.recordProbe("connection", [probe]);
        const resultRow = required(review.results[0], "probe result row");
        const sourceRow = required(resultRow.sources[0], "source root row");
        const projectRow = required(resultRow.projects[0], "project row");
        const targetRow = required(resultRow.targets[0], "target row");
        expect(review.results[0]).toMatchObject({
            adapterId: "CLAUDECODE",
            status: "complete",
            runtimes: [{ agentRuntimeId: "CLAUDE_CODE_CLI", sourceRootRowIds: [sourceRow.rowId] }],
            sources: [
                {
                    sourceRootId: H2_SOURCE_ROOT_ID,
                    locatorIdentities: [
                        { locatorKind: "runtime_known_rule", locatorKey: "project_claude" },
                        { locatorKind: "runtime_declared_path", locatorKey: "settings_source" },
                        { locatorKind: "project_registry_entry", locatorKey: "workspace_registry" },
                    ],
                },
            ],
            projects: [{ workspaceSourceRowIds: [sourceRow.rowId] }],
            targets: [{ targetKind: "project" }],
        });
        expect(records.resolveProbeResult(review.probeToken, resultRow.rowId)).toEqual(probe);
        expect(records.resolveProbeSources(review.probeToken, resultRow.rowId, [sourceRow.rowId])).toEqual({
            result: probe,
            sourceRootIds: [H2_SOURCE_ROOT_ID],
        });
        const firstTargetResolution = records.resolveProbeTarget(review.probeToken, resultRow.rowId, targetRow.rowId);
        const secondTargetResolution = records.resolveProbeTarget(review.probeToken, resultRow.rowId, targetRow.rowId);
        expect(firstTargetResolution).toEqual({
            result: probe,
            currentProbeResults: [probe],
            targetKind: "project",
            targetRootPath: "/project",
        });
        expect(firstTargetResolution.currentProbeResults).toBe(secondTargetResolution.currentProbeResults);
        expect(Object.isFrozen(firstTargetResolution.currentProbeResults)).toBe(true);
        expect(Object.isFrozen(firstTargetResolution.currentProbeResults[0]?.observation)).toBe(true);
        expect(
            records.resolveProbeProjectRoot("connection", {
                probeToken: review.probeToken,
                probeResultRowId: resultRow.rowId,
                projectRowId: projectRow.rowId,
                sourceRootRowId: sourceRow.rowId,
            }),
        ).toBe("/project/.claude");
        expect(() =>
            records.resolveProbeProjectRoot("another-connection", {
                probeToken: review.probeToken,
                probeResultRowId: resultRow.rowId,
                projectRowId: projectRow.rowId,
                sourceRootRowId: sourceRow.rowId,
            }),
        ).toThrow(HostReviewRecordUnavailableError);
        expect(() =>
            records.resolveProbeProjectRoot("connection", {
                probeToken: review.probeToken,
                probeResultRowId: resultRow.rowId,
                projectRowId: "unknown",
                sourceRootRowId: sourceRow.rowId,
            }),
        ).toThrow(HostReviewRecordUnavailableError);
        expect(() =>
            records.resolveProbeProjectRoot("connection", {
                probeToken: review.probeToken,
                probeResultRowId: "unknown",
                projectRowId: projectRow.rowId,
                sourceRootRowId: sourceRow.rowId,
            }),
        ).toThrow(HostReviewRecordUnavailableError);

        const mismatchedProbeToken = store.put({
            kind: "probe",
            ownerConnectionId: "connection",
            replacementKey: "mismatched-probe",
            payload: {
                recordKind: "probe",
                results: [{ observation: { observedProjects: [], sourceRoots: [] } }],
                rows: [
                    {
                        rowId: "mismatched-result",
                        runtimeRowIds: [],
                        sourceRowIds: ["mismatched-source"],
                        projectRowIds: ["mismatched-project"],
                        targetRowIds: [],
                    },
                ],
            },
        });
        expect(() =>
            records.resolveProbeProjectRoot("connection", {
                probeToken: mismatchedProbeToken,
                probeResultRowId: "mismatched-result",
                projectRowId: "mismatched-project",
                sourceRootRowId: "mismatched-source",
            }),
        ).toThrow(HostReviewRecordUnavailableError);
        expect(store.remove(mismatchedProbeToken, "cancelled")).toBe(true);

        expect(() => records.resolveProbeResult(review.probeToken, "unknown")).toThrow(HostReviewRecordUnavailableError);
        expect(() => records.resolveProbeSources(review.probeToken, "unknown", [])).toThrow(HostReviewRecordUnavailableError);
        expect(() => records.resolveProbeSources(review.probeToken, resultRow.rowId, ["unknown"])).toThrow(
            HostReviewRecordUnavailableError,
        );
        expect(() => records.resolveProbeSources(review.probeToken, resultRow.rowId, [sourceRow.rowId, sourceRow.rowId])).toThrow(
            HostReviewRecordUnavailableError,
        );
        expect(() => records.resolveProbeTarget(review.probeToken, "unknown", "unknown")).toThrow(
            HostReviewRecordUnavailableError,
        );
        expect(() => records.resolveProbeTarget(review.probeToken, resultRow.rowId, "unknown")).toThrow(
            HostReviewRecordUnavailableError,
        );
        records.invalidateProbeOperationSnapshot(review.probeToken);
        expect(() => records.resolveProbeTarget(review.probeToken, resultRow.rowId, targetRow.rowId)).toThrow(
            HostReviewRecordUnavailableError,
        );

        const invalidProbe: ProbeResult = {
            ...probe,
            observation: {
                ...probe.observation,
                observedProjects: [
                    {
                        ...required(probe.observation.observedProjects[0], "observed project"),
                        workspaces: [{ sourceRootId: "unknown-source", role: "primary" }],
                    },
                ],
            },
        };
        expect(() => records.recordProbe("other", [invalidProbe])).toThrow(/unknown source root/u);
        const invalidRuntimeProbe: ProbeResult = {
            ...probe,
            observation: {
                ...probe.observation,
                observedAgentRuntimes: [
                    {
                        ...required(probe.observation.observedAgentRuntimes[0], "observed runtime"),
                        sourceRootIds: ["unknown-source"],
                    },
                ],
            },
        };
        expect(() => records.recordProbe("other", [invalidRuntimeProbe])).toThrow(/unknown source root/u);
        expect(fs.readdirSync(rootPath).filter((entry) => entry.endsWith(".record"))).toHaveLength(1);
        store.close();
    });

    it("keeps Provider, runtime, target, and entry diagnostics in their exact projection owners", () => {
        const { records, store } = reviewHarness();
        const probe = h2ProbeResult();
        const diagnostic = (code: string) => ({
            severity: "warning" as const,
            code,
            message: code,
            path: "",
            traceId: "",
            operation: "probe" as const,
            causeKind: "partial" as const,
            retryable: false,
            suggestedActions: [],
            rawSummary: "",
        });
        probe.diagnostics.push(diagnostic("provider.sibling_failed"));
        required(probe.observation.observedAgentRuntimes[0], "runtime").diagnostics.push(diagnostic("runtime.exact_failed"));
        const target = required(probe.observation.targetCandidates[0], "target");
        target.diagnostics.push(diagnostic("target.exact_failed"));
        required(target.entryApplicabilities[0], "entry applicability").diagnostics.push(diagnostic("entry.exact_failed"));

        const result = required(records.recordProbe("connection", [probe]).results[0], "review result");
        expect(result.diagnostics.map((item) => item.code)).toEqual(["provider.sibling_failed"]);
        expect(required(result.runtimes[0], "runtime row").diagnostics.map((item) => item.code)).toEqual([
            "runtime.exact_failed",
        ]);
        expect(required(result.targets[0], "target row").diagnostics.map((item) => item.code)).toEqual(["target.exact_failed"]);
        expect(
            required(required(result.targets[0], "target row").entryApplicabilities[0], "entry row").diagnostics.map(
                (item) => item.code,
            ),
        ).toEqual(["entry.exact_failed"]);
        store.close();
    });

    it("refuses unavailable and non-member roots while authorizing an exact selected multi-workspace member", () => {
        const unavailableHarness = reviewHarness();
        const unavailableProbe = h2ProbeResult();
        required(unavailableProbe.observation.sourceRoots[0], "source root").accessStatus = "unavailable";
        const unavailableReview = unavailableHarness.records.recordProbe("connection", [unavailableProbe]);
        const unavailableResult = required(unavailableReview.results[0], "probe result");
        expect(() =>
            unavailableHarness.records.resolveProbeProjectRoot("connection", {
                probeToken: unavailableReview.probeToken,
                probeResultRowId: unavailableResult.rowId,
                projectRowId: required(unavailableResult.projects[0], "project row").rowId,
                sourceRootRowId: required(unavailableResult.sources[0], "source row").rowId,
            }),
        ).toThrow(HostReviewRecordUnavailableError);
        unavailableHarness.store.close();

        const multiHarness = reviewHarness();
        const multiProbe = h2ProbeResult();
        const firstSource = required(multiProbe.observation.sourceRoots[0], "source root");
        multiProbe.observation.sourceRoots.push({
            ...firstSource,
            sourceRootId: "source-root-2",
            path: "/project/secondary",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "project_secondary",
                    evidenceLevel: "agent_runtime_verified",
                },
            ],
        });
        required(multiProbe.observation.observedAgentRuntimes[0], "runtime").sourceRootIds.push("source-root-2");
        required(multiProbe.observation.observedProjects[0], "project").workspaces.push({
            sourceRootId: "source-root-2",
            role: "secondary",
        });
        multiProbe.observation.sourceRoots.push({
            ...firstSource,
            sourceRootId: "unrelated-source-root",
            path: "/unrelated",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "unrelated_source",
                    evidenceLevel: "agent_runtime_verified",
                },
            ],
        });
        required(multiProbe.observation.observedAgentRuntimes[0], "runtime").sourceRootIds.push("unrelated-source-root");
        const multiReview = multiHarness.records.recordProbe("connection", [multiProbe]);
        const multiResult = required(multiReview.results[0], "probe result");
        const projectedProject = required(multiResult.projects[0], "project row");
        const projectedPrimary = required(multiResult.sources[0], "primary source row");
        const projectedSecondary = required(multiResult.sources[1], "secondary source row");
        const projectedUnrelated = required(multiResult.sources[2], "unrelated source row");
        expect(
            multiHarness.records.resolveProbeProjectRoot("connection", {
                probeToken: multiReview.probeToken,
                probeResultRowId: multiResult.rowId,
                projectRowId: projectedProject.rowId,
                sourceRootRowId: projectedPrimary.rowId,
            }),
        ).toBe(firstSource.path);
        expect(
            multiHarness.records.resolveProbeProjectRoot("connection", {
                probeToken: multiReview.probeToken,
                probeResultRowId: multiResult.rowId,
                projectRowId: projectedProject.rowId,
                sourceRootRowId: projectedSecondary.rowId,
            }),
        ).toBe("/project/secondary");
        expect(() =>
            multiHarness.records.resolveProbeProjectRoot("connection", {
                probeToken: multiReview.probeToken,
                probeResultRowId: multiResult.rowId,
                projectRowId: projectedProject.rowId,
                sourceRootRowId: projectedUnrelated.rowId,
            }),
        ).toThrow(HostReviewRecordUnavailableError);
        multiHarness.store.close();
    });

    it("maps every source read status and preserves the prior record when projection validation fails", () => {
        const { records, store } = reviewHarness();
        const probe = h2ProbeResult();
        const probeReview = records.recordProbe("connection", [probe]);
        const statuses: SourceReadStatus[] = [
            "scanned",
            "empty",
            "skipped_ignored_source",
            "not_found",
            "blocked",
            "permission_denied",
            "partial",
            "deferred",
            "unsupported",
            "malformed_source",
            "unknown_schema",
        ];
        const read: AdapterReadResult = {
            ...h2ReadResult(probe),
            sourceReports: statuses.map((status) => ({ sourceRootId: H2_SOURCE_ROOT_ID, status, diagnostics: [] })),
        };
        const review = records.recordRead("connection", probeReview.probeToken, [read]);
        expect(review.reports.map((report) => report.status)).toEqual([
            "complete",
            "complete",
            "complete",
            "not_found",
            "failed",
            "failed",
            "partial",
            "partial",
            "partial",
            "partial",
            "partial",
        ]);
        expect(review.candidateCount).toBe(1);
        expect(records.resolveRead(review.readToken)).toEqual([read]);

        const userSelected: AdapterReadResult = {
            ...read,
            readTarget: {
                ...read.readTarget,
                sourceSelector: {
                    selectorKind: "user_selected_root",
                    platformContext: probe.observation.platformContext,
                    binding: {
                        sourceRoot: required(probe.observation.sourceRoots[0], "source root"),
                        assetScope: "global",
                        projectRootPath: "",
                    },
                },
            },
        };
        expect(() => records.recordRead("connection", probeReview.probeToken, [userSelected])).toThrow(/user-selected-root/u);
        expect(records.resolveRead(review.readToken)).toEqual([read]);

        const unowned: AdapterReadResult = {
            ...read,
            readTarget: {
                ...read.readTarget,
                sourceSelector: {
                    selectorKind: "probe_roots",
                    observation: {
                        ...probe.observation,
                        observedAgentRuntimes: probe.observation.observedAgentRuntimes.map((runtime) => ({
                            ...runtime,
                            sourceRootIds: [],
                        })),
                    },
                    sourceRootIds: [H2_SOURCE_ROOT_ID],
                },
            },
        };
        expect(() => records.recordRead("connection", probeReview.probeToken, [unowned])).toThrow(/no owning agent runtime/u);
        store.close();
    });

    it("projects all preview statuses, bounded selectors, text and binary details without rebuilding files", () => {
        const { records, store } = reviewHarness();
        const probeReview = records.recordProbe("connection", [h2ProbeResult()]);
        const baseRead = h2ReadResult();
        const baseCandidate = required(baseRead.candidates[0], "base candidate");
        const baseFile = required(baseCandidate.files[0], "base candidate file");
        const candidates = [
            { ...baseCandidate, candidateId: "importable" },
            { ...baseCandidate, candidateId: "duplicate" },
            { ...baseCandidate, candidateId: "blocked" },
            { ...baseCandidate, candidateId: "incomplete", assetCandidateStatus: "incomplete" as const },
            {
                ...baseCandidate,
                candidateId: "many-files",
                files: Array.from({ length: 129 }, (_, index) => ({
                    ...baseFile,
                    logicalPath: `files/${String(index).padStart(3, "0")}.md`,
                })),
            },
            {
                ...baseCandidate,
                candidateId: "long-text",
                files: [{ ...baseFile, logicalPath: "long.md", text: "é".repeat(40_000) }],
            },
            {
                ...baseCandidate,
                candidateId: "code-unit-order",
                files: [
                    { ...baseFile, logicalPath: "ä.md" },
                    { ...baseFile, logicalPath: "z.md" },
                ],
            },
            {
                ...baseCandidate,
                candidateId: "many-bindings",
                files: [
                    {
                        ...baseFile,
                        references: Array.from({ length: 129 }, (_, index) => ({
                            kind: "execute" as const,
                            rawTarget: `tool-${index}`,
                            required: true,
                            diagnostics: [],
                            resolution: "unresolved" as const,
                        })),
                    },
                ],
            },
            {
                ...baseCandidate,
                candidateId: "memory-catalog",
                kind: "Memory",
                files: [],
                typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
                memoryCatalogMemberBindingInputs: [{ rawTarget: "topic.md", routingTitle: "Topic", routingHint: "hint" }],
            },
            {
                ...baseCandidate,
                candidateId: "memory-unit",
                kind: "Memory",
                typeData: {
                    schemaVersion: 2,
                    entityRole: "unit",
                    card: { name: "Topic", description: "topic" },
                    loading: { card: "high", body: "low" },
                    applicabilityRule: "",
                },
            },
        ];
        const read: AdapterReadResult = { ...baseRead, candidates };
        const readReview = records.recordRead("connection", probeReview.probeToken, [read]);
        const snapshot: ImportPreviewSnapshotV1 = {
            ...h2PreviewSnapshot(read),
            readResults: [read],
            items: [
                {
                    candidateId: "importable",
                    action: "create_asset",
                    freshness: "fresh",
                    callableBindingRequests: [
                        {
                            subject: { subjectKind: "workflow_execution_agent" },
                            rawTarget: "reviewer",
                            required: true,
                        },
                    ],
                    diagnostics: [],
                },
                {
                    candidateId: "duplicate",
                    action: "duplicate",
                    freshness: "fresh",
                    callableBindingRequests: [],
                    diagnostics: [],
                },
                { candidateId: "blocked", action: "blocked", freshness: "fresh", callableBindingRequests: [], diagnostics: [] },
                {
                    candidateId: "incomplete",
                    action: "incomplete",
                    freshness: "fresh",
                    callableBindingRequests: [],
                    diagnostics: [
                        {
                            severity: "error",
                            code: "antigravity.skill_trigger_frontmatter_unverified",
                            operation: "read",
                            causeKind: "invalid_schema",
                            retryable: false,
                            suggestedActions: ["skip"],
                            message: "provider-owned technical diagnostic",
                            path: "SKILL.md",
                        },
                    ],
                },
                {
                    candidateId: "many-files",
                    action: "create_asset",
                    freshness: "fresh",
                    callableBindingRequests: [],
                    diagnostics: [],
                },
                {
                    candidateId: "long-text",
                    action: "create_asset",
                    freshness: "fresh",
                    callableBindingRequests: [],
                    diagnostics: [],
                },
                {
                    candidateId: "code-unit-order",
                    action: "create_asset",
                    freshness: "fresh",
                    callableBindingRequests: [],
                    diagnostics: [],
                },
                {
                    candidateId: "many-bindings",
                    action: "create_asset",
                    freshness: "fresh",
                    callableBindingRequests: Array.from({ length: 129 }, (_, referenceIndex) => ({
                        subject: { subjectKind: "file_reference" as const, logicalPath: "AGENTS.md", referenceIndex },
                        rawTarget: `tool-${referenceIndex}`,
                        required: true,
                    })),
                    diagnostics: [],
                },
                {
                    candidateId: "memory-catalog",
                    action: "create_asset",
                    freshness: "fresh",
                    callableBindingRequests: [
                        {
                            subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                            rawTarget: "topic.md",
                            required: true,
                        },
                    ],
                    diagnostics: [],
                },
                {
                    candidateId: "memory-unit",
                    action: "create_asset",
                    freshness: "fresh",
                    callableBindingRequests: [],
                    diagnostics: [],
                },
            ],
        };
        const review = records.recordPreview("connection", readReview.readToken, snapshot);
        expect(review.candidates.map((candidate) => candidate.status)).toEqual([
            "importable",
            "duplicate",
            "blocked",
            "incomplete",
            "importable",
            "importable",
            "importable",
            "importable",
            "importable",
            "importable",
        ]);
        expect(review.candidates[0]).toMatchObject({
            callableBindingRequestCount: 1,
            callableBindingRequests: [
                {
                    subject: { subjectKind: "workflow_execution_agent" },
                    rawTarget: "reviewer",
                    required: true,
                },
            ],
            callableBindingRequestsTruncated: false,
        });
        expect(review.candidates[4]).toMatchObject({
            fileCount: 129,
            logicalPaths: expect.any(Array),
            logicalPathsTruncated: true,
        });
        expect(required(review.candidates[4], "many-files preview candidate").logicalPaths).toHaveLength(128);
        expect(review.candidates[3]).toMatchObject({
            diagnosticCodes: ["antigravity.skill_trigger_frontmatter_unverified"],
        });
        expect(review.candidates[7]).toMatchObject({
            callableBindingRequestCount: 129,
            callableBindingRequests: expect.any(Array),
            callableBindingRequestsTruncated: true,
        });
        expect(required(review.candidates[7], "many-bindings preview candidate").callableBindingRequests).toHaveLength(128);
        expect(review.candidates[8]).toMatchObject({
            kind: "Memory",
            memoryEntityRole: "catalog",
            callableBindingRequests: [
                {
                    subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                    rawTarget: "topic.md",
                    required: true,
                },
            ],
        });
        expect(review.candidates[9]).toMatchObject({ kind: "Memory", memoryEntityRole: "unit" });

        expect(records.previewDetail(review.previewToken, "importable")).toMatchObject({
            logicalPath: "AGENTS.md",
            contentKind: "text",
            text: { text: "# Guidance", truncated: false },
        });
        expect(records.previewDetail(review.previewToken, "importable", "assets/data.bin")).toMatchObject({
            logicalPath: "assets/data.bin",
            contentKind: "binary",
            byteLength: 3,
        });
        expect(records.previewDetail(review.previewToken, "code-unit-order")).toMatchObject({
            logicalPath: "z.md",
        });
        const long = records.previewDetail(review.previewToken, "long-text", "long.md");
        expect(long).toMatchObject({
            text: { byteLength: 80_000, truncated: true },
        });
        expect(new TextEncoder().encode(long.text?.text ?? "").byteLength).toBe(65_536);
        expect(() => records.previewDetail(review.previewToken, "unknown")).toThrow(HostReviewRecordUnavailableError);
        expect(() => records.previewDetail(review.previewToken, "importable", "unknown")).toThrow(
            HostReviewRecordUnavailableError,
        );

        const oldSnapshot = records.resolvePreview(review.previewToken);
        const missingCandidateSnapshot: ImportPreviewSnapshotV1 = {
            ...snapshot,
            items: [
                {
                    candidateId: "missing",
                    action: "create_asset",
                    freshness: "fresh",
                    callableBindingRequests: [],
                    diagnostics: [],
                },
            ],
        };
        expect(() => records.recordPreview("connection", readReview.readToken, missingCandidateSnapshot)).toThrow(
            /no exact candidate/u,
        );
        expect(records.resolvePreview(review.previewToken)).toEqual(oldSnapshot);
        expect(records.cancelPreview(review.previewToken)).toBe(true);
        expect(records.cancelPreview(review.previewToken)).toBe(false);
        store.close();
    });

    it("projects every inspection change and attribution branch and enforces exact evidence membership", () => {
        const { records, store } = reviewHarness();
        const changes: AttributedSemanticChange[] = [
            {
                changeKind: "asset_type_data_replacement",
                changeFingerprint: H2_DIGEST,
                semanticRefFingerprints: [],
                replacement: { kind: "Guidance", typeData: { schemaVersion: 1 } },
            },
            {
                changeKind: "file_content_replacement",
                changeFingerprint: H2_DIGEST,
                semanticRefFingerprints: [],
                replacementContent: { contentKind: "binary", bytes: new Uint8Array([4, 5]) },
            },
            {
                changeKind: "file_deletion",
                changeFingerprint: H2_DIGEST,
                semanticRefFingerprints: [],
                fileId: ASSET_ID as AttributedSemanticChange & never,
            },
            {
                changeKind: "file_executable_replacement",
                changeFingerprint: H2_DIGEST,
                semanticRefFingerprints: [],
                fileId: ASSET_ID as AttributedSemanticChange & never,
                executable: true,
            },
            {
                changeKind: "file_addition",
                changeFingerprint: H2_DIGEST,
                semanticRefFingerprints: [],
                logicalPath: "new.md" as never,
                role: "resource",
                content: { contentKind: "text", text: "new" },
                executable: false,
            },
            {
                changeKind: "file_addition",
                changeFingerprint: H2_DIGEST,
                semanticRefFingerprints: [],
                logicalPath: "new.bin" as never,
                role: "resource",
                content: { contentKind: "binary", bytes: new Uint8Array([6]) },
                executable: false,
            },
        ];
        const files: RenderedFileAttributionResult[] = [
            {
                relativePath: "unique.md" as never,
                attributionState: "uniquely_attributable",
                changeFingerprints: [H2_DIGEST],
                hunkAttributions: [],
                diagnostics: [],
            },
            {
                relativePath: "whole.md" as never,
                attributionState: "whole_file_adoption_required",
                diagnostics: [],
            },
            {
                relativePath: "conflict.md" as never,
                attributionState: "conflict",
                reasonCode: "ambiguous",
                diagnostics: [],
            },
        ];
        const result: RenderedTargetInspectionResult = { ...h2Inspection(), changes, files };
        const review = records.recordInspection("connection", "deployment", result);
        expect(review).toMatchObject({
            changeCount: 6,
            conflictCount: 1,
            detailsTruncated: false,
        });
        expect(review.details[0]).toMatchObject({ detailKind: "file_attribution", displayName: "conflict.md" });
        const details = review.details.map((entry) => records.inspectionDetail(review.inspectionToken, entry.selector));
        const semantic = details.filter((entry) => entry.detailKind === "semantic_change");
        expect(semantic).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    changeKind: "asset_type_data_replacement",
                    content: expect.objectContaining({ contentKind: "text" }),
                }),
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    content: expect.objectContaining({ contentKind: "binary" }),
                }),
                expect.objectContaining({ changeKind: "file_deletion" }),
                expect.objectContaining({
                    changeKind: "file_executable_replacement",
                    content: expect.objectContaining({ contentKind: "text" }),
                }),
                expect.objectContaining({
                    changeKind: "file_addition",
                    content: expect.objectContaining({ contentKind: "text" }),
                }),
            ]),
        );
        expect(semantic.find((entry) => entry.changeKind === "file_deletion" && !("content" in entry))).toBeDefined();
        expect(details).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    detailKind: "file_attribution",
                    attributionState: "uniquely_attributable",
                }),
                expect.objectContaining({
                    detailKind: "file_attribution",
                    attributionState: "whole_file_adoption_required",
                }),
                expect.objectContaining({
                    detailKind: "file_attribution",
                    attributionState: "conflict",
                    reasonCode: "ambiguous",
                }),
            ]),
        );
        expect(records.resolveInspection(review.inspectionToken, "deployment", review.inspectionResultFingerprint)).toEqual(
            result,
        );
        expect(() => records.resolveInspection(review.inspectionToken, "other", review.inspectionResultFingerprint)).toThrow(
            HostReviewRecordUnavailableError,
        );
        expect(() => records.resolveInspection(review.inspectionToken, "deployment", "sha256:wrong")).toThrow(
            HostReviewRecordUnavailableError,
        );
        expect(() => records.inspectionDetail(review.inspectionToken, "unknown")).toThrow(HostReviewRecordUnavailableError);
        expect(records.acceptInspection(review.inspectionToken)).toBe(true);
        expect(records.acceptInspection(review.inspectionToken)).toBe(false);

        const manyFiles: RenderedTargetInspectionResult = {
            ...h2Inspection(),
            changes: [],
            files: Array.from({ length: 129 }, (_, index) => ({
                relativePath: `file-${index}.md` as never,
                attributionState: "whole_file_adoption_required" as const,
                diagnostics: [],
            })),
        };
        const truncated = records.recordInspection("connection", "many", manyFiles);
        expect(truncated.details).toHaveLength(128);
        expect(truncated.detailsTruncated).toBe(true);
        store.close();
    });

    it("rejects manually published records whose exact kind or retained closure is inconsistent", () => {
        const { records, store } = reviewHarness();
        const invalidProbe = store.put({
            kind: "probe",
            ownerConnectionId: "c",
            replacementKey: "bad-probe",
            payload: { recordKind: "probe", results: [], rows: [{}] },
        });
        expect(() => records.resolveProbeResult(invalidProbe, "row")).toThrow(HostReviewRecordUnavailableError);

        const invalidRead = store.put({
            kind: "read",
            ownerConnectionId: "c",
            replacementKey: "bad-read",
            payload: {
                recordKind: "read",
                probeToken: "probe",
                results: [{ readAuthorityFingerprint: H2_DIGEST, readSnapshotFingerprint: H2_DIGEST }],
                readFingerprints: [`${H2_DIGEST}\0sha256:${"b".repeat(64)}`],
            },
        });
        expect(() => records.resolveRead(invalidRead)).toThrow(HostReviewRecordUnavailableError);
        const malformedRead = store.put({
            kind: "read",
            ownerConnectionId: "c",
            replacementKey: "malformed-read",
            payload: { recordKind: "read" },
        });
        expect(() => records.resolveRead(malformedRead)).toThrow(HostReviewRecordUnavailableError);

        const invalidPreview = store.put({
            kind: "import_preview",
            ownerConnectionId: "c",
            replacementKey: "bad-preview",
            payload: {
                recordKind: "import_preview",
                readToken: "read",
                snapshot: { snapshotFingerprint: H2_DIGEST },
                snapshotFingerprint: `sha256:${"b".repeat(64)}`,
            },
        });
        expect(() => records.resolvePreview(invalidPreview)).toThrow(HostReviewRecordUnavailableError);

        const invalidInspection = store.put({
            kind: "rendered_inspection",
            ownerConnectionId: "c",
            replacementKey: "bad-inspection",
            payload: {
                recordKind: "rendered_inspection",
                deploymentId: "deployment",
                result: { inspectionResultFingerprint: H2_DIGEST },
                inspectionResultFingerprint: H2_DIGEST,
                details: [{ selector: "selector", detailKind: "unknown", index: 0, displayName: "bad" }],
            },
        });
        expect(() => records.resolveInspection(invalidInspection, "deployment", H2_DIGEST)).toThrow(
            HostReviewRecordUnavailableError,
        );

        const invalidProjectLifecycle = store.put({
            kind: "project_lifecycle",
            ownerConnectionId: "c",
            replacementKey: "bad-project-lifecycle",
            payload: {
                recordKind: "project_lifecycle",
                preparation: {},
            },
        });
        expect(() => records.resolveProjectLifecycle(invalidProjectLifecycle)).toThrow(HostReviewRecordUnavailableError);
        store.close();
    });
});
