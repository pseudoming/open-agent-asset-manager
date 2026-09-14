/** Non-vacuous fourth-family proof through Core and adapter-framework authorities. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildSeparateNativeRepresentation,
    defineAdapterProvider,
    defineAssetReaderRegistry,
    isAdapterFrameworkProvider,
    isAdapterFrameworkReadHandler,
    isAdapterFrameworkTargetHandler,
    sha256SourceBytes,
    sourceReader,
    sourceUnavailable,
    traverseSourceRead,
    type SourceContextBase,
    type SourceScanResultBase,
} from "@oaam/adapter-framework";
import { createAdapterAssetSourceCapability } from "../../packages/core/src/adapters/adapter-source-capability";
import {
    bootstrapAdapterRegistry,
    clearRegistry,
    getRegisteredVersionDialectRegistry,
    probeAdapters,
    readAssetsFromAdapterForTest,
    registerAdapterProvider,
    replaceEnabledAdapters,
} from "../../packages/core/src/orchestration/adapter-registry";
import { BUILTIN_ASSET_KINDS } from "../../packages/core/src/specs/registry";
import type {
    AdapterExtractedAssetCandidate,
    AdapterProvider,
    AdapterReadTarget,
    ExtractedAssetCandidate,
    NativeDialectValidationInputV1,
    OperationDiagnostic,
    Sha256Digest,
    SourceRoot,
    VersionedContractComponentRef,
} from "../../packages/core/src/types";
import { inspectAdapterExtensionContract } from "./adapter-extension-contract";

const ADAPTER_ID = "SYNTHETIC_FOURTH";
const AGENT_RUNTIME_ID = "SYNTHETIC_FOURTH_CLI";
const SOURCE_ROOT_ID = "synthetic-fourth:shared";
const NATIVE_DIALECT_ID = "synthetic-fourth-guidance-v1";
const GUIDANCE_PATH = "GUIDANCE.md";
const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as Sha256Digest;
const LINUX_CONTEXT = {
    platform: "linux" as const,
    platformInstanceId: "synthetic-local",
    accessRootPath: "/",
};

type SyntheticContext = SourceContextBase<"family_shared">;
type SyntheticScan = SourceScanResultBase;

const SYNTHETIC_READER_REGISTRY = defineAssetReaderRegistry({
    Guidance: sourceReader(buildSyntheticGuidanceCandidates),
    Rule: sourceUnavailable("deferred", "synthetic.rule_deferred", "Synthetic Rule reading is intentionally deferred"),
    Workflow: sourceUnavailable(
        "deferred",
        "synthetic.workflow_deferred",
        "Synthetic Workflow reading is intentionally deferred",
    ),
    Skill: sourceUnavailable("deferred", "synthetic.skill_deferred", "Synthetic Skill reading is intentionally deferred"),
    Subagent: sourceUnavailable(
        "deferred",
        "synthetic.subagent_deferred",
        "Synthetic Subagent reading is intentionally deferred",
    ),
    Memory: sourceUnavailable("unsupported", "synthetic.memory_unsupported", "Synthetic Memory has no native source contract"),
});

const temporaryRoots = new Set<string>();

afterEach(() => {
    clearRegistry();
    for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
    temporaryRoots.clear();
});

describe("synthetic fourth adapter family extension", () => {
    it("registers, probes, and reads one native Guidance candidate without Core family knowledge", async () => {
        const fixture = createFixture();
        const { provider, calls } = createSyntheticProvider(fixture.sourceRoot);

        expect(
            inspectAdapterExtensionContract({
                provider,
                sourceReaderRegistry: SYNTHETIC_READER_REGISTRY,
            }),
        ).toEqual([]);
        expect(bootstrapAdapterRegistry([provider])).toEqual({
            status: "complete",
            value: undefined,
            diagnostics: [],
        });
        expect(replaceEnabledAdapters([provider.adapterId]).status).toBe("complete");

        const probed = await probeAdapters({
            adapterIds: [provider.adapterId],
            contexts: [LINUX_CONTEXT],
            target: { authorizationScope: "global" },
        });
        expect(probed.status, JSON.stringify(probed.diagnostics, null, 2)).toBe("complete");
        expect(probed.value).toHaveLength(1);
        const observation = probed.value[0]?.observation;
        expect(observation?.observedAgentRuntimes).toEqual([
            expect.objectContaining({
                agentRuntimeId: AGENT_RUNTIME_ID,
                installationStatus: "available",
                sourceRootIds: [SOURCE_ROOT_ID],
            }),
        ]);
        if (observation === undefined) throw new Error("synthetic probe observation is missing");

        const target: AdapterReadTarget = {
            adapterId: provider.adapterId,
            allowedKinds: ["Guidance"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation,
                sourceRootIds: [SOURCE_ROOT_ID],
            },
        };
        const read = await readAssetsFromAdapterForTest(target, {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: fixture.transactionsRoot,
        });

        expect(read.status, JSON.stringify(read.diagnostics, null, 2)).toBe("complete");
        expect(read.diagnostics).toEqual([]);
        expect(read.value.sourceParseReports).toEqual([
            expect.objectContaining({
                sourceRootId: SOURCE_ROOT_ID,
                status: "parsed",
                sourceReadObligationIds: [expect.any(String)],
            }),
        ]);
        expect(read.value.candidates).toHaveLength(1);
        const candidate = read.value.candidates[0];
        expect(candidate).toMatchObject({
            adapterId: ADAPTER_ID,
            kind: "Guidance",
            scope: "global",
            projectRootPath: "",
            files: [
                {
                    logicalPath: GUIDANCE_PATH,
                    contentKind: "text",
                    text: "# Synthetic fourth family\n",
                },
            ],
            nativeRepresentation: {
                representationSource: "separate_files",
                dialectId: NATIVE_DIALECT_ID,
                files: [{ relativePath: GUIDANCE_PATH }],
            },
        });
        if (candidate?.nativeRepresentation.representationSource !== "separate_files") {
            throw new Error("synthetic candidate lost its native file graph");
        }
        const candidateNativeFile = candidate.nativeRepresentation.files[0];
        if (candidateNativeFile === undefined) {
            throw new Error("synthetic candidate native graph is empty");
        }
        expect([...candidateNativeFile.bytes]).toEqual([...new TextEncoder().encode("# Synthetic fourth family\n")]);
        expect(calls).toEqual({ probe: 1, scan: 1, analyze: 0, materialize: 0, inspect: 0 });

        const native = getRegisteredVersionDialectRegistry().getNative("Guidance", NATIVE_DIALECT_ID);
        expect(native).not.toBeNull();
        const validationInput = nativeValidationInput(candidate);
        expect(native?.validateSameContent(validationInput)).toBe(true);
        const tampered = structuredClone(validationInput);
        const tamperedNativeFile = tampered.nativeFiles[0];
        if (tamperedNativeFile === undefined) throw new Error("native fixture is empty");
        tamperedNativeFile.bytes = new TextEncoder().encode("tampered");
        expect(native?.validateSameContent(tampered)).toBe(false);
    });

    it("rejects incomplete reader and provider matrices before any provider method runs", () => {
        const fixture = createFixture();
        const incompleteRegistry = { ...SYNTHETIC_READER_REGISTRY } as Record<string, unknown>;
        delete incompleteRegistry.Memory;
        expect(() => defineAssetReaderRegistry(incompleteRegistry as never)).toThrow(
            "asset reader registry must answer every AssetKind exactly once",
        );

        const missing = createSyntheticProvider(fixture.sourceRoot);
        const missingProvider = {
            ...missing.provider,
            assetSourceCapabilities: missing.provider.assetSourceCapabilities.filter((row) => row.assetKind !== "Memory"),
        };
        const missingResult = registerAdapterProvider(missingProvider);
        expect(missingResult.status).toBe("failed");
        expect(missingResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("adapter.source_capability_missing");
        expect(missing.calls).toEqual({
            probe: 0,
            scan: 0,
            analyze: 0,
            materialize: 0,
            inspect: 0,
        });

        clearRegistry();
        const duplicate = createSyntheticProvider(fixture.sourceRoot);
        const duplicateSourceRow = duplicate.provider.assetSourceCapabilities[0];
        if (duplicateSourceRow === undefined) throw new Error("source fixture is empty");
        const duplicateProvider = {
            ...duplicate.provider,
            assetSourceCapabilities: [...duplicate.provider.assetSourceCapabilities, structuredClone(duplicateSourceRow)],
        };
        const duplicateResult = registerAdapterProvider(duplicateProvider);
        expect(duplicateResult.status).toBe("failed");
        expect(duplicateResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("adapter.source_capability_duplicate");

        clearRegistry();
        const foreign = createSyntheticProvider(fixture.sourceRoot);
        const foreignSourceRow = foreign.provider.assetSourceCapabilities[0];
        if (foreignSourceRow === undefined) throw new Error("source fixture is empty");
        const foreignProvider = {
            ...foreign.provider,
            assetSourceCapabilities: foreign.provider.assetSourceCapabilities.map((row) =>
                row === foreignSourceRow ? { ...row, agentRuntimeId: "FOREIGN_CLI" } : row,
            ),
        };
        const foreignResult = registerAdapterProvider(foreignProvider);
        expect(foreignResult.status).toBe("failed");
        expect(foreignResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("adapter.source_runtime_foreign");
        expect(foreign.calls).toEqual({
            probe: 0,
            scan: 0,
            analyze: 0,
            materialize: 0,
            inspect: 0,
        });
    });

    it("rejects manual copies, read wrappers, and unrelated factory calls as construction proof", () => {
        const fixture = createFixture();
        const { provider } = createSyntheticProvider(fixture.sourceRoot);
        const copied = { ...provider };
        const wrapped = { ...provider, read: (input: Parameters<AdapterProvider["read"]>[0]) => provider.read(input) };

        expect(isAdapterFrameworkProvider(provider)).toBe(true);
        expect(isAdapterFrameworkReadHandler(provider.read)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(provider.analyzeRender)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(provider.materializeRender)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(provider.inspectRenderedTarget)).toBe(true);
        expect(Object.isFrozen(provider)).toBe(true);
        expect(inspectAdapterExtensionContract({ provider: copied, sourceReaderRegistry: SYNTHETIC_READER_REGISTRY })).toContain(
            "Provider was not constructed by adapter-framework",
        );
        expect(inspectAdapterExtensionContract({ provider: wrapped, sourceReaderRegistry: SYNTHETIC_READER_REGISTRY })).toEqual(
            expect.arrayContaining([
                "Provider read handler is not the adapter-framework-owned function",
                "Provider was not constructed by adapter-framework",
            ]),
        );

        createSyntheticProvider(fixture.sourceRoot);
        expect(isAdapterFrameworkProvider(copied)).toBe(false);
        expect(isAdapterFrameworkReadHandler(wrapped.read)).toBe(false);

        const wrappedTarget = {
            ...provider,
            analyzeRender: (input: Parameters<AdapterProvider["analyzeRender"]>[0]) => provider.analyzeRender(input),
        };
        expect(
            inspectAdapterExtensionContract({
                provider: wrappedTarget,
                sourceReaderRegistry: SYNTHETIC_READER_REGISTRY,
            }),
        ).toContain("Provider analyzeRender handler is not the adapter-framework-owned function");
    });
});

function createFixture(): { sourceRoot: string; transactionsRoot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-fourth-family-"));
    temporaryRoots.add(root);
    const sourceRoot = path.join(root, "source");
    const transactionsRoot = path.join(root, "transactions");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(transactionsRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, GUIDANCE_PATH), "# Synthetic fourth family\n");
    return { sourceRoot, transactionsRoot };
}

function createSyntheticProvider(sourceRootPath: string): {
    provider: AdapterProvider;
    calls: Record<"probe" | "scan" | "analyze" | "materialize" | "inspect", number>;
} {
    const calls = { probe: 0, scan: 0, analyze: 0, materialize: 0, inspect: 0 };
    const agentRuntimes = [
        {
            agentRuntimeId: AGENT_RUNTIME_ID,
            displayName: "Synthetic fourth CLI",
            entryClass: "cli" as const,
        },
    ];
    const sourceCapabilities = BUILTIN_ASSET_KINDS.map((assetKind) =>
        createAdapterAssetSourceCapability(
            { adapterId: ADAPTER_ID, agentRuntimes },
            {
                agentRuntimeId: AGENT_RUNTIME_ID,
                entrySupportStatus: assetKind === "Guidance" ? "supported" : assetKind === "Memory" ? "unsupported" : "deferred",
                rootLocatorKind: "runtime_known_rule",
                rootRole: "source",
                sourceDomain: "family_shared",
                assetKind,
                sourcePathMechanism: assetKind === "Guidance" ? "recursive_entry" : "unknown",
                evidenceLevel: "local_artifact",
                readPolicy: assetKind === "Guidance" ? "auto_read" : "report_only",
                diagnostics:
                    assetKind === "Guidance" ? [] : [syntheticDiagnostic(`synthetic.source.${assetKind}.unavailable`, "read")],
            },
        ),
    );
    const provider = defineAdapterProvider({
        adapterId: ADAPTER_ID,
        displayName: "Synthetic fourth adapter",
        version: "1.0.0",
        agentRuntimes,
        targetContextSchemas: [],
        assetSourceCapabilities: sourceCapabilities,
        assetTargetCapabilities: BUILTIN_ASSET_KINDS.map((assetKind) => ({
            agentRuntimeId: AGENT_RUNTIME_ID,
            entrySupportStatus: "deferred",
            assetKind,
            diagnostics: [syntheticDiagnostic(`synthetic.target.${assetKind}.deferred`, "render")],
        })),
        materializerCapabilities: [],
        renderContractDeclarations: [],
        dialectContracts: {
            native: [
                {
                    definition: {
                        kind: "Guidance",
                        dialectId: NATIVE_DIALECT_ID,
                        nativeFileGraphSchema: component("synthetic.native-graph"),
                        contentNormalization: component("synthetic.content-normalization"),
                        nativeToCanonicalParser: component("synthetic.native-parser"),
                        canonicalConsistencyValidator: component("synthetic.canonical-consistency"),
                        rebaseMaterializer: null,
                        targetApplicabilityPredicate: null,
                    },
                    validateSameContent: validateSyntheticNativeDialect,
                },
            ],
            restoration: [],
            portableEntries: [],
            portableSelectors: [],
        },
        sourceRead: {
            registry: SYNTHETIC_READER_REGISTRY,
            resolveContext: (_readInput, root) =>
                root.rootRole === "source" && root.sourceDomain === "family_shared"
                    ? {
                          root,
                          scope: "global" as const,
                          projectRootPath: "",
                          layout: "family_shared" as const,
                      }
                    : null,
            scan: (readInput, obligation, capability, context) => {
                calls.scan += 1;
                return traverseSourceRead(readInput, obligation, capability, context, {
                    shouldEnterDirectory: () => false,
                    shouldReadFile: (kind, _context, relativePath) => kind === "Guidance" && relativePath === GUIDANCE_PATH,
                    dispositionId: (handle) => `synthetic:${handle.readEntryHandleId}`,
                    rootEntryKindDiagnostic: (context, expectedKind) =>
                        syntheticDiagnostic(`synthetic.root_not_${expectedKind}`, "read", context.root.path),
                    mechanismNotCallableDiagnostic: (context) =>
                        syntheticDiagnostic("synthetic.mechanism_not_callable", "read", context.root.path),
                });
            },
            diagnostics: {
                unknownAuthority: (root) => syntheticDiagnostic("synthetic.authority_unknown", "read", root?.path ?? ""),
                capabilityNotCallable: (root) => syntheticDiagnostic("synthetic.capability_not_callable", "read", root.path),
                readerUnavailable: (root, unavailable) => syntheticDiagnostic(unavailable.diagnosticCode, "read", root.path),
                contextUnresolved: (root) => syntheticDiagnostic("synthetic.context_unresolved", "read", root.path),
                rootWithoutObligation: (root) => syntheticDiagnostic("synthetic.root_without_obligation", "read", root.path),
            },
        },
        async probe() {
            calls.probe += 1;
            return {
                status: "complete",
                observation: {
                    observedAgentRuntimes: [
                        {
                            agentRuntimeId: AGENT_RUNTIME_ID,
                            versionText: "1.0.0",
                            installationEvidence: [
                                {
                                    kind: "install_root",
                                    path: sourceRootPath,
                                    evidenceLevel: "local_artifact",
                                    diagnostics: [],
                                },
                            ],
                            sourceRootIds: [SOURCE_ROOT_ID],
                            agentRuntimeResourceIds: [],
                            observedProjectIds: [],
                            installationStatus: "available",
                            projectDiscoveryStatus: "not_found",
                            diagnostics: [],
                        },
                    ],
                    sourceRoots: [syntheticSourceRoot(sourceRootPath)],
                    agentRuntimeResources: [],
                    observedProjects: [],
                    targetCandidates: [],
                },
                diagnostics: [],
            };
        },
        targetRender: { consumers: [], materializers: [] },
    });
    return { provider, calls };
}

function buildSyntheticGuidanceCandidates(context: SyntheticContext, scan: SyntheticScan) {
    const file = scan.files.find((candidate) => candidate.relativePath === GUIDANCE_PATH);
    if (file === undefined || file.text === null || file.text.trim() === "") {
        return { candidates: [], diagnostics: [], ignoredSource: false };
    }
    const candidateId = "synthetic-fourth-guidance";
    const candidate: AdapterExtractedAssetCandidate = {
        candidateId,
        sourceRootIds: [scan.obligation.sourceRootId],
        scope: context.scope,
        projectRootPath: context.projectRootPath,
        scopePath: "",
        displayName: "Synthetic fourth Guidance",
        displayDescription: "",
        files: [
            {
                logicalPath: GUIDANCE_PATH,
                role: "entry",
                contentKind: "text",
                mediaType: "text/markdown",
                text: file.text,
                executable: false,
                references: [],
            },
        ],
        nativeRepresentation: buildSeparateNativeRepresentation(NATIVE_DIALECT_ID, [file]),
        dialectRestorationTransition: { action: "inherit" },
        status: "complete",
        assetCandidateStatus: "importable",
        promotionSafety: "default_promotable",
        sourceFileOrigins: [
            {
                logicalPath: GUIDANCE_PATH,
                observedReadEntryIds: [file.observedReadEntryId],
            },
        ],
        sourceContainerEntryIds: [],
        metadataSourceOrigins: [
            {
                metadataSubject: "display_name",
                observedReadEntryId: file.observedReadEntryId,
            },
            {
                metadataSubject: "type_data",
                observedReadEntryId: file.observedReadEntryId,
            },
        ],
        sourceEvidence: [
            {
                evidenceOrigin: "observed_read",
                observedReadEntryId: file.observedReadEntryId,
                kind: "document",
                value: `synthetic_guidance:${file.relativePath}`,
                evidenceLevel: scan.capability.evidenceLevel,
            },
        ],
        diagnostics: [],
        kind: "Guidance",
        typeData: { schemaVersion: 1 },
    };
    scan.attachCandidate(candidateId, [file]);
    return { candidates: [candidate], diagnostics: [], ignoredSource: false };
}

function syntheticSourceRoot(rootPath: string): SourceRoot {
    return {
        sourceRootId: SOURCE_ROOT_ID,
        rootRole: "source",
        sourceDomain: "family_shared",
        path: rootPath,
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "synthetic_shared_root",
                evidenceLevel: "local_artifact",
            },
        ],
        diagnostics: [],
    };
}

function component(componentId: string): VersionedContractComponentRef {
    return {
        componentId,
        componentVersion: 1,
        configFingerprint: sha256SourceBytes(new TextEncoder().encode(`${componentId}\0v1`)),
    };
}

function validateSyntheticNativeDialect(input: NativeDialectValidationInputV1): boolean {
    const descriptor = input.representation.files[0];
    const native = input.nativeFiles[0];
    const canonical = input.canonicalFiles[0];
    if (
        input.canonical.kind !== "Guidance" ||
        input.canonical.typeData.schemaVersion !== 1 ||
        input.representation.schemaVersion !== 1 ||
        input.representation.dialectId !== NATIVE_DIALECT_ID ||
        input.representation.files.length !== 1 ||
        input.nativeFiles.length !== 1 ||
        input.canonicalFiles.length !== 1 ||
        descriptor === undefined ||
        native === undefined ||
        canonical?.contentKind !== "text"
    ) {
        return false;
    }
    return (
        descriptor.relativePath === GUIDANCE_PATH &&
        native.relativePath === GUIDANCE_PATH &&
        canonical.file.logicalPath === GUIDANCE_PATH &&
        descriptor.contentKind === "text" &&
        descriptor.mediaType === "text/markdown" &&
        descriptor.executable === false &&
        canonical.file.contentKind === "text" &&
        canonical.file.mediaType === "text/markdown" &&
        canonical.file.executable === false &&
        descriptor.byteSize === native.bytes.byteLength &&
        descriptor.contentHash === sha256SourceBytes(native.bytes) &&
        new TextDecoder("utf-8", { fatal: true }).decode(native.bytes) === canonical.text
    );
}

function nativeValidationInput(candidate: ExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") {
        throw new Error("synthetic native representation is not separate-files");
    }
    const nativeFile = candidate.nativeRepresentation.files[0];
    if (nativeFile === undefined) throw new Error("synthetic native representation is empty");
    const bytes = new Uint8Array(nativeFile.bytes);
    const contentHash = sha256SourceBytes(bytes);
    return {
        canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
        canonicalFiles: [
            {
                file: {
                    fileId: "00000000-0000-4000-8000-000000000001",
                    logicalPath: GUIDANCE_PATH,
                    role: "entry",
                    contentHash,
                    contentKind: "text",
                    mediaType: "text/markdown",
                    byteSize: bytes.byteLength,
                    executable: false,
                    references: [],
                },
                contentKind: "text",
                text: new TextDecoder().decode(bytes),
            },
        ],
        representation: {
            schemaVersion: 1,
            dialectId: NATIVE_DIALECT_ID,
            dialectContractFingerprint: ZERO_DIGEST,
            canonicalContentFingerprint: ZERO_DIGEST,
            files: [
                {
                    relativePath: GUIDANCE_PATH,
                    contentKind: "text",
                    mediaType: "text/markdown",
                    contentHash,
                    byteSize: bytes.byteLength,
                    executable: false,
                },
            ],
            representationFingerprint: ZERO_DIGEST,
        },
        nativeFiles: [{ relativePath: GUIDANCE_PATH, bytes }],
    };
}

function syntheticDiagnostic(
    code: string,
    operation: OperationDiagnostic["operation"],
    diagnosticPath = "",
): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message: code,
        path: diagnosticPath,
        traceId: "",
        operation,
        causeKind: "unsupported",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
