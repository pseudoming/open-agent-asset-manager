/** Native document mechanics shared by synthetic exact-file contract fixtures. */

import type {
    AdapterNativeDialectContractV1,
    AssetKindTypeDataV2,
    NativeProjectExactFileAssetKind,
    PosixRelativePath,
    Sha256Digest,
} from "../../../src/types";
import type { RenderAnalysisInput } from "../../../src/contracts/render";
import {
    computeNativeDialectContractFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../../src/foundation/fingerprint";
import { textPayloadStats } from "../../../src/catalog/payload-store";
import type {
    NativeProjectExactFileRebaseInput,
    NativeProjectExactFileRebaseMaterializer,
} from "../../../src/render/native-project-exact-file";
import { ASSET_ID, VERSION_ID } from "../../catalog/fixtures/version-v2";

export const EXACT_HASH = `sha256:${"7".repeat(64)}` as Sha256Digest;
export const EXACT_DIALECT_ID = "fixture-skill-frontmatter-v1";
export const EXACT_PROFILE_ID = "fixture-cli-project-skill-v1";
export const EXACT_OUTPUT_CONTRACT_ID = "FIXTURE_NATIVE_PROJECT_SKILL_V1";
export const EXACT_TARGET_PATH = ".fixture/skills/review/SKILL.md" as PosixRelativePath;
export const EXACT_ENTRY_TEXT = "# Review\nReview the current change.\n";
const EXACT_NATIVE_HEADER =
    "---\n# fixture-native-layout: keep\nname: review\ndescription: Review changes\nx-fixture-only: keep-me\n---\n";
export const EXACT_NATIVE_TEXT = `${EXACT_NATIVE_HEADER}${EXACT_ENTRY_TEXT}`;
export const EXACT_CHANGED_ENTRY_TEXT = "# Review\nReview the change and its tests.\n";
export const EXACT_CHANGED_NATIVE_TEXT = `${EXACT_NATIVE_HEADER}${EXACT_CHANGED_ENTRY_TEXT}`;
export const EXACT_REBASED_ENTRY_TEXT = "# Review\nReview the foreign-runtime edit.\n";
export const EXACT_REBASED_NATIVE_TEXT =
    "---\n# fixture-native-layout: keep\nname: review\ndescription: Review foreign changes\n" +
    `x-fixture-only: keep-me\n---\n${EXACT_REBASED_ENTRY_TEXT}`;

export const RULE_EXACT_DIALECT_ID = "fixture-rule-frontmatter-v1";
export const RULE_EXACT_PROFILE_ID = "fixture-cli-project-rule-exact-file-v1";
export const RULE_EXACT_OUTPUT_CONTRACT_ID = "FIXTURE_NATIVE_PROJECT_RULE_EXACT_FILE_V1";
export const RULE_EXACT_TARGET_PATH = ".fixture/rules/review.md" as PosixRelativePath;
export const RULE_EXACT_ENTRY_TEXT = "# Review\nReview every change before accepting it.\n";
const RULE_EXACT_NATIVE_HEADER = "---\n# fixture-native-layout: keep\ntrigger: always_on\nx-fixture-only: keep-me\n---\n";
export const RULE_EXACT_NATIVE_TEXT = `${RULE_EXACT_NATIVE_HEADER}${RULE_EXACT_ENTRY_TEXT}`;
export const RULE_EXACT_CHANGED_ENTRY_TEXT = "# Review\nReview the change and its tests before accepting it.\n";
export const RULE_EXACT_CHANGED_NATIVE_TEXT = `${RULE_EXACT_NATIVE_HEADER}${RULE_EXACT_CHANGED_ENTRY_TEXT}`;
export const RULE_EXACT_REBASED_ENTRY_TEXT = "# Review\nReview the foreign-runtime edit before accepting it.\n";
export const RULE_EXACT_REBASED_NATIVE_TEXT = `${RULE_EXACT_NATIVE_HEADER}${RULE_EXACT_REBASED_ENTRY_TEXT}`;

export const MEMORY_EXACT_DIALECT_ID = "fixture-memory-topic-v1";
export const MEMORY_EXACT_PROFILE_ID = "fixture-cli-project-memory-unit-v1";
export const MEMORY_EXACT_OUTPUT_CONTRACT_ID = "FIXTURE_NATIVE_PROJECT_MEMORY_UNIT_V1";
export const MEMORY_EXACT_TARGET_PATH = "topics/review-memory.md" as PosixRelativePath;
export const MEMORY_EXACT_ENTRY_TEXT = "# Review memory\nRemember the current review conventions.\n";
const MEMORY_EXACT_NATIVE_HEADER =
    "---\n# fixture-native-layout: keep\nname: review-memory\ndescription: Review conventions\n" +
    "applicability: Before reviewing a change\ntype: user\nx-fixture-only: keep-me\n---\n";
export const MEMORY_EXACT_NATIVE_TEXT = `${MEMORY_EXACT_NATIVE_HEADER}${MEMORY_EXACT_ENTRY_TEXT}`;
export const MEMORY_EXACT_CHANGED_ENTRY_TEXT = "# Review memory\nRemember the current review and test conventions.\n";
export const MEMORY_EXACT_CHANGED_NATIVE_TEXT = `${MEMORY_EXACT_NATIVE_HEADER}${MEMORY_EXACT_CHANGED_ENTRY_TEXT}`;
export const MEMORY_EXACT_REBASED_ENTRY_TEXT = "# Review memory\nRemember the foreign-runtime review conventions.\n";
export const MEMORY_EXACT_REBASED_NATIVE_TEXT =
    "---\n# fixture-native-layout: keep\nname: review-memory\ndescription: Foreign review conventions\n" +
    `applicability: Before reviewing a change\ntype: user\nx-fixture-only: keep-me\n---\n${MEMORY_EXACT_REBASED_ENTRY_TEXT}`;

export const EXACT_PATH_REF = {
    componentId: "fixture.skill.project-path",
    componentVersion: 1,
    configFingerprint: `sha256:${"1".repeat(64)}` as Sha256Digest,
};
export const EXACT_PARSER_REF = {
    componentId: "fixture.skill.frontmatter-parser",
    componentVersion: 1,
    configFingerprint: `sha256:${"2".repeat(64)}` as Sha256Digest,
};
export const EXACT_REBASE_REF = {
    componentId: "fixture.skill.frontmatter-rebase",
    componentVersion: 1,
    configFingerprint: `sha256:${"4".repeat(64)}` as Sha256Digest,
};

export interface ExactFixtureDefinition {
    assetKind: Extract<NativeProjectExactFileAssetKind, "Rule" | "Skill" | "Memory">;
    nativeDialectId: string;
    profileId: string;
    outputContractId: string;
    targetPath: PosixRelativePath;
    logicalPath: PosixRelativePath;
    fixtureId: string;
    parentRebaseFixtureId: string;
    exactLoadMarker: string;
    reverseFixtureId: string;
    entryText: string;
    nativeText: string;
    changedEntryText: string;
    changedNativeText: string;
    rebasedEntryText: string;
    rebasedNativeText: string;
    canonical(): Extract<AssetKindTypeDataV2, { kind: "Rule" | "Skill" | "Memory" }>;
    validatePath(relativePath: PosixRelativePath): boolean;
    parseChangedNativeText(input: {
        assetKind: NativeProjectExactFileAssetKind;
        nativeDialectId: string;
        relativePath: PosixRelativePath;
        appliedNativeText: string;
        currentNativeText: string;
    }): { canonicalEntryText: string } | null;
    rebaseNativeText: NativeProjectExactFileRebaseMaterializer["materialize"];
}

export function skillCanonical(): Extract<AssetKindTypeDataV2, { kind: "Skill" }> {
    return {
        kind: "Skill",
        typeData: {
            schemaVersion: 2,
            name: "review",
            description: "Review changes",
            whenToUse: "Before accepting a change",
            entryDialectId: "fixture-skill-entry-v1",
            portableMetadata: { license: "", compatibility: "", metadata: {} },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "not_directly_invocable" },
                model: { mode: "model_decision" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
        },
    };
}

export function ruleExactCanonical(): Extract<AssetKindTypeDataV2, { kind: "Rule" }> {
    return {
        kind: "Rule",
        typeData: {
            schemaVersion: 2,
            name: "review",
            description: "",
            activation: { mode: "always" },
        },
    };
}

export function memoryExactCanonical(): Extract<AssetKindTypeDataV2, { kind: "Memory" }> {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "unit",
            card: { name: "review-memory", description: "Review conventions" },
            loading: { card: "high", body: "low" },
            applicabilityRule: "Before reviewing a change",
        },
    };
}

