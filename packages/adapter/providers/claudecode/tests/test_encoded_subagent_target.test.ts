import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    AssetKindTypeDataV2,
    AssetVersionFileContentV2,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
    NativeProjectEncodedFileRebaseInput,
} from "@oaam/core";
import { makeNativeProjectEncodedFileContractParts } from "../../../core/src/render/native-project-encoded-file-profiles";
import { assetSemanticKinds, fileSemanticKinds, requiredSemantic } from "../../../core/src/render/render-semantics";
import { validateClaudeCodeNativeDialect } from "../src/claudecode-source-read";
import { claudecodeProvider } from "../src/claudecode-provider";
import {
    createClaudeCodeAppGlobalEncodedSubagentTargetSupport,
    claudeCodeEncodedSubagentTargetInternalsForTest,
    createClaudeCodeAppEncodedSubagentTargetSupport,
    createClaudeCodeEncodedSubagentTargetSupport,
    createClaudeCodeGlobalEncodedSubagentTargetSupport,
} from "../src/claudecode-target-encoded-subagent";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const ENTRY_FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROMPT_FILE_ID = "55555555-5555-4555-8555-555555555555";
const PROJECT_ID = "66666666-6666-4666-8666-666666666666";
const NATIVE_PATH = ".claude/agents/oaam-phase53-agent.md";
const APP_NATIVE_PATH = ".claude/agents/oaam-phase53-app-agent.md";
const GLOBAL_NATIVE_PATH = "agents/oaam-phase53-global-agent.md";
const APP_GLOBAL_NATIVE_PATH = "agents/oaam-phase53-app-global-agent.md";
const DIALECT_ID = "claudecode-subagent-markdown-v1";
const BASE_BODY = "Reply with exactly `OAAM_CC_21220_SUBAGENT_BODY_C614EF`.\n";
const CHANGED_BODY = "Reply with exactly `OAAM_CC_21220_SUBAGENT_BODY_B0D1A2`.\n";
const BASE_PROMPT = "Start with marker OAAM_CC_21220_SUBAGENT_INITIAL_PROMPT_C614EF.";
const CHANGED_PROMPT = 'Start with "quoted # marker" OAAM_CC_21220_SUBAGENT_INITIAL_PROMPT_B0D1A2.';
const targetContextSchemaId = requiredTargetContextSchema("CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1");
const support = createClaudeCodeEncodedSubagentTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId,
});
const appTargetContextSchemaId = requiredTargetContextSchema("CLAUDE_CODE_APP_PROJECT_GUIDANCE_TARGET_V1");
const appSupport = createClaudeCodeAppEncodedSubagentTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: appTargetContextSchemaId,
});
const globalSupport = createClaudeCodeGlobalEncodedSubagentTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: requiredTargetContextSchema("CLAUDE_CODE_CLI_GLOBAL_CONFIG_TARGET_V1"),
});
const appGlobalSupport = createClaudeCodeAppGlobalEncodedSubagentTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: requiredTargetContextSchema("CLAUDE_CODE_APP_GLOBAL_CONFIG_TARGET_V1"),
});
type EncodedSupport = typeof support | typeof appSupport | typeof globalSupport | typeof appGlobalSupport;

