/** Memory Catalog operation-local member binding and batch publication. */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";
import { createVersionDialectRegistry, readVersionAuthority } from "../../src/catalog/version-authority";
import { serializeVersionManifest } from "../../src/catalog/version-manifest";
import { applyCanonicalBindings, deriveCallableBindingRequests } from "../../src/orchestration/import-material";
import type {
    AdapterExtractedAssetCandidate,
    AdapterReadResult,
    ImportAcceptBatchCallableBindingV1,
    UuidV4,
} from "../../src/types";
import { makeNativeDialectContract } from "./fixtures/dialect-contracts";
import {
    acceptRequest,
    assetsRoot,
    candidateBase,
    makeReadResultFromProvider,
    makeService,
    providerForCandidate,
    sourceFile,
    subagentTypeData,
} from "./fixtures/import-service-test-fixtures";

const UNIT_DIALECT = "fixture-memory-unit-v1";
const CATALOG_DIALECT = "fixture-memory-catalog-v1";

describe("Core Memory Catalog import binding", () => {
    it("publishes Units dependency-first and preserves ordered Catalog routing metadata", async () => {
        const first = await memoryUnitRead("topic-a.md", "Topic A", "First body");
        const second = await memoryUnitRead("topic-b.md", "Topic B", "Second body");
        const catalog = await memoryCatalogRead([
            { rawTarget: "topic-b.md", routingTitle: "Second", routingHint: "Load second" },
            { rawTarget: "topic-a.md", routingTitle: "First", routingHint: "Load first" },
        ]);
        const service = memoryService();
        const preview = service.previewImport([catalog, first, second]).value;
        const catalogId = candidateId(catalog);
        const firstId = candidateId(first);
        const secondId = candidateId(second);

        expect(preview.items.find((item) => item.candidateId === catalogId)?.callableBindingRequests).toEqual([
            {
                subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                rawTarget: "topic-b.md",
                required: true,
            },
            {
                subject: { subjectKind: "memory_catalog_member", memberIndex: 1 },
                rawTarget: "topic-a.md",
                required: true,
            },
        ]);

        const result = await service.acceptImportBatch({
            previewSnapshot: preview,
            decisions: [
                batchDecision(catalogId, [
                    {
                        subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                        targetCandidateId: secondId,
                    },
                    {
                        subject: { subjectKind: "memory_catalog_member", memberIndex: 1 },
                        targetCandidateId: firstId,
                    },
                ]),
                batchDecision(firstId),
                batchDecision(secondId),
            ],
        });

        expect(result.status).toBe("complete");
        const catalogResult = completeItem(result.value.items, catalogId);
        const firstResult = completeItem(result.value.items, firstId);
        const secondResult = completeItem(result.value.items, secondId);
        const closure = readVersionAuthority(
            assetsRoot,
            catalogResult.version.assetId,
            catalogResult.version.versionId,
            memoryRegistry(),
        );
        expect(closure?.manifest.typeData).toEqual({
            schemaVersion: 2,
            entityRole: "catalog",
            members: [
                {
                    targetAssetVersionId: secondResult.version.versionId,
                    routingTitle: "Second",
                    routingHint: "Load second",
                },
                {
                    targetAssetVersionId: firstResult.version.versionId,
                    routingTitle: "First",
                    routingHint: "Load first",
                },
            ],
        });
    });

    it("keeps an observed empty Catalog complete without manufacturing a member", async () => {
        const catalog = await memoryCatalogRead([]);
        const service = memoryService();
        const preview = service.previewImport([catalog]).value;
        expect(preview.items[0]?.callableBindingRequests).toEqual([]);

        const accepted = await service.acceptImport(acceptRequest(preview));
        expect(accepted.status).toBe("complete");
        if (accepted.status !== "complete") throw new Error("empty Catalog import failed");
        const closure = readVersionAuthority(assetsRoot, accepted.value.assetId, accepted.value.versionId, memoryRegistry());
        expect(closure?.manifest.typeData).toEqual({ schemaVersion: 2, entityRole: "catalog", members: [] });
    });

    it("keeps legacy incomplete Catalog reports unbound while validating any supplied observations", async () => {
        const withoutBindings = await incompleteMemoryCatalogRead(undefined);
        const withoutBindingsCandidate = withoutBindings.candidates[0];
        if (withoutBindingsCandidate?.kind !== "Memory") throw new Error("incomplete Memory Catalog missing");
        expect(deriveCallableBindingRequests(withoutBindingsCandidate)).toEqual([]);
        expect(applyCanonicalBindings(withoutBindingsCandidate, [])).toEqual({
            kind: "Memory",
            typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
        });

        const observed = [{ rawTarget: "topic.md", routingTitle: "Topic", routingHint: "Load topic" }];
        const withBindings = await incompleteMemoryCatalogRead(observed);
        expect(withBindings.candidates[0]).toMatchObject({
            status: "incomplete",
            memoryCatalogMemberBindingInputs: observed,
        });

        await expect(incompleteMemoryCatalogRead({ unexpected: true } as never)).rejects.toThrow(
            "read.memory_catalog_binding_input_invalid",
        );
    });

    it("rejects missing, duplicate, wrong-kind, wrong-role, incomplete, and wrong-scope member authorities", async () => {
        const unit = await memoryUnitRead("topic.md", "Topic", "Body");
        const catalog = await memoryCatalogRead([{ rawTarget: "topic.md", routingTitle: "Topic", routingHint: "Load topic" }]);
        const service = memoryService();
        const unitAccepted = await service.acceptImport(acceptRequest(service.previewImport([unit]).value));
        if (unitAccepted.status !== "complete") throw new Error("Memory Unit import failed");

        const missing = await service.acceptImport(acceptRequest(service.previewImport([catalog]).value));
        expect(missing.diagnostics[0]?.code).toBe("import.binding_required_missing");

        const binding = {
            subject: { subjectKind: "memory_catalog_member" as const, memberIndex: 0 },
            targetAssetVersionId: unitAccepted.value.versionId,
        };
        const duplicated = await service.acceptImport(
            acceptRequest(service.previewImport([catalog]).value, { callableBindings: [binding, binding] }),
        );
        expect(duplicated.diagnostics[0]?.code).toBe("import.binding_invalid");

        const emptyCatalog = await memoryCatalogRead([]);
        const emptyAccepted = await service.acceptImport(acceptRequest(service.previewImport([emptyCatalog]).value));
        if (emptyAccepted.status !== "complete") throw new Error("empty Catalog import failed");
        const wrongRole = await acceptCatalogWithTarget(service, catalog, emptyAccepted.value.versionId);
        expect(wrongRole.diagnostics[0]?.code).toBe("import.binding_target_kind_invalid");

        const subagent = await subagentRead();
        const subagentAccepted = await service.acceptImport(acceptRequest(service.previewImport([subagent]).value));
        if (subagentAccepted.status !== "complete") throw new Error("Subagent import failed");
        const wrongKind = await acceptCatalogWithTarget(service, catalog, subagentAccepted.value.versionId);
        expect(wrongKind.diagnostics[0]?.code).toBe("import.binding_target_kind_invalid");

        const unitClosure = readVersionAuthority(
            assetsRoot,
            unitAccepted.value.assetId,
            unitAccepted.value.versionId,
            memoryRegistry(),
        );
        if (unitClosure === null) throw new Error("Memory Unit closure missing");
        const incomplete = structuredClone(unitClosure.manifest);
        incomplete.status = "incomplete";
        fs.writeFileSync(
            `${assetsRoot}/${unitAccepted.value.assetId}/versions/${unitAccepted.value.versionId}/version.json`,
            serializeVersionManifest(incomplete),
        );
        const incompleteTarget = await acceptCatalogWithTarget(service, catalog, unitAccepted.value.versionId);
        expect(incompleteTarget.diagnostics[0]?.code).toBe("import.binding_target_incomplete");

        fs.writeFileSync(
            `${assetsRoot}/${unitAccepted.value.assetId}/versions/${unitAccepted.value.versionId}/version.json`,
            serializeVersionManifest(unitClosure.manifest),
        );
        const unitAsset = readAssetManifest(assetsRoot, unitAccepted.value.assetId);
        if (unitAsset === null) throw new Error("Memory Unit Asset missing");
        writeAssetManifest(assetsRoot, {
            ...unitAsset,
            scope: "project",
            projectId: "00000000-0000-4000-8000-000000000900" as UuidV4,
        });
        const wrongScope = await acceptCatalogWithTarget(service, catalog, unitAccepted.value.versionId);
        expect(wrongScope.diagnostics[0]?.code).toBe("import.binding_target_kind_invalid");
    });

    it("rejects a refreshed Catalog whose operation-local member observation changed after review", async () => {
        const unit = await memoryUnitRead("topic.md", "Topic", "Body");
        const catalog = await memoryCatalogRead([{ rawTarget: "topic.md", routingTitle: "Topic", routingHint: "Load topic" }]);
        const service = memoryService(async (previous) => {
            const refreshed = structuredClone(previous);
            const candidate = refreshed.candidates[0];
            if (candidate?.kind === "Memory" && candidate.typeData.entityRole === "catalog") {
                const member = candidate.memoryCatalogMemberBindingInputs?.[0];
                if (member !== undefined) member.routingTitle = "Changed after review";
            }
            return refreshed;
        });
        const unitAccepted = await service.acceptImport(acceptRequest(service.previewImport([unit]).value));
        if (unitAccepted.status !== "complete") throw new Error("Memory Unit import failed");

        const result = await acceptCatalogWithTarget(service, catalog, unitAccepted.value.versionId);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("import.source_changed");
    });

    it("rejects malformed operation-local Catalog binding inputs before preview", async () => {
        const mutations: Array<(candidate: Extract<AdapterExtractedAssetCandidate, { kind: "Memory" }>) => void> = [
            (candidate) => {
                delete candidate.memoryCatalogMemberBindingInputs;
            },
            (candidate) => {
                candidate.typeData = {
                    schemaVersion: 2,
                    entityRole: "catalog",
                    members: [
                        {
                            targetAssetVersionId: "00000000-0000-4000-8000-000000000001",
                            routingTitle: "Already bound",
                            routingHint: "invalid source authority",
                        },
                    ],
                };
            },
            (candidate) => {
                candidate.memoryCatalogMemberBindingInputs = [
                    { rawTarget: "../escape.md", routingTitle: "Escape", routingHint: "" },
                ];
            },
            (candidate) => {
                candidate.memoryCatalogMemberBindingInputs = [
                    { rawTarget: "topic.md", routingTitle: "Topic", routingHint: "" },
                    { rawTarget: "topic.md", routingTitle: "Duplicate", routingHint: "" },
                ];
            },
            (candidate) => {
                candidate.memoryCatalogMemberBindingInputs = [{ rawTarget: "topic.md", routingTitle: " ", routingHint: "" }];
            },
            (candidate) => {
                candidate.memoryCatalogMemberBindingInputs = { unexpected: true } as never;
            },
            (candidate) => {
                candidate.memoryCatalogMemberBindingInputs = [
                    { rawTarget: "topic.md", routingTitle: "Topic", routingHint: "", extra: true } as never,
                ];
            },
            (candidate) => {
                candidate.typeData = {
                    schemaVersion: 2,
                    entityRole: "unit",
                    card: { name: "Topic", description: "" },
                    loading: { card: "high", body: "low" },
                    applicabilityRule: "",
                };
                candidate.files = [
                    {
                        logicalPath: "memory.md",
                        role: "entry",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        text: "Body",
                        executable: false,
                        references: [],
                    },
                ];
                candidate.sourceFileOrigins = [
                    {
                        logicalPath: "memory.md",
                        observedReadEntryIds: [candidate.metadataSourceOrigins[0]!.observedReadEntryId],
                    },
                ];
                candidate.memoryCatalogMemberBindingInputs = [];
            },
        ];

        for (const mutate of mutations) {
            await expect(malformedMemoryRead(mutate)).rejects.toThrow("read.memory_catalog_binding_input_invalid");
        }
    });
});

