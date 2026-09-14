import type {
    AdapterNativeDialectContractV1,
    AdapterPortableEntryDialectContractV1,
    AdapterPortableSelectorDialectContractV1,
    AdapterRestorationDialectContractV1,
    AgentRuntimeId,
    AssetKind,
    NativeDialectContractDefinitionV1,
    NativeDialectValidationInputV1,
    PortableEntryDialectFieldV1,
    PortableEntryDialectValidationInputV1,
    PortableDialectSourceRuntimeV1,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
    RestorationDialectContractDefinitionV1,
    Sha256Digest,
    VersionedContractComponentRef,
} from "../../../src/types";
import {
    computeNativeDialectContractFingerprint,
    computeRestorationDialectContractFingerprint,
} from "../../../src/foundation/fingerprint";

const DEFAULT_CONFIG = `sha256:${"a".repeat(64)}` as Sha256Digest;

export function makeNativeDialectDefinition(
    kind: AssetKind,
    dialectId: string,
    configFingerprint: Sha256Digest = DEFAULT_CONFIG,
): NativeDialectContractDefinitionV1 {
    return {
        kind,
        dialectId,
        nativeFileGraphSchema: component(`${dialectId}.file-graph`, configFingerprint),
        contentNormalization: component(`${dialectId}.normalization`, configFingerprint),
        nativeToCanonicalParser: component(`${dialectId}.parser`, configFingerprint),
        canonicalConsistencyValidator: component(`${dialectId}.consistency`, configFingerprint),
        rebaseMaterializer: null,
        targetApplicabilityPredicate: null,
    };
}

export function makeRestorationDialectDefinition(
    kind: AssetKind,
    dialectId: string,
    configFingerprint: Sha256Digest = DEFAULT_CONFIG,
): RestorationDialectContractDefinitionV1 {
    return {
        kind,
        dialectId,
        payloadCodecValidator: component(`${dialectId}.payload-codec`, configFingerprint),
        transitionValidator: component(`${dialectId}.transition`, configFingerprint),
    };
}

export function makeNativeDialectContract(
    kind: AssetKind,
    dialectId: string,
    validateSameContent: (input: NativeDialectValidationInputV1) => boolean = () => true,
    configFingerprint: Sha256Digest = DEFAULT_CONFIG,
): AdapterNativeDialectContractV1 {
    return {
        definition: makeNativeDialectDefinition(kind, dialectId, configFingerprint),
        validateSameContent,
    };
}

export function makeRestorationDialectContract(
    kind: AssetKind,
    dialectId: string,
    validatePayload: (bytes: Uint8Array) => boolean = () => true,
    configFingerprint: Sha256Digest = DEFAULT_CONFIG,
): AdapterRestorationDialectContractV1 {
    return {
        definition: makeRestorationDialectDefinition(kind, dialectId, configFingerprint),
        validatePayload,
    };
}

export function makePortableEntryDialectContract(
    kind: AssetKind,
    field: PortableEntryDialectFieldV1,
    dialectId: string,
    validateCanonicalEntry: (input: PortableEntryDialectValidationInputV1) => boolean = () => true,
    applicableAgentRuntimeIds: AgentRuntimeId[] = ["FIXTURE_CLI"],
    configFingerprint: Sha256Digest = DEFAULT_CONFIG,
    validateSourceApplicability: (source: PortableDialectSourceRuntimeV1) => boolean = () => true,
): AdapterPortableEntryDialectContractV1 {
    return {
        definition: {
            kind,
            field,
            dialectId,
            applicableAgentRuntimeIds,
            canonicalEntryValidator: component(`${dialectId}.${field}.portable-entry-validator`, configFingerprint),
            sourceApplicabilityValidator: component(`${dialectId}.${field}.source-applicability-validator`, configFingerprint),
        },
        validateCanonicalEntry,
        validateSourceApplicability,
    };
}

export function makePortableSelectorDialectContract(
    kind: AssetKind,
    field: PortableSelectorDialectFieldV1,
    dialectId: string,
    validateSelector: (use: PortableSelectorDialectUseV1) => boolean = () => true,
    applicableAgentRuntimeIds: AgentRuntimeId[] = ["FIXTURE_CLI"],
    configFingerprint: Sha256Digest = DEFAULT_CONFIG,
    validateSourceApplicability: (source: PortableDialectSourceRuntimeV1) => boolean = () => true,
): AdapterPortableSelectorDialectContractV1 {
    return {
        definition: {
            kind,
            field,
            dialectId,
            applicableAgentRuntimeIds,
            selectorSemanticsValidator: component(`${dialectId}.${field}.portable-selector-validator`, configFingerprint),
            sourceApplicabilityValidator: component(`${dialectId}.${field}.source-applicability-validator`, configFingerprint),
        },
        validateSelector,
        validateSourceApplicability,
    };
}

export function nativeDialectFingerprint(
    kind: AssetKind,
    dialectId: string,
    configFingerprint: Sha256Digest = DEFAULT_CONFIG,
): Sha256Digest {
    return computeNativeDialectContractFingerprint(makeNativeDialectDefinition(kind, dialectId, configFingerprint));
}

export function restorationDialectFingerprint(
    kind: AssetKind,
    dialectId: string,
    configFingerprint: Sha256Digest = DEFAULT_CONFIG,
): Sha256Digest {
    return computeRestorationDialectContractFingerprint(makeRestorationDialectDefinition(kind, dialectId, configFingerprint));
}

function component(componentId: string, configFingerprint: Sha256Digest): VersionedContractComponentRef {
    return { componentId, componentVersion: 1, configFingerprint };
}
