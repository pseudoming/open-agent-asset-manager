import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desktopEnvironmentKey } from "../desktop-environment-key";
import {
    CLAUDE_RUNTIME_ID,
    CLAUDE_RUNTIME_VERSION,
    PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS,
    type ProjectGuidanceSemanticSelection,
    type ProjectGuidanceApplySubject,
    projectGuidanceApplyScript,
    projectGuidanceAuthorizeScript,
    projectGuidanceCreateReviewScript,
    projectGuidancePreviewScript,
    projectGuidanceRelationshipScript,
} from "./project-guidance-apply-ui-script";
import {
    captureProjectGuidanceVisualStage,
    type ProjectGuidanceVisualStageInput,
    type ProjectGuidanceVisualStageReceipt,
    ProjectGuidanceVisualTerminalError,
} from "./project-guidance-apply-visual-proof";

export {
    PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS,
    type ProjectGuidanceApplySubject,
    type ProjectGuidanceSemanticSelection,
    projectGuidanceApplyScript,
    projectGuidanceAuthorizeScript,
    projectGuidanceCreateReviewScript,
    projectGuidancePreviewScript,
    projectGuidanceRelationshipScript,
} from "./project-guidance-apply-ui-script";

import {
    diffPackagedAssetUsageAuthority,
    isPackagedAssetUsageObservabilitySnapshotComparable,
    type PackagedAssetUsageAuthoritySnapshot,
    waitForPackagedAssetUsageAuthorityQuiescence,
} from "./packaged-asset-usage-authority-proof";
import { exactRecord } from "./packaged-provider-project-sweep-ui-smoke";
import { PackagedProviderScreenshotProof } from "./packaged-provider-screenshot-proof";