describe("Claude Code encoded project Subagent target", () => {
    it("binds App Subagent current-exact and parent-native rebase to the exact App engine", async () => {
        expect(appSupport.renderContractDeclaration).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_APP",
            outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_SUBAGENT_ENCODED_FILE_V1",
            materializationProfileId: "claude-code-app-project-subagent-encoded-file-v1",
            verifiedBuilds: [
                expect.objectContaining({
                    versionText: "2.1.219",
                    buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                    platform: "win32",
                }),
            ],
        });
        for (const inputRole of ["current_exact", "parent_rebase_seed"] as const) {
            const fixture = analysisFixture({
                inputRole,
                targetSupport: appSupport,
                targetBody: inputRole === "parent_rebase_seed" ? CHANGED_BODY : BASE_BODY,
                targetPrompt: inputRole === "parent_rebase_seed" ? CHANGED_PROMPT : BASE_PROMPT,
            });
            const analysis = await claudecodeProvider.analyzeRender(fixture);
            expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
            const input = materializationInput(fixture, appSupport);
            expect(await claudecodeProvider.materializeRender(input)).toMatchObject({
                status: "complete",
                materializationState: "materialized",
                materializedUnits: [
                    {
                        files: [
                            {
                                relativePath: APP_NATIVE_PATH,
                                content: {
                                    text: nativeText(
                                        inputRole === "parent_rebase_seed" ? CHANGED_BODY : BASE_BODY,
                                        inputRole === "parent_rebase_seed" ? CHANGED_PROMPT : BASE_PROMPT,
                                    ),
                                },
                            },
                        ],
                    },
                ],
            });
            if (inputRole === "current_exact") {
                await expect(
                    claudecodeProvider.inspectRenderedTarget(
                        inspectionInput(input, nativeText("Inspect the App body.\n", "Inspect the App prompt."), appSupport),
                    ),
                ).resolves.toMatchObject({
                    status: "complete",
                    files: [{ attributionState: "uniquely_attributable" }],
                    changes: [{ changeKind: "file_content_replacement" }, { changeKind: "file_content_replacement" }],
                });
            }
        }
    });

    it("keeps global CLI/App current, parent-rebase and reverse lifecycles entry-specific", async () => {
        for (const [targetSupport, expectedPath] of [
            [globalSupport, GLOBAL_NATIVE_PATH],
            [appGlobalSupport, APP_GLOBAL_NATIVE_PATH],
        ] as const) {
            expect(targetSupport.renderContractDeclaration.declarationKind).toBe("native_global_encoded_file_v1");
            for (const inputRole of ["current_exact", "parent_rebase_seed"] as const) {
                const fixture = analysisFixture({
                    inputRole,
                    targetSupport,
                    targetBody: inputRole === "parent_rebase_seed" ? CHANGED_BODY : BASE_BODY,
                    targetPrompt: inputRole === "parent_rebase_seed" ? CHANGED_PROMPT : BASE_PROMPT,
                });
                expect(await claudecodeProvider.analyzeRender(fixture)).toMatchObject({
                    status: "complete",
                    blockedSemanticRefs: [],
                    diagnostics: [],
                });
                expect(await claudecodeProvider.materializeRender(materializationInput(fixture, targetSupport))).toMatchObject({
                    status: "complete",
                    materializationState: "materialized",
                    materializedUnits: [{ files: [{ relativePath: expectedPath }] }],
                });
            }
            const current = analysisFixture({ inputRole: "current_exact", targetSupport });
            await expect(
                claudecodeProvider.inspectRenderedTarget(
                    inspectionInput(
                        materializationInput(current, targetSupport),
                        nativeText(CHANGED_BODY, CHANGED_PROMPT),
                        targetSupport,
                    ),
                ),
            ).resolves.toMatchObject({
                status: "complete",
                files: [{ relativePath: expectedPath, attributionState: "uniquely_attributable" }],
                changes: [{ changeKind: "file_content_replacement" }, { changeKind: "file_content_replacement" }],
            });
        }
    });

    it("declares one exact CLI build and dispatches the complete graph through the frozen Provider facade", async () => {
        expect(support.renderContractDeclaration).toMatchObject({
            declarationKind: "native_project_encoded_file_v1",
            assetKind: "Subagent",
            agentRuntimeId: "CLAUDE_CODE_CLI",
            nativeDialectId: DIALECT_ID,
            verifiedBuilds: [
                {
                    versionText: "2.1.220",
                    buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
                    platform: "wsl",
                    fixtureSetFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
                },
            ],
        });
        expect(support.targetCapability).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            assetKind: "Subagent",
            entrySupportStatus: "supported",
            renderStrategy: "native_graph",
            reverseExtractPolicy: "can_reconcile",
        });

        const fixture = analysisFixture({
            inputRole: "parent_rebase_seed",
            targetBody: CHANGED_BODY,
            targetPrompt: CHANGED_PROMPT,
        });
        const analysis = await claudecodeProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const input = materializationInput(fixture);
        const materialized = await claudecodeProvider.materializeRender(input);
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: NATIVE_PATH,
                            content: { contentKind: "text", text: nativeText(CHANGED_BODY, CHANGED_PROMPT) },
                            sectionBindings: expect.arrayContaining([
                                expect.objectContaining({ sectionHandle: "subagent-entry" }),
                                expect.objectContaining({ sectionHandle: "subagent-prompt" }),
                            ]),
                        },
                    ],
                },
            ],
        });
        const inspection = await claudecodeProvider.inspectRenderedTarget(
            inspectionInput(input, nativeText("Inspect the changed body.\n", "Inspect the changed prompt.")),
        );
        expect(inspection).toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [{ changeKind: "file_content_replacement" }, { changeKind: "file_content_replacement" }],
        });
    });

    it.each([
        ["entry and prompt", BASE_PROMPT],
        ["entry only", undefined],
    ] as const)("restores exact current native bytes for %s", (_name, prompt) => {
        const fixture = analysisFixture({ inputRole: "current_exact", targetPrompt: prompt });
        const input = materializationInput(fixture);
        const result = support.materialize(input);
        expect(result).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: nativeText(BASE_BODY, prompt) } }] }],
        });
        expect(validateFixtureNative(fixture, nativeText(BASE_BODY, prompt))).toBe(true);
    });

    it("rebases both canonical sections while preserving Claude-only layout and comments", () => {
        expect(
            validateNative(
                canonical(CHANGED_PROMPT),
                canonicalFiles(CHANGED_BODY, CHANGED_PROMPT),
                nativeText(CHANGED_BODY, CHANGED_PROMPT),
            ),
        ).toBe(true);
        const fixture = analysisFixture({
            inputRole: "parent_rebase_seed",
            targetBody: CHANGED_BODY,
            targetPrompt: CHANGED_PROMPT,
        });
        const result = support.materialize(materializationInput(fixture));
        expect(result).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { text: nativeText(CHANGED_BODY, CHANGED_PROMPT) } }] }],
        });
        expect(validateFixtureNative(fixture, nativeText(CHANGED_BODY, CHANGED_PROMPT))).toBe(true);
    });

    it("adds and removes the optional initialPrompt section without disturbing the remaining frontmatter", () => {
        const added = analysisFixture({
            inputRole: "parent_rebase_seed",
            parentPrompt: undefined,
            targetPrompt: CHANGED_PROMPT,
        });
        const addedText = materializedText(support.materialize(materializationInput(added)));
        expect(addedText).toBe(nativeText(BASE_BODY, CHANGED_PROMPT, false, false));
        expect(validateFixtureNative(added, addedText)).toBe(true);

        const removed = analysisFixture({ inputRole: "parent_rebase_seed", targetPrompt: undefined });
        const removedText = materializedText(support.materialize(materializationInput(removed)));
        expect(removedText).toBe(nativeText(BASE_BODY, undefined, true));
        expect(validateFixtureNative(removed, removedText)).toBe(true);
    });

    it.each([
        ["body", CHANGED_BODY, BASE_PROMPT, ["instructions.json"]],
        ["initial prompt", BASE_BODY, CHANGED_PROMPT, ["initial-prompt.md"]],
        ["both sections", CHANGED_BODY, CHANGED_PROMPT, ["initial-prompt.md", "instructions.json"]],
    ] as const)("attributes a %s reverse edit to its exact canonical section", (_name, body, prompt, paths) => {
        const fixture = analysisFixture({ inputRole: "current_exact" });
        const result = support.inspect(inspectionInput(materializationInput(fixture), nativeText(body, prompt)));
        expect(result).toMatchObject({ status: "complete", files: [{ attributionState: "uniquely_attributable" }] });
        const replacements = result.changes
            .filter((change) => change.changeKind === "file_content_replacement")
            .map((change) => change.replacementContent.text)
            .sort();
        const expected = paths
            .map((path) =>
                path === "instructions.json" ? canonicalEntry(body) : path === "initial-prompt.md" ? prompt : undefined,
            )
            .filter((value): value is string => value !== undefined)
            .sort();
        expect(replacements).toEqual(expected);
    });

    it("conflicts on metadata-only, malformed, removed-section, and unsafe-path reverse edits", () => {
        const fixture = analysisFixture({ inputRole: "current_exact" });
        const input = materializationInput(fixture);
        for (const currentText of [
            nativeText(BASE_BODY, BASE_PROMPT).replace("Reviews isolated changes", "Changed outside canonical"),
            "---\nname: broken\n",
            nativeText(BASE_BODY, undefined),
        ]) {
            expect(support.inspect(inspectionInput(input, currentText))).toMatchObject({
                status: "complete",
                changes: [],
                files: [
                    {
                        attributionState: "conflict",
                        reasonCode: "native_project_encoded_file_change_not_reconcilable",
                    },
                ],
            });
        }
        const unsafe = inspectionInput(input, nativeText(CHANGED_BODY, BASE_PROMPT));
        const unsafeFile = unsafe.files[0];
        const unsafeState = unsafe.inspectionScope.fileStates[0];
        if (unsafeFile === undefined || unsafeState === undefined) throw new Error("unsafe inspection fixture missing");
        unsafeFile.relativePath = "../escape.md";
        unsafeState.relativePath = "../escape.md";
        expect(support.inspect(unsafe)).toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict" }],
        });
    });

    it("leaves mixed metadata and body edits for Core's complete native consistency gate", () => {
        const fixture = analysisFixture({ inputRole: "current_exact" });
        const changed = nativeText(CHANGED_BODY, BASE_PROMPT).replace("Reviews isolated changes", "Changed outside canonical");
        expect(support.inspect(inspectionInput(materializationInput(fixture), changed))).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement" }],
        });
        const changedFiles = canonicalFiles(CHANGED_BODY, BASE_PROMPT);
        expect(validateNative(canonical(BASE_PROMPT), changedFiles, changed)).toBe(false);
    });

    it("blocks canonical metadata drift, invalid graph shapes, foreign restoration, and unsafe native paths", () => {
        const metadata = analysisFixture({ inputRole: "parent_rebase_seed", targetBody: CHANGED_BODY });
        const canonicalValue = metadata.deployment.assets[0]?.version.canonical;
        if (canonicalValue?.kind !== "Subagent") throw new Error("Subagent fixture missing");
        canonicalValue.typeData.description = "Changed outside Claude";
        expect(support.analyze(metadata).status).toBe("failed");

        const extraResource = analysisFixture({ inputRole: "current_exact" });
        extraResource.deployment.assets[0]?.version.files.push(textFile("extra.md", "extra\n", "resource"));
        expect(support.analyze(extraResource).status).toBe("failed");

        const executablePrompt = analysisFixture({ inputRole: "current_exact" });
        const prompt = executablePrompt.deployment.assets[0]?.version.files.find((file) => file.file.role === "resource");
        if (prompt === undefined) throw new Error("prompt fixture missing");
        prompt.file.executable = true;
        expect(support.analyze(executablePrompt).status).toBe("failed");

        const restoration = analysisFixture({ inputRole: "current_exact" });
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: { dialectId: "foreign-private-v1", restorationContractFingerprint: HASH, contentHash: HASH },
            content: { contentKind: "text", text: "private\n" },
        });
        expect(support.analyze(restoration).status).toBe("failed");

        for (const relativePath of [
            "../escape.md",
            ".claude\\agents\\unsafe.md",
            ".claude/agents/.md",
            ".claude/agents/a\0.md",
        ]) {
            const unsafe = analysisFixture({ inputRole: "current_exact" });
            const native = unsafe.dialectInputs[0]?.inputs[0];
            if (native?.inputKind !== "native_representation") throw new Error("native fixture missing");
            const nativeFile = native.files[0];
            if (nativeFile === undefined) throw new Error("native file fixture missing");
            nativeFile.relativePath = relativePath;
            expect(support.analyze(unsafe).status).toBe("failed");
        }
    });

    it("keeps the Provider callback fail closed for malformed canonical envelopes and native prompts", () => {
        const invalidEntries = [
            "not-json",
            "[]",
            "{}",
            JSON.stringify({ schemaVersion: 2, sections: [{ title: "", content: BASE_BODY }] }),
            JSON.stringify({ schemaVersion: 1, sections: "invalid" }),
            JSON.stringify({ schemaVersion: 1, sections: [] }),
            JSON.stringify({ schemaVersion: 1, sections: [null] }),
            JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: BASE_BODY, extra: true }] }),
            JSON.stringify({ schemaVersion: 1, sections: [{ title: "Role", content: BASE_BODY }] }),
            JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: "" }] }),
        ];
        for (const entryText of invalidEntries) {
            const input = rebaseInput();
            const entry = input.targetFiles.find((file) => file.file.role === "entry");
            if (entry?.contentKind !== "text") throw new Error("entry fixture missing");
            entry.text = entryText;
            expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(input)).toBeNull();
        }

        const wrongDialect = rebaseInput();
        wrongDialect.nativeDialectId = "foreign-subagent-v1";
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(wrongDialect)).toBeNull();

        const missingEntry = rebaseInput();
        missingEntry.targetFiles = missingEntry.targetFiles.filter((file) => file.file.role !== "entry");
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(missingEntry)).toBeNull();

        const tooManyResources = rebaseInput();
        tooManyResources.targetFiles.push(textFile("extra.md", "extra\n", "resource"));
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(tooManyResources)).toBeNull();

        const paddedPrompt = rebaseInput();
        const prompt = paddedPrompt.targetFiles.find((file) => file.file.role === "resource");
        if (prompt?.contentKind !== "text") throw new Error("prompt fixture missing");
        prompt.text = " padded ";
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(paddedPrompt)).toBeNull();

        const invalidParent = rebaseInput();
        invalidParent.parent.file.text =
            '---\nname: oaam-phase53-agent\ndescription: Reviews isolated changes\ninitialPrompt: ""\n---\nBody.\n';
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(invalidParent)).toBeNull();
    });

    it("preserves quoted prompt parsing and both no-comment removal branches", () => {
        const quotedParent = rebaseInput({ parentPrompt: CHANGED_PROMPT, targetPrompt: BASE_PROMPT });
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(quotedParent)).toEqual({
            nativeText: nativeText(BASE_BODY, BASE_PROMPT),
        });

        const noCommentUpdate = rebaseInput({ parentPromptComment: false, targetPrompt: CHANGED_PROMPT });
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(noCommentUpdate)).toEqual({
            nativeText: nativeText(BASE_BODY, CHANGED_PROMPT, false, false),
        });

        const noCommentRemoval = rebaseInput({ parentPromptComment: false, targetPrompt: undefined });
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(noCommentRemoval)).toEqual({
            nativeText: nativeText(BASE_BODY, undefined),
        });

        const alreadyAbsent = rebaseInput({ parentPrompt: undefined, targetPrompt: undefined });
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.materializeParent(alreadyAbsent)).toEqual({
            nativeText: nativeText(BASE_BODY, undefined),
        });
    });

    it("rejects malformed decoder identities and section closures before attribution", () => {
        const base = {
            assetKind: "Subagent" as const,
            nativeDialectId: DIALECT_ID,
            relativePath: NATIVE_PATH,
            nativeText: nativeText(BASE_BODY, BASE_PROMPT),
            sections: [
                { sectionHandle: "entry", semanticKind: "subagent.invoked_context" as const },
                { sectionHandle: "prompt", semanticKind: "subagent.resource" as const },
            ],
        };
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.decode(base)).not.toBeNull();
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.decode({ ...base, nativeDialectId: "foreign" })).toBeNull();
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.decode({ ...base, relativePath: "unsafe.md" })).toBeNull();
        expect(claudeCodeEncodedSubagentTargetInternalsForTest.decode({ ...base, sections: base.sections.slice(1) })).toBeNull();
        const entrySection = base.sections[0];
        const promptSection = base.sections[1];
        if (entrySection === undefined || promptSection === undefined) throw new Error("decoder section fixture missing");
        expect(
            claudeCodeEncodedSubagentTargetInternalsForTest.decode({
                ...base,
                sections: [entrySection, promptSection, { ...promptSection, sectionHandle: "prompt-2" }],
            }),
        ).toBeNull();
        expect(
            claudeCodeEncodedSubagentTargetInternalsForTest.decode({
                ...base,
                nativeText: nativeText(BASE_BODY, undefined),
            }),
        ).toBeNull();
    });
});

