/** Shared deterministic fixtures for the split source/import tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { computeSourceCapabilityFingerprint } from "../../../src/adapters/adapter-contract-validator";
import { createVersionDialectRegistry } from "../../../src/catalog/version-authority";
import { inferCanonicalMediaType } from "../../../src/foundation/media-type";
import { compareCodeUnitText } from "../../../src/foundation/text-order";
import { createImportService, type ImportServiceConfiguration } from "../../../src/orchestration/import-service";
import {
    computeReadSnapshotFingerprint,
    executeAdapterReadWithAuthority,
} from "../../../src/source-import/source-contract-validator";
import type {
    AdapterExtractedAssetCandidate,
    AdapterId,
    AdapterProvider,
    AdapterProviderReadInput,
    AdapterReadResult,
    AdapterReadTarget,
    AssetKind,
    ExtractedAssetCandidateBase,
    FileReferenceV2,
    ImportAcceptRequest,
    ImportPreviewSnapshotV1,
    SourceRoot,
    UuidV4,
} from "../../../src/types";
import { makeContractProvider } from "../../adapters/fixtures/adapter-contract-fixtures";
import { makeNativeDialectContract, makePortableEntryDialectContract } from "./dialect-contracts";

export const ADAPTER = "IMPORT_FAKE" as AdapterId;
export const SOURCE_CAPABILITY = `sha256:${"1".repeat(64)}` as const;
export const PROJECT_ID = "00000000-0000-4000-8000-000000000900" as UuidV4;
export const TARGET_PROJECT_ID = "00000000-0000-4000-8000-000000000901" as UuidV4;

export let sandbox = "";
export let assetsRoot = "";
export let oaamRoot = "";
export let locksRoot = "";
export let sourceFile = "";
export let transactionsRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-import-service-"));
    assetsRoot = path.join(sandbox, "assets");
    oaamRoot = path.join(sandbox, "oaam");
    locksRoot = path.join(sandbox, "authority-locks");
    transactionsRoot = path.join(sandbox, "transactions");
    sourceFile = path.join(sandbox, "GUIDANCE.md");
    fs.writeFileSync(sourceFile, "# Guidance\n");
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

export function sourceRoot(): SourceRoot {
    return {
        sourceRootId: "root-1",
        rootRole: "source",
        sourceDomain: "agent_runtime_private",
        path: sourceFile,
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "guidance",
                evidenceLevel: "agent_runtime_verified",
            },
        ],
        diagnostics: [],
    };
}

export function readTarget(allowedKind: AssetKind = "Guidance"): AdapterReadTarget {
    const root = sourceRoot();
    return {
        adapterId: ADAPTER,
        allowedKinds: [allowedKind],
        sourceSelector: {
            selectorKind: "probe_roots",
            observation: {
                adapterId: ADAPTER,
                platformContext: {
                    platform: "linux",
                    platformInstanceId: "local",
                    accessRootPath: "/",
                },
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: `${ADAPTER}_CLI`,
                        versionText: "fixture",
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: "/fixture/bin",
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [root.sourceRootId],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "available",
                        projectDiscoveryStatus: "not_found",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [root],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            sourceRootIds: [root.sourceRootId],
        },
    };
}

export function provider(references: FileReferenceV2[] = []): AdapterProvider {
    return providerForCandidate("Guidance", (observedReadEntryId, text) =>
        guidanceCandidate(observedReadEntryId, text, {
            files: [
                {
                    logicalPath: "GUIDANCE.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    text,
                    executable: false,
                    references,
                },
            ],
        }),
    );
}

export function guidanceCandidate(
    observedReadEntryId: string,
    text: string,
    overrides: Partial<Extract<AdapterExtractedAssetCandidate, { kind: "Guidance" }>> = {},
): Extract<AdapterExtractedAssetCandidate, { kind: "Guidance" }> {
    return {
        candidateId: "provider-guidance",
        sourceRootIds: ["root-1"],
        scope: "global",
        projectRootPath: "",
        scopePath: "",
        displayName: "Imported Guidance",
        displayDescription: "",
        files: [
            {
                logicalPath: "GUIDANCE.md",
                role: "entry",
                contentKind: "text",
                mediaType: "text/markdown",
                text,
                executable: false,
                references: [],
            },
        ],
        nativeRepresentation: {
            representationSource: "canonical_files",
            dialectId: "fixture-guidance-v1",
        },
        dialectRestorationTransition: { action: "inherit" },
        status: "complete",
        assetCandidateStatus: "importable",
        promotionSafety: "requires_user_confirmation",
        sourceFileOrigins: [
            {
                logicalPath: "GUIDANCE.md",
                observedReadEntryIds: [observedReadEntryId],
            },
        ],
        sourceContainerEntryIds: [],
        metadataSourceOrigins: [
            {
                metadataSubject: "display_name",
                observedReadEntryId,
            },
        ],
        sourceEvidence: [
            {
                evidenceOrigin: "observed_read",
                observedReadEntryId,
                kind: "document",
                value: "GUIDANCE.md",
                evidenceLevel: "agent_runtime_verified",
            },
        ],
        diagnostics: [],
        kind: "Guidance",
        typeData: { schemaVersion: 1 },
        ...overrides,
    };
}

export function providerForCandidate(
    kind: AssetKind,
    makeCandidate: (observedReadEntryId: string, text: string) => AdapterExtractedAssetCandidate,
): AdapterProvider {
    const selected = makeContractProvider(ADAPTER);
    const capability = selected.assetSourceCapabilities.find((row) => row.assetKind === kind);
    if (capability === undefined) throw new Error(`missing ${kind} capability`);
    Object.assign(capability, {
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: "source",
        sourceDomain: "agent_runtime_private",
        sourcePathMechanism: "fixed_file",
        evidenceLevel: "agent_runtime_verified",
        readPolicy: "auto_read",
        diagnostics: [],
    });
    capability.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(selected, capability) as string;
    selected.read = async (input: AdapterProviderReadInput) => {
        const obligation = input.sourceReadObligations[0];
        if (obligation === undefined) throw new Error("missing read obligation");
        const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
        if (resolved.state !== "succeeded") throw new Error("source root did not resolve");
        const read = await input.readAccess.readFile(resolved.value.readEntryHandleId);
        if (read.state !== "succeeded") throw new Error("source file did not read");
        const observedReadEntryId = read.value.entry.observedReadEntryId;
        const candidate = makeCandidate(observedReadEntryId, Buffer.from(read.value.bytes).toString("utf-8"));
        return {
            candidates: [candidate],
            sourceParseReports: [
                {
                    sourceRootId: obligation.sourceRootId,
                    sourceReadObligationIds: [obligation.sourceReadObligationId],
                    status: "parsed",
                    observedReadEntryIds: [observedReadEntryId],
                    readEntryDispositions: [
                        {
                            readEntryDispositionId: "disposition-1",
                            sourceReadObligationId: obligation.sourceReadObligationId,
                            readEntryHandleId: resolved.value.readEntryHandleId,
                            disposition: "parsed",
                            readAccessOutcomeId: read.readAccessOutcomeId,
                            observedReadEntryIds: [observedReadEntryId],
                            candidateIds: [candidate.candidateId],
                        },
                    ],
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        };
    };
    return selected;
}

export function candidateBase(
    observedReadEntryId: string,
    logicalPath: string,
    text: string,
    dialectId: string,
): ExtractedAssetCandidateBase {
    return {
        candidateId: `candidate-${logicalPath}`,
        sourceRootIds: ["root-1"],
        scope: "global",
        projectRootPath: "",
        scopePath: "",
        displayName: logicalPath,
        displayDescription: "fixture",
        files: [
            {
                logicalPath,
                role: "entry",
                contentKind: "text",
                mediaType: inferCanonicalMediaType(logicalPath, "text"),
                text,
                executable: false,
                references: [],
            },
        ],
        nativeRepresentation: { representationSource: "canonical_files", dialectId },
        dialectRestorationTransition: { action: "inherit" },
        status: "complete",
        assetCandidateStatus: "importable",
        promotionSafety: "default_promotable",
        sourceFileOrigins: [{ logicalPath, observedReadEntryIds: [observedReadEntryId] }],
        sourceContainerEntryIds: [],
        metadataSourceOrigins: [
            {
                metadataSubject: "display_name",
                observedReadEntryId,
            },
        ],
        sourceEvidence: [
            {
                evidenceOrigin: "observed_read",
                observedReadEntryId,
                kind: "document",
                value: logicalPath,
                evidenceLevel: "agent_runtime_verified",
            },
        ],
        diagnostics: [],
    };
}

export function subagentTypeData() {
    return {
        schemaVersion: 2 as const,
        name: "reviewer",
        description: "Review changes",
        promptContextPolicy: { mode: "agent_runtime_default" as const },
        tools: {
            availability: { base: { mode: "inherit_available" as const }, unavailable: [] },
            permission: { rules: [], otherwise: "inherit_agent_runtime_policy" as const },
        },
        dependencies: { preloadedSkillVersionIds: [] },
        memory: { mode: "disabled" as const },
        execution: {
            permission: { mode: "inherit" as const },
            workspaceIsolation: { mode: "agent_runtime_default" as const },
            scheduling: { mode: "agent_runtime_default" as const },
            turnLimit: { mode: "agent_runtime_default" as const },
            model: { mode: "inherit" as const },
            effort: { mode: "inherit" as const },
            sampling: {
                temperature: { mode: "agent_runtime_default" as const },
                topP: { mode: "agent_runtime_default" as const },
            },
        },
        directInvocation: { mode: "delegated_only" as const },
        presentation: {
            listing: "agent_runtime_default" as const,
            color: { mode: "agent_runtime_default" as const },
        },
    };
}

export function workflowTypeData(selector: string | null) {
    return {
        schemaVersion: 2 as const,
        name: "review",
        description: "Review a change",
        implementation: {
            kind: "instructions" as const,
            instructionDialectId: "claudecode-command-markdown-v1",
            execution: {
                mode: "isolated" as const,
                agent:
                    selector === null
                        ? ({ mode: "agent_runtime_default" } as const)
                        : ({ mode: "agent_runtime_named", selector } as const),
                model: { mode: "inherit" as const },
                effort: { mode: "inherit" as const },
                shell: { mode: "none" as const },
            },
            toolPolicy: {
                preapproved: [],
                denied: [],
                otherwise: "inherit_agent_runtime_policy" as const,
            },
        },
        invocation: {
            commandNames: ["review"],
            userInvocable: true,
            agentInvocable: false,
            argumentHint: "",
            argumentNames: [],
        },
    };
}

export async function makeReadResult(references: FileReferenceV2[] = []): Promise<AdapterReadResult> {
    return makeReadResultFromProvider(provider(references), "Guidance");
}

export async function makeGuidanceReadResult(
    overrides: Partial<Extract<AdapterExtractedAssetCandidate, { kind: "Guidance" }>>,
): Promise<AdapterReadResult> {
    return makeReadResultFromProvider(
        providerForCandidate("Guidance", (observedReadEntryId, text) => guidanceCandidate(observedReadEntryId, text, overrides)),
        "Guidance",
    );
}

export async function makeReadResultFromProvider(
    selectedProvider: AdapterProvider,
    allowedKind: AssetKind,
): Promise<AdapterReadResult> {
    const result = await executeAdapterReadWithAuthority(selectedProvider, readTarget(allowedKind), {
        managedTargetGuards: [],
        reservationIdentityFingerprints: [SOURCE_CAPABILITY],
        transactionsRoot,
    });
    if (result.status !== "complete") {
        throw new Error(`read fixture failed: ${JSON.stringify(result.diagnostics)}`);
    }
    return result.value;
}

export function cloneAsSecondPhysicalObservation(read: AdapterReadResult): AdapterReadResult {
    const cloned = structuredClone(read);
    const oldCandidateId = cloned.candidates[0]!.candidateId;
    const newCandidateId = `${oldCandidateId}-second-observer`;
    cloned.readAuthorityFingerprint = `sha256:${"9".repeat(64)}`;
    cloned.readTarget.adapterId = "IMPORT_SECOND_FAKE" as AdapterId;
    if (cloned.readTarget.sourceSelector.selectorKind === "probe_roots") {
        cloned.readTarget.sourceSelector.observation.adapterId = "IMPORT_SECOND_FAKE";
    }
    cloned.candidates[0]!.candidateId = newCandidateId;
    cloned.candidates[0]!.adapterId = "IMPORT_SECOND_FAKE" as AdapterId;
    for (const report of cloned.sourceParseReports) {
        for (const disposition of report.readEntryDispositions) {
            if (disposition.disposition !== "ignored") {
                disposition.candidateIds = disposition.candidateIds.map((candidateId) =>
                    candidateId === oldCandidateId ? newCandidateId : candidateId,
                );
            }
        }
    }
    cloned.readSnapshotFingerprint = computeReadSnapshotFingerprint(
        cloned.readTarget,
        cloned.readAuthorityFingerprint,
        cloned.sourceReadObligations,
        cloned.observedReadEntries,
        cloned.externalAttestationReceipts.map((receipt) => receipt.attestationReceiptFingerprint),
        cloned.sourceParseReports,
    );
    return cloned;
}

export function cloneWithSiblingCandidateObservation(read: AdapterReadResult): AdapterReadResult {
    const cloned = structuredClone(read);
    const first = cloned.candidates[0];
    if (first === undefined) throw new Error("sibling-observation fixture requires one candidate");
    const sibling = structuredClone(first);
    sibling.candidateId = `${first.candidateId}-sibling-runtime`;
    cloned.candidates.push(sibling);
    cloned.candidates.sort((left, right) => compareCodeUnitText(left.candidateId, right.candidateId));
    for (const report of cloned.sourceParseReports) {
        for (const disposition of report.readEntryDispositions) {
            if (disposition.disposition !== "ignored" && disposition.candidateIds.includes(first.candidateId)) {
                disposition.candidateIds = [...disposition.candidateIds, sibling.candidateId].sort(compareCodeUnitText);
            }
        }
    }
    cloned.readSnapshotFingerprint = computeReadSnapshotFingerprint(
        cloned.readTarget,
        cloned.readAuthorityFingerprint,
        cloned.sourceReadObligations,
        cloned.observedReadEntries,
        cloned.externalAttestationReceipts.map((receipt) => receipt.attestationReceiptFingerprint),
        cloned.sourceParseReports,
    );
    return cloned;
}

export function identityFactory(): () => UuidV4 {
    let next = 1;
    return () => {
        const suffix = String(next).padStart(12, "0");
        next += 1;
        return `00000000-0000-4000-8000-${suffix}`;
    };
}

export function makeServiceConfiguration(
    refresh: (previous: AdapterReadResult) => Promise<AdapterReadResult>,
    overrides: Partial<ImportServiceConfiguration> = {},
): ImportServiceConfiguration {
    return {
        assetsRoot,
        oaamRoot,
        authorityLocksRoot: locksRoot,
        dialectRegistry: createVersionDialectRegistry(
            [
                makeNativeDialectContract("Guidance", "fixture-guidance-v1"),
                makeNativeDialectContract("Workflow", "fixture-workflow-v1"),
                makeNativeDialectContract("Subagent", "fixture-subagent-v1"),
            ],
            [],
            [
                makePortableEntryDialectContract(
                    "Workflow",
                    "workflow_instruction",
                    "claudecode-command-markdown-v1",
                    () => true,
                    [`${ADAPTER}_CLI`],
                ),
            ],
            [],
        ),
        resolveSourceCapabilityAgentRuntimeId: () => `${ADAPTER}_CLI`,
        resolveProjectId: (projectRootPath) => (projectRootPath === "/project" ? PROJECT_ID : null),
        acquireProjectAuthority: () => () => undefined,
        validateReadAuthority: () => true,
        refreshReadResult: async (previous) => ({
            status: "complete",
            value: await refresh(previous),
            diagnostics: [],
        }),
        reindexImportedAsset: () => ({
            status: "complete",
            value: {
                scannedAssets: 1,
                indexedAssets: 1,
                skippedAssets: 0,
                diagnostics: [],
            },
            diagnostics: [],
        }),
        assertMutationScope: () => undefined,
        now: () => 1_000,
        newUuid: identityFactory(),
        ...overrides,
    };
}

export function makeService(
    refresh: (previous: AdapterReadResult) => Promise<AdapterReadResult>,
    overrides: Partial<ImportServiceConfiguration> = {},
) {
    return createImportService(makeServiceConfiguration(refresh, overrides));
}

export function acceptRequest(
    previewSnapshot: ImportPreviewSnapshotV1,
    overrides: Partial<ImportAcceptRequest["decision"]> = {},
): ImportAcceptRequest {
    const candidateId = previewSnapshot.items[0]?.candidateId;
    if (candidateId === undefined) throw new Error("preview has no candidate");
    return {
        previewSnapshot,
        decision: {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: { promotionAction: "import_only", userActionId: "accept-import" },
            callableBindings: [],
            ...overrides,
        } as ImportAcceptRequest["decision"],
    };
}
