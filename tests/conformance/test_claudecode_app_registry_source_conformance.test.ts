/** App-only retained project anchors must survive Core's exact source-authority selection. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterReadTarget, PlatformContext } from "../../packages/core/src/types";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";
import { probeClaudeCode } from "../../packages/adapter/providers/claudecode/src/claudecode-probe";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreService } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";

describe("Claude App registry source conformance", () => {
    let sandbox = "";
    let projectRoot = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claude-app-source-"));
        projectRoot = path.join(sandbox, "project");
        platformContext = { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox };
        const metadata = path.join(sandbox, "home", ".config", "Claude", "claude-code-sessions", "aabbccdd", "org");
        fs.mkdirSync(metadata, { recursive: true });
        fs.writeFileSync(path.join(metadata, "local_project.json"), JSON.stringify({ originCwd: projectRoot }));
        const files = {
            "CLAUDE.md": "# App project guidance\n",
            ".claude/rules/typescript.md": "---\nname: TypeScript\npaths: [src/**/*.ts]\n---\nUse strict mode.\n",
            ".claude/commands/review.md": "---\nname: review\ndescription: Review changes\n---\nReview carefully.\n",
            ".claude/skills/explain/SKILL.md":
                "---\nname: explain\ndescription: Explain code\n---\nUse [details](docs/details.md).\n",
            ".claude/skills/explain/docs/details.md": "# Owned skill resource\n",
            ".claude/agents/reviewer.md":
                "---\nname: reviewer\ndescription: Review changes\ntools: [Read]\n---\nReview carefully.\n",
        };
        for (const [relativePath, text] of Object.entries(files)) {
            const destination = path.join(projectRoot, relativePath);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, text);
        }
        clearRegistry();
        closeDb();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    async function fixture() {
        const homePath = path.join(sandbox, "home");
        const probe = await probeClaudeCode(
            { platformContext, authorizationScope: "global", installationRootPath: path.join(sandbox, "no-install") },
            { HOME: homePath, PATH: "" },
            homePath,
            "linux",
        );
        const root = probe.observation.sourceRoots.find((item) => item.path === projectRoot);
        if (root === undefined) throw new Error("App project fixture was not discovered");
        expect(root.locatorEvidence.map((item) => item.locatorKind)).toEqual(["project_registry_entry"]);
        expect(
            probe.observation.observedAgentRuntimes
                .filter((runtime) => runtime.sourceRootIds.includes(root.sourceRootId))
                .map((runtime) => runtime.agentRuntimeId),
        ).toEqual(["CLAUDE_CODE_APP"]);

        const core = createCoreService({
            providers: [claudecodeProvider],
            platformContexts: [platformContext],
            oaamRoot: path.join(sandbox, "oaam"),
            databasePath: path.join(sandbox, "state.db"),
        });
        const current = core.getAdapterEnablement();
        expect(
            core.replaceAdapterEnablement({
                expectedRevision: current.value.revision,
                expectedSettingFingerprint: current.value.settingFingerprint,
                enabledAdapterIds: ["CLAUDECODE"],
                userActionId: "enable-app-registry-fixture",
            }).status,
        ).toBe("complete");
        expect(core.registerProject({ rootPath: projectRoot, displayName: "App project fixture" }).status).toBe("complete");
        const target: AdapterReadTarget = {
            adapterId: "CLAUDECODE",
            allowedKinds: ["Guidance", "Rule", "Workflow", "Skill", "Subagent"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: { adapterId: "CLAUDECODE", platformContext, ...probe.observation },
                sourceRootIds: [root.sourceRootId],
            },
        };
        return { core, target };
    }

    it("reads all five existing App project kinds and preserves the owned Skill graph without CLI ownership", async () => {
        const { core, target } = await fixture();
        const read = await core.readAssetsFromAdapter(target);
        expect(read.status, JSON.stringify(read.diagnostics)).toBe("complete");
        expect(read.value.candidates.map((candidate) => candidate.kind).sort()).toEqual([
            "Guidance",
            "Rule",
            "Skill",
            "Subagent",
            "Workflow",
        ]);
        expect(
            read.value.candidates.find((candidate) => candidate.kind === "Skill")?.files.map((file) => file.logicalPath),
        ).toEqual(["SKILL.md", "docs/details.md"]);
        expect(read.value.sourceReadObligations).toHaveLength(5);
        for (const obligation of read.value.sourceReadObligations) {
            expect(
                claudecodeProvider.assetSourceCapabilities.find(
                    (row) => row.sourceCapabilityFingerprint === obligation.sourceCapabilityFingerprint,
                ),
            ).toMatchObject({ agentRuntimeId: "CLAUDE_CODE_APP", rootLocatorKind: "project_registry_entry" });
        }
        const preview = core.previewImport([read.value]);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        expect(preview.value.items).toHaveLength(5);
    });

    it.each(["Memory", "unowned", "foreign-locator"] as const)("keeps exact source refusal for %s", async (scenario) => {
        const { core, target } = await fixture();
        if (target.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected probe fixture");
        if (scenario === "Memory") target.allowedKinds = ["Memory"];
        else if (scenario === "unowned") {
            for (const runtime of target.sourceSelector.observation.observedAgentRuntimes) runtime.sourceRootIds = [];
        } else {
            for (const root of target.sourceSelector.observation.sourceRoots) {
                root.locatorEvidence = [
                    { locatorKind: "runtime_known_rule", locatorKey: "unbound", evidenceLevel: "local_artifact" },
                ];
            }
        }
        const read = await core.readAssetsFromAdapter(target);
        expect(read.status).toBe("failed");
        expect(read.diagnostics).toContainEqual(expect.objectContaining({ code: "read.source_capability_unavailable" }));
    });
});
