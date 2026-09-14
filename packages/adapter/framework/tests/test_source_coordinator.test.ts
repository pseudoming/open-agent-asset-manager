import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AdapterProviderReadInput,
    AssetKind,
    OperationDiagnostic,
    ProviderReadEntryDisposition,
    SourceReadObligation,
    SourceRoot,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    coordinateSourceRead,
    type SourceContextBase,
    type SourceReadCoordinatorHooks,
    type SourceScanResultBase,
    sourceReader,
    sourceUnavailable,
} from "../src";

type TestContext = SourceContextBase<"test">;
type TestScan = SourceScanResultBase;

function diagnostic(code: string, path = ""): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message: code,
        path,
        traceId: "",
        operation: "read",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: ["skip"],
        rawSummary: "",
    };
}

function root(sourceRootId: string): SourceRoot {
    return {
        sourceRootId,
        rootRole: "source",
        sourceDomain: "family_shared",
        path: `/${sourceRootId}`,
        accessStatus: "available",
        locatorEvidence: [],
        diagnostics: [],
    } as SourceRoot;
}

function capability(
    fingerprint: string,
    assetKind: AssetKind,
    overrides: Partial<AdapterAssetSourceCapability> = {},
): AdapterAssetSourceCapability {
    return {
        sourceCapabilityFingerprint: fingerprint,
        agentRuntimeId: "TEST_CLI",
        entrySupportStatus: "supported",
        rootLocatorKind: "known_path",
        rootRole: "source",
        sourceDomain: "family_shared",
        assetKind,
        sourcePathMechanism: "known_path",
        evidenceLevel: "runtime_verified",
        readPolicy: "auto_read",
        diagnostics: [],
        ...overrides,
    } as AdapterAssetSourceCapability;
}

function obligation(
    sourceReadObligationId: string,
    sourceRootId: string,
    sourceCapabilityFingerprint: string,
): SourceReadObligation {
    return {
        sourceReadObligationId,
        sourceRootId,
        sourceCapabilityFingerprint,
    } as SourceReadObligation;
}

function probeInput(
    roots: SourceRoot[],
    obligations: SourceReadObligation[],
    selectedRootIds = roots.map((item) => item.sourceRootId),
): AdapterProviderReadInput {
    return {
        target: {
            sourceSelector: {
                selectorKind: "probe_roots",
                sourceRootIds: selectedRootIds,
                observation: { sourceRoots: roots },
            },
        },
        sourceReadObligations: obligations,
    } as AdapterProviderReadInput;
}

function userSelectedInput(selectedRoot: SourceRoot, obligations: SourceReadObligation[]): AdapterProviderReadInput {
    return {
        target: {
            sourceSelector: {
                selectorKind: "user_selected_root",
                binding: {
                    sourceRoot: selectedRoot,
                    assetScope: "global",
                    projectRootPath: "",
                },
            },
        },
        sourceReadObligations: obligations,
    } as AdapterProviderReadInput;
}

function candidate(candidateId: string, overrides: Partial<AdapterExtractedAssetCandidate> = {}): AdapterExtractedAssetCandidate {
    return {
        candidateId,
        status: "complete",
        assetCandidateStatus: "importable",
        diagnostics: [],
        ...overrides,
    } as AdapterExtractedAssetCandidate;
}

