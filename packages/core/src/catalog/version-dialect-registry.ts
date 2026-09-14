import type {
    AdapterDialectContractSetV1,
    AdapterNativeDialectContractV1,
    AdapterPortableEntryDialectContractV1,
    AdapterPortableSelectorDialectContractV1,
    AdapterRestorationDialectContractV1,
    NativeDialectContractDefinitionV1,
    NativeDialectValidationInputV1,
    NativeDialectGraphRebaseMaterializerV1,
    PortableEntryDialectContractDefinitionV1,
    PortableEntryDialectFieldV1,
    PortableEntryDialectValidationInputV1,
    PortableDialectSourceRuntimeV1,
    PortableSelectorDialectContractDefinitionV1,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
    RestorationDialectContractDefinitionV1,
} from "../contracts/dialect";
import type { AssetKind, Sha256Digest } from "../contracts/primitives";
import type { VersionedContractComponentRef } from "../contracts/render";
import {
    stableStringify,
    computeNativeDialectContractFingerprint,
    computePortableEntryDialectContractFingerprint,
    computePortableSelectorDialectContractFingerprint,
    computeRestorationDialectContractFingerprint,
} from "../foundation/fingerprint";
import { deepFreezeParentFirst } from "../foundation/deep-freeze";
import { hasExactKeys, isSha256Digest } from "../foundation/validators";

const ASSET_KINDS = new Set<AssetKind>(["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"]);
const VERSIONED_DIALECT_ID = /-v[1-9][0-9]*$/;
const PORTABLE_ENTRY_FIELDS = new Set<PortableEntryDialectFieldV1>([
    "workflow_instruction",
    "workflow_executable",
    "skill_entry",
    "subagent_initial_prompt",
]);
const PORTABLE_SELECTOR_FIELDS = new Set<PortableSelectorDialectFieldV1>([
    "workflow_tool",
    "workflow_model",
    "workflow_effort",
    "workflow_shell",
    "skill_tool",
    "skill_agent",
    "skill_model",
    "skill_effort",
    "subagent_context",
    "subagent_tool",
    "subagent_permission",
    "subagent_model",
    "subagent_effort",
    "subagent_turn_limit",
    "subagent_color",
]);

export interface NativeDialectContractV1 {
    kind: AssetKind;
    dialectId: string;
    contractFingerprint: Sha256Digest;
    validateSameContent(input: NativeDialectValidationInputV1): boolean;
    rebaseNativeGraph?: NativeDialectGraphRebaseMaterializerV1["materialize"];
}

export interface RestorationDialectContractV1 {
    kind: AssetKind;
    dialectId: string;
    contractFingerprint: Sha256Digest;
    validatePayload(bytes: Uint8Array): boolean;
}

export interface PortableEntryDialectContractV1 {
    kind: AssetKind;
    field: PortableEntryDialectFieldV1;
    dialectId: string;
    applicableAgentRuntimeIds: readonly string[];
    contractFingerprint: Sha256Digest;
    validateCanonicalEntry(input: PortableEntryDialectValidationInputV1): boolean;
    validateSourceApplicability(source: PortableDialectSourceRuntimeV1): boolean;
}

export interface PortableSelectorDialectContractV1 {
    kind: AssetKind;
    field: PortableSelectorDialectFieldV1;
    dialectId: string;
    applicableAgentRuntimeIds: readonly string[];
    contractFingerprint: Sha256Digest;
    validateSelector(use: PortableSelectorDialectUseV1): boolean;
    validateSourceApplicability(source: PortableDialectSourceRuntimeV1): boolean;
}

export interface VersionDialectRegistryV1 {
    getNative(kind: AssetKind, dialectId: string): NativeDialectContractV1 | null;
    getRestoration(kind: AssetKind, dialectId: string): RestorationDialectContractV1 | null;
    getPortableEntry(
        kind: AssetKind,
        field: PortableEntryDialectFieldV1,
        dialectId: string,
    ): PortableEntryDialectContractV1 | null;
    getPortableSelector(
        kind: AssetKind,
        field: PortableSelectorDialectFieldV1,
        dialectId: string,
    ): PortableSelectorDialectContractV1 | null;
}