export function exactFixtureDefinition(assetKind: ExactFixtureDefinition["assetKind"]): ExactFixtureDefinition {
    switch (assetKind) {
        case "Rule":
            return {
                assetKind,
                nativeDialectId: RULE_EXACT_DIALECT_ID,
                profileId: RULE_EXACT_PROFILE_ID,
                outputContractId: RULE_EXACT_OUTPUT_CONTRACT_ID,
                targetPath: RULE_EXACT_TARGET_PATH,
                logicalPath: "rule.md",
                fixtureId: "fixture-cli-1.2.3-project-rule-exact-file-2026-08-02",
                parentRebaseFixtureId: "fixture-cli-1.2.3-project-rule-exact-file-parent-rebase-v1",
                exactLoadMarker: "OAAM_RULE_EXACT_FILE_FIXTURE_MARKER",
                reverseFixtureId: "native-project-rule-exact-file-body-reverse-v1",
                entryText: RULE_EXACT_ENTRY_TEXT,
                nativeText: RULE_EXACT_NATIVE_TEXT,
                changedEntryText: RULE_EXACT_CHANGED_ENTRY_TEXT,
                changedNativeText: RULE_EXACT_CHANGED_NATIVE_TEXT,
                rebasedEntryText: RULE_EXACT_REBASED_ENTRY_TEXT,
                rebasedNativeText: RULE_EXACT_REBASED_NATIVE_TEXT,
                canonical: ruleExactCanonical,
                validatePath: isFixtureRulePath,
                parseChangedNativeText: parseRuleNativeText,
                rebaseNativeText: rebaseRuleNativeText,
            };
        case "Memory":
            return {
                assetKind,
                nativeDialectId: MEMORY_EXACT_DIALECT_ID,
                profileId: MEMORY_EXACT_PROFILE_ID,
                outputContractId: MEMORY_EXACT_OUTPUT_CONTRACT_ID,
                targetPath: MEMORY_EXACT_TARGET_PATH,
                logicalPath: "memory.md",
                fixtureId: "fixture-cli-1.2.3-project-memory-unit-2026-08-03",
                parentRebaseFixtureId: "fixture-cli-1.2.3-project-memory-unit-parent-rebase-v1",
                exactLoadMarker: "OAAM_MEMORY_UNIT_FIXTURE_MARKER",
                reverseFixtureId: "native-project-memory-unit-body-reverse-v1",
                entryText: MEMORY_EXACT_ENTRY_TEXT,
                nativeText: MEMORY_EXACT_NATIVE_TEXT,
                changedEntryText: MEMORY_EXACT_CHANGED_ENTRY_TEXT,
                changedNativeText: MEMORY_EXACT_CHANGED_NATIVE_TEXT,
                rebasedEntryText: MEMORY_EXACT_REBASED_ENTRY_TEXT,
                rebasedNativeText: MEMORY_EXACT_REBASED_NATIVE_TEXT,
                canonical: memoryExactCanonical,
                validatePath: isFixtureMemoryPath,
                parseChangedNativeText: parseMemoryNativeText,
                rebaseNativeText: rebaseMemoryNativeText,
            };
        case "Skill":
            return {
                assetKind,
                nativeDialectId: EXACT_DIALECT_ID,
                profileId: EXACT_PROFILE_ID,
                outputContractId: EXACT_OUTPUT_CONTRACT_ID,
                targetPath: EXACT_TARGET_PATH,
                logicalPath: "SKILL.md",
                fixtureId: "fixture-cli-1.2.3-project-skill-2026-08-01",
                parentRebaseFixtureId: "fixture-cli-1.2.3-project-skill-parent-rebase-v1",
                exactLoadMarker: "OAAM_SKILL_FIXTURE_MARKER",
                reverseFixtureId: "native-project-skill-whole-file-reverse-v1",
                entryText: EXACT_ENTRY_TEXT,
                nativeText: EXACT_NATIVE_TEXT,
                changedEntryText: EXACT_CHANGED_ENTRY_TEXT,
                changedNativeText: EXACT_CHANGED_NATIVE_TEXT,
                rebasedEntryText: EXACT_REBASED_ENTRY_TEXT,
                rebasedNativeText: EXACT_REBASED_NATIVE_TEXT,
                canonical: skillCanonical,
                validatePath: isFixtureSkillPath,
                parseChangedNativeText: parseSkillNativeText,
                rebaseNativeText: rebaseSkillNativeText,
            };
    }
}

