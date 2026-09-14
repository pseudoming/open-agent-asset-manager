import { describe, expect, it } from "vitest";
import { zcodeProvider } from "../src/zcode-provider";
import { ZCODE_SKILL_TARGET_COMPONENTS, createZcodeSkillTargetSupports } from "../src/zcode-target-skill";

const BUILD_HASH = "sha256:420a571ebd2c7fca9cdaad49bd0f3ad6dd930f13e9ae4abd35dab411793afb1a";

describe("ZCode App Skill target contracts", () => {
    it("registers project, global-config, and direct-directory contracts for both current platforms", () => {
        const projectSchema = zcodeProvider.targetContextSchemas.find(
            (row) => row.targetContextSchemaId === "ZCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
        );
        if (projectSchema === undefined) throw new Error("ZCode project target schema is missing");
        const supports = createZcodeSkillTargetSupports({
            adapterVersion: zcodeProvider.version,
            agentRuntimes: zcodeProvider.agentRuntimes,
            projectTargetContextSchemaId: projectSchema.targetContextSchemaId,
            globalTargetContextSchemaId: "ZCODE_APP_GLOBAL_WORKFLOW_TARGET_V1",
            globalDirectoryTargetContextSchemaId: "ZCODE_APP_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
        });

        expect(zcodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Skill")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                outputContractId: "ZCODE_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                outputContractId: "ZCODE_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                outputContractId: "ZCODE_NATIVE_GLOBAL_DIRECT_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
        ]);
        for (const [variant, support] of Object.entries(supports)) {
            const historical =
                variant === "globalDirectoryFolder"
                    ? []
                    : [
                          expect.objectContaining({
                              versionText: "3.1.8",
                              buildIdentity: "sha256:aaab9c07d95e1d6f2d2961db21195c4b48cfaaa159a78b15c0b04f91f8fe0d73",
                              platform: "wsl",
                          }),
                      ];
            expect(support.renderContractDeclaration).toMatchObject({
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Skill",
                buildCompatibility: {
                    versionOrdering: "numeric_dotted_core_v1",
                    unknownVersionPolicy: "allow_with_warning",
                    deniedBuilds: [],
                },
                verifiedBuilds: [
                    expect.objectContaining({ versionText: "3.5.3", buildIdentity: BUILD_HASH, platform: "wsl" }),
                    expect.objectContaining({ versionText: "3.5.3", buildIdentity: BUILD_HASH, platform: "win32" }),
                    ...historical,
                ],
            });
        }
        expect(
            zcodeProvider.dialectContracts.native
                .filter((row) => row.definition.kind === "Skill")
                .map((row) => row.definition.rebaseMaterializer),
        ).toEqual([ZCODE_SKILL_TARGET_COMPONENTS.rebase]);
    });
});