export function createVersionDialectRegistry(
    nativeContracts: readonly AdapterNativeDialectContractV1[],
    restorationContracts: readonly AdapterRestorationDialectContractV1[],
    portableEntryContracts: readonly AdapterPortableEntryDialectContractV1[],
    portableSelectorContracts: readonly AdapterPortableSelectorDialectContractV1[],
): VersionDialectRegistryV1 {
    const native = indexContracts(nativeContracts.map(resolveNative), "native");
    const restoration = indexContracts(restorationContracts.map(resolveRestoration), "restoration");
    const portableEntries = indexPortableContracts(portableEntryContracts.map(resolvePortableEntry), "portable entry");
    const portableSelectors = indexPortableContracts(portableSelectorContracts.map(resolvePortableSelector), "portable selector");
    return Object.freeze({
        getNative: (kind: AssetKind, dialectId: string) => native.get(contractKey(kind, dialectId)) ?? null,
        getRestoration: (kind: AssetKind, dialectId: string) => restoration.get(contractKey(kind, dialectId)) ?? null,
        getPortableEntry: (kind: AssetKind, field: PortableEntryDialectFieldV1, dialectId: string) =>
            portableEntries.get(portableContractKey(kind, field, dialectId)) ?? null,
        getPortableSelector: (kind: AssetKind, field: PortableSelectorDialectFieldV1, dialectId: string) =>
            portableSelectors.get(portableContractKey(kind, field, dialectId)) ?? null,
    });
}

export function snapshotAdapterDialectContracts(contracts: AdapterDialectContractSetV1): AdapterDialectContractSetV1 {
    assertContractSetShape(contracts);
    return Object.freeze({
        native: Object.freeze(contracts.native.map(snapshotNative)) as unknown as AdapterNativeDialectContractV1[],
        restoration: Object.freeze(
            contracts.restoration.map(snapshotRestoration),
        ) as unknown as AdapterRestorationDialectContractV1[],
        portableEntries: Object.freeze(
            contracts.portableEntries.map(snapshotPortableEntry),
        ) as unknown as AdapterPortableEntryDialectContractV1[],
        portableSelectors: Object.freeze(
            contracts.portableSelectors.map(snapshotPortableSelector),
        ) as unknown as AdapterPortableSelectorDialectContractV1[],
    });
}

export function assertAdapterDialectContracts(contracts: AdapterDialectContractSetV1): void {
    assertContractSetShape(contracts);
    createVersionDialectRegistry(contracts.native, contracts.restoration, contracts.portableEntries, contracts.portableSelectors);
}

export const EMPTY_VERSION_DIALECT_REGISTRY = createVersionDialectRegistry([], [], [], []);

function resolveNative(contract: AdapterNativeDialectContractV1): NativeDialectContractV1 {
    const snapshot = snapshotNative(contract);
    const materialize = snapshot.rebase?.materialize;
    const rebaseNativeGraph: NativeDialectGraphRebaseMaterializerV1["materialize"] | undefined =
        materialize === undefined
            ? undefined
            : (input) => {
                  try {
                      if (input.assetKind !== snapshot.definition.kind || input.nativeDialectId !== snapshot.definition.dialectId)
                          return null;
                      return structuredClone(materialize(structuredClone(input)));
                  } catch {
                      return null;
                  }
              };
    return Object.freeze({
        kind: snapshot.definition.kind,
        dialectId: snapshot.definition.dialectId,
        contractFingerprint: computeNativeDialectContractFingerprint(snapshot.definition),
        ...(rebaseNativeGraph === undefined ? {} : { rebaseNativeGraph }),
        validateSameContent: (input: NativeDialectValidationInputV1) => {
            try {
                return snapshot.validateSameContent(structuredClone(input)) === true;
            } catch {
                return false;
            }
        },
    });
}

function resolveRestoration(contract: AdapterRestorationDialectContractV1): RestorationDialectContractV1 {
    const snapshot = snapshotRestoration(contract);
    return Object.freeze({
        kind: snapshot.definition.kind,
        dialectId: snapshot.definition.dialectId,
        contractFingerprint: computeRestorationDialectContractFingerprint(snapshot.definition),
        validatePayload: (bytes: Uint8Array) => {
            try {
                return snapshot.validatePayload(new Uint8Array(bytes)) === true;
            } catch {
                return false;
            }
        },
    });
}

