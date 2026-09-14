import * as crypto from "node:crypto";
import type {
    AdapterReadResult,
    AttributedSemanticChange,
    DeploymentRenderPreviewView,
    ImportPreviewSnapshotV1,
    ProbeResult,
    ProjectLifecyclePreparationV1,
    RenderedFileAttributionResult,
    RenderedTargetInspectionResult,
    RenderSelectionRequest,
    SourceRoot,
    StateBackupPreparationV1,
    StateRestorePreparationV1,
    TargetFileContent,
} from "@oaam/core";
import { projectDiagnostic, toProtocolSha256 } from "./core-outcome";
import {
    requireImportPreviewCandidate,
    requireImportPreviewCandidateFile,
    resolveImportPreviewFileDirectoryFromSnapshot,
} from "./import-preview-file-authority";
import { projectImportPreviewCandidates } from "./import-preview-projection";
import { inspectionChangeDisplayName } from "./inspection-change-display";
import {
    type HostOneTimeRenderApprovalResolution,
    hostRenderApprovalResolutionsMatchSelection,
    isHostOneTimeRenderApprovalResolution,
} from "./render-approval-authority";
import { projectDeploymentRenderPreview } from "./render-projection";
import { isDeploymentRenderPreviewView } from "./render-preview-review-validation";
import { HostProbeOperationSnapshots } from "./probe-operation-snapshots";
import { projectProbeEnvironmentReferences } from "./probe-environment-reference-projection";
import { projectProbeProjectRows } from "./probe-review-project-projection";
import type { HostReviewRecordStore } from "./review-record-store";
import { isPreparedSupportBundle, type PreparedSupportBundle } from "./support-bundle";
const MAXIMUM_SUMMARY_SELECTORS = 128;
const MAXIMUM_TEXT_DETAIL_BYTES = 64 * 1024;

interface ProbeResultRows {
    readonly rowId: string;
    readonly runtimeRowIds: readonly string[];
    readonly sourceRowIds: readonly string[];
    readonly projectRowIds: readonly string[];
    readonly targetRowIds: readonly string[];
}

interface ProbeReviewRecord {
    readonly recordKind: "probe";
    readonly results: ProbeResult[];
    readonly rows: ProbeResultRows[];
}

interface ReadReviewRecord {
    readonly recordKind: "read";
    readonly probeToken: string;
    readonly results: AdapterReadResult[];
    readonly readFingerprints: readonly string[];
}

interface ImportPreviewReviewRecord {
    readonly recordKind: "import_preview";
    readonly readToken: string;
    readonly snapshot: ImportPreviewSnapshotV1;
    readonly snapshotFingerprint: string;
}

interface RenderPreviewReviewRecord {
    readonly recordKind: "render_preview";
    readonly deploymentId: string;
    readonly selectionRequest: RenderSelectionRequest;
    readonly preview: DeploymentRenderPreviewView;
    readonly previewFingerprint: string;
    readonly approvalResolutions: readonly HostOneTimeRenderApprovalResolution[];
}

interface InspectionDetailMember {
    readonly selector: string;
    readonly detailKind: "semantic_change" | "file_attribution";
    readonly index: number;
    readonly displayName: string;
}

interface RenderedInspectionReviewRecord {
    readonly recordKind: "rendered_inspection";
    readonly deploymentId: string;
    readonly result: RenderedTargetInspectionResult;
    readonly inspectionResultFingerprint: string;
    readonly details: InspectionDetailMember[];
}

interface StateBackupReviewRecord {
    readonly recordKind: "state_backup";
    readonly preparation: StateBackupPreparationV1;
    readonly preparationFingerprint: string;
}

interface StateRestoreReviewRecord {
    readonly recordKind: "state_restore";
    readonly preparation: StateRestorePreparationV1;
    readonly preparationFingerprint: string;
}

interface ProjectLifecycleReviewRecord {
    readonly recordKind: "project_lifecycle";
    readonly preparation: ProjectLifecyclePreparationV1;
}

