import { describe, expect, it } from "vitest";
import { OPENCODE_DIALECT_CONTRACTS } from "../../src/opencode-dialects";
import { opencodeProvider } from "../../src/opencode-provider";
import {
    OPENCODE_APP_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
    OPENCODE_CLI_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
    OPENCODE_CLI_TARGET_BUILD_ANCHORS,
} from "../../src/opencode-target-builds";

const KINDS = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];

describe("OpenCode provider declaration", () => {
    it("declares independent CLI and Desktop entries with complete source/target matrices", () => {
        expect(opencodeProvider.agentRuntimes).toEqual([
            { agentRuntimeId: "OPENCODE_CLI", displayName: "OpenCode CLI", entryClass: "cli" },
            { agentRuntimeId: "OPENCODE_APP", displayName: "OpenCode App", entryClass: "app" },
        ]);
        for (const agentRuntimeId of ["OPENCODE_CLI", "OPENCODE_APP"]) {
            expect(
                new Set(
                    opencodeProvider.assetSourceCapabilities
                        .filter((row) => row.agentRuntimeId === agentRuntimeId)
                        .map((row) => row.assetKind),
                ),
            ).toEqual(new Set(KINDS));
            expect(
                new Set(
                    opencodeProvider.assetTargetCapabilities
                        .filter((row) => row.agentRuntimeId === agentRuntimeId)
                        .map((row) => row.assetKind),
                ),
            ).toEqual(new Set(KINDS));
            expect(
                opencodeProvider.assetTargetCapabilities.filter(
                    (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === "Workflow",
                ),
            ).toHaveLength(2);
            expect(
                opencodeProvider.assetTargetCapabilities.filter(
                    (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === "Subagent",
                ),
            ).toHaveLength(2);
        }
        expect(new Set(opencodeProvider.assetSourceCapabilities.map((row) => row.sourceCapabilityFingerprint)).size).toBe(
            opencodeProvider.assetSourceCapabilities.length,
        );
    });

    it("supports native declaration sources while leaving non-native Rule and Memory unavailable", () => {
        for (const kind of ["Guidance", "Workflow", "Skill", "Subagent"]) {
            expect(
                opencodeProvider.assetSourceCapabilities.some(
                    (row) => row.assetKind === kind && row.entrySupportStatus === "supported" && row.readPolicy === "auto_read",
                ),
            ).toBe(true);
        }
        const rules = opencodeProvider.assetSourceCapabilities.filter((row) => row.assetKind === "Rule");
        expect(rules).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                entrySupportStatus: "unsupported",
                readPolicy: "report_only",
                diagnostics: [expect.objectContaining({ code: "opencode_rule_unsupported" })],
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                entrySupportStatus: "unsupported",
                readPolicy: "report_only",
                diagnostics: [expect.objectContaining({ code: "opencode_rule_unsupported" })],
            }),
        ]);
        for (const agentRuntimeId of ["OPENCODE_CLI", "OPENCODE_APP"]) {
            for (const assetKind of ["Guidance", "Workflow", "Skill", "Subagent"]) {
                expect(
                    opencodeProvider.assetSourceCapabilities
                        .filter(
                            (row) =>
                                row.agentRuntimeId === agentRuntimeId &&
                                row.assetKind === assetKind &&
                                row.entrySupportStatus === "supported" &&
                                row.rootRole === "project_actual" &&
                                row.sourceDomain === "project_root" &&
                                row.readPolicy === "auto_read",
                        )
                        .map((row) => row.rootLocatorKind)
                        .sort(),
                ).toEqual(["project_registry_entry", "user_provided_path"]);
            }
        }
        expect(opencodeProvider.assetSourceCapabilities.filter((row) => row.assetKind === "Memory")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                entrySupportStatus: "unsupported",
                readPolicy: "report_only",
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                entrySupportStatus: "unsupported",
                readPolicy: "report_only",
            }),
        ]);
        expect(
            opencodeProvider.assetSourceCapabilities.filter(
                (row) => row.assetKind === "Guidance" && row.sourceDomain === "family_shared",
            ),
        ).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                rootRole: "config",
                sourcePathMechanism: "recursive_entry",
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                rootRole: "config",
                sourcePathMechanism: "recursive_entry",
            }),
        ]);
    });

    it("registers immutable validators for standalone and bounded config-fragment dialects", () => {
        expect(OPENCODE_DIALECT_CONTRACTS.native.map((row) => [row.definition.kind, row.definition.dialectId])).toEqual([
            ["Guidance", "opencode-guidance-markdown-v1"],
            ["Rule", "opencode-instructions-config-graph-v1"],
            ["Workflow", "opencode-command-markdown-v1"],
            ["Skill", "opencode-skill-directory-v1"],
            ["Skill", "opencode-skill-directory-v2"],
            ["Subagent", "opencode-subagent-markdown-v1"],
        ]);
        expect(OPENCODE_DIALECT_CONTRACTS.restoration).toEqual([]);
    });

    it("registers exact CLI and Desktop declaration targets and leaves Rule and Memory unavailable", () => {
        expect(opencodeProvider.assetTargetCapabilities).toHaveLength(20);
        expect(opencodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Guidance")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                entrySupportStatus: "supported",
                renderStrategy: "native_file",
                outputContractId: "OPENCODE_NATIVE_PROJECT_GUIDANCE_V1",
                targetContextSchemaId: "OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
                reverseExtractPolicy: "can_reconcile",
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                entrySupportStatus: "supported",
                renderStrategy: "native_file",
                outputContractId: "OPENCODE_APP_NATIVE_PROJECT_GUIDANCE_V1",
                targetContextSchemaId: "OPENCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
                reverseExtractPolicy: "can_reconcile",
            }),
        ]);
        expect(opencodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Workflow")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                entrySupportStatus: "supported",
                outputContractId: "OPENCODE_CLI_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1",
                reverseExtractPolicy: "can_reconcile",
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                entrySupportStatus: "supported",
                outputContractId: "OPENCODE_CLI_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1",
                reverseExtractPolicy: "can_reconcile",
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                entrySupportStatus: "supported",
                outputContractId: "OPENCODE_APP_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1",
                reverseExtractPolicy: "can_reconcile",
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                entrySupportStatus: "supported",
                outputContractId: "OPENCODE_APP_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1",
                reverseExtractPolicy: "can_reconcile",
            }),
        ]);
        expect(opencodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Skill")).toEqual([
            ...["PROJECT", "GLOBAL_CONFIG", "SHARED"].map((variant) =>
                expect.objectContaining({
                    agentRuntimeId: "OPENCODE_CLI",
                    entrySupportStatus: "supported",
                    outputContractId: `OPENCODE_CLI_NATIVE_${variant}_SKILL_DIRECTORY_V2`,
                    renderStrategy: "native_graph",
                    reverseExtractPolicy: "can_reconcile",
                }),
            ),
            ...["PROJECT", "GLOBAL_CONFIG", "SHARED"].map((variant) =>
                expect.objectContaining({
                    agentRuntimeId: "OPENCODE_APP",
                    entrySupportStatus: "supported",
                    outputContractId: `OPENCODE_APP_NATIVE_${variant}_SKILL_DIRECTORY_V1`,
                    renderStrategy: "native_graph",
                    reverseExtractPolicy: "can_reconcile",
                }),
            ),
        ]);
        expect(opencodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Subagent")).toEqual([
            ...["PROJECT", "GLOBAL"].map((variant) =>
                expect.objectContaining({
                    agentRuntimeId: "OPENCODE_CLI",
                    entrySupportStatus: "supported",
                    outputContractId: `OPENCODE_CLI_NATIVE_${variant}_SUBAGENT_MARKDOWN_V1`,
                    renderStrategy: "native_graph",
                    reverseExtractPolicy: "can_reconcile",
                }),
            ),
            ...["PROJECT", "GLOBAL"].map((variant) =>
                expect.objectContaining({
                    agentRuntimeId: "OPENCODE_APP",
                    entrySupportStatus: "supported",
                    outputContractId: `OPENCODE_APP_NATIVE_${variant}_SUBAGENT_MARKDOWN_V1`,
                    renderStrategy: "native_graph",
                    reverseExtractPolicy: "can_reconcile",
                }),
            ),
        ]);
        expect(opencodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Rule")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                entrySupportStatus: "unsupported",
                diagnostics: [expect.objectContaining({ code: "opencode_rule_unsupported" })],
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                entrySupportStatus: "unsupported",
                diagnostics: [expect.objectContaining({ code: "opencode_rule_unsupported" })],
            }),
        ]);
        expect(
            opencodeProvider.assetTargetCapabilities
                .filter((row) => row.assetKind === "Memory")
                .every((row) => row.entrySupportStatus === "unsupported"),
        ).toBe(true);
        expect(opencodeProvider.targetContextSchemas).toHaveLength(14);
        expect(opencodeProvider.materializerCapabilities).toHaveLength(16);
        expect(opencodeProvider.renderContractDeclarations).toHaveLength(16);
        expect(opencodeProvider.renderContractDeclarations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    declarationKind: "native_project_guidance_v1",
                    agentRuntimeId: "OPENCODE_CLI",
                    outputContractId: "OPENCODE_NATIVE_PROJECT_GUIDANCE_V1",
                    materializationProfileId: "opencode-cli-project-guidance-v1",
                    target: expect.objectContaining({ relativePath: "AGENTS.md" }),
                    verifiedBuilds: [
                        expect.objectContaining({
                            versionText: "1.17.11",
                            buildIdentity: "sha256:0254a429cd0e6cf0ba53fc01672cf98e4a8dc728f7fa94be88f1e4b3645e6ded",
                            platform: "wsl",
                        }),
                        ...OPENCODE_CLI_TARGET_BUILD_ANCHORS.map((build) =>
                            expect.objectContaining({
                                versionText: build.versionText,
                                buildIdentity: build.buildIdentity,
                                platform: build.platform,
                            }),
                        ),
                    ],
                }),
                expect.objectContaining({
                    declarationKind: "native_project_guidance_v1",
                    agentRuntimeId: "OPENCODE_APP",
                    outputContractId: "OPENCODE_APP_NATIVE_PROJECT_GUIDANCE_V1",
                    materializationProfileId: "opencode-app-project-guidance-v1",
                    target: expect.objectContaining({ relativePath: "AGENTS.md" }),
                    verifiedBuilds: [
                        expect.objectContaining({
                            versionText: "1.18.15",
                            buildIdentity: "sha256:c5fe1808131d04a1fba13ec237fbf675bb4951dcaa669a48da58cb20b3396c6f",
                            platform: "wsl",
                        }),
                    ],
                }),
                expect.objectContaining({
                    declarationKind: "native_project_exact_graph_v1",
                    agentRuntimeId: "OPENCODE_CLI",
                    assetKind: "Workflow",
                    nativeDialectId: "opencode-command-markdown-v1",
                    verifiedBuilds: OPENCODE_CLI_TARGET_BUILD_ANCHORS.map((build) =>
                        expect.objectContaining({ versionText: build.versionText, platform: build.platform }),
                    ),
                }),
                expect.objectContaining({
                    declarationKind: "native_project_exact_graph_v1",
                    agentRuntimeId: "OPENCODE_APP",
                    assetKind: "Skill",
                    nativeDialectId: "opencode-skill-directory-v1",
                    outputContractId: "OPENCODE_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                    verifiedBuilds: OPENCODE_APP_PROJECT_SKILL_TARGET_BUILD_ANCHORS.map((build) =>
                        expect.objectContaining({ versionText: build.versionText, platform: build.platform }),
                    ),
                }),
                expect.objectContaining({
                    declarationKind: "native_global_exact_graph_v1",
                    agentRuntimeId: "OPENCODE_APP",
                    assetKind: "Workflow",
                    nativeDialectId: "opencode-command-markdown-v1",
                    verifiedBuilds: [expect.objectContaining({ versionText: "1.18.15", platform: "wsl" })],
                }),
                expect.objectContaining({
                    declarationKind: "native_project_exact_graph_v1",
                    agentRuntimeId: "OPENCODE_CLI",
                    assetKind: "Subagent",
                    nativeDialectId: "opencode-subagent-markdown-v1",
                    outputContractId: "OPENCODE_CLI_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
                    verifiedBuilds: OPENCODE_CLI_TARGET_BUILD_ANCHORS.map((build) =>
                        expect.objectContaining({ versionText: build.versionText, platform: build.platform }),
                    ),
                }),
                expect.objectContaining({
                    declarationKind: "native_global_exact_graph_v1",
                    agentRuntimeId: "OPENCODE_APP",
                    assetKind: "Subagent",
                    nativeDialectId: "opencode-subagent-markdown-v1",
                    outputContractId: "OPENCODE_APP_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                    verifiedBuilds: [expect.objectContaining({ versionText: "1.18.15", platform: "wsl" })],
                }),
                expect.objectContaining({
                    declarationKind: "native_project_exact_graph_v1",
                    agentRuntimeId: "OPENCODE_CLI",
                    assetKind: "Skill",
                    nativeDialectId: "opencode-skill-directory-v2",
                    outputContractId: "OPENCODE_CLI_NATIVE_PROJECT_SKILL_DIRECTORY_V2",
                    verifiedBuilds: OPENCODE_CLI_PROJECT_SKILL_TARGET_BUILD_ANCHORS.map((build) =>
                        expect.objectContaining({ versionText: build.versionText, platform: build.platform }),
                    ),
                }),
                expect.objectContaining({
                    declarationKind: "native_global_exact_graph_v1",
                    agentRuntimeId: "OPENCODE_APP",
                    assetKind: "Skill",
                    nativeDialectId: "opencode-skill-directory-v1",
                    outputContractId: "OPENCODE_APP_NATIVE_SHARED_SKILL_DIRECTORY_V1",
                    verifiedBuilds: [expect.objectContaining({ versionText: "1.18.15", platform: "wsl" })],
                }),
            ]),
        );
        const cliDeclarations = opencodeProvider.renderContractDeclarations.filter(
            (declaration) => declaration.agentRuntimeId === "OPENCODE_CLI",
        );
        expect(cliDeclarations).toHaveLength(8);
        for (const declaration of cliDeclarations) {
            expect(declaration.verifiedBuilds).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        versionText: "1.18.15",
                        buildIdentity: "sha256:fd254474def7ee35f07416cf4674c361f07e7bcd9c7ffb284af21bb011066ee3",
                        platform: "win32",
                    }),
                ]),
            );
        }
    });
});