const SCREENSHOTS = ["relationship", "authorization", "preview", "applied"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

interface ProjectGuidanceApplyWebContents {
    executeJavaScript(script: string): Promise<unknown>;
    capturePage(): Promise<{ toPNG(): Buffer }>;
}

interface TerminalReceipt {
    readonly status: "terminal";
    readonly stage: string;
    readonly code: string;
    readonly lastObservation: Readonly<Record<string, unknown>>;
}

class ProjectGuidanceApplyTerminalError extends Error {
    public readonly receipt: TerminalReceipt;

    public constructor(receipt: TerminalReceipt) {
        super(`packaged Project Guidance apply stopped at ${receipt.stage}: ${receipt.code}`);
        this.receipt = receipt;
    }
}

class ProjectGuidanceApplyScreenshotProof extends PackagedProviderScreenshotProof<(typeof SCREENSHOTS)[number], unknown> {
    public recordTerminal(value: unknown): void {
        this.writeBoundedEvidence("terminal-observation.json", value, 24_576);
    }

    public recordVisualStage(stage: (typeof SCREENSHOTS)[number], value: ProjectGuidanceVisualStageReceipt): void {
        this.writeBoundedEvidence(`visual-${stage}.json`, value, 8_192);
    }
}

function requireSubject(condition: boolean): asserts condition {
    if (!condition) throw new TypeError("invalid packaged Project Guidance apply subject");
}

export function readPackagedProjectAssetImportSubject(profileRootPath: string): ProjectGuidanceApplySubject {
    const filePath = path.join(profileRootPath, ".oaam-packaged-project-asset-import-subject.json");
    const stat = fs.lstatSync(filePath);
    requireSubject(!stat.isSymbolicLink() && stat.isFile() && stat.size >= 1 && stat.size <= 8_192);
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    requireSubject(
        exactRecord(value, [
            "assetId",
            "projectId",
            "rootPath",
            "schemaVersion",
            "sourceSha256",
            "terminalDeadlineAtMillisecondsSinceEpoch",
            "versionId",
        ]) &&
            value.schemaVersion === 3 &&
            typeof value.projectId === "string" &&
            UUID.test(value.projectId) &&
            typeof value.assetId === "string" &&
            UUID.test(value.assetId) &&
            typeof value.versionId === "string" &&
            UUID.test(value.versionId) &&
            typeof value.rootPath === "string" &&
            path.win32.normalize(value.rootPath) === value.rootPath &&
            typeof value.sourceSha256 === "string" &&
            SHA256.test(value.sourceSha256) &&
            typeof value.terminalDeadlineAtMillisecondsSinceEpoch === "number" &&
            Number.isSafeInteger(value.terminalDeadlineAtMillisecondsSinceEpoch) &&
            value.terminalDeadlineAtMillisecondsSinceEpoch > Date.now() - 120_000 &&
            value.terminalDeadlineAtMillisecondsSinceEpoch <= Date.now() + 120_000,
    );
    const distroName = /^\\\\wsl\.localhost\\([^\\]+)\\/iu.exec(value.rootPath)?.[1];
    requireSubject(distroName !== undefined);
    const environment = Object.freeze({ platform: "wsl" as const, platformInstanceId: distroName });
    const sourcePath = path.win32.join(value.rootPath, "AGENTS.md");
    const source = fs.lstatSync(sourcePath);
    requireSubject(
        !source.isSymbolicLink() &&
            source.isFile() &&
            source.size >= 1 &&
            source.size <= 1_048_576 &&
            crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex") === value.sourceSha256,
    );
    return Object.freeze({
        projectId: value.projectId,
        rootPath: value.rootPath,
        assetId: value.assetId,
        versionId: value.versionId,
        sourceSha256: value.sourceSha256,
        environment,
        environmentKey: desktopEnvironmentKey(environment),
        terminalDeadlineAtMillisecondsSinceEpoch: value.terminalDeadlineAtMillisecondsSinceEpoch,
    });
}

function isTerminalReceipt(value: unknown): value is TerminalReceipt {
    return (
        exactRecord(value, ["code", "lastObservation", "stage", "status"]) &&
        value.status === "terminal" &&
        typeof value.stage === "string" &&
        typeof value.code === "string" &&
        typeof value.lastObservation === "object" &&
        value.lastObservation !== null &&
        !Array.isArray(value.lastObservation)
    );
}

function requireSemanticSelections(value: unknown): readonly ProjectGuidanceSemanticSelection[] {
    if (!Array.isArray(value) || value.length !== PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS.length) {
        throw new TypeError("invalid complete Guidance semantic selection receipt");
    }
    const semanticRefs = new Set<string>();
    const optionFingerprints = new Set<string>();
    const result = value.map((entry, index) => {
        if (
            !exactRecord(entry, ["optionFingerprint", "semanticKind", "semanticRefFingerprint"]) ||
            entry.semanticKind !== PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS[index] ||
            typeof entry.semanticRefFingerprint !== "string" ||
            !SHA256.test(entry.semanticRefFingerprint) ||
            typeof entry.optionFingerprint !== "string" ||
            !SHA256.test(entry.optionFingerprint) ||
            semanticRefs.has(entry.semanticRefFingerprint) ||
            optionFingerprints.has(entry.optionFingerprint)
        ) {
            throw new TypeError("invalid complete Guidance semantic selection receipt");
        }
        semanticRefs.add(entry.semanticRefFingerprint);
        optionFingerprints.add(entry.optionFingerprint);
        return Object.freeze({
            semanticKind: entry.semanticKind,
            semanticRefFingerprint: entry.semanticRefFingerprint,
            optionFingerprint: entry.optionFingerprint,
        }) as ProjectGuidanceSemanticSelection;
    });
    return Object.freeze(result);
}

function sameSemanticSelections(
    left: readonly ProjectGuidanceSemanticSelection[],
    right: readonly ProjectGuidanceSemanticSelection[],
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function executeReceipt(
    webContents: ProjectGuidanceApplyWebContents,
    source: string,
    keys: readonly string[],
): Promise<Record<string, unknown>> {
    const value = await webContents.executeJavaScript(source);
    if (isTerminalReceipt(value)) throw new ProjectGuidanceApplyTerminalError(value);
    if (!exactRecord(value, keys) || value.status !== "complete") throw new TypeError("invalid Project Guidance apply receipt");
    return value;
}

function remaining(deadlineAt: number): number {
    return Math.max(1, Math.min(10_000, deadlineAt - Date.now() - 1_500));
}

async function settledAuthority(
    readAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot,
    subject: ProjectGuidanceApplySubject,
): Promise<PackagedAssetUsageAuthoritySnapshot> {
    return waitForPackagedAssetUsageAuthorityQuiescence(readAuthoritySnapshot, subject.projectId, {
        deadlineMilliseconds: remaining(subject.terminalDeadlineAtMillisecondsSinceEpoch),
    });
}

function assertStageBoundary(
    proof: ProjectGuidanceApplyScreenshotProof,
    before: PackagedAssetUsageAuthoritySnapshot,
    after: PackagedAssetUsageAuthoritySnapshot,
): ReturnType<typeof diffPackagedAssetUsageAuthority> {
    const delta = diffPackagedAssetUsageAuthority(before, after);
    if (
        delta.preferencesChanged ||
        !isPackagedAssetUsageObservabilitySnapshotComparable(after) ||
        (delta.observabilityChanged && !delta.observability.validDurableReplacementGrowth)
    ) {
        proof.recordAuthorityChange({ schemaVersion: 2, before, after, delta });
        throw new Error("packaged Project Guidance apply escaped its preference or observability boundary");
    }
    return delta;
}

async function stage<T>(proof: ProjectGuidanceApplyScreenshotProof, name: string, operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        proof.recordTerminal({
            stage: name,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof ProjectGuidanceApplyTerminalError || error instanceof ProjectGuidanceVisualTerminalError
                ? { receipt: error.receipt }
                : {}),
        });
        throw error;
    }
}

