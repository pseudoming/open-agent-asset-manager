/** Reviewed foreign and user-created Skills over Claude's existing directory contract. */
import { defineDialectComponentV1 as component, sha256SourceBytes, stableSourceValueEqual } from "@oaam/adapter-framework";
import type {
    CanonicalMaterializationAssessmentInput,
    CanonicalRenderEntryValidationInput,
    NativeProjectExactGraphCanonicalMaterializationInput,
    NativeProjectExactGraphCanonicalMaterializer,
    PosixRelativePath,
    RenderNativeRepresentationFileInput,
    SkillTypeDataV2,
} from "@oaam/core/adapter-spi";
import { containsExecutablePromptSubstitution, parseClaudeFrontmatter } from "./claudecode-frontmatter";
import { CLAUDECODE_NATIVE_DIALECTS } from "./claudecode-source-read-model";

const SOURCE_DIALECTS = [
    "antigravity-skill-flat-v1",
    "antigravity-skill-folder-v1",
    "claudecode-skill-directory-v1",
    "codex-skill-directory-v1",
    "cursor-skill-directory-v1",
    "opencode-skill-directory-v1",
    "opencode-skill-directory-v2",
    "zcode-skill-directory-v1",
];
const ENTRY_DIALECTS = [
    "antigravity-skill-markdown-v1",
    "claudecode-skill-markdown-v1",
    "codex-skill-markdown-v1",
    "cursor-skill-directory-v1",
    "opencode-skill-markdown-v1",
    "opencode-skill-markdown-v2",
    "zcode-skill-markdown-v1",
];
const SOURCE_POLICY_FIELDS: Readonly<Record<string, readonly string[]>> = {
    "claudecode-skill-directory-v1": [
        "when_to_use",
        "allowed-tools",
        "disallowed-tools",
        "argument-hint",
        "arguments",
        "model",
        "effort",
        "disable-model-invocation",
        "user-invocable",
        "context",
        "agent",
        "paths",
    ],
    "cursor-skill-directory-v1": ["disable-model-invocation"],
    "opencode-skill-directory-v1": ["slash"],
    "opencode-skill-directory-v2": ["slash"],
};

export function createClaudeSkillCanonicalMaterializer(
    scope: "project" | "global",
): NativeProjectExactGraphCanonicalMaterializer {
    return {
        ref: component("claudecode." + scope + "-skill-reviewed-canonical-materialization-v1"),
        degradationKinds: ["runtime_specific_metadata_lost"],
        preservationDialectIds: [...SOURCE_DIALECTS],
        requiresNativeSourceAssessment: true,
        reasonCode: "claudecode_skill_reviewed_canonical_conversion",
        diagnosticMessage:
            "The complete Skill and expressible invocation metadata are mapped into Claude's directory format; unrepresented source metadata remains in the saved Version",
        assessLoss: (input) => assessClaudeSkillLoss(input, scope),
        materialize: (input) => materialize(input, scope),
        validateEntry: (input) => validateEntry(input, scope),
    };
}

export function claudeSkillCanonicalDeclaration(materializer: NativeProjectExactGraphCanonicalMaterializer) {
    return {
        materializer: materializer.ref,
        degradationKinds: [...materializer.degradationKinds] as typeof materializer.degradationKinds,
        preservationDialectIds: [...SOURCE_DIALECTS],
        assessesLoss: true as const,
        requiresNativeSourceAssessment: true as const,
        reasonCode: materializer.reasonCode,
    };
}

function expressible(data: SkillTypeDataV2): boolean {
    const command = data.invocation.user.mode === "direct" ? data.invocation.user.commandName : data.name;
    return (
        data.schemaVersion === 2 &&
        data.name.trim() !== "" &&
        data.description.trim() !== "" &&
        /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(command) &&
        ENTRY_DIALECTS.includes(data.entryDialectId) &&
        Object.keys(data.portableMetadata.metadata).every(
            (key) =>
                /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key) &&
                !/^(?:null|true|false|y|n|yes|no|on|off)$/iu.test(key) &&
                !["__proto__", "prototype", "constructor"].includes(key),
        ) &&
        data.invocation.pathCondition.mode === "none" &&
        (data.invocation.user.mode === "direct" || data.invocation.user.mode === "not_directly_invocable") &&
        (data.invocation.model.mode === "model_decision" || data.invocation.model.mode === "disabled") &&
        data.invocation.argumentNames.length === 0 &&
        data.toolPolicy.preapproved.length === 0 &&
        data.toolPolicy.denied.length === 0 &&
        data.toolPolicy.otherwise === "inherit_agent_runtime_policy" &&
        data.execution.mode === "caller" &&
        data.execution.model.mode === "inherit" &&
        data.execution.effort.mode === "inherit"
    );
}

