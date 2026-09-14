import { describe, expect, it } from "vitest";
import { opencodeProvider } from "../src/opencode-provider";
import {
    OPENCODE_CLI_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
    OPENCODE_CLI_TARGET_BUILD_ANCHORS,
} from "../src/opencode-target-builds";
import {
    createOpencodeSkillTargetSupports,
    OPENCODE_SKILL_TARGET_COMPONENTS,
    OPENCODE_CLI_SKILL_TARGET_COMPONENTS,
} from "../src/opencode-target-skill";

const BUILD_HASH = "sha256:c1971d3d4d42abe8e15b2e320ecc1acbdb8377914d4e2cfa47c9bce2316caa7d";

const supports = createOpencodeSkillTargetSupports({
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

describe("OpenCode CLI Skill target declarations", () => {
    it("keeps historical evidence scoped to the project Skill contract", () => {
        expect(
            opencodeProvider.assetTargetCapabilities.filter(
                (row) => row.assetKind === "Skill" && row.agentRuntimeId === "OPENCODE_CLI",
            ),
        ).toEqual([
            expect.objectContaining({
                outputContractId: "OPENCODE_CLI_NATIVE_PROJECT_SKILL_DIRECTORY_V2",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                outputContractId: "OPENCODE_CLI_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V2",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                outputContractId: "OPENCODE_CLI_NATIVE_SHARED_SKILL_DIRECTORY_V2",
                renderStrategy: "native_graph",
            }),
        ]);
        for (const [variant, support] of Object.entries(supports)) {
            const historical =
                variant === "projectFolder"
                    ? [
                          expect.objectContaining({
                              versionText: "1.17.11",
                              buildIdentity: "sha256:0254a429cd0e6cf0ba53fc01672cf98e4a8dc728f7fa94be88f1e4b3645e6ded",
                              platform: "wsl",
                          }),
                      ]
                    : [];
            expect(support.renderContractDeclaration).toMatchObject({
                agentRuntimeId: "OPENCODE_CLI",
                assetKind: "Skill",
                buildCompatibility: {
                    versionOrdering: "numeric_dotted_core_v1",
                    unknownVersionPolicy: "allow_with_warning",
                    deniedBuilds: [],
                },
                verifiedBuilds: [
                    expect.objectContaining({ versionText: "1.18.15", buildIdentity: BUILD_HASH, platform: "wsl" }),
                    expect.objectContaining({
                        versionText: "1.18.15",
                        buildIdentity: "sha256:fd254474def7ee35f07416cf4674c361f07e7bcd9c7ffb284af21bb011066ee3",
                        platform: "win32",
                    }),
                    ...historical,
                ],
            });
        }
        expect(
            opencodeProvider.dialectContracts.native
                .filter((row) => row.definition.kind === "Skill")
                .map((row) => row.definition.rebaseMaterializer),
        ).toEqual([OPENCODE_SKILL_TARGET_COMPONENTS.rebase, OPENCODE_CLI_SKILL_TARGET_COMPONENTS.rebase]);
    });
});