export function makeExactNativeDialectContract(
    definition: ExactFixtureDefinition,
    rebaseMaterializer: AdapterNativeDialectContractV1["definition"]["rebaseMaterializer"],
): AdapterNativeDialectContractV1 {
    const contractDefinition = {
        kind: definition.assetKind,
        dialectId: definition.nativeDialectId,
        nativeFileGraphSchema: {
            componentId: `fixture.${definition.assetKind.toLowerCase()}.file-graph`,
            componentVersion: 1,
            configFingerprint: EXACT_HASH,
        },
        contentNormalization: {
            componentId: `fixture.${definition.assetKind.toLowerCase()}.normalization`,
            componentVersion: 1,
            configFingerprint: EXACT_HASH,
        },
        nativeToCanonicalParser: EXACT_PARSER_REF,
        canonicalConsistencyValidator: {
            componentId: `fixture.${definition.assetKind.toLowerCase()}.consistency`,
            componentVersion: 1,
            configFingerprint: EXACT_HASH,
        },
        rebaseMaterializer,
        targetApplicabilityPredicate: null,
    };
    return {
        definition: contractDefinition,
        validateSameContent(input) {
            if (
                input.nativeFiles.length !== 1 ||
                input.canonicalFiles.length !== 1 ||
                input.canonicalFiles[0]?.contentKind !== "text" ||
                input.representation.dialectId !== definition.nativeDialectId
            ) {
                return false;
            }
            const nativeText = Buffer.from(input.nativeFiles[0].bytes).toString("utf8");
            if (definition.assetKind === "Rule") {
                const parsed = parseRuleNativeDocument(nativeText);
                return (
                    input.canonical.kind === "Rule" &&
                    input.canonical.typeData.name === "review" &&
                    input.canonical.typeData.description === "" &&
                    input.canonical.typeData.activation.mode === "always" &&
                    parsed?.canonicalEntryText === input.canonicalFiles[0].text
                );
            }
            if (definition.assetKind === "Memory") {
                const parsed = parseMemoryNativeDocument(nativeText);
                return (
                    input.canonical.kind === "Memory" &&
                    input.canonical.typeData.entityRole === "unit" &&
                    parsed?.name === input.canonical.typeData.card.name &&
                    parsed.description === input.canonical.typeData.card.description &&
                    parsed.applicability === input.canonical.typeData.applicabilityRule &&
                    parsed.canonicalEntryText === input.canonicalFiles[0].text
                );
            }
            const parsed = parseSkillNativeDocument(nativeText);
            return (
                input.canonical.kind === "Skill" &&
                parsed?.name === input.canonical.typeData.name &&
                parsed.description === input.canonical.typeData.description &&
                parsed.canonicalEntryText === input.canonicalFiles[0].text
            );
        },
    };
}