function memoryService(refresh: (previous: AdapterReadResult) => Promise<AdapterReadResult> = async (previous) => previous) {
    return makeService(refresh, { dialectRegistry: memoryRegistry() });
}

function memoryRegistry() {
    return createVersionDialectRegistry(
        [
            makeNativeDialectContract("Memory", UNIT_DIALECT),
            makeNativeDialectContract("Memory", CATALOG_DIALECT),
            makeNativeDialectContract("Subagent", "fixture-subagent-v1"),
        ],
        [],
        [],
        [],
    );
}

async function memoryUnitRead(relativePath: string, name: string, text: string): Promise<AdapterReadResult> {
    fs.writeFileSync(sourceFile, text);
    return makeReadResultFromProvider(
        providerForCandidate("Memory", (observedReadEntryId, observedText) => ({
            ...candidateBase(observedReadEntryId, relativePath, observedText, UNIT_DIALECT),
            candidateId: `candidate-unit-${relativePath}`,
            kind: "Memory",
            typeData: {
                schemaVersion: 2,
                entityRole: "unit",
                card: { name, description: `${name} description` },
                loading: { card: "high", body: "low" },
                applicabilityRule: "",
            },
        })),
        "Memory",
    );
}

async function memoryCatalogRead(
    members: NonNullable<Extract<AdapterExtractedAssetCandidate, { kind: "Memory" }>["memoryCatalogMemberBindingInputs"]>,
): Promise<AdapterReadResult> {
    const text = members.map((member) => `- [${member.routingTitle}](./${member.rawTarget}) — ${member.routingHint}`).join("\n");
    fs.writeFileSync(sourceFile, text === "" ? "# Memory\n" : `# Memory\n${text}\n`);
    return makeReadResultFromProvider(
        providerForCandidate("Memory", (observedReadEntryId, observedText) => ({
            ...candidateBase(observedReadEntryId, "MEMORY.md", observedText, CATALOG_DIALECT),
            candidateId: `candidate-catalog-${members.map((member) => member.rawTarget).join("-") || "empty"}`,
            files: [],
            nativeRepresentation: {
                representationSource: "separate_files",
                dialectId: CATALOG_DIALECT,
                files: [
                    {
                        relativePath: "MEMORY.md",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        bytes: new Uint8Array(Buffer.from(observedText, "utf8")),
                        executable: false,
                    },
                ],
            },
            sourceFileOrigins: [],
            kind: "Memory",
            typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
            memoryCatalogMemberBindingInputs: members,
        })),
        "Memory",
    );
}

