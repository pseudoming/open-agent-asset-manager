/**
 * Callable-binding acceptance and dependency-liveness scenarios.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";
import { createVersionDialectRegistry, readVersionAuthority } from "../../src/catalog/version-authority";
import { serializeVersionManifest } from "../../src/catalog/version-manifest";
import type { FileReferenceV2 } from "../../src/types";
import { makeNativeDialectContract, makePortableEntryDialectContract } from "./fixtures/dialect-contracts";
import {
    acceptRequest,
    assetsRoot,
    candidateBase,
    makeReadResult,
    makeReadResultFromProvider,
    makeService,
    providerForCandidate,
    sourceFile,
    subagentTypeData,
    workflowTypeData,
} from "./fixtures/import-service-test-fixtures";

describe("Core import callable-binding acceptance", () => {
    it("turns an exact Workflow selector input into a bound Subagent dependency", async () => {
        fs.writeFileSync(
            sourceFile,
            JSON.stringify({
                schemaVersion: 1,
                sections: [{ title: "Role", content: "Review changes" }],
            }),
        );
        const subagentRead = await makeReadResultFromProvider(
            providerForCandidate("Subagent", (observedReadEntryId, text) => ({
                ...candidateBase(observedReadEntryId, "agent.json", text, "fixture-subagent-v1"),
                kind: "Subagent",
                typeData: subagentTypeData(),
            })),
            "Subagent",
        );
        const service = makeService(async (previous) => previous);
        const subagent = await service.acceptImport(acceptRequest(service.previewImport([subagentRead]).value));
        if (subagent.status !== "complete") {
            throw new Error("Subagent import failed");
        }

        fs.writeFileSync(sourceFile, "Review the selected change.\n");
        const workflowRead = await makeReadResultFromProvider(
            providerForCandidate("Workflow", (observedReadEntryId, text) => ({
                ...candidateBase(observedReadEntryId, "review.md", text, "fixture-workflow-v1"),
                files: [
                    {
                        logicalPath: "review.md",
                        role: "entry",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        text,
                        executable: false,
                        references: [
                            {
                                kind: "execute",
                                rawTarget: "optional-helper",
                                required: false,
                                resolution: "unresolved",
                                diagnostics: [],
                            },
                            {
                                kind: "link",
                                rawTarget: "documentation",
                                required: false,
                                resolution: "unresolved",
                                diagnostics: [],
                            },
                        ],
                    },
                ],
                kind: "Workflow",
                workflowExecutionAgentBindingInput: {
                    bindingInputKind: "raw_selector",
                    rawTarget: "reviewer",
                    required: true,
                },
                typeData: workflowTypeData("reviewer"),
            })),
            "Workflow",
        );
        const workflowPreview = service.previewImport([workflowRead]);
        expect(workflowPreview.value.items[0]?.callableBindingRequests).toEqual([
            {
                subject: {
                    subjectKind: "file_reference",
                    logicalPath: "review.md",
                    referenceIndex: 0,
                },
                rawTarget: "optional-helper",
                required: false,
            },
            {
                subject: { subjectKind: "workflow_execution_agent" },
                rawTarget: "reviewer",
                required: true,
            },
        ]);
        const extraBinding = await service.acceptImport(
            acceptRequest(workflowPreview.value, {
                callableBindings: [
                    {
                        subject: {
                            subjectKind: "file_reference",
                            logicalPath: "review.md",
                            referenceIndex: 99,
                        },
                        targetAssetVersionId: subagent.value.versionId,
                    },
                    {
                        subject: { subjectKind: "workflow_execution_agent" },
                        targetAssetVersionId: subagent.value.versionId,
                    },
                ],
            }),
        );
        expect(extraBinding.diagnostics[0]?.code).toBe("import.binding_invalid");
        const workflow = await service.acceptImport(
            acceptRequest(workflowPreview.value, {
                callableBindings: [
                    {
                        subject: { subjectKind: "workflow_execution_agent" },
                        targetAssetVersionId: subagent.value.versionId,
                    },
                ],
            }),
        );
        expect(workflow.status).toBe("complete");
        if (workflow.status !== "complete") {
            throw new Error("Workflow import failed");
        }
        const closure = readVersionAuthority(
            assetsRoot,
            workflow.value.assetId,
            workflow.value.versionId,
            createVersionDialectRegistry(
                [
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
                        ["IMPORT_FAKE_CLI"],
                    ),
                ],
                [],
            ),
        );
        expect(closure?.manifest.typeData).toEqual(
            expect.objectContaining({
                implementation: expect.objectContaining({
                    execution: expect.objectContaining({
                        agent: { mode: "bound", targetAssetVersionId: subagent.value.versionId },
                    }),
                }),
            }),
        );

        const repeatedPreview = service.previewImport([workflowRead]);
        expect(repeatedPreview.value.items[0]?.action).toBe("create_asset");
        const repeated = await service.acceptImport(
            acceptRequest(repeatedPreview.value, {
                callableBindings: [
                    {
                        subject: { subjectKind: "workflow_execution_agent" },
                        targetAssetVersionId: subagent.value.versionId,
                    },
                ],
            }),
        );
        expect(repeated.diagnostics[0]?.code).toBe("import.duplicate_after_binding");
    });

    it("revalidates callable target liveness and completeness under authority locks", async () => {
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
        const service = makeService(async (previous) => previous);
        const leaf = await service.acceptImport(acceptRequest(service.previewImport([leafRead]).value));
        if (leaf.status !== "complete") {
            throw new Error("Subagent import failed");
        }

        fs.writeFileSync(sourceFile, "# Root\n");
        const reference: FileReferenceV2 = {
            kind: "execute",
            rawTarget: "reviewer",
            required: true,
            diagnostics: [],
            resolution: "unresolved",
        };
        const rootRead = await makeReadResult([reference]);
        const preview = service.previewImport([rootRead]);
        const request = () =>
            acceptRequest(preview.value, {
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
            });

        const asset = readAssetManifest(assetsRoot, leaf.value.assetId);
        if (asset === null) {
            throw new Error("fixture Asset missing");
        }
        writeAssetManifest(assetsRoot, { ...asset, deleted: true });
        const inactive = await service.acceptImport(request());
        expect(inactive.diagnostics[0]?.code).toBe("import.binding_target_inactive");

        writeAssetManifest(assetsRoot, asset);
        const closure = readVersionAuthority(
            assetsRoot,
            leaf.value.assetId,
            leaf.value.versionId,
            createVersionDialectRegistry([makeNativeDialectContract("Subagent", "fixture-subagent-v1")], [], [], []),
        );
        if (closure === null) {
            throw new Error("fixture Version missing");
        }
        const incomplete = structuredClone(closure.manifest);
        incomplete.status = "incomplete";
        fs.writeFileSync(
            path.join(assetsRoot, leaf.value.assetId, "versions", leaf.value.versionId, "version.json"),
            serializeVersionManifest(incomplete),
        );
        const incompleteTarget = await service.acceptImport(request());
        expect(incompleteTarget.diagnostics[0]?.code).toBe("import.binding_target_incomplete");
    });
});
