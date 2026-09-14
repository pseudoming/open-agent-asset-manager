/** Bounded OpenCode `instructions` fragment and owned-file projection. */

import type { PosixRelativePath, RenderNativeRepresentationFileInput } from "@oaam/core";
import { readJsoncTopLevelPropertyValue } from "@oaam/core/adapter-spi";
import { compareText, decodeUtf8, isCanonicalNativeRelativePath } from "./opencode-source-read-foundation";
import { stripJsonc } from "./opencode-source-read-jsonc";

export const OPENCODE_INSTRUCTIONS_PROPERTY = "instructions";
export const OPENCODE_RULE_FRAGMENT_LOGICAL_PATH = "resources/opencode-instructions.fragment.jsonc" as PosixRelativePath;
export const OPENCODE_PROJECT_CONFIG_PATHS = ["opencode.json", "opencode.jsonc"] as const satisfies readonly PosixRelativePath[];

const MAX_INSTRUCTION_PATHS = 64;
const MAX_INSTRUCTION_PATH_LENGTH = 1_024;

export type OpencodeInstructionFragmentResult =
    | { status: "complete"; fragmentBytes: Uint8Array; instructionPaths: PosixRelativePath[] }
    | {
          status: "absent" | "invalid" | "dynamic";
          reasonCode: string;
          message: string;
      };

export function readOpencodeInstructionFragment(containerBytes: Uint8Array): OpencodeInstructionFragmentResult {
    let fragment: Uint8Array | null;
    try {
        fragment = readJsoncTopLevelPropertyValue(containerBytes, OPENCODE_INSTRUCTIONS_PROPERTY)?.valueBytes ?? null;
    } catch {
        return {
            status: "invalid",
            reasonCode: "opencode.rule_instructions_container_invalid",
            message: "The OpenCode config has an invalid or ambiguous top-level instructions property",
        };
    }
    if (fragment === null) {
        return {
            status: "absent",
            reasonCode: "opencode.rule_instructions_absent",
            message: "The OpenCode config does not declare an instructions list",
        };
    }
    return parseOpencodeInstructionFragment(fragment);
}

export function parseOpencodeInstructionFragment(fragmentBytes: Uint8Array): OpencodeInstructionFragmentResult {
    let value: unknown;
    try {
        const text = decodeUtf8(fragmentBytes);
        if (text === null) throw new Error("instructions fragment is not UTF-8");
        value = JSON.parse(stripJsonc(text)) as unknown;
    } catch {
        return {
            status: "invalid",
            reasonCode: "opencode.rule_instructions_invalid",
            message: "The OpenCode instructions property is not a valid bounded JSONC value",
        };
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INSTRUCTION_PATHS) {
        return {
            status: "invalid",
            reasonCode: "opencode.rule_instructions_shape_invalid",
            message: `OpenCode instructions must contain between 1 and ${MAX_INSTRUCTION_PATHS} path strings`,
        };
    }
    const paths: PosixRelativePath[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string" || item.length === 0 || item.length > MAX_INSTRUCTION_PATH_LENGTH) {
            return {
                status: "invalid",
                reasonCode: "opencode.rule_instruction_path_invalid",
                message: "Every OpenCode instruction must be one bounded non-empty path string",
            };
        }
        if (!isLiteralProjectInstructionPath(item)) {
            return {
                status: "dynamic",
                reasonCode: "opencode.rule_instruction_path_dynamic",
                message:
                    "This instructions list uses a URL, absolute path, home-relative path, or glob; OAAM will not guess its current file set",
            };
        }
        if (seen.has(item)) {
            return {
                status: "invalid",
                reasonCode: "opencode.rule_instruction_path_duplicate",
                message: "The OpenCode instructions list contains the same physical path more than once",
            };
        }
        seen.add(item);
        paths.push(item as PosixRelativePath);
    }
    return { status: "complete", fragmentBytes: new Uint8Array(fragmentBytes), instructionPaths: paths };
}

export function canonicalRuleLogicalPath(index: number): PosixRelativePath {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("OpenCode instruction index must be non-negative");
    return index === 0
        ? ("RULE.md" as PosixRelativePath)
        : (`resources/instruction-${String(index + 1).padStart(4, "0")}.md` as PosixRelativePath);
}

export function opencodeRuleGraph(files: readonly RenderNativeRepresentationFileInput[]): {
    graphIdentityRelativePath: PosixRelativePath;
    files: Array<{ nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }>;
    managedDirectoryBoundaries: PosixRelativePath[];
} | null {
    const configFiles = files.filter((file) => isProjectConfigPath(file.relativePath));
    if (configFiles.length !== 1) return null;
    const config = configFiles[0] as RenderNativeRepresentationFileInput;
    if (config.contentKind !== "binary" || config.executable) return null;
    const fragment = parseOpencodeInstructionFragment(config.bytes);
    if (fragment.status !== "complete") return null;
    const byPath = new Map(files.map((file) => [file.relativePath, file]));
    if (byPath.size !== files.length || files.length !== fragment.instructionPaths.length + 1) return null;
    const projection = [
        {
            nativeRelativePath: config.relativePath,
            canonicalLogicalPath: OPENCODE_RULE_FRAGMENT_LOGICAL_PATH,
        },
    ];
    for (const [index, path] of fragment.instructionPaths.entries()) {
        const file = byPath.get(path);
        if (file?.contentKind !== "text" || file.text.trim() === "") return null;
        projection.push({ nativeRelativePath: path, canonicalLogicalPath: canonicalRuleLogicalPath(index) });
    }
    return {
        graphIdentityRelativePath: config.relativePath,
        files: projection.sort((left, right) => compareText(left.nativeRelativePath, right.nativeRelativePath)),
        managedDirectoryBoundaries: [],
    };
}

export function isProjectConfigPath(path: string): path is (typeof OPENCODE_PROJECT_CONFIG_PATHS)[number] {
    return OPENCODE_PROJECT_CONFIG_PATHS.includes(path as (typeof OPENCODE_PROJECT_CONFIG_PATHS)[number]);
}

function isLiteralProjectInstructionPath(path: string): boolean {
    return isCanonicalNativeRelativePath(path) && !path.startsWith("~/") && !path.includes("://") && !/[?*{}[\]]/u.test(path);
}
