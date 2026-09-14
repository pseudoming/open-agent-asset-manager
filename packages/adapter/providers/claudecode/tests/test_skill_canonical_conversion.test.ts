import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    CanonicalMaterializationAssessmentInput,
    CanonicalNativePreservationSeed,
    NativeProjectExactGraphCanonicalMaterializationInput,
    SkillTypeDataV2,
} from "@oaam/core/adapter-spi";
import { claudecodeProvider } from "../src/claudecode-provider";
import { createClaudeSkillCanonicalMaterializer } from "../src/claudecode-target-skill-canonical";

const ref = { assetId: "11111111-1111-4111-8111-111111111111", versionId: "22222222-2222-4222-8222-222222222222" };
const hash = ("sha256:" + "1".repeat(64)) as `sha256:${string}`;
function data(): SkillTypeDataV2 {
    return {
        schemaVersion: 2,
        name: "Readable display name",
        description: "Review documentation.",
        whenToUse: "Before releasing the handbook.",
        entryDialectId: "antigravity-skill-markdown-v1",
        portableMetadata: { license: "MIT", compatibility: "Local documentation", metadata: { owner: "author" } },
        invocation: {
            pathCondition: { mode: "none" },
            user: { mode: "direct", commandName: "docs-review" },
            model: { mode: "model_decision" },
            argumentNames: [],
            argumentHint: "[scope]",
        },
        toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
        execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
    };
}
function assessment(
    typeData = data(),
    body = "Review $SHELL_VARIABLE without executing examples.\n",
): CanonicalMaterializationAssessmentInput {
    return {
        canonical: { kind: "Skill", typeData },
        canonicalEntry: { contentKind: "text", text: body },
        targetVersion: ref,
        targetScope: "project",
        nativeDialectId: "claudecode-skill-directory-v1",
    };
}
function nativeSeed(body: string, extra = "", dialectId = "antigravity-skill-folder-v1"): CanonicalNativePreservationSeed {
    const text = '---\nname: "Readable display name"\ndescription: "Review documentation."\n' + extra + "---\n" + body;
    const file = {
        relativePath: ".agents/skills/docs-review/SKILL.md",
        contentKind: "text" as const,
        mediaType: "text/markdown",
        executable: false,
        contentHash: hash,
        byteSize: Buffer.byteLength(text),
        text,
    };
    const { text: _text, ...descriptor } = file;
    return {
        representation: {
            schemaVersion: 1,
            dialectId,
            dialectContractFingerprint: hash,
            canonicalContentFingerprint: hash,
            representationFingerprint: hash,
            files: [descriptor],
        },
        files: [file],
    };
}