async function malformedMemoryRead(
    mutate: (candidate: Extract<AdapterExtractedAssetCandidate, { kind: "Memory" }>) => void,
): Promise<AdapterReadResult> {
    fs.writeFileSync(sourceFile, "# Memory\n- [Topic](./topic.md)\n");
    return makeReadResultFromProvider(
        providerForCandidate("Memory", (observedReadEntryId, observedText) => {
            const candidate: Extract<AdapterExtractedAssetCandidate, { kind: "Memory" }> = {
                ...candidateBase(observedReadEntryId, "MEMORY.md", observedText, CATALOG_DIALECT),
                files: [],
                nativeRepresentation: {
                    representationSource: "separate_files",
                    dialectId: CATALOG_DIALECT,
                    files: [
                        {
                            relativePath: "MEMORY.md",
                            contentKind: "text",
                            mediaType: "text/markdown",
                            bytes: new Uint8Array(Buffer.from(observedText, "utf8")),
                            executable: false,
                        },
                    ],
                },
                sourceFileOrigins: [],
                kind: "Memory",
                typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
                memoryCatalogMemberBindingInputs: [{ rawTarget: "topic.md", routingTitle: "Topic", routingHint: "" }],
            };
            mutate(candidate);
            return candidate;
        }),
        "Memory",
    );
}

