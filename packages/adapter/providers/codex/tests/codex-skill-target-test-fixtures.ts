import * as crypto from "node:crypto";

import type {
    AssetKindTypeDataV2,
    AssetVersionFileContentV2,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core";

import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { codexProvider } from "../src/codex-provider";
import { validateCodexNativeDialect } from "../src/codex-source-read-native";
import { createCodexSkillGraphTargetSupports } from "../src/codex-target-exact-graph";

export type CodexRuntime = "CODEX_CLI" | "CODEX_APP";
export type SkillVariant = "project_cli" | "project_app" | "global_cli" | "global_app";

export const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
export const ASSET_ID = "11111111-1111-4111-8111-111111111111";
export const VERSION_ID = "22222222-2222-4222-8222-222222222222";
export const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
export const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
export const ENTRY_BODY = "\nUse the bundled resources. OAAM_CODEX_SKILL_GRAPH_41A7D2\n";
export const CHANGED_ENTRY_BODY = ENTRY_BODY.replace("41A7D2", "99C4E1");
export const SCRIPT = "print('OAAM_CODEX_RESOURCE_V1')\n";
export const CHANGED_SCRIPT = "print('OAAM_CODEX_RESOURCE_V2')\n";
export const PRIVATE_METADATA = [
    "interface:",
    "  default_prompt: Use the OAAM graph marker.",
    "policy:",
    "  allow_implicit_invocation: false",
    "dependencies:",
    "  tools:",
    "    - type: mcp",
    "      value: docs",
    "",
].join("\n");
export const BINARY = Uint8Array.of(0, 255, 1, 2);
export const CHANGED_BINARY = Uint8Array.of(0, 255, 4, 5);

export const supports = createCodexSkillGraphTargetSupports({
    adapterVersion: codexProvider.version,
    agentRuntimes: codexProvider.agentRuntimes,
});

export function supportFor(variant: SkillVariant) {
    const runtime: CodexRuntime = variant.endsWith("app") ? "CODEX_APP" : "CODEX_CLI";
    return variant.startsWith("global") ? supports[runtime].global : supports[runtime].project;
}

export function analysisFixture(
    variant: SkillVariant,
    inputRole: "current_exact" | "parent_rebase_seed",
    files: AssetVersionFileContentV2[],
): RenderAnalysisInput {
    const selected = skillVariant(variant);
    const targetSupport = supportFor(variant);
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const nativeFiles = nativeFilesFor(inputRole === "current_exact" ? files : canonicalFiles(), variant);
    const runtime: CodexRuntime = variant.endsWith("app") ? "CODEX_APP" : "CODEX_CLI";
    const platform = runtime === "CODEX_APP" ? "win32" : "wsl";
    const asset = {
        scope: variant.startsWith("global") ? ("global" as const) : ("project" as const),
        projectId: variant.startsWith("global") ? "" : PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical: skillCanonical(selected.name),
            files: structuredClone(files),
        },
        sectionHandles: Object.fromEntries(files.map((file) => [file.file.fileId, `skill-${file.file.logicalPath}`])),
    };
    const common = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: "codex-skill-directory-v1",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: nativeFiles.map(({ text: _text, bytes: _bytes, ...descriptor }) => descriptor),
        },
        files: nativeFiles,
    };
    const semantics = [
        semantic("asset.file_inventory", runtime, versionId, "asset"),
        semantic("skill.discovery_metadata", runtime, versionId, "asset"),
        ...files.map((file) =>
            semantic(file.file.role === "entry" ? "skill.body" : "skill.resource", runtime, versionId, "file", file.file.fileId),
        ),
    ];
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform,
            platformInstanceId: `test-${platform}`,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: runtime,
                    versionText: runtime === "CODEX_APP" ? "0.147.0-alpha.1.2" : "0.142.5",
                    buildIdentity:
                        runtime === "CODEX_APP"
                            ? "sha256:fa960ec081bec3629f40c63ed610ebc49c7e5e077dfb42322b08cb6d460f0b8a"
                            : "sha256:ac06f492f3ded7a8e2f36dc961e3cc5276a3c4841a2695d4681d0557c5b30e41",
                    targetContextSchemaId: targetSupport.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: targetSupport.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: platform, evidenceLevel: "agent_runtime_verified" as const },
                        ...(variant.startsWith("global")
                            ? [
                                  {
                                      key: "oaam.target-kind",
                                      value: "directory",
                                      evidenceLevel: "agent_runtime_verified" as const,
                                  },
                              ]
                            : []),
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [asset],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: semantics as RenderAnalysisInput["requiredSemantics"],
        dialectInputs: [
            {
                targetVersion: { assetId: ASSET_ID, versionId },
                consumerAgentRuntimeIds: [runtime],
                inputs: [
                    inputRole === "current_exact"
                        ? common
                        : {
                              ...common,
                              inputRole: "parent_rebase_seed" as const,
                              sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                          },
                ],
            },
        ],
    };
}

