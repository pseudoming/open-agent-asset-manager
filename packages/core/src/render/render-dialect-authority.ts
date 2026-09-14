/** Operation-local projection of immutable Version dialect authority. */

import type { NativePayloadClosureV1, RestorationPayloadClosureV1 } from "../catalog/version-authority";
import type { RequiredRenderSemantic } from "../contracts/deployment-authority";
import type { MemoryCatalogTypeDataV2 } from "../contracts/specs";
import type { AdapterNativeExactGraphRenderDeclarationV1, AdapterProviderSummary } from "../contracts/source-import";
import type {
    ProviderRenderDialectInputsForAsset,
    RenderVersionDialectInputs,
    RenderDeploymentInput,
    RenderNativeRepresentationFileInput,
    RenderTargetFileSnapshotV1,
} from "../contracts/render";
import type { VersionRef } from "../types";
import type { VersionDialectRestorationPayloadRefV1, VersionNativeRepresentation } from "../contracts/persistence";
import { normalizeText } from "../catalog/payload-store";
import { compareUtf8Bytes } from "../foundation/text-order";
import { versionRefKey } from "./render-semantics";
import { stableStringify } from "../foundation/fingerprint";
import { projectCanonicalDirectoryAuthority } from "./canonical-materialization-directories";
import { renderDialectScopeKey } from "./render-dialect-scope";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type { RenderRegistrySnapshot } from "./render-registry";
import { projectCanonicalNativePreservationSeed } from "./canonical-native-preservation-seed";

export function projectVersionDialectInputs(
    targetVersion: VersionRef,
    closure: {
        nativeRepresentations: readonly VersionNativeRepresentation[];
        dialectRestorationPayloads: readonly VersionDialectRestorationPayloadRefV1[];
        nativePayloads: readonly NativePayloadClosureV1[];
        restorationPayloads: readonly RestorationPayloadClosureV1[];
    },
    parent?: {
        sourceVersion: VersionRef;
        closure: {
            nativeRepresentations: readonly VersionNativeRepresentation[];
            nativePayloads: readonly NativePayloadClosureV1[];
        };
    },
): RenderVersionDialectInputs | null {
    const inputs: ProviderRenderDialectInputsForAsset["inputs"] = [];
    projectNativeRepresentations(inputs, "current_exact", closure.nativeRepresentations, closure.nativePayloads);
    if (parent !== undefined) {
        if (
            parent.sourceVersion.assetId !== targetVersion.assetId ||
            parent.sourceVersion.versionId === targetVersion.versionId
        ) {
            throw new Error("Version parent dialect authority is not an immediate same-Asset predecessor");
        }
        projectNativeRepresentations(
            inputs,
            "parent_rebase_seed",
            parent.closure.nativeRepresentations,
            parent.closure.nativePayloads,
            parent.sourceVersion,
        );
    }
    for (const descriptor of closure.dialectRestorationPayloads) {
        const payload = closure.restorationPayloads.find((candidate) => candidate.dialectId === descriptor.dialectId);
        if (payload === undefined) throw new Error("Version restoration payload closure is incomplete");
        inputs.push({
            inputKind: "dialect_restoration",
            restoration: structuredClone(descriptor),
            content: { contentKind: "binary", bytes: new Uint8Array(payload.bytes) },
        });
    }
    inputs.sort((left, right) => compareUtf8Bytes(dialectInputOrderKey(left), dialectInputOrderKey(right)));
    return inputs.length === 0 ? null : { targetVersion: structuredClone(targetVersion), inputs };
}

function projectNativeRepresentations(
    inputs: ProviderRenderDialectInputsForAsset["inputs"],
    inputRole: "current_exact" | "parent_rebase_seed",
    representations: readonly VersionNativeRepresentation[],
    payloads: readonly NativePayloadClosureV1[],
    sourceVersion?: VersionRef,
): void {
    for (const representation of representations) {
        const payload = payloads.find((candidate) => candidate.dialectId === representation.dialectId);
        if (payload === undefined || payload.files.length !== representation.files.length) {
            throw new Error("Version native payload closure is incomplete");
        }
        const { files: descriptors, ...metadata } = representation;
        const files = descriptors.map((descriptor): RenderNativeRepresentationFileInput => {
            const payloadFile = payload.files.find((candidate) => candidate.relativePath === descriptor.relativePath);
            if (payloadFile === undefined) throw new Error("Version native payload path is missing");
            if (descriptor.contentKind === "binary") {
                return { ...structuredClone(descriptor), contentKind: "binary", bytes: new Uint8Array(payloadFile.bytes) };
            }
            const text = new TextDecoder("utf-8", { fatal: true }).decode(payloadFile.bytes);
            if (normalizeText(text).normalized !== text) {
                throw new Error("Version native text payload is not normalized");
            }
            return { ...structuredClone(descriptor), contentKind: "text", text };
        });
        inputs.push(
            inputRole === "current_exact"
                ? {
                      inputKind: "native_representation",
                      inputRole,
                      representation: structuredClone(metadata),
                      files,
                  }
                : {
                      inputKind: "native_representation",
                      inputRole,
                      sourceVersion: structuredClone(sourceVersion as VersionRef),
                      representation: structuredClone(metadata),
                      files,
                  },
        );
    }
}

