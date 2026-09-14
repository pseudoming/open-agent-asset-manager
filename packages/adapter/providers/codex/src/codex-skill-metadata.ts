/** Strict, non-executing interpretation of Codex agents/openai.yaml. */

import { parseDocument } from "yaml";

const INTERFACE_FIELDS = new Set([
    "display_name",
    "short_description",
    "icon_small",
    "icon_large",
    "brand_color",
    "default_prompt",
]);

export interface CodexSkillMetadataResult {
    allowImplicitInvocation: boolean;
    diagnostics: string[];
    nativeOnlyDiagnostics: string[];
}

export function parseCodexSkillMetadata(content: string): CodexSkillMetadataResult {
    try {
        const document = parseDocument(content, {
            customTags: [],
            merge: false,
            prettyErrors: false,
            schema: "core",
            strict: true,
            uniqueKeys: true,
        });
        if (document.errors.length > 0) {
            return result(
                true,
                document.errors.map((error) => error.message),
            );
        }
        const value: unknown = document.toJS({ maxAliasCount: 0 });
        if (!isRecord(value)) return result(true, ["agents/openai.yaml must contain a mapping"]);

        const diagnostics: string[] = [];
        const nativeOnlyDiagnostics: string[] = [];
        for (const key of Object.keys(value)) {
            if (key !== "interface" && key !== "policy" && key !== "dependencies") {
                diagnostics.push(`unsupported agents/openai.yaml key ${key}`);
            }
        }
        if (value.interface !== undefined) {
            if (!isRecord(value.interface)) {
                diagnostics.push("agents/openai.yaml interface must be a mapping");
            } else {
                for (const [key, fieldValue] of Object.entries(value.interface)) {
                    if (!INTERFACE_FIELDS.has(key)) {
                        diagnostics.push(`unsupported agents/openai.yaml interface key ${key}`);
                    } else if (typeof fieldValue !== "string") {
                        diagnostics.push(`agents/openai.yaml interface ${key} must be a string`);
                    }
                    if (key === "default_prompt" && typeof fieldValue === "string") {
                        nativeOnlyDiagnostics.push(
                            "agents/openai.yaml interface default_prompt is preserved as Codex-native Skill state",
                        );
                    }
                }
            }
        }

        let allowImplicitInvocation = true;
        if (value.policy !== undefined) {
            if (!isRecord(value.policy)) {
                diagnostics.push("agents/openai.yaml policy must be a mapping");
            } else {
                for (const key of Object.keys(value.policy)) {
                    if (key !== "allow_implicit_invocation") {
                        diagnostics.push(`unsupported agents/openai.yaml policy key ${key}`);
                    }
                }
                const configured = value.policy.allow_implicit_invocation;
                if (configured !== undefined) {
                    if (typeof configured === "boolean") allowImplicitInvocation = configured;
                    else diagnostics.push("agents/openai.yaml allow_implicit_invocation must be boolean");
                }
            }
        }
        if (value.dependencies !== undefined && !isEmptyCollection(value.dependencies)) {
            nativeOnlyDiagnostics.push("agents/openai.yaml dependencies are preserved as Codex-native Skill state");
        }
        return result(allowImplicitInvocation, diagnostics, nativeOnlyDiagnostics);
    } catch (error) {
        return result(true, [error instanceof Error ? error.message : "agents/openai.yaml could not be parsed"]);
    }
}

function result(
    allowImplicitInvocation: boolean,
    diagnostics: string[],
    nativeOnlyDiagnostics: string[] = [],
): CodexSkillMetadataResult {
    return { allowImplicitInvocation, diagnostics, nativeOnlyDiagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyCollection(value: unknown): boolean {
    if (Array.isArray(value)) return value.length === 0;
    return isRecord(value) && Object.keys(value).length === 0;
}