function assessClaudeSkillLoss(
    input: CanonicalMaterializationAssessmentInput,
    scope: "project" | "global",
): ["runtime_specific_metadata_lost"] | [] | null {
    if (
        input.nativeDialectId !== CLAUDECODE_NATIVE_DIALECTS.skill ||
        input.targetScope !== scope ||
        input.canonical.kind !== "Skill" ||
        input.canonicalEntry.contentKind !== "text" ||
        !expressible(input.canonical.typeData)
    )
        return null;
    const body = input.canonicalEntry.text,
        data = input.canonical.typeData;
    if (body.trim() === "" || containsExecutablePromptSubstitution(body)) return null;
    // Claude expands these tokens even in ordinary instruction text. A foreign literal must not acquire behavior.
    if (data.entryDialectId !== "claudecode-skill-markdown-v1" && /\$(?:ARGUMENTS|\d+|\{CLAUDE_[A-Z0-9_]+\})/u.test(body))
        return null;
    const seed = input.nativePreservationSeed;
    if (seed === undefined) return [];
    if (!SOURCE_DIALECTS.includes(seed.representation.dialectId)) return null;
    const entries =
        seed.representation.dialectId === "antigravity-skill-flat-v1"
            ? seed.files.filter((file) => seed.files.length === 1 && file.relativePath.endsWith(".md"))
            : seed.files.filter(
                  (file) =>
                      file.relativePath.endsWith("/SKILL.md") &&
                      seed.files.every((owned) => owned.relativePath.startsWith(file.relativePath.slice(0, -"SKILL.md".length))),
              );
    if (entries.length !== 1 || entries[0]?.contentKind !== "text") return null;
    const parsed = parseClaudeFrontmatter(entries[0].text);
    if ((parsed.hasFrontmatter && !parsed.closed) || parsed.diagnostics.length !== 0 || parsed.body !== body) return null;
    const mapped: Record<string, unknown> = {
        name: data.name,
        description: data.description,
        license: data.portableMetadata.license,
        compatibility: data.portableMetadata.compatibility,
        metadata: data.portableMetadata.metadata,
    };
    let lost = false;
    for (const [key, value] of Object.entries(parsed.values)) {
        if (Object.hasOwn(mapped, key)) {
            if (!stableSourceValueEqual(value, mapped[key])) return null;
        } else if (key === "version" && seed.representation.dialectId === "claudecode-skill-directory-v1") {
            lost = true;
        } else if (!SOURCE_POLICY_FIELDS[seed.representation.dialectId]?.includes(key)) {
            return null;
        }
    }
    return lost ? ["runtime_specific_metadata_lost"] : [];
}

function boundary(data: SkillTypeDataV2, scope: "project" | "global"): string {
    const command = data.invocation.user.mode === "direct" ? data.invocation.user.commandName : data.name;
    return (scope === "project" ? ".claude/skills/" : "skills/") + command;
}

function fields(data: SkillTypeDataV2): Record<string, string | boolean | Record<string, string>> {
    const value: Record<string, string | boolean | Record<string, string>> = { name: data.name, description: data.description };
    if (data.whenToUse !== "") value.when_to_use = data.whenToUse;
    if (data.invocation.user.mode === "not_directly_invocable") value["user-invocable"] = false;
    if (data.invocation.model.mode === "disabled") value["disable-model-invocation"] = true;
    if (data.invocation.argumentHint !== "") value["argument-hint"] = data.invocation.argumentHint;
    if (data.portableMetadata.license !== "") value.license = data.portableMetadata.license;
    if (data.portableMetadata.compatibility !== "") value.compatibility = data.portableMetadata.compatibility;
    if (Object.keys(data.portableMetadata.metadata).length) value.metadata = data.portableMetadata.metadata;
    return value;
}

function header(data: SkillTypeDataV2): string {
    const lines = ["---"];
    for (const [key, value] of Object.entries(fields(data))) {
        if (typeof value === "object") {
            lines.push(key + ":");
            for (const name of Object.keys(value).sort()) lines.push("  " + name + ": " + JSON.stringify(value[name]));
        } else lines.push(key + ": " + JSON.stringify(value));
    }
    return lines.join("\n") + "\n---\n";
}

function validPath(value: string): boolean {
    return (
        value !== "" &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    );
}

function materialize(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
    scope: "project" | "global",
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (input.assetKind !== "Skill" || input.targetCanonical.kind !== "Skill" || input.restorationInputs.length !== 0)
        return null;
    const entries = input.targetFiles.filter((file) => file.file.role === "entry");
    const entry = entries[0];
    if (entries.length !== 1 || entry?.file.logicalPath !== "SKILL.md" || entry.contentKind !== "text") return null;
    if (
        assessClaudeSkillLoss(
            {
                canonical: input.targetCanonical,
                canonicalEntry: { contentKind: "text", text: entry.text },
                targetVersion: input.targetVersion,
                targetScope: input.targetScope,
                nativeDialectId: input.nativeDialectId,
                nativePreservationSeed: input.nativePreservationSeed,
            },
            scope,
        ) === null
    )
        return null;
    const paths = input.targetFiles.map((file) => file.file.logicalPath);
    if (new Set(paths).size !== paths.length || paths.some((value) => !validPath(value))) return null;
    const data = input.targetCanonical.typeData;
    const root = boundary(data, scope);
    const nativeFiles: RenderNativeRepresentationFileInput[] = input.targetFiles.map((file) => {
        const relativePath = (root + "/" + file.file.logicalPath) as PosixRelativePath;
        const base = { relativePath, mediaType: file.file.mediaType, executable: file.file.executable };
        if (file.contentKind === "text") {
            const text = (file.file.role === "entry" ? header(data) : "") + file.text;
            const bytes = new TextEncoder().encode(text);
            return { ...base, contentKind: "text", text, byteSize: bytes.length, contentHash: sha256SourceBytes(bytes) };
        }
        const bytes = new Uint8Array(file.bytes);
        return { ...base, contentKind: "binary", bytes, byteSize: bytes.length, contentHash: sha256SourceBytes(bytes) };
    });
    nativeFiles.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    return { nativeFiles };
}

function validateEntry(input: CanonicalRenderEntryValidationInput, scope: "project" | "global"): boolean {
    if (
        assessClaudeSkillLoss(input, scope) === null ||
        input.canonical.kind !== "Skill" ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text"
    )
        return false;
    if (input.nativeEntry.relativePath !== boundary(input.canonical.typeData, scope) + "/SKILL.md") return false;
    const parsed = parseClaudeFrontmatter(input.nativeEntry.content.text);
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body === input.canonicalEntry.text &&
        stableSourceValueEqual(parsed.values, fields(input.canonical.typeData))
    );
}