export function resolveProviderExactFileDialectInputs(input: {
    provider: AdapterProviderSummary;
    deployment: RenderDeploymentInput;
    semantics: readonly RequiredRenderSemantic[];
    available: readonly RenderVersionDialectInputs[];
    dialectRegistry?: VersionDialectRegistryV1;
    renderRegistry?: RenderRegistrySnapshot;
}): ProviderRenderDialectInputsForAsset[] {
    interface ExactCellProjection {
        outputContractId: string;
        materializationProfileId: string;
        nativeDialectId: string;
        targetContextSchemaId: string;
        rebaseEnabled: boolean;
        canonicalMaterialization: NonNullable<AdapterNativeExactGraphRenderDeclarationV1["canonicalMaterialization"]> | null;
        restorationDialectIds: string[];
    }
    const exactCells = new Map<string, ExactCellProjection[]>();
    for (const declaration of input.provider.renderContractDeclarations) {
        if (
            declaration.declarationKind !== "native_project_exact_file_v1" &&
            declaration.declarationKind !== "native_project_encoded_file_v1" &&
            declaration.declarationKind !== "native_global_encoded_file_v1" &&
            declaration.declarationKind !== "native_project_exact_graph_v1" &&
            declaration.declarationKind !== "native_global_exact_graph_v1"
        ) {
            continue;
        }
        const key = `${declaration.agentRuntimeId}\0${declaration.assetKind}`;
        const cells = exactCells.get(key) ?? [];
        cells.push({
            outputContractId: declaration.outputContractId,
            materializationProfileId: declaration.materializationProfileId,
            nativeDialectId: declaration.nativeDialectId,
            targetContextSchemaId: declaration.target.targetContextSchemaId,
            rebaseEnabled: declaration.rebaseMaterializer !== null,
            canonicalMaterialization:
                "canonicalMaterialization" in declaration ? (declaration.canonicalMaterialization ?? null) : null,
            restorationDialectIds: declaration.restorationDialectIds,
        });
        exactCells.set(key, cells);
    }
    const assetByVersion = new Map(input.deployment.assets.map((asset) => [versionRefKey(asset.version.ref), asset]));
    const selectedCellsByVersion = new Map<
        string,
        {
            asset: RenderDeploymentInput["assets"][number];
            consumerAgentRuntimeId: RequiredRenderSemantic["consumerAgentRuntimeId"];
            cells: Map<string, ExactCellProjection>;
            ambiguous: boolean;
        }
    >();
    for (const semantic of input.semantics) {
        const asset = assetByVersion.get(versionRefKey(semantic.subject));
        if (asset === undefined) continue;
        const cells = exactCellsForTargetContext(
            exactCells,
            input.deployment,
            semantic.consumerAgentRuntimeId,
            asset.version.canonical.kind,
        );
        if (cells.length === 0) continue;
        const versionKey = renderDialectScopeKey(semantic.consumerAgentRuntimeId, asset.version.ref);
        const selection = selectedCellsByVersion.get(versionKey) ?? {
            asset,
            consumerAgentRuntimeId: semantic.consumerAgentRuntimeId,
            cells: new Map(),
            ambiguous: false,
        };
        addExactCells(selection, cells);
        selectedCellsByVersion.set(versionKey, selection);
    }
    for (const [versionKey, selection] of [...selectedCellsByVersion.entries()]) {
        const catalog = selection.asset;
        if (catalog.version.canonical.kind !== "Memory" || catalog.version.canonical.typeData.entityRole !== "catalog") continue;
        const catalogCanonical = catalog.version.canonical as { kind: "Memory"; typeData: MemoryCatalogTypeDataV2 };
        for (const member of catalogCanonical.typeData.members) {
            const memberAsset = input.deployment.assets.find(
                (asset) => asset.version.ref.versionId === member.targetAssetVersionId,
            );
            if (
                memberAsset === undefined ||
                memberAsset.version.canonical.kind !== "Memory" ||
                memberAsset.version.canonical.typeData.entityRole !== "unit"
            ) {
                continue;
            }
            const memberVersionKey = renderDialectScopeKey(selection.consumerAgentRuntimeId, memberAsset.version.ref);
            const memberSelection = selectedCellsByVersion.get(memberVersionKey) ?? {
                asset: memberAsset,
                consumerAgentRuntimeId: selection.consumerAgentRuntimeId,
                cells: new Map<string, ExactCellProjection>(),
                ambiguous: false,
            };
            addExactCells(
                memberSelection,
                exactCellsForTargetContext(exactCells, input.deployment, selection.consumerAgentRuntimeId, "Memory"),
            );
            selectedCellsByVersion.set(memberVersionKey, memberSelection);
        }
        selectedCellsByVersion.set(versionKey, selection);
    }
    const availableByVersion = new Map(input.available.map((group) => [versionRefKey(group.targetVersion), group]));
    const projected = [...selectedCellsByVersion.values()].flatMap(
        ({ asset, consumerAgentRuntimeId, cells: selected, ambiguous }): ProviderRenderDialectInputsForAsset[] => {
            if (ambiguous) return [];
            const group = availableByVersion.get(versionRefKey(asset.version.ref)) ?? {
                targetVersion: asset.version.ref,
                inputs: [],
            };
            const nativeInputs = [...selected.values()].flatMap((cell) => {
                const current = group.inputs.find(
                    (candidate) =>
                        candidate.inputKind === "native_representation" &&
                        candidate.inputRole === "current_exact" &&
                        candidate.representation.dialectId === cell.nativeDialectId,
                );
                if (current !== undefined) return [structuredClone(current)];
                if (!cell.rebaseEnabled) return [];
                const parent = group.inputs.find(
                    (candidate) =>
                        candidate.inputKind === "native_representation" &&
                        candidate.inputRole === "parent_rebase_seed" &&
                        candidate.representation.dialectId === cell.nativeDialectId,
                );
                return parent === undefined ? [] : [structuredClone(parent)];
            });
            const directoryAuthority = nativeInputs.length === 0 ? projectCanonicalDirectoryAuthority(asset, group) : {};
            if (directoryAuthority === null) return [];
            const canonicalInputs =
                nativeInputs.length === 0
                    ? [...selected.values()].flatMap((cell) => {
                          if (cell.canonicalMaterialization === null) return [];
                          const preservation = projectCanonicalNativePreservationSeed(
                              asset,
                              group,
                              cell.canonicalMaterialization.preservationDialectIds,
                              input.dialectRegistry,
                          );
                          if (preservation === null) return [];
                          // Precise assessment must not treat a present but unselected private source as canonical-only.
                          if (
                              cell.canonicalMaterialization.requiresNativeSourceAssessment === true &&
                              group.inputs.some(
                                  (item) =>
                                      item.inputKind === "native_representation" &&
                                      item.inputRole === "current_exact" &&
                                      item.representation.dialectId !==
                                          preservation.nativePreservationSeed?.representation.dialectId,
                              )
                          )
                              return [];
                          const degradationKinds =
                              cell.canonicalMaterialization.assessesLoss === true
                                  ? (input.renderRegistry?.assessCanonicalMaterialization({
                                        adapterId: input.provider.adapterId,
                                        adapterVersion: input.provider.version,
                                        outputContractId: cell.outputContractId,
                                        materializationProfileId: cell.materializationProfileId,
                                        materializer: cell.canonicalMaterialization.materializer,
                                        asset,
                                        ...preservation,
                                    }) ?? null)
                                  : structuredClone(cell.canonicalMaterialization.degradationKinds);
                          if (degradationKinds === null) return [];
                          return [
                              {
                                  inputKind: "canonical_materialization" as const,
                                  ...preservation,
                                  ...directoryAuthority,
                                  nativeDialectId: cell.nativeDialectId,
                                  materializer: structuredClone(cell.canonicalMaterialization.materializer),
                                  degradationKinds,
                                  ...(cell.canonicalMaterialization.substituteAssetKind === undefined
                                      ? {}
                                      : { substituteAssetKind: cell.canonicalMaterialization.substituteAssetKind }),
                                  reasonCode: cell.canonicalMaterialization.reasonCode,
                              },
                          ];
                      })
                    : [];
            const restorationIds = new Set([...selected.values()].flatMap((cell) => cell.restorationDialectIds));
            const restorationInputs = group.inputs
                .filter(
                    (candidate) =>
                        candidate.inputKind === "dialect_restoration" && restorationIds.has(candidate.restoration.dialectId),
                )
                .map((candidate) => structuredClone(candidate));
            const inputs = [...nativeInputs, ...canonicalInputs, ...restorationInputs].sort((left, right) =>
                compareUtf8Bytes(dialectInputOrderKey(left), dialectInputOrderKey(right)),
            );
            return nativeInputs.length + canonicalInputs.length !== 1 || restorationInputs.length !== restorationIds.size
                ? []
                : [
                      {
                          targetVersion: structuredClone(group.targetVersion),
                          consumerAgentRuntimeIds: [consumerAgentRuntimeId],
                          inputs,
                      },
                  ];
        },
    );
    const shared = new Map<string, ProviderRenderDialectInputsForAsset>();
    for (const group of projected) {
        const key = stableStringify({ targetVersion: group.targetVersion, inputs: group.inputs });
        const previous = shared.get(key);
        if (previous === undefined) shared.set(key, group);
        else previous.consumerAgentRuntimeIds.push(...group.consumerAgentRuntimeIds);
    }
    for (const group of shared.values()) group.consumerAgentRuntimeIds.sort(compareUtf8Bytes);
    return [...shared.values()].sort((left, right) =>
        compareUtf8Bytes(
            `${versionRefKey(left.targetVersion)}\0${left.consumerAgentRuntimeIds.join("\0")}`,
            `${versionRefKey(right.targetVersion)}\0${right.consumerAgentRuntimeIds.join("\0")}`,
        ),
    );
}