function resolvePortableEntry(contract: AdapterPortableEntryDialectContractV1): PortableEntryDialectContractV1 {
    const snapshot = snapshotPortableEntry(contract);
    return Object.freeze({
        kind: snapshot.definition.kind,
        field: snapshot.definition.field,
        dialectId: snapshot.definition.dialectId,
        applicableAgentRuntimeIds: snapshot.definition.applicableAgentRuntimeIds,
        contractFingerprint: computePortableEntryDialectContractFingerprint(snapshot.definition),
        validateCanonicalEntry: (input: PortableEntryDialectValidationInputV1) => {
            try {
                return snapshot.validateCanonicalEntry(structuredClone(input)) === true;
            } catch {
                return false;
            }
        },
        validateSourceApplicability: (source: PortableDialectSourceRuntimeV1) => {
            try {
                return snapshot.validateSourceApplicability(structuredClone(source)) === true;
            } catch {
                return false;
            }
        },
    });
}

function resolvePortableSelector(contract: AdapterPortableSelectorDialectContractV1): PortableSelectorDialectContractV1 {
    const snapshot = snapshotPortableSelector(contract);
    return Object.freeze({
        kind: snapshot.definition.kind,
        field: snapshot.definition.field,
        dialectId: snapshot.definition.dialectId,
        applicableAgentRuntimeIds: snapshot.definition.applicableAgentRuntimeIds,
        contractFingerprint: computePortableSelectorDialectContractFingerprint(snapshot.definition),
        validateSelector: (use: PortableSelectorDialectUseV1) => {
            try {
                return snapshot.validateSelector(structuredClone(use)) === true;
            } catch {
                return false;
            }
        },
        validateSourceApplicability: (source: PortableDialectSourceRuntimeV1) => {
            try {
                return snapshot.validateSourceApplicability(structuredClone(source)) === true;
            } catch {
                return false;
            }
        },
    });
}

function snapshotNative(contract: AdapterNativeDialectContractV1): AdapterNativeDialectContractV1 {
    if (typeof contract !== "object" || contract === null) {
        throw new Error("native dialect contract must be an object");
    }
    const hasRebase = Object.hasOwn(contract, "rebase");
    assertExactKeys(
        contract,
        hasRebase ? ["definition", "validateSameContent", "rebase"] : ["definition", "validateSameContent"],
        "native dialect contract",
    );
    assertNativeDefinition(contract.definition);
    if (typeof contract.validateSameContent !== "function") {
        throw new Error("native dialect validator must be a function");
    }
    const rebase = hasRebase ? contract.rebase : undefined;
    if (
        hasRebase &&
        (rebase === undefined ||
            !hasExactKeys(rebase, ["ref", "materialize"]) ||
            typeof rebase.materialize !== "function" ||
            contract.definition.rebaseMaterializer === null ||
            stableStringify(rebase.ref) !== stableStringify(contract.definition.rebaseMaterializer))
    ) {
        throw new Error("native graph rebase must match the declared component");
    }
    return Object.freeze({
        definition: deepFreezeParentFirst(structuredClone(contract.definition)),
        validateSameContent: contract.validateSameContent,
        ...(rebase === undefined
            ? {}
            : {
                  rebase: Object.freeze({
                      ref: deepFreezeParentFirst(structuredClone(rebase.ref)),
                      materialize: rebase.materialize,
                  }),
              }),
    });
}

function snapshotRestoration(contract: AdapterRestorationDialectContractV1): AdapterRestorationDialectContractV1 {
    if (typeof contract !== "object" || contract === null) {
        throw new Error("restoration dialect contract must be an object");
    }
    assertExactKeys(contract, ["definition", "validatePayload"], "restoration dialect contract");
    assertRestorationDefinition(contract.definition);
    if (typeof contract.validatePayload !== "function") {
        throw new Error("restoration dialect validator must be a function");
    }
    return Object.freeze({
        definition: deepFreezeParentFirst(structuredClone(contract.definition)),
        validatePayload: contract.validatePayload,
    });
}

function snapshotPortableEntry(contract: AdapterPortableEntryDialectContractV1): AdapterPortableEntryDialectContractV1 {
    if (typeof contract !== "object" || contract === null) {
        throw new Error("portable entry dialect contract must be an object");
    }
    assertExactKeys(
        contract,
        ["definition", "validateCanonicalEntry", "validateSourceApplicability"],
        "portable entry dialect contract",
    );
    assertPortableEntryDefinition(contract.definition);
    if (typeof contract.validateCanonicalEntry !== "function") {
        throw new Error("portable entry dialect validator must be a function");
    }
    if (typeof contract.validateSourceApplicability !== "function") {
        throw new Error("portable entry source applicability validator must be a function");
    }
    return Object.freeze({
        definition: deepFreezeParentFirst(structuredClone(contract.definition)),
        validateCanonicalEntry: contract.validateCanonicalEntry,
        validateSourceApplicability: contract.validateSourceApplicability,
    });
}

