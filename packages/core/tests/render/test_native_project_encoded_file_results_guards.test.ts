/** Result matching, rebase, decode, materialization and inspection guards for encoded files. */

import { describe, expect, it } from "vitest";
import type { PosixRelativePath, UuidV4 } from "../../src/types";
import {
    canonicalSectionRefs,
    encodedFileDiagnostic,
    encodedSectionDescriptors,
    findEncodedFileAssets,
    safeDecodeNativeFile,
    safePathValidation,
    type NativeProjectEncodedFileProviderBehavior,
} from "../../src/render/native-project-encoded-file-results";
import { makeNativeProjectEncodedFileContractParts } from "../../src/render/native-project-encoded-file-profiles";
import { analyzeNativeProjectEncodedFile } from "../../src/render/native-project-encoded-file-behavior";
import {
    ENCODED_DIALECT_ID,
    ENCODED_ENTRY_TEXT,
    ENCODED_NATIVE_TEXT,
    ENCODED_PROMPT_TEXT,
    ENCODED_TARGET_PATH,
    changedEncodedInspection,
    decodeEncodedNativeFile,
    encodedMaterializationInput,
    encodedRebaseMaterializer,
    makeEncodedFileFixture,
    makeParentEncodedRebaseFixture,
} from "./fixtures/native-project-encoded-file-test-fixtures";

const OTHER_ASSET = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as UuidV4;
const OTHER_VERSION = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" as UuidV4;

