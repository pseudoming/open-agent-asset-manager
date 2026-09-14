/** Reviewed portable Skill entry creation; native Codex configuration stays on the native graph path. */
import { defineDialectComponentV1, sha256SourceBytes, stableSourceValueEqual } from "@oaam/adapter-framework";
import type {
    CanonicalRenderEntryValidationInput,
    CanonicalMaterializationAssessmentInput,
    NativeProjectExactGraphCanonicalMaterializationInput,
    NativeProjectExactGraphCanonicalMaterializer,
    PosixRelativePath,
    RenderNativeRepresentationFileInput,
    SkillTypeDataV2,
} from "@oaam/core/adapter-spi";
import { parseCodexFrontmatter } from "./codex-frontmatter";
import { isCanonicalNativeRelativePath } from "./codex-source-read-foundation";
import { CODEX_NATIVE_DIALECTS } from "./codex-source-read-model";
import { CODEX_SKILL_SOURCE_DIALECTS, assessCodexSkillSourceMetadata } from "./codex-skill-conversion-assessment";

type Scope = "project" | "global";
type CodexEntry = "CODEX_CLI" | "CODEX_APP";
const ENTRY = "SKILL.md";
const REASON = "codex_skill_reviewed_canonical_conversion";

export function codexCanonicalSkillDeclaration(scope: Scope, requiresNativeSourceAssessment = true) {
    return {
        materializer: defineDialectComponentV1(`codex.${scope}-skill-canonical-graph-v${requiresNativeSourceAssessment ? 2 : 1}`),
        degradationKinds: ["runtime_specific_metadata_lost"] as ["runtime_specific_metadata_lost"],
        reasonCode: REASON,
        preservationDialectIds: CODEX_SKILL_SOURCE_DIALECTS.filter(
            (id) => requiresNativeSourceAssessment || id !== "antigravity-skill-flat-v1",
        ),
        ...(requiresNativeSourceAssessment ? { requiresNativeSourceAssessment: true as const } : {}),
        assessesLoss: true as const,
    };
}

export function createCodexCanonicalSkillMaterializer(
    scope: Scope,
    agentRuntimeId: CodexEntry,
    requiresNativeSourceAssessment = true,
): NativeProjectExactGraphCanonicalMaterializer {
    const declaration = codexCanonicalSkillDeclaration(scope, requiresNativeSourceAssessment);
    return {
        ref: declaration.materializer,
        degradationKinds: declaration.degradationKinds,
        reasonCode: REASON,
        preservationDialectIds: declaration.preservationDialectIds,
        ...(requiresNativeSourceAssessment ? { requiresNativeSourceAssessment: true as const } : {}),
        assessLoss: (input) => assessLoss(input, scope, requiresNativeSourceAssessment),
        diagnosticMessage:
            "Codex receives the complete portable Skill graph; source-only entry metadata remains in the saved source Version",
        materialize: (input) => materialize(input, scope, agentRuntimeId, requiresNativeSourceAssessment),
        validateEntry: (input) => validateEntry(input, scope, agentRuntimeId, requiresNativeSourceAssessment),
    };
}

function materialize(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
    scope: Scope,
    agentRuntimeId: CodexEntry,
    requiresNativeSourceAssessment: boolean,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.skill ||
        input.targetCanonical.kind !== "Skill" ||
        input.targetScope !== scope ||
        input.restorationInputs.length !== 0 ||
        !isPortable(input.targetCanonical.typeData)
    )
        return null;
    const entries = input.targetFiles.filter((file) => file.file.role === "entry");
    if (
        entries.length !== 1 ||
        entries[0]?.file.logicalPath !== ENTRY ||
        entries[0].contentKind !== "text" ||
        entries[0].text.trim() === ""
    )
        return null;
    if (
        assessLoss(
            {
                canonical: input.targetCanonical,
                canonicalEntry: { contentKind: "text", text: entries[0].text },
                targetVersion: input.targetVersion,
                targetScope: input.targetScope,
                nativeDialectId: input.nativeDialectId,
                nativePreservationSeed: input.nativePreservationSeed,
            },
            scope,
            requiresNativeSourceAssessment,
        ) === null
    )
        return null;
    const paths = input.targetFiles.map((file) => file.file.logicalPath);
    // Codex interprets this path as invocation/tool configuration, including on case-insensitive Windows.
    if (
        new Set(paths).size !== paths.length ||
        paths.some(
            (path) =>
                !isCanonicalNativeRelativePath(path) ||
                path.toLowerCase() === "agents/openai.yaml" ||
                path.toLowerCase().startsWith("agents/openai.yaml/"),
        )
    )
        return null;
    const root = boundary(scope, agentRuntimeId, input.targetVersion.assetId);
    const header = serialize(input.targetCanonical.typeData);
    const nativeFiles = input.targetFiles
        .map((file): RenderNativeRepresentationFileInput => {
            const relativePath = `${root}/${file.file.logicalPath}` as PosixRelativePath;
            const common = { relativePath, mediaType: file.file.mediaType, executable: file.file.executable };
            if (file.contentKind === "text") {
                const text = file.file.role === "entry" ? header + file.text : file.text;
                const bytes = new TextEncoder().encode(text);
                return {
                    ...common,
                    contentKind: "text",
                    text,
                    byteSize: bytes.byteLength,
                    contentHash: sha256SourceBytes(bytes),
                };
            }
            const bytes = new Uint8Array(file.bytes);
            return { ...common, contentKind: "binary", bytes, byteSize: bytes.byteLength, contentHash: sha256SourceBytes(bytes) };
        })
        .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
    return { nativeFiles };
}

