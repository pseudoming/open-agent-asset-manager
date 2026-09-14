import * as crypto from "node:crypto";
import type {
    AssetKindTypeDataV2,
    AssetVersionFileContentV2,
    MaterializedRenderFile,
    RenderAnalysisInput,
    RenderedTargetInspectionInput,
    RenderMaterializationInput,
    RenderNativeRepresentationFileInput,
    Sha256Digest,
} from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core";
import { makeNativeProjectExactGraphContractParts } from "../../../../core/src/render/native-project-exact-graph";
import { opencodeProvider } from "../src/opencode-provider";
import { OPENCODE_NATIVE_DIALECTS } from "../src/opencode-source-read-model";
import { validateOpencodeNativeDialect } from "../src/opencode-source-read-native";
import {
    OPENCODE_CLI_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
    OPENCODE_CLI_TARGET_BUILD_ANCHORS,
} from "../src/opencode-target-builds";
import { createOpencodeSkillTargetSupports } from "../src/opencode-target-skill";

export type SkillVariant = "project_folder" | "global_config_folder" | "shared_directory_folder";

export const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
export const BUILD_HASH = "sha256:c1971d3d4d42abe8e15b2e320ecc1acbdb8377914d4e2cfa47c9bce2316caa7d";
export const ASSET_ID = "11111111-1111-4111-8111-111111111111";
export const VERSION_ID = "22222222-2222-4222-8222-222222222222";
export const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
export const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
export const ENTRY_BODY = "Use the bundled resources. OAAM_OPENCODE_SKILL_GRAPH_41A7D2\n";
export const CHANGED_ENTRY_BODY = ENTRY_BODY.replace("41A7D2", "99C4E1");
export const SCRIPT = "print('OAAM_OPENCODE_RESOURCE_V1')\n";
export const CHANGED_SCRIPT = "print('OAAM_OPENCODE_RESOURCE_V2')\n";
export const REFERENCE = "OAAM_OPENCODE_REFERENCE_V1\n";
export const CHANGED_REFERENCE = "OAAM_OPENCODE_REFERENCE_V2\n";
export const BINARY = Uint8Array.of(0, 255, 1, 2);
export const CHANGED_BINARY = Uint8Array.of(0, 255, 4, 5);

export const supports = createOpencodeSkillTargetSupports({
    adapterVersion: opencodeProvider.version,
    agentRuntimes: opencodeProvider.agentRuntimes,
    agentRuntimeId: "OPENCODE_CLI",
    runtimeSlug: "cli",
    targetBuilds: OPENCODE_CLI_TARGET_BUILD_ANCHORS,
    projectTargetBuilds: OPENCODE_CLI_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
    projectTargetContextSchemaId: "OPENCODE_CLI_PROJECT_SKILL_TARGET_V1",
    globalTargetContextSchemaId: "OPENCODE_CLI_GLOBAL_CONFIG_SKILL_TARGET_V1",
    sharedDirectoryTargetContextSchemaId: "OPENCODE_CLI_SHARED_SKILL_DIRECTORY_TARGET_V1",
});

export const VARIANTS: readonly SkillVariant[] = ["project_folder", "global_config_folder", "shared_directory_folder"];

export function supportFor(variant: SkillVariant) {
    if (variant === "project_folder") return supports.projectFolder;
    return variant === "global_config_folder" ? supports.globalConfigFolder : supports.sharedDirectoryFolder;
}

export function bindExactBuild(fixture: RenderAnalysisInput, variant: SkillVariant, versionText: string): void {
    const build = supportFor(variant).renderContractDeclaration.verifiedBuilds.find(
        (candidate) => candidate.platform === "wsl" && candidate.versionText === versionText,
    );
    const context = fixture.deployment.targetContexts[0];
    if (build === undefined || context === undefined) throw new Error(`Skill ${versionText} verified build is missing`);
    context.versionText = build.versionText;
    context.buildIdentity = build.buildIdentity;
}