export class HostReviewRecordUnavailableError extends Error {
    public constructor(public readonly failureKind: "record" | "member") {
        super(`Host review ${failureKind} is unavailable`);
        this.name = "HostReviewRecordUnavailableError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value).sort();
    const sorted = [...expected].sort();
    return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function projectSourceLocatorIdentities(source: SourceRoot) {
    const identities = new Map<
        string,
        { locatorKind: SourceRoot["locatorEvidence"][number]["locatorKind"]; locatorKey: string }
    >();
    for (const evidence of source.locatorEvidence) {
        identities.set(`${evidence.locatorKind}\0${evidence.locatorKey}`, {
            locatorKind: evidence.locatorKind,
            locatorKey: evidence.locatorKey,
        });
    }
    return [...identities.values()];
}

function isProbeReviewRecord(value: unknown): value is ProbeReviewRecord {
    return (
        isRecord(value) &&
        hasExactKeys(value, ["recordKind", "results", "rows"]) &&
        value.recordKind === "probe" &&
        Array.isArray(value.results) &&
        Array.isArray(value.rows) &&
        value.results.length === value.rows.length &&
        value.rows.every(
            (row) =>
                isRecord(row) &&
                hasExactKeys(row, ["rowId", "runtimeRowIds", "sourceRowIds", "projectRowIds", "targetRowIds"]) &&
                typeof row.rowId === "string" &&
                isStringArray(row.runtimeRowIds) &&
                isStringArray(row.sourceRowIds) &&
                isStringArray(row.projectRowIds) &&
                isStringArray(row.targetRowIds),
        )
    );
}

function isReadReviewRecord(value: unknown): value is ReadReviewRecord {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, ["recordKind", "probeToken", "results", "readFingerprints"]) ||
        value.recordKind !== "read" ||
        typeof value.probeToken !== "string" ||
        !Array.isArray(value.results) ||
        !isStringArray(value.readFingerprints) ||
        value.readFingerprints.length !== value.results.length
    ) {
        return false;
    }
    const fingerprints = value.readFingerprints;
    return value.results.every((result, index) => {
        const [authorityFingerprint, snapshotFingerprint] = (fingerprints[index] as string).split("\0");
        return (
            isRecord(result) &&
            result.readAuthorityFingerprint === authorityFingerprint &&
            result.readSnapshotFingerprint === snapshotFingerprint
        );
    });
}

function isImportPreviewReviewRecord(value: unknown): value is ImportPreviewReviewRecord {
    return (
        isRecord(value) &&
        hasExactKeys(value, ["recordKind", "readToken", "snapshot", "snapshotFingerprint"]) &&
        value.recordKind === "import_preview" &&
        typeof value.readToken === "string" &&
        typeof value.snapshotFingerprint === "string" &&
        isRecord(value.snapshot) &&
        value.snapshot.snapshotFingerprint === value.snapshotFingerprint
    );
}

function isRenderPreviewReviewRecord(value: unknown): value is RenderPreviewReviewRecord {
    return (
        isRecord(value) &&
        hasExactKeys(value, [
            "recordKind",
            "deploymentId",
            "selectionRequest",
            "preview",
            "previewFingerprint",
            "approvalResolutions",
        ]) &&
        value.recordKind === "render_preview" &&
        typeof value.deploymentId === "string" &&
        typeof value.previewFingerprint === "string" &&
        isRecord(value.selectionRequest) &&
        value.selectionRequest.renderInputFingerprint !== undefined &&
        isDeploymentRenderPreviewView(value.preview) &&
        value.preview.deploymentId === value.deploymentId &&
        value.preview.renderInputFingerprint === value.selectionRequest.renderInputFingerprint &&
        value.preview.previewFingerprint === value.previewFingerprint &&
        Array.isArray(value.approvalResolutions) &&
        value.approvalResolutions.every(isHostOneTimeRenderApprovalResolution) &&
        hostRenderApprovalResolutionsMatchSelection(
            value.selectionRequest as unknown as RenderSelectionRequest,
            value.approvalResolutions,
        )
    );
}

function isInspectionDetailMember(value: unknown): value is InspectionDetailMember {
    return (
        isRecord(value) &&
        hasExactKeys(value, ["selector", "detailKind", "index", "displayName"]) &&
        typeof value.selector === "string" &&
        (value.detailKind === "semantic_change" || value.detailKind === "file_attribution") &&
        Number.isSafeInteger(value.index) &&
        (value.index as number) >= 0 &&
        typeof value.displayName === "string"
    );
}

function isRenderedInspectionReviewRecord(value: unknown): value is RenderedInspectionReviewRecord {
    return (
        isRecord(value) &&
        hasExactKeys(value, ["recordKind", "deploymentId", "result", "inspectionResultFingerprint", "details"]) &&
        value.recordKind === "rendered_inspection" &&
        typeof value.deploymentId === "string" &&
        typeof value.inspectionResultFingerprint === "string" &&
        isRecord(value.result) &&
        value.result.inspectionResultFingerprint === value.inspectionResultFingerprint &&
        Array.isArray(value.details) &&
        value.details.every(isInspectionDetailMember)
    );
}

