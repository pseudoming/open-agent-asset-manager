import {
    isAdapterFrameworkProvider,
    isAdapterFrameworkReadHandler,
    isAdapterFrameworkTargetHandler,
} from "@oaam/adapter-framework";
import { describe, expect, it } from "vitest";
import { cursorProvider } from "../src/cursor-provider";
import {
    CURSOR_SUBAGENT_MODEL_DIALECT,
    CURSOR_SUBAGENT_PERMISSION_DIALECT,
    CURSOR_SUBAGENT_TOOL_DIALECT,
} from "../src/cursor-subagent-markdown";
import { CURSOR_RULE_TARGET_COMPONENTS } from "../src/cursor-target-rule";
import { CURSOR_SKILL_TARGET_COMPONENTS } from "../src/cursor-target-skill";
import { CURSOR_SUBAGENT_TARGET_COMPONENTS } from "../src/cursor-target-subagent";
import { CURSOR_WORKFLOW_TARGET_COMPONENTS } from "../src/cursor-target-workflow";

describe("Cursor Provider declaration", () => {
    it("is framework-owned, frozen, and exhaustive across two independent runtime entries", () => {
        expect(isAdapterFrameworkProvider(cursorProvider)).toBe(true);
        expect(isAdapterFrameworkReadHandler(cursorProvider.read)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(cursorProvider.analyzeRender)).toBe(true);
        expect(Object.isFrozen(cursorProvider)).toBe(true);
        expect(cursorProvider.agentRuntimes).toEqual([
            { agentRuntimeId: "CURSOR_AGENT_CLI", displayName: "Cursor Agent CLI", entryClass: "cli" },
            { agentRuntimeId: "CURSOR_APP", displayName: "Cursor App", entryClass: "app" },
        ]);
        expect(cursorProvider.assetSourceCapabilities).toHaveLength(18);
        expect(cursorProvider.assetTargetCapabilities).toHaveLength(18);
        expect(cursorProvider.dialectContracts.portableEntries).toHaveLength(3);
        expect(cursorProvider.dialectContracts.portableSelectors).toHaveLength(3);
        expect(new Set(cursorProvider.materializerCapabilities.map((row) => row.materializerCapabilityKey)).size).toBe(
            cursorProvider.materializerCapabilities.length,
        );
    });

    it("supports independently verified CLI/App declaration lifecycles while keeping Memory precise", () => {
        const supportedSources = cursorProvider.assetSourceCapabilities
            .filter((row) => row.entrySupportStatus === "supported")
            .map((row) => `${row.agentRuntimeId}/${row.assetKind}/${row.rootRole}`)
            .sort();
        const supportedTargets = cursorProvider.assetTargetCapabilities
            .filter((row) => row.entrySupportStatus === "supported")
            .map((row) => `${row.agentRuntimeId}/${row.assetKind}/${row.targetContextSchemaId}`)
            .sort();
        expect(supportedSources).toEqual([
            "CURSOR_AGENT_CLI/Guidance/project_actual",
            "CURSOR_AGENT_CLI/Rule/project_actual",
            "CURSOR_AGENT_CLI/Skill/config",
            "CURSOR_AGENT_CLI/Skill/project_actual",
            "CURSOR_AGENT_CLI/Skill/source",
            "CURSOR_AGENT_CLI/Subagent/project_actual",
            "CURSOR_AGENT_CLI/Workflow/config",
            "CURSOR_AGENT_CLI/Workflow/project_actual",
            "CURSOR_APP/Guidance/project_actual",
            "CURSOR_APP/Memory/source",
            "CURSOR_APP/Rule/project_actual",
            "CURSOR_APP/Skill/config",
            "CURSOR_APP/Skill/project_actual",
            "CURSOR_APP/Skill/source",
            "CURSOR_APP/Subagent/project_actual",
            "CURSOR_APP/Workflow/config",
            "CURSOR_APP/Workflow/project_actual",
        ]);
        expect(supportedTargets).toEqual([
            "CURSOR_AGENT_CLI/Guidance/CURSOR_AGENT_CLI_PROJECT_TARGET_V1",
            "CURSOR_AGENT_CLI/Rule/CURSOR_AGENT_CLI_PROJECT_TARGET_V1",
            "CURSOR_AGENT_CLI/Skill/CURSOR_AGENT_CLI_GLOBAL_SHARED_SKILL_TARGET_V1",
            "CURSOR_AGENT_CLI/Skill/CURSOR_AGENT_CLI_GLOBAL_WORKFLOW_TARGET_V1",
            "CURSOR_AGENT_CLI/Skill/CURSOR_AGENT_CLI_PROJECT_TARGET_V1",
            "CURSOR_AGENT_CLI/Subagent/CURSOR_AGENT_CLI_PROJECT_TARGET_V1",
            "CURSOR_AGENT_CLI/Workflow/CURSOR_AGENT_CLI_GLOBAL_WORKFLOW_TARGET_V1",
            "CURSOR_AGENT_CLI/Workflow/CURSOR_AGENT_CLI_PROJECT_TARGET_V1",
            "CURSOR_APP/Guidance/CURSOR_APP_PROJECT_TARGET_V1",
            "CURSOR_APP/Rule/CURSOR_APP_PROJECT_TARGET_V1",
            "CURSOR_APP/Skill/CURSOR_APP_GLOBAL_SHARED_SKILL_TARGET_V1",
            "CURSOR_APP/Skill/CURSOR_APP_GLOBAL_WORKFLOW_TARGET_V1",
            "CURSOR_APP/Skill/CURSOR_APP_PROJECT_TARGET_V1",
            "CURSOR_APP/Subagent/CURSOR_APP_PROJECT_TARGET_V1",
            "CURSOR_APP/Workflow/CURSOR_APP_GLOBAL_WORKFLOW_TARGET_V1",
            "CURSOR_APP/Workflow/CURSOR_APP_PROJECT_TARGET_V1",
        ]);
        expect(
            cursorProvider.assetSourceCapabilities
                .filter((row) => row.agentRuntimeId === "CURSOR_APP" && row.assetKind === "Workflow")
                .every((row) => row.entrySupportStatus === "supported" && row.evidenceLevel === "agent_runtime_verified"),
        ).toBe(true);
        expect(
            cursorProvider.assetTargetCapabilities.find(
                (row) => row.agentRuntimeId === "CURSOR_APP" && row.assetKind === "Workflow",
            ),
        ).toMatchObject({ entrySupportStatus: "supported", diagnostics: [] });
        expect(
            cursorProvider.assetSourceCapabilities
                .filter((row) => row.entrySupportStatus === "deferred")
                .every((row) => row.readPolicy === "report_only" && row.diagnostics.length > 0),
        ).toBe(true);
        expect(
            cursorProvider.assetTargetCapabilities
                .filter((row) => row.entrySupportStatus === "deferred")
                .every((row) => row.diagnostics.length > 0),
        ).toBe(true);
    });

    it("binds independent CLI/App anchors and rebase components without cross-entry evidence borrowing", () => {
        const guidance = cursorProvider.renderContractDeclarations.filter(
            (row) => row.declarationKind === "native_project_guidance_v1",
        );
        const rules = cursorProvider.renderContractDeclarations.filter(
            (row) => row.declarationKind === "native_project_exact_file_v1" && row.assetKind === "Rule",
        );
        expect(guidance).toContainEqual(
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "2026.07.23-e383d2b",
                        buildIdentity: "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
                        platform: "wsl",
                    }),
                ],
            }),
        );
        const appGuidance = guidance.find((row) => row.agentRuntimeId === "CURSOR_APP");
        expect(appGuidance?.verifiedBuilds).toHaveLength(2);
        expect(appGuidance?.verifiedBuilds).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    versionText: "3.13.25",
                    buildIdentity: "sha256:98c0fc2885636738e986e01af8f9c5229dad4b2d7510bc489c9ffc0924da4904",
                    platform: "linux",
                }),
                expect.objectContaining({
                    versionText: "3.12.30",
                    buildIdentity: "sha256:4defe15e408c98082ee766f761ec77f9504f74727f57446a135b87bb44a4254e",
                    platform: "win32",
                }),
            ]),
        );
        expect(rules).toContainEqual(
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                nativeDialectId: "cursor-rule-mdc-v1",
                rebaseMaterializer: CURSOR_RULE_TARGET_COMPONENTS.rebase,
                verifiedBuilds: [expect.objectContaining({ platform: "wsl" })],
            }),
        );
        const appRule = rules.find((row) => row.agentRuntimeId === "CURSOR_APP");
        expect(appRule).toMatchObject({
            agentRuntimeId: "CURSOR_APP",
            nativeDialectId: "cursor-rule-mdc-v1",
            rebaseMaterializer: CURSOR_RULE_TARGET_COMPONENTS.rebase,
        });
        expect(appRule?.verifiedBuilds).toHaveLength(2);
        expect(appRule?.verifiedBuilds).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ platform: "linux", versionText: "3.13.25" }),
                expect.objectContaining({ platform: "win32", versionText: "3.12.30" }),
            ]),
        );
        const workflows = cursorProvider.renderContractDeclarations.filter((row) => row.assetKind === "Workflow");
        expect(workflows).toHaveLength(4);
        expect(new Set(workflows.map((row) => row.agentRuntimeId))).toEqual(new Set(["CURSOR_AGENT_CLI", "CURSOR_APP"]));
        expect(
            workflows.every(
                (row) => JSON.stringify(row.rebaseMaterializer) === JSON.stringify(CURSOR_WORKFLOW_TARGET_COMPONENTS.rebase),
            ),
        ).toBe(true);
        const skills = cursorProvider.renderContractDeclarations.filter((row) => row.assetKind === "Skill");
        expect(skills).toHaveLength(6);
        expect(new Set(skills.map((row) => row.agentRuntimeId))).toEqual(new Set(["CURSOR_AGENT_CLI", "CURSOR_APP"]));
        expect(
            skills.every(
                (row) => JSON.stringify(row.rebaseMaterializer) === JSON.stringify(CURSOR_SKILL_TARGET_COMPONENTS.rebase),
            ),
        ).toBe(true);
        const subagents = cursorProvider.renderContractDeclarations.filter((row) => row.assetKind === "Subagent");
        expect(subagents).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                nativeDialectId: "cursor-subagent-markdown-v1",
                rebaseMaterializer: CURSOR_SUBAGENT_TARGET_COMPONENTS.rebase,
                verifiedBuilds: [expect.objectContaining({ platform: "wsl" })],
            }),
            expect.objectContaining({
                agentRuntimeId: "CURSOR_APP",
                nativeDialectId: "cursor-subagent-markdown-v1",
                rebaseMaterializer: CURSOR_SUBAGENT_TARGET_COMPONENTS.rebase,
            }),
        ]);
        const appSubagent = subagents.find((row) => row.agentRuntimeId === "CURSOR_APP");
        expect(appSubagent?.verifiedBuilds).toHaveLength(2);
        expect(appSubagent?.verifiedBuilds).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ platform: "linux", versionText: "3.13.25" }),
                expect.objectContaining({ platform: "win32", versionText: "3.12.30" }),
            ]),
        );
        for (const assetKind of ["Workflow", "Skill"] as const) {
            for (const declaration of cursorProvider.renderContractDeclarations.filter(
                (row) => row.agentRuntimeId === "CURSOR_APP" && row.assetKind === assetKind,
            )) {
                expect(declaration.verifiedBuilds).toHaveLength(2);
                expect(declaration.verifiedBuilds).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ platform: "linux", versionText: "3.13.25" }),
                        expect.objectContaining({ platform: "win32", versionText: "3.12.30" }),
                    ]),
                );
            }
        }
    });

    it("validates Cursor Subagent selectors per exact field and both source entries", () => {
        const tool = requiredSelector(CURSOR_SUBAGENT_TOOL_DIALECT);
        const model = requiredSelector(CURSOR_SUBAGENT_MODEL_DIALECT);
        const permission = requiredSelector(CURSOR_SUBAGENT_PERMISSION_DIALECT);
        expect(tool.validateSourceApplicability({ agentRuntimeId: "CURSOR_AGENT_CLI", versionText: "exact" })).toBe(true);
        expect(tool.validateSourceApplicability({ agentRuntimeId: "CURSOR_APP", versionText: "exact" })).toBe(true);
        expect(tool.validateSourceApplicability({ agentRuntimeId: "ZCODE_APP", versionText: "foreign" })).toBe(false);
        expect(
            tool.validateSelector({
                kind: "Subagent",
                field: "subagent_tool",
                dialectId: CURSOR_SUBAGENT_TOOL_DIALECT,
                value: { valueKind: "selector", selector: "Read" },
            }),
        ).toBe(true);
        expect(
            tool.validateSelector({
                kind: "Subagent",
                field: "subagent_tool",
                dialectId: CURSOR_SUBAGENT_TOOL_DIALECT,
                value: { valueKind: "selector", selector: "bad,name" },
            }),
        ).toBe(false);
        expect(
            model.validateSelector({
                kind: "Subagent",
                field: "subagent_model",
                dialectId: CURSOR_SUBAGENT_MODEL_DIALECT,
                value: { valueKind: "relative_tier", selector: "fast", relativeTier: -1 },
            }),
        ).toBe(true);
        expect(
            model.validateSelector({
                kind: "Subagent",
                field: "subagent_model",
                dialectId: CURSOR_SUBAGENT_MODEL_DIALECT,
                value: { valueKind: "relative_tier", selector: "", relativeTier: 1 },
            }),
        ).toBe(false);
        expect(
            permission.validateSelector({
                kind: "Subagent",
                field: "subagent_permission",
                dialectId: CURSOR_SUBAGENT_PERMISSION_DIALECT,
                value: { valueKind: "permission_effect", selector: "readonly", effect: "read_only" },
            }),
        ).toBe(true);
        expect(
            permission.validateSelector({
                kind: "Subagent",
                field: "subagent_permission",
                dialectId: CURSOR_SUBAGENT_PERMISSION_DIALECT,
                value: { valueKind: "permission_effect", selector: "readonly", effect: "interactive" },
            }),
        ).toBe(false);
        expect(
            tool.validateSelector({
                kind: "Workflow",
                field: "workflow_tool",
                dialectId: CURSOR_SUBAGENT_TOOL_DIALECT,
                value: { valueKind: "selector", selector: "Read" },
            } as never),
        ).toBe(false);
    });

    it("exposes only the selected App read-only Memory snapshot while rejecting remote mutation", () => {
        const sourceRows = cursorProvider.assetSourceCapabilities.filter((row) => row.assetKind === "Memory");
        const targetRows = cursorProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Memory");
        expect(sourceRows).toHaveLength(2);
        expect(targetRows).toHaveLength(2);
        expect(sourceRows.map((row) => row.agentRuntimeId).sort()).toEqual(["CURSOR_AGENT_CLI", "CURSOR_APP"]);
        expect(targetRows.map((row) => row.agentRuntimeId).sort()).toEqual(["CURSOR_AGENT_CLI", "CURSOR_APP"]);
        expect(sourceRows.find((row) => row.agentRuntimeId === "CURSOR_AGENT_CLI")).toMatchObject({
            entrySupportStatus: "deferred",
            readPolicy: "report_only",
        });
        expect(sourceRows.find((row) => row.agentRuntimeId === "CURSOR_APP")).toMatchObject({
            entrySupportStatus: "supported",
            rootRole: "source",
            sourceDomain: "external_managed",
            sourcePathMechanism: "fixed_file",
            readPolicy: "user_selected_root_only",
        });
        expect(targetRows.find((row) => row.agentRuntimeId === "CURSOR_AGENT_CLI")?.entrySupportStatus).toBe("deferred");
        expect(targetRows.find((row) => row.agentRuntimeId === "CURSOR_APP")?.entrySupportStatus).toBe("unsupported");
        const sourceByEntry = new Map(sourceRows.map((row) => [row.agentRuntimeId, row.diagnostics[0]?.message]));
        expect(sourceByEntry.get("CURSOR_AGENT_CLI")).toContain("no callable exact-entry item-selected source");
        expect(sourceByEntry.get("CURSOR_APP")).toBeUndefined();
        const targetByEntry = new Map(targetRows.map((row) => [row.agentRuntimeId, row.diagnostics[0]?.message]));
        expect(targetByEntry.get("CURSOR_AGENT_CLI")).toContain("no callable exact-entry Memory mutation");
        expect(targetByEntry.get("CURSOR_APP")).toContain("remote-only");
        expect(targetByEntry.get("CURSOR_APP")).toContain("OAAM mutation authority is local-disk only");
        expect(targetByEntry.get("CURSOR_APP")).toContain("remote target and reverse are unsupported");
    });
});

function requiredSelector(dialectId: string) {
    const row = cursorProvider.dialectContracts.portableSelectors.find(
        (candidate) => candidate.definition.dialectId === dialectId,
    );
    if (row === undefined) throw new Error(`Cursor selector contract missing: ${dialectId}`);
    return row;
}
