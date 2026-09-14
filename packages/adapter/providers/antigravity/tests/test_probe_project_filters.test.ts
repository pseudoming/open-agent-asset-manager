import type { AdapterProbeContext, AdapterProbeResult } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getPathRule } from "../src/antigravity-paths";
import { discoverAntigravityProjects, materializeAntigravityProjects } from "../src/antigravity-probe-projects";

describe("Antigravity project source filters", () => {
    it("keeps plugin and builtin-managed registry paths out of ordinary project sources", () => {
        const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const context = {
            platform: "wsl",
            platformInstanceId: "wsl:Ubuntu",
            accessRootPath: wslHome,
        } as const;
        const rule = getPathRule("wsl", wslHome);
        const record = (runtimeProjectKey: string, workspacePath: string) => ({
            runtimeProjectKey,
            displayName: runtimeProjectKey,
            agentRuntimeIds: ["ANTIGRAVITY_CLI" as const],
            workspaces: [{ path: workspacePath, role: "primary" as const }],
            evidence: [],
            diagnostics: [],
        });
        expect(rule).not.toBeNull();
        const sourceRoots = new Map();
        const result = materializeAntigravityProjects(
            [
                record("plugin", "/home/example/.gemini/config/plugins/demo-plugin"),
                record("builtin", "/home/example/.gemini/antigravity/builtin/skills/system"),
                record("ordinary", "/home/example/projects/demo-plugin"),
                {
                    ...record("mixed", "/home/example/projects/mixed"),
                    workspaces: [
                        { path: "/home/example/projects/mixed", role: "primary" },
                        { path: "/home/example/.gemini/antigravity-cli/plugins/managed", role: "additional" },
                    ],
                },
            ],
            sourceRoots,
            context,
            rule ?? undefined,
        );

        expect(result.observedProjects.map((project) => project.runtimeProjectKey).sort()).toEqual(["mixed", "ordinary"]);
        expect([...sourceRoots.values()].map((root) => root.path).sort()).toEqual(
            [
                "\\\\wsl.localhost\\Ubuntu\\home\\example\\projects\\mixed",
                "\\\\wsl.localhost\\Ubuntu\\home\\example\\projects\\demo-plugin",
            ].sort(),
        );
        expect(result.diagnostics).toHaveLength(3);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "antigravity_managed_project_workspace_excluded",
                    path: "\\\\wsl.localhost\\Ubuntu\\home\\example\\.gemini\\config\\plugins\\demo-plugin",
                }),
                expect.objectContaining({
                    code: "antigravity_managed_project_workspace_excluded",
                    path: "\\\\wsl.localhost\\Ubuntu\\home\\example\\.gemini\\antigravity\\builtin\\skills\\system",
                }),
                expect.objectContaining({
                    code: "antigravity_managed_project_workspace_excluded",
                    path: "\\\\wsl.localhost\\Ubuntu\\home\\example\\.gemini\\antigravity-cli\\plugins\\managed",
                }),
            ]),
        );
    });

    it("uses only the exact user-authorized Windows Project without reading its global registry", async () => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-antigravity-windows-project-"));
        try {
            const registryRoot = path.join(sandbox, "projects");
            fs.mkdirSync(registryRoot);
            fs.writeFileSync(
                path.join(registryRoot, "registered.json"),
                JSON.stringify({
                    id: "windows-project",
                    name: "Windows project",
                    projectResources: { resources: [{ folderUri: "file:///C:/Projects/Example" }] },
                }),
            );
            const context: AdapterProbeContext = {
                authorizationScope: "project",
                projectRootPath: "C:\\Projects\\Example",
                platformContext: {
                    platform: "win32",
                    platformInstanceId: "fixture:win32",
                    accessRootPath: "C:\\",
                },
            };
            const rule = getPathRule("win32", "C:\\Users\\fixture");
            expect(rule).not.toBeNull();
            const resource = (
                agentRuntimeResourceId: string,
                resourcePath: string,
                accessStatus: "available" | "not_found",
            ): AdapterProbeResult["observation"]["agentRuntimeResources"][number] => ({
                agentRuntimeResourceId,
                roles: ["project_registry"],
                path: resourcePath,
                accessStatus,
                locatorEvidence: [],
                diagnostics: [],
            });
            const readDirectoryEntries = vi.fn(() => {
                throw new Error("project-scoped probes must not enumerate global registries");
            });
            const readRegularFile = vi.fn(() => {
                throw new Error("project-scoped probes must not read global registries");
            });
            const result = await discoverAntigravityProjects(
                context,
                { ANTIGRAVITY_PROJECT_ID: "windows-project" },
                { ...(rule as NonNullable<typeof rule>), sharedProjectsRoot: registryRoot },
                resource("shared", registryRoot, "available"),
                resource("app", "C:\\Users\\fixture\\app.pb", "not_found"),
                resource("ide", "C:\\Users\\fixture\\ide.pb", "not_found"),
                resource("cli-index", "C:\\Users\\fixture\\conversation_summaries.db", "not_found"),
                { readDirectoryEntries, readRegularFile },
            );

            expect(result.records).toEqual([
                expect.objectContaining({
                    runtimeProjectKey: "windows-project",
                    workspaces: [{ path: "C:\\Projects\\Example", role: "primary" }],
                    evidence: [
                        {
                            evidenceKind: "invocation",
                            locatorKey: "probe_project_root",
                            evidenceLevel: "user_provided",
                        },
                    ],
                }),
            ]);
            expect(result.diagnostics).toEqual([]);
            expect(readDirectoryEntries).not.toHaveBeenCalled();
            expect(readRegularFile).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
    });
});