describe("Claude canonical Skill boundary", () => {
    it("retains the exact pre-change 0.8 renderer metadata without exposing a historical canonical converter", () => {
        const old = claudecodeProvider.retainedInspectionBindings?.find((row) => row.rendererVersion === "0.8.0");
        expect(old).toBeDefined();
        const snapshot = {
            version: old!.rendererVersion,
            agentRuntimes: old!.agentRuntimes,
            targetContextSchemas: old!.targetContextSchemas,
            assetTargetCapabilities: old!.assetTargetCapabilities,
            materializerCapabilities: old!.materializerCapabilities,
            renderContractDeclarations: old!.renderContractDeclarations,
        };
        expect(createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")).toBe(
            "a0b46315fb15a867ec77d77779399a865071568dfa4b01ec62b7f386feb56e73",
        );
        expect(old!.canonicalMaterializationValidators).toBeUndefined();
        expect(claudecodeProvider.canonicalMaterializationValidators).toHaveLength(8);
    });

    it.each([
        "project",
        "global",
    ] as const)("preserves independent metadata, command identity and disabled invocation for %s", (scope) => {
        const materializer = createClaudeSkillCanonicalMaterializer(scope),
            typeData = data();
        const input = assessment(typeData),
            body = (input.canonicalEntry as { contentKind: "text"; text: string }).text;
        const entry = {
            file: {
                fileId: "entry",
                logicalPath: "SKILL.md",
                role: "entry" as const,
                contentKind: "text" as const,
                mediaType: "text/markdown",
                executable: false,
                byteSize: Buffer.byteLength(body),
                contentHash: hash,
            },
            contentKind: "text" as const,
            text: body,
        };
        const request: NativeProjectExactGraphCanonicalMaterializationInput = {
            assetKind: "Skill",
            targetCanonical: { kind: "Skill", typeData },
            targetFiles: [entry],
            targetVersion: ref,
            targetScope: scope,
            nativeDialectId: input.nativeDialectId,
            restorationInputs: [],
        };
        for (const disabled of [false, true]) {
            if (disabled) {
                typeData.name = "docs-review";
                typeData.invocation.user = { mode: "not_directly_invocable" };
                typeData.invocation.model = { mode: "disabled" };
            }
            const result = materializer.materialize(request);
            expect(result?.nativeFiles).toHaveLength(1);
            const file = result!.nativeFiles[0]!;
            expect(file.relativePath).toBe((scope === "project" ? ".claude/" : "") + "skills/docs-review/SKILL.md");
            if (file.contentKind !== "text") throw new Error("Text entry missing");
            expect(file.text).toContain('when_to_use: "Before releasing the handbook."');
            expect(file.text).toContain('license: "MIT"');
            expect(file.text).toContain('argument-hint: "[scope]"');
            if (disabled) {
                expect(file.text).toContain("user-invocable: false");
                expect(file.text).toContain("disable-model-invocation: true");
            }
            const validation = {
                ...assessment(typeData, body),
                targetScope: scope,
                nativeEntry: { relativePath: file.relativePath, content: { contentKind: "text" as const, text: file.text } },
            };
            expect(materializer.validateEntry(validation)).toBe(true);
            expect(
                materializer.validateEntry({
                    ...validation,
                    nativeEntry: { ...validation.nativeEntry, relativePath: "skills/wrong/SKILL.md" },
                }),
            ).toBe(false);
            expect(
                materializer.validateEntry({
                    ...validation,
                    nativeEntry: {
                        ...validation.nativeEntry,
                        content: { contentKind: "text", text: file.text.replace(typeData.whenToUse, "wrong trigger") },
                    },
                }),
            ).toBe(false);
        }
    });

    const blocked: [string, (value: SkillTypeDataV2) => void][] = [
        [
            "unknown entry dialect",
            (value) => {
                value.entryDialectId = "unknown-skill-v1";
            },
        ],
        [
            "path trigger",
            (value) => {
                value.invocation.pathCondition = { mode: "required", patterns: ["src/**"] };
            },
        ],
        [
            "argument substitution",
            (value) => {
                value.invocation.argumentNames = ["branch"];
            },
        ],
        [
            "tool preapproval",
            (value) => {
                value.toolPolicy.preapproved = [{ dialectId: "claudecode-tool-selector-v1", selector: "Bash" }];
            },
        ],
        [
            "tool denial",
            (value) => {
                value.toolPolicy.denied = [{ dialectId: "claudecode-tool-selector-v1", selector: "Write" }];
            },
        ],
        [
            "isolated execution",
            (value) => {
                value.execution = {
                    mode: "isolated",
                    agent: { mode: "agent_runtime_default" },
                    model: { mode: "inherit" },
                    effort: { mode: "inherit" },
                };
            },
        ],
        [
            "model selection",
            (value) => {
                value.execution.model = {
                    mode: "selected",
                    dialectId: "claudecode-model-selector-v1",
                    selector: "sonnet",
                    relativeTier: 2,
                };
            },
        ],
        [
            "unsafe command boundary",
            (value) => {
                value.invocation.user = { mode: "direct", commandName: "../outside" };
            },
        ],
        [
            "unserializable metadata key",
            (value) => {
                value.portableMetadata.metadata = { true: "unexpected YAML key" };
            },
        ],
    ];
    it.each(blocked)("blocks %s without authorizing loss", (_name, mutate) => {
        const value = data();
        mutate(value);
        expect(createClaudeSkillCanonicalMaterializer("project").assessLoss!(assessment(value))).toBeNull();
    });

    it.each([
        "Run $ARGUMENTS",
        "Read $0",
        "Use ${CLAUDE_SKILL_DIR}",
        "Execute !`echo altered`",
        "```!\necho altered\n```",
    ])("does not activate foreign entry syntax %s", (body) => {
        expect(createClaudeSkillCanonicalMaterializer("project").assessLoss!(assessment(data(), body))).toBeNull();
    });

    it("assesses the unique source entry, rejects unknown fields and preserves ordinary Shell variables", () => {
        const materializer = createClaudeSkillCanonicalMaterializer("project"),
            body = "Read $PROJECT_ROOT.\n";
        const base = assessment(data(), body);
        expect(materializer.assessLoss!(base)).toEqual([]);
        const source = nativeSeed(body);
        expect(materializer.assessLoss!({ ...base, nativePreservationSeed: source })).toEqual([]);
        expect(materializer.assessLoss!({ ...base, nativePreservationSeed: nativeSeed(body, "hooks: forbidden\n") })).toBeNull();
        expect(
            materializer.assessLoss!({ ...base, nativePreservationSeed: nativeSeed(body, "", "unknown-native-v1") }),
        ).toBeNull();
        expect(materializer.assessLoss!({ ...base, nativePreservationSeed: nativeSeed("different body\n") })).toBeNull();
        expect(
            materializer.assessLoss!({
                ...base,
                nativePreservationSeed: nativeSeed(body, 'version: "private-version"\n', "claudecode-skill-directory-v1"),
            }),
        ).toEqual(["runtime_specific_metadata_lost"]);
        const sibling = structuredClone(source);
        sibling.files.push({ ...sibling.files[0]!, relativePath: ".agents/skills/sibling/SKILL.md" });
        expect(materializer.assessLoss!({ ...base, nativePreservationSeed: sibling })).toBeNull();
    });
});
