/** Generic construction grammar for provider-owned immutable dialect contracts. */

import * as crypto from "node:crypto";
import type {
    AdapterNativeDialectContractV1,
    AdapterPortableEntryDialectContractV1,
    AdapterPortableSelectorDialectContractV1,
    AgentRuntimeId,
    AssetKind,
    NativeDialectValidationInputV1,
    PortableDialectSourceRuntimeV1,
    PortableEntryDialectFieldV1,
    PortableEntryDialectValidationInputV1,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
    VersionedContractComponentRef,
} from "@oaam/core";

export function defineDialectComponentV1(componentId: string): VersionedContractComponentRef {
    return {
        componentId,
        componentVersion: 1,
        configFingerprint: `sha256:${crypto.createHash("sha256").update(`${componentId}\0v1`, "utf8").digest("hex")}`,
    };
}

export function defineNativeDialectContractV1(input: {
    kind: AssetKind;
    dialectId: string;
    rebaseMaterializer?: VersionedContractComponentRef;
    rebase?: AdapterNativeDialectContractV1["rebase"];
    validateSameContent(input: NativeDialectValidationInputV1): boolean;
}): AdapterNativeDialectContractV1 {
    return {
        definition: {
            kind: input.kind,
            dialectId: input.dialectId,
            nativeFileGraphSchema: defineDialectComponentV1(`${input.dialectId}.native-file-graph`),
            contentNormalization: defineDialectComponentV1(`${input.dialectId}.content-normalization`),
            nativeToCanonicalParser: defineDialectComponentV1(`${input.dialectId}.native-to-canonical-parser`),
            canonicalConsistencyValidator: defineDialectComponentV1(`${input.dialectId}.canonical-consistency-validator`),
            rebaseMaterializer: input.rebaseMaterializer === undefined ? null : structuredClone(input.rebaseMaterializer),
            targetApplicabilityPredicate: null,
        },
        validateSameContent: input.validateSameContent,
        ...(input.rebase === undefined ? {} : { rebase: input.rebase }),
    };
}

export function hasCanonicalTextEntryV1(
    files: PortableEntryDialectValidationInputV1["canonicalFiles"],
    logicalPath: string,
): boolean {
    const entry = files.find((file) => file.file.logicalPath === logicalPath);
    return entry?.file.role === "entry" && entry.contentKind === "text";
}

export function definePortableEntryDialectContractV1(input: {
    kind: "Workflow" | "Skill" | "Subagent";
    field: PortableEntryDialectFieldV1;
    dialectId: string;
    applicableAgentRuntimeIds: readonly AgentRuntimeId[];
    validateCanonicalEntry(input: PortableEntryDialectValidationInputV1): boolean;
    validateSourceApplicability(source: PortableDialectSourceRuntimeV1): boolean;
}): AdapterPortableEntryDialectContractV1 {
    return {
        definition: {
            kind: input.kind,
            field: input.field,
            dialectId: input.dialectId,
            applicableAgentRuntimeIds: [...input.applicableAgentRuntimeIds],
            canonicalEntryValidator: defineDialectComponentV1(`${input.dialectId}.${input.field}.portable-entry-validator`),
            sourceApplicabilityValidator: defineDialectComponentV1(
                `${input.dialectId}.${input.field}.source-applicability-validator`,
            ),
        },
        validateCanonicalEntry: input.validateCanonicalEntry,
        validateSourceApplicability: input.validateSourceApplicability,
    };
}

export function definePortableSelectorDialectContractV1(input: {
    kind: "Workflow" | "Skill" | "Subagent";
    field: PortableSelectorDialectFieldV1;
    dialectId: string;
    applicableAgentRuntimeIds: readonly AgentRuntimeId[];
    validateSelector(use: PortableSelectorDialectUseV1): boolean;
    validateSourceApplicability(source: PortableDialectSourceRuntimeV1): boolean;
}): AdapterPortableSelectorDialectContractV1 {
    return {
        definition: {
            kind: input.kind,
            field: input.field,
            dialectId: input.dialectId,
            applicableAgentRuntimeIds: [...input.applicableAgentRuntimeIds],
            selectorSemanticsValidator: defineDialectComponentV1(`${input.dialectId}.${input.field}.portable-selector-validator`),
            sourceApplicabilityValidator: defineDialectComponentV1(
                `${input.dialectId}.${input.field}.source-applicability-validator`,
            ),
        },
        validateSelector: input.validateSelector,
        validateSourceApplicability: input.validateSourceApplicability,
    };
}