interface FixtureOptions {
    inputRole: "current_exact" | "parent_rebase_seed";
    targetSupport?: EncodedSupport;
    parentBody?: string | undefined;
    parentPrompt?: string | undefined;
    targetBody?: string | undefined;
    targetPrompt?: string | undefined;
}

function analysisFixture(options: FixtureOptions): RenderAnalysisInput {
    const targetSupport = options.targetSupport ?? support;
    const isApp = targetSupport.renderContractDeclaration.agentRuntimeId === "CLAUDE_CODE_APP";
    const isGlobal = targetSupport.renderContractDeclaration.declarationKind === "native_global_encoded_file_v1";
    const targetBody = options.targetBody ?? BASE_BODY;
    const targetPrompt = Object.hasOwn(options, "targetPrompt") ? options.targetPrompt : BASE_PROMPT;
    const parentBody = options.parentBody ?? (options.inputRole === "current_exact" ? targetBody : BASE_BODY);
    const parentPrompt = Object.hasOwn(options, "parentPrompt")
        ? options.parentPrompt
        : options.inputRole === "current_exact"
          ? targetPrompt
          : BASE_PROMPT;
    const versionId = options.inputRole === "current_exact" ? VERSION_ID : "77777777-7777-4777-8777-777777777777";
    const files = canonicalFiles(targetBody, targetPrompt);
    const canonicalValue = canonical(targetPrompt);
    const asset = {
        scope: isGlobal ? ("global" as const) : ("project" as const),
        projectId: isGlobal ? "" : PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical: canonicalValue,
            files,
        },
        sectionHandles: Object.fromEntries(
            files.map((file) => [file.file.fileId, file.file.role === "entry" ? "subagent-entry" : "subagent-prompt"]),
        ),
    };
    const requiredSemantics = [
        ...assetSemanticKinds("Subagent").map((semanticKind) =>
            requiredSemantic(
                isApp ? "CLAUDE_CODE_APP" : "CLAUDE_CODE_CLI",
                { subjectKind: "asset", assetId: ASSET_ID, versionId },
                semanticKind,
            ),
        ),
        ...files.flatMap((file) =>
            fileSemanticKinds("Subagent", file).map((semanticKind) =>
                requiredSemantic(
                    isApp ? "CLAUDE_CODE_APP" : "CLAUDE_CODE_CLI",
                    { subjectKind: "file", assetId: ASSET_ID, versionId, fileId: file.file.fileId },
                    semanticKind,
                ),
            ),
        ),
    ];
    const parentText = nativeText(parentBody, parentPrompt);
    const native = {
        inputKind: "native_representation" as const,
        inputRole: options.inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: DIALECT_ID,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [nativeFile(encodedNativePath(isApp, isGlobal), parentText)],
    };
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: isApp ? "win32" : "wsl",
            platformInstanceId: isApp ? "test-win32" : "test-wsl",
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: isApp ? "CLAUDE_CODE_APP" : "CLAUDE_CODE_CLI",
                    versionText: isApp ? "2.1.219" : "2.1.220",
                    buildIdentity: isApp
                        ? "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637"
                        : "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
                    targetContextSchemaId: targetSupport.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: targetSupport.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        {
                            key: "oaam.platform",
                            value: isApp ? "win32" : "wsl",
                            evidenceLevel: "agent_runtime_verified",
                        },
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [asset],
            renderInputFingerprint: HASH,
        },
        requiredSemantics,
        dialectInputs: [
            {
                targetVersion: { assetId: ASSET_ID, versionId },
                consumerAgentRuntimeIds: [targetSupport.renderContractDeclaration.agentRuntimeId],
                inputs: [
                    options.inputRole === "current_exact"
                        ? native
                        : {
                              ...native,
                              inputRole: "parent_rebase_seed" as const,
                              sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                          },
                ],
            },
        ],
    };
}