describe("native project encoded-file result guards", () => {
    it("rejects malformed deployment, Asset and canonical graph closures", () => {
        const cases: Array<(fixture: ReturnType<typeof makeEncodedFileFixture>) => void> = [
            (fixture) => {
                fixture.analysisInput.deployment.assets = [];
            },
            (fixture) => {
                fixture.analysisInput.deployment.targetContexts = [];
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs = [];
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets.push(structuredClone(fixture.analysisInput.deployment.assets[0]!));
                fixture.analysisInput.dialectInputs.push(structuredClone(fixture.analysisInput.dialectInputs[0]!));
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs[0]!.targetVersion.versionId = OTHER_VERSION;
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.canonical = {
                    kind: "Skill",
                    typeData: { schemaVersion: 1, name: "wrong", description: "wrong" },
                } as never;
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.scope = "global";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.projectId = "" as never;
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.scopePath = "nested";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.status = "incomplete";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files = [];
            },
            (fixture) => {
                const files = fixture.analysisInput.deployment.assets[0]!.version.files;
                files.push({
                    ...structuredClone(files[1]!),
                    file: { ...structuredClone(files[1]!.file), fileId: OTHER_VERSION },
                });
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files[0]!.contentKind = "binary" as never;
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files[1]!.file.role = "entry";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files[0]!.file.executable = true;
            },
            (fixture) => {
                const entry = fixture.analysisInput.deployment.assets[0]!.version.files[0]!;
                if (entry.contentKind === "text") entry.text = "";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.sectionHandles = {};
            },
            (fixture) => {
                const handles = fixture.analysisInput.deployment.assets[0]!.sectionHandles;
                handles[Object.keys(handles)[1]!] = handles[Object.keys(handles)[0]!]!;
            },
        ];
        for (const [index, mutate] of cases.entries()) {
            const fixture = makeEncodedFileFixture();
            mutate(fixture);
            expect(findEncodedFileAssets(fixture.analysisInput, behavior(fixture)), `closure mutation ${index}`).toBeNull();
        }
    });

    it("rejects malformed native and restoration inputs without trusting Provider exceptions", () => {
        const cases: Array<(fixture: ReturnType<typeof makeEncodedFileFixture>) => void> = [
            (fixture) => {
                fixture.analysisInput.dialectInputs[0]!.inputs = [];
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs[0]!.inputs.push(
                    structuredClone(fixture.analysisInput.dialectInputs[0]!.inputs[0]!),
                );
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs[0]!.inputs.push({ inputKind: "dialect_restoration" } as never);
            },
            (fixture) => {
                const native = currentNative(fixture);
                native.representation.dialectId = "foreign-v1";
            },
            (fixture) => {
                currentNative(fixture).files.push(structuredClone(currentNative(fixture).files[0]!));
            },
            (fixture) => {
                const native = currentNative(fixture);
                native.inputRole = "parent_rebase_seed";
                (native as never as { sourceVersion: { assetId: UuidV4; versionId: UuidV4 } }).sourceVersion = {
                    assetId: OTHER_ASSET,
                    versionId: OTHER_VERSION,
                };
            },
            (fixture) => {
                currentNative(fixture).files[0]!.contentKind = "binary" as never;
            },
            (fixture) => {
                currentNative(fixture).files[0]!.executable = true;
            },
            (fixture) => {
                const file = currentNative(fixture).files[0]!;
                if (file.contentKind === "text") file.text = file.text.replace("\n", "\r\n");
            },
            (fixture) => {
                currentNative(fixture).files[0]!.relativePath = "outside.md";
            },
        ];
        for (const [index, mutate] of cases.entries()) {
            const fixture = makeEncodedFileFixture();
            mutate(fixture);
            expect(findEncodedFileAssets(fixture.analysisInput, behavior(fixture)), `native mutation ${index}`).toBeNull();
        }

        const throwingPath = makeEncodedFileFixture();
        const pathBehavior = behavior(throwingPath);
        pathBehavior.validatePath = () => {
            throw new Error("fixture path failure");
        };
        expect(findEncodedFileAssets(throwingPath.analysisInput, pathBehavior)).toBeNull();
        expect(safePathValidation(pathBehavior, ENCODED_TARGET_PATH)).toBe(false);
    });

    it("requires deterministic Provider decoding and safe immediate-parent rebasing", () => {
        const decodeCases: NativeProjectEncodedFileProviderBehavior["decodeNativeFile"][] = [
            () => null,
            () => ({ sections: "bad" as never }),
            () => ({ sections: [], extra: true }) as never,
            () => ({ sections: [{ sectionHandle: "duplicate", canonicalContent: { contentKind: "text", text: "x" } }] }),
            () => ({
                sections: [
                    { sectionHandle: "encoded-entry", canonicalContent: { contentKind: "binary", bytes: Uint8Array.of(1) } },
                    { sectionHandle: "encoded-resource", canonicalContent: { contentKind: "text", text: ENCODED_PROMPT_TEXT } },
                ],
            }),
            () => ({
                sections: [
                    {
                        sectionHandle: "encoded-entry",
                        canonicalContent: { contentKind: "text", text: `${ENCODED_ENTRY_TEXT}\r\n` },
                    },
                    { sectionHandle: "encoded-resource", canonicalContent: { contentKind: "text", text: ENCODED_PROMPT_TEXT } },
                ],
            }),
            () => {
                throw new Error("fixture decoder failure");
            },
        ];
        for (const decodeNativeFile of decodeCases) {
            const fixture = makeEncodedFileFixture();
            expect(findEncodedFileAssets(fixture.analysisInput, { ...behavior(fixture), decodeNativeFile })).toBeNull();
        }

        for (const materialize of [
            () => null,
            () => ({ nativeText: 1 as never }),
            () => ({ nativeText: ENCODED_NATIVE_TEXT, extra: true }) as never,
            () => ({ nativeText: ENCODED_NATIVE_TEXT }),
            () => ({ nativeText: "\n" }),
            () => ({ nativeText: ENCODED_NATIVE_TEXT.replace("\n", "\r\n") }),
            () => {
                throw new Error("fixture rebase failure");
            },
        ]) {
            const fixture = makeParentEncodedRebaseFixture();
            const candidate = behavior(fixture);
            candidate.rebaseMaterializer = { ...encodedRebaseMaterializer, materialize };
            expect(findEncodedFileAssets(fixture.analysisInput, candidate)).toBeNull();
        }
    });

    it("sorts distinct native paths and rejects two Assets targeting one physical file", () => {
        const fixture = makeEncodedFileFixture();
        const other = makeSecondAsset(fixture, ".fixture/agents/alpha.md" as PosixRelativePath);
        fixture.analysisInput.deployment.assets.unshift(other.asset);
        fixture.analysisInput.dialectInputs.unshift(other.group);
        const candidate = behavior(fixture);
        candidate.validatePath = (path) => path.startsWith(".fixture/agents/");
        candidate.decodeNativeFile = (input) => decodeEncodedNativeFile({ ...input, relativePath: ENCODED_TARGET_PATH });
        expect(findEncodedFileAssets(fixture.analysisInput, candidate)?.map((item) => item.nativeFile.relativePath)).toEqual([
            ".fixture/agents/alpha.md",
            ENCODED_TARGET_PATH,
        ]);

        const duplicate = makeEncodedFileFixture();
        const same = makeSecondAsset(duplicate, ENCODED_TARGET_PATH);
        duplicate.analysisInput.deployment.assets.push(same.asset);
        duplicate.analysisInput.dialectInputs.push(same.group);
        expect(findEncodedFileAssets(duplicate.analysisInput, behavior(duplicate))).toBeNull();

        const analysis = makeEncodedFileFixture();
        const second = makeSecondAsset(analysis, ".fixture/agents/alpha.md" as PosixRelativePath);
        analysis.analysisInput.deployment.assets.unshift(second.asset);
        analysis.analysisInput.dialectInputs.unshift(second.group);
        analysis.analysisInput.requiredSemantics.unshift(
            ...analysis.analysisInput.requiredSemantics.map((semantic) => ({
                ...structuredClone(semantic),
                subject: {
                    ...structuredClone(semantic.subject),
                    assetId: OTHER_ASSET,
                    versionId: OTHER_VERSION,
                },
            })),
        );
        const analysisBehavior = behavior(analysis);
        analysisBehavior.validatePath = (path) => path.startsWith(".fixture/agents/");
        analysisBehavior.decodeNativeFile = (input) => decodeEncodedNativeFile({ ...input, relativePath: ENCODED_TARGET_PATH });
        const result = analyzeNativeProjectEncodedFile(analysis.analysisInput, analysisBehavior);
        expect(result).toMatchObject({ status: "complete", outputUnits: [{}, {}] });
    });

    it("fails analysis and materialization on incomplete semantics or forged selections", () => {
        const incomplete = makeEncodedFileFixture();
        incomplete.analysisInput.requiredSemantics.pop();
        expect(incomplete.support.analyze(incomplete.analysisInput)).toMatchObject({ status: "failed", outputUnits: [] });

        const malformed = makeEncodedFileFixture();
        malformed.analysisInput.deployment.assets = [];
        expect(malformed.support.analyze(malformed.analysisInput)).toMatchObject({ status: "failed" });
        const malformedMaterialization = encodedMaterializationInput(makeEncodedFileFixture());
        malformedMaterialization.deployment.assets = [];
        expect(makeEncodedFileFixture().support.materialize(malformedMaterialization)).toMatchObject({
            status: "failed",
            materializationState: "blocked",
        });

        const selectionMutations: Array<(input: ReturnType<typeof encodedMaterializationInput>) => void> = [
            (input) => {
                input.selection.outputUnits = [];
            },
            (input) => {
                input.selection.outputUnitRenderers = [];
            },
            (input) => {
                input.selection.outputUnits[0]!.claims[0]!.relativePath = "outside.md";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.rendererAdapterId = "FOREIGN";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.rendererAdapterVersion = "9.9.9";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializerCapabilityKey = "foreign";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializationProfileId = "foreign";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.profileConstraintFingerprint = `sha256:${"9".repeat(64)}`;
            },
            (input) => {
                input.selection.semanticOptions.pop();
            },
            (input) => {
                input.selection.semanticOptions[0]!.semanticRefFingerprint = `sha256:${"9".repeat(64)}`;
            },
            (input) => {
                input.selection.semanticOptions[0]!.outcome = "degraded";
            },
            (input) => {
                input.selection.semanticOptions[0]!.renderStrategy = "portable";
            },
            (input) => {
                input.selection.semanticOptions[0]!.actualReverseExtractPolicy = "cannot_reconcile";
            },
            (input) => {
                input.selection.semanticOptions[0]!.requiredOutputUnitFingerprints = [];
            },
        ];
        for (const [index, mutate] of selectionMutations.entries()) {
            const fixture = makeEncodedFileFixture();
            const input = encodedMaterializationInput(fixture);
            mutate(input);
            expect(fixture.support.materialize(input), `selection mutation ${index}`).toMatchObject({
                status: "failed",
                materializationState: "blocked",
            });
        }

        const invalidBinding = makeEncodedFileFixture();
        const input = encodedMaterializationInput(invalidBinding);
        const fileSemantic = input.requiredSemantics.find(
            (semantic) => semantic.semanticKind === "subagent.resource" && semantic.subject.subjectKind === "file",
        )!;
        if (fileSemantic.subject.subjectKind !== "file") throw new Error("resource semantic fixture is missing");
        fileSemantic.subject.fileId = OTHER_VERSION;
        expect(invalidBinding.support.materialize(input)).toMatchObject({ status: "failed", materializationState: "blocked" });
    });

    it("blocks invalid inspection shape and returns conflicts for undecodable or unchanged edits", () => {
        const fixture = makeEncodedFileFixture();
        expect(fixture.support.inspect({} as never)).toMatchObject({ status: "failed", files: [] });
        const materialization = encodedMaterializationInput(fixture);
        const base = changedEncodedInspection(fixture, materialization);
        const blockedMutations: Array<(input: typeof base) => void> = [
            (input) => {
                input.appliedRenderSnapshot.outputUnits = [];
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers = [];
            },
            (input) => {
                input.files.push(structuredClone(input.files[0]!));
            },
            (input) => {
                input.inventoryDeltas.push({} as never);
            },
            (input) => {
                input.inspectionScope.directoryInventories.push({} as never);
            },
            (input) => {
                input.inspectionScope.fileStates[0]!.outputUnitFingerprint = `sha256:${"9".repeat(64)}`;
            },
            (input) => {
                input.files[0]!.fileState = "baseline_missing";
            },
            (input) => {
                input.files[0]!.appliedContent = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (input) => {
                input.files[0]!.currentContent = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (input) => {
                input.files[0]!.attributeChanges.push({} as never);
            },
            (input) => {
                input.files[0]!.diffHunks = [];
            },
            (input) => {
                input.files[0]!.provenance.sectionBindings[0]!.semanticRefFingerprints = [];
            },
            (input) => {
                input.appliedRenderSnapshot.decisions = [];
            },
            (input) => {
                input.appliedRenderSnapshot.decisions.push(structuredClone(input.appliedRenderSnapshot.decisions[0]!));
            },
        ];
        for (const [index, mutate] of blockedMutations.entries()) {
            const input = structuredClone(base);
            mutate(input);
            expect(fixture.support.inspect(input), `inspection mutation ${index}`).toMatchObject({ status: "failed" });
        }

        const undecodable = structuredClone(base);
        if (undecodable.files[0]!.currentContent.contentKind === "text") {
            undecodable.files[0]!.currentContent.text = "not-json\n";
        }
        expect(fixture.support.inspect(undecodable)).toMatchObject({
            status: "complete",
            files: [expect.objectContaining({ attributionState: "conflict" })],
        });

        const unchanged = changedEncodedInspection(fixture, materialization, ENCODED_NATIVE_TEXT);
        expect(fixture.support.inspect(unchanged)).toMatchObject({
            status: "complete",
            files: [expect.objectContaining({ attributionState: "conflict" })],
        });
    });

    it("exposes stable diagnostics and rejects malformed direct decoder contracts", () => {
        const fixture = makeEncodedFileFixture();
        const candidate = behavior(fixture);
        const sections = encodedSectionDescriptors(fixture.analysisInput.deployment.assets[0]!)!;
        expect(safeDecodeNativeFile(candidate, ENCODED_TARGET_PATH, ENCODED_NATIVE_TEXT, sections)).toHaveLength(2);
        expect(encodedFileDiagnostic(candidate, "blocked")).toMatchObject({ severity: "error", operation: "render" });
        expect(encodedFileDiagnostic(candidate, "conflict", "warning")).toMatchObject({
            severity: "warning",
            operation: "scan",
        });

        const entryOnly = makeEncodedFileFixture({ withPrompt: false });
        expect(
            canonicalSectionRefs(entryOnly.requiredSemantics, entryOnly.analysisInput.deployment.assets[0]! as never, {
                sectionHandle: "missing",
                semanticKind: "subagent.resource",
            }),
        ).toEqual([]);

        const restoration = makeEncodedFileFixture({ restorationDialectIds: ["fixture-restoration-v1"] });
        expect(restoration.support.analyze(restoration.analysisInput).status).toBe("complete");
    });
});

function behavior(fixture: ReturnType<typeof makeEncodedFileFixture>): NativeProjectEncodedFileProviderBehavior {
    const { profile, outputContract } = makeNativeProjectEncodedFileContractParts(fixture.support.renderContractDeclaration);
    return {
        adapterId: fixture.provider.adapterId,
        adapterVersion: fixture.provider.version,
        profile,
        profileConstraintFingerprint: outputContract.materializationProfiles[0]!.profileConstraintFingerprint,
        targetContextSchema: fixture.support.targetContextSchema,
        materializerCapability: fixture.support.materializerCapability,
        outputContract,
        validatePath: (path) => path === ENCODED_TARGET_PATH,
        decodeNativeFile: decodeEncodedNativeFile,
        rebaseMaterializer: encodedRebaseMaterializer,
    };
}

function currentNative(fixture: ReturnType<typeof makeEncodedFileFixture>) {
    const native = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
    if (native.inputKind !== "native_representation") throw new Error("native fixture is missing");
    return native;
}

function makeSecondAsset(fixture: ReturnType<typeof makeEncodedFileFixture>, relativePath: PosixRelativePath) {
    const asset = structuredClone(fixture.analysisInput.deployment.assets[0]!);
    asset.version.ref = { assetId: OTHER_ASSET, versionId: OTHER_VERSION };
    const group = structuredClone(fixture.analysisInput.dialectInputs[0]!);
    group.targetVersion = { assetId: OTHER_ASSET, versionId: OTHER_VERSION };
    const native = group.inputs[0]!;
    if (native.inputKind !== "native_representation") throw new Error("native fixture is missing");
    native.files[0]!.relativePath = relativePath;
    return { asset, group };
}
