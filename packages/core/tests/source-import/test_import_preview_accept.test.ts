/** Authority-focused split from the original oversized test suite. */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { readAssetManifest } from "../../src/catalog/asset-manifest";
import { resolvePromotionGrantAuthority } from "../../src/catalog/promotion-grant-store";
import {
    computeReadSnapshotFingerprint,
    executeAdapterReadWithAuthority,
} from "../../src/source-import/source-contract-validator";
import { createVersionDialectRegistry, readVersionAuthority } from "../../src/catalog/version-authority";
import type { FileReferenceV2, UuidV4 } from "../../src/types";
import { makeNativeDialectContract, makePortableEntryDialectContract } from "./fixtures/dialect-contracts";
import {
    SOURCE_CAPABILITY,
    TARGET_PROJECT_ID,
    assetsRoot,
    sourceFile,
    transactionsRoot,
    readTarget,
    providerForCandidate,
    candidateBase,
    subagentTypeData,
    workflowTypeData,
    makeReadResult,
    makeGuidanceReadResult,
    makeReadResultFromProvider,
    cloneAsSecondPhysicalObservation,
    cloneWithSiblingCandidateObservation,
    makeService,
    acceptRequest,
} from "./fixtures/import-service-test-fixtures";

describe("Core import preview reconciliation and initial accept", () => {
    it("rejects empty, duplicate, invalid, and cross-snapshot duplicate candidate closures", async () => {
        const service = makeService(async (previous) => previous);
        expect(service.previewImport([]).diagnostics[0]?.code).toBe("import.preview_empty");

        const first = await makeReadResult();
        expect(service.previewImport([first, first]).diagnostics[0]?.code).toBe("import.read_snapshot_duplicate");

        const invalid = structuredClone(first);
        invalid.status = "partial";
        expect(service.previewImport([invalid]).diagnostics[0]?.code).toBe("import.read_snapshot_invalid");

        fs.writeFileSync(sourceFile, "# Other bytes\n");
        const second = await makeReadResult();
        expect(first.readSnapshotFingerprint).not.toBe(second.readSnapshotFingerprint);
        expect(service.previewImport([second, first]).diagnostics[0]?.code).toBe("import.candidate_duplicate");
    });

    it("classifies incomplete and unregistered-project candidates without publishing", async () => {
        const incompleteRead = await makeGuidanceReadResult({ assetCandidateStatus: "incomplete" });
        const service = makeService(async (previous) => previous);
        const incomplete = service.previewImport([incompleteRead]);
        expect(incomplete.value.items[0]?.action).toBe("incomplete");
        const incompleteAccept = await service.acceptImport(acceptRequest(incomplete.value));
        expect(incompleteAccept.diagnostics[0]?.code).toBe("import.candidate_not_creatable");

        const projectRead = await makeGuidanceReadResult({
            scope: "project",
            projectRootPath: "/missing-project",
        });
        const blocked = service.previewImport([projectRead]);
        expect(blocked.value.items[0]?.action).toBe("blocked");
        expect(blocked.value.items[0]?.diagnostics[0]?.code).toBe("import.project_unregistered");
        const blockedAccept = await service.acceptImport(acceptRequest(blocked.value));
        expect(blockedAccept.diagnostics[0]?.code).toBe("import.candidate_not_creatable");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("blocks an arbitrary portable dialect before candidate acceptance", async () => {
        const read = await makeReadResultFromProvider(
            providerForCandidate("Workflow", (observedReadEntryId, text) => ({
                ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
                kind: "Workflow",
                workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
                typeData: {
                    ...workflowTypeData(null),
                    implementation: {
                        ...workflowTypeData(null).implementation,
                        instructionDialectId: "invented-workflow-entry-v1",
                    },
                },
            })),
            "Workflow",
        );
        const service = makeService(async () => read);
        const preview = service.previewImport([read]);
        expect(preview.value.items[0]).toEqual(
            expect.objectContaining({
                action: "blocked",
                diagnostics: expect.arrayContaining([
                    expect.objectContaining({
                        code: "import.portable_dialect_contract_rejected",
                    }),
                ]),
            }),
        );
        const accepted = await service.acceptImport(acceptRequest(preview.value));
        expect(accepted.diagnostics[0]?.code).toBe("import.candidate_not_creatable");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("preserves a non-Error portable registry failure as a typed import diagnostic", async () => {
        const read = await makeReadResultFromProvider(
            providerForCandidate("Workflow", (observedReadEntryId, text) => ({
                ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
                kind: "Workflow",
                workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
                typeData: workflowTypeData(null),
            })),
            "Workflow",
        );
        const service = makeService(async () => read, {
            dialectRegistry: {
                getNative: () => null,
                getRestoration: () => null,
                getPortableEntry: () => {
                    throw "portable registry fault";
                },
                getPortableSelector: () => null,
            },
        });
        const preview = service.previewImport([read]);
        expect(preview.value.items[0]?.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "import.portable_dialect_contract_rejected",
                    message: "portable registry fault",
                }),
            ]),
        );
    });

    it("binds portable contracts to the candidate's actual source runtime version", async () => {
        const read = await makeReadResultFromProvider(
            providerForCandidate("Workflow", (observedReadEntryId, text) => ({
                ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
                kind: "Workflow",
                workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
                typeData: workflowTypeData(null),
            })),
            "Workflow",
        );
        const portable = makePortableEntryDialectContract(
            "Workflow",
            "workflow_instruction",
            "claudecode-command-markdown-v1",
            () => true,
            ["IMPORT_FAKE_CLI"],
        );
        portable.validateSourceApplicability = (source) => source.versionText === "other-build";
        const registry = createVersionDialectRegistry(
            [makeNativeDialectContract("Workflow", "fixture-workflow-v1")],
            [],
            [portable],
            [],
        );
        const blocked = makeService(async () => read, { dialectRegistry: registry }).previewImport([read]);
        expect(blocked.value.items[0]).toEqual(expect.objectContaining({ action: "blocked" }));
        expect(blocked.value.items[0]?.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "import.portable_dialect_contract_rejected" })]),
        );

        portable.validateSourceApplicability = (source) => source.versionText === "fixture";
        const acceptedRegistry = createVersionDialectRegistry(
            [makeNativeDialectContract("Workflow", "fixture-workflow-v1")],
            [],
            [portable],
            [],
        );
        expect(makeService(async () => read, { dialectRegistry: acceptedRegistry }).previewImport([read]).value.items[0]).toEqual(
            expect.objectContaining({ action: "create_asset" }),
        );
    });

    it("treats a refreshed source-runtime build change as a stale preview", async () => {
        const read = await makeReadResultFromProvider(
            providerForCandidate("Workflow", (observedReadEntryId, text) => ({
                ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
                kind: "Workflow",
                workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
                typeData: workflowTypeData(null),
            })),
            "Workflow",
        );
        const portable = makePortableEntryDialectContract(
            "Workflow",
            "workflow_instruction",
            "claudecode-command-markdown-v1",
            () => true,
            ["IMPORT_FAKE_CLI"],
        );
        portable.validateSourceApplicability = (source) => source.versionText === "fixture";
        const registry = createVersionDialectRegistry(
            [makeNativeDialectContract("Workflow", "fixture-workflow-v1")],
            [],
            [portable],
            [],
        );
        const refreshed = structuredClone(read);
        if (refreshed.readTarget.sourceSelector.selectorKind !== "probe_roots") {
            throw new Error("portable refresh fixture requires probe roots");
        }
        refreshed.readTarget.sourceSelector.observation.observedAgentRuntimes =
            refreshed.readTarget.sourceSelector.observation.observedAgentRuntimes.map((entry) => ({
                ...entry,
                versionText: "other-build",
            }));
        refreshed.readSnapshotFingerprint = computeReadSnapshotFingerprint(
            refreshed.readTarget,
            refreshed.readAuthorityFingerprint,
            refreshed.sourceReadObligations,
            refreshed.observedReadEntries,
            refreshed.externalAttestationReceipts.map((receipt) => receipt.attestationReceiptFingerprint),
            refreshed.sourceParseReports,
        );

        const service = makeService(async () => refreshed, { dialectRegistry: registry });
        const preview = service.previewImport([read]);
        expect(preview.value.items[0]).toEqual(expect.objectContaining({ action: "create_asset" }));
        const accepted = await service.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("failed");
        expect(accepted.diagnostics[0]?.code).toBe("import.source_changed");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("canonically orders two complete read closures and their preview items", async () => {
        const zRead = await makeGuidanceReadResult({ candidateId: "candidate-z" });
        const aRead = await makeGuidanceReadResult({
            candidateId: "candidate-a",
            scope: "project",
            projectRootPath: "/project",
        });
        const service = makeService(async (previous) => previous);
        const first = service.previewImport([zRead, aRead]);
        const second = service.previewImport([aRead, zRead]);
        expect(first.status).toBe("complete");
        expect(first.value.snapshotFingerprint).toBe(second.value.snapshotFingerprint);
        const candidateIds = first.value.items.map((item) => item.candidateId);
        expect(candidateIds).toHaveLength(2);
        expect(candidateIds).toEqual(
            [...candidateIds].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
        );
    });

    it("deduplicates one physical source and blocks incompatible cross-adapter interpretations", async () => {
        const first = await makeReadResult();
        const equivalent = cloneAsSecondPhysicalObservation(first);
        const service = makeService(async (previous) => previous);

        const merged = service.previewImport([equivalent, first]);
        expect(merged.status).toBe("complete");
        expect(merged.value.items).toHaveLength(1);
        expect(merged.value.items[0]?.action).toBe("create_asset");

        const conflicting = cloneAsSecondPhysicalObservation(first);
        conflicting.candidates[0]!.displayName = "Incompatible interpretation";
        const blocked = service.previewImport([first, conflicting]);
        expect(blocked.value.items).toHaveLength(1);
        expect(blocked.value.items[0]).toEqual(
            expect.objectContaining({
                action: "blocked",
                diagnostics: [
                    expect.objectContaining({
                        code: "import.same_source_interpretation_conflict",
                    }),
                ],
            }),
        );
    });

    it("freshly re-reconciles equivalent sibling-runtime observations before accepting one Asset", async () => {
        const read = cloneWithSiblingCandidateObservation(await makeReadResult());
        const service = makeService(async () => structuredClone(read));
        const preview = service.previewImport([read]);
        expect(preview.status).toBe("complete");
        expect(preview.value.items).toHaveLength(1);

        const accepted = await service.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("complete");
    });

    it("rejects a refreshed conflicting sibling-runtime interpretation before publication", async () => {
        const read = cloneWithSiblingCandidateObservation(await makeReadResult());
        const refreshed = structuredClone(read);
        refreshed.candidates[1]!.displayName = "Changed sibling parser output";
        const service = makeService(async () => refreshed);

        const accepted = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
        expect(accepted.status).toBe("failed");
        expect(accepted.diagnostics[0]?.code).toBe("import.source_changed");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("accepts runtime-default/executable Workflows and rejects unbound or mismatched selectors", async () => {
        const runtimeNative = providerForCandidate("Workflow", (observedReadEntryId, text) => ({
            ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
            kind: "Workflow",
            workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
            typeData: workflowTypeData(null),
        }));
        const accepted = await executeAdapterReadWithAuthority(runtimeNative, readTarget("Workflow"), {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [SOURCE_CAPABILITY],
            transactionsRoot,
        });
        expect(accepted.status).toBe("complete");

        const executable = providerForCandidate("Workflow", (observedReadEntryId, text) => ({
            ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
            kind: "Workflow",
            workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
            typeData: {
                ...workflowTypeData(null),
                implementation: {
                    kind: "executable",
                    executableDialectId: "claudecode-js-workflow-v1",
                },
            },
        }));
        expect(
            (
                await executeAdapterReadWithAuthority(executable, readTarget("Workflow"), {
                    managedTargetGuards: [],
                    reservationIdentityFingerprints: [SOURCE_CAPABILITY],
                    transactionsRoot,
                })
            ).status,
        ).toBe("complete");

        const unbound = providerForCandidate("Workflow", (observedReadEntryId, text) => ({
            ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
            kind: "Workflow",
            workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
            typeData: workflowTypeData("reviewer"),
        }));
        const unboundResult = await executeAdapterReadWithAuthority(unbound, readTarget("Workflow"), {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [SOURCE_CAPABILITY],
            transactionsRoot,
        });
        expect(unboundResult.status).toBe("failed");
        expect(unboundResult.diagnostics.some((item) => item.code === "read.workflow_agent_binding_input_invalid")).toBe(true);

        const mismatched = providerForCandidate("Workflow", (observedReadEntryId, text) => ({
            ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
            kind: "Workflow",
            workflowExecutionAgentBindingInput: {
                bindingInputKind: "raw_selector",
                rawTarget: "different-agent",
                required: true,
            },
            typeData: workflowTypeData("reviewer"),
        }));
        const result = await executeAdapterReadWithAuthority(mismatched, readTarget("Workflow"), {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [SOURCE_CAPABILITY],
            transactionsRoot,
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "read.workflow_agent_binding_input_invalid")).toBe(true);
    });

    it("rechecks mutation scope under Asset locks after the asynchronous source refresh", async () => {
        const read = await makeReadResult();
        let checks = 0;
        const service = makeService(async () => read, {
            assertMutationScope: () => {
                checks += 1;
                if (checks === 2) throw new Error("action-time import freeze");
            },
        });
        const preview = service.previewImport([read]);
        const accepted = await service.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("failed");
        expect(accepted.diagnostics[0]?.message).toBe("action-time import freeze");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("publishes one fresh imported Version and later recognizes the exact duplicate", async () => {
        const read = await makeReadResult();
        const service = makeService(async () => read);
        const preview = service.previewImport([read]);
        expect(preview.status).toBe("complete");
        expect(preview.value.items).toEqual([expect.objectContaining({ freshness: "fresh", action: "create_asset" })]);

        const accepted = await service.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("complete");
        const asset = readAssetManifest(assetsRoot, accepted.value.assetId);
        expect(asset?.versionIds).toEqual([accepted.value.versionId]);
        const version = readVersionAuthority(
            assetsRoot,
            accepted.value.assetId,
            accepted.value.versionId,
            createVersionDialectRegistry([makeNativeDialectContract("Guidance", "fixture-guidance-v1")], [], [], []),
        );
        expect(version?.manifest.originAuthority.originKind).toBe("import");
        expect(version?.manifest.importProvenanceAuthority.acceptedFreshness).toBe("current_source_verified");

        const duplicate = service.previewImport([read]);
        expect(duplicate.value.items[0]).toEqual(
            expect.objectContaining({
                action: "duplicate",
                assetId: accepted.value.assetId,
                versionId: accepted.value.versionId,
            }),
        );
        const duplicateAccept = await service.acceptImport(acceptRequest(duplicate.value));
        expect(duplicateAccept.diagnostics[0]?.code).toBe("import.candidate_not_creatable");
    });

    it("preserves an importable incomplete candidate as an incomplete Version", async () => {
        const read = await makeGuidanceReadResult({ status: "incomplete" });
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([read]);
        expect(preview.value.items[0]?.action).toBe("create_asset");

        const accepted = await service.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("complete");
        if (accepted.status !== "complete") throw new Error("incomplete import failed");
        expect(
            readVersionAuthority(
                assetsRoot,
                accepted.value.assetId,
                accepted.value.versionId,
                createVersionDialectRegistry([makeNativeDialectContract("Guidance", "fixture-guidance-v1")], [], [], []),
            )?.manifest.status,
        ).toBe("incomplete");

        const completeRead = await makeGuidanceReadResult({ status: "complete" });
        const completePreview = service.previewImport([completeRead]);
        expect(completePreview.value.items[0]?.action).toBe("create_asset");
        const completed = await service.acceptImport(
            acceptRequest(completePreview.value, {
                action: "create_version",
                assetId: accepted.value.assetId,
                parentVersionId: accepted.value.versionId,
            }),
        );
        expect(completed.status).toBe("complete");
        if (completed.status !== "complete") throw new Error("completion import failed");
        expect(
            readVersionAuthority(
                assetsRoot,
                completed.value.assetId,
                completed.value.versionId,
                createVersionDialectRegistry([makeNativeDialectContract("Guidance", "fixture-guidance-v1")], [], [], []),
            )?.manifest.status,
        ).toBe("complete");
    });

    it("publishes an initial current-Version promotion grant in the same Asset commit", async () => {
        const read = await makeReadResult();
        const service = makeService(async (previous) => previous);
        const accepted = await service.acceptImport(
            acceptRequest(service.previewImport([read]).value, {
                promotion: {
                    promotionAction: "grant_current_version_current_target",
                    target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
                    userActionId: "grant-imported-version",
                },
            }),
        );
        expect(accepted.status).toBe("complete");
        if (accepted.status !== "complete") throw new Error("granting import failed");
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: accepted.value.assetId,
                versionId: accepted.value.versionId,
                target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
            })?.subject,
        ).toEqual({
            subjectKind: "asset_version",
            assetId: accepted.value.assetId,
            versionId: accepted.value.versionId,
        });
    });

    it("rejects a changed current source before any Asset or grant mutation", async () => {
        const read = await makeReadResult();
        const service = makeService(async () => {
            fs.writeFileSync(sourceFile, "# Changed\n");
            return makeReadResult();
        });
        const preview = service.previewImport([read]);
        const accepted = await service.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("failed");
        expect(accepted.diagnostics[0]?.code).toBe("import.source_changed");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("rejects changed parser material even when the physical read closure is unchanged", async () => {
        const read = await makeReadResult();
        const changed = structuredClone(read);
        changed.candidates[0]!.displayName = "Changed parser output";
        expect(changed.readSnapshotFingerprint).toBe(read.readSnapshotFingerprint);

        const service = makeService(async () => changed);
        const result = await service.acceptImport(acceptRequest(service.previewImport([read]).value));
        expect(result.diagnostics[0]?.code).toBe("import.source_changed");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("imports exact preview bytes only after explicit stale-snapshot approval", async () => {
        const read = await makeReadResult();
        let refreshCalls = 0;
        const service = makeService(async () => {
            refreshCalls += 1;
            return read;
        });
        const preview = service.previewImport([read]);
        fs.writeFileSync(sourceFile, "# Changed outside preview\n");
        const accepted = await service.acceptImport(
            acceptRequest(preview.value, {
                freshness: {
                    freshnessAction: "accept_preview_snapshot",
                    userActionId: "accept-old-snapshot",
                },
            }),
        );
        expect(accepted.status).toBe("complete");
        expect(refreshCalls).toBe(0);
        const version = readVersionAuthority(
            assetsRoot,
            accepted.value.assetId,
            accepted.value.versionId,
            createVersionDialectRegistry([makeNativeDialectContract("Guidance", "fixture-guidance-v1")], [], [], []),
        );
        expect(version?.files[0]).toEqual(expect.objectContaining({ text: "# Guidance\n" }));
        expect(version?.manifest.importProvenanceAuthority.acceptedFreshness).toBe("user_approved_preview_snapshot");
    });

    it("creates a user-selected later Version with an all-Versions project grant", async () => {
        const firstRead = await makeReadResult();
        const service = makeService(async (previous) => previous);
        const firstPreview = service.previewImport([firstRead]);
        const first = await service.acceptImport(acceptRequest(firstPreview.value));
        if (first.status !== "complete") throw new Error("first import failed");

        fs.writeFileSync(sourceFile, "# Guidance v2\n");
        const secondRead = await makeReadResult();
        const secondPreview = service.previewImport([secondRead]);
        expect(secondPreview.value.items[0]?.action).toBe("create_asset");
        const second = await service.acceptImport(
            acceptRequest(secondPreview.value, {
                action: "create_version",
                assetId: first.value.assetId,
                parentVersionId: first.value.versionId,
                promotion: {
                    promotionAction: "grant_asset_all_versions_current_target",
                    target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
                    userActionId: "grant-all-versions",
                },
            }),
        );
        expect(second.status).toBe("complete");
        expect(second.value.assetId).toBe(first.value.assetId);
        expect(readAssetManifest(assetsRoot, first.value.assetId)?.versionIds).toEqual([
            first.value.versionId,
            second.value.versionId,
        ]);
        expect(
            resolvePromotionGrantAuthority({
                assetsRoot,
                assetId: first.value.assetId,
                versionId: first.value.versionId,
                target: { targetKind: "project", projectId: TARGET_PROJECT_ID },
            })?.subject.subjectKind,
        ).toBe("asset_all_versions");
    });

    it("does not publish a dependent root until its required leaf Version exists", async () => {
        const missingLeaf = "00000000-0000-4000-8000-000000009999" as UuidV4;
        const reference: FileReferenceV2 = {
            kind: "execute",
            rawTarget: "leaf",
            required: true,
            diagnostics: [],
            resolution: "unresolved",
        };
        const rootRead = await makeReadResult([reference]);
        const service = makeService(async (previous) => previous);
        const preview = service.previewImport([rootRead]);
        const noBinding = await service.acceptImport(acceptRequest(preview.value));
        expect(noBinding.diagnostics[0]?.code).toBe("import.binding_required_missing");

        const nonexistentBinding = await service.acceptImport(
            acceptRequest(preview.value, {
                callableBindings: [
                    {
                        subject: {
                            subjectKind: "file_reference",
                            logicalPath: "GUIDANCE.md",
                            referenceIndex: 0,
                        },
                        targetAssetVersionId: missingLeaf,
                    },
                ],
            }),
        );
        expect(nonexistentBinding.diagnostics[0]?.code).toBe("import.binding_target_missing");
        expect(fs.existsSync(assetsRoot)).toBe(false);

        fs.writeFileSync(sourceFile, "# Non-callable leaf\n");
        const guidanceRead = await makeReadResult();
        const guidance = await service.acceptImport(acceptRequest(service.previewImport([guidanceRead]).value));
        if (guidance.status !== "complete") throw new Error("Guidance import failed");
        const wrongKind = await service.acceptImport(
            acceptRequest(preview.value, {
                callableBindings: [
                    {
                        subject: {
                            subjectKind: "file_reference",
                            logicalPath: "GUIDANCE.md",
                            referenceIndex: 0,
                        },
                        targetAssetVersionId: guidance.value.versionId,
                    },
                ],
            }),
        );
        expect(wrongKind.diagnostics[0]?.code).toBe("import.binding_target_kind_invalid");

        fs.writeFileSync(
            sourceFile,
            JSON.stringify({
                schemaVersion: 1,
                sections: [{ title: "Role", content: "Review changes" }],
            }),
        );
        const leafRead = await makeReadResultFromProvider(
            providerForCandidate("Subagent", (observedReadEntryId, text) => ({
                ...candidateBase(observedReadEntryId, "agent.json", text, "fixture-subagent-v1"),
                kind: "Subagent",
                typeData: subagentTypeData(),
            })),
            "Subagent",
        );
        const leaf = await service.acceptImport(acceptRequest(service.previewImport([leafRead]).value));
        if (leaf.status !== "complete") throw new Error("Subagent leaf import failed");

        fs.writeFileSync(sourceFile, "# Root\n");
        const freshRootRead = await makeReadResult([reference]);
        const rootPreview = service.previewImport([freshRootRead]);
        const root = await service.acceptImport(
            acceptRequest(rootPreview.value, {
                callableBindings: [
                    {
                        subject: {
                            subjectKind: "file_reference",
                            logicalPath: "GUIDANCE.md",
                            referenceIndex: 0,
                        },
                        targetAssetVersionId: leaf.value.versionId,
                    },
                ],
            }),
        );
        expect(root.status).toBe("complete");
    });
});