async function captureVisualStage(
    proof: ProjectGuidanceApplyScreenshotProof,
    webContents: ProjectGuidanceApplyWebContents,
    input: ProjectGuidanceVisualStageInput,
): Promise<ProjectGuidanceVisualStageReceipt> {
    return stage(proof, `visual-${input.stage}`, () =>
        captureProjectGuidanceVisualStage(webContents, input, async (receipt) => {
            proof.recordVisualStage(input.stage, receipt);
            await proof.capture(input.stage, webContents, 0);
        }),
    );
}

export async function proveWindowsPackagedProjectAssetImportSubject(
    webContents: ProjectGuidanceApplyWebContents,
    _resolveWslHomePath: unknown,
    temporaryRootPath: string,
    subject: ProjectGuidanceApplySubject,
    readAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot,
) {
    const proof = new ProjectGuidanceApplyScreenshotProof(
        path.join(temporaryRootPath, "oaam-phase59-project-guidance-apply"),
        SCREENSHOTS,
        "Project-Guidance-apply",
    );
    const before = await stage(proof, "authority-before", () => settledAuthority(readAuthoritySnapshot, subject));
    const relationship = await stage(proof, "relationship", () =>
        executeReceipt(webContents, projectGuidanceRelationshipScript(subject), [
            "agentRuntimeId",
            "assetId",
            "capability",
            "managedState",
            "projectId",
            "runtimeVersion",
            "status",
            "statusLabel",
            "targetKey",
            "targetState",
        ]),
    );
    const targetKey = relationship.targetKey;
    if (
        typeof targetKey !== "string" ||
        relationship.agentRuntimeId !== CLAUDE_RUNTIME_ID ||
        relationship.runtimeVersion !== CLAUDE_RUNTIME_VERSION ||
        relationship.capability !== "direct" ||
        relationship.targetState !== "absent" ||
        relationship.managedState !== "none"
    ) {
        throw new TypeError("invalid exact Claude relationship receipt");
    }
    const relationshipVisual = await captureVisualStage(proof, webContents, {
        stage: "relationship",
        subject,
        targetKey,
        deploymentId: "",
        semanticSelections: [],
        desiredSha256: "",
    });
    const createReview = await stage(proof, "create-review", () =>
        executeReceipt(webContents, projectGuidanceCreateReviewScript(subject, targetKey), [
            "agentRuntimeId",
            "authorization",
            "compatibility",
            "deploymentId",
            "runtimeVersion",
            "status",
            "targetKey",
        ]),
    );
    const deploymentId = createReview.deploymentId;
    if (typeof deploymentId !== "string" || !UUID.test(deploymentId)) throw new TypeError("invalid created Deployment identity");
    const afterCreate = await stage(proof, "authority-after-create", () => settledAuthority(readAuthoritySnapshot, subject));
    const createDelta = assertStageBoundary(proof, before, afterCreate);
    const authorizationVisual = await captureVisualStage(proof, webContents, {
        stage: "authorization",
        subject,
        targetKey,
        deploymentId,
        semanticSelections: [],
        desiredSha256: "",
    });
    const authorization = await stage(proof, "authorize", () =>
        executeReceipt(webContents, projectGuidanceAuthorizeScript(subject, targetKey, deploymentId), [
            "authorization",
            "deploymentId",
            "semanticSelections",
            "status",
            "targetKey",
        ]),
    );
    const semanticSelections = requireSemanticSelections(authorization.semanticSelections);
    if (authorization.authorization !== "allowed") {
        throw new TypeError("invalid current-Project permission receipt");
    }
    const afterGrant = await stage(proof, "authority-after-grant", () => settledAuthority(readAuthoritySnapshot, subject));
    const grantDelta = assertStageBoundary(proof, afterCreate, afterGrant);
    const preview = await stage(proof, "preview", () =>
        executeReceipt(webContents, projectGuidancePreviewScript(subject, targetKey, deploymentId, semanticSelections), [
            "applyLabel",
            "changeKind",
            "currentState",
            "deploymentId",
            "desiredByteSize",
            "desiredSha256",
            "desiredState",
            "relativePath",
            "reversePolicy",
            "semanticSelections",
            "status",
            "targetKey",
        ]),
    );
    const previewSemanticSelections = requireSemanticSelections(preview.semanticSelections);
    if (
        !sameSemanticSelections(previewSemanticSelections, semanticSelections) ||
        preview.relativePath !== "CLAUDE.md" ||
        preview.changeKind !== "create" ||
        preview.currentState !== "missing" ||
        preview.desiredState !== "present" ||
        typeof preview.desiredSha256 !== "string" ||
        !SHA256.test(preview.desiredSha256) ||
        !Number.isSafeInteger(preview.desiredByteSize) ||
        Number(preview.desiredByteSize) < 1 ||
        preview.reversePolicy !== "can_reconcile"
    ) {
        throw new TypeError("invalid exact CLAUDE.md preview receipt");
    }
    const previewVisual = await captureVisualStage(proof, webContents, {
        stage: "preview",
        subject,
        targetKey,
        deploymentId,
        semanticSelections: previewSemanticSelections,
        desiredSha256: preview.desiredSha256 as string,
    });
    const applied = await stage(proof, "apply", () =>
        executeReceipt(
            webContents,
            projectGuidanceApplyScript(
                subject,
                targetKey,
                deploymentId,
                preview.desiredSha256 as string,
                previewSemanticSelections,
            ),
            [
                "applicationState",
                "deploymentId",
                "detail",
                "semanticSelections",
                "status",
                "statusLabel",
                "targetKey",
                "versionState",
            ],
        ),
    );
    const appliedSemanticSelections = requireSemanticSelections(applied.semanticSelections);
    if (
        !sameSemanticSelections(appliedSemanticSelections, previewSemanticSelections) ||
        applied.applicationState !== "applied" ||
        applied.versionState !== "current" ||
        String(applied.statusLabel).trim() === "" ||
        String(applied.detail).trim() === ""
    ) {
        throw new TypeError("invalid applied Claude Code state receipt");
    }
    const appliedVisual = await captureVisualStage(proof, webContents, {
        stage: "applied",
        subject,
        targetKey,
        deploymentId,
        semanticSelections: appliedSemanticSelections,
        desiredSha256: preview.desiredSha256 as string,
    });
    const afterDeploy = await stage(proof, "authority-after-apply", () => settledAuthority(readAuthoritySnapshot, subject));
    const deployDelta = assertStageBoundary(proof, afterGrant, afterDeploy);
    const result = Object.freeze({
        status: "complete",
        subject,
        relationship,
        createReview,
        authorization,
        preview,
        applied,
        visual: {
            relationship: relationshipVisual,
            authorization: authorizationVisual,
            preview: previewVisual,
            applied: appliedVisual,
        },
        authority: { before, afterCreate, afterGrant, afterDeploy, createDelta, grantDelta, deployDelta },
    });
    proof.finalize(result);
    return result;
}

