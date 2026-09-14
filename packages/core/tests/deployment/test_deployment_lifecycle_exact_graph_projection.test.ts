/** Complete-file-graph reverse staging and immutable native-authority tests. */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { Sha256Digest, UuidV4 } from "../../src/types";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { publishAssetVersion, validateVersionMaterialClosure } from "../../src/catalog/version-authority";
import { resolvePortableDialectContractRefs } from "../../src/catalog/portable-dialect-authority";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import {
    computeRenderInputFingerprint,
    computeRenderedTargetDiffHunkFingerprint,
    computeRenderedTargetInspectionScopeFingerprint,
    computeTargetFileRenderProvenanceFingerprint,
    computeVersionFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../src/foundation/fingerprint";
import {
    validateChangedFiles,
    validateInspectionScope,
    validateInventoryDeltas,
} from "../../src/render/render-inspection-validation";
import { ASSET_ID, PROJECT_ID, VERSION_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import {
    GRAPH_BINARY_FILE_ID,
    GRAPH_BINARY_RESOURCE,
    GRAPH_BINARY_RESOURCE_PATH,
    GRAPH_BOUNDARY,
    GRAPH_CHANGED_BINARY_RESOURCE,
    GRAPH_CHANGED_ENTRY_TEXT,
    GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
    GRAPH_CHANGED_TEXT_RESOURCE,
    GRAPH_DIALECT_ID,
    GRAPH_ENTRY_PATH,
    GRAPH_HASH,
    GRAPH_REBASED_ENTRY_TEXT,
    GRAPH_REBASED_NATIVE_ENTRY_TEXT,
    GRAPH_TEXT_FILE_ID,
    GRAPH_TEXT_RESOURCE_PATH,
    changedExactGraphInspection,
    exactGraphMaterializationInput,
    fullExactGraphAppliedSnapshot,
    graphCanonicalMaterializer,
    type makeExactGraphFixture,
    makeParentGraphRebaseFixture,
} from "../render/fixtures/native-project-exact-graph-test-fixtures";
import {
    FOREIGN_GRAPH_RESTORATION_DIALECT_ID,
    graphStagingInvocation,
    makePublishedGraphParent,
} from "./fixtures/deployment-lifecycle-exact-graph-test-fixtures";

const VERSION_ID_3 = "ffffffff-ffff-4fff-8fff-ffffffffffff" as UuidV4;
const FOREIGN_RESTORATION_BYTES = Uint8Array.of(19, 23, 29, 31);
const REVERSE_AFTER_REBASE_ENTRY_TEXT = "# Review\nReview the returned foreign edit and read resources/marker.txt.\n";
const REVERSE_AFTER_REBASE_NATIVE_ENTRY_TEXT = GRAPH_REBASED_NATIVE_ENTRY_TEXT.replace(
    GRAPH_REBASED_ENTRY_TEXT,
    REVERSE_AFTER_REBASE_ENTRY_TEXT,
);

describe("deployment lifecycle exact-graph projection", () => {
    it("adds the first validated target-native graph after canonical-only materialization", () => {
        const published = makePublishedGraphParent({ canonicalMaterializer: graphCanonicalMaterializer });
        try {
            const invocation = graphStagingInvocation(published);
            const siblingAsset = structuredClone(invocation.base.assets[0]!);
            siblingAsset.version.ref.assetId = PROJECT_ID;
            const siblingDialect = structuredClone(invocation.base.dialectInputs[0]!);
            siblingDialect.targetVersion.assetId = PROJECT_ID;
            invocation.base.dialectInputs = [];
            const staged = deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                invocation.configuration,
                invocation.inspected,
                invocation.base,
                VERSION_ID_2 as UuidV4,
            );
            expect(staged.allowFirstNativeDialectProjection).toBe(true);
            invocation.base.assets.push(siblingAsset);
            invocation.base.dialectInputs = [siblingDialect];
            const projected = deploymentLifecycleInternalsForTest.projectStagedRenderBase(invocation.base, staged);
            expect(projected.dialectInputs.map((group) => group.targetVersion.assetId)).toEqual([ASSET_ID, PROJECT_ID]);
            expect(projected.dialectInputs[0]).toMatchObject({
                targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID_2 },
                inputs: [
                    {
                        inputKind: "native_representation",
                        inputRole: "current_exact",
                        representation: { dialectId: GRAPH_DIALECT_ID },
                        files: [{}, {}, {}],
                    },
                ],
            });

            const duplicate = structuredClone(invocation.base);
            const parentGroup = structuredClone(projected.dialectInputs[0]!);
            parentGroup.targetVersion.versionId = VERSION_ID;
            duplicate.dialectInputs = [parentGroup, structuredClone(parentGroup)];
            expect(() => deploymentLifecycleInternalsForTest.projectStagedRenderBase(duplicate, staged)).toThrow(
                /one unique parent authority/,
            );
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("reverses one changed parent-rebased file without reverting unchanged child resources", () => {
        const published = makePublishedGraphParent();
        const child = publishForeignGraphChild(published);
        try {
            const invocation = graphRebaseStagingInvocation(published, child.fixture);
            const staged = deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                invocation.configuration,
                invocation.inspected,
                invocation.base,
                VERSION_ID_3,
            );
            expect(staged).toMatchObject({
                assetId: ASSET_ID,
                versionId: VERSION_ID_3,
                revision: 3,
                parentVersionId: VERSION_ID_2,
                canonical: { kind: "Skill", typeData: child.closure.manifest.typeData },
                dialectRestorationPayloads: child.closure.manifest.dialectRestorationPayloads,
            });
            expect(staged.restorationPayloads).toEqual([
                { dialectId: FOREIGN_GRAPH_RESTORATION_DIALECT_ID, bytes: FOREIGN_RESTORATION_BYTES },
            ]);
            const files = new Map(staged.files.map((file) => [file.file.logicalPath, file]));
            expect(files.get("SKILL.md")).toMatchObject({ contentKind: "text", text: REVERSE_AFTER_REBASE_ENTRY_TEXT });
            expect(files.get("resources/marker.txt")).toMatchObject({
                contentKind: "text",
                text: GRAPH_CHANGED_TEXT_RESOURCE,
            });
            const native = new Map(staged.nativePayloads[0]!.files.map((file) => [file.relativePath, Buffer.from(file.bytes)]));
            expect(native.get(GRAPH_ENTRY_PATH)?.toString("utf8")).toBe(REVERSE_AFTER_REBASE_NATIVE_ENTRY_TEXT);
            expect(native.get(GRAPH_TEXT_RESOURCE_PATH)?.toString("utf8")).toBe(GRAPH_CHANGED_TEXT_RESOURCE);
            expect(native.get(GRAPH_BINARY_RESOURCE_PATH)).toEqual(Buffer.from(GRAPH_BINARY_RESOURCE));

            const originPreimage = {
                schemaVersion: 1 as const,
                assetId: staged.assetId,
                versionId: staged.versionId,
                originKind: "reverse_accept" as const,
                previousVersionId: staged.parentVersionId,
                previousVersionOriginAuthorityFingerprint: staged.parentOriginAuthorityFingerprint,
                reversePreparationIdentityFingerprint: GRAPH_HASH,
                userActionEvidenceId: "reverse-graph-after-parent-rebase",
                promotionRequirement: staged.promotionRequirement,
                createdAt: child.closure.manifest.createdAt + 1,
            };
            const closure = deploymentLifecycleInternalsForTest.buildStagedVersionClosure(
                staged,
                {
                    ...originPreimage,
                    authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
                },
                child.fixture.deployment.deploymentId as UuidV4,
            );
            validateVersionMaterialClosure(closure, published.versionRegistry);
            expect(closure.manifest.sourceVersionId).toBe(VERSION_ID_2);
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("stages one complete changed Skill graph and preserves all canonical and native members", () => {
        const published = makePublishedGraphParent();
        try {
            const invocation = graphStagingInvocation(published);
            const staged = deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                invocation.configuration,
                invocation.inspected,
                invocation.base,
                VERSION_ID_2 as UuidV4,
            );
            expect(staged).toMatchObject({
                assetId: ASSET_ID,
                versionId: VERSION_ID_2,
                revision: 2,
                parentVersionId: VERSION_ID,
                canonical: { kind: "Skill", typeData: published.closure.manifest.typeData },
                dialectRestorationPayloads: [],
                restorationPayloads: [],
            });
            const stagedFiles = new Map(staged.files.map((file) => [file.file.logicalPath, file]));
            expect(stagedFiles.get("SKILL.md")).toMatchObject({ contentKind: "text", text: GRAPH_CHANGED_ENTRY_TEXT });
            expect(stagedFiles.get("resources/marker.txt")).toMatchObject({
                contentKind: "text",
                text: GRAPH_CHANGED_TEXT_RESOURCE,
                file: { fileId: GRAPH_TEXT_FILE_ID, executable: true },
            });
            expect(stagedFiles.get("resources/tool.bin")).toMatchObject({
                contentKind: "binary",
                file: { fileId: GRAPH_BINARY_FILE_ID },
            });
            const binary = stagedFiles.get("resources/tool.bin");
            if (binary?.contentKind !== "binary") throw new Error("staged binary resource is missing");
            expect(binary.bytes).toEqual(GRAPH_CHANGED_BINARY_RESOURCE);

            expect(staged.nativeRepresentations).toHaveLength(1);
            expect(staged.nativeRepresentations[0]).toMatchObject({
                dialectId: GRAPH_DIALECT_ID,
                canonicalContentFingerprint: staged.versionCanonicalContentFingerprint,
                files: expect.arrayContaining([
                    expect.objectContaining({ relativePath: GRAPH_ENTRY_PATH, executable: false }),
                    expect.objectContaining({ relativePath: GRAPH_TEXT_RESOURCE_PATH, executable: true }),
                    expect.objectContaining({ relativePath: GRAPH_BINARY_RESOURCE_PATH, executable: false }),
                ]),
            });
            const nativePayloads = new Map(
                staged.nativePayloads[0]!.files.map((file) => [file.relativePath, Buffer.from(file.bytes)]),
            );
            expect(nativePayloads.get(GRAPH_ENTRY_PATH)?.toString("utf8")).toBe(GRAPH_CHANGED_NATIVE_ENTRY_TEXT);
            expect(nativePayloads.get(GRAPH_TEXT_RESOURCE_PATH)?.toString("utf8")).toBe(GRAPH_CHANGED_TEXT_RESOURCE);
            expect(nativePayloads.get(GRAPH_BINARY_RESOURCE_PATH)).toEqual(Buffer.from(GRAPH_CHANGED_BINARY_RESOURCE));

            const originPreimage = {
                schemaVersion: 1 as const,
                assetId: staged.assetId,
                versionId: staged.versionId,
                originKind: "reverse_accept" as const,
                previousVersionId: staged.parentVersionId,
                previousVersionOriginAuthorityFingerprint: staged.parentOriginAuthorityFingerprint,
                reversePreparationIdentityFingerprint: GRAPH_HASH,
                userActionEvidenceId: "reverse-graph-fixture",
                promotionRequirement: staged.promotionRequirement,
                createdAt: published.closure.manifest.createdAt + 1,
            };
            const closure = deploymentLifecycleInternalsForTest.buildStagedVersionClosure(
                staged,
                {
                    ...originPreimage,
                    authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
                },
                published.fixture.deployment.deploymentId as UuidV4,
            );
            validateVersionMaterialClosure(closure, published.versionRegistry);
            expect(closure.manifest.sourceVersionId).toBe(VERSION_ID);

            const projected = deploymentLifecycleInternalsForTest.projectStagedRenderBase(invocation.base, staged);
            expect(projected.assets[0]!.version.ref.versionId).toBe(VERSION_ID_2);
            expect(projected.dialectInputs).toMatchObject([
                {
                    targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID_2 },
                    inputs: [
                        {
                            inputKind: "native_representation",
                            inputRole: "current_exact",
                            representation: { dialectId: GRAPH_DIALECT_ID },
                            files: [{}, {}, {}],
                        },
                    ],
                },
            ]);
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });
});

function publishForeignGraphChild(published: ReturnType<typeof makePublishedGraphParent>) {
    const fixture = makeParentGraphRebaseFixture();
    const closure = structuredClone(fixture.closure);
    closure.manifest.portableDialectContracts = resolvePortableDialectContractRefs(
        { kind: "Skill", typeData: closure.manifest.typeData },
        closure.files,
        closure.manifest.status,
        published.versionRegistry,
    );
    const restoration = published.versionRegistry.getRestoration("Skill", FOREIGN_GRAPH_RESTORATION_DIALECT_ID);
    if (restoration === null) throw new Error("foreign graph restoration contract is missing");
    closure.manifest.dialectRestorationPayloads = [
        {
            dialectId: FOREIGN_GRAPH_RESTORATION_DIALECT_ID,
            restorationContractFingerprint: restoration.contractFingerprint,
            contentHash: binaryPayloadStats(FOREIGN_RESTORATION_BYTES).contentHash,
        },
    ];
    closure.restorationPayloads = [
        { dialectId: FOREIGN_GRAPH_RESTORATION_DIALECT_ID, bytes: new Uint8Array(FOREIGN_RESTORATION_BYTES) },
    ];
    closure.manifest.fingerprint = computeVersionFingerprint(
        closure.manifest.versionCanonicalContentFingerprint,
        closure.manifest.nativeRepresentations,
        closure.manifest.dialectRestorationPayloads,
        closure.manifest.portableDialectContracts,
    );
    fixture.closure = closure;
    fixture.deployment.assets[0]!.version = {
        ref: { assetId: ASSET_ID, versionId: VERSION_ID_2 },
        versionFingerprint: closure.manifest.fingerprint,
        versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
        status: closure.manifest.status,
        canonical: { kind: "Skill", typeData: closure.manifest.typeData },
        files: closure.files,
    };
    const { renderInputFingerprint: _old, ...preimage } = fixture.deployment;
    fixture.deployment = { ...preimage, renderInputFingerprint: computeRenderInputFingerprint(preimage) };
    fixture.analysisInput.deployment = {
        schemaVersion: 1,
        platform: fixture.deployment.platform,
        platformInstanceId: fixture.deployment.platformInstanceId,
        targetContexts: fixture.deployment.targetContexts,
        assets: fixture.deployment.assets,
        renderInputFingerprint: fixture.deployment.renderInputFingerprint,
    };
    publishAssetVersion({
        assetsRoot: published.assetsRoot,
        transactionId: "txn-exact-graph-foreign-child",
        version: closure,
        dialectRegistry: published.versionRegistry,
    });
    return { fixture, closure };
}

function graphRebaseStagingInvocation(
    published: ReturnType<typeof makePublishedGraphParent>,
    fixture: ReturnType<typeof makeParentGraphRebaseFixture>,
) {
    const materialization = exactGraphMaterializationInput(fixture);
    const materializedResult = fixture.support.materialize(materialization);
    if (materializedResult.materializationState !== "materialized") throw new Error("graph rebase did not materialize");
    const materialized = materializedResult.materializedUnits[0]!;
    const template = changedExactGraphInspection(fixture, materialization);
    const provenance = new Map(
        template.files.flatMap((file) =>
            file.fileState === "baseline_changed" ? [[file.relativePath, validGraphProvenance(file.provenance)] as const] : [],
        ),
    );
    const outputUnitFingerprint = materialized.outputUnitFingerprint;
    const fileStates = materialized.files.map((file) => {
        const appliedBytes = bytesForMaterializedContent(file.content);
        const currentBytes =
            file.relativePath === GRAPH_ENTRY_PATH
                ? new Uint8Array(Buffer.from(REVERSE_AFTER_REBASE_NATIVE_ENTRY_TEXT))
                : appliedBytes;
        const appliedContentHash = binaryPayloadStats(appliedBytes).contentHash;
        const currentContentHash = binaryPayloadStats(currentBytes).contentHash;
        const fileProvenance = provenance.get(file.relativePath);
        if (fileProvenance === undefined) throw new Error(`missing graph provenance for ${file.relativePath}`);
        return {
            relativePath: file.relativePath,
            state: file.relativePath === GRAPH_ENTRY_PATH ? ("changed" as const) : ("unchanged" as const),
            appliedContentHash,
            currentContentHash,
            appliedExecutable: file.executable,
            currentExecutable: file.executable,
            outputUnitFingerprint,
            provenanceFingerprint: fileProvenance.provenanceFingerprint,
        };
    });
    const scope = {
        fileStates,
        directoryInventories: [
            {
                outputUnitFingerprint,
                boundary: { relativePath: GRAPH_BOUNDARY, boundaryKind: "directory_inventory" as const },
                currentDescendantPaths: materialized.files.map((file) => file.relativePath).sort(),
            },
        ],
    };
    const inspectionScopeFingerprint = computeRenderedTargetInspectionScopeFingerprint({
        deploymentId: fixture.deployment.deploymentId as UuidV4,
        appliedCompilationFingerprint: template.appliedRenderSnapshot.compilationFingerprint,
        scope,
    });
    const entry = structuredClone(template.files.find((file) => file.relativePath === GRAPH_ENTRY_PATH));
    if (entry?.fileState !== "baseline_changed") throw new Error("graph rebase entry evidence is missing");
    entry.appliedContent = { contentKind: "text", text: GRAPH_REBASED_NATIVE_ENTRY_TEXT };
    entry.currentContent = { contentKind: "text", text: REVERSE_AFTER_REBASE_NATIVE_ENTRY_TEXT };
    entry.provenance = provenance.get(GRAPH_ENTRY_PATH)!;
    const entryState = fileStates.find((state) => state.relativePath === GRAPH_ENTRY_PATH)!;
    const hunk = {
        appliedStartByte: 0,
        appliedEndByte: Buffer.byteLength(GRAPH_REBASED_NATIVE_ENTRY_TEXT),
        currentStartByte: 0,
        currentEndByte: Buffer.byteLength(REVERSE_AFTER_REBASE_NATIVE_ENTRY_TEXT),
    };
    entry.diffHunks = [
        {
            ...hunk,
            hunkFingerprint: computeRenderedTargetDiffHunkFingerprint({
                relativePath: GRAPH_ENTRY_PATH,
                appliedContentHash: entryState.appliedContentHash,
                currentContentHash: entryState.currentContentHash,
                diffAlgorithmVersion: "core_byte_ranges_v1",
                hunk,
            }),
        },
    ];
    entry.attributeChanges = [];
    const inspectionInput = {
        ...template,
        inspectionScope: { inspectionScopeFingerprint, ...scope },
        files: [entry],
        inventoryDeltas: [],
    };
    const validationSnapshot = fullExactGraphAppliedSnapshot(inspectionInput.appliedRenderSnapshot);
    validateInspectionScope(inspectionInput, validationSnapshot);
    validateChangedFiles(inspectionInput, validationSnapshot);
    validateInventoryDeltas(inspectionInput, validationSnapshot);
    const result = fixture.support.inspect(inspectionInput);
    const inspected = {
        input: inspectionInput,
        result,
        appliedRenderSnapshot: inspectionInput.appliedRenderSnapshot,
        runtimeReplacementAuthority: {
            files: materialized.files.map((file) => ({
                relativePath: file.relativePath,
                expectedState: "present" as const,
                expectedBytes:
                    file.relativePath === GRAPH_ENTRY_PATH
                        ? new Uint8Array(Buffer.from(REVERSE_AFTER_REBASE_NATIVE_ENTRY_TEXT))
                        : bytesForMaterializedContent(file.content),
                expectedExecutable: file.executable,
            })),
        },
        operation: {
            deployment: structuredClone(fixture.deployment),
            registry: fixture.registry,
            dialectInputs: structuredClone(fixture.analysisInput.dialectInputs),
            diagnostics: [],
        },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[1];
    const base = graphRenderBase(fixture);
    const configuration = {
        render: { assetsRoot: published.assetsRoot, dialectRegistry: published.versionRegistry },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[0];
    return { configuration, inspected, base };
}

function bytesForMaterializedContent(
    content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array },
) {
    return content.contentKind === "text" ? new Uint8Array(Buffer.from(content.text)) : new Uint8Array(content.bytes);
}

function validGraphProvenance<T extends { provenanceFingerprint: Sha256Digest }>(provenance: T): T {
    const { provenanceFingerprint: _stored, ...preimage } = structuredClone(provenance);
    return {
        ...preimage,
        provenanceFingerprint: computeTargetFileRenderProvenanceFingerprint(preimage as never),
    } as T;
}

function graphRenderBase(fixture: ReturnType<typeof makeExactGraphFixture>) {
    const version = fixture.deployment.assets[0]!.version.ref;
    return {
        deploymentId: fixture.deployment.deploymentId,
        consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
        platform: fixture.deployment.platform,
        platformInstanceId: fixture.deployment.platformInstanceId,
        targetRootPath: fixture.deployment.targetRootPath,
        projectId: fixture.deployment.projectId,
        assets: structuredClone(fixture.deployment.assets),
        dialectInputs: structuredClone(fixture.analysisInput.dialectInputs),
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId: fixture.deployment.deploymentId,
            consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
            assets: [{ assetId: version.assetId, versionId: version.versionId, allowIncomplete: false }],
        },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.projectStagedRenderBase>[0];
}