function isStateBackupReviewRecord(value: unknown): value is StateBackupReviewRecord {
    return (
        isRecord(value) &&
        hasExactKeys(value, ["recordKind", "preparation", "preparationFingerprint"]) &&
        value.recordKind === "state_backup" &&
        typeof value.preparationFingerprint === "string" &&
        isRecord(value.preparation) &&
        value.preparation.preparationFingerprint === value.preparationFingerprint
    );
}

function isStateRestoreReviewRecord(value: unknown): value is StateRestoreReviewRecord {
    return (
        isRecord(value) &&
        hasExactKeys(value, ["recordKind", "preparation", "preparationFingerprint"]) &&
        value.recordKind === "state_restore" &&
        typeof value.preparationFingerprint === "string" &&
        isRecord(value.preparation) &&
        value.preparation.preparationFingerprint === value.preparationFingerprint
    );
}

function isProjectLifecyclePreparation(value: unknown): value is ProjectLifecyclePreparationV1 {
    if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.projectId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.projectId) ||
        typeof value.projectAuthorityFingerprint !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.projectAuthorityFingerprint)
    ) {
        return false;
    }
    if (value.action === "rename") {
        return (
            hasExactKeys(value, [
                "schemaVersion",
                "action",
                "projectId",
                "projectAuthorityFingerprint",
                "rootPath",
                "currentDisplayName",
                "nextDisplayName",
            ]) &&
            typeof value.rootPath === "string" &&
            typeof value.currentDisplayName === "string" &&
            typeof value.nextDisplayName === "string"
        );
    }
    if (value.action === "rebind") {
        return (
            hasExactKeys(value, [
                "schemaVersion",
                "action",
                "projectId",
                "projectAuthorityFingerprint",
                "displayName",
                "currentRootPath",
                "nextRootPath",
            ]) &&
            typeof value.displayName === "string" &&
            typeof value.currentRootPath === "string" &&
            typeof value.nextRootPath === "string"
        );
    }
    if (value.action === "restore") {
        return (
            hasExactKeys(value, [
                "schemaVersion",
                "action",
                "projectId",
                "projectAuthorityFingerprint",
                "displayName",
                "rootPath",
                "rootAccessState",
            ]) &&
            typeof value.displayName === "string" &&
            typeof value.rootPath === "string" &&
            (value.rootAccessState === "available" || value.rootAccessState === "unavailable")
        );
    }
    return (
        value.action === "stop_managing" &&
        hasExactKeys(value, ["schemaVersion", "action", "projectId", "projectAuthorityFingerprint", "displayName", "rootPath"]) &&
        typeof value.displayName === "string" &&
        typeof value.rootPath === "string"
    );
}

function isProjectLifecycleReviewRecord(value: unknown): value is ProjectLifecycleReviewRecord {
    return (
        isRecord(value) &&
        hasExactKeys(value, ["recordKind", "preparation"]) &&
        value.recordKind === "project_lifecycle" &&
        isProjectLifecyclePreparation(value.preparation)
    );
}

function readStatus(status: AdapterReadResult["sourceReports"][number]["status"]) {
    switch (status) {
        case "scanned":
        case "empty":
        case "skipped_ignored_source":
            return "complete" as const;
        case "not_found":
            return "not_found" as const;
        case "blocked":
        case "permission_denied":
            return "failed" as const;
        default:
            return "partial" as const;
    }
}

function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function boundedText(text: string) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= MAXIMUM_TEXT_DETAIL_BYTES) {
        return { text, byteLength: bytes.byteLength, truncated: false };
    }
    let result = "";
    let used = 0;
    for (const character of text) {
        const byteLength = new TextEncoder().encode(character).byteLength;
        if (used + byteLength > MAXIMUM_TEXT_DETAIL_BYTES) break;
        result += character;
        used += byteLength;
    }
    return { text: result, byteLength: bytes.byteLength, truncated: true };
}

function projectContent(content: TargetFileContent, mediaType: string) {
    if (content.contentKind === "binary") {
        return {
            contentKind: "binary" as const,
            mediaType,
            byteLength: content.bytes.byteLength,
            contentHash: sha256(content.bytes),
        };
    }
    const bytes = new TextEncoder().encode(content.text);
    return {
        contentKind: "text" as const,
        mediaType,
        text: boundedText(content.text),
        contentHash: sha256(bytes),
    };
}

function projectSemanticContent(change: AttributedSemanticChange) {
    switch (change.changeKind) {
        case "asset_type_data_replacement":
            return projectContent({ contentKind: "text", text: JSON.stringify(change.replacement) }, "application/json");
        case "file_content_replacement":
            return projectContent(
                change.replacementContent,
                change.replacementContent.contentKind === "text" ? "text/plain" : "application/octet-stream",
            );
        case "file_addition":
            return projectContent(
                change.content,
                change.content.contentKind === "text" ? "text/plain" : "application/octet-stream",
            );
        case "file_executable_replacement":
            return projectContent(
                { contentKind: "text", text: JSON.stringify({ executable: change.executable }) },
                "application/json",
            );
        case "file_deletion":
            return undefined;
    }
}