export function analysisFixture(
    variant: SkillVariant,
    inputRole: "current_exact" | "parent_rebase_seed",
    files: AssetVersionFileContentV2[],
): RenderAnalysisInput {
    const support = supportFor(variant);
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const baseFiles = inputRole === "current_exact" ? files : canonicalFiles(variant);
    const nativeFiles = nativeFilesFor(baseFiles, variant);
    const native = {
        inputKind: "native_representation" as const,
        inputRole: "current_exact" as const,
        representation: {
            schemaVersion: 1 as const,
            dialectId: OPENCODE_NATIVE_DIALECTS.skillCli,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: nativeFiles,
    };
    return baseAnalysisFixture(
        variant,
        versionId,
        files,
        [
            inputRole === "current_exact"
                ? native
                : {
                      ...native,
                      inputRole: "parent_rebase_seed" as const,
                      sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                  },
        ],
        support,
    );
}

export function canonicalMaterializationFixture(variant: SkillVariant): RenderAnalysisInput {
    const support = supportFor(variant);
    const declaration = support.renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("canonical Skill materializer is missing");
    return baseAnalysisFixture(
        variant,
        VERSION_ID,
        canonicalFiles(variant),
        [
            {
                inputKind: "canonical_materialization",
                nativeDialectId: OPENCODE_NATIVE_DIALECTS.skillCli,
                materializer: declaration.materializer,
                degradationKinds: [],
                reasonCode: declaration.reasonCode,
            },
        ],
        support,
    );
}

export function baseAnalysisFixture(
    variant: SkillVariant,
    versionId: string,
    files: AssetVersionFileContentV2[],
    inputs: RenderAnalysisInput["dialectInputs"][number]["inputs"],
    support: ReturnType<typeof supportFor>,
): RenderAnalysisInput {
    const scope = variant === "project_folder" ? ("project" as const) : ("global" as const);
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "wsl",
            platformInstanceId: "test-wsl",
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: "OPENCODE_CLI",
                    versionText: "1.18.15",
                    buildIdentity: BUILD_HASH,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                        ...(scope === "project"
                            ? [
                                  {
                                      key: "oaam.project-binding",
                                      value: "registered",
                                      evidenceLevel: "agent_runtime_verified" as const,
                                  },
                              ]
                            : [
                                  {
                                      key: "oaam.target-kind",
                                      value: variant === "global_config_folder" ? "global" : "directory",
                                      evidenceLevel: "agent_runtime_verified" as const,
                                  },
                              ]),
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [
                {
                    scope,
                    projectId: scope === "project" ? PROJECT_ID : "",
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: skillCanonical(skillName(variant)),
                        files: structuredClone(files),
                    },
                    sectionHandles: Object.fromEntries(files.map((file) => [file.file.fileId, `skill-${file.file.logicalPath}`])),
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", versionId, "asset"),
            semantic("skill.discovery_metadata", versionId, "asset"),
            ...files.map((file) =>
                semantic(file.file.role === "entry" ? "skill.body" : "skill.resource", versionId, "file", file.file.fileId),
            ),
        ] as RenderAnalysisInput["requiredSemantics"],
        dialectInputs: [{ targetVersion: { assetId: ASSET_ID, versionId }, consumerAgentRuntimeIds: ["OPENCODE_CLI"], inputs }],
    };
}