function exactCellsForTargetContext<T extends { nativeDialectId: string; targetContextSchemaId: string }>(
    exactCells: ReadonlyMap<string, readonly T[]>,
    deployment: RenderDeploymentInput,
    agentRuntimeId: string,
    assetKind: string,
): readonly T[] {
    const contexts = deployment.targetContexts.filter((context) => context.agentRuntimeId === agentRuntimeId);
    if (contexts.length !== 1) return [];
    const targetContextSchemaId = contexts[0]?.targetContextSchemaId;
    return (exactCells.get(`${agentRuntimeId}\0${assetKind}`) ?? []).filter(
        (cell) => cell.targetContextSchemaId === targetContextSchemaId,
    );
}

function addExactCells<T extends { nativeDialectId: string }>(
    selection: { cells: Map<string, T>; ambiguous: boolean },
    cells: readonly T[],
): void {
    for (const cell of cells) {
        const previous = selection.cells.get(cell.nativeDialectId);
        if (previous !== undefined && previous !== cell) selection.ambiguous = true;
        else selection.cells.set(cell.nativeDialectId, cell);
    }
}

export function projectProviderTargetFileSnapshots(input: {
    targetFileSnapshots: readonly RenderTargetFileSnapshotV1[] | undefined;
    dialectInputs: readonly ProviderRenderDialectInputsForAsset[];
}): RenderTargetFileSnapshotV1[] | undefined {
    if (input.targetFileSnapshots === undefined) return undefined;
    const ownedPaths = new Set(
        input.dialectInputs.flatMap((group) =>
            group.inputs.flatMap((dialectInput) =>
                dialectInput.inputKind === "native_representation" ? dialectInput.files.map((file) => file.relativePath) : [],
            ),
        ),
    );
    const projected = input.targetFileSnapshots
        .filter((snapshot) => ownedPaths.has(snapshot.relativePath))
        .map((snapshot) => structuredClone(snapshot));
    return projected.length === 0 ? undefined : projected;
}

function dialectInputOrderKey(input: ProviderRenderDialectInputsForAsset["inputs"][number]): string {
    if (input.inputKind === "dialect_restoration") return `restoration\0${input.restoration.dialectId}`;
    if (input.inputKind === "canonical_materialization") return `canonical\0${input.nativeDialectId}`;
    return `native\0${input.inputRole}\0${input.representation.dialectId}`;
}
