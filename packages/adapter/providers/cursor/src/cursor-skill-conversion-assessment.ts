/** Assess concrete source metadata through the Core-selected immutable native representation. */
import { stableSourceValueEqual } from "@oaam/adapter-framework";
import type { CanonicalMaterializationAssessmentInput } from "@oaam/core/adapter-spi";
import { parseCursorFrontmatter } from "./cursor-frontmatter";

export const CURSOR_SKILL_SOURCE_DIALECTS = [
    "antigravity-skill-flat-v1",
    "antigravity-skill-folder-v1",
    "claudecode-skill-directory-v1",
    "codex-skill-directory-v1",
    "cursor-skill-directory-v1",
    "opencode-skill-directory-v1",
    "opencode-skill-directory-v2",
    "zcode-skill-directory-v1",
];
const DEFAULT_POLICY_FIELDS: Readonly<Record<string, readonly string[]>> = {
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

/** Caller has already proved the canonical invocation/tool/execution fields are expressible. */
export function assessCursorSkillSourceMetadata(
    input: CanonicalMaterializationAssessmentInput,
): ["runtime_specific_metadata_lost"] | [] | null {
    const seed = input.nativePreservationSeed;
    if (
        input.canonical.kind !== "Skill" ||
        input.canonicalEntry.contentKind !== "text" ||
        (seed !== undefined && !CURSOR_SKILL_SOURCE_DIALECTS.includes(seed.representation.dialectId))
    )
        return null;
    // Core leaves this absent for canonical-only user Versions, never for an unassessed current native source.
    if (seed === undefined)
        return input.canonical.typeData.portableMetadata.license !== "" ||
            input.canonical.typeData.portableMetadata.compatibility !== ""
            ? ["runtime_specific_metadata_lost"]
            : [];
    const entries =
        seed.representation.dialectId === "antigravity-skill-flat-v1"
            ? seed.files.filter((file) => seed.files.length === 1 && file.relativePath.endsWith(".md"))
            : seed.files.filter(
                  (file) =>
                      file.relativePath.endsWith("/SKILL.md") &&
                      seed.files.every((owned) => owned.relativePath.startsWith(file.relativePath.slice(0, -"SKILL.md".length))),
              );
    const entry = entries[0];
    if (entries.length !== 1 || entry?.contentKind !== "text") return null;
    const parsed = parseCursorFrontmatter(entry.text);
    if ((parsed.hasFrontmatter && !parsed.closed) || parsed.diagnostics.length !== 0 || parsed.body !== input.canonicalEntry.text)
        return null;
    const data = input.canonical.typeData;
    const mapped: Record<string, unknown> = {
        name: data.name,
        description: data.description,
        license: data.portableMetadata.license,
        compatibility: data.portableMetadata.compatibility,
        metadata: data.portableMetadata.metadata,
    };
    let metadataLost = data.portableMetadata.license !== "" || data.portableMetadata.compatibility !== "";
    for (const [key, value] of Object.entries(parsed.values)) {
        if (key === "name" || key === "description") {
            if (!stableSourceValueEqual(value, mapped[key])) return null;
        } else if (key === "license" || key === "compatibility") {
            if (value !== "") metadataLost = true;
        } else if (key === "metadata") {
            if (!stableSourceValueEqual(value, mapped[key])) metadataLost = true;
        } else if (key === "version" && seed.representation.dialectId === "claudecode-skill-directory-v1") {
            metadataLost = true;
        } else if (!DEFAULT_POLICY_FIELDS[seed.representation.dialectId]?.includes(key)) {
            // Unknown fields may carry behavior; metadata approval must not authorize losing an unknown restriction.
            return null;
        }
    }
    return metadataLost ? ["runtime_specific_metadata_lost"] : [];
}
