/** Fail-closed dispatch, lineage, change and runtime-authority guards for exact graph reverse. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import {
    deploymentLifecycleExactGraphInternalsForTest,
    rebuildExactGraphNativeDialectAuthority,
    tryBuildExactGraphStagedReverseVersionContent,
} from "../../src/orchestration/deployment-lifecycle-exact-graph";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import type { UuidV4 } from "../../src/types";
import { ASSET_ID, FILE_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import {
    GRAPH_BINARY_RESOURCE_PATH,
    GRAPH_BOUNDARY,
    GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
    GRAPH_DIALECT_ID,
    GRAPH_ENTRY_PATH,
    GRAPH_HASH,
    graphCanonicalMaterializer,
} from "../render/fixtures/native-project-exact-graph-test-fixtures";
import { graphStagingInvocation, makePublishedGraphParent } from "./fixtures/deployment-lifecycle-exact-graph-test-fixtures";

describe("deployment lifecycle exact-graph guards", () => {
    it("reconstructs one applied canonical migration as exact target-dialect reverse authority", () => {
        const published = makePublishedGraphParent({ canonicalMaterializer: graphCanonicalMaterializer });
        try {
            const invocation = graphStagingInvocation(published);
            const staged = stage(invocation);
            expect(staged.nativeRepresentations).toHaveLength(1);
            expect(staged.nativeRepresentations[0]).toMatchObject({ dialectId: GRAPH_DIALECT_ID });
            expect(staged.nativePayloads).toHaveLength(1);
            expect(staged.nativePayloads[0]?.files).toHaveLength(3);
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("rejects incomplete or contradictory applied canonical migration authority", () => {
        const published = makePublishedGraphParent({ canonicalMaterializer: graphCanonicalMaterializer });
        try {
            const cases: Array<(value: ReturnType<typeof canonicalGraphAuthorityCandidate>) => void> = [
                ({ inspected }) => void (inspected.appliedRenderSnapshot.outputUnits = []),
                (value) => {
                    value.registry = createVersionDialectRegistry([], [], [published.portableEntry], []);
                },
                ({ canonicalInput }) => void (canonicalInput.nativeDialectId = "foreign-skill-graph-v1"),
                ({ inspected }) => void (inspected.appliedRenderSnapshot.outputUnits[0]!.claims = []),
                ({ inspected }) => {
                    const claims = inspected.appliedRenderSnapshot.outputUnits[0]!.claims;
                    claims.push(structuredClone(claims[0]!));
                },
                ({ inspected }) => {
                    const states = inspected.input.inspectionScope.fileStates;
                    states.push(structuredClone(states[0]!));
                },
                ({ inspected }) => {
                    const authority = inspected.runtimeReplacementAuthority.files;
                    authority.push(structuredClone(authority[0]!));
                },
                ({ inspected }) => void inspected.input.inspectionScope.fileStates.pop(),
                ({ inspected }) => void inspected.runtimeReplacementAuthority.files.pop(),
                ({ inspected }) => void (inspected.input.inspectionScope.fileStates[0]!.relativePath = "foreign.txt" as never),
                ({ inspected }) => void (inspected.input.inspectionScope.fileStates[0]!.state = "missing" as never),
                ({ inspected }) => void (inspected.input.inspectionScope.fileStates[0]!.state = "added" as never),
                ({ inspected }) => {
                    inspected.runtimeReplacementAuthority.files[0] = {
                        relativePath: inspected.runtimeReplacementAuthority.files[0]!.relativePath,
                        expectedState: "missing",
                    };
                },
                ({ inspected }) => {
                    const claim = inspected.appliedRenderSnapshot.outputUnits[0]!.claims[0]!;
                    claim.executable = !claim.executable;
                },
                ({ inspected }) => {
                    const relativePath = inspected.input.inspectionScope.fileStates[0]!.relativePath;
                    inspected.input.files = inspected.input.files.filter((file) => file.relativePath !== relativePath);
                },
                ({ inspected }) => void (inspected.input.inspectionScope.fileStates[0]!.state = "unchanged" as never),
                ({ inspected }) => {
                    const claim = inspected.appliedRenderSnapshot.outputUnits[0]!.claims[0]!;
                    claim.contentKind = claim.contentKind === "text" ? "binary" : "text";
                },
                ({ inspected }) =>
                    void (inspected.input.inspectionScope.fileStates[0]!.appliedContentHash = `sha256:${"9".repeat(64)}`),
                ({ inspected }) => {
                    const changed = inspected.input.files.find((file) => file.appliedContent.contentKind === "text")!;
                    if (changed.appliedContent.contentKind !== "text") throw new Error("text applied fixture is missing");
                    const state = inspected.input.inspectionScope.fileStates.find(
                        (candidate) => candidate.relativePath === changed.relativePath,
                    )!;
                    const authority = inspected.runtimeReplacementAuthority.files.find(
                        (candidate) => candidate.relativePath === changed.relativePath,
                    );
                    if (authority?.expectedState !== "present") throw new Error("text runtime authority fixture is missing");
                    const noncanonicalBytes = Buffer.from(changed.appliedContent.text.replaceAll("\n", "\r\n"));
                    state.state = "unchanged";
                    state.appliedContentHash = binaryPayloadStats(noncanonicalBytes).contentHash;
                    authority.expectedBytes = new Uint8Array(noncanonicalBytes);
                    inspected.input.files = inspected.input.files.filter((file) => file.relativePath !== changed.relativePath);
                },
                (value) => {
                    value.registry = createVersionDialectRegistry(
                        [{ ...published.fixture.nativeDialect, validateSameContent: () => false }],
                        [published.foreignRestoration],
                        [published.portableEntry],
                        [],
                    );
                },
            ];
            for (const mutate of cases) {
                const candidate = canonicalGraphAuthorityCandidate(published);
                mutate(candidate);
                expect(
                    deploymentLifecycleExactGraphInternalsForTest.reconstructAppliedCanonicalNativeInput(candidate),
                ).toBeNull();
            }

            const unchanged = canonicalGraphAuthorityCandidate(published);
            const unchangedFile = unchanged.inspected.input.files[0]!;
            const unchangedState = unchanged.inspected.input.inspectionScope.fileStates.find(
                (state) => state.relativePath === unchangedFile.relativePath,
            )!;
            const unchangedAuthority = unchanged.inspected.runtimeReplacementAuthority.files.find(
                (file) => file.relativePath === unchangedFile.relativePath,
            );
            if (unchangedFile.appliedContent.contentKind !== "text" || unchangedAuthority?.expectedState !== "present") {
                throw new Error("unchanged text authority fixture is missing");
            }
            unchangedState.state = "unchanged";
            unchangedState.currentContentHash = unchangedState.appliedContentHash;
            unchangedAuthority.expectedBytes = new Uint8Array(Buffer.from(unchangedFile.appliedContent.text));
            unchanged.inspected.input.files = unchanged.inspected.input.files.filter(
                (file) => file.relativePath !== unchangedFile.relativePath,
            );
            expect(
                deploymentLifecycleExactGraphInternalsForTest.reconstructAppliedCanonicalNativeInput(unchanged),
            ).not.toBeNull();

            const rejectedAppliedInput = graphStagingInvocation(published);
            rejectedAppliedInput.inspected.appliedRenderSnapshot.outputUnits[0]!.claims = [];
            expect(() =>
                deploymentLifecycleExactGraphInternalsForTest.resolveAppliedNativeInput(
                    canonicalResolutionCandidate(published, rejectedAppliedInput),
                ),
            ).toThrow(/no unique applied target-dialect input/);
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("fails closed for inventory, ownership, lineage, parent, change and dispatch drift", () => {
        const published = makePublishedGraphParent();
        try {
            const cases: Array<{
                expected: RegExp;
                mutate(value: ReturnType<typeof graphStagingInvocation>): void;
            }> = [
                { expected: /one unique applied Asset/, mutate: ({ base }) => void (base.assets = []) },
                {
                    expected: /one unique applied Asset/,
                    mutate: ({ base }) => void (base.appliedInputsSnapshot.assets = []),
                },
                {
                    expected: /one unique applied Asset/,
                    mutate: ({ inspected }) => void (inspected.appliedRenderSnapshot.decisions = []),
                },
                {
                    expected: /semantic no longer matches/,
                    mutate: ({ base }) => {
                        base.assets[0]!.version.canonical = {
                            kind: "Workflow",
                            typeData: { schemaVersion: 1, invocation: { mode: "manual" } },
                        } as never;
                    },
                },
                {
                    expected: /existing-file content or executable changes/,
                    mutate: ({ inspected }) => void inspected.input.inventoryDeltas.push({} as never),
                },
                {
                    expected: /existing-file content or executable changes/,
                    mutate: ({ inspected }) => {
                        inspected.result.files[0] = {
                            relativePath: GRAPH_ENTRY_PATH,
                            attributionState: "conflict",
                            reasonCode: "fixture",
                            diagnostics: [],
                        };
                    },
                },
                {
                    expected: /existing-file content or executable changes/,
                    mutate: ({ inspected }) => void (inspected.result.changes = []),
                },
                {
                    expected: /no unique applied target-dialect input/,
                    mutate: ({ inspected }) => void (inspected.operation.dialectInputs = []),
                },
                {
                    expected: /immediate Version lineage/,
                    mutate: ({ inspected }) => {
                        const native = inspected.operation.dialectInputs[0]!.inputs[0]!;
                        if (native.inputKind === "native_representation") {
                            native.representation.canonicalContentFingerprint = GRAPH_HASH;
                        }
                    },
                },
                {
                    expected: /ambiguous, duplicated, or outside/,
                    mutate: ({ inspected }) => {
                        const change = findContentChange(inspected);
                        inspected.result.changes.push(structuredClone(change));
                    },
                },
                {
                    expected: /ambiguous, duplicated, or outside/,
                    mutate: ({ inspected }) => void (findContentChange(inspected).semanticRefFingerprints = []),
                },
                {
                    expected: /ambiguous, duplicated, or outside/,
                    mutate: ({ inspected }) => {
                        findContentChange(inspected).semanticRefFingerprints = [
                            inspected.appliedRenderSnapshot.decisions.find(
                                (decision) => decision.semanticRef.subject.subjectKind === "asset",
                            )!.semanticRef.semanticRefFingerprint,
                        ];
                    },
                },
                {
                    expected: /ambiguous, duplicated, or outside/,
                    mutate: ({ inspected }) => {
                        findContentChange(inspected).replacementContent = {
                            contentKind: "binary",
                            bytes: new Uint8Array([1]),
                        };
                    },
                },
                {
                    expected: /complete canonical graph/,
                    mutate: ({ inspected }) => {
                        findEntryContentChange(inspected).replacementContent = { contentKind: "text", text: "\n" };
                    },
                },
                {
                    expected: /parent Version is missing/,
                    mutate: ({ configuration }) => {
                        configuration.render.assetsRoot = path.join(published.assetsRoot, "missing-assets");
                    },
                },
                {
                    expected: /parent Version is missing/,
                    mutate: ({ base }) => void (base.assets[0]!.version.versionFingerprint = GRAPH_HASH),
                },
                {
                    expected: /native dialect contract rejected/,
                    mutate: ({ configuration }) => {
                        configuration.render.dialectRegistry = createVersionDialectRegistry(
                            [{ ...published.fixture.nativeDialect, validateSameContent: () => false }],
                            [published.foreignRestoration],
                            [published.portableEntry],
                            [],
                        );
                    },
                },
            ];
            for (const { expected, mutate } of cases) {
                const value = graphStagingInvocation(published);
                mutate(value);
                expect(() => stage(value)).toThrow(expected);
            }

            const contentOutsideGraph = graphStagingInvocation(published);
            const decisions = structuredClone(contentOutsideGraph.inspected.appliedRenderSnapshot.decisions);
            const contentChange = findContentChange(contentOutsideGraph.inspected);
            const decision = decisions.find(
                (candidate) =>
                    candidate.semanticRef.semanticRefFingerprint === contentChange.semanticRefFingerprints[0] &&
                    candidate.semanticRef.subject.subjectKind === "file",
            );
            if (decision?.semanticRef.subject.subjectKind !== "file") throw new Error("file decision fixture is missing");
            decision.semanticRef.subject.fileId = ASSET_ID;
            expect(() =>
                deploymentLifecycleExactGraphInternalsForTest.applyCanonicalChanges(published.closure, decisions, [
                    contentChange,
                ]),
            ).toThrow(/ambiguous, duplicated, or outside/);

            const executableOutsideGraph = graphStagingInvocation(published);
            const executableChange = structuredClone(findExecutableChange(executableOutsideGraph.inspected));
            executableChange.fileId = ASSET_ID;
            expect(() =>
                deploymentLifecycleExactGraphInternalsForTest.applyCanonicalChanges(
                    published.closure,
                    executableOutsideGraph.inspected.appliedRenderSnapshot.decisions,
                    [executableChange],
                ),
            ).toThrow(/ambiguous, duplicated, or outside/);

            const noScope = graphStagingInvocation(published);
            noScope.inspected.input.inspectionScope = undefined as never;
            expect(tryStage(noScope)).toBeNull();

            for (const mutate of [
                (value: ReturnType<typeof graphStagingInvocation>) => void (value.inspected.input.files = []),
                (value: ReturnType<typeof graphStagingInvocation>) => {
                    value.inspected.input.inspectionScope.fileStates[0]!.outputUnitFingerprint = GRAPH_HASH;
                },
                (value: ReturnType<typeof graphStagingInvocation>) =>
                    void (value.inspected.appliedRenderSnapshot.outputUnits = []),
                (value: ReturnType<typeof graphStagingInvocation>) =>
                    void (value.inspected.appliedRenderSnapshot.outputUnitRenderers = []),
                (value: ReturnType<typeof graphStagingInvocation>) =>
                    void (value.inspected.operation.registry = { getProvider: () => null } as never),
                (value: ReturnType<typeof graphStagingInvocation>) => {
                    const provider = published.fixture.registry.getProvider(published.fixture.provider.adapterId)!;
                    value.inspected.operation.registry = {
                        getProvider: () => ({ ...provider, renderContractDeclarations: [] }),
                    } as never;
                },
            ]) {
                const value = graphStagingInvocation(published);
                mutate(value);
                expect(tryStage(value)).toBeNull();
            }

            const duplicate = graphStagingInvocation(published);
            const provider = published.fixture.registry.getProvider(published.fixture.provider.adapterId)!;
            duplicate.inspected.operation.registry = {
                getProvider: () => ({
                    ...provider,
                    renderContractDeclarations: [
                        ...provider.renderContractDeclarations,
                        structuredClone(provider.renderContractDeclarations[0]!),
                    ],
                }),
            } as never;
            expect(() => tryStage(duplicate)).toThrow(/no unique Applied renderer declaration/);
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("rejects missing native contracts and every incomplete runtime graph authority", () => {
        const published = makePublishedGraphParent();
        try {
            const invocation = graphStagingInvocation(published);
            const nativeInput = invocation.inspected.operation.dialectInputs[0]!.inputs[0]!;
            if (nativeInput.inputKind !== "native_representation") throw new Error("native graph input is missing");
            const valid = {
                inspected: invocation.inspected,
                nativeInput,
                canonical: published.fixture.canonical,
                files: published.fixture.closure.files,
                nativeDialectId: GRAPH_DIALECT_ID,
                versionCanonicalContentFingerprint: published.closure.manifest.versionCanonicalContentFingerprint,
                registry: published.versionRegistry,
            };
            const v2 = {
                ...valid,
                nativeInput: structuredClone(valid.nativeInput),
                registry: createVersionDialectRegistry(
                    [{ ...published.fixture.nativeDialect, validateSameContent: () => true }],
                    [published.foreignRestoration],
                    [published.portableEntry],
                    [],
                ),
            };
            v2.nativeInput.representation = {
                ...v2.nativeInput.representation,
                schemaVersion: 2,
                directories: [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`, `${GRAPH_BOUNDARY}/resources`],
            };
            expect(rebuildExactGraphNativeDialectAuthority(v2).nativeRepresentations[0]).toEqual(
                expect.objectContaining({
                    schemaVersion: 2,
                    directories: [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`, `${GRAPH_BOUNDARY}/resources`],
                }),
            );
            expect(() =>
                rebuildExactGraphNativeDialectAuthority({
                    ...valid,
                    registry: createVersionDialectRegistry([], [], [published.portableEntry], []),
                }),
            ).toThrow(/validator rejected/);

            const withSiblingOutputUnit = graphStagingInvocation(published);
            const siblingAuthority = structuredClone(requirePresentAuthority(withSiblingOutputUnit.inspected, 0));
            siblingAuthority.relativePath = "sibling/entry.md";
            withSiblingOutputUnit.inspected.runtimeReplacementAuthority.files.push(siblingAuthority);
            const siblingState = structuredClone(withSiblingOutputUnit.inspected.input.inspectionScope.fileStates[0]!);
            siblingState.relativePath = "sibling/entry.md" as never;
            siblingState.outputUnitFingerprint = `sha256:${"7".repeat(64)}`;
            withSiblingOutputUnit.inspected.input.inspectionScope.fileStates.push(siblingState);
            expect(tryStage(withSiblingOutputUnit)?.nativeRepresentations).toHaveLength(1);

            const authorityCases: Array<(value: typeof valid) => void> = [
                ({ inspected }) =>
                    void inspected.runtimeReplacementAuthority.files.push({
                        relativePath: "foreign.txt",
                        expectedState: "missing",
                    }),
                ({ inspected }) => void (inspected.runtimeReplacementAuthority.files[0]!.relativePath = "foreign.txt"),
                ({ inspected }) => {
                    inspected.runtimeReplacementAuthority.files[0] = {
                        relativePath: inspected.runtimeReplacementAuthority.files[0]!.relativePath,
                        expectedState: "missing",
                    };
                },
                ({ inspected }) => void (inspected.input.inspectionScope.fileStates[0]!.relativePath = "foreign.txt" as never),
                ({ inspected }) => {
                    inspected.input.inspectionScope.fileStates[0] = {
                        relativePath: inspected.input.inspectionScope.fileStates[0]!.relativePath,
                        state: "missing",
                        appliedContentHash: GRAPH_HASH,
                        appliedExecutable: false,
                        outputUnitFingerprint: GRAPH_HASH,
                        provenanceFingerprint: GRAPH_HASH,
                    };
                },
                ({ inspected }) => {
                    const authority = requirePresentAuthority(inspected, 0);
                    authority.expectedBytes = new Uint8Array([1]);
                },
                ({ inspected }) => {
                    const authority = requirePresentAuthority(inspected, 0);
                    authority.expectedExecutable = !authority.expectedExecutable;
                },
                ({ inspected }) => {
                    const authority = inspected.runtimeReplacementAuthority.files.find(
                        (file) => file.relativePath === GRAPH_ENTRY_PATH,
                    );
                    const state = inspected.input.inspectionScope.fileStates.find(
                        (file) => file.relativePath === GRAPH_ENTRY_PATH,
                    );
                    if (authority?.expectedState !== "present" || state === undefined || state.state === "missing") {
                        throw new Error("text authority fixture is missing");
                    }
                    authority.expectedBytes = new Uint8Array(
                        Buffer.from(GRAPH_CHANGED_NATIVE_ENTRY_TEXT.replaceAll("\n", "\r\n")),
                    );
                    state.currentContentHash = binaryPayloadStats(authority.expectedBytes).contentHash;
                },
            ];
            for (const mutate of authorityCases) {
                const candidate = graphAuthorityCandidate(published);
                mutate(candidate);
                expect(() => rebuildExactGraphNativeDialectAuthority(candidate)).toThrow(/ambiguous, duplicated, or outside/);
            }
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("rebuilds only a declared JSONC fragment and rejects missing or non-binary patch authority", () => {
        const published = makePublishedGraphParent();
        const fragment = new TextEncoder().encode('["resources/marker.txt"]');
        const container = new TextEncoder().encode('{"secret":"keep","instructions":["resources/marker.txt"],"theme":"warm"}');
        try {
            const candidateFor = (containerBytes: Uint8Array) => {
                const candidate = graphAuthorityCandidate(published);
                const native = candidate.nativeInput.files.find((file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH);
                const canonical = candidate.files.find((file) => file.file.logicalPath === "resources/tool.bin");
                const authority = candidate.inspected.runtimeReplacementAuthority.files.find(
                    (file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH,
                );
                const state = candidate.inspected.input.inspectionScope.fileStates.find(
                    (file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH,
                );
                if (
                    native?.contentKind !== "binary" ||
                    canonical?.contentKind !== "binary" ||
                    authority?.expectedState !== "present" ||
                    state === undefined ||
                    state.state === "missing"
                ) {
                    throw new Error("JSONC reverse fixture is incomplete");
                }
                const fragmentStats = binaryPayloadStats(fragment);
                native.bytes = new Uint8Array(fragment);
                native.contentHash = fragmentStats.contentHash;
                native.byteSize = fragmentStats.byteSize;
                canonical.bytes = new Uint8Array(fragment);
                canonical.file.contentHash = fragmentStats.contentHash;
                canonical.file.byteSize = fragmentStats.byteSize;
                authority.expectedBytes = new Uint8Array(containerBytes);
                const containerStats = binaryPayloadStats(containerBytes);
                state.currentContentHash = containerStats.contentHash;
                candidate.registry = createVersionDialectRegistry(
                    [{ ...published.fixture.nativeDialect, validateSameContent: () => true }],
                    [published.foreignRestoration],
                    [published.portableEntry],
                    [],
                );
                return { candidate, native, authority, state };
            };
            const valid = candidateFor(container);
            const rebuilt = rebuildExactGraphNativeDialectAuthority({
                ...valid.candidate,
                jsoncTopLevelPropertyPatch: {
                    propertyName: "instructions",
                    allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH],
                },
            });
            expect(
                rebuilt.nativePayloads[0]?.files.find((file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH)?.bytes,
            ).toEqual(fragment);

            const missing = candidateFor(new TextEncoder().encode('{"theme":"warm"}'));
            expect(() =>
                rebuildExactGraphNativeDialectAuthority({
                    ...missing.candidate,
                    jsoncTopLevelPropertyPatch: {
                        propertyName: "instructions",
                        allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH],
                    },
                }),
            ).toThrow(/ambiguous, duplicated, or outside/);

            const textSource = candidateFor(container);
            textSource.native.contentKind = "text" as never;
            expect(() =>
                rebuildExactGraphNativeDialectAuthority({
                    ...textSource.candidate,
                    jsoncTopLevelPropertyPatch: {
                        propertyName: "instructions",
                        allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH],
                    },
                }),
            ).toThrow(/ambiguous, duplicated, or outside/);

            const executable = candidateFor(container);
            executable.authority.expectedExecutable = true;
            executable.state.currentExecutable = true;
            expect(() =>
                rebuildExactGraphNativeDialectAuthority({
                    ...executable.candidate,
                    jsoncTopLevelPropertyPatch: {
                        propertyName: "instructions",
                        allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH],
                    },
                }),
            ).toThrow(/ambiguous, duplicated, or outside/);
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });
});

function stage(value: ReturnType<typeof graphStagingInvocation>) {
    return deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
        value.configuration,
        value.inspected,
        value.base,
        VERSION_ID_2 as UuidV4,
    );
}

function tryStage(value: ReturnType<typeof graphStagingInvocation>) {
    return tryBuildExactGraphStagedReverseVersionContent({
        configuration: value.configuration,
        inspected: value.inspected,
        base: value.base,
        stagedVersionId: VERSION_ID_2 as UuidV4,
    });
}

function findContentChange(inspected: ReturnType<typeof graphStagingInvocation>["inspected"]) {
    const change = inspected.result.changes.find((item) => item.changeKind === "file_content_replacement");
    if (change?.changeKind !== "file_content_replacement") throw new Error("content change fixture is missing");
    return change;
}

function findEntryContentChange(inspected: ReturnType<typeof graphStagingInvocation>["inspected"]) {
    const change = inspected.result.changes.find((item) => {
        if (item.changeKind !== "file_content_replacement") return false;
        return inspected.appliedRenderSnapshot.decisions.some(
            (decision) =>
                decision.semanticRef.semanticRefFingerprint === item.semanticRefFingerprints[0] &&
                decision.semanticRef.subject.subjectKind === "file" &&
                decision.semanticRef.subject.fileId === FILE_ID,
        );
    });
    if (change?.changeKind !== "file_content_replacement") throw new Error("entry change fixture is missing");
    return change;
}

function findExecutableChange(inspected: ReturnType<typeof graphStagingInvocation>["inspected"]) {
    const change = inspected.result.changes.find((item) => item.changeKind === "file_executable_replacement");
    if (change?.changeKind !== "file_executable_replacement") throw new Error("executable change fixture is missing");
    return change;
}

function graphAuthorityCandidate(published: ReturnType<typeof makePublishedGraphParent>) {
    const invocation = graphStagingInvocation(published);
    const nativeInput = invocation.inspected.operation.dialectInputs[0]!.inputs[0]!;
    if (nativeInput.inputKind !== "native_representation") throw new Error("native graph input is missing");
    return {
        inspected: invocation.inspected,
        nativeInput,
        canonical: published.fixture.canonical,
        files: published.fixture.closure.files,
        nativeDialectId: GRAPH_DIALECT_ID,
        versionCanonicalContentFingerprint: published.closure.manifest.versionCanonicalContentFingerprint,
        registry: published.versionRegistry,
    };
}

function canonicalGraphAuthorityCandidate(published: ReturnType<typeof makePublishedGraphParent>) {
    const invocation = graphStagingInvocation(published);
    const canonicalInput = invocation.inspected.operation.dialectInputs[0]!.inputs[0]!;
    const outputUnitFingerprint = invocation.inspected.appliedRenderSnapshot.outputUnits[0]!.outputUnitFingerprint;
    if (canonicalInput.inputKind !== "canonical_materialization") {
        throw new Error("canonical graph input is missing");
    }
    return {
        inspected: invocation.inspected,
        parent: published.closure,
        nativeDialectId: GRAPH_DIALECT_ID,
        outputUnitFingerprint,
        registry: published.versionRegistry,
        canonicalInput,
    };
}

function canonicalResolutionCandidate(
    published: ReturnType<typeof makePublishedGraphParent>,
    invocation: ReturnType<typeof graphStagingInvocation>,
) {
    const owner = invocation.inspected.operation.registry.getProvider(published.fixture.provider.adapterId);
    if (owner === null) throw new Error("canonical graph Provider is missing");
    return {
        inspected: invocation.inspected,
        owner,
        decisions: invocation.inspected.appliedRenderSnapshot.decisions,
        parent: published.closure,
        nativeDialectId: GRAPH_DIALECT_ID,
        outputUnitFingerprint: invocation.inspected.appliedRenderSnapshot.outputUnits[0]!.outputUnitFingerprint,
        registry: published.versionRegistry,
    };
}

function requirePresentAuthority(inspected: ReturnType<typeof graphStagingInvocation>["inspected"], index: number) {
    const authority = inspected.runtimeReplacementAuthority.files[index];
    if (authority?.expectedState !== "present") throw new Error("present authority fixture is missing");
    return authority;
}
