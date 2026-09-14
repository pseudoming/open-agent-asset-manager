/** Authority-focused split from the original oversized Deployment test suite. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { publishInitialAssetVersion } from "../../src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import type { ProviderRenderDialectInputsForAsset } from "../../src/contracts/render";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../src/foundation/fingerprint";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import type { CoreResult, UuidV4 } from "../../src/types";
import {
    ASSET_ID,
    FILE_ID,
    makeAsset,
    makeTextFile,
    makeVersionClosure,
    PROJECT_ID,
    VERSION_ID,
    VERSION_ID_2,
} from "../catalog/fixtures/version-v2";
import { makeNativeDialectContract, nativeDialectFingerprint } from "../source-import/fixtures/dialect-contracts";
import {
    contentChange,
    DEPLOYMENT_ID,
    type Inspected,
    inspectedFor,
    renderBase,
    reverseOrigin,
    SHA_A,
    SHA_B,
    stagedContent,
    TRANSACTION_ID,
} from "./fixtures/deployment-lifecycle-test-fixtures";

describe("deployment lifecycle pure boundary helpers", () => {
    it("accepts exactly one attributable whole-file replacement", () => {
        expect(deploymentLifecycleInternalsForTest.requireOneWholeFileContentChange(inspectedFor())).toEqual(contentChange());
    });

    it("rejects both an invalid change cardinality and invalid attribution semantics", () => {
        const empty = inspectedFor();
        empty.result.changes = [];
        expect(() => deploymentLifecycleInternalsForTest.requireOneWholeFileContentChange(empty)).toThrow(/exactly one/);

        const conflicting = inspectedFor();
        conflicting.result.files[0] = {
            relativePath: "GUIDANCE.md",
            attributionState: "conflict",
            reasonCode: "fixture_conflict",
            diagnostics: [],
        };
        expect(() => deploymentLifecycleInternalsForTest.requireOneWholeFileContentChange(conflicting)).toThrow(/exactly one/);
    });

    it("builds one exact reverse Version and rejects a stale origin join", () => {
        const content = stagedContent();
        const origin = reverseOrigin(content);
        const closure = deploymentLifecycleInternalsForTest.buildStagedVersionClosure(content, origin, DEPLOYMENT_ID);
        expect(closure.manifest).toMatchObject({
            assetId: ASSET_ID,
            versionId: VERSION_ID_2,
            sourceVersionId: VERSION_ID,
            sourceDeploymentId: DEPLOYMENT_ID,
        });
        expect(() =>
            deploymentLifecycleInternalsForTest.buildStagedVersionClosure(
                content,
                { ...origin, previousVersionId: DEPLOYMENT_ID },
                DEPLOYMENT_ID,
            ),
        ).toThrow(/origin no longer matches/);
    });

    it("projects the staged Version into the one-Asset render base", () => {
        const content = stagedContent();
        const base = renderBase();
        const projected = deploymentLifecycleInternalsForTest.projectStagedRenderBase(base, content);
        expect(projected.assets[0]?.version.ref.versionId).toBe(VERSION_ID_2);
        expect(projected.appliedInputsSnapshot.assets[0]?.versionId).toBe(VERSION_ID_2);

        const staleDialect = renderBase();
        staleDialect.dialectInputs = [
            {
                targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                inputs: [],
            },
        ];
        expect(() => deploymentLifecycleInternalsForTest.projectStagedRenderBase(staleDialect, content)).toThrow(
            /one unique parent authority/,
        );
    });

    it("removes only one obsolete immediate-parent rebase seed when the staged Version owns no dialect authority", () => {
        const content = stagedContent();
        const base = renderBase();
        base.dialectInputs = [parentRebaseSeedGroup()];
        const before = structuredClone(base);
        const projected = deploymentLifecycleInternalsForTest.projectStagedRenderBase(base, content);
        expect(projected.dialectInputs).toEqual([]);
        expect(base).toEqual(before);

        const withSibling = renderBase();
        const siblingGroup = parentRebaseSeedGroup();
        siblingGroup.targetVersion.assetId = PROJECT_ID;
        const siblingInput = siblingGroup.inputs[0]!;
        if (siblingInput.inputKind !== "native_representation" || siblingInput.inputRole !== "parent_rebase_seed") {
            throw new Error("parent seed fixture missing");
        }
        siblingInput.sourceVersion.assetId = PROJECT_ID;
        withSibling.dialectInputs = [siblingGroup, parentRebaseSeedGroup()];
        expect(deploymentLifecycleInternalsForTest.projectStagedRenderBase(withSibling, content).dialectInputs).toEqual([
            siblingGroup,
        ]);

        const cases: Array<(value: ReturnType<typeof renderBase>) => void> = [
            (value) => {
                const input = value.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind !== "native_representation") throw new Error("native seed fixture missing");
                input.inputRole = "current_exact" as never;
                delete (input as Partial<typeof input>).sourceVersion;
            },
            (value) => {
                value.dialectInputs[0]!.inputs = [];
            },
            (value) => {
                value.dialectInputs.push(structuredClone(value.dialectInputs[0]!));
            },
            (value) => {
                value.dialectInputs[0]!.inputs = [
                    {
                        inputKind: "dialect_restoration",
                        restoration: {
                            dialectId: "fixture-restoration-v1",
                            restorationContractFingerprint: SHA_A,
                            contentHash: SHA_B,
                        },
                        content: { contentKind: "binary", bytes: Uint8Array.of(1) },
                    },
                ];
            },
            (value) => {
                value.dialectInputs[0]!.targetVersion.versionId = VERSION_ID_2;
            },
            (value) => {
                const input = value.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind !== "native_representation" || input.inputRole !== "parent_rebase_seed") {
                    throw new Error("parent seed fixture missing");
                }
                input.sourceVersion.assetId = PROJECT_ID;
            },
            (value) => {
                const input = value.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind !== "native_representation" || input.inputRole !== "parent_rebase_seed") {
                    throw new Error("parent seed fixture missing");
                }
                input.sourceVersion.versionId = VERSION_ID;
            },
            (value) => {
                const first = value.dialectInputs[0]!.inputs[0]!;
                if (first.inputKind !== "native_representation" || first.inputRole !== "parent_rebase_seed") {
                    throw new Error("parent seed fixture missing");
                }
                value.dialectInputs[0]!.inputs.push({
                    ...structuredClone(first),
                    sourceVersion: { assetId: ASSET_ID, versionId: VERSION_ID_2 },
                });
            },
        ];
        for (const mutate of cases) {
            const stale = renderBase();
            stale.dialectInputs = [parentRebaseSeedGroup()];
            mutate(stale);
            expect(() => deploymentLifecycleInternalsForTest.projectStagedRenderBase(stale, content)).toThrow(
                /one unique parent authority/,
            );
        }
    });

    it("stages one exact Guidance change from the persisted parent authority", () => {
        const assetsRoot = path.join(os.tmpdir(), `oaam-stage-content-${process.pid}-${Date.now()}`);
        try {
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-stage-content",
                asset: makeAsset([VERSION_ID], {
                    scope: "project",
                    projectId: PROJECT_ID,
                    scopePath: "",
                }),
                version: makeVersionClosure({ files: [makeTextFile("# old\n", "GUIDANCE.md")] }),
                dialectRegistry: createVersionDialectRegistry([], [], [], []),
            });
            const inspected = inspectedFor() as Inspected & {
                appliedRenderSnapshot: { decisions: unknown[] };
            };
            inspected.appliedRenderSnapshot = {
                decisions: [
                    {
                        semanticRef: {
                            semanticRefFingerprint: SHA_B,
                            semanticKind: "guidance.content",
                            consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                            subject: {
                                subjectKind: "file",
                                assetId: ASSET_ID,
                                versionId: VERSION_ID,
                                fileId: FILE_ID,
                            },
                        },
                    },
                ],
            };
            const configuration = {
                render: {
                    assetsRoot,
                    dialectRegistry: createVersionDialectRegistry([], [], [], []),
                },
            } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[0];
            const staged = deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                configuration,
                inspected,
                renderBase(),
                VERSION_ID_2 as UuidV4,
            );
            expect(staged).toMatchObject({
                assetId: ASSET_ID,
                versionId: VERSION_ID_2,
                revision: 2,
                files: [{ text: "# changed\n" }],
            });

            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    configuration,
                    inspected,
                    renderBase(),
                    "not-a-uuid" as UuidV4,
                ),
            ).toThrow(/UUID v4/);
            const noDecision = structuredClone(inspected);
            noDecision.appliedRenderSnapshot.decisions = [
                {
                    semanticRef: {
                        semanticRefFingerprint: SHA_A,
                        semanticKind: "guidance.content",
                        subject: { subjectKind: "file" },
                    },
                },
                {
                    semanticRef: {
                        semanticRefFingerprint: SHA_B,
                        semanticKind: "asset.file_inventory",
                        subject: { subjectKind: "asset" },
                    },
                },
                {
                    semanticRef: {
                        semanticRefFingerprint: SHA_B,
                        semanticKind: "guidance.content",
                        subject: { subjectKind: "asset" },
                    },
                },
            ];
            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    configuration,
                    noDecision,
                    renderBase(),
                    VERSION_ID_2 as UuidV4,
                ),
            ).toThrow(/bind one applied file semantic/);
            const extraAsset = renderBase();
            extraAsset.assets.push(structuredClone(extraAsset.assets[0]!));
            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    configuration,
                    inspected,
                    extraAsset,
                    VERSION_ID_2 as UuidV4,
                ),
            ).toThrow(/one exact project Guidance or Rule Asset/);
        } finally {
            fs.rmSync(assetsRoot, { recursive: true, force: true });
        }
    });

    it("rejects every stale reverse staging join before constructing Version bytes", () => {
        const base = renderBase();
        const subject = {
            subjectKind: "file" as const,
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            fileId: FILE_ID,
        };
        expect(deploymentLifecycleInternalsForTest.requireT5WholeFileRenderAsset(base, subject, "Guidance")).toBe(base.assets[0]);
        const missingRenderAsset = structuredClone(base);
        missingRenderAsset.assets[0]!.version.ref.versionId = VERSION_ID_2;
        expect(() =>
            deploymentLifecycleInternalsForTest.requireT5WholeFileRenderAsset(missingRenderAsset, subject, "Guidance"),
        ).toThrow(/no longer matches/);
        const wrongKind = structuredClone(base);
        wrongKind.assets[0]!.version.canonical = {
            kind: "Rule",
            typeData: { schemaVersion: 1, trigger: { mode: "always" } },
        } as never;
        expect(() => deploymentLifecycleInternalsForTest.requireT5WholeFileRenderAsset(wrongKind, subject, "Guidance")).toThrow(
            /no longer matches/,
        );
        expect(() =>
            deploymentLifecycleInternalsForTest.requireT5WholeFileRenderAsset(missingRenderAsset, subject, "Rule"),
        ).toThrow(/no longer matches/);

        const parent = makeVersionClosure();
        expect(
            deploymentLifecycleInternalsForTest.requireT5ParentSourceFile(parent, FILE_ID, contentChange(), "Guidance"),
        ).toEqual({ parent, sourceFile: parent.files[0], replacementText: "# changed\n" });
        expect(() =>
            deploymentLifecycleInternalsForTest.requireT5ParentSourceFile(null, FILE_ID, contentChange(), "Guidance"),
        ).toThrow(/missing or incomplete/);
        const incomplete = structuredClone(parent);
        incomplete.manifest.status = "incomplete";
        expect(() =>
            deploymentLifecycleInternalsForTest.requireT5ParentSourceFile(incomplete, FILE_ID, contentChange(), "Guidance"),
        ).toThrow(/missing or incomplete/);
        expect(() =>
            deploymentLifecycleInternalsForTest.requireT5ParentSourceFile(parent, FILE_ID, contentChange(), "Rule"),
        ).toThrow(/not Rule/);
        const missingFile = structuredClone(parent);
        missingFile.files = [];
        expect(() =>
            deploymentLifecycleInternalsForTest.requireT5ParentSourceFile(missingFile, FILE_ID, contentChange(), "Guidance"),
        ).toThrow(/text replacement/);
        expect(() =>
            deploymentLifecycleInternalsForTest.requireT5ParentSourceFile(parent, DEPLOYMENT_ID, contentChange(), "Guidance"),
        ).toThrow(/text replacement/);
        const binaryChange = contentChange();
        binaryChange.replacementContent = {
            contentKind: "binary",
            bytes: new Uint8Array([1]),
        };
        expect(() =>
            deploymentLifecycleInternalsForTest.requireT5ParentSourceFile(parent, FILE_ID, binaryChange, "Guidance"),
        ).toThrow(/text replacement/);

        const asset = makeAsset([VERSION_ID]);
        expect(deploymentLifecycleInternalsForTest.requireAvailableStagedAsset(asset, VERSION_ID_2 as UuidV4)).toBe(asset);
        expect(() => deploymentLifecycleInternalsForTest.requireAvailableStagedAsset(null, VERSION_ID_2 as UuidV4)).toThrow(
            /identity is not available/,
        );
        expect(() =>
            deploymentLifecycleInternalsForTest.requireAvailableStagedAsset({ ...asset, deleted: true }, VERSION_ID_2 as UuidV4),
        ).toThrow(/identity is not available/);
        expect(() =>
            deploymentLifecycleInternalsForTest.requireAvailableStagedAsset(
                { ...asset, versionIds: [VERSION_ID, VERSION_ID_2] },
                VERSION_ID_2 as UuidV4,
            ),
        ).toThrow(/identity is not available/);

        const revisions = makeAsset([VERSION_ID, VERSION_ID_2]);
        expect(
            deploymentLifecycleInternalsForTest.nextAssetRevision(revisions, (versionId) =>
                makeVersionClosure({
                    versionId,
                    revision: versionId === VERSION_ID ? 1 : 3,
                }),
            ),
        ).toBe(4);
        expect(() =>
            deploymentLifecycleInternalsForTest.nextAssetRevision(revisions, (versionId) =>
                versionId === VERSION_ID ? makeVersionClosure() : null,
            ),
        ).toThrow(/missing Version/);
    });

    it("rebuilds one exact native whole-file dialect and rejects non-native authority", () => {
        const fixture = nativeProjectionFixture();
        const rebuilt = deploymentLifecycleInternalsForTest.rebuildWholeFileNativeDialectAuthority(fixture.input);
        expect(rebuilt.nativePayloads).toEqual([
            {
                dialectId: "fixture-native-v1",
                files: [{ relativePath: "GUIDANCE.md", bytes: new Uint8Array(Buffer.from("# changed\n")) }],
            },
        ]);
        expect(rebuilt.nativeRepresentations[0]).toMatchObject({
            dialectId: "fixture-native-v1",
            canonicalContentFingerprint: fixture.input.versionCanonicalContentFingerprint,
            files: [expect.objectContaining({ relativePath: "GUIDANCE.md", executable: false })],
        });

        const crossProvider = nativeProjectionFixture();
        crossProvider.input.files[0]!.file.relativePath = "CLAUDE.md";
        const crossProviderFingerprint = computeVersionCanonicalContentFingerprint(
            crossProvider.input.canonical,
            crossProvider.input.files.map((file) => file.file),
        );
        crossProvider.input.versionCanonicalContentFingerprint = crossProviderFingerprint;
        const rebuiltCrossProvider = deploymentLifecycleInternalsForTest.rebuildWholeFileNativeDialectAuthority(
            crossProvider.input,
        );
        expect(rebuiltCrossProvider.nativeRepresentations[0]?.files[0]?.relativePath).toBe("GUIDANCE.md");
        expect(rebuiltCrossProvider.nativePayloads[0]?.files[0]?.relativePath).toBe("GUIDANCE.md");

        for (const mutate of [
            (value: ReturnType<typeof nativeProjectionFixture>) => {
                value.input.parent.manifest.portableDialectContracts = [{} as never];
            },
            (value: ReturnType<typeof nativeProjectionFixture>) => {
                value.input.parent.manifest.dialectRestorationPayloads = [{} as never];
            },
            (value: ReturnType<typeof nativeProjectionFixture>) => {
                value.input.parent.restorationPayloads = [{} as never];
            },
        ]) {
            const blocked = nativeProjectionFixture();
            mutate(blocked);
            expect(() => deploymentLifecycleInternalsForTest.rebuildWholeFileNativeDialectAuthority(blocked.input)).toThrow(
                /portable or restoration/,
            );
        }
    });

    it("rejects malformed or unvalidated native whole-file dialect projections", () => {
        const invalidShapes: Array<(value: ReturnType<typeof nativeProjectionFixture>) => void> = [
            (value) => {
                value.input.parent.manifest.nativeRepresentations[0]!.files = [];
            },
            (value) => {
                value.input.parent.nativePayloads[0]!.files = [];
            },
            (value) => {
                value.input.parent.manifest.nativeRepresentations[0]!.files = new Array(1) as never;
            },
            (value) => {
                value.input.parent.nativePayloads[0]!.files = new Array(1) as never;
            },
            (value) => {
                value.input.parent.nativePayloads = [];
            },
            (value) => {
                value.input.parent.manifest.nativeRepresentations[0]!.files[0]!.relativePath = "other.md";
            },
            (value) => {
                value.input.parent.nativePayloads[0]!.files[0]!.relativePath = "other.md";
            },
            (value) => {
                value.input.parent.manifest.nativeRepresentations[0]!.files[0]!.contentKind = "binary";
            },
            (value) => {
                value.input.parent.manifest.nativeRepresentations[0]!.files[0]!.executable = true;
            },
        ];
        for (const mutate of invalidShapes) {
            const fixture = nativeProjectionFixture();
            mutate(fixture);
            expect(() => deploymentLifecycleInternalsForTest.rebuildWholeFileNativeDialectAuthority(fixture.input)).toThrow(
                /cannot safely project/,
            );
        }

        for (const mutate of [
            (value: ReturnType<typeof nativeProjectionFixture>) => {
                value.input.registry = createVersionDialectRegistry([], [], [], []);
            },
            (value: ReturnType<typeof nativeProjectionFixture>) => {
                value.input.parent.manifest.nativeRepresentations[0]!.dialectContractFingerprint = SHA_B;
            },
            (value: ReturnType<typeof nativeProjectionFixture>) => {
                value.input.registry = createVersionDialectRegistry(
                    [makeNativeDialectContract("Guidance", "fixture-native-v1", () => false)],
                    [],
                    [],
                    [],
                );
            },
        ]) {
            const fixture = nativeProjectionFixture();
            mutate(fixture);
            expect(() => deploymentLifecycleInternalsForTest.rebuildWholeFileNativeDialectAuthority(fixture.input)).toThrow(
                /validator rejected/,
            );
        }

        const inconsistent = nativeProjectionFixture();
        inconsistent.input.parent.nativePayloads.unshift({ dialectId: "foreign", files: [] });
        expect(() => deploymentLifecycleInternalsForTest.rebuildWholeFileNativeDialectAuthority(inconsistent.input)).toThrow(
            /membership is inconsistent/,
        );
    });

    it("returns no pending grant for existing authority and builds an exact staged grant", () => {
        const content = stagedContent();
        const origin = reverseOrigin(content);
        const deployment = { projectId: PROJECT_ID } as Parameters<
            typeof deploymentLifecycleInternalsForTest.pendingPromotionGrant
        >[1];
        const existing = {
            request: { newVersionPromotion: { promotionAction: "use_existing_authority" } },
        } as Parameters<typeof deploymentLifecycleInternalsForTest.pendingPromotionGrant>[0];
        expect(deploymentLifecycleInternalsForTest.pendingPromotionGrant(existing, deployment)).toBeUndefined();

        const granting = {
            request: {
                newVersionPromotion: { promotionAction: "grant_staged_version_current_target" },
            },
            promotionGrantId: TRANSACTION_ID,
            stagedVersionOriginAuthority: origin,
        } as Parameters<typeof deploymentLifecycleInternalsForTest.pendingPromotionGrant>[0];
        expect(deploymentLifecycleInternalsForTest.pendingPromotionGrant(granting, deployment)).toMatchObject({
            promotionGrantId: TRANSACTION_ID,
            subject: { subjectKind: "asset_version", versionId: VERSION_ID_2 },
        });
        expect(() =>
            deploymentLifecycleInternalsForTest.pendingPromotionGrant({ ...granting, promotionGrantId: "" }, deployment),
        ).toThrow(/allocate/);
    });

    it("proves exact text and binary runtime bytes and rejects every stale join", () => {
        const text = "# current\n";
        const binary = new Uint8Array([0, 255]);
        const targetPlan: TargetPlan = {
            schemaVersion: 1,
            targetFiles: [
                { relativePath: "a.md", content: { contentKind: "text", text }, executable: false },
                {
                    relativePath: "b.bin",
                    content: { contentKind: "binary", bytes: binary },
                    executable: true,
                },
            ],
        };
        const compiled = { targetPlan } as Parameters<
            typeof deploymentLifecycleInternalsForTest.verifyCompiledPlanAlreadyPresent
        >[0];
        const runtime = {
            runtimeReplacementAuthority: {
                files: [
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from(text),
                        expectedExecutable: false,
                    },
                    {
                        relativePath: "b.bin",
                        expectedState: "present",
                        expectedBytes: binary,
                        expectedExecutable: true,
                    },
                ],
            },
        } as Parameters<typeof deploymentLifecycleInternalsForTest.verifyCompiledPlanAlreadyPresent>[1];
        expect(deploymentLifecycleInternalsForTest.verifyCompiledPlanAlreadyPresent(compiled, runtime)).toHaveLength(2);

        const wrongPath = structuredClone(runtime);
        wrongPath.runtimeReplacementAuthority.files.pop();
        expect(() => deploymentLifecycleInternalsForTest.verifyCompiledPlanAlreadyPresent(compiled, wrongPath)).toThrow(
            /target closure/,
        );

        for (const mutate of [
            (value: typeof runtime) => {
                value.runtimeReplacementAuthority.files[0]!.expectedState = "missing";
            },
            (value: typeof runtime) => {
                value.runtimeReplacementAuthority.files[0]!.expectedBytes = Buffer.from("wrong");
            },
            (value: typeof runtime) => {
                value.runtimeReplacementAuthority.files[0]!.expectedExecutable = true;
            },
        ]) {
            const stale = structuredClone(runtime);
            mutate(stale);
            expect(() => deploymentLifecycleInternalsForTest.verifyCompiledPlanAlreadyPresent(compiled, stale)).toThrow(
                /does not contain/,
            );
        }
    });

    it("unwraps complete results and preserves or supplies failed diagnostics", () => {
        expect(
            deploymentLifecycleInternalsForTest.requireComplete({
                status: "complete",
                value: 7,
                diagnostics: [],
            }),
        ).toBe(7);
        expect(() =>
            deploymentLifecycleInternalsForTest.requireComplete({
                status: "failed",
                value: undefined,
                diagnostics: [
                    {
                        severity: "error",
                        code: "fixture.failure",
                        message: "fixture failed",
                        path: "",
                        traceId: "",
                        operation: "reverse_accept",
                        causeKind: "conflict",
                        retryable: true,
                        suggestedActions: [],
                        rawSummary: "fixture failed",
                    },
                ],
            } as CoreResult<unknown>),
        ).toThrow(/fixture failed/);
        expect(() =>
            deploymentLifecycleInternalsForTest.requireComplete({
                status: "failed",
                value: undefined,
                diagnostics: [],
            } as CoreResult<unknown>),
        ).toThrow(/prerequisite did not complete/);
    });
});

function parentRebaseSeedGroup(): ProviderRenderDialectInputsForAsset {
    return {
        targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
        inputs: [
            {
                inputKind: "native_representation",
                inputRole: "parent_rebase_seed",
                sourceVersion: {
                    assetId: ASSET_ID,
                    versionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as UuidV4,
                },
                representation: {
                    schemaVersion: 1,
                    dialectId: "fixture-parent-guidance-v1",
                    dialectContractFingerprint: SHA_A,
                    canonicalContentFingerprint: SHA_A,
                    representationFingerprint: SHA_B,
                },
                files: [
                    {
                        relativePath: "GUIDANCE.md",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        contentHash: SHA_A,
                        byteSize: 6,
                        executable: false,
                        text: "# old\n",
                    },
                ],
            },
        ],
    };
}

function nativeProjectionFixture() {
    const oldText = "# old\n";
    const replacementText = "# changed\n";
    const parent = makeVersionClosure({ files: [makeTextFile(oldText, "GUIDANCE.md")] });
    const oldBytes = new Uint8Array(Buffer.from(oldText));
    const oldStats = binaryPayloadStats(oldBytes);
    const dialectContractFingerprint = nativeDialectFingerprint("Guidance", "fixture-native-v1");
    const representationPreimage = {
        schemaVersion: 1 as const,
        dialectId: "fixture-native-v1",
        dialectContractFingerprint,
        canonicalContentFingerprint: parent.manifest.versionCanonicalContentFingerprint,
        files: [
            {
                relativePath: "GUIDANCE.md",
                contentKind: "text" as const,
                mediaType: "text/markdown",
                contentHash: oldStats.contentHash,
                byteSize: oldStats.byteSize,
                executable: false,
            },
        ],
    };
    parent.manifest.nativeRepresentations = [
        {
            ...representationPreimage,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(representationPreimage),
        },
    ];
    parent.nativePayloads = [{ dialectId: "fixture-native-v1", files: [{ relativePath: "GUIDANCE.md", bytes: oldBytes }] }];
    const canonical = { kind: "Guidance" as const, typeData: { schemaVersion: 1 as const } };
    const files = [makeTextFile(replacementText, "GUIDANCE.md")];
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        files.map((file) => file.file),
    );
    return {
        input: {
            parent,
            canonical,
            files,
            replacementText,
            versionCanonicalContentFingerprint,
            registry: createVersionDialectRegistry([makeNativeDialectContract("Guidance", "fixture-native-v1")], [], [], []),
        },
    };
}