function materializationInput(fixture: RenderAnalysisInput, targetSupport: EncodedSupport = support): RenderMaterializationInput {
    const analysis = targetSupport.analyze(fixture);
    if (analysis.status !== "complete") {
        throw new Error(`encoded Subagent analysis fixture did not close: ${JSON.stringify(analysis)}`);
    }
    const contract = makeNativeProjectEncodedFileContractParts(targetSupport.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("encoded Subagent profile missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.deployment),
        requiredSemantics: structuredClone(fixture.requiredSemantics),
        dialectInputs: structuredClone(fixture.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "CLAUDECODE",
                rendererAdapterVersion: claudecodeProvider.version,
                materializerCapabilityKey: targetSupport.materializerCapability.materializerCapabilityKey,
                materializationProfileId: targetSupport.renderContractDeclaration.materializationProfileId,
                profileConstraintFingerprint: profile.profileConstraintFingerprint,
            })),
            semanticOptions: analysis.semanticOptions.map((option) => ({
                optionFingerprint: option.optionFingerprint,
                semanticRefFingerprint: option.semanticRefFingerprint,
                renderStrategy: option.renderStrategy,
                actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                outcome: "preserved" as const,
            })),
        },
    };
}

function rebaseInput(
    options: {
        parentPrompt?: string | undefined;
        targetPrompt?: string | undefined;
        parentPromptComment?: boolean | undefined;
    } = {},
): NativeProjectEncodedFileRebaseInput {
    const targetPrompt = Object.hasOwn(options, "targetPrompt") ? options.targetPrompt : BASE_PROMPT;
    const parentPrompt = Object.hasOwn(options, "parentPrompt") ? options.parentPrompt : BASE_PROMPT;
    const fixture = analysisFixture({
        inputRole: "parent_rebase_seed",
        parentPrompt,
        targetPrompt,
    });
    const asset = fixture.deployment.assets[0];
    const native = fixture.dialectInputs[0]?.inputs[0];
    if (asset?.version.canonical.kind !== "Subagent" || native?.inputKind !== "native_representation") {
        throw new Error("rebase fixture missing");
    }
    const parentFile = native.files[0];
    if (parentFile?.contentKind !== "text" || native.inputRole !== "parent_rebase_seed") {
        throw new Error("rebase native fixture missing");
    }
    if (options.parentPromptComment === false) {
        parentFile.text = nativeText(BASE_BODY, parentPrompt, false, false);
    }
    return {
        assetKind: "Subagent",
        nativeDialectId: DIALECT_ID,
        targetCanonical: structuredClone(asset.version.canonical),
        targetFiles: structuredClone(asset.version.files),
        parent: {
            sourceVersion: structuredClone(native.sourceVersion),
            representation: structuredClone(native.representation),
            file: structuredClone(parentFile),
        },
        restorationInputs: [],
    };
}