export function makeExactDialectInput(
    canonicalContentFingerprint: Sha256Digest,
    contract: AdapterNativeDialectContractV1,
    definition: ExactFixtureDefinition,
    options: {
        targetVersion?: { assetId: string; versionId: string };
        relativePath?: PosixRelativePath;
        nativeText?: string;
    } = {},
): RenderAnalysisInput["dialectInputs"][number] {
    const targetVersion = options.targetVersion ?? { assetId: ASSET_ID, versionId: VERSION_ID };
    const relativePath = options.relativePath ?? definition.targetPath;
    const nativeText = options.nativeText ?? definition.nativeText;
    const stats = textPayloadStats(nativeText);
    const descriptor = {
        relativePath,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: stats.contentHash,
        byteSize: stats.byteSize,
        executable: false,
    };
    const preimage = {
        schemaVersion: 1 as const,
        dialectId: definition.nativeDialectId,
        dialectContractFingerprint: computeNativeDialectContractFingerprint(contract.definition),
        canonicalContentFingerprint,
        files: [descriptor],
    };
    const representation = {
        ...preimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
    };
    const { files: _files, ...metadata } = representation;
    return {
        targetVersion,
        consumerAgentRuntimeIds: ["FIXTURE_CLI"],
        inputs: [
            {
                inputKind: "native_representation",
                inputRole: "current_exact",
                representation: metadata,
                files: [{ ...descriptor, text: nativeText }],
            },
        ],
    };
}