export interface ProjectGuidanceApplyInstalledReceipt {
    readonly schemaVersion: 1;
    readonly subject: {
        readonly projectId: string;
        readonly assetId: string;
        readonly versionId: string;
        readonly targetKey: string;
        readonly sourceSha256: string;
    };
    readonly ui: {
        readonly runtimeId: string;
        readonly runtimeVersion: string;
        readonly capability: string;
        readonly targetState: string;
        readonly managedStateBefore: string;
        readonly authorizationRequired: boolean;
        readonly authorizationAllowed: boolean;
        readonly compatibility: string;
        readonly semanticSelections: readonly ProjectGuidanceSemanticSelection[];
        readonly previewPath: string;
        readonly previewCurrentState: string;
        readonly previewDesiredState: string;
        readonly previewDesiredSha256: string;
        readonly reversePolicy: string;
        readonly applicationState: string;
        readonly versionState: string;
    };
    readonly operations: Readonly<Record<string, { readonly accepted: number; readonly terminalComplete: number }>>;
    readonly authority: {
        readonly projectUnchanged: boolean;
        readonly assetUnchanged: boolean;
        readonly versionUnchanged: boolean;
        readonly preferencesUnchanged: boolean;
        readonly settingsUnchanged: boolean;
        readonly localSourcesUnchanged: boolean;
        readonly oneActiveGrant: boolean;
        readonly oneAppliedDeployment: boolean;
        readonly appliedSemanticSelections: readonly ProjectGuidanceSemanticSelection[];
        readonly noResidualTransaction: boolean;
    };
    readonly runtime: {
        readonly beforePaths: readonly string[];
        readonly afterPaths: readonly string[];
        readonly sourceSha256: string;
        readonly claudeSha256: string;
        readonly siblingsUnchanged: boolean;
    };
    readonly consumer: {
        readonly agentRuntimeId: string;
        readonly runtimeVersion: string;
        readonly targetKey: string;
        readonly loopbackOnly: boolean;
        readonly markerMatchCount: number;
        readonly cloudInvocationCount: number;
        readonly modelExecutionCount: number;
        readonly loginCount: number;
        readonly sessionPersistenceCount: number;
    };
    readonly cleanup: { readonly processResidueCount: number; readonly fixtureResidueCount: number };
}

