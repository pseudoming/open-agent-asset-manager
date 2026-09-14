/** Authority-focused split from the original oversized test suite. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    computeReadAuthorityFingerprint,
    executeAdapterReadWithAuthority,
    validateAdapterReadResultSnapshot,
} from "../../src/source-import/source-contract-validator";
import { computeSourceCapabilityFingerprint } from "../../src/adapters/adapter-contract-validator";
import { fingerprintDomain } from "../../src/foundation/fingerprint";
import type { AdapterProviderReadInput } from "../../src/types";
import {
    ADAPTER,
    RESERVATION,
    DEPLOYMENT_ID,
    sandbox,
    sourceFile,
    root,
    provider,
    target,
    authority,
    validRead,
} from "./fixtures/source-contract-test-fixtures";

describe("source contract execution and read ledger", () => {
    it("keeps Core read authority immutable when a provider mutates its projected input", async () => {
        const malicious = provider(async (input) => {
            expect(Object.isFrozen(input.readAccess)).toBe(true);
            const result = await validRead()(input);
            input.sourceReadObligations.length = 0;
            input.managedTargetGuards.push({
                sourceRootId: "foreign",
                matchKind: "entire_root",
                deploymentId: DEPLOYMENT_ID,
                provenanceFingerprint: RESERVATION,
            });
            return result;
        });
        const result = await executeAdapterReadWithAuthority(malicious, target(), authority());
        expect(result.status).toBe("complete");
        expect(result.value.sourceReadObligations).toHaveLength(1);
        expect(result.value.sourceRoots.map((item) => item.sourceRootId)).toEqual(["root-1"]);
    });

    it("stamps provider output with Core authority and produces an exact terminal ledger", async () => {
        let providerInput: AdapterProviderReadInput | undefined;
        const selectedProvider = provider(
            validRead((input) => {
                providerInput = input;
            }),
        );
        const readTarget = target();
        const result = await executeAdapterReadWithAuthority(selectedProvider, readTarget, authority());
        expect(result.status).toBe("complete");
        expect(result.value.readTarget).toEqual(readTarget);
        expect(providerInput?.target).toEqual({ sourceSelector: readTarget.sourceSelector });
        expect("adapterId" in (providerInput?.target ?? {})).toBe(false);
        expect("allowedKinds" in (providerInput?.target ?? {})).toBe(false);
        expect(providerInput?.readAuthorityFingerprint).toBe(
            computeReadAuthorityFingerprint(selectedProvider, readTarget, [root()], [], [RESERVATION]),
        );
        expect(result.value.candidates[0]).toEqual(
            expect.objectContaining({
                adapterId: ADAPTER,
                candidateId: expect.stringMatching(/^sha256:/),
            }),
        );
        expect(result.value.candidates[0]?.candidateId).not.toBe("provider-candidate");
        expect(result.value.sourceParseReports[0]?.readEntryDispositions[0]).toEqual(
            expect.objectContaining({
                candidateIds: [result.value.candidates[0]?.candidateId],
            }),
        );
        expect(result.value.sourceReports).toEqual([{ sourceRootId: "root-1", status: "scanned", diagnostics: [] }]);
        expect(validateAdapterReadResultSnapshot(result.value)).toEqual([]);
    });

    it("accepts derived canonical files only when a separate native graph matches observed bytes", async () => {
        const rawSource = "---\nname: source\n---\n# Canonical body\n";
        fs.writeFileSync(sourceFile, rawSource);
        const selectedProvider = provider(async (input) => {
            const result = await validRead()(input);
            const candidate = result.candidates[0];
            const file = candidate?.files[0];
            if (candidate === undefined || file?.contentKind !== "text") {
                throw new Error("expected text candidate");
            }
            file.text = "# Canonical body\n";
            candidate.nativeRepresentation = {
                representationSource: "separate_files",
                dialectId: "mock-guidance-v1",
                files: [
                    {
                        relativePath: "GUIDANCE.md",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        bytes: Buffer.from(rawSource),
                        executable: false,
                    },
                ],
            };
            return result;
        });

        const result = await executeAdapterReadWithAuthority(selectedProvider, target(), authority());
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(validateAdapterReadResultSnapshot(result.value)).toEqual([]);
        expect(result.value.candidates[0]?.files[0]).toEqual(expect.objectContaining({ text: "# Canonical body\n" }));
    });

    it("matches executable native bytes without treating a folder origin as a source file", async () => {
        const directory = path.join(sandbox, "native-folder");
        const nativeFile = path.join(directory, "source.md");
        const nativeBytes = Buffer.from("---\nname: source\n---\n# Native\n");
        fs.mkdirSync(directory);
        fs.writeFileSync(nativeFile, nativeBytes, { mode: 0o755 });
        const selectedProvider = provider(async (input) => {
            const obligation = input.sourceReadObligations[0];
            if (obligation === undefined) throw new Error("missing obligation");
            const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
            if (resolved.state !== "succeeded") throw new Error("root did not resolve");
            const listed = await input.readAccess.listDirectory(resolved.value.readEntryHandleId);
            if (listed.state !== "succeeded") throw new Error("root did not list");
            const child = listed.value.children.find((item) => item.entryKind === "file");
            if (child === undefined) throw new Error("missing source file");
            const read = await input.readAccess.readFile(child.readEntryHandleId);
            if (read.state !== "succeeded") throw new Error("source file did not read");
            const candidateId = "folder-candidate";
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
                                text: "# Derived\n",
                                executable: false,
                            },
                        ],
                        nativeRepresentation: {
                            representationSource: "separate_files",
                            dialectId: "mock-guidance-v1",
                            files: [
                                {
                                    relativePath: "source.md",
                                    contentKind: "text",
                                    mediaType: "text/markdown",
                                    bytes: nativeBytes,
                                    executable: true,
                                },
                            ],
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
                        sourceContainerEntryIds: [listed.value.directory.observedReadEntryId],
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
                                value: "source.md",
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
                        observedReadEntryIds: [
                            listed.value.directory.observedReadEntryId,
                            read.value.entry.observedReadEntryId,
                        ].sort(),
                        readEntryDispositions: [
                            {
                                readEntryDispositionId: "directory-disposition",
                                sourceReadObligationId: obligation.sourceReadObligationId,
                                readEntryHandleId: resolved.value.readEntryHandleId,
                                disposition: "traversed",
                                listDirectoryOutcomeId: listed.readAccessOutcomeId,
                                observedDirectoryEntryId: listed.value.directory.observedReadEntryId,
                                candidateIds: [candidateId],
                            },
                            {
                                readEntryDispositionId: "file-disposition",
                                sourceReadObligationId: obligation.sourceReadObligationId,
                                readEntryHandleId: child.readEntryHandleId,
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
        });
        const guidance = selectedProvider.assetSourceCapabilities.find((row) => row.assetKind === "Guidance");
        if (guidance === undefined) throw new Error("fixture missing Guidance row");
        guidance.sourcePathMechanism = "directory_entry";
        guidance.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(selectedProvider, guidance) as string;

        const result = await executeAdapterReadWithAuthority(selectedProvider, target([root("root-1", directory)]), authority());
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(validateAdapterReadResultSnapshot(result.value)).toEqual([]);
    });

    it("re-canonicalizes disposition candidate ids after Core authority stamping", async () => {
        const selectedProvider = provider(async (input) => {
            const result = await validRead()(input);
            const base = result.candidates[0];
            const disposition = result.sourceParseReports[0]?.readEntryDispositions[0];
            if (base === undefined || disposition?.disposition === "ignored") {
                throw new Error("expected candidate disposition");
            }
            let providerIds: [string, string] | undefined;
            for (let index = 0; index < 64 && providerIds === undefined; index += 1) {
                const left = `candidate-${String(index).padStart(2, "0")}`;
                const right = `candidate-${String(index + 1).padStart(2, "0")}`;
                const leftStamped = fingerprintDomain("oaam.read.candidate-id.v1", {
                    adapterId: ADAPTER,
                    readAuthorityFingerprint: input.readAuthorityFingerprint,
                    providerCandidateId: left,
                    index: 0,
                });
                const rightStamped = fingerprintDomain("oaam.read.candidate-id.v1", {
                    adapterId: ADAPTER,
                    readAuthorityFingerprint: input.readAuthorityFingerprint,
                    providerCandidateId: right,
                    index: 1,
                });
                if (leftStamped > rightStamped) providerIds = [left, right];
            }
            if (providerIds === undefined) throw new Error("could not build reverse-order fixture");
            result.candidates = providerIds.map((candidateId) => ({ ...base, candidateId }));
            disposition.candidateIds = [...providerIds];
            return result;
        });

        const result = await executeAdapterReadWithAuthority(selectedProvider, target(), authority());
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        const disposition = result.value.sourceParseReports[0]?.readEntryDispositions[0];
        if (disposition?.disposition === "ignored") throw new Error("expected disposition");
        expect(disposition?.candidateIds).toEqual([...(disposition?.candidateIds ?? [])].sort());
    });

    it("rejects invented or duplicate separate native files", async () => {
        async function readWithNativeFiles(
            files: Array<{
                relativePath: string;
                bytes: Uint8Array;
                executable: boolean;
            }>,
            useForeignCanonicalOrigin = false,
        ) {
            const selectedProvider = provider(async (input) => {
                const result = await validRead()(input);
                const candidate = result.candidates[0];
                if (candidate === undefined) throw new Error("expected candidate");
                candidate.nativeRepresentation = {
                    representationSource: "separate_files",
                    dialectId: "mock-guidance-v1",
                    files: files.map((file) => ({
                        ...file,
                        contentKind: "text" as const,
                        mediaType: "text/markdown",
                    })),
                };
                if (useForeignCanonicalOrigin) {
                    candidate.sourceFileOrigins[0]!.observedReadEntryIds = ["foreign-entry"];
                }
                return result;
            });
            return executeAdapterReadWithAuthority(selectedProvider, target(), authority());
        }

        const invented = await readWithNativeFiles([
            {
                relativePath: "GUIDANCE.md",
                bytes: Buffer.from("invented native bytes"),
                executable: false,
            },
        ]);
        expect(invented.status).toBe("failed");
        expect(invented.diagnostics.some((item) => item.code === "read.candidate_native_origin_invalid")).toBe(true);

        const foreignCanonicalOrigin = await readWithNativeFiles(
            [
                {
                    relativePath: "GUIDANCE.md",
                    bytes: Buffer.from("# Guidance\n"),
                    executable: false,
                },
            ],
            true,
        );
        expect(foreignCanonicalOrigin.status).toBe("failed");
        expect(
            foreignCanonicalOrigin.diagnostics.some(
                (item) =>
                    item.code === "read.candidate_file_origin_invalid" &&
                    item.message.includes("outside the observed source closure"),
            ),
        ).toBe(true);

        const duplicate = await readWithNativeFiles([
            {
                relativePath: "GUIDANCE.md",
                bytes: Buffer.from("# Guidance\n"),
                executable: false,
            },
            {
                relativePath: "COPY.md",
                bytes: Buffer.from("# Guidance\n"),
                executable: false,
            },
        ]);
        expect(duplicate.status).toBe("failed");
        expect(duplicate.diagnostics.some((item) => item.code === "read.candidate_native_origin_invalid")).toBe(true);
        expect(
            validateAdapterReadResultSnapshot(duplicate.value).filter(
                (item) => item.code === "read.candidate_native_origin_invalid",
            ),
        ).toHaveLength(1);
    });

    it("rejects an empty parse report that made zero port calls", async () => {
        const emptyProvider = provider(async (input) => ({
            candidates: [],
            sourceParseReports: [
                {
                    sourceRootId: "root-1",
                    sourceReadObligationIds: input.sourceReadObligations.map((item) => item.sourceReadObligationId),
                    status: "empty",
                    observedReadEntryIds: [],
                    readEntryDispositions: [],
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        }));
        const result = await executeAdapterReadWithAuthority(emptyProvider, target(), authority());
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "read.obligation_root_unresolved")).toBe(true);
        expect(result.value.sourceReports[0]?.status).toBe("blocked");
    });

    it("rejects a fixed-file root that was resolved but never read", async () => {
        const unreadProvider = provider(async (input) => {
            const obligation = input.sourceReadObligations[0]!;
            const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
            if (resolved.state !== "succeeded") throw new Error("resolve failed");
            return {
                candidates: [],
                sourceParseReports: [
                    {
                        sourceRootId: "root-1",
                        sourceReadObligationIds: [obligation.sourceReadObligationId],
                        status: "empty",
                        observedReadEntryIds: [],
                        readEntryDispositions: [
                            {
                                readEntryDispositionId: "ignored",
                                sourceReadObligationId: obligation.sourceReadObligationId,
                                readEntryHandleId: resolved.value.readEntryHandleId,
                                disposition: "ignored",
                                reasonCode: "not_applicable",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                diagnostics: [],
            };
        });
        const result = await executeAdapterReadWithAuthority(unreadProvider, target(), authority());
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "read.obligation_root_unconsumed")).toBe(true);
    });

    it("rejects silent root-report drops and provider throws", async () => {
        const missingReport = provider(async () => ({
            candidates: [],
            sourceParseReports: [],
            diagnostics: [],
        }));
        expect(
            (await executeAdapterReadWithAuthority(missingReport, target(), authority())).diagnostics.some(
                (item) => item.code === "read.parse_report_root_mismatch",
            ),
        ).toBe(true);

        const throwing = provider(async () => {
            throw new Error("parser exploded");
        });
        const thrown = await executeAdapterReadWithAuthority(throwing, target(), authority());
        expect(thrown.status).toBe("failed");
        expect(thrown.diagnostics[0]?.code).toBe("read.provider_threw");
    });

    it("rejects managed roots before provider parsing", async () => {
        let calls = 0;
        const guardedProvider = provider(async (input) => {
            calls += 1;
            const obligation = input.sourceReadObligations[0]!;
            await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
            return {
                candidates: [],
                sourceParseReports: [
                    {
                        sourceRootId: obligation.sourceRootId,
                        sourceReadObligationIds: [obligation.sourceReadObligationId],
                        status: "empty",
                        observedReadEntryIds: [],
                        readEntryDispositions: [],
                        diagnostics: [],
                    },
                ],
                diagnostics: [],
            };
        });
        const result = await executeAdapterReadWithAuthority(
            guardedProvider,
            target(),
            authority({
                managedTargetGuards: [
                    {
                        sourceRootId: "root-1",
                        matchKind: "entire_root",
                        managementState: "active_managed",
                        deploymentId: DEPLOYMENT_ID,
                        outputUnitFingerprint: RESERVATION,
                    },
                ],
            }),
        );
        expect(calls).toBe(1);
        expect(result.status).toBe("failed");
        expect(result.value.readAccessOutcomes[0]?.status).toBe("blocked_managed_target");
    });

    it("detects symlink replacement instead of following a recursive child", async () => {
        const directory = path.join(sandbox, "source-dir");
        const outside = path.join(sandbox, "outside.md");
        fs.mkdirSync(directory);
        fs.writeFileSync(outside, "secret");
        fs.symlinkSync(outside, path.join(directory, "linked.md"));
        const selectedProvider = provider(async (input) => {
            const obligation = input.sourceReadObligations[0]!;
            const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
            if (resolved.state === "succeeded") {
                await input.readAccess.listDirectory(resolved.value.readEntryHandleId);
            }
            return {
                candidates: [],
                sourceParseReports: [
                    {
                        sourceRootId: obligation.sourceRootId,
                        sourceReadObligationIds: [obligation.sourceReadObligationId],
                        status: "empty",
                        observedReadEntryIds: [],
                        readEntryDispositions:
                            resolved.state === "succeeded"
                                ? [
                                      {
                                          readEntryDispositionId: "ignored-root",
                                          sourceReadObligationId: obligation.sourceReadObligationId,
                                          readEntryHandleId: resolved.value.readEntryHandleId,
                                          disposition: "ignored",
                                          reasonCode: "unsafe_child",
                                      },
                                  ]
                                : [],
                        diagnostics: [],
                    },
                ],
                diagnostics: [],
            };
        });
        const guidance = selectedProvider.assetSourceCapabilities.find((row) => row.assetKind === "Guidance")!;
        guidance.sourcePathMechanism = "recursive_entry";
        guidance.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(selectedProvider, guidance) as string;
        const result = await executeAdapterReadWithAuthority(selectedProvider, target([root("root-1", directory)]), authority());
        expect(result.status).toBe("failed");
        expect(result.value.readAccessOutcomes.some((item) => item.status === "blocked_symlink_or_reparse")).toBe(true);
    });
});