export class HostReviewRecords {
    readonly #store: HostReviewRecordStore;
    readonly #createMemberId: () => string;
    readonly #probeOperationSnapshots = new HostProbeOperationSnapshots();

    public constructor(store: HostReviewRecordStore, createMemberId: () => string) {
        this.#store = store;
        this.#createMemberId = createMemberId;
    }

    public recordProbe(ownerConnectionId: string, results: ProbeResult[]) {
        const memberIds = new Set<string>();
        const payload: ProbeReviewRecord = {
            recordKind: "probe",
            results,
            rows: results.map((result) => ({
                rowId: this.#newMemberId(memberIds),
                runtimeRowIds: result.observation.observedAgentRuntimes.map(() => this.#newMemberId(memberIds)),
                sourceRowIds: result.observation.sourceRoots.map(() => this.#newMemberId(memberIds)),
                projectRowIds: result.observation.observedProjects.map(() => this.#newMemberId(memberIds)),
                targetRowIds: result.observation.targetCandidates.map(() => this.#newMemberId(memberIds)),
            })),
        };
        const projectedResults = results.map((result, resultIndex) => {
            const rows = payload.rows[resultIndex] as ProbeResultRows;
            const sourceRowsByRootId = new Map(
                result.observation.sourceRoots.map((source, sourceIndex) => [
                    source.sourceRootId,
                    rows.sourceRowIds[sourceIndex] as string,
                ]),
            );
            return {
                rowId: rows.rowId,
                adapterId: result.observation.adapterId,
                environment: {
                    platform: result.observation.platformContext.platform,
                    platformInstanceId: result.observation.platformContext.platformInstanceId,
                },
                status: result.status,
                runtimes: result.observation.observedAgentRuntimes.map((runtime, index) => ({
                    rowId: rows.runtimeRowIds[index] as string,
                    agentRuntimeId: runtime.agentRuntimeId,
                    versionText: runtime.versionText,
                    installationStatus: runtime.installationStatus,
                    projectDiscoveryStatus: runtime.projectDiscoveryStatus,
                    sourceRootRowIds: runtime.sourceRootIds.map((sourceRootId) => {
                        const rowId = sourceRowsByRootId.get(sourceRootId);
                        if (rowId === undefined) throw new TypeError("Observed agent runtime references an unknown source root");
                        return rowId;
                    }),
                    diagnostics: runtime.diagnostics.map(projectDiagnostic),
                })),
                sources: result.observation.sourceRoots.map((source, index) => ({
                    rowId: rows.sourceRowIds[index] as string,
                    sourceRootId: source.sourceRootId,
                    rootRole: source.rootRole,
                    sourceDomain: source.sourceDomain,
                    displayPath: source.path,
                    accessStatus: source.accessStatus,
                    locatorIdentities: projectSourceLocatorIdentities(source),
                    diagnostics: source.diagnostics.map(projectDiagnostic),
                })),
                projects: projectProbeProjectRows(result, rows.sourceRowIds, rows.projectRowIds),
                targets: result.observation.targetCandidates.map((target, index) => ({
                    rowId: rows.targetRowIds[index] as string,
                    targetCandidateId: target.targetCandidateId,
                    targetKind: target.targetKind,
                    displayName: target.displayName,
                    displayPath: target.targetRootPath,
                    entryApplicabilities: target.entryApplicabilities.map((applicability) => ({
                        agentRuntimeId: applicability.agentRuntimeId,
                        status: applicability.status,
                        diagnostics: applicability.diagnostics.map(projectDiagnostic),
                    })),
                    diagnostics: target.diagnostics.map(projectDiagnostic),
                })),
                diagnostics: result.diagnostics.map(projectDiagnostic),
            };
        });
        const probeToken = this.#store.put({
            kind: "probe",
            ownerConnectionId,
            replacementKey: "probe",
            payload,
        });
        this.#probeOperationSnapshots.record(probeToken, payload.rows, payload.results);
        return {
            probeToken,
            results: projectedResults,
        };
    }

    public resolveProbeResult(probeToken: string, resultRowId: string): ProbeResult {
        const payload = this.#require(probeToken, "probe", isProbeReviewRecord);
        const index = payload.rows.findIndex((row) => row.rowId === resultRowId);
        if (index < 0) throw new HostReviewRecordUnavailableError("member");
        return payload.results[index] as ProbeResult;
    }
    public listProbeEnvironmentReferences(owner: string, token: string) {
        return projectProbeEnvironmentReferences(this.#requireOwned(token, "probe", owner, isProbeReviewRecord).results);
    }
    public resolveProbeProjectRoot(
        ownerConnectionId: string,
        reference: {
            readonly probeToken: string;
            readonly probeResultRowId: string;
            readonly projectRowId: string;
            readonly sourceRootRowId: string;
        },
    ): string {
        const payload = this.#requireOwned(reference.probeToken, "probe", ownerConnectionId, isProbeReviewRecord);
        const resultIndex = payload.rows.findIndex((row) => row.rowId === reference.probeResultRowId);
        if (resultIndex < 0) throw new HostReviewRecordUnavailableError("member");
        const rows = payload.rows[resultIndex] as ProbeResultRows;
        const result = payload.results[resultIndex] as ProbeResult;
        const projectIndex = rows.projectRowIds.indexOf(reference.projectRowId);
        const sourceIndex = rows.sourceRowIds.indexOf(reference.sourceRootRowId);
        if (projectIndex < 0 || sourceIndex < 0) throw new HostReviewRecordUnavailableError("member");
        const project = result.observation.observedProjects[projectIndex];
        const source = result.observation.sourceRoots[sourceIndex];
        if (project === undefined || source === undefined) throw new HostReviewRecordUnavailableError("member");
        const selectedWorkspaces = project.workspaces.filter((workspace) => workspace.sourceRootId === source.sourceRootId);
        if (selectedWorkspaces.length !== 1 || source.accessStatus !== "available") {
            throw new HostReviewRecordUnavailableError("member");
        }
        return source.path;
    }

    public resolveProbeSources(
        probeToken: string,
        resultRowId: string,
        sourceRowIds: readonly string[],
    ): { readonly result: ProbeResult; readonly sourceRootIds: string[] } {
        const payload = this.#require(probeToken, "probe", isProbeReviewRecord);
        const resultIndex = payload.rows.findIndex((row) => row.rowId === resultRowId);
        if (resultIndex < 0) throw new HostReviewRecordUnavailableError("member");
        const rows = payload.rows[resultIndex] as ProbeResultRows;
        const result = payload.results[resultIndex] as ProbeResult;
        const indexes = sourceRowIds.map((rowId) => rows.sourceRowIds.indexOf(rowId));
        if (indexes.some((index) => index < 0) || new Set(indexes).size !== indexes.length) {
            throw new HostReviewRecordUnavailableError("member");
        }
        return {
            result,
            sourceRootIds: indexes.map(
                (index) => (result.observation.sourceRoots[index] as { sourceRootId: string }).sourceRootId,
            ),
        };
    }

    public resolveProbeTarget(
        probeToken: string,
        resultRowId: string,
        targetRowId: string,
    ): {
        readonly result: ProbeResult;
        readonly currentProbeResults: ProbeResult[];
        readonly targetRootPath: string;
        readonly targetKind: ProbeResult["observation"]["targetCandidates"][number]["targetKind"];
    } {
        const payload = this.#require(probeToken, "probe", isProbeReviewRecord);
        const resultIndex = payload.rows.findIndex((row) => row.rowId === resultRowId);
        if (resultIndex < 0) throw new HostReviewRecordUnavailableError("member");
        const rows = payload.rows[resultIndex] as ProbeResultRows;
        const result = payload.results[resultIndex] as ProbeResult;
        const targetIndex = rows.targetRowIds.indexOf(targetRowId);
        if (targetIndex < 0) throw new HostReviewRecordUnavailableError("member");
        const target = result.observation.targetCandidates[targetIndex] as ProbeResult["observation"]["targetCandidates"][number];
        const currentProbeResults = this.#probeOperationSnapshots.resolve(probeToken, rows.rowId);
        if (currentProbeResults === undefined) throw new HostReviewRecordUnavailableError("record");
        return { result, currentProbeResults, targetRootPath: target.targetRootPath, targetKind: target.targetKind };
    }

    /** @internal Drop the immutable in-memory operation snapshot with its Host review authority. */
    public invalidateProbeOperationSnapshot(probeToken: string): void {
        this.#probeOperationSnapshots.invalidate(probeToken);
    }

    public recordRead(ownerConnectionId: string, probeToken: string, results: AdapterReadResult[]) {
        const payload: ReadReviewRecord = {
            recordKind: "read",
            probeToken,
            results,
            readFingerprints: results.map((result) => `${result.readAuthorityFingerprint}\0${result.readSnapshotFingerprint}`),
        };
        const reports = results.flatMap((result) =>
            result.sourceReports.flatMap((report) => {
                const sourceSelector = result.readTarget.sourceSelector;
                if (sourceSelector.selectorKind !== "probe_roots") {
                    throw new TypeError("Protocol read review cannot project a user-selected-root result");
                }
                const runtimeIds = sourceSelector.observation.observedAgentRuntimes
                    .filter((runtime) => runtime.sourceRootIds.includes(report.sourceRootId))
                    .map((runtime) => runtime.agentRuntimeId);
                if (runtimeIds.length === 0) throw new TypeError("Read report source has no owning agent runtime");
                const candidateCount = result.candidates.filter((candidate) =>
                    candidate.sourceRootIds.includes(report.sourceRootId),
                ).length;
                return runtimeIds.map((agentRuntimeId) => ({
                    adapterId: result.readTarget.adapterId,
                    agentRuntimeId,
                    sourceRootId: report.sourceRootId,
                    status: readStatus(report.status),
                    candidateCount,
                    diagnostics: report.diagnostics.map(projectDiagnostic),
                }));
            }),
        );
        const readToken = this.#store.put({
            kind: "read",
            ownerConnectionId,
            replacementKey: "read",
            parentTokens: [probeToken],
            payload,
        });
        return {
            readToken,
            reports,
            candidateCount: results.reduce((count, result) => count + result.candidates.length, 0),
        };
    }

    public resolveRead(readToken: string): AdapterReadResult[] {
        return this.#require(readToken, "read", isReadReviewRecord).results;
    }

    public recordPreview(ownerConnectionId: string, readToken: string, snapshot: ImportPreviewSnapshotV1) {
        const payload: ImportPreviewReviewRecord = {
            recordKind: "import_preview",
            readToken,
            snapshot,
            snapshotFingerprint: snapshot.snapshotFingerprint,
        };
        const candidates = projectImportPreviewCandidates(snapshot, MAXIMUM_SUMMARY_SELECTORS);
        const previewToken = this.#store.put({
            kind: "import_preview",
            ownerConnectionId,
            replacementKey: "import_preview",
            parentTokens: [readToken],
            payload,
        });
        return {
            previewToken,
            snapshotFingerprint: toProtocolSha256(snapshot.snapshotFingerprint),
            candidates,
        };
    }

    public resolvePreview(previewToken: string): ImportPreviewSnapshotV1 {
        return this.#require(previewToken, "import_preview", isImportPreviewReviewRecord).snapshot;
    }

    public previewDetail(previewToken: string, candidateId: string, logicalPath?: string) {
        const snapshot = this.resolvePreview(previewToken);
        const unavailable = new HostReviewRecordUnavailableError("member");
        const candidate = requireImportPreviewCandidate(snapshot, candidateId, unavailable);
        const file = requireImportPreviewCandidateFile(candidate, logicalPath, unavailable);
        const bytes = file.contentKind === "text" ? new TextEncoder().encode(file.text) : file.bytes;
        return {
            candidateId,
            logicalPath: file.logicalPath,
            mediaType: file.mediaType,
            contentKind: file.contentKind,
            ...(file.contentKind === "text" ? { text: boundedText(file.text) } : {}),
            byteLength: bytes.byteLength,
            contentHash: sha256(bytes),
        };
    }

    public resolveImportPreviewFileDirectory(
        ownerConnectionId: string,
        reference: { readonly previewToken: string; readonly candidateId: string; readonly logicalPath?: string },
    ): string {
        const payload = this.#requireOwned(
            reference.previewToken,
            "import_preview",
            ownerConnectionId,
            isImportPreviewReviewRecord,
        );
        const snapshot = payload.snapshot;
        if (snapshot.items.filter((item) => item.candidateId === reference.candidateId).length !== 1) {
            throw new HostReviewRecordUnavailableError("member");
        }
        const unavailable = new HostReviewRecordUnavailableError("member");
        const candidate = requireImportPreviewCandidate(snapshot, reference.candidateId, unavailable);
        const file = requireImportPreviewCandidateFile(candidate, reference.logicalPath, unavailable);
        return resolveImportPreviewFileDirectoryFromSnapshot(snapshot, candidate, file, unavailable);
    }

    public cancelPreview(previewToken: string): boolean {
        return this.#store.remove(previewToken, "cancelled");
    }

    public acceptPreview(previewToken: string): boolean {
        return this.#store.remove(previewToken, "accepted");
    }

    public recordRenderPreview(
        ownerConnectionId: string,
        deploymentId: string,
        selectionRequest: RenderSelectionRequest,
        preview: DeploymentRenderPreviewView,
        approvalResolutions: readonly HostOneTimeRenderApprovalResolution[] = [],
    ) {
        if (!isDeploymentRenderPreviewView(preview)) {
            throw new TypeError("render preview does not satisfy the strict public projection contract");
        }
        if (preview.deploymentId !== deploymentId || preview.renderInputFingerprint !== selectionRequest.renderInputFingerprint) {
            throw new TypeError("render preview does not belong to its exact Deployment selection");
        }
        if (!hostRenderApprovalResolutionsMatchSelection(selectionRequest, approvalResolutions)) {
            throw new TypeError("render preview approvals do not belong to its exact selection request");
        }
        const payload: RenderPreviewReviewRecord = {
            recordKind: "render_preview",
            deploymentId,
            selectionRequest: structuredClone(selectionRequest),
            preview: structuredClone(preview),
            previewFingerprint: preview.previewFingerprint,
            approvalResolutions: structuredClone(approvalResolutions),
        };
        const previewToken = this.#store.put({
            kind: "render_preview",
            ownerConnectionId,
            replacementKey: deploymentId,
            payload,
        });
        return projectDeploymentRenderPreview(previewToken, preview);
    }

    public resolveRenderPreview(previewToken: string): RenderPreviewReviewRecord {
        return this.#require(previewToken, "render_preview", isRenderPreviewReviewRecord);
    }

    public acceptRenderPreview(previewToken: string): boolean {
        return this.#store.remove(previewToken, "accepted");
    }

    public recordInspection(ownerConnectionId: string, deploymentId: string, result: RenderedTargetInspectionResult) {
        const memberIds = new Set<string>();
        const unsortedDetails: InspectionDetailMember[] = [
            ...result.files.map((file, index) => ({
                selector: this.#newMemberId(memberIds),
                detailKind: "file_attribution" as const,
                index,
                displayName: file.relativePath,
            })),
            ...result.changes.map((change, index) => ({
                selector: this.#newMemberId(memberIds),
                detailKind: "semantic_change" as const,
                index,
                displayName: inspectionChangeDisplayName(change, result.files),
            })),
        ];
        const details = unsortedDetails.sort((left, right) => {
            const leftConflict =
                left.detailKind === "file_attribution" &&
                (result.files[left.index] as RenderedFileAttributionResult).attributionState === "conflict";
            const rightConflict =
                right.detailKind === "file_attribution" &&
                (result.files[right.index] as RenderedFileAttributionResult).attributionState === "conflict";
            return Number(rightConflict) - Number(leftConflict);
        });
        const payload: RenderedInspectionReviewRecord = {
            recordKind: "rendered_inspection",
            deploymentId,
            result,
            inspectionResultFingerprint: result.inspectionResultFingerprint,
            details,
        };
        const inspectionToken = this.#store.put({
            kind: "rendered_inspection",
            ownerConnectionId,
            replacementKey: deploymentId,
            payload,
        });
        return {
            inspectionToken,
            deploymentId,
            inspectionResultFingerprint: toProtocolSha256(result.inspectionResultFingerprint),
            changeCount: result.changes.length,
            conflictCount: result.files.filter((file) => file.attributionState === "conflict").length,
            details: details.slice(0, MAXIMUM_SUMMARY_SELECTORS).map(({ selector, detailKind, displayName }) => ({
                selector,
                detailKind,
                displayName,
            })),
            detailsTruncated: details.length > MAXIMUM_SUMMARY_SELECTORS,
        };
    }

    public resolveInspection(
        inspectionToken: string,
        deploymentId: string,
        inspectionResultFingerprint: string,
    ): RenderedTargetInspectionResult {
        const payload = this.#require(inspectionToken, "rendered_inspection", isRenderedInspectionReviewRecord);
        if (
            payload.deploymentId !== deploymentId ||
            toProtocolSha256(payload.result.inspectionResultFingerprint) !== inspectionResultFingerprint
        ) {
            throw new HostReviewRecordUnavailableError("member");
        }
        return payload.result;
    }

    public acceptInspection(inspectionToken: string): boolean {
        return this.#store.remove(inspectionToken, "accepted");
    }

    public inspectionDetail(inspectionToken: string, selector: string) {
        const payload = this.#require(inspectionToken, "rendered_inspection", isRenderedInspectionReviewRecord);
        const member = payload.details.find((detail) => detail.selector === selector);
        if (member === undefined) throw new HostReviewRecordUnavailableError("member");
        if (member.detailKind === "semantic_change") {
            const change = payload.result.changes[member.index] as AttributedSemanticChange;
            const content = projectSemanticContent(change);
            return {
                inspectionToken,
                selector,
                detailKind: "semantic_change" as const,
                changeKind: change.changeKind,
                changeFingerprint: toProtocolSha256(change.changeFingerprint),
                ...(content === undefined ? {} : { content }),
            };
        }
        const file = payload.result.files[member.index] as RenderedFileAttributionResult;
        return {
            inspectionToken,
            selector,
            detailKind: "file_attribution" as const,
            relativePath: file.relativePath,
            attributionState: file.attributionState,
            ...(file.attributionState === "conflict" ? { reasonCode: file.reasonCode } : {}),
            diagnostics: file.diagnostics.map(projectDiagnostic),
        };
    }

    public recordStateBackup(ownerConnectionId: string, preparation: StateBackupPreparationV1): string {
        const payload: StateBackupReviewRecord = {
            recordKind: "state_backup",
            preparation,
            preparationFingerprint: preparation.preparationFingerprint,
        };
        return this.#store.put({
            kind: "state_backup",
            ownerConnectionId,
            replacementKey: "state_backup",
            payload,
        });
    }

    public resolveStateBackup(backupReviewToken: string): StateBackupPreparationV1 {
        return this.#require(backupReviewToken, "state_backup", isStateBackupReviewRecord).preparation;
    }

    public acceptStateBackup(backupReviewToken: string): boolean {
        return this.#store.remove(backupReviewToken, "accepted");
    }

    public recordStateRestore(ownerConnectionId: string, preparation: StateRestorePreparationV1): string {
        const payload: StateRestoreReviewRecord = {
            recordKind: "state_restore",
            preparation,
            preparationFingerprint: preparation.preparationFingerprint,
        };
        return this.#store.put({
            kind: "state_restore",
            ownerConnectionId,
            replacementKey: "state_restore",
            payload,
        });
    }

    public resolveStateRestore(restoreReviewToken: string): StateRestorePreparationV1 {
        return this.#require(restoreReviewToken, "state_restore", isStateRestoreReviewRecord).preparation;
    }

    public acceptStateRestore(restoreReviewToken: string): boolean {
        return this.#store.remove(restoreReviewToken, "accepted");
    }

    public recordSupportBundle(ownerConnectionId: string, prepared: PreparedSupportBundle): string {
        return this.#store.put({
            kind: "support_bundle",
            ownerConnectionId,
            replacementKey: "support_bundle",
            payload: prepared,
        });
    }

    public resolveSupportBundle(supportBundleReviewToken: string): PreparedSupportBundle {
        return this.#require(supportBundleReviewToken, "support_bundle", isPreparedSupportBundle);
    }

    public acceptSupportBundle(supportBundleReviewToken: string): boolean {
        return this.#store.remove(supportBundleReviewToken, "accepted");
    }

    public recordProjectLifecycle(ownerConnectionId: string, preparation: ProjectLifecyclePreparationV1): string {
        const payload: ProjectLifecycleReviewRecord = {
            recordKind: "project_lifecycle",
            preparation,
        };
        return this.#store.put({
            kind: "project_lifecycle",
            ownerConnectionId,
            replacementKey: `project_lifecycle:${preparation.projectId}`,
            payload,
        });
    }

    public resolveProjectLifecycle(projectLifecycleReviewToken: string): ProjectLifecyclePreparationV1 {
        return this.#require(projectLifecycleReviewToken, "project_lifecycle", isProjectLifecycleReviewRecord).preparation;
    }

    public acceptProjectLifecycle(projectLifecycleReviewToken: string): boolean {
        return this.#store.remove(projectLifecycleReviewToken, "accepted");
    }

    #require<T>(
        token: string,
        kind:
            | "probe"
            | "read"
            | "import_preview"
            | "render_preview"
            | "rendered_inspection"
            | "state_backup"
            | "state_restore"
            | "support_bundle"
            | "project_lifecycle",
        validate: (value: unknown) => value is T,
    ): T {
        const value = this.#store.get(token, kind, validate);
        if (value === null) throw new HostReviewRecordUnavailableError("record");
        return value;
    }

    #requireOwned<T>(
        token: string,
        kind: "probe" | "import_preview",
        ownerConnectionId: string,
        validate: (value: unknown) => value is T,
    ): T {
        const value = this.#store.getOwned(token, kind, ownerConnectionId, validate);
        if (value === null) throw new HostReviewRecordUnavailableError("record");
        return value;
    }

    #newMemberId(used: Set<string>): string {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const memberId = this.#createMemberId();
            if (memberId.length > 0 && memberId.trim() === memberId && !memberId.includes("\0") && !used.has(memberId)) {
                used.add(memberId);
                return memberId;
            }
        }
        throw new Error("Host could not allocate a unique review member id");
    }
}