function parseSkillNativeText(input: {
    assetKind: NativeProjectExactFileAssetKind;
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedNativeText: string;
    currentNativeText: string;
}): { canonicalEntryText: string } | null {
    if (input.assetKind !== "Skill" || input.nativeDialectId !== EXACT_DIALECT_ID || !isFixtureSkillPath(input.relativePath)) {
        return null;
    }
    const applied = parseSkillNativeDocument(input.appliedNativeText);
    const current = parseSkillNativeDocument(input.currentNativeText);
    return applied === null || current === null || applied.header !== current.header
        ? null
        : { canonicalEntryText: current.canonicalEntryText };
}

function rebaseSkillNativeText(input: NativeProjectExactFileRebaseInput) {
    const entry = input.targetFiles.find((file) => file.file.role === "entry");
    const parent = parseSkillNativeDocument(input.parent.file.text);
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== EXACT_DIALECT_ID ||
        input.targetCanonical.kind !== "Skill" ||
        entry?.contentKind !== "text" ||
        !isFixtureSkillPath(input.parent.file.relativePath) ||
        parent === null
    ) {
        return null;
    }
    return {
        nativeText:
            parent.header
                .replace(/^name: .*$/m, `name: ${input.targetCanonical.typeData.name}`)
                .replace(/^description: .*$/m, `description: ${input.targetCanonical.typeData.description}`) + entry.text,
    };
}

function isFixtureSkillPath(relativePath: PosixRelativePath): boolean {
    return /^\.fixture\/skills\/[a-z0-9-]+\/SKILL\.md$/u.test(relativePath);
}

function parseSkillNativeDocument(nativeText: string): {
    header: string;
    name: string;
    description: string;
    canonicalEntryText: string;
} | null {
    const match =
        /^(---\n# fixture-native-layout: keep\nname: ([^\n]+)\ndescription: ([^\n]+)\nx-fixture-only: keep-me\n---\n)([\s\S]+)$/.exec(
            nativeText,
        );
    return match === null
        ? null
        : {
              header: match[1] as string,
              name: match[2] as string,
              description: match[3] as string,
              canonicalEntryText: match[4] as string,
          };
}

function parseRuleNativeText(input: {
    assetKind: NativeProjectExactFileAssetKind;
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedNativeText: string;
    currentNativeText: string;
}): { canonicalEntryText: string } | null {
    if (input.assetKind !== "Rule" || input.nativeDialectId !== RULE_EXACT_DIALECT_ID || !isFixtureRulePath(input.relativePath)) {
        return null;
    }
    const applied = parseRuleNativeDocument(input.appliedNativeText);
    const current = parseRuleNativeDocument(input.currentNativeText);
    return applied === null || current === null || applied.header !== current.header
        ? null
        : { canonicalEntryText: current.canonicalEntryText };
}