export function materializationInput(
    analysisInput: RenderAnalysisInput,
    targetSupport: ReturnType<typeof supportFor>,
): RenderMaterializationInput {
    const analysis = targetSupport.analyze(analysisInput);
    if (analysis.status !== "complete") throw new Error("Skill graph analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(targetSupport.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Skill graph target profile is missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(analysisInput.deployment),
        requiredSemantics: structuredClone(analysisInput.requiredSemantics),
        dialectInputs: structuredClone(analysisInput.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "CODEX",
                rendererAdapterVersion: codexProvider.version,
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
                ...(option.outcome === "degraded"
                    ? { outcome: "degraded" as const, degradationFingerprint: option.degradationFingerprint }
                    : { outcome: "preserved" as const }),
            })),
        },
    };
}

export function changedInspection(
    fixture: RenderAnalysisInput,
    materialization: RenderMaterializationInput,
    variant: SkillVariant,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Skill graph output unit missing");
    const selected = skillVariant(variant);
    const applied = nativeFilesFor(canonicalFiles(), variant);
    const current = nativeFilesFor(changedCanonicalFiles(), variant);
    const files = applied.map((appliedFile) => {
        const currentFile = current.find((file) => file.relativePath === appliedFile.relativePath);
        if (currentFile === undefined || currentFile.contentKind !== appliedFile.contentKind) throw new Error("graph mismatch");
        const fileId = canonicalFiles().find(
            (file) => `${selected.boundary}/${file.file.logicalPath}` === appliedFile.relativePath,
        )?.file.fileId;
        if (fileId === undefined) throw new Error("canonical graph mismatch");
        const appliedContent =
            appliedFile.contentKind === "text"
                ? { contentKind: "text" as const, text: appliedFile.text }
                : { contentKind: "binary" as const, bytes: new Uint8Array(appliedFile.bytes) };
        const currentContent =
            currentFile.contentKind === "text"
                ? { contentKind: "text" as const, text: currentFile.text }
                : { contentKind: "binary" as const, bytes: new Uint8Array(currentFile.bytes) };
        const executableChanged = appliedFile.executable !== currentFile.executable;
        return {
            fileState: "baseline_changed" as const,
            relativePath: appliedFile.relativePath,
            appliedContent,
            currentContent,
            diffHunks: [
                {
                    hunkFingerprint: sha256Text(appliedFile.relativePath),
                    appliedStartByte: 0,
                    appliedEndByte: appliedFile.byteSize,
                    currentStartByte: 0,
                    currentEndByte: currentFile.byteSize,
                },
            ],
            attributeChanges: executableChanged
                ? [
                      {
                          attributeChangeFingerprint: sha256Text(`${appliedFile.relativePath}:executable`),
                          attributeKind: "executable" as const,
                          appliedValue: appliedFile.executable,
                          currentValue: currentFile.executable,
                      },
                  ]
                : [],
            provenance: {
                schemaVersion: 1 as const,
                appliedRenderSnapshotFingerprint: HASH,
                outputUnitFingerprint: unit.outputUnitFingerprint,
                semanticRefFingerprints: fixture.requiredSemantics
                    .filter(
                        (item) =>
                            item.subject.subjectKind === "asset" ||
                            (item.subject.subjectKind === "file" && item.subject.fileId === fileId),
                    )
                    .map((item) => item.semanticRefFingerprint),
                sectionBindings: [],
                materializationFingerprint: HASH,
                provenanceFingerprint: HASH,
            },
        };
    });
    return {
        schemaVersion: 1,
        deploymentId: "77777777-7777-4777-8777-777777777777",
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: HASH,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: HASH,
            compilationFingerprint: HASH,
            decisions: materialization.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: "CODEX",
                consumerOwnerAdapterVersion: codexProvider.version,
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
            fileStates: files.map((file) => ({
                relativePath: file.relativePath,
                state: "changed" as const,
                appliedContentHash: contentHash(file.appliedContent),
                currentContentHash: contentHash(file.currentContent),
                appliedExecutable: file.attributeChanges[0]?.appliedValue ?? false,
                currentExecutable: file.attributeChanges[0]?.currentValue ?? false,
                outputUnitFingerprint: unit.outputUnitFingerprint,
                provenanceFingerprint: HASH,
            })),
            directoryInventories: [
                {
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    boundary: { relativePath: selected.boundary, boundaryKind: "directory_inventory" },
                    currentDescendantPaths: current.map((file) => file.relativePath),
                },
            ],
        },
        files,
        inventoryDeltas: [],
    };
}

export function canonicalFiles(): AssetVersionFileContentV2[] {
    return [
        textFile("SKILL.md", ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false),
        textFile("agents/openai.yaml", PRIVATE_METADATA, "22222222-2222-4222-8222-222222222223", "resource", false),
        binaryFile("assets/marker.bin", BINARY, "44444444-4444-4444-8444-444444444444"),
        textFile("scripts/marker.py", SCRIPT, "33333333-3333-4333-8333-333333333333", "resource", false),
    ];
}

