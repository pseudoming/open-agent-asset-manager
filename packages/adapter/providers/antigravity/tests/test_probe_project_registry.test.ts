import type { AdapterProbeContext, AdapterProbeResult } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { getPathRule } from "../src/antigravity-paths";
import {
    antigravityProjectDiscoveryStatus,
    discoverAntigravityProjects,
    materializeAntigravityProjects,
} from "../src/antigravity-probe-projects";
import { canonicalWorkspacePath } from "../src/antigravity-project-paths";

async function discover(entries: Record<string, unknown>, platform: "linux" | "win32" = "linux") {
    const rule = getPathRule(platform, platform === "win32" ? "C:\\Users\\registry-fixture" : "/home/registry-fixture");
    if (rule === null) throw new Error("Linux path rule is required");
    const context: AdapterProbeContext = {
        authorizationScope: "global",
        platformContext: { platform, platformInstanceId: "fixture", accessRootPath: platform === "win32" ? "C:\\" : "/" },
    };
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
    return discoverAntigravityProjects(
        context,
        {},
        rule,
        resource("shared", rule.sharedProjectsRoot, "available"),
        resource("app", rule.appSummariesPath, "not_found"),
        resource("ide", rule.ideSummariesPath, "not_found"),
        resource("cli-index", rule.cliSummariesDbPath, "not_found"),
        {
            readDirectoryEntries: () => Object.keys(entries).map((name) => ({ name, entryKind: "file" as const })),
            readRegularFile: (filePath) => {
                const name = filePath.slice(rule.sharedProjectsRoot.length + 1);
                if (!(name in entries)) throw new Error("Read outside the selected project registry");
                return Buffer.from(JSON.stringify(entries[name]));
            },
        },
    );
}

describe("Antigravity filesystem and runtime-only Project records", () => {
    it("preserves a valid WSL file URI as a foreign workspace without accessing it from Windows", async () => {
        const result = await discover(
            {
                "foreign.json": {
                    id: "foreign",
                    projectResources: {
                        resources: [{ gitFolder: { folderUri: "file://wsl.localhost/Ubuntu/home/fixture/project" } }],
                    },
                },
                "outside-of-project.json": { id: "outside-of-project" },
            },
            "win32",
        );
        expect(result.diagnostics).toEqual([]);
        expect(result.records[0]?.workspaces).toEqual([
            { path: "\\\\wsl.localhost\\Ubuntu\\home\\fixture\\project", role: "primary" },
        ]);
        const roots = new Map();
        const projected = materializeAntigravityProjects(result.records, roots, {
            platform: "win32",
            platformInstanceId: "desktop-local",
            accessRootPath: "C:\\",
        });
        expect(projected.observedProjects).toEqual([]);
        expect(roots.size).toBe(0);
        expect(projected.diagnostics).toEqual([
            expect.objectContaining({ code: "antigravity_project_workspace_unreachable", causeKind: "partial" }),
        ]);
    });

    it.each(["wsl.localhost", "wsl$"])("decodes the declared %s workspace URI without authorizing the path", (host) => {
        expect(canonicalWorkspacePath(`file://${host}/Ubuntu/home/fixture/my%20project`, "win32")).toBe(
            `\\\\${host}\\Ubuntu\\home\\fixture\\my project`,
        );
        expect(canonicalWorkspacePath(`file://${host}/Ubuntu/home/fixture`, "linux")).toBeNull();
    });

    it.each([
        "file://server/Ubuntu/home",
        "file://wsl.localhost/Ubuntu",
        "file://wsl.localhost/Ubuntu/",
        "file://wsl.localhost/Ubuntu/home?query",
        "file://wsl.localhost/Ubuntu/home#fragment",
        "file://wsl.localhost/Ubuntu/home/../project",
        "file://wsl.localhost/Ubuntu/home/%2e%2e/project",
        "file://wsl.localhost/Ubuntu/%2Fproject",
        "file://wsl.localhost/Ubuntu/%5Cproject",
        "file://wsl.localhost/Ubuntu/%00project",
        "file://wsl.localhost/Ubuntu/%20project",
        "file://wsl.localhost/Ubuntu/project.",
        "file://wsl.localhost/Ubuntu/project%3Aname",
        "file://wsl.localhost/Ubuntu/%GG",
    ])("rejects malformed or unassigned workspace encoding %s", (uri) => {
        expect(canonicalWorkspacePath(uri, "win32")).toBeNull();
    });

    it("completes a checked registry when optional App/IDE/CLI indexes have not been created", async () => {
        const result = await discover({
            "ordinary.json": { id: "ordinary", projectResources: { resources: [{ folderUri: "file:///work/ordinary" }] } },
        });
        const context: AdapterProbeContext = {
            authorizationScope: "global",
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" },
        };
        expect(result.indexes).toEqual({ shared: "complete", app: "not_found", ide: "not_found", cli: "not_found" });
        for (const index of [result.indexes.app, result.indexes.ide, result.indexes.cli]) {
            expect(antigravityProjectDiscoveryStatus(context, [result.indexes.shared, index])).toBe("complete");
        }
        expect(antigravityProjectDiscoveryStatus(context, ["not_found", "not_found"])).toBe("not_found");
        expect(antigravityProjectDiscoveryStatus(context, ["complete", "partial"])).toBe("partial");
    });
    it("accepts explicit empty and default resource objects without inventing filesystem Projects", async () => {
        const result = await discover({
            "outside-of-project.json": { id: "outside-of-project" },
            "default-cli-project.json": { id: "default-cli-project", name: "Default Project", projectResources: {} },
            "11111111-1111-1111-1111-111111111111.json": {
                id: "11111111-1111-1111-1111-111111111111",
                name: "demo-system",
                projectResources: { resources: [] },
            },
            "ordinary.json": {
                id: "ordinary",
                name: "Ordinary Project",
                projectResources: { resources: [{ folderUri: "file:///work/ordinary" }] },
            },
        });
        expect(result.indexes.shared).toBe("complete");
        expect(result.diagnostics).toEqual([]);
        expect(result.records).toEqual([
            expect.objectContaining({
                runtimeProjectKey: "ordinary",
                workspaces: [{ path: "/work/ordinary", role: "primary" }],
            }),
        ]);
    });

    it("retains malformed identity, resource-shape and path diagnostics beside valid empty Projects", async () => {
        const result = await discover({
            "empty-valid.json": { id: "empty", projectResources: { resources: [] } },
            "missing-id.json": { projectResources: {} },
            "null-resources.json": { id: "null", projectResources: null },
            "wrong-resource-object.json": { id: "array", projectResources: [] },
            "wrong-resources.json": { id: "wrong", projectResources: { resources: null } },
            "invalid-resource.json": { id: "invalid", projectResources: { resources: [42] } },
            "invalid-path.json": { id: "relative", projectResources: { resources: [{ folderUri: "relative" }] } },
        });
        expect(result.records).toEqual([]);
        expect(result.indexes.shared).toBe("partial");
        expect(result.diagnostics).toHaveLength(6);
        expect(result.diagnostics.every((item) => item.code === "antigravity_project_registry_entry_incomplete")).toBe(true);
        expect(result.diagnostics.every((item) => item.causeKind === "invalid_schema")).toBe(true);
        expect(result.diagnostics.map((item) => item.path?.split("/").pop())).toEqual([
            "invalid-path.json",
            "invalid-resource.json",
            "missing-id.json",
            "null-resources.json",
            "wrong-resource-object.json",
            "wrong-resources.json",
        ]);
    });
});