function inspectionInput(
    materialization: RenderMaterializationInput,
    currentText: string,
    targetSupport: EncodedSupport = support,
): RenderedTargetInspectionInput {
    const result = targetSupport.materialize(materialization);
    if (result.materializationState !== "materialized") throw new Error("encoded Subagent did not materialize");
    const materialized = result.materializedUnits[0]?.files[0];
    const unit = materialization.selection.outputUnits[0];
    if (materialized?.content.contentKind !== "text" || unit === undefined) throw new Error("materialized text fixture missing");
    const appliedText = materialized.content.text;
    return {
        schemaVersion: 1,
        deploymentId: "88888888-8888-4888-8888-888888888888",
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: HASH,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: HASH,
            compilationFingerprint: HASH,
            decisions: materialization.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: "CLAUDECODE",
                consumerOwnerAdapterVersion: claudecodeProvider.version,
                optionFingerprint: HASH,
                renderStrategy: "native_graph",
                actualReverseExtractPolicy: "can_reconcile",
                outputUnitFingerprints: [unit.outputUnitFingerprint],
                outcome: "preserved",
            })),
            outputUnits: [unit],
            outputUnitRenderers: materialization.selection.outputUnitRenderers,
            semanticCoverageProofs: [],
        },
        inspectionScope: {
            inspectionScopeFingerprint: HASH,
            fileStates: [
                {
                    relativePath: materialized.relativePath,
                    state: "changed",
                    appliedContentHash: sha256Text(appliedText),
                    currentContentHash: sha256Text(currentText),
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    provenanceFingerprint: HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: materialized.relativePath,
                appliedContent: { contentKind: "text", text: appliedText },
                currentContent: { contentKind: "text", text: currentText },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(appliedText),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentText),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: HASH,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    semanticRefFingerprints: materialized.semanticRefFingerprints,
                    sectionBindings: materialized.sectionBindings,
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function requiredTargetContextSchema(targetContextSchemaId: string): string {
    const schema = claudecodeProvider.targetContextSchemas.find(
        (candidate) => candidate.targetContextSchemaId === targetContextSchemaId,
    );
    if (schema === undefined) {
        throw new Error(`Claude Code target context schema is missing: ${targetContextSchemaId}`);
    }
    return schema.targetContextSchemaId;
}

function encodedNativePath(isApp: boolean, isGlobal: boolean): string {
    if (isGlobal) return isApp ? APP_GLOBAL_NATIVE_PATH : GLOBAL_NATIVE_PATH;
    return isApp ? APP_NATIVE_PATH : NATIVE_PATH;
}

function canonical(initialPrompt: string | undefined): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name: "oaam-phase53-agent",
            description: "Reviews isolated changes",
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: { base: { mode: "inherit_available" }, unavailable: [] },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "agent_runtime_default" },
                turnLimit: { mode: "agent_runtime_default" },
                model: { mode: "inherit" },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation:
                initialPrompt === undefined
                    ? { mode: "agent_runtime_default" }
                    : {
                          mode: "user_selectable",
                          initialPrompt: {
                              mode: "resource",
                              logicalPath: "initial-prompt.md",
                              dialectId: "claudecode-initial-prompt-v1",
                          },
                      },
            presentation: { listing: "agent_runtime_default", color: { mode: "agent_runtime_default" } },
        },
    };
}

