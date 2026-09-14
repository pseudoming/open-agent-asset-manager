/** Published Version and reverse-staging fixtures shared by exact-graph lifecycle tests. */

import * as os from "node:os";
import * as path from "node:path";
import { createVersionDialectRegistry } from "../../../src/catalog/version-dialect-registry";
import { publishInitialAssetVersion } from "../../../src/catalog/version-authority";
import { resolvePortableDialectContractRefs } from "../../../src/catalog/portable-dialect-authority";
import { computeRenderInputFingerprint, computeVersionFingerprint } from "../../../src/foundation/fingerprint";
import type { deploymentLifecycleInternalsForTest } from "../../../src/orchestration/deployment-lifecycle-service";
import type { UuidV4 } from "../../../src/types";
import { makePortableEntryDialectContract, makeRestorationDialectContract } from "../../source-import/fixtures/dialect-contracts";
import { ASSET_ID, PROJECT_ID, VERSION_ID, makeAsset } from "../../catalog/fixtures/version-v2";
import {
    GRAPH_DIALECT_ID,
    changedExactGraphInspection,
    exactGraphMaterializationInput,
    makeExactGraphFixture,
} from "../../render/fixtures/native-project-exact-graph-test-fixtures";

export const FOREIGN_GRAPH_RESTORATION_DIALECT_ID = "foreign-runtime-skill-state-v1";

export function makePublishedGraphParent(options: Parameters<typeof makeExactGraphFixture>[0] = {}) {
    const fixture = makeExactGraphFixture(options);
    const assetsRoot = path.join(os.tmpdir(), `oaam-exact-graph-parent-${process.pid}-${Date.now()}-${Math.random()}`);
    const portableEntry = makePortableEntryDialectContract(
        "Skill",
        "skill_entry",
        fixture.closure.manifest.typeData.entryDialectId,
        () => true,
    );
    const foreignRestoration = makeRestorationDialectContract("Skill", FOREIGN_GRAPH_RESTORATION_DIALECT_ID);
    const versionRegistry = createVersionDialectRegistry([fixture.nativeDialect], [foreignRestoration], [portableEntry], []);
    const closure = structuredClone(fixture.closure);
    const projected = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
    if (projected.inputKind === "native_representation") {
        closure.manifest.nativeRepresentations = [
            {
                ...structuredClone(projected.representation),
                files: projected.files.map((file) => {
                    if (file.contentKind === "text") {
                        const { text: _text, ...descriptor } = file;
                        return descriptor;
                    }
                    const { bytes: _bytes, ...descriptor } = file;
                    return descriptor;
                }),
            },
        ];
        closure.nativePayloads = [
            {
                dialectId: GRAPH_DIALECT_ID,
                files: projected.files.map((file) => ({
                    relativePath: file.relativePath,
                    bytes: Buffer.from(file.contentKind === "text" ? file.text : file.bytes),
                })),
            },
        ];
    } else if (projected.inputKind === "canonical_materialization") {
        closure.manifest.nativeRepresentations = [];
        closure.nativePayloads = [];
    } else {
        throw new Error("fixture exact graph materialization authority is missing");
    }
    closure.manifest.portableDialectContracts = resolvePortableDialectContractRefs(
        { kind: "Skill", typeData: closure.manifest.typeData },
        closure.files,
        closure.manifest.status,
        versionRegistry,
    );
    closure.manifest.fingerprint = computeVersionFingerprint(
        closure.manifest.versionCanonicalContentFingerprint,
        closure.manifest.nativeRepresentations,
        [],
        closure.manifest.portableDialectContracts,
    );
    fixture.closure = closure;
    fixture.deployment.assets[0]!.version.versionFingerprint = closure.manifest.fingerprint;
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
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "txn-exact-graph-parent",
        asset: makeAsset([VERSION_ID], {
            kind: "Skill",
            scope: "project",
            projectId: PROJECT_ID,
            scopePath: "",
        }),
        version: closure,
        dialectRegistry: versionRegistry,
    });
    return { fixture, assetsRoot, portableEntry, foreignRestoration, versionRegistry, closure };
}

export function graphStagingInvocation(published: ReturnType<typeof makePublishedGraphParent>) {
    const materialization = exactGraphMaterializationInput(published.fixture);
    const inspectionInput = changedExactGraphInspection(published.fixture, materialization);
    const result = published.fixture.support.inspect(inspectionInput);
    const inspected = {
        input: inspectionInput,
        result,
        appliedRenderSnapshot: inspectionInput.appliedRenderSnapshot,
        runtimeReplacementAuthority: runtimeAuthorityFromChangedFiles(inspectionInput.files),
        operation: {
            deployment: structuredClone(published.fixture.deployment),
            registry: published.fixture.registry,
            dialectInputs: structuredClone(published.fixture.analysisInput.dialectInputs),
            diagnostics: [],
        },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[1];
    const base = graphRenderBase(published.fixture);
    const configuration = {
        render: { assetsRoot: published.assetsRoot, dialectRegistry: published.versionRegistry },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[0];
    return { configuration, inspected, base };
}

function runtimeAuthorityFromChangedFiles(files: ReturnType<typeof changedExactGraphInspection>["files"]) {
    return {
        files: files.map((file) => {
            if (file.fileState !== "baseline_changed") throw new Error("graph runtime authority fixture requires present files");
            const bytes = Buffer.from(
                file.currentContent.contentKind === "text" ? file.currentContent.text : file.currentContent.bytes,
            );
            return {
                relativePath: file.relativePath,
                expectedState: "present" as const,
                expectedBytes: new Uint8Array(bytes),
                expectedExecutable: file.attributeChanges[0]?.currentValue ?? false,
            };
        }),
    };
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