export function materializationInput(fixture: RenderAnalysisInput, variant: SkillVariant): RenderMaterializationInput {
    const support = supportFor(variant);
    const analysis = support.analyze(fixture);
    if (analysis.status !== "complete") throw new Error("Skill graph analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Skill graph materialization profile is missing");
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
                rendererAdapterId: "OPENCODE",
                rendererAdapterVersion: opencodeProvider.version,
                materializerCapabilityKey: support.materializerCapability.materializerCapabilityKey,
                materializationProfileId: support.renderContractDeclaration.materializationProfileId,
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
    if (unit === undefined) throw new Error("Skill graph output unit is missing");
    const baseCanonical = canonicalFiles(variant);
    const changedCanonical = changedCanonicalFiles(variant);
    const applied = nativeFilesFor(baseCanonical, variant);
    const current = nativeFilesFor(changedCanonical, variant);
    const files = applied.map((appliedFile) => {
        const currentFile = current.find((file) => file.relativePath === appliedFile.relativePath);
        if (currentFile === undefined || currentFile.contentKind !== appliedFile.contentKind) throw new Error("graph mismatch");
        const fileId = baseCanonical.find(
            (file) => `${skillBoundary(variant)}/${file.file.logicalPath}` === appliedFile.relativePath,
        )?.file.fileId;
        if (fileId === undefined) throw new Error("canonical graph mismatch");
        const appliedContent = fileContent(appliedFile);
        const currentContent = fileContent(currentFile);
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
            attributeChanges:
                appliedFile.executable === currentFile.executable
                    ? []
                    : [
                          {
                              attributeChangeFingerprint: sha256Text(`${appliedFile.relativePath}:executable`),
                              attributeKind: "executable" as const,
                              appliedValue: appliedFile.executable,
                              currentValue: currentFile.executable,
                          },
                      ],
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
                consumerOwnerAdapterId: "OPENCODE",
                consumerOwnerAdapterVersion: opencodeProvider.version,
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
                    boundary: { relativePath: skillBoundary(variant), boundaryKind: "directory_inventory" },
                    currentDescendantPaths: current.map((file) => file.relativePath),
                },
            ],
        },
        files,
        inventoryDeltas: [],
    };
}

export function canonicalFiles(_variant: SkillVariant): AssetVersionFileContentV2[] {
    return [
        textFile("SKILL.md", ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false),
        binaryFile("assets/marker.bin", BINARY, "22222222-2222-4222-8222-222222222223"),
        textFile("references/marker.txt", REFERENCE, "33333333-3333-4333-8333-333333333333", "resource", false),
        textFile("scripts/marker.py", SCRIPT, "44444444-4444-4444-8444-444444444444", "resource", false),
    ];
}

export function changedCanonicalFiles(_variant: SkillVariant): AssetVersionFileContentV2[] {
    return [
        textFile("SKILL.md", CHANGED_ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false),
        binaryFile("assets/marker.bin", CHANGED_BINARY, "22222222-2222-4222-8222-222222222223"),
        textFile("references/marker.txt", CHANGED_REFERENCE, "33333333-3333-4333-8333-333333333333", "resource", false),
        textFile("scripts/marker.py", CHANGED_SCRIPT, "44444444-4444-4444-8444-444444444444", "resource", true),
    ];
}

export function nativeFilesFor(files: AssetVersionFileContentV2[], variant: SkillVariant) {
    const prefix = skillHeader(variant);
    return files
        .map((file) => {
            const relativePath = `${skillBoundary(variant)}/${file.file.logicalPath}`;
            if (file.contentKind === "binary") return nativeBinary(relativePath, file.bytes, file.file.executable);
            return nativeText(
                relativePath,
                file.file.role === "entry" ? `${prefix}${file.text}` : file.text,
                file.file.executable,
            );
        })
        .sort((left, right) => compareText(left.relativePath, right.relativePath));
}

export function skillBoundary(variant: SkillVariant): string {
    if (variant === "global_config_folder") return "skills/oaam-phase57-global-config-skill";
    if (variant === "shared_directory_folder") return "oaam-phase57-shared-skill";
    return ".agents/skills/oaam-phase57-project-skill";
}

export function skillName(variant: SkillVariant): string {
    if (variant === "global_config_folder") return "oaam-phase57-global-config-skill";
    if (variant === "shared_directory_folder") return "oaam-phase57-shared-skill";
    return "oaam-phase57-project-skill";
}

export function canonicalEntryPattern(variant: SkillVariant): RegExp {
    if (variant === "global_config_folder") return /^skills\/oaam-skill-11111111\/SKILL\.md$/;
    if (variant === "shared_directory_folder") return /^oaam-skill-11111111\/SKILL\.md$/;
    return /^\.opencode\/skills\/oaam-skill-11111111\/SKILL\.md$/;
}