export function changedCanonicalFiles(): AssetVersionFileContentV2[] {
    return [
        textFile("SKILL.md", CHANGED_ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false),
        textFile("agents/openai.yaml", PRIVATE_METADATA, "22222222-2222-4222-8222-222222222223", "resource", false),
        binaryFile("assets/marker.bin", CHANGED_BINARY, "44444444-4444-4444-8444-444444444444"),
        textFile("scripts/marker.py", CHANGED_SCRIPT, "33333333-3333-4333-8333-333333333333", "resource", true),
    ];
}

export function skillVariant(variant: SkillVariant): { boundary: string; name: string; header: string } {
    const name = `oaam-phase54-${variant.replace("_", "-")}-skill`;
    const boundary = variant.startsWith("global") ? name : `${variant === "project_app" ? ".codex" : ".agents"}/skills/${name}`;
    return {
        boundary,
        name,
        header: [
            "---",
            "# preserve Codex Skill layout",
            `name: ${name}`,
            "description: OAAM Codex graph Skill",
            "license: MIT",
            "compatibility: Codex",
            "metadata:",
            "  owner: oaam",
            "---",
            "",
        ].join("\n"),
    };
}

export function nativeFilesFor(files: AssetVersionFileContentV2[], variant: SkillVariant) {
    const selected = skillVariant(variant);
    return files
        .map((file) => {
            const relativePath = `${selected.boundary}/${file.file.logicalPath}`;
            if (file.contentKind === "binary") return nativeBinary(relativePath, file.bytes, file.file.executable);
            const text = file.file.role === "entry" ? `${selected.header}${file.text}` : file.text;
            return nativeText(relativePath, text, file.file.executable);
        })
        .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
}

export function validateNative(files: AssetVersionFileContentV2[], nativeFiles: ReturnType<typeof nativeFilesFor>): boolean {
    return validateCodexNativeDialect({
        canonical: skillCanonical(skillVariant("project_cli").name),
        canonicalFiles: files,
        representation: {
            schemaVersion: 1,
            dialectId: "codex-skill-directory-v1",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: nativeFiles.map(({ text: _text, bytes: _bytes, ...descriptor }) => descriptor),
        },
        nativeFiles: nativeFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes: file.contentKind === "text" ? new TextEncoder().encode(file.text) : new Uint8Array(file.bytes),
        })),
    });
}

export function skillCanonical(name: string): Extract<AssetKindTypeDataV2, { kind: "Skill" }> {
    return {
        kind: "Skill",
        typeData: {
            schemaVersion: 2,
            name,
            description: "OAAM Codex graph Skill",
            whenToUse: "",
            entryDialectId: "codex-skill-markdown-v1",
            portableMetadata: { license: "MIT", compatibility: "Codex", metadata: { owner: "oaam" } },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "direct", commandName: name },
                model: { mode: "disabled" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
        },
    };
}

export function textFile(
    logicalPath: string,
    text: string,
    fileId: string,
    role: "entry" | "resource",
    executable: boolean,
): AssetVersionFileContentV2 {
    return {
        contentKind: "text",
        text,
        file: {
            fileId,
            logicalPath,
            role,
            contentHash: sha256Text(text),
            contentKind: "text",
            mediaType: inferCanonicalMediaType(logicalPath, "text"),
            byteSize: Buffer.byteLength(text),
            executable,
            references: [],
        },
    };
}

export function binaryFile(logicalPath: string, source: Uint8Array, fileId: string): AssetVersionFileContentV2 {
    const bytes = new Uint8Array(source);
    return {
        contentKind: "binary",
        bytes,
        file: {
            fileId,
            logicalPath,
            role: "resource",
            contentHash: sha256Bytes(bytes),
            contentKind: "binary",
            mediaType: inferCanonicalMediaType(logicalPath, "binary"),
            byteSize: bytes.byteLength,
            executable: false,
            references: [],
        },
    };
}

export function nativeText(relativePath: string, text: string, executable: boolean) {
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType: inferCanonicalMediaType(relativePath, "text"),
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable,
        text,
    };
}

export function nativeBinary(relativePath: string, source: Uint8Array, executable: boolean) {
    const bytes = new Uint8Array(source);
    return {
        relativePath,
        contentKind: "binary" as const,
        mediaType: inferCanonicalMediaType(relativePath, "binary"),
        contentHash: sha256Bytes(bytes),
        byteSize: bytes.byteLength,
        executable,
        bytes,
    };
}

export function semantic(kind: string, runtime: CodexRuntime, versionId: string, subjectKind: "asset" | "file", fileId?: string) {
    return {
        semanticRefFingerprint: sha256Text(`${kind}:${fileId ?? "asset"}`),
        consumerAgentRuntimeId: runtime,
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: fileId as string },
        semanticKind: kind,
    };
}

export function nativeInput(input: RenderAnalysisInput) {
    const candidate = input.dialectInputs[0]?.inputs[0];
    if (candidate?.inputKind !== "native_representation") throw new Error("native graph fixture missing");
    return candidate;
}

export function contentHash(content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array }) {
    return content.contentKind === "text" ? sha256Text(content.text) : sha256Bytes(content.bytes);
}

export function sha256Text(text: string): Sha256Digest {
    return sha256Bytes(new TextEncoder().encode(text));
}

export function sha256Bytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
