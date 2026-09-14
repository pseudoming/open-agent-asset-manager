/** Core fail-closed tests for bounded JSONC container-fragment materialization. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MaterializedRenderFile } from "../../src/contracts/render";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { resolveDeploymentContainerPatches } from "../../src/deployment/deployment-container-patch";
import { computeRenderSelectionFingerprint } from "../../src/foundation/fingerprint";
import { replaceJsoncTopLevelPropertyValue } from "../../src/foundation/jsonc-top-level-property";
import { makeNativeProjectExactGraphContractParts } from "../../src/render/native-project-exact-graph";
import type { CoreRenderMaterializationView } from "../../src/render/render-materialization";
import { materializeRenderDeployment, renderMaterializationInternalsForTest } from "../../src/render/render-materialization";
import {
    GRAPH_BINARY_RESOURCE_PATH,
    exactGraphMaterializationInput,
    makeExactGraphFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";

const physicalReads = vi.hoisted(() => vi.fn());
vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        readRegularFileNoFollow: (...args: Parameters<typeof actual.readRegularFileNoFollow>) => {
            physicalReads(...args);
            return actual.readRegularFileNoFollow(...args);
        },
    };
});

describe("native project exact-graph container patches", () => {
    it("reads each live container once and observes independent later edits during fresh materialization", async () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-jsonc-fresh-target-"));
        try {
            const fixture = makeExactGraphFixture({
                jsoncTopLevelPropertyPatch: jsoncPatchDeclaration(),
                targetRootPath: targetRoot,
            });
            const file = path.join(targetRoot, GRAPH_BINARY_RESOURCE_PATH);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const original = '{"instructions":["old.md"],"theme":"warm"}\n';
            fs.writeFileSync(file, original);
            physicalReads.mockClear();
            const first = await coreMaterializeExactGraph(fixture);
            expect(first.status).toBe("complete");
            const content = (result: typeof first) =>
                result.value.units[0]!.files.find((entry) => entry.relativePath === GRAPH_BINARY_RESOURCE_PATH)!.content;
            expect(JSON.stringify(content(first))).toContain("binary");
            expect(physicalReads.mock.calls.filter(([filePath]) => filePath === file)).toHaveLength(1);
            const changed = original.replace("warm", "cool");
            fs.writeFileSync(file, changed);
            const second = await coreMaterializeExactGraph(fixture);
            expect(second.status).toBe("complete");
            expect(content(second)).not.toEqual(content(first));
            expect(content(second)).toEqual({
                contentKind: "binary",
                bytes: replaceJsoncTopLevelPropertyValue(Buffer.from(changed), "instructions", fixture.patchBytes!),
            });
            expect(physicalReads.mock.calls.filter(([filePath]) => filePath === file)).toHaveLength(2);
            expect(fs.readFileSync(file, "utf8")).toBe(changed);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it("patches only one declared live JSONC property and fails closed on unavailable container authority", async () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-jsonc-graph-target-"));
        try {
            const fixture = makeExactGraphFixture({
                jsoncTopLevelPropertyPatch: jsoncPatchDeclaration(),
                targetRootPath: targetRoot,
            });
            const containerPath = path.join(targetRoot, GRAPH_BINARY_RESOURCE_PATH);
            fs.mkdirSync(path.dirname(containerPath), { recursive: true });
            const original = new TextEncoder().encode(
                '{\n  "provider": { "token": "SECRET_MUST_STAY_OUT" },\n  "instructions": ["old.md"],\n  "theme": "warm"\n}\n',
            );
            fs.writeFileSync(containerPath, original);

            const providerInput = exactGraphMaterializationInput(fixture);
            const providerResult = fixture.support.materialize(providerInput);
            expect(providerResult).toMatchObject({ status: "complete", materializationState: "materialized" });
            expect(JSON.stringify(providerResult)).not.toContain("SECRET_MUST_STAY_OUT");
            if (providerResult.materializationState !== "materialized") throw new Error("patch fixture did not materialize");
            expect(
                providerResult.materializedUnits[0]!.files.find((file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH),
            ).toMatchObject({
                content: { contentKind: "binary", bytes: fixture.patchBytes },
                containerPatch: { patchKind: "jsonc_top_level_property_value", propertyName: "instructions" },
            });

            const materialized = await coreMaterializeExactGraph(fixture);
            expect(materialized.status).toBe("complete");
            const resolved = materialized.value.units[0]?.files.find((file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH);
            expect(resolved?.content.contentKind).toBe("binary");
            if (resolved?.content.contentKind !== "binary" || fixture.patchBytes === undefined) {
                throw new Error("resolved JSONC fixture is missing");
            }
            expect(resolved.content.bytes).toEqual(
                replaceJsoncTopLevelPropertyValue(original, "instructions", fixture.patchBytes),
            );
            expect(new TextDecoder().decode(resolved.content.bytes)).toContain("SECRET_MUST_STAY_OUT");

            const forgedContent = {
                units: [
                    {
                        files: [
                            {
                                relativePath: GRAPH_BINARY_RESOURCE_PATH,
                                content: { contentKind: "text", text: "[]" },
                                executable: false,
                                containerPatch: {
                                    patchKind: "jsonc_top_level_property_value",
                                    propertyName: "instructions",
                                },
                            },
                        ],
                    },
                ],
            } as unknown as CoreRenderMaterializationView;
            expect(resolveDeploymentContainerPatches(forgedContent, targetRoot).diagnostics[0]?.code).toBe(
                "render.materialization_container_patch_rejected",
            );

            const nonCloneable = {
                units: [],
                testOnlyNonCloneable: () => undefined,
            } as unknown as CoreRenderMaterializationView;
            expect(resolveDeploymentContainerPatches(nonCloneable, targetRoot)).toMatchObject({
                status: "failed",
                diagnostics: [
                    {
                        code: "render.materialization_container_patch_internal_error",
                        causeKind: "internal_error",
                        retryable: false,
                    },
                ],
            });

            fs.rmSync(containerPath);
            const created = await coreMaterializeExactGraph(fixture);
            expect(created.status).toBe("complete");
            const createdFile = created.value.units[0]?.files.find((file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH);
            expect(createdFile?.content.contentKind === "binary" ? new TextDecoder().decode(createdFile.content.bytes) : "").toBe(
                '{\n  "instructions": ["resources/marker.txt"]\n}\n',
            );

            fs.writeFileSync(containerPath, "{}\n");
            expect((await coreMaterializeExactGraph(fixture)).diagnostics[0]?.code).toBe(
                "render.materialization_container_patch_rejected",
            );

            fs.writeFileSync(containerPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
            expect((await coreMaterializeExactGraph(fixture)).diagnostics[0]?.code).toBe(
                "render.materialization_container_patch_limit",
            );

            fs.rmSync(containerPath);
            fs.mkdirSync(containerPath);
            expect((await coreMaterializeExactGraph(fixture)).diagnostics[0]?.code).toBe(
                "render.materialization_container_patch_target_unavailable",
            );
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it("rejects forged or incomplete Provider JSONC patch receipts before live target access", () => {
        const fixture = makeExactGraphFixture({ jsoncTopLevelPropertyPatch: jsoncPatchDeclaration() });
        const input = exactGraphMaterializationInput(fixture);
        const result = fixture.support.materialize(input);
        if (result.materializationState !== "materialized") throw new Error("patch receipt fixture did not materialize");
        const outputUnit = input.selection.outputUnits[0]!;
        const files = result.materializedUnits[0]!.files;
        const refs = fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint);
        const validate = (
            candidateFiles: readonly MaterializedRenderFile[],
            candidateUnit = outputUnit,
            declaration: Parameters<
                typeof renderMaterializationInternalsForTest.validateMaterializedFiles
            >[4] = jsoncPatchDeclaration(),
        ) =>
            renderMaterializationInternalsForTest.validateMaterializedFiles(
                candidateFiles,
                candidateUnit,
                refs,
                fixture.deployment,
                declaration,
            );
        expect(validate(files)).toHaveLength(3);
        expect(() =>
            renderMaterializationInternalsForTest.validateMaterializedFiles(
                files,
                outputUnit,
                refs,
                fixture.deployment,
                undefined,
            ),
        ).toThrow(/absent from or outside/);

        for (const mutate of [
            (changed: MaterializedRenderFile[]) => {
                changed.find((file) => file.containerPatch !== undefined)!.containerPatch!.patchKind = "foreign" as never;
            },
            (changed: MaterializedRenderFile[]) => {
                changed.find((file) => file.containerPatch !== undefined)!.containerPatch!.propertyName = "foreign";
            },
        ]) {
            const changed = structuredClone(files);
            mutate(changed);
            expect(() => validate(changed)).toThrow(/absent from or outside/);
        }

        const wrongPathDeclaration = { propertyName: "instructions", allowedContainerRelativePaths: ["other.jsonc"] };
        expect(() => validate(files, outputUnit, wrongPathDeclaration)).toThrow(/absent from or outside/);

        const textFiles = structuredClone(files);
        const textUnit = structuredClone(outputUnit);
        const textPatch = textFiles.find((file) => file.containerPatch !== undefined)!;
        textPatch.content = { contentKind: "text", text: "[]" };
        textUnit.claims.find((claim) => claim.relativePath === textPatch.relativePath)!.contentKind = "text";
        expect(() => validate(textFiles, textUnit)).toThrow(/absent from or outside/);

        const executableFiles = structuredClone(files);
        const executableUnit = structuredClone(outputUnit);
        const executablePatch = executableFiles.find((file) => file.containerPatch !== undefined)!;
        executablePatch.executable = true;
        executableUnit.claims.find((claim) => claim.relativePath === executablePatch.relativePath)!.executable = true;
        expect(() => validate(executableFiles, executableUnit)).toThrow(/absent from or outside/);

        const boundFiles = structuredClone(files);
        boundFiles.find((file) => file.containerPatch !== undefined)!.sectionBindings = [
            { sectionHandle: "unused", semanticRefFingerprints: [refs[0]!] },
        ];
        expect(() => validate(boundFiles)).toThrow(/absent from or outside/);

        const missingReceipt = structuredClone(files);
        delete missingReceipt.find((file) => file.containerPatch !== undefined)!.containerPatch;
        expect(() => validate(missingReceipt)).toThrow(/patch closure is not exact/);
    });

    it("rejects malformed Provider JSONC patch declarations", () => {
        const fixture = makeExactGraphFixture({ jsoncTopLevelPropertyPatch: jsoncPatchDeclaration() });
        for (const patch of [
            { propertyName: "", allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH] },
            { propertyName: " instructions", allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH] },
            { propertyName: "instructions\0", allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH] },
            { propertyName: "instructions", allowedContainerRelativePaths: [] },
            {
                propertyName: "instructions",
                allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH, GRAPH_BINARY_RESOURCE_PATH],
            },
            { propertyName: "instructions", allowedContainerRelativePaths: ["../escape.jsonc"] },
            { propertyName: "instructions", allowedContainerRelativePaths: ["z.jsonc", "a.jsonc"] },
        ] as const) {
            const declaration = structuredClone(fixture.support.renderContractDeclaration);
            declaration.jsoncTopLevelPropertyPatch = patch as never;
            expect(() => makeNativeProjectExactGraphContractParts(declaration)).toThrow(/JSONC property patch declaration/);
        }
        const nonArray = structuredClone(fixture.support.renderContractDeclaration);
        nonArray.jsoncTopLevelPropertyPatch = {
            propertyName: "instructions",
            allowedContainerRelativePaths: null,
        } as never;
        expect(() => makeNativeProjectExactGraphContractParts(nonArray)).toThrow(/JSONC property patch declaration/);
    });
});

function jsoncPatchDeclaration() {
    return {
        propertyName: "instructions",
        allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH],
    } as const;
}

async function coreMaterializeExactGraph(fixture: ReturnType<typeof makeExactGraphFixture>) {
    const analysis = fixture.support.analyze(fixture.analysisInput);
    if (analysis.status !== "complete") throw new Error("exact graph patch analysis did not close");
    const providerSelection = exactGraphMaterializationInput(fixture).selection;
    const selectionPreimage = {
        schemaVersion: 1 as const,
        compilerPolicyVersion: "core_render_policy_v1" as const,
        renderInputFingerprint: fixture.deployment.renderInputFingerprint,
        semanticOptions: providerSelection.semanticOptions.map((option) => ({
            ...option,
            consumerOwnerAdapterId: fixture.provider.adapterId,
            consumerOwnerAdapterVersion: fixture.provider.version,
            approval: { approvalState: "not_required" as const },
        })),
        outputUnits: providerSelection.outputUnits,
        outputUnitRenderers: providerSelection.outputUnitRenderers,
        promotionAuthorizations: [],
    };
    const selection = {
        ...selectionPreimage,
        selectionFingerprint: computeRenderSelectionFingerprint(selectionPreimage),
    };
    const materialized = await materializeRenderDeployment(
        {
            deployment: fixture.deployment,
            analysis: {
                renderInputFingerprint: fixture.deployment.renderInputFingerprint,
                requiredSemantics: fixture.requiredSemantics,
                analyses: [{ ...analysis, adapterId: fixture.provider.adapterId, adapterVersion: fixture.provider.version }],
            },
            selection,
        },
        {
            registry: fixture.registry,
            dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect], [], [], []),
            resolveDialectInputs: () => structuredClone(fixture.analysisInput.dialectInputs),
            dispatch: async (_adapterId, input) => ({
                status: "complete" as const,
                value: fixture.support.materialize(input),
                diagnostics: [],
            }),
        },
    );
    if (materialized.status !== "complete") return materialized;
    return resolveDeploymentContainerPatches(materialized.value, fixture.deployment.targetRootPath);
}
