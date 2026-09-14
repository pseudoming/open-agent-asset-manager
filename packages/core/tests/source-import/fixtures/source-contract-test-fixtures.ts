/** Shared deterministic fixtures for the split source/import tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
    executeAdapterReadWithAuthority,
    type AdapterReadAuthorityContext,
} from "../../../src/source-import/source-contract-validator";
import { computeSourceCapabilityFingerprint } from "../../../src/adapters/adapter-contract-validator";
import type {
    AdapterId,
    AdapterProvider,
    AdapterProviderReadInput,
    AdapterProviderReadResult,
    AdapterReadResult,
    AdapterReadTarget,
    SourceRoot,
} from "../../../src/types";
import { makeContractProvider } from "../../adapters/fixtures/adapter-contract-fixtures";

export const ADAPTER = "READ_FAKE" as AdapterId;
export const RESERVATION = `sha256:${"9".repeat(64)}` as const;
export const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000001";
export let sandbox = "";
export let sourceFile = "";
export let transactionsRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-read-contract-"));
    sourceFile = path.join(sandbox, "GUIDANCE.md");
    transactionsRoot = path.join(sandbox, "transactions");
    fs.writeFileSync(sourceFile, "# Guidance\n", { mode: 0o644 });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

export function root(rootId = "root-1", filePath = sourceFile): SourceRoot {
    return {
        sourceRootId: rootId,
        rootRole: "source",
        sourceDomain: "agent_runtime_private",
        path: filePath,
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

export function provider(read?: (input: AdapterProviderReadInput) => Promise<AdapterProviderReadResult>): AdapterProvider {
    const candidate = makeContractProvider(ADAPTER);
    const guidance = candidate.assetSourceCapabilities.find((row) => row.assetKind === "Guidance");
    if (guidance === undefined) throw new Error("fixture missing Guidance row");
    Object.assign(guidance, {
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: "source",
        sourceDomain: "agent_runtime_private",
        sourcePathMechanism: "fixed_file",
        evidenceLevel: "agent_runtime_verified",
        readPolicy: "auto_read",
        diagnostics: [],
    });
    const fingerprint = computeSourceCapabilityFingerprint(candidate, guidance);
    if (fingerprint === null) throw new Error("fixture Guidance capability has no matching runtime owner");
    guidance.sourceCapabilityFingerprint = fingerprint;
    if (read !== undefined) candidate.read = read;
    return candidate;
}

export function target(selectedRoots = [root()]): AdapterReadTarget {
    const agentRuntimeId = `${ADAPTER}_CLI`;
    return {
        adapterId: ADAPTER,
        allowedKinds: ["Guidance"],
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
                        agentRuntimeId,
                        versionText: "test",
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: "/mock/bin",
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: selectedRoots.map((item) => item.sourceRootId),
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "available",
                        projectDiscoveryStatus: "not_found",
                        diagnostics: [],
                    },
                ],
                sourceRoots: selectedRoots,
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            sourceRootIds: selectedRoots.map((item) => item.sourceRootId),
        },
    };
}

export function authority(overrides: Partial<AdapterReadAuthorityContext> = {}): AdapterReadAuthorityContext {
    return {
        managedTargetGuards: [],
        reservationIdentityFingerprints: [RESERVATION],
        transactionsRoot,
        ...overrides,
    };
}

export function validRead(
    inspect?: (input: AdapterProviderReadInput) => void,
): (input: AdapterProviderReadInput) => Promise<AdapterProviderReadResult> {
    return async (input) => {
        inspect?.(input);
        const obligation = input.sourceReadObligations[0];
        if (obligation === undefined) throw new Error("missing obligation");
        const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
        if (resolved.state !== "succeeded") throw new Error("root did not resolve");
        const read = await input.readAccess.readFile(resolved.value.readEntryHandleId);
        if (read.state !== "succeeded") throw new Error("file did not read");
        const candidateId = "provider-candidate";
        return {
            candidates: [
                {
                    candidateId,
                    sourceRootIds: [obligation.sourceRootId],
                    scope: "global",
                    projectRootPath: "",
                    scopePath: "",
                    displayName: "Guidance",
                    displayDescription: "",
                    files: [
                        {
                            logicalPath: "GUIDANCE.md",
                            role: "entry",
                            contentKind: "text",
                            mediaType: "text/markdown",
                            text: Buffer.from(read.value.bytes).toString("utf-8"),
                            executable: false,
                        },
                    ],
                    nativeRepresentation: {
                        representationSource: "canonical_files",
                        dialectId: "mock-guidance-v1",
                    },
                    dialectRestorationTransition: { action: "inherit" },
                    status: "complete",
                    assetCandidateStatus: "importable",
                    promotionSafety: "default_promotable",
                    sourceFileOrigins: [
                        {
                            logicalPath: "GUIDANCE.md",
                            observedReadEntryIds: [read.value.entry.observedReadEntryId],
                        },
                    ],
                    sourceContainerEntryIds: [],
                    metadataSourceOrigins: [
                        {
                            metadataSubject: "display_name",
                            observedReadEntryId: read.value.entry.observedReadEntryId,
                        },
                    ],
                    sourceEvidence: [
                        {
                            evidenceOrigin: "observed_read",
                            observedReadEntryId: read.value.entry.observedReadEntryId,
                            kind: "document",
                            value: "GUIDANCE.md",
                            evidenceLevel: "agent_runtime_verified",
                        },
                    ],
                    diagnostics: [],
                    kind: "Guidance",
                    typeData: { schemaVersion: 1 },
                },
            ],
            sourceParseReports: [
                {
                    sourceRootId: obligation.sourceRootId,
                    sourceReadObligationIds: [obligation.sourceReadObligationId],
                    status: "parsed",
                    observedReadEntryIds: [read.value.entry.observedReadEntryId],
                    readEntryDispositions: [
                        {
                            readEntryDispositionId: "disposition-1",
                            sourceReadObligationId: obligation.sourceReadObligationId,
                            readEntryHandleId: resolved.value.readEntryHandleId,
                            disposition: "parsed",
                            readAccessOutcomeId: read.readAccessOutcomeId,
                            observedReadEntryIds: [read.value.entry.observedReadEntryId],
                            candidateIds: [candidateId],
                        },
                    ],
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        };
    };
}

export function validEmptyDirectoryRead(): (input: AdapterProviderReadInput) => Promise<AdapterProviderReadResult> {
    return async (input) => {
        const obligation = input.sourceReadObligations[0]!;
        const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
        if (resolved.state !== "succeeded") throw new Error("directory root did not resolve");
        const listed = await input.readAccess.listDirectory(resolved.value.readEntryHandleId);
        if (listed.state !== "succeeded") throw new Error("directory root did not list");
        return {
            candidates: [],
            sourceParseReports: [
                {
                    sourceRootId: obligation.sourceRootId,
                    sourceReadObligationIds: [obligation.sourceReadObligationId],
                    status: "empty",
                    observedReadEntryIds: [listed.value.directory.observedReadEntryId],
                    readEntryDispositions: [
                        {
                            readEntryDispositionId: "directory-disposition",
                            sourceReadObligationId: obligation.sourceReadObligationId,
                            readEntryHandleId: resolved.value.readEntryHandleId,
                            disposition: "traversed",
                            listDirectoryOutcomeId: listed.readAccessOutcomeId,
                            observedDirectoryEntryId: listed.value.directory.observedReadEntryId,
                            candidateIds: [],
                        },
                    ],
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        };
    };
}

export async function successfulRead(): Promise<AdapterReadResult> {
    const result = await executeAdapterReadWithAuthority(provider(validRead()), target(), authority());
    if (result.status !== "complete") throw new Error(`expected complete: ${JSON.stringify(result.diagnostics)}`);
    return result.value;
}

export async function successfulDirectoryRead(): Promise<AdapterReadResult> {
    const directory = path.join(sandbox, "snapshot-directory");
    fs.mkdirSync(directory);
    const selectedProvider = provider(validEmptyDirectoryRead());
    const guidance = selectedProvider.assetSourceCapabilities.find((row) => row.assetKind === "Guidance");
    if (guidance === undefined) throw new Error("fixture missing Guidance row");
    guidance.sourcePathMechanism = "directory_entry";
    const fingerprint = computeSourceCapabilityFingerprint(selectedProvider, guidance);
    if (fingerprint === null) throw new Error("fixture Guidance capability has no matching runtime owner");
    guidance.sourceCapabilityFingerprint = fingerprint;
    const result = await executeAdapterReadWithAuthority(selectedProvider, target([root("root-1", directory)]), authority());
    if (result.status !== "complete") throw new Error(`expected complete: ${JSON.stringify(result.diagnostics)}`);
    return result.value;
}
