import type { AssetVersionFileContentV2 } from "./asset-version";
import type { VersionNativeRepresentation } from "./persistence";
import type { AgentRuntimeId, AssetKind, PosixRelativePath, VersionStatus } from "./primitives";
import type { AssetKindTypeDataV2 } from "./specs";
import type { ProviderRenderDialectInput, RenderNativeRepresentationFileInput, VersionedContractComponentRef } from "./render";
import type { NativeProjectExactGraphAssetKind } from "./source-import";
import type { VersionRef } from "./common";

/**
 * One immutable, versioned native-format contract owned by an adapter family.
 * The dialectId is semantic identity, not a mutable display label. Any semantic
 * change requires a new -vN id; old contracts remain registered for historical
 * Version validation and missing contracts fail closed.
 */
export interface NativeDialectContractDefinitionV1 {
    kind: AssetKind;
    dialectId: string;
    nativeFileGraphSchema: VersionedContractComponentRef;
    contentNormalization: VersionedContractComponentRef;
    nativeToCanonicalParser: VersionedContractComponentRef;
    canonicalConsistencyValidator: VersionedContractComponentRef;
    rebaseMaterializer: VersionedContractComponentRef | null;
    targetApplicabilityPredicate: VersionedContractComponentRef | null;
}

export interface NativeDialectPayloadFileV1 {
    relativePath: PosixRelativePath;
    bytes: Uint8Array;
}

export interface NativeDialectValidationInputV1 {
    canonical: AssetKindTypeDataV2;
    canonicalFiles: AssetVersionFileContentV2[];
    representation: VersionNativeRepresentation;
    nativeFiles: NativeDialectPayloadFileV1[];
}

export interface NativeDialectGraphRebaseInputV1 {
    assetKind: NativeProjectExactGraphAssetKind;
    nativeDialectId: string;
    targetCanonical: Extract<AssetKindTypeDataV2, { kind: NativeProjectExactGraphAssetKind }>;
    targetFiles: AssetVersionFileContentV2[];
    parent: {
        sourceVersion: VersionRef;
        representation: Extract<ProviderRenderDialectInput, { inputKind: "native_representation" }>["representation"];
        files: RenderNativeRepresentationFileInput[];
    };
    restorationInputs: Extract<ProviderRenderDialectInput, { inputKind: "dialect_restoration" }>[];
}

export interface NativeDialectGraphRebaseMaterializerV1 {
    ref: VersionedContractComponentRef;
    materialize(input: NativeDialectGraphRebaseInputV1): { nativeFiles: RenderNativeRepresentationFileInput[] } | null;
}

export interface AdapterNativeDialectContractV1 {
    definition: NativeDialectContractDefinitionV1;
    validateSameContent(input: NativeDialectValidationInputV1): boolean;
    /** Pure implementation of the already declared native rebase component; no runtime access. */
    rebase?: NativeDialectGraphRebaseMaterializerV1;
}

export interface RestorationDialectContractDefinitionV1 {
    kind: AssetKind;
    dialectId: string;
    payloadCodecValidator: VersionedContractComponentRef;
    transitionValidator: VersionedContractComponentRef;
}

export interface AdapterRestorationDialectContractV1 {
    definition: RestorationDialectContractDefinitionV1;
    validatePayload(bytes: Uint8Array): boolean;
}

export type PortableEntryDialectFieldV1 =
    | "workflow_instruction"
    | "workflow_executable"
    | "skill_entry"
    | "subagent_initial_prompt";

export type PortableSelectorDialectFieldV1 =
    | "workflow_tool"
    | "workflow_model"
    | "workflow_effort"
    | "workflow_shell"
    | "skill_tool"
    | "skill_agent"
    | "skill_model"
    | "skill_effort"
    | "subagent_context"
    | "subagent_tool"
    | "subagent_permission"
    | "subagent_model"
    | "subagent_effort"
    | "subagent_turn_limit"
    | "subagent_color";

export type PortableDialectFieldV1 = PortableEntryDialectFieldV1 | PortableSelectorDialectFieldV1;

export interface PortableEntryDialectUseV1 {
    kind: AssetKind;
    field: PortableEntryDialectFieldV1;
    dialectId: string;
    logicalPath: PosixRelativePath | "";
}

export type PortableSelectorValueV1 =
    | { valueKind: "selector"; selector: string }
    | { valueKind: "selector_set"; selectors: string[] }
    | { valueKind: "relative_tier"; selector: string; relativeTier: -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 }
    | {
          valueKind: "permission_effect";
          selector: string;
          effect:
              | "interactive"
              | "read_only"
              | "auto_approve_selected_operations"
              | "auto_deny_unapproved"
              | "bypass_permission_checks"
              | "classifier_mediated";
      }
    | { valueKind: "positive_limit"; limit: number };

export interface PortableSelectorDialectUseV1 {
    kind: AssetKind;
    field: PortableSelectorDialectFieldV1;
    dialectId: string;
    value: PortableSelectorValueV1;
}

interface PortableDialectContractDefinitionBaseV1 {
    kind: AssetKind;
    dialectId: string;
    applicableAgentRuntimeIds: AgentRuntimeId[];
}

export interface PortableEntryDialectContractDefinitionV1 extends PortableDialectContractDefinitionBaseV1 {
    field: PortableEntryDialectFieldV1;
    canonicalEntryValidator: VersionedContractComponentRef;
    sourceApplicabilityValidator: VersionedContractComponentRef;
}

export interface PortableSelectorDialectContractDefinitionV1 extends PortableDialectContractDefinitionBaseV1 {
    field: PortableSelectorDialectFieldV1;
    selectorSemanticsValidator: VersionedContractComponentRef;
    sourceApplicabilityValidator: VersionedContractComponentRef;
}

export interface PortableDialectSourceRuntimeV1 {
    agentRuntimeId: AgentRuntimeId;
    versionText: string;
}

export interface PortableEntryDialectValidationInputV1 {
    use: PortableEntryDialectUseV1;
    versionStatus: VersionStatus;
    canonical: AssetKindTypeDataV2;
    canonicalFiles: AssetVersionFileContentV2[];
}

export interface AdapterPortableEntryDialectContractV1 {
    definition: PortableEntryDialectContractDefinitionV1;
    validateCanonicalEntry(input: PortableEntryDialectValidationInputV1): boolean;
    validateSourceApplicability(source: PortableDialectSourceRuntimeV1): boolean;
}

export interface AdapterPortableSelectorDialectContractV1 {
    definition: PortableSelectorDialectContractDefinitionV1;
    validateSelector(use: PortableSelectorDialectUseV1): boolean;
    validateSourceApplicability(source: PortableDialectSourceRuntimeV1): boolean;
}

export interface AdapterDialectContractSetV1 {
    native: AdapterNativeDialectContractV1[];
    restoration: AdapterRestorationDialectContractV1[];
    portableEntries: AdapterPortableEntryDialectContractV1[];
    portableSelectors: AdapterPortableSelectorDialectContractV1[];
}