export function skillHeader(variant: SkillVariant): string {
    return `${[
        "---",
        "# preserve OpenCode Skill layout",
        `name: ${skillName(variant)}`,
        "description: OAAM OpenCode graph Skill",
        "slash: true",
        "license: MIT",
        "compatibility: OpenCode",
        "metadata:",
        "  owner: oaam",
        "---",
    ].join("\n")}\n`;
}

export function skillCanonical(name: string): Extract<AssetKindTypeDataV2, { kind: "Skill" }> {
    return {
        kind: "Skill",
        typeData: {
            schemaVersion: 2,
            name,
            description: "OAAM OpenCode graph Skill",
            whenToUse: "",
            entryDialectId: "opencode-skill-markdown-v2",
            portableMetadata: { license: "MIT", compatibility: "OpenCode", metadata: { owner: "oaam" } },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "direct", commandName: name },
                model: { mode: "model_decision" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
        },
    };
}

export function validateNative(
    files: AssetVersionFileContentV2[],
    nativeFiles: ReturnType<typeof nativeFilesFor>,
    variant: SkillVariant,
): boolean {
    return validateOpencodeNativeDialect({
        canonical: skillCanonical(skillName(variant)),
        canonicalFiles: files,
        representation: {
            schemaVersion: 1,
            dialectId: OPENCODE_NATIVE_DIALECTS.skillCli,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: nativeFiles.map(nativeDescriptor),
        },
        nativeFiles: nativeFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes: file.contentKind === "text" ? new TextEncoder().encode(file.text) : new Uint8Array(file.bytes),
        })),
    });
}

export function validateMaterializedNative(
    files: AssetVersionFileContentV2[],
    nativeFiles: MaterializedRenderFile[],
    variant: SkillVariant,
): boolean {
    const descriptors = nativeFiles.map((nativeFile) => {
        const canonical = files.find((file) => nativeFile.relativePath.endsWith(`/${file.file.logicalPath}`));
        if (canonical === undefined || canonical.contentKind !== nativeFile.content.contentKind) {
            throw new Error(`materialized Skill file ${nativeFile.relativePath} has no canonical owner`);
        }
        const bytes =
            nativeFile.content.contentKind === "text"
                ? new TextEncoder().encode(nativeFile.content.text)
                : new Uint8Array(nativeFile.content.bytes);
        return {
            relativePath: nativeFile.relativePath,
            contentKind: nativeFile.content.contentKind,
            mediaType: canonical.file.mediaType,
            contentHash: sha256Bytes(bytes),
            byteSize: bytes.byteLength,
            executable: nativeFile.executable,
        };
    });
    return validateOpencodeNativeDialect({
        canonical: skillCanonical(skillName(variant)),
        canonicalFiles: files,
        representation: {
            schemaVersion: 1,
            dialectId: OPENCODE_NATIVE_DIALECTS.skillCli,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: descriptors,
        },
        nativeFiles: nativeFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes:
                file.content.contentKind === "text"
                    ? new TextEncoder().encode(file.content.text)
                    : new Uint8Array(file.content.bytes),
        })),
    });
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

export function nativeDescriptor(file: RenderNativeRepresentationFileInput) {
    const { text: _text, bytes: _bytes, ...descriptor } = file as typeof file & { text?: string; bytes?: Uint8Array };
    return descriptor;
}

export function nativeInput(input: RenderAnalysisInput) {
    const candidate = input.dialectInputs[0]?.inputs[0];
    if (candidate?.inputKind !== "native_representation") throw new Error("native graph fixture is missing");
    return candidate;
}

export function fileContent(file: ReturnType<typeof nativeText> | ReturnType<typeof nativeBinary>) {
    return file.contentKind === "text"
        ? { contentKind: "text" as const, text: file.text }
        : { contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) };
}

export function semantic(kind: string, versionId: string, subjectKind: "asset" | "file", fileId?: string) {
    return {
        semanticRefFingerprint: sha256Text(`${kind}:${fileId ?? "asset"}`),
        consumerAgentRuntimeId: "OPENCODE_CLI" as const,
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: fileId as string },
        semanticKind: kind,
    };
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

export function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
