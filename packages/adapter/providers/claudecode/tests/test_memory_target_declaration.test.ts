/** Exact Claude Code CLI Memory Unit and Catalog target declarations. */

import { describe, expect, it } from "vitest";
import { claudecodeProvider } from "../src/claudecode-provider";

describe("Claude Code Memory target declaration", () => {
    it("owns exact CLI topic and Catalog targets, restoration dialect, and verified builds", () => {
        expect(
            claudecodeProvider.assetTargetCapabilities.filter(
                (row) =>
                    row.agentRuntimeId === "CLAUDE_CODE_CLI" &&
                    row.assetKind === "Memory" &&
                    row.entrySupportStatus === "supported",
            ),
        ).toEqual([
            expect.objectContaining({
                outputContractId: "CLAUDECODE_NATIVE_PROJECT_MEMORY_TOPIC_V1",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                diagnostics: [],
            }),
            expect.objectContaining({
                outputContractId: "CLAUDECODE_NATIVE_PROJECT_MEMORY_CATALOG_V1",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                diagnostics: [],
            }),
        ]);
        expect(
            claudecodeProvider.targetContextSchemas.filter(
                (schema) => schema.targetContextSchemaId === "CLAUDE_CODE_CLI_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
            ),
        ).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CLAUDE_CODE_CLI",
                factRules: expect.arrayContaining([
                    expect.objectContaining({ key: "oaam.project-binding" }),
                    expect.objectContaining({ key: "oaam.target-kind" }),
                ]),
            }),
        ]);
        expect(
            claudecodeProvider.materializerCapabilities.filter(
                (capability) =>
                    capability.outputContractId === "CLAUDECODE_NATIVE_PROJECT_MEMORY_TOPIC_V1" ||
                    capability.outputContractId === "CLAUDECODE_NATIVE_PROJECT_MEMORY_CATALOG_V1",
            ),
        ).toEqual([
            expect.objectContaining({
                materializationProfileIds: ["claude-code-cli-project-memory-topic-v1"],
            }),
            expect.objectContaining({
                materializationProfileIds: ["claude-code-cli-project-memory-catalog-v1"],
            }),
        ]);
        expect(
            claudecodeProvider.renderContractDeclarations.filter(
                (declaration) =>
                    declaration.outputContractId === "CLAUDECODE_NATIVE_PROJECT_MEMORY_TOPIC_V1" ||
                    declaration.outputContractId === "CLAUDECODE_NATIVE_PROJECT_MEMORY_CATALOG_V1",
            ),
        ).toEqual([
            expect.objectContaining({
                declarationKind: "native_project_exact_file_v1",
                assetKind: "Memory",
                nativeDialectId: "claudecode-memory-topic-v1",
                restorationDialectIds: ["claudecode-memory-topic-v1"],
                target: {
                    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
                    requiredFacts: {
                        "oaam.project-binding": "registered",
                        "oaam.target-kind": "directory",
                    },
                },
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "2.1.220",
                        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
                        platform: "wsl",
                    }),
                ],
            }),
            expect.objectContaining({
                declarationKind: "native_project_exact_file_v1",
                assetKind: "Memory",
                nativeDialectId: "claudecode-memory-catalog-v1",
                restorationDialectIds: [],
                target: {
                    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
                    requiredFacts: {
                        "oaam.project-binding": "registered",
                        "oaam.target-kind": "directory",
                    },
                },
                verifiedBuilds: [expect.objectContaining({ versionText: "2.1.220", platform: "wsl" })],
            }),
        ]);
        expect(
            claudecodeProvider.dialectContracts.native
                .filter((contract) => contract.definition.kind === "Memory")
                .map((contract) => contract.definition.dialectId),
        ).toEqual(["claudecode-memory-catalog-v1", "claudecode-memory-topic-v1"]);
        expect(
            claudecodeProvider.dialectContracts.restoration.filter(
                (contract) => contract.definition.dialectId === "claudecode-memory-topic-v1",
            ),
        ).toEqual([
            expect.objectContaining({
                definition: expect.objectContaining({ kind: "Memory", dialectId: "claudecode-memory-topic-v1" }),
            }),
        ]);
        expect(
            claudecodeProvider.dialectContracts.native
                .filter(
                    (contract) =>
                        contract.definition.dialectId === "claudecode-memory-topic-v1" ||
                        contract.definition.dialectId === "claudecode-memory-catalog-v1",
                )
                .map((contract) => contract.definition.rebaseMaterializer?.componentId ?? null),
        ).toEqual(["claudecode.project-memory-catalog-parent-rebase-v1", "claudecode.project-memory-topic-parent-rebase-v1"]);
        const catalogDeclaration = claudecodeProvider.renderContractDeclarations.find(
            (declaration) =>
                declaration.declarationKind === "native_project_exact_file_v1" &&
                declaration.nativeDialectId === "claudecode-memory-catalog-v1",
        );
        const catalogDialect = claudecodeProvider.dialectContracts.native.find(
            (contract) => contract.definition.dialectId === "claudecode-memory-catalog-v1",
        );
        expect(catalogDeclaration?.reverseParser).toEqual(catalogDialect?.definition.nativeToCanonicalParser);
    });

    it("owns distinct exact App topic and Catalog contracts without borrowing the CLI build", () => {
        expect(
            claudecodeProvider.assetTargetCapabilities.filter(
                (row) =>
                    row.agentRuntimeId === "CLAUDE_CODE_APP" &&
                    row.assetKind === "Memory" &&
                    row.entrySupportStatus === "supported",
            ),
        ).toEqual([
            expect.objectContaining({
                outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_TOPIC_V1",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                diagnostics: [],
            }),
            expect.objectContaining({
                outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_CATALOG_V1",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                diagnostics: [],
            }),
        ]);
        expect(
            claudecodeProvider.targetContextSchemas.filter(
                (schema) => schema.targetContextSchemaId === "CLAUDE_CODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
            ),
        ).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CLAUDE_CODE_APP",
                factRules: expect.arrayContaining([
                    expect.objectContaining({ key: "oaam.project-binding" }),
                    expect.objectContaining({ key: "oaam.target-kind" }),
                ]),
            }),
        ]);
        expect(
            claudecodeProvider.renderContractDeclarations.filter(
                (declaration) =>
                    declaration.outputContractId === "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_TOPIC_V1" ||
                    declaration.outputContractId === "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_CATALOG_V1",
            ),
        ).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CLAUDE_CODE_APP",
                nativeDialectId: "claudecode-memory-topic-v1",
                materializationProfileId: "claude-code-app-project-memory-topic-v1",
                target: expect.objectContaining({
                    targetContextSchemaId: "CLAUDE_CODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
                }),
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "2.1.219",
                        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                        platform: "win32",
                    }),
                ],
            }),
            expect.objectContaining({
                agentRuntimeId: "CLAUDE_CODE_APP",
                nativeDialectId: "claudecode-memory-catalog-v1",
                materializationProfileId: "claude-code-app-project-memory-catalog-v1",
                target: expect.objectContaining({
                    targetContextSchemaId: "CLAUDE_CODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
                }),
                verifiedBuilds: [expect.objectContaining({ versionText: "2.1.219", platform: "win32" })],
            }),
        ]);
    });
});
