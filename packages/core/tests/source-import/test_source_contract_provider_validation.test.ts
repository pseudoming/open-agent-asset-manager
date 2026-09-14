/** Authority-focused split from the original oversized test suite. */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
    executeAdapterReadWithAuthority,
    type AdapterReadAuthorityContext,
} from "../../src/source-import/source-contract-validator";
import { prepareRead } from "../../src/source-import/source-read-preparation";
import { validateCandidateOrigins } from "../../src/source-import/source-read-candidate-validator";
import type {
    AdapterExtractedAssetCandidate,
    AdapterProviderReadResult,
    AdapterReadTarget,
    ObservedReadEntry,
    ReadEntryHandle,
} from "../../src/types";
import {
    RESERVATION,
    DEPLOYMENT_ID,
    sourceFile,
    transactionsRoot,
    root,
    provider,
    target,
    authority,
    validRead,
    successfulRead,
} from "./fixtures/source-contract-test-fixtures";

describe("source contract provider-result validation", () => {
    it("validates one separate JSONC fragment against private read bytes and public snapshot structure", async () => {
        const readResult = await successfulRead();
        const extracted = structuredClone(readResult.candidates[0]!);
        const { adapterId: _adapterId, ...candidateBase } = extracted;
        const candidate = candidateBase as AdapterExtractedAssetCandidate;
        const disposition = readResult.sourceParseReports[0]!.readEntryDispositions[0]!;
        if (disposition.disposition !== "parsed") throw new Error("fragment fixture disposition is missing");
        const entry = readResult.observedReadEntries.find((item) => item.entryKind === "file");
        if (entry?.entryKind !== "file") throw new Error("fragment fixture entry is missing");
        const container = new TextEncoder().encode('{"secret":"keep","instructions":["docs/rule.md"],"theme":"warm"}');
        const fragment = new TextEncoder().encode('["docs/rule.md"]');
        const fragmentFile = {
            relativePath: "resources/instructions.fragment.jsonc" as const,
            contentKind: "binary" as const,
            mediaType: "application/jsonc",
            bytes: fragment,
            executable: false,
            fragmentOrigin: {
                fragmentKind: "jsonc_top_level_property_value" as const,
                observedReadEntryId: entry.observedReadEntryId,
                propertyName: "instructions",
            },
        };
        candidate.nativeRepresentation = {
            representationSource: "separate_files",
            dialectId: "fixture-jsonc-fragment-v1",
            files: [fragmentFile],
        };
        const handle: ReadEntryHandle = {
            readEntryHandleId: disposition.readEntryHandleId,
            sourceReadObligationId: disposition.sourceReadObligationId,
            sourceRootId: entry.sourceRootId,
            relativePath: entry.relativePath,
            entryKind: "file",
        };
        const entries = new Map(readResult.observedReadEntries.map((item) => [item.observedReadEntryId, item]));
        const handles = new Map([[handle.readEntryHandleId, handle]]);
        const outcomes = new Map(readResult.readAccessOutcomes.map((item) => [item.readAccessOutcomeId, item]));
        const validate = (
            value: AdapterExtractedAssetCandidate,
            candidateEntries: ReadonlyMap<string, ObservedReadEntry> = entries,
            payloads: ReadonlyMap<string, Uint8Array> | null = new Map([[entry.observedReadEntryId, container]]),
        ) => {
            const diagnostics = [];
            validateCandidateOrigins(value, [disposition], handles, outcomes, candidateEntries, payloads, [], diagnostics);
            return diagnostics.filter((item) => item.code === "read.candidate_native_fragment_origin_invalid");
        };

        expect(validate(candidate)).toEqual([]);
        expect(validate(candidate, entries, null)).toEqual([]);

        const cases: Array<{
            candidate: AdapterExtractedAssetCandidate;
            entries?: ReadonlyMap<string, ObservedReadEntry>;
            payloads?: ReadonlyMap<string, Uint8Array>;
        }> = [];
        const malformedKind = structuredClone(candidate);
        firstFragment(malformedKind).fragmentOrigin!.fragmentKind = "foreign" as never;
        cases.push({ candidate: malformedKind });
        const missingPayload = structuredClone(candidate);
        cases.push({ candidate: missingPayload, payloads: new Map() });
        const malformedPayload = structuredClone(candidate);
        cases.push({
            candidate: malformedPayload,
            payloads: new Map([[entry.observedReadEntryId, new TextEncoder().encode("{")]]),
        });
        const mismatched = structuredClone(candidate);
        firstFragment(mismatched).bytes = new TextEncoder().encode("[]");
        cases.push({ candidate: mismatched });
        const executable = structuredClone(candidate);
        firstFragment(executable).executable = true;
        cases.push({ candidate: executable });
        const foreignEntry = structuredClone(candidate);
        firstFragment(foreignEntry).fragmentOrigin!.observedReadEntryId = "foreign-entry";
        cases.push({ candidate: foreignEntry });
        const outside = structuredClone(candidate);
        firstFragment(outside).fragmentOrigin!.observedReadEntryId = "outside-entry";
        const outsideEntry = { ...entry, observedReadEntryId: "outside-entry" };
        cases.push({ candidate: outside, entries: new Map([...entries, [outsideEntry.observedReadEntryId, outsideEntry]]) });
        const directory = structuredClone(candidate);
        firstFragment(directory).fragmentOrigin!.observedReadEntryId = "directory-entry";
        const directoryEntry = {
            observedReadEntryId: "directory-entry",
            sourceRootId: entry.sourceRootId,
            relativePath: "directory" as const,
            entryKind: "directory" as const,
            physicalIdentityFingerprint: entry.physicalIdentityFingerprint,
            directoryInventoryFingerprint: entry.physicalIdentityFingerprint,
        };
        cases.push({
            candidate: directory,
            entries: new Map([...entries, [directoryEntry.observedReadEntryId, directoryEntry]]),
        });

        for (const testCase of cases) {
            expect(validate(testCase.candidate, testCase.entries ?? entries, testCase.payloads)).toHaveLength(1);
        }
    });

    it("rejects candidate evidence, root, content, typeData, and disposition tampering", async () => {
        const mutations: Array<(result: AdapterProviderReadResult) => void> = [
            (result) => {
                result.candidates[0]!.sourceRootIds = ["foreign-root"];
            },
            (result) => {
                result.candidates[0]!.files[0] = {
                    ...result.candidates[0]!.files[0]!,
                    text: "tampered",
                } as never;
            },
            (result) => {
                result.candidates[0]!.sourceEvidence[0] = {
                    ...result.candidates[0]!.sourceEvidence[0]!,
                    observedReadEntryId: "foreign",
                } as never;
            },
            (result) => {
                result.candidates[0]!.typeData = { schemaVersion: 2 } as never;
            },
            (result) => {
                (
                    result.sourceParseReports[0]!.readEntryDispositions[0] as {
                        candidateIds: string[];
                    }
                ).candidateIds = [];
            },
        ];
        for (const mutate of mutations) {
            const tamperingProvider = provider(async (input) => {
                const result = await validRead()(input);
                mutate(result);
                return result;
            });
            expect((await executeAdapterReadWithAuthority(tamperingProvider, target(), authority())).status).toBe("failed");
        }
    });

    it("detects a changed source during the two-pass stable closure", async () => {
        const changingProvider = provider(validRead(() => undefined));
        changingProvider.read = async (input) => {
            const result = await validRead()(input);
            fs.writeFileSync(sourceFile, "# Changed\n");
            return result;
        };
        const result = await executeAdapterReadWithAuthority(changingProvider, target(), authority());
        expect(result.status).toBe("failed");
        expect(
            result.value.readAccessOutcomes.some(
                (outcome) => outcome.operation === "final_validate" && outcome.status === "stale",
            ),
        ).toBe(true);
    });

    it("rejects selector and authority ambiguity before provider invocation", async () => {
        let calls = 0;
        const selectedProvider = provider(
            validRead(() => {
                calls += 1;
            }),
        );
        const badTargets: AdapterReadTarget[] = [];
        const badAdapter = target();
        badAdapter.sourceSelector.observation.adapterId = "FOREIGN";
        badTargets.push(badAdapter);
        const duplicateKind = target();
        duplicateKind.allowedKinds = ["Guidance", "Guidance"];
        badTargets.push(duplicateKind);
        const missingRoot = target();
        missingRoot.sourceSelector.sourceRootIds = ["missing"];
        badTargets.push(missingRoot);
        for (const badTarget of badTargets) {
            expect((await executeAdapterReadWithAuthority(selectedProvider, badTarget, authority())).status).toBe("failed");
        }
        expect(
            (
                await executeAdapterReadWithAuthority(
                    selectedProvider,
                    target(),
                    authority({ reservationIdentityFingerprints: ["not-a-digest" as never] }),
                )
            ).status,
        ).toBe("failed");
        expect(calls).toBe(0);
    });

    it("prepares a logical WSL read from canonical Windows-hosted UNC roots without accepting POSIX leakage", () => {
        const uncRoot = "\\\\wsl.localhost\\Ubuntu\\home\\example\\.claude";
        const windowsHostedWsl = target([{ ...root(), path: uncRoot }]);
        windowsHostedWsl.sourceSelector.observation.platformContext = {
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
        };
        const prepared = prepareRead(provider(), windowsHostedWsl, authority());
        expect("diagnostics" in prepared).toBe(false);
        if ("diagnostics" in prepared) throw new Error("expected prepared UNC read");
        expect(prepared.platform).toBe("wsl");
        expect(prepared.roots[0]?.path).toBe(uncRoot);

        const leakedPosix = structuredClone(windowsHostedWsl);
        leakedPosix.sourceSelector.observation.sourceRoots[0]!.path = "/home/example/.claude";
        const rejected = prepareRead(provider(), leakedPosix, authority());
        expect("diagnostics" in rejected && rejected.diagnostics.some((item) => item.code === "read.root_path_invalid")).toBe(
            true,
        );

        const foreignShare = structuredClone(windowsHostedWsl);
        foreignShare.sourceSelector.observation.sourceRoots[0]!.path = "\\\\wsl.localhost\\Debian\\home\\example\\.claude";
        const rejectedForeignShare = prepareRead(provider(), foreignShare, authority());
        expect(
            "diagnostics" in rejectedForeignShare &&
                rejectedForeignShare.diagnostics.some((item) => item.code === "read.root_path_invalid"),
        ).toBe(true);
    });

    it("rejects every untrusted root, runtime, guard, and lock authority before dispatch", async () => {
        let calls = 0;
        const selectedProvider = provider(
            validRead(() => {
                calls += 1;
            }),
        );
        const cases: Array<[string, AdapterReadTarget, AdapterReadAuthorityContext]> = [];

        const foreignRuntime = target();
        foreignRuntime.sourceSelector.observation.observedAgentRuntimes[0]!.agentRuntimeId = "FOREIGN_CLI";
        cases.push(["read.runtime_identity_mismatch", foreignRuntime, authority()]);

        const duplicateObservationRoot = target();
        duplicateObservationRoot.sourceSelector.observation.sourceRoots.push(root());
        cases.push(["read.observation_root_duplicate", duplicateObservationRoot, authority()]);

        const duplicateSelectedRoot = target();
        duplicateSelectedRoot.sourceSelector.sourceRootIds.push("root-1");
        cases.push(["read.selected_root_duplicate", duplicateSelectedRoot, authority()]);

        const unavailableRoot = target([
            {
                ...root(),
                accessStatus: "permission_denied",
                diagnostics: [],
            },
        ]);
        cases.push(["read.root_not_available", unavailableRoot, authority()]);

        const relativeRoot = target([{ ...root(), path: "relative/root" }]);
        cases.push(["read.root_path_invalid", relativeRoot, authority()]);

        const unsupportedKind = target();
        unsupportedKind.allowedKinds = ["Rule"];
        cases.push(["read.source_capability_unavailable", unsupportedKind, authority()]);

        const foreignGuard = {
            sourceRootId: "foreign",
            matchKind: "entire_root" as const,
            managementState: "active_managed" as const,
            deploymentId: DEPLOYMENT_ID,
            outputUnitFingerprint: RESERVATION,
        };
        cases.push(["read.guard_root_foreign", target(), authority({ managedTargetGuards: [foreignGuard] })]);

        const invalidGuard = {
            sourceRootId: "root-1",
            relativePath: "../escape",
            matchKind: "exact_file" as const,
            managementState: "active_managed" as const,
            deploymentId: DEPLOYMENT_ID,
            appliedContentHash: RESERVATION,
        };
        cases.push(["read.guard_path_invalid", target(), authority({ managedTargetGuards: [invalidGuard] })]);

        cases.push([
            "read.guard_authority_invalid",
            target(),
            authority({
                managedTargetGuards: [
                    {
                        ...invalidGuard,
                        relativePath: "managed.md",
                        deploymentId: "not-a-uuid" as never,
                    },
                ],
            }),
        ]);
        cases.push([
            "read.guard_authority_invalid",
            target(),
            authority({
                managedTargetGuards: [
                    {
                        ...invalidGuard,
                        relativePath: "managed.md",
                        appliedContentHash: "not-a-digest" as never,
                    },
                ],
            }),
        ]);
        cases.push([
            "read.guard_authority_invalid",
            target(),
            authority({
                managedTargetGuards: [
                    {
                        sourceRootId: "root-1",
                        matchKind: "entire_root",
                        managementState: "in_flight_managed",
                        deploymentId: DEPLOYMENT_ID,
                        reservationIdentityFingerprint: "not-a-digest" as never,
                    },
                ],
            }),
        ]);

        const exactGuard = { ...invalidGuard, relativePath: "managed.md" };
        cases.push(["read.guard_duplicate", target(), authority({ managedTargetGuards: [exactGuard, exactGuard] })]);
        cases.push([
            "read.reservation_identity_invalid",
            target(),
            authority({
                reservationIdentityFingerprints: [RESERVATION, RESERVATION],
            }),
        ]);
        cases.push(["read.lock_root_missing", target(), authority({ transactionsRoot: "" })]);

        const projectTarget = target();
        projectTarget.sourceSelector = {
            selectorKind: "user_selected_root",
            platformContext: {
                platform: "linux",
                platformInstanceId: "local",
                accessRootPath: "/",
            },
            binding: {
                sourceRoot: root(),
                assetScope: "project",
                projectRootPath: "relative/project",
            },
        };
        cases.push(["read.user_root_project_invalid", projectTarget, authority()]);

        for (const [expectedCode, readTarget, readAuthority] of cases) {
            const result = await executeAdapterReadWithAuthority(selectedProvider, readTarget, readAuthority);
            expect(result.status, expectedCode).toBe("failed");
            expect(
                result.diagnostics.some((item) => item.code === expectedCode),
                expectedCode,
            ).toBe(true);
        }
        expect(calls).toBe(0);
    });

    it("rejects every provider-owned closure forgery with a specific diagnostic", async () => {
        const cases: Array<[string, (result: AdapterProviderReadResult) => void]> = [
            [
                "read.parse_report_obligation_mismatch",
                (result) => {
                    result.sourceParseReports[0]!.sourceReadObligationIds = [];
                },
            ],
            [
                "read.parse_report_entry_foreign",
                (result) => {
                    result.sourceParseReports[0]!.observedReadEntryIds = ["foreign"];
                },
            ],
            [
                "read.disposition_duplicate",
                (result) => {
                    const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
                    result.sourceParseReports[0]!.readEntryDispositions.push({
                        ...disposition,
                    });
                },
            ],
            [
                "read.handle_disposition_duplicate",
                (result) => {
                    const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
                    result.sourceParseReports[0]!.readEntryDispositions.push({
                        ...disposition,
                        readEntryDispositionId: "disposition-2",
                    });
                },
            ],
            [
                "read.handle_disposition_missing",
                (result) => {
                    result.sourceParseReports[0]!.readEntryDispositions = [];
                    result.candidates = [];
                },
            ],
            [
                "read.disposition_authority_mismatch",
                (result) => {
                    result.sourceParseReports[0]!.readEntryDispositions[0]!.sourceReadObligationId = "foreign";
                },
            ],
            [
                "read.ignored_reason_missing",
                (result) => {
                    const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
                    result.sourceParseReports[0]!.readEntryDispositions[0] = {
                        readEntryDispositionId: disposition.readEntryDispositionId,
                        sourceReadObligationId: disposition.sourceReadObligationId,
                        readEntryHandleId: disposition.readEntryHandleId,
                        disposition: "ignored",
                        reasonCode: "",
                    };
                },
            ],
            [
                "read.disposition_candidates_not_canonical",
                (result) => {
                    const first = result.candidates[0]!;
                    const second = structuredClone(first);
                    first.candidateId = "z-candidate";
                    second.candidateId = "a-candidate";
                    result.candidates = [first, second];
                    const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
                    if (disposition.disposition === "ignored") throw new Error("expected candidate disposition");
                    disposition.candidateIds = ["z-candidate", "a-candidate"];
                },
            ],
            [
                "read.traversed_outcome_invalid",
                (result) => {
                    const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
                    result.sourceParseReports[0]!.readEntryDispositions[0] = {
                        readEntryDispositionId: disposition.readEntryDispositionId,
                        sourceReadObligationId: disposition.sourceReadObligationId,
                        readEntryHandleId: disposition.readEntryHandleId,
                        disposition: "traversed",
                        listDirectoryOutcomeId: "missing",
                        observedDirectoryEntryId: result.sourceParseReports[0]!.observedReadEntryIds[0]!,
                        candidateIds: ["provider-candidate"],
                    };
                },
            ],
            [
                "read.parsed_outcome_invalid",
                (result) => {
                    const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
                    if (disposition.disposition !== "parsed") throw new Error("expected parsed disposition");
                    disposition.readAccessOutcomeId = "missing";
                },
            ],
            [
                "read.candidate_kind_mismatch",
                (result) => {
                    result.candidates[0]!.kind = "Rule";
                },
            ],
            [
                "read.candidate_file_graph_invalid",
                (result) => {
                    result.candidates[0]!.files[0]!.logicalPath = "../escape.md";
                },
            ],
            [
                "read.candidate_native_graph_invalid",
                (result) => {
                    result.candidates[0]!.nativeRepresentation = {
                        representationSource: "separate_files",
                        dialectId: "mock-guidance-v1",
                        files: [
                            {
                                relativePath: "../native.md",
                                contentKind: "text",
                                mediaType: "text/markdown",
                                bytes: Buffer.from("native"),
                                executable: false,
                            },
                        ],
                    };
                },
            ],
            [
                "read.candidate_native_graph_invalid",
                (result) => {
                    const nativeFile = {
                        relativePath: "native.md",
                        contentKind: "text" as const,
                        mediaType: "text/markdown",
                        bytes: Buffer.from("native"),
                        executable: false,
                    };
                    result.candidates[0]!.nativeRepresentation = {
                        representationSource: "separate_files",
                        dialectId: "mock-guidance-v1",
                        files: [nativeFile, { ...nativeFile }],
                    };
                },
            ],
            [
                "read.candidate_media_type_invalid",
                (result) => {
                    result.candidates[0]!.files[0]!.mediaType = "text/plain";
                },
            ],
            [
                "read.candidate_media_type_invalid",
                (result) => {
                    result.candidates[0]!.nativeRepresentation = {
                        representationSource: "separate_files",
                        dialectId: "mock-guidance-v1",
                        files: [
                            {
                                relativePath: "native.md",
                                contentKind: "text",
                                mediaType: "Text/Markdown; charset=UTF-8",
                                bytes: Buffer.from("native"),
                                executable: false,
                            },
                        ],
                    };
                },
            ],
            [
                "read.candidate_complete_entry_invalid",
                (result) => {
                    result.candidates[0]!.files[0] = {
                        logicalPath: "GUIDANCE.md",
                        role: "entry",
                        contentKind: "binary",
                        mediaType: "application/octet-stream",
                        bytes: Buffer.from("# Guidance\n"),
                        executable: false,
                    };
                },
            ],
            [
                "read.candidate_spec_files_invalid",
                (result) => {
                    result.candidates[0] = {
                        ...result.candidates[0]!,
                        kind: "Subagent",
                        typeData: {
                            schemaVersion: 2,
                            name: "reviewer",
                            description: "Reviews changes",
                            promptContextPolicy: { mode: "agent_runtime_default" },
                            tools: {
                                availability: {
                                    base: { mode: "inherit_available" },
                                    unavailable: [],
                                },
                                permission: {
                                    rules: [],
                                    otherwise: "inherit_agent_runtime_policy",
                                },
                            },
                            dependencies: { preloadedSkillVersionIds: [] },
                            memory: { mode: "disabled" },
                            execution: {
                                permission: { mode: "inherit" },
                                workspaceIsolation: { mode: "agent_runtime_default" },
                                scheduling: { mode: "agent_runtime_default" },
                                turnLimit: { mode: "agent_runtime_default" },
                                model: { mode: "inherit" },
                                effort: { mode: "inherit" },
                                sampling: {
                                    temperature: { mode: "agent_runtime_default" },
                                    topP: { mode: "agent_runtime_default" },
                                },
                            },
                            directInvocation: {
                                mode: "user_selectable",
                                initialPrompt: {
                                    mode: "resource",
                                    logicalPath: "prompts/start.md",
                                    dialectId: "mock",
                                },
                            },
                            presentation: {
                                listing: "agent_runtime_default",
                                color: { mode: "agent_runtime_default" },
                            },
                        },
                        files: [
                            {
                                logicalPath: "GUIDANCE.md",
                                role: "entry",
                                contentKind: "text",
                                mediaType: "application/json",
                                text: JSON.stringify({
                                    schemaVersion: 1,
                                    sections: [{ title: "Role", content: "Review changes" }],
                                }),
                                executable: false,
                            },
                        ],
                    };
                },
            ],
            [
                "read.candidate_kind_mismatch",
                (result) => {
                    result.candidates[0] = {
                        ...result.candidates[0]!,
                        kind: "Memory",
                        typeData: {
                            schemaVersion: 2,
                            entityRole: "catalog",
                            members: [],
                        },
                        files: [],
                        sourceFileOrigins: [],
                    };
                },
            ],
            [
                "read.candidate_scope_invalid",
                (result) => {
                    result.candidates[0]!.projectRootPath = "/unexpected";
                },
            ],
            [
                "read.candidate_scope_invalid",
                (result) => {
                    result.candidates[0]!.scope = "project";
                    result.candidates[0]!.projectRootPath = "";
                },
            ],
            [
                "read.candidate_file_origin_mismatch",
                (result) => {
                    result.candidates[0]!.sourceFileOrigins = [];
                },
            ],
            [
                "read.candidate_file_origin_missing",
                (result) => {
                    result.candidates[0]!.sourceFileOrigins[0]!.observedReadEntryIds = [];
                },
            ],
            [
                "read.candidate_container_origin_invalid",
                (result) => {
                    result.candidates[0]!.sourceContainerEntryIds = [result.sourceParseReports[0]!.observedReadEntryIds[0]!];
                },
            ],
            [
                "read.candidate_container_origins_not_canonical",
                (result) => {
                    const id = result.sourceParseReports[0]!.observedReadEntryIds[0]!;
                    result.candidates[0]!.sourceContainerEntryIds = [id, id];
                },
            ],
            [
                "read.candidate_metadata_origin_invalid",
                (result) => {
                    result.candidates[0]!.metadataSourceOrigins[0]!.observedReadEntryId = "foreign";
                },
            ],
            [
                "read.candidate_metadata_origins_not_canonical",
                (result) => {
                    const origin = result.candidates[0]!.metadataSourceOrigins[0]!;
                    result.candidates[0]!.metadataSourceOrigins.push({ ...origin });
                },
            ],
            [
                "read.candidate_attestation_unknown",
                (result) => {
                    result.candidates[0]!.sourceEvidence = [
                        {
                            evidenceOrigin: "external_attestation",
                            externalAttestationReceiptId: "foreign",
                        },
                    ];
                },
            ],
            [
                "read.candidate_reverse_origin_missing",
                (result) => {
                    result.candidates[0]!.sourceFileOrigins = [];
                    result.candidates[0]!.metadataSourceOrigins = [];
                    result.candidates[0]!.sourceEvidence = [];
                },
            ],
            [
                "read.candidate_parse_outcome_missing",
                (result) => {
                    const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
                    if (disposition.disposition !== "parsed") throw new Error("expected parsed disposition");
                    disposition.readAccessOutcomeId = "missing";
                },
            ],
            [
                "read.candidate_disposition_mismatch",
                (result) => {
                    const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
                    if (disposition.disposition === "ignored") throw new Error("expected candidate disposition");
                    disposition.candidateIds = ["foreign-provider-id"];
                },
            ],
        ];
        for (const [expectedCode, mutate] of cases) {
            const selectedProvider = provider(async (input) => {
                const result = await validRead()(input);
                mutate(result);
                return result;
            });
            const result = await executeAdapterReadWithAuthority(selectedProvider, target(), authority());
            expect(result.status, expectedCode).toBe("failed");
            expect(
                result.diagnostics.some((item) => item.code === expectedCode),
                expectedCode,
            ).toBe(true);
        }
    });
});

function firstFragment(candidate: AdapterExtractedAssetCandidate) {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") {
        throw new Error("separate native fragment fixture is missing");
    }
    const file = candidate.nativeRepresentation.files[0];
    if (file === undefined) throw new Error("separate native fragment file is missing");
    return file;
}