function snapshotPortableSelector(contract: AdapterPortableSelectorDialectContractV1): AdapterPortableSelectorDialectContractV1 {
    if (typeof contract !== "object" || contract === null) {
        throw new Error("portable selector dialect contract must be an object");
    }
    assertExactKeys(
        contract,
        ["definition", "validateSelector", "validateSourceApplicability"],
        "portable selector dialect contract",
    );
    assertPortableSelectorDefinition(contract.definition);
    if (typeof contract.validateSelector !== "function") {
        throw new Error("portable selector dialect validator must be a function");
    }
    if (typeof contract.validateSourceApplicability !== "function") {
        throw new Error("portable selector source applicability validator must be a function");
    }
    return Object.freeze({
        definition: deepFreezeParentFirst(structuredClone(contract.definition)),
        validateSelector: contract.validateSelector,
        validateSourceApplicability: contract.validateSourceApplicability,
    });
}

function assertNativeDefinition(definition: NativeDialectContractDefinitionV1): void {
    assertExactKeys(
        definition,
        [
            "kind",
            "dialectId",
            "nativeFileGraphSchema",
            "contentNormalization",
            "nativeToCanonicalParser",
            "canonicalConsistencyValidator",
            "rebaseMaterializer",
            "targetApplicabilityPredicate",
        ],
        "native dialect definition",
    );
    assertIdentity(definition.kind, definition.dialectId);
    assertComponent(definition.nativeFileGraphSchema, "nativeFileGraphSchema");
    assertComponent(definition.contentNormalization, "contentNormalization");
    assertComponent(definition.nativeToCanonicalParser, "nativeToCanonicalParser");
    assertComponent(definition.canonicalConsistencyValidator, "canonicalConsistencyValidator");
    assertOptionalComponent(definition.rebaseMaterializer, "rebaseMaterializer");
    assertOptionalComponent(definition.targetApplicabilityPredicate, "targetApplicabilityPredicate");
}

function assertRestorationDefinition(definition: RestorationDialectContractDefinitionV1): void {
    assertExactKeys(
        definition,
        ["kind", "dialectId", "payloadCodecValidator", "transitionValidator"],
        "restoration dialect definition",
    );
    assertIdentity(definition.kind, definition.dialectId);
    assertComponent(definition.payloadCodecValidator, "payloadCodecValidator");
    assertComponent(definition.transitionValidator, "transitionValidator");
}

function assertPortableEntryDefinition(definition: PortableEntryDialectContractDefinitionV1): void {
    assertExactKeys(
        definition,
        ["kind", "field", "dialectId", "applicableAgentRuntimeIds", "canonicalEntryValidator", "sourceApplicabilityValidator"],
        "portable entry dialect definition",
    );
    assertIdentity(definition.kind, definition.dialectId);
    if (!PORTABLE_ENTRY_FIELDS.has(definition.field)) {
        throw new Error("portable entry dialect field is invalid");
    }
    assertPortableFieldKind(definition.kind, definition.field);
    assertAgentRuntimeIds(definition.applicableAgentRuntimeIds);
    assertComponent(definition.canonicalEntryValidator, "canonicalEntryValidator");
    assertComponent(definition.sourceApplicabilityValidator, "sourceApplicabilityValidator");
}

function assertPortableSelectorDefinition(definition: PortableSelectorDialectContractDefinitionV1): void {
    assertExactKeys(
        definition,
        ["kind", "field", "dialectId", "applicableAgentRuntimeIds", "selectorSemanticsValidator", "sourceApplicabilityValidator"],
        "portable selector dialect definition",
    );
    assertIdentity(definition.kind, definition.dialectId);
    if (!PORTABLE_SELECTOR_FIELDS.has(definition.field)) {
        throw new Error("portable selector dialect field is invalid");
    }
    assertPortableFieldKind(definition.kind, definition.field);
    assertAgentRuntimeIds(definition.applicableAgentRuntimeIds);
    assertComponent(definition.selectorSemanticsValidator, "selectorSemanticsValidator");
    assertComponent(definition.sourceApplicabilityValidator, "sourceApplicabilityValidator");
}

