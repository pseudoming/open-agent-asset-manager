import { withReadBatch } from "../adapters/fixtures/adapter-read-filesystem";
/** Authority-focused split from the original oversized test suite. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import {
    executeAdapterReadWithAuthority,
    executeAdapterReadWithAuthorityForTest,
    validateAdapterReadResultSnapshot,
} from "../../src/source-import/source-contract-validator";
import { createAdapterReadOperationForTest } from "../../src/adapters/adapter-read-access";
import { computeSourceCapabilityFingerprint } from "../../src/adapters/adapter-contract-validator";
import type { AdapterReadTarget } from "../../src/types";
import {
    ADAPTER,
    sandbox,
    sourceFile,
    root,
    provider,
    target,
    authority,
    validRead,
    validEmptyDirectoryRead,
} from "./fixtures/source-contract-test-fixtures";

describe("source contract provider-result fault closure", () => {
    it("derives partial and blocked source outcomes without disguising access failure as empty", async () => {
        const partialProvider = provider(async (input) => {
            const result = await validRead()(input);
            const disposition = result.sourceParseReports[0]!.readEntryDispositions[0]!;
            await input.readAccess.readFile(disposition.readEntryHandleId);
            return result;
        });
        const partial = await executeAdapterReadWithAuthority(partialProvider, target(), authority());
        expect(partial.status).toBe("partial");
        expect(partial.value.sourceReports[0]?.status).toBe("partial");

        const blockedProvider = provider(async (input) => {
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
        const blocked = await executeAdapterReadWithAuthorityForTest(
            blockedProvider,
            target(),
            authority(),
            (operationInput, revalidateAuthority) =>
                createAdapterReadOperationForTest(
                    operationInput,
                    withReadBatch({
                        readRegularFileNoFollow: () => {
                            throw new SafeFilesystemError({
                                failureKind: "io_error",
                                operation: "read_regular_file",
                                targetPath: sourceFile,
                                message: "broken source",
                            });
                        },
                        inventoryDirectoryNoFollow: () => {
                            throw new Error("directory port not expected");
                        },
                    }),
                    () => ({ release() {} }),
                    revalidateAuthority,
                ),
        );
        expect(blocked.status).toBe("failed");
        expect(blocked.value.sourceReports[0]?.status).toBe("blocked");
    });

    it("accepts a fully traversed empty directory as empty rather than a zero-port fake", async () => {
        const directory = path.join(sandbox, "empty-source");
        fs.mkdirSync(directory);
        const selectedProvider = provider(validEmptyDirectoryRead());
        const guidance = selectedProvider.assetSourceCapabilities.find((row) => row.assetKind === "Guidance")!;
        guidance.sourcePathMechanism = "directory_entry";
        guidance.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(selectedProvider, guidance) as string;
        const result = await executeAdapterReadWithAuthority(selectedProvider, target([root("root-1", directory)]), authority());
        expect(result.status).toBe("complete");
        expect(result.value.sourceReports).toEqual([{ sourceRootId: "root-1", status: "empty", diagnostics: [] }]);

        const containerProvider = provider(async (input) => {
            const parsed = await validEmptyDirectoryRead()(input);
            const report = parsed.sourceParseReports[0]!;
            const disposition = report.readEntryDispositions[0]!;
            if (disposition.disposition === "ignored") throw new Error("expected traversal");
            disposition.candidateIds = ["container-candidate"];
            report.status = "parsed";
            parsed.candidates = [
                {
                    candidateId: "container-candidate",
                    sourceRootIds: [report.sourceRootId],
                    scope: "global",
                    projectRootPath: "",
                    scopePath: "",
                    displayName: "Container guidance",
                    displayDescription: "",
                    files: [],
                    nativeRepresentation: {
                        representationSource: "canonical_files",
                        dialectId: "mock-container-v1",
                    },
                    dialectRestorationTransition: { action: "inherit" },
                    status: "incomplete",
                    assetCandidateStatus: "incomplete",
                    promotionSafety: "default_promotable",
                    sourceFileOrigins: [],
                    sourceContainerEntryIds: [report.observedReadEntryIds[0]!],
                    metadataSourceOrigins: [],
                    sourceEvidence: [],
                    diagnostics: [],
                    kind: "Guidance",
                    typeData: { schemaVersion: 1 },
                },
            ];
            return parsed;
        });
        const containerCapability = containerProvider.assetSourceCapabilities.find((row) => row.assetKind === "Guidance")!;
        containerCapability.sourcePathMechanism = "directory_entry";
        containerCapability.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(
            containerProvider,
            containerCapability,
        ) as string;
        const container = await executeAdapterReadWithAuthority(
            containerProvider,
            target([root("root-1", directory)]),
            authority(),
        );
        expect(container.status).toBe("complete");
        expect(container.value.sourceReports[0]?.status).toBe("scanned");
    });

    it("validates user-selected candidate scope, manifest obligations, and surfaced parse diagnostics", async () => {
        const selectedProvider = provider(async (input) => {
            const result = await validRead()(input);
            result.candidates[0]!.scope = "project";
            result.candidates[0]!.projectRootPath = "/other";
            result.sourceParseReports[0]!.diagnostics = [
                {
                    severity: "warning",
                    code: "provider.note",
                    message: "fixture note",
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
        const guidance = selectedProvider.assetSourceCapabilities.find((row) => row.assetKind === "Guidance")!;
        guidance.sourceDomain = "external_managed";
        guidance.rootLocatorKind = "user_provided_path";
        guidance.readPolicy = "user_selected_root_only";
        guidance.sourcePathMechanism = "manifest_declared";
        guidance.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(selectedProvider, guidance) as string;
        const selectedRoot = {
            ...root(),
            sourceDomain: "external_managed" as const,
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path" as const,
                    locatorKey: "picker",
                    evidenceLevel: "user_provided" as const,
                },
            ],
        };
        const selectedTarget: AdapterReadTarget = {
            adapterId: ADAPTER,
            allowedKinds: ["Guidance"],
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
        const result = await executeAdapterReadWithAuthority(selectedProvider, selectedTarget, authority());
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "read.candidate_user_scope_mismatch")).toBe(true);
        expect(result.diagnostics.some((item) => item.code === "provider.note")).toBe(true);
    });

    it("hashes an incomplete binary candidate without pretending it is complete Guidance", async () => {
        const selectedProvider = provider(async (input) => {
            const result = await validRead()(input);
            result.candidates[0]!.files[0] = {
                logicalPath: "GUIDANCE.md",
                role: "entry",
                contentKind: "binary",
                mediaType: "application/octet-stream",
                bytes: Buffer.from("# Guidance\n"),
                executable: false,
            };
            result.candidates[0]!.status = "incomplete";
            result.candidates[0]!.assetCandidateStatus = "incomplete";
            result.candidates[0]!.nativeRepresentation = {
                representationSource: "separate_files",
                dialectId: "mock-guidance-v1",
                files: [
                    {
                        relativePath: "native/GUIDANCE.md",
                        contentKind: "binary",
                        mediaType: "application/octet-stream",
                        bytes: Buffer.from("# Guidance\n"),
                        executable: false,
                    },
                ],
            };
            return result;
        });
        expect((await executeAdapterReadWithAuthority(selectedProvider, target(), authority())).status).toBe("complete");
    });

    it("fails closed when a faulting read port contradicts its own root-handle ledger", async () => {
        const selectedProvider = provider(validRead());
        const withoutHandle = await executeAdapterReadWithAuthorityForTest(
            selectedProvider,
            target(),
            authority(),
            (operationInput) => {
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
                    snapshot: () => ({ ...operation.snapshot(), handles: [] }),
                };
            },
        );
        expect(withoutHandle.status).toBe("failed");
        expect(withoutHandle.diagnostics.some((item) => item.code === "read.obligation_root_unresolved")).toBe(true);

        const failedProvider = provider(async (input) => {
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
        const failedWithHandle = await executeAdapterReadWithAuthorityForTest(
            failedProvider,
            target(),
            authority(),
            (operationInput) => {
                const operation = createAdapterReadOperationForTest(
                    operationInput,
                    withReadBatch({
                        readRegularFileNoFollow: () => {
                            throw new SafeFilesystemError({
                                failureKind: "not_found",
                                operation: "read_regular_file",
                                targetPath: sourceFile,
                                message: "missing",
                            });
                        },
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
                        handles: [
                            {
                                readEntryHandleId: "impossible-handle",
                                sourceReadObligationId: operationInput.sourceReadObligations[0]!.sourceReadObligationId,
                                sourceRootId: "root-1",
                                relativePath: "",
                                entryKind: "file",
                            },
                        ],
                    }),
                };
            },
        );
        expect(failedWithHandle.status).toBe("failed");
        expect(failedWithHandle.diagnostics.some((item) => item.code === "read.obligation_failed_root_has_handle")).toBe(true);
    });

    it("keeps root not-found and permission failures as Core-owned terminal reports", async () => {
        const cases = [
            ["not_found", "not_found", "complete"],
            ["permission_denied", "permission_denied", "failed"],
        ] as const;
        for (const [failureKind, sourceStatus, resultStatus] of cases) {
            const selectedProvider = provider(async (input) => {
                const obligation = input.sourceReadObligations[0]!;
                const resolved = await input.readAccess.resolveRootEntry(
                    obligation.sourceReadObligationId,
                    obligation.sourceRootId,
                );
                expect(resolved).toEqual(
                    expect.objectContaining({
                        state: "failed",
                        failureStatus: failureKind,
                    }),
                );
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
            const result = await executeAdapterReadWithAuthorityForTest(
                selectedProvider,
                target(),
                authority(),
                (operationInput) =>
                    createAdapterReadOperationForTest(
                        operationInput,
                        withReadBatch({
                            readRegularFileNoFollow: () => {
                                throw new SafeFilesystemError({
                                    failureKind,
                                    operation: "read_regular_file",
                                    targetPath: sourceFile,
                                    message: failureKind,
                                });
                            },
                            inventoryDirectoryNoFollow: () => {
                                throw new Error("directory port not expected");
                            },
                        }),
                        () => ({ release() {} }),
                    ),
            );
            expect(result.status).toBe(resultStatus);
            expect(result.value.sourceReports).toEqual([
                expect.objectContaining({ sourceRootId: "root-1", status: sourceStatus }),
            ]);
            expect(validateAdapterReadResultSnapshot(result.value)).toEqual([]);
        }
    });
});
