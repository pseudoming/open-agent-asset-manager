import { withReadBatch } from "../adapters/fixtures/adapter-read-filesystem";
/** Authority-focused split from the original oversized test suite. */

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    computeReadAuthorityFingerprint,
    computeReadSnapshotFingerprint,
    executeAdapterReadWithAuthority,
    executeAdapterReadWithAuthorityForTest,
    validateAdapterReadResultSnapshot,
} from "../../src/source-import/source-contract-validator";
import { createAdapterReadOperationForTest } from "../../src/adapters/adapter-read-access";
import { computeSourceCapabilityFingerprint } from "../../src/adapters/adapter-contract-validator";
import type { AdapterId, AdapterReadResult, AdapterReadTarget, SourceRoot } from "../../src/types";
import {
    ADAPTER,
    RESERVATION,
    DEPLOYMENT_ID,
    root,
    provider,
    target,
    authority,
    validRead,
    successfulRead,
    successfulDirectoryRead,
} from "./fixtures/source-contract-test-fixtures";

describe("source contract snapshot and authority revalidation", () => {
    it.each([
        { name: "empty", ids: [] },
        { name: "duplicate", ids: [ADAPTER + "_CLI", ADAPTER + "_CLI"] },
        { name: "foreign", ids: ["FOREIGN_CLI"] },
        { name: "non-string", ids: [0] },
        { name: "non-array", ids: ADAPTER + "_CLI" },
    ])("rejects a $name runtime selection before Provider I/O", async ({ ids }) => {
        const read = vi.fn(validRead());
        const selectedProvider = provider(read);
        const selectedTarget = { ...target(), agentRuntimeIds: ids as string[] };
        const result = await executeAdapterReadWithAuthority(selectedProvider, selectedTarget, authority());
        expect(result.status).toBe("failed");
        expect(result.diagnostics.map((item) => item.code)).toContain("read.agent_runtime_selection_invalid");
        expect(read).not.toHaveBeenCalled();
    });

    it("rejects a declared entry that did not own any selected observed root before I/O", async () => {
        const read = vi.fn(validRead());
        const selectedProvider = provider(read),
            selectedTarget = target();
        selectedTarget.agentRuntimeIds = [ADAPTER + "_CLI"];
        if (selectedTarget.sourceSelector.selectorKind !== "probe_roots") throw new Error("Expected observed roots");
        selectedTarget.sourceSelector.observation.observedAgentRuntimes[0]!.sourceRootIds = [];
        const result = await executeAdapterReadWithAuthority(selectedProvider, selectedTarget, authority());
        expect(result.status).toBe("failed");
        expect(result.diagnostics.map((item) => item.code)).toContain("read.agent_runtime_selection_invalid");
        expect(read).not.toHaveBeenCalled();
    });
    it("rechecks durable authority under the physical lock before the filesystem port sees bytes", async () => {
        let filesystemCalls = 0;
        const selectedProvider = provider(async (input) => {
            const obligation = input.sourceReadObligations[0]!;
            const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
            expect(resolved).toEqual(
                expect.objectContaining({
                    state: "failed",
                    failureStatus: "stale",
                }),
            );
            return {
                candidates: [],
                sourceParseReports: [
                    {
                        sourceRootId: obligation.sourceRootId,
                        sourceReadObligationIds: [obligation.sourceReadObligationId],
                        status: "failed",
                        observedReadEntryIds: [],
                        readEntryDispositions: [],
                        diagnostics: [],
                    },
                ],
                diagnostics: [],
            };
        });
        const result = await executeAdapterReadWithAuthorityForTest(
            selectedProvider,
            target(),
            authority(),
            (operationInput, revalidateAuthority) =>
                createAdapterReadOperationForTest(
                    operationInput,
                    withReadBatch({
                        readRegularFileNoFollow: () => {
                            filesystemCalls += 1;
                            return {
                                bytes: Buffer.from("must-not-leak"),
                                executable: false,
                                identity: { deviceId: "1", fileId: "1", entryKind: "file" },
                            };
                        },
                        inventoryDirectoryNoFollow: () => {
                            filesystemCalls += 1;
                            throw new Error("directory port must not run");
                        },
                    }),
                    () => ({ release() {} }),
                    revalidateAuthority,
                ),
            () => false,
        );
        expect(result.status).toBe("failed");
        expect(filesystemCalls).toBe(0);
    });

    it("rechecks managed provenance even when a faulting read port leaks guarded bytes", async () => {
        const selectedProvider = provider(validRead());
        const result = await executeAdapterReadWithAuthorityForTest(
            selectedProvider,
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
            (operationInput) =>
                createAdapterReadOperationForTest(
                    { ...operationInput, managedTargetGuards: [] },
                    withReadBatch({
                        readRegularFileNoFollow: () => ({
                            bytes: Buffer.from("# Guidance\n"),
                            executable: false,
                            identity: { deviceId: "1", fileId: "1", entryKind: "file" },
                        }),
                        inventoryDirectoryNoFollow: () => {
                            throw new Error("directory port not expected");
                        },
                    }),
                    () => ({ release() {} }),
                ),
        );
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "read.candidate_managed_origin")).toBe(true);
    });

    it("rejects a directory origin outside the candidate disposition closure", async () => {
        const selectedProvider = provider(async (input) => {
            const result = await validRead()(input);
            result.candidates[0]!.sourceContainerEntryIds = ["extra-directory"];
            return result;
        });
        const result = await executeAdapterReadWithAuthorityForTest(selectedProvider, target(), authority(), (operationInput) => {
            const operation = createAdapterReadOperationForTest(
                operationInput,
                withReadBatch({
                    readRegularFileNoFollow: () => ({
                        bytes: Buffer.from("# Guidance\n"),
                        executable: false,
                        identity: { deviceId: "1", fileId: "1", entryKind: "file" },
                    }),
                    inventoryDirectoryNoFollow: () => {
                        throw new Error("directory port not expected");
                    },
                }),
                () => ({ release() {} }),
            );
            return {
                ...operation,
                snapshot: () => ({
                    ...operation.snapshot(),
                    entries: [
                        ...operation.snapshot().entries,
                        {
                            observedReadEntryId: "extra-directory",
                            sourceRootId: "root-1",
                            relativePath: "extra",
                            entryKind: "directory",
                            physicalIdentityFingerprint: RESERVATION,
                            directoryInventoryFingerprint: RESERVATION,
                        },
                    ],
                }),
            };
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "read.candidate_container_origin_invalid")).toBe(true);
    });

    it("requires exact user-selected scope binding and user-selected capability policy", async () => {
        const selectedProvider = provider(validRead());
        const guidance = selectedProvider.assetSourceCapabilities.find((row) => row.assetKind === "Guidance")!;
        guidance.sourceDomain = "external_managed";
        guidance.rootLocatorKind = "user_provided_path";
        guidance.readPolicy = "user_selected_root_only";
        guidance.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(selectedProvider, guidance) as string;
        const selectedRoot: SourceRoot = {
            ...root(),
            sourceDomain: "external_managed",
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "picker",
                    evidenceLevel: "user_provided",
                },
            ],
        };
        const selectedTarget: AdapterReadTarget = {
            adapterId: ADAPTER,
            allowedKinds: ["Guidance"],
            agentRuntimeIds: [ADAPTER + "_CLI"],
            sourceSelector: {
                selectorKind: "user_selected_root",
                platformContext: {
                    platform: "linux",
                    platformInstanceId: "local",
                    accessRootPath: "/",
                },
                binding: {
                    sourceRoot: selectedRoot,
                    assetScope: "global",
                    projectRootPath: "",
                },
            },
        };
        const selected = await executeAdapterReadWithAuthority(selectedProvider, selectedTarget, authority());
        expect(selected.status).toBe("complete");
        expect(selected.value?.readTarget).toEqual(selectedTarget);
        expect(selected.value?.candidates).toHaveLength(1);
        selectedTarget.sourceSelector.binding.projectRootPath = "/unexpected";
        expect((await executeAdapterReadWithAuthority(selectedProvider, selectedTarget, authority())).status).toBe("failed");
    });

    it("rejects tampering of the complete Core-owned snapshot", async () => {
        const readResult = await successfulRead();
        const alteredEntry = structuredClone(readResult);
        const entry = alteredEntry.observedReadEntries[0];
        if (entry?.entryKind !== "file") throw new Error("expected file entry");
        entry.contentHash = `sha256:${"0".repeat(64)}`;
        expect(
            validateAdapterReadResultSnapshot(alteredEntry).some((item) => item.code === "read.snapshot_fingerprint_mismatch"),
        ).toBe(true);

        const alteredCandidate = structuredClone(readResult);
        const candidateFile = alteredCandidate.candidates[0]?.files[0];
        if (candidateFile?.contentKind !== "text") throw new Error("expected text candidate file");
        candidateFile.text = "tampered candidate bytes";
        expect(
            validateAdapterReadResultSnapshot(alteredCandidate).some(
                (item) => item.code === "read.candidate_file_origin_invalid",
            ),
        ).toBe(true);

        const duplicateOutcome = structuredClone(readResult);
        duplicateOutcome.readAccessOutcomes.push(duplicateOutcome.readAccessOutcomes[0]!);
        expect(validateAdapterReadResultSnapshot(duplicateOutcome).some((item) => item.code === "read.outcome_duplicate")).toBe(
            true,
        );

        const duplicateDispositionCandidate = structuredClone(readResult);
        const disposition = duplicateDispositionCandidate.sourceParseReports[0]?.readEntryDispositions[0];
        if (disposition?.disposition === "ignored") throw new Error("expected candidate disposition");
        const candidateId = disposition?.candidateIds[0];
        if (candidateId === undefined) throw new Error("expected candidate id");
        disposition.candidateIds = [candidateId, candidateId];
        expect(
            validateAdapterReadResultSnapshot(duplicateDispositionCandidate).some(
                (item) => item.code === "read.disposition_candidates_not_canonical",
            ),
        ).toBe(true);

        const reseal = (value: AdapterReadResult): void => {
            value.readSnapshotFingerprint = computeReadSnapshotFingerprint(
                value.readTarget,
                value.readAuthorityFingerprint,
                value.sourceReadObligations,
                value.observedReadEntries,
                value.externalAttestationReceipts.map((receipt) => receipt.attestationReceiptFingerprint),
                value.sourceParseReports,
            );
        };
        const alteredTargetRoot = structuredClone(readResult);
        if (alteredTargetRoot.readTarget.sourceSelector.selectorKind !== "probe_roots") {
            throw new Error("expected probe target");
        }
        alteredTargetRoot.readTarget.sourceSelector.sourceRootIds = [];
        reseal(alteredTargetRoot);
        expect(
            validateAdapterReadResultSnapshot(alteredTargetRoot).some((item) => item.code === "read.target_root_mismatch"),
        ).toBe(true);

        const alteredTargetKind = structuredClone(readResult);
        alteredTargetKind.readTarget.allowedKinds = ["Rule"];
        reseal(alteredTargetKind);
        expect(
            validateAdapterReadResultSnapshot(alteredTargetKind).some((item) => item.code === "read.target_candidate_mismatch"),
        ).toBe(true);

        const alteredTargetAdapter = structuredClone(readResult);
        if (alteredTargetAdapter.readTarget.sourceSelector.selectorKind !== "probe_roots") {
            throw new Error("expected probe target");
        }
        alteredTargetAdapter.readTarget.sourceSelector.observation.adapterId = "FOREIGN" as AdapterId;
        reseal(alteredTargetAdapter);
        expect(
            validateAdapterReadResultSnapshot(alteredTargetAdapter).some((item) => item.code === "read.target_adapter_mismatch"),
        ).toBe(true);

        const alteredUserBinding = structuredClone(readResult);
        alteredUserBinding.readTarget.sourceSelector = {
            selectorKind: "user_selected_root",
            platformContext: {
                platform: "linux",
                platformInstanceId: "local",
                accessRootPath: "/",
            },
            binding: {
                sourceRoot: { ...root(), sourceRootId: "different-root" },
                assetScope: "global",
                projectRootPath: "",
            },
        };
        reseal(alteredUserBinding);
        expect(
            validateAdapterReadResultSnapshot(alteredUserBinding).some((item) => item.code === "read.target_root_mismatch"),
        ).toBe(true);
    });

    it("rejects impossible operation traces and traversal bindings in a saved snapshot", async () => {
        const fileSnapshot = await successfulRead();
        const fileCases: Array<[string, (value: AdapterReadResult) => void]> = [
            [
                "read.resolve_outcome_cardinality_invalid",
                (value) => {
                    const outcome = value.readAccessOutcomes.find((item) => item.operation === "resolve_root");
                    if (outcome?.operation !== "resolve_root") throw new Error("expected resolve outcome");
                    outcome.producedReadEntryHandleIds = [];
                },
            ],
            [
                "read.outcome_entry_cardinality_invalid",
                (value) => {
                    const outcome = value.readAccessOutcomes.find((item) => item.operation === "read_file");
                    if (outcome?.operation !== "read_file") throw new Error("expected read outcome");
                    outcome.observedReadEntryIds = [];
                },
            ],
        ];
        for (const [expectedCode, mutate] of fileCases) {
            const altered = structuredClone(fileSnapshot);
            mutate(altered);
            expect(
                validateAdapterReadResultSnapshot(altered).some((item) => item.code === expectedCode),
                expectedCode,
            ).toBe(true);
        }

        const directorySnapshot = await successfulDirectoryRead();
        const failedList = structuredClone(directorySnapshot);
        const failedListOutcome = failedList.readAccessOutcomes.find((item) => item.operation === "list_directory");
        if (failedListOutcome?.operation !== "list_directory") throw new Error("expected list outcome");
        failedListOutcome.status = "io_error";
        failedListOutcome.producedReadEntryHandleIds = ["impossible-child-handle"];
        expect(
            validateAdapterReadResultSnapshot(failedList).some((item) => item.code === "read.failed_list_produced_handle"),
        ).toBe(true);

        const invalidTraversal = structuredClone(directorySnapshot);
        const traversalOutcome = invalidTraversal.readAccessOutcomes.find((item) => item.operation === "list_directory");
        if (traversalOutcome?.operation !== "list_directory") throw new Error("expected list outcome");
        traversalOutcome.status = "io_error";
        expect(
            validateAdapterReadResultSnapshot(invalidTraversal).some((item) => item.code === "read.traversed_outcome_invalid"),
        ).toBe(true);
    });

    it("validates every top-level snapshot reference and terminal status", async () => {
        const base = await successfulRead();
        const cases: Array<[string, (value: AdapterReadResult) => void]> = [
            [
                "read.root_duplicate",
                (value) => {
                    value.sourceRoots.push(value.sourceRoots[0]!);
                },
            ],
            [
                "read.obligation_duplicate",
                (value) => {
                    value.sourceReadObligations.push(value.sourceReadObligations[0]!);
                },
            ],
            [
                "read.obligation_root_missing",
                (value) => {
                    value.sourceReadObligations[0]!.sourceRootId = "foreign";
                },
            ],
            [
                "read.outcome_authority_missing",
                (value) => {
                    value.readAccessOutcomes[0]!.sourceReadObligationId = "foreign";
                },
            ],
            [
                "read.outcome_entry_missing",
                (value) => {
                    value.readAccessOutcomes.find((item) => item.operation === "read_file")!.observedReadEntryIds = ["foreign"];
                },
            ],
            [
                "read.entry_root_missing",
                (value) => {
                    value.observedReadEntries[0]!.sourceRootId = "foreign";
                },
            ],
            [
                "read.candidate_duplicate",
                (value) => {
                    value.candidates.push(value.candidates[0]!);
                },
            ],
            [
                "read.parse_report_duplicate",
                (value) => {
                    value.sourceParseReports.push(value.sourceParseReports[0]!);
                },
            ],
            [
                "read.source_report_duplicate",
                (value) => {
                    value.sourceReports.push(value.sourceReports[0]!);
                },
            ],
            [
                "read.report_root_mismatch",
                (value) => {
                    value.sourceReports = [];
                },
            ],
            [
                "read.status_mismatch",
                (value) => {
                    value.status = "partial";
                },
            ],
        ];
        for (const [expectedCode, mutate] of cases) {
            const altered = structuredClone(base);
            mutate(altered);
            expect(
                validateAdapterReadResultSnapshot(altered).some((item) => item.code === expectedCode),
                expectedCode,
            ).toBe(true);
        }

        const receipt = {
            externalAttestationReceiptId: "receipt-1",
            verifier: {
                componentId: "verifier",
                componentVersion: "1",
                configFingerprint: RESERVATION,
            },
            subject: {
                subjectKind: "agent_runtime" as const,
                agentRuntimeId: `${ADAPTER}_CLI`,
            },
            subjectFingerprint: RESERVATION,
            verifierInputFingerprint: RESERVATION,
            attestedKind: "environment" as const,
            attestedValue: "ok",
            evidenceLevel: "agent_runtime_verified" as const,
            verifierResultFingerprint: RESERVATION,
            attestationReceiptFingerprint: RESERVATION,
        };
        const duplicateReceipt = structuredClone(base);
        duplicateReceipt.externalAttestationReceipts = [receipt, receipt];
        expect(validateAdapterReadResultSnapshot(duplicateReceipt).some((item) => item.code === "read.receipt_duplicate")).toBe(
            true,
        );
    });

    it("canonicalizes authority and stable-closure fingerprints independent of input order", async () => {
        const selectedProvider = provider(validRead());
        const root1 = root("root-a");
        const root2 = root("root-b");
        const exactGuard = {
            sourceRootId: "root-a",
            relativePath: "a.md",
            matchKind: "exact_file" as const,
            managementState: "active_managed" as const,
            deploymentId: DEPLOYMENT_ID,
            appliedContentHash: RESERVATION,
        };
        const prefixGuard = {
            sourceRootId: "root-b",
            relativePath: "dir",
            matchKind: "directory_prefix" as const,
            managementState: "residual_managed" as const,
            deploymentId: DEPLOYMENT_ID,
            outputUnitFingerprint: RESERVATION,
        };
        expect(
            computeReadAuthorityFingerprint(
                selectedProvider,
                target([root1, root2]),
                [root2, root1],
                [prefixGuard, exactGuard],
                [RESERVATION, RESERVATION],
            ),
        ).toBe(
            computeReadAuthorityFingerprint(
                selectedProvider,
                target([root1, root2]),
                [root1, root2],
                [exactGuard, prefixGuard],
                [RESERVATION, RESERVATION],
            ),
        );

        const base = await successfulRead();
        const obligation1 = base.sourceReadObligations[0]!;
        const obligation2 = {
            ...obligation1,
            sourceReadObligationId: "zz-obligation",
            sourceRootId: "root-b",
        };
        const fileEntry = base.observedReadEntries[0]!;
        const directoryEntry = {
            observedReadEntryId: "entry-directory",
            sourceRootId: fileEntry.sourceRootId,
            relativePath: fileEntry.relativePath,
            entryKind: "directory" as const,
            physicalIdentityFingerprint: RESERVATION,
            directoryInventoryFingerprint: RESERVATION,
        };
        const otherEntry = {
            ...fileEntry,
            observedReadEntryId: "entry-other",
            sourceRootId: "root-b",
        };
        const laterEntry = {
            ...fileEntry,
            observedReadEntryId: "entry-later",
            relativePath: "z.md",
        };
        const report = base.sourceParseReports[0]!;
        const disposition = report.readEntryDispositions[0]!;
        const report2 = {
            ...report,
            sourceRootId: "root-b",
            readEntryDispositions: [{ ...disposition, readEntryDispositionId: "zz-disposition" }],
        };
        const left = computeReadSnapshotFingerprint(
            base.readTarget,
            base.readAuthorityFingerprint,
            [obligation2, obligation1],
            [otherEntry, laterEntry, directoryEntry, fileEntry],
            [RESERVATION, RESERVATION],
            [report2, report],
        );
        const right = computeReadSnapshotFingerprint(
            base.readTarget,
            base.readAuthorityFingerprint,
            [obligation1, obligation2],
            [fileEntry, directoryEntry, laterEntry, otherEntry],
            [RESERVATION, RESERVATION],
            [report, report2],
        );
        expect(left).toBe(right);

        const mixedTerminal = structuredClone(base);
        mixedTerminal.sourceRoots.push(root("root-b"));
        mixedTerminal.sourceParseReports.push({
            sourceRootId: "root-b",
            sourceReadObligationIds: [],
            status: "parsed",
            observedReadEntryIds: [],
            readEntryDispositions: [],
            diagnostics: [],
        });
        mixedTerminal.sourceReports = [
            { sourceRootId: "root-1", status: "blocked", diagnostics: [] },
            { sourceRootId: "root-b", status: "scanned", diagnostics: [] },
        ];
        mixedTerminal.status = "partial";
        mixedTerminal.readSnapshotFingerprint = computeReadSnapshotFingerprint(
            mixedTerminal.readTarget,
            mixedTerminal.readAuthorityFingerprint,
            mixedTerminal.sourceReadObligations,
            mixedTerminal.observedReadEntries,
            [],
            mixedTerminal.sourceParseReports,
        );
        expect(validateAdapterReadResultSnapshot(mixedTerminal).some((item) => item.code === "read.status_mismatch")).toBe(false);
    });

    it("orders multiple eligible capability rows deterministically before provider dispatch", async () => {
        let received: string[] = [];
        const selectedProvider = provider(async (input) => {
            received = input.sourceReadObligations.map((item) => item.sourceCapabilityFingerprint);
            throw new Error("ordering observed");
        });
        const guidance = selectedProvider.assetSourceCapabilities.find((row) => row.assetKind === "Guidance")!;
        selectedProvider.assetSourceCapabilities.push({
            ...guidance,
            sourceCapabilityFingerprint: `sha256:${"0".repeat(64)}`,
        });
        const result = await executeAdapterReadWithAuthority(selectedProvider, target(), authority());
        expect(result.status).toBe("failed");
        expect(received).toEqual([...received].sort());
        expect(received).toHaveLength(2);
    });

    it("preserves parser diagnostics while recomputing a snapshot-invalid result", async () => {
        const selectedProvider = provider(async (input) => {
            const result = await validRead()(input);
            result.candidates.push(structuredClone(result.candidates[0]!));
            result.sourceParseReports[0]!.diagnostics = [
                {
                    severity: "warning",
                    code: "provider.snapshot_note",
                    message: "duplicate candidate fixture",
                    path: "",
                    traceId: "",
                    operation: "read",
                    causeKind: "none",
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: "",
                },
            ];
            return result;
        });
        const result = await executeAdapterReadWithAuthority(selectedProvider, target(), authority());
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "provider.snapshot_note")).toBe(true);
        expect(result.value.sourceReports[0]?.status).toBe("blocked");
    });
});
