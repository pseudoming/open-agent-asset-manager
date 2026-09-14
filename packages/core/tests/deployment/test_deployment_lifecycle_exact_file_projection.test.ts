/** Exact-file reverse staging and immutable native-authority projection tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { UuidV4 } from "../../src/types";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import { loadRenderBaseAuthority } from "../../src/orchestration/deployment-render-service";
import { resolveOperationDialectInputs } from "../../src/orchestration/deployment-render-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import {
    publishAssetVersion,
    publishInitialAssetVersion,
    validateVersionMaterialClosure,
} from "../../src/catalog/version-authority";
import { writeProjectManifest } from "../../src/catalog/project-authority";
import { insertDeployment, upsertDeploymentAsset } from "../../src/persistence/state-db";
import { resolvePortableDialectContractRefs } from "../../src/catalog/portable-dialect-authority";
import { computeVersionFingerprint, computeVersionOriginAuthorityFingerprint } from "../../src/foundation/fingerprint";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { makePortableEntryDialectContract, makeRestorationDialectContract } from "../source-import/fixtures/dialect-contracts";
import {
    ASSET_ID,
    FILE_ID,
    PROJECT_ID,
    VERSION_ID,
    VERSION_ID_2,
    makeAsset,
    makeTextFile,
    makeVersionClosure,
} from "../catalog/fixtures/version-v2";
import { freshDb, makeDeploymentRow } from "./fixtures/deployment-state-ops-test-fixtures";
import {
    EXACT_CHANGED_ENTRY_TEXT,
    EXACT_CHANGED_NATIVE_TEXT,
    EXACT_DIALECT_ID,
    EXACT_REBASED_ENTRY_TEXT,
    EXACT_REBASED_NATIVE_TEXT,
    MEMORY_EXACT_CHANGED_ENTRY_TEXT,
    MEMORY_EXACT_CHANGED_NATIVE_TEXT,
    MEMORY_EXACT_DIALECT_ID,
    changedExactFileInspection,
    exactMaterializationInput,
    makeExactFileFixture,
    skillCanonical,
} from "../render/fixtures/native-project-exact-file-test-fixtures";

const VERSION_ID_3 = "ffffffff-ffff-4fff-8fff-ffffffffffff" as UuidV4;
const SIBLING_ASSET_ID_BEFORE = "11111111-1111-4111-8111-111111111112" as UuidV4;
const SIBLING_VERSION_ID_BEFORE = "22222222-2222-4222-8222-222222222223" as UuidV4;
const SIBLING_ASSET_ID_AFTER = "33333333-3333-4333-8333-333333333334" as UuidV4;
const SIBLING_VERSION_ID_AFTER = "44444444-4444-4444-8444-444444444445" as UuidV4;
const FOREIGN_RESTORATION_DIALECT_ID = "foreign-runtime-skill-state-v1";
const FOREIGN_RESTORATION_BYTES = Uint8Array.of(7, 11, 13, 17);
const REVERSE_AFTER_REBASE_ENTRY_TEXT = "# Review\nReview the foreign-runtime edit after deployment.\n";
const REVERSE_AFTER_REBASE_NATIVE_TEXT = EXACT_REBASED_NATIVE_TEXT.replace(
    EXACT_REBASED_ENTRY_TEXT,
    REVERSE_AFTER_REBASE_ENTRY_TEXT,
);

describe("deployment lifecycle exact-file projection", () => {
    it("reverses a parent-rebased target and inherits foreign restoration authority into the new Version", () => {
        const published = makePublishedExactParent();
        const child = publishForeignExactChild(published, true);
        const { db, base } = loadPublishedExactBase(published, VERSION_ID_2 as UuidV4);
        try {
            const { configuration, inspected } = exactRebaseStagingInvocation(published, base);
            const staged = deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                configuration,
                inspected,
                base,
                VERSION_ID_3,
            );
            expect(staged).toMatchObject({
                versionId: VERSION_ID_3,
                parentVersionId: VERSION_ID_2,
                canonical: { kind: "Skill", typeData: child.manifest.typeData },
                files: [{ contentKind: "text", text: REVERSE_AFTER_REBASE_ENTRY_TEXT }],
                dialectRestorationPayloads: child.manifest.dialectRestorationPayloads,
            });
            expect(staged.nativeRepresentations).toHaveLength(1);
            expect(staged.nativeRepresentations[0]).toMatchObject({ dialectId: EXACT_DIALECT_ID });
            expect(Buffer.from(staged.nativePayloads[0]!.files[0]!.bytes).toString("utf8")).toBe(
                REVERSE_AFTER_REBASE_NATIVE_TEXT,
            );
            expect(staged.restorationPayloads).toEqual([
                { dialectId: FOREIGN_RESTORATION_DIALECT_ID, bytes: FOREIGN_RESTORATION_BYTES },
            ]);

            const originPreimage = {
                schemaVersion: 1 as const,
                assetId: staged.assetId,
                versionId: staged.versionId,
                originKind: "reverse_accept" as const,
                previousVersionId: staged.parentVersionId,
                previousVersionOriginAuthorityFingerprint: staged.parentOriginAuthorityFingerprint,
                reversePreparationIdentityFingerprint: published.hash,
                userActionEvidenceId: "reverse-after-parent-rebase",
                promotionRequirement: staged.promotionRequirement,
                createdAt: child.manifest.createdAt + 1,
            };
            const closure = deploymentLifecycleInternalsForTest.buildStagedVersionClosure(
                staged,
                {
                    ...originPreimage,
                    authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
                },
                published.fixture.deployment.deploymentId as UuidV4,
            );
            validateVersionMaterialClosure(closure, published.registry);
            expect(closure.manifest.sourceVersionId).toBe(VERSION_ID_2);
            expect(closure.manifest.nativeRepresentations[0]!.canonicalContentFingerprint).toBe(
                closure.manifest.versionCanonicalContentFingerprint,
            );

            const projected = deploymentLifecycleInternalsForTest.projectStagedRenderBase(base, staged);
            expect(projected.dialectInputs[0]!.inputs).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        inputKind: "native_representation",
                        inputRole: "current_exact",
                        representation: expect.objectContaining({ dialectId: EXACT_DIALECT_ID }),
                    }),
                    expect.objectContaining({
                        inputKind: "dialect_restoration",
                        restoration: expect.objectContaining({ dialectId: FOREIGN_RESTORATION_DIALECT_ID }),
                    }),
                ]),
            );
            const projectedDeployment = structuredClone(published.fixture.deployment);
            projectedDeployment.assets = structuredClone(projected.assets);
            const semantic = structuredClone(published.fixture.requiredSemantics[0]!);
            if (semantic.subject.subjectKind !== "missing_required_file_role") {
                semantic.subject.versionId = VERSION_ID_3;
            }
            const providerInputs = resolveOperationDialectInputs(
                {
                    deployment: projectedDeployment,
                    registry: published.fixture.registry,
                    dialectInputs: projected.dialectInputs,
                    diagnostics: [],
                },
                published.fixture.provider,
                projectedDeployment,
                [semantic],
            );
            expect(providerInputs[0]!.inputs).toMatchObject([
                {
                    inputKind: "native_representation",
                    inputRole: "current_exact",
                    representation: { dialectId: EXACT_DIALECT_ID },
                },
            ]);
            expect(providerInputs[0]!.inputs).toHaveLength(1);

            const stale = exactRebaseStagingInvocation(published, base);
            const staleNative = stale.inspected.operation.dialectInputs[0]!.inputs[0]!;
            if (staleNative.inputKind !== "native_representation" || staleNative.inputRole !== "parent_rebase_seed") {
                throw new Error("parent rebase fixture input is missing");
            }
            staleNative.sourceVersion.versionId = VERSION_ID_3;
            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    stale.configuration,
                    stale.inspected,
                    base,
                    VERSION_ID_3,
                ),
            ).toThrow(/immediate Version lineage/);
        } finally {
            db.close();
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("stages one exact Skill from a multi-Asset Deployment and preserves every sibling authority in place", () => {
        const published = makePublishedExactParent();
        const invocation = exactStagingInvocation(published);
        addExactSiblingAuthority(invocation.base);
        const before = structuredClone(invocation.base);
        try {
            const staged = deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                invocation.configuration,
                invocation.inspected,
                invocation.base,
                VERSION_ID_2 as UuidV4,
            );
            const projected = deploymentLifecycleInternalsForTest.projectStagedRenderBase(invocation.base, staged);
            expect(staged).toMatchObject({
                assetId: ASSET_ID,
                versionId: VERSION_ID_2,
                revision: 2,
                canonical: { kind: "Skill", typeData: published.fixture.closure.manifest.typeData },
                files: [{ contentKind: "text", text: EXACT_CHANGED_ENTRY_TEXT }],
                portableDialectContracts: published.closure.manifest.portableDialectContracts,
                dialectRestorationPayloads: [],
                restorationPayloads: [],
            });
            expect(Buffer.from(staged.nativePayloads[0]!.files[0]!.bytes).toString("utf8")).toBe(EXACT_CHANGED_NATIVE_TEXT);
            expect(projected.assets.map((asset) => asset.version.ref.versionId)).toEqual([
                SIBLING_VERSION_ID_BEFORE,
                VERSION_ID_2,
                SIBLING_VERSION_ID_AFTER,
            ]);
            expect(projected.appliedInputsSnapshot.assets.map((asset) => asset.versionId)).toEqual([
                SIBLING_VERSION_ID_BEFORE,
                VERSION_ID_2,
                SIBLING_VERSION_ID_AFTER,
            ]);
            expect(projected.dialectInputs.map((group) => group.targetVersion.versionId)).toEqual([
                SIBLING_VERSION_ID_BEFORE,
                VERSION_ID_2,
                SIBLING_VERSION_ID_AFTER,
            ]);
            expect(projected.assets[0]).toEqual(before.assets[0]);
            expect(projected.assets[2]).toEqual(before.assets[2]);
            expect(projected.appliedInputsSnapshot.assets[0]).toEqual(before.appliedInputsSnapshot.assets[0]);
            expect(projected.appliedInputsSnapshot.assets[2]).toEqual(before.appliedInputsSnapshot.assets[2]);
            expect(projected.dialectInputs[0]).toEqual(before.dialectInputs[0]);
            expect(projected.dialectInputs[2]).toEqual(before.dialectInputs[2]);
            const mutations: Array<(base: typeof invocation.base) => void> = [
                (base) => {
                    base.assets.splice(1, 1);
                },
                (base) => {
                    base.assets.push(structuredClone(base.assets[1]!));
                },
                (base) => {
                    base.assets[1]!.version.ref.versionId = SIBLING_VERSION_ID_BEFORE;
                },
                (base) => {
                    base.appliedInputsSnapshot.assets.splice(1, 1);
                },
                (base) => {
                    base.appliedInputsSnapshot.assets.push(structuredClone(base.appliedInputsSnapshot.assets[1]!));
                },
                (base) => {
                    base.appliedInputsSnapshot.assets[1]!.versionId = SIBLING_VERSION_ID_BEFORE;
                },
                (base) => {
                    base.dialectInputs.splice(1, 1);
                },
                (base) => {
                    base.dialectInputs.push(structuredClone(base.dialectInputs[1]!));
                },
                (base) => {
                    base.dialectInputs[1]!.targetVersion.versionId = SIBLING_VERSION_ID_BEFORE;
                },
            ];
            for (const mutate of mutations) {
                const base = structuredClone(invocation.base);
                mutate(base);
                expect(() => deploymentLifecycleInternalsForTest.projectStagedRenderBase(base, staged)).toThrow(
                    /one unique parent authority/,
                );
            }
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("stages a complete Memory Unit reverse without treating its Catalog sibling as an exact file", () => {
        const published = makePublishedExactParent("Memory");
        try {
            const invocation = exactStagingInvocation(published);
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
                canonical: {
                    kind: "Memory",
                    typeData: { entityRole: "unit", card: { name: "review-memory" } },
                },
                files: [{ contentKind: "text", text: MEMORY_EXACT_CHANGED_ENTRY_TEXT }],
            });
            expect(staged.nativeRepresentations).toMatchObject([{ dialectId: MEMORY_EXACT_DIALECT_ID }]);
            expect(Buffer.from(staged.nativePayloads[0]!.files[0]!.bytes).toString("utf8")).toBe(
                MEMORY_EXACT_CHANGED_NATIVE_TEXT,
            );
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("loads the target Version's exact sourceVersionId as an operation-local parent rebase seed", () => {
        const published = makePublishedExactParent();
        publishForeignExactChild(published, false);
        const { db, base } = loadPublishedExactBase(published, VERSION_ID_2 as UuidV4);
        try {
            expect(base.assets[0]!.version.ref).toEqual({ assetId: ASSET_ID, versionId: VERSION_ID_2 });
            expect(base.dialectInputs).toMatchObject([
                {
                    targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID_2 },
                    inputs: [
                        {
                            inputKind: "native_representation",
                            inputRole: "parent_rebase_seed",
                            sourceVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                            representation: { dialectId: EXACT_DIALECT_ID },
                        },
                    ],
                },
            ]);
            const parent = base.dialectInputs[0]!.inputs[0]!;
            if (parent.inputKind !== "native_representation") throw new Error("parent projection missing");
            expect(parent.representation.canonicalContentFingerprint).toBe(
                published.closure.manifest.versionCanonicalContentFingerprint,
            );
            expect(parent.representation.canonicalContentFingerprint).not.toBe(
                base.assets[0]!.version.versionCanonicalContentFingerprint,
            );
        } finally {
            db.close();
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("fails closed for stale exact-file reverse subjects, contracts, parents and target bytes", () => {
        const published = makePublishedExactParent();
        try {
            const cases: Array<{
                expected: RegExp;
                mutate(value: ReturnType<typeof exactStagingInvocation>): void;
            }> = [
                {
                    expected: /one unique applied project Asset/,
                    mutate: ({ base }) => {
                        base.assets = [];
                    },
                },
                {
                    expected: /one unique applied project Asset/,
                    mutate: ({ base }) => {
                        base.assets.push(structuredClone(base.assets[0]!));
                    },
                },
                {
                    expected: /one unique applied project Asset/,
                    mutate: ({ base }) => {
                        base.appliedInputsSnapshot.assets = [];
                    },
                },
                {
                    expected: /one unique applied project Asset/,
                    mutate: ({ base }) => {
                        base.appliedInputsSnapshot.assets.push(structuredClone(base.appliedInputsSnapshot.assets[0]!));
                    },
                },
                {
                    expected: /one unique applied project Asset/,
                    mutate: ({ base }) => {
                        base.assets[0]!.version.ref.versionId = SIBLING_VERSION_ID_BEFORE;
                    },
                },
                {
                    expected: /one unique applied project Asset/,
                    mutate: ({ base }) => {
                        base.appliedInputsSnapshot.assets[0]!.versionId = SIBLING_VERSION_ID_BEFORE;
                    },
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
                    expected: /no unique current Provider declaration/,
                    mutate: ({ inspected }) => {
                        inspected.appliedRenderSnapshot.outputUnits = [];
                    },
                },
                {
                    expected: /parent Version is missing/,
                    mutate: ({ inspected }) => {
                        const decision = exactEntryDecision(inspected);
                        if (decision.semanticRef.subject.subjectKind === "file") {
                            decision.semanticRef.subject.fileId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
                        }
                    },
                },
                {
                    expected: /reverse target text is unavailable/,
                    mutate: ({ inspected }) => {
                        inspected.result.files[0]!.relativePath = "wrong/SKILL.md";
                    },
                },
                {
                    expected: /no unique applied target-dialect input/,
                    mutate: ({ inspected }) => {
                        inspected.operation.dialectInputs = [];
                    },
                },
                {
                    expected: /immediate Version lineage/,
                    mutate: ({ inspected }) => {
                        const native = inspected.operation.dialectInputs[0]!.inputs[0]!;
                        if (native.inputKind === "native_representation") {
                            native.representation.canonicalContentFingerprint = published.hash;
                        }
                    },
                },
            ];
            for (const { mutate, expected } of cases) {
                const value = exactStagingInvocation(published);
                mutate(value);
                expect(() =>
                    deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                        value.configuration,
                        value.inspected,
                        value.base,
                        VERSION_ID_2 as UuidV4,
                    ),
                ).toThrow(expected);
            }

            for (const semanticKind of ["workflow.content", "subagent.invoked_context"] as const) {
                const value = exactStagingInvocation(published);
                exactEntryDecision(value.inspected).semanticRef.semanticKind = semanticKind;
                expect(() =>
                    deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                        value.configuration,
                        value.inspected,
                        value.base,
                        VERSION_ID_2 as UuidV4,
                    ),
                ).toThrow(/semantic no longer matches/);
            }

            const unsupported = exactStagingInvocation(published);
            exactEntryDecision(unsupported.inspected).semanticRef.semanticKind = "skill.resource";
            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    unsupported.configuration,
                    unsupported.inspected,
                    unsupported.base,
                    VERSION_ID_2 as UuidV4,
                ),
            ).toThrow(/one supported applied file semantic/);
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });
});

function exactStagingInvocation(published: ReturnType<typeof makePublishedExactParent>) {
    const materialization = exactMaterializationInput(published.fixture);
    const inspectionInput = structuredClone(changedExactFileInspection(published.fixture, materialization));
    const result = published.fixture.support.inspect(inspectionInput);
    const inspected = {
        input: inspectionInput,
        result,
        appliedRenderSnapshot: inspectionInput.appliedRenderSnapshot,
        operation: {
            deployment: structuredClone(published.fixture.deployment),
            registry: published.fixture.registry,
            dialectInputs: structuredClone(published.fixture.analysisInput.dialectInputs),
            diagnostics: [],
        },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[1];
    const base = structuredClone(exactRenderBase(published.fixture));
    const configuration = {
        render: { assetsRoot: published.assetsRoot, dialectRegistry: published.registry },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[0];
    return { configuration, inspected, base };
}

function addExactSiblingAuthority(base: ReturnType<typeof exactStagingInvocation>["base"]): void {
    const targetAsset = structuredClone(base.assets[0]!);
    const targetApplied = structuredClone(base.appliedInputsSnapshot.assets[0]!);
    const targetDialect = structuredClone(base.dialectInputs[0]!);
    const sibling = (assetId: UuidV4, versionId: UuidV4) => {
        const asset = structuredClone(targetAsset);
        asset.version.ref = { assetId, versionId };
        asset.sectionHandles = Object.fromEntries(
            Object.entries(asset.sectionHandles).map(([fileId, handle]) => [fileId, handle.replace(VERSION_ID, versionId)]),
        );
        const applied = { ...structuredClone(targetApplied), assetId, versionId };
        const dialect = structuredClone(targetDialect);
        dialect.targetVersion = { assetId, versionId };
        return { asset, applied, dialect };
    };
    const before = sibling(SIBLING_ASSET_ID_BEFORE, SIBLING_VERSION_ID_BEFORE);
    const after = sibling(SIBLING_ASSET_ID_AFTER, SIBLING_VERSION_ID_AFTER);
    base.assets = [before.asset, ...base.assets, after.asset];
    base.appliedInputsSnapshot.assets = [before.applied, ...base.appliedInputsSnapshot.assets, after.applied];
    base.dialectInputs = [before.dialect, ...base.dialectInputs, after.dialect];
}

function exactEntryDecision(inspected: ReturnType<typeof exactStagingInvocation>["inspected"]) {
    const decision = inspected.appliedRenderSnapshot.decisions.find(
        (candidate) => candidate.semanticRef.subject.subjectKind === "file",
    );
    if (decision === undefined) throw new Error("exact entry decision missing");
    return decision;
}

function makePublishedExactParent(assetKind: "Skill" | "Memory" = "Skill") {
    const fixture = makeExactFileFixture({
        assetKind,
        ...(assetKind === "Memory" ? { targetKind: "directory" as const } : {}),
    });
    const assetsRoot = path.join(os.tmpdir(), `oaam-exact-file-parent-${process.pid}-${Date.now()}-${Math.random()}`);
    const portableEntry =
        assetKind === "Skill"
            ? makePortableEntryDialectContract("Skill", "skill_entry", skillCanonical().typeData.entryDialectId, () => true)
            : null;
    const foreignRestoration =
        assetKind === "Skill"
            ? makeRestorationDialectContract("Skill", FOREIGN_RESTORATION_DIALECT_ID, (bytes) =>
                  Buffer.from(bytes).equals(Buffer.from(FOREIGN_RESTORATION_BYTES)),
              )
            : null;
    const registry = createVersionDialectRegistry(
        [fixture.nativeDialect],
        foreignRestoration === null ? [] : [foreignRestoration],
        portableEntry === null ? [] : [portableEntry],
        [],
    );
    const closure = structuredClone(fixture.closure);
    const projected = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
    if (projected.inputKind !== "native_representation") throw new Error("fixture native representation missing");
    const representation = {
        ...structuredClone(projected.representation),
        files: projected.files.map(({ text: _text, ...file }) => file),
    };
    closure.manifest.nativeRepresentations = [representation];
    closure.nativePayloads = [
        {
            dialectId: fixture.definition.nativeDialectId,
            files: projected.files.map((file) => ({
                relativePath: file.relativePath,
                bytes: Buffer.from(file.contentKind === "text" ? file.text : file.bytes),
            })),
        },
    ];
    closure.manifest.portableDialectContracts = resolvePortableDialectContractRefs(
        fixture.definition.canonical(),
        closure.files,
        closure.manifest.status,
        registry,
    );
    closure.manifest.fingerprint = computeVersionFingerprint(
        closure.manifest.versionCanonicalContentFingerprint,
        closure.manifest.nativeRepresentations,
        [],
        closure.manifest.portableDialectContracts,
    );
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "txn-exact-file-parent",
        asset: makeAsset([VERSION_ID], {
            kind: assetKind,
            scope: "project",
            projectId: PROJECT_ID,
            scopePath: "",
        }),
        version: closure,
        dialectRegistry: registry,
    });
    return {
        fixture,
        assetsRoot,
        portableEntry,
        foreignRestoration,
        registry,
        closure,
        hash: `sha256:${"5".repeat(64)}` as const,
    };
}

function publishForeignExactChild(published: ReturnType<typeof makePublishedExactParent>, withRestoration: boolean) {
    const canonical = skillCanonical();
    canonical.typeData.description = "Review foreign changes";
    const child = makeVersionClosure({
        versionId: VERSION_ID_2,
        revision: 2,
        sourceVersionId: VERSION_ID,
        changeKind: "edit",
        canonical,
        files: [makeTextFile(EXACT_REBASED_ENTRY_TEXT, "SKILL.md")],
        createdAt: published.closure.manifest.createdAt + 1,
    });
    child.manifest.portableDialectContracts = resolvePortableDialectContractRefs(
        { kind: "Skill", typeData: child.manifest.typeData },
        child.files,
        child.manifest.status,
        published.registry,
    );
    if (withRestoration) {
        const contract = published.registry.getRestoration("Skill", FOREIGN_RESTORATION_DIALECT_ID);
        if (contract === null) throw new Error("foreign restoration fixture contract is missing");
        child.manifest.dialectRestorationPayloads = [
            {
                dialectId: FOREIGN_RESTORATION_DIALECT_ID,
                restorationContractFingerprint: contract.contractFingerprint,
                contentHash: binaryPayloadStats(FOREIGN_RESTORATION_BYTES).contentHash,
            },
        ];
        child.restorationPayloads = [
            { dialectId: FOREIGN_RESTORATION_DIALECT_ID, bytes: new Uint8Array(FOREIGN_RESTORATION_BYTES) },
        ];
    }
    child.manifest.fingerprint = computeVersionFingerprint(
        child.manifest.versionCanonicalContentFingerprint,
        child.manifest.nativeRepresentations,
        child.manifest.dialectRestorationPayloads,
        child.manifest.portableDialectContracts,
    );
    publishAssetVersion({
        assetsRoot: published.assetsRoot,
        transactionId: withRestoration ? "txn-exact-file-foreign-child" : "txn-exact-file-child",
        version: child,
        dialectRegistry: published.registry,
    });
    return child;
}

function loadPublishedExactBase(published: ReturnType<typeof makePublishedExactParent>, versionId: UuidV4) {
    const db = freshDb();
    const targetRoot = path.join(published.assetsRoot, "target-project");
    const projectsRoot = path.join(published.assetsRoot, "projects-authority");
    fs.mkdirSync(targetRoot);
    writeProjectManifest(projectsRoot, {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        rootPath: targetRoot,
        displayName: "Exact parent fixture",
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
    });
    const deploymentId = published.fixture.deployment.deploymentId as UuidV4;
    insertDeployment(
        db,
        makeDeploymentRow(deploymentId, {
            consumerAgentRuntimeIds: JSON.stringify([published.fixture.descriptor.agentRuntimeId]),
            platform: "wsl",
            platformInstanceId: "test-wsl",
            targetRootPath: targetRoot,
            projectId: PROJECT_ID,
        }),
    );
    upsertDeploymentAsset(db, deploymentId, ASSET_ID, versionId, 0, 0, 2);
    const base = loadRenderBaseAuthority(
        {
            db,
            assetsRoot: published.assetsRoot,
            projectsRoot,
            oaamRoot: path.join(published.assetsRoot, "oaam"),
            authorityLocksRoot: path.join(published.assetsRoot, "locks"),
            transactionsRoot: path.join(published.assetsRoot, "transactions"),
            deploymentsRoot: path.join(published.assetsRoot, "deployments"),
            platformContexts: [],
            dialectRegistry: published.registry,
            assertMutationScope: () => undefined,
            now: () => 3,
        },
        deploymentId,
    );
    return { db, base };
}

function exactRebaseStagingInvocation(
    published: ReturnType<typeof makePublishedExactParent>,
    base: ReturnType<typeof loadPublishedExactBase>["base"],
) {
    const materialization = exactMaterializationInput(published.fixture);
    const inspectionInput = structuredClone(changedExactFileInspection(published.fixture, materialization));
    for (const decision of inspectionInput.appliedRenderSnapshot.decisions) {
        if (decision.semanticRef.subject.subjectKind !== "missing_required_file_role") {
            decision.semanticRef.subject.versionId = VERSION_ID_2 as UuidV4;
        }
    }
    const state = inspectionInput.inspectionScope.fileStates[0];
    const file = inspectionInput.files[0];
    if (state?.state !== "changed" || file?.fileState !== "baseline_changed") {
        throw new Error("exact rebase inspection fixture is not a changed file");
    }
    state.appliedContentHash = binaryPayloadStats(Buffer.from(EXACT_REBASED_NATIVE_TEXT)).contentHash;
    state.currentContentHash = binaryPayloadStats(Buffer.from(REVERSE_AFTER_REBASE_NATIVE_TEXT)).contentHash;
    file.appliedContent = { contentKind: "text", text: EXACT_REBASED_NATIVE_TEXT };
    file.currentContent = { contentKind: "text", text: REVERSE_AFTER_REBASE_NATIVE_TEXT };
    file.diffHunks[0]!.appliedEndByte = Buffer.byteLength(EXACT_REBASED_NATIVE_TEXT);
    file.diffHunks[0]!.currentEndByte = Buffer.byteLength(REVERSE_AFTER_REBASE_NATIVE_TEXT);
    const result = published.fixture.support.inspect(inspectionInput);
    const deployment = structuredClone(published.fixture.deployment);
    deployment.assets = structuredClone(base.assets);
    const inspected = {
        input: inspectionInput,
        result,
        appliedRenderSnapshot: inspectionInput.appliedRenderSnapshot,
        operation: {
            deployment,
            registry: published.fixture.registry,
            dialectInputs: structuredClone(base.dialectInputs),
            diagnostics: [],
        },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[1];
    const configuration = {
        render: { assetsRoot: published.assetsRoot, dialectRegistry: published.registry },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[0];
    return { configuration, inspected };
}

function exactRenderBase(fixture: ReturnType<typeof makeExactFileFixture>) {
    return {
        deploymentId: fixture.deployment.deploymentId,
        consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
        platform: fixture.deployment.platform,
        platformInstanceId: fixture.deployment.platformInstanceId,
        targetRootPath: fixture.deployment.targetRootPath,
        projectId: fixture.deployment.projectId,
        assets: fixture.deployment.assets,
        dialectInputs: fixture.analysisInput.dialectInputs,
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId: fixture.deployment.deploymentId,
            consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.projectStagedRenderBase>[0];
}
