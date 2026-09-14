import {
    type AdapterProviderSummary,
    type RenderAnalysisInput,
    resolveTargetBuildCompatibility,
    type Sha256Digest,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import { makeVerifiedNativeProjectGuidanceTargetContextForTest } from "../../../core/src/render/native-project-guidance";
import { zcodeProvider } from "../src/zcode-provider";

const HASH = `sha256:${"9".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";

function providerSummary(): AdapterProviderSummary {
    return {
        adapterId: zcodeProvider.adapterId,
        displayName: zcodeProvider.displayName,
        version: zcodeProvider.version,
        enabled: true,
        agentRuntimes: zcodeProvider.agentRuntimes,
        targetContextSchemas: zcodeProvider.targetContextSchemas,
        assetSourceCapabilities: zcodeProvider.assetSourceCapabilities,
        assetTargetCapabilities: zcodeProvider.assetTargetCapabilities,
        materializerCapabilities: zcodeProvider.materializerCapabilities,
        renderContractDeclarations: zcodeProvider.renderContractDeclarations,
    };
}

function targetContext(platform: "win32" | "wsl" = "win32", versionText = "3.5.3") {
    const declaration = zcodeProvider.renderContractDeclarations.find(
        (candidate) => candidate.declarationKind === "native_project_guidance_v1",
    );
    const build = declaration?.verifiedBuilds.find(
        (candidate) => candidate.platform === platform && candidate.versionText === versionText,
    );
    if (build === undefined) throw new Error("ZCode verified Guidance build is missing");
    return makeVerifiedNativeProjectGuidanceTargetContextForTest({ provider: providerSummary(), build });
}

function input(platform: "win32" | "wsl" = "win32", versionText = "3.5.3"): RenderAnalysisInput {
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform,
            targetContexts: [targetContext(platform, versionText)],
            assets: [
                {
                    scope: "project",
                    projectId: "44444444-4444-4444-8444-444444444444",
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId: VERSION_ID },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
                        files: [
                            {
                                contentKind: "text",
                                text: "# Project guidance\n",
                                file: {
                                    fileId: FILE_ID,
                                    logicalPath: "AGENTS.md",
                                    role: "entry",
                                    contentHash: HASH,
                                    contentKind: "text",
                                    mediaType: "text/markdown",
                                    byteSize: 19,
                                    executable: false,
                                    references: [],
                                },
                            },
                        ],
                    },
                    sectionHandles: { [FILE_ID]: "guidance-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            {
                semanticRefFingerprint: `sha256:${"1".repeat(64)}`,
                consumerAgentRuntimeId: "ZCODE_APP",
                subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                semanticKind: "asset.file_inventory",
            },
            {
                semanticRefFingerprint: `sha256:${"2".repeat(64)}`,
                consumerAgentRuntimeId: "ZCODE_APP",
                subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                semanticKind: "guidance.base_context",
            },
            {
                semanticRefFingerprint: `sha256:${"3".repeat(64)}`,
                consumerAgentRuntimeId: "ZCODE_APP",
                subject: { subjectKind: "file", assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID },
                semanticKind: "guidance.content",
            },
        ],
        dialectInputs: [],
    };
}

function firstAsset(value: RenderAnalysisInput): RenderAnalysisInput["deployment"]["assets"][number] {
    const asset = value.deployment.assets[0];
    if (asset === undefined) throw new Error("ZCode Guidance target fixture has no Asset");
    return asset;
}

function firstFile(value: RenderAnalysisInput): RenderAnalysisInput["deployment"]["assets"][number]["version"]["files"][number] {
    const file = firstAsset(value).version.files[0];
    if (file === undefined) throw new Error("ZCode Guidance target fixture has no entry file");
    return file;
}

describe("ZCode App exact project Guidance target", () => {
    it("binds the current shared consumer digest to separate exact Win32 and WSL platform facts", async () => {
        const win32 = targetContext("win32");
        const wsl = targetContext("wsl");

        expect(win32.buildIdentity).toBe(wsl.buildIdentity);
        expect(win32.versionText).toBe(wsl.versionText);
        expect(win32.renderFacts).toEqual([
            { key: "oaam.platform", value: "win32", evidenceLevel: "agent_runtime_verified" },
            { key: "oaam.project-binding", value: "registered", evidenceLevel: "agent_runtime_verified" },
        ]);
        expect(wsl.renderFacts).toEqual([
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
            { key: "oaam.project-binding", value: "registered", evidenceLevel: "agent_runtime_verified" },
        ]);
        await expect(zcodeProvider.analyzeRender(input("win32"))).resolves.toMatchObject({ status: "complete" });
        await expect(zcodeProvider.analyzeRender(input("wsl"))).resolves.toMatchObject({ status: "complete" });
    });

    it("retains the historical App-version anchor and warns on an accepted newer build", async () => {
        await expect(zcodeProvider.analyzeRender(input("wsl", "3.1.8"))).resolves.toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        expect(targetContext("win32", "3.3.5")).toMatchObject({
            versionText: "3.3.5",
            buildIdentity: "sha256:15fd526de795655faf302ba3f0427d6eedf5f3eca78927266580c48c7820cc10",
        });
        const candidate = input();
        const context = candidate.deployment.targetContexts[0];
        if (context === undefined) throw new Error("ZCode target context is missing");
        context.versionText = "3.5.4";
        context.buildIdentity = `sha256:${"8".repeat(64)}`;

        await expect(zcodeProvider.analyzeRender(candidate)).resolves.toMatchObject({
            status: "complete",
            diagnostics: [
                {
                    code: "zcode_target_build_compatibility_inferred",
                    causeKind: "partial",
                    severity: "warning",
                },
            ],
        });
    });

    it("does not infer compatibility for an App older than the earliest exact anchor", () => {
        const declaration = zcodeProvider.renderContractDeclarations.find(
            (candidate) => candidate.declarationKind === "native_project_guidance_v1",
        );
        if (declaration === undefined) throw new Error("ZCode Guidance declaration is missing");
        expect(
            resolveTargetBuildCompatibility({
                anchors: declaration.verifiedBuilds,
                policy: declaration.buildCompatibility,
                current: {
                    agentRuntimeId: "ZCODE_APP",
                    versionText: "3.3.4",
                    buildIdentity: `sha256:${"7".repeat(64)}`,
                    platform: "win32",
                },
            }),
        ).toEqual({
            status: "blocked",
            reason: "older_than_earliest_anchor",
        });
    });

    it("claims one AGENTS.md output and preserves the complete Guidance semantic closure", async () => {
        const result = await zcodeProvider.analyzeRender(input());

        expect(result).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(result.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId: "ZCODE_NATIVE_PROJECT_GUIDANCE_V1",
                claims: [{ relativePath: "AGENTS.md", contentKind: "text", executable: false }],
                managedDirectoryBoundaries: [],
            }),
        ]);
        expect(result.semanticOptions).toHaveLength(3);
        expect(result.semanticOptions.every((option) => option.outcome === "preserved")).toBe(true);
        expect(result.semanticOptions.every((option) => option.renderStrategy === "native_file")).toBe(true);
        expect(result.semanticOptions.every((option) => option.actualReverseExtractPolicy === "can_reconcile")).toBe(true);
    });

    it.each([
        ["global scope", (value: RenderAnalysisInput) => (firstAsset(value).scope = "global")],
        ["nested scope", (value: RenderAnalysisInput) => (firstAsset(value).scopePath = "nested")],
        ["incomplete version", (value: RenderAnalysisInput) => (firstAsset(value).version.status = "incomplete")],
        ["executable entry", (value: RenderAnalysisInput) => (firstFile(value).file.executable = true)],
        ["extra file", (value: RenderAnalysisInput) => firstAsset(value).version.files.push({} as never)],
    ])("blocks %s instead of silently degrading it", async (_label, mutate) => {
        const candidate = structuredClone(input());
        mutate(candidate);

        const result = await zcodeProvider.analyzeRender(candidate);

        expect(result).toMatchObject({ status: "failed", outputUnits: [], semanticOptions: [] });
        expect(result.blockedSemanticRefs).toHaveLength(3);
        expect(result.blockedSemanticRefs.every((item) => item.reasonCode === "project_guidance_target_not_applicable")).toBe(
            true,
        );
    });
});
