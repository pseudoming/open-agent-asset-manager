import type { AssetKindTypeDataV2, SubagentToolSelectorV2 } from "../contracts/specs";
import type { AssetSpecHandler, SpecDependencyRequirement } from "./registry";
import { isAssetKindTypeDataV2, parseSubagentInstructionEntryV1 } from "./validators";

function boundSubagentRequirement(selector: SubagentToolSelectorV2, source: string): SpecDependencyRequirement[] {
    return selector.mode === "bound_subagent"
        ? [
              {
                  targetAssetVersionId: selector.targetAssetVersionId,
                  expectedTarget: "Subagent",
                  scopeRequirement: "none",
                  source,
              },
          ]
        : [];
}

export const subagentSpecHandler = Object.freeze({
    kind: "Subagent",
    isCanonicalPair: (value: unknown) => isAssetKindTypeDataV2(value) && value.kind === "Subagent",
    completeEntryRule: () => "one_text",
    validateEntryText: (text: string) => parseSubagentInstructionEntryV1(text) !== null,
    validateFiles: (canonical, files) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Subagent" }>).typeData;
        if (data.directInvocation.mode !== "user_selectable" || data.directInvocation.initialPrompt.mode !== "resource") {
            return [];
        }
        const expectedPath = data.directInvocation.initialPrompt.logicalPath;
        const target = files.find((file) => file.file.logicalPath === expectedPath);
        if (
            target === undefined ||
            target.file.role !== "resource" ||
            target.file.executable ||
            target.contentKind !== "text" ||
            target.text.trim().length === 0
        ) {
            return [{ code: "invalid_initial_prompt_resource", path: expectedPath }];
        }
        return [];
    },
    collectDependencies: (canonical) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Subagent" }>).typeData;
        const requirements: SpecDependencyRequirement[] = data.dependencies.preloadedSkillVersionIds.map(
            (targetAssetVersionId) => ({
                targetAssetVersionId,
                expectedTarget: "Skill",
                scopeRequirement: "none",
                source: "typeData.dependencies.preloadedSkillVersionIds",
            }),
        );
        const availability = data.tools.availability;
        if (availability.base.mode === "allowlist") {
            for (const selector of availability.base.allowed) {
                requirements.push(...boundSubagentRequirement(selector, "typeData.tools.availability.base.allowed"));
            }
        }
        for (const selector of availability.unavailable) {
            requirements.push(...boundSubagentRequirement(selector, "typeData.tools.availability.unavailable"));
        }
        for (const rule of data.tools.permission.rules) {
            requirements.push(...boundSubagentRequirement(rule.selector, "typeData.tools.permission.rules"));
        }
        return requirements;
    },
    searchProjection: (canonical, files) => {
        const data = (canonical as Extract<AssetKindTypeDataV2, { kind: "Subagent" }>).typeData;
        const entry = files.find((file) => file.file.role === "entry" && file.contentKind === "text");
        const instruction = entry?.contentKind === "text" ? parseSubagentInstructionEntryV1(entry.text) : null;
        return [
            data.name,
            data.description,
            ...(instruction?.sections.flatMap((section) => [section.title, section.content]) ?? []),
        ];
    },
} satisfies AssetSpecHandler);