function canonicalFiles(body: string, prompt: string | undefined): AssetVersionFileContentV2[] {
    const files = [textFile("instructions.json", canonicalEntry(body), "entry")];
    if (prompt !== undefined) files.push(textFile("initial-prompt.md", prompt, "resource"));
    return files.sort((left, right) => left.file.logicalPath.localeCompare(right.file.logicalPath));
}

function textFile(logicalPath: string, text: string, role: "entry" | "resource"): AssetVersionFileContentV2 {
    return {
        contentKind: "text",
        text,
        file: {
            fileId: role === "entry" ? ENTRY_FILE_ID : logicalPath === "initial-prompt.md" ? PROMPT_FILE_ID : PROJECT_ID,
            logicalPath,
            role,
            contentHash: sha256Text(text),
            contentKind: "text",
            mediaType: logicalPath.endsWith(".json") ? "application/json" : "text/markdown",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function nativeText(body: string, prompt: string | undefined, retainedPromptComment = false, promptComment = true): string {
    return [
        "---",
        "# keep Claude-only layout",
        "name: oaam-phase53-agent",
        "description: Reviews isolated changes",
        ...(prompt === undefined
            ? retainedPromptComment
                ? ["# keep prompt placement"]
                : []
            : [`initialPrompt: ${JSON.stringify(prompt)}${promptComment ? " # keep prompt placement" : ""}`]),
        "---",
        body,
    ].join("\n");
}

function nativeFile(relativePath: string, text: string) {
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function validateFixtureNative(fixture: RenderAnalysisInput, native: string): boolean {
    const asset = fixture.deployment.assets[0];
    if (asset?.version.canonical.kind !== "Subagent") throw new Error("Subagent fixture missing");
    return validateNative(asset.version.canonical, asset.version.files, native);
}

function validateNative(
    canonicalValue: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    files: AssetVersionFileContentV2[],
    native: string,
): boolean {
    const descriptor = nativeFile(NATIVE_PATH, native);
    const { text: _text, ...file } = descriptor;
    return validateClaudeCodeNativeDialect({
        canonical: canonicalValue,
        canonicalFiles: files,
        representation: {
            schemaVersion: 1,
            dialectId: DIALECT_ID,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [file],
        },
        nativeFiles: [{ relativePath: NATIVE_PATH, bytes: new TextEncoder().encode(native) }],
    });
}

function materializedText(result: ReturnType<typeof support.materialize>): string {
    const content = result.materializationState === "materialized" ? result.materializedUnits[0]?.files[0]?.content : undefined;
    if (content?.contentKind !== "text") throw new Error("materialized Subagent text missing");
    return content.text;
}

function canonicalEntry(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body }] });
}

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}