function observedCandidate(
    candidateId: string,
    observedReadEntryId: string,
    displayName = "Shared guidance",
): AdapterExtractedAssetCandidate {
    return candidate(candidateId, {
        sourceRootIds: ["shared-root"],
        scope: "global",
        projectRootPath: "",
        scopePath: "",
        displayName,
        displayDescription: "",
        files: [
            {
                logicalPath: "GUIDANCE.md",
                role: "entry",
                contentKind: "text",
                mediaType: "text/markdown",
                text: "# Shared\n",
                executable: false,
            },
            {
                logicalPath: "DETAILS.md",
                role: "resource",
                contentKind: "text",
                mediaType: "text/markdown",
                text: "# Details\n",
                executable: false,
            },
        ],
        nativeRepresentation: {
            representationSource: "separate_files",
            dialectId: "shared-guidance-v1",
            files: [
                {
                    relativePath: "AGENTS.md",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    bytes: new TextEncoder().encode("# Shared\n"),
                    executable: false,
                },
                {
                    relativePath: "instructions.fragment.jsonc",
                    contentKind: "binary",
                    mediaType: "application/octet-stream",
                    bytes: new TextEncoder().encode("[]"),
                    executable: false,
                    fragmentOrigin: {
                        fragmentKind: "jsonc_top_level_property_value",
                        observedReadEntryId,
                        propertyName: "instructions",
                    },
                },
            ],
        },
        dialectRestorationTransition: { action: "inherit" },
        promotionSafety: "default_promotable",
        sourceFileOrigins: [
            { logicalPath: "DETAILS.md", observedReadEntryIds: [observedReadEntryId] },
            { logicalPath: "GUIDANCE.md", observedReadEntryIds: [observedReadEntryId] },
        ],
        sourceContainerEntryIds: [`container:${observedReadEntryId}`],
        metadataSourceOrigins: [{ metadataSubject: "display_name", observedReadEntryId }],
        sourceEvidence: [
            {
                evidenceOrigin: "observed_read",
                observedReadEntryId,
                kind: "document",
                value: "shared-guidance",
                evidenceLevel: "runtime_verified",
            },
            {
                evidenceOrigin: "external_attestation",
                externalAttestationReceiptId: "shared-attestation",
            },
        ],
        kind: "Guidance",
        typeData: { schemaVersion: 1 },
    });
}

function parsedDisposition(id: string, obligationId: string, candidateIds: string[]): ProviderReadEntryDisposition {
    return {
        readEntryDispositionId: id,
        sourceReadObligationId: obligationId,
        readEntryHandleId: `handle:${id}`,
        disposition: "parsed",
        readAccessOutcomeId: `outcome:${id}`,
        observedReadEntryIds: [`observed:${id}`],
        candidateIds,
    };
}

function ignoredDisposition(id: string, obligationId: string): ProviderReadEntryDisposition {
    return {
        readEntryDispositionId: id,
        sourceReadObligationId: obligationId,
        readEntryHandleId: `handle:${id}`,
        disposition: "ignored",
        reasonCode: "test_ignored",
    };
}

function scan(
    item: SourceReadObligation,
    cap: AdapterAssetSourceCapability,
    input: {
        observed?: string[];
        dispositions?: ProviderReadEntryDisposition[];
        diagnostics?: OperationDiagnostic[];
        ignored?: boolean;
    } = {},
): TestScan {
    return {
        obligation: item,
        capability: cap,
        files: [],
        directories: [],
        dispositions: input.dispositions ?? [],
        observedReadEntryIds: input.observed ?? [],
        diagnostics: input.diagnostics ?? [],
        hadIgnoredSource: input.ignored ?? false,
        attachCandidate() {},
        ignoreRecord() {},
        ignoreHandle() {},
        async readReferencedFile() {
            return { state: "failed", failureStatus: "not_found" };
        },
    };
}

function hooks(
    readers: Partial<Record<AssetKind, "reader" | "unsupported" | "deferred">> = {},
): SourceReadCoordinatorHooks<TestContext, TestScan> {
    return {
        getReader(kind) {
            const disposition = readers[kind] ?? "reader";
            if (disposition !== "reader") {
                return sourceUnavailable(disposition, `test.${kind}.unavailable`, "unavailable");
            }
            return sourceReader((_context: TestContext, item: TestScan) => ({
                candidates: item.obligation.sourceReadObligationId.includes("parsed")
                    ? [candidate(`candidate:${item.obligation.sourceReadObligationId}`)]
                    : [],
                diagnostics: item.obligation.sourceReadObligationId.includes("builder-diagnostic")
                    ? [diagnostic("builder-diagnostic")]
                    : [],
                ignoredSource: item.obligation.sourceReadObligationId.includes("builder-ignored"),
            }));
        },
        resolveContext(_input, selectedRoot) {
            return selectedRoot.sourceRootId.includes("unresolved")
                ? null
                : {
                      root: selectedRoot,
                      scope: "global",
                      projectRootPath: "",
                      layout: "test",
                  };
        },
        async scan(_input, item, cap) {
            return scan(item, cap);
        },
        diagnostics: {
            unknownAuthority: (selectedRoot) => diagnostic("unknown-authority", selectedRoot?.path),
            capabilityNotCallable: (selectedRoot) => diagnostic("not-callable", selectedRoot.path),
            readerUnavailable: (selectedRoot, unavailable) => diagnostic(unavailable.diagnosticCode, selectedRoot.path),
            contextUnresolved: (selectedRoot) => diagnostic("context-unresolved", selectedRoot.path),
            rootWithoutObligation: (selectedRoot) => diagnostic("root-without-obligation", selectedRoot.path),
        },
    };
}

