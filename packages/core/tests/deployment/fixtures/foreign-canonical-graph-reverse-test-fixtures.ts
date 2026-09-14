/** A saved foreign source graph, approved canonical target and real changed-file attribution. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVersionDialectRegistry } from "../../../src/catalog/version-dialect-registry";
import { publishInitialAssetVersion } from "../../../src/catalog/version-authority";
import { resolvePortableDialectContractRefs } from "../../../src/catalog/portable-dialect-authority";
import type { AdapterNativeDialectContractV1 } from "../../../src/contracts/dialect";
import type { PosixRelativePath } from "../../../src/types";
import {
    computeRenderInputFingerprint,
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../../src/foundation/fingerprint";
import { deriveRequiredRenderSemanticsV1 } from "../../../src/render/render-semantics";
import { projectVersionDialectInputs } from "../../../src/render/render-dialect-authority";
import { makePortableEntryDialectContract, makeRestorationDialectContract } from "../../source-import/fixtures/dialect-contracts";
import { ASSET_ID, PROJECT_ID, VERSION_ID, makeAsset } from "../../catalog/fixtures/version-v2";
import {
    GRAPH_BOUNDARY,
    GRAPH_DIALECT_ID,
    GRAPH_HASH,
    graphCanonicalMaterializer,
    graphRebaseMaterializer,
    makeGraphDialectInput,
    makeGraphNativeDialectContract,
} from "../../render/fixtures/native-project-exact-graph-native-test-fixtures";
import {
    exactGraphCanonicalValues,
    exactGraphMaterializationInput,
    fullExactGraphAppliedSnapshot,
    makeExactGraphFixture,
} from "../../render/fixtures/native-project-exact-graph-test-fixtures";
import { FOREIGN_GRAPH_RESTORATION_DIALECT_ID, graphStagingInvocation } from "./deployment-lifecycle-exact-graph-test-fixtures";

export const SOURCE_DIALECT = "foreign-skill-folder-v1";
export const SOURCE_ENTRY_DIALECT = "foreign-skill-entry-v1";
export const SOURCE_DIRECTORIES = [
    GRAPH_BOUNDARY,
    `${GRAPH_BOUNDARY}/empty`,
    `${GRAPH_BOUNDARY}/resources`,
] as PosixRelativePath[];

export function foreignSourceContract(): AdapterNativeDialectContractV1 {
    const original = makeGraphNativeDialectContract();
    return {
        definition: { ...original.definition, dialectId: SOURCE_DIALECT },
        validateSameContent: (input) =>
            input.canonical.kind === "Skill" &&
            input.canonical.typeData.entryDialectId === SOURCE_ENTRY_DIALECT &&
            input.representation.dialectId === SOURCE_DIALECT &&
            original.validateSameContent({ ...input, representation: { ...input.representation, dialectId: GRAPH_DIALECT_ID } }),
        rebase: {
            ref: { ...graphRebaseMaterializer.ref },
            materialize: (input) => graphRebaseMaterializer.materialize({ ...input, nativeDialectId: GRAPH_DIALECT_ID }),
        },
    };
}

export function makeForeignCanonicalGraphReverseFixture(
    renderer: { adapterVersion?: string; outputContractId?: string; materializationProfileId?: string } = {},
    sourceAuthority: "native" | "canonical_only" = "native",
) {
    // Generate current canonical bytes, including later reverse Versions; never return a fixed old graph.
    const canonicalMaterializer = {
        ...graphCanonicalMaterializer,
        materialize(input: Parameters<typeof graphCanonicalMaterializer.materialize>[0]) {
            const generated = makeGraphDialectInput(GRAPH_HASH, makeGraphNativeDialectContract()).inputs[0]!;
            if (generated.inputKind !== "native_representation") throw new Error("target graph fixture missing");
            return graphRebaseMaterializer.materialize({
                ...input,
                parent: {
                    sourceVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                    representation: generated.representation,
                    files: generated.files,
                },
            });
        },
    };
    const fixture = makeExactGraphFixture({ ...renderer, canonicalMaterializer });
    const sourceNative = foreignSourceContract();
    const strictTarget = makeGraphNativeDialectContract();
    const targetNative = {
        ...strictTarget,
        validateSameContent: (input: Parameters<typeof strictTarget.validateSameContent>[0]) =>
            input.canonical.kind === "Skill" &&
            input.canonical.typeData.entryDialectId === "fixture-skill-entry-v1" &&
            strictTarget.validateSameContent(input),
    };
    const closure = structuredClone(fixture.closure);
    closure.manifest.typeData.entryDialectId = SOURCE_ENTRY_DIALECT;
    const canonical = { kind: "Skill" as const, typeData: closure.manifest.typeData };
    closure.manifest.versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        closure.manifest.files,
    );
    const native = makeGraphDialectInput(closure.manifest.versionCanonicalContentFingerprint, sourceNative, {
        directories: SOURCE_DIRECTORIES,
    }).inputs[0]!;
    if (native.inputKind !== "native_representation") throw new Error("source graph fixture missing");
    const { representationFingerprint: _old, ...preimage } = native.representation;
    const representation = {
        ...preimage,
        dialectId: SOURCE_DIALECT,
        files: native.files.map((file) => {
            if (file.contentKind === "text") {
                const { text: _text, ...descriptor } = file;
                return descriptor;
            }
            const { bytes: _bytes, ...descriptor } = file;
            return descriptor;
        }),
    };
    closure.manifest.nativeRepresentations = [
        { ...representation, representationFingerprint: computeVersionNativeRepresentationFingerprint(representation) },
    ];
    closure.nativePayloads = [
        {
            dialectId: SOURCE_DIALECT,
            files: native.files.map((file) => ({
                relativePath: file.relativePath,
                bytes: new Uint8Array(Buffer.from(file.contentKind === "text" ? file.text : file.bytes)),
            })),
        },
    ];
    if (sourceAuthority === "canonical_only") {
        closure.manifest.nativeRepresentations = [];
        closure.nativePayloads = [];
    }
    const portableEntry = makePortableEntryDialectContract("Skill", "skill_entry", SOURCE_ENTRY_DIALECT, () => true);
    const foreignRestoration = makeRestorationDialectContract("Skill", FOREIGN_GRAPH_RESTORATION_DIALECT_ID);
    const versionRegistry = createVersionDialectRegistry([sourceNative, targetNative], [foreignRestoration], [portableEntry], []);
    closure.manifest.portableDialectContracts = resolvePortableDialectContractRefs(
        canonical,
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
    Object.assign(fixture.deployment.assets[0]!.version, {
        canonical,
        versionFingerprint: closure.manifest.fingerprint,
        versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
    });
    const { renderInputFingerprint: _input, ...deployment } = fixture.deployment;
    fixture.deployment = { ...deployment, renderInputFingerprint: computeRenderInputFingerprint(deployment) };
    fixture.requiredSemantics = deriveRequiredRenderSemanticsV1(fixture.deployment);
    fixture.analysisInput.deployment = {
        ...fixture.analysisInput.deployment,
        assets: fixture.deployment.assets,
        renderInputFingerprint: fixture.deployment.renderInputFingerprint,
    };
    fixture.analysisInput.requiredSemantics = fixture.requiredSemantics;
    const conversion = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
    if (conversion.inputKind !== "canonical_materialization") throw new Error("canonical conversion fixture missing");
    if (sourceAuthority === "native") conversion.logicalDirectoryPaths = ["empty", "resources"];
    const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-foreign-reverse-"));
    const asset = makeAsset([VERSION_ID], { kind: "Skill", scope: "project", projectId: PROJECT_ID, scopePath: "" });
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "txn-foreign-parent",
        asset,
        version: closure,
        dialectRegistry: versionRegistry,
    });
    const published = { fixture, assetsRoot, portableEntry, foreignRestoration, versionRegistry, closure };
    const invocation = graphStagingInvocation(published);
    const materialization = exactGraphMaterializationInput(fixture);
    const materialized = fixture.support.materialize(materialization);
    if (materialized.materializationState !== "materialized") throw new Error("target materialization fixture failed");
    const proof = fixture.registry.validateOutputContractMaterialization({
        contract: fixture.components.outputContracts[0]!,
        profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
        outputUnit: materialization.selection.outputUnits[0]!,
        selectedSemantics: fixture.requiredSemantics,
        canonicalValues: exactGraphCanonicalValues(fixture),
        selectedOptions: materialization.selection.semanticOptions,
        dialectInputs: materialization.dialectInputs,
        files: materialized.materializedUnits[0]!.files,
    });
    const snapshot = fullExactGraphAppliedSnapshot(invocation.inspected.input.appliedRenderSnapshot);
    snapshot.semanticCoverageProofs = [proof];
    snapshot.decisions = materialization.selection.semanticOptions.map((option) => {
        const { semanticRefFingerprint, requiredOutputUnitFingerprints, ...rest } = option;
        return {
            ...rest,
            semanticRef: fixture.requiredSemantics.find(
                (semantic) => semantic.semanticRefFingerprint === semanticRefFingerprint,
            )!,
            consumerOwnerAdapterId: fixture.provider.adapterId,
            consumerOwnerAdapterVersion: fixture.provider.version,
            outputUnitFingerprints: requiredOutputUnitFingerprints,
            approval: { approvalState: "not_required" as const },
        };
    });
    invocation.inspected.appliedRenderSnapshot = snapshot;
    invocation.inspected.input.appliedRenderSnapshot = snapshot;
    invocation.inspected.result = fixture.support.inspect(invocation.inspected.input);
    const available = projectVersionDialectInputs(
        { assetId: ASSET_ID, versionId: VERSION_ID },
        {
            nativeRepresentations: closure.manifest.nativeRepresentations,
            dialectRestorationPayloads: [],
            nativePayloads: closure.nativePayloads,
            restorationPayloads: [],
        },
    );
    if (available === null && sourceAuthority !== "canonical_only") throw new Error("source dialect projection fixture failed");
    invocation.base.dialectInputs = available === null ? [] : [available];
    invocation.inspected.operation.dialectInputs = invocation.base.dialectInputs;
    return { published, invocation, sourceNative, targetNative, materialization, materialized, available, asset };
}