function isPortable(data: SkillTypeDataV2): boolean {
    return (
        data.schemaVersion === 2 &&
        /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(data.name) &&
        data.description.trim() !== "" &&
        data.description.length <= 1024 &&
        (data.whenToUse === "" || data.whenToUse === data.description) &&
        Object.keys(data.portableMetadata.metadata).every(
            (key) =>
                /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key) &&
                !/^(?:null|true|false|y|n|yes|no|on|off)$/iu.test(key) &&
                !["__proto__", "prototype", "constructor"].includes(key),
        ) &&
        data.invocation.pathCondition.mode === "none" &&
        data.invocation.user.mode === "direct" &&
        data.invocation.user.commandName === data.name &&
        data.invocation.model.mode === "model_decision" &&
        data.invocation.argumentNames.length === 0 &&
        data.invocation.argumentHint === "" &&
        data.toolPolicy.preapproved.length === 0 &&
        data.toolPolicy.denied.length === 0 &&
        data.toolPolicy.otherwise === "inherit_agent_runtime_policy" &&
        data.execution.mode === "caller" &&
        data.execution.model.mode === "inherit" &&
        data.execution.effort.mode === "inherit"
    );
}

function validateEntry(
    input: CanonicalRenderEntryValidationInput,
    scope: Scope,
    agentRuntimeId: CodexEntry,
    requiresNativeSourceAssessment: boolean,
): boolean {
    if (
        input.canonical.kind !== "Skill" ||
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.skill ||
        input.targetScope !== scope ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        assessLoss(input, scope, requiresNativeSourceAssessment) === null ||
        input.nativeEntry.relativePath !== `${boundary(scope, agentRuntimeId, input.targetVersion.assetId)}/${ENTRY}`
    )
        return false;
    const parsed = parseCodexFrontmatter(input.nativeEntry.content.text);
    const data = input.canonical.typeData;
    const expected: Record<string, unknown> = { name: data.name, description: data.description };
    if (data.portableMetadata.license !== "") expected.license = data.portableMetadata.license;
    if (data.portableMetadata.compatibility !== "") expected.compatibility = data.portableMetadata.compatibility;
    if (Object.keys(data.portableMetadata.metadata).length > 0) expected.metadata = data.portableMetadata.metadata;
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body.trim() !== "" &&
        parsed.body === input.canonicalEntry.text &&
        stableSourceValueEqual(parsed.values, expected)
    );
}

function serialize(data: SkillTypeDataV2): string {
    const lines = ["---", `name: ${JSON.stringify(data.name)}`, `description: ${JSON.stringify(data.description)}`];
    if (data.portableMetadata.license !== "") lines.push(`license: ${JSON.stringify(data.portableMetadata.license)}`);
    if (data.portableMetadata.compatibility !== "")
        lines.push(`compatibility: ${JSON.stringify(data.portableMetadata.compatibility)}`);
    const metadata = Object.entries(data.portableMetadata.metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (metadata.length > 0) lines.push("metadata:", ...metadata.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`));
    return lines.join("\n") + "\n---\n";
}

function boundary(scope: Scope, agentRuntimeId: CodexEntry, assetId: string): string {
    const leaf = `oaam-skill-${assetId.slice(0, 8)}`;
    return scope === "global" ? leaf : `${agentRuntimeId === "CODEX_APP" ? ".codex" : ".agents"}/skills/${leaf}`;
}

function assessLoss(input: CanonicalMaterializationAssessmentInput, scope: Scope, requiresNativeSourceAssessment: boolean) {
    if (
        input.canonical.kind !== "Skill" ||
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.skill ||
        input.targetScope !== scope ||
        !isPortable(input.canonical.typeData)
    )
        return null;
    return assessCodexSkillSourceMetadata(input, requiresNativeSourceAssessment);
}