describe("adapter-framework fixed source-read coordinator", () => {
    it("sorts obligations and candidates while normalizing merged parse accounting", async () => {
        const selectedRoot = root("root-b");
        const idleRoot = root("root-a");
        const parsedCap = capability("fp-parsed", "Guidance");
        const emptyCap = capability("fp-empty", "Guidance");
        const parsed = obligation("a-parsed-builder-diagnostic", "root-b", "fp-parsed");
        const middle = obligation("m-parsed", "root-b", "fp-parsed");
        const empty = obligation("z-empty", "root-b", "fp-empty");
        const testHooks = hooks();
        testHooks.scan = async (_input, item, cap) =>
            item.sourceReadObligationId === parsed.sourceReadObligationId
                ? scan(item, cap, {
                      observed: ["observed-b", "observed-a", "observed-a"],
                      dispositions: [
                          parsedDisposition("z", item.sourceReadObligationId, ["b", "a", "a"]),
                          ignoredDisposition("a", item.sourceReadObligationId),
                      ],
                      diagnostics: [diagnostic("scan-diagnostic")],
                  })
                : scan(item, cap);

        const result = await coordinateSourceRead(
            probeInput([selectedRoot, idleRoot], [empty, middle, parsed]),
            [parsedCap, emptyCap],
            testHooks,
        );

        expect(result.candidates.map((item) => item.candidateId)).toEqual([
            "candidate:a-parsed-builder-diagnostic",
            "candidate:m-parsed",
        ]);
        expect(result.sourceParseReports.map((report) => report.sourceRootId)).toEqual(["root-a", "root-b"]);
        expect(result.sourceParseReports[0]).toMatchObject({
            status: "deferred",
            sourceReadObligationIds: [],
            diagnostics: [{ code: "root-without-obligation" }],
        });
        expect(result.sourceParseReports[1]).toMatchObject({
            status: "parsed",
            sourceReadObligationIds: ["a-parsed-builder-diagnostic", "m-parsed", "z-empty"],
            observedReadEntryIds: ["observed-a", "observed-b"],
        });
        expect(result.sourceParseReports[1]?.readEntryDispositions).toEqual([
            ignoredDisposition("a", parsed.sourceReadObligationId),
            parsedDisposition("z", parsed.sourceReadObligationId, ["a", "b"]),
        ]);
        expect(result.diagnostics.map((item) => item.code)).toEqual(["scan-diagnostic", "builder-diagnostic"]);
    });

    it("reports scan-ignored and builder-ignored sources without inventing candidates", async () => {
        const scanIgnoredRoot = root("scan-ignored");
        const builderIgnoredRoot = root("builder-ignored");
        const scanCap = capability("fp-scan-ignored", "Guidance");
        const builderCap = capability("fp-builder-ignored", "Skill");
        const scanObligation = obligation("scan-ignored", "scan-ignored", "fp-scan-ignored");
        const builderObligation = obligation("builder-ignored", "builder-ignored", "fp-builder-ignored");
        const testHooks = hooks();
        testHooks.scan = async (_input, item, cap) =>
            scan(item, cap, { ignored: item.sourceReadObligationId === "scan-ignored" });

        const result = await coordinateSourceRead(
            probeInput([scanIgnoredRoot, builderIgnoredRoot], [scanObligation, builderObligation]),
            [scanCap, builderCap],
            testHooks,
        );

        expect(result.candidates).toEqual([]);
        expect(result.sourceParseReports.map((report) => report.status)).toEqual([
            "skipped_ignored_source",
            "skipped_ignored_source",
        ]);
    });

    it("coalesces exact sibling-runtime candidates while retaining every observed origin", async () => {
        const selectedRoot = root("shared-root");
        const capabilities = [
            capability("fp-app", "Guidance", { agentRuntimeId: "TEST_APP" }),
            capability("fp-cli", "Guidance", { agentRuntimeId: "TEST_CLI" }),
        ];
        const obligations = capabilities.map((item) =>
            obligation(`parsed-${item.agentRuntimeId}`, selectedRoot.sourceRootId, item.sourceCapabilityFingerprint),
        );
        const testHooks = hooks();
        testHooks.scan = async (_input, item, cap) =>
            scan(item, cap, {
                observed: [`observed:${item.sourceReadObligationId}`],
                dispositions: [parsedDisposition(item.sourceReadObligationId, item.sourceReadObligationId, ["shared-candidate"])],
            });
        testHooks.getReader = () =>
            sourceReader((_context: TestContext, item: TestScan) => {
                const observedReadEntryId = `observed:${item.obligation.sourceReadObligationId}`;
                const itemCandidate = observedCandidate(
                    "shared-candidate",
                    observedReadEntryId,
                    item.obligation.sourceReadObligationId.includes("different") ? "Different guidance" : undefined,
                );
                itemCandidate.nativeRepresentation = {
                    ...itemCandidate.nativeRepresentation,
                    representationSource: "separate_file_graph",
                    directories: [
                        {
                            relativePath: "bundle",
                            observedReadEntryIds: [`container:${observedReadEntryId}`],
                        },
                    ],
                };
                return { candidates: [itemCandidate], diagnostics: [], ignoredSource: false };
            });

        const result = await coordinateSourceRead(probeInput([selectedRoot], obligations), capabilities, testHooks);

        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({
            candidateId: "shared-candidate",
            sourceFileOrigins: [
                {
                    logicalPath: "DETAILS.md",
                    observedReadEntryIds: ["observed:parsed-TEST_APP", "observed:parsed-TEST_CLI"],
                },
                {
                    logicalPath: "GUIDANCE.md",
                    observedReadEntryIds: ["observed:parsed-TEST_APP", "observed:parsed-TEST_CLI"],
                },
            ],
            sourceContainerEntryIds: ["container:observed:parsed-TEST_APP", "container:observed:parsed-TEST_CLI"],
        });
        expect(result.candidates[0]?.nativeRepresentation).toMatchObject({
            representationSource: "separate_file_graph",
            directories: [
                {
                    relativePath: "bundle",
                    observedReadEntryIds: ["container:observed:parsed-TEST_APP", "container:observed:parsed-TEST_CLI"],
                },
            ],
        });
        expect(result.candidates[0]?.metadataSourceOrigins).toHaveLength(2);
        expect(result.candidates[0]?.sourceEvidence).toHaveLength(3);
        expect(result.sourceParseReports[0]?.sourceReadObligationIds).toEqual(["parsed-TEST_APP", "parsed-TEST_CLI"]);

        testHooks.getReader = () =>
            sourceReader((_context: TestContext, item: TestScan) => ({
                candidates: [observedCandidate("shared-candidate", `observed:${item.obligation.sourceReadObligationId}`)],
                diagnostics: [],
                ignoredSource: false,
            }));
        const fileOnlyResult = await coordinateSourceRead(probeInput([selectedRoot], obligations), capabilities, testHooks);
        expect(fileOnlyResult.candidates).toHaveLength(1);
        expect(fileOnlyResult.candidates[0]?.nativeRepresentation.representationSource).toBe("separate_files");
    });

    it("keeps a duplicate candidate fail-closed when sibling obligations disagree on material", async () => {
        const selectedRoot = root("shared-root");
        const capabilities = [capability("fp-a", "Guidance"), capability("fp-b", "Guidance")];
        const obligations = [
            obligation("parsed-a", selectedRoot.sourceRootId, "fp-a"),
            obligation("parsed-different", selectedRoot.sourceRootId, "fp-b"),
        ];
        const testHooks = hooks();
        testHooks.getReader = () =>
            sourceReader((_context: TestContext, item: TestScan) => {
                const itemCandidate = observedCandidate(
                    "shared-candidate",
                    `observed:${item.obligation.sourceReadObligationId}`,
                    item.obligation.sourceReadObligationId.includes("different") ? "Different guidance" : "Shared guidance",
                );
                itemCandidate.nativeRepresentation = {
                    representationSource: "canonical_files",
                    dialectId: "shared-guidance-v1",
                };
                return { candidates: [itemCandidate], diagnostics: [], ignoredSource: false };
            });

        const result = await coordinateSourceRead(probeInput([selectedRoot], obligations), capabilities, testHooks);

        expect(result.candidates.map((item) => item.displayName)).toEqual(["Shared guidance", "Different guidance"]);
    });

    it("does not hide duplicate candidate IDs emitted by one obligation", async () => {
        const selectedRoot = root("shared-root");
        const cap = capability("fp-a", "Guidance");
        const item = obligation("parsed-a", selectedRoot.sourceRootId, cap.sourceCapabilityFingerprint);
        const testHooks = hooks();
        testHooks.getReader = () =>
            sourceReader(() => ({
                candidates: [
                    observedCandidate("duplicated", "observed:parsed-a"),
                    observedCandidate("duplicated", "observed:parsed-a"),
                ],
                diagnostics: [],
                ignoredSource: false,
            }));

        const result = await coordinateSourceRead(probeInput([selectedRoot], [item]), [cap], testHooks);

        expect(result.candidates.map((candidate) => candidate.candidateId)).toEqual(["duplicated", "duplicated"]);
    });

    it("marks every cross-root member of a Provider identity conflict incomplete", async () => {
        const roots = [root("root-a"), root("root-b"), root("root-c"), root("root-d")];
        const capabilities = roots.map((_item, index) => capability(`fp-${index}`, "Skill"));
        const obligations = roots.map((item, index) => obligation(`parsed-${index}`, item.sourceRootId, `fp-${index}`));
        const testHooks = hooks();
        testHooks.getReader = () =>
            sourceReader((_context: TestContext, item: TestScan) => ({
                candidates: [
                    candidate(`candidate:${item.obligation.sourceReadObligationId}`, {
                        displayName:
                            item.obligation.sourceRootId === "root-c"
                                ? "unique"
                                : item.obligation.sourceRootId === "root-d"
                                  ? "excluded"
                                  : "same-name",
                        scope: "global",
                        projectRootPath: "",
                        kind: "Skill",
                    }),
                ],
                diagnostics: [],
                ignoredSource: false,
            }));
        testHooks.candidateIdentityConflict = {
            identityKey: (item) =>
                item.displayName === "excluded"
                    ? null
                    : `${item.kind}\0${item.scope}\0${item.projectRootPath}\0${item.displayName}`,
            diagnostic: (_item, key) => diagnostic("identity-conflict", key),
        };

        const result = await coordinateSourceRead(probeInput(roots, obligations), capabilities, testHooks);

        expect(result.candidates).toEqual([
            expect.objectContaining({
                candidateId: "candidate:parsed-0",
                status: "incomplete",
                assetCandidateStatus: "incomplete",
                diagnostics: [expect.objectContaining({ code: "identity-conflict" })],
            }),
            expect.objectContaining({
                candidateId: "candidate:parsed-1",
                status: "incomplete",
                assetCandidateStatus: "incomplete",
                diagnostics: [expect.objectContaining({ code: "identity-conflict" })],
            }),
            expect.objectContaining({
                candidateId: "candidate:parsed-2",
                status: "complete",
                assetCandidateStatus: "importable",
                diagnostics: [],
            }),
            expect.objectContaining({
                candidateId: "candidate:parsed-3",
                status: "complete",
                assetCandidateStatus: "importable",
                diagnostics: [],
            }),
        ]);
    });

    it("fails closed for unknown capability and root authority", async () => {
        const knownRoot = root("known-root");
        const cap = capability("known-fp", "Guidance");
        const result = await coordinateSourceRead(
            probeInput(
                [knownRoot],
                [
                    obligation("a-unknown-cap", "known-root", "unknown-fp"),
                    obligation("b-unknown-root", "missing-root", "known-fp"),
                ],
            ),
            [cap],
            hooks(),
        );

        expect(result.sourceParseReports).toHaveLength(1);
        expect(result.sourceParseReports[0]).toMatchObject({
            sourceRootId: "known-root",
            status: "malformed_source",
            sourceReadObligationIds: ["a-unknown-cap"],
        });
        expect(result.diagnostics.map((item) => [item.code, item.path])).toEqual([
            ["unknown-authority", "/known-root"],
            ["unknown-authority", ""],
        ]);
    });

    it("distinguishes unsupported capabilities from deferred and report-only rows", async () => {
        const roots = [root("unsupported"), root("deferred"), root("report-only")];
        const capabilities = [
            capability("fp-unsupported", "Memory", { entrySupportStatus: "unsupported" }),
            capability("fp-deferred", "Rule", { entrySupportStatus: "deferred" }),
            capability("fp-report", "Guidance", { readPolicy: "report_only" }),
        ];
        const obligations = capabilities.map((cap, index) =>
            obligation(`obligation-${index}`, roots[index]?.sourceRootId ?? "", cap.sourceCapabilityFingerprint),
        );

        const result = await coordinateSourceRead(probeInput(roots, obligations), capabilities, hooks());

        expect(result.sourceParseReports.map((report) => report.status)).toEqual(["deferred", "deferred", "unsupported"]);
        expect(result.diagnostics.map((item) => item.code)).toEqual(["not-callable", "not-callable", "not-callable"]);
    });

    it("preserves explicit unsupported and deferred reader dispositions", async () => {
        const unsupportedRoot = root("reader-unsupported");
        const deferredRoot = root("reader-deferred");
        const unsupportedCap = capability("fp-reader-unsupported", "Memory");
        const deferredCap = capability("fp-reader-deferred", "Rule");

        const result = await coordinateSourceRead(
            probeInput(
                [unsupportedRoot, deferredRoot],
                [
                    obligation("unsupported", unsupportedRoot.sourceRootId, "fp-reader-unsupported"),
                    obligation("deferred", deferredRoot.sourceRootId, "fp-reader-deferred"),
                ],
            ),
            [unsupportedCap, deferredCap],
            hooks({ Memory: "unsupported", Rule: "deferred" }),
        );

        expect(result.sourceParseReports.map((report) => report.status)).toEqual(["deferred", "unsupported"]);
        expect(result.diagnostics.map((item) => item.code).sort()).toEqual(["test.Memory.unavailable", "test.Rule.unavailable"]);
    });

    it("marks unresolved family context as malformed before scanning", async () => {
        const selectedRoot = root("unresolved-root");
        const cap = capability("fp-unresolved", "Guidance");
        let scanCalls = 0;
        const testHooks = hooks();
        testHooks.scan = async (_input, item, itemCapability) => {
            scanCalls += 1;
            return scan(item, itemCapability);
        };

        const result = await coordinateSourceRead(
            userSelectedInput(selectedRoot, [
                obligation("unresolved", selectedRoot.sourceRootId, cap.sourceCapabilityFingerprint),
            ]),
            [cap],
            testHooks,
        );

        expect(scanCalls).toBe(0);
        expect(result.sourceParseReports[0]).toMatchObject({ status: "malformed_source" });
        expect(result.diagnostics).toMatchObject([{ code: "context-unresolved" }]);
    });

    it("does not convert a provider hook exception into a successful empty result", async () => {
        const selectedRoot = root("throwing-root");
        const cap = capability("fp-throw", "Guidance");
        const testHooks = hooks();
        testHooks.scan = async () => {
            throw new Error("provider scan failed");
        };

        await expect(
            coordinateSourceRead(
                probeInput([selectedRoot], [obligation("throw", selectedRoot.sourceRootId, cap.sourceCapabilityFingerprint)]),
                [cap],
                testHooks,
            ),
        ).rejects.toThrow("provider scan failed");
    });
});
