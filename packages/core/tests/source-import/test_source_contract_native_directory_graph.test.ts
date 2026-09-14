import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateCandidateFileGraph, validateCandidateOrigins } from "../../src/source-import/source-read-candidate-validator";
import type { AdapterExtractedAssetCandidate, ObservedReadEntry, ReadEntryHandle } from "../../src/types";
import { sourceFile, successfulRead } from "./fixtures/source-contract-test-fixtures";

describe("source contract native directory graph", () => {
    it("validates a complete observed graph and rejects every malformed graph or origin class", async () => {
        const readResult = await successfulRead();
        const extracted = structuredClone(readResult.candidates[0]!);
        const { adapterId: _adapterId, ...candidateBase } = extracted;
        const candidate = candidateBase as AdapterExtractedAssetCandidate;
        const disposition = structuredClone(readResult.sourceParseReports[0]!.readEntryDispositions[0]!);
        if (disposition.disposition !== "parsed") throw new Error("directory graph fixture disposition is missing");
        const fileEntry = readResult.observedReadEntries.find((item) => item.entryKind === "file");
        if (fileEntry?.entryKind !== "file") throw new Error("directory graph fixture file is missing");
        const nativeBytes = fs.readFileSync(sourceFile);
        const directoryEntries: ObservedReadEntry[] = ["bundle", "bundle/empty"].map((relativePath, index) => ({
            observedReadEntryId: `directory-${index}`,
            sourceRootId: fileEntry.sourceRootId,
            relativePath,
            entryKind: "directory",
            physicalIdentityFingerprint: fileEntry.physicalIdentityFingerprint,
            directoryInventoryFingerprint: fileEntry.physicalIdentityFingerprint,
        }));
        candidate.nativeRepresentation = {
            representationSource: "separate_file_graph",
            dialectId: "fixture-directory-graph-v2",
            directories: directoryEntries.map((entry) => ({
                relativePath: entry.relativePath,
                observedReadEntryIds: [entry.observedReadEntryId],
            })),
            files: [
                {
                    relativePath: "bundle/native.md",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    bytes: nativeBytes,
                    executable: fileEntry.executable,
                },
            ],
        };
        candidate.sourceContainerEntryIds = directoryEntries.map((entry) => entry.observedReadEntryId);
        disposition.observedReadEntryIds = [...disposition.observedReadEntryIds, ...candidate.sourceContainerEntryIds].sort();
        const entries = new Map(
            [...readResult.observedReadEntries, ...directoryEntries].map((entry) => [entry.observedReadEntryId, entry]),
        );
        const handle: ReadEntryHandle = {
            readEntryHandleId: disposition.readEntryHandleId,
            sourceReadObligationId: disposition.sourceReadObligationId,
            sourceRootId: fileEntry.sourceRootId,
            relativePath: fileEntry.relativePath,
            entryKind: "file",
        };
        const origins = (
            value: AdapterExtractedAssetCandidate,
            candidateDisposition = disposition,
            candidateEntries: ReadonlyMap<string, ObservedReadEntry> = entries,
        ) => {
            const diagnostics = [];
            validateCandidateOrigins(
                value,
                [candidateDisposition],
                new Map([[handle.readEntryHandleId, handle]]),
                new Map(readResult.readAccessOutcomes.map((item) => [item.readAccessOutcomeId, item])),
                candidateEntries,
                null,
                [],
                diagnostics,
            );
            return diagnostics;
        };
        const graphDiagnostics = [];
        validateCandidateFileGraph(candidate, graphDiagnostics);
        expect(graphDiagnostics).toEqual([]);
        expect(origins(candidate).filter((item) => item.code.includes("native_directory"))).toEqual([]);

        const rootCandidate = structuredClone(candidate);
        if (rootCandidate.nativeRepresentation.representationSource !== "separate_file_graph")
            throw new Error("Root graph is missing");
        rootCandidate.nativeRepresentation.files[0]!.relativePath = "native.md";
        const rootEntry: ObservedReadEntry = { ...directoryEntries[0]!, observedReadEntryId: "root-container", relativePath: "" };
        rootCandidate.sourceContainerEntryIds = [...rootCandidate.sourceContainerEntryIds, rootEntry.observedReadEntryId].sort();
        const rootDisposition = {
            ...disposition,
            observedReadEntryIds: [...disposition.observedReadEntryIds, rootEntry.observedReadEntryId].sort(),
        };
        const rootEntries = new Map([...entries, [rootEntry.observedReadEntryId, rootEntry] as const]);
        const rootGraphDiagnostics = [];
        validateCandidateFileGraph(rootCandidate, rootGraphDiagnostics);
        expect(rootGraphDiagnostics).toEqual([]);
        expect(origins(rootCandidate, rootDisposition, rootEntries)).toEqual([]);
        expect(origins(rootCandidate, disposition, rootEntries).map((item) => item.code)).toContain(
            "read.candidate_container_origin_invalid",
        );
        rootCandidate.nativeRepresentation.directories[0]!.relativePath = "missing/parent/child";
        rootCandidate.nativeRepresentation.directories = [rootCandidate.nativeRepresentation.directories[0]!];
        const missingParentDiagnostics = [];
        validateCandidateFileGraph(rootCandidate, missingParentDiagnostics);
        expect(missingParentDiagnostics.map((item) => item.code)).toContain("read.candidate_native_directory_graph_invalid");

        const graphCases: Array<(value: typeof candidate) => void> = [
            (value) => {
                if (value.nativeRepresentation.representationSource === "separate_file_graph") {
                    value.nativeRepresentation.directories = [];
                }
            },
            (value) => {
                if (value.nativeRepresentation.representationSource === "separate_file_graph") {
                    value.nativeRepresentation.directories[0]!.relativePath = "../unsafe";
                }
            },
            (value) => {
                if (value.nativeRepresentation.representationSource === "separate_file_graph") {
                    value.nativeRepresentation.directories.reverse();
                }
            },
            (value) => {
                if (value.nativeRepresentation.representationSource === "separate_file_graph") {
                    value.nativeRepresentation.directories[1]!.observedReadEntryIds = ["directory-0"];
                }
            },
            (value) => {
                if (value.nativeRepresentation.representationSource === "separate_file_graph") {
                    value.nativeRepresentation.directories[0]!.observedReadEntryIds = [];
                }
            },
            (value) => {
                if (value.nativeRepresentation.representationSource === "separate_file_graph") {
                    value.nativeRepresentation.directories[0]!.observedReadEntryIds = ["z", "a"];
                }
            },
            (value) => {
                if (value.nativeRepresentation.representationSource === "separate_file_graph") {
                    value.nativeRepresentation.directories.push({
                        relativePath: "bundle/native.md",
                        observedReadEntryIds: ["directory-file-collision"],
                    });
                }
            },
            (value) => {
                if (value.nativeRepresentation.representationSource === "separate_file_graph") {
                    value.nativeRepresentation.directories = [
                        value.nativeRepresentation.directories[0]!,
                        { relativePath: "bundle/missing/leaf", observedReadEntryIds: ["directory-missing"] },
                    ];
                }
            },
        ];
        for (const mutate of graphCases) {
            const copy = structuredClone(candidate);
            mutate(copy);
            const diagnostics = [];
            validateCandidateFileGraph(copy, diagnostics);
            expect(diagnostics.map((item) => item.code)).toContain("read.candidate_native_directory_graph_invalid");
        }

        const wrongKind = structuredClone(candidate);
        if (wrongKind.nativeRepresentation.representationSource !== "separate_file_graph") throw new Error("missing graph");
        wrongKind.nativeRepresentation.directories[0]!.observedReadEntryIds = [fileEntry.observedReadEntryId];
        expect(origins(wrongKind).map((item) => item.code)).toContain("read.candidate_native_directory_origin_invalid");

        const disallowed = structuredClone(disposition);
        disallowed.observedReadEntryIds = disallowed.observedReadEntryIds.filter((id) => id !== "directory-0");
        expect(origins(candidate, disallowed).map((item) => item.code)).toContain(
            "read.candidate_native_directory_origin_invalid",
        );

        const mismatch = structuredClone(candidate);
        mismatch.sourceContainerEntryIds = ["directory-0"];
        expect(origins(mismatch).map((item) => item.code)).toContain("read.candidate_native_directory_origin_mismatch");
    });
});