function rebaseRuleNativeText(input: NativeProjectExactFileRebaseInput) {
    const entry = input.targetFiles.find((file) => file.file.role === "entry");
    const parent = parseRuleNativeDocument(input.parent.file.text);
    if (
        input.assetKind !== "Rule" ||
        input.nativeDialectId !== RULE_EXACT_DIALECT_ID ||
        input.targetCanonical.kind !== "Rule" ||
        input.targetCanonical.typeData.activation.mode !== "always" ||
        entry?.contentKind !== "text" ||
        !isFixtureRulePath(input.parent.file.relativePath) ||
        parent === null
    ) {
        return null;
    }
    return { nativeText: parent.header + entry.text };
}

function isFixtureRulePath(relativePath: PosixRelativePath): boolean {
    return /^\.fixture\/rules\/[a-z0-9-]+\.md$/u.test(relativePath);
}

function parseRuleNativeDocument(nativeText: string): { header: string; canonicalEntryText: string } | null {
    const match = /^(---\n# fixture-native-layout: keep\ntrigger: always_on\nx-fixture-only: keep-me\n---\n)([\s\S]+)$/.exec(
        nativeText,
    );
    return match === null ? null : { header: match[1] as string, canonicalEntryText: match[2] as string };
}

function parseMemoryNativeText(input: {
    assetKind: NativeProjectExactFileAssetKind;
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedNativeText: string;
    currentNativeText: string;
}): { canonicalEntryText: string } | null {
    if (
        input.assetKind !== "Memory" ||
        input.nativeDialectId !== MEMORY_EXACT_DIALECT_ID ||
        !isFixtureMemoryPath(input.relativePath)
    ) {
        return null;
    }
    const applied = parseMemoryNativeDocument(input.appliedNativeText);
    const current = parseMemoryNativeDocument(input.currentNativeText);
    return applied === null || current === null || applied.header !== current.header
        ? null
        : { canonicalEntryText: current.canonicalEntryText };
}

function rebaseMemoryNativeText(input: NativeProjectExactFileRebaseInput) {
    const entry = input.targetFiles.find((file) => file.file.role === "entry");
    const parent = parseMemoryNativeDocument(input.parent.file.text);
    if (
        input.assetKind !== "Memory" ||
        input.nativeDialectId !== MEMORY_EXACT_DIALECT_ID ||
        input.targetCanonical.kind !== "Memory" ||
        input.targetCanonical.typeData.entityRole !== "unit" ||
        entry?.contentKind !== "text" ||
        !isFixtureMemoryPath(input.parent.file.relativePath) ||
        parent === null
    ) {
        return null;
    }
    return {
        nativeText:
            parent.header
                .replace(/^name: .*$/m, `name: ${input.targetCanonical.typeData.card.name}`)
                .replace(/^description: .*$/m, `description: ${input.targetCanonical.typeData.card.description}`)
                .replace(/^applicability: .*$/m, `applicability: ${input.targetCanonical.typeData.applicabilityRule}`) +
            entry.text,
    };
}

function isFixtureMemoryPath(relativePath: PosixRelativePath): boolean {
    return /^topics\/[a-z0-9-]+\.md$/u.test(relativePath);
}

function parseMemoryNativeDocument(nativeText: string): {
    header: string;
    name: string;
    description: string;
    applicability: string;
    canonicalEntryText: string;
} | null {
    const match =
        /^(---\n# fixture-native-layout: keep\nname: ([^\n]+)\ndescription: ([^\n]+)\napplicability: ([^\n]+)\ntype: user\nx-fixture-only: keep-me\n---\n)([\s\S]+)$/.exec(
            nativeText,
        );
    return match === null
        ? null
        : {
              header: match[1] as string,
              name: match[2] as string,
              description: match[3] as string,
              applicability: match[4] as string,
              canonicalEntryText: match[5] as string,
          };
}