function assertContractSetShape(contracts: AdapterDialectContractSetV1): void {
    if (typeof contracts !== "object" || contracts === null) {
        throw new Error("provider dialectContracts must be an object");
    }
    assertExactKeys(contracts, ["native", "restoration", "portableEntries", "portableSelectors"], "provider dialectContracts");
    if (
        !Array.isArray(contracts.native) ||
        !Array.isArray(contracts.restoration) ||
        !Array.isArray(contracts.portableEntries) ||
        !Array.isArray(contracts.portableSelectors)
    ) {
        throw new Error("provider dialect contract collections must be arrays");
    }
}

function assertPortableFieldKind(kind: AssetKind, field: PortableEntryDialectFieldV1 | PortableSelectorDialectFieldV1): void {
    const expectedKind = field.startsWith("workflow_") ? "Workflow" : field.startsWith("skill_") ? "Skill" : "Subagent";
    if (kind !== expectedKind) {
        throw new Error("portable dialect field does not belong to its AssetKind");
    }
}

function assertAgentRuntimeIds(agentRuntimeIds: readonly string[]): void {
    if (
        !Array.isArray(agentRuntimeIds) ||
        agentRuntimeIds.length === 0 ||
        agentRuntimeIds.some(
            (agentRuntimeId) =>
                typeof agentRuntimeId !== "string" || agentRuntimeId.trim() !== agentRuntimeId || agentRuntimeId.length === 0,
        ) ||
        agentRuntimeIds.some((agentRuntimeId, index) => index > 0 && agentRuntimeIds[index - 1] >= agentRuntimeId)
    ) {
        throw new Error("portable dialect applicableAgentRuntimeIds must be sorted unique non-blank ids");
    }
}

function assertIdentity(kind: AssetKind, dialectId: string): void {
    if (!ASSET_KINDS.has(kind)) throw new Error("dialect contract AssetKind is invalid");
    if (typeof dialectId !== "string" || dialectId.trim() !== dialectId || !VERSIONED_DIALECT_ID.test(dialectId)) {
        throw new Error("dialectId must be a non-blank immutable id ending in -vN");
    }
}

function assertOptionalComponent(ref: VersionedContractComponentRef | null, label: string): void {
    if (ref !== null) assertComponent(ref, label);
}

function assertComponent(ref: VersionedContractComponentRef, label: string): void {
    if (typeof ref !== "object" || ref === null) {
        throw new Error(`${label} must be a component ref`);
    }
    assertExactKeys(ref, ["componentId", "componentVersion", "configFingerprint"], label);
    if (
        typeof ref.componentId !== "string" ||
        ref.componentId.trim() !== ref.componentId ||
        ref.componentId.length === 0 ||
        !Number.isInteger(ref.componentVersion) ||
        ref.componentVersion <= 0 ||
        !isSha256Digest(ref.configFingerprint)
    ) {
        throw new Error(`${label} is not a canonical versioned component ref`);
    }
}

function indexContracts<T extends { kind: AssetKind; dialectId: string }>(
    contracts: readonly T[],
    label: string,
): ReadonlyMap<string, T> {
    const result = new Map<string, T>();
    for (const contract of contracts) {
        const key = contractKey(contract.kind, contract.dialectId);
        if (result.has(key)) throw new Error(`duplicate ${label} dialect contract: ${key}`);
        result.set(key, contract);
    }
    return result;
}

function indexPortableContracts<
    T extends {
        kind: AssetKind;
        field: PortableEntryDialectFieldV1 | PortableSelectorDialectFieldV1;
        dialectId: string;
    },
>(contracts: readonly T[], label: string): ReadonlyMap<string, T> {
    const result = new Map<string, T>();
    for (const contract of contracts) {
        const key = portableContractKey(contract.kind, contract.field, contract.dialectId);
        if (result.has(key)) throw new Error(`duplicate ${label} dialect contract: ${key}`);
        result.set(key, contract);
    }
    return result;
}

function contractKey(kind: AssetKind, dialectId: string): string {
    return `${kind}\0${dialectId}`;
}

function portableContractKey(
    kind: AssetKind,
    field: PortableEntryDialectFieldV1 | PortableSelectorDialectFieldV1,
    dialectId: string,
): string {
    return `${kind}\0${field}\0${dialectId}`;
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
    if (!hasExactKeys(value, expected)) {
        throw new Error(`${label} has unknown or missing fields`);
    }
}