async function incompleteMemoryCatalogRead(
    inputs: Extract<AdapterExtractedAssetCandidate, { kind: "Memory" }>["memoryCatalogMemberBindingInputs"],
): Promise<AdapterReadResult> {
    return malformedMemoryRead((candidate) => {
        candidate.status = "incomplete";
        candidate.assetCandidateStatus = "incomplete";
        if (inputs === undefined) delete candidate.memoryCatalogMemberBindingInputs;
        else candidate.memoryCatalogMemberBindingInputs = inputs;
    });
}

async function subagentRead(): Promise<AdapterReadResult> {
    const text = JSON.stringify({ schemaVersion: 1, sections: [{ title: "Role", content: "Review" }] });
    fs.writeFileSync(sourceFile, text);
    return makeReadResultFromProvider(
        providerForCandidate("Subagent", (observedReadEntryId, observedText) => ({
            ...candidateBase(observedReadEntryId, "agent.json", observedText, "fixture-subagent-v1"),
            kind: "Subagent",
            typeData: subagentTypeData(),
        })),
        "Subagent",
    );
}

function batchDecision(candidateIdValue: string, callableBindings: ImportAcceptBatchCallableBindingV1[] = []) {
    return {
        candidateId: candidateIdValue,
        action: "create_asset" as const,
        freshness: { freshnessAction: "accept_preview_snapshot" as const, userActionId: "accept-preview" },
        promotion: { promotionAction: "import_only" as const, userActionId: "accept-import" },
        callableBindings,
    };
}

function candidateId(read: AdapterReadResult): string {
    const value = read.candidates[0]?.candidateId;
    if (value === undefined) throw new Error("candidate missing");
    return value;
}

function completeItem(
    items: Awaited<ReturnType<ReturnType<typeof memoryService>["acceptImportBatch"]>>["value"]["items"],
    wantedCandidateId: string,
) {
    const result = items.find((item) => item.candidateId === wantedCandidateId);
    if (result?.status !== "complete") throw new Error(`batch item did not complete: ${wantedCandidateId}`);
    return result;
}

async function acceptCatalogWithTarget(
    service: ReturnType<typeof memoryService>,
    catalog: AdapterReadResult,
    targetAssetVersionId: UuidV4,
) {
    return service.acceptImport(
        acceptRequest(service.previewImport([catalog]).value, {
            callableBindings: [
                {
                    subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                    targetAssetVersionId,
                },
            ],
        }),
    );
}