export function validatePackagedProjectGuidanceApplyInstalledReceipt(
    value: ProjectGuidanceApplyInstalledReceipt,
): readonly string[] {
    const errors: string[] = [];
    if (value.schemaVersion !== 1) errors.push("installed receipt schema is not 1");
    if (!UUID.test(value.subject.projectId) || !UUID.test(value.subject.assetId) || !UUID.test(value.subject.versionId))
        errors.push("installed receipt subject identity is invalid");
    if (!SHA256.test(value.subject.sourceSha256) || value.subject.targetKey.trim() === "")
        errors.push("installed receipt source or target identity is invalid");
    const ui = value.ui;
    let semanticSelectionsValid = true;
    try {
        requireSemanticSelections(ui.semanticSelections);
    } catch {
        semanticSelectionsValid = false;
    }
    if (
        ui.runtimeId !== CLAUDE_RUNTIME_ID ||
        ui.runtimeVersion !== CLAUDE_RUNTIME_VERSION ||
        ui.capability !== "direct" ||
        ui.targetState !== "absent" ||
        ui.managedStateBefore !== "none" ||
        !ui.authorizationRequired ||
        !ui.authorizationAllowed ||
        ui.compatibility !== "newer-compatible" ||
        !semanticSelectionsValid ||
        ui.previewPath !== "CLAUDE.md" ||
        ui.previewCurrentState !== "missing" ||
        ui.previewDesiredState !== "present" ||
        !SHA256.test(ui.previewDesiredSha256) ||
        ui.reversePolicy !== "can_reconcile" ||
        ui.applicationState !== "applied" ||
        ui.versionState !== "current"
    )
        errors.push("installed UI result is not the exact Claude Guidance apply result");
    const expectedMutations = new Set(["deployment.create", "promotion_grant.create", "deployment.deploy"]);
    for (const [operation, counts] of Object.entries(value.operations)) {
        const expected = expectedMutations.has(operation) ? 1 : 0;
        if (counts.accepted !== expected || counts.terminalComplete !== expected)
            errors.push(`installed operation count escaped the target stage: ${operation}`);
        expectedMutations.delete(operation);
    }
    if (expectedMutations.size > 0) errors.push("installed target-stage mutation operation is missing");
    let appliedSemanticSelectionsValid = true;
    try {
        const appliedSelections = requireSemanticSelections(value.authority.appliedSemanticSelections);
        appliedSemanticSelectionsValid = sameSemanticSelections(appliedSelections, ui.semanticSelections);
    } catch {
        appliedSemanticSelectionsValid = false;
    }
    const { appliedSemanticSelections: _appliedSemanticSelections, ...authorityStates } = value.authority;
    if (Object.values(authorityStates).some((state) => state !== true) || !appliedSemanticSelectionsValid)
        errors.push("installed OAAM authority result escaped the exact grant and applied Deployment boundary");
    if (
        JSON.stringify(value.runtime.beforePaths) !== JSON.stringify(["AGENTS.md"]) ||
        JSON.stringify(value.runtime.afterPaths) !== JSON.stringify(["AGENTS.md", "CLAUDE.md"]) ||
        value.runtime.sourceSha256 !== value.subject.sourceSha256 ||
        value.runtime.claudeSha256 !== ui.previewDesiredSha256 ||
        !value.runtime.siblingsUnchanged
    )
        errors.push("installed runtime tree is not the exact CLAUDE.md-only change");
    const consumer = value.consumer;
    if (
        consumer.agentRuntimeId !== ui.runtimeId ||
        consumer.runtimeVersion !== ui.runtimeVersion ||
        consumer.targetKey !== value.subject.targetKey ||
        !consumer.loopbackOnly ||
        consumer.markerMatchCount !== 1 ||
        consumer.cloudInvocationCount !== 0 ||
        consumer.modelExecutionCount !== 0 ||
        consumer.loginCount !== 0 ||
        consumer.sessionPersistenceCount !== 0
    )
        errors.push("installed Claude CLI consumer did not load the exact local CLAUDE.md marker");
    if (value.cleanup.processResidueCount !== 0 || value.cleanup.fixtureResidueCount !== 0)
        errors.push("installed target stage left owned residue");
    return Object.freeze(errors);
}

export function proveWindowsPackagedProjectAssetImport(
    webContents: ProjectGuidanceApplyWebContents,
    resolveWslHomePath: unknown,
    temporaryRootPath: string,
    profileRootPath: string,
    readAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot,
) {
    return proveWindowsPackagedProjectAssetImportSubject(
        webContents,
        resolveWslHomePath,
        temporaryRootPath,
        readPackagedProjectAssetImportSubject(profileRootPath),
        readAuthoritySnapshot,
    );
}
